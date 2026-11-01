'use strict';
// A crowded area (the stage 6 arena): n entities in a 48 x 48 arena (3 x 3 chunks, so with chunk borders inside it), with
// a stone floor and glass walls, at night: zombies chasing villagers that take no damage, skeletons, creepers, spiders,
// dropped items, animals, and boats and minecarts among them. `watchers` players stand above it; Fighter (survival, with
// resistance) stands in a corner, hits the nearest zombie it was shown every 10 ticks and has an apple dropped at its feet
// every 20 ticks (combat, item pickup). Then `ticks` ticks. Args: { n: 250, watchers: 3, ticks: 600, seed: 7 }.
module.exports = async function crowd(h) {
  const { n = 250, watchers = 3, ticks = 600, seed = 7, boats = 6, carts = 4 } = h.args;
  await h.steps(2);
  const ws = [];
  for (let i = 0; i < watchers; i++) ws.push(await h.join('W' + i));
  const fighter = await h.join('Fighter');
  const sp = ws.length ? ws[0].bot.spawn : fighter.bot.spawn;
  const x0 = Math.floor((sp[0] + 400) / 16) * 16, z0 = Math.floor(sp[2] / 16) * 16, Y = 120, S = 48;
  for (const c of ['gamerule doMobSpawning false', 'time set 18000', 'gamerule doDaylightCycle false']) h.cmd(c);
  ws.forEach((w, i) => h.cmd(`tp ${w.name} ${x0 + 20 + i} 170 ${z0 + 24}`));
  h.cmd(`tp Fighter ${x0 + 4} ${Y + 1} ${z0 + 4}`); h.cmd('gamemode 0 Fighter'); h.cmd('effect Fighter 11 100000 4 true');
  await h.steps(1);
  // the arena's chunks loaded (the players' view reaches them)
  const loaded = async (x, z) => !/outOfWorld/.test(((await h.command(`testforblock ${x} ${Y} ${z} minecraft:bedrock`)).lines || []).join(' '));
  let ok = false;
  for (let i = 0; i < 400 && !ok; i++) ok = (await loaded(x0, z0)) && (await loaded(x0 + S - 1, z0 + S - 1));
  if (!ok) throw new Error('the arena\'s chunks did not load');
  for (let l = Y + 1; l <= Y + 24; l += 8) h.cmd(`fill ${x0} ${l} ${z0} ${x0 + S - 1} ${l + 7} ${z0 + S - 1} minecraft:air`);
  h.cmd(`fill ${x0} ${Y} ${z0} ${x0 + S - 1} ${Y} ${z0 + S - 1} minecraft:stone`);
  for (const [a, b, c2, d2] of [[0, 0, S - 1, 0], [0, S - 1, S - 1, S - 1], [0, 0, 0, S - 1], [S - 1, 0, S - 1, S - 1]]) h.cmd(`fill ${x0 + a} ${Y + 1} ${z0 + b} ${x0 + c2} ${Y + 4} ${z0 + d2} minecraft:glass`);
  await h.steps(1);
  // n entities at places from a fixed sequence (the stage 6 mix)
  let r = seed >>> 0; const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
  const at = () => `${(x0 + 2 + rnd() * (S - 4)).toFixed(2)} ${Y + 1} ${(z0 + 2 + rnd() * (S - 4)).toFixed(2)}`;
  const mix = [['Zombie', 25, '{PersistenceRequired:1}'], ['Villager', 15, '{Invulnerable:1,PersistenceRequired:1}'], ['Skeleton', 5, '{PersistenceRequired:1}'], ['Creeper', 5, '{PersistenceRequired:1}'],
    ['Spider', 5, '{PersistenceRequired:1}'], ['Item', 5, '{Item:{id:"minecraft:stone",Count:1},Age:-32768}'], ['Cow', 10, '{PersistenceRequired:1}'], ['Sheep', 10, '{PersistenceRequired:1}'], ['Pig', 10, '{PersistenceRequired:1}'], ['Chicken', 10, '{PersistenceRequired:1}']];
  let made = 0;
  for (const [type, pct, nbt] of mix) for (let i = 0; i < Math.round(n * pct / 100); i++) { h.cmd(`summon ${type} ${at()} ${nbt}`); made++; }
  for (let i = 0; i < boats; i++) h.cmd(`summon Boat ${at()}`);
  for (let i = 0; i < carts; i++) h.cmd(`summon MinecartRideable ${at()}`);
  await h.steps(1);
  h.result.summoned = made + boats + carts;
  // a CPU profile of the game thread (profile: true -> <out>/game.cpuprofile)
  if (h.args.profile) await h.profile(typeof h.args.profile === 'string' ? h.args.profile : require('node:path').join(h.out, 'game.cpuprofile'), h.args.profileSeconds || 15);
  for (let t = 0; t < ticks; t++) {
    if (t % 10 === 0) {   // the nearest zombie Fighter was shown
      let best = null, bd = Infinity; const [fx, fy, fz] = fighter.bot.pos || [0, 0, 0];
      for (const [id, e] of fighter.bot.entities) if (e.kind === 'mob' && e.type === 54) { const dd = (e.x - fx) ** 2 + (e.y - fy) ** 2 + (e.z - fz) ** 2; if (dd < bd) { bd = dd; best = id; } }
      if (best !== null) fighter.attack(best);
    }
    if (t % 20 === 5) h.cmd('execute Fighter ~ ~ ~ summon Item ~ ~1 ~ {Item:{id:"minecraft:apple",Count:1}}');
    await h.steps(1);
  }
  const count = async (sel) => ((await h.command(`testfor ${sel}`)).lines || []).filter((l) => l.startsWith('commands.testfor.success')).length;
  h.result.census = { zombies: await count('@e[type=Zombie]'), villagers: await count('@e[type=Villager]'), items: await count('@e[type=Item]'), boats: await count('@e[type=Boat]') };
};
