'use strict';
// A terrain thread (config terrainThreads, see terrain.js): its own copy of the game code (classes.js,
// with the "terrain threads" correction and the thread's side, game-patches.js) makes the terrain of
// chunks for the pre-generation job and for players, exactly as the game's provideChunk would, up to the structures.
// It never starts the game: the game's entry runs with two arguments, which only sets up the runtime;
// then the world's generator is made from the level.dat it is given (see $eaglanTgWInit).
//   workerData: { classesJs, level (the level.dat bytes), longConstants (speedup 4, as the game has it) }
//   in:  { x, z }                       a chunk, one at a time in order of arrival
//   out: { ready, initMs, seed }        the generator is ready (or { error }: nothing more comes)
//        { x, z, data, bio, ms }        data: the primer (ArrayBuffer of an Int16Array of 65,536), bio: the ids of its
//                                       256 biomes (ArrayBuffer of a Uint8Array), or { x, z, error }
//        { log }                        a line the game code printed

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyTerrainWorkerPatches } = require('./game-patches');

const g = globalThis;
const post = (m, t) => parentPort.postMessage(m, t);
g.self = g;
g.location = { href: 'http://headless-host.invalid/terrain.js', protocol: 'http:', host: 'headless-host.invalid', hostname: 'headless-host.invalid', origin: 'http://headless-host.invalid', search: '', hash: '', pathname: '/terrain.js' };
if (!g.navigator) g.navigator = {};
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.postMessage = () => {};
const line = (a) => a.join(' ');
g.console = { ...console, log: (...a) => post({ log: line(a) }), info: (...a) => post({ log: line(a) }), warn: (...a) => post({ log: '[warn] ' + line(a) }), error: (...a) => post({ log: '[err] ' + line(a) }) };
process.on('uncaughtException', (e) => { post({ error: 'uncaught: ' + ((e && e.stack) || e) }); process.exit(1); });

const t0 = Date.now();
const r = applyTerrainWorkerPatches(fs.readFileSync(workerData.classesJs, 'utf8'), { longConstants: workerData.longConstants === true });
if (r.problems.length) { post({ error: r.problems.join('; ') }); process.exit(1); }
vm.runInThisContext(r.src, { filename: 'classes.js' });
const W = g.__eaglanTgWorker;
const level = workerData.level;

let gen = null, busy = false;
const queue = [];
function next() {
  if (busy || !queue.length) return;
  const { x, z } = queue.shift(), t = process.hrtime.bigint();
  busy = true;
  W.primer(gen, x, z, (res) => {
    busy = false;
    if (res.error) post({ x, z, error: res.error });
    else { const ab = res.data.slice().buffer, bio = res.bio ? res.bio.buffer : null; post({ x, z, data: ab, bio, ms: Number(process.hrtime.bigint() - t) / 1e6 }, bio ? [ab, bio] : [ab]); }
    setImmediate(next);
  });
}
parentPort.on('message', (m) => { queue.push(m); if (gen) next(); });

// The game's entry with two arguments sets up the runtime and prints "???" (not passed on).
g.console.log = (...a) => { const s = line(a); if (s !== '???') post({ log: s }); };
g.main(['_eaglan_terrain_', '_'], () => {
  W.init(new Int8Array(level.buffer, level.byteOffset, level.byteLength), (res) => {
    if (res.error) { post({ error: 'the generator could not be made: ' + res.error }); process.exit(1); }
    gen = res.gen;
    post({ ready: true, initMs: Date.now() - t0, seed: res.seed });
    next();
  });
});
