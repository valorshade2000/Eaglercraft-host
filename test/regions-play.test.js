'use strict';
// Regions in play (stage 7) with the real daemon and game: Alice and Carl near spawn in the main instance, Bob (an OP)
// far away in a region instance of his own; his client shows the boat that stood next to him before he was moved. Bob
// rides the boat while he is moved into the main instance and out again (the boat comes with him: one boat in the
// world); a console command with @e answers for every instance; Bob's
// "/give @a" reaches the players of the other instance; the console's "say @a" names every player and every player
// sees it, as Bob's "/me"; Alice and Bob draw on copies of one map in two instances and the saved map keeps both
// drawings; Bob's instance ends abruptly (as a crash): Bob is disconnected with a message, the others see him leave
// (tab list, "left the game"), its cells are free, and Bob joins again where he was saved (the others see him join);
// Bob dies in his instance: the others see his death message, and he comes back at the world spawn, in the main
// instance. No stall.
//   node --test test/regions-play.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgp-'));
process.env.EAGLAN_DATA = dataDir;
process.env.EAGLAN_DEBUG = '1';   // the host's /debug/region-exit
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');
const { WORLDS_DB } = require('../src/worlds');
const { readNBT } = require('../src/region-cells');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const cmd = async (s) => { const r = await c.consoleCommand(s, { allowOp: true }); assert.ok(!r.error, `${s}: ${JSON.stringify(r)}`); return r; };
const where = async () => Object.fromEntries((await c.status()).regions.instances.flatMap((i) => i.players.map((p) => [p, i.id])));
const count = async (what, sel) => (await cmd(`clear ${what}`)).lines.join(' ');
const items = async (who, item) => { const r = await cmd(`clear ${who} minecraft:${item} -1 0`); const m = /has (\d+) items?/.exec(r.lines.join(' ')); return m ? +m[1] : 0; };
const found = async (sel) => ((await c.consoleCommand(`testfor ${sel}`, { allowOp: true })).lines.join('\n').match(/Found /g) || []).length;
const debug = async (p) => { const st = await c.status(); return new Promise((resolve, reject) => require('node:http').request({ host: '127.0.0.1', port: st.controlPort, path: p, method: 'POST' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b || '{}'))); }).on('error', reject).end()); };
// The pixels of the saved map map_<id>.
function savedMap(folder, id) {
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
  try { const row = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, `worlds/${folder}/data/map_${id}.dat`); return row ? readNBT(zlib.gunzipSync(Buffer.from(row.data))).data : null; } finally { db.close(); }
}

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: regions in play: riding across moves, commands and maps across instances, a crashed instance', { timeout: 900000 }, async () => {
  void count;
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ regions: true, regionInstances: 2, viewDistance: 4, lanGamemode: 1, ops: ['Bob'] });
  await c.create({ name: 'Regions Play', seed: '12345' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st && st.regions && st.regions.on, 'hosting with regions');
  const world = await waitFor(() => { const x = c.store.list()[0]; return x && x.spawn && x; }, 60000), [sx, , sz] = world.spawn.map(Math.floor);
  const join = async (name) => {
    const b = new Bot({ name, relayUrl: relay.url, code: (await c.status()).code, path: { kind: 'still' }, log: () => {} });
    await b.join(); bots.push(b);
    assert.ok(await Promise.race([b.ready, sleep(30000).then(() => false)]), `${name} got into the world`);
    return b;
  };
  const alice = await join('Alice'), bob = await join('Bob'), carl = await join('Carl');
  for (const s of ['gamerule doMobSpawning false', 'time set 6000', 'gamerule doDaylightCycle false']) await cmd(s);
  // a map of the area round spawn, held by Alice (made in the main instance; scale 3: 8 blocks a pixel, 1024 blocks wide), and a copy for Bob
  await cmd('give Alice minecraft:filled_map 1 0');
  const mapId = await waitFor(() => { const m = hostLog().match(/map_(\d+)/); return m ? +m[1] : 0; }, 3000) || 0;
  void mapId;

  // Bob goes 450 blocks away, onto a stone floor; 20 s far from everyone: an instance of his own. Towards the middle of
  // the map the game makes round the spawn (centred on a grid of 1024 blocks, as MapData.calculateMapCenter does), so
  // that both places are on it.
  const mapX = Math.floor((sx + 64) / 1024) * 1024 + 448, fx = sx < mapX ? sx + 450 : sx - 450, fz = sz, Y = 120;
  await cmd(`tp Bob ${fx} ${Y + 5} ${fz}`);
  assert.ok(await waitFor(async () => !/outside of the world/.test((await c.consoleCommand(`execute Bob ~ ~ ~ testforblock ${fx} ${Y} ${fz} minecraft:bedrock`, { allowOp: true })).lines.join(' ')), 60000, 1000), 'Bob\'s chunks are loaded');
  await cmd(`execute Bob ~ ~ ~ fill ${fx - 12} ${Y} ${fz - 12} ${fx + 12} ${Y} ${fz + 12} minecraft:stone`);
  await cmd(`execute Bob ~ ~ ~ fill ${fx - 12} ${Y + 1} ${fz - 12} ${fx + 12} ${Y + 8} ${fz + 12} minecraft:air`);
  await cmd(`tp Bob ${fx + 0.5} ${Y + 1} ${fz + 0.5}`);
  await cmd(`execute Bob ~ ~ ~ summon Boat ${fx + 2} ${Y + 1} ${fz + 0.5}`);   // a boat next to him, before he is moved
  let w = await waitFor(async () => { const x = await where(); return x.Bob > 0 && x; }, 90000, 500);
  assert.ok(w, 'Bob in a region instance: ' + JSON.stringify(await where()));

  // Riding: Bob's client shows the boat that stood there before he arrived (game patch "entities shown with their
  // chunk"), and he gets in; the others come near (Bob moves into the main instance), then leave (Bob moves out).
  const boat = await waitFor(() => bob.nearest('object', 1), 10000);
  assert.ok(boat, 'Bob\'s client shows the boat that stood next to him before he was moved');
  bob.useEntity(boat);
  assert.ok(await waitFor(() => bob.vehicle != null, 10000), 'Bob is in the boat');
  assert.equal(await found('@e[type=Boat]'), 1, 'the console finds the boat in Bob\'s instance (an @e command answers for every instance)');
  let resp = bob.stats.respawns;
  await cmd(`tp Alice ${fx + 40} ${Y + 30} ${fz}`); await cmd(`tp Carl ${fx + 41} ${Y + 30} ${fz}`);
  assert.ok(await waitFor(async () => (await where()).Bob === 0 && bob.stats.respawns >= resp + 2, 60000, 500), 'Bob moved into the main instance: ' + JSON.stringify(await where()));
  assert.ok(await waitFor(() => bob.vehicle != null, 15000), 'still in a boat after the move');
  assert.equal(await found('@e[type=Boat]'), 1, 'one boat in the world (it came with Bob)');
  resp = bob.stats.respawns;
  await cmd(`tp Alice ${sx} ${Y + 50} ${sz}`); await cmd(`tp Carl ${sx + 1} ${Y + 50} ${sz}`);
  assert.ok(await waitFor(async () => (await where()).Bob > 0 && bob.stats.respawns >= resp + 2, 90000, 500), 'Bob moved to a region instance again: ' + JSON.stringify(await where()));
  assert.ok(await waitFor(() => bob.vehicle != null, 15000), 'still in a boat');
  assert.equal(await found('@e[type=Boat]'), 1, 'one boat in the world');
  bob.sneak(); assert.ok(await waitFor(() => bob.vehicle == null, 10000), 'Bob gets off');

  // Commands across instances: Bob's /give @a reaches Alice and Carl; the console's say @a names every player.
  for (const n of ['Alice', 'Bob', 'Carl']) await cmd(`clear ${n}`);
  bob.say('/give @a minecraft:diamond 2');
  assert.ok(await waitFor(async () => (await items('Alice', 'diamond')) === 2 && (await items('Carl', 'diamond')) === 2 && (await items('Bob', 'diamond')) === 2, 15000),
    'two diamonds each: ' + JSON.stringify([await items('Alice', 'diamond'), await items('Bob', 'diamond'), await items('Carl', 'diamond')]));
  await cmd('say Hello @a');
  const plain = (j) => j.replace(/§./g, '');   // (the game puts formatting resets between the words)
  assert.ok(await waitFor(() => alice.stats.chat.some((j) => plain(j).includes('Hello Alice, Bob and Carl')) && bob.stats.chat.some((j) => plain(j).includes('Hello Alice, Bob and Carl')), 10000),
    'say names every player, and every player sees it: ' + JSON.stringify({ alice: alice.stats.chat.slice(-2), bob: bob.stats.chat.slice(-2) }));
  bob.say('/me waves');
  assert.ok(await waitFor(() => alice.stats.chat.some((j) => j.includes('chat.type.emote') && plain(j).includes('waves')), 10000), 'Bob\'s /me shows in the other instance');

  // Maps: Alice (main instance) and Bob (his instance) hold copies of one map; both draw their areas; saved, the map has both.
  for (const n of ['Alice', 'Bob']) await cmd(`clear ${n}`);
  await cmd('give Alice minecraft:filled_map 1 0');
  await sleep(4000); await cmd('save-all');
  const map0 = await waitFor(() => savedMap(world.folder, 0), 20000);
  assert.ok(map0, 'map_0 saved by the main instance');
  await cmd(`tp Alice ${sx} ${Y + 10} ${sz}`); await cmd(`tp Bob ${fx} ${Y + 10} ${fz}`);
  await cmd('give Bob minecraft:filled_map 1 0');
  await sleep(20000); await cmd('save-all'); await sleep(3000);
  const m = savedMap(world.folder, 0), px = (bx, bz) => { const s = 1 << m.scale, x = Math.floor((bx - m.xCenter) / s) + 64, z = Math.floor((bz - m.zCenter) / s) + 64; return x >= 0 && x < 128 && z >= 0 && z < 128 ? m.colors[x + z * 128] & 255 : null; };
  const drawn = (bx, bz) => { let n = 0; for (let dx = -48; dx <= 48; dx += 16) for (let dz = -48; dz <= 48; dz += 16) if (px(bx + dx, bz + dz)) n++; return n; };
  assert.ok(drawn(sx, sz) > 10 && drawn(fx, fz) > 10, `both areas on the saved map (scale ${m.scale}, centre ${m.xCenter} ${m.zCenter}): round spawn ${drawn(sx, sz)}, round Bob ${drawn(fx, fz)} pixels of 49`);

  // Bob's instance ends abruptly: Bob is disconnected with a message, its cells are free, and Bob joins again.
  const rid = (await where()).Bob;
  assert.ok(rid > 0, 'Bob in a region instance');
  await cmd('save-all'); await sleep(2000);
  const inTab = (b, n) => [...b.tab.values()].includes(n), saw = (b, re) => b.stats.chat.some((j) => re.test(j) && j.includes('"Bob"'));
  assert.ok(inTab(alice, 'Bob'), 'Bob in Alice\'s tab list');
  alice.stats.chat.length = 0;
  assert.deepEqual(await debug(`/debug/region-exit?id=${rid}`), { ok: true });
  assert.ok(await waitFor(() => bob.stats.kicked || bob.stats.closed, 15000), 'Bob is disconnected');
  if (bob.stats.kicked) assert.match(bob.stats.kicked, /stopped unexpectedly/);
  assert.ok(await waitFor(() => !inTab(alice, 'Bob') && saw(alice, /multiplayer\.player\.left/), 10000), 'the others see Bob leave (tab list, "left the game"): ' + JSON.stringify(alice.stats.chat));
  st = await waitFor(async () => { const s = await c.status(); return !s.regions.instances.some((i) => i.id === rid) && s; }, 15000);
  assert.ok(st, 'r' + rid + ' gone: ' + JSON.stringify((await c.status()).regions.instances));
  assert.match(hostLog(), new RegExp(`region instance r${rid} ended unexpectedly; its players \\(Bob\\)`));
  bots.splice(bots.indexOf(bob), 1); bob.close();
  const bob2 = await join('Bob');
  assert.ok(await waitFor(async () => (await where()).Bob != null, 30000), 'Bob plays again');
  assert.ok(await waitFor(() => bob2.chunks.size > 20, 20000), 'with his chunks');
  assert.ok(Math.abs(bob2.spawn[0] - fx) < 32 && Math.abs(bob2.spawn[2] - fz) < 32, 'where he was saved: ' + bob2.spawn.map(Math.round).join(' '));
  assert.equal(await items('Bob', 'filled_map'), 1, 'with his map (saved before the end)');
  assert.ok(await waitFor(() => inTab(alice, 'Bob') && saw(alice, /multiplayer\.player\.joined/), 10000), 'the others see Bob join again: ' + JSON.stringify(alice.stats.chat));
  assert.ok((await where()).Bob > 0, 'Bob in a region instance');

  // Bob dies in his instance: the others see his death message; he comes back at the world spawn, which the main
  // instance has, so he is moved into it.
  alice.stats.chat.length = 0;
  await cmd('kill Bob');
  assert.ok(await waitFor(() => saw(alice, /death\./), 10000), 'Alice sees Bob\'s death message: ' + JSON.stringify(alice.stats.chat));
  assert.ok(await waitFor(async () => (await where()).Bob === 0 && bob2.chunks.size > 20, 60000, 500), 'Bob back at the world spawn, in the main instance: ' + JSON.stringify(await where()));
  assert.ok(Math.abs(bob2.pos[0] - sx) < 48 && Math.abs(bob2.pos[2] - sz) < 48, 'near the spawn: ' + bob2.pos.map(Math.round).join(' '));

  st = await c.status();
  assert.equal(st.regions.moves.failed, 0, JSON.stringify(st.regions.moves));
  assert.doesNotMatch(hostLog(), /\] stall: |worker uncaught|CRASHED/);
});
