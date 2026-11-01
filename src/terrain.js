'use strict';
// Terrain threads (config terrainThreads, 0 = off, the default): while a pre-generation job runs, and with
// config terrainForPlayers while players play, other threads make the terrain of the chunks the game is
// about to make, and the game uses that instead of making it (game-patches.js, "terrain threads"; each
// thread is terrain-worker.js). This runs on the game's thread (worker-runtime.js). Every 50 ms:
//   - a job that runs: starts the threads (each loads its own copy of the game code: 1-2 s, and its own
//     memory), then asks them for the chunks ahead of the job that are neither loaded nor saved, and
//     hands what they make to the game;
//   - players (terrainForPlayers, no job running), every 250 ms: the chunks of each player's view on the
//     way it goes in the next 4 s at its speed of the last second that are neither loaded nor saved
//     (playersAhead); the threads start when there is one, and are asked for them, sooner first;
//   - 10 s after the job stopped running, and a minute after the last chunk for players: ends the
//     threads (their memory is given back).
// What moves: the noise, the surface, the caves, the ravines and the biomes. The structures, decoration,
// lighting and saving stay on the game thread. Every 32nd chunk (every one with config terrainVerify) is
// compared with the game's own instead of used, blocks and biomes; a difference switches the threads off
// until the world restarts, and is logged.

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { availableCpus } = require('./cpu');
const { pregenPlan } = require('./game-patches');

const WORLDS_DB = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_worlds';
const AHEAD = 48;         // chunks of the job looked at, from where it is
const PER_THREAD = 4;     // chunks asked of a thread at a time
const IDLE_MS = 10000;    // the threads end this long after the job stopped running
const CHECK_EVERY = 32;   // one chunk in so many is compared instead of used
// Players (terrainForPlayers): how often their positions are looked at, how far ahead (the way each goes in
// PLAY_LEAD s, a point every PLAY_STEP s), the speed above which a move is a jump (a teleport or a respawn:
// nothing on the way), how long the threads stay after the last chunk for players, and how many chunks the
// game keeps from the threads (128 KB each).
const PLAY_EVERY = 250;
const PLAY_LEAD = 4;
const PLAY_STEP = 0.5;
const PLAY_MAX_SPEED = 25;
const PLAY_IDLE_MS = 60000;
const PLAY_KEEP = 192;
// A thread's young generation: 8 MB keeps it about 100 MB smaller than Node's default here, for about
// 15% more time per chunk (it still makes them faster than the job loads them).
const YOUNG_MB = 8;

// The file of chunk (x, z) in the world's folder, as the game names it (VFSChunkLoader.getChunkPath,
// Eq2: x and z plus 1,900,000, six hex digits each, the lowest first; "level0" is the overworld).
function chunkPath(dir, x, z) {
  const hex = '0123456789ABCDEF', ux = (x + 1900000) | 0, uz = (z + 1900000) | 0;
  let a = '', b = '';
  for (let i = 0; i < 6; i++) { a += hex[(ux >>> (i * 4)) & 15]; b += hex[(uz >>> (i * 4)) & 15]; }
  return `${dir}/level0/${a}${b}.dat`;
}

// The next n chunks the job loads, in its order (rings round its centre, as $eaglanPregenStep goes),
// from where it is (st.ring, st.k): [x, z, ring].
function ahead(st, n) {
  const out = [];
  for (let r = st.ring, k = st.k; out.length < n && r <= st.rings;) {
    const o = pregenPlan.ringPos(r, k);
    out.push([st.cx + o[0], st.cz + o[1], r]);
    if (++k >= (r === 0 ? 1 : 8 * r)) { k = 0; r++; }
  }
  return out;
}

