'use strict';
// The game rule playersSleepingPercentage (game-patches.js "players sleeping percentage", web page Game Rules): its
// count against 1.17's (at least one; ceil(players * n / 100); spectators aside), its rule lookup, and the game's own
// code without the rule or at 100. Then with the real daemon and game and three players in beds at night: without the
// rule one of three asleep keeps the night; at 50, two of three skip it, for everyone; a new value counts at once; at 0
// one is enough; at 100 a spectator keeps the night as the game does, at 99 the spectator does not count.
//   node --test test/sleep.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-sleep-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { sleepCode } = require('../src/game-patches');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) { await sleep(500); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

test('the count is 1.17\'s, the rule is read from the world\'s game rules, and without it (or at 100) the game decides', () => {
  // the game's objects as $eaglanSleep uses them: GameRules' sorted map (node: key cr, value dp, greater M, less bW; GO is
  // String.compareTo), a rule's integer Gu, the world's players pD (ArrayList: size b, items f.data), a player's game type
  // l3.qE (SPECTATOR HLu), in bed nu, ticks in bed uY
  const SPECTATOR = {};
  const S = new Function('GO', '$rt_str', 'HLu', sleepCode + 'return $eaglanSleep;')((a, b) => (a < b ? -1 : a > b ? 1 : 0), (x) => x, SPECTATOR);
  const node = (cr, v, bW = null, M = null) => ({ cr, dp: { Gu: v }, bW, M });
  const world = (pct, players = []) => ({
    bR: { gv: () => ({ fO: { bZ: node('keepInventory', 0, node('doMobSpawning', 1), pct === undefined ? node('randomTickSpeed', 3) : node('playersSleepingPercentage', pct, null, node('randomTickSpeed', 3))) } }) },
    pD: { b: players.length, f: { data: players } },
  });
  assert.equal(S.pct(world(undefined)), null, 'no rule: the game decides');
  assert.equal(S.pct(world(100)), null, 'at 100: the game decides');
  assert.deepEqual([S.pct(world(50)), S.pct(world(0)), S.pct(world(150))], [50, 0, 150]);
  // 1.17 SleepStatus.sleepersNeeded: Math.max(1, Mth.ceil((float)(activePlayers * percentage) / 100.0F))
  for (let active = 0; active <= 40; active++) for (const p of [0, 1, 10, 33, 50, 66, 99, 101, 150, -5]) assert.equal(S.need(p, active), Math.max(1, Math.ceil(Math.fround(active * p) / 100)), `${p} % of ${active}`);
  const pl = (state, spec = false) => ({ l3: { qE: spec ? SPECTATOR : {} }, nu: state > 0, uY: state === 2 ? 100 : state === 1 ? 40 : 0 });   // 0 awake, 1 in bed, 2 asleep (100 ticks)
  assert.equal(S.asleep(world(50, [pl(2), pl(0), pl(0), pl(0)]), 50), 0, '1 of 4 at 50 %');
  assert.equal(S.asleep(world(50, [pl(2), pl(2), pl(0), pl(0)]), 50), 1, '2 of 4 at 50 %');
  assert.equal(S.asleep(world(50, [pl(2), pl(1), pl(0), pl(0)]), 50), 0, 'one of the two only 40 ticks in bed');
  assert.equal(S.asleep(world(50, [pl(2), pl(0), pl(0, true)]), 50), 1, 'a spectator does not count: 1 of 2');
  assert.equal(S.asleep(world(0, [pl(2), pl(0), pl(0)]), 0), 1, 'at 0 one is enough');
  assert.equal(S.asleep(world(0, [pl(0), pl(0)]), 0), 0, 'but one, not none');
  assert.equal(S.asleep(world(0, [pl(0, true)]), 0), 0, 'only a spectator: no');
  assert.equal(S.asleep(world(150, [pl(2), pl(2)]), 150), 0, 'above 100: never');
});

