'use strict';
// Network load test (stage 8, E8): the real host on a local mock relay, `--bots` players joined over WebRTC from
// `--bot-procs` processes of their own (so the players' side is not what limits), all watching an arena of `--mobs`
// entities (the stage 6 mix) at night. Measures, for `--seconds`:
//   - how fast the host answers its status request (its own thread: every 250 ms; the latency of each)
//   - the game's tick times (the host's own stats), and the frames each player received per second
//   - CPU time of the host's processes (the host, and its network processes with config networkProcesses)
// and, with --check (EAGLAN_DEBUG_NETHASH), that every player received exactly the frames the host sent it, in order:
// both sides keep a running hash with a checkpoint every 1,000 frames; every checkpoint a player reached must match.
//   node test/bench/net-load.js [--bots 12] [--bot-procs 4] [--mobs 1000] [--seconds 60] [--net-procs 0]
//        [--config JSON] [--check] [--out result.json] [--label text] [--keep]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2), v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } }
}
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the players' processes
if (process.env.NETLOAD_BOTS) {
  const { Bot } = require('./bot');
  const { names, relayUrl, code, hashDir } = JSON.parse(process.env.NETLOAD_BOTS);
  const bots = [];
  const nhAdd = (st, u) => { let h = Math.imul(st.h ^ u.length, 16777619); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619); st.h = h >>> 0; st.n++; if (st.n % 1000 === 0) st.cps.push([st.n, st.h]); };
  (async () => {
    for (const name of names) {
      const b = new Bot({ name, relayUrl, code, path: { kind: 'still' } });
      if (hashDir) { b._nh = { n: 0, h: 0x811c9dc5, cps: [] }; const f = b._onFrame.bind(b); b._onFrame = (buf) => { nhAdd(b._nh, buf); f(buf); }; }
      try { await b.join(); bots.push(b); } catch (e) { process.send({ log: `${name} could not join: ${e.message}` }); }
    }
    process.send({ joined: bots.map((b) => b.name) });
  })();
  process.on('message', (m) => {
    if (m.op === 'counts') process.send({ counts: bots.map((b) => [b.name, b.stats.frames, b.stats.bytes, b.state]) });
    if (m.op === 'leave') {
      for (const b of bots) { if (hashDir && b._nh) fs.writeFileSync(path.join(hashDir, b.name + '.bot.json'), JSON.stringify(b._nh)); b.close(); }
      process.send({ left: true });
      setTimeout(() => process.exit(0), 500);
    }
  });
  return;
}

// ------------------------------------------------------------------ the test
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-netload-'));
process.env.EAGLAN_DATA = dataDir;
const hashDir = args.check ? fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-nethash-')) : null;
if (hashDir) process.env.EAGLAN_DEBUG_NETHASH = hashDir;
const c = require('../../src/control');
const { MockRelay } = require('../mock-relay');
const N = num('bots', 12), K = Math.max(1, Math.min(N, num('bot-procs', 4))), MOBS = num('mobs', 1000), SECONDS = num('seconds', 60);

