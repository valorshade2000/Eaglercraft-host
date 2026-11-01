'use strict';
// Regions, the world-wide state (stage 4) with the real daemon and game (config regions): Alice in the main instance,
// Bob far away in a region instance of his own. Commands across instances: /tell, /list, a world-wide command a player
// types (time, game rules) in a region instance, console selectors (@a in every instance, @r one player of all), a
// command about a player of another instance, /tp to a player of another instance (the two instances become one).
// Sleeping: the night is over only when the players of every instance sleep. Maps: one count of ids, files kept. The
// scoreboard: objectives by commands in every instance, scores set in one instance the same in all.
//   node --test test/regions-world.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgw-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const cmd = async (s) => { const r = await c.consoleCommand(s, { allowOp: true }); assert.ok(!r.error, `${s}: ${JSON.stringify(r)}`); return r; };
const where = async () => Object.fromEntries((await c.status()).regions.instances.flatMap((i) => i.players.map((p) => [p, i.id])));
const count = async (who, item, data = -1) => { const r = await cmd(`clear ${who} minecraft:${item} ${data} 0`); const m = /has (\d+) items?/.exec(r.lines.join(' ')); return m ? +m[1] : 0; };
// Whether the world's storage has the file (a path in the world's folder).
const savedFile = (folder, rel) => {
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
  try { return !!db.prepare('SELECT 1 FROM files WHERE db = ? AND path = ?').get(require('../src/worlds').WORLDS_DB, `worlds/${folder}/${rel}`); } finally { db.close(); }
};
const saw = (bot, ...parts) => bot.stats.chat.some((j) => parts.every((p) => j.includes(p)));

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: regions: the world-wide state across instances: commands, sleeping, maps, the scoreboard', { timeout: 900000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ regions: true, regionInstances: 2, viewDistance: 4, lanGamemode: 1, lanCheats: true });
  await c.create({ name: 'Regions World', seed: '12345' });
  const st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st && st.regions && st.regions.on, 'hosting with regions');
  const world = await waitFor(() => { const x = c.store.list()[0]; return x && x.spawn && x; }, 60000), [sx, , sz] = world.spawn;
  const join = async (name) => {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: () => {} });
    await b.join(); bots.push(b);
    assert.ok(await Promise.race([b.ready, sleep(30000).then(() => false)]), `${name} got into the world`);
    return b;
  };
  const alice = await join('Alice'), bob = await join('Bob');
  await cmd(`tp Bob ${Math.round(sx + 600)} 120 ${Math.round(sz + 600)}`);
  const w = await waitFor(async () => { const x = await where(); return x.Bob > 0 && x.Alice === 0 && x; }, 90000, 500);
  assert.ok(w, 'Bob in a region instance of his own: ' + JSON.stringify(await where()));

  // /tell to a player of another instance: shown to both as the game shows a whisper
  alice.say('/tell Bob hello across');
  assert.ok(await waitFor(() => saw(bob, 'commands.message.display.incoming', 'Alice', 'hello across') && saw(alice, 'commands.message.display.outgoing', 'Bob', 'hello across'), 10000),
    'the whisper reached Bob and Alice saw it sent');
  assert.ok(!saw(alice, 'commands.generic.player.notFound'), 'not "player not found"');
  // /list: the players of every instance
  bob.say('/list');
  assert.ok(await waitFor(() => saw(bob, 'commands.players.list', '"2"') && bob.stats.chat.some((j) => /Alice, Bob|Bob, Alice/.test(j)), 10000), '/list shows both');
  // a world-wide command a player types in a region instance holds everywhere (the main instance's time was put back
  // over it every second before)
  bob.say('/time set 1000');
  bob.say('/gamerule doDaylightCycle false');
  await sleep(3000);
  // (with the daylight cycle off the game sends the time negative: the client then stops it)
  assert.ok(await waitFor(() => alice.stats.time === -1000 && bob.stats.time === -1000, 10000), `time 1000 for both, daylight cycle off: ${alice.stats.time}, ${bob.stats.time}`);
  assert.match((await cmd('gamerule doDaylightCycle')).lines.join(' '), /false/, 'the game rule in the main instance too');
  // console selectors: @a in every instance, @r one player of all
  await cmd('give @a minecraft:diamond 1');
  assert.deepEqual([await count('Alice', 'diamond'), await count('Bob', 'diamond')], [1, 1], '@a: both');
  await cmd('give @r minecraft:emerald 1');
  assert.equal((await count('Alice', 'emerald')) + (await count('Bob', 'emerald')), 1, '@r: one of them');
  const list = await cmd('list');
  assert.ok(list.lines.some((l) => /2\//.test(l)) && list.lines.some((l) => /Alice/.test(l) && /Bob/.test(l)), 'console list: ' + list.lines.join(' | '));
  // a command about a player of another instance runs there, and its answer comes back to the one who typed it
  bob.say('/give Alice minecraft:gold_ingot 2');
  assert.ok(await waitFor(async () => (await count('Alice', 'gold_ingot')) === 2, 10000), 'Alice got the gold');
  assert.ok(await waitFor(() => saw(bob, 'commands.give.success'), 10000), 'Bob was told');
  // sleeping: the night is over only when the players of every instance sleep, and then for everyone
  await cmd('gamerule doDaylightCycle true'); await cmd('time set 18000');
  const bed = async (who, x, z) => {   // a stone floor and a bed in the air at (x, 150, z), the player beside it, in bed
    await cmd(`execute ${who} ~ ~ ~ fill ${x - 2} 149 ${z - 2} ${x + 2} 149 ${z + 3} minecraft:stone`);
    await cmd(`execute ${who} ~ ~ ~ setblock ${x} 150 ${z} minecraft:bed 0`); await cmd(`execute ${who} ~ ~ ~ setblock ${x} 150 ${z + 1} minecraft:bed 8`);
    await cmd(`tp ${who} ${x + 0.5} 150 ${z - 0.5}`); await sleep(1500);
    (who === 'Alice' ? alice : bob).useBlock(x, 150, z);
  };
  await bed('Alice', Math.round(sx), Math.round(sz));
  await sleep(9000);
  assert.ok(alice.stats.time > 18000 && alice.stats.time < 20000, `Alice alone in bed: still night (${alice.stats.time})`);
  await bed('Bob', Math.round(sx + 600), Math.round(sz + 600));
  assert.ok(await waitFor(() => Math.abs(alice.stats.time - 24000) < 400 && Math.abs(bob.stats.time - 24000) < 400, 20000), `both in bed: the next morning for both (${alice.stats.time}, ${bob.stats.time})`);
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'), /every player sleeps \(2\)/);
  // a new map in each instance: the ids come from one count (the main instance's), so no two maps share one, and each
  // map's file is written by the instance that has it
  await cmd('clear Alice'); await cmd('clear Bob');
  await cmd('give Bob minecraft:map 1'); await sleep(1000); bob.useItem();
  assert.ok(await waitFor(async () => (await count('Bob', 'filled_map')) === 1, 15000), 'Bob made a map');
  await cmd('give Alice minecraft:map 1'); await sleep(1000); alice.useItem();
  assert.ok(await waitFor(async () => (await count('Alice', 'filled_map')) === 1, 15000), 'Alice made a map');
  const idOf = async (who) => { for (let d = 0; d < 8; d++) if (await count(who, 'filled_map', d)) return d; return null; };
  const ma = await idOf('Alice'), mb = await idOf('Bob');
  assert.ok(ma !== null && mb !== null && ma !== mb, `two maps, two ids: Alice ${ma}, Bob ${mb}`);
  await cmd('save-all');
  assert.ok(await waitFor(() => savedFile(world.folder, `data/map_${ma}.dat`) && savedFile(world.folder, `data/map_${mb}.dat`), 15000), 'both map files saved');
  // the scoreboard: objectives by commands in every instance; a score set in one instance is the same in the others
  await cmd('scoreboard objectives add kills dummy Kills'); await cmd('scoreboard objectives setdisplay sidebar kills');
  const scoreIn = async (via, who) => (await cmd(`${via ? `execute ${via} ~ ~ ~ ` : ''}scoreboard players list ${who}`)).lines.join(' ');
  bob.say('/scoreboard players set Bob kills 3');
  assert.ok(await waitFor(async () => /kills/.test(await scoreIn(null, 'Bob')) && /3/.test(await scoreIn(null, 'Bob')), 10000), `Bob's score, set in his instance, in the main one: ${await scoreIn(null, 'Bob')}`);
  await cmd('scoreboard players add Alice kills 2');
  assert.ok(await waitFor(async () => /2/.test(await scoreIn('Bob', 'Alice')), 10000), `Alice's score, set in the main instance, in Bob's: ${await scoreIn('Bob', 'Alice')}`);
  bob.say('/scoreboard players reset Bob kills');
  assert.ok(await waitFor(async () => !/kills/.test(await scoreIn(null, 'Bob')), 10000), `Bob's score reset in his instance, gone in the main one: ${await scoreIn(null, 'Bob')}`);
  // /tp to a player of another instance: the two instances become one
  bob.say('/tp Bob Alice');
  assert.ok(await waitFor(async () => (await where()).Bob === 0, 60000, 500), 'Bob is with Alice in the main instance: ' + JSON.stringify(await where()));
  assert.equal(bob.stats.kicked, null, 'Bob stayed connected');
});
