'use strict';
// Terrain threads (config terrainThreads): the game's side of the hook (game-patches.js, "terrain
// threads", run here on stand-ins for the game's objects: terrain, biomes, players), the chunk names and
// the job's order (terrain.js), and the threads' manager with stand-in threads: what it asks for, for a
// job and for players (terrainForPlayers), what it skips, and how it stops. The real game and threads:
// test/terrain-daemon.test.js.
//   node --test test/terrain.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const paths = require('../src/paths');
const { applyTerrainWorkerPatches, terrainHook, pregenPlan } = require('../src/game-patches');
const { TerrainThreads, chunkPath, ahead } = require('../src/terrain');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  return fn();
}

// The hook's code (TERRAIN_CODE) in a context of its own, with stand-ins for the game's names it uses:
// the server (HMl) with its overworld (C5: tA loaded chunks, I8 generator; bce.a81.dT its folder) and its
// player list (f1.e1: dimension tk, x D, z E, name e7.eq), the generator class (A_p), a map lookup (Ld), longs
// (here a chunk key is just "x,z"), the biome list (H1Y: here biome i is { fr: i }, 200 an empty entry), its
// default (H2D) and arrays (H).
function hook({ generator = 'default', players = [] } = {}) {
  function A_p() {}
  const loaded = new Map();
  const w = { C5: { tA: loaded, I8: generator === 'default' ? new A_p() : {} }, bce: { a81: { dT: 'worlds/Test World' } } };
  const biomes = Array.from({ length: 256 }, (_, i) => (i === 200 ? null : { fr: i })), H2D = { fr: 0, isDefault: true };
  const list = players.map((p) => ({ tk: p.dim || 0, D: p.x, E: p.z, e7: { eq: p.name } }));
  const ctx = vm.createContext({
    HMl: { gc: { data: [w] }, f1: { e1: { b: list.length, f: { data: list } } } }, A_p, Ld: (m, k) => (m.has(k) ? m.get(k) : null),
    L: (v) => v, M: () => 0, X: (a) => a, Cw: (a) => a, Dq: (a, b) => `${a},${b}`, $rt_ustr: (s) => s, D: (e) => e,
    H1Y: { data: biomes }, H2D, E9: 'BiomeGenBase', H: (cls, n) => ({ cls, data: new Array(n).fill(null) }),
  });
  vm.runInContext(terrainHook.code(), ctx);
  const T = ctx.__eaglanTerrain;
  T.level = (cb) => cb({ bytes: new Uint8Array([1, 2, 3]) });   // the game's own (TeaVM) in the real hook
  return { T, ctx, loaded, biomes, H2D, list };
}
const primer = (fill = 0) => ({ w1: { data: new Int16Array(65536).fill(fill) } });
const terrainOf = (v) => new Int16Array(65536).fill(v).buffer;

test('terrain hook: off, the game makes every chunk itself', () => {
  const { T, ctx } = hook();
  const f = primer();
  assert.equal(T.put(1, 2, terrainOf(7)), false, 'nothing kept while off');
  assert.equal(ctx.$eaglanTgTake(1, 2, f), 0);
  assert.equal(f.w1.data[0], 0);
  assert.equal(ctx.$eaglanTgAt9(1, 2, f), false);
  assert.equal(T.status().used, 0);
});

