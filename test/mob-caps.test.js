'use strict';
// Mob caps (game-patches.js "vanilla mob caps", config mobCaps): this game build counts the chunks within the view
// distance for its mob caps, so at the host's view distance 4 a player's animal cap is 2 and animals that died never come
// back; the correction counts vanilla's chunks (within 8 of each player: 10 animals per player). The correction applied
// once and skipped when the code differs; its count the same as vanilla's for any players. With the equivalence harness
// (test/harness, scenario animals) in a superflat grass world: as the build ships, spawning stops at the first animals;
// corrected, animals spawn up to the vanilla cap and come back after the ones near the player were killed. At view
// distance 8, where the build already counts vanilla's chunks, the corrected and uncorrected games are identical.
//   node --test test/mob-caps.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const paths = require('../src/paths');
const { applyGamePatches, PATCHES, mobCapsCode } = require('../src/game-patches');

test('applied once to the vendored game code, skipped when the spawner differs; its chunk count is vanilla\'s', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const r = applyGamePatches(orig);
  assert.deepEqual(r.problems, []);
  assert.equal(r.src.split('k=k+$eaglanMobCaps.player(u,h,i)|0;if(i>8)i=8;').length - 1, 1, 'per player, where the build takes the view distance');
  assert.equal(r.src.split('if(!$eaglanMobCaps.own)k=k+1|0;').length - 1, 3, 'at each place the spawner counts a chunk');
  assert.doesNotThrow(() => new vm.Script(r.src));
  const p = PATCHES.find((x) => x.name === 'vanilla mob caps');
  for (const anchor of [...p.requires, ...p.edits.map((e) => e.find)]) {
    const { src, problems } = applyGamePatches(orig.split(anchor).join(anchor.slice(0, -1) + ' ' + anchor.slice(-1)));
    assert.ok(problems.some((x) => x.startsWith('vanilla mob caps not applied')), 'skipped without ' + anchor);
    assert.ok(!src.includes('$eaglanMobCaps'), 'nothing changed without ' + anchor);
  }

  // Vanilla's count (SpawnerAnimals.findChunksForSpawning, radius 8): for each player in order, each chunk of its 17 x
  // 17 not in the eligible set yet counts; its inner 15 x 15 join the set (the world border taken as containing them).
  const vanilla = (players) => {
    const set = new Set(); let k = 0;
    for (const [cx, cz] of players) for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
      const key = (cx + dx) + ',' + (cz + dz);
      if (set.has(key)) continue;
      k++; if (Math.abs(dx) < 8 && Math.abs(dz) < 8) set.add(key);
    }
    return k;
  };
  const m = new Function(mobCapsCode + 'return $eaglanMobCaps;')();
  const ours = (players, vd) => { m.start(); let k = 0; for (const [cx, cz] of players) k += m.player(cx, cz, vd); return k; };
  assert.equal(ours([[0, 0]], 4), 289, 'one player: 17 x 17');
  assert.equal(m.own, true, 'below view distance 8 the count is replaced');
  assert.equal(ours([[0, 0], [0, 0]], 4), 289 + 64, 'a second player in the same place: the border chunks once more, as vanilla');
  assert.equal(ours([[0, 0]], 8), 0); assert.equal(m.own, false, 'from 8 up the spawner counts itself');
  let r2 = 12345;
  const rnd = (n) => ((r2 = (Math.imul(r2, 1103515245) + 12345) >>> 0) % n);
  for (let i = 0; i < 300; i++) {
    const players = Array.from({ length: 1 + rnd(6) }, () => [rnd(40) - 20 + (rnd(2) ? 1875000 : -1875000) * (i % 7 === 0 ? 1 : 0), rnd(40) - 20]);
    assert.equal(ours(players, 2 + rnd(6)), vanilla(players), JSON.stringify(players));
  }
});

// ---- the equivalence harness
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-mobcaps-'));
const FLAT = '2;7,2x3,2;1;';   // superflat: bedrock, 2 dirt, grass; plains; no structures (no animals made with the chunks)
const run = (name, args, config, world = ['--world-type', '1', '--generator', FLAT]) => new Promise((resolve, reject) => {
  const dir = path.join(out, name);
  execFile(process.execPath, [path.join(__dirname, 'harness', 'run.js'), 'animals', dir, ...world, '--args', JSON.stringify(args), '--config', JSON.stringify(config), '--dump-every', '0'],
    { timeout: 1200000, maxBuffer: 1 << 24 }, (e, stdout) => {
      let r = null; try { r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch {}
      if (!r || !r.ok) return reject(new Error(`${name}: ${(r && r.error) || (e && e.message) || stdout}`));
      resolve({ dir, ...r.result });
    });
});
const totals = (c) => c.map((x) => x.total);

test('superflat, view distance 4: as shipped spawning stops at the first animals; corrected, up to the vanilla cap, and back after they died', { timeout: 2400000 }, async () => {
  // (two animal ticks first: 10 animals with the correction, so that fewer than 10 are left after the kill)
  const args = { ticks: 800, kill: -1, thenKill: 40, thenTicks: 2400 };
  const [old, fixed] = await Promise.all([run('flat-shipped', args, { mobCaps: 'viewDistance' }), run('flat-vanilla', args, {})]);
  const o1 = totals(old.census), f1 = totals(fixed.census), o2 = totals(old.census2), f2 = totals(fixed.census2);
  const info = JSON.stringify({ shipped: [o1, o2], vanilla: [f1, f2] });
  // as shipped (cap 2): what the first spawn made stays all there is
  const first = o1.findIndex((n) => n > 2);
  assert.ok(first > 0, 'animals spawn once: ' + info);
  assert.ok(o1.slice(first).every((n) => n === o1[first]), 'nothing after the first animals: ' + info);
  assert.ok(o1[o1.length - 1] <= 8, info);
  // corrected (cap 10): more spawns while 10 or fewer, past 10 in the end
  assert.ok(f1[f1.length - 1] >= 10, 'up to the vanilla cap: ' + info);
  assert.ok(f1.filter((n, i) => i > 0 && n > f1[i - 1]).length >= 2, 'spawned on more than one animal tick: ' + info);
  // after the animals near the player were killed: corrected, they come back (to the cap again)
  assert.ok(f2[0] < f1[f1.length - 1], 'some were killed: ' + info);
  assert.ok(f2[f2.length - 1] > f2[0] && f2[f2.length - 1] >= 10, 'back after they died: ' + info);
  assert.ok(f2[f2.length - 1] > o2[o2.length - 1], info);
});

test('view distance 8 (the build already counts vanilla\'s chunks): corrected and uncorrected games identical', { timeout: 2400000 }, async () => {
  const args = { ticks: 1200, kill: 40 }, world = ['--world-seed', '12345'];
  const [a, b] = await Promise.all([run('vd8-shipped', args, { viewDistance: 8, mobCaps: 'viewDistance' }, world), run('vd8-vanilla', args, { viewDistance: 8 }, world)]);
  let cmp;
  try { cmp = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'harness', 'compare.js'), a.dir, b.dir], { encoding: 'utf8' })); }
  catch (e) { cmp = JSON.parse(e.stdout); }
  assert.equal(cmp.identical, true, 'the same ticks, packets and world: ' + JSON.stringify({ firstStateDiff: cmp.firstStateDiff, firstPacketDiff: cmp.firstPacketDiff, world: cmp.world && cmp.world.differCount }));
  if (!process.env.KEEP_DATA) fs.rmSync(out, { recursive: true, force: true });
});
