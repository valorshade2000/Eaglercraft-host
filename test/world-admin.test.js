'use strict';
// World management (src/world-admin.js through src/control.js; the web page's Worlds section; cli.js rename, delete,
// deleted, restore, purge): rename moves the world into the folder of its new name (this game version names a world
// after its folder) with only the level name in level.dat changed; delete moves the world to the deleted worlds,
// restore brings it back byte for byte (into a free folder when its old one is in use), purge removes only its files;
// every other world and file stays as it was; refused while a world runs, without the world's name typed again, and for
// unknown worlds; a restart never brings a deleted world back as a new one. First on a throwaway worlds database, then
// through the HTTP API and the real page (chrome-headless-shell; skipped without it), then with the real game hosting a
// renamed, deleted and restored world.
//   node --test test/world-admin.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-worlds-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const paths = require('../src/paths');
const { WORLDS_DB, WorldStore, parseNBT } = require('../src/worlds');
const { setLevelName } = require('../src/world-admin');
const { MockRelay } = require('./mock-relay');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const relays = [];
after(async () => {
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) { await sleep(500); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

// A small NBT writer for test worlds: tags as [type, value]; a compound's value is a list of [name, tag].
function writeNBT(tag) {
  const out = [];
  const num = (n, f, v) => { const b = Buffer.alloc(n); b[f](v); out.push(b); };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); num(2, 'writeUInt16BE', b.length); out.push(b); };
  const payload = ([t, v]) => {
    if (t === 1) num(1, 'writeInt8', v); else if (t === 2) num(2, 'writeInt16BE', v); else if (t === 3) num(4, 'writeInt32BE', v);
    else if (t === 4) num(8, 'writeBigInt64BE', BigInt(v)); else if (t === 5) num(4, 'writeFloatBE', v); else if (t === 6) num(8, 'writeDoubleBE', v);
    else if (t === 7) { num(4, 'writeInt32BE', v.length); out.push(Buffer.from(v)); } else if (t === 8) str(v);
    else if (t === 9) { num(1, 'writeUInt8', v.et); num(4, 'writeInt32BE', v.items.length); for (const x of v.items) payload([v.et, x]); }
    else if (t === 10) { for (const [n, x] of v) { num(1, 'writeUInt8', x[0]); str(n); payload(x); } num(1, 'writeUInt8', 0); }
    else if (t === 11) { num(4, 'writeInt32BE', v.length); for (const x of v) num(4, 'writeInt32BE', x); }
  };
  num(1, 'writeUInt8', 10); str(''); payload(tag);
  return Buffer.concat(out);
}
const levelNBT = (name, seed) => writeNBT([10, [['Data', [10, [
  ['RandomSeed', [4, seed]], ['GameType', [3, 0]], ['hardcore', [1, 0]], ['LevelName', [8, name]], ['SpawnX', [3, 12]], ['SpawnY', [3, 64]], ['SpawnZ', [3, -40]],
  ['Time', [4, 123456]], ['version', [3, 19133]], ['GameRules', [10, [['keepInventory', [8, 'false']]]]],
  ['Player', [10, [['Pos', [9, { et: 6, items: [1.5, 70, -3.25] }]], ['Inventory', [9, { et: 10, items: [[['id', [2, 1]], ['Count', [1, 64]]]] }]]]]],
  ['BorderSize', [6, 60000000]], ['heights', [11, [1, 2, 3]]], ['blob', [7, [1, 2, 3, 4]]], ['thunderTime', [3, 9999]],
]]]]]);
// The worlds database as the game leaves it: worlds_list.txt (repeats included) and each world's files.
function makeDb(file, worlds, list) {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS files (db TEXT NOT NULL, path TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(db, path)) WITHOUT ROWID');
    db.exec('CREATE TABLE IF NOT EXISTS dbs (db TEXT PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO dbs(db) VALUES(?)').run(WORLDS_DB);
    const put = db.prepare('INSERT INTO files(db, path, data) VALUES(?, ?, ?) ON CONFLICT(db, path) DO UPDATE SET data = excluded.data');
    for (const [folder, name, seed] of worlds) {
      put.run(WORLDS_DB, `worlds/${folder}/level.dat`, zlib.gzipSync(levelNBT(name, seed)));
      put.run(WORLDS_DB, `worlds/${folder}/level.dat_old`, zlib.gzipSync(levelNBT(name, seed)));
      for (let i = 0; i < 5; i++) put.run(WORLDS_DB, `worlds/${folder}/level0/${i}.dat`, crypto.randomBytes(200 + i));
      put.run(WORLDS_DB, `worlds/${folder}/player/steve.dat`, crypto.randomBytes(64));
    }
    if (list) put.run(WORLDS_DB, 'worlds_list.txt', Buffer.from(list.join('\n')));
  } finally { db.close(); }
}
// Every file of the worlds database: path -> SHA-1 of its bytes.
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT path, data FROM files WHERE db = ?').all(WORLDS_DB).map((r) => [r.path, crypto.createHash('sha1').update(r.data).digest('hex')])); } finally { db.close(); }
}
function readFile(file, p) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { const r = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, p); return r ? Buffer.from(r.data) : null; } finally { db.close(); }
}
const list = (file) => readFile(file, 'worlds_list.txt').toString('utf8');
const pick = (snap, prefix) => Object.fromEntries(Object.entries(snap).filter(([k]) => k.startsWith(prefix)));
const others = (snap, prefixes) => Object.fromEntries(Object.entries(snap).filter(([k]) => !prefixes.some((p) => k.startsWith(p))));
const without = (o, k) => { const x = { ...o }; delete x[k]; return x; };
const moved = (snap, from, to) => Object.fromEntries(Object.entries(pick(snap, from)).map(([k, v]) => [to + k.slice(from.length), v]));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const WORLDS = [['Alpha', 'Alpha', 1], ['Alpha-', 'Alpha copy', 2], ['Alpha2', 'Alpha two', 3], ['Beta', 'Beta', 4]];

