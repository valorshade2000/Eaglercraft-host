'use strict';
// Runs EaglercraftX's own integrated-server worker (the code a browser would start
// as a Web Worker from classes.js + `main(["_worker_process_"])`) inside a Node
// worker_thread. Only the handful of browser APIs that the worker touches are
// provided here; no rendering, WebGL or DOM is involved.

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const { createIndexedDB } = require('./idb-sqlite');
const { mergeFor, MapBaselines } = require('./region-data');
const { makeRegionGate } = require('./region-gate');
const { applyGamePatches } = require('./game-patches');
const { TerrainThreads } = require('./terrain');

const g = globalThis;
const log = (m) => parentPort.postMessage({ __host: 'log', msg: String(m) });

g.self = g;
// Multi-core mode: chunk files the game hands over uncompressed are gzipped by the host's pool (this
// thread -> the host -> a pool thread -> back here), then committed (idb-sqlite.js). When the host
// cannot (the mode switched off meanwhile, or its pool failed), they are gzipped here.
const zjobs = new Map(); let zjobSeq = 0;
function compressOnPool(raw) {
  return new Promise((resolve, reject) => {
    const id = ++zjobSeq; zjobs.set(id, { resolve, reject });
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);   // a copy: the caller keeps its bytes
    parentPort.postMessage({ __host: 'zjob', id, op: 'gzip', data: ab }, [ab]);
  });
}
// Regions (config regions; regions.js): which cells of chunks this instance has (region-gate.js).
g.__eaglanRegions = workerData.regions || null;
// Regions: a question to the host that the game's thread waits for (game-patches.js $eaglanRgAskId: a new map's id).
const asks = new Map(), askAt = new Map(); let askSeq = 0;
g.__eaglanRegionsAsk = (what, arg, cb) => { const id = ++askSeq; asks.set(id, cb); askAt.set(id, Date.now()); parentPort.postMessage({ __host: 'ask', id, what, arg }); };
// Regions: a score that changed here, for the other instances (game-patches.js: Score.setScorePoints, removeObjectiveFromEntity).
g.__eaglanScore = (op, name, obj, value) => parentPort.postMessage({ __host: 'score', op, name, obj, value });
const regionGate = workerData.regions ? makeRegionGate(workerData.regions, { post: (m) => parentPort.postMessage(m), log, api: () => g.__eaglanRegionsApi, flush: () => g.indexedDB.flush(), mergeFor }) : null;
if (regionGate) setInterval(() => regionGate.recheck(), 2000).unref();   // claims the host has not answered are asked again
if (regionGate) g.__eaglanRegionGate = regionGate;   // the pre-generation job asks it which cells it may load (game-patches.js)
// Regions: maps written by several instances keep every instance's pixels (region-data.js MapBaselines).
const maps = regionGate ? new MapBaselines() : null;
g.indexedDB = createIndexedDB(workerData.dbFile, log, workerData.diskSync, { compress: compressOnPool, gate: regionGate,
  merge: regionGate ? (k) => maps.merge(k) || mergeFor(k, regionGate.mine) : null, onRead: maps ? (k, d) => maps.read(k, d) : null });
// Terrain threads for the pre-generation job, and with terrainForPlayers for players (config terrainThreads, off by default; terrain.js).
const terrain = new TerrainThreads({ wanted: workerData.terrainThreads, verify: workerData.terrainVerify === true, forPlayers: workerData.terrainForPlayers === true, view: workerData.viewDistance || 4,
  classesJs: workerData.classesJs, log: (m) => log('[runtime] ' + m), store: g.indexedDB,
  longConstants: workerData.gamePatches !== false && (workerData.speedups || {}).longConstants !== false });
g.location = { href: 'http://headless-host.invalid/worker.js', protocol: 'http:', host: 'headless-host.invalid', hostname: 'headless-host.invalid', origin: 'http://headless-host.invalid', search: '', hash: '', pathname: '/worker.js' };
if (!g.navigator) g.navigator = {};
g.__eaglerXOnMessage = null;

