'use strict';
// Supervisor helpers shared by the web UI server and the CLI. The daemon is spawned
// detached, so neither the UI server nor the CLI needs to stay running for hosting.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const paths = require('./paths');
const { WorldStore } = require('./worlds');
const { normalizeRelays } = require('./relay');
const donation = require('./donation');

// Candidate relays. The world is registered on every one that works; the others are
// marked unavailable/incompatible and retried in the background (see relay.js).
const DEFAULT_RELAYS = [
  'wss://relay.eaglercraft.net/',
  'wss://relay.lax1dude.net/',
  'wss://relay.shhnowisnottheti.me/',
  'wss://relay.deev.is/',
  'wss://relay.mcjs.link/',
  'wss://relay.webmc.xyz/',
  'wss://relay.neurosama.place/',
  'wss://relay.webmc.fun/',
];

const DEFAULT_CONFIG = {
  ownerName: 'HeadlessHost',
  hidden: false,
  lanWorldName: '',
  lanGamemode: 0,
  lanCheats: false,
  difficulty: 2,
  viewDistance: 4,
  redundantSend: false,   // send small packets to players twice (see src/redundant.js); off by default
  redundantPort: null,    // UDP port players send to for send twice (1024-65535); null: a free port per player
  diskSync: 'full',       // 'normal': no disk sync per world write (faster on slow disks; see README)
  gamePatches: true,      // false: run classes.js without the corrections in src/game-patches.js
  gameRules: { enabled: false, live: 1, values: {} },  // web page "Game Rules" (see src/game-rules.js)
  ops: [],                // player names that may use every command; changed only in the web page console
  playerLimit: 0,         // refuse joins above this many players (u53 enforces no limit); 0: no limit
  multiCore: false,       // multi-core mode: large network packets compressed on other CPU cores (src/multicore.js)
  multiCoreWorkers: null, // its pool threads: null = 2 (1 on a 2-CPU server); never more than the CPUs allow minus 1
  networkProcesses: 0,    // the players' WebRTC connections in this many processes of their own (src/net-procs.js); 0 = off
  terrainThreads: 0,      // threads that make the terrain for a pre-generation job (src/terrain.js): 0 = off; 1 is enough
  terrainVerify: false,   // with terrainThreads: every chunk compared with the game's own instead of used (a check)
  terrainForPlayers: false, // with terrainThreads: also the terrain of the chunks players are about to reach (src/terrain.js)
  pregenFastWhenEmpty: true, // pre-generation: more than one chunk per tick while nobody is on the server (up to its rate)
  speedups: true,         // the same results with less work on the game thread (src/game-patches.js "speedup: ...")
  collisionScan: false,   // speedup 6 too: a moving entity skips the entities near it when none can be in its way (stage 6)
  encodeOnce: false,      // speedup 7 too: a packet the entity tracker sends to several players is made once, then copied (stage 8)
  packedHandover: false,  // speedup 8 too: the entity tracker's packets for a player handed to the network side in one buffer (stage 8)
  pathAhead: false,       // mobs' path following worked out ahead on a thread of its own, used only when nothing changed (stage 8)
  pathAheadSearches: false, // with pathAhead: also the chase path searches mobs are about to make (stage 8; exact, but no measured gain)
  decorationAhead: false,  // chunk decoration for players worked out ahead on a thread of its own, replayed only when nothing changed (stage 8)
  decorationAheadPregen: false, // the same for the pre-generation job
  regions: false,         // groups of players far apart on game instances of their own (src/regions.js; experimental)
  regionInstances: null,  // regions: at most so many besides the main instance (null: one per CPU left over, at most 7)
  maxHeapMb: 2048,
  spreadAutosave: true,   // the autosave's chunk saves spread over the next ticks (see README); false: all in one tick, as the game does
  mobCaps: 'vanilla',     // mob caps counted over 8 chunks round each player as in 1.8.8 (10 animals, 70 monsters each); 'viewDistance': as this game build ships
  donation: { ...donation.DEFAULTS },   // the donation message (web page "Donation message", donation.js); off by default
  youngGenerationMb: null,
  'Pre-generationOnline': false,   // true: an unfinished pre-generation is resumed when the world starts; false: only when started again (web page, pregen resume) // the game thread's young generation in MB (16-1024, e.g. 128; see README); null: Node's choice
  uiPort: 8090,
};

