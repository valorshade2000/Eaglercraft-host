'use strict';
// Headless World LAN host daemon.
//   node src/daemon.js --session <session.json>
// Runs detached from the UI. Owns: the native integrated-server worker (Node
// worker_thread running classes.js), one registration per configured relay and the
// WebRTC peers. Control API on 127.0.0.1:<controlPort>; state in data/host-state.json;
// logs in data/logs/host.log (and on stdout when EAGLAN_LOG_STDOUT=1).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Worker } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { IPC_CHANNEL, enc, decode } = require('./ipc');
const { LANHost } = require('./lan-host');
const { normalizeRelays } = require('./relay');
const paths = require('./paths');
const gameRules = require('./game-rules');
const stats = require('./game-stats');
const donation = require('./donation');
const { MultiCore } = require('./multicore');

const argi = process.argv.indexOf('--session');
const session = JSON.parse(fs.readFileSync(process.argv[argi + 1], 'utf8'));
const cfg = session.config;

fs.mkdirSync(paths.logDir, { recursive: true });
const logFile = path.join(paths.logDir, 'host.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const ring = [];
let logSeq = 0;
function log(msg, src = 'host') {
  const line = `[${new Date().toISOString()}] [${src}] ${msg}`;
  ring.push({ seq: ++logSeq, line }); if (ring.length > 2000) ring.shift();
  logStream.write(line + '\n');
  if (process.env.EAGLAN_LOG_STDOUT === '1') process.stdout.write(line + '\n');
}

const state = {
  pid: process.pid, controlPort: null, startedAt: Date.now(), status: 'starting',
  world: session.world, mode: session.mode, code: null, relay: null, codes: [], error: null,
  players: [], tps: [], hidden: !!cfg.hidden, lanGamemode: cfg.lanGamemode, lanCheats: cfg.lanCheats, redundantSend: !!cfg.redundantSend, redundantPort: null, ops: [], playerLimit: 0,
};
function writeState() {
  refreshRelayState();
  const s = { ...state, relays: lan ? lan.relaySnapshot() : [], peers: lan ? lan.peerList() : [], playerCount: lan ? lan.playerCount() : 0, refusedFull: lan ? lan.refusedFull : 0, redundantUnavailable: lan ? lan.redundantUnavailable || lan.redundantUnreached || null : null, multiCore: multiCore.status(), regions: regions ? regions.status() : null, netProcs: netProcs ? netProcs.status() : null, updatedAt: Date.now() };
  const txt = JSON.stringify(s, null, 2);
  try {
    fs.writeFileSync(paths.stateFile + '.tmp', txt);
    fs.renameSync(paths.stateFile + '.tmp', paths.stateFile);
  } catch {
    // Windows refuses the rename while a reader has the file open; fall back to a plain write.
    try { fs.writeFileSync(paths.stateFile, txt); } catch {}
  }
  return s;
}
function setStatus(st, extra) { state.status = st; Object.assign(state, extra || {}); log(`status -> ${st}`); writeState(); }

// ---------------------------------------------------------------- worker
// The game thread's heap: maxHeapMb for its old generation; youngGenerationMb (opt-in, README "Young
// generation of the game thread") for its young generation, otherwise Node's own choice for this
// machine. EAGLAN_DEBUG_YOUNG_MB sets it for measurements (test/bench/load.js --young).
const youngMb = +process.env.EAGLAN_DEBUG_YOUNG_MB > 0 ? +process.env.EAGLAN_DEBUG_YOUNG_MB : cfg.youngGenerationMb;
const youngOk = Number.isInteger(youngMb) && youngMb >= 16 && youngMb <= 1024;
if (youngMb != null && !youngOk) log(`config youngGenerationMb ${JSON.stringify(youngMb)} ignored: it must be a whole number of MB from 16 to 1024, or null (Node's own choice)`);
else if (youngOk) log(`game thread young generation: ${youngMb} MB (${+process.env.EAGLAN_DEBUG_YOUNG_MB > 0 ? 'EAGLAN_DEBUG_YOUNG_MB' : 'config youngGenerationMb'})`);
// Multi-core mode (config multiCore, the web page's Multi-core switch; multicore.js): a pool of threads
// compresses the large network packets while the game thread goes on with its tick. It starts before
// the game, so the game's first packets find it, and switches on and off without a restart (/settings).
// multiCoreWorkers (optional) can lower the number of pool threads below what the CPUs allow.
let workerStarted = false;
if (process.env.EAGLAN_DEBUG_CPU_MASK) {
  // Debug: this process on fewer CPUs, as on a smaller server (test/bench/load.js --host-cpus).
  const mask = parseInt(process.env.EAGLAN_DEBUG_CPU_MASK, 16);
  try { require('./cpu').pinToCpus(mask); log(`DEBUG: this process runs on the CPUs of mask 0x${mask.toString(16)} only (EAGLAN_DEBUG_CPU_MASK)`); }
  catch (e) { log('DEBUG: EAGLAN_DEBUG_CPU_MASK not applied: ' + e.message); }
}
const validWorkers = (v) => (Number.isInteger(v) && v >= 1 && v <= 64 ? v : null);
if (cfg.multiCoreWorkers != null && validWorkers(cfg.multiCoreWorkers) === null) log(`config multiCoreWorkers ${JSON.stringify(cfg.multiCoreWorkers)} ignored (a whole number 1-64, or null: as many as the CPUs allow)`);
// Network processes (config networkProcesses, 0 = off, the default: every player's WebRTC connection on this thread,
// as before; net-procs.js): the players' connections in that many processes of their own; this thread passes packets on.
const validNetProcs = (v) => (Number.isInteger(v) && v >= 0 && v <= 16 ? v : null);
if (cfg.networkProcesses != null && validNetProcs(cfg.networkProcesses) === null) log(`config networkProcesses ${JSON.stringify(cfg.networkProcesses)} ignored (a whole number 0-16; 0 = off)`);
const netProcCount = session.mode === 'import' || session.mode === 'export' || process.env.EAGLAN_HARNESS ? 0 : validNetProcs(cfg.networkProcesses) || 0;
let netProcs = null;
const multiCore = new MultiCore({
  deliver: (ch, buf) => deliverToPlayer(ch, buf),
  setGame: (on) => { if (!workerStarted) return; callWorker('multicore', { on }).then((r) => { if (r.error && on && multiCore.state.on) multiCore.disable(r.error).then(() => writeState()); }); if (regions) regions.forEachRegion((i) => i.call('multicore', { on })); },
  log: (m) => log(m),
  workers: validWorkers(cfg.multiCoreWorkers), debug: !!process.env.EAGLAN_DEBUG,
});
if (cfg.multiCore && session.mode !== 'import' && session.mode !== 'export') multiCore.enable();
// Terrain threads for the pre-generation job (config terrainThreads, 0 = off; terrain.js): the game
// thread starts and ends them itself while a job runs, and with terrainForPlayers while players reach new
// terrain (in every instance, with regions). terrainVerify compares every chunk instead.
const validTerrain = (v) => (Number.isInteger(v) && v >= 0 && v <= 8 ? v : null);
if (cfg.terrainThreads != null && validTerrain(cfg.terrainThreads) === null) log(`config terrainThreads ${JSON.stringify(cfg.terrainThreads)} ignored (a whole number 0-8; 0 = off)`);
const terrainThreads = session.mode === 'import' || session.mode === 'export' ? 0 : validTerrain(cfg.terrainThreads) || 0;
// Speedups (config speedups, on unless false; game-patches.js "speedup: ..."): the same results with less work on
// the game thread. The collision scan (stage 6) only with config collisionScan true as well, until it is proven in play;
// the same for encode once (stage 8: a packet the entity tracker sends to several players is made once; config encodeOnce)
// and the packed hand-over (stage 8: the tracker's packets of a player in one buffer; config packedHandover).
// For measurements: EAGLAN_DEBUG_SPEEDUPS, a list of chunkCache, uuidText, packetBatch, longConstants, lightSets, collisionScan, encodeOnce and packedHandover (or none),
// and EAGLAN_DEBUG_SPEEDUPS_VERIFY=1 (the game computes its own answers too; the packets' order is checked here).
const SPEEDUPS = ['chunkCache', 'uuidText', 'packetBatch', 'longConstants', 'lightSets', 'collisionScan', 'encodeOnce', 'packedHandover'];
const OPT_IN = ['collisionScan', 'encodeOnce', 'packedHandover'];   // only with their own config switch true as well
for (const k of OPT_IN) if (cfg[k] != null && typeof cfg[k] !== 'boolean') log(`config ${k} ${JSON.stringify(cfg[k])} ignored (true or false; off)`);
// Mob caps (config mobCaps, game-patches.js "vanilla mob caps"): "vanilla" (the default) or "viewDistance" (as the build ships).
if (cfg.mobCaps != null && cfg.mobCaps !== 'vanilla' && cfg.mobCaps !== 'viewDistance') log(`config mobCaps ${JSON.stringify(cfg.mobCaps)} ignored ("vanilla" or "viewDistance"; vanilla)`);
const spEnv = process.env.EAGLAN_DEBUG_SPEEDUPS;
const spOn = new Set(spEnv != null ? spEnv.split(',').map((s) => s.trim()).filter((s) => SPEEDUPS.includes(s)) : cfg.speedups === false ? [] : SPEEDUPS.filter((s) => !OPT_IN.includes(s) || cfg[s] === true));
const speedups = { chunkCache: spOn.has('chunkCache'), uuidText: spOn.has('uuidText'), packetBatch: spOn.has('packetBatch'), longConstants: spOn.has('longConstants'), lightSets: spOn.has('lightSets'), collisionScan: spOn.has('collisionScan'), encodeOnce: spOn.has('encodeOnce'), packedHandover: spOn.has('packedHandover'), verify: process.env.EAGLAN_DEBUG_SPEEDUPS_VERIFY === '1' };
if (spEnv != null || speedups.verify) log(`DEBUG: speedups: ${[...spOn].join(', ') || 'none'}${speedups.verify ? ', verify mode' : ''} (EAGLAN_DEBUG_SPEEDUPS)`);
else if (cfg.speedups === false) log('speedups off (config speedups: false)');
else for (const k of OPT_IN) if (speedups[k]) log(`${{ collisionScan: 'collision scan', encodeOnce: 'encode once', packedHandover: 'packed hand-over' }[k]} on (config ${k}: true)`);
// Verify mode: each player's packets are numbered by the game; a gap or a step back is counted.
const packetSeq = new Map(); let packetOrderErrors = 0;
const checkSeq = (ch, first, n) => { if (first === undefined) return; if (first !== (packetSeq.get(ch) || 0) + 1) packetOrderErrors++; packetSeq.set(ch, first + n - 1); };
// Regions (config regions, off by default; regions.js): groups of players far apart on their own game instances, each
// a worker thread like the main one, so that their ticks run on separate cores. regionInstances: at most so many
// besides the main one (default: one per CPU left over, at most 7).
const regionsWanted = cfg.regions === true && session.mode !== 'import' && session.mode !== 'export';
const validRegionInstances = (v) => (Number.isInteger(v) && v >= 0 && v <= 15 ? v : null);
if (cfg.regionInstances != null && validRegionInstances(cfg.regionInstances) === null) log(`config regionInstances ${JSON.stringify(cfg.regionInstances)} ignored (a whole number 0-15, or null: one per CPU left over)`);
const maxRegions = regionsWanted ? (validRegionInstances(cfg.regionInstances) ?? Math.max(0, Math.min(7, Math.floor(require('./cpu').availableCpus().cores + 1e-9) - 1))) : 0;
let regions = null;   // regions.js's Regions, while regionsWanted
const BOOT_MSG = JSON.stringify({ worldsDB: 'worlds', demoMode: false, lang: 'en_US', allowVoiceClient: false, allowUpdateSvc: false, allowUpdateDL: false, allowFNAWSkins: true, crashOnUncaughtExceptions: false });
let localeLines = null;   // the en_US strings sent to the game (also to region instances)

// Equivalence harness (test/harness/run.js sets EAGLAN_HARNESS; never in normal use): the game runs one tick per step on
// a clock of its own with seeded random numbers (worker-runtime.js), and its players are scripted clients in this
// process (test/harness/daemon-side.js) instead of relays and WebRTC.
const harnessData = process.env.EAGLAN_HARNESS ? { seed: Number(process.env.EAGLAN_HARNESS_SEED || 1) >>> 0, epoch: 1767225600000, dumpEvery: Number(process.env.EAGLAN_HARNESS_DUMP_EVERY || 0) } : null;
let harness = null;
// The game thread (the main instance); regions.js starts region instances with the same options and their regions data.
const workerOptions = (regionsData) => ({
  workerData: { dbFile: paths.dbFile, classesJs: paths.classesJs, diskSync: cfg.diskSync === 'normal' ? 'normal' : 'full', gamePatches: cfg.gamePatches !== false, spreadAutosave: cfg.spreadAutosave !== false, mobCaps: cfg.mobCaps === 'viewDistance' ? 'viewDistance' : 'vanilla', multiCore: multiCore.state.on, terrainThreads: regionsData && regionsData.region && cfg.terrainForPlayers !== true ? 0 : terrainThreads, terrainVerify: cfg.terrainVerify === true, terrainForPlayers: cfg.terrainForPlayers === true, viewDistance: cfg.viewDistance || 4, speedups, pathAhead: cfg.pathAhead === true, pathAheadSearches: cfg.pathAheadSearches === true, decorationAhead: cfg.decorationAhead === true, decorationAheadPregen: cfg.decorationAheadPregen === true, regions: regionsData, harness: harnessData },
  resourceLimits: { maxOldGenerationSizeMb: cfg.maxHeapMb || 2048, ...(youngOk ? { maxYoungGenerationSizeMb: youngMb } : {}) },
});
const worker = new Worker(path.join(__dirname, 'worker-runtime.js'), workerOptions(regionsWanted ? { id: 0, region: false, entityIdBase: 1, cellShift: require('./region-cells').CELL_SHIFT } : null));
workerStarted = true;
let msgsToGame = 0, msgsFromGame = 0;   // player messages between this thread and the game thread (status.hostLoad)
const rawToWorker = (channel, data) => {
  const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  worker.postMessage({ ch: channel, dat: ab }, [ab]);
};
const toWorker = (channel, data) => { if (channel !== IPC_CHANNEL) msgsToGame++; rawToWorker(channel, data); };
const ipc = (buf) => toWorker(IPC_CHANNEL, buf);

const ackWaiters = [];
function waitAck(ack, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = { ack, resolve, reject };
    w.timer = setTimeout(() => { ackWaiters.splice(ackWaiters.indexOf(w), 1); reject(new Error(`timeout waiting for ack 0x${ack.toString(16)}`)); }, timeoutMs);
    ackWaiters.push(w);
  });
}

