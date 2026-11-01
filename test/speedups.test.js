'use strict';
// The speedups (src/game-patches.js, "speedup: ..."), run on stand-ins for the game's functions: the chunk
// lookup cache returns exactly what the map returns, also while chunks are loaded and unloaded; the UUID text
// is made once per UUID and again when a half is replaced; a player's packets kept during entity tracking
// reach the host in the order sent, with the IPC channel never kept, and how long they waited is counted;
// the 64-bit constants are made once, with the same values, and nothing else in the code changes; the lighting engine's
// position sets, run with the game's own set code, hold the same keys with either hash and are far quicker to fill; the
// collision scan, run with the game's own entity walk, leaves a walk out only where no entity found could give a box, and
// looks up the same chunks and sections as the walk. Verify mode notices a wrong answer.
// The patches on the vendored classes.js: test/game-patches.test.js; with the real game: the daemon tests.
//   node --test test/speedups.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const paths = require('../src/paths');
const { speedupCode, PATCHES, longConstants, applyGamePatches, applyTerrainWorkerPatches } = require('../src/game-patches');

// A 64-bit key as a "x,z" string (the stand-ins for TeaVM's Long functions), a LongObjectHashMap as a Map
// whose put and remove count the changes as the patched Dta and ADP do.
const longs = { L: (v) => v, M: () => 0, X: (v) => v, Cw: (v) => v, Dq: (x, z) => `${x},${z}` };
function chunkHook(wanted) {
  const ctx = vm.createContext({ ...longs, globalThis: undefined, Ld: (m, k) => (m.has(k) ? m.get(k) : null), ABR: (m, k) => (m.has(k) ? 1 : 0) });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = wanted;
  vm.runInContext(speedupCode.chunkCache, ctx);
  const map = new Map(), provider = { tA: map };
  const put = (x, z, v) => { map.set(`${x},${z}`, v); map.$eaglanMod = (map.$eaglanMod || 0) + 1; };
  const remove = (x, z) => { map.delete(`${x},${z}`); map.$eaglanMod = (map.$eaglanMod || 0) + 1; };
  return { ctx, map, provider, put, remove, get: (x, z) => ctx.$eaglanCk(provider, x, z), has: (x, z) => ctx.$eaglanCkHas(provider, x, z), status: () => ctx.__eaglanSpeedups.chunkCache() };
}

test('speedup chunk lookups: the same answers as the map, while chunks are loaded and unloaded', () => {
  const h = chunkHook({ chunkCache: true, verify: true });
  let seed = 7; const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const objs = [];
  for (let i = 0; i < 20000; i++) {
    const x = rnd(24) - 12, z = rnd(24) - 12, op = rnd(10);
    if (op === 0) { const c = { x, z, n: i }; objs.push(c); h.put(x, z, c); }
    else if (op === 1) h.remove(x, z);
    else {
      const want = h.map.has(`${x},${z}`) ? h.map.get(`${x},${z}`) : null;
      assert.equal(h.get(x, z), want, `chunk ${x}, ${z}`);
      assert.equal(h.has(x, z), want !== null ? 1 : 0);
    }
  }
  const s = h.status();
  assert.equal(s.diff, 0); assert.ok(s.hits > 1000, JSON.stringify(s)); assert.ok(s.misses > 100);
  // one slot per x & 7, z & 7: chunks 8 apart share a slot, and still get their own answers
  h.put(1, 1, 'a'); h.put(9, 1, 'b');
  for (let i = 0; i < 5; i++) { assert.equal(h.get(1, 1), 'a'); assert.equal(h.get(9, 1), 'b'); assert.equal(h.get(-7, 1), null); }
});

test('speedup chunk lookups: off, the map itself; verify mode notices a change the map did not count', () => {
  const off = chunkHook({ chunkCache: false });
  off.put(2, 3, 'c'); assert.equal(off.get(2, 3), 'c'); assert.equal(off.has(2, 3), 1);
  assert.equal(off.status().hits + off.status().misses, 0);
  const h = chunkHook({ chunkCache: true, verify: true });
  h.put(4, 4, 'old'); assert.equal(h.get(4, 4), 'old');
  h.map.set('4,4', 'new');   // changed without put: a cache would be wrong, and verify mode counts it
  h.get(4, 4);
  assert.equal(h.status().diff, 1);
});

// EaglercraftUUID.toString: the game's own ($eaglanCTz) counts its calls; the TeaVM thread functions as no-ops.
function uuidHook(wanted) {
  const ctx = vm.createContext({ FQ: () => false, B: () => false, FO: () => { throw new Error('FO'); }, DJ: () => ({ s() {}, l() {} }), $rt_ustr: (s) => s.text, calls: 0 });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = wanted;
  ctx.$eaglanCTz = (a) => { ctx.calls++; return { text: `${a.c9.v}-${a.da.v}` }; };
  vm.runInContext(speedupCode.uuidText, ctx);
  return ctx;
}