fs.mkdirSync(paths.dataDir, { recursive: true });

function readConfigFile() {
  try { return { data: JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) }; }
  catch (e) { return { data: {}, error: e.code === 'ENOENT' ? null : `${paths.configFile}: ${e.message}` }; }
}

// ---- relay list: data/relays.txt, one URL per line, '#' starts a comment.
const RELAYS_HEADER = [
  '# Eaglercraft relays for World LAN hosting, one per line (wss://...).',
  '# The world is registered on every working relay at the same time; each relay gives its own',
  '# join code. Lines starting with # are ignored. Apply changes to a running world with:',
  '#   node cli.js relays apply',
];

function writeRelaysFile(relays) {
  const txt = RELAYS_HEADER.join('\n') + '\n' + relays.join('\n') + '\n';
  fs.writeFileSync(paths.relaysFile + '.tmp', txt);
  fs.renameSync(paths.relaysFile + '.tmp', paths.relaysFile);
}

// First run (or upgrade): create relays.txt from the old config.json "relays" key or the defaults.
function ensureRelaysFile() {
  if (fs.existsSync(paths.relaysFile)) return;
  const { data } = readConfigFile();
  const legacy = Array.isArray(data.relays) && data.relays.length ? data.relays : null;
  writeRelaysFile(normalizeRelays(legacy || DEFAULT_RELAYS).relays);
  if (legacy) { delete data.relays; fs.writeFileSync(paths.configFile, JSON.stringify(data, null, 2)); }
}
try { ensureRelaysFile(); } catch (e) { console.error('could not create ' + paths.relaysFile + ': ' + e.message); }

function loadRelays() {
  let text;
  try { text = fs.readFileSync(paths.relaysFile, 'utf8'); }
  catch (e) { return { relays: normalizeRelays(DEFAULT_RELAYS).relays, warnings: [`${paths.relaysFile}: ${e.message}; using the built-in defaults`], file: paths.relaysFile }; }
  const { relays, warnings } = normalizeRelays(text);
  return { relays, warnings, file: paths.relaysFile };
}

function saveRelays(input) {
  const { relays, warnings } = normalizeRelays(input);
  writeRelaysFile(relays);
  return { relays, warnings, file: paths.relaysFile };
}

function loadConfig() {
  const { data, error } = readConfigFile();
  delete data.relays;
  const r = loadRelays();
  return { ...DEFAULT_CONFIG, ...data, relays: r.relays, relayWarnings: r.warnings, ...(error ? { configError: error } : {}) };
}
function saveConfig(patch) {
  patch = { ...patch };
  let relayWarnings = null;
  if ('relays' in patch) { relayWarnings = saveRelays(patch.relays).warnings; delete patch.relays; }
  const { data } = readConfigFile();
  delete data.relays;
  const c = { ...data, ...patch };
  for (const k of ['relayWarnings', 'configError']) delete c[k];
  fs.writeFileSync(paths.configFile, JSON.stringify(c, null, 2));
  const out = loadConfig();
  if (relayWarnings) out.relayWarnings = relayWarnings; // what was ignored from the submitted list
  return out;
}

const store = new WorldStore(paths.dbFile);

function readState() {
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; } // partial write: retry
  }
  return null;
}
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function ctl(port, method, p, timeout = 4000, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = data ? { 'content-type': 'application/json', 'content-length': data.length } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(data || undefined);
  });
}

async function status() {
  const st = readState();
  if (!st) return { running: false, status: 'stopped' };
  const alive = pidAlive(st.pid) && !['stopped', 'crashed'].includes(st.status);
  if (!alive) {
    const clean = ['stopped', 'crashed'].includes(st.status);
    return { ...st, running: false, code: null, status: clean ? st.status : 'crashed',
      stopReason: clean ? st.stopReason : 'host process ended unexpectedly (killed or crashed); world data up to the last save is intact' };
  }
  try { return { ...(await ctl(st.controlPort, 'GET', '/status')), running: true }; }
  catch { return { ...st, running: true, stale: true }; }
}

