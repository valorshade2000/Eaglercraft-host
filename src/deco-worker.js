'use strict';
// The decoration-ahead thread (config decorationAhead / decorationAheadPregen; deco-ahead.js, deco-patch.js): its own
// copy of the game code (classes.js with the game's corrections, the recording among them, the terrain threads' side
// and its own: game-patches.js applyDecoWorkerPatches). It never starts the game: the game's entry runs with two
// arguments, which only sets up the runtime; then the world and its generator are made from the level.dat it is given.
// For each batch it makes the chunks the game is about to make, runs the decorations their loads will start on copies
// of the chunks around them, and sends each decoration's record as soon as it is made.
//   workerData: { classesJs, level (the level.dat bytes), longConstants }
//   in:  { id, seq, snaps, loaded, unloaded }    a batch (deco-patch.js $eaglanDwPost)
//   out: { ready, initMs } | { error }             set up (or not: nothing more comes)
//        { id, pop } ... { id, done, n, ms }       each decoration's record, then the batch's end ({ id, error } instead)
//        { log }                                   a line the game code printed
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyDecoWorkerPatches } = require('./game-patches');

const g = globalThis;
const post = (m, t) => parentPort.postMessage(m, t);
g.self = g;
g.location = { href: 'http://headless-host.invalid/deco.js', protocol: 'http:', host: 'headless-host.invalid', hostname: 'headless-host.invalid', origin: 'http://headless-host.invalid', search: '', hash: '', pathname: '/deco.js' };
if (!g.navigator) g.navigator = {};
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.postMessage = () => {};
const line = (a) => a.join(' ');
g.console = { ...console, log: (...a) => post({ log: line(a) }), info: (...a) => post({ log: line(a) }), warn: (...a) => post({ log: '[warn] ' + line(a) }), error: (...a) => post({ log: '[err] ' + line(a) }) };
process.on('uncaughtException', (e) => { post({ error: 'uncaught: ' + ((e && e.stack) || e) }); process.exit(1); });

const t0 = Date.now();
const r = applyDecoWorkerPatches(fs.readFileSync(workerData.classesJs, 'utf8'), { longConstants: workerData.longConstants === true });
const bad = r.problems.filter((p) => /decoration|terrain threads/.test(p));
if (bad.length) { post({ error: bad.join('; ') }); process.exit(1); }
vm.runInThisContext(r.src, { filename: 'classes.js' });
const W = g.__eaglanDwWorker;
if (process.env.EAGLAN_DEBUG_DECO) g.__eaglanDwDebug = Number(process.env.EAGLAN_DEBUG_DECO) || 5;   // (debugging: the first n chunks it was not given)

let ready = false, busy = false;
const queue = [];
function next() {
  if (!ready || busy || !queue.length) return;
  const batch = queue.shift(), t = Date.now();
  busy = true;
  W.run(batch, (pop) => post({ id: batch.id, pop }, [pop.ops.buffer]), (res) => {   // (the writes as an Int32Array, moved, not copied)
    busy = false;
    if (res.error) post({ id: batch.id, error: res.error });
    else post({ id: batch.id, done: true, n: res.n, ms: Date.now() - t });
    setImmediate(next);
  });
}
parentPort.on('message', (m) => { queue.push(m); next(); });

g.console.log = (...a) => { const s = line(a); if (s !== '???') post({ log: s }); };
g.main(['_eaglan_deco_', '_'], () => {
  const level = workerData.level;
  W.init(new Int8Array(level.buffer, level.byteOffset, level.byteLength), (res) => {
    if (res.error) { post({ error: 'the world could not be set up: ' + res.error }); process.exit(1); }
    ready = true;
    post({ ready: true, initMs: Date.now() - t0 });
    next();
  });
});
