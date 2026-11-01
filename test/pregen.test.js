'use strict';
// World pre-generation (src/game-patches.js, hook "world pre-generation"): the order chunks are
// loaded in, when each is lit and handed back to the game's unloading, and the hook applied or skipped.
//   node --test test/pregen.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const paths = require('../src/paths');
const { applyGamePatches, PATCHES, pregenPlan } = require('../src/game-patches');
const { ringPos, id, xz, done, lightDone, waiting, advance } = pregenPlan;

test('order: rings round the centre chunk, nearest first, every chunk of a ring once', () => {
  assert.deepEqual(ringPos(0, 0), [0, 0]);
  for (let r = 1; r <= 8; r++) {
    const seen = new Set();
    for (let k = 0; k < 8 * r; k++) { const [x, z] = ringPos(r, k); assert.equal(Math.max(Math.abs(x), Math.abs(z)), r); seen.add(x + ',' + z); }
    assert.equal(seen.size, 8 * r, `ring ${r}: ${8 * r} different chunks`);
  }
  for (const [x, z] of [[0, 0], [-1900000, 1900000], [123, -45678]]) assert.deepEqual(xz(id(x, z)), [x, z]);
});

test('a chunk is lit once its eight neighbours are loaded, light populated once theirs are lit, and handed back once every chunk within three of it is and no waiting call needs it; about three rings stay loaded', () => {
  // The hook's own planning on a 21x21 area round (5, -7), tick by tick as the step does it: one chunk
  // loaded per tick (none while more than 8 calls wait), then at most 2 first calls (lighting), 8
  // second calls (light populated) and 4 chunks handed back, with the hook's own check of which
  // chunks a waiting call still needs. Two chunks are loaded already when the walk gets there (as
  // by the game, or on the way); they are the job's like the others.
  const R = 10;
  const p = { running: true, done: false, cx: 5, cz: -7, rings: R, ring: 0, k: 0, seen: new Set(), owned: new Set(), queued: new Set(), dropQ: [], lightQ: [], lightSet: new Set(), lightDone: new Set(), settleQ: [], settleSet: new Set(), lightWait: new Set(), settleWait: new Set() };
  const loaded = new Set(), unloaded = new Set(), lit = new Set(), populated = new Set(); let maxLoaded = 0, steps = 0, ticks = 0;
  const ring = (x, z) => Math.max(Math.abs(x - p.cx), Math.abs(z - p.cz));
  const inside = (x, z) => ring(x, z) <= R;
  const isLoaded = (q) => loaded.has(q) && !unloaded.has(q);
  while (p.running || p.lightQ.length || p.settleQ.length || p.dropQ.length) {
    assert.ok(++ticks < 10000, 'the job ends');
    if (p.running && p.lightQ.length + p.settleQ.length <= 8) {
      const [ox, oz] = ringPos(p.ring, p.k), x = p.cx + ox, z = p.cz + oz, c = id(x, z);
      assert.ok(!loaded.has(c), 'each chunk loaded once'); loaded.add(c); steps++;
      p.owned.add(c);   // loaded by the walk, or found loaded already: the job's either way
      done(p, x, z); advance(p);
    }
    for (let n = 0; n < 2 && p.lightQ.length; n++) {
      const q = p.lightQ.shift(), [qx, qz] = xz(q); p.lightWait.delete(q);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        assert.ok(inside(qx + dx, qz + dz) && isLoaded(id(qx + dx, qz + dz)), `(${qx},${qz}) lit without its neighbour (${qx + dx},${qz + dz})`);
      }
      assert.ok(!lit.has(q), 'each chunk lit once'); lit.add(q);
      lightDone(p, qx, qz);
    }
    for (let n = 0; n < 8 && p.settleQ.length; n++) {
      const q = p.settleQ.shift(), [qx, qz] = xz(q); p.settleWait.delete(q);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const m = id(qx + dx, qz + dz);
        assert.ok(lit.has(m) && isLoaded(m), `(${qx},${qz}) checked while its neighbour (${qx + dx},${qz + dz}) was not lit and loaded`);
      }
      assert.ok(!populated.has(q), 'each chunk checked once'); populated.add(q);
    }
    for (let n = 0, looked = 0; n < 4 && p.dropQ.length && looked < 32; looked++) {
      const q = p.dropQ.shift(), [qx, qz] = xz(q);
      if (waiting(p, qx, qz)) { p.dropQ.push(q); continue; }
      p.queued.delete(q); p.owned.delete(q); p.lightSet.delete(q); p.settleSet.delete(q); unloaded.add(q); n++;
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (inside(qx + dx, qz + dz)) assert.ok(loaded.has(id(qx + dx, qz + dz)), `(${qx},${qz}) handed back before (${qx + dx},${qz + dz}) was loaded`);
      }
      if (ring(qx, qz) <= R - 2) assert.ok(populated.has(q), `(${qx},${qz}) handed back before it was light populated`);
    }
    maxLoaded = Math.max(maxLoaded, p.owned.size);
  }
  assert.equal(steps, (2 * R + 1) ** 2, 'the whole area');
  assert.equal(p.done, true);
  assert.equal(unloaded.size, steps, 'everything handed back at the end');
  // Light populated up to two rings inside the edge: the outermost ring is only loaded, the one
  // inside it lit; every other chunk exactly once.
  for (let x = p.cx - R; x <= p.cx + R; x++) for (let z = p.cz - R; z <= p.cz + R; z++) {
    assert.equal(lit.has(id(x, z)), ring(x, z) <= R - 1, `(${x},${z}) lit`);
    assert.equal(populated.has(id(x, z)), ring(x, z) <= R - 2, `(${x},${z}) light populated`);
  }
  // At most the last four rings loaded (the outer ring of 8R chunks, and the three inside it).
  assert.ok(maxLoaded <= 8 * (4 * R - 6), `at most about three to four rings loaded (${maxLoaded}; the outer ring has ${8 * R})`);
});