test('daemon: players in beds at night: without the rule all must sleep; at 50 two of three; at 0 one; at 100 a spectator keeps the night, at 99 not', { timeout: 600000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ viewDistance: 4, lanGamemode: 1 });
  await c.create({ name: 'Sleep World', seed: '12345' });
  const st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st, 'hosting');
  const cmd = async (s) => { const r = await c.consoleCommand(s, { allowOp: true }); assert.ok(!r.error, `${s}: ${JSON.stringify(r)}`); return r; };
  const join = async (name) => {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: () => {} });
    await b.join(); bots.push(b);
    assert.ok(await Promise.race([b.ready, sleep(30000).then(() => false)]), `${name} got into the world`);
    return b;
  };
  const alice = await join('Alice'), bob = await join('Bob'), carol = await join('Carol');
  const all = [alice, bob, carol];
  const [sx, , sz] = alice.spawn.map(Math.round);
  await cmd('gamerule doMobSpawning false'); await cmd('kill @e[type=!Player]');
  // a stone floor in the air and a bed for each, the player beside it
  const spot = { Alice: [sx, sz], Bob: [sx + 4, sz], Carol: [sx + 8, sz] };
  for (const [who, [x, z]] of Object.entries(spot)) {
    await cmd(`fill ${x - 1} 149 ${z - 2} ${x + 1} 149 ${z + 3} minecraft:stone`);
    await cmd(`setblock ${x} 150 ${z} minecraft:bed 0`); await cmd(`setblock ${x} 150 ${z + 1} minecraft:bed 8`);
  }
  const toBed = async (bot) => {
    const [x, z] = spot[bot.name];
    await cmd(`tp ${bot.name} ${x + 0.5} 150 ${z - 0.5}`); await sleep(1500);
    bot.useBlock(x, 150, z);
  };
  const night = async () => { await cmd('time set 18000'); await waitFor(() => all.every((b) => b.stats.time >= 18000 && b.stats.time < 18600), 10000); };
  const skipped = (ms) => waitFor(() => all.every((b) => b.stats.time >= 23900 && b.stats.time < 24600), ms);   // the next morning, for everyone
  const stillNight = () => all.every((b) => b.stats.time > 18000 && b.stats.time < 20000);
  const times = () => all.map((b) => `${b.name} ${b.stats.time}`).join(', ');

  // without the rule: everyone must sleep (the game's own rule)
  await night();
  await toBed(alice);
  await sleep(9000);   // (asleep after 100 ticks: 5 s)
  assert.ok(stillNight(), `1 of 3 asleep, no rule: still night (${times()})`);
  // at 50 two of three are needed: still night with Alice alone, the morning once Bob is asleep too; at once, while
  // Alice was already in bed
  await cmd('gamerule playersSleepingPercentage 50');
  await sleep(3000);
  assert.ok(stillNight(), `1 of 3 at 50 %: still night (${times()})`);
  await toBed(bob);
  assert.ok(await skipped(20000), `2 of 3 at 50 %: the next morning for all three (${times()})`);
  // at 0 one is enough
  await sleep(2000); await night();
  await cmd('gamerule playersSleepingPercentage 0');
  await toBed(carol);
  assert.ok(await skipped(20000), `1 of 3 at 0 %: the next morning (${times()})`);
  // at 100 the game's own rule, a spectator included: Alice and Bob asleep, Carol a spectator: still night, as the game
  // does; at 99 the spectator does not count: the morning
  await sleep(2000); await night();
  await cmd('gamerule playersSleepingPercentage 100');
  await cmd('gamemode 3 Carol');
  await toBed(alice); await toBed(bob);
  await sleep(9000);
  assert.ok(stillNight(), `at 100 a spectator keeps the night, as in 1.8.8 (${times()})`);
  await cmd('gamerule playersSleepingPercentage 99');
  assert.ok(await skipped(20000), `at 99 the spectator does not count: 2 of 2 asleep, the next morning (${times()})`);
  assert.match((await cmd('gamerule playersSleepingPercentage')).lines.join(' '), /playersSleepingPercentage = 99/, 'the rule stored in the world, as /gamerule shows it');
  for (const b of bots) b.close();
  await c.stop();
});
