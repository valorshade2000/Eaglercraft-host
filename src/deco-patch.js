'use strict';
// Decoration ahead (stage 8, path 4; config decorationAhead for players, decorationAheadPregen for the pre-generation
// job; both off by default). The game code's side, for game-patches.js: the functions below are written in the game's
// own names (TeaVM, u53 classes.js) and inserted into it as text; nothing here runs in Node itself.
//
// A chunk's decoration (ChunkProviderGenerate.populate, EPT: ores, lakes, trees, flowers, the animals...) runs when the
// chunk and three neighbours are loaded, inside the load of the last of them. A thread of its own (deco-worker.js, its own
// copy of the game code) runs ahead what the game is about to load (the next row of chunks a moving player will see; the
// next chunks of the pre-generation job): it makes their terrain as the game will, and runs every decoration their loads
// will start, in the game's order, on copies of the chunks loaded now. Of each decoration it records:
//   - the block writes its own logic makes (World.setBlockState, FUd, at the top: not those its writes cause, which the
//     game's own writes cause again), with the exact block state (its block and its index among the block's states:
//     the game's numeric state id would lose state properties the block does not keep as metadata);
//   - the animals' spawning (SpawnerAnimals.performWorldGenSpawning, E31) with the state of the decoration's random
//     generator there: the species come from the world's own random generator, so the game spawns them itself;
//   - with each write, whether World.scheduledUpdatesAreImmediate (coU) was set: a liquid spring (WorldGenLiquids)
//     sets it around the spring's first update, so the water flows at once inside the writes it causes;
//   - every chunk it touched with its version (two 32-bit hashes of every block written to it since it was loaded,
//     kept by Chunk.setBlockState, E53) and its height map, and every "is this chunk loaded" answer it got;
//   - the height limit of every biome's big tree generator before and after (a big tree that does not fit leaves its
//     height limit for the next big tree of the biome, in any chunk: state carried between decorations);
//   - and anything a copy cannot give the game's answer to: a light value read (the lighting engine's state is the
//     whole world's), a tile entity, an entity, a block tick or neighbour update asked for, the world's random generator,
//     an unseeded random number, a chunk it was not given. Such a decoration is not used.
// When the game reaches a decoration ($eaglanDwTake), it uses the thread's record only if every chunk it touched is
// the same object (or was made after the record was asked for, by the generator) with the same version and height map,
// every loaded answer is the same, the big tree generators are as the record started from, no structure start of the
// generator meets the chunk, and the block falling and immediate update flags are clear. Then $eaglanDwReplay does what
// populate does, in its order: the biome lookup, the structure generators' calls (each finds nothing, as checked, and
// steps its map's iteration seed as populate's calls do), every recorded write through the game's own setBlockState (the
// immediate update flag set as recorded), the animals' spawning through the game's own function with the random
// generator set to the recorded state, the big tree generators as the record ended, and the flag. Otherwise the game
// decorates the chunk itself, as before.
// Verify mode (EAGLAN_DEBUG_SPEEDUPS_VERIFY=1): the game decorates the chunk itself, records it the same way and
// compares it with the thread's record (written blocks, spawning, the random generator's state, what was not usable).

// ---------------------------------------------------------------- both copies (the game's and the thread's)
// An exact integer key for chunk (x, z) (|x|, |z| < 1,875,000: the world border).
function $eaglanDwNow() { return Number(globalThis.process.hrtime.bigint()) / 1e6; }   // (the harness moves the game's own clock)
function $eaglanDwK(x, z) { return (x + 1875000) * 4194304 + (z + 1875000); }
// A block state as (block id * 65536 + its index among the block's valid states), and back: the same objects on
// both sides (the states of a block are made once, in a fixed order).
function $eaglanDwIndexBlock(blk) {
  var s = $eaglanDw, id = EFh(blk), it = DH7(FN0(blk)).Oo(), i = 0, arr = [];
  while (it.by()) { var st = it.bz(); s.sid.set(st, id * 65536 + i); arr.push(st); i = i + 1 | 0; }
  s.sts.set(id, arr);
}
function $eaglanDwSid(st) {
  var s = $eaglanDw, v = s.sid.get(st);
  if (v !== undefined) return v;
  $eaglanDwIndexBlock(st.v);
  v = s.sid.get(st);
  return v === undefined ? -1 : v;
}
function $eaglanDwState(v) {
  var s = $eaglanDw, id = Math.floor(v / 65536), arr = s.sts.get(id);
  if (arr === undefined) { $eaglanDwIndexBlock(EK1(id)); arr = s.sts.get(id); }
  return arr === undefined ? null : (arr[v % 65536] || null);
}
// Chunk.setBlockState (E53), after the block is set: the chunk's version (two hashes, from 0 when the chunk was made or
// read from its file) takes the position in the chunk (y << 8 | z << 4 | x) and the block as the chunk keeps it (its
// section's char: what the chunk holds, nothing more).
function $eaglanDwHash(ch, pos, v) {
  var k = pos ^ Math.imul(v, 0x27D4EB2D);
  ch.$eaglanDwH1 = Math.imul(ch.$eaglanDwH1 ^ k, 0x9E3779B1) + 0x165667B1 | 0;
  ch.$eaglanDwH2 = Math.imul(ch.$eaglanDwH2 + k | 0, 0x85EBCA77) ^ (ch.$eaglanDwH2 >>> 13);
}
// A chunk's height map (heightMap X9, 256 ints) as one number.
function $eaglanDwHm(c) { var d = c.X9.data, h = 0, i; for (i = 0; i < 256; i++) h = Math.imul(h ^ d[i], 0x9E3779B1) + i | 0; return h; }
// The biomes' big tree generators (WorldGenBigTree: heightLimit bGW, leafDistanceLimit bq9), in a fixed order. A big tree
// that does not fit leaves its height limit for the next one of its biome (validTreeLocation FY1 returns before it is
// reset): state carried from one decoration to the next, so the thread starts each batch from the game's, the game
// checks it before a replay and takes the thread's after.
function $eaglanDwTrees() {
  var s = $eaglanDw, l, i, k, b, v;
  if (s.trees !== null) return s.trees;
  if (H1Y === null) return [];
  l = [];
  for (i = 0; i < H1Y.data.length; i++) { b = H1Y.data[i]; if (b === null) continue; for (k in b) { v = b[k]; if (v !== null && typeof v === 'object' && 'bGW' in v && 'bq9' in v && l.indexOf(v) < 0) l.push(v); } }
  s.trees = l;
  return l;
}
function $eaglanDwTreeState() { var l = $eaglanDwTrees(), o = new Array(l.length), i; for (i = 0; i < l.length; i++) o[i] = l[i].bGW; return o; }
function $eaglanDwSetTrees(v) { var l = $eaglanDwTrees(), i; for (i = 0; i < l.length && i < v.length; i++) l[i].bGW = v[i]; }
// A random generator's state (EaglercraftRandom Hn: seed i, a long; jo; dPP; fT), and setting it.
function $eaglanDwRand(r) { return [String(r.i), r.jo, r.dPP, r.fT]; }
function $eaglanDwSetRand(r, v) { r.i = BigInt(v[0]); r.jo = v[1]; r.dPP = v[2]; r.fT = v[3]; }
// While a decoration is recorded: something a copy cannot answer for the game. any: at any depth (else only at the top).
function $eaglanDwNo(why, any) {
  var s = $eaglanDw;
  if (s.rec === 0 || FQ() || s.native > 0 || (!any && s.depth !== 0)) return;
  if (s.abort === null) s.abort = why;
}

