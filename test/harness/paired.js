'use strict';
// Paired comparison of two harness runs of the same scenario (the same work in every tick): for each tick, B's game time
// minus A's; the median and quartiles of those differences say more than two means when the machine's load varies.
//   node test/harness/paired.js <runA> <runB> [--from T] [--to T]
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : null; };
const [a, b] = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const read = (r) => new Map(fs.readFileSync(path.join(r, 'ticks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.tick, x.game]));
const A = read(a), B = read(b), last = Math.min(Math.max(...A.keys()), Math.max(...B.keys()));
const from = opt('from') ?? Math.floor(last * 0.2), to = opt('to') ?? last;
const d = [], ra = [];
for (let t = from; t <= to; t++) if (typeof A.get(t) === 'number' && typeof B.get(t) === 'number') { d.push(B.get(t) - A.get(t)); ra.push(A.get(t)); }
d.sort((x, y) => x - y); ra.sort((x, y) => x - y);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const medA = q(ra, 0.5), sum = d.reduce((x, y) => x + y, 0);
console.log(`${path.basename(b)} - ${path.basename(a)}: ticks ${from}-${to} (${d.length}): median difference ${q(d, 0.5).toFixed(2)} ms (${(q(d, 0.5) / medA * 100).toFixed(1)} % of A's median ${medA.toFixed(2)}), quartiles ${q(d, 0.25).toFixed(2)} / ${q(d, 0.75).toFixed(2)}, mean ${(sum / d.length).toFixed(2)}`);
