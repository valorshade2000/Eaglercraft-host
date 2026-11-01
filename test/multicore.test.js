'use strict';
// Multi-core mode (src/multicore.js, compute-pool.js, cpu.js, idb-sqlite.js "later" writes), without
// the game: the frames a player gets, the order of every player's packets, the CPU detection, the pool
// and its fallback, and the storage rules for chunk files compressed on another core.
//   node --test test/multicore.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { frames, FRAGMENT, MultiCore } = require('../src/multicore');
const { ComputePool } = require('../src/compute-pool');
const { availableCpus, cgroupQuota, poolSize } = require('../src/cpu');
const { createIndexedDB, RAW_MAGIC } = require('../src/idb-sqlite');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(5); } return fn(); }

// What the u53 client does with a player's messages (as test/bench/bot.js): type 0 is a whole packet;
// 1 is part of a large one, 2 its last part; a large packet is [4-byte length][zlib].
function unframe(msgs) {
  const out = []; let parts = [];
  for (const ab of msgs) {
    const b = Buffer.from(ab);
    if (b[0] === 0) { out.push(b.subarray(1)); continue; }
    parts.push(b.subarray(1));
    if (b[0] === 2) { const all = Buffer.concat(parts); parts = []; const n = all.readUInt32BE(0); const p = zlib.inflateSync(all.subarray(4)); assert.equal(p.length, n, 'length field'); out.push(p); }
  }
  assert.equal(parts.length, 0, 'no unfinished packet');
  return out;
}
const packet = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = (x >>> 24) & (i % 7 ? 255 : 3); } return b; };

test('frames: one message up to 65,280 bytes, then parts of 65,279 bytes; the client gets the packet back', () => {
  const p = packet(3000, 1), z = zlib.deflateSync(p, { level: 5 });
  const one = frames(p.length, z);
  assert.equal(one.length, 1);
  assert.equal(Buffer.from(one[0])[0], 2);
  assert.deepEqual(unframe(one)[0], p);
  // Around the limits, including a compressed size whose parts come out exactly even (the game's own
  // code drops the last part then; these frames must not). Stored (level 0) zlib streams give exact sizes.
  const zOfLength = (target) => {
    let s = target - 16;
    for (let k = 0; k < 30; k++) { const raw = packet(s, 5), z = zlib.deflateSync(raw, { level: 0 }); if (z.length === target) return { raw, z }; s += target - z.length; }
    throw new Error('no input gives ' + target);
  };
  for (const zlen of [FRAGMENT - 4, FRAGMENT - 3, FRAGMENT * 2 - 4, FRAGMENT * 2 - 3, FRAGMENT * 3 + 77]) {
    const { raw, z } = zOfLength(zlen);
    const fr = frames(raw.length, z);
    const total = 5 + z.length;
    assert.equal(fr.length, total <= FRAGMENT + 1 ? 1 : Math.ceil((total - 1) / FRAGMENT), `parts for ${zlen}`);
    if (fr.length > 1) assert.ok(fr.slice(0, -1).every((f) => Buffer.from(f)[0] === 1 && f.byteLength === FRAGMENT + 1));
    assert.equal(Buffer.from(fr[fr.length - 1])[0], 2);
    assert.deepEqual(unframe(fr)[0], raw);
  }
});