// Worker messaging: browser workers use global postMessage / addEventListener("message").
g.postMessage = (msg) => {
  if (msg && msg.pack) parentPort.postMessage(msg, msg.dats ? [msg.pack, msg.ix, ...msg.dats] : [msg.pack, msg.ix]);   // the same, in one buffer (speedup: packed hand-over)
  else if (msg && msg.dats) parentPort.postMessage(msg, msg.dats);   // a player's packets kept during entity tracking (speedup: packet hand-over)
  else if (msg && msg.dat instanceof ArrayBuffer) parentPort.postMessage(msg, [msg.dat]);
  else parentPort.postMessage(msg);
};
const msgListeners = [];
const origAdd = g.addEventListener;
g.addEventListener = function (type, fn, opts) {
  if (type === 'message') { msgListeners.push(fn); return; }
  if (origAdd) return origAdd.call(g, type, fn, opts);
};
g.removeEventListener = function (type, fn) {
  const i = msgListeners.indexOf(fn); if (i >= 0) msgListeners.splice(i, 1);
};
parentPort.on('message', (data) => {
  if (data && data.__harness === 'step') { if (g.__eaglanHarnessStep) g.__eaglanHarnessStep(data.ms || 50); return; }   // (equivalence harness, below)
  if (data && data.__host === 'rules') { applyRules(data); return; }
  if (data && data.__host === 'call') { hostCall(data); return; }
  if (data && data.__host === 'claimResult') { if (regionGate) regionGate.claimResult(data); return; }
  if (data && data.__host === 'answer') { const cb = asks.get(data.id); if (cb) { asks.delete(data.id); askAt.delete(data.id); cb(data.value); } return; }
  if (data && data.__host === 'zjobResult') {
    const j = zjobs.get(data.id); if (!j) return;
    zjobs.delete(data.id);
    if (data.error) j.reject(new Error(data.error)); else j.resolve(new Uint8Array(data.data));
    return;
  }
  const ev = { data, type: 'message' };
  for (const fn of msgListeners.slice()) fn(ev);
});

