'use strict';
// World pre-generation: the hook's own step ($eaglanPregenStep, src/game-patches.js), run tick by tick
// on stand-ins for the game: a clock, the server's tick schedule (a tick is due every 50 ms, as the
// game's main loop runs them), chunks that take 35 ms of the game thread to load and 1 ms per
// lighting call. With players on the server the job loads at most one chunk per tick; with nobody on
// it, as many as fit before the tick is late, never above its rate, and the server stays on schedule
// (never more than one chunk's work behind). Every chunk is loaded once, in order, and every chunk
// within the radius is lit and light populated before it is handed back.
//   node --test test/pregen-step.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PATCHES, pregenPlan } = require('../src/game-patches');

const PREGEN_CODE = (() => { const e = PATCHES.find((p) => p.name === 'world pre-generation').edits[0]; return e.replace.slice(0, e.replace.length - e.find.length); })();

// A server with `players` players, ticking for at most `seconds` (simulated) or until the job is over.
function simulate({ players = 0, rate = 50, fast, radius = 64, loadMs = 35, baseMs = 4, seconds = 120 }) {
  let clock = 1000;
  const all = new Map(), tA = new Map(), bdn = { el: 0, nb: null }, loads = [], perTick = [];
  const b = { tA, bdn, zC: {} };
  const w = { C5: b, Ly: { beT: new Map() }, bR: { bAD: () => 8, bAf: () => 8 } };
  const a = { gc: { data: [w] }, bGw: clock, f1: { e1: { b: players } }, bXY: 0 };
  const key = (x, z) => `${x},${z}`;
  let ticks = 0, inTick = 0, maxBehind = 0;
  const ctx = vm.createContext({
    HMl: a, HHE: () => clock, Dj: (v) => v, L: (v) => v, M: () => 0, X: (v) => v, Cw: (v) => v, U: (v) => v, Dq: (x, z) => key(x, z),
    Ld: (m, k) => (m.has(k) ? m.get(k) : null), HVj: 0, HVi: 0, FQ: () => false, B: () => false, FO: () => { throw new Error('FO'); },
    D: (e) => e, $rt_ustr: (s) => s,
    // ChunkProviderServer.loadChunk: generated, added to the loaded chunks and to the loaded list
    EIs: (pb, x, z) => {
      clock += loadMs; inTick++;
      const ch = { sk: x, rL: z, IU: 1, brF: 0, bdH: 0, loads: (all.get(key(x, z)) || { loads: 0 }).loads + 1 };
      all.set(key(x, z), ch); tA.set(key(x, z), ch); loads.push(key(x, z));
      bdn.nb = { jy: ch, brJ: bdn.nb }; bdn.el++; ctx.HVj++;
      return ch;
    },
    // Chunk.func_150809_p: first call lights it (brF), the second sets light populated (bdH) if its
    // eight neighbours are loaded and lit, as the game's check does
    D7o: (ch) => {
      clock += 1;
      if (!ch.brF) { ch.brF = 1; return; }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const n = tA.get(key(ch.sk + dx, ch.rL + dz)); if (!n || !n.brF) return; }
      ch.bdH = 1;
    },
    // dropChunk: the game unloads it
    Ef0: (set, k) => { tA.delete(k); },
  });
  vm.runInContext(PREGEN_CODE, ctx);
  const st0 = ctx.__eaglanPregen.start({ radius, rate, fast });
  const t0 = clock;
  for (;;) {
    // the main loop: a tick runs once it is due (more than 50 ms after the last one's due time)
    if (clock - a.bGw <= 50) clock = a.bGw + 51;
    a.bGw += 50; ticks++; inTick = 0;
    clock += baseMs;                       // the worlds' own work
    ctx.$eaglanPregenStep(a);
    perTick.push(inTick);
    maxBehind = Math.max(maxBehind, clock - a.bGw);
    const s = ctx.__eaglanPregen.status();
    if ((!s.running && !s.loadedNow && !s.pendingLights) || clock - t0 > seconds * 1000) break;
  }
  return { status: ctx.__eaglanPregen.status(), total: st0.total, seconds: (clock - t0) / 1000, ticks, all, loads, perTick, maxBehind, tps: ticks / ((clock - t0) / 1000) };
}

