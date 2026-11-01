'use strict';
// Regions with the real daemon and game (config regions): a player who goes far from everyone is moved, while
// playing, to a game instance of their own (no new join: the client gets a respawn and the new instance's world),
// with the same entity ID and inventory; chat, the tab list, time and weather go across instances; a command about a
// player runs in that player's instance; a block placed in each instance is saved by that instance; when the far
// player comes back, they are moved into the main instance the same way, and their instance stops; after a restart
// without regions both blocks are in the world.
//   node --test test/regions-daemon.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgd-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');
const { WORLDS_DB } = require('../src/worlds');
const { chunkPath } = require('../src/terrain');
const { readNBT } = require('../src/region-cells');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const cmd = async (s) => { const r = await c.consoleCommand(s, { allowOp: true }); assert.ok(!r.error, `${s}: ${JSON.stringify(r)}`); return r; };
// The block id at (x, y, z) in the world's saved chunk file. (Read right after the host stopped: Windows may still hold
// the database's files for a moment, a disk I/O error; read again.)
function savedBlock(folder, x, y, z) {
  for (let k = 0; ; k++) {
    try { return readSavedBlock(folder, x, y, z); } catch (e) { if (k >= 10 || !/disk I\/O|locked|busy/i.test(e.message)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
  }
}
function readSavedBlock(folder, x, y, z) {
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, chunkPath(`worlds/${folder}`, x >> 4, z >> 4));
    if (!row) return null;
    const sec = readNBT(require('node:zlib').gunzipSync(Buffer.from(row.data))).Level.Sections.find((s) => s.Y === (y >> 4));
    return sec ? sec.Blocks[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] & 255 : 0;
  } finally { db.close(); }
}
const where = async () => Object.fromEntries((await c.status()).regions.instances.flatMap((i) => i.players.map((p) => [p, i.id])));
const diamonds = async (who) => { const r = await cmd(`clear ${who} minecraft:diamond -1 0`); const m = /has (\d+) items?/.exec(r.lines.join(' ')); return m ? +m[1] : r.lines.join(' '); };

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: regions: players moved between instances while playing (split and merge), world-wide chat, tab list, time and weather, saves', { timeout: 900000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  // EAGLAN_TEST_CONFIG: more settings for this run (stage 8, E7: regions together with the other options)
  c.saveConfig({ regions: true, regionInstances: 2, viewDistance: 4, lanGamemode: 1, ...JSON.parse(process.env.EAGLAN_TEST_CONFIG || '{}') });
  await c.create({ name: 'Regions World', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st, 'hosting');
  assert.ok(st.regions && st.regions.on, 'regions on: ' + JSON.stringify(st.regions));
  const world = await waitFor(() => { const x = c.store.list()[0]; return x && x.spawn && x; }, 60000), [sx, , sz] = world.spawn;
  const join = async (name) => {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: () => {} });
    await b.join(); bots.push(b);
    assert.ok(await Promise.race([b.ready, sleep(30000).then(() => false)]), `${name} got into the world`);
    return b;
  };

  // Alice and Bob near spawn, in the main instance; Bob with 5 diamonds.
  const alice = await join('Alice');
  const bob = await join('Bob');
  await cmd('give Bob minecraft:diamond 5');
  assert.equal(await diamonds('Bob'), 5);
  // Bob goes 600 blocks away: after 20 s far from everyone he is moved to a region instance, still connected.
  const fx = Math.round(sx + 600), fz = Math.round(sz + 600);
  await cmd(`tp Bob ${fx} 120 ${fz}`);
  let w = await waitFor(async () => { const x = await where(); return x.Bob > 0 && x.Alice === 0 && x; }, 90000, 500);
  assert.ok(w, 'Bob moved to a region instance: ' + JSON.stringify(await where()));
  const r1 = w.Bob;
  assert.equal(bob.stats.kicked, null, 'not asked to join again');
  assert.ok(await waitFor(() => bob.stats.respawns >= 2 && bob.stats.moveMs.length >= 1, 15000), 'a respawn into another dimension and back, then the position from the new instance: ' + JSON.stringify([bob.stats.respawns, bob.stats.moveMs]));
  assert.match(hostLog(), new RegExp(`moving Bob from the main instance to r${r1}`));
  const ids = [...hostLog().matchAll(/Bob\[channel:[^\]]+\] logged in with entity id (\d+)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2 && ids.every((x) => x === ids[0]), 'the same entity ID in both instances: ' + ids.join(', '));
  assert.ok(await waitFor(() => bob.chunks.size > 20, 15000), 'Bob gets the region instance\'s chunks: ' + bob.chunks.size);
  assert.equal(await diamonds('Bob'), 5, 'his inventory came with him');

  // Chat both ways, the tab list, time and weather, across the two instances.
  alice.say('hello from Alice'); bob.say('hello from Bob');
  assert.ok(await waitFor(() => bob.stats.chat.some((j) => j.includes('hello from Alice')) && alice.stats.chat.some((j) => j.includes('hello from Bob')), 10000),
    'chat crossed: ' + JSON.stringify({ alice: alice.stats.chat.slice(-3), bob: bob.stats.chat.slice(-3) }));
  assert.ok(!alice.stats.chat.some((j) => /multiplayer\.player\.left/.test(j) && j.includes('Bob')), 'no "Bob left the game" for the move');
  await cmd('time set 6000');
  assert.ok(await waitFor(() => alice.stats.time >= 6000 && alice.stats.time < 6400 && bob.stats.time >= 6000 && bob.stats.time < 6400, 8000),
    'time set in both: ' + JSON.stringify([alice.stats.time, bob.stats.time]));
  await cmd('weather rain');
  assert.ok(await waitFor(() => alice.stats.raining === true && bob.stats.raining === true, 10000), 'rain in both: ' + JSON.stringify([alice.stats.raining, bob.stats.raining]));

  // A block in each instance: a command about a player runs in that player's instance.
  await cmd(`execute Bob ~ ~ ~ setblock ${fx} 100 ${fz} minecraft:gold_block`);
  await cmd(`execute Alice ~ ~ ~ setblock ${sx} 100 ${sz} minecraft:diamond_block`);
  assert.equal((await cmd(`execute Bob ~ ~ ~ testforblock ${fx} 100 ${fz} minecraft:gold_block`)).ok, true, 'the gold block, in Bob\'s instance');

  // Bob comes back to Alice: he is moved into the main instance, and his instance stops.
  const respawns = bob.stats.respawns;
  await cmd(`tp Bob ${sx + 4} 120 ${sz + 4}`);
  w = await waitFor(async () => { const x = await where(); return x.Bob === 0 && x; }, 40000, 500);
  assert.ok(w, 'Bob is in the main instance again: ' + JSON.stringify(await where()));
  assert.equal(bob.stats.kicked, null, 'still not asked to join again');
  assert.ok(await waitFor(() => bob.stats.respawns >= respawns + 2 && bob.stats.moveMs.length >= 2, 15000), 'moved again: ' + JSON.stringify([bob.stats.respawns, bob.stats.moveMs]));
  assert.ok(await waitFor(async () => (await c.status()).regions.instances.length === 1, 90000, 1000), 'the region instance stopped: ' + JSON.stringify((await c.status()).regions));
  assert.equal(await diamonds('Bob'), 5, 'his inventory came back with him');
  await cmd(`tp Bob ${fx} 120 ${fz}`); await sleep(2000);   // the chunk loaded in the main instance (testforblock needs it loaded)
  assert.equal((await cmd(`testforblock ${fx} 100 ${fz} minecraft:gold_block`)).ok, true, 'the region instance saved the gold block');
  assert.equal((await cmd(`testforblock ${sx} 100 ${sz} minecraft:diamond_block`)).ok, true, 'the diamond block is still there');
  st = await c.status();
  assert.ok(st.regions.moves.done >= 2 && st.regions.moves.failed === 0, JSON.stringify(st.regions.moves));

  // Saved: both blocks in the world's chunk files; and the world starts without regions.
  for (const b of bots.splice(0)) b.close();
  await c.stop();
  assert.equal(savedBlock(world.folder, fx, 100, fz), 41, 'gold block in its saved chunk');
  assert.equal(savedBlock(world.folder, sx, 100, sz), 57, 'diamond block in its saved chunk');
  c.saveConfig({ regions: false });
  await c.start({ folder: world.folder });
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s; }, 180000);
  assert.ok(st && !st.regions, 'hosting without regions');
  assert.doesNotMatch(hostLog(), /CRASHED|worker uncaught/);
});
