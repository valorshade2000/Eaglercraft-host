#!/usr/bin/env node
'use strict';
// Network checks for the server running eaglan-host. Changes nothing on the system.
//
//   node tools/netcheck.js local [--seconds 30]
//       Read-only health check of this Linux server while players are connected: UDP socket
//       buffer drops, NIC drops, queueing-discipline drops, IPv6, the host's event-loop delay and
//       each player's round-trip time. Prints what (if anything) the server itself adds.
//
//   node tools/netcheck.js paths [--target IP|host] [--from CN,IN,PK,DE] [--per 4] [--family 4|6|both]
//                                [--packets 16] [--probes <id or file>] [--out file.json]
//       Measures latency, jitter and packet loss from real home-internet probes in those countries
//       to this server (public measurement network Globalping, api.globalping.io; free, no account,
//       ~250 probe-tests per hour). The target defaults to this machine's public IPv4 address.
//       Use --probes <file from an earlier run> to measure with the same probes again (before/after).
//
//   node tools/netcheck.js compare before.json after.json
//       Per-probe and per-country difference between two "paths" runs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i > 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const avg = (a) => { const s = a.filter((x) => x != null); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const f1 = (x) => (x == null ? '-' : (Math.round(x * 10) / 10).toString());

// ---------------------------------------------------------------- local
const readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sysctl = (k) => { const v = readFile('/proc/sys/' + k.replace(/\./g, '/')); return v == null ? null : v.trim(); };

function snmp() {
  const out = {};
  const t = readFile('/proc/net/snmp');
  if (t) {
    const lines = t.split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
      const [ka, ...keys] = lines[i].split(/\s+/), [kb, ...vals] = lines[i + 1].split(/\s+/);
      if (ka === 'Udp:' && kb === 'Udp:' && isNaN(+keys[0])) keys.forEach((k, j) => { out['Udp' + k] = +vals[j]; });
    }
  }
  const t6 = readFile('/proc/net/snmp6');
  if (t6) for (const l of t6.split('\n')) { const [k, v] = l.trim().split(/\s+/); if (/^Udp6/.test(k || '')) out[k] = +v; }
  return out;
}

function netdev() {
  const out = {};
  const t = readFile('/proc/net/dev');
  if (!t) return out;
  for (const l of t.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(l); if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1]] = { rxPackets: v[1], rxErrs: v[2], rxDrop: v[3], txPackets: v[9], txErrs: v[10], txDrop: v[11] };
  }
  return out;
}

function defaultIface() {
  const t = readFile('/proc/net/route');
  if (!t) return null;
  for (const l of t.split('\n').slice(1)) { const f = l.trim().split(/\s+/); if (f[1] === '00000000' && f[7] === '00000000') return f[0]; }
  return null;
}

function qdiscStats(dev) {
  try {
    const txt = execFileSync('tc', ['-s', 'qdisc', 'show', 'dev', dev], { encoding: 'utf8', timeout: 5000 });
    let dropped = 0, overlimits = 0, backlog = 0, kinds = [];
    for (const m of txt.matchAll(/^qdisc (\S+)/gm)) kinds.push(m[1]);
    for (const m of txt.matchAll(/dropped (\d+), overlimits (\d+)/g)) { dropped += +m[1]; overlimits += +m[2]; }
    for (const m of txt.matchAll(/backlog (\d+)b/g)) backlog += +m[1];
    return { kinds: [...new Set(kinds)], dropped, overlimits, backlog };
  } catch { return null; }
}

function publicAddrs() {
  const v4 = [], v6 = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.internal) continue;
    if (a.family === 'IPv4' || a.family === 4) {
      if (!/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.address)) v4.push(a.address);
    } else if (!/^(fe80|fc|fd|::1)/i.test(a.address)) v6.push(a.address);
  }
  return { v4, v6 };
}