// ---------------------------------------------------------------- the game's copy
// At the end of every tick (path ahead's $eaglanTickEnd): the thread's records in, then what to ask it for next.
function $eaglanDwTick() {
  var s = $eaglanDw, api = s.api;
  if (api === null) { api = globalThis.__eaglanDecoAhead || null; if (api === null) return; s.api = api; }
  s.tick = s.tick + 1 | 0;
  var t0 = $eaglanDwNow(), got = api.take(), i;
  for (i = 0; i < got.length; i++) {
    var res = got[i], b = s.batches.get(res.id);
    if (b === undefined) continue;
    if (res.error) { s.st.errors++; s.lastError = res.error; b.done = 1; continue; }
    if (res.done) { b.done = 1; s.st.results++; for (var q = 0; q < b.seq.length; q += 2) { var qk = $eaglanDwK(b.seq[q], b.seq[q + 1]); if (s.inFlight.get(qk) === b.id) s.inFlight.delete(qk); } continue; }
    var d = res.pop; d.b = b; s.jobs.set($eaglanDwK(d.x, d.z), d); s.st.records++;
  }
  // records nobody used within 30 s are dropped (the player turned, the job moved on)
  if ((s.tick & 63) === 0) {
    s.batches.forEach(function (b, id) { if (s.tick - b.t > 600) { s.batches.delete(id); s.st.expired++; } });
    s.jobs.forEach(function (d, k) { if (!s.batches.has(d.b.id)) s.jobs.delete(k); });
  }
  s.st.tickMs += $eaglanDwNow() - t0;
  if (!api.ready()) return;
  var w = $eaglanTgWorld();
  if (!w || !(w.C5.I8 instanceof A_p)) return;
  try {
    if (s.on) $eaglanDwPlanPlayers(w);
    if (s.pregen) $eaglanDwPlanPregen(w);
  } catch (e) { s.on = false; s.pregen = false; try { $rt_globals.console.error('[runtime] decoration ahead stopped after an error (the game decorates every chunk itself now): ' + ((e && e.stack) || e)); } catch (e2) {} }
}
// Players: each one's next view update (PlayerManager.updateMountedMovingPlayer, FfD) where its position goes now:
// when it is 8 blocks or more from where the view was last updated (cN9, cN8) in another chunk, the chunks of the new
// view that were not in the old one are added, x outer and z inner, each loaded then (DTU -> loadChunk).
function $eaglanDwPlanPlayers(w) {
  var s = $eaglanDw, pm = w.Ly, k = pm.rq, srv = HMl, l, i, p, seen = new Set();
  if (srv === null || !srv.f1) return;
  l = srv.f1.e1;
  for (i = 0; i < l.b; i++) {
    p = l.f.data[i];
    if (p.tk !== 0) continue;
    seen.add(p);
    var last = s.players.get(p), x = p.D, z = p.E;
    s.players.set(p, [x, z]);
    if (last === undefined) continue;
    var vx = x - last[0], vz = z - last[1];
    if (vx * vx + vz * vz < 1e-6 || vx * vx + vz * vz > 100) continue;   // standing, or a jump (teleport)
    var mx = p.cN9, mz = p.cN8, ci = (mx | 0) >> 4, cj = (mz | 0) >> 4, t;
    for (t = 1; t <= 20; t++) {   // a view update within 20 ticks (the thread needs time; the copies should be recent)
      var px = x + vx * t, pz = z + vz * t, dx = px - mx, dz = pz - mz;
      if (dx * dx + dz * dz < 64) continue;
      var cd = (px | 0) >> 4, cf = (pz | 0) >> 4;
      if (cd === ci && cf === cj) continue;
      if (t < 3) break;   // too soon for the thread
      var key = cd + ',' + cf + ',' + ci + ',' + cj;
      if (s.asked.get(p) === key) break;
      s.asked.set(p, key);
      var seq = [], n, m;
      for (n = cd - k; n <= cd + k; n++) for (m = cf - k; m <= cf + k; m++) {
        if (n - ci >= -k && n - ci <= k && m - cj >= -k && m - cj <= k) continue;
        seq.push(n, m);
      }
      $eaglanDwPost(w, seq);
      break;
    }
  }
  s.players.forEach(function (v, p) { if (!seen.has(p)) { s.players.delete(p); s.asked.delete(p); } });
}
// The pre-generation job: its next chunks, as $eaglanPgNextLoad will take them (ring by ring round its centre).
function $eaglanDwPlanPregen(w) {
  var s = $eaglanDw, p = $eaglanPregen;
  if (p === null || !p.running) { s.pgAt = -1; return; }
  // the position the job is at, as one number; the next 32 chunks it will make are asked for once the job is within
  // 12 of the end of what was asked for last (each record is sent back as soon as it is made)
  var at = p.ring === 0 ? 0 : (2 * p.ring - 1) * (2 * p.ring - 1) + p.k;
  if (s.pgAt >= 0 && at < s.pgAt - 12 && s.pgJob === p.job) return;
  var seq = [], r = p.ring, kk = p.k, n = 0, guard = 0;
  if (s.pgAt > at && s.pgJob === p.job) { r = s.pgR; kk = s.pgK; }   // on from the end of the last batch
  while (n < 32 && r <= p.rings && guard++ < 4096) {
    var o = $eaglanPgRingPos(r, kk), x = p.cx + o[0], z = p.cz + o[1];
    if (Ld(w.C5.tA, $eaglanPgKey(x, z)) === null) { seq.push(x, z); n++; }
    if (++kk >= (r === 0 ? 1 : 8 * r)) { kk = 0; r++; }
  }
  s.pgAt = (r === 0 ? 0 : (2 * r - 1) * (2 * r - 1)) + kk; s.pgJob = p.job; s.pgR = r; s.pgK = kk;
  if (seq.length) $eaglanDwPost(w, seq);
}
// A batch for the thread: the chunks to load in order; copies of every loaded chunk next to one of them (their
// decorations read them); which chunks two around them are loaded.
function $eaglanDwPost(w, seq) {
  var s = $eaglanDw, t0 = $eaglanDwNow(), map = w.C5.tA, near = new Map(), snaps = [], tr = [], loaded = [], unloaded = [], objs = new Map(), i, dx, dz;
  for (i = 0; i < seq.length; i += 2) for (dx = -2; dx <= 2; dx++) for (dz = -2; dz <= 2; dz++) {
    var x = seq[i] + dx, z = seq[i + 1] + dz, k = $eaglanDwK(x, z), c;
    if (near.has(k)) c = near.get(k);
    else { c = Ld(map, $eaglanPgKey(x, z)); near.set(k, c); if (c === null) unloaded.push(x, z); else loaded.push(x, z); }
    if (c !== null && dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1 && !objs.has(k)) { snaps.push($eaglanDwSnap(c, tr)); objs.set(k, c); }
  }
  var id = s.nextId = s.nextId + 1 | 0;
  s.batches.set(id, { id: id, t: s.tick, born: s.born, objs: objs, done: 0, seq: seq });
  for (i = 0; i < seq.length; i += 2) s.inFlight.set($eaglanDwK(seq[i], seq[i + 1]), id);
  s.st.batches++; s.st.copied += snaps.length; s.st.snapMs += $eaglanDwNow() - t0;
  s.api.post({ id: id, seq: seq, snaps: snaps, loaded: loaded, unloaded: unloaded, trees: $eaglanDwTreeState() }, tr);
}
// A copy of a chunk for the thread: what its blocks, heights and decoration read (not entities, tile entities, light
// engine queues: a decoration that needs them is not used).
function $eaglanDwSnap(c, tr) {
  var o = { x: c.sk, z: c.rL, h1: c.$eaglanDwH1, h2: c.$eaglanDwH2, f: [c.IU, c.bdH, c.b40, c.uv, c.dqn, c.cSm, c.Ue, c.a$v, c.brF, c.b27],
    bio: c.a9Z.data.slice(), prec: c.YD.data.slice(), sky: c.bUn.data.slice(), hm: c.X9.data.slice(), sec: [] }, i;
  tr.push(o.bio.buffer, o.prec.buffer, o.sky.buffer, o.hm.buffer);
  for (i = 0; i < 16; i++) {
    var e = c.xT.data[i];
    if (e === null) { o.sec.push(null); continue; }
    var q = { y: e.a_l, n1: e.bJ1, n2: e.bPc, y6: e.Y6, d: new Uint16Array(e.R8.data), bl: e.VL.zw.data.slice(), sl: e.T6 === null ? null : e.T6.zw.data.slice() };
    tr.push(q.d.buffer, q.bl.buffer); if (q.sl !== null) tr.push(q.sl.buffer);
    o.sec.push(q);
  }
  return o;
}
// The thread's record of the decoration of chunk (x, z), if the game can use it now; null: the game decorates it.
function $eaglanDwTake(a, x, z) {
  var s = $eaglanDw, k = $eaglanDwK(x, z), d = s.jobs.get(k);
  if (d === undefined) {
    var late = false, ex, ez;
    for (ex = 0; ex <= 1 && !late; ex++) for (ez = 0; ez <= 1; ez++) if (s.inFlight.has($eaglanDwK(x + ex, z + ez))) { late = true; break; }
    if (late) s.st.late++; else s.st.none++;
    return null;
  }
  s.jobs.delete(k);
  if (d.abort !== null) { s.st.notUsable++; s.whyNot[d.abort] = (s.whyNot[d.abort] || 0) + 1; return null; }
  if (KDC || s.rec !== 0 || a.jj.coU) { s.st.busy++; return null; }
  var w = a.jj, map = w.C5.tA, b = d.b, i;
  for (i = 0; i < d.seen.length; i += 6) {
    var cx = d.seen[i], cz = d.seen[i + 1], c = Ld(map, $eaglanPgKey(cx, cz));
    if (c === null) { s.st.changed++; return null; }
    if (d.seen[i + 4]) { if (c.$eaglanDwBorn <= b.born) { s.st.changed++; return null; } }   // made by the thread: made since by the game's generator
    else if (b.objs.get($eaglanDwK(cx, cz)) !== c) { s.st.changed++; return null; }   // a copy: the same chunk object
    if (c.$eaglanDwH1 !== d.seen[i + 2] || c.$eaglanDwH2 !== d.seen[i + 3]) { s.st.changed++; return null; }
    if ($eaglanDwHm(c) !== d.seen[i + 5]) { s.st.heights++; return null; }
  }
  for (i = 0; i < d.asked.length; i += 3) if ((Ld(map, $eaglanPgKey(d.asked[i], d.asked[i + 1])) !== null ? 1 : 0) !== d.asked[i + 2]) { s.st.loadedDiff++; return null; }
  var tv = $eaglanDwTreeState();
  for (i = 0; i < tv.length; i++) if (tv[i] !== d.trees0[i]) { s.st.trees++; return null; }
  var gens = $eaglanDwGens(a), x0 = x * 16 + 8 | 0, z0 = z * 16 + 8 | 0;
  for (i = 0; i < gens.length; i++) if ($eaglanDwStructs(gens[i].Fy, x0, z0)) { s.st.structure++; return null; }
  if (d.states === undefined) {
    d.states = [];
    for (i = 0; i < d.ops.length; i += 6) if (d.ops[i] === 1) { var st = $eaglanDwState(d.ops[i + 4]); if (st === null) { s.st.errors++; return null; } d.states.push(st); }
  }
  d.gens = gens; d.bail = 0;
  return d;
}
// The structure generators populate calls, in its order (mineshafts, villages, strongholds, temples, monuments).
function $eaglanDwGens(a) {
  var g = [];
  if (a.kF.cgc && a.o2) g.push(a.b8t);
  if (a.kF.bEw && a.o2) g.push(a.buv);
  if (a.kF.bhQ && a.o2) g.push(a.bds);
  if (a.kF.a6K && a.o2) g.push(a.WK);
  if (a.kF.PZ && a.o2) g.push(a.Pc);
  return g;
}
// Has the structure map m (MapGenStructure.structureMap, Fy) a start whose box meets [x0, x0 + 15] x [z0, z0 + 15]?
// Walked as generateStructure (F93) walks it, its iteration seed (I_) put back afterwards.
function $eaglanDwStructs(m, x0, z0) {
  var saved = m.I_, i = new ARu(), hit = false, j, k;
  i.cc4 = m; i.cx = 0; i.bU5 = new PJ();
  j = Bp(m.I_, -1640531527); k = j ^ (j >>> 16); m.I_ = k; i.cc5 = 29 + ((k & 7) << 1) | 0; i.bTk = k & m.Xi;
  try {
    while (true) {
      if (!i.cx) { i.cx = 1; i.f4 = W1(i); }
      if (i.cx !== 1) break;
      i.cx = 0;
      var q = i.f4.tf.zP;
      if (q.eN >= x0 && q.dO <= x0 + 15 && q.e3 >= z0 && q.dQ <= z0 + 15) { hit = true; break; }
    }
  } finally { m.I_ = saved; }
  return hit;
}
// What populate (EPT) does, from the thread's record (b) instead of its own logic. Written as the game's code is
// (TeaVM: each call can pause, and the function then resumes there). b.bail: the biome differs; nothing was done.
function $eaglanDwReplay(a, b) {
  var c, d, e, f, g, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); g = $T.l(); f = $T.l(); e = $T.l(); d = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0:
        b.t0 = $eaglanDwNow(); KDC = 1; c = new BJ(); c.k = b.x * 16 + 16 | 0; c.u = 0; c.m = b.z * 16 + 16 | 0; $p = 1;
      case 1:
        $z = CzN(a.jj, c); if (B()) { break _; } b.biome = $z;
        if (b.spawnBiome >= 0 && b.biome.fr !== b.spawnBiome) { KDC = 0; b.bail = 1; $eaglanDw.st.biome++; return; }
        d = HCr(b.x, b.z); b.gi = 0; b.oi = 0; b.si = 0; b.ri = 0; $p = 2;
      case 2:
        if (b.gi < b.gens.length) { $p = 3; continue _; }
        $p = 4; continue _;
      case 3:
        F93(b.gens[b.gi], a.jj, a.no, d); if (B()) { break _; } b.gi = b.gi + 1 | 0; $p = 2; continue _;
      case 4:
        if (b.oi >= b.ops.length) { KDC = 0; $eaglanDwSetTrees(b.trees1); $eaglanDwReplayed(b); return; }
        g = b.oi;
        if (b.ops[g] === 1) { e = new BJ(); e.k = b.ops[g + 1]; e.u = b.ops[g + 2]; e.m = b.ops[g + 3]; f = b.states[b.si]; $p = 5; continue _; }
        $eaglanDwSetRand(a.no, b.rnd[b.ri]); $p = 6; continue _;
      case 5:
        a.jj.coU = b.ops[g + 5] >> 16 & 1; FUd(a.jj, e, f, b.ops[g + 5] & 65535); if (B()) { break _; } a.jj.coU = 0; b.si = b.si + 1 | 0; b.oi = b.oi + 6 | 0; $p = 4; continue _;
      case 6:
        E31(a.jj, b.biome, b.ops[g + 2], b.ops[g + 3], b.ops[g + 4], b.ops[g + 5], a.no); if (B()) { break _; } b.ri = b.ri + 1 | 0; b.oi = b.oi + 6 | 0; $p = 4; continue _;
      default: FO();
    }
  }
  DJ().s(a, b, c, d, e, f, g, $p);
}
function $eaglanDwReplayed(b) {
  var s = $eaglanDw; s.st.used++; s.st.writes += b.ops.length / 6 | 0; s.st.replayMs += $eaglanDwNow() - b.t0; s.st.threadMs += b.ms || 0;
}
// Verify mode: the game's own decoration is recorded the same way ($eaglanDwRecBegin before it, $eaglanDwRecEnd after)
// and compared with the thread's.
function $eaglanDwRecBegin(d, a) {
  var s = $eaglanDw;
  s.rec = 1; s.depth = 0; s.native = 0; s.abort = null; s.ops = []; s.rnd = []; s.spawned = 0; s.wrand = a.jj.c8; s.grand = a.no;
  return 1;
}
function $eaglanDwRecEnd(d) {
  var s = $eaglanDw, same = s.abort === null && s.ops.length === d.ops.length, i;
  s.rec = 0;
  for (i = 0; same && i < s.ops.length; i++) if (s.ops[i] !== d.ops[i]) same = false;
  for (i = 0; same && i < s.rnd.length; i++) if (String(s.rnd[i]) !== String(d.rnd[i])) same = false;
  if (same && String($eaglanDwTreeState()) !== String(d.trees1)) same = false;
  if (same) s.st.checked++;
  else {
    s.st.diff++;
    var fi = 0; while (fi < s.ops.length && fi < d.ops.length && s.ops[fi] === d.ops[fi]) fi++;
    fi = fi - fi % 6;
    if (s.diffs.length < 8) s.diffs.push({ x: d.x, z: d.z, abort: s.abort, ops: [s.ops.length, d.ops.length], first: fi / 6, game: s.ops.slice(Math.max(0, fi - 12), fi + 18), thread: d.ops.slice(Math.max(0, fi - 12), fi + 18), seen: d.seen, asked: d.asked });
  }
}