// Web page console and OP list (hooks that game-patches.js adds to the game code): a console command
// waits for the start of the next tick, says when it starts (callStart: the game's log lines from
// then on, up to callResult, are its own) and replies with its chat output; Tab completion and the
// OP list answer at once.
function hostCall({ id, fn, arg }) {
  const reply = (o) => parentPort.postMessage({ __host: 'callResult', id, ...o });
  const missing = (what) => reply({ error: `${what} is not available (config gamePatches is off, or classes.js is another build)` });
  try {
    if (fn === 'console' || fn === 'complete') {
      const c = g.__eaglanConsole;
      if (!c) return missing('the console');
      if (fn === 'console') c.run(String(arg), reply, () => parentPort.postMessage({ __host: 'callStart', id }));
      else c.complete(String(arg), reply);
      return;
    }
    if (fn === 'ops') { const o = g.__eaglanOps; if (!o) return missing('the OP list'); return reply({ count: o.set(arg.map(String)) }); }
    if (fn === 'pregen') {
      // World pre-generation: start / stop / status (the work itself runs in the game's tick).
      const pg = g.__eaglanPregen;
      if (!pg) return missing('world pre-generation');
      const r = arg.action === 'start' ? pg.start(arg) : arg.action === 'stop' ? pg.stop() : pg.status();
      return reply(r && r.error ? { error: r.error } : { status: r });
    }
    if (fn === 'cpuProfile') return cpuProfile(arg, reply);
    if (fn === 'speedups') return reply({ status: g.__eaglanSpeedups ? Object.fromEntries(Object.entries(g.__eaglanSpeedups).map(([k, f]) => [k, f()])) : null });   // their counters now
    if (fn === 'players' || fn === 'dropCells' || fn === 'releaseNow' || fn === 'playerId' || fn === 'sleepSkip' || fn === 'dataId' || fn === 'saveData' || fn === 'refreshMaps' || fn === 'score') {
      // Regions, moving a player between instances (regions.js): who is here; the unwatched chunks of cells queued for
      // unloading; cells without loaded chunks given back at once; the entity ID a player who comes here keeps.
      const api = g.__eaglanRegionsApi, r = g.__eaglanRegions;
      if (!api || !r || !regionGate) return missing('regions');
      if (fn === 'players') return reply({ status: api.players() });
      if (fn === 'sleepSkip') return api.sleepSkip(arg.setTime === true, (n) => reply({ status: n }));   // every player sleeps: the night is over
      if (fn === 'dataId') return api.dataId(String(arg.key), (n) => reply({ status: n }));   // the main instance: a region instance's new map
      if (fn === 'saveData') return api.saveData((n) => reply({ status: n }));   // before a move: its maps for the next instance
      if (fn === 'refreshMaps') return api.refreshMaps((n) => reply({ status: n }));   // after a move: its maps again from their files
      if (fn === 'score') return api.score(arg, (n) => reply({ status: n }));   // a score that changed in another instance
      if (fn === 'dropCells') return api.dropCells(arg.map(String), (n) => reply({ status: typeof n === 'number' ? n : 0 }));
      if (fn === 'releaseNow') return regionGate.releaseIdle(true).then(() => reply({ status: regionGate.owned() }), (e) => reply({ error: e.message }));
      r.ids = r.ids || {}; r.ids[String(arg.name).toLowerCase()] = arg.id | 0; return reply({ status: true });
    }
    if (fn === 'worldState' || fn === 'setWorldState') {
      // Regions: the main instance's world time and weather, which the region instances follow.
      const api = g.__eaglanRegionsApi;
      if (!api || !g.__eaglanRegions) return missing('regions');
      return reply({ status: fn === 'worldState' ? api.worldState() : api.setWorldState(arg) });
    }
    if (fn === 'flush') {
      // Every chunk file handed over uncompressed is committed (before a stop, or a reported save).
      const t0 = Date.now(), st = g.indexedDB._stats, waiting = st.laterPending;
      // (and the writes already queued: they run on this thread's next turns, setImmediate)
      return g.indexedDB.flush().then(() => new Promise((res) => setImmediate(res))).then(() => reply({ status: { waited: waiting, ms: Date.now() - t0 } }), (e) => reply({ error: e.message }));
    }
    if (fn === 'multicore') {
      // Multi-core mode on or off (the host's multicore.js has its pool ready before it switches on).
      const z = g.__eaglanZ;
      if (!z) return missing('the multi-core mode');
      return reply({ status: { on: z.set(arg.on === true), ...z.status() } });
    }
    reply({ error: 'unknown call ' + fn });
  } catch (e) { reply({ error: (e && e.message) || String(e) }); }
}

// Debug (the host's /debug/cpu-profile, only with EAGLAN_DEBUG): a CPU profile of this thread, the
// game's, for arg.seconds, written to arg.file (open it in Chrome DevTools).
let profiling = false;
function cpuProfile({ seconds = 100, file }, reply) {
  if (profiling) return reply({ error: 'a CPU profile is being recorded already' });
  if (!file) return reply({ error: 'no file given' });
  const { Session } = require('node:inspector');
  const s = new Session(); s.connect(); profiling = true;
  s.post('Profiler.enable', () => s.post('Profiler.start', (err) => {
    if (err) { profiling = false; s.disconnect(); return reply({ error: err.message }); }
    reply({ status: `recording ${seconds} s` });
    setTimeout(() => s.post('Profiler.stop', (e, r) => {
      if (!e) fs.writeFileSync(file, JSON.stringify(r.profile));
      log(`[runtime] CPU profile ${e ? 'failed: ' + e.message : 'written: ' + file}`);
      profiling = false; s.disconnect();
    }), seconds * 1000);
  }));
}

