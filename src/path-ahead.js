'use strict';
// Path work ahead of time (stage 8, path 3; config pathAhead, off by default). Runs in the game's worker thread.
//
// Each tick, a mob that follows a path checks how far along it can go straight (PathNavigate.pathFollow, Ecw: a walk
// over the blocks between it and the path's next points, PathNavigateGround.isDirectPathBetweenPoints, ETm). That
// depends only on the blocks, the path, the mob's size and where it stands when its AI runs, and a mob stands where it
// ended the last tick (nothing but its own move changes its position). So at the end of each tick the game hands every
// path-following mob's inputs to a thread of its own (path-worker.js, its own copy of the game code), which runs the
// game's own pathFollow on stand-ins while the game does the rest of the tick and the next one's world tick. When the
// mob's AI then calls pathFollow, the game uses the thread's answer only if every input is still the same: the same
// path object, index and length, the same size and water flag, exactly the same position, and every chunk the thread
// read loaded, the one it had, and not changed since (game-patches.js "path ahead"). Otherwise it does it itself.
//
// The blocks are shared, not copied: with pathAhead on, every block array of every chunk section (ExtendedBlockStorage
// R8, a char[] of 4,096) is allocated on a SharedArrayBuffer, so the thread reads the game's own arrays.
//   jobs (Float64Array, JW per job, in the order of the mobs): type 0, a path step: pathId, rk (index), vG (length),
//        x, y, z (getEntityPosition), width, height, heightRequirement, inWater, world; type 1, a path search (see
//        path-worker.js): world, position, box, size, inWater, getMaxFallHeight, range, the node processor flags, target
//   res (Int32Array, RW per job): status (epoch*4 + 1 done / 2 a chunk it did not have / 3 an error), the new index (a
//        step) or the number of points (a search; 0: no path), the chunks it read (cx0, cz0, cx1, cz1), where the points
//        are in pts (Float64Array: 9 numbers a point, every field of the game's PathPoint)
//   ctl (Int32Array): [0] the epoch of the jobs now in the tables
// Messages to the thread: { epoch, n, paths: [[id, Int32Array x,y,z...]], chunks: [[w, cx, cz, [16 SAB|null]]],
// keep: Int32Array of w,cx,cz (the chunks it may keep) }.
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const JW = 24, RW = 8, MAX = 8192, PMAX = 1 << 20;

class PathAhead {
  constructor({ wanted, verify, classesJs, longConstants, log }) {
    this.on = wanted === true; this.verify = verify === true; this.log = log; this.ready = false; this.failed = null;
    if (!this.on) return;
    this.jobsBuf = new SharedArrayBuffer(JW * MAX * 8); this.resBuf = new SharedArrayBuffer(RW * MAX * 4); this.ctlBuf = new SharedArrayBuffer(64); this.ptsBuf = new SharedArrayBuffer(PMAX * 8); this.statsBuf = new SharedArrayBuffer(64);
    this.jobs = new Float64Array(this.jobsBuf); this.res = new Int32Array(this.resBuf); this.ctl = new Int32Array(this.ctlBuf); this.pts = new Float64Array(this.ptsBuf); this.stats = new Float64Array(this.statsBuf);
    this.worker = new Worker(path.join(__dirname, 'path-worker.js'), { workerData: { classesJs, longConstants: longConstants === true, jobs: this.jobsBuf, res: this.resBuf, ctl: this.ctlBuf, pts: this.ptsBuf, stats: this.statsBuf, JW, RW, PMAX } });
    this.worker.on('message', (m) => {
      if (m.ready) { this.ready = true; this.log(`path ahead: the thread is ready (${m.initMs} ms)`); }
      else if (m.log) this.log('path ahead thread: ' + m.log);
      else if (m.error) { this.failed = m.error; this.ready = false; this.log('path ahead thread failed: ' + m.error + ' (the game finds its paths itself from now on)'); }
    });
    this.worker.on('error', (e) => { this.failed = e.message; this.ready = false; this.log('path ahead thread failed: ' + e.message); });
    this.worker.on('exit', (c) => { if (this.ready) this.log(`path ahead thread ended (${c})`); this.ready = false; });
    this.worker.unref();
  }
  // for the game code ($eaglanPa.api)
  api() {
    const self = this;
    return {
      JW, RW, MAX, jobs: this.jobs, res: this.res, ctl: this.ctl, pts: this.pts, stats: this.stats,
      ready: () => self.ready,
      post: (m) => { try { self.worker.postMessage(m); } catch (e) { self.failed = e.message; self.ready = false; } },
    };
  }
  close() { if (this.worker) this.worker.terminate().catch(() => {}); }
}

module.exports = { PathAhead, JW, RW, MAX, PMAX };