// ---------------------------------------------------------------- the thread's copy (deco-worker.js)
// The world's chunk provider there: the copies and the chunks it made; anything else is a chunk it was not given.
function $eaglanDwExists(x, z) {
  var s = $eaglanDw, k;
  if (s.terrain) return 0;   // making a chunk's terrain: as the terrain threads (only the caves and ravines ask)
  k = $eaglanDwK(x, z);
  var v = s.loaded.get(k);
  if (v === undefined) { $eaglanDwNo('a chunk two or more away', true); return 0; }
  if (s.rec !== 0 && !s.askedNow.has(k)) s.askedNow.set(k, v);
  return v;
}
function $eaglanDwGet(x, z) {
  var s = $eaglanDw, k = $eaglanDwK(x, z), c = s.chunks.get(k);
  if ((c === undefined || s.loaded.get(k) !== 1) && s.rec !== 0 && globalThis.__eaglanDwDebug !== undefined && globalThis.__eaglanDwDebug-- > 0) $rt_globals.console.log('[dw debug] target ' + s.tx + ',' + s.tz + ' asked ' + x + ',' + z + ' chunk ' + (c !== undefined) + ' loaded ' + s.loaded.get(k) + ' chunks ' + Array.from(s.chunks.keys()).map(function (q) { var qx = Math.floor(q / 4194304); return (qx - 1875000) + ':' + (q - qx * 4194304 - 1875000); }).join(' '));
  if (c === undefined || s.loaded.get(k) !== 1) { $eaglanDwNo('a chunk it was not given (' + (x - s.tx) + ',' + (z - s.tz) + (s.loaded.get(k) === 1 ? ', loaded' : s.loaded.get(k) === 0 ? ', not loaded' : ', unknown') + (s.depth > 0 ? ', inside a write' : '') + ')', true); return s.empty; }
  if (s.rec !== 0 && !s.seenNow.has(k)) s.seenNow.set(k, [x, z, c.$eaglanDwH1, c.$eaglanDwH2, s.made.has(k) ? 1 : 0, $eaglanDwHm(c)]);
  return c;
}
var $eaglanDwProvider = {
  ua: function (x, z) { return $eaglanDwExists(x, z); },
  bk: function (x, z) { return $eaglanDwGet(x, z); },
  bGb: function (x, z) { return $eaglanDwExists(x, z) ? $eaglanDwGet(x, z) : null; },
};
// A batch, from its first step to its end (each step can pause; the steps are in a.call, set by $eaglanDwStep).
function $eaglanDwRun(a) {
  var $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0:
        if (!$eaglanDwStep(a)) return a;
        $p = a.call; continue _;
      case 1:   // a chunk the game will make: as its generator makes it (provideChunk, Fs1)
        $eaglanDw.terrain = 1; $z = Fs1(a.gen, a.cx, a.cz); if (B()) { break _; } $eaglanDw.terrain = 0; $eaglanDwMade(a, $z); $p = 0; continue _;
      case 2:   // a decoration, recorded
        EPT(a.gen, $eaglanDwProvider, a.cx, a.cz); if (B()) { break _; } $eaglanDwDecorated(a); $p = 0; continue _;
      case 3:   // an empty chunk object for a copy (Chunk(World, x, z), B1o)
        B1o(a.obj, a.gen.jj, a.cx, a.cz); if (B()) { break _; } $eaglanDwFill(a); $p = 0; continue _;
      default: FO();
    }
  }
  DJ().s(a, $p);
}
// The next step of batch a: false when it is done.
function $eaglanDwStep(a) {
  var s = $eaglanDw;
  if (a.si < a.snaps.length) { var o = a.snaps[a.si]; a.obj = new Ng(); a.cx = o.x; a.cz = o.z; a.call = 3; return true; }
  if (a.empty === undefined) { a.empty = new Ng(); a.obj = a.empty; a.cx = 0; a.cz = 0; a.si = a.si + 1 | 0; a.snapsDone = 1; a.call = 3; return true; }
  while (a.pend.length) {   // decorations the last load starts, in populateChunk's order
    var t = a.pend.shift(), c = s.chunks.get($eaglanDwK(t[0], t[1]));
    if (c === undefined || c.IU) continue;
    c.IU = 1;   // as ChunkProviderServer.populate's func_150809_p first does
    a.gen.jj.coU = 0; KDC = 0;   // as the game has them when a decoration starts (checked there)
    a.cx = t[0]; a.cz = t[1]; s.tx = t[0]; s.tz = t[1];
    s.rec = 1; s.depth = 0; s.native = 0; s.abort = null; s.ops = []; s.rnd = []; s.spawned = 0; s.seenNow = new Map(); s.askedNow = new Map();
    s.wrand = a.gen.jj.c8; s.grand = a.gen.no; a.t0 = $eaglanDwNow(); a.trees0 = $eaglanDwTreeState();
    a.call = 2; return true;
  }
  while (a.qi < a.seq.length) {
    var x = a.seq[a.qi], z = a.seq[a.qi + 1], k = $eaglanDwK(x, z);
    a.qi = a.qi + 2 | 0;
    if (s.loaded.get(k) === 1) continue;   // loaded already: the game's loadChunk returns it
    a.cx = x; a.cz = z; a.call = 1; return true;
  }
  return false;
}
// A copy filled in (its empty chunk object made): blocks, heights, biomes, flags; its version from the game.
function $eaglanDwFill(a) {
  var s = $eaglanDw, c = a.obj;
  if (c === a.empty) { s.empty = c; return; }
  var o = a.snaps[a.si], i, f = o.f;
  a.si = a.si + 1 | 0;
  c.IU = f[0]; c.bdH = f[1]; c.b40 = f[2]; c.uv = f[3]; c.dqn = f[4]; c.cSm = f[5]; c.Ue = f[6]; c.a$v = f[7]; c.brF = f[8]; c.b27 = f[9];
  c.a9Z.data.set(o.bio); c.YD.data.set(o.prec); c.bUn.data.set(o.sky); c.X9.data.set(o.hm);
  for (i = 0; i < 16; i++) {
    var q = o.sec[i];
    if (q === null) continue;
    var e = new ANG(); G3L(e, q.y, q.sl !== null);
    e.bJ1 = q.n1; e.bPc = q.n2; e.Y6 = q.y6; e.R8.data.set(q.d); e.VL.zw.data.set(q.bl); if (q.sl !== null) e.T6.zw.data.set(q.sl);
    c.xT.data[i] = e;
  }
  c.$eaglanDwH1 = o.h1; c.$eaglanDwH2 = o.h2;
  var k = $eaglanDwK(o.x, o.z);
  s.chunks.set(k, c); s.loaded.set(k, 1);
}
// A chunk made (loadChunk: it is loaded, then populateChunk, FeW: the decorations its load starts, in that order).
function $eaglanDwMade(a, c) {
  var s = $eaglanDw, x = a.cx, z = a.cz, k = $eaglanDwK(x, z);
  c.$eaglanDwH1 = 0; c.$eaglanDwH2 = 0;
  s.chunks.set(k, c); s.loaded.set(k, 1); s.made.add(k);
  var L = function (dx, dz) { return s.loaded.get($eaglanDwK(x + dx, z + dz)) === 1; };
  var f = L(0, -1), f1 = L(1, 0), f2 = L(0, 1), f3 = L(-1, 0), f4 = L(-1, -1), f5 = L(1, 1), f6 = L(-1, 1), f7 = L(1, -1);
  if (f1 && f2 && f5) a.pend.push([x, z]);
  if (f3 && f2 && f6) a.pend.push([x - 1, z]);
  if (f && f1 && f7) a.pend.push([x, z - 1]);
  if (f4 && f && f3) a.pend.push([x - 1, z - 1]);
}
// A decoration recorded: what the game needs to check and replay it.
function $eaglanDwDecorated(a) {
  var s = $eaglanDw, seen = [], asked = [], sb = -1, i;
  s.rec = 0;
  s.seenNow.forEach(function (v) { seen.push(v[0], v[1], v[2], v[3], v[4], v[5]); });
  s.askedNow.forEach(function (v, k) { var x = Math.floor(k / 4194304); asked.push(x - 1875000, k - x * 4194304 - 1875000, v); });
  for (i = 0; i < s.ops.length; i += 6) if (s.ops[i] === 2) { sb = s.ops[i + 1]; break; }
  var rec = { x: a.cx, z: a.cz, abort: s.abort, ops: s.abort === null ? Int32Array.from(s.ops) : new Int32Array(0), rnd: s.rnd, seen: seen, asked: asked, spawnBiome: sb, trees0: a.trees0, trees1: $eaglanDwTreeState(), ms: $eaglanDwNow() - a.t0 };
  a.n = a.n + 1 | 0;
  a.onPop(rec);
}
// The thread's API (deco-worker.js): set up from the world's level.dat bytes, then batches.
var $eaglanDwApi = {
  init: function (bytes, cb) {
    $rt_startThread(function () { return $eaglanTgWInit(bytes); }, function (r) {
      if (!(r instanceof A_p)) { cb({ error: 'the world\'s generator is not the overworld\'s default one' }); return; }
      var s = $eaglanDw; s.gen = r; s.thread = true; r.jj.F = $eaglanDwProvider;
      cb({ ok: true });
    });
  },
  // batch: { id, seq, snaps, loaded, unloaded }; onPop(record) for each decoration as it is recorded, then
  // cb({ id, n }) or cb({ id, error })
  run: function (batch, onPop, cb) {
    var s = $eaglanDw, i;
    s.chunks = new Map(); s.loaded = new Map(); s.made = new Set();
    for (i = 0; i < batch.loaded.length; i += 2) s.loaded.set($eaglanDwK(batch.loaded[i], batch.loaded[i + 1]), 1);
    for (i = 0; i < batch.unloaded.length; i += 2) s.loaded.set($eaglanDwK(batch.unloaded[i], batch.unloaded[i + 1]), 0);
    for (i = 0; i < batch.seq.length; i += 2) { var k = $eaglanDwK(batch.seq[i], batch.seq[i + 1]); if (!s.loaded.has(k)) s.loaded.set(k, 0); }
    $eaglanDwSetTrees(batch.trees || []);
    var a = { gen: s.gen, seq: batch.seq, qi: 0, snaps: batch.snaps, si: 0, pend: [], onPop: onPop, n: 0, call: 0, cx: 0, cz: 0, obj: null };
    $rt_startThread(function () { return $eaglanDwRun(a); }, function (r) {
      s.rec = 0; s.terrain = 0; s.chunks = null; s.loaded = null; s.empty = null;
      if (r !== a) cb({ id: batch.id, error: r === null || r === undefined ? 'no result' : String(r) });
      else cb({ id: batch.id, n: a.n });
    });
  },
};