// ---------------------------------------------------------------- game rules
// Web page "Game Rules" (config gameRules, see game-rules.js): with enabled set, the host applies
// the values at every start, and on save too when live is 1. Game rules are kept in the world;
// the switches (PvP, flying, idle kick, command blocks) only while it runs.
// ---------------------------------------------------------------- console and OP list
// Web page console (control.consoleCommand -> /console here -> the game thread, see game-patches.js)
// and the OP list (config ops): only the web page console changes it; it is set at every start.
const callWaiters = new Map();
let callSeq = 0, callLogging = null;   // the console command running in the game: the log lines it causes
function callWorker(fn, arg, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const id = ++callSeq, w = { resolve, log: [] };
    w.timer = setTimeout(() => { callWaiters.delete(id); if (callLogging === w) callLogging = null; resolve({ error: `the game did not answer within ${timeoutMs / 1000} s` }); }, timeoutMs);
    callWaiters.set(id, w);
    worker.postMessage({ __host: 'call', id, fn, arg });
  });
}
// Multi-core mode on at the start: the game's hook must be there (config gamePatches, the u53 build).
if (multiCore.state.on) callWorker('multicore', { on: true }).then((r) => { if (r.error && multiCore.state.on) multiCore.disable(r.error).then(() => writeState()); });
// A game log line as the console shows it: without the time, thread and logger name (the level only
// when it is not INFO) and without formatting codes.
const consoleLogText = (m) => String(m).replace(/^\[[^\]]*\]\[[^\]/]*\/([A-Z]+)\]\[[^\]]*\]: ?/, (x, lvl) => (lvl === 'INFO' ? '' : lvl + ': ')).replace(/§./g, '');
const langMap = new Map();   // en_US strings, filled when the locale is sent to the game
const chatText = (o) => require('./chat-text').chatText(o, langMap);
const validOps = (list) => (Array.isArray(list) ? [...new Set(list.map(String).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n)))] : []);
async function applyOps(why) {
  const ops = validOps(cfg.ops);
  const r = await callWorker('ops', ops);
  if (regions) regions.forEachRegion((i) => i.call('ops', ops));
  state.ops = ops;
  if (r.error) log(`OP list not applied (${why}): ${r.error}`, 'console');
  else log(`OP list (${why}): ${ops.length ? ops.join(', ') : 'nobody'}${cfg.lanCheats ? '; "Allow cheats for every player" is on, so every player can use commands anyway' : ''}`, 'console');
  return r;
}