test('terrain hook: on, a primer from a thread is used; every 32nd is compared instead', () => {
  const { T, ctx, loaded } = hook();
  T.set({ on: true, every: 32 });
  assert.equal(T.put(1, 2, terrainOf(7)), true);
  const f = primer();
  assert.equal(ctx.$eaglanTgTake(1, 2, f), 1, 'used: the game skips its own terrain');
  assert.equal(f.w1.data[0], 7); assert.equal(f.w1.data[65535], 7);
  assert.equal(ctx.$eaglanTgAt9(1, 2, f), false, 'the game goes on with the chunk');
  assert.equal(ctx.$eaglanTgTake(1, 2, primer()), 0, 'each primer is used once');
  assert.equal(T.status().missed, 1);
  // Chunks 2..31 used, the 32nd kept: the game makes its own, and at case 9 the two are compared.
  for (let i = 2; i < 32; i++) { T.put(i, 0, terrainOf(5)); assert.equal(ctx.$eaglanTgTake(i, 0, primer()), 1); }
  T.put(40, 0, terrainOf(5));
  const own = primer(); assert.equal(ctx.$eaglanTgTake(40, 0, own), 0, 'the 32nd is not used');
  assert.equal(own.w1.data[0], 0);
  own.w1.data.fill(5);   // the game's own terrain, the same
  assert.equal(ctx.$eaglanTgAt9(40, 0, own), false);
  let s = T.status();
  assert.deepEqual([s.used, s.checked, s.same, s.differ, s.on], [31, 1, 1, 0, true]);
  // Not kept: a chunk that is loaded already (the game made it meanwhile); the oldest beyond max.
  loaded.set('9,9', {});
  assert.equal(T.put(9, 9, terrainOf(1)), false); assert.equal(T.status().late, 1);
  T.set({ max: 3 });
  for (let i = 0; i < 5; i++) T.put(100 + i, 0, terrainOf(1));
  s = T.status(); assert.equal(s.ready, 3); assert.equal(s.dropped, 2);
  assert.equal(ctx.$eaglanTgTake(100, 0, primer()), 0, 'the oldest went first');
  assert.equal(ctx.$eaglanTgTake(104, 0, primer()), 1);
  T.set({ on: false }); assert.equal(T.status().ready, 0, 'off: nothing kept');
});