// ---------------------------------------------------------------- the patch
const STATE = 'var $eaglanDwW=globalThis.__eaglanDecoWanted||{};\n' +
  'var $eaglanDw={on:$eaglanDwW.on===true,pregen:$eaglanDwW.pregen===true,verify:$eaglanDwW.verify===true,thread:false,api:null,tick:0,' +
  'rec:0,depth:0,native:0,abort:null,ops:null,rnd:null,spawned:0,wrand:null,grand:null,seenNow:null,askedNow:null,terrain:0,chunks:null,loaded:null,made:null,empty:null,gen:null,' +
  'sid:new Map(),sts:new Map(),trees:null,born:0,nextId:0,batches:new Map(),jobs:new Map(),inFlight:new Map(),players:new Map(),asked:new Map(),pgAt:-1,pgJob:null,pgR:0,pgK:0,whyNot:{},diffs:[],lastError:null,' +
  'st:{batches:0,copied:0,snapMs:0,results:0,records:0,errors:0,expired:0,none:0,late:0,notUsable:0,busy:0,changed:0,loadedDiff:0,structure:0,biome:0,used:0,writes:0,replayMs:0,threadMs:0,heights:0,trees:0,tickMs:0,checked:0,diff:0}};\n';
const SHARED = [$eaglanDwNow, $eaglanDwK, $eaglanDwHm, $eaglanDwTrees, $eaglanDwTreeState, $eaglanDwSetTrees, $eaglanDwIndexBlock, $eaglanDwSid, $eaglanDwState, $eaglanDwHash, $eaglanDwRand, $eaglanDwSetRand, $eaglanDwNo];
const GAME = [$eaglanDwTick, $eaglanDwPlanPlayers, $eaglanDwPlanPregen, $eaglanDwPost, $eaglanDwSnap, $eaglanDwTake, $eaglanDwGens, $eaglanDwStructs, $eaglanDwReplay, $eaglanDwReplayed, $eaglanDwRecBegin, $eaglanDwRecEnd];
const THREAD = [$eaglanDwExists, $eaglanDwGet, $eaglanDwRun, $eaglanDwStep, $eaglanDwFill, $eaglanDwMade, $eaglanDwDecorated];
const API = '(globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={})).decoAhead=function(){var s=$eaglanDw,r={on:s.on,pregen:s.pregen,verify:s.verify,ready:!!(s.api&&s.api.ready()),whyNot:s.whyNot,diffs:s.diffs,lastError:s.lastError};for(var k in s.st)r[k]=s.st[k];return r;};\n';
const CODE = STATE + [...SHARED, ...GAME, ...THREAD].map(String).join('\n') +
  '\nvar $eaglanDwProvider={ua:function(x,z){return $eaglanDwExists(x,z);},bk:function(x,z){return $eaglanDwGet(x,z);},bGb:function(x,z){return $eaglanDwExists(x,z)?$eaglanDwGet(x,z):null;}};\n' + API;
