'use strict';
// Busy share of each logical CPU over a time window, for load tests (test/bench/load.js): Windows with typeperf
// (the "% Processor Time" counter of each CPU, once a second), Linux from /proc/stat.
//   const s = startCpuSampler(); ...; const cpus = await s.stop();   // [{ cpu, busyPct }], all CPUs of the machine
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// typeperf's CSV: a header with one column per counter instance ("\\HOST\Processor(3)\% Processor Time"), then
// one row a second. Numbers may have a decimal comma (the system's locale).
function parseTypeperf(lines) {
  const rows = lines.filter((l) => l.startsWith('"')).map((l) => l.slice(1, -1).split('","'));
  if (rows.length < 2) return [];
  const cols = rows[0].map((h) => { const m = /Processor\((\d+)\)/.exec(h); return m ? +m[1] : null; });
  const sum = new Map(), n = new Map();
  for (const r of rows.slice(1)) r.forEach((v, i) => {
    const cpu = cols[i], x = parseFloat(String(v).replace(',', '.'));
    if (cpu === null || !Number.isFinite(x)) return;
    sum.set(cpu, (sum.get(cpu) || 0) + x); n.set(cpu, (n.get(cpu) || 0) + 1);
  });
  return [...sum.keys()].sort((a, b) => a - b).map((cpu) => ({ cpu, busyPct: Math.round((sum.get(cpu) / n.get(cpu)) * 10) / 10 }));
}

function startCpuSampler() {
  if (process.platform === 'win32') {
    const lines = []; let buf = '';
    const p = spawn('typeperf', ['\\Processor(*)\\% Processor Time', '-si', '1'], { windowsHide: true });
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
    p.on('error', () => {});
    return { stop: () => new Promise((resolve) => { p.on('exit', () => resolve(parseTypeperf(lines))); p.kill(); }) };
  }
  const read = () => {
    try {
      return fs.readFileSync('/proc/stat', 'utf8').split('\n').filter((l) => /^cpu\d+ /.test(l)).map((l) => {
        const [name, ...v] = l.trim().split(/\s+/); const t = v.map(Number);
        return { cpu: +name.slice(3), idle: t[3] + (t[4] || 0), total: t.reduce((a, b) => a + b, 0) };
      });
    } catch { return []; }
  };
  const a = read();
  return {
    stop: async () => read().map((x) => {
      const y = a.find((z) => z.cpu === x.cpu); if (!y) return null;
      return { cpu: x.cpu, busyPct: Math.round((1 - (x.idle - y.idle) / Math.max(1, x.total - y.total)) * 1000) / 10 };
    }).filter(Boolean),
  };
}

module.exports = { startCpuSampler, parseTypeperf };
