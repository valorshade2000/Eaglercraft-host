'use strict';
// Network lab: replays a real EaglercraftX u53 game session (test/netlab/trace-u53.json, recorded
// from the unmodified client with join-test.js TRACE_DC=1) between a real Chrome WebRTC client
// and the host's WebRTC stack (node-datachannel, as in src/lan-host.js), through an emulated
// network link (impair.js), and measures the one-way delay of every game message.
//
//   node test/netlab/bench.js [--scenario cn-typical] [--config default] [--runs 3] [--seed 1]
//                             [--duration 60] [--out results.jsonl]
//   --scenario and --config accept comma-separated lists (every combination is run).
// The client's data channel is created exactly like the u53 client's: createDataChannel("lan"),
// ordered and reliable. Each message carries its sequence number and send time; all clocks are
// on this machine, so one-way delays are measured directly (clock offsets are corrected).
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createImpairedLink } = require('./impair');

// Emulated paths. China <-> Germany values come from Globalping measurements (2026-10-17,
// 14-15 residential/cloud probes in CN to 5 German providers): median RTT ~190-250 ms, ping
// jitter 0-30 ms, loss 0-25 % (median a few %).
const SCENARIOS = {
  lan:          { up: {}, down: {} },
  'eu':         { up: { delay: 15, jitter: 1, loss: 0.001 }, down: { delay: 15, jitter: 1, loss: 0.001 } },
  'cn-typical': { up: { delay: 100, jitter: 4, loss: 0.01, burst: 1.5 }, down: { delay: 100, jitter: 4, loss: 0.01, burst: 1.5 } },
  'cn-lossy':   { up: { delay: 105, jitter: 8, loss: 0.05, burst: 2 }, down: { delay: 105, jitter: 8, loss: 0.05, burst: 2 } },
  'cn-mobile':  { up: { delay: 170, jitter: 15, loss: 0.02, burst: 1.5 }, down: { delay: 170, jitter: 15, loss: 0.02, burst: 1.5 } },
};
// Host-side SCTP settings (node-datachannel exposes these six; libdatachannel defaults in comments).
const CONFIGS = {
  default: {},                                           // delayed SACK 20 ms, initial cwnd 10, RFC 4960 CC, 1 MiB buffers
  'sack0': { delayedSackTime: 0 },
  'sack5': { delayedSackTime: 5 },
  'cwnd32': { initialCongestionWindow: 32 },
  'cc-hstcp': { congestionControlModule: 1 },
  'cc-htcp': { congestionControlModule: 2 },
  'cc-rtcc': { congestionControlModule: 3 },
  'buf4m': { recvBufferSize: 4 << 20, sendBufferSize: 4 << 20 },
  'buf256k': { recvBufferSize: 256 << 10, sendBufferSize: 256 << 10 },   // usrsctp's own default
  'chunks100k': { maxChunksOnQueue: 100000 },                            // default 10000
  'redundant': { _redundant: true },  // the host's real send-twice relay (src/redundant.js), default SCTP
};

// "cn-lossy@dup10s": the host sends every datagram to the player twice, the copy 10 ms later
// ("s": only datagrams up to 400 bytes, i.e. not chunk data). "@dup0" = back-to-back copies.
function scenarioOf(name) {
  const [base, ...mods] = name.split('@');
  const sc = SCENARIOS[base];
  if (!sc) throw new Error('unknown scenario ' + base);
  const out = { up: { ...sc.up }, down: { ...sc.down } };
  for (const m of mods) {
    const d = /^dup(\d+)(s?)$/.exec(m);
    if (!d) throw new Error('unknown scenario modifier ' + m);
    Object.assign(out.down, { dup: true, dupGapMs: +d[1], dupMaxBytes: d[2] ? 400 : Infinity });
  }
  return out;
}

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  try {
    for (const d of fs.readdirSync(base)) for (const exe of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(base, d, exe); if (fs.existsSync(p)) return p;
    }
  } catch {}
  throw new Error('chrome-headless-shell not found (set CHROME_PATH)');
}

const clock = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const stripCands = (sdp) => sdp.split(/\r?\n/).filter((l) => l && !/^a=(candidate|end-of-candidates)/.test(l)).join('\r\n') + '\r\n';

async function offsetOf(probe) { // returns remote clock - local clock (ms), from the lowest-RTT sample
  let best = null;
  for (let i = 0; i < 12; i++) {
    const a = clock(), r = await probe(), b = clock();
    if (!best || b - a < best.rtt) best = { rtt: b - a, off: r - (a + b) / 2 };
  }
  return best;
}

// Messages sent from this trace time on count as steady gameplay (the join's chunk burst is at ~10 s).
const STEADY_FROM_MS = 30000;