test('terrain hook: a difference switches it off and is reported; with verify it is only counted', () => {
  let { T, ctx } = hook();
  T.set({ on: true, every: 1 });
  T.put(3, 4, terrainOf(1)); T.put(5, 6, terrainOf(1));
  const own = primer(1); own.w1.data[300] = 2; own.w1.data[301] = 2;
  assert.equal(ctx.$eaglanTgTake(3, 4, own), 0);
  ctx.$eaglanTgAt9(3, 4, own);
  let s = T.status();
  assert.equal(s.on, false); assert.equal(s.differ, 1); assert.equal(s.differBlocks, 2); assert.equal(s.ready, 0, 'the rest is dropped');
  assert.match(s.error, /chunk 3, 4 from a terrain thread differed from the game's in 2 blocks/);
  assert.deepEqual({ ...s.firstDiff }, { x: 3, z: 4, blocks: 2, biomes: 0, index: 300, game: 2, thread: 1 });
  assert.equal(ctx.$eaglanTgTake(5, 6, primer()), 0, 'off: the game makes its own');

  ({ T, ctx } = hook());
  T.set({ on: true, verify: true });
  for (let i = 0; i < 3; i++) {
    T.put(i, 0, terrainOf(1));
    const f = primer(1); if (i === 1) f.w1.data[7] = 9;
    assert.equal(ctx.$eaglanTgTake(i, 0, f), 0, 'verify: never used');
    ctx.$eaglanTgAt9(i, 0, f);
  }
  s = T.status();
  assert.deepEqual([s.on, s.used, s.checked, s.same, s.differ, s.error], [true, 0, 3, 2, 1, null]);
});

test('terrain hook: a thread\'s biomes come with its terrain, as the game\'s lookup gives them, and are compared', () => {
  const { T, ctx, biomes, H2D } = hook();
  T.set({ on: true, every: 32 });
  const ids = Uint8Array.from({ length: 256 }, (_, i) => (i % 7 === 3 ? 200 : i % 40));   // 200: an empty entry
  T.put(1, 2, terrainOf(7), ids.slice().buffer);
  assert.equal(ctx.$eaglanTgTake(1, 2, primer()), 2, 'terrain and biomes: the game skips its biome lookup too');
  const g = { data: new Array(300).fill(null) };   // the generator's own array, room for 256: filled in place
  assert.equal(ctx.$eaglanTgBiomes(g), g);
  for (let i = 0; i < 256; i++) assert.equal(g.data[i], ids[i] === 200 ? H2D : biomes[ids[i]], `biome ${i}`);
  assert.equal(g.data[299], null, 'the rest of the array as it was');
  T.put(3, 4, terrainOf(7), ids.slice().buffer); ctx.$eaglanTgTake(3, 4, primer());
  const small = { data: new Array(100).fill(null) }, made = ctx.$eaglanTgBiomes(small);
  assert.notEqual(made, small); assert.equal(made.cls, 'BiomeGenBase'); assert.equal(made.data.length, 256, 'too small: a new BiomeGenBase[256]');
  assert.equal(ctx.$eaglanTg.bio, null, 'taken once');
  T.put(5, 6, terrainOf(7));   // a thread without biomes: terrain only, the game looks its biomes up
  assert.equal(ctx.$eaglanTgTake(5, 6, primer()), 1);
  assert.equal(T.status().biomes, 2); assert.equal(T.status().used, 3);
  // compared: the same biomes; one biome different is a difference (blocks the same)
  T.set({ every: 1 });
  const bm = { data: Array.from(ids, (id) => ({ fr: id })) };
  T.put(7, 0, terrainOf(7), ids.slice().buffer);
  assert.equal(ctx.$eaglanTgTake(7, 0, primer()), 0); ctx.$eaglanTgAt9(7, 0, primer(7), bm);
  assert.deepEqual([T.status().checked, T.status().checkedBiomes, T.status().same], [1, 1, 1]);
  T.put(8, 0, terrainOf(7), ids.slice().buffer); ctx.$eaglanTgTake(8, 0, primer());
  bm.data[17] = { fr: 99 }; ctx.$eaglanTgAt9(8, 0, primer(7), bm);
  const s = T.status();
  assert.deepEqual([s.differ, s.differBlocks, s.differBiomes, s.on], [1, 0, 1, false]);
  assert.match(s.error, /chunk 8, 0 from a terrain thread differed from the game's in 0 blocks and 1 biomes/);
});

test('terrain hook: the overworld\'s players', () => {
  const { T } = hook({ players: [{ name: 'Alice', x: 10.5, z: -3.25 }, { name: 'Bob', x: 1, z: 2, dim: -1 }, { name: 'Cy', x: -40, z: 7 }] });
  assert.deepEqual(Array.from(T.players(), (p) => ({ ...p })), [{ name: 'Alice', x: 10.5, z: -3.25 }, { name: 'Cy', x: -40, z: 7 }]);
  assert.equal(hook().T.players().length, 0);
});

test('terrain hook: in a terrain thread the primer is the result', () => {
  const { ctx } = hook();
  ctx.$eaglanTg.primerOnly = true;
  const f = primer(3);
  assert.equal(ctx.$eaglanTgAt9(0, 0, f), true, 'provideChunk returns there');
  assert.equal(ctx.$eaglanTg.out, f);
});

test('terrain hook: the thread side applies to the vendored classes.js and parses', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const { src, problems } = applyTerrainWorkerPatches(orig);
  assert.deepEqual(problems, []);
  assert.ok(src.includes('globalThis.__eaglanTgWorker='));
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'classes.js' }));
  assert.match(applyTerrainWorkerPatches('function Fs1(a,b,c){}').problems[0], /terrain threads \(thread side\) not applied/);
});

test('terrain: chunk file names and the order of the job', () => {
  // as u53 saved them (a world of seed 12345)
  assert.equal(chunkPath('worlds/Bench World', -12, 10), 'worlds/Bench World/level0/4DDFC1AEDFC1.dat');
  assert.equal(chunkPath('worlds/Bench World', -11, 10), 'worlds/Bench World/level0/5DDFC1AEDFC1.dat');
  assert.equal(chunkPath('w', 0, 0), 'w/level0/0EDFC10EDFC1.dat');
  // the job's own order, from where it is, within its rings
  const st = { cx: 5, cz: -7, ring: 1, k: 6, rings: 2 };
  const list = ahead(st, 100), want = [];
  for (let r = 1, k = 6; r <= 2;) { const o = pregenPlan.ringPos(r, k); want.push([5 + o[0], -7 + o[1], r]); if (++k >= 8 * r) { k = 0; r++; } }
  assert.deepEqual(list, want);
  assert.equal(list.length, 2 + 16);
  assert.deepEqual(ahead({ cx: 0, cz: 0, ring: 0, k: 0, rings: 1 }, 3), [[0, 0, 0], [-1, -1, 1], [0, -1, 1]]);
});

