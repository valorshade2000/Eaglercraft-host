'use strict';
// The multi-core mode's pool of worker threads (config multiCore, see multicore.js). Each job is a
// pure function of the bytes it is given (compute-worker.js), so it can run on another core at the
// same time as the game thread. Results come back in any order; the caller puts them in order.
//
// Failures never lose a job: the input stays here until the job is done, so when a thread dies its
// jobs are rejected with { lost: true } and the caller runs them itself. A dead thread is replaced;
// after `maxFailures` deaths within a minute the pool gives up (failed) and rejects everything.

const { Worker } = require('node:worker_threads');
const path = require('node:path');

class ComputePool {
  constructor({ size, log = () => {}, debug = false, maxFailures = 3 }) {
    this.size = size; this.log = log; this.debug = debug; this.maxFailures = maxFailures;
    this.slots = []; this.jobs = new Map(); this.seq = 0; this.rr = 0;
    this.failed = null; this.closed = false; this.deaths = [];
    this.stats = { jobs: 0, done: 0, lost: 0, inBytes: 0, outBytes: 0, maxPending: 0, restarts: 0 };
  }

  start() { for (let i = 0; i < this.size; i++) this._spawn(i); return this; }

  _spawn(i) {
    const w = new Worker(path.join(__dirname, 'compute-worker.js'), { workerData: { index: i, debug: this.debug } });
    const slot = { w, i, alive: true, pending: new Set(), jobs: 0, elu: null };
    w.on('message', (m) => this._done(slot, m));
    w.on('error', (e) => this._lost(slot, e && e.message ? e.message : String(e)));
    w.on('exit', (code) => this._lost(slot, `exited with code ${code}`));
    w.unref();
    this.slots[i] = slot;
  }

  pending() { return this.jobs.size; }

  // op: 'deflate'; data: ArrayBuffer or typed array (copied to the thread, so the caller keeps it).
  run(op, data, opts) {
    if (this.closed) return Promise.reject(Object.assign(new Error('the pool is closed'), { lost: true }));
    if (this.failed) return Promise.reject(Object.assign(new Error(this.failed), { lost: true }));
    const live = this.slots.filter((s) => s && s.alive);
    if (!live.length) return Promise.reject(Object.assign(new Error('no pool thread is running'), { lost: true }));
    // The thread with the fewest jobs in progress; round-robin among equals.
    let best = null;
    for (let k = 0; k < live.length; k++) { const s = live[(this.rr + k) % live.length]; if (!best || s.pending.size < best.pending.size) best = s; }
    this.rr = (this.rr + 1) % live.length;
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.jobs.set(id, { resolve, reject, slot: best, bytes: data.byteLength }));
    best.pending.add(id); best.jobs++;
    this.stats.jobs++; this.stats.inBytes += data.byteLength;
    if (this.jobs.size > this.stats.maxPending) this.stats.maxPending = this.jobs.size;
    best.w.postMessage({ id, op, data, opts });
    return p;
  }

  _done(slot, m) {
    const j = this.jobs.get(m.id); if (!j) return;
    this.jobs.delete(m.id); slot.pending.delete(m.id);
    if (m.error) { j.reject(new Error(m.error)); return; }
    this.stats.done++; this.stats.outBytes += m.data.byteLength;
    j.resolve(m.data);
  }

  _lost(slot, why) {
    if (!slot.alive) return;
    slot.alive = false;
    for (const id of slot.pending) { const j = this.jobs.get(id); if (j) { this.jobs.delete(id); this.stats.lost++; j.reject(Object.assign(new Error(`pool thread ${slot.i + 1} ${why}`), { lost: true })); } }
    slot.pending.clear();
    if (this.closed) return;
    const now = Date.now(); this.deaths = this.deaths.filter((t) => now - t < 60000); this.deaths.push(now);
    if (this.deaths.length >= this.maxFailures) {
      this.failed = `${this.deaths.length} pool threads failed within a minute (last: thread ${slot.i + 1} ${why})`;
      this.log(`multi-core pool: ${this.failed}; giving up`);
      return;
    }
    this.log(`multi-core pool: thread ${slot.i + 1} ${why}; its jobs are done another way; starting a new thread`);
    this.stats.restarts++; this._spawn(slot.i);
  }

  // Busy share of each thread (event-loop utilization) since the last call, and job counts.
  threadStats() {
    return this.slots.filter(Boolean).map((s) => {
      let busy = null, activeMs = s.activeMs || 0;
      try {
        const now = s.w.performance.eventLoopUtilization();
        busy = s.elu ? Math.round(s.w.performance.eventLoopUtilization(now, s.elu).utilization * 1000) / 10 : null;
        s.elu = now; activeMs = s.activeMs = now.active;
      } catch {}
      return { thread: s.i + 1, alive: s.alive, jobs: s.jobs, pending: s.pending.size, busyPct: busy, activeMs: Math.round(activeMs) };
    });
  }

  // Waits up to `ms` for the jobs in progress, then stops the threads.
  async close(ms = 5000) {
    if (this.closed) return; this.closed = true;
    const t0 = Date.now();
    while (this.jobs.size && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    for (const s of this.slots) if (s) { s.alive = false; try { await s.w.terminate(); } catch {} }
    for (const [id, j] of this.jobs) { this.jobs.delete(id); j.reject(Object.assign(new Error('the pool was closed'), { lost: true })); }
  }
}

module.exports = { ComputePool };