// ---------------------------------------------------------------- world pre-generation
// Host command "pregen" (web page console, node cli.js pregen): generates and saves the chunks
// within a radius of the world spawn while the world runs, in the game's tick (game-patches.js),
// at most `rate` chunks per second and only while the server keeps up. It starts only when asked
// (the web page's Pre-generate button, the console or node cli.js pregen). An unfinished job is kept
// in data/pregen.json: at the next start it waits until it is resumed ("pregen resume", the button),
// or is resumed at once with config "Pre-generationOnline": true. It resumes four rings back: the
// chunks of the last rings before a stop may not be lit and light populated yet, and the first ring
// of a job is only loaded for its neighbours.
const PREGEN_FILE = path.join(paths.dataDir, 'pregen.json');
const PREGEN_MAX_RADIUS = 4000, PREGEN_DEFAULT_RATE = 4;
let pregenJob = null, pregenLastLog = 0, pregenLastProcessed = null;
const readPregenJob = () => { try { const j = JSON.parse(fs.readFileSync(PREGEN_FILE, 'utf8')); return j && j.world === session.world ? j : null; } catch { return null; } };
function savePregenJob(j) { try { if (j) fs.writeFileSync(PREGEN_FILE, JSON.stringify(j, null, 2)); else fs.rmSync(PREGEN_FILE, { force: true }); } catch (e) { log('pre-generation: could not write ' + PREGEN_FILE + ': ' + e.message); } }
const fmtMin = (s) => (s >= 5400 ? `${(s / 3600).toFixed(1)} h` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const pregenOnline = () => { const v = cfg['Pre-generationOnline']; return v === true || String(v).toLowerCase() === 'true'; };
// An unfinished job in data/pregen.json that has not been resumed (status.pregenWaiting).
const pregenWaitingInfo = (j) => ({ radius: j.radius, rate: j.rate, ring: j.ring || 0, rings: Math.ceil(j.radius / 16) + 2, startedAt: j.startedAt || null });
function pregenText(p) {
  const pct = p.total ? Math.floor((p.processed / p.total) * 100) : 0;
  return `${p.processed}/${p.total} chunks (${pct}%, ring ${Math.min(p.ring, p.rings)}/${p.rings}): ${p.generated} generated, ${p.read} read from disk, ${p.alreadyLoaded} already loaded, ${p.lit} lit; paused for players in ${p.yieldedTicks} ticks${p.skippedRegion ? `; ${p.skippedRegion} left out (region instances have them; a later run fills them in)` : ''}`;
}
async function pregenStart(radius, rate, why, fromRing = 0) {
  // fast: with nobody on the server the job may load more than one chunk per tick (config pregenFastWhenEmpty, default on)
  const r = await callWorker('pregen', { action: 'start', radius, rate, fromRing, fast: cfg.pregenFastWhenEmpty !== false });
  if (r.error) { log(`pre-generation not started: ${r.error}`); return { error: r.error }; }
  const p = r.status;
  pregenJob = { world: session.world, radius, rate, ring: p.ring, startedAt: Date.now() };
  savePregenJob(pregenJob); state.pregen = p; state.pregenWaiting = null; pregenLastLog = Date.now(); pregenLastProcessed = { n: p.processed, t: Date.now() };
  const left = p.total - p.processed;
  log(`pre-generation ${why}: the ${p.total} chunks within ${radius} blocks of spawn (${p.center[0]}, ${p.center[1]})${fromRing ? `, from ring ${fromRing}` : ''}, at up to ${rate} chunks/s (at least ${fmtMin(left / rate)}), only while the server keeps up; it pauses whenever a tick is late`);
  return { status: p };
}
// From the worker's 5 s reports: progress in the log once a minute, the end, and the job file.
// The terrain threads' part of a job, for its last log line.
function terrainText(t) {
  if (!t || !t.wanted) return '';
  const g = t.game || {};
  return `; terrain threads: ${t.made} chunks made (${t.meanMs ?? '-'} ms each), ${g.used || 0} used, ${g.checked || 0} compared with the game's own (${g.same || 0} the same${g.differ ? `, ${g.differ} DIFFERENT` : ''})${t.error ? `; ${t.state}: ${t.error}` : ''}`;
}
function pregenReport(p) {
  state.pregen = p;
  if (!pregenJob || !p) return;
  if (p.running) {
    if (p.ring !== pregenJob.ring) { pregenJob.ring = p.ring; savePregenJob(pregenJob); }
    if (Date.now() - pregenLastLog >= 60000) {
      const rateNow = pregenLastProcessed && Date.now() > pregenLastProcessed.t ? ((p.processed - pregenLastProcessed.n) * 1000) / (Date.now() - pregenLastProcessed.t) : 0;
      log(`pre-generation: ${pregenText(p)}${rateNow > 0 ? `; about ${fmtMin((p.total - p.processed) / rateNow)} left at the last minute's ${rateNow.toFixed(1)} chunks/s` : ''}`);
      pregenLastLog = Date.now(); pregenLastProcessed = { n: p.processed, t: Date.now() };
    }
    return;
  }
  if (p.done && (p.pendingLights || p.loadedNow)) return;   // finished once the last chunks are lit and handed back too
  if (p.done || p.stopped) {
    log(`pre-generation ${p.done ? 'finished' : 'stopped'}${p.error ? ` (${p.error})` : ''} after ${fmtMin((p.endedAt - p.startedAt) / 1000)}: ${pregenText(p)}; game time spent ${fmtMin(p.spentMs / 1000)} (lighting ${fmtMin(p.lightMs / 1000)}), longest chunk ${p.maxMs} ms${terrainText(state.terrain)}`);
    pregenJob = null; savePregenJob(null);
  }
}

const rulesWaiters = new Map();
let rulesSeq = 0, rulesApplied = null;   // the values last applied to this run of the world
function runRules(rules, set) {
  if (regions) regions.forEachRegion((i) => i.runRules(rules, set));   // region instances too (the main one answers)
  return new Promise((resolve) => {
    const id = ++rulesSeq;
    const timer = setTimeout(() => { rulesWaiters.delete(id); resolve({ error: 'the game did not answer within 20 s' }); }, 20000);
    rulesWaiters.set(id, { resolve, timer });
    worker.postMessage({ __host: 'rules', id, rules, set });
  });
}
const rulesConfig = () => gameRules.normalize(cfg.gameRules).value;
const ruleText = (k, v) => (typeof v === 'boolean' ? `${k} ${v ? 'on' : 'off'}` : `${k} ${v}`);
state.gameRules = { enabled: rulesConfig().enabled, live: rulesConfig().live, appliedAt: null, error: null, pending: false, switches: null };
{ const bad = gameRules.normalize(cfg.gameRules).errors; if (bad.length) log(`config gameRules: ignored ${bad.join('; ')}`, 'lan'); }
// Applies values to the running world: all of them (before = null) or only the rules that changed.
async function applyGameRules(values, before, why) {
  const { rules, set } = gameRules.plan(values, before);
  const r = await runRules(rules, set);
  if (r.error) {
    state.gameRules = { ...state.gameRules, error: r.error };
    log(`game rules not applied (${why}): ${r.error}`, 'lan');
    return { applied: false, error: r.error };
  }
  const failed = rules.map(([n], i) => [n, r.results[i]]).filter(([, res]) => res !== 1).map(([n, res]) => `${n} (${res})`);
  rulesApplied = { ...values };
  const changed = rules.map(([n]) => n);
  const notDefault = Object.entries({ ...values, ...set }).filter(([k, v]) => v !== gameRules.defaults()[k]).map(([k, v]) => ruleText(k, v));
  state.gameRules = { ...state.gameRules, error: failed.length ? 'not set: ' + failed.join(', ') : null, appliedAt: Date.now(), switches: r.state || null };
  log(`game rules applied (${why}): ${changed.length} game rule${changed.length === 1 ? '' : 's'} set${changed.length && changed.length <= 6 ? ' (' + changed.join(', ') + ')' : ''}; ` +
    `PvP ${set.pvp ? 'on' : 'off'}, flying ${set.flight ? 'allowed' : 'not allowed'}, idle kick ${set.idleMinutes ? set.idleMinutes + ' min' : 'off'}, command blocks ${set.commandBlocks ? 'on' : 'off'}` +
    `${notDefault.length ? ' | not the game default: ' + notDefault.join(', ') : ''}`, 'lan');
  if (failed.length) log(`game rules: the game refused ${failed.join(', ')}`, 'lan');
  return { applied: true, changed, failed, switches: r.state || null };
}

let lan = null;
let shuttingDown = false;
const droppedChannels = new Set();
function deliverToPlayer(ch, buf) {
  if (regions && ch.startsWith('~eaglan-bc/')) { regions.broadcast(ch, buf); return; }   // regions: for the other instances' players
  if (lan && regions) { const out = regions.outgoing(ch, buf); if (out) { for (const f of out) lan.fromWorker(ch, f); return; } }   // regions: a move, the tab list
  if (lan && lan.fromWorker(ch, buf)) return;
  // After a player leaves, the server still flushes a few packets to the closed channel: report once.
  if (!droppedChannels.has(ch)) { droppedChannels.add(ch); if (droppedChannels.size > 500) droppedChannels.clear(); log(`dropping data for closed/unknown channel '${ch}'`); }
}
const playerChannels = new Map();   // player name -> channel (from the server's login line)
const closeReasons = new Map();     // channel -> reason the server gave for ending the session

// The server's own log lines carry player names and kick reasons; use them for readable
// session summaries and to explain unreadable-data errors.
function inspectServerLog(msg) {
  if (!lan) return;
  let m = /(\S+)\[channel:([^\]]+)\] logged in with entity id/.exec(msg);
  if (m) { playerChannels.set(m[1], m[2]); lan.setPlayerName(m[2], m[1]); return; }
  m = /Disconnecting channel:(\S+?): (.+)$/.exec(msg);
  if (m) { closeReasons.set(m[1], m[2].trim()); return; }
  m = /\]: (\S+) lost connection: (.+)$/.exec(msg);
  if (m && playerChannels.has(m[1])) {
    const t = /text='([^']*)'/.exec(m[2]);
    closeReasons.set(playerChannels.get(m[1]), (t ? t[1] : m[2]).trim());
    return;
  }
  m = /fragment of unknown type: (\d+)/.exec(msg);
  if (m) lan.flagUnreadable(+m[1]);
}