test('cpu: the smallest cgroup quota on the way to the root; v1 and v2; no limit', () => {
  const files = {
    '/proc/self/cgroup': '0::/system.slice/eaglan.service\n',
    '/sys/fs/cgroup/system.slice/eaglan.service/cpu.max': '150000 100000\n',
    '/sys/fs/cgroup/system.slice/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/cpu.max': '400000 100000\n',
  };
  const read = (f) => (f in files ? files[f] : null);
  assert.equal(cgroupQuota({ read }).cores, 1.5);
  const c = availableCpus({ read, cpus: new Array(8).fill({}), affinity: 8 });
  assert.equal(c.cores, 1.5); assert.match(c.limitedBy, /CPU quota 1\.5/);
  assert.equal(poolSize(c), 0, 'one and a half CPUs: nothing left for a pool');
  // v1
  const v1 = { '/proc/self/cgroup': '4:cpu,cpuacct:/docker/abc\n3:memory:/docker/abc\n', '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us': '300000', '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_period_us': '100000' };
  assert.equal(cgroupQuota({ read: (f) => v1[f] ?? null }).cores, 3);
  // no limit anywhere
  const none = { '/proc/self/cgroup': '0::/user.slice\n', '/sys/fs/cgroup/user.slice/cpu.max': 'max 100000', '/sys/fs/cgroup/cpu.max': 'max 100000' };
  assert.equal(cgroupQuota({ read: (f) => none[f] ?? null }), null);
  // pool sizes: one CPU stays with the game thread; at most 2 unless asked for another number
  assert.equal(poolSize({ cores: 1 }), 0);
  assert.equal(poolSize({ cores: 2 }), 1);
  assert.equal(poolSize({ cores: 3.9 }), 2);
  assert.equal(poolSize({ cores: 12 }), 2);
  assert.equal(poolSize({ cores: 12 }, { wanted: 1 }), 1);
  assert.equal(poolSize({ cores: 12 }, { wanted: 4 }), 4);
  assert.equal(poolSize({ cores: 3 }, { wanted: 8 }), 2, 'never more than the CPUs allow');
  assert.ok(availableCpus().cores >= 1, 'this machine');
});

test('pool: jobs run on the threads; a dead thread\'s jobs come back as lost and the thread is replaced; too many deaths: failed', async () => {
  const logs = [];
  const pool = new ComputePool({ size: 2, log: (m) => logs.push(m), debug: true }).start();
  try {
    const p = packet(50000, 7);
    const outs = await Promise.all([1, 2, 3, 4].map(() => pool.run('deflate', p, { level: 5 })));
    for (const o of outs) assert.deepEqual(zlib.inflateSync(Buffer.from(o)), p);
    const gz = await pool.run('gzip', p);
    assert.deepEqual(zlib.gunzipSync(Buffer.from(gz)), p);
    // a thread dies: its job is rejected with lost, and a new thread takes its place
    await assert.rejects(pool.run('crash', p), (e) => e.lost === true);
    await waitFor(() => pool.stats.restarts === 1);
    assert.deepEqual(zlib.inflateSync(Buffer.from(await pool.run('deflate', p))), p, 'still works');
    await assert.rejects(pool.run('crash', p), (e) => e.lost === true);
    await assert.rejects(pool.run('crash', p), (e) => e.lost === true);
    assert.match(pool.failed || '', /3 pool threads failed within a minute/);
    await assert.rejects(pool.run('deflate', p), (e) => e.lost === true);
    assert.ok(logs.some((l) => /giving up/.test(l)));
  } finally { await pool.close(); }
});

// MultiCore with a stand-in pool whose jobs finish in an order the test chooses.
function fakeMultiCore() {
  const sent = new Map(), log = [];
  const mc = new MultiCore({ deliver: (ch, b) => { if (!sent.has(ch)) sent.set(ch, []); sent.get(ch).push(b); }, setGame: () => {}, log: (m) => log.push(m), detect: () => ({ cores: 4, limitedBy: null }) });
  const jobs = [];
  mc.pool = { failed: null, run: (op, data) => new Promise((resolve, reject) => jobs.push({ op, data, resolve, reject })), threadStats: () => [], pending: () => jobs.length, stats: {}, close: async () => {} };
  mc.state.on = true;
  // as the pool thread does: an ArrayBuffer of exactly the compressed bytes
  const finish = (j) => { const z = zlib.deflateSync(Buffer.from(j.data), { level: 5 }); j.resolve(z.buffer.slice(z.byteOffset, z.byteOffset + z.length)); };
  return { mc, sent, jobs, finish, log };
}

