'use strict';
// Decoration ahead (stage 8, path 4; config decorationAhead for players, decorationAheadPregen for the pre-generation
// job; both off by default): the thread's host side, in the game's worker thread (worker-runtime.js). The game code
// (deco-patch.js) asks it for batches and takes the records back at the end of every tick; the thread
// (deco-worker.js) starts the first time the game asks, once the world's level.dat bytes are there (from the game,
// as the terrain threads get them).
const { Worker } = require('node:worker_threads');
const path = require('node:path');

class DecoAhead {
  constructor({ classesJs, longConstants, log }) {
    this.classesJs = classesJs; this.longConstants = longConstants === true; this.log = log;
    this.worker = null; this.starting = false; this.ready = false; this.failed = null; this.queue = []; this.got = []; this.sent = 0;
  }
  // The thread, set up from the world's level.dat (asked of the game: __eaglanTerrain.level).
  start() {
    if (this.worker || this.starting || this.failed) return;
    const T = globalThis.__eaglanTerrain;
    if (!T || !T.level) { this.failed = 'the terrain threads\' correction is missing'; this.log('decoration ahead: ' + this.failed); return; }
    this.starting = true;
    T.level((r) => {
      this.starting = false;
      if (r.error) { this.failed = r.error; this.log('decoration ahead: no level.dat: ' + r.error); return; }
      this.worker = new Worker(path.join(__dirname, 'deco-worker.js'), { workerData: { classesJs: this.classesJs, level: r.bytes, longConstants: this.longConstants } });
      this.worker.on('message', (m) => {
        if (m.pop || m.done || (m.error && m.id !== undefined)) this.got.push(m);
        else if (m.ready) { this.ready = true; this.log(`decoration ahead: the thread is ready (${m.initMs} ms)`); for (const q of this.queue.splice(0)) this.send(q[0], q[1]); }
        else if (m.log) this.log('decoration ahead thread: ' + m.log);
        else if (m.error) { this.failed = m.error; this.ready = false; this.log('decoration ahead thread failed: ' + m.error + ' (the game decorates every chunk itself from now on)'); }
      });
      this.worker.on('error', (e) => { this.failed = e.message; this.ready = false; this.log('decoration ahead thread failed: ' + e.message); });
      this.worker.on('exit', (c) => { if (this.ready) this.log(`decoration ahead thread ended (${c})`); this.ready = false; });
      this.worker.unref();
    });
  }
  // (asked from inside the game's tick: the level.dat bytes need a game thread of their own, so after it)
  later() { if (this.worker || this.starting || this.failed || this.scheduled) return; this.scheduled = true; setTimeout(() => { this.scheduled = false; this.start(); }, 0); }
  send(m, tr) { try { this.worker.postMessage(m, tr); this.sent++; } catch (e) { this.failed = e.message; this.ready = false; } }
  // for the game code ($eaglanDw.api)
  api() {
    const self = this;
    return {
      ready: () => { if (process.env.EAGLAN_DEBUG_DECO_NOTHREAD) return false; self.later(); return self.ready; },   // (debugging: the correction alone, no thread)
      post: (m, tr) => { if (self.ready) self.send(m, tr); else if (!self.failed) { self.queue.push([m, tr]); self.later(); } },
      take: () => (self.got.length ? self.got.splice(0) : []),
    };
  }
  close() { if (this.worker) this.worker.terminate().catch(() => {}); }
}

module.exports = { DecoAhead };
