'use strict';
// Minimal IndexedDB implementation backed by node:sqlite.
//
// It implements exactly the surface EaglercraftX u53's IndexedDBFilesystem uses
// (src/teavm/.../internal/teavm/IndexedDBFilesystem.java): one object store named
// "filesystem" with keyPath "path", and get / put / delete / count / openCursor.
// Every write is committed to disk before its "success" event fires, so world
// data survives a crash or kill of the host process.
//
// Multi-core mode (multicore.js, game-patches.js "multi-core saves"): a chunk file the game hands over
// uncompressed, as [RAW_MAGIC (12 bytes)][length (4 bytes, big-endian)][NBT] followed by the rest of
// its buffer, is gzipped on another core (options.compress) and committed when that is done; its
// "success" fires at once, so the game goes on. Until it is committed, a read, count or listing that
// touches the file waits for it, a newer write or delete of the same file wins over it, and flush()
// waits for all of them (the host calls it before a stop, and before it reports a save as done).
// Such a file is never stored uncompressed: if the other core fails, it is gzipped here.

const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');

const RAW_MAGIC = Uint8Array.from([0, 0x45, 0x41, 0x47, 0x4c, 0x41, 0x4e, 0x52, 0x41, 0x57, 0, 1]);   // "\0EAGLANRAW\0\1"
const RAW_HEADER = RAW_MAGIC.length + 4;

function normKey(k) {
  if (Array.isArray(k)) k = k[0];
  return k == null ? null : String(k);
}