function tailFile(file, maxBytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n'); if (size > len) lines.shift();
    return lines.filter(Boolean);
  } catch { return []; }
}

async function logs(since) {
  const st = await status();
  if (st.running && !st.stale) { try { return { live: true, ...(await ctl(st.controlPort, 'GET', '/logs?since=' + (since || 0))) }; } catch {} }
  return { live: false, lines: tailFile(path.join(paths.logDir, 'host.log')).slice(-500).map((line, i) => ({ seq: -1 - i, line })) };
}

// foreground: run the host attached to this terminal (logs on stdout, Ctrl+C saves and
// stops). Resolves when the host exits. Used for debugging on a server.
async function startSession(session, { foreground = false } = {}) {
  const st = await status();
  if (st.running) throw new Error(`host already running (pid ${st.pid}, world '${st.world}')`);
  const config = loadConfig();
  session = { ...session, config };
  fs.writeFileSync(paths.sessionFile, JSON.stringify(session, null, 2));
  fs.mkdirSync(paths.logDir, { recursive: true });
  if (foreground) {
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js'), '--session', paths.sessionFile], {
      stdio: ['ignore', 'inherit', 'inherit'], cwd: paths.root, env: { ...process.env, EAGLAN_LOG_STDOUT: '1' },
    });
    // The terminal's Ctrl+C reaches the host directly (same process group); wait for its clean exit.
    const relay = (sig) => () => { try { child.kill(sig); } catch {} };
    const onInt = relay('SIGINT'), onTerm = relay('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    return new Promise((resolve) => child.on('exit', (code) => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); resolve({ exitCode: code }); }));
  }
  const out = fs.openSync(path.join(paths.logDir, 'daemon-stdout.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js'), '--session', paths.sessionFile], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: paths.root, env: { ...process.env },
  });
  child.unref();
  fs.closeSync(out);
  // Wait for the daemon to publish its state file.
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    const s = readState();
    if (s && s.pid === child.pid) return { pid: child.pid, ...s };
  }
  return { pid: child.pid, status: 'starting' };
}

async function start({ folder, foreground }) {
  const w = store.list().find((x) => x.folder === folder);
  if (!w) throw new Error(`world '${folder}' not found`);
  if (w.error) throw new Error(`world '${folder}' cannot be loaded: ${w.error}`);
  return startSession({ mode: 'existing', world: folder, displayName: w.name }, { foreground });
}

async function create(opts) {
  const name = String(opts.name || '').trim() || 'World';
  const folder = store.freeFolderName(name); // never collides with existing data
  return startSession({ mode: 'create', world: folder, displayName: name, create: {
    seed: opts.seed || '', gamemode: +opts.gamemode || 0, worldType: +opts.worldType || 0, generatorOptions: opts.generatorOptions || '',
    cheats: !!opts.cheats, structures: opts.structures !== false, bonusChest: !!opts.bonusChest, hardcore: !!opts.hardcore,
  } }, { foreground: !!opts.foreground });
}

async function importWorld({ file, name, format }) {
  const folder = store.freeFolderName(name || path.basename(file).replace(/\.[^.]+$/, ''));
  return startSession({ mode: 'import', world: folder, displayName: name, importFile: file, importFormat: format === 'mca' ? 1 : 0, importGameRules: 2 | 1 });
}