test('speedup UUID text: made once per UUID, again when a half is replaced', () => {
  const ctx = uuidHook({ uuidText: true });
  const u = { c9: { v: 1 }, da: { v: 2 } };
  const a = ctx.CTz(u), b = ctx.CTz(u);
  assert.equal(a.text, '1-2'); assert.equal(b, a, 'the same text'); assert.equal(ctx.calls, 1);
  u.da = { v: 3 };
  assert.equal(ctx.CTz(u).text, '1-3'); assert.equal(ctx.calls, 2);
  const s = ctx.__eaglanSpeedups.uuidText(); assert.deepEqual([s.hits, s.misses], [1, 2]);
  const off = uuidHook({ uuidText: false });
  off.CTz(u); off.CTz(u); assert.equal(off.calls, 2, 'off: the game\'s own every time');
  const v = uuidHook({ uuidText: true, verify: true });
  const w = { c9: { v: 5 }, da: { v: 6 } };
  v.CTz(w); w.$eaglanS = { text: 'wrong' }; v.CTz(w);
  assert.equal(v.__eaglanSpeedups.uuidText().diff, 1, 'verify mode counts a wrong text');
});

// ServerPlatformSingleplayer's postMessage as the patched code calls it; the host as a list of messages.
function packetHook(wanted) {
  const sent = [];
  const ctx = vm.createContext({ $rt_ustr: (j) => j.s, $rt_globals: { postMessage: (m) => sent.push(m) } });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = wanted;
  vm.runInContext(speedupCode.packetBatch, ctx);
  return { ctx, sent, post: (ch, n, z = 0) => ctx.$eaglanPkPost(ch, { n }, z) };
}
// What a player gets, in order, from the messages (single or kept).
const received = (sent, ch) => sent.filter((m) => m.ch === ch).flatMap((m) => (m.dats ? m.dats.map((d, i) => [d.n, m.zs ? m.zs[i] : 0]) : [[m.dat.n, m.z || 0]]));

test('speedup packet hand-over: kept during entity tracking, handed over at its end in the order sent', () => {
  const h = packetHook({ packetBatch: true });
  h.post('p1', 1); h.post('p2', 2);                  // outside: at once
  assert.equal(h.sent.length, 2);
  h.ctx.$eaglanPkOpen();
  h.post('p1', 3); h.post('p1', 4, 1); h.post('p2', 5);
  assert.equal(h.sent.length, 2, 'kept');
  h.ctx.$eaglanPkClose();
  assert.equal(h.sent.length, 4, 'one message per player');
  assert.deepEqual(received(h.sent, 'p1'), [[1, 0], [3, 0], [4, 1]]);
  assert.deepEqual(received(h.sent, 'p2'), [[2, 0], [5, 0]]);
  // the host's own channel is never kept, and what is kept goes before it (it may close a player's channel)
  h.ctx.$eaglanPkOpen(); h.post('p1', 6); h.post('~!IPC', 7); h.post('p1', 8);
  assert.deepEqual(h.sent.slice(4).map((m) => [m.ch, m.dat.n]), [['p1', 6], ['~!IPC', 7]]);
  h.ctx.$eaglanPkClose();
  // a phase that did not end: the next packet outside it hands over what is kept first
  h.ctx.$eaglanPkOpen(); h.post('p1', 9); h.ctx.$eaglanSpPk.open = false;
  h.post('p1', 10);
  assert.deepEqual(received(h.sent, 'p1').map((r) => r[0]), [1, 3, 4, 6, 8, 9, 10]);
  const s = h.ctx.__eaglanSpeedups.packetBatch(); assert.deepEqual([s.kept, s.flushes], [6, 4]);
  // off: every packet at once
  const off = packetHook({ packetBatch: false });
  off.ctx.$eaglanPkOpen(); off.post('p1', 1); off.post('p1', 2); off.ctx.$eaglanPkClose();
  assert.equal(off.sent.length, 2); assert.equal(off.sent.some((m) => m.dats), false);
});

test('speedup packet hand-over: verify mode numbers each player\'s packets without a gap, kept or not', () => {
  const h = packetHook({ packetBatch: true, verify: true });
  h.post('p1', 1); h.ctx.$eaglanPkOpen(); h.post('p1', 2); h.post('p1', 3); h.post('p2', 4); h.ctx.$eaglanPkClose(); h.post('p1', 5); h.post('~!IPC', 6);
  const seqs = h.sent.filter((m) => m.ch === 'p1').map((m) => [m.seq, m.dats ? m.dats.length : 1]);
  assert.deepEqual(seqs, [[1, 1], [2, 2], [4, 1]]);
  assert.equal(h.sent.find((m) => m.ch === '~!IPC').seq, undefined, 'the IPC channel is not numbered');
});