// ---------------------------------------------------------------- game server stalls
// The worker reports every 5 s what held up the game server's thread (worker-runtime.js). Kept for
// 3 minutes, summarised in status, and used to explain each "Can't keep up!" in the log (game-stats.js).
const gameStats = [];
const sumStats = (from, to) => stats.summarize(gameStats, from, to);
let worldLoadedAt = 0;
function explainStall(behindMs, at) {
  if (!worldLoadedAt || at - worldLoadedAt < 60000) {
    log(`game server fell ${(behindMs / 1000).toFixed(1)}s behind while starting up (loading or generating the world): normal once after a start`);
    return;
  }
  const line = stats.explainStall(gameStats, behindMs, at, { diskSync: cfg.diskSync });
  if (line) log(line);
}

// ---------------------------------------------------------------- donation message
// Config donation (donation.js, web page "Donation message"; off by default). With every report of the game thread
// (5 s): the game ticks per second over the last 30 s; below donation.lagTps while players are on, the message goes to
// the in-game chat, at most once per donation.cooldownMinutes. Status reports the ticks per second and whether the
// server lags (the players' page then shows the message too). EAGLAN_DEBUG_DONATION_TPS: ticks per second taken as
// measured (tests).
let donationCfg = (() => { const n = donation.normalize(cfg.donation); if (n.errors.length) log(`config donation: ${n.errors.join('; ')} (the default used for each)`); return n.value; })();
state.donation = { enabled: donationCfg.enabled, tps: null, lag: false, lastSentAt: null, lastAutoAt: null, sent: 0 };
let donationBusy = false;
// A command run as the server where its selector reaches (with regions: @a in every instance), as the console runs it.
function serverCommand(command) {
  const where = regions ? regions.commandTarget(command) : { id: 0 }, jobs = [];
  if (where.all) regions.forEachRegion((i) => jobs.push(i.call('console', command)));
  const inst = where.id ? regions.instances.get(where.id) : null, run = where.command || command;
  jobs.push(inst ? inst.call('console', run) : callWorker('console', run));
  return Promise.all(jobs).then((rs) => { const bad = rs.find((r) => r && r.error); if (bad) throw new Error(bad.error); return rs; });
}
async function sendDonation(lag) {
  await serverCommand(donation.chatCommand(donationCfg, { lag }));
  state.donation.lastSentAt = Date.now(); state.donation.sent++;
}
async function donationCheck() {
  const now = Date.now(), d = donationCfg;
  let tps = null;
  if (process.env.EAGLAN_DEBUG_DONATION_TPS) tps = Number(process.env.EAGLAN_DEBUG_DONATION_TPS);
  else { const r = sumStats(now - donation.LAG_WINDOW_MS, now); if (r && r.ticks && r.seconds >= 25) tps = Math.round((r.ticks.n / r.seconds) * 10) / 10; }
  const { lag, send } = donation.lagDecision(d, { tps, players: lan ? lan.playerCount() : 0, now, lastAt: state.donation.lastAutoAt });
  Object.assign(state.donation, { enabled: d.enabled, tps, lag });
  if (!send || donationBusy || shuttingDown || !worldLoadedAt) return;
  donationBusy = true;
  try {
    await sendDonation(true); state.donation.lastAutoAt = now;
    log(`donation message sent to the chat: the server lags (${tps} game ticks per second, below ${d.lagTps}); again at the earliest in ${d.cooldownMinutes} min`, 'lan');
  } catch (e) { log('donation message not sent: ' + e.message, 'lan'); }
  finally { donationBusy = false; writeState(); }
}