// CPU time (s) of a process and of its children (Windows: PowerShell; elsewhere ps)
function cpuOf(pids) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }`], { encoding: 'utf8' });
      return Object.fromEntries(out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [p, s] = l.trim().split(/\s+/); return [p, Number(s)]; }));
    }
    const out = execFileSync('ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { encoding: 'utf8' });
    return Object.fromEntries(out.trim().split('\n').map((l) => { const [p, t] = l.trim().split(/\s+/); const [h, m, s] = t.split(':').map(Number); return [p, h * 3600 + m * 60 + s]; }));
  } catch { return {}; }
}

(async () => {
  const relay = await new MockRelay().start();
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ viewDistance: 4, lanGamemode: 1, networkProcesses: num('net-procs', 0), ...JSON.parse(args.config || '{}') });
  const finish = async (code, result) => {
    try { await c.stop(); } catch {}
    try { relay.stop && relay.stop(); } catch {}
    if (result) { console.log(JSON.stringify(result, null, 1)); if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 1)); }
    if (!args.keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} if (hashDir) try { fs.rmSync(hashDir, { recursive: true, force: true }); } catch {} }
    else console.log('data: ' + dataDir + (hashDir ? ' hashes: ' + hashDir : ''));
    process.exit(code);
  };
  await c.create({ name: 'NetLoad', seed: '12345' });
  let st = null;
  for (let i = 0; i < 300 && !(st && st.status === 'hosting' && st.code); i++) { await sleep(500); st = await c.status().catch(() => null); }
  if (!st || !st.code) { console.log('the host did not start hosting'); return finish(1); }
  const cmd = async (t) => { const r = await c.consoleCommand(t, { allowOp: true }); return (r.lines || []).join(' '); };
  // the players, in K processes
  const kids = [], names = Array.from({ length: N }, (_, i) => `Net${i + 1}`);
  for (let k = 0; k < K; k++) {
    const mine = names.filter((_, i) => i % K === k);
    const ch = fork(__filename, [], { env: { ...process.env, NETLOAD_BOTS: JSON.stringify({ names: mine, relayUrl: relay.url, code: st.code, hashDir }) } });
    ch.on('message', (m) => { if (m.log) console.log(m.log); });
    kids.push(ch);
  }
  const joined = await Promise.all(kids.map((ch) => new Promise((r) => ch.on('message', (m) => { if (m.joined) r(m.joined); }))));
  console.log(`players in: ${joined.flat().length} of ${N}`);
  // the arena: 600 blocks east of spawn, built while only the first player watches it (12 players watching 1,000
  // entities being summoned one by one is more than the original host's thread can send); then everyone comes
  const sx = 0, sz = 0;
  await cmd('gamerule doMobSpawning false'); await cmd('time set 18000'); await cmd('gamerule doDaylightCycle false');
  const x0 = Math.floor((sx + 600) / 16) * 16, z0 = 0, Y = 120, S = 48;
  const all = joined.flat();
  await cmd(`tp ${all[0]} ${x0 + 24} 170 ${z0 + 24}`);
  for (let i = 0; i < 60; i++) { await sleep(1000); if (!/outside of the world/i.test(await cmd(`testforblock ${x0} ${Y} ${z0} minecraft:bedrock`)) && !/outside of the world/i.test(await cmd(`testforblock ${x0 + S - 1} ${Y} ${z0 + S - 1} minecraft:bedrock`))) break; }
  for (let l = Y + 1; l <= Y + 24; l += 8) await cmd(`fill ${x0} ${l} ${z0} ${x0 + S - 1} ${l + 7} ${z0 + S - 1} minecraft:air`);
  await cmd(`fill ${x0} ${Y} ${z0} ${x0 + S - 1} ${Y} ${z0 + S - 1} minecraft:stone`);
  for (const [a, b, c2, d2] of [[0, 0, S - 1, 0], [0, S - 1, S - 1, S - 1], [0, 0, 0, S - 1], [S - 1, 0, S - 1, S - 1]]) await cmd(`fill ${x0 + a} ${Y + 1} ${z0 + b} ${x0 + c2} ${Y + 4} ${z0 + d2} minecraft:glass`);
  let r = 7; const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
  const mix = [['Zombie', 25], ['Villager', 15, '{Invulnerable:1,PersistenceRequired:1}'], ['Skeleton', 5], ['Creeper', 5], ['Spider', 5], ['Cow', 10, '{PersistenceRequired:1}'], ['Sheep', 10, '{PersistenceRequired:1}'], ['Pig', 10, '{PersistenceRequired:1}'], ['Chicken', 15, '{PersistenceRequired:1}']];
  let made = 0;
  const summons = [];
  for (const [type, pct, nbt = '{PersistenceRequired:1}'] of mix) for (let i = 0; i < Math.round(MOBS * pct / 100); i++) summons.push(`summon ${type} ${(x0 + 2 + rnd() * (S - 4)).toFixed(2)} ${Y + 1} ${(z0 + 2 + rnd() * (S - 4)).toFixed(2)} ${nbt}`);
  for (let i = 0; i < summons.length; i += 50) { const res = await Promise.all(summons.slice(i, i + 50).map((s) => cmd(s))); made += res.filter((t) => /successfully/i.test(t)).length; }   // 50 at a time: they run in one tick
  console.log(`summoned ${made}; the other players come; settling 15 s`);
  for (const n of all.slice(1)) await cmd(`tp ${n} ${x0 + 24} 170 ${z0 + 24}`);
  await sleep(15000);
  // measure
  const st0 = await c.status(), pids = [st0.pid, ...((st0.netProcs && st0.netProcs.list) || []).map((p) => p.pid).filter(Boolean)];
  const counts = () => Promise.all(kids.map((ch) => new Promise((res) => { const f = (m) => { if (m.counts) { ch.off('message', f); res(m.counts); } }; ch.on('message', f); ch.send({ op: 'counts' }); }))).then((l) => l.flat());
  const c0 = await counts(), cpu0 = cpuOf(pids), t0 = Date.now(), lat = [];
  let stopLat = false;
  let statusFailed = 0;
  (async () => { while (!stopLat) { const a = process.hrtime.bigint(); const ok = await c.status().then(() => true, () => false); if (!ok) statusFailed++; lat.push(Number(process.hrtime.bigint() - a) / 1e6); await sleep(250); } })();
  await sleep(SECONDS * 1000);
  stopLat = true;
  const c1 = await counts(), cpu1 = cpuOf(pids), secs = (Date.now() - t0) / 1000, st1 = await c.status();
  const per = c1.map(([n, f, b, s]) => { const p = c0.find((x) => x[0] === n) || [n, 0, 0]; return { name: n, framesPerS: Math.round((f - p[1]) / secs), kbPerS: Math.round((b - p[2]) / secs / 1024), state: s }; });
  lat.sort((a, b) => a - b);
  const q = (p) => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 10) / 10 : null;
  const gs = st1.gameServer || {};
  const result = {
    label: args.label || null, bots: N, botProcs: K, mobs: made, seconds: Math.round(secs), netProcs: num('net-procs', 0), config: JSON.parse(args.config || '{}'),
    statusMs: { n: lat.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), failed: statusFailed },
    framesPerS: per.reduce((a, p) => a + p.framesPerS, 0), perPlayer: per,
    cpuS: Object.fromEntries(pids.map((p, i) => [i === 0 ? 'host' : 'net' + i, cpu0[p] != null && cpu1[p] != null ? Math.round((cpu1[p] - cpu0[p]) * 10) / 10 : null])),
    game: { busy: gs.busy, ticks: gs.ticks || null },
    netProcsStatus: st1.netProcs || null,
  };
  // the players leave; then the checkpoints are compared
  await Promise.all(kids.map((ch) => new Promise((res) => { ch.on('message', (m) => { if (m.left) res(); }); ch.send({ op: 'leave' }); })));
  await sleep(4000);
  if (hashDir) {
    const check = { players: 0, checkpoints: 0, mismatches: [], missing: [] };
    for (const n of names) {
      let hb, hh; try { hb = JSON.parse(fs.readFileSync(path.join(hashDir, n + '.bot.json'))); } catch { check.missing.push(n + ' (player)'); continue; }
      try { hh = JSON.parse(fs.readFileSync(path.join(hashDir, n + '.host.json'))); } catch { check.missing.push(n + ' (host)'); continue; }
      check.players++;
      const hostAt = new Map(hh.cps.map(([k, v]) => [k, v]));
      for (const [k, v] of hb.cps) { check.checkpoints++; if (hostAt.get(k) !== v) { check.mismatches.push({ player: n, at: k }); break; } }
      if (hb.n > hh.n) check.mismatches.push({ player: n, extra: hb.n - hh.n });
    }
    check.exact = check.players === N && !check.mismatches.length && !check.missing.length;
    result.check = check;
  }
  finish(0, result);
})().catch((e) => { console.error(e); process.exit(1); });