function checkJob(r, rings) {
  const { status: s, all, loads } = r;
  assert.equal(s.done, true, JSON.stringify(s));
  assert.equal(s.loadedNow, 0); assert.equal(s.pendingLights, 0);
  assert.equal(loads.length, r.total - s.alreadyLoaded, 'every chunk loaded');
  assert.equal(new Set(loads).size, loads.length, 'each once');
  // in the job's order: rings round the centre
  const want = []; for (let ring = 0; ring <= rings; ring++) for (let k = 0; k < (ring === 0 ? 1 : 8 * ring); k++) { const o = pregenPlan.ringPos(ring, k); want.push(`${o[0]},${o[1]}`); }
  assert.deepEqual(loads, want.filter((k) => loads.includes(k)));
  // within the radius (all but the two outer rings): lit and light populated
  let lit = 0;
  for (const ch of all.values()) if (Math.max(Math.abs(ch.sk), Math.abs(ch.rL)) <= rings - 2) { assert.equal(ch.bdH, 1, `chunk ${ch.sk},${ch.rL} light populated`); lit++; }
  return lit;
}

test('pre-generation step, nobody on the server: several chunks a tick, within the rate, on schedule', () => {
  const r = simulate({ players: 0, rate: 50 });
  const rings = Math.ceil(64 / 16) + 2;
  assert.equal(checkJob(r, rings), (2 * (rings - 2) + 1) ** 2);
  const rate = r.loads.length / r.seconds;
  assert.ok(rate > 23, `about 1000 / 39 ms a chunk: ${rate.toFixed(1)} chunks/s`);
  assert.ok(Math.max(...r.perTick) >= 2, 'more than one chunk in some ticks');
  assert.ok(r.status.extraLoads > 30, JSON.stringify(r.status));
  assert.ok(r.maxBehind <= 50 + 35 + 4 * 1 + 10, `never more than one chunk behind: ${r.maxBehind} ms`);
  assert.ok(r.tps > 19.5, `20 ticks per second: ${r.tps.toFixed(2)}`);
  assert.equal(r.status.empty, true); assert.equal(r.status.fast, true);
});

test('pre-generation step, players on the server: at most one chunk a tick, none while late', () => {
  const r = simulate({ players: 1, rate: 50 });
  checkJob(r, Math.ceil(64 / 16) + 2);
  assert.equal(Math.max(...r.perTick), 1);
  assert.equal(r.status.extraLoads, 0);
  const rate = r.loads.length / r.seconds;
  assert.ok(rate <= 20.5, `${rate.toFixed(1)} chunks/s`);
  assert.equal(r.status.empty, false);
});

test('pre-generation step, nobody on the server with fast off (config pregenFastWhenEmpty false): one chunk a tick, as before', () => {
  const off = simulate({ players: 0, rate: 50, fast: false }), on1 = simulate({ players: 1, rate: 50 });
  checkJob(off, Math.ceil(64 / 16) + 2);
  assert.equal(Math.max(...off.perTick), 1);
  assert.deepEqual(off.loads, on1.loads); assert.equal(off.ticks, on1.ticks, 'the same ticks as with a player on the server');
  assert.equal(off.status.fast, false); assert.equal(off.status.empty, false);
});

test('pre-generation step, nobody on the server: the rate is still the limit', () => {
  for (const rate of [4, 20, 30]) {
    const r = simulate({ players: 0, rate, radius: 160, seconds: 30 });
    const got = r.loads.length / r.seconds;
    assert.ok(got <= rate * 1.05 + 0.5, `rate ${rate}: ${got.toFixed(1)} chunks/s`);
    assert.ok(got >= rate * 0.8, `rate ${rate}: ${got.toFixed(1)} chunks/s`);
  }
  // fast chunks (read from disk: 2 ms): at most 16 a tick
  const r = simulate({ players: 0, rate: 1000, loadMs: 2, radius: 160, seconds: 5 });
  assert.equal(Math.max(...r.perTick), 16);
});