// A player's packets from a game thread (the main instance or a region instance), in the order it sent them.
function playerPacketsFromGame(m) {
  if (m.pack && netProcs && !m.dats && lan && (!regions || regions.canPassPacked(m.ch)) && multiCore.idle(m.ch) && lan.sendPacked(m.ch, m.pack, m.ix)) {
    msgsFromGame += m.ix.byteLength >> 2;   // network processes: the batch as it is (same frames, same order)
    if (speedups.verify) checkSeq(m.ch, m.seq, m.ix.byteLength >> 2);
    return;
  }
  if (m.pack) {
    // The same in one buffer (speedup: packed hand-over): ix[i] >= 0 is where the next frame of pack ends, < 0 is
    // -(k+1) for dats[k], a packet kept as it came. Each frame becomes an ArrayBuffer of its own again, in this order.
    const ix = new Int32Array(m.ix);
    if (speedups.verify) checkSeq(m.ch, m.seq, ix.length);
    let start = 0;
    for (let i = 0; i < ix.length; i++) {
      const v = ix[i]; msgsFromGame++;
      if (v >= 0) { multiCore.fromGame(m.ch, m.pack.slice(start, v), false); start = v; }
      else { const k = -v - 1; multiCore.fromGame(m.ch, m.dats[k], m.zs ? m.zs[k] === 1 : false); }
    }
    return;
  }
  if (m.dats) {
    // A player's packets kept during entity tracking (speedup: packet hand-over), in the order the game sent them.
    if (speedups.verify) checkSeq(m.ch, m.seq, m.dats.length);
    for (let i = 0; i < m.dats.length; i++) { msgsFromGame++; multiCore.fromGame(m.ch, m.dats[i], m.zs ? m.zs[i] === 1 : false); }
    return;
  }
  msgsFromGame++;
  if (speedups.verify) checkSeq(m.ch, m.seq, 1);
  // In order per player; z: a packet the game handed over uncompressed (multi-core mode).
  multiCore.fromGame(m.ch, m.dat, m.z === 1);
}
// Regions: a player's saved position, from the player's file in the world (as worlds.js reads level.dat).
let playerDb = null;
function readPlayerFile(name) {
  if (!playerDb) playerDb = new (require('node:sqlite').DatabaseSync)(paths.dbFile, { readOnly: true });
  const r = playerDb.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get('_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_worlds', `worlds/${session.world}/player/${String(name).toLowerCase()}.dat`);
  return r ? Buffer.from(r.data) : null;
}
if (regionsWanted) {
  const { Regions } = require('./regions');
  regions = new Regions({
    log, viewDistance: cfg.viewDistance || 4, maxRegions, lan: () => lan, enc, decode, IPC_CHANNEL,
    main: { ipc, call: (fn, arg, ms) => callWorker(fn, arg, ms), toGame: rawToWorker, openChannel: (ch) => ipc(enc.playerChannel(ch, true)), closeChannel: (ch) => ipc(enc.playerChannel(ch, false)), reply: (m) => worker.postMessage(m) },
    makeWorker: (r) => new Worker(path.join(__dirname, 'worker-runtime.js'), workerOptions(r)),
    boot: { msg: BOOT_MSG, locale: () => localeLines, startServer: () => ({ worldName: session.world, ownerName: cfg.ownerName || 'HeadlessHost', difficulty: cfg.difficulty ?? 2, viewDistance: cfg.viewDistance || 4 }),
      rules: () => (rulesConfig().enabled ? gameRules.plan(rulesConfig().values, null) : null), ops: () => validOps(cfg.ops), lan: () => ({ gamemode: cfg.lanGamemode, cheats: !!cfg.lanCheats }), multiCore: () => multiCore.state.on },
    fromGame: playerPacketsFromGame,
    zjob: (m, w) => multiCore.jobForGame(m.op, m.data).then((out) => w.postMessage({ __host: 'zjobResult', id: m.id, data: out }, [out]), (e) => w.postMessage({ __host: 'zjobResult', id: m.id, error: e.message })),
    readPlayerFile,
  });
  log(`regions on: groups of players far apart get a game instance of their own, up to ${maxRegions} besides the main one${maxRegions ? '' : ' (no CPU to spare: everyone stays in the main instance)'}`);
}
worker.on('message', (m) => {
  if (m.__host === 'harnessTick') { if (harness) harness.onTick(m); return; }
  if (regions && regions.fromInstance(0, m)) return;
  if (m.__host === 'callStart') { const w = callWaiters.get(m.id); if (w) callLogging = w; return; }
  if (m.__host === 'callResult') { const w = callWaiters.get(m.id); if (w) { callWaiters.delete(m.id); clearTimeout(w.timer); if (callLogging === w) callLogging = null; w.resolve({ ...m, log: w.log }); } return; }
  if (m.__host === 'zjob') {
    // Multi-core saves: gzip a chunk file for the game thread on the pool (it does it itself on an error).
    multiCore.jobForGame(m.op, m.data).then((out) => worker.postMessage({ __host: 'zjobResult', id: m.id, data: out }, [out]),
      (e) => worker.postMessage({ __host: 'zjobResult', id: m.id, error: e.message }));
    return;
  }
  if (m.__host === 'rulesResult') { const w = rulesWaiters.get(m.id); if (w) { rulesWaiters.delete(m.id); clearTimeout(w.timer); w.resolve(m); } return; }
  if (m.__host === 'stats') {
    gameStats.push(m); while (gameStats.length > 36) gameStats.shift();
    if (m.terrain !== undefined) state.terrain = m.terrain;
    if (m.speedups !== undefined) state.speedups = m.speedups ? { ...m.speedups, packetOrderErrors: speedups.verify ? packetOrderErrors : null } : null;
    if (m.pregen || state.pregen) pregenReport(m.pregen);
    donationCheck();
    const r = sumStats(Date.now() - 60000, Date.now());
    if (r) state.gameServer = { busy: r.busy, writesPerMin: r.writes, writeMsPerMin: r.writeMs, maxWriteMs: r.maxWriteMs, maxWritesQueued: r.maxQueued, gcMsPerMin: r.gcMs, maxGcMs: r.maxGcMs, heapMb: r.heapMb, heapPhysMb: r.heapPhysMb, extMb: r.extMb, heapLimitMb: r.heapLimitMb, ticks: r.ticks || null, autosave: m.autosave || null };
    return;
  }
  // Normal worker output also arrives as IPCPacket1ALoggerMessage; only keep runtime errors here,
  // and skip formatted game-log lines ("[hh:mm:ss+ms][thread/LEVEL]...") that IPC delivers anyway.
  if (m.__host) {
    if (/^\[(err|warn)\] \[\d\d:\d\d:\d\d\+\d+\]\[/.test(m.msg)) return;
    if (/^\[(err|warn|worker uncaught|runtime)\]|IDB error/.test(m.msg)) log(m.msg, 'runtime');
    return;
  }
  if (m.dats || m.pack || m.ch !== IPC_CHANNEL) { if (!regions || regions.fromSource(0, m.ch)) playerPacketsFromGame(m); return; }   // regions: not after the player moved on
  const p = decode(m.dat);
  switch (p.type) {
    case 'Logger': {
      log(p.message, 'server'); inspectServerLog(p.message);
      if (callLogging) callLogging.log.push(p.message);
      const stall = /Can't keep up!.*Running (\d+)ms behind/.exec(p.message);
      if (stall) { const at = Date.now(), behind = +stall[1]; setTimeout(() => explainStall(behind, at), 7000).unref(); }
      break;
    }
    case 'StringList': if (p.opCode === 3) state.tps = p.list; break;
    case 'ProgressUpdate': {
      // The worker reports either a 0..1 fraction or a running byte count.
      const v = p.progress <= 1 ? `${(p.progress * 100).toFixed(0)}%` : `${(p.progress / 1048576).toFixed(1)} MB`;
      if (Date.now() - (state._lastProgLog || 0) > 1000) { state._lastProgLog = Date.now(); log(`progress: ${p.message} ${v}`, 'server'); }
      break;
    }
    case 'Crashed': log('INTEGRATED SERVER CRASHED:\n' + p.report, 'server'); state.error = p.report.slice(0, 4000); writeState(); break;
    case 'IssueDetected': log(`issue detected: ${p.issue}`, 'server'); break;
    case 'RequestResponse': {
      const i = ackWaiters.findIndex((w) => w.ack === 'export');
      if (i >= 0) { const w = ackWaiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(p.data); }
      break;
    }
    case 'PlayerChannel':
      if (!p.open && !(regions && regions.onGameClosed(0, p.channel))) {   // regions: a move closes it on the host's word
        log(`server closed player channel '${p.channel}'`);
        if (lan) lan.serverClosedChannel(p.channel, closeReasons.get(p.channel));
        closeReasons.delete(p.channel);
      }
      break;
    case 'KeepAlive': {
      if (p.ack === 0xfc) { log('worker reported EXITED'); if (!shuttingDown) shutdown('worker exited', 1); }
      const failed = p.ack === 0xfe || p.ack === 0xfc;
      if (p.ack === 0xfe) log('integrated server reported a task FAILURE');
      const i = failed ? (ackWaiters.length ? 0 : -1) : ackWaiters.findIndex((w) => w.ack === p.ack);
      if (i >= 0) { const w = ackWaiters.splice(i, 1)[0]; clearTimeout(w.timer); if (failed) w.reject(new Error('integrated server task failed')); else w.resolve(); }
      else if (p.ack === 0x01 && !shuttingDown) { log('integrated server stopped on its own'); shutdown('server stopped', 1); }
      break;
    }
    default: log('unhandled IPC ' + p.type);
  }
});
worker.on('error', (e) => { log('worker error: ' + (e && e.stack || e)); if (!shuttingDown) shutdown('worker error', 1); });
worker.on('exit', (c) => { log('worker thread exited with code ' + c); if (!shuttingDown) shutdown('worker exit', 1); });

// ---------------------------------------------------------------- LAN (all relays)
let stateTimer = null;
function scheduleState() { if (!stateTimer && !shuttingDown) { stateTimer = setTimeout(() => { stateTimer = null; writeState(); }, 200); } }

// A relay that lost the connection registers the world again with a new code: it never gives an
// old one back (README "When the join code changes"). Said once per change, with what to do.
// eaglercraft.com lists worlds on relay.eaglercraft.net only and closes a listing a few minutes
// after its code stops working; its Re-list takes the new code.
const codeChangesLogged = new Map(); // relay url -> codeChangedAt already logged
function noteCodeChange(r) {
  if (!r.previousCode || !r.codeChangedAt || codeChangesLogged.get(r.url) === r.codeChangedAt) return;
  codeChangesLogged.set(r.url, r.codeChangedAt);
  const next = r.name === 'relay.eaglercraft.net'
    ? 'A listing on eaglercraft.com closes a few minutes after its code stops working: re-list it there with the new code (My worlds -> Re-list, https://eaglercraft.com/dashboard/worlds; the web page has a button for it).'
    : 'Give new players the new code.';
  log(`join code on ${r.name} changed: ${r.previousCode} -> ${r.code} (the connection to the relay was lost; a relay never gives an old code back). The world and the players in it are not affected. ${next}`, 'lan');
}

// "hosting" while at least one relay accepts new players; "waiting-for-relay" otherwise.
// state.code / state.relay keep the first active relay in configured order (primary code).
function refreshRelayState() {
  if (!lan || shuttingDown) return;
  const active = lan.activeRelays();
  state.codes = active.map((r) => ({ relay: r.url, name: r.name, code: r.code, turn: r.turn, since: r.activeSince, previousCode: r.previousCode, changedAt: r.codeChangedAt }));
  for (const r of active) noteCodeChange(r);
  state.code = active.length ? active[0].code : null;
  state.relay = active.length ? active[0].url : null;
  const next = active.length ? 'hosting' : 'waiting-for-relay';
  if ((state.status === 'hosting' || state.status === 'waiting-for-relay') && state.status !== next) { state.status = next; log(`status -> ${next}`); }
}

function relayList(input) {
  const { relays, warnings } = normalizeRelays(input || []);
  for (const w of warnings) log('relay config: ' + w, 'lan');
  if (!relays.length) log('WARNING: no valid relay configured; nobody can join until one is added', 'lan');
  return relays;
}

// Options for the send-twice relay. EAGLAN_REDUNDANT_ALLOW_PRIVATE=1 also uses private addresses
// (testing on a LAN; on a server only public addresses make sense). redundantPort: the UDP port
// players send to (1024-65535), or null/empty for a free port per player.
const validPort = (v) => { const n = v === null || v === undefined || v === '' ? null : Number(v); return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null; };
const redundantOpts = () => ({ allowPrivate: process.env.EAGLAN_REDUNDANT_ALLOW_PRIVATE === '1', port: validPort(cfg.redundantPort) });
const twicePortText = () => (validPort(cfg.redundantPort)
  ? `UDP port ${validPort(cfg.redundantPort)}: allow it in the server's firewall, and forward it to this server if it is behind NAT`
  : 'automatic port: needs the server\'s public IP on a network interface');
state.redundantPort = validPort(cfg.redundantPort);
// Player limit (config playerLimit, 1-1000; 0 or empty: none): joins above it are refused with a message (lan-host.js).
const validLimit = (v) => { const n = v === null || v === undefined || v === '' ? 0 : Number(v); return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null; };
state.playerLimit = validLimit(cfg.playerLimit) || 0;

function startLAN() {
  if (harness) {   // the equivalence harness's players instead of relays (test/harness/daemon-side.js)
    lan = harness.lan({ toWorker: regions ? (ch, data) => { msgsToGame++; regions.toGame(ch, data); } : toWorker,
      openPlayerChannel: (ch) => { if (regions) regions.open(ch); else ipc(enc.playerChannel(ch, true)); },
      closePlayerChannel: (ch) => { if (regions) regions.close(ch); else ipc(enc.playerChannel(ch, false)); } });
    ipc(enc.configureLAN({ gamemode: cfg.lanGamemode, cheats: !!cfg.lanCheats, iceServers: [] }));
    setStatus('hosting', { code: 'harness', codes: [] });
    return;
  }
  if (netProcCount && !netProcs) {
    netProcs = new (require('./net-procs').NetProcs)({ count: netProcCount, log: (m) => log(m, 'lan') });
    log(`network processes: ${netProcCount} (config networkProcesses): the players' connections are there, this thread passes packets on`, 'lan');
  }
  lan = new LANHost({
    log: (m) => log(m, 'lan'),
    toWorker: regions ? (ch, data) => { msgsToGame++; regions.toGame(ch, data); } : toWorker,   // regions: to the player's instance
    openPlayerChannel: (ch) => { if (regions) regions.open(ch); else ipc(enc.playerChannel(ch, true)); scheduleState(); },
    closePlayerChannel: (ch) => { if (regions) regions.close(ch); else ipc(enc.playerChannel(ch, false)); scheduleState(); },
    onChange: scheduleState,
    redundant: cfg.redundantSend ? redundantOpts() : null,
    playerLimit: state.playerLimit,
    netProcs,
  });
  if (cfg.redundantPort != null && cfg.redundantPort !== '' && !validPort(cfg.redundantPort)) log(`config redundantPort ${JSON.stringify(cfg.redundantPort)} ignored (must be 1024-65535); send twice uses an automatic port`, 'lan');
  if (validLimit(cfg.playerLimit) === null) log(`config playerLimit ${JSON.stringify(cfg.playerLimit)} ignored (must be a whole number 0-1000; 0 = no limit)`, 'lan');
  if (state.playerLimit) log(`player limit: ${state.playerLimit} (more players are refused with a message)`, 'lan');
  if (cfg.redundantSend) log(`send twice is on: small packets to players are sent twice (${twicePortText()})`, 'lan');
  // IPCPacket17ConfigureLAN sets the game mode / cheats of joining players. It is sent once
  // for the whole world (not per relay). Its ICE list only matters for voice, which is off.
  ipc(enc.configureLAN({ gamemode: cfg.lanGamemode, cheats: !!cfg.lanCheats, iceServers: [] }));
  log(`LAN game mode for joiners: ${['Survival', 'Creative', 'Adventure', 'Spectator'][cfg.lanGamemode] || cfg.lanGamemode}; cheats ${cfg.lanCheats ? 'ON for every player' : 'off'}`, 'lan');
  const relays = relayList(cfg.relays);
  log(`registering the world on ${relays.length} relay${relays.length === 1 ? '' : 's'} in parallel`, 'lan');
  state.status = 'waiting-for-relay'; log('status -> waiting-for-relay');
  lan.start(relays, cfg.lanWorldName || session.displayName || session.world, !!cfg.hidden);
  writeState();
}

// ---------------------------------------------------------------- control API
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return send(403, { error: 'local only' });
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/status') return send(200, writeState());
  // The game thread's 5 s reports of the last 3 minutes (tick times, disk writes, GC, busy), for load tests and monitoring.
  if (req.method === 'GET' && u.pathname === '/stats') { const since = +u.searchParams.get('since') || 0; return send(200, { windows: gameStats.filter((x) => x.t > since).concat(regions ? regions.windows(since) : []) }); }
  if (req.method === 'GET' && u.pathname === '/logs') {
    const since = +u.searchParams.get('since') || 0;
    // instance lets a log viewer notice a restarted host (sequence numbers start again at 1).
    return send(200, { instance: `${process.pid}-${state.startedAt}`, lines: ring.filter((l) => l.seq > since).slice(-1000) });
  }
  if (req.method === 'POST' && u.pathname === '/stop') { send(200, { ok: true }); shutdown('stop requested', 0); return; }
  if (req.method === 'POST' && u.pathname === '/save') {
    // "complete" once the files the multi-core mode compresses on other cores are committed too
    ipc(enc.autosave()); waitAck(0x19, 60000).then(() => flushSaves('save')).then(() => regions && regions.saveAll()).then(() => log('manual save complete')).catch((e) => log('save failed: ' + e.message));
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && u.pathname === '/relays') {
    // Apply a new relay list to the running world (no restart, connected players stay).
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!lan || shuttingDown) return send(409, { error: 'world is not being hosted' });
      const { relays, warnings } = normalizeRelays(body.relays || []);
      for (const w of warnings) log('relay config: ' + w, 'lan');
      cfg.relays = relays;
      log(`applying relay list (${relays.length} relays) without restarting`, 'lan');
      lan.reconfigure(relays);
      return send(200, { ok: true, warnings, relays: lan.relaySnapshot() });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && u.pathname === '/settings') {
    // Settings that apply without a restart.
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      // LAN game mode and cheats: the game reads them on every join, respawn and command, so a new
      // ConfigureLAN takes effect at once (game mode: for players who join or respawn from now on;
      // cheats: for every player, connected ones included). Before the world is open, startLAN sends them.
      let gm = 'lanGamemode' in body ? Number(body.lanGamemode) : cfg.lanGamemode;
      if (![0, 1, 2, 3].includes(gm)) { log(`ignored LAN game mode ${JSON.stringify(body.lanGamemode)} (must be 0, 1, 2 or 3)`, 'lan'); gm = cfg.lanGamemode; }
      const cheats = 'lanCheats' in body ? !!body.lanCheats : !!cfg.lanCheats;
      if (gm !== cfg.lanGamemode || cheats !== !!cfg.lanCheats) {
        cfg.lanGamemode = gm; cfg.lanCheats = cheats; state.lanGamemode = gm; state.lanCheats = cheats;
        if (lan && !shuttingDown) {
          ipc(enc.configureLAN({ gamemode: gm, cheats, iceServers: [] }));
          if (regions) regions.forEachRegion((i) => i.ipc(enc.configureLAN({ gamemode: gm, cheats, iceServers: [] })));
          log(`LAN settings applied: game mode ${['Survival', 'Creative', 'Adventure', 'Spectator'][gm]} for players who join or respawn from now on; cheats ${cheats ? 'ON for every player' : 'off'}`, 'lan');
        }
        writeState();
      }
      // Send twice and its UDP port: for players who join from now on (connected players keep theirs).
      let twiceChanged = false;
      if ('redundantPort' in body) {
        const v = body.redundantPort, p = validPort(v);
        if (p === null && v !== null && v !== undefined && v !== '') log(`ignored send-twice UDP port ${JSON.stringify(v)} (must be 1024-65535, or empty for automatic)`, 'lan');
        else if (p !== validPort(cfg.redundantPort)) {
          cfg.redundantPort = p; state.redundantPort = p; twiceChanged = true;
          if (cfg.redundantSend && !('redundantSend' in body && !body.redundantSend)) log(`send twice: ${twicePortText()}, for players who join from now on`, 'lan');
        }
      }
      if ('redundantSend' in body && !!body.redundantSend !== !!cfg.redundantSend) {
        cfg.redundantSend = !!body.redundantSend; state.redundantSend = cfg.redundantSend; twiceChanged = true;
        log(`send twice ${cfg.redundantSend ? 'on' : 'off'} for players who join from now on${cfg.redundantSend ? ` (${twicePortText()})` : ''}`, 'lan');
      }
      if (twiceChanged) { if (lan) lan.setRedundant(cfg.redundantSend ? redundantOpts() : null); writeState(); }
      // Multi-core mode: on or off at once, without a restart (multicore.js); the order of every
      // player's packets is kept across the switch.
      if ('multiCore' in body && !!body.multiCore !== !!multiCore.state.wanted) {
        cfg.multiCore = !!body.multiCore;
        if (cfg.multiCore) multiCore.enable(); else await multiCore.disable();
        writeState();
      }
      // Player limit: for joins from now on (players already in the world stay).
      if ('playerLimit' in body) {
        const n = validLimit(body.playerLimit);
        if (n === null) log(`ignored player limit ${JSON.stringify(body.playerLimit)} (must be a whole number 0-1000; 0 = no limit)`, 'lan');
        else if (n !== state.playerLimit) {
          cfg.playerLimit = n; state.playerLimit = n; if (lan) lan.setPlayerLimit(n);
          log(n ? `player limit ${n}: more players are refused with a message, from now on` : 'no player limit any more', 'lan');
          writeState();
        }
      }
      // Game rules (web page "Game Rules"): apply mode 1 sets them in the running world now,
      // 0 leaves them for the next start (the world loads them from the config then).
      let rules = null;
      if ('gameRules' in body) {
        const { value: next, errors } = gameRules.normalize(body.gameRules);
        if (errors.length) return send(400, { error: 'game rules: ' + errors.join('; ') });
        const prev = rulesConfig();
        cfg.gameRules = next;
        state.gameRules = { ...state.gameRules, enabled: next.enabled, live: next.live };
        if (JSON.stringify(prev) === JSON.stringify(next)) rules = { applied: false, unchanged: true };
        else if (next.live === 1 && worldLoadedAt && !shuttingDown) {
          if (next.enabled) rules = await applyGameRules(next.values, prev.enabled ? rulesApplied : null, 'saved');
          else if (prev.enabled) {
            // Switched off: the switches go back to the game's own values; game rules stay as they are in the world.
            const r = await runRules([], gameRules.plan({}, {}).set);
            rulesApplied = null; state.gameRules.switches = r.state || null;
            rules = r.error ? { applied: false, error: r.error } : { applied: true, off: true, changed: [], switches: r.state || null };
            log('game rules are no longer set by the host: PvP, flying, idle kick and command blocks are back to the game\'s values; the game rules stay as they are in the world', 'lan');
          }
          state.gameRules.pending = false;
        } else if (next.enabled || prev.enabled) {
          rules = { applied: false, pending: true };
          state.gameRules.pending = true;
          log(`game rules saved (apply mode ${next.live}); they apply at the next start`, 'lan');
        }
        writeState();
      }
      // OP list (only the web page console sends it): applies to every command from now on.
      let opsApplied = null;
      if ('ops' in body && JSON.stringify(validOps(body.ops)) !== JSON.stringify(validOps(cfg.ops))) {
        cfg.ops = validOps(body.ops);
        if (worldLoadedAt && !shuttingDown) { const r = await applyOps('changed'); opsApplied = !r.error; }
        else state.ops = cfg.ops;
        writeState();
      }
      // Donation message: from now on (on, off, the text, the threshold, the cooldown).
      if ('donation' in body) {
        const n = donation.normalize(body.donation);
        if (n.errors.length) log(`ignored donation settings: ${n.errors.join('; ')}`, 'lan');
        else if (JSON.stringify(n.value) !== JSON.stringify(donationCfg)) {
          if (n.value.enabled !== donationCfg.enabled) log(`donation message ${n.value.enabled ? 'on' : 'off'}`, 'lan');
          donationCfg = n.value; state.donation.enabled = n.value.enabled; if (!n.value.enabled) state.donation.lag = false;
          writeState();
        }
      }
      return send(200, { ok: true, multiCore: multiCore.status(), playerLimit: state.playerLimit, redundantSend: !!cfg.redundantSend, redundantPort: validPort(cfg.redundantPort), lanGamemode: cfg.lanGamemode, lanCheats: !!cfg.lanCheats, gameRules: rules, ops: validOps(cfg.ops), opsApplied });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && u.pathname === '/donation-send') {
    // The web page's "Send to chat now": the donation message to every player now (no cooldown: the owner sends it).
    if (!worldLoadedAt || shuttingDown) return send(409, { error: 'the world is not running' });
    if (!donationCfg.enabled) return send(409, { error: 'the donation message is off' });
    try {
      await sendDonation(state.donation.lag); writeState();
      log(`donation message sent to the chat (by the owner, to ${lan ? lan.playerCount() : 0} players)`, 'lan');
      return send(200, { ok: true, players: lan ? lan.playerCount() : 0 });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && (u.pathname === '/console' || u.pathname === '/console/complete')) {
    // Web page console: a command for the game (run at the start of the next tick, as the server),
    // or the Tab completions for what is typed so far.
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!worldLoadedAt || shuttingDown) return send(409, { error: 'the world is not running' });
      if (u.pathname === '/console/complete') {
        const r = await callWorker('complete', '/' + String(body.text || '').replace(/^\/+/, ''), 5000);
        return send(200, { list: r.list || [], error: r.error || null });
      }
      const command = String(body.command || '').trim().replace(/^\/+/, '');
      if (!command) return send(400, { error: 'empty command' });
      if (command.length > 32767) return send(400, { error: 'command too long' });
      log(`> /${command}`, 'console');
      // Regions: world-wide commands (time, weather, game rules, ...) run in every instance, the main one answers; one
      // with a selector of all players or entities (@a, @e) in every instance, each answers for its own (as one server
      // answers for all of them); a command about a player runs in that player's instance; anything else in the main one.
      const where = regions ? regions.commandTarget(command) : { id: 0 };
      if (where.list) {   // the players of every instance
        const lines = (await regions.listLines()).map(chatText); for (const l of lines) log(l, 'console');
        return send(200, { ok: true, result: 1, lines, log: [], error: null });
      }
      const others = [];
      if (where.all) regions.forEachRegion((i) => others.push(i.call('console', command).then((x) => { if (x.error) log(`r${i.id}: the command failed: ${x.error}`, 'console'); return x; })));
      const inst = where.id ? regions.instances.get(where.id) : null, run = where.command || command;   // @p / @r: the player picked
      const r = inst ? await inst.call('console', run) : await callWorker('console', run);
      if (where.selector) for (const x of await Promise.all(others)) if (!x.error) { r.out = (r.out || []).concat(x.out || []); r.result = (r.result || 0) + (x.result || 0); }
      const lines = (r.out || []).map(chatText);
      for (const l of lines) log(l, 'console');
      if (r.error) log(`the command failed: ${r.error}`, 'console');
      // What the command made the server log (say, death messages, ...), already in the log as
      // [server] lines; without the "[Server: ...]" copies of what the console was told (logAdminCommands).
      const told = new Set(lines.map((l) => `[Server: ${l}]`));
      const logLines = (r.log || []).map(consoleLogText).filter((l) => l && !told.has(l));
      return send(200, { ok: !r.error && r.result > 0, result: r.result ?? null, lines, log: logLines, error: r.error || null });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && u.pathname === '/pregen') {
    // World pre-generation: {action: "start", radius (blocks), rate (chunks/s)} | {action: "resume"} (the
    // unfinished job of data/pregen.json) | {action: "stop"} (a waiting job is discarded) | {action: "status"}.
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!worldLoadedAt || shuttingDown) return send(409, { error: 'the world is not running' });
      if (body.action === 'start') {
        const radius = Number(body.radius), rate = body.rate == null || body.rate === '' ? PREGEN_DEFAULT_RATE : Number(body.rate);
        if (!Number.isInteger(radius) || radius < 16 || radius > PREGEN_MAX_RADIUS) return send(400, { error: `the radius must be a whole number of blocks from 16 to ${PREGEN_MAX_RADIUS}` });
        if (!(rate >= 0.5 && rate <= 50)) return send(400, { error: 'the rate must be 0.5 to 50 chunks per second' });
        return send(200, await pregenStart(radius, rate, 'started'));
      }
      if (body.action === 'resume') {
        if (pregenJob) return send(409, { error: 'a pre-generation is running already' });
        const j = readPregenJob();
        if (!j) return send(404, { error: 'there is no unfinished pre-generation to resume' });
        return send(200, await pregenStart(j.radius, j.rate, 'resumed', Math.max(0, (j.ring || 0) - 4)));
      }
      const r = await callWorker('pregen', { action: body.action === 'stop' ? 'stop' : 'status' }, 5000);
      if (r.error) return send(200, { error: r.error });
      if (body.action === 'stop' && pregenJob) { pregenReport(r.status); pregenJob = null; savePregenJob(null); }
      else if (body.action === 'stop' && state.pregenWaiting) {
        const w = state.pregenWaiting; state.pregenWaiting = null; savePregenJob(null);
        log(`pre-generation: the unfinished job (${w.radius} blocks, ring ${w.ring} of ${w.rings}) was discarded`);
        return send(200, { status: r.status || null, discarded: w });
      }
      return send(200, { status: r.status || null, waiting: state.pregenWaiting || null });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (process.env.EAGLAN_DEBUG && req.method === 'POST' && u.pathname === '/debug/cpu-profile') {
    // Debug: a CPU profile of the game thread (?seconds=n&file=path), for test/bench/load.js --profile.
    const r = await callWorker('cpuProfile', { seconds: +u.searchParams.get('seconds') || 100, file: u.searchParams.get('file') });
    return send(r.error ? 400 : 200, r.error ? { error: r.error } : { status: r.status });
  }
  if (process.env.EAGLAN_DEBUG && req.method === 'POST' && u.pathname === '/debug/region-exit') {
    // Test hook (regions): region instance ?id=n ends at once, as if its thread crashed (nothing saved first).
    const i = regions && regions.instances.get(+u.searchParams.get('id'));
    if (!i || !i.region) return send(404, { error: 'no such region instance' });
    log(`DEBUG: region instance r${i.id} ends abruptly`);
    i.worker.terminate();
    return send(200, { ok: true });
  }
  if (process.env.EAGLAN_DEBUG && req.method === 'POST' && u.pathname === '/debug/drop-relay') {
    // Test hook: simulate a relay connection dropping (all relays, or ?relay=<url or host>).
    const which = u.searchParams.get('relay');
    let n = 0;
    if (lan) for (const link of lan.links.values()) if (!which || link.url === which || link.name === which) { if (link.ws) { link.dropConnection(); n++; } }
    log(`DEBUG: forcibly dropped ${n} relay connection(s)`);
    return send(200, { ok: true, dropped: n });
  }
  send(404, { error: 'not found' });
});

