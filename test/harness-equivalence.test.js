'use strict';
// Stage 8: the options that must not change the game (encodeOnce, packedHandover, pathAhead with pathAheadSearches,
// collisionScan) against the original, with the equivalence harness (test/harness): the same crowd scenario twice, in
// lockstep with seeded random numbers, once with them and once without; every tick's state hash (every entity, every
// random generator), every player's packets and every file of the saved world must be the same. The harness itself is
// checked first: two runs of the original are identical, and a different seed is not.
//   node --test test/harness-equivalence.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-heq-'));
const run = (name, ...extra) => {
  const dir = path.join(out, name);
  execFileSync(process.execPath, [path.join(__dirname, 'harness', 'run.js'), 'crowd', dir, '--args', JSON.stringify({ n: 60, watchers: 2, ticks: 240 }), '--dump-every', '60', ...extra], { stdio: 'pipe', timeout: 600000 });
  return dir;
};
const compare = (a, b) => {
  try { return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'harness', 'compare.js'), a, b], { encoding: 'utf8' })); }
  catch (e) { return JSON.parse(e.stdout); }   // (exit code 1: not identical)
};

test('harness: deterministic and sensitive; the stage 8 options give the same game as without them', { timeout: 2400000 }, () => {
  const a = run('original'), b = run('original-again'), c = run('other-seed', '--seed', '2');
  const all = run('all-options', '--config', JSON.stringify({ encodeOnce: true, packedHandover: true, pathAhead: true, pathAheadSearches: true, collisionScan: true }));
  const ab = compare(a, b);
  assert.equal(ab.identical, true, 'two runs of the original are identical: ' + JSON.stringify(ab));
  const ac = compare(a, c);
  assert.equal(ac.identical, false, 'another seed is not');
  const ad = compare(a, all);
  assert.equal(ad.identical, true, 'with every option the same ticks, packets and world: ' + JSON.stringify({ firstStateDiff: ad.firstStateDiff, firstPacketDiff: ad.firstPacketDiff, world: ad.world, detail: ad.detail }));
  const r = JSON.parse(fs.readFileSync(path.join(all, 'result.json'), 'utf8')), sp = r.speedups || {};
  assert.ok(sp.encodeOnce && sp.encodeOnce.hits > 0, 'encode once was used: ' + JSON.stringify(sp.encodeOnce));
  assert.ok(sp.packedHandover && sp.packedHandover.packed > 0, 'the packed hand-over was used');
  assert.ok(sp.pathAhead && sp.pathAhead.used > 0, 'path steps were taken from the thread: ' + JSON.stringify(sp.pathAhead));
  assert.ok(ad.ticks[0] > 200 && ad.world.files[0] > 10, 'a real run: ' + JSON.stringify(ad.ticks) + ' ticks, ' + JSON.stringify(ad.world.files) + ' files');
  if (!process.env.KEEP_DATA) fs.rmSync(out, { recursive: true, force: true });
});
