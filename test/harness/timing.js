'use strict';
// Game-thread time per tick of harness runs (ticks.jsonl "game": real ms from the step to the end of the tick):
//   node test/harness/timing.js <run> [<run> ...] [--from T] [--to T]
// mean, median, p95, max and total over the ticks in [from, to] (default: the last 80 % of the ticks: setup left out).
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : null; };
const runs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
for (const r of runs) {
  const t = fs.readFileSync(path.join(r, 'ticks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const from = opt('from') ?? Math.floor(t.length * 0.2), to = opt('to') ?? t[t.length - 1].tick;
  const ms = t.filter((x) => x.tick >= from && x.tick <= to && typeof x.game === 'number').map((x) => x.game).sort((a, b) => a - b);
  if (!ms.length) { console.log(r, 'no game times'); continue; }
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))], sum = ms.reduce((a, b) => a + b, 0);
  console.log(`${path.basename(r)}: ticks ${from}-${to} (${ms.length}): mean ${(sum / ms.length).toFixed(2)} ms, median ${q(0.5).toFixed(2)}, p95 ${q(0.95).toFixed(2)}, max ${ms[ms.length - 1].toFixed(2)}, total ${(sum / 1000).toFixed(2)} s`);
}