test('speedup packet hand-over: how long the first packet kept waited, per hand-over', () => {
  const sent = []; let now = 1000;
  const ctx = vm.createContext({ $rt_ustr: (j) => j.s, $rt_globals: { postMessage: (m) => sent.push(m), performance: { now: () => now } } });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = { packetBatch: true };
  vm.runInContext(speedupCode.packetBatch, ctx);
  ctx.$eaglanPkOpen(); now += 2; ctx.$eaglanPkPost('p1', {}, 0); now += 3; ctx.$eaglanPkPost('p2', {}, 0); now += 1; ctx.$eaglanPkClose();   // 4 ms
  ctx.$eaglanPkOpen(); ctx.$eaglanPkPost('p1', {}, 0); now += 2; ctx.$eaglanPkClose();   // 2 ms
  ctx.$eaglanPkOpen(); now += 50; ctx.$eaglanPkClose();   // nothing kept: no hand-over, no wait
  const s = ctx.__eaglanSpeedups.packetBatch();
  assert.deepEqual([s.flushes, s.heldMs, s.heldMaxMs, sent.length], [2, 3, 4, 3]);
});

test('speedup patches: each one all or nothing, with the code it needs', () => {
  const names = PATCHES.filter((p) => p.name.startsWith('speedup:')).map((p) => p.name);
  assert.deepEqual(names, ['speedup: chunk lookups', 'speedup: UUID text', 'speedup: packet hand-over', 'speedup: lighting sets', 'speedup: collision scan', 'speedup: encode once']);
});

// TeaVM's 64-bit numbers as it makes them where BigInt exists (as in Node): Long_create, Long_ne, Long_add.
const bigLongs = {
  Long_create: (lo, hi) => BigInt.asIntN(64, BigInt.asUintN(64, BigInt(lo)) | BigInt.asUintN(64, BigInt(hi) << 32n)),
  Long_ne: (a, b) => a !== b, Long_add: (a, b) => BigInt.asIntN(64, a + b),
};

test('speedup 64-bit constants: each made once with the same value; the rest of the game code unchanged', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const r = longConstants(orig);
  assert.equal(r.error, undefined);
  assert.equal(r.sites, 7014); assert.equal(r.values, 1075);
  // the definitions, right after M is set
  const at = r.src.indexOf('var M=Long_create;') + 'var M=Long_create;'.length, end = r.src.indexOf(';', r.src.indexOf('$eaglanLc' + (r.values - 1) + '='));
  const decl = r.src.slice(at, end + 1), defs = new Map();
  for (const m of decl.matchAll(/(\$eaglanLc\d+)=(M\(-?\d+, -?\d+\))/g)) defs.set(m[1], m[2]);
  assert.equal(defs.size, r.values);
  // each name back as its call, without the definitions: the vendored text, byte for byte
  const tail = 'diff:$eaglanLcD};};', rest = r.src.slice(0, at) + r.src.slice(r.src.indexOf(tail, end) + tail.length);
  assert.equal(rest.replace(/\$eaglanLc\d+/g, (n) => defs.get(n)), orig);
  // the values: as Long_create makes them
  const ctx = vm.createContext({ ...bigLongs, M: bigLongs.Long_create, globalThis: {} });
  vm.runInContext(r.src.slice(at, r.src.indexOf(tail, end) + tail.length), ctx);   // the definitions and the status
  for (const [n, call] of defs) {
    const [, lo, hi] = call.match(/M\((-?\d+), (-?\d+)\)/);
    assert.equal(ctx[n], bigLongs.Long_create(Number(lo), Number(hi)), n);
  }
  assert.equal(ctx[[...defs.keys()].find((n) => defs.get(n) === 'M(3740067437, 5)')], 0x5DEECE66Dn, "java.util.Random's multiplier");
  assert.deepEqual({ ...ctx.globalThis.__eaglanSpeedups.longConstants() }, { on: true, verify: false, sites: 7014, values: 1075, diff: null });
  assert.doesNotThrow(() => new vm.Script(r.src, { filename: 'classes.js' }));
});

test('speedup 64-bit constants: the same results; verify mode counts a constant that differs; not applied elsewhere', () => {
  const code = 'var M=Long_create;function f(){return Long_add(M(1, 2),M(4294967295, 0));}function g(){return M(1, 2);}var h=x.M(3, 4);';
  const run = (src) => { const ctx = vm.createContext({ ...bigLongs, globalThis: {}, x: { M: () => 'method' } }); ctx.globalThis = ctx; vm.runInContext(src, ctx); return ctx; };
  const plain = run(code), fast = run(longConstants(code).src);
  assert.equal(fast.f(), plain.f()); assert.equal(fast.g(), plain.g()); assert.equal(fast.h, 'method', 'a method named M is not one');
  assert.equal(longConstants(code).sites, 3); assert.equal(longConstants(code).values, 2);
  const v = run(longConstants(code, true).src);
  assert.equal(v.f(), plain.f()); assert.equal(v.__eaglanSpeedups.longConstants().diff, 0);
  v.$eaglanLc0 = 5n; v.g(); assert.equal(v.__eaglanSpeedups.longConstants().diff, 1, 'a wrong constant is counted');
  assert.match(longConstants('function x(){}').error, /Long_create is not where it is expected/);
  assert.match(longConstants(code + code).error, /Long_create is not where it is expected/);
  // with the game patches: last, over the patched text (the hooks' own constants too), only when asked for
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const on = applyGamePatches(orig, { longConstants: true }), off = applyGamePatches(orig);
  assert.deepEqual(on.problems, []); assert.equal(on.longConstants.values, 1075); assert.ok(on.longConstants.sites > 7014);
  assert.equal(off.longConstants, undefined); assert.ok(off.src.includes('M(3740067437, 5)'));
  assert.equal(on.src.split('M(3740067437, 5)').length - 1, 1, 'made once, where M is set');
  assert.deepEqual(applyTerrainWorkerPatches(orig, { longConstants: true }).problems, []);
  assert.match(applyGamePatches('function DDV(){}', { longConstants: true }).problems.at(-1), /speedup: 64-bit constants not applied/);
});

