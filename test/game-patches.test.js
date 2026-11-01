'use strict';
// The in-memory corrections to the vendored game code (src/game-patches.js).
//   node --test test/game-patches.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const paths = require('../src/paths');
const { applyGamePatches, PATCHES } = require('../src/game-patches');

test('game patches: each correction applies exactly once to the vendored u53 classes.js', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const { src, problems } = applyGamePatches(orig, { decoration: true });   // (with the corrections applied only on request)
  assert.deepEqual(problems, []);
  const edits = PATCHES.flatMap((p) => (p.edits || [p]).map((e) => ({ name: p.name, find: e.find, replace: e.replace })));
  for (const e of edits) {
    assert.equal(src.split(e.replace).length - 1, 1, `${e.name}: corrected text present once`);
    if (!e.replace.includes(e.find)) assert.equal(src.includes(e.find), false, `${e.name}: original text replaced`);
  }
  assert.equal(src.length - orig.length, edits.reduce((n, e) => n + e.replace.length - e.find.length, 0), 'nothing else changed in size');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'classes.js' }), 'the corrected game code still parses');
  assert.equal(fs.readFileSync(paths.classesJs, 'utf8'), orig, 'the file on disk is not modified');
});

test('game patches: other game code is left unchanged and each skipped correction is reported', () => {
  const other = 'function DDV(a,b,c,d){return 1;}';
  const r = applyGamePatches(other, { decoration: true });
  assert.equal(r.src, other);
  assert.equal(r.problems.length, PATCHES.length);
  assert.match(r.problems[0], /LAN game mode on join not applied: classes.js is not the expected u53 build \(joiners get the LAN game mode only after respawning\)/);
  // Text that matches more than once is ambiguous and not patched either.
  const twice = PATCHES[0].find + ';' + PATCHES[0].find;
  const r2 = applyGamePatches(twice);
  assert.equal(r2.src, twice);
  assert.equal(r2.problems.filter((x) => x.startsWith(PATCHES[0].name + ' not applied')).length, 1);
});

test('game patches: a correction applied only on request (decoration ahead) is left out without it', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const off = applyGamePatches(orig), on = applyGamePatches(orig, { decoration: true });
  assert.deepEqual(off.problems, []); assert.deepEqual(on.problems, []);
  assert.ok(!off.src.includes('$eaglanDwTake') && on.src.includes('$eaglanDwTake'));
  assert.equal(off.src.length, applyGamePatches(orig, { decoration: false }).src.length);
});

test('game patches: the game rules hook is skipped when the code it relies on differs', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const hook = PATCHES.find((p) => p.name === 'game rules from the host');
  for (const anchor of hook.requires) {
    const changed = orig.split(anchor).join(anchor.replace(/.$/, (c) => (c === ';' ? ',' : ';')));
    const { src, problems } = applyGamePatches(changed);
    assert.deepEqual(problems.filter((x) => x.startsWith('game rules from the host')).length, 1, 'skipped without ' + anchor);
    assert.ok(!src.includes('__eaglanHost'), 'no hook without ' + anchor);
  }
});