function toArrayBuffer(buf) {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

// The NBT of a file handed over uncompressed, or null for a normal file (a gzip file starts with 1f 8b).
function rawPayload(bytes) {
  if (bytes.length < RAW_HEADER) return null;
  for (let i = 0; i < RAW_MAGIC.length; i++) if (bytes[i] !== RAW_MAGIC[i]) return null;
  const n = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
  if (RAW_HEADER + n > bytes.length) throw new Error(`an uncompressed chunk file claims ${n} bytes but has ${bytes.length - RAW_HEADER}`);
  return bytes.subarray(RAW_HEADER, RAW_HEADER + n);
}

class Req extends EventTarget {
  constructor() { super(); this.result = undefined; this.error = null; this.readyState = 'pending'; }
  _fire(type) {
    this.readyState = 'done';
    const ev = new Event(type);
    if (typeof this['on' + type] === 'function') this['on' + type](ev);
    this.dispatchEvent(ev);
  }
}

function later(fn) { setImmediate(fn); }

// Write diagnostics. Each write is committed (and synced to disk) on the game server's own thread,
// so slow disks stall the game: the worker runtime reports these numbers to the host.
// later*: files compressed on another core (multi-core mode): how many, how many still waiting, and the
// longest time from the game's write to the commit.
const stats = { writes: 0, writeMs: 0, maxWriteMs: 0, pending: 0, maxPending: 0, laterWrites: 0, laterPending: 0, laterMaxPending: 0, laterMaxMs: 0, laterRedone: 0, laterDropped: 0 };
// Requests that wait before they run (a file still being compressed; with regions, a chunk of a cell not yet this
// instance's): the file and since when, for the worker's stall report (worker-runtime.js).
const waiting = new Map();
// Test hook: EAGLAN_DEBUG_SLOW_WRITES_MS=n makes every write take n ms longer (a slow disk).
const SLOW_WRITE_MS = +process.env.EAGLAN_DEBUG_SLOW_WRITES_MS || 0;

// Files waiting for their compression (shared by every database of this file).
class Later {
  constructor(compress, log) {
    this.compress = compress; this.log = log;
    this.pending = new Map();   // key -> the newest waiting write { seq, done }
    this.seq = new Map();       // key -> number of its newest write of any kind, only while one is waiting
  }
  bump(k) { const n = (this.seq.get(k) || 0) + 1; this.seq.set(k, n); return n; }
  // A normal write or a delete: wins over a write of the same file still waiting for its compression.
  supersede(k) { if (this.pending.has(k)) this.bump(k); }
  // Resolves once the newest waiting write of key k (all keys: k undefined) is committed or dropped.
  wait(k) {
    if (k === undefined) return this.pending.size ? Promise.all([...this.pending.values()].map((e) => e.done)).then(() => this.wait()) : null;
    const e = this.pending.get(k); return e ? e.done.then(() => this.wait(k)) : null;
  }
  flush() { return this.wait() || Promise.resolve(); }
}

class Store {
  constructor(db, name) { this._db = db; this.name = name; this.keyPath = 'path'; }
  // wait: a promise to wait for first (a file still being compressed), or null; k: the file (for the stall report).
  _req(fn, write = false, wait = null, k = null) {
    const r = new Req();
    if (write) { stats.pending++; if (stats.pending > stats.maxPending) stats.maxPending = stats.pending; }
    const run = () => {
      const t0 = write ? performance.now() : 0;
      let ok = false;
      try { r.result = fn(); ok = true; if (write && SLOW_WRITE_MS) { const end = performance.now() + SLOW_WRITE_MS; while (performance.now() < end); } }
      catch (e) { r.error = e; this._db._log('IDB error: ' + (e && e.stack || e)); }
      if (write) {
        const ms = performance.now() - t0;
        stats.pending--; stats.writes++; stats.writeMs += ms; if (ms > stats.maxWriteMs) stats.maxWriteMs = ms;
      }
      if (!ok) { r._fire('error'); return; }
      try { r._fire('success'); }
      catch (e) { r.error = e; this._db._log('IDB error: ' + (e && e.stack || e)); r._fire('error'); }
    };
    if (wait) {
      waiting.set(r, { k, t0: Date.now() });
      wait.then(() => { waiting.delete(r); later(run); }, (e) => { waiting.delete(r); this._db._log('IDB error: waiting before ' + k + ' failed: ' + (e && e.stack || e)); later(run); });
    } else later(run);
    return r;
  }
  get(key) {
    const k = normKey(key), gate = this._db._gate, gw = gate ? gate.read(k) : null;
    if (gw) {   // regions: a chunk file, read once this instance has its cell (or the empty chunk: another instance has it)
      let verdict = 'ok'; const lw = this._db._later.wait(k);
      return this._req(() => {
        try {
          if (verdict === 'empty') return { path: k, data: toArrayBuffer(gate.empty(k)) };
          const row = this._db._get.get(this._db.dbName, k);
          return row ? { path: k, data: toArrayBuffer(row.data) } : undefined;
        } finally { gate.end(k); }
      }, false, gw.then((v) => { verdict = v; return lw; }), k);
    }
    return this._req(() => {
      const row = this._db._get.get(this._db.dbName, k);
      if (row && this._db._onRead) this._db._onRead(k, row.data);
      return row ? { path: k, data: toArrayBuffer(row.data) } : undefined;
    }, false, this._db._later.wait(k), k);
  }
  count(key) {
    const k = normKey(key), gate = this._db._gate, gw = k != null && gate ? gate.read(k) : null;
    if (gw) {
      let verdict = 'ok'; const lw = this._db._later.wait(k);
      return this._req(() => { try { return verdict === 'empty' ? 1 : this._db._count.get(this._db.dbName, k).n; } finally { gate.end(k); } }, false, gw.then((v) => { verdict = v; return lw; }), k);
    }
    return this._req(() => (k == null ? this._db._countAll.get(this._db.dbName).n : this._db._count.get(this._db.dbName, k).n),
      false, this._db._later.wait(k == null ? undefined : k), k);
  }
  put(obj) {
    const k = normKey(obj && obj.path);
    const data = obj && obj.data;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(0);
    let raw = null;
    try { raw = rawPayload(bytes); } catch (e) { const r = new Req(); r.error = e; this._db._log('IDB error: ' + e.message); later(() => r._fire('error')); return r; }
    const gate = this._db._gate;
    if (gate && !gate.write(k)) { const r = new Req(); later(() => { r.result = k; r._fire('success'); }); return r; }   // regions: not this instance's file
    if (raw) return this._putLater(k, raw);
    this._db._later.supersede(k);   // a newer write wins over one still being compressed
    return this._req(() => { try { this._db._write(k, bytes); return k; } finally { if (gate) gate.end(k); } }, true);
  }
  // A file handed over uncompressed: "success" at once; gzipped on another core, then committed,
  // unless a newer write or delete of the same file came first.
  _putLater(k, raw) {
    const L = this._db._later, seq = L.bump(k), t0 = performance.now(), copy = Uint8Array.from(raw);
    stats.laterWrites++; stats.laterPending++; if (stats.laterPending > stats.laterMaxPending) stats.laterMaxPending = stats.laterPending;
    const entry = { seq, done: null };
    const gzipHere = () => { stats.laterRedone++; return zlib.gzipSync(copy); };
    const compressed = L.compress ? Promise.resolve().then(() => L.compress(copy)).catch((e) => { L.log(`multi-core save: compressing ${k} on another core failed (${e.message}); compressed here`); return gzipHere(); }) : Promise.resolve().then(gzipHere);
    entry.done = compressed.then((gz) => {
      if (L.seq.get(k) !== seq) { stats.laterDropped++; return; }   // a newer write or delete of this file came first
      const w0 = performance.now();
      this._db._write(k, gz);
      const ms = performance.now() - w0; stats.writes++; stats.writeMs += ms; if (ms > stats.maxWriteMs) stats.maxWriteMs = ms;
    }).catch((e) => { L.log('IDB error: saving ' + k + ' failed: ' + (e && e.stack || e)); }).finally(() => {
      stats.laterPending--; if (this._db._gate) this._db._gate.end(k);
      const total = performance.now() - t0; if (total > stats.laterMaxMs) stats.laterMaxMs = total;
      if (L.pending.get(k) === entry) { L.pending.delete(k); L.seq.delete(k); }   // nothing of this file waits any more
    });
    L.pending.set(k, entry);
    const r = new Req();
    later(() => { r.result = k; r._fire('success'); });
    return r;
  }
  delete(key) {
    const k = normKey(key), gate = this._db._gate;
    if (gate && !gate.write(k)) { const r = new Req(); later(() => { r.result = undefined; r._fire('success'); }); return r; }
    this._db._later.supersede(k);   // wins over a write still being compressed
    return this._req(() => { try { this._db._del.run(this._db.dbName, k); return undefined; } finally { if (gate) gate.end(k); } }, true);
  }
  openCursor() {
    const r = new Req();
    const db = this._db;
    const step = (after) => later(() => {
      try {
        const row = after == null ? db._first.get(db.dbName) : db._next.get(db.dbName, after);
        if (!row) { r.result = null; r._fire('success'); return; }
        const key = row.path;
        r.result = {
          key, primaryKey: key,
          continue: () => step(key),
        };
        r._fire('success');
      } catch (e) { r.error = e; r._fire('error'); }
    });
    const w = db._later.wait();   // a listing sees every file still being compressed
    if (w) w.then(() => step(null)); else step(null);
    return r;
  }
  createIndex() { throw new Error('not supported'); }
}

class Tx extends EventTarget {
  constructor(db, mode) { super(); this.db = db; this.mode = mode; }
  objectStore(name) {
    if (name !== 'filesystem') throw new Error('NotFoundError: object store ' + name);
    return new Store(this.db, name);
  }
}

class DB extends EventTarget {
  constructor(sql, dbName, log, laterWrites, gate, merge, onRead) {
    super();
    this.name = dbName; this.dbName = dbName; this._log = log || (() => {}); this._later = laterWrites; this._gate = gate || null;
    this._sql = sql; this._merge = merge || null; this._onRead = onRead || null;
    this.version = 1;
    this.objectStoreNames = { contains: (n) => n === 'filesystem', length: 1, 0: 'filesystem' };
    this._get = sql.prepare('SELECT data FROM files WHERE db = ? AND path = ?');
    this._count = sql.prepare('SELECT COUNT(*) AS n FROM files WHERE db = ? AND path = ?');
    this._countAll = sql.prepare('SELECT COUNT(*) AS n FROM files WHERE db = ?');
    this._put = sql.prepare('INSERT INTO files(db, path, data) VALUES(?, ?, ?) ON CONFLICT(db, path) DO UPDATE SET data = excluded.data');
    this._del = sql.prepare('DELETE FROM files WHERE db = ? AND path = ?');
    this._first = sql.prepare('SELECT path FROM files WHERE db = ? ORDER BY path LIMIT 1');
    this._next = sql.prepare('SELECT path FROM files WHERE db = ? AND path > ? ORDER BY path LIMIT 1');
  }
  // A file's bytes into the table; with regions, a world data file that several instances write is merged with what is
  // there (region-data.js) in one transaction, against the other instances' writes of it.
  _write(k, bytes) {
    const m = this._merge && this._merge(k);
    if (!m) { this._put.run(this.dbName, k, bytes); return; }
    this._sql.exec('BEGIN IMMEDIATE');
    try { const row = this._get.get(this.dbName, k); this._put.run(this.dbName, k, m(row ? Buffer.from(row.data) : null, Buffer.from(bytes))); this._sql.exec('COMMIT'); }
    catch (e) { try { this._sql.exec('ROLLBACK'); } catch {} throw e; }
  }
  transaction(store, mode) { return new Tx(this, mode || 'readonly'); }
  createObjectStore(name) { if (name !== 'filesystem') throw new Error('unsupported store ' + name); return new Store(this, name); }
  close() {}
}

// diskSync "full" (default): every write is synced to disk before it completes, so nothing is lost
// even on power loss. "normal": no sync per write (WAL mode stays consistent and nothing is lost if the
// process crashes, but the last writes can roll back after a power loss or kernel crash); much less
// time blocked on slow disks.
function openSqlite(file, diskSync = 'full') {
  const sql = new DatabaseSync(file);
  sql.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${diskSync === 'normal' ? 'NORMAL' : 'FULL'}; PRAGMA busy_timeout = 5000;`);
  sql.exec('CREATE TABLE IF NOT EXISTS files (db TEXT NOT NULL, path TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(db, path)) WITHOUT ROWID');
  sql.exec('CREATE TABLE IF NOT EXISTS dbs (db TEXT PRIMARY KEY)');
  return sql;
}

// options.compress(Uint8Array) -> Promise of the gzip file: used for files handed over uncompressed
// (multi-core mode); without it they are gzipped here. options.gate (regions, worker-runtime.js): which chunk
// files this instance may read and write. options.merge(path): null, or how a written file is merged with the stored
// one (regions: world data files several instances write, region-data.js). options.onRead(path, bytes): every file read
// (regions: the maps' baselines, region-data.js MapBaselines).
function createIndexedDB(file, log, diskSync, options = {}) {
  const sql = openSqlite(file, diskSync);
  const hasDb = sql.prepare('SELECT 1 AS x FROM dbs WHERE db = ?');
  const addDb = sql.prepare('INSERT OR IGNORE INTO dbs(db) VALUES(?)');
  const getFile = sql.prepare('SELECT data FROM files WHERE db = ? AND path = ?');
  const fileThere = sql.prepare('SELECT 1 AS x FROM files WHERE db = ? AND path = ?');
  const laterWrites = new Later(options.compress || null, log || (() => {}));
  return {
    _sql: sql,
    _stats: stats,
    // Resolves once every file handed over uncompressed is committed.
    flush: () => laterWrites.flush(),
    // The requests waiting before they run, oldest first: [{ k, ms }] (the worker's stall report).
    waiting: (n = 5) => { const now = Date.now(); return [...waiting.values()].sort((a, b) => a.t0 - b.t0).slice(0, n).map((w) => ({ k: w.k, ms: now - w.t0 })); },
    waitingCount: () => waiting.size,
    setCompress: (fn) => { laterWrites.compress = fn || null; },
    // For the terrain threads (terrain.js), at once: a committed file's bytes, and whether a file is there
    // (one waiting to be committed counts).
    readFile: (db, p) => { const r = getFile.get(String(db), String(p)); return r ? r.data : null; },
    hasFile: (db, p) => laterWrites.pending.has(String(p)) || !!fileThere.get(String(db), String(p)),
    open(name, version) {
      const r = new Req();
      later(() => {
        const db = new DB(sql, String(name), log, laterWrites, options.gate, options.merge, options.onRead);
        r.result = db;
        if (!hasDb.get(String(name))) {
          addDb.run(String(name));
          const ev = new Event('upgradeneeded');
          ev.oldVersion = 0; ev.newVersion = version || 1;
          if (typeof r.onupgradeneeded === 'function') r.onupgradeneeded(ev);
          r.dispatchEvent(ev);
        }
        r._fire('success');
      });
      return r;
    },
    deleteDatabase() { throw new Error('deleteDatabase is disabled in the headless host'); },
    databases: async () => sql.prepare('SELECT db AS name FROM dbs').all().map((r) => ({ name: r.name, version: 1 })),
    cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  };
}

module.exports = { createIndexedDB, openSqlite, RAW_MAGIC, rawPayload };