test('rename, delete, restore and delete permanently: only that world changes; refused while a world runs, without the typed name, for unknown worlds', async () => {
  const db = paths.dbFile;
  makeDb(db, WORLDS, ['Alpha', 'Alpha-', 'Beta', 'Alpha', 'Alpha2']);
  const s0 = snapshot(db);
  assert.deepEqual(c.store.list().map((w) => w.folder).sort(), ['Alpha', 'Alpha-', 'Alpha2', 'Beta']);

  // Rename: into the folder of the new name (this game version names a world after its folder), every file moved with
  // its bytes, level.dat with only its name replaced, listed where it was; the host's files naming the folder follow.
  fs.writeFileSync(paths.sessionFile, JSON.stringify({ mode: 'existing', world: 'Alpha', displayName: 'Alpha' }));
  fs.writeFileSync(path.join(dataDir, 'pregen.json'), JSON.stringify({ world: 'Alpha', radius: 100, rate: 4, ring: 3 }));
  const name = 'Neue Welt 🌍 Ünïcödé', N = `worlds/${name}/`;
  const r = await c.renameWorld({ folder: 'Alpha', name: '  ' + name + ' ' });
  assert.deepEqual([r.folder, r.name, r.previous, r.previousFolder, r.typed], [name, name, 'Alpha', 'Alpha', name]);
  const s1 = snapshot(db);
  assert.deepEqual(others(s1, [N, 'worlds/Alpha/', 'worlds_list.txt']), others(s0, ['worlds/Alpha/', 'worlds_list.txt']), 'the other worlds untouched');
  assert.deepEqual(pick(s1, 'worlds/Alpha/'), {}, 'nothing left in the old folder');
  assert.deepEqual(without(pick(s1, N), N + 'level.dat'), without(moved(s0, 'worlds/Alpha/', N), N + 'level.dat'), 'every other file moved, the same bytes');
  const nbt = zlib.gunzipSync(readFile(db, N + 'level.dat'));
  assert.ok(nbt.equals(setLevelName(levelNBT('Alpha', 1), name)), 'level.dat: the same bytes with only the name replaced');
  const d0 = parseNBT(levelNBT('Alpha', 1)).Data, d1 = parseNBT(nbt).Data;
  assert.equal(d1.LevelName, name);
  assert.deepEqual({ ...d1, LevelName: null }, { ...d0, LevelName: null }, 'every other tag as it was');
  assert.equal(list(db), `${name}\nAlpha-\nBeta\n${name}\nAlpha2`, 'worlds_list.txt: the new folder where the old one was');
  assert.equal(c.store.list().find((w) => w.folder === name).name, name);
  assert.equal(JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8')).world, name, 'the last world follows (Restart)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'pregen.json'), 'utf8')).world, name, 'its waiting pre-generation follows');
  // Another world's name, or characters a folder cannot have: a folder name as for a new world.
  const taken = await c.renameWorld({ folder: 'Alpha2', name: 'Alpha-' });
  assert.deepEqual([taken.folder, taken.name, taken.typed], ['Alpha--', 'Alpha--', 'Alpha-']);
  assert.equal((await c.renameWorld({ folder: 'Alpha--', name: 'Al/pha:2?' })).folder, 'Al_pha_2_');
  assert.equal((await c.renameWorld({ folder: 'Al_pha_2_', name: 'x'.repeat(100) })).folder.length, 100);
  assert.equal((await c.renameWorld({ folder: 'x'.repeat(100), name: 'Alpha2' })).folder, 'Alpha2');
  assert.equal(list(db), `${name}\nAlpha-\nBeta\n${name}\nAlpha2`);
  const s1b = snapshot(db);
  assert.equal((await c.renameWorld({ folder: 'Beta', name: 'Beta' })).unchanged, true, 'its own name: nothing to do');
  for (const bad of ['', '   ', 'x'.repeat(101), 'a\nb', 'tab\there']) await assert.rejects(c.renameWorld({ folder: 'Beta', name: bad }), /World name/, JSON.stringify(bad));
  await assert.rejects(c.renameWorld({ folder: 'Nope', name: 'X' }), /not found/);
  assert.deepEqual(snapshot(db), s1b, 'nothing changed');

  // Delete: without the world's name typed again, nothing happens.
  const s2 = snapshot(db);
  for (const typed of [undefined, '', 'alpha', 'Alpha', 'Neue Welt']) await assert.rejects(c.deleteWorld({ folder: name, confirm: typed }), /type the world's name/, String(typed));
  await assert.rejects(c.deleteWorld({ folder: 'Nope', confirm: 'Nope' }), /not found/);
  assert.deepEqual(snapshot(db), s2);
  const del = await c.deleteWorld({ folder: name, confirm: name });
  assert.equal(del.id, del.id.slice(0, 13) + '/' + name); assert.match(del.id, /^\d{13}\//);
  assert.equal(del.pregenDropped, true); assert.ok(!fs.existsSync(path.join(dataDir, 'pregen.json')), 'its waiting pre-generation dropped');
  const s3 = snapshot(db);
  assert.deepEqual(pick(s3, `deleted/${del.id}/`), moved(s2, N, `deleted/${del.id}/`), 'every file moved, the same bytes');
  assert.deepEqual(pick(s3, N), {}, 'nothing left in its folder');
  assert.deepEqual(others(s3, [N, 'deleted/', 'worlds_list.txt']), others(s2, [N, 'worlds_list.txt']), 'the other worlds untouched');
  assert.equal(list(db), 'Alpha-\nBeta\nAlpha2', 'out of worlds_list.txt (each repeat), the others in order');
  assert.deepEqual(c.store.list().map((w) => w.folder).sort(), ['Alpha-', 'Alpha2', 'Beta']);
  const t = c.listDeleted();
  assert.deepEqual(t.map((x) => [x.id, x.folder, x.name, x.files]), [[del.id, name, name, 8]]);

  // A restart never brings it back as a new world in its folder.
  await assert.rejects(c.restart(), /no longer exists/);
  await assert.rejects(c.start({ folder: name }), /not found/);
  assert.equal((await c.status()).running, false);
  assert.deepEqual(snapshot(db), s3);

  // While a world runs: all refused, nothing changed.
  fs.writeFileSync(paths.stateFile, JSON.stringify({ pid: process.pid, status: 'hosting', controlPort: await freePort(), world: 'Beta' }));
  assert.equal((await c.status()).running, true);
  await assert.rejects(c.renameWorld({ folder: 'Beta', name: 'X' }), /only while no world runs/);
  await assert.rejects(c.deleteWorld({ folder: 'Beta', confirm: 'Beta' }), /only while no world runs/);
  await assert.rejects(c.restoreWorld({ id: del.id }), /only while no world runs/);
  await assert.rejects(c.purgeWorld({ id: del.id, confirm: name }), /only while no world runs/);
  assert.deepEqual(snapshot(db), s3);
  fs.rmSync(paths.stateFile);

  // Restore: back into its folder, byte for byte, listed again.
  const rs = await c.restoreWorld({ id: del.id });
  assert.deepEqual([rs.folder, rs.movedFrom], [name, null]);
  assert.deepEqual(others(snapshot(db), ['worlds_list.txt']), others(s2, ['worlds_list.txt']), 'every file where it was, the same bytes');
  assert.equal(list(db), `Alpha-\nBeta\nAlpha2\n${name}`);
  assert.deepEqual(c.listDeleted(), []);
  await assert.rejects(c.restoreWorld({ id: del.id }), /not found/);
  await assert.rejects(c.restoreWorld({ id: '../worlds/Beta' }), /not found/);

  // Restore when its folder has been taken since (a new world there): into a free folder; the new world untouched.
  const del2 = await c.deleteWorld({ folder: name, confirm: name });
  makeDb(db, [[name, 'Fresh', 9]], null);
  const s5 = snapshot(db);
  const rs2 = await c.restoreWorld({ id: del2.id });
  assert.deepEqual([rs2.folder, rs2.movedFrom], [name + '-', name]);
  const s6 = snapshot(db);
  assert.deepEqual(pick(s6, N), pick(s5, N), 'the new world in its old folder untouched');
  assert.deepEqual(pick(s6, `worlds/${name}-/`), moved(s5, `deleted/${del2.id}/`, `worlds/${name}-/`));

  // Delete permanently: only after the name typed again; only that world's files.
  const del3 = await c.deleteWorld({ folder: name + '-', confirm: name + '-' });
  const s7 = snapshot(db);
  await assert.rejects(c.purgeWorld({ id: del3.id, confirm: 'Alpha' }), /type the world's name/);
  await assert.rejects(c.purgeWorld({ id: 'nope', confirm: 'x' }), /not found/);
  assert.deepEqual(snapshot(db), s7);
  assert.equal((await c.purgeWorld({ id: del3.id, confirm: name })).files, 8);
  assert.deepEqual(snapshot(db), others(s7, [`deleted/${del3.id}/`]), 'only its files removed');
  assert.deepEqual(c.listDeleted(), []);
});

// ---- the HTTP API and the real page
const call = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
async function startUi(dir) {
  const port = await freePort();
  const env = { ...process.env, EAGLAN_DATA: dir, PORT: String(port), BIND: '127.0.0.1' };
  for (const k of ['EAGLAN_AUTOSTART', 'EAGLAN_RELAYS_FILE', 'EAGLAN_STOP_HOST_ON_EXIT']) delete env[k];
  const child = spawn(process.execPath, [path.join(root, 'src', 'ui-server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 150; i++) { try { if ((await call(port, 'GET', '/api/worlds')).status === 200) return { port, child }; } catch {} await sleep(100); }
  child.kill(); throw new Error('the web UI server did not start: ' + out);
}
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  try {
    for (const d of fs.readdirSync(base)) for (const exe of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(base, d, exe); if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}
const chrome = findChrome();


test('API and page: Rename, Delete with the typed name, the deleted worlds with Restore and Delete permanently', { timeout: 180000 }, async () => {
  const dir = path.join(dataDir, 'ui'); fs.mkdirSync(dir);
  const db = path.join(dir, 'worlds.sqlite');
  makeDb(db, WORLDS, ['Alpha', 'Alpha-', 'Alpha2', 'Beta']);
  const ui = await startUi(dir);
  let browser;
  try {
    // API
    let r = await call(ui.port, 'POST', '/api/rename', { folder: 'Beta', name: 'Beta Two' });
    assert.deepEqual([r.status, r.body.folder, r.body.name], [200, 'Beta Two', 'Beta Two']);
    r = await call(ui.port, 'POST', '/api/rename', { folder: 'Beta Two', name: '' });
    assert.equal(r.status, 400); assert.match(r.body.error, /World name/);
    const s0 = snapshot(db);
    r = await call(ui.port, 'POST', '/api/delete', { folder: 'Beta Two', confirm: 'Beta Tw' });
    assert.equal(r.status, 400, 'part of the name does not confirm'); assert.deepEqual(snapshot(db), s0);
    r = await call(ui.port, 'POST', '/api/delete', { folder: 'Beta Two', confirm: 'Beta Two' }, { origin: 'http://elsewhere.example' });
    assert.equal(r.status, 403); assert.deepEqual(snapshot(db), s0);
    r = await call(ui.port, 'POST', '/api/delete', { folder: 'Beta Two', confirm: 'Beta Two' });
    assert.equal(r.status, 200);
    const t = (await call(ui.port, 'GET', '/api/deleted')).body;
    assert.deepEqual(t.map((x) => [x.folder, x.name]), [['Beta Two', 'Beta Two']]);
    r = await call(ui.port, 'POST', '/api/purge', { id: t[0].id, confirm: 'nope' });
    assert.equal(r.status, 400);
    r = await call(ui.port, 'POST', '/api/restore', { id: t[0].id });
    assert.deepEqual([r.status, r.body.folder], [200, 'Beta Two']);
    assert.deepEqual(snapshot(db), s0, 'restored byte for byte');

    if (!chrome) return;
    // the page
    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] });
    const p = await browser.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${ui.port}/`);
    await p.waitForSelector('#worlds tr.w[data-f="Alpha2"]', { timeout: 20000 });
    const worldMsg = (re) => p.waitForFunction((s) => new RegExp(s).test(document.getElementById('worldMsg').textContent), { timeout: 10000 }, re);
    const click = async (sel) => { await p.waitForFunction((s) => { const e = document.querySelector(s); return e && !e.disabled; }, { timeout: 10000 }, sel); await p.click(sel); };
    const row = (f) => `#worlds tr.w[data-f="${f}"]`;
    assert.equal(await p.$eval('#bRename', (e) => e.disabled), true, 'nothing selected');
    await p.click(row('Alpha2'));
    // Rename: the world in its new folder, still selected
    await click('#bRename');
    assert.equal(await p.$eval('#rnName', (e) => e.value), 'Alpha two');
    await p.$eval('#rnName', (e) => { e.value = ''; }); await p.type('#rnName', 'Second Alpha');
    await p.click('#bRnOk');
    await worldMsg("^Renamed 'Alpha two' to 'Second Alpha'\\.$");
    await p.waitForSelector(row('Second Alpha'), { timeout: 10000 });
    assert.equal(await p.$(row('Alpha2')), null);
    assert.equal(await p.$eval('#selInfo', (e) => e.textContent), 'Selected: Second Alpha');
    assert.equal(new WorldStore(db).list().find((w) => w.folder === 'Second Alpha').name, 'Second Alpha');
    // Delete: the button works only with the name typed
    await click('#bDelete');
    assert.equal(await p.$eval('#bDlOk', (e) => e.disabled), true);
    await p.type('#dlConfirm', 'Second Alph');
    assert.equal(await p.$eval('#bDlOk', (e) => e.disabled), true, 'not with part of the name');
    await p.type('#dlConfirm', 'a');
    assert.equal(await p.$eval('#bDlOk', (e) => e.disabled), false);
    await p.click('#bDlOk');
    await worldMsg("^'Second Alpha' moved to Deleted worlds");
    await p.waitForFunction((s) => !document.querySelector(s) && !document.getElementById('trashBox').hidden, { timeout: 10000 }, row('Second Alpha'));
    assert.equal(await p.$eval('#trashN', (e) => e.textContent), '1');
    // Restore
    await p.click('#trashBox summary');
    await click('#trash button[data-restore]');
    await worldMsg("^Restored into folder 'Second Alpha'");
    await p.waitForFunction((s) => !!document.querySelector(s) && document.getElementById('trashBox').hidden, { timeout: 10000 }, row('Second Alpha'));
    // Delete, then Delete permanently with the name typed
    await p.click(row('Second Alpha'));
    await click('#bDelete'); await p.type('#dlConfirm', 'Second Alpha'); await p.click('#bDlOk');
    await worldMsg('moved to Deleted worlds');
    await p.waitForFunction(() => !document.getElementById('trashBox').hidden, { timeout: 10000 });
    if (!(await p.$eval('#trashBox', (e) => e.open))) await p.click('#trashBox summary');
    await click('#trash button[data-purge]');
    assert.equal(await p.$eval('#bPurgeOk', (e) => e.disabled), true);
    await p.type('#purgeConfirm', 'Second Alpha');
    await p.click('#bPurgeOk');
    await worldMsg("^'Second Alpha' deleted permanently \\(8 files\\)");
    await p.waitForFunction(() => document.getElementById('trashBox').hidden, { timeout: 10000 });
    const s9 = snapshot(db);
    assert.deepEqual(pick(s9, 'worlds/Second Alpha/'), {}); assert.deepEqual(pick(s9, 'deleted/'), {});
    assert.deepEqual(others(s9, ['worlds/Alpha2/', 'worlds_list.txt']), others(s0, ['worlds/Alpha2/', 'worlds_list.txt']), 'the other worlds untouched');
    assert.deepEqual(errors, [], 'no errors on the page');
  } finally { if (browser) await browser.close(); ui.child.kill(); }
});

test('the real game: a renamed world is hosted with its new name, also after a Restart; deleted, neither start nor restart brings it back; restored, it is hosted again', { timeout: 600000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  await c.create({ name: 'Admin World', seed: '4242' });
  const hosting = () => waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s; }, 150000);
  let st = await hosting();
  assert.ok(st, 'hosting');
  const folder = st.world;
  await assert.rejects(c.renameWorld({ folder, name: 'X' }), /only while no world runs/);
  await assert.rejects(c.deleteWorld({ folder, confirm: folder }), /only while no world runs/);
  await c.stop();
  const before = c.store.list().find((w) => w.folder === folder);
  assert.equal(before.name, 'Admin World');

  const rn = await c.renameWorld({ folder, name: 'Renamed World' });
  assert.equal(rn.folder, 'Renamed World');
  await c.restart();   // (the last world followed the rename)
  st = await hosting();
  assert.ok(st && st.world === 'Renamed World', 'Restart hosts the renamed world');
  assert.ok([...relay.hosts.values()].some((h) => h.name === 'Renamed World'), 'registered on the relay with its new name');
  await c.stop();
  const again = c.store.list().find((w) => w.folder === 'Renamed World');
  assert.equal(again.name, 'Renamed World', 'the name lasts after the game saved level.dat again');
  assert.deepEqual([again.seed, again.spawn, again.gameType], [before.seed, before.spawn, before.gameType]);
  assert.ok(!c.store.exists(folder), 'the old folder is free');

  const del = await c.deleteWorld({ folder: 'Renamed World', confirm: 'Renamed World' });
  assert.ok(!c.store.list().some((w) => w.folder === 'Renamed World'));
  await assert.rejects(c.start({ folder: 'Renamed World' }), /not found/);
  await assert.rejects(c.restart(), /no longer exists/);
  assert.equal(c.store.exists('Renamed World'), false, 'no new world was made in its folder');

  await c.restoreWorld({ id: del.id });
  await c.start({ folder: 'Renamed World' });
  st = await hosting();
  assert.ok(st, 'hosted again after the restore');
  await c.stop();
  const restored = c.store.list().find((w) => w.folder === 'Renamed World');
  assert.deepEqual([restored.name, restored.seed, restored.spawn], ['Renamed World', before.seed, before.spawn]);
});
