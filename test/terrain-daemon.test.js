'use strict';
// Terrain threads with the real daemon and game (config terrainThreads): a pre-generation job with
// terrainVerify (every chunk a thread makes is compared with the game's own, block by block: all the
// same), a second job over the saved chunks (the thread is asked for none of them), then after a
// restart without terrainVerify a job whose terrain comes from the thread (every 32nd chunk still
// compared), every chunk of it saved, populated and lit, and the thread gone once the job is over.
// For players (terrainForPlayers): a player walking into new terrain, with terrainVerify (every chunk the
// thread made ahead of the player compared with the game's own, blocks and biomes: all the same), then after a
// restart without it (the thread's terrain and biomes used, every 32nd still compared), the chunks saved,
// populated and lit, with the biomes the game gives them.
//   node --test test/terrain-daemon.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-ttd-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { WORLDS_DB } = require('../src/worlds');
const { chunkPath } = require('../src/terrain');
const { readNbt } = require('./bench/compare-worlds');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
// A job of radius blocks (at the top rate unless given), until it is finished and everything it loaded is handed back.
async function pregen(radius, rate = 50) {
  const r = await c.pregen({ action: 'start', radius, rate });
  assert.ok(!r.error, JSON.stringify(r));
  const done = await waitFor(async () => { const p = (await c.status()).pregen; return p && p.done && !p.loadedNow && !p.pendingLights && p; }, 300000, 500);
  assert.ok(done, 'the job finished: ' + JSON.stringify((await c.status()).pregen));
  await sleep(6000);   // the game thread's next report (every 5 s)
  return { p: done, t: (await c.status()).terrain };
}
function savedChunk(folder, x, z) {
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
  try { const row = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, chunkPath(`worlds/${folder}`, x, z)); return row ? readNbt(zlib.gunzipSync(Buffer.from(row.data))).Level : null; } finally { db.close(); }
}

const relays = [];
after(async () => {
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: terrain threads for pre-generation, compared with the game\'s own terrain', { timeout: 900000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ terrainThreads: 1, terrainVerify: true });
  await c.create({ name: 'Terrain World', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.terrain && s; }, 180000);
  assert.ok(st, 'hosting');
  assert.equal(st.terrain.state, 'waiting', 'nothing runs before a job: ' + JSON.stringify(st.terrain));
  assert.equal(st.terrain.threads, 0);

  // terrainVerify: every chunk a thread makes is compared with the game's own and none is used. (At 10 chunks/s the thread
  // is ready while most of the job is still ahead; at the top rate the game, faster since speedup 4, makes most of a job
  // this small itself while the thread starts.)
  let { p, t } = await pregen(48, 10);
  assert.match(hostLog(), /terrain threads: starting 1 for the pre-generation job; every chunk is compared/);
  assert.match(hostLog(), /terrain threads: ready after \d+\.\d s/);
  assert.equal(p.generated + p.read + p.alreadyLoaded, p.total);
  assert.ok(t.game.checked >= 40, 'compared: ' + JSON.stringify(t));
  assert.equal(t.game.same, t.game.checked, 'the same terrain: ' + JSON.stringify(t.game));
  assert.equal(t.game.differ, 0); assert.equal(t.game.used, 0);
  assert.equal(t.error, null);
  assert.match(hostLog(), /pre-generation finished .*; terrain threads: \d+ chunks made \([\d.]+ ms each\), 0 used, \d+ compared with the game's own \(\d+ the same\)/);
  const made = t.made;

  // A second job over the same chunks: all saved, so the thread is asked for none of them.
  // (at 10 chunks/s: with nobody online a job over saved chunks loads up to 16 a tick, faster than the thread starts again)
  ({ p, t } = await pregen(48, 10));
  assert.equal(p.generated, 0); assert.ok(p.read > 100, JSON.stringify(p));
  assert.equal(t.made, made, 'nothing made: ' + JSON.stringify(t));
  // (the job reads saved chunks fast: some are past before the thread, started again, is ready)
  assert.ok(t.onDisk >= 30, 'saved chunks skipped: ' + JSON.stringify(t));

  // The thread ends 10 s after a job.
  st = await waitFor(async () => { const s = await c.status(); return s.terrain && s.terrain.threads === 0 && s.terrain.state === 'waiting' && s; }, 30000);
  assert.ok(st, 'the thread ended: ' + JSON.stringify((await c.status()).terrain));
  assert.match(hostLog(), /terrain threads ended \(the pre-generation job ended\)/);
  await c.stop();

  // Without terrainVerify: the thread's terrain is used; every 32nd chunk is still compared.
  c.saveConfig({ terrainVerify: false });
  await c.start({ folder: st.world });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.terrain && s; }, 180000);
  assert.ok(st, 'hosting again');
  ({ p, t } = await pregen(128));   // 441 chunks, of which the 121 of the first job are saved
  assert.equal(p.generated, 320, JSON.stringify(p));
  assert.ok(t.game.used > 200, 'used: ' + JSON.stringify(t));
  assert.ok(t.game.checked >= 3, 'compared: ' + JSON.stringify(t.game));
  assert.equal(t.game.same, t.game.checked); assert.equal(t.game.differ, 0); assert.equal(t.error, null);
  assert.ok(t.game.used + t.game.checked <= p.generated, 'only chunks the job generated');
  // every chunk within the radius saved, populated (trees, ores) and lit
  const [cx, cz] = [p.cx, p.cz];
  let n = 0;
  for (let x = cx - 6; x <= cx + 6; x++) for (let z = cz - 6; z <= cz + 6; z++) {
    const L = savedChunk(st.world, x, z);
    assert.ok(L, `chunk ${x}, ${z} saved`);
    assert.equal(L.TerrainPopulated, 1, `chunk ${x}, ${z} populated`);
    assert.equal(L.LightPopulated, 1, `chunk ${x}, ${z} lit`);
    n++;
  }
  assert.equal(n, 169);
  assert.doesNotMatch(hostLog(), /terrain threads (stopped|not used)/);
  await c.stop();
});

