'use strict';
// What status and the stall lines say about the game thread's 5 s reports (src/game-stats.js).
//   node --test test/game-stats.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, explainStall } = require('../src/game-stats');

const report = (t, ms, o = {}) => ({
  t, ms, storage: { writes: o.writes || 0, ms: o.writeMs || 0, maxMs: o.maxWriteMs || 0, maxQueued: 1 }, gc: { count: 1, ms: o.gcMs || 0, maxMs: o.maxGcMs || 0 },
  busy: o.busy ?? 30, heapMb: 200, heapPhysMb: 250, extMb: 50, heapLimitMb: 2096, ticks: o.ticks || null,
});

test('stall line: the window is the real time the reports cover, also when the game thread was stuck', () => {
  // Reports every 5 s; then the thread is stuck for 20 s, and the report sent after it covers those 20 s.
  // Before, this read "In the 5s around it: ... garbage collection 8081 ms" (as in a real log).
  const rs = [report(5000, 5000), report(10000, 5000), report(30000, 20000, { gcMs: 8081, maxGcMs: 2900, busy: 100 }), report(35000, 5000)];
  const line = explainStall(rs, 18000, 30200);
  assert.match(line, /^game server fell 18\.0s behind\. In the 20s around it: disk writes 0 \(blocked 0 ms, slowest 0 ms\), garbage collection 8081 ms \(longest 2900 ms\), thread busy up to 100%, heap 200 of 2096 MB\. Likely cause: garbage collection/);
  // A stall that spans two reports: both, and their whole time.
  const two = [report(5000, 5000), report(10000, 5000, { writes: 300, writeMs: 700, maxWriteMs: 9, busy: 90 }), report(15000, 5000, { writes: 200, writeMs: 500, busy: 95 }), report(20000, 5000)];
  const l2 = explainStall(two, 3000, 11500);
  assert.match(l2, /In the 10s around it: disk writes 500 \(blocked 1200 ms, slowest 9 ms\)/);
  assert.match(l2, /Likely cause: saving world data/);
  // Regular reports: one 5 s report for a short stall at its end.
  assert.match(explainStall(two, 2000, 10050), /In the 5s around it: disk writes 300/);
  // Nothing reported yet: no line.
  assert.equal(explainStall([], 2000, 10000), null);
});

test('summary: busy is weighted by the time each report covers; tick times are summed', () => {
  const rs = [report(5000, 5000, { busy: 20, ticks: { n: 3, ms: 30, max: 12, list: [8, 10, 12] } }), report(20000, 15000, { busy: 100, ticks: { n: 2, ms: 14500, max: 14000, list: [500, 14000] } })];
  const r = summarize(rs, 0, 20000);
  assert.equal(r.seconds, 20);
  assert.equal(r.busy, 80);   // (20 * 5 + 100 * 15) / 20
  assert.equal(r.maxBusy, 100);
  assert.deepEqual(r.ticks, { n: 5, p50: 12, p95: 14000, p99: 14000, max: 14000, over50: 2 });
  assert.equal(summarize(rs, 20000, 30000), null, 'nothing after the last report');
});
