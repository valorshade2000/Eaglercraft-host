'use strict';
// The path-ahead thread (config pathAhead, see path-ahead.js): its own copy of the game code (classes.js with only the
// thread's side added: game-patches.js applyPathWorkerPatches), set up but never started. For each job of a tick it
// runs the game's own code on stand-ins whose fields are the job's, over the game's own block arrays (shared memory):
//   type 0, a path step: PathNavigate.pathFollow (Ecw) for a navigator with the job's path, index and length and a mob
//     with its size and water flag at its position; the answer is the path index it leaves
//   type 1, a path search: getPathToEntityLiving's search (EQC after its checks: initProcessor, getPathPointTo,
//     getPathPointToCoords, addToPath, postProcess) by the game's own PathFinder and WalkNodeProcessor (made as
//     getPathFinder EXt makes them, with the job's flags), with a ChunkCache of the job's region; the answer is the
//     path, every field of every point (game-patches.js "path ahead" builds the same PathEntity from it)
// With either, the chunks it read (each chunk stand-in notes every read of its sections). A chunk it was not given
// ends the job: the game then does it itself (and loads the chunk if it has to, as before).
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyPathWorkerPatches } = require('./game-patches');

const g = globalThis;
const post = (m) => parentPort.postMessage(m);
g.self = g;
g.location = { href: 'http://headless-host.invalid/path.js', protocol: 'http:', host: 'headless-host.invalid', hostname: 'headless-host.invalid', origin: 'http://headless-host.invalid', search: '', hash: '', pathname: '/path.js' };
if (!g.navigator) g.navigator = {};
g.addEventListener = () => {}; g.removeEventListener = () => {}; g.postMessage = () => {};
const line = (a) => a.join(' ');
const quiet = (s) => s === '???';   // what the game's entry prints when it only sets the runtime up
g.console = { ...console, log: (...a) => { const s = line(a); if (!quiet(s)) post({ log: s }); }, info: (...a) => { const s = line(a); if (!quiet(s)) post({ log: s }); }, warn: (...a) => post({ log: '[warn] ' + line(a) }), error: (...a) => post({ log: '[err] ' + line(a) }) };
process.on('uncaughtException', (e) => { post({ error: 'uncaught: ' + ((e && e.stack) || e) }); process.exit(1); });

const t0 = Date.now();
const r = applyPathWorkerPatches(fs.readFileSync(workerData.classesJs, 'utf8'), { longConstants: workerData.longConstants === true });
if (r.problems.length) { post({ error: r.problems.join('; ') }); process.exit(1); }
vm.runInThisContext(r.src, { filename: 'classes.js' });
const PW = g.__eaglanPw;
const { JW, RW, PMAX } = workerData;
const jobs = new Float64Array(workerData.jobs), res = new Int32Array(workerData.res), ctl = new Int32Array(workerData.ctl), pout = new Float64Array(workerData.pts);
const tstat = new Float64Array(workerData.stats);   // this thread's time: [busy ms, path steps ms, steps, searches ms, searches]
const now = () => performance.now();