// ---------------------------------------------------------------- lifecycle
// Seed text -> long, like GuiCreateWorld: numeric text is used as-is, other text uses String.hashCode().
function seedFrom(s) {
  s = s == null ? '' : String(s).trim();
  if (!s) return require('node:crypto').randomBytes(8).readBigInt64BE();
  if (/^-?\d+$/.test(s)) { try { const v = BigInt(s); if (v === BigInt.asIntN(64, v) && v !== 0n) return v; } catch {} }
  let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return BigInt(h);
}

async function main() {
  log(`daemon pid ${process.pid} starting (mode=${session.mode}, world='${session.world}')`);
  await new Promise((r) => server.listen(cfg.controlPort || 0, '127.0.0.1', r));
  state.controlPort = server.address().port;
  writeState();

  worker.postMessage({ msg: BOOT_MSG });
  await waitAck(0xff, 60000);
  log('integrated server worker is up');

  // Locale for server-side messages (what StringTranslate.dump() sends from a browser client).
  try {
    const { readEPK } = require('./epk');
    const f = readEPK(fs.readFileSync(path.join(paths.vendorDir, 'assets.epk')), (n) => n === 'assets/minecraft/lang/en_US.lang');
    const lang = f.get('assets/minecraft/lang/en_US.lang').toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='));
    ipc(enc.stringList(1, lang)); localeLines = lang;
    for (const l of lang) { const i = l.indexOf('='); langMap.set(l.slice(0, i), l.slice(i + 1)); }
    log(`sent en_US locale (${lang.length} strings) to integrated server`);
  } catch (e) { log('could not load en_US.lang from assets.epk: ' + e.message); }

  if (session.mode === 'import') {
    setStatus('importing');
    const data = fs.readFileSync(session.importFile);
    ipc(enc.importWorld({ worldName: session.world, data, format: session.importFormat, gameRules: session.importGameRules || 0 }));
    await waitAck(0x07, 600000);
    log(`imported world as '${session.world}'`);
    return shutdown('import finished', 0);
  }

  if (session.mode === 'export') {
    setStatus('exporting');
    ipc(enc.requestData(session.world, session.exportFormat === 'mca' ? 2 : 1));
    const data = await waitAck('export', 600000);
    fs.mkdirSync(path.dirname(session.exportFile), { recursive: true });
    fs.writeFileSync(session.exportFile, data);
    log(`exported '${session.world}' (${data.length} bytes) to ${session.exportFile}`);
    state.lastExport = session.exportFile;
    return shutdown('export finished', 0);
  }

  setStatus('loading-world');
  if (session.mode === 'create') {
    const c = session.create;
    log(`creating NEW world folder '${session.world}' (seed ${c.seed || 'random'})`);
    ipc(enc.initWorld({ worldName: session.world, gamemode: c.gamemode, worldType: c.worldType || 0, worldArgs: c.generatorOptions || '',
      seed: seedFrom(c.seed),
      cheats: !!c.cheats, structures: c.structures !== false, bonusChest: !!c.bonusChest, hardcore: !!c.hardcore }));
  }
  ipc(enc.startServer({ worldName: session.world, ownerName: cfg.ownerName || 'HeadlessHost', difficulty: cfg.difficulty ?? 2, viewDistance: cfg.viewDistance || 4 }));
  await waitAck(0x00, 300000);
  log('world loaded'); worldLoadedAt = Date.now();
  if (rulesConfig().enabled) await applyGameRules(rulesConfig().values, null, 'world start');  // before anyone can join
  await applyOps('world start');
  {
    const j = readPregenJob();
    if (j && pregenOnline()) await pregenStart(j.radius, j.rate, 'resumed after the restart (config "Pre-generationOnline")', Math.max(0, (j.ring || 0) - 4));
    else if (j) {
      state.pregenWaiting = pregenWaitingInfo(j);
      log(`pre-generation: an unfinished job is waiting (${j.radius} blocks, ring ${state.pregenWaiting.ring} of ${state.pregenWaiting.rings}); it continues only when started again: the web page's Pre-generate button or "pregen resume" ("Pre-generationOnline": true in data/config.json resumes it at every start)`);
    }
  }
  if (cfg.diskSync === 'normal') log('world writes are not synced to disk one by one (diskSync "normal"): faster on slow disks; the last writes can roll back after a power loss');
  if (harnessData) harness = require(process.env.EAGLAN_HARNESS_MODULE || path.join(__dirname, '..', 'test', 'harness', 'daemon-side.js')).setup({
    log: (m) => log(m, 'harness'), step: (ms) => worker.postMessage({ __harness: 'step', ms }), call: callWorker,
    save: () => { ipc(enc.autosave()); return waitAck(0x19, 60000).then(() => flushSaves('harness')); },
    pendingPackets: () => multiCore.pendingPackets(), shutdown, dbFile: paths.dbFile, world: session.world,
    out: process.env.EAGLAN_HARNESS_OUT, scenario: process.env.EAGLAN_HARNESS_SCENARIO, args: JSON.parse(process.env.EAGLAN_HARNESS_ARGS || '{}') });
  startLAN();
  if (harness) harness.start();
  setInterval(writeState, 2000).unref();
  setInterval(sampleLoopDelay, 60000).unref();
}