async function exportWorld({ folder, format }) {
  const w = store.list().find((x) => x.folder === folder);
  if (!w) throw new Error(`world '${folder}' not found`);
  const ext = format === 'mca' ? 'zip' : 'epk';
  const safe = folder.replace(/[^A-Za-z0-9 _-]/g, '_');
  const exportFile = path.join(paths.dataDir, 'exports', `${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  const r = await startSession({ mode: 'export', world: folder, displayName: w.name, exportFile, exportFormat: format === 'mca' ? 'mca' : 'epk' });
  return { ...r, exportFile };
}

function listExports() {
  const d = path.join(paths.dataDir, 'exports');
  try { return fs.readdirSync(d).filter((f) => /\.(epk|zip)$/.test(f)).map((f) => ({ name: f, bytes: fs.statSync(path.join(d, f)).size, mtime: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime); } catch { return []; }
}

// ---- worlds: rename, delete (into the deleted worlds, restorable), restore, delete permanently (world-admin.js).
// Only while no world runs (as create, import and export), so the game never writes the database meanwhile.
const admin = require('./world-admin');
const WORLD_NAME_MAX = 100;   // (the web page's Create world name field)
async function whileIdle(what) {
  if ((await status()).running) throw new Error(`${what} only while no world runs: stop the world first`);
}
function findWorld(folder) {
  const w = store.list().find((x) => x.folder === folder);
  if (!w) throw new Error(`world '${folder}' not found`);
  return w;
}
// The world's name (or its folder) typed again: what a delete asks for.
const confirmed = (typed, folder, name) => { const t = String(typed ?? '').trim(); return !!t && (t === folder || t === String(name || '').trim()); };

// A rename moves the world to the folder of its new name (world-admin.js says why); the host's files that name a world by
// its folder follow it: the last world (Restart, EAGLAN_AUTOSTART=last), its waiting pre-generation, the last state.
function followRename(from, to) {
  for (const file of [paths.sessionFile, path.join(paths.dataDir, 'pregen.json'), paths.stateFile]) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || j.world !== from) continue;
      j.world = to; if (file === paths.sessionFile) j.displayName = to;
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    } catch {}
  }
}
async function renameWorld({ folder, name }) {
  name = String(name ?? '').trim();
  if (!name || name.length > WORLD_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`World name: 1 to ${WORLD_NAME_MAX} characters, no control characters`);
  await whileIdle('Rename works');
  const w = findWorld(folder);
  if (w.error) throw new Error(`world '${folder}' cannot be renamed: ${w.error}`);
  const r = admin.renameWorld(paths.dbFile, folder, store.freeFolderName(name, folder));
  if (r.folder !== folder) followRename(folder, r.folder);
  // (a service that starts a world by its name would make a new world of the old name at its next start)
  const auto = process.env.EAGLAN_AUTOSTART;
  const autostart = auto && auto !== 'last' && (auto === folder || auto === w.name) ? `EAGLAN_AUTOSTART names this world's old name ('${auto}'): set it to '${r.folder}' (or last), or the next start makes a new world named '${auto}'` : null;
  return { ...r, previous: w.name || folder, typed: name, autostart };
}
async function deleteWorld({ folder, confirm }) {
  await whileIdle('Delete works');
  const w = findWorld(folder);
  if (!confirmed(confirm, folder, w.name)) throw new Error(`type the world's name (${w.name || folder}) to confirm`);
  const r = admin.trashWorld(paths.dbFile, folder);
  // A waiting pre-generation of this world (data/pregen.json) is dropped, so that a new world in this folder does not
  // find it; the chunks it made stay in the world.
  let pregenDropped = false;
  const pregenFile = path.join(paths.dataDir, 'pregen.json');
  try { const j = JSON.parse(fs.readFileSync(pregenFile, 'utf8')); if (j && j.world === folder) { fs.rmSync(pregenFile); pregenDropped = true; } } catch {}
  return { ...r, name: w.name || folder, pregenDropped };
}
function listDeleted() { return fs.existsSync(paths.dbFile) ? admin.listTrash(paths.dbFile) : []; }
async function restoreWorld({ id }) {
  await whileIdle('Restore works');
  return admin.restoreWorld(paths.dbFile, String(id ?? ''), (f) => store.freeFolderName(f));
}
async function purgeWorld({ id, confirm }) {
  await whileIdle('Delete permanently works');
  const t = listDeleted().find((x) => x.id === id);
  if (!t) throw new Error(`deleted world '${id}' not found`);
  if (!confirmed(confirm, t.folder, t.name)) throw new Error(`type the world's name (${t.name || t.folder}) to confirm`);
  return admin.purgeWorld(paths.dbFile, id);
}

// ---- the donation message (donation.js): settings in data/config.json (donation), sent to a running world at once.
async function donationInfo() {
  const n = donation.normalize(loadConfig().donation), st = await status();
  return { settings: n.value, fileErrors: n.errors, defaults: donation.DEFAULTS, running: !!st.running, now: st.running ? st.donation || null : null };
}
async function saveDonation(input) {
  const n = donation.normalize(input);
  if (n.errors.length) throw new Error(n.errors.join('; '));
  saveConfig({ donation: n.value });
  let applied = null;
  try { applied = await applySettings(); } catch (e) { applied = { applied: false, reason: e.message }; }
  return { ok: true, settings: n.value, applied: !!(applied && applied.applied), reason: applied && !applied.applied ? applied.reason : null };
}
async function sendDonationNow() {
  const st = await status();
  if (!st.running || st.stale) throw new Error('the world is not running: start it first');
  const r = await ctl(st.controlPort, 'POST', '/donation-send', 15000, {});
  if (r.error) throw new Error(r.error);
  return r;
}
// What the players' page shows (GET /api/donation): the message while on, and whether the server lags now.
async function donationPublic() {
  const d = donation.normalize(loadConfig().donation).value;
  if (!d.enabled) return donation.publicView(d);
  const st = await status();
  return donation.publicView(d, { lag: !!(st.running && st.donation && st.donation.lag) });
}

async function stop({ timeoutMs = 90000 } = {}) {
  const st = await status();
  if (!st.running) return { ok: true, already: true };
  try { await ctl(st.controlPort, 'POST', '/stop'); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(st.pid)) return { ok: true, graceful: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  // Last resort. SQLite commits each write, so data already saved stays intact.
  try { process.kill(st.pid); } catch {}
  return { ok: true, graceful: false };
}

async function restart() {
  let session; try { session = JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8')); } catch {}
  if (!session || session.mode === 'import' || session.mode === 'export') throw new Error('nothing to restart');
  // (a deleted world must not come back as a new one in its folder)
  if (!store.exists(session.world)) throw new Error(`world '${session.world}' no longer exists (deleted?): host a world from the list`);
  await stop();
  // A created world now exists: restart must load it, never re-create it.
  return startSession({ mode: 'existing', world: session.world, displayName: session.displayName });
}

async function save() {
  const st = await status();
  if (!st.running) throw new Error('host not running');
  return ctl(st.controlPort, 'POST', '/save');
}

// Pushes the current relays.txt to a running host (no restart; connected players stay).
async function applyRelays() {
  const { relays, warnings } = loadRelays();
  const st = await status();
  if (!st.running || st.stale) return { applied: false, reason: 'host not running; the list is used on the next start', relays, warnings };
  const r = await ctl(st.controlPort, 'POST', '/relays', 8000, { relays });
  if (r.error) throw new Error(r.error);
  return { applied: true, relays, warnings, state: r.relays };
}

// Settings that a running host applies to players who join from now on (no restart).
async function applySettings() {
  const cfg = loadConfig();
  const st = await status();
  if (!st.running || st.stale) return { applied: false, reason: 'host not running; used on the next start' };
  const r = await ctl(st.controlPort, 'POST', '/settings', 30000, { redundantSend: !!cfg.redundantSend, redundantPort: cfg.redundantPort ?? null, lanGamemode: cfg.lanGamemode, lanCheats: !!cfg.lanCheats, gameRules: cfg.gameRules, ops: cfg.ops || [], playerLimit: cfg.playerLimit ?? 0, multiCore: !!cfg.multiCore, donation: donation.normalize(cfg.donation).value });
  if (r.error) throw new Error(r.error);
  return { applied: true, multiCore: r.multiCore || null, playerLimit: r.playerLimit ?? 0, redundantSend: r.redundantSend, redundantPort: r.redundantPort ?? null, lanGamemode: r.lanGamemode, lanCheats: r.lanCheats, gameRules: r.gameRules || null, ops: r.ops || [], opsApplied: r.opsApplied ?? null };
}

// Web page console. A command goes to the game and runs as the server (every command allowed);
// "op", "deop" and "ops" manage the OP list, which only the web page may change (allowOp), and
// "save-all" and "stop" are the host's Save and Stop. Returns the lines to show.
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const HOST_COMMANDS = ['op', 'deop', 'ops', 'save-all', 'stop', 'pregen'];

// World pre-generation (host command "pregen", see daemon.js): the lines the console shows.
const PREGEN_USAGE = 'Usage: pregen <radius in blocks> [chunks per second] | pregen resume | pregen stop | pregen status. Generates and saves the terrain within the radius of the world spawn while the world runs (default 4 chunks/s; it pauses whenever the server falls behind). resume continues an unfinished one; stop stops it, or discards an unfinished one.';
const waitingLine = (w) => `An unfinished pre-generation is waiting: ${w.radius} blocks, ring ${w.ring} of ${w.rings}, at up to ${w.rate} chunks/s. pregen resume continues it (on the web page: Pre-generate), pregen stop discards it.`;
function pregenLines(p, waiting) {
  if (!p) return ['No pre-generation has run since the world started.' + (waiting ? ' ' + waitingLine(waiting) : '')];
  const pct = p.total ? Math.floor((p.processed / p.total) * 100) : 0;
  const what = p.running ? 'Running' : p.done ? 'Finished' : p.error ? `Stopped: ${p.error}.` : 'Stopped';
  return [`${what}: ${p.processed} of ${p.total} chunks within ${p.radius} blocks of spawn (${p.center[0]}, ${p.center[1]}), ${pct}%; ${p.generated} generated, ${p.read} read from disk, ${p.alreadyLoaded} already loaded, ${p.lit} lit; at up to ${p.rate} chunks/s; paused for players in ${p.yieldedTicks} ticks.`];
}
// World pre-generation through the host: {action: "start", radius, rate} | {action: "resume"} |
// {action: "stop"} | {action: "status"}; the web page's Pre-generate button and the console use it.
async function pregen(body) {
  const st = await status();
  if (!st.running || st.stale) return { ok: false, lines: ['The world is not running: start it first.'] };
  let r; try { r = await ctl(st.controlPort, 'POST', '/pregen', 10000, body); } catch (e) { return { ok: false, lines: ['The host did not answer: ' + e.message] }; }
  if (r.error) return { ok: false, lines: [r.error] };
  const p = r.status;
  if (body.action === 'start') return { ok: true, pregen: p, lines: [`Pre-generating the ${p.total} chunks within ${p.radius} blocks of spawn (${p.center[0]}, ${p.center[1]}) at up to ${p.rate} chunks/s. Progress: pregen status, or the log.`] };
  if (body.action === 'resume') return { ok: true, pregen: p, lines: [`Pre-generation resumed: the ${p.total} chunks within ${p.radius} blocks of spawn (${p.center[0]}, ${p.center[1]}), from ring ${p.ring} of ${p.rings}, at up to ${p.rate} chunks/s.`] };
  if (body.action === 'stop' && r.discarded) return { ok: true, pregen: p, lines: [`The unfinished pre-generation (${r.discarded.radius} blocks, ring ${r.discarded.ring} of ${r.discarded.rings}) was discarded; it will not be resumed.`] };
  if (body.action === 'stop') return { ok: true, pregen: p, lines: p && p.stopped ? ['Pre-generation stopped; the chunks it has loaded are saved and unloaded over the next seconds.', ...pregenLines(p)] : pregenLines(p, r.waiting) };
  return { ok: true, pregen: p, waiting: r.waiting || null, lines: pregenLines(p, r.waiting) };
}
async function pregenCommand(args) {
  if (String(args[0] || '').toLowerCase() === 'start') args = args.slice(1);
  const sub = (args[0] || 'status').toLowerCase();
  if (['status', 'stop', 'resume'].includes(sub) && args.length === 1 || !args.length) return pregen({ action: sub });
  if (/^\d+$/.test(sub) && args.length <= 2 && (args[1] === undefined || /^\d+(\.\d+)?$/.test(args[1]))) return pregen({ action: 'start', radius: +sub, rate: args[1] === undefined ? null : +args[1] });
  return { ok: false, lines: [PREGEN_USAGE] };
}
async function consoleCommand(text, { allowOp = false } = {}) {
  const command = String(text || '').trim().replace(/^\/+/, '');
  if (!command) return { ok: false, lines: [] };
  const [word, ...args] = command.split(/\s+/);
  const name = word.toLowerCase();
  if (name === 'op' || name === 'deop' || name === 'ops') {
    if (!allowOp) return { ok: false, lines: ['OP can only be given or taken in the web page console.'] };
    let ops = (loadConfig().ops || []).filter((n) => PLAYER_NAME.test(n));
    if (name === 'ops') return { ok: true, ops, lines: [ops.length ? `OPs (${ops.length}): ${ops.join(', ')}` : 'Nobody is OP.'] };
    const who = args[0];
    if (!who || args.length > 1 || !PLAYER_NAME.test(who)) return { ok: false, lines: [`Usage: ${name} <player name> (letters, digits and _, up to 16 characters)`] };
    const had = ops.find((n) => n.toLowerCase() === who.toLowerCase());
    if (name === 'op') { if (had) return { ok: true, ops, lines: [`${had} is already an OP.`] }; ops = [...ops, who]; }
    else { if (!had) return { ok: false, ops, lines: [`${who} is not an OP.`] }; ops = ops.filter((n) => n !== had); }
    saveConfig({ ops });
    let r; try { r = await applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
    const line = name === 'op' ? `Made ${who} an OP: they can use every command.` : `${had} is no longer an OP.`;
    const when = !r.applied ? 'Saved; it applies when the world starts.' : r.opsApplied === false ? 'Saved, but the game did not take it (see the log).' : 'In effect now.';
    return { ok: true, ops, lines: [line, when] };
  }
  if (name === 'save-all') { try { await save(); return { ok: true, lines: ['Saving the world (the log says when it is done).'] }; } catch (e) { return { ok: false, lines: [e.message] }; } }
  if (name === 'pregen') return pregenCommand(args);
  if (name === 'stop') { const r = await stop(); return { ok: true, lines: [r.already ? 'The server is not running.' : 'The world was saved and the server stopped.'] }; }
  const st = await status();
  if (!st.running || st.stale) return { ok: false, lines: ['The world is not running: start it first.'] };
  let r; try { r = await ctl(st.controlPort, 'POST', '/console', 25000, { command }); } catch (e) { return { ok: false, lines: ['The host did not answer: ' + e.message] }; }
  const lines = [...(r.lines || []), ...(r.error ? [r.error] : [])];
  if (name === 'help' || name === '?') lines.push(`Host commands: op <player>, deop <player>, ops (the list), save-all, stop, pregen <radius> [chunks/s] | resume | stop | status (generate the terrain round spawn).${allowOp ? '' : ' OP only in the web page console.'}`);
  return { ok: !!r.ok, lines, log: r.log || [] };
}

// Tab completion for the console: the game's own completions (commands, then their arguments)
// plus the host commands.
async function consoleComplete(text) {
  const t = String(text || '').replace(/^\/+/, '');
  const st = await status();
  let list = [];
  if (st.running && !st.stale) { try { list = (await ctl(st.controlPort, 'POST', '/console/complete', 6000, { text: t })).list || []; } catch {} }
  if (!/\s/.test(t)) list = list.concat(HOST_COMMANDS.filter((c) => c.startsWith(t.toLowerCase())).map((c) => '/' + c));
  return { list: [...new Set(list)].sort() };
}

// For the web page's Game Rules section: the list of rules and switches, the saved settings, and
// the values stored in the world that is (or was last) hosted, to start from when nothing is saved.
async function gameRulesInfo() {
  const gr = require('./game-rules');
  const st = await status();
  let folder = st.running ? st.world : null;
  if (!folder) { try { folder = JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8')).world; } catch {} }
  const stored = folder ? store.gameRules(folder) : null;
  return {
    groups: gr.GROUPS, rules: [...gr.RULES, ...gr.HOST_RULES], switches: gr.SWITCHES, defaults: gr.defaults(),
    config: gr.normalize(loadConfig().gameRules).value,
    world: stored ? { folder, values: gr.fromLevelDat(stored) } : null,
    running: !!st.running, state: st.running ? st.gameRules || null : null,
  };
}

module.exports = { loadConfig, saveConfig, readConfigFile, loadRelays, saveRelays, applyRelays, applySettings, gameRulesInfo, consoleCommand, consoleComplete, pregen, store, status, logs, start, create, importWorld, exportWorld, listExports, renameWorld, deleteWorld, listDeleted, restoreWorld, purgeWorld, donationInfo, saveDonation, sendDonationNow, donationPublic, stop, restart, save, DEFAULT_CONFIG, DEFAULT_RELAYS };
