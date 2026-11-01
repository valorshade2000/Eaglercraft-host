'use strict';
// Decoration ahead (stage 8, path 4; config decorationAhead, decorationAheadPregen): with the equivalence harness
// (test/harness), the same game as without it, and its records used. Players exploring fresh terrain with
// decorationAhead, a pre-generation job with decorationAheadPregen, each against the original; then both in verify
// mode (the game decorates every chunk itself and compares the thread's record of it: no difference).
//   node --test test/deco-ahead.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-deco-'));
const run = (name, scenario, args, extra = [], env = {}) => {
  const dir = path.join(out, name);
  execFileSync(process.execPath, [path.join(__dirname, 'harness', 'run.js'), scenario, dir, '--args', JSON.stringify(args), '--dump-every', '0', ...extra], { stdio: 'pipe', timeout: 900000, env: { ...process.env, ...env } });
  return dir;
};
const compare = (a, b) => {
  try { return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'harness', 'compare.js'), a, b], { encoding: 'utf8' })); }
  catch (e) { return JSON.parse(e.stdout); }   // (exit code 1: not identical)
};
const deco = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).speedups.decoAhead;
const short = (c) => JSON.stringify({ firstStateDiff: c.firstStateDiff, firstPacketDiff: c.firstPacketDiff, world: c.world && { files: c.world.files, differ: c.world.differCount } });

test('decoration ahead: players in fresh terrain and a pre-generation job give the same game; verify mode finds no difference', { timeout: 3600000 }, () => {
  const ex = { ticks: 300 }, pg = { radius: 64 };   // (short: other tests run beside it)
  const a = run('explore', 'explore', ex), b = run('explore-deco', 'explore', ex, ['--config', JSON.stringify({ decorationAhead: true })]);
  const ab = compare(a, b);
  assert.equal(ab.identical, true, 'players: the same ticks, packets and world: ' + short(ab));
  assert.ok(deco(b).used > 0, 'players: decorations replayed from the thread: ' + JSON.stringify(deco(b)));
  const c = run('pregen', 'pregen', pg), d = run('pregen-deco', 'pregen', pg, ['--config', JSON.stringify({ decorationAheadPregen: true })]);
  const cd = compare(c, d);
  assert.equal(cd.identical, true, 'pre-generation: the same ticks and world: ' + short(cd));
  assert.ok(deco(d).used > 0, 'pre-generation: decorations replayed from the thread: ' + JSON.stringify(deco(d)));
  assert.ok(cd.world.files[0] > 60, 'a real job: ' + JSON.stringify(cd.world.files) + ' files');
  // verify mode: every record the game could use is compared with the game's own decoration instead
  const v = deco(run('verify', 'explore', ex, ['--config', JSON.stringify({ decorationAhead: true })], { EAGLAN_DEBUG_SPEEDUPS_VERIFY: '1' }));
  assert.ok(v.checked > 0 && v.diff === 0, 'verify (players): ' + JSON.stringify({ checked: v.checked, diff: v.diff, diffs: v.diffs }));
  const w = deco(run('verify-pregen', 'pregen', pg, ['--config', JSON.stringify({ decorationAheadPregen: true })], { EAGLAN_DEBUG_SPEEDUPS_VERIFY: '1' }));
  assert.ok(w.checked > 0 && w.diff === 0, 'verify (pre-generation): ' + JSON.stringify({ checked: w.checked, diff: w.diff, diffs: w.diffs }));
  if (!process.env.KEEP_DATA) fs.rmSync(out, { recursive: true, force: true });
});