// stand-ins (the fields the game's code reads, by their names in classes.js)
const MISSING = { missing: true };
const chunks = new Map();   // 'w,cx,cz' -> chunk: { xT (getter: notes the read) -> { data: [16 x { R8: { data: Uint16Array } } | null] } }
const paths = new Map();    // id -> { data: [{ qN, r0, rr }] } (PathEntity.bn_: its points x, y, z)
let curW = 0, bx0 = 0, bz0 = 0, bx1 = 0, bz1 = 0;
const touch = (x, z) => { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; };
function chunkStandIn(cx, cz, secs) {
  const xT = { data: secs.map((sab) => (sab ? { R8: { data: new Uint16Array(sab) } } : null)) };
  const c = {};
  Object.defineProperty(c, 'xT', { get() { touch(cx, cz); return xT; } });   // Chunk.getBlockState (ENM) reads its sections here
  return c;
}
const provider = {          // ChunkProviderServer.provideChunk (bk), only for the chunks given
  bk(x, z) { const c = chunks.get(curW + ',' + x + ',' + z); if (c === undefined) throw MISSING; touch(x, z); return c; },
};
const world = { F: provider, dY(pos) { return PW.getBlockState(this, pos); } };            // World: chunkProvider F, getBlockState dY
// path steps: the mob (width ey, height eo, isInWater bj1), its path (length vG, index rk, points bn_), its navigator
const ent = { ey: 0, eo: 0, water: 0, bj1() { return this.water; } };
const pathObj = { vG: 0, rk: 0, bn_: null };
const nav = { lv: pathObj, rS: ent, LU: world, cB_: 1, cga: 0, b1D: 0, bOa: null, AP: 0, A$: 0, vecB: null,
  cS5() { return this.vecB; }, ea3(b, c, d, e, f) { return PW.isDirect(this, b, c, d, e, f); } };
// path searches: the mob (position D J E, box dz, size, its world x, isInWater bj1, getMaxFallHeight dJz), a finder
const box = { cE: 0, b2: 0, cD: 0, cJ: 0, cG: 0, cK: 0 };
const sEnt = { D: 0, J: 0, E: 0, dz: box, ey: 0, eo: 0, x: world, water: 0, fall: 0, bj1() { return this.water; }, dJz() { return this.fall; } };
let finder = null, proc = null;   // made at the first search (the game code is set up by then)
let errors = 0;

function follow(o) {
  const p = paths.get(jobs[o + 1]); if (!p) return [3, 0];
  pathObj.bn_ = p; pathObj.rk = jobs[o + 2]; pathObj.vG = jobs[o + 3];
  nav.vecB = PW.vec(jobs[o + 4], jobs[o + 5], jobs[o + 6]);
  ent.ey = jobs[o + 7]; ent.eo = jobs[o + 8]; nav.cB_ = jobs[o + 9]; ent.water = jobs[o + 10] ? 1 : 0; curW = jobs[o + 11];
  nav.cga = 0; nav.b1D = 0; nav.bOa = null;
  PW.follow(nav);
  return [1, pathObj.rk];
}
let pn = 0;   // where the next path's points go in pout (from 0 each tick)
function search(o) {
  if (finder === null) { finder = PW.newFinder(); proc = finder.a_V; }
  curW = jobs[o + 1];
  sEnt.D = jobs[o + 2]; sEnt.J = jobs[o + 3]; sEnt.E = jobs[o + 4];
  box.cE = jobs[o + 5]; box.b2 = jobs[o + 6]; box.cD = jobs[o + 7]; box.cJ = jobs[o + 8]; box.cG = jobs[o + 9]; box.cK = jobs[o + 10];
  sEnt.ey = jobs[o + 11]; sEnt.eo = jobs[o + 12]; sEnt.water = jobs[o + 13] ? 1 : 0; sEnt.fall = jobs[o + 14];
  const range = jobs[o + 15];
  proc.T3 = jobs[o + 16]; proc.R$ = jobs[o + 17]; proc.xv = jobs[o + 18]; proc.NV = jobs[o + 19];
  // the ChunkCache getPathToEntityLiving makes: round the block above the mob's feet, (range + 16) blocks each way
  const fx = Math.floor(sEnt.D), fz = Math.floor(sEnt.E), c = (range + 16.0) | 0;
  const bez = (fx - c) >> 4, a63 = (fz - c) >> 4, h = (fx + c) >> 4, i2 = (fz + c) >> 4, rows = [];
  for (let x = bez; x <= h; x++) {
    const row = [];
    for (let z = a63; z <= i2; z++) { const ch = chunks.get(curW + ',' + x + ',' + z); if (ch === undefined) throw MISSING; row.push(ch); }
    rows.push({ data: row });
  }
  const cache = { bez, a63, bjr: { data: rows }, dY(p) { return PW.cacheGet(this, p); } };
  finder.bmp.blc = 0;
  PW.initProc(proc, cache, sEnt);
  const start = PW.pointTo(proc, sEnt);
  const end = PW.pointToCoords(proc, sEnt, jobs[o + 20], jobs[o + 21], jobs[o + 22]);
  const path = PW.addToPath(finder, sEnt, start, end, range);
  PW.postProc(proc);
  if (path === null) return [1, 0, pn];
  const pts = path.bn_.data, n = pts.length;
  if (pn + n * 9 > PMAX) return [3, 0, 0];   // no room left this tick
  const at = pn;
  for (let i = 0; i < n; i++) {
    const q = pts[i], k = pn + i * 9;
    pout[k] = q.qN; pout[k + 1] = q.r0; pout[k + 2] = q.rr; pout[k + 3] = q.a4u; pout[k + 4] = q.OO;
    pout[k + 5] = q.cK9; pout[k + 6] = q.duv; pout[k + 7] = q.bAe; pout[k + 8] = q.bUk;
  }
  pn += n * 9;
  return [1, n, at];
}