// The game's own LongHashSet (We) code, patched, taken from the vendored classes.js: the constructor, add (Ef0), contains
// (Qj), remove (ABh) and its shift (Bs9), rehash (XA), growing (DRx), with TeaVM's 64-bit numbers (BigInt) as classes.js
// makes them, its assertion checks on (K9l, HFt 0), and stand-ins for allocating (FZh) and the next size (Crp) as HPPC has
// them. Not inside a TeaVM thread: nothing pauses (FQ, B).
function gameSet(wanted) {
  const src = applyGamePatches(fs.readFileSync(paths.classesJs, 'utf8')).src;
  const fnText = (name) => { const i = src.indexOf('\nfunction ' + name + '('); assert.ok(i >= 0, name); return src.slice(i + 1, src.indexOf('\nfunction ', i + 10)); };
  // TeaVM's BigInt version of each 64-bit helper: of the definitions of a name, the one without TeaVM's Long objects (the
  // branch taken where BigInt exists)
  const defs = (n) => { const out = []; for (const m of src.matchAll(new RegExp(n + '\\s*=\\s*function', 'g'))) { let k = src.indexOf('{', m.index), d = 0; for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; } out.push(src.slice(m.index, k + 1).replace(/\s*=\s*function/, '=function')); } return out; };
  const helper = (n) => { const d = defs(n).find((t) => !/new Long|\b[a-z]+\.(hi|lo)\b/.test(t)); assert.ok(d, n); return d + ';'; };
  const bigLongDefs = 'Long_ZERO=$rt_globals.BigInt(0);' + ['Long_create', 'Long_eq', 'Long_ne', 'Long_compare', 'Long_mul', 'Long_xor', 'Long_shru', 'Long_lo'].map(helper).join('');
  const ctx = vm.createContext({ $rt_globals: globalThis, globalThis: undefined, FQ: () => false, B: () => false, K9l: 0, HFt: 0,
    CB: function () {}, F: (e) => { throw new Error('assertion failed'); }, AK1: function () {}, FO: () => { throw new Error('bad state'); }, DJ: () => { throw new Error('paused'); } });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = wanted;
  vm.runInContext('var Long_ZERO,Long_create,Long_eq,Long_ne,Long_compare,Long_mul,Long_xor,Long_shru,Long_lo;' + bigLongDefs +
    ';var BN=Long_ZERO,M=Long_create,T=Long_mul,R=Long_lo,C4=Long_xor,Ba=Long_shru,DX=Long_eq,EA=Long_ne,Ik=Long_compare;' +
    // HPPC: nextBufferSize doubles; allocateBuffers makes keys[size + 1] (the last slot for the empty key) and sets mask and resizeAt
    'function Crp(n,c,l){return n*2;}function FZh(a,n){a.tq={data:new Array(n+1).fill(Long_ZERO)};a.Fv=n-1;a.a2j=Math.min(n-1,Math.ceil(n*0.75));}\n' +
    speedupCode.lightSets + ['We', 'Ef0', 'Qj', 'ABh', 'Bs9', 'XA', 'DRx'].map(fnText).join('\n'), ctx);
  const make = (mark) => { const a = new ctx.We(); a.a6e = 0.75; ctx.FZh(a, 4); return mark ? ctx.$eaglanLhMark(a) : a; };
  return { ctx, make };
}
const posKey = (x, y, z) => (BigInt(y) << 52n) | (BigInt(x + 33554432) << 26n) | BigInt(z + 33554432);

test('speedup lighting sets: the game\'s set code holds the same keys with either hash, while growing and removing', () => {
  for (const verify of [false, true]) {
    const { ctx, make } = gameSet({ lightSets: true, verify });
    for (const mark of [false, true]) {
      const a = make(mark), want = new Set();
      assert.equal(a.$eaglanLh, mark ? 1 : 0);
      let seed = 11; const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };   // xorshift32
      for (let i = 0; i < 30000; i++) {
        const k = posKey(rnd(40) - 20, rnd(256), rnd(40) - 20), op = rnd(10);
        if (op < 6) assert.equal(ctx.Ef0(a, k), want.has(k) ? 0 : 1, 'add ' + k), want.add(k);
        else if (op < 8) assert.equal(ctx.Qj(a, k), want.has(k) ? 1 : 0, 'contains ' + k);
        else { assert.equal(ctx.ABh(a, k), want.has(k) ? 1 : 0, 'remove ' + k); want.delete(k); }
      }
      assert.equal(a.sx, want.size, 'its count');
      for (const k of want) assert.equal(ctx.Qj(a, k), 1);
      assert.ok(a.Fv > 4096, 'it grew: ' + (a.Fv + 1) + ' slots');
    }
    const st = ctx.__eaglanSpeedups.lightSets();
    assert.equal(st.sets, 1); assert.equal(st.diff, 0);
    if (verify) assert.ok(st.adds > 10000, 'verify: every add on the marked set checked: ' + st.adds); else assert.equal(st.adds, 0);
  }
});