async function local() {
  const secs = +opt('seconds', 30);
  if (process.platform !== 'linux') console.log('note: the system counters below are only available on Linux; showing what this OS provides.\n');
  const addrs = publicAddrs();
  const dev = defaultIface();
  console.log(`system:   ${os.type()} ${os.release()}, ${os.cpus().length} CPU, load ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}, ${Math.round(os.freemem() / 1048576)} MB free of ${Math.round(os.totalmem() / 1048576)} MB`);
  console.log(`address:  public IPv4 ${addrs.v4.join(', ') || 'none on an interface (NAT/cloud: use --target with paths)'}; public IPv6 ${addrs.v6.join(', ') || 'none'}`);
  console.log(`settings: rmem_default ${sysctl('net.core.rmem_default') ?? '?'}, rmem_max ${sysctl('net.core.rmem_max') ?? '?'}, wmem_default ${sysctl('net.core.wmem_default') ?? '?'}, default_qdisc ${sysctl('net.core.default_qdisc') ?? '?'}, tcp_congestion_control ${sysctl('net.ipv4.tcp_congestion_control') ?? '?'} (TCP only: not used by game traffic)`);

  let host = null;
  try { host = await require('../src/control').status(); } catch {}
  const s1 = snmp(), d1 = netdev(), q1 = dev ? qdiscStats(dev) : null;
  console.log(`\nsampling counters for ${secs}s${host && host.running ? ` while the host runs with ${host.playerCount || 0} player(s)` : ' (the host is not running: start it with players online for a meaningful result)'}...`);
  await sleep(secs * 1000);
  const s2 = snmp(), d2 = netdev(), q2 = dev ? qdiscStats(dev) : null;
  try { host = await require('../src/control').status(); } catch {}

  const findings = [];
  const delta = (k) => (s2[k] ?? 0) - (s1[k] ?? 0);
  if (Object.keys(s2).length) {
    const rows = ['UdpInDatagrams', 'UdpOutDatagrams', 'UdpRcvbufErrors', 'UdpSndbufErrors', 'UdpInErrors', 'Udp6InDatagrams', 'Udp6OutDatagrams', 'Udp6RcvbufErrors', 'Udp6SndbufErrors', 'Udp6InErrors'];
    console.log('\nUDP (all sockets on this server, change during the sample):');
    console.log('  ' + rows.filter((k) => k in s2).map((k) => `${k.replace('Udp', 'udp')} +${delta(k)}`).join(', '));
    const bufDrops = delta('UdpRcvbufErrors') + delta('UdpSndbufErrors') + delta('Udp6RcvbufErrors') + delta('Udp6SndbufErrors');
    if (bufDrops > 0) findings.push({ problem: `${bufDrops} UDP packets were dropped because a socket buffer was full (RcvbufErrors/SndbufErrors). Lost packets cause retransmission delays for players.`,
      fix: 'sudo sysctl -w net.core.rmem_default=1048576 net.core.wmem_default=1048576 net.core.rmem_max=4194304 net.core.wmem_max=4194304',
      revert: `sudo sysctl -w net.core.rmem_default=${sysctl('net.core.rmem_default')} net.core.wmem_default=${sysctl('net.core.wmem_default')} net.core.rmem_max=${sysctl('net.core.rmem_max')} net.core.wmem_max=${sysctl('net.core.wmem_max')}`,
      check: 'run this check again with players online: the counters must stop increasing' });
  }
  if (dev && d1[dev] && d2[dev]) {
    const a = d1[dev], b = d2[dev];
    const rx = b.rxDrop - a.rxDrop, tx = b.txDrop - a.txDrop, er = b.rxErrs - a.rxErrs + b.txErrs - a.txErrs;
    console.log(`\ninterface ${dev}: +${b.rxPackets - a.rxPackets} rx / +${b.txPackets - a.txPackets} tx packets, dropped +${rx} rx / +${tx} tx, errors +${er}`);
    if (rx + tx + er > 0) findings.push({ problem: `the network interface ${dev} dropped or errored ${rx + tx + er} packets during the sample. This is usually the VPS provider's virtual NIC or host being overloaded.`, fix: 'ask the provider, or compare with another VPS/provider (use "paths" before and after)', revert: '-', check: '-' });
  }
  if (q1 && q2) {
    const dq = q2.dropped - q1.dropped;
    console.log(`queueing (${dev}): ${q2.kinds.join(', ')}; dropped +${dq}, backlog ${q2.backlog} bytes`);
    if (dq > 0) findings.push({ problem: `the outgoing queue on ${dev} dropped ${dq} packets: the server's upload is saturated at times, which delays and drops game packets.`,
      fix: `sudo tc qdisc replace dev ${dev} root fq_codel   (keeps queues short under load; or reduce other uploads on this server)`,
      revert: `sudo tc qdisc del dev ${dev} root   (returns to the system default: ${sysctl('net.core.default_qdisc') || 'default'})`, check: 'run this check again: dropped must stay at +0' });
  } else if (process.platform === 'linux') console.log('queueing: "tc" not available (iproute2); skipped');

  if (host && host.running) {
    console.log(`\nhost process: ${host.playerCount || 0} player(s)`);
    if (host.hostLoopDelay) {
      console.log(`  event-loop delay (last full minute): p50 ${host.hostLoopDelay.p50} ms, p99 ${host.hostLoopDelay.p99} ms, max ${host.hostLoopDelay.max} ms`);
      if (host.hostLoopDelay.p99 > 20) findings.push({ problem: `the host process itself is slow (event-loop delay p99 ${host.hostLoopDelay.p99} ms): this is added to every player's latency.`, fix: 'check CPU load and memory (top, free -m); a VPS with more CPU, or fewer other services', revert: '-', check: 'p99 should be below ~10 ms' });
    } else console.log('  event-loop delay: available after the host has run for a minute');
    for (const p of (host.peers || []).filter((x) => x.state === 'CONNECTED')) {
      console.log(`  ${(p.name || p.id).padEnd(18)} ${p.rtt ? `rtt ${p.rtt.last} ms now, median ${p.rtt.median} ms (min ${p.rtt.min}, max ${p.rtt.max})` : 'rtt not measured yet'}  ${p.path || ''} ${p.family || ''}`);
    }
  }
  if (addrs.v6.length) console.log('\nIPv6: this server has a public IPv6 address, so players with IPv6 may connect over IPv6, which can take a different route than IPv4. Compare both with: node tools/netcheck.js paths --family both');

  console.log('\nfindings:');
  if (!Object.keys(s2).length) console.log('  system counters are not available on this OS (Linux only); only the host process was checked.');
  else if (!findings.length) console.log('  none: this server does not drop or delay game packets. The latency players see is the route between them and this server (see "paths").');
  for (const f of findings) console.log(`  - ${f.problem}\n      try:    ${f.fix}\n      revert: ${f.revert}\n      verify: ${f.check}`);
}