// A stand-in for terrain-worker.js: "ready", then a primer filled with x for each chunk (mode in
// workerData.classesJs: 'fail-init' / 'fail-chunk' for chunk x = 1).
const fakeWorker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-tt-')), 'fake-terrain.js');
fs.writeFileSync(fakeWorker, `const { parentPort, workerData } = require('node:worker_threads');
if (workerData.classesJs === 'fail-init') { parentPort.postMessage({ error: 'the generator could not be made: boom' }); process.exit(1); }
parentPort.postMessage({ ready: true, initMs: 1, seed: '1' });
parentPort.on('message', ({ x, z }) => {
  if (workerData.classesJs === 'fail-chunk' && x === 1) return parentPort.postMessage({ x, z, error: 'bad chunk' });
  const d = new Int16Array(65536).fill(x); parentPort.postMessage({ x, z, data: d.buffer, ms: 1 }, [d.buffer]);
});`);

function manager({ mode = 'ok', cores = 4, generator, wanted = 1, idleMs = 100, forPlayers = false, view = 2, playIdleMs = 200, playEvery = 0 } = {}) {
  const h = hook({ generator }), st = { running: false, cx: 0, cz: 0, ring: 0, k: 0, rings: 3 }, saved = new Set(), logs = [];
  const tt = new TerrainThreads({ wanted, classesJs: mode, log: (m) => logs.push(m), store: { hasFile: (db, p) => saved.has(p) },
    game: () => h.T, pregen: () => ({ status: () => ({ ...st }) }), detect: () => ({ cores, limitedBy: null }), workerFile: fakeWorker, idleMs,
    forPlayers, view, playIdleMs, playEvery });
  return { ...h, st, saved, logs, tt };
}

test('terrain threads: started by a job; the chunks ahead of it that are neither loaded nor saved', async () => {
  const m = manager();
  m.tt.tick(); assert.equal(m.tt.state, 'waiting', 'no job: nothing starts'); assert.equal(m.tt.threads.length, 0);
  m.st.running = true;
  m.loaded.set('0,0', {});                                     // the centre is loaded
  m.saved.add(chunkPath('worlds/Test World', 0, -1));          // the second of ring 1 is saved
  m.tt.tick();
  assert.equal(m.tt.threads.length, 1); assert.equal(m.tt.state, 'starting');
  assert.ok(await waitFor(() => m.tt.state === 'on'), 'ready');
  assert.equal(m.T.status().on, true);
  m.tt.tick();
  // 4 at a time per thread: (-1,-1), (1,-1), (1,0), (1,1); (0,0) loaded and (0,-1) saved are skipped
  assert.ok(await waitFor(() => m.tt.made === 4), 'made: ' + m.tt.made);
  assert.equal(m.tt.loadedAlready, 1); assert.equal(m.tt.onDisk, 1);
  for (const [x, z] of [[-1, -1], [1, -1], [1, 0], [1, 1]]) { const f = primer(); assert.equal(m.ctx.$eaglanTgTake(x, z, f), 1, `${x},${z}`); assert.equal(f.w1.data[0], x); }
  m.tt.tick();
  assert.ok(await waitFor(() => m.tt.made === 8));
  assert.equal(m.tt.status().inFlight, 0);
  // another job at once (the thread is still there): its chunks are asked for, also those asked for before
  m.st.startedAt = 2; m.st.ring = 1; m.st.k = 2; m.tt.tick();
  assert.ok(await waitFor(() => m.tt.made === 12), 'asked again: ' + m.tt.made);
  // the job stops: the threads end after idleMs, and the hook is off
  m.st.running = false;
  m.tt.tick(); await sleep(150); m.tt.tick();
  assert.equal(m.tt.threads.length, 0); assert.equal(m.tt.state, 'waiting'); assert.equal(m.T.status().on, false);
  assert.match(m.logs.join('\n'), /terrain threads ended \(the pre-generation job ended\): 12 chunks made/);
  // a new job starts them again
  m.st.running = true; m.tt.tick();
  assert.ok(await waitFor(() => m.tt.state === 'on')); assert.equal(m.tt.runs, 2);
  m.tt.close();
});