test('speedup lighting sets: a column\'s heights spread over the slots; marked only while empty; off; verify counts a wrong answer', () => {
  const { ctx, make } = gameSet({ lightSets: true, verify: true });
  // a column's 256 heights: one slot with the game's hash below 2^20 slots, about 256 with the marked sets' one
  const PHI = 0x9E3779B97F4A7C15n, mixPhi = (k) => { const h = BigInt.asUintN(64, k * PHI); return Number((h ^ (h >> 32n)) & 0xffffffffn) | 0; };
  const game = new Set(), marked = new Set();
  for (let y = 0; y < 256; y++) { const k = posKey(123, y, -456); game.add(mixPhi(k) & 4095); marked.add(ctx.$eaglanLhHash(k) & 4095); }
  assert.equal(game.size, 1); assert.ok(marked.size > 240, 'slots: ' + marked.size);
  // a TeaVM Long object (no BigInt) hashes as the BigInt of the same value
  for (const k of [posKey(5, 70, 9), -1n, (1n << 63n) - 7n]) {
    const u = BigInt.asUintN(64, k), long = { lo: Number(u & 0xffffffffn) | 0, hi: Number(u >> 32n) | 0 };
    assert.equal(ctx.$eaglanLhHash(long), ctx.$eaglanLhHash(k));
  }
  // marked once, only while empty
  const a = make(false); ctx.Ef0(a, 5n); assert.equal(ctx.$eaglanLhMark(a).$eaglanLh, 0, 'not once it holds a key');
  const b = make(true); assert.equal(ctx.$eaglanLhMark(b), b); assert.equal(ctx.__eaglanSpeedups.lightSets().sets, 1);
  // verify mode: an answer that does not match the plain set beside it is counted
  ctx.$eaglanLhSeen(b, 9n, 1); assert.equal(ctx.__eaglanSpeedups.lightSets().diff, 0);
  ctx.$eaglanLhSeen(b, 9n, 1); assert.equal(ctx.__eaglanSpeedups.lightSets().diff, 1, '"added" twice');
  ctx.$eaglanLhSeen(b, 10n, 0); assert.equal(ctx.__eaglanSpeedups.lightSets().diff, 2, '"there already", never added');
  // off: nothing marked, the game's hash everywhere
  const off = gameSet({ lightSets: false });
  assert.equal(off.make(true).$eaglanLh, 0); assert.equal(off.ctx.__eaglanSpeedups.lightSets().on, false);
});