class TerrainThreads {
  // wanted: config terrainThreads; forPlayers: config terrainForPlayers, view: the view distance (chunks);
  // store: the storage layer (idb-sqlite.js: readFile, hasFile); game / pregen / detect / workerFile / idleMs /
  // playIdleMs / playEvery: the game's hooks, the CPU count, the thread, how long it stays after a job and after the
  // last chunk for players, and how often the players are looked at (replaced in the tests).
  constructor({ wanted, verify = false, forPlayers = false, view = 4, classesJs, log = () => {}, store, game, pregen, detect, workerFile, idleMs = IDLE_MS, playIdleMs = PLAY_IDLE_MS, playEvery = PLAY_EVERY, longConstants = false }) {
    this.wanted = Math.max(0, Math.floor(Number(wanted) || 0));
    this.verify = verify === true;
    this.classesJs = classesJs; this.log = log; this.store = store; this.longConstants = longConstants === true;   // speedup 4 in the threads' copies too
    this.game = game || (() => globalThis.__eaglanTerrain);
    this.pregen = pregen || (() => globalThis.__eaglanPregen);
    this.detect = detect || availableCpus;
    this.workerFile = workerFile || path.join(__dirname, 'terrain-worker.js'); this.idleMs = idleMs;
    this.state = this.wanted ? 'waiting' : 'off';   // waiting (for a job) | starting | on | failed | unavailable | off
    this.error = null; this.threads = []; this.asked = new Map(); this.jobAt = null; this.dir = null; this.cpu = null;
    this.idleSince = 0; this.startedAt = 0; this.runs = 0; this.initMs = null; this.seed = null;
    this.made = 0; this.ms = 0; this.maxMs = 0; this.onDisk = 0; this.loadedAlready = 0;
    this.timer = null;
    // players: the last positions of each (name -> [{ t, x, z }], 1.5 s), the chunks known to be there (1: loaded or
    // saved) or asked for (2), the chunks to ask for next (sooner first), when they were looked at, when a chunk
    // was last wanted for them, what the threads were last started for
    this.forPlayers = forPlayers === true; this.view = Math.max(1, Math.floor(Number(view) || 4)); this.playIdleMs = playIdleMs; this.playEvery = playEvery;
    this.track = new Map(); this.seen = new Map(); this.playQueue = []; this.playAt = 0; this.playLast = 0; this.prunedAt = 0; this.use = null;
    this.playAsked = 0; this.playLooks = 0;
  }
  begin() {
    if (!this.wanted || this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.fail('internal error: ' + ((e && e.stack) || e)); } }, 50);
    this.timer.unref();
  }
  tick() {
    const pg = this.pregen(), st = pg ? pg.status() : null, job = !!(st && st.running), now = Date.now();
    // players: while no job runs (the job's chunks first); a chunk wanted keeps the threads for playIdleMs
    if (!job && this.forPlayers && this.state !== 'failed' && this.state !== 'unavailable') {
      const want = this.playersAhead(now);
      if (want) { this.playQueue = want; if (want.length) this.playLast = now; }
    }
    const players = !job && this.forPlayers && this.playLast > 0 && now - this.playLast < this.playIdleMs;
    if (!job && !players) {
      if (this.threads.length) {
        if (!this.idleSince) this.idleSince = now;
        else if (now - this.idleSince >= this.idleMs) this.stop(this.use === 'players' ? 'no player reached new terrain for a while' : 'the pre-generation job ended');
      }
      return;
    }
    this.idleSince = 0;
    if (this.state === 'failed' || this.state === 'unavailable') return;
    if (this.state === 'waiting') this.start(job ? 'job' : 'players');
    else if (this.state === 'on') {
      const s = this.game().status();   // a difference found by the game switched it off ($eaglanTgAt9)
      if (s.error) return this.fail(s.error);
      this.use = job ? 'job' : 'players';
      if (job) this.feed(st); else this.feedPlayers();
    }
  }
  // Players: every PLAY_EVERY ms (playEvery; null between), the chunks of the overworld's players' views (the view distance
  // around them) on the way each goes in the next PLAY_LEAD s at its speed of the last second, that are neither
  // loaded, nor saved, nor asked for already: [x, z, s (when it is reached), distance], sooner first. A player
  // standing still: its view only (all loaded); a jump (teleport, respawn): from where it landed. Chunks known to
  // be loaded or saved stay known (a chunk once made is never made again); far from every player they are
  // forgotten, and looked at again when one comes back.
  playersAhead(now = Date.now()) {
    if (now - this.playAt < this.playEvery) return null;
    this.playAt = now; this.playLooks++;
    const T = this.game(); if (!T || !T.players) return [];
    const w = T.world(); if (!w || !w.generate) return [];
    this.dir = w.dir;
    const ps = T.players(), v = this.view, out = [], looked = new Set(), names = new Set();
    for (const p of ps) {
      names.add(p.name);
      let h = this.track.get(p.name); if (!h) this.track.set(p.name, (h = []));
      h.push({ t: now, x: p.x, z: p.z }); while (h.length > 1 && now - h[0].t > 1500) h.shift();
      const o = h[0], dt = (now - o.t) / 1000;
      let vx = dt >= 0.4 ? (p.x - o.x) / dt : 0, vz = dt >= 0.4 ? (p.z - o.z) / dt : 0;
      if (Math.hypot(vx, vz) > PLAY_MAX_SPEED) { vx = 0; vz = 0; h.splice(0, h.length - 1); }
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      for (let s = 0; s <= PLAY_LEAD + 1e-9; s += PLAY_STEP) {
        const cx = Math.floor(p.x + vx * s) >> 4, cz = Math.floor(p.z + vz * s) >> 4;
        for (let dx = -v; dx <= v; dx++) for (let dz = -v; dz <= v; dz++) {
          const x = cx + dx, z = cz + dz, id = pregenPlan.id(x, z);
          if (looked.has(id) || this.seen.has(id)) continue;
          looked.add(id);
          if (T.loaded(x, z)) { this.seen.set(id, 1); this.loadedAlready++; continue; }
          if (this.store.hasFile(WORLDS_DB, chunkPath(this.dir, x, z))) { this.seen.set(id, 1); this.onDisk++; continue; }
          out.push([x, z, s, Math.max(Math.abs(x - pcx), Math.abs(z - pcz))]);
        }
        if (!vx && !vz) break;
      }
    }
    for (const n of this.track.keys()) if (!names.has(n)) this.track.delete(n);
    if (this.seen.size > 20000 && now - this.prunedAt > 10000) {
      this.prunedAt = now;
      const r = v + Math.ceil((PLAY_LEAD * PLAY_MAX_SPEED) / 16) + 2, at = ps.map((p) => [Math.floor(p.x) >> 4, Math.floor(p.z) >> 4]);
      for (const id of this.seen.keys()) {
        const [x, z] = pregenPlan.xz(id);
        if (!at.some(([cx, cz]) => Math.abs(x - cx) <= r && Math.abs(z - cz) <= r)) this.seen.delete(id);
      }
    }
    return out.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  }
  // Asks the threads for the next chunks for players (playQueue), as many as they take at a time; again each time
  // one comes back.
  feedPlayers() {
    let free = this.threads.length * PER_THREAD - this.threads.reduce((s, t) => s + t.pending, 0);
    while (free > 0 && this.playQueue.length) {
      const [x, z] = this.playQueue.shift(), id = pregenPlan.id(x, z);
      if (this.seen.has(id)) continue;
      this.seen.set(id, 2); this.playAsked++;
      let t = this.threads[0];
      for (const u of this.threads) if (u.pending < t.pending) t = u;
      t.pending++; free--;
      t.worker.postMessage({ x, z });
    }
  }
  start(what = 'job') {
    const T = this.game();
    if (!T) return this.fail('the game code hook is not available (config gamePatches is off, or classes.js is another build)', 'unavailable');
    const w = T.world();
    if (!w) return;   // the world is not loaded yet
    if (!w.generate) return this.fail('the world\'s generator is not the default overworld one (a flat or debug world)', 'unavailable');
    const cpu = this.detect(), room = Math.floor(cpu.cores) - 1, n = Math.min(this.wanted, room);
    if (n < 1) return this.fail(`the server has ${cpu.cores} CPU${cpu.cores === 1 ? '' : 's'}${cpu.limitedBy ? ` (${cpu.limitedBy})` : ''}: a terrain thread needs one besides the game's`, 'unavailable');
    // The world's settings as level.dat has them, from the game (a new world may not be saved yet).
    this.dir = w.dir; this.cpu = cpu; this.state = 'starting'; this.runs++; this.startedAt = Date.now();
    const run = this.runs;
    T.level((r) => {
      if (this.state !== 'starting' || this.runs !== run) return;
      if (r.error) return this.fail(`the world's settings could not be read: ${r.error}`);
      for (let i = 0; i < n; i++) {
        const t = { worker: new Worker(this.workerFile, { workerData: { classesJs: this.classesJs, level: r.bytes, longConstants: this.longConstants }, resourceLimits: { maxYoungGenerationSizeMb: YOUNG_MB } }), pending: 0, ready: false, made: 0, heapMb: null };
        t.worker.on('message', (m) => this.onMessage(t, m));
        t.worker.on('error', (e) => { if (this.threads.includes(t)) this.fail(`a terrain thread failed: ${(e && e.message) || e}`); });
        t.worker.on('exit', (c) => { if (this.threads.includes(t)) this.fail(`a terrain thread ended (exit code ${c})`); });
        this.threads.push(t);
      }
      this.log(`terrain threads: starting ${n} for ${what === 'job' ? 'the pre-generation job' : 'the chunks players are about to reach'}${n < this.wanted ? ` (${this.wanted} wanted, ${cpu.cores} CPUs)` : ''}` +
        (this.verify ? '; every chunk is compared with the game\'s own and not used (terrainVerify)' : ''));
    });
  }
  onMessage(t, m) {
    if (!this.threads.includes(t) || m.log) return;
    const T = this.game();
    if (m.ready) {
      t.ready = true; this.seed = m.seed;
      if (this.threads.every((u) => u.ready)) {
        this.initMs = Date.now() - this.startedAt; this.state = 'on';
        T.set({ on: true, verify: this.verify, every: CHECK_EVERY, max: this.forPlayers ? PLAY_KEEP : AHEAD + 16 });
        this.log(`terrain threads: ready after ${(this.initMs / 1000).toFixed(1)} s`);
      }
      return;
    }
    if (m.x === undefined) return this.fail('a terrain thread could not start: ' + m.error);
    t.pending--;
    if (m.error) return this.fail(`a terrain thread could not make chunk ${m.x}, ${m.z}: ${m.error}`);
    this.made++; t.made++; this.ms += m.ms; if (m.ms > this.maxMs) this.maxMs = m.ms;
    T.put(m.x, m.z, m.data, m.bio || null);
    const s = T.status();   // a difference found by the game switches it off ($eaglanTgAt9)
    if (s.error && this.state === 'on') return this.fail(s.error);
    if (this.use === 'players' && this.state === 'on') this.feedPlayers();
  }
  // Asks the threads for the next chunks of the job that are neither asked for already, nor loaded,
  // nor saved (the job would read those).
  feed(st) {
    const T = this.game();
    if (st.startedAt !== this.jobAt) { this.asked.clear(); this.jobAt = st.startedAt; }   // another job: its chunks are asked for anew
    for (const [id, r] of this.asked) if (r < st.ring - 1) this.asked.delete(id);
    let free = this.threads.length * PER_THREAD - this.threads.reduce((s, t) => s + t.pending, 0);
    for (const [x, z, r] of ahead(st, AHEAD)) {
      if (free <= 0) break;
      const id = pregenPlan.id(x, z);
      if (this.asked.has(id)) continue;
      this.asked.set(id, r);
      if (T.loaded(x, z)) { this.loadedAlready++; continue; }
      if (this.store.hasFile(WORLDS_DB, chunkPath(this.dir, x, z))) { this.onDisk++; continue; }
      let t = this.threads[0];
      for (const u of this.threads) if (u.pending < t.pending) t = u;
      t.pending++; free--;
      t.worker.postMessage({ x, z });
    }
  }
  fail(why, state = 'failed') {
    this.error = why;
    this.log(`terrain threads ${state === 'unavailable' ? 'not used' : 'stopped'}: ${why}. The game makes all terrain itself${state === 'failed' ? ' until the world restarts' : ''}.`);
    this.end(); this.state = state;
  }
  stop(why) {
    const s = this.summary();
    this.end(); this.state = 'waiting';
    this.log(`terrain threads ended (${why})${s ? ': ' + s : ''}`);
  }
  end() {
    try { const T = this.game(); if (T) T.set({ on: false }); } catch {}
    for (const t of this.threads) t.worker.terminate().catch(() => {});
    this.threads = []; this.asked.clear(); this.playQueue = [];
    for (const [id, k] of this.seen) if (k === 2) this.seen.delete(id);   // asked for, but what came is gone with the hook's
  }
  summary() {
    let g = null; try { const T = this.game(); g = T ? T.status() : null; } catch {}
    if (!this.made && !(g && g.used)) return '';
    return `${this.made} chunks made (${this.made ? (this.ms / this.made).toFixed(1) : '-'} ms each)` +
      (g ? `, ${g.used} used by the game, ${g.checked} compared (${g.same} the same${g.differ ? `, ${g.differ} DIFFERENT` : ''}), ${g.missed} made by the game itself` : '');
  }
  status() {
    let g = null; try { const T = this.game(); g = T ? T.status() : null; } catch {}
    for (const t of this.threads) t.worker.getHeapStatistics().then((h) => { t.heapMb = Math.round(h.used_heap_size / 1048576); }, () => {});
    return { wanted: this.wanted, verify: this.verify, forPlayers: this.forPlayers, view: this.forPlayers ? this.view : null, use: this.use, playAsked: this.playAsked, playQueue: this.playQueue.length,
      state: this.state, error: this.error, threads: this.threads.length, cpus: this.cpu ? this.cpu.cores : null,
      runs: this.runs, initMs: this.initMs, made: this.made, meanMs: this.made ? Math.round((this.ms / this.made) * 10) / 10 : null, maxMs: Math.round(this.maxMs),
      inFlight: this.threads.reduce((s, t) => s + t.pending, 0), onDisk: this.onDisk, loadedAlready: this.loadedAlready,
      heapMb: this.threads.map((t) => t.heapMb), game: g };
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.end(); }
}

module.exports = { TerrainThreads, chunkPath, ahead, WORLDS_DB };