test('terrain threads: not used without a CPU to spare, or for a flat world', async () => {
  let m = manager({ cores: 1 });
  m.st.running = true; m.tt.tick();
  assert.equal(m.tt.state, 'unavailable'); assert.equal(m.tt.threads.length, 0);
  assert.match(m.tt.error, /1 CPU: a terrain thread needs one besides the game's/);
  m.tt.tick(); assert.equal(m.tt.threads.length, 0, 'and it stays so');
  m = manager({ generator: 'flat' });
  m.st.running = true; m.tt.tick();
  assert.equal(m.tt.state, 'unavailable'); assert.match(m.tt.error, /not the default overworld one/);
  m = manager({ cores: 2.5, wanted: 4 });   // a 2.5-CPU quota: 1 thread
  m.st.running = true; m.tt.tick();
  assert.equal(m.tt.threads.length, 1); m.tt.close();
});

test('terrain threads: a thread that fails, or a difference, switches them off for the run', async () => {
  let m = manager({ mode: 'fail-init' });
  m.st.running = true; m.tt.tick();
  assert.ok(await waitFor(() => m.tt.state === 'failed'));
  assert.match(m.tt.error, /could not start: the generator could not be made: boom/);
  assert.equal(m.T.status().on, false); assert.equal(m.tt.threads.length, 0);
  m.tt.tick(); assert.equal(m.tt.threads.length, 0, 'not started again');

  m = manager({ mode: 'fail-chunk' });
  m.st.running = true; m.st.ring = 1; m.st.k = 2; m.tt.tick();   // (1,-1) first
  assert.ok(await waitFor(() => m.tt.state === 'on')); m.tt.tick();
  assert.ok(await waitFor(() => m.tt.state === 'failed'));
  assert.match(m.tt.error, /could not make chunk 1, -1: bad chunk/);

  m = manager();
  m.st.running = true; m.tt.tick();
  assert.ok(await waitFor(() => m.tt.state === 'on'));
  m.T.set({ every: 1 }); m.tt.tick();
  assert.ok(await waitFor(() => m.tt.made >= 1));
  const own = primer(42); m.ctx.$eaglanTgTake(0, 0, own); m.ctx.$eaglanTgAt9(0, 0, own);   // (0,0): the thread's is all 0
  m.tt.tick();
  assert.equal(m.tt.state, 'failed'); assert.match(m.tt.error, /differed from the game's in 65536 blocks/);
  assert.match(m.logs.join('\n'), /terrain threads stopped: .* The game makes all terrain itself until the world restarts/);
});

test('terrain threads for players: the chunks of their view on the way they go, neither loaded nor saved, sooner first', () => {
  const m = manager({ forPlayers: true, view: 2 });
  let alice = { name: 'Alice', x: 8, z: 8 };
  const bob = { name: 'Bob', x: 8, z: 8 };
  m.T.players = () => [alice, bob];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) m.loaded.set(`${x},${z}`, {});
  const t0 = 1e6;
  assert.deepEqual(m.tt.playersAhead(t0), [], 'standing in their loaded view: nothing');
  m.tt.playEvery = 250;
  assert.equal(m.tt.playersAhead(t0 + 200), null, 'not looked at again this soon');
  m.tt.playEvery = 0;
  // Alice goes +x at 8 blocks a second: in 4 s from x 16 (chunk 1) to 48 (chunk 3); her view reaches columns 3, 4, 5
  m.saved.add(chunkPath('worlds/Test World', 4, 0));
  alice = { ...alice, x: 16 };
  const want = m.tt.playersAhead(t0 + 1000);
  const key = (l) => l.map(([x, z]) => `${x},${z}`).sort();
  const cols = (xs) => xs.flatMap((x) => [-2, -1, 0, 1, 2].map((z) => `${x},${z}`)).filter((k) => k !== '4,0').sort();
  assert.deepEqual(key(want), cols([3, 4, 5]), 'not the loaded ones, nor the saved 4,0');
  assert.deepEqual(key(want.slice(0, 5)), cols([3]), 'the column she reaches first comes first');
  assert.ok(want.every((w, i) => i === 0 || want[i - 1][2] <= w[2]), 'sooner first');
  // what is known stays known: asked for, a chunk is not wanted again
  const asked = [];
  m.tt.playQueue = want.slice(); m.tt.threads = [{ pending: 0, worker: { postMessage: (c) => asked.push(`${c.x},${c.z}`) } }];
  m.tt.feedPlayers();
  assert.equal(m.tt.playAsked, 4, '4 at a time per thread'); assert.deepEqual(asked, want.slice(0, 4).map(([x, z]) => `${x},${z}`), 'the first four, in order');
  const again = m.tt.playersAhead(t0 + 1250);
  assert.ok(again.length > 0 && again.every((w) => !asked.includes(`${w[0]},${w[1]}`)), 'the asked ones are not wanted again');
  m.tt.threads = []; m.tt.playQueue = [];
  // a jump (teleport): no way, only the view where she landed
  alice = { ...alice, x: 8000, z: 8 };
  const jump = m.tt.playersAhead(t0 + 1500);
  assert.deepEqual(key(jump), [498, 499, 500, 501, 502].flatMap((x) => [-2, -1, 0, 1, 2].map((z) => `${x},${z}`)).sort());
  assert.ok(jump.every((w) => w[2] === 0));
  // a player who left is forgotten
  m.T.players = () => [bob]; m.tt.playersAhead(t0 + 2000);
  assert.deepEqual([...m.tt.track.keys()], ['Bob']);
  m.tt.close();
});

test('terrain threads for players: started for them, fed as chunks come back, ended a while after the last one', async () => {
  const m = manager({ forPlayers: true, view: 1, playIdleMs: 200, idleMs: 100 });
  let alice = { name: 'Alice', x: 8, z: 8 };
  m.T.players = () => [alice];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) m.loaded.set(`${x},${z}`, {});
  m.tt.tick(); assert.equal(m.tt.state, 'waiting', 'nothing to make: nothing starts');
  alice = { ...alice, x: 9000 };   // she lands in new terrain: her view there
  m.tt.tick();
  assert.equal(m.tt.state, 'starting'); assert.match(m.logs.join('\n'), /terrain threads: starting 1 for the chunks players are about to reach/);
  assert.ok(await waitFor(() => m.tt.state === 'on'));
  m.tt.tick();
  assert.ok(await waitFor(() => m.tt.made === 9), 'her 9 chunks, 4 at a time, the rest as chunks come back: ' + m.tt.made);
  assert.equal(m.tt.status().playAsked, 9); assert.equal(m.tt.status().use, 'players');
  for (let x = 561; x <= 563; x++) for (let z = -1; z <= 1; z++) assert.equal(m.ctx.$eaglanTgTake(x, z, primer()), 1, `${x},${z}`);
  // a job meanwhile goes first: its chunks, not the players'
  m.st.running = true; m.tt.tick(); assert.equal(m.tt.use, 'job'); m.st.running = false;
  // nothing more for players: the threads end playIdleMs + idleMs after the last chunk wanted
  for (let x = 561; x <= 563; x++) for (let z = -1; z <= 1; z++) m.loaded.set(`${x},${z}`, {});
  m.tt.use = 'players';
  await sleep(100); m.tt.tick(); assert.equal(m.tt.threads.length, 1, 'still there');
  await sleep(200); m.tt.tick(); await sleep(150); m.tt.tick();
  assert.equal(m.tt.threads.length, 0); assert.equal(m.tt.state, 'waiting');
  assert.match(m.logs.join('\n'), /terrain threads ended \(no player reached new terrain for a while\): \d+ chunks made/);
  m.tt.close();
});
