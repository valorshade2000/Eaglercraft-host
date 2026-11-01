'use strict';
// The autosave spread over ticks (src/game-patches.js, hook "spread autosave"): applied once, and
// skipped when the game code differs; with the real daemon and a player in the world, a block a
// command placed reaches the saved chunk through a spread round, without a save command; config
// spreadAutosave: false keeps the game's own autosave.
//   node --test test/autosave.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-autosave-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const paths = require('../src/paths');
const { applyGamePatches, PATCHES } = require('../src/game-patches');
const { WORLDS_DB } = require('../src/worlds');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };

// A saved chunk's NBT with its byte arrays (the host's parseNBT leaves those out).
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
// The block id at (x, y, z) in the saved chunk, or null when the chunk or its section is not saved.
function savedBlock(folder, x, y, z) {
  const hex = (v) => Array.from({ length: 6 }, (_, i) => '0123456789ABCDEF'[((v + 1900000) >>> (4 * i)) & 15]).join('');
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, `worlds/${folder}/level0/${hex(x >> 4)}${hex(z >> 4)}.dat`);
    if (!row) return null;
    const section = (readNBT(zlib.gunzipSync(Buffer.from(row.data))).Level.Sections || []).find((s) => s.Y === y >> 4);
    return section ? section.Blocks[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : null;
  } finally { db.close(); }
}

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the hook is applied once to the vendored u53 game code, and skipped when any code it relies on differs', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const ok = applyGamePatches(orig);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.src.split('case 11:if($eaglanAutosave.on){$eaglanAsStart(a);}else{Dq_(a,h);if(B()){break _;}}').length - 1, 1, 'in place of saveAllWorlds(true) in the autosave tick');
  const step = 'case 8:$p=24;case 24:$eaglanAutosaveStep(a);if(B()){break _;}$p=25;case 25:$z=b();if(B()){break _;}b=$z;';
  assert.equal(ok.src.split(step).length - 1, 1, 'once per tick, at the start of its last case');
  const tick = orig.slice(orig.indexOf('\nfunction Gnh(a){'), orig.indexOf('\nfunction ', orig.indexOf('\nfunction Gnh(a){') + 1));
  assert.ok(!tick.includes('case 24:') && !tick.includes('case 25:'), 'cases 24 and 25 are new in MinecraftServer.tick');
  // Also when the pre-generation hook is not applied (its code differs).
  const noPregen = applyGamePatches(orig.split('function EIs(a,b,c){').join('function EIs(a,b,c) {'));
  assert.equal(noPregen.problems.length, 1);
  assert.match(noPregen.problems[0], /^world pre-generation not applied/);
  assert.ok(noPregen.src.includes(step));
  assert.doesNotThrow(() => new (require('node:vm').Script)(noPregen.src));
  const hook = PATCHES.find((x) => x.name === 'spread autosave');
  for (const anchor of [...hook.requires, ...hook.edits.map((e) => e.find)]) {
    const { src, problems } = applyGamePatches(orig.split(anchor).join(anchor.replace(/.$/, (ch) => (ch === ';' ? ',' : ';'))));
    assert.equal(problems.filter((x) => x.startsWith('spread autosave not applied')).length, 1, 'skipped without ' + anchor);
    assert.ok(!src.includes('__eaglanAutosave'), 'no hook without ' + anchor);
  }
});

test('daemon: a placed block is saved by a spread autosave round without a save command; spreadAutosave false keeps the game\'s autosave', { timeout: 300000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  await c.create({ name: 'Autosave World', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 120000);
  assert.ok(st, 'hosting');
  // A player keeps the chunks round spawn loaded, as in a game.
  const bot = new Bot({ name: 'Saver', relayUrl: relay.url, code: st.code }); bots.push(bot);
  await bot.join();
  assert.equal(await Promise.race([bot.ready, sleep(30000).then(() => false)]), true, 'the player is in the world');
  const x = Math.floor(bot.spawn[0]) + 3, y = 250, z = Math.floor(bot.spawn[2]) + 3;   // next to the player
  const placedAt = Date.now();
  const r = await c.consoleCommand(`setblock ${x} ${y} ${z} minecraft:gold_block`, { allowOp: true });
  assert.match(r.lines.join(' '), /Block placed/);
  assert.notEqual(savedBlock(st.world, x, y, z), 41, 'not saved yet');
  // The next autosave (every 900 ticks): a round that started after the block was placed, done.
  const round = await waitFor(async () => {
    const a = ((await c.status()).gameServer || {}).autosave;
    return a && a.on && a.last && a.last.startedAt > placedAt && a.last;
  }, 120000, 1000);
  assert.ok(round, 'an autosave round finished: ' + JSON.stringify(((await c.status()).gameServer || {}).autosave));
  assert.ok(round.saved > 0, 'chunks saved: ' + JSON.stringify(round));
  assert.ok(round.ticks >= 2, 'over more than the autosave tick: ' + JSON.stringify(round));
  assert.equal(savedBlock(st.world, x, y, z), 41, 'the gold block is in the saved chunk');
  assert.doesNotMatch(hostLog(), /\[autosave\] could not save|spread autosave not applied/);
  assert.doesNotMatch(hostLog(), /manual save complete/, 'no save command was used');
  bot.close();
  await c.stop();

  // Off: the game's own autosave (the hook's round never starts).
  c.saveConfig({ spreadAutosave: false });
  await c.start({ folder: st.world });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.gameServer && s.gameServer.autosave && s; }, 120000);
  assert.ok(st, 'hosting again, with the game thread\'s report');
  assert.equal(st.gameServer.autosave.on, false);
  assert.equal(st.gameServer.autosave.rounds, 0);
  await c.stop();
});