test('daemon: terrain threads for players: the chunks they are about to reach, compared, then used with their biomes', { timeout: 900000 }, async () => {
  try { await c.stop(); } catch {}   // (a test before that failed may have left its world running)
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ terrainThreads: 1, terrainVerify: true, terrainForPlayers: true, viewDistance: 4 });
  await c.create({ name: 'Players World', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s.terrain && s; }, 180000);
  assert.ok(st, 'hosting');
  assert.equal(st.terrain.forPlayers, true); assert.equal(st.terrain.threads, 0, 'nothing runs before a player reaches new terrain');
  // A player walking east at 8 blocks a second (a boat's speed), 40 s: about 20 chunks into terrain nobody has made.
  const walk = async (name, angle, ms) => {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code, path: { kind: 'line', angle, speed: 8 }, log: () => {} });
    await b.join();
    assert.ok(await Promise.race([b.ready, sleep(60000).then(() => false)]), name + ' got into the world');
    b.go(); await sleep(ms); b.close();
    return b;
  };
  let b = await walk('Walker', 0, 40000);
  assert.ok(b.stats.distance > 150, 'walked: ' + Math.round(b.stats.distance));
  await sleep(6000);   // the game thread's next report (every 5 s)
  let t = (await c.status()).terrain;
  assert.equal(t.use, 'players', JSON.stringify(t));
  assert.ok(t.playAsked >= 50 && t.made >= 50, 'made for the player: ' + JSON.stringify(t));
  assert.ok(t.game.checked >= 40, 'compared: ' + JSON.stringify(t.game));
  assert.equal(t.game.same, t.game.checked); assert.equal(t.game.checkedBiomes, t.game.checked, 'with their biomes'); assert.equal(t.game.differ, 0); assert.equal(t.game.used, 0, 'verify: none used');
  assert.match(hostLog(), /terrain threads: starting 1 for the chunks players are about to reach; every chunk is compared/);
  await c.stop();

  // Without terrainVerify: the thread's terrain and biomes are used; every 32nd chunk is still compared.
  c.saveConfig({ terrainVerify: false });
  await c.start({ folder: st.world });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s.terrain && s; }, 180000);
  assert.ok(st, 'hosting again');
  b = await walk('Walker', Math.PI / 2, 40000);   // south from where he stopped: new terrain again
  assert.ok(b.stats.distance > 150, 'walked: ' + Math.round(b.stats.distance));
  await sleep(6000);
  t = (await c.status()).terrain;
  assert.ok(t.game.used >= 40, 'used: ' + JSON.stringify(t.game));
  assert.equal(t.game.biomes, t.game.used, 'every one with its biomes');
  assert.equal(t.game.same, t.game.checked); assert.equal(t.game.differ, 0); assert.equal(t.error, null);
  // the chunks along his way saved, populated and lit (those the game made from the thread's terrain among them)
  const at = b.pos, [px, pz] = [Math.floor(at[0]) >> 4, Math.floor(at[2]) >> 4];
  await c.stop();   // everything saved
  let n = 0;
  for (let dz = -12; dz <= -4; dz++) {
    const L = savedChunk(st.world, px, pz + dz);
    assert.ok(L, `chunk ${px}, ${pz + dz} saved`);
    assert.equal(L.TerrainPopulated, 1, `chunk ${px}, ${pz + dz} populated`);
    assert.equal(L.LightPopulated, 1, `chunk ${px}, ${pz + dz} lit`);
    assert.equal(L.Biomes.length, 256, 'its biomes');
    n++;
  }
  assert.equal(n, 9);
  assert.doesNotMatch(hostLog(), /terrain threads (stopped|not used)/);
});