const WORKER_CODE = 'globalThis.__eaglanDwWorker={' + Object.entries($eaglanDwApi).map(([k, v]) => `${k}:${String(v).replace(/^(init|run)\s*/, 'function')}`).join(',') + '};\n';

// A wrapper in front of a game function: pre runs first (with the arguments), then the game's function (renamed).
const wrap = (name, args, pre) => ({ find: `function ${name}(${args}){`, replace: `function ${name}(${args}){${pre}return $eaglanDw${name}(${args});}\nfunction $eaglanDw${name}(${args}){` });
const PATCH = {
  name: 'decoration ahead',
  only: 'decoration',   // applied only with config decorationAhead or decorationAheadPregen (game-patches.js applyGamePatches)
  edits: [
    // the chunk's version and when the generator made it: fields from the start (the same object shape for every chunk)
    { find: 'a.brF=0;a.NW=null;}', replace: 'a.brF=0;a.NW=null;a.$eaglanDwH1=0;a.$eaglanDwH2=0;a.$eaglanDwBorn=0;}' },
    { find: 'case 2:CNC(o,d,p,f,c);if(B()){break _;}', replace: 'case 2:CNC(o,d,p,f,c);if(B()){break _;}$eaglanDwHash(a,(n<<4|p)<<8|g|d,o.R8.data[p<<8|g|d]);' },
    // a chunk the generator makes: Chunk(World, ChunkPrimer, x, z) (BVS), used only for the generator's chunks
    { find: 'function BVS(a,b,c,d,e){', replace: 'function BVS(a,b,c,d,e){if(!FQ())a.$eaglanDwBorn=$eaglanDw.born=$eaglanDw.born+1|0;' },
    // populate: the thread's record when it holds (or, verify mode, the game's own recorded and compared), else the game's
    { find: 'function EPT(a,b,c,d){', replace: CODE + 'function EPT(a,b,c,d){var e,f,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}' +
      '_:while(true){switch($p){case 0:e=($eaglanDw.on||$eaglanDw.pregen)?$eaglanDwTake(a,c,d):null;if(e===null){$p=1;continue _;}if($eaglanDw.verify){f=$eaglanDwRecBegin(e,a);$p=3;continue _;}$p=2;continue _;' +
      'case 1:$eaglanDwEPT(a,b,c,d);if(B()){break _;}return;' +
      'case 2:$eaglanDwReplay(a,e);if(B()){break _;}if(e.bail){$p=1;continue _;}return;' +
      'case 3:$eaglanDwEPT(a,b,c,d);if(B()){break _;}$eaglanDwRecEnd(e);return;' +
      'default:FO();}}DJ().s(a,b,c,d,e,f,$p);}\nfunction $eaglanDwEPT(a,b,c,d){' },
    // the block writes a decoration's own logic makes (and the depth: everything inside a write is the write's)
    { find: 'function FUd(a,b,c,d){', replace: 'function FUd(a,b,c,d){var s=$eaglanDw;if(s.rec===0)return $eaglanDwFUd(a,b,c,d);if(s.depth===0&&s.native===0&&!FQ())s.ops.push(1,b.k,b.u,b.m,$eaglanDwSid(c),a.coU?d|65536:d);s.depth=s.depth+1|0;var r=$eaglanDwFUd(a,b,c,d);s.depth=s.depth-1|0;return r;}\nfunction $eaglanDwFUd(a,b,c,d){' },
    // the animals' spawning: recorded with the random generator's state; the thread leaves it to the game
    { find: 'function E31(b,c,d,e,f,g,h){', replace: 'function E31(b,c,d,e,f,g,h){var s=$eaglanDw;if(s.rec===0)return $eaglanDwE31(b,c,d,e,f,g,h);if(s.depth===0&&s.native===0&&!FQ()){s.ops.push(2,c.fr,d,e,f,g);s.rnd.push($eaglanDwRand(h));s.spawned=1;}if(s.thread)return;s.depth=s.depth+1|0;s.native=s.native+1|0;$eaglanDwE31(b,c,d,e,f,g,h);s.depth=s.depth-1|0;s.native=s.native-1|0;}\nfunction $eaglanDwE31(b,c,d,e,f,g,h){' },
    { find: 'function F7l(a,b,c,d){', replace: 'function F7l(a,b,c,d){var s=$eaglanDw;if(s.rec===0)return $eaglanDwF7l(a,b,c,d);$eaglanDwNo("a forced block tick");s.depth=s.depth+1|0;var r=$eaglanDwF7l(a,b,c,d);s.depth=s.depth-1|0;return r;}\nfunction $eaglanDwF7l(a,b,c,d){' },
    // what a copy cannot answer for the game
    wrap('CQj', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a light value");'),
    wrap('DPI', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a light value");'),
    wrap('E2_', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a light value");'),
    wrap('F3Y', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a light value");'),
    wrap('CRV', 'a,b', 'if($eaglanDw.rec!==0)$eaglanDwNo("a tile entity");'),
    wrap('F6M', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a tile entity");'),
    wrap('EoI', 'a,b', 'if($eaglanDw.rec!==0)$eaglanDwNo("a tile entity");'),
    wrap('Fll', 'a,b', 'if($eaglanDw.rec!==0)$eaglanDwNo("an entity");'),
    // (the thread's world has no tick lists: a block tick asked for inside a write is the game's to keep, unless it is
    // immediate: a liquid spring's first update runs with World.scheduledUpdatesAreImmediate, coU, set)
    wrap('EZy', 'a,b,c,d', 'if($eaglanDw.rec!==0)$eaglanDwNo("a block tick");if($eaglanDw.thread){if(!a.coU)return;try{return $eaglanDwEZy(a,b,c,d);}catch(e){$eaglanDwNo("a block tick that failed on the thread",true);return;}}'),
    wrap('Cz6', 'a,b,c,d', 'if($eaglanDw.rec!==0)$eaglanDwNo("a block tick");if($eaglanDw.thread){if(!a.coU)return;try{return $eaglanDwCz6(a,b,c,d);}catch(e){$eaglanDwNo("a block tick that failed on the thread",true);return;}}'),
    wrap('EXu', 'a,b,c', 'if($eaglanDw.rec!==0)$eaglanDwNo("a neighbour update");'),
    wrap('EcW', 'a,b', 'if($eaglanDw.rec!==0)$eaglanDwNo("a light check");'),
    wrap('E0d', 'a', 'if($eaglanDw.rec!==0)$eaglanDwNo("an unseeded random generator");'),
    // the random generators: the world's at any depth; the decoration's own after the animals' spawning
    { find: 'function DF(a,b){', replace: 'function DF(a,b){var s=$eaglanDw;if(s.rec!==0&&s.native===0&&!FQ()){if(a===s.wrand)$eaglanDwNo("the world\'s random generator",true);else if(a===s.grand&&s.spawned)$eaglanDwNo("its random generator after spawning",true);}return $eaglanDwDF(a,b);}\nfunction $eaglanDwDF(a,b){' },
  ],
  requires: [
    // Chunk (Ng: its fields, the last two of its constructor; setBlockState E53 sets the block with CNC at case 2),
    // ChunkProviderGenerate (A_p: populate EPT, the world jj, its random no, settings kF, mapFeaturesEnabled o2, the
    // structure generators b8t buv bds WK Pc, provideChunk Fs1), MapGenStructure.generateStructure (F93: its walk of
    // structureMap Fy with ARu, PJ, Bp, W1; a start's box zP: dO dQ eN e3), getBiomeGenForCoords (CzN),
    // ChunkCoordIntPair (HCr), BlockPos (BJ: k u m), the falling-block flag (KDC), World.c8 (its random generator)
    'function EPT(a,b,c,d){', 'case 0:KDC=1;e=c*16|0;f=d*16|0;g=new BJ;g.k=e;g.u=0;g.m=f;b=a.jj;h=B_(g,16,0,16);$p=1;case 1:$z=CzN(b,h);',
    'if(a.kF.cgc&&a.o2){b=a.b8t;h=a.jj;n=a.no;$p=2;continue _;}if(a.kF.bEw&&a.o2){b=a.buv;h=a.jj;n=a.no;$p=3;continue _;}',
    'if(a.kF.bhQ&&a.o2){b=a.bds;h=a.jj;n=a.no;$p=4;continue _;}if(a.kF.a6K&&a.o2){b=a.WK;h=a.jj;n=a.no;$p=6;continue _;}if(a.kF.PZ&&a.o2){b=a.Pc;h=a.jj;n=a.no;$p=7;continue _;}',
    'i=new ARu;i.cc4=h;i.cx=0;i.bU5=new PJ;j=Bp(h.I_,(-1640531527));k=j^(j>>>16|0);h.I_=k;i.cc5', '=29+((k&7)<<1)|0;i.bTk=k&h.Xi;',
    'if(!i.cx){i.cx=1;i.f4=W1(i);}o=i.cx;if(!(o!=1?0:1))break;', 'h=i.f4.tf;if(h.bQO()){$p=2;continue _;}', 'q=h.zP;if(q.eN>=e&&q.dO<=j&&q.e3>=f&&q.dQ<=l?1:0)',
    'KDC=0;return;', 'function HCr(', 'case 0:a.coU=1;if(!Bz(a,c)){e=HLp.r;$p=3;continue _;}', 'a.c8=f;a.jl=Ea();', 'function Hn(){var a=this;G.call(a);a.i=BN;a.jo=0;a.dPP=0.0;a.fT=0;}',
    // block states: Block.getBlockState (FN0: hQ), its valid states (DH7: iP), getIdFromBlock (EFh), getBlockById (EK1)
    'function FN0(a){', 'function DH7(a){return a.iP;}', 'function EFh(b){', 'function EK1(b){',
    // the world (via the terrain threads' patch: $eaglanTgWorld; HMl the server, gc its worlds, C5 the chunk provider
    // with its map tA; f1 the player list e1; a player's dimension tk, position D E, view centre cN9 cN8), the player
    // manager (Ly: view radius rq), loaded chunks (Ld, $eaglanPgKey), the pre-generation job ($eaglanPregen,
    // $eaglanPgRingPos), path ahead's end-of-tick hook ($eaglanTickEnd)
    'function $eaglanTgWorld()', 'function $eaglanPgKey(', 'function $eaglanPgRingPos(', 'var $eaglanPregen', 'function $eaglanTickEnd()',
    'c=b.D;d=(c|0)>>4;e=b.E;f=(e|0)>>4;g=b.cN9;c=g-c;h=b.cN8;e=h-e;if(c*c+e*e>=64.0){i=(g|0)>>4;j=(h|0)>>4;k=a.rq;',
    'a.Ly=b;', 'function B1o(a,b,c,d){', 'function G3L(a,b,c){var d;a.Y6=(-1);a.a_l=b;', 'd=new UH;d.zw=Cb(2048);a.VL=d;if(c){d=new UH;d.zw=Cb(2048);a.T6=d;}}',
  ],
  skipped: 'every chunk is decorated by the game thread itself, as before',
};
// The thread's own side, next to the game's entry (as the terrain threads' TERRAIN_WORKER_EDIT).
const WORKER_EDIT = { find: '$rt_exports.main=$rt_mainStarter(HdT);', replace: WORKER_CODE + '$rt_exports.main=$rt_mainStarter(HdT);' };

module.exports = { PATCH, WORKER_EDIT };