function metrics(sent, rx, baseOneWay, bigIdx, fromMs = 0) {
  // sent: [[tRel, size]] in seq order; rx: [[seq, sentRel, recvRel]]
  const got = new Map(); for (const [seq, s, r] of rx) if (!got.has(seq)) got.set(seq, r - s);
  const idx = []; for (let i = 0; i < sent.length; i++) if (sent[i][0] >= fromMs) idx.push(i);
  const d = []; for (const i of idx) if (got.has(i)) d.push(got.get(i));
  let jit = 0; for (let i = 1; i < d.length; i++) jit += Math.abs(d[i] - d[i - 1]);
  const big = bigIdx.filter((i) => got.has(i)).map((i) => got.get(i));
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    n: idx.length, missing: idx.length - d.length,
    mean: r1(mean(d)), p50: r1(q(d, 0.5)), p90: r1(q(d, 0.9)), p99: r1(q(d, 0.99)), p999: r1(q(d, 0.999)), max: r1(d.length ? Math.max(...d) : null),
    jitter: r1(d.length > 1 ? jit / (d.length - 1) : null),
    over100: d.filter((x) => x > baseOneWay + 100).length,     // messages delayed >100 ms beyond the path delay
    over250: d.filter((x) => x > baseOneWay + 250).length,
    bigMax: r1(big.length ? Math.max(...big) : null), bigMean: r1(mean(big)),
  };
}

