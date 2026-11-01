'use strict';
// Block mechanics on a 40 x 40 stone platform at y 100, three chunks east of spawn (so across chunk borders), watched by
// two players: redstone wire, lamps, a repeater, pistons pushing and pulling (driven by a redstone block the console
// switches every 30 ticks), water and lava flowing into each other, falling sand and gravel, wheat and a sapling growing
// and leaves decaying (random ticks, randomTickSpeed 40), fire spreading over wool, hoppers moving items between chests,
// items merging, a minecart going to and fro on powered rails, a boat and a villager in a pool, TNT exploding next to cows.
// Daytime. With --phases 2 the host restarts on the saved world; phase 2: the watchers join again and it goes on.
// Args: { ticks: 900, ticks2: 300 }.
module.exports = async function blocks(h) {
  const { ticks = 900, ticks2 = 300 } = h.args;
  await h.steps(2);
  const o0 = await h.join('O0'), o1 = await h.join('O1');
  const sp = o0.bot.spawn;
  const bx = Math.floor((sp[0] + 48) / 16) * 16, bz = Math.floor(sp[2] / 16) * 16, Y = 100;
  const X = (dx) => bx + dx, Z = (dz) => bz + dz;
  if (h.phase > 1) {
    await h.steps(ticks2);
    return census(h, X, Z, Y);
  }
  for (const c of ['time set 6000', 'gamerule doDaylightCycle false', 'gamerule randomTickSpeed 40', 'gamerule doMobSpawning false']) h.cmd(c);
  h.cmd(`tp O0 ${X(20)} 125 ${Z(20)}`); h.cmd(`tp O1 ${X(10)} 125 ${Z(30)}`);
  await h.steps(1);
  // the platform's chunks loaded (the watchers' view reaches them)
  const loaded = async (x, z) => !/outOfWorld/.test(((await h.command(`testforblock ${x} ${Y} ${z} minecraft:bedrock`)).lines || []).join(' '));
  let ok = false;
  for (let i = 0; i < 400 && !ok; i++) ok = (await loaded(X(0), Z(0))) && (await loaded(X(39), Z(39)));
  if (!ok) throw new Error('the platform\'s chunks did not load');
  const fails = [];
  const run = (c) => h.cmd(c).then((r) => { if (!(r.result > 0)) fails.push(c + ' -> ' + (r.lines || []).join(' ')); });
  for (let l = Y + 1; l <= Y + 24; l += 8) h.cmd(`fill ${X(0)} ${l} ${Z(0)} ${X(39)} ${l + 7} ${Z(39)} minecraft:air`);   // (fails where all is air)
  run(`fill ${X(0)} ${Y} ${Z(0)} ${X(39)} ${Y} ${Z(39)} minecraft:stone`);
  await h.steps(1);
  // redstone: a switched redstone block at (2,1,2); wire north-south with lamps beside it and a sticky piston lifting sand
  // at its end; wire east-west with a repeater (delay 4) and a piston pushing three blocks at its end
  run(`fill ${X(2)} ${Y + 1} ${Z(3)} ${X(2)} ${Y + 1} ${Z(16)} minecraft:redstone_wire`);
  for (const dz of [5, 9, 13]) run(`setblock ${X(3)} ${Y + 1} ${Z(dz)} minecraft:redstone_lamp`);
  run(`setblock ${X(2)} ${Y + 1} ${Z(17)} minecraft:sticky_piston 1`);
  run(`setblock ${X(2)} ${Y + 2} ${Z(17)} minecraft:sand`);
  run(`fill ${X(3)} ${Y + 1} ${Z(2)} ${X(12)} ${Y + 1} ${Z(2)} minecraft:redstone_wire`);
  run(`setblock ${X(8)} ${Y + 1} ${Z(2)} minecraft:unpowered_repeater 13`);
  run(`setblock ${X(13)} ${Y + 1} ${Z(2)} minecraft:piston 5`);
  run(`setblock ${X(14)} ${Y + 1} ${Z(2)} minecraft:stone`); run(`setblock ${X(15)} ${Y + 1} ${Z(2)} minecraft:dirt`); run(`setblock ${X(16)} ${Y + 1} ${Z(2)} minecraft:cobblestone`);
  // water and lava in a glass pen
  for (const [a, b, c2, d2] of [[18, 2, 30, 2], [18, 12, 30, 12], [18, 2, 18, 12], [30, 2, 30, 12]]) run(`fill ${X(a)} ${Y + 1} ${Z(b)} ${X(c2)} ${Y + 2} ${Z(d2)} minecraft:glass`);
  run(`setblock ${X(20)} ${Y + 1} ${Z(4)} minecraft:water`);
  run(`setblock ${X(28)} ${Y + 1} ${Z(10)} minecraft:lava`);
  // falling sand and gravel
  run(`fill ${X(4)} ${Y + 6} ${Z(24)} ${X(6)} ${Y + 12} ${Z(26)} minecraft:sand`);
  run(`fill ${X(8)} ${Y + 6} ${Z(24)} ${X(9)} ${Y + 10} ${Z(25)} minecraft:gravel`);
  // wheat on moist farmland with water, a sapling on dirt, leaves round a log (the log is taken away later)
  run(`fill ${X(4)} ${Y} ${Z(30)} ${X(12)} ${Y} ${Z(32)} minecraft:farmland 7`);
  run(`fill ${X(4)} ${Y + 1} ${Z(30)} ${X(12)} ${Y + 1} ${Z(32)} minecraft:wheat 0`);
  run(`setblock ${X(13)} ${Y} ${Z(31)} minecraft:water`);
  run(`setblock ${X(20)} ${Y} ${Z(30)} minecraft:dirt`); run(`setblock ${X(20)} ${Y + 1} ${Z(30)} minecraft:sapling 0`);
  run(`fill ${X(26)} ${Y + 1} ${Z(30)} ${X(26)} ${Y + 4} ${Z(30)} minecraft:log`);
  run(`fill ${X(24)} ${Y + 4} ${Z(28)} ${X(28)} ${Y + 6} ${Z(32)} minecraft:leaves 0 keep`);
  // fire on netherrack among wool
  run(`fill ${X(18)} ${Y + 1} ${Z(18)} ${X(22)} ${Y + 1} ${Z(22)} minecraft:wool`);
  run(`setblock ${X(20)} ${Y} ${Z(20)} minecraft:netherrack`); run(`setblock ${X(20)} ${Y + 1} ${Z(20)} minecraft:fire`);
  // hoppers: chest -> hopper (down) -> hopper (east) -> chest
  run(`setblock ${X(14)} ${Y + 3} ${Z(22)} minecraft:chest 0 replace {Items:[{Slot:0b,id:"minecraft:cobblestone",Count:64b},{Slot:1b,id:"minecraft:dirt",Count:32b}]}`);
  run(`setblock ${X(14)} ${Y + 2} ${Z(22)} minecraft:hopper 0`);
  run(`setblock ${X(14)} ${Y + 1} ${Z(22)} minecraft:hopper 5`);
  run(`setblock ${X(15)} ${Y + 1} ${Z(22)} minecraft:chest`);
  // powered rails over redstone blocks between two stone blocks, and a minecart
  run(`fill ${X(2)} ${Y} ${Z(36)} ${X(37)} ${Y} ${Z(36)} minecraft:redstone_block`);
  run(`fill ${X(2)} ${Y + 1} ${Z(36)} ${X(37)} ${Y + 1} ${Z(36)} minecraft:golden_rail`);
  run(`setblock ${X(1)} ${Y + 1} ${Z(36)} minecraft:stone`); run(`setblock ${X(38)} ${Y + 1} ${Z(36)} minecraft:stone`);
  // a pool with a boat and a villager
  run(`fill ${X(32)} ${Y} ${Z(2)} ${X(37)} ${Y} ${Z(12)} minecraft:water`);
  await h.steps(2);
  run(`summon MinecartRideable ${X(2) + 0.5} ${Y + 1.1} ${Z(36) + 0.5}`);
  run(`summon Boat ${X(34)} ${Y + 0.5} ${Z(6)}`);
  run(`summon Villager ${X(35)} ${Y + 0.5} ${Z(9)} {PersistenceRequired:1}`);
  for (let i = 0; i < 8; i++) run(`summon Item ${X(10) + (i % 3) * 0.3} ${Y + 4} ${Z(12) + (i % 2) * 0.4} {Item:{id:"minecraft:diamond",Count:1}}`);
  for (let i = 0; i < 3; i++) run(`summon Cow ${X(24) + i} ${Y + 1} ${Z(25)} {PersistenceRequired:1}`);
  await h.steps(1);
  let on = false;
  for (let t = 0; t < ticks; t++) {
    if (t % 30 === 0) { on = !on; run(`setblock ${X(2)} ${Y + 1} ${Z(2)} minecraft:${on ? 'redstone_block' : 'air'}`); }
    if (t === 100) run(`fill ${X(26)} ${Y + 1} ${Z(30)} ${X(26)} ${Y + 4} ${Z(30)} minecraft:air`);   // the leaves start decaying
    if (t === 300) { run(`setblock ${X(26)} ${Y + 1} ${Z(24)} minecraft:tnt`); run(`setblock ${X(26)} ${Y + 1} ${Z(23)} minecraft:redstone_block`); }
    await h.steps(1);
  }
  h.result.failedCommands = fails;
  if (fails.length) throw new Error(`${fails.length} setup commands failed: ${fails.slice(0, 3).join(' | ')}`);
  return census(h, X, Z, Y);
};

async function census(h, X, Z, Y) {
  const count = async (sel) => ((await h.command(`testfor ${sel}`)).lines || []).filter((l) => l.startsWith('commands.testfor.success')).length;
  const block = async (x, y, z, b) => ((await h.command(`testforblock ${x} ${y} ${z} ${b}`)).lines || []).some((l) => l.startsWith('commands.testforblock.success'));
  h.result.census = { items: await count('@e[type=Item]'), carts: await count('@e[type=MinecartRideable]'), cows: await count('@e[type=Cow]'),
    tree: await block(X(20), Y + 1, Z(30), 'minecraft:log'), cobble: await block(X(24), Y + 1, Z(7), 'minecraft:cobblestone') };
}
