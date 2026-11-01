'use strict';
// Compares two runs of the equivalence harness (run.js): node test/harness/compare.js <runA> <runB>
// Tick by tick: the hash of the game's state (every entity in order, every random-number generator, ...) and each
// player's packets (count and hash of their bytes); then every file of the saved world. Where both runs dumped the
// whole state of a tick (--dump-every), the first entity or value that differs is shown. Runs with --phases: every
// phase is compared (phase1/ ...). Exit code 0: identical.
const fs = require('node:fs');
const path = require('node:path');

const [a, b] = process.argv.slice(2).map((p) => path.resolve(p));
if (!a || !b) { console.error('usage: node test/harness/compare.js <runA> <runB>'); process.exit(2); }
const lines = (dir) => fs.readFileSync(path.join(dir, 'ticks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (dir, f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };

function compareDir(a, b) {
  const A = lines(a), B = lines(b), report = { ticks: [A.length, B.length], firstStateDiff: null, firstPacketDiff: {}, world: null, detail: null };
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i], y = B[i];
    if (report.firstStateDiff === null && x.state !== y.state) report.firstStateDiff = x.tick;
    for (const name of new Set([...Object.keys(x.players), ...Object.keys(y.players)])) {
      if (report.firstPacketDiff[name] !== undefined) continue;
      const p = x.players[name] || [0, ''], q = y.players[name] || [0, ''];
      if (p[0] !== q[0] || p[1] !== q[1]) report.firstPacketDiff[name] = { tick: x.tick, a: p, b: q };
    }
  }
  if (A.length !== B.length) report.lengthDiff = true;
  // the first difference in a dumped state at or after the first differing tick
  if (report.firstStateDiff !== null) {
    const dumped = fs.existsSync(path.join(a, 'states')) ? fs.readdirSync(path.join(a, 'states')).map((f) => +f.split('.')[0]).filter((t) => t >= report.firstStateDiff).sort((p, q) => p - q) : [];
    for (const t of dumped) {
      const sa = json(a, `states/${t}.json`), sb = json(b, `states/${t}.json`);
      if (!sa || !sb) continue;
      const diff = (p, q, where) => {
        if (JSON.stringify(p) === JSON.stringify(q)) return null;
        if (Array.isArray(p) && Array.isArray(q)) { for (let i = 0; i < Math.max(p.length, q.length); i++) { const r = diff(p[i], q[i], `${where}[${i}]`); if (r) return r; } return { where, a: p, b: q }; }
        if (p && q && typeof p === 'object' && typeof q === 'object') { for (const k of new Set([...Object.keys(p), ...Object.keys(q)])) { const r = diff(p[k], q[k], `${where}.${k}`); if (r) return r; } }
        return { where, a: p, b: q };
      };
      report.detail = { tick: t, ...diff(sa, sb, 'state') };
      break;
    }
  }
  const wa = json(a, 'world.json'), wb = json(b, 'world.json');
  if (wa && wb) {
    const keys = new Set([...Object.keys(wa), ...Object.keys(wb)]), onlyA = [], onlyB = [], differ = [];
    for (const k of keys) { if (!(k in wb)) onlyA.push(k); else if (!(k in wa)) onlyB.push(k); else if (wa[k] !== wb[k]) differ.push(k); }
    report.world = { files: [Object.keys(wa).length, Object.keys(wb).length], onlyA: onlyA.slice(0, 20), onlyB: onlyB.slice(0, 20), differ: differ.slice(0, 40), differCount: differ.length };
  } else report.world = { missing: !wa ? 'A' : 'B' };
  report.identical = report.firstStateDiff === null && !Object.keys(report.firstPacketDiff).length && !report.lengthDiff && !!report.world && !report.world.missing &&
    !report.world.onlyA.length && !report.world.onlyB.length && !report.world.differCount;
  return report;
}

const report = compareDir(a, b);
let same = report.identical;
for (let ph = 1; fs.existsSync(path.join(a, 'phase' + ph)) || fs.existsSync(path.join(b, 'phase' + ph)); ph++) {
  const pa = path.join(a, 'phase' + ph), pb = path.join(b, 'phase' + ph);
  const r = fs.existsSync(pa) && fs.existsSync(pb) ? compareDir(pa, pb) : { identical: false, missing: fs.existsSync(pa) ? 'B' : 'A' };
  report['phase' + ph] = r; same = same && r.identical;
}
report.identical = same;
console.log(JSON.stringify(report, null, 1));
process.exit(same ? 0 : 1);