function run(m) {
  const t0r = now();
  try { runJobs(m); } finally { tstat[0] += now() - t0r; }
}
function runJobs(m) {
  if (m.chunks) for (const [w, cx, cz, secs] of m.chunks) chunks.set(w + ',' + cx + ',' + cz, chunkStandIn(cx, cz, secs));
  if (m.keep) {
    const keep = new Set(), k = m.keep;
    for (let i = 0; i < k.length; i += 3) keep.add(k[i] + ',' + k[i + 1] + ',' + k[i + 2]);
    for (const key of chunks.keys()) if (!keep.has(key)) chunks.delete(key);
  }
  if (m.paths) for (const [id, pts] of m.paths) { const a = []; for (let i = 0; i < pts.length; i += 3) a.push({ qN: pts[i], r0: pts[i + 1], rr: pts[i + 2] }); paths.set(id, { data: a }); }
  const used = new Set(); let complete = true;
  pn = 0;
  for (let j = 0; j < m.n; j++) {
    if (Atomics.load(ctl, 0) !== m.epoch) { complete = false; break; }   // the game has handed out newer jobs: these answers would not be used
    const o = j * JW, type = jobs[o], q = j * RW;
    let out = [3, 0, 0];
    bx0 = bz0 = 1e9; bx1 = bz1 = -1e9;
    if (type === 0) used.add(jobs[o + 1]);
    const tj = now();
    try { out = type === 0 ? follow(o) : search(o); }
    catch (e) { if (e === MISSING) out = [2, 0, 0]; else { out = [3, 0, 0]; if (errors++ < 3) post({ log: `a ${type ? 'search' : 'path step'} failed: ` + ((e && e.stack) || e) }); } }
    const dt = now() - tj; if (type === 0) { tstat[1] += dt; tstat[2]++; } else { tstat[3] += dt; tstat[4]++; }
    res[q + 1] = out[1]; res[q + 2] = bx0; res[q + 3] = bz0; res[q + 4] = bx1; res[q + 5] = bz1; res[q + 6] = out[2] || 0;
    Atomics.store(res, q, m.epoch * 4 + out[0]);
  }
  // the paths of this tick's path steps are kept (the game sends a path again when it was not in the last tick's jobs)
  if (complete) for (const id of paths.keys()) if (!used.has(id)) paths.delete(id);
}

let ready = false;
const queue = [];
parentPort.on('message', (m) => { if (!ready) { queue.push(m); return; } run(m); });
g.main(['_eaglan_path_', '_'], () => {
  PW.init((x) => {
    if (x !== 1) { post({ error: 'the game code could not be set up: ' + ((x && x.message) || x) }); process.exit(1); }
    ready = true; post({ ready: true, initMs: Date.now() - t0 });
    for (const m of queue.splice(0)) run(m);
  });
});
