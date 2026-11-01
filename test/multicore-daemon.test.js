'use strict';
// Multi-core mode with the real daemon and game (config multiCore): players get their chunks through
// the pool (protocol-level players that decode every chunk packet), chunk files are gzipped on the
// pool and readable by the game after a restart, nothing is ever stored uncompressed, the mode
// switches off and on while players play, "Save now" waits for the files being compressed, and
// without the game hook (gamePatches false) the mode reports why it is off.
//   node --test test/multicore-daemon.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-mcd-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { WORLDS_DB } = require('../src/worlds');
const { RAW_MAGIC } = require('../src/idb-sqlite');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const db = () => new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });

// A saved chunk's NBT with its byte arrays.
function readNBT(buf) {
  let o = 0;
  const str = () => { const n = buf.readUInt16BE(o); o += 2; o += n; return buf.toString('utf8', o - n, o); };
  const i32 = () => { o += 4; return buf.readInt32BE(o - 4); };
  const payload = (t) => {
    switch (t) {
      case 1: return buf.readInt8(o++);
      case 2: o += 2; return buf.readInt16BE(o - 2);
      case 3: return i32();
      case 4: o += 8; return buf.readBigInt64BE(o - 8);
      case 5: o += 4; return buf.readFloatBE(o - 4);
      case 6: o += 8; return buf.readDoubleBE(o - 8);
      case 7: { const n = i32(); o += n; return buf.subarray(o - n, o); }
      case 8: return str();
      case 9: { const et = buf[o++], n = i32(), a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const m = {}; for (;;) { const tt = buf[o++]; if (tt === 0) return m; const name = str(); m[name] = payload(tt); } }
      case 11: { const n = i32(), a = []; for (let i = 0; i < n; i++) a.push(i32()); return a; }
      default: throw new Error('NBT tag type ' + t);
    }
  };
  const t = buf[o++]; str(); return payload(t);
}
const chunkKey = (folder, x, z) => { const hex = (v) => Array.from({ length: 6 }, (_, i) => '0123456789ABCDEF'[((v + 1900000) >>> (4 * i)) & 15]).join(''); return `worlds/${folder}/level0/${hex(x >> 4)}${hex(z >> 4)}.dat`; };
function savedBlock(folder, x, y, z) {
  const d = db();
  try {
    const row = d.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, chunkKey(folder, x, z));
    if (!row) return null;
    const section = (readNBT(zlib.gunzipSync(Buffer.from(row.data))).Level.Sections || []).find((s) => s.Y === y >> 4);
    return section ? section.Blocks[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : null;
  } finally { d.close(); }
}
// Every stored file: none with the marker of an uncompressed hand-over; every chunk file a gzip file
// that ends where its gzip data ends (the game's own writes leave the rest of their buffer after it).
function storedFiles(folder) {
  const d = db();
  try {
    const rows = d.prepare('SELECT path, data FROM files WHERE db = ?').all(WORLDS_DB);
    const raw = rows.filter((r) => Buffer.from(r.data).subarray(0, RAW_MAGIC.length).equals(Buffer.from(RAW_MAGIC)));
    const chunks = rows.filter((r) => r.path.startsWith(`worlds/${folder}/level0/`));
    let exact = 0, padded = 0;
    for (const r of chunks) { const b = Buffer.from(r.data); assert.equal(b[0], 0x1f, r.path); const used = zlib.gunzipSync(b, { info: true }).engine.bytesWritten; if (used === b.length) exact++; else padded++; }
    return { raw: raw.length, chunks: chunks.length, exact, padded };
  } finally { d.close(); }
}
async function roundAfter(t) {
  return waitFor(async () => { const a = ((await c.status()).gameServer || {}).autosave; return a && a.last && a.last.startedAt > t && a.last; }, 120000, 1000);
}

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: multi-core mode end to end', { timeout: 600000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ multiCore: true });
  await c.create({ name: 'Multi World', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 120000);
  assert.ok(st, 'hosting');
  assert.equal(st.multiCore.on, true, JSON.stringify(st.multiCore));
  assert.ok(st.multiCore.threads >= 1);
  assert.match(hostLog(), /multi-core mode on: \d pool threads? compress/);

  // Two players: every chunk they get went through the pool (the bots decode every chunk packet and
  // never walk into terrain they have not received).
  for (const name of ['Alpha', 'Beta']) {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code }); bots.push(b);
    await b.join();
    assert.equal(await Promise.race([b.ready, sleep(30000).then(() => false)]), true, name + ' is in the world');
  }
  // (chunk data goes out in large bundles: a few packets of hundreds of KB each)
  st = await waitFor(async () => { const s = await c.status(); return s.multiCore.packets > 0 && s.multiCore.rawMb > 1 && s; }, 30000);
  assert.ok(st, 'packets compressed on the pool: ' + JSON.stringify((await c.status()).multiCore));
  assert.equal(st.multiCore.compressedHere, 0); assert.equal(st.multiCore.redone, 0);
  assert.ok(await waitFor(() => bots.every((b) => b.stats.bytes > 100000 && !b.stats.kicked), 30000), 'both got their chunks: ' + bots.map((b) => b.stats.bytes));

  // A block placed next to a player is in its chunk file after the next autosave; that file was gzipped
  // on the pool (no padding after the gzip data, unlike the game's own writes).
  const [bx, , bz] = bots[0].spawn.map(Math.floor);
  const x1 = bx + 2, y = 250, z1 = bz + 2;
  let t = Date.now();
  assert.match((await c.consoleCommand(`setblock ${x1} ${y} ${z1} minecraft:gold_block`, { allowOp: true })).lines.join(' '), /Block placed/);
  assert.ok(await roundAfter(t), 'an autosave round');
  await waitFor(() => savedBlock(st.world, x1, y, z1) === 41, 10000);
  assert.equal(savedBlock(st.world, x1, y, z1), 41, 'the gold block is saved');
  st = await c.status();
  assert.ok(st.multiCore.saves > 0, 'chunk files gzipped on the pool: ' + JSON.stringify(st.multiCore));
  let files = storedFiles(st.world);
  assert.equal(files.raw, 0, 'nothing stored uncompressed');
  assert.ok(files.exact > 0, 'chunk files written through the pool: ' + JSON.stringify(files));

  // Off while the players play: the game compresses again; on again.
  c.saveConfig({ multiCore: false });
  let r = await c.applySettings();
  assert.equal(r.multiCore.on, false); assert.equal(r.multiCore.status, 'off');
  const packetsOff = (await c.status()).multiCore.packets;
  const x2 = bx - 2, z2 = bz - 2;
  t = Date.now();
  assert.match((await c.consoleCommand(`setblock ${x2} ${y} ${z2} minecraft:diamond_block`, { allowOp: true })).lines.join(' '), /Block placed/);
  assert.ok(await roundAfter(t), 'an autosave round with the mode off');
  await waitFor(() => savedBlock(st.world, x2, y, z2) === 57, 10000);
  assert.equal(savedBlock(st.world, x2, y, z2), 57, 'saved by the game itself');
  assert.equal((await c.status()).multiCore.packets, packetsOff, 'no packet went through the pool while off');
  assert.ok(bots.every((b) => !b.stats.kicked && !b.stats.closed), 'the players stayed');
  c.saveConfig({ multiCore: true });
  r = await c.applySettings();
  assert.equal(r.multiCore.on, true);

  // "Save now" waits for the files still being compressed; then a stop and a restart: the game reads the
  // pool's gzip files (testforblock in the loaded chunks).
  const x3 = bx + 3, z3 = bz - 3;
  assert.match((await c.consoleCommand(`setblock ${x3} ${y} ${z3} minecraft:emerald_block`, { allowOp: true })).lines.join(' '), /Block placed/);
  const saves0 = (hostLog().match(/manual save complete/g) || []).length;
  await c.save();
  assert.ok(await waitFor(() => (hostLog().match(/manual save complete/g) || []).length > saves0, 60000), 'save complete');
  assert.equal(savedBlock(st.world, x3, y, z3), 133, 'saved when "Save now" says so');
  for (const b of bots) b.close();
  await c.stop();
  assert.match(hostLog(), /world saved and integrated server stopped cleanly/);
  files = storedFiles(st.world);
  assert.equal(files.raw, 0, 'nothing stored uncompressed after the stop');

  await c.start({ folder: st.world });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s; }, 120000);
  assert.equal(st.multiCore.on, true);
  const b2 = new Bot({ name: 'Gamma', relayUrl: relay.url, code: st.code }); bots.push(b2);
  await b2.join();
  assert.equal(await Promise.race([b2.ready, sleep(30000).then(() => false)]), true);
  for (const [x, z, id, name] of [[x1, z1, 41, 'gold_block'], [x2, z2, 57, 'diamond_block'], [x3, z3, 133, 'emerald_block']]) {
    const out = (await c.consoleCommand(`testforblock ${x} ${y} ${z} minecraft:${name}`, { allowOp: true })).lines.join(' ');
    assert.match(out, /Successfully found the block/, `${name} after the restart: ${out}`);
    void id;
  }
  b2.close();
  await c.stop();
  assert.doesNotMatch(hostLog(), /IDB error|multi-core pool: |worker uncaught/);

  // Without the game hook (gamePatches false) the mode says why it is off; the game runs as before.
  c.saveConfig({ gamePatches: false });
  await c.start({ folder: st.world });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.multiCore && s.multiCore.status === 'failed' && s; }, 120000);
  assert.ok(st, 'reported: ' + JSON.stringify((await c.status()).multiCore));
  assert.match(st.multiCore.error, /not available/);
  assert.match(hostLog(), /multi-core mode switched off: the multi-core mode is not available/);
  await c.stop();
  c.saveConfig({ gamePatches: true, multiCore: false });
});