// Game rules and server switches from the host (see game-rules.js): the switches are set at once,
// then the game rules one after the other, through the hook that game-patches.js adds to the game
// code. The reply lists each rule's result (1, or the error) and the switches as the game has them.
function applyRules({ id, rules = [], set = {} }) {
  const h = g.__eaglanHost, reply = (o) => parentPort.postMessage({ __host: 'rulesResult', id, ...o });
  if (!h) { reply({ error: 'the game code hook is not available (config gamePatches is off, or classes.js is another build)' }); return; }
  const results = [];
  try { for (const [k, v] of Object.entries(set)) if (!h.set(k, v)) { reply({ error: 'the server is not running' }); return; } }
  catch (e) { reply({ error: 'setting ' + Object.keys(set).join(', ') + ' failed: ' + (e && e.message) }); return; }
  const next = (i) => {
    if (i >= rules.length) { reply({ results, state: h.get() }); return; }
    try {
      h.rule(rules[i][0], rules[i][1], (r) => { results.push(r === 1 ? 1 : 'error: ' + ((r && r.message) || String(r))); next(i + 1); });
    } catch (e) { results.push('error: ' + (e && e.message)); next(i + 1); }
  };
  next(0);
}

// Console output from System.out / System.err in the worker.
g.console = {
  ...console,
  log: (...a) => log(a.join(' ')),
  info: (...a) => log(a.join(' ')),
  warn: (...a) => log('[warn] ' + a.join(' ')),
  error: (...a) => log('[err] ' + a.join(' ')),
};

process.on('uncaughtException', (e) => log('[worker uncaught] ' + (e && e.stack || e)));

// Every 5 s: what held up this thread (the game server's only thread). The host uses this to explain
// "Can't keep up!" stalls: time spent in world writes (each synced to disk), in garbage collection,
// and how busy the thread was overall.
{
  const { PerformanceObserver, performance: perf } = require('node:perf_hooks');
  const v8 = require('node:v8');
  const gc = { count: 0, ms: 0, maxMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { gc.count++; gc.ms += e.duration; if (e.duration > gc.maxMs) gc.maxMs = e.duration; }
    }).observe({ entryTypes: ['gc'] });
  } catch {}
  const st = g.indexedDB._stats;
  let last = { writes: 0, writeMs: 0 }, elu = perf.eventLoopUtilization(), lastAt = Date.now();
  // Stall report: no tick for 15 s (after the first) is logged with what the game's thread waits for, again every
  // 30 s while it lasts, and its end (busy near 0: it waits; near 100: one long tick of its own work).
  let ticked = false, quietSince = 0, reportedAt = 0;
  const stallReport = (t, busyPct) => {
    const s = Math.round((t - quietSince) / 1000), w = g.indexedDB.waiting(), rg = regionGate ? regionGate.snapshot() : null;
    const oldestAsk = askAt.size ? Math.round((t - Math.min(...askAt.values())) / 1000) : null;
    log(`[runtime] stall: no tick for ${s} s (this thread busy ${busyPct} %); files waited for: ${g.indexedDB.waitingCount()}${w.length ? ' (' + w.map((x) => `${x.k} ${Math.round(x.ms / 1000)} s`).join(', ') + ')' : ''}` +
      (rg ? `; region cells asked for without an answer: ${rg.claims.length ? rg.claims.join(', ') : 'none'}, being given back ${rg.releasing}, in use ${rg.busy}, held ${rg.owned}` : '') +
      `; questions to the host: ${asks.size}${oldestAsk != null ? ` (oldest ${oldestAsk} s)` : ''}; chunk files being compressed: ${st.laterPending}`);
  };
  setInterval(() => {
    const now = perf.eventLoopUtilization(), busy = perf.eventLoopUtilization(now, elu); elu = now;
    const h = v8.getHeapStatistics();
    const ticks = g.__eaglanTicks ? g.__eaglanTicks.take() : null;   // every tick's duration (see game-patches.js)
    {
      const t = Date.now(), n = ticks ? ticks.n : 0, busyPct = Math.round(busy.utilization * 100);
      if (n > 0) {
        if (quietSince && reportedAt) log(`[runtime] stall over: ticks again after ${Math.round((t - quietSince) / 1000)} s`);
        ticked = true; quietSince = 0; reportedAt = 0;
      } else if (ticked) {
        if (!quietSince) quietSince = lastAt;   // since the last report with ticks
        if (t - quietSince >= 15000 && (!reportedAt || t - reportedAt >= 30000)) { reportedAt = t; stallReport(t, busyPct); }
      }
    }
    const pregen = g.__eaglanPregen ? g.__eaglanPregen.status() : null;
    const autosave = g.__eaglanAutosave ? g.__eaglanAutosave.status() : null;   // the autosave spread over ticks
    // ms: the time this report covers; more than 5 s when the game thread was stuck and the timer late.
    const t = Date.now(), ms = t - lastAt; lastAt = t;
    const z = g.__eaglanZ ? g.__eaglanZ.status() : null;   // multi-core mode: packets and chunk files the game handed over
    const sp = g.__eaglanSpeedups ? Object.fromEntries(Object.entries(g.__eaglanSpeedups).map(([k, f]) => [k, f()])) : null;   // the speedups' counters
    parentPort.postMessage({ __host: 'stats', t, ms, ticks, pregen, autosave, multiCore: z, terrain: terrain.wanted ? terrain.status() : null, speedups: sp,
      storage: { writes: st.writes - last.writes, ms: Math.round(st.writeMs - last.writeMs), maxMs: Math.round(st.maxWriteMs), maxQueued: st.maxPending,
        later: { writes: st.laterWrites, pending: st.laterPending, maxPending: st.laterMaxPending, maxMs: Math.round(st.laterMaxMs), redone: st.laterRedone, dropped: st.laterDropped } },
      gc: { count: gc.count, ms: Math.round(gc.ms), maxMs: Math.round(gc.maxMs) },
      busy: Math.round(busy.utilization * 100), heapMb: Math.round(h.used_heap_size / 1048576), heapPhysMb: Math.round(h.total_physical_size / 1048576), extMb: Math.round((h.external_memory || 0) / 1048576), heapLimitMb: Math.round(h.heap_size_limit / 1048576) });
    last = { writes: st.writes, writeMs: st.writeMs }; st.maxWriteMs = 0; st.maxPending = st.pending;
    gc.count = 0; gc.ms = 0; gc.maxMs = 0;
  }, 5000).unref();
}