test('speedup lighting sets: filling a set with columns of heights, the game\'s set code probes far less when marked', () => {
  const { ctx, make } = gameSet({ lightSets: true });
  const keys = []; for (let x = 0; x < 48; x++) for (let z = 0; z < 16; z++) for (let y = 60; y < 80; y++) keys.push(posKey(x, y, z));
  const time = (mark) => { const a = make(mark), t = process.hrtime.bigint(); for (const k of keys) ctx.Ef0(a, k); return { a, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  time(false); time(true);   // warm up
  const plain = time(false), fast = time(true);
  assert.equal(plain.a.sx, keys.length); assert.equal(fast.a.sx, keys.length);
  assert.ok(fast.ms * 3 < plain.ms, `marked ${fast.ms.toFixed(1)} ms, the game's hash ${plain.ms.toFixed(1)} ms for ${keys.length} keys`);
});

test('speedup collision scan: on the vendored classes.js, only the classes it takes give boxes; another build walks as before', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8'), r = applyGamePatches(orig);
  assert.deepEqual(r.problems, []);
  assert.equal(r.src.split('case 2:$z=$eaglanCsScan(a,b,w,q,c);').length - 1, 1, 'F5z hands its walk to the speedup');
  assert.equal(r.src.split('Lfl=b;$eaglanCsInit();}').length - 1, 1, 'EntityBoat joins the classes every section knows');
  // every class's getCollisionBoundingBox (cXC), getCollisionBox (dlf) and getEntitiesWithinAABBForEntity (el9)
  const impl = (m) => [...orig.matchAll(new RegExp('"' + m + '",HE\\w*\\(([\\w$]+)\\)', 'g'))].map((x) => x[1]).sort();
  assert.deepEqual(impl('cXC'), ['GOn', 'GZ8', 'G_F', 'Gxv']);
  assert.deepEqual(impl('dlf'), ['CDr', 'Eci', 'FfU']);
  assert.deepEqual(impl('el9'), ['Dbo', 'DuM']);
  const broken = applyGamePatches(orig.replace('function GZ8(a){return null;}', 'function GZ8(a){return a.dz;}'));
  assert.equal(broken.problems.filter((p) => p.startsWith('speedup: collision scan not applied')).length, 1);
  assert.ok(broken.src.includes('case 2:$z=CGv(a,b,w,q);if(B()){break _;}') && !broken.src.includes('$eaglanCsInit'));
});

// The collision scan (speedup 6) with the game's own entity walk, taken from the vendored classes.js:
// World.getEntitiesInAABBexcluding (CGv), Chunk.getEntitiesWithinAABBForEntity (Dbo), AxisAlignedBB.intersectsWith (Lk)
// and the entities' boxes (a boat's Gxv and Eci, a minecart's GZ8 and FfU, any other entity's GOn and CDr), on stand-ins
// for a world: chunks (some not loaded, some empty: EmptyChunk, AU0) of 16 sections, each with its entities (a_f), the
// classes it knows (an IdentityHashMap: l8.data, entries AJ hash, n key, ox next) and its lists by class (a HashMap:
// o.data, entries s hash, n key, q list, p next), laid out as TeaVM lays them out. Each chunk lookup and each read of a
// section's entities goes into a log. Not inside a TeaVM thread: nothing pauses (FQ, B).
let csSrc = null;
function collisionGame(wanted) {
  const src = csSrc || (csSrc = applyGamePatches(fs.readFileSync(paths.classesJs, 'utf8')).src);
  const fnText = (name) => { const i = src.indexOf('\nfunction ' + name + '('); assert.ok(i >= 0, name); return src.slice(i + 1, src.indexOf('\nfunction ', i + 10)); };
  const ctx = vm.createContext({ globalThis: undefined, FQ: () => false, B: () => false, FO: () => { throw new Error('bad state'); }, DJ: () => { throw new Error('paused'); } });
  ctx.globalThis = ctx; ctx.__eaglanSpeedupsWanted = wanted;
  vm.runInContext(
    // an ArrayList (V: f.data, b its size) as CGv makes it, ensureCapacity (Be), Integer.compare (Bc), a section's iterator (FvR)
    'function G(){}function V(){this.f=null;this.b=0;this.h=0;}function H(c,n){return {data:new Array(n).fill(null)};}function Be(l,n){}' +
    'function Bc(a,b){return a<b?-1:a>b?1:0;}function FvR(m){var l=m.a_f,i=0;return {by:function(){return i<l.b?1:0;},bz:function(){return l.f.data[i++];}};}' +
    // EntityBoat, EntityMinecart, EmptyChunk, any other entity; class objects (HK) with identity hashes; the static set (Lfl)
    'function SA(){}function Md(){}function AU0(){}function Mob(){}var $eaglanIds=100;function $rt_nextId(){return ++$eaglanIds;}' +
    'function $rt_cls(c){if(!c.classObject)c.classObject={T:c,$id$:0};return c.classObject;}' +
    'var Lfl={bi:{keys:[],RF:function(k,v){if(this.keys.indexOf(k)<0)this.keys.push(k);return null;}}};\n' +
    speedupCode.collisionScan + ['CGv', 'Dbo', 'Lk', 'Gxv', 'Eci', 'GZ8', 'FfU', 'GOn', 'CDr'].map(fnText).join('\n') +
    '\nSA.prototype.cXC=function(){return Gxv(this);};SA.prototype.dlf=function(o){return Eci(this,o);};' +
    'Md.prototype.cXC=function(){return GZ8(this);};Md.prototype.dlf=function(o){return FfU(this,o);};' +
    'Mob.prototype.cXC=function(){return GOn(this);};Mob.prototype.dlf=function(o){return CDr(this,o);};' +
    '[SA,Md,Mob].forEach(function(c){c.prototype.cfm=function(){return null;};c.prototype.bnf=function(){return 1;};});' +
    'AU0.prototype.el9=function(){};\n$eaglanCsInit();', ctx);
  return ctx;
}
// A section with entities ents. known: it knows the boat class (every section made once the class was set up does), and
// then its boat list holds its boats (kept false: a list the game failed to keep, empty). The boat's entries come first
// or after another class's in the same slot (first), so the lookups walk chains.
function csSection(ctx, log, tag, ents, { known = true, kept = true, first = false } = {}) {
  const boat = ctx.$eaglanSpCs.boat || ctx.$rt_cls(ctx.SA); if (!boat.$id$) boat.$id$ = ctx.$rt_nextId();   // (off: a class the speedup does not use)
  const id = boat.$id$, slot = id & 15, other = { $id$: id + 16 };
  const list = (xs) => ({ f: { data: xs.slice() }, b: xs.length }), all = list(ents);
  const l8 = new Array(16).fill(null), o = new Array(16).fill(null);
  l8[slot] = { AJ: other.$id$, n: other, ox: null }; o[slot] = { s: other.$id$, n: other, q: all, p: null };
  if (known) {
    const boats = kept ? ents.filter((e) => e instanceof ctx.SA) : [];
    l8[slot] = first ? { AJ: id, n: boat, ox: l8[slot] } : { AJ: other.$id$, n: other, ox: { AJ: id, n: boat, ox: null } };
    if (boats.length || first) o[slot] = first ? { s: id, n: boat, q: list(boats), p: o[slot] } : { s: other.$id$, n: other, q: all, p: { s: id, n: boat, q: list(boats), p: null } };
  }
  const sec = { bnD: { n9: { l8: { data: l8 } } }, baM: { o: { data: o } }, ents, known };
  Object.defineProperty(sec, 'a_f', { get() { log.push(tag); return all; } });
  return sec;
}
const csWorld = (ctx, log, chunks) => ({ F: {
  ua: (x, z) => { log.push(`ua ${x},${z}`); return chunks.has(`${x},${z}`) ? 1 : 0; },
  bk: (x, z) => { log.push(`bk ${x},${z}`); return chunks.get(`${x},${z}`) || null; } } });
const csChunk = (ctx, secs) => ({ R3: { data: secs }, el9(b, c, e, d) { ctx.Dbo(this, b, c, e, d); } });
const csBox = (x, y, z, sx, sy, sz) => ({ cE: x, b2: y, cD: z, cJ: x + sx, cG: y + sy, cK: z + sz });
const csGrown = (bb) => ({ cE: bb.cE - 0.25, b2: bb.b2 - 0.25, cD: bb.cD - 0.25, cJ: bb.cJ + 0.25, cG: bb.cG + 0.25, cK: bb.cK + 0.25 });

test('speedup collision scan: with the game\'s own entity walk, left out exactly where no section walked has a boat', () => {
  const ctx = collisionGame({ collisionScan: true }), log = [], chunks = new Map(), all = [], tags = new Map();
  let seed = 23; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };   // xorshift32
  const entity = (k, x, y, z) => { const e = k < 0.04 ? new ctx.SA() : k < 0.1 ? new ctx.Md() : new ctx.Mob(), w = 0.2 + rnd() * 0.6; e.dz = csBox(x - w, y, z - w, 2 * w, 0.5 + rnd() * 1.5, 2 * w); return e; };
  for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) {
    const r = rnd();
    if (r < 0.08) continue;   // not loaded
    if (r < 0.12) { chunks.set(`${cx},${cz}`, new ctx.AU0()); continue; }
    const secs = [];
    for (let y = 0; y < 16; y++) {
      // (an entity is listed where it was at its last update: up to a block outside its section)
      const ents = []; for (let i = rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 5); i > 0; i--) ents.push(entity(rnd(), cx * 16 - 1 + rnd() * 18, y * 16 - 1 + rnd() * 18, cz * 16 - 1 + rnd() * 18));
      const tag = `${cx},${cz},${y}`, s = csSection(ctx, log, tag, ents, { known: rnd() < 0.97, first: rnd() < 0.5 });
      secs.push(s); tags.set(tag, s); all.push(...ents);
    }
    chunks.set(`${cx},${cz}`, csChunk(ctx, secs));
  }
  const w = csWorld(ctx, log, chunks), pred = { jc: () => 1 }, n = { left: 0, boxes: 0, mover: 0, boat: 0, unknown: 0 };
  const lookups = (l) => l.filter((s) => /^(ua|bk) /.test(s)).join(' '), sections = (l) => [...new Set(l.filter((s) => !/^(ua|bk) /.test(s)))].sort().join(' ');
  for (let t = 0; t < 8000; t++) {
    const k = rnd(), mover = k < 0.05 ? new ctx.SA() : k < 0.1 ? new ctx.Md() : new ctx.Mob();
    // the mover's box as moved (bb), half of the time at an entity, and the box CGv is asked about (grown by 0.25, as F5z grows it)
    const at = rnd() < 0.5 ? all[Math.floor(rnd() * all.length)].dz : null;
    const bb = csBox(at ? at.cE - 1 + rnd() * 1.5 : -70 + rnd() * 140, at ? at.b2 - 1 + rnd() : -30 + rnd() * 320, at ? at.cD - 1 + rnd() * 1.5 : -70 + rnd() * 140, 0.3 + rnd() * 2, 0.5 + rnd() * 2.5, 0.3 + rnd() * 2);
    const c = csGrown(bb);
    log.length = 0;
    const found = ctx.CGv(w, mover, c, pred), walked = log.slice();
    let boxes = false;
    for (let i = 0; i < found.b; i++) { const o = found.f.data[i], a = o.cXC(), m = mover.dlf(o); if ((a !== null && ctx.Lk(a, bb)) || (m !== null && ctx.Lk(m, bb))) boxes = true; }
    const near = [...new Set(walked.filter((s) => !/^(ua|bk) /.test(s)))].map((tg) => tags.get(tg)).filter((s) => s.ents.length);
    const keep = mover instanceof ctx.SA || mover instanceof ctx.Md || near.some((s) => !s.known || s.ents.some((e) => e instanceof ctx.SA));
    log.length = 0;
    const why = ctx.$eaglanCsWhy(w, mover, c);
    assert.equal(why !== 0, keep, `try ${t}: reason ${why}`);
    if (why === 0) {
      assert.ok(!boxes, `try ${t}: left out, but an entity found gives a box`);
      assert.equal(lookups(log), lookups(walked), `try ${t}: the same chunk lookups as CGv`);
      assert.equal(sections(log), sections(walked), `try ${t}: the same sections as Dbo`);
      n.left++;
    } else if (why === 1) { assert.ok(mover instanceof ctx.SA || mover instanceof ctx.Md); n.mover++; } else if (why === 2) n.boat++; else n.unknown++;
    if (boxes) n.boxes++;
  }
  assert.ok(n.left > 2000 && n.boat > 500 && n.mover > 400 && n.unknown > 20 && n.boxes > 300, JSON.stringify(n));
});