// Every player packet passes through this process's event loop (WebRTC callbacks, worker messages),
// so its lag adds directly to every player's latency. Measured per minute, shown in status, and
// logged when high (e.g. an overloaded CPU or swapping VPS).
const LOOP_SAMPLE_MS = 10;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
loopDelay.enable();
function sampleLoopDelay() {
  // The histogram holds the time between samples; the delay is the part beyond the sampling interval
  // (an idle loop reads ~0 ms; a 200 ms stall reads ~200 ms).
  const ms = (ns) => Math.max(0, Math.round((ns / 1e6 - LOOP_SAMPLE_MS) * 10) / 10);
  state.hostLoopDelay = { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max), at: Date.now() };
  if (state.hostLoopDelay.p99 > 50) log(`host process was slow in the last minute (event-loop delay p99 ${state.hostLoopDelay.p99} ms, max ${state.hostLoopDelay.max} ms): this adds to every player's latency; check the server's CPU load and memory`);
  loopDelay.reset();
}

// Host load (status.hostLoad, last minute): CPU of the whole process and of its network thread (this
// thread: WebRTC callbacks, relay connections, the messages to and from the game thread), messages
// per second between players and the game, and where the memory is. Busy figures are event-loop
// utilization (time not idle, in % of one core); "other" is the rest of the process CPU: the WebRTC
// library's own threads (encryption, SCTP, ICE), V8's garbage-collection helpers and I/O threads.
const loadSamples = [];
let loadPrev = { t: Date.now(), elu: performance.eventLoopUtilization(), cpu: process.cpuUsage(), msgs: 0 };
setInterval(() => {
  const now = { t: Date.now(), elu: performance.eventLoopUtilization(), cpu: process.cpuUsage(), msgs: msgsToGame + msgsFromGame };
  loadSamples.push({ ms: now.t - loadPrev.t, net: performance.eventLoopUtilization(now.elu, loadPrev.elu).active,
    cpu: (now.cpu.user - loadPrev.cpu.user + now.cpu.system - loadPrev.cpu.system) / 1000, msgs: now.msgs - loadPrev.msgs });
  if (loadSamples.length > 12) loadSamples.shift();
  loadPrev = now;
  const T = loadSamples.reduce((a, x) => a + x.ms, 0), pct = (k) => Math.round(loadSamples.reduce((a, x) => a + x[k], 0) / T * 1000) / 10;
  const mem = process.memoryUsage(), h = require('node:v8').getHeapStatistics(), gs = state.gameServer || {};
  const cpu = pct('cpu'), net = pct('net'), game = gs.busy ?? null;
  const pool = Math.round(multiCore.sample() * 10) / 10;   // the multi-core pool's threads (last 5 s)
  state.hostLoad = {
    // cpuTotalMs: CPU time of the whole process since it started (all threads), for averages over any window.
    cpuTotalMs: Math.round((now.cpu.user + now.cpu.system) / 1000), at: now.t,
    cpu, netBusy: net, gameBusy: game, poolBusy: multiCore.state.on ? pool : null, other: game === null ? null : Math.max(0, Math.round((cpu - net - game - (multiCore.state.on ? pool : 0)) * 10) / 10),
    msgsPerSec: Math.round(loadSamples.reduce((a, x) => a + x.msgs, 0) / T * 1000),
    rssMb: Math.round(mem.rss / 1048576), hostHeapMb: Math.round(h.total_physical_size / 1048576), hostExternalMb: Math.round((h.external_memory || 0) / 1048576),
    gameHeapMb: gs.heapPhysMb ?? null, gameExternalMb: gs.extMb ?? null,
  };
}, 5000).unref();

