'use strict';
// Players exploring fresh terrain: `explorers` players fly away from spawn in different directions, `speed` blocks a
// tick (chunk generation, decoration, first lighting, chunks unloaded behind them), and turn back half-way (chunks
// loaded again from the world's files), while Home stays at spawn. Every 40 ticks each explorer digs a 5 x 5 pit from
// y 40 to 75 under itself and puts glowstone at its bottom (sky and block light changes, block updates). It is dusk, so
// monsters spawn naturally. With 1,200 ticks the autosave at tick 900 happens while they move.
// Args: { explorers: 3, ticks: 1200, speed: 0.6, y: 110, home: true }.
module.exports = async function explore(h) {
  const { explorers = 3, ticks = 1200, speed = 0.6, y = 110, home = true } = h.args;
  await h.steps(2);
  if (home) await h.join('Home');
  const es = [];
  for (let i = 0; i < explorers; i++) es.push(await h.join('E' + i));
  h.cmd('time set 13000');
  const sp = es[0].bot.spawn;
  for (const e of es) h.cmd(`tp ${e.name} ${sp[0]} ${y} ${sp[2]}`);   // up to cruise height first (a jump that big is refused)
  await h.steps(2);
  const dirs = es.map((_, i) => [Math.cos(2 * Math.PI * i / explorers + 0.3), Math.sin(2 * Math.PI * i / explorers + 0.3)]);
  const pos = es.map(() => [sp[0], y, sp[2]]);
  let digs = 0;
  // a CPU profile of the game thread (profile: true -> <out>/game.cpuprofile)
  if (h.args.profile) await h.profile(require('node:path').join(h.out, 'game.cpuprofile'), h.args.profileSeconds || 30);
  for (let t = 0; t < ticks; t++) {
    const s = t < ticks / 2 ? speed : -speed;
    es.forEach((e, i) => { pos[i][0] += dirs[i][0] * s; pos[i][2] += dirs[i][1] * s; e.move(pos[i][0], y, pos[i][2], false); });
    if (t % 40 === 20) {
      for (let i = 0; i < es.length; i++) {
        const x = Math.floor(pos[i][0]) - 2, z = Math.floor(pos[i][2]) - 2;
        h.cmd(`fill ${x} 40 ${z} ${x + 4} 75 ${z + 4} minecraft:air`).then((r) => { if (r.result > 0) digs++; });
        h.cmd(`setblock ${x + 2} 40 ${z + 2} minecraft:glowstone`);
      }
    }
    await h.steps(1);
  }
  h.result.digs = digs;
  h.result.chunks = es.map((e) => e.bot.chunks.size);
};