test('order: every player\'s messages leave in the order the game sent them, whatever order the compressions finish in', async () => {
  const { mc, sent, jobs, finish } = fakeMultiCore();
  const small = (s) => { const b = Buffer.alloc(10, s); b[0] = 0; return b.buffer.slice(0); };
  const big = (n, s) => packet(n, s);
  const expect = { a: [], b: [] };
  // a: small, big1, small, big2, small; b: big3 interleaved
  const seq = [['a', 'small', 1], ['a', 'big', 2], ['b', 'big', 3], ['a', 'small', 4], ['a', 'big', 5], ['b', 'small', 6], ['a', 'small', 7]];
  for (const [ch, kind, s] of seq) {
    if (kind === 'small') { const m = small(s); expect[ch].push(Buffer.from(m).subarray(1)); mc.fromGame(ch, m, false); }
    else { const p = big(5000 + s, s); expect[ch].push(p); mc.fromGame(ch, p.buffer.slice(p.byteOffset, p.byteOffset + p.length), true); }
  }
  assert.equal((sent.get('a') || []).length, 1, 'a: only the first small one before the first big one is ready');
  assert.equal(sent.get('b'), undefined);
  // finish in reverse order
  for (const j of jobs.slice().reverse()) { finish(j); await sleep(1); }
  await waitFor(() => (sent.get('a') || []).length === 5 && (sent.get('b') || []).length === 2);
  assert.deepEqual(unframe(sent.get('a')), expect.a);
  assert.deepEqual(unframe(sent.get('b')), expect.b);
  assert.equal(mc.queues.size, 0, 'nothing left waiting');
});

test('order: a job that fails is compressed on the main thread; nothing is lost; a failed pool switches the mode off', async () => {
  const { mc, sent, jobs, log } = fakeMultiCore();
  let gameOn = true; mc.setGame = (on) => { gameOn = on; };
  const p1 = packet(4000, 11), p2 = packet(4000, 12);
  mc.fromGame('c', p1.buffer.slice(p1.byteOffset, p1.byteOffset + p1.length), true);
  mc.fromGame('c', p2.buffer.slice(p2.byteOffset, p2.byteOffset + p2.length), true);
  mc.pool.failed = 'test: pool gone';
  jobs[0].reject(Object.assign(new Error('lost'), { lost: true }));
  jobs[1].reject(Object.assign(new Error('lost'), { lost: true }));
  await waitFor(() => (sent.get('c') || []).length === 2);
  assert.deepEqual(unframe(sent.get('c')), [p1, p2]);
  await waitFor(() => mc.state.status === 'failed');
  assert.equal(gameOn, false, 'the game compresses again');
  assert.match(mc.state.error, /pool gone/);
  assert.ok(log.some((l) => /switched off: test: pool gone/.test(l)));
  assert.equal(mc.stats.redone, 2);
});

test('multi-core mode: not started when the CPUs leave nothing for a pool; the reason is given', () => {
  const mc = new MultiCore({ deliver: () => {}, setGame: () => assert.fail('the game must not be switched'), log: () => {}, detect: () => ({ cores: 1.5, limitedBy: 'CPU quota 1.5 (/sys/fs/cgroup/x/cpu.max)' }) });
  const st = mc.enable();
  assert.equal(st.on, false); assert.equal(st.status, 'unavailable');
  assert.match(st.error, /only 1\.5 CPUs are available to this process \(CPU quota 1\.5/);
});

// ---------------------------------------------------------------- storage: files compressed elsewhere
function rawFile(nbt, junk = 300) {
  const b = new Uint8Array(16 + nbt.length + junk);
  b.set(RAW_MAGIC, 0); b[12] = nbt.length >>> 24; b[13] = nbt.length >>> 16; b[14] = nbt.length >>> 8; b[15] = nbt.length;
  b.set(nbt, 16); b.fill(0xee, 16 + nbt.length);
  return b.buffer;
}
function openDb(compress) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-mc-'));
  const idb = createIndexedDB(path.join(dir, 'w.sqlite'), () => {}, 'normal', { compress });
  return new Promise((resolve) => { const r = idb.open('worlds'); r.onsuccess = () => resolve({ idb, db: r.result, dir }); });
}
const req = (r) => new Promise((resolve, reject) => { r.addEventListener('success', () => resolve(r.result)); r.addEventListener('error', () => reject(r.error)); });
const store = (db, mode) => db.transaction('filesystem', mode).objectStore('filesystem');