// ---------------------------------------------------------------- paths (Globalping)
const API = 'https://api.globalping.io/v1/measurements';

async function gp(body) {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'eaglan-host-netcheck' }, body: JSON.stringify(body) }); }
    catch (e) { if (i < 4) { await sleep(3000 * (i + 1)); continue; } throw e; }
    const js = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error('Globalping rate limit reached (about 250 probe-tests per hour without an account); try again later');
    if (r.status >= 400) throw new Error(`Globalping ${r.status}: ${JSON.stringify(js.error || js)}`);
    for (let k = 0; k < 120; k++) {
      await sleep(2000);
      const g = await fetch(`${API}/${js.id}`).then((x) => x.json()).catch(() => null);
      if (g && g.status && g.status !== 'in-progress') return g;
    }
    throw new Error('measurement did not finish');
  }
}

function rows(m) {
  return m.results.map(({ probe: p, result: t }) => {
    const tim = (t.timings || []).map((x) => x.rtt).filter((x) => x != null);
    let jit = 0; for (let i = 1; i < tim.length; i++) jit += Math.abs(tim[i] - tim[i - 1]);
    const s = t.stats || {};
    return { country: p.country, city: p.city, asn: p.asn, network: p.network, status: t.status, address: t.resolvedAddress,
      min: s.min ?? null, avg: s.avg ?? null, max: s.max ?? null, loss: s.loss ?? null, jitter: tim.length > 1 ? jit / (tim.length - 1) : null };
  });
}

function printRows(title, rs) {
  console.log(`\n${title}`);
  for (const r of rs) console.log(`  ${r.country} ${String(r.city).slice(0, 14).padEnd(14)} AS${String(r.asn).padEnd(7)} ${String(r.network).slice(0, 26).padEnd(26)} ${r.avg != null ? `rtt ${f1(r.avg).padStart(6)} ms (min ${f1(r.min)}, max ${f1(r.max)})  jitter ${f1(r.jitter).padStart(5)} ms  loss ${f1(r.loss)}%` : r.status}`);
  const by = {};
  for (const r of rs) (by[r.country] ||= []).push(r);
  console.log('  per country (median rtt / median jitter / mean loss):');
  for (const [c, a] of Object.entries(by)) console.log(`    ${c}: ${f1(median(a.map((r) => r.avg)))} ms / ${f1(median(a.map((r) => r.jitter)))} ms / ${f1(avg(a.map((r) => r.loss)))}%  (${a.filter((r) => r.avg != null).length} probes)`);
}

