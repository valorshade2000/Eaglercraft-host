'use strict';
// Multi-core mode (config multiCore, the web page's Multi-core switch).
//
// The game itself stays on its one thread: its simulation (ticks, entities, block updates, world
// generation, lighting) depends on the order things happen in, and the compiled game has no locks.
// What moves to other cores is work that does not touch the world:
//   - compressing large network packets (over 1 KB: chunk data, entity lists). The game thread
//     hands the packet over uncompressed (a hook in game-patches.js, "multi-core packets") and goes
//     on with its tick; a pool thread compresses it with zlib, using the game's own settings, and
//     the packet is framed as the game frames it ([2][length][zlib], parts of at most 65,279 bytes).
//   - gzipping chunk files when they are saved: the game writes the NBT uncompressed and goes on; the
//     storage layer (idb-sqlite.js) has it gzipped by the pool and commits it then. A read of that
//     file waits for it, and the host waits for all of them before a stop or a reported save.
// Every player's packets leave in exactly the order the game sent them: a packet that waits for its
// compression holds back everything sent after it to that player, compressed or not. The pool
// size comes from the CPUs this process may use (cpu.js). When the pool fails, the waiting
// packets are compressed here and the mode switches itself off (the game compresses again).

const zlib = require('node:zlib');
const { ComputePool } = require('./compute-pool');
const { availableCpus, poolSize } = require('./cpu');

const FRAGMENT = 65279;          // bytes of a large packet per network message, as the game sends them
const MAX_WAITING = 512;         // compressions in progress beyond which packets are compressed here

// The game's frames for a compressed packet: one [2][length][zlib] message, or, above 65,280 bytes,
// its bytes after the type in parts of 65,279, each with type 1 (more follows) or 2 (last).
function frames(rawLength, z) {
  const total = 5 + z.length;
  const one = new Uint8Array(total);
  one[0] = 2; one[1] = rawLength >>> 24; one[2] = (rawLength >>> 16) & 255; one[3] = (rawLength >>> 8) & 255; one[4] = rawLength & 255;
  one.set(z, 5);
  if (total <= FRAGMENT + 1) return [one.buffer];
  const out = [];
  for (let i = 1; i < total; i += FRAGMENT) {
    const j = Math.min(i + FRAGMENT, total);
    const part = new Uint8Array(j - i + 1);
    part[0] = j >= total ? 2 : 1; part.set(one.subarray(i, j), 1);
    out.push(part.buffer);
  }
  return out;
}

const deflateHere = (data) => zlib.deflateSync(Buffer.from(data), { level: 5, windowBits: 15, memLevel: 8, strategy: 0 });

class MultiCore {
  // deliver(channel, ArrayBuffer): sends one message to a player (false: the channel is closed).
  // setGame(on): switches the game's hook. log(line).
  constructor({ deliver, setGame, log, workers = null, debug = false, detect = availableCpus }) {
    this.deliver = deliver; this.setGame = setGame; this.log = log;
    this.workers = workers; this.debug = debug; this.detect = detect;
    this.pool = null; this.queues = new Map(); this.waiting = 0;
    this.state = { wanted: false, on: false, status: 'off', error: null, cpu: null, threads: 0 };
    this.stats = { packets: 0, rawBytes: 0, zBytes: 0, inline: 0, redone: 0, maxWaiting: 0, maxDelayMs: 0 };
  }

  // Switches the mode on: checks the CPUs, starts the pool, then the game's hook.
  enable() {
    this.state.wanted = true;
    if (this.state.on) return this.state;
    const cpu = this.detect(); this.state.cpu = cpu;
    const n = poolSize(cpu, { wanted: this.workers });
    if (n < 1) {
      Object.assign(this.state, { on: false, status: 'unavailable', threads: 0,
        error: `only ${Math.round(cpu.cores * 100) / 100} CPU${cpu.cores === 1 ? ' is' : 's are'} available to this process${cpu.limitedBy ? ' (' + cpu.limitedBy + ')' : ''}: the game thread needs one and the pool at least one more` });
      this.log(`multi-core mode not started: ${this.state.error}; the game runs single-threaded as before`);
      return this.state;
    }
    try {
      this.pool = new ComputePool({ size: n, log: this.log, debug: this.debug }).start();
    } catch (e) {
      Object.assign(this.state, { on: false, status: 'failed', error: 'the pool threads could not be started: ' + e.message, threads: 0 });
      this.log(`multi-core mode not started: ${this.state.error}; the game runs single-threaded as before`);
      return this.state;
    }
    Object.assign(this.state, { on: true, status: 'on', error: null, threads: n });
    this.setGame(true);
    this.log(`multi-core mode on: ${n} pool thread${n === 1 ? '' : 's'} compress the large network packets (${this._cpuText(cpu)})`);
    return this.state;
  }