test('speedup collision scan: the reasons to walk, verify mode, the list it leaves out, and off', () => {
  const run = (wanted, opts) => {
    const ctx = collisionGame(wanted), log = [], boat = new ctx.SA(), mob = new ctx.Mob(), far = new ctx.Mob();
    boat.dz = csBox(7.5, 70, 7.5, 1.4, 0.6, 1.4); mob.dz = csBox(5.7, 70, 7.0, 0.6, 1.95, 0.6); far.dz = csBox(40.7, 70, 8.7, 0.6, 1.95, 0.6);
    const secs = []; for (let y = 0; y < 16; y++) secs.push(csSection(ctx, log, `0,0,${y}`, y === 4 ? [boat, mob] : [], opts));
    const secs2 = []; for (let y = 0; y < 16; y++) secs2.push(csSection(ctx, log, `2,0,${y}`, y === 4 ? [far] : []));
    const w = csWorld(ctx, log, new Map([['0,0', csChunk(ctx, secs)], ['2,0', csChunk(ctx, secs2)]]));
    const at = (e, dx) => { const bb = csBox(e.dz.cE + dx, e.dz.b2, e.dz.cD, 0.6, 1.95, 0.6); return { bb, c: csGrown(bb) }; };
    return { ctx, w, boat, mob, far, at, st: () => ctx.__eaglanSpeedups.collisionScan() };
  };
  const pred = { jc: () => 1 };
  // the reasons: a boat in reach, the mover a boat or a minecart, a section that does not know boats; nothing near
  let g = run({ collisionScan: true });
  assert.deepEqual([g.ctx.Lfl.bi.keys.length, g.ctx.Lfl.bi.keys[0]], [1, g.ctx.$rt_cls(g.ctx.SA)], 'EntityBoat joins the static set of classes');
  let m = g.at(g.mob, 1.5);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, g.mob, m.c), 2);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, g.boat, m.c), 1);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, new g.ctx.Md(), m.c), 1);
  const f = g.at(g.far, 0.1);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, g.far, f.c), 0);
  const r1 = g.ctx.$eaglanCsScan(g.w, g.far, f.c, pred, f.bb), r2 = g.ctx.$eaglanCsScan(g.w, g.far, f.c, pred, f.bb);
  assert.equal(r1.b, 0); assert.equal(r2, r1, 'one empty list, never changed (F5z only reads it)');
  const kept = g.ctx.$eaglanCsScan(g.w, g.mob, m.c, pred, m.bb);
  assert.equal(kept.b, 1); assert.equal(kept.f.data[0], g.boat, 'walked: the game\'s list');
  assert.deepEqual({ ...g.st() }, { on: true, verify: false, ready: true, calls: 3, skipped: 2, mover: 0, boats: 1, unknown: 0, diff: 0 });
  g = run({ collisionScan: true }, { known: false }); m = g.at(g.mob, 1.5);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, g.mob, m.c), 3, 'a section that does not know boats');
  // verify mode: a boat list the game failed to keep (the speedup would leave the walk out): walked anyway, counted
  g = run({ collisionScan: true, verify: true }, { kept: false }); m = g.at(g.mob, 1.5);
  assert.equal(g.ctx.$eaglanCsWhy(g.w, g.mob, m.c), 0);
  const r = g.ctx.$eaglanCsScan(g.w, g.mob, m.c, pred, m.bb);
  assert.equal(r.b, 1); assert.equal(r.f.data[0], g.boat);
  assert.deepEqual([g.st().skipped, g.st().diff], [1, 1]);
  g.ctx.$eaglanCsScan(g.w, g.far, g.at(g.far, 0.1).c, pred, g.at(g.far, 0.1).bb);
  assert.deepEqual([g.st().skipped, g.st().diff], [2, 1], 'nothing near: no difference');
  // off: the boat class not set up, the game's walk, nothing counted
  g = run({ collisionScan: false }); m = g.at(g.mob, 1.5);
  assert.equal(g.ctx.Lfl.bi.keys.length, 0);
  assert.equal(g.ctx.$eaglanCsScan(g.w, g.far, g.at(g.far, 0.1).c, pred, g.at(g.far, 0.1).bb).b, 0);
  assert.equal(g.ctx.$eaglanCsScan(g.w, g.mob, m.c, pred, m.bb).b, 1);
  assert.deepEqual({ ...g.st() }, { on: false, verify: false, ready: false, calls: 0, skipped: 0, mover: 0, boats: 0, unknown: 0, diff: 0 });
});