async function paths() {
  const addrs = publicAddrs();
  const fam = opt('family', '4');
  let target = opt('target', null);
  if (!target) target = fam === '6' ? addrs.v6[0] : addrs.v4[0];
  if (!target) throw new Error('no public address found on this machine; pass --target <public IP or hostname of this server>');
  const packets = Math.min(16, Math.max(1, +opt('packets', 16)));
  let locations;
  const probes = opt('probes', null);
  if (probes) locations = fs.existsSync(probes) ? JSON.parse(fs.readFileSync(probes, 'utf8')).measurements[0].id : probes;
  else {
    const per = +opt('per', 4), eyeball = opt('eyeball', 'yes') !== 'no';
    locations = opt('from', 'CN,IN,PK,DE').split(',').map((c) => ({ country: c.trim().toUpperCase(), ...(eyeball ? { tags: ['eyeball-network'] } : {}), limit: per }));
  }
  const families = fam === 'both' ? ['4', '6'] : [fam];
  const saved = { target, at: new Date().toISOString(), measurements: [] };
  for (const f of families) {
    const host6 = f === '6' && /^\d+\.\d+\.\d+\.\d+$/.test(target) ? (opt('target6', null) || addrs.v6[0]) : target;
    const tgt = f === '6' ? host6 : target;
    if (!tgt) { console.log('\nIPv6: no public IPv6 address known; pass --target6'); continue; }
    console.log(`measuring IPv${f} ${tgt} (${packets} pings per probe)...`);
    const m = await gp({ type: 'ping', target: tgt, locations: saved.measurements.length ? saved.measurements[0].id : locations, measurementOptions: { packets, ipVersion: +f } });
    const rs = rows(m);
    saved.measurements.push({ id: m.id, family: f, target: tgt, rows: rs });
    printRows(`IPv${f} to ${tgt}:`, rs);
  }
  const out = opt('out', path.join(__dirname, '..', 'data', 'netcheck', `paths-${saved.at.replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(saved, null, 1));
  console.log(`\nsaved ${out}\nrepeat with the same probes later: node tools/netcheck.js paths --probes ${out}${opt('target', null) ? ` --target ${target}` : ''}`);
}

function compare() {
  const [a, b] = argv.slice(1, 3).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  for (const mb of b.measurements) {
    const ma = a.measurements.find((x) => x.family === mb.family) || a.measurements[0];
    console.log(`\nIPv${mb.family}: ${ma.target} (${a.at})  ->  ${mb.target} (${b.at})`);
    const key = (r) => `${r.country}|${r.city}|${r.asn}`;
    const old = new Map(ma.rows.map((r) => [key(r), r]));
    const diffs = [];
    for (const r of mb.rows) {
      const o = old.get(key(r));
      if (!o || o.avg == null || r.avg == null) continue;
      diffs.push({ r, d: r.avg - o.avg, dl: (r.loss ?? 0) - (o.loss ?? 0), dj: (r.jitter ?? 0) - (o.jitter ?? 0) });
      console.log(`  ${r.country} ${String(r.city).slice(0, 14).padEnd(14)} AS${String(r.asn).padEnd(7)} rtt ${f1(o.avg).padStart(6)} -> ${f1(r.avg).padStart(6)} ms (${r.avg - o.avg >= 0 ? '+' : ''}${f1(r.avg - o.avg)})  jitter ${f1(o.jitter)} -> ${f1(r.jitter)}  loss ${f1(o.loss)} -> ${f1(r.loss)}%`);
    }
    if (diffs.length) console.log(`  same probes: ${diffs.length}; median rtt change ${f1(median(diffs.map((x) => x.d)))} ms, mean loss change ${f1(avg(diffs.map((x) => x.dl)))} points, median jitter change ${f1(median(diffs.map((x) => x.dj)))} ms`);
    else console.log('  no probe in common: compare the per-country medians of both runs instead');
  }
}

(async () => {
  if (cmd === 'local') return local();
  if (cmd === 'paths') return paths();
  if (cmd === 'compare') return compare();
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? 2 : 0;
})().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