  // Switches it off: the game compresses again at once; packets already handed over are finished.
  async disable(why = null) {
    this.state.wanted = why ? this.state.wanted : false;
    const pool = this.pool;
    this.setGame(false);
    Object.assign(this.state, { on: false, status: why ? 'failed' : 'off', error: why, threads: 0 });
    if (pool) { await pool.close(); if (this.pool === pool) this.pool = null; }
    if (why) this.log(`multi-core mode switched off: ${why}; the game runs single-threaded as before`);
    else this.log('multi-core mode off: the game runs single-threaded as before');
    return this.state;
  }

  _cpuText(c) {
    return `${c.cores === Infinity ? '?' : Math.round(c.cores * 100) / 100} CPU${c.cores === 1 ? '' : 's'} available to this process` +
      `${c.limitedBy ? ', limited by ' + c.limitedBy : ''}; one stays with the game thread`;
  }

  // A message from the game for a player's channel. z: the game handed over an uncompressed packet.
  // nothing of this player's waiting for compression: a packed batch may go on whole (daemon.js)
  idle(ch) { const q = this.queues.get(ch); return !q || !q.length; }

  fromGame(ch, data, z) {
    if (!z) {
      const q = this.queues.get(ch);
      if (q) q.push({ ready: true, frames: [data] }); else this.deliver(ch, data);
      return;
    }
    const item = { ready: false, frames: null, at: Date.now() };
    let q = this.queues.get(ch); if (!q) { q = []; this.queues.set(ch, q); }
    q.push(item);
    const n = data.byteLength;
    this.stats.packets++; this.stats.rawBytes += n;
    const finish = (zbuf) => {
      this.stats.zBytes += zbuf.length;
      item.frames = frames(n, zbuf); item.ready = true;
      const d = Date.now() - item.at; if (d > this.stats.maxDelayMs) this.stats.maxDelayMs = d;
      this._flush(ch);
    };
    const pool = this.pool;
    if (!pool || pool.failed || this.waiting >= MAX_WAITING) { this.stats.inline++; finish(deflateHere(data)); return; }
    this.waiting++; if (this.waiting > this.stats.maxWaiting) this.stats.maxWaiting = this.waiting;
    pool.run('deflate', data, { level: 5 }).then((ab) => { this.waiting--; finish(new Uint8Array(ab)); }, (e) => {
      this.waiting--; this.stats.redone++;
      finish(deflateHere(data));   // the job is never lost: compressed here instead
      if (pool.failed && this.state.on) this.disable(pool.failed).catch(() => {});
      else if (!e.lost) this.log('multi-core pool: a compression failed (' + e.message + '); it was done on the main thread');
    });
  }

  _flush(ch) {
    const q = this.queues.get(ch); if (!q) return;
    while (q.length && q[0].ready) for (const f of q.shift().frames) this.deliver(ch, f);
    if (!q.length) this.queues.delete(ch);
  }

  // A job for the game thread (multi-core saves: gzip of a chunk file). Rejects when the pool is not
  // running; the game thread then does it itself.
  jobForGame(op, data) {
    const pool = this.pool;
    if (!pool || pool.failed || !this.state.on) return Promise.reject(new Error('the multi-core mode is off'));
    this.stats.saves = (this.stats.saves || 0) + 1; this.stats.saveBytes = (this.stats.saveBytes || 0) + data.byteLength;
    return pool.run(op, data).catch((e) => {
      if (pool.failed && this.state.on) this.disable(pool.failed).catch(() => {});
      throw e;
    });
  }

  // Packets waiting for their compression (all players).
  pendingPackets() { let n = 0; for (const q of this.queues.values()) n += q.filter((x) => !x.ready).length; return n; }

  // How busy each pool thread was since the last call (the host calls it every 5 s); their sum in %
  // of one core.
  sample() {
    this.threads = this.pool ? this.pool.threadStats() : [];
    // Busy time of all pool threads so far (threads of earlier pools included): CPU averages over any window.
    const now = this.threads.reduce((a, t) => a + (t.activeMs || 0), 0);
    if (this.pool !== this._sampledPool) { this._activeBase = (this._activeBase || 0) + (this._lastActive || 0); this._sampledPool = this.pool; }
    this._lastActive = now;
    return this.threads.reduce((a, t) => a + (t.busyPct || 0), 0);
  }

  status() {
    return {
      ...this.state,
      threadsBusy: this.threads || [], poolActiveMs: Math.round((this._activeBase || 0) + (this._lastActive || 0)),
      saves: this.stats.saves || 0, savesMb: Math.round((this.stats.saveBytes || 0) / 104857.6) / 10,
      packets: this.stats.packets, rawMb: Math.round(this.stats.rawBytes / 104857.6) / 10, compressedMb: Math.round(this.stats.zBytes / 104857.6) / 10,
      compressedHere: this.stats.inline, redone: this.stats.redone, maxWaiting: this.stats.maxWaiting, maxDelayMs: this.stats.maxDelayMs,
      pool: this.pool ? { ...this.pool.stats, pending: this.pool.pending() } : null,
    };
  }

  async close() { if (this.pool) { const p = this.pool; this.pool = null; await p.close(); } }
}

module.exports = { MultiCore, frames, FRAGMENT };
