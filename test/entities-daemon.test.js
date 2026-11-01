'use strict';
// Stage 6 (many entities in one place) with the real daemon and game: the collision scan (speedup 6, config
// collisionScan) in verify mode (EAGLAN_DEBUG_SPEEDUPS_VERIFY: each walk it would leave out is made anyway, and the
// walks whose entities give a box are counted). An arena away from spawn with a crowd of mobs, boats in one corner and
// minecarts in another: walks left out, walks kept for a boat in reach and for a moving boat or minecart, none left out
// wrongly; the boats removed (/kill: no walk kept for a boat any more) and summoned again; the arena's chunks unloaded
// and loaded again (new sections, the boats in their lists again; the player, back and standing still, is shown the
// boats); the world restarted. Then without verify mode: walks left out while the game runs on; and with the config
// as it comes (off): the game's own walk.
//   node --test test/entities-daemon.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-ent-'));
process.env.EAGLAN_DATA = dataDir;
process.env.EAGLAN_DEBUG_SPEEDUPS_VERIFY = '1';
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const cmd = async (s) => (await c.consoleCommand(s, { allowOp: true })).lines.join(' ');
const loaded = async (x, y, z) => !/outside of the world/.test(await cmd(`testforblock ${x} ${y} ${z} minecraft:bedrock`));
// The collision scan's counters as the game thread last reported them (every 5 s), after waiting ms.
const scanAfter = async (ms, what) => { await sleep(ms); const s = { ...(await c.status()).speedups.collisionScan }; console.log(what + ': ' + JSON.stringify(s)); return s; };

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: collision scan with boats and minecarts among a crowd, verified, through despawns, chunk unloads and a restart', { timeout: 900000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ collisionScan: true });
  await c.create({ name: 'Entity World', seed: '12345' });
  const hosting = () => waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 120000);
  let st = await hosting();
  assert.ok(st, 'hosting');
  assert.match(hostLog(), /DEBUG: speedups: chunkCache, uuidText, packetBatch, longConstants, lightSets, collisionScan, verify mode/);
  const join = async () => {
    const b = new Bot({ name: 'Alpha', relayUrl: relay.url, code: (await c.status()).code }); bots.push(b);
    await b.join();
    assert.equal(await Promise.race([b.ready, sleep(60000).then(() => false)]), true, 'Alpha is in the world');
    return b;
  };
  const bot = await join();

  // The arena: 48 x 48 blocks (3 x 3 chunks) 400 blocks from spawn (outside the spawn chunks, which stay loaded), a stone
  // floor at y 120 and glass walls; the player above it at y 170, out of the zombies' reach. Boats in the corner chunk
  // at x0, z0 among animals; minecarts in the opposite corner chunk; zombies chasing villagers that take no damage (night
  // kept: zombies burn in daylight).
  const x0 = Math.floor((bot.spawn[0] + 400) / 16) * 16, z0 = Math.floor(bot.spawn[2] / 16) * 16, Y = 120, S = 48;
  for (const s of ['gamerule doMobSpawning false', 'time set 18000', 'gamerule doDaylightCycle false']) await cmd(s);
  await cmd(`tp Alpha ${x0 + 24} 170 ${z0 + 24}`);
  assert.ok(await waitFor(async () => (await loaded(x0, Y, z0)) && loaded(x0 + S - 1, Y, z0 + S - 1), 120000, 1000), 'the arena\'s chunks are loaded');
  const build = [];
  for (let l = Y + 1; l <= Y + 24; l += 8) build.push(`fill ${x0} ${l} ${z0} ${x0 + S - 1} ${l + 7} ${z0 + S - 1} minecraft:air`);
  build.push(`fill ${x0} ${Y} ${z0} ${x0 + S - 1} ${Y} ${z0 + S - 1} minecraft:stone`,
    `fill ${x0} ${Y + 1} ${z0} ${x0 + S - 1} ${Y + 4} ${z0} minecraft:glass`, `fill ${x0} ${Y + 1} ${z0 + S - 1} ${x0 + S - 1} ${Y + 4} ${z0 + S - 1} minecraft:glass`,
    `fill ${x0} ${Y + 1} ${z0} ${x0} ${Y + 4} ${z0 + S - 1} minecraft:glass`, `fill ${x0 + S - 1} ${Y + 1} ${z0} ${x0 + S - 1} ${Y + 4} ${z0 + S - 1} minecraft:glass`);
  for (const b of build) assert.doesNotMatch(await cmd(b), /outside of the world|Unknown|Usage/, b);
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const at = (xa, za, w) => `${(xa + 1.5 + rnd() * (w - 3)).toFixed(1)} ${Y + 1} ${(za + 1.5 + rnd() * (w - 3)).toFixed(1)}`;
  const boats = () => { const out = []; for (let i = 0; i < 6; i++) out.push(`summon Boat ${at(x0, z0, 16)}`); return out; };
  const summons = [...boats()];
  for (let i = 0; i < 16; i++) summons.push(`summon ${['Cow', 'Pig', 'Sheep', 'Chicken'][i % 4]} ${at(x0, z0, 16)} {PersistenceRequired:1}`);
  for (let i = 0; i < 4; i++) summons.push(`summon MinecartRideable ${at(x0 + 32, z0 + 32, 16)}`);
  for (let i = 0; i < 40; i++) summons.push(`summon Zombie ${at(x0, z0, S)} {PersistenceRequired:1}`);
  for (let i = 0; i < 16; i++) summons.push(`summon Villager ${at(x0, z0, S)} {Invulnerable:1,PersistenceRequired:1}`);
  for (const s of summons) assert.match(await cmd(s), /Object successfully summoned/, s);

  // Verified: walks left out (most of the arena has no boat), walks kept for a boat in reach and for a moving boat or
  // minecart, every section knows boats, and no walk left out had an entity that gives a box.
  let s1 = await scanAfter(20000, 'crowd, verify mode');
  assert.ok(s1.on && s1.verify && s1.ready, JSON.stringify(s1));
  assert.ok(s1.skipped > 1000 && s1.boats > 100 && s1.mover > 100, JSON.stringify(s1));
  assert.equal(s1.unknown, 0, 'every section knows boats'); assert.equal(s1.diff, 0, 'no walk left out wrongly');

  // The boats removed: their sections' lists are kept, so no walk is kept for a boat any more; summoned again: kept again.
  assert.match(await cmd('kill @e[type=Boat]'), /Killed/);
  const s2 = await scanAfter(7000, 'boats killed'), s3 = await scanAfter(7000, '7 s later');
  assert.equal(s3.boats, s2.boats, 'no boat left: ' + JSON.stringify([s2, s3]));
  assert.ok(s3.skipped > s2.skipped && s3.diff === 0, JSON.stringify(s3));
  for (const s of boats()) assert.match(await cmd(s), /Object successfully summoned/, s);
  const s4 = await scanAfter(12000, 'boats again');
  assert.ok(s4.boats > s3.boats && s4.diff === 0 && s4.unknown === 0, JSON.stringify(s4));

  // The arena's chunks unloaded (the player far away) and loaded again: new sections, the boats in their lists again.
  await cmd(`tp Alpha ${x0 + 3000} 170 ${z0}`);
  assert.ok(await waitFor(async () => !(await loaded(x0 + 8, Y, z0 + 8)), 120000, 1000), 'the arena\'s chunks are unloaded');
  const s5 = await scanAfter(6000, 'arena unloaded');
  await cmd(`tp Alpha ${x0 + 24} 170 ${z0 + 24}`);
  assert.ok(await waitFor(() => loaded(x0 + 8, Y, z0 + 8), 120000, 1000), 'and loaded again');
  // The player, teleported back and standing still, is shown the boats resting there (game patch "entities shown with
  // their chunk"; without it, only once the player or a boat goes 4 blocks)
  const boatsSeen = () => [...bot.entities.values()].filter((e) => e.kind === 'object' && e.type === 1).length;
  assert.ok(await waitFor(() => boatsSeen() >= 6, 20000), `Alpha is shown the 6 boats: ${boatsSeen()}`);
  const s6 = await scanAfter(15000, 'arena loaded again');
  assert.ok(s6.boats > s5.boats && s6.skipped > s5.skipped && s6.diff === 0 && s6.unknown === 0, JSON.stringify([s5, s6]));

  // A restart: the arena loaded from the saved world.
  const folder = st.world;
  const restart = async (cfg) => {
    for (const b of bots.splice(0)) b.close();
    await c.stop();
    if (cfg) c.saveConfig(cfg);
    await c.start({ folder });
    st = await hosting(); assert.ok(st, 'hosting again');
    await join();
  };
  await restart();
  const s7 = await scanAfter(20000, 'after a restart, verify mode');
  assert.ok(s7.on && s7.verify && s7.skipped > 1000 && s7.boats > 100 && s7.mover > 100, JSON.stringify(s7));
  assert.equal(s7.unknown, 0); assert.equal(s7.diff, 0);

  // Without verify mode the walks are left out; the game runs on (the counters keep rising).
  delete process.env.EAGLAN_DEBUG_SPEEDUPS_VERIFY;
  await restart();
  assert.match(hostLog(), /collision scan on \(config collisionScan: true\)/);
  const s8 = await scanAfter(15000, 'without verify mode'), s9 = await scanAfter(10000, '10 s later');
  assert.ok(s8.on && !s8.verify && s8.skipped > 1000 && s8.boats > 100, JSON.stringify(s8));
  assert.ok(s9.calls > s8.calls && s9.skipped > s8.skipped, JSON.stringify(s9));
  assert.equal((await c.status()).status, 'hosting');

  // The config as it comes (off): the game's own walk, nothing counted; the other speedups on.
  await restart({ collisionScan: false });
  await sleep(12000);
  const sp = (await c.status()).speedups;
  assert.equal(sp.collisionScan.on, false); assert.equal(sp.collisionScan.calls, 0); assert.equal(sp.collisionScan.ready, false);
  assert.equal(sp.lightSets.on, true); assert.equal(sp.chunkCache.on, true);
});