// Multi-core mode: waits until every chunk file the game handed over uncompressed is committed.
async function flushSaves(why) {
  const r = await callWorker('flush', {}, 60000);
  if (r.error) { if (!/not available/.test(r.error)) log(`waiting for the chunk files being compressed (${why}) failed: ${r.error}`); return; }
  if (r.status && r.status.waited) log(`${r.status.waited} chunk file${r.status.waited === 1 ? '' : 's'} being compressed on other cores committed (${why}, ${r.status.ms} ms)`);
}

async function shutdown(reason, code) {
  if (shuttingDown) return; shuttingDown = true;
  log(`shutting down: ${reason}`);
  state.status = 'stopping'; writeState();
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  // Close every relay registration and pending reconnect first, so nothing can reconnect
  // while the world is being saved.
  try { if (lan) lan.close(); } catch (e) { log('lan close: ' + e.message); }
  try {
    if (session.mode !== 'import' && session.mode !== 'export') {
      if (regions) await regions.stopAll();   // each saves its own chunks and players first
      ipc(enc.stopServer());
      await waitAck(0x01, 60000);
      await flushSaves('stop');
      log('world saved and integrated server stopped cleanly');
    }
  } catch (e) { log('graceful stop failed: ' + e.message); code = code || 1; }
  try { await worker.terminate(); } catch {}
  try { await multiCore.close(); } catch {}
  try { if (netProcs) netProcs.close(); } catch {}
  state.status = code ? 'crashed' : 'stopped'; state.code = null; state.codes = []; state.stoppedAt = Date.now(); state.stopReason = reason;
  lan = null;
  writeState();
  server.close();
  logStream.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGBREAK', () => shutdown('SIGBREAK', 0));
process.on('uncaughtException', (e) => { log('uncaught: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { log('unhandled rejection: ' + (e && e.stack || e)); });

main().catch((e) => { log('startup failed: ' + (e && e.stack || e)); state.error = String(e && e.message || e); shutdown('startup failed', 1); });
