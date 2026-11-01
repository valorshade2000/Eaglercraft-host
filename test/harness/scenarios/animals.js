'use strict';
// Animal spawning (the mob caps, game-patches.js "vanilla mob caps"): one player (`at`: blocks east of the world spawn)
// at noon in clear weather. The animals within `kill` blocks of the player killed (0: every animal in the world; -1:
// none), `keep` cows summoned next to the player (they count for the game's animal cap, as any animal that may despawn
// does), then `ticks` ticks with the living animals counted every 400 ticks (the game spawns animals only on ticks whose
// world total time is a multiple of 400). Then, with thenKill >= 0, the animals within thenKill blocks killed again and
// thenTicks more ticks, counted the same way: whether animals come back after they died.
// Animals killed in the outer chunks of the loaded area (within 32 blocks of an unloaded chunk) do not finish dying: the
// game does not update entities there. result.census, result.census2: [{ tick, total, by type }] (testfor).
// Args: { ticks: 4000, kill: 0, keep: 0, at: 0, thenKill: -1, thenTicks: 0 }.
module.exports = async function animals(h) {
  const { ticks = 4000, kill = 0, keep = 0, at = 0, thenKill = -1, thenTicks = 0 } = h.args;
  await h.steps(2);
  const p = await h.join('Watcher');
  const sp = p.bot.spawn, x = Math.floor(sp[0]) + at, z = Math.floor(sp[2]);
  for (const c of ['gamerule doDaylightCycle false', 'time set 6000', 'weather clear 1000000']) h.cmd(c);
  if (at) h.cmd(`tp Watcher ${x} 200 ${z}`);
  h.cmd('effect Watcher 11 1000000 4 true');
  await h.steps(200);   // its view loaded
  const TYPES = ['Cow', 'Pig', 'Sheep', 'Chicken', 'Rabbit', 'EntityHorse', 'Wolf', 'Ozelot', 'MushroomCow'];
  const count = async (sel) => ((await h.command(`testfor ${sel}`)).lines || []).filter((l) => l.startsWith('commands.testfor.success')).length;
  const census = async () => {
    const o = { tick: h.tick, total: 0 };
    for (const t of TYPES) { const n = await count(`@e[type=${t}]`); if (n) o[t] = n; o.total += n; }
    return o;
  };
  const killAround = async (r) => {
    if (r < 0) return;
    for (const t of TYPES) h.cmd(r ? `execute Watcher ~ ~ ~ kill @e[type=${t},r=${r}]` : `kill @e[type=${t}]`);
    await h.steps(40);   // (dying takes 20 ticks)
  };
  const watch = async (n) => {
    const out = [await census()];
    for (let t = 0; t < n; t += 400) { await h.steps(400 - TYPES.length); out.push(await census()); }
    return out;
  };
  h.result.before = await census();
  await killAround(kill);
  for (let i = 0; i < keep; i++) h.cmd(`summon Cow ${x + (i % 4) * 2} 200 ${z + Math.floor(i / 4) * 2} {NoAI:1}`);
  await h.steps(2);
  h.result.census = await watch(ticks);
  if (thenKill >= 0) {
    await killAround(thenKill);
    h.result.census2 = await watch(thenTicks);
  }
};