test('storage: a file handed over uncompressed is stored gzipped (never raw); a read waits for it; flush waits for all', async () => {
  const gate = []; const compress = (raw) => new Promise((resolve) => gate.push(() => resolve(zlib.gzipSync(raw))));
  const { idb, db, dir } = await openDb(compress);
  try {
    const nbt = packet(20000, 21);
    const t0 = Date.now();
    await req(store(db, 'readwrite').put({ path: 'w/level0/A.dat', data: rawFile(nbt) }));
    assert.ok(Date.now() - t0 < 1000, 'success at once, before the compression');
    let got = null; req(store(db).get(['w/level0/A.dat'])).then((r) => { got = r; });
    let n = null; req(store(db).count(['w/level0/A.dat'])).then((r) => { n = r; });
    let flushed = false; idb.flush().then(() => { flushed = true; });
    await sleep(50);
    assert.equal(got, null, 'the read waits'); assert.equal(n, null); assert.equal(flushed, false);
    gate.shift()();
    await waitFor(() => got && n !== null && flushed);
    const stored = Buffer.from(got.data);
    assert.equal(stored[0], 0x1f); assert.equal(stored[1], 0x8b, 'gzip');
    assert.deepEqual(zlib.gunzipSync(stored), nbt, 'exactly the NBT: the header and the rest of the buffer are gone');
    assert.equal(n, 1);
    // what is on disk
    const row = idb._sql.prepare('SELECT data FROM files WHERE path = ?').get('w/level0/A.dat');
    assert.deepEqual(zlib.gunzipSync(Buffer.from(row.data)), nbt);
  } finally { try { idb._sql.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage: the newest write of a file wins, whatever order the compressions finish in; a delete wins too', async () => {
  const gate = []; const compress = (raw) => new Promise((resolve) => gate.push(() => resolve(zlib.gzipSync(raw))));
  const { idb, db, dir } = await openDb(compress);
  try {
    const v1 = packet(5000, 1), v2 = packet(5000, 2), v3 = packet(5000, 3);
    await req(store(db, 'readwrite').put({ path: 'k', data: rawFile(v1) }));
    await req(store(db, 'readwrite').put({ path: 'k', data: rawFile(v2) }));
    gate[1](); await sleep(20);   // the newer one is committed first ...
    assert.deepEqual(zlib.gunzipSync(Buffer.from(idb._sql.prepare('SELECT data FROM files WHERE path = ?').get('k').data)), v2);
    gate[0]();                    // ... and the older one, finishing last, must not overwrite it
    await idb.flush();
    assert.deepEqual(zlib.gunzipSync(Buffer.from((await req(store(db).get(['k']))).data)), v2);
    assert.equal(idb._stats.laterDropped >= 1, true);
    // a normal (gzip) write after a waiting one wins
    await req(store(db, 'readwrite').put({ path: 'k', data: rawFile(v3) }));
    const plain = zlib.gzipSync(v1);
    await req(store(db, 'readwrite').put({ path: 'k', data: plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.length) }));
    gate[2](); await idb.flush();
    assert.deepEqual(zlib.gunzipSync(Buffer.from((await req(store(db).get(['k']))).data)), v1);
    // a delete after a waiting one wins
    await req(store(db, 'readwrite').put({ path: 'k', data: rawFile(v3) }));
    await req(store(db, 'readwrite').delete(['k']));
    gate[3](); await idb.flush();
    assert.equal(await req(store(db).get(['k'])), undefined);
    assert.equal(await req(store(db).count(['k'])), 0);
  } finally { try { idb._sql.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage: when the other core fails, the file is gzipped here; a listing sees files still being compressed', async () => {
  const { idb, db, dir } = await openDb(() => Promise.reject(new Error('pool gone')));
  try {
    const nbt = packet(3000, 9);
    await req(store(db, 'readwrite').put({ path: 'x/level0/B.dat', data: rawFile(nbt) }));
    // listing right away
    const keys = await new Promise((resolve) => { const ks = []; const r = store(db).openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return resolve(ks); ks.push(c.key); c.continue(); }; });
    assert.deepEqual(keys, ['x/level0/B.dat']);
    await idb.flush();
    assert.deepEqual(zlib.gunzipSync(Buffer.from((await req(store(db).get(['x/level0/B.dat']))).data)), nbt);
    assert.equal(idb._stats.laterRedone >= 1, true);
    // a damaged header is refused, not stored
    const bad = new Uint8Array(rawFile(nbt, 0)); bad[12] = 0x7f;
    await assert.rejects(req(store(db, 'readwrite').put({ path: 'x/level0/C.dat', data: bad.buffer })));
    assert.equal(await req(store(db).count(['x/level0/C.dat'])), 0);
  } finally { try { idb._sql.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});