test('the hook is applied once to the vendored u53 game code, and skipped when any code it relies on differs', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const ok = applyGamePatches(orig);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.src.split('$p=23;case 23:$eaglanPregenStep(a);if(B()){break _;}').length - 1, 1, 'called once from MinecraftServer.tick');
  assert.equal(ok.src.split('case 5:$eaglanPgProtect(a);Gm3(a);').length - 1, 1);
  assert.doesNotThrow(() => new vm.Script(ok.src));
  // MinecraftServer.tick has cases 0-22, so case 23 is new.
  const tick = orig.slice(orig.indexOf('\nfunction Gnh(a){'), orig.indexOf('\nfunction ', orig.indexOf('\nfunction Gnh(a){') + 1));
  assert.deepEqual([...new Set([...tick.matchAll(/case (\d+):/g)].map((m) => +m[1]))].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i));
  const hook = PATCHES.find((x) => x.name === 'world pre-generation');
  for (const anchor of [...hook.requires, ...hook.edits.map((e) => e.find)]) {
    const changed = orig.split(anchor).join(anchor.replace(/.$/, (c) => (c === ';' ? ',' : ';')));
    const { src, problems } = applyGamePatches(changed);
    assert.equal(problems.filter((x) => x.startsWith('world pre-generation not applied')).length, 1, 'skipped without ' + anchor);
    assert.ok(!src.includes('__eaglanPregen'), 'no hook without ' + anchor);
  }
});

test('tick times: the hook is applied once, and skipped when the code it relies on differs', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  assert.equal(applyGamePatches(orig).src.split('$eaglanTickDone(g[h]);return;').length - 1, 1);
  const hook = PATCHES.find((x) => x.name === 'tick times for the host');
  for (const anchor of [...hook.requires, hook.edits[1].find]) {
    const { src, problems } = applyGamePatches(orig.split(anchor).join(anchor.replace(/.$/, (c) => (c === ';' ? ',' : ';'))));
    assert.equal(problems.filter((x) => x.startsWith('tick times for the host not applied')).length, 1, 'skipped without ' + anchor);
    assert.ok(!src.includes('__eaglanTicks'), 'no hook without ' + anchor);
  }
});