async function runOnce({ scenario, config, seed, duration, trace, chrome, puppeteer }) {
  const sc = scenarioOf(scenario), sctp = CONFIGS[config];
  if (!sctp) throw new Error('unknown config ' + config);
  const msgs = trace.msgs.filter((m) => m[0] <= duration * 1000);
  const up = msgs.filter((m) => m[1] === 0).map((m) => [m[0], m[2]]);
  const down = msgs.filter((m) => m[1] === 1).map((m) => [m[0], m[2]]);
  const bigDown = down.map((m, i) => (m[1] > 1000 ? i : -1)).filter((i) => i >= 0);

  const { _redundant, ...sctpSettings } = sctp;
  const host = fork(path.join(__dirname, 'bench-host.js'), [], { env: { ...process.env, NETLAB_SCTP: JSON.stringify(sctpSettings), ...(_redundant ? { NETLAB_REDUNDANT: '1' } : {}) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const inbox = []; let waiters = [];
  host.on('message', (m) => { inbox.push(m); waiters = waiters.filter((w) => !w()); });
  const recv = (pred, ms = 20000) => new Promise((resolve, reject) => {
    const check = () => { const i = inbox.findIndex(pred); if (i >= 0) { resolve(inbox.splice(i, 1)[0]); return true; } return false; };
    if (check()) return;
    const t = setTimeout(() => reject(new Error('host child timeout')), ms);
    waiters.push(() => { if (check()) { clearTimeout(t); return true; } return false; });
  });
  const link = await createImpairedLink({ up: sc.up, down: sc.down, seed });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  try {
    await recv((m) => m.ready);
    const page = await browser.newPage();
    await page.goto('about:blank');
    const offer = await page.evaluate(async () => {
      const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
      const dc = window.dc = pc.createDataChannel('lan');          // as the u53 client does
      dc.binaryType = 'arraybuffer';
      window.rx = []; window.t0 = 0;
      window.opened = new Promise((r) => { dc.onopen = r; });
      dc.onmessage = (e) => { const v = new DataView(e.data); window.rx.push([v.getUint32(0), v.getFloat32(4), performance.timeOrigin + performance.now() - window.t0]); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => { const ok = () => pc.iceGatheringState === 'complete' && r(); pc.onicegatheringstatechange = ok; ok(); setTimeout(r, 3000); });
      return pc.localDescription.sdp;
    });
    host.send({ offer: stripCands(offer) });            // the host only learns the client through the link
    const { answer, candidates } = await recv((m) => m.answer);
    // The highest-priority IPv4 host candidate (with the send-twice relay that is the relay's port).
    const hc = candidates.map((c) => c.split(' ')).filter((f) => f[2].toLowerCase() === 'udp' && /^\d+\.\d+\.\d+\.\d+$/.test(f[4]) && !f[4].startsWith('169.254.') && f[7] === 'host')
      .sort((x, y) => Number(y[3]) - Number(x[3]))[0];
    if (!hc) throw new Error('no IPv4 host candidate from the host: ' + candidates.join(' | '));
    link.setTarget(hc[4], +hc[5]);
    // --all-candidates: give Chrome every host candidate as real signaling does (no emulated link).
    const allCands = process.argv.includes('--all-candidates');
    const viaLink = allCands
      ? stripCands(answer) + candidates.map((c) => 'a=' + c.replace(/^a=/, '') + '\r\n').join('') + 'a=end-of-candidates\r\n'
      : stripCands(answer) + `a=candidate:1 1 udp 2122260223 ${hc[4]} ${link.port} typ host\r\na=end-of-candidates\r\n`;
    if (allCands) console.log('candidates given to Chrome:\n  ' + candidates.join('\n  '));
    await page.evaluate((sdp) => window.pc.setRemoteDescription({ type: 'answer', sdp }), viaLink);
    await Promise.race([page.evaluate(() => window.opened), sleep(20000).then(() => { throw new Error('data channel did not open'); })]);
    await recv((m) => m.open);

    const offC = await offsetOf(() => page.evaluate(() => performance.timeOrigin + performance.now()));
    const offH = await offsetOf(async () => { const id = Math.random(); host.send({ ping: id }); return (await recv((m) => m.pong === id)).t; });
    const T0 = clock() + 1500;
    host.send({ start: true, t0: T0 + offH.off, msgs: down });
    await page.evaluate((t0, msgs) => {
      window.t0 = t0;
      const clk = () => performance.timeOrigin + performance.now();
      let i = 0;
      const tick = () => {
        const rel = clk() - t0;
        while (i < msgs.length && msgs[i][0] <= rel) {
          const b = new ArrayBuffer(Math.max(8, msgs[i][1])), v = new DataView(b);
          v.setUint32(0, i); v.setFloat32(4, clk() - t0);
          try { window.dc.send(b); } catch {}
          i++;
        }
        if (i < msgs.length) window.timer = setTimeout(tick, Math.max(0, msgs[i][0] - (clk() - t0)));
      };
      window.timer = setTimeout(tick, Math.max(0, t0 - clk()));
    }, T0 + offC.off, up);
    await sleep(1500 + duration * 1000 + 5000);        // replay + time for the last retransmissions
    const rxC = await page.evaluate(() => { clearTimeout(window.timer); return window.rx; });
    host.send({ finish: true });
    const { result } = await recv((m) => m.result);
    const base = { up: sc.up.delay || 0, down: sc.down.delay || 0 };
    // (base: the emulated one-way path delay, used for the "delayed beyond the path" counts)
    const ls = link.stats();
    const rttMs = result.rtt.map((x) => x[1]).filter((x) => x > 0);
    return {
      scenario, config, sctp, seed, duration,
      clock: { chromeOffset: +offC.off.toFixed(2), chromeRtt: +offC.rtt.toFixed(2), hostOffset: +offH.off.toFixed(2), hostRtt: +offH.rtt.toFixed(2) },
      path: result.pair,
      link: { upLoss: +(ls.up.lost / Math.max(1, ls.up.packets)).toFixed(4), downLoss: +(ls.down.lost / Math.max(1, ls.down.packets)).toFixed(4), upPackets: ls.up.packets, downPackets: ls.down.packets, downBytes: ls.down.bytes, downDuplicates: ls.down.duplicates, downDupBytes: ls.down.dupBytes },
      down: metrics(down, rxC, base.down, bigDown),
      up: metrics(up, result.rx, base.up, []),
      downSteady: metrics(down, rxC, base.down, [], STEADY_FROM_MS),
      upSteady: metrics(up, result.rx, base.up, [], STEADY_FROM_MS),
      sctpRtt: { median: q(rttMs, 0.5), min: rttMs.length ? Math.min(...rttMs) : null, max: rttMs.length ? Math.max(...rttMs) : null, samples: rttMs.length },
      hostMaxBuffered: result.maxBuffered,
      relay: result.relay,
    };
  } finally {
    try { await browser.close(); } catch {}
    link.close();
    if (host.exitCode === null) { setTimeout(() => { try { host.kill(); } catch {} }, 3000); }
  }
}

async function main() {
  const puppeteer = require('puppeteer-core');
  const chrome = findChrome();
  const trace = JSON.parse(fs.readFileSync(arg('trace', path.join(__dirname, 'trace-u53.json')), 'utf8'));
  const scenarios = arg('scenario', 'cn-typical').split(',');
  const configs = arg('config', 'default').split(',');
  const runs = +arg('runs', 1), seed0 = +arg('seed', 1), duration = +arg('duration', 60);
  const out = arg('out', null);
  for (let r = 0; r < runs; r++) {
    for (const scenario of scenarios) for (const config of configs) {
      const t = Date.now();
      let res;
      try { res = await runOnce({ scenario, config, seed: seed0 + r, duration, trace, chrome, puppeteer }); }
      catch (e) { res = { scenario, config, seed: seed0 + r, error: e.message }; }
      res.at = new Date().toISOString(); res.wallSec = Math.round((Date.now() - t) / 1000);
      const line = JSON.stringify(res);
      if (out) fs.appendFileSync(out, line + '\n');
      const f = (m) => (m ? `mean ${m.mean} p50 ${m.p50} p99 ${m.p99} max ${m.max} jit ${m.jitter} >+100ms ${m.over100} miss ${m.missing}` : '');
      console.log(res.error ? `${scenario}/${config}/seed${res.seed}: ERROR ${res.error}`
        : `${scenario}/${config}/seed${res.seed}: DOWN ${f(res.down)} chunks max ${res.down.bigMax} | UP ${f(res.up)} | loss up ${res.link.upLoss} down ${res.link.downLoss} | sctp rtt ${res.sctpRtt.median} | path ${JSON.stringify(res.path)} | clock ${JSON.stringify(res.clock)}`);
    }
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runOnce, SCENARIOS, CONFIGS };