// Small corrections to the game code are applied to its text in memory (see game-patches.js);
// config "gamePatches": false runs the game code exactly as shipped.
let src = fs.readFileSync(workerData.classesJs, 'utf8');
g.__eaglanSpreadAutosave = workerData.spreadAutosave !== false;   // config spreadAutosave (game-patches.js "spread autosave")
g.__eaglanMobCaps = workerData.mobCaps !== 'viewDistance';   // config mobCaps (game-patches.js "vanilla mob caps")
g.__eaglanMultiCore = workerData.multiCore === true;   // multi-core mode at the start (game-patches.js "multi-core packets")
g.__eaglanSpeedupsWanted = workerData.speedups || {};   // which speedups are on, and their verify mode (game-patches.js "speedup: ...")
// Path work ahead of time (stage 8, config pathAhead; path-ahead.js): its thread starts now, beside the game's own start;
// the game code reads __eaglanPathAheadWanted when it loads (block arrays on shared memory from the first chunk on).
g.__eaglanPathAheadWanted = { on: workerData.pathAhead === true && workerData.gamePatches !== false, searches: workerData.pathAheadSearches === true, verify: (workerData.speedups || {}).verify === true, debug: process.env.EAGLAN_DEBUG_PATHAHEAD || null };
if (g.__eaglanPathAheadWanted.on) {
  const { PathAhead } = require('./path-ahead');
  g.__eaglanPathAhead = new PathAhead({ wanted: true, verify: g.__eaglanPathAheadWanted.verify, classesJs: workerData.classesJs, log: (m) => log('[runtime] ' + m),
    longConstants: (workerData.speedups || {}).longConstants !== false });
}
// Decoration ahead (stage 8, path 4; config decorationAhead for players, decorationAheadPregen for the pre-generation job;
// deco-ahead.js, deco-patch.js): its correction is in the game code only with one of them on; its thread starts the
// first time the game asks for a batch.
g.__eaglanDecoWanted = { on: workerData.decorationAhead === true && workerData.gamePatches !== false, pregen: workerData.decorationAheadPregen === true && workerData.gamePatches !== false, verify: (workerData.speedups || {}).verify === true };
if (g.__eaglanDecoWanted.on || g.__eaglanDecoWanted.pregen) {
  const { DecoAhead } = require('./deco-ahead');
  g.__eaglanDecoHost = new DecoAhead({ classesJs: workerData.classesJs, log: (m) => log('[runtime] ' + m), longConstants: (workerData.speedups || {}).longConstants !== false });
  g.__eaglanDecoAhead = g.__eaglanDecoHost.api();
}
if (workerData.gamePatches === false) log('[runtime] game code corrections off (config gamePatches: false)');
else {   // (speedup 4, the 64-bit constants, is applied to the whole text: game-patches.js longConstants)
  const sw = g.__eaglanSpeedupsWanted, r = applyGamePatches(src, { longConstants: sw.longConstants !== false, longConstantsVerify: sw.verify === true, decoration: g.__eaglanDecoWanted.on || g.__eaglanDecoWanted.pregen });
  src = r.src; for (const p of r.problems) log('[runtime] ' + p);
}
if (process.env.EAGLAN_DEBUG_CHUNKS) {
  // (debugging) EAGLAN_DEBUG_CHUNKS logs the game's call chain when it loads a chunk or checks for its file: "far" (10
  // chunks or more from every player of this instance, with regions) or a list of x:z (calls at the start of the game's
  // loadChunk EIs and of the file system's exists GdV).
  const want = new Set(process.env.EAGLAN_DEBUG_CHUNKS.split(','));
  src = src.replace('function EIs(a,b,c){', 'function EIs(a,b,c){if(!$rt_resuming())globalThis.__eaglanDebugChunk(b,c);');
  src = src.replace('function GdV(a,b){', 'function GdV(a,b){if(!$rt_resuming())globalThis.__eaglanDebugFile($rt_ustr(b));');
  const why = (x, z) => {
    if (!want.has('far')) return want.has(x + ':' + z) ? 'listed' : null;
    const api = g.__eaglanRegionsApi, ps = api ? api.players() : []; if (!ps.length) return null;
    const d = Math.min(...ps.map((q) => Math.max(Math.abs((Math.floor(q.x) >> 4) - x), Math.abs((Math.floor(q.z) >> 4) - z))));
    return d >= 10 ? `${d} chunks from ${ps.map((q) => `${q.name} ${Math.round(q.x)},${Math.round(q.z)}`).join('; ')}` : null;
  };
  const chain = () => new Error().stack.split('\n').slice(3, 60).map((l) => l.trim().split(' ')[1]).join(' < ');
  g.__eaglanDebugChunk = (x, z) => { const w = why(x, z); if (w) log(`[runtime] [debug] loadChunk ${x}:${z} (${w}) ${chain()}`); };
  g.__eaglanDebugFile = (p) => { const c = require('./region-cells').chunkOfPath(p), w = c && why(c.x, c.z); if (w) log(`[runtime] [debug] fileExists ${p} (${w}) ${chain()}`); };
}
// Equivalence harness (test/harness; only when the host runs with EAGLAN_HARNESS, never in normal use): the game gets a
// Math.random of its own (seeded) and a clock of its own (Date, performance) that moves only when the host steps it,
// 50 ms at a time. The server's loop (MinecraftServer, DJm) ticks once 50 ms have passed on that clock, so the server
// runs exactly one tick per step, and two runs with the same inputs are the same, tick for tick. After each tick the
// hash of the game's state goes to the host (game-patches.js "harness state"). The rest of this thread keeps the real
// clock and random numbers.
const harness = workerData.harness || null;
if (harness) {
  const RealDate = Date;
  let now = harness.epoch, sa = harness.seed >>> 0, sb = 0x9e3779b9, sc = 0x243f6a88, sd = 0xb7e15162;
  const t0 = now;
  const next32 = () => {   // sfc32
    const t = (((sa + sb) | 0) + sd) | 0; sd = (sd + 1) | 0;
    sa = sb ^ (sb >>> 9); sb = (sc + (sc << 3)) | 0; sc = (sc << 21) | (sc >>> 11); sc = (sc + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next32();
  const random = () => ((next32() >>> 5) * 67108864 + (next32() >>> 6)) / 9007199254740992;   // 53 bits, as Java's nextDouble
  function GameDate(...a) { if (!new.target) return new RealDate(now).toString(); return a.length ? new RealDate(...a) : new RealDate(now); }
  GameDate.now = () => now; GameDate.UTC = RealDate.UTC; GameDate.parse = RealDate.parse; GameDate.prototype = RealDate.prototype;
  g.__eaglanGameGlobals = Object.create(g, {
    Math: { value: Object.create(Math, { random: { value: random } }) },
    Date: { value: GameDate },
    performance: { value: { now: () => now - t0, timeOrigin: t0 } },
  });
  let stepAt = 0;   // real time of the last step: gameMs = how long the game thread took for the tick (+ <= 1 ms until its loop saw the step)
  g.__eaglanHarnessStep = (ms) => { now += ms; stepAt = performance.now(); };
  const crypto = require('node:crypto');
  let tick = 0;
  g.__eaglanHarnessTick = () => {
    tick++;
    const gameMs = Math.round((performance.now() - stepAt) * 1000) / 1000;
    const h = g.__eaglanHarness, json = JSON.stringify(h ? h.state() : null);
    const m = { __host: 'harnessTick', tick, gameMs, hash: crypto.createHash('sha1').update(json).digest('hex') };
    if (harness.dumpEvery && tick % harness.dumpEvery === 0) m.state = json;   // the whole state now and then (to find what differs)
    parentPort.postMessage(m);
  };
  // the game reaches the browser's globals through the module's $rt_globals; two functions use them directly
  const swap = (a, b) => { if (!src.includes(a)) throw new Error('equivalence harness: the game code has no ' + a.slice(0, 70)); src = src.replace(a, b); };
  swap("}(typeof self!=='undefined'?self:this,function($rt_globals,$rt_exports){", '}(globalThis.__eaglanGameGlobals,function($rt_globals,$rt_exports){');
  swap('function E0(){return Math.random();}', 'function E0(){return $rt_globals.Math.random();}');
  swap('function Hb(){return Long_fromNumber(new Date().getTime());}', 'function Hb(){return Long_fromNumber($rt_globals.Date.now());}');
  // the loop ticks once more than 50 ms have passed (j > 50): on this clock, which moves exactly 50 ms a step, once 50 have
  swap('if(EC(f,L(50))){if(b)return;b=1;$p=11;continue _;}', 'if(EC(f,L(49))){if(b)return;b=1;$p=11;continue _;}');
  log(`[runtime] equivalence harness: seed ${harness.seed}, the game's clock moves only in steps`);
  // (research instrumentation for harness runs only: test/harness/extra-*.js, run.js --extra)
  if (process.env.EAGLAN_HARNESS_EXTRA) { src = require(process.env.EAGLAN_HARNESS_EXTRA).apply(src); log(`[runtime] equivalence harness: ${process.env.EAGLAN_HARNESS_EXTRA} applied`); }
}
vm.runInThisContext(src + '\n;\n' + (harness ? 'globalThis.__eaglanGameGlobals.main' : 'main') + '(["_worker_process_"]);\n', { filename: 'classes.js' });
log('[runtime] classes.js loaded, worker main() invoked');
terrain.begin();
// Regions: where this instance's players are (every second), and its idle cells given back (every 5 s).
if (regionGate) {
  setInterval(() => { const api = g.__eaglanRegionsApi; if (api) { try { parentPort.postMessage({ __host: 'positions', players: api.players() }); } catch {} } }, 1000).unref();
  setInterval(() => { regionGate.releaseIdle().catch((e) => log('[runtime] regions: giving back cells failed: ' + (e && e.message))); }, 5000).unref();
}
