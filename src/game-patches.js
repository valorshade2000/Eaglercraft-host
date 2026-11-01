'use strict';
const DECO = require('./deco-patch');
// Corrections to the vendored EaglercraftX u53 game code (classes.js), applied to its text in memory
// right before the worker evaluates it; the file on disk stays unchanged. classes.js is one UMD
// closure, so its functions cannot be replaced from outside. Each correction must find its exact
// original text once, or it is skipped with a log line: another build is never patched blindly.

// ---------------------------------------------------------------- world pre-generation
// The hook below ("world pre-generation"). These functions never run in this file: their source
// text is inserted into classes.js, where the game's own names exist (TeaVM names from the game's
// name table; checked by the patch's anchors):
//   EIs   ChunkProviderServer.loadChunk(x, z): from disk, or generated and populated
//   Ld    LongObjectHashMap.get       Ef0  LongHashSet.add      HVj, HVi  chunks generated / read (the game's counters)
//   w.C5  WorldServer.theChunkProviderServer: .tA loaded chunks (map), .zC chunks to unload (set), .bdn loaded chunks (LinkedList: el size, nb last, entries jy item, brJ previous)
//   w.Ly.beT  PlayerManager.playerInstances (chunks players see)     w.bR  WorldInfo (bAD/bAf: spawn x/z)
//   a     MinecraftServer: gc worldServers, bGw the time the current tick was due, bXY the game rule loadSpawnChunks
//   D7o   Chunk.func_150809_p, as the chunk's tick calls it (func_150804_b, while IU terrain populated and
//         not bdH light populated): the chunk's first lighting (Alfheim's initChunkLighting, sets brF =
//         lighting initialised) if not done yet; then bdH = light populated, but only if its eight
//         neighbours are loaded with brF set. The chunk is saved with LightPopulated = bdH
//         (AnvilChunkLoader.writeChunkToNBT writes Alfheim's brF first, then vanilla's bdH over it),
//         and loaded with both set from it: a chunk saved before bdH is lit again when a player comes.
// A chunk is loaded with the game's own loadChunk, on the game thread, between ticks' work, like a
// chunk a player walks into. Rings round the spawn chunk, nearest first. D7o is called for it once its
// eight neighbours are loaded (lighting), and again once theirs has been called (light populated). It
// is handed to the game's own unloading (dropChunk: saved, then unloaded) once every chunk within
// three of it has been loaded and those calls are done: then its neighbours were all there when
// trees, ores and structures that cross chunk borders were placed and when it was lit, it was there
// for its neighbours' second call, and about three rings are loaded at a time.

function $eaglanPgKey(x, z) { return Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)); }   // ChunkCoordIntPair.chunkXZ2Int
function $eaglanPgId(x, z) { return (x + 2097152) * 4194304 + (z + 2097152); }
function $eaglanPgXZ(id) { var x = Math.floor(id / 4194304); return [x - 2097152, id - x * 4194304 - 2097152]; }
function $eaglanPgRing(p, x, z) { return Math.max(Math.abs(x - p.cx), Math.abs(z - p.cz)); }
// The k-th chunk of ring r (offsets from the centre), going round the square.
function $eaglanPgRingPos(r, k) {
  if (r === 0) return [0, 0];
  var s = Math.floor(k / (2 * r)), o = k % (2 * r);
  return s === 0 ? [o - r, -r] : s === 1 ? [r, o - r] : s === 2 ? [r - o, r] : [-r, r - o];
}
function $eaglanPgQueue(p, id) { if (p.owned.has(id) && !p.queued.has(id)) { p.queued.add(id); p.dropQ.push(id); } }
// Every chunk within r of (x, z) in the area has been loaded.
function $eaglanPgAround(p, x, z, r) {
  for (var ex = -r; ex <= r; ex++) {
    for (var ez = -r; ez <= r; ez++) {
      if ($eaglanPgRing(p, x + ex, z + ez) > p.rings) continue;   // outside the area: never loaded
      if (!p.seen.has($eaglanPgId(x + ex, z + ez))) return false;
    }
  }
  return true;
}
// (x, z) is done. A chunk next to it whose eight neighbours are all done gets its first call; a
// chunk near it of which every chunk within three is done is no longer needed once the calls queued
// by then are done (they include its neighbours' second ones: theirs need the chunks within two).
// The outermost ring is only loaded for its neighbours, and the one inside it can be lit but not
// light populated: its outer neighbours are never lit.
function $eaglanPgDone(p, x, z) {
  p.seen.add($eaglanPgId(x, z));
  for (var dx = -3; dx <= 3; dx++) {
    for (var dz = -3; dz <= 3; dz++) {
      var qx = x + dx, qz = z + dz, q = $eaglanPgId(qx, qz);
      if (!p.owned.has(q)) continue;
      if (dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1 && !p.lightSet.has(q) && $eaglanPgRing(p, qx, qz) < p.rings && $eaglanPgAround(p, qx, qz, 1)) { p.lightSet.add(q); p.lightQ.push(q); p.lightWait.add(q); }
      if (!p.queued.has(q) && $eaglanPgAround(p, qx, qz, 3)) $eaglanPgQueue(p, q);
    }
  }
}
// (x, z) had its first call (or needs none: lit already, not populated, or gone). A chunk next to it,
// or itself, whose eight neighbours have all had theirs gets its second call.
function $eaglanPgLightDone(p, x, z) {
  p.lightDone.add($eaglanPgId(x, z));
  for (var dx = -1; dx <= 1; dx++) {
    for (var dz = -1; dz <= 1; dz++) {
      var qx = x + dx, qz = z + dz, q = $eaglanPgId(qx, qz), all = true;
      if (!p.owned.has(q) || p.settleSet.has(q) || $eaglanPgRing(p, qx, qz) >= p.rings - 1) continue;
      for (var ex = -1; ex <= 1 && all; ex++) for (var ez = -1; ez <= 1; ez++) if (!p.lightDone.has($eaglanPgId(qx + ex, qz + ez))) { all = false; break; }
      if (all) { p.settleSet.add(q); p.settleQ.push(q); p.settleWait.add(q); }
    }
  }
}
// The next chunk for its first call, or null: loaded, populated (IU), not lit yet (brF), its eight
// neighbours loaded.
function $eaglanPgNextLight(b) {
  var p = $eaglanPregen;
  while (p.lightQ.length) {
    var id = p.lightQ.shift(), c = $eaglanPgXZ(id), x = c[0], z = c[1], ch = Ld(b.tA, $eaglanPgKey(x, z)), all = true;
    p.lightWait.delete(id);
    if (ch !== null && ch.IU && !ch.brF) {
      for (var dx = -1; dx <= 1 && all; dx++) for (var dz = -1; dz <= 1; dz++) if (Ld(b.tA, $eaglanPgKey(x + dx, z + dz)) === null) { all = false; break; }
      if (all) return ch;
    }
    $eaglanPgLightDone(p, x, z);
  }
  return null;
}
// The next chunk for its second call, or null: loaded, lit (brF), not light populated yet (bdH).
function $eaglanPgNextSettle(b) {
  var p = $eaglanPregen;
  while (p.settleQ.length) {
    var id = p.settleQ.shift(), c = $eaglanPgXZ(id), ch = Ld(b.tA, $eaglanPgKey(c[0], c[1]));
    p.settleWait.delete(id);
    if (ch !== null && ch.bdH) { p.lit++; continue; }
    if (ch === null || !ch.brF) { p.unlit++; continue; }
    return ch;
  }
  return null;
}
function $eaglanPgAdvance(p) {
  if (++p.k < (p.ring === 0 ? 1 : 8 * p.ring)) return;
  p.k = 0; p.ring++;
  // Forget rings no longer needed for the checks above, and hand back anything else loaded on the
  // way (e.g. a neighbour a tree reached into) once the work is four rings further out.
  p.seen.forEach(function (id) { var c = $eaglanPgXZ(id); if ($eaglanPgRing(p, c[0], c[1]) < p.ring - 8) p.seen.delete(id); });
  p.lightDone.forEach(function (id) { var c = $eaglanPgXZ(id); if ($eaglanPgRing(p, c[0], c[1]) < p.ring - 8) p.lightDone.delete(id); });
  p.owned.forEach(function (id) { var c = $eaglanPgXZ(id), r = $eaglanPgRing(p, c[0], c[1]); if (r < p.ring - 4 || r > p.rings) $eaglanPgQueue(p, id); });
  if (p.ring > p.rings) { p.running = false; p.done = true; p.endedAt = Date.now(); p.owned.forEach(function (id) { $eaglanPgQueue(p, id); }); }
}
// After loadChunk: the chunks it loaded (itself, and any neighbour the game loaded on the way) are
// the host's to hand back; count what was generated or read.
function $eaglanPgLoaded(b, x, z) {
  var p = $eaglanPregen, bf = p.before; if (bf === null) return;
  var n = b.bdn.el - bf[0], node = b.bdn.nb; p.before = null;
  for (; n > 0 && node !== null; n--, node = node.brJ) if (node.jy) p.owned.add($eaglanPgId(node.jy.sk, node.jy.rL));
  if (bf[4] !== p.job) return;   // asked for by a job that was replaced meanwhile: only handed back
  p.generated += HVj - bf[1]; p.read += HVi - bf[2]; p.tokens -= 1;
  p.lastMs = HHE() - bf[3]; p.spentMs += p.lastMs; if (p.lastMs > p.maxMs) p.maxMs = p.lastMs;
  $eaglanPgDone(p, x, z); $eaglanPgAdvance(p);
}
// The game failed to load or generate a chunk: the job stops (status says why); the world goes on.
function $eaglanPgFailed(e, x, z) {
  var p = $eaglanPregen, m; try { var je = D(e); m = je && je.l ? $rt_ustr(je.l) : String(e && e.message || e); } catch (x2) { m = String(e); }
  p.error = 'the game could not load or generate chunk ' + x + ', ' + z + ': ' + m; p.before = null;
  if (p.running) { p.running = false; p.stopped = true; p.endedAt = Date.now(); p.owned.forEach(function (id) { $eaglanPgQueue(p, id); }); }
}
// A D7o call that may still need (x, z) loaded is waiting: the first call of a chunk within two
// (its neighbours' second calls need it lit, and they need this chunk), or the second call of a
// chunk within one.
function $eaglanPgWaiting(p, x, z) {
  for (var dx = -2; dx <= 2; dx++) {
    for (var dz = -2; dz <= 2; dz++) {
      var q = $eaglanPgId(x + dx, z + dz);
      if (p.lightWait.has(q) || (dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1 && p.settleWait.has(q))) return true;
    }
  }
  return false;
}
// The next chunk to unload, as ChunkProviderServer.dropChunk decides, or null. One that a waiting
// D7o call may need goes back to the end of the queue (at most 32 looked at per call).
function $eaglanPgNextDrop(a, b) {
  var p = $eaglanPregen, w = a.gc.data[0], later = [], k = null;
  for (var n = p.dropQ.length; n > 0 && k === null && later.length < 32; n--) {
    var id = p.dropQ.shift();
    if (!p.owned.has(id)) { p.queued.delete(id); continue; }
    var c = $eaglanPgXZ(id), x = c[0], z = c[1];
    if ($eaglanPgWaiting(p, x, z)) { later.push(id); continue; }
    p.queued.delete(id); p.owned.delete(id); p.lightSet.delete(id); p.settleSet.delete(id);
    var key = $eaglanPgKey(x, z);
    if (Ld(b.tA, key) === null) continue;   // already unloaded
    // A player sees it: it stays, and the game unloads (and lights) it as usual.
    if (Ld(w.Ly.beT, Dq(U(L(x), L(2147483647)), Cw(U(L(z), L(2147483647)), 32))) !== null) { p.keptWatched++; continue; }
    // With the game rule loadSpawnChunks the spawn area stays loaded (World.isSpawnChunk).
    if (a.bXY) { var sx = x * 16 + 8 - w.bR.bAD(), sz = z * 16 + 8 - w.bR.bAf(); if (sx >= -128 && sx <= 128 && sz >= -128 && sz <= 128) { p.keptSpawn++; continue; } }
    k = key;
  }
  for (var i = 0; i < later.length; i++) p.dropQ.push(later[i]);
  return k;
}
// Called at the start of every tick, before the worlds unload what is queued. The game's save
// (WorldServer.saveAllChunks, every 45 s and on save-all) queues every chunk no player sees for
// unloading; the chunks of the job not handed back yet (also those waiting in its own queue) are
// taken back out (LongHashSet.remove), or the ones round the edge of the work would be unloaded
// before their neighbours exist (unpopulated) or are lit (unlit). The job unloads them itself.
// It looks through the smaller of the two: the game's queue (zC: keys tq, 0 = empty slot; s7 =
// chunk 0, 0 queued) or the chunks loaded here.
function $eaglanPgProtect(a) {
  var p = $eaglanPregen, w = p === null || a.gc === null ? null : a.gc.data[0];
  if (!w || !p.owned.size) return;
  var z = w.C5.zC, n = z.sx + (z.s7 ? 1 : 0), found = [], i, id;
  if (!n) return;
  if (n < p.owned.size) {
    var keys = z.tq.data;
    for (i = 0; i < keys.length; i++) { if (DX(keys[i], BN)) continue; id = $eaglanPgId(R(keys[i]), HE8(keys[i])); if (p.owned.has(id)) found.push(keys[i]); }
    id = $eaglanPgId(0, 0); if (z.s7 && p.owned.has(id)) found.push(BN);
  } else p.owned.forEach(function (q) { var c = $eaglanPgXZ(q); found.push($eaglanPgKey(c[0], c[1])); });
  for (i = 0; i < found.length; i++) if (ABh(z, found[i])) p.protected++;
}
// Nobody on the server: its player list (the config manager f1: e1, an ArrayList, b its size) is
// empty. Only while the job's fast option is on (the default; config pregenFastWhenEmpty false: off).
function $eaglanPgEmpty(a) { var p = $eaglanPregen, m = a.f1; return p.fast && !!m && !!m.e1 && m.e1.b === 0; }
// The job's next chunk to load in this tick, or null. At most p.rate per second, none while the tick
// is already late, and none while the calls for the chunks loaded so far are behind:
//   - with players on the server, at most one per tick (players first);
//   - with nobody on it (p.empty), as many as fit before the tick is late (at most 16), so that the
//     time the game thread would wait for its next tick goes to the job. A tick that is late loads
//     none, so the server is never more than one chunk's work behind and keeps 20 ticks per second.
function $eaglanPgNextLoad(a, b) {
  var p = $eaglanPregen; if (!p.running) return null;
  var now = HHE();
  if (!p.loads) { p.tokens = Math.min(p.empty ? Math.max(1, p.rate / 10) : 1, p.tokens + ((now - p.last) * p.rate) / 1000); p.last = now; }
  if (p.tokens < 1) return null;
  if (now - Dj(a.bGw) > p.maxBehindMs) { if (!p.loads) p.yielded++; return null; }
  if (p.loads && (!p.empty || p.loads >= 16)) return null;
  if (p.lightQ.length + p.settleQ.length > (p.empty ? 16 : 8)) return null;
  for (var guard = 0; guard < 512 && p.running; guard++) {
    var o = $eaglanPgRingPos(p.ring, p.k), x = p.cx + o[0], z = p.cz + o[1];
    if (Ld(b.tA, $eaglanPgKey(x, z)) !== null) {
      // Loaded already (by the game, e.g. near a player, or on the way by this job): it is
      // lit and handed back like the others, unless a player sees it ($eaglanPgNextDrop).
      p.alreadyLoaded++; p.owned.add($eaglanPgId(x, z)); $eaglanPgDone(p, x, z);
      $eaglanPgAdvance(p); continue;
    }
    // Regions (main instance): only a chunk of a cell this instance has. A cell no instance has is asked for and the
    // job waits a tick for it; a cell another instance has is left out (its players are not moved, nobody waits):
    // the next job after they have gone fills it in. (region-gate.js pregenCell)
    var rg = globalThis.__eaglanRegionGate;
    if (rg) {
      var st = rg.pregenCell(x, z);
      if (st === 'wait') return null;
      if (st === 'skip') { p.skippedRegion++; $eaglanPgDone(p, x, z); $eaglanPgAdvance(p); continue; }
    }
    if (p.loads) p.extraLoads++;
    p.loads++; p.before = [b.bdn.el, HVj, HVi, now, p.job];
    return [x, z];
  }
  return null;
}
// Called once per tick (MinecraftServer.tick, after the worlds' work): the chunks of $eaglanPgNextLoad,
// then the lighting calls and the unloading. Written as the game's code is (TeaVM): loadChunk can pause
// for a disk read, and this function then resumes there.
function $eaglanPregenStep(a) {
  var b, c, d, e, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); e = $T.l(); d = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: {
        var p = $eaglanPregen, w = a.gc === null ? null : a.gc.data[0];
        if (p === null || !w || (!p.running && !p.dropQ.length && !p.lightQ.length && !p.settleQ.length)) return;
        b = w.C5; p.drops = 0; p.lights = 0; p.settles = 0; p.loads = 0; p.empty = $eaglanPgEmpty(a);
        if (p.empty && p.running) p.emptyTicks++;
        var n = $eaglanPgNextLoad(a, b);
        if (n !== null) { c = n[0]; d = n[1]; $p = 1; continue _; }
        $p = 2; continue _;
      }
      case 1: {
        try { $z = EIs(b, c, d); if (B()) { break _; } }
        catch ($e) { $eaglanPgFailed($e, c, d); $p = 2; continue _; }
        $eaglanPgLoaded(b, c, d);
        var n1 = $eaglanPgNextLoad(a, b);
        if (n1 !== null) { c = n1[0]; d = n1[1]; $p = 1; continue _; }
        $p = 2;
      }
      case 2: {
        // The D7o calls come first: first ones at most 2 per tick and not while the tick is late
        // (also after the loads above); second ones, which only check the neighbours, at most 8.
        // Then unloading (at most 4), of chunks no waiting call needs; it waits while the tick is
        // late, unless many chunks are waiting to be unloaded while the job runs. With nobody on the
        // server, first calls at most 4 and unloading at most 8, also while the tick is late: they
        // keep up with the loads, and are short.
        var q = $eaglanPregen, late = HHE() - Dj(a.bGw) > q.maxBehindMs, many = q.running && q.dropQ.length >= 64;
        if (late && !many && !q.empty) return;
        if ((!late || q.empty) && q.lights < (q.empty ? 4 : 2)) { c = $eaglanPgNextLight(b); if (c !== null) { q.lightAt = HHE(); $p = 4; continue _; } }
        if (q.settles < 8) { c = $eaglanPgNextSettle(b); if (c !== null) { q.lightAt = HHE(); $p = 5; continue _; } }
        e = $eaglanPgNextDrop(a, b); if (e === null) return;
        $p = 3; continue _;
      }
      case 4:
        try { D7o(c); if (B()) { break _; } } catch ($e) {}   // failed: not lit (counted by the second call)
        $eaglanPregen.lightMs += HHE() - $eaglanPregen.lightAt; $eaglanPregen.lights++;
        $eaglanPgLightDone($eaglanPregen, c.sk, c.rL);
        $p = 2; continue _;
      case 5:
        try { D7o(c); if (B()) { break _; } } catch ($e) {}
        $eaglanPregen.lightMs += HHE() - $eaglanPregen.lightAt; $eaglanPregen.settles++;
        if (c.bdH) $eaglanPregen.lit++; else $eaglanPregen.unlit++;
        $p = 2; continue _;
      case 3:
        Ef0(b.zC, e); if (B()) { break _; }
        $eaglanPregen.dropped++;
        if (++$eaglanPregen.drops < ($eaglanPregen.empty ? 8 : 4)) { $p = 2; continue _; }
        return;
      default: FO();
    }
  }
  DJ().s(a, b, c, d, e, $p);
}
function $eaglanPgStatus() {
  var p = $eaglanPregen; if (p === null) return null;
  var processed = p.ring === 0 ? p.k : Math.min(p.total, (2 * p.ring - 1) * (2 * p.ring - 1) + p.k);
  return { running: p.running, done: p.done, stopped: p.stopped, center: [p.cx * 16 + 8, p.cz * 16 + 8], cx: p.cx, cz: p.cz, k: p.k, radius: p.radius, rate: p.rate, ring: p.ring, rings: p.rings, processed: processed, total: p.total,
    generated: p.generated, read: p.read, alreadyLoaded: p.alreadyLoaded, lit: p.lit, unlit: p.unlit, dropped: p.dropped, keptFromSave: p.protected, keptWatched: p.keptWatched, keptSpawn: p.keptSpawn, loadedNow: p.owned.size, pendingUnloads: p.dropQ.length, pendingLights: p.lightQ.length + p.settleQ.length,
    yieldedTicks: p.yielded, fast: p.fast, empty: p.empty, emptyTicks: p.emptyTicks, extraLoads: p.extraLoads, skippedRegion: p.skippedRegion, error: p.error, spentMs: Math.round(p.spentMs + p.lightMs), lightMs: Math.round(p.lightMs), maxMs: Math.round(p.maxMs), lastMs: Math.round(p.lastMs), startedAt: p.startedAt, endedAt: p.endedAt };
}
// The host's controls: start (radius in blocks round the world spawn, rate in chunks per second;
// fromRing to resume after a restart; fast: false loads one chunk per tick also while nobody is on the
// server), stop (what is loaded is handed back gradually) and status.
var $eaglanPgApi = {
  version: 1,
  start: function (o) {
    var s = HMl; if (s === null || s.gc === null || !s.gc.data[0]) return { error: 'the world is not loaded' };
    // +2: the ring at the radius is populated once its outer neighbours exist, and light populated
    // once theirs are lit, which needs one more ring.
    var w = s.gc.data[0], old = $eaglanPregen, rings = Math.ceil(o.radius / 16) + 2;
    $eaglanPregen = { running: true, done: false, stopped: false, cx: w.bR.bAD() >> 4, cz: w.bR.bAf() >> 4, radius: o.radius, rings: rings, total: (2 * rings + 1) * (2 * rings + 1),
      rate: o.rate, maxBehindMs: o.maxBehindMs || 50, ring: Math.min(rings, o.fromRing || 0), k: 0, tokens: 1, last: HHE(), before: old ? old.before : null, job: old ? old.job + 1 : 1, drops: 0, error: null,
      fast: o.fast !== false, empty: false, loads: 0, emptyTicks: 0, extraLoads: 0, skippedRegion: 0,
      seen: new Set(), owned: old ? old.owned : new Set(), queued: old ? old.queued : new Set(), dropQ: old ? old.dropQ : [], lightQ: old ? old.lightQ : [], lightSet: old ? old.lightSet : new Set(), lights: 0,
      lightDone: old ? old.lightDone : new Set(), settleQ: old ? old.settleQ : [], settleSet: old ? old.settleSet : new Set(), settles: 0,
      lightWait: old ? old.lightWait : new Set(), settleWait: old ? old.settleWait : new Set(),
      alreadyLoaded: 0, generated: 0, read: 0, lit: 0, unlit: 0, dropped: 0, protected: 0, keptWatched: 0, keptSpawn: 0, yielded: 0, spentMs: 0, lightMs: 0, lightAt: 0, maxMs: 0, lastMs: 0, startedAt: Date.now(), endedAt: null };
    return $eaglanPgStatus();
  },
  stop: function () {
    var p = $eaglanPregen; if (p === null) return null;
    if (p.running) { p.running = false; p.stopped = true; p.endedAt = Date.now(); p.owned.forEach(function (id) { $eaglanPgQueue(p, id); }); }
    return $eaglanPgStatus();
  },
  status: function () { return $eaglanPgStatus(); },
};
const PREGEN_CODE = 'var $eaglanPregen=null;\n' +
  [$eaglanPgKey, $eaglanPgId, $eaglanPgXZ, $eaglanPgRing, $eaglanPgRingPos, $eaglanPgQueue, $eaglanPgAround, $eaglanPgDone, $eaglanPgLightDone, $eaglanPgNextLight, $eaglanPgNextSettle, $eaglanPgAdvance, $eaglanPgLoaded, $eaglanPgFailed, $eaglanPgWaiting, $eaglanPgNextDrop, $eaglanPgProtect, $eaglanPgEmpty, $eaglanPgNextLoad, $eaglanPregenStep, $eaglanPgStatus].map(String).join('\n') +
  '\nglobalThis.__eaglanPregen={' + Object.entries($eaglanPgApi).map(([k, v]) => `${k}:${typeof v === 'function' ? String(v).replace(/^(start|stop|status)\s*/, 'function') : v}`).join(',') + '};\n';

// ---------------------------------------------------------------- autosave spread over ticks
// The hook below ("spread autosave"). Every 900 ticks MinecraftServer.tick (Gnh) saves the players'
// data, then calls saveAllWorlds(true) (Dq_; nothing while a world is being deleted, dj7), which
// does for each world what WorldServer.saveAllChunks(true) (CgP) does:
//   - level.dat (saveLevel, Dl9);
//   - every loaded chunk that needs it (ChunkProviderServer.saveChunks(true), DeY: needsSaving(true)
//     ejC, i.e. had entities since its last save or was changed; then setLastSaveTime B4f with
//     getTotalWorldTime ABc, EaglerChunkLoader.saveChunk DZt, the write counter HVk, isModified uv =
//     0; saveExtraChunkData GaV does nothing in u53);
//   - dropChunk for every loaded chunk no player sees (PlayerManager.playerInstances, Ly.beT), except
//     spawn chunks the world keeps (canRespawnHere eA.Un, World.isSpawnChunk EZO): the game then
//     unloads those, up to 100 per tick, saving each again.
// All in that one tick: with 12 players 300-500 chunks, 0.6-0.9 s, then ticks of 100-240 ms while
// the dropped chunks are unloaded. With the hook the autosave tick saves the players' data as
// before; the rest runs at the end of that tick and the following ones, with the same calls:
// level.dat, then the chunks (as many per tick as fit until the tick is 40 ms old, at least one),
// then the drops (8 per tick).
// save-all, the web page's "Save now" and the save when the world stops call saveAllWorlds or
// saveAllChunks themselves and still save everything at once. Config "spreadAutosave": false
// (globalThis.__eaglanSpreadAutosave, set by worker-runtime.js) keeps the game's own autosave.
// Chunks: a world's ChunkProviderServer is C5 (loaded chunks tA by key, list bdn: fn first, iZ next,
// jy item; queue to unload zC; chunk loader bdj; worldObj rZ with dWo = disableLevelSaving).

function $eaglanAsKey(x, z) { return Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)); }   // ChunkCoordIntPair.chunkXZ2Int
// The loaded chunks of the worlds that can be saved, as [world, chunk].
function $eaglanAsChunks(a) {
  var list = [], ws = a.gc === null ? [] : a.gc.data;
  if (a.dj7) return list;
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i]; if (w === null || w.C5.rZ.dWo) continue;   // ChunkProviderServer.canSave
    for (var n = w.C5.bdn.fn; n !== null; n = n.iZ) if (n.jy) list.push([w, n.jy]);
  }
  return list;
}
// The autosave tick, in place of saveAllWorlds(true): the work starts in the next tick.
function $eaglanAsStart(a) {
  var s = $eaglanAutosave;
  if (s.phase) s.unfinished++;   // the last one was not done yet: this one starts over with every chunk
  s.phase = 1; s.rounds++; s.cur = { startedAt: Date.now(), ticks: 0, saved: 0, dropped: 0, mostInATick: 0 };
}
function $eaglanAsFailed(e, what) {
  var s = $eaglanAutosave, m; try { var je = D(e); m = je && je.l ? $rt_ustr(je.l) : String(e && e.message || e); } catch (x2) { m = String(e); }
  if (++s.failed <= 5) console.error('[autosave] could not save ' + what + ': ' + m);
}
// Called once per tick, at its end (MinecraftServer.tick, after all its work, before its time is
// taken). Written as the game's code is (TeaVM): a save can pause for the write, and this function
// then resumes there.
function $eaglanAutosaveStep(a) {
  var b, c, d, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); d = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: {
        var s = $eaglanAutosave;
        if (!s.phase) return;
        s.n = 0; s.cur.ticks++;
        if (s.phase === 1) { s.list = $eaglanAsChunks(a); s.pos = 0; s.wi = 0; s.phase = 2; }
        $p = s.phase === 2 ? 1 : s.phase === 3 ? 3 : 8; continue _;
      }
      case 1: {   // level.dat of each world
        var s1 = $eaglanAutosave, ws = a.gc.data;
        while (s1.wi < ws.length && (ws[s1.wi] === null || ws[s1.wi].C5.rZ.dWo || a.dj7)) s1.wi++;
        if (s1.wi >= ws.length) { s1.phase = 3; $p = 3; continue _; }
        b = ws[s1.wi++]; $p = 2;
      }
      case 2:
        try { Dl9(b); if (B()) { break _; } } catch ($e) { $eaglanAsFailed($e, 'level.dat'); }
        $p = 1; continue _;
      case 3: {   // the next chunk, while the tick has time
        var s3 = $eaglanAutosave;
        while (s3.pos < s3.list.length) {
          if (s3.n >= 64 || (s3.n > 0 && HHE() - Dj(a.bGw) > 40)) return;
          var e3 = s3.list[s3.pos++]; b = e3[0]; c = e3[1];
          if (Ld(b.C5.tA, $eaglanAsKey(c.sk, c.rL)) !== c) continue;   // unloaded meanwhile, and saved then
          $p = 4; continue _;
        }
        // All saved: now the chunks no player sees (the loaded ones of this moment, as saveAllChunks).
        s3.phase = 4; s3.list = $eaglanAsChunks(a); s3.pos = 0;
        $p = 8; continue _;
      }
      case 4:
        $z = c.ejC(1); if (B()) { break _; }   // Chunk.needsSaving(true)
        if (!$z) { $p = 3; continue _; }
        d = b.C5.bdj; if (d === null) { c.uv = 0; $p = 3; continue _; }
        $p = 5;
      case 5:
        try { B4f(c, ABc(b)); if (B()) { break _; } }
        catch ($e) { $eaglanAsFailed($e, 'chunk ' + c.sk + ', ' + c.rL); c.uv = 0; $p = 3; continue _; }
        $p = 6;
      case 6:
        try { DZt(d, b, c); if (B()) { break _; } }
        catch ($e) { $eaglanAsFailed($e, 'chunk ' + c.sk + ', ' + c.rL); c.uv = 0; $p = 3; continue _; }
        $p = 7;
      case 7: {
        Wz(); if (B()) { break _; }
        HVk = HVk + 1 | 0; c.uv = 0;
        var s7 = $eaglanAutosave; s7.n++; s7.cur.saved++; if (s7.n > s7.cur.mostInATick) s7.cur.mostInATick = s7.n;
        $p = 3; continue _;
      }
      case 8: {   // dropChunk, as saveAllChunks does it, 8 per tick
        var s8 = $eaglanAutosave;
        while (s8.pos < s8.list.length) {
          if (s8.n >= 8) return;
          var e8 = s8.list[s8.pos++]; b = e8[0]; c = e8[1];
          if (Ld(b.C5.tA, $eaglanAsKey(c.sk, c.rL)) !== c) continue;
          if (Ld(b.Ly.beT, Dq(U(L(c.sk), L(2147483647)), Cw(U(L(c.rL), L(2147483647)), 32))) !== null) continue;   // a player sees it
          $p = b.C5.rZ.eA.Un() ? 9 : 10; continue _;
        }
        s8.phase = 0; s8.list = []; s8.cur.endedAt = Date.now(); s8.last = s8.cur; s8.done++;
        return;
      }
      case 9:
        $z = EZO(b.C5.rZ, c.sk, c.rL); if (B()) { break _; }
        if ($z) { $p = 8; continue _; }   // a spawn chunk the world keeps loaded
        $p = 10;
      case 10: {
        Ef0(b.C5.zC, $eaglanAsKey(c.sk, c.rL)); if (B()) { break _; }
        var s10 = $eaglanAutosave; s10.n++; s10.cur.dropped++;
        $p = 8; continue _;
      }
      default: FO();
    }
  }
  DJ().s(a, b, c, d, $p);
}
function $eaglanAsStatus() {
  var s = $eaglanAutosave;
  return { on: s.on, running: !!s.phase, rounds: s.rounds, done: s.done, unfinished: s.unfinished, failed: s.failed, last: s.last, current: s.phase ? s.cur : null };
}
// "vanilla mob caps": the chunks Minecraft 1.8.8 counts round the players for the mob caps (see the patch). Per call of
// the spawner (start), then per player (player(cx, cz, viewDistance)): below a view distance of 8 the spawner's own
// count (within the view distance) is replaced (own) by vanilla's: the chunks within 8 of the player not remembered yet,
// the inner 15 x 15 of them remembered for the next players. From 8 up the spawner counts itself, over 8.
const MOB_CAPS_CODE = 'var $eaglanMobCaps={on:globalThis.__eaglanMobCaps===true,own:false,seen:new Set(),' +
  'start:function(){this.own=false;if(this.seen.size)this.seen.clear();},' +
  'player:function(cx,cz,vd){this.own=vd<8;if(!this.own)return 0;var n=0,s=this.seen;for(var dx=-8;dx<=8;dx++)for(var dz=-8;dz<=8;dz++){' +
    'var key=(cx+dx+33554432)*67108864+(cz+dz+33554432);if(s.has(key))continue;n++;if(dx>-8&&dx<8&&dz>-8&&dz<8)s.add(key);}return n;}};\n';
// "players sleeping percentage": the game rule playersSleepingPercentage of Minecraft 1.17 in this 1.8.8 game (see the
// patch). pct: the world's rule (GameRules: the world info's bR.gv(), its map fO of Value dp, integer Gu; a rule lookup as
// the game's), null when the world has none or 100: then the game's own code decides, unchanged. need: of the players who
// are not spectators (ItemInWorldManager l3, game type qE, SPECTATOR HLu), how many must sleep: at least one.
const SLEEP_CODE = 'var $eaglanSleep={key:null,' +
  'pct:function(w){if(this.key===null)this.key=$rt_str("playersSleepingPercentage");var b=w.bR.gv().fO.bZ,d;' +
    'while(b!==null){d=GO(this.key,b.cr);if(!d)break;b=d>=0?b.M:b.bW;}var v=b===null?null:b.dp;if(v===null)return null;var p=v.Gu|0;return p===100?null:p;},' +
  'need:function(p,active){return Math.max(1,Math.ceil(active*p/100));},' +
  // areAllPlayersAsleep (B$Q) with the rule, every tick (so a new value counts at once, as in 1.17): enough of the active
  // players asleep for 100 ticks (isPlayerSleeping nu, sleepTimer uY; asleep that long means in bed too)
  'asleep:function(w,p){var l=w.pD,active=0,deep=0;for(var i=0;i<l.b;i++){var q=l.f.data[i];if(q.l3&&q.l3.qE===HLu)continue;active++;if(q.nu&&q.uY>=100)deep++;}return deep>=this.need(p,active)?1:0;}};\n';
const AUTOSAVE_CODE = 'var $eaglanAutosave={on:globalThis.__eaglanSpreadAutosave!==false,phase:0,rounds:0,done:0,unfinished:0,failed:0,list:[],pos:0,wi:0,n:0,cur:null,last:null};\n' +
  [$eaglanAsKey, $eaglanAsChunks, $eaglanAsStart, $eaglanAsFailed, $eaglanAutosaveStep, $eaglanAsStatus].map(String).join('\n') +
  '\nglobalThis.__eaglanAutosave={version:1,status:$eaglanAsStatus};\n';

// ---------------------------------------------------------------- multi-core packets and saves
// The hooks for the multi-core mode (multicore.js). While it is on:
//   - a LAN packet over 1 KB is handed to the host uncompressed, through the same postMessage that
//     carries every packet (so the order stays); the host compresses and frames it on another core.
//   - a chunk file is written uncompressed, as [header][NBT]: $eaglanZSaveHead puts the 12-byte
//     marker (idb-sqlite.js RAW_MAGIC) and room for the length at the start of the file's fresh
//     buffer, the game's own CompressedStreamTools.write (GQr) writes the NBT after it, and
//     $eaglanZSaveTail fills in the length. The storage layer gzips it on another core.
// Off ($eaglanZ.on false): the game's own code.
//   EPd  PacketBuffer.array (the packet is in its first n bytes)     $rt_ustr  the channel as a JS string
//   c.a0q  VFileOutputStream's buffer (ByteBuffer: nC bytes, c7 position, cj limit)
const MULTICORE_CODE = 'var $eaglanZ={on:globalThis.__eaglanMultiCore===true,sent:0,bytes:0,saves:0};\n' +
  'var $eaglanZRaw=[0,69,65,71,76,65,78,82,65,87,0,1];\n' +
  'function $eaglanZSaveHead(c){var b=c.a0q;if(b===null||b.c7!==0||b.cj<16)return false;b.nC.set($eaglanZRaw,0);b.c7=16;$eaglanZ.saves++;return true;}\n' +
  'function $eaglanZSaveTail(c){var b=c.a0q,n=b.c7-16|0,d=b.nC;d[12]=n>>>24;d[13]=n>>>16;d[14]=n>>>8;d[15]=n;}\n' +
  'function $eaglanZSend(ch,buf,n){var a=EPd(buf),d;if(a===null||a.data.length<n)return false;d=new Int8Array(n);d.set(a.data.subarray(0,n));' +
  'if(typeof $eaglanPkPost===\'function\')$eaglanPkPost($eaglanUstr(ch),d.buffer,1);else $rt_globals.postMessage({ch:$rt_ustr(ch),dat:d.buffer,z:1});$eaglanZ.sent++;$eaglanZ.bytes+=n;return true;}\n' +
  'globalThis.__eaglanZ={version:2,set:function(on){$eaglanZ.on=on===true;return $eaglanZ.on;},status:function(){return {on:$eaglanZ.on,sent:$eaglanZ.sent,bytes:$eaglanZ.bytes,saves:$eaglanZ.saves};}};\n';

// ---------------------------------------------------------------- terrain threads (pre-generation, players)
// The hook below ("terrain threads"), for config terrainThreads (terrain.js, terrain-worker.js; off by
// default, used while a pre-generation job runs, and with terrainForPlayers for the chunks players are about
// to reach). ChunkProviderGenerate.provideChunk (Fs1) makes a
// chunk in this order: its random seeded from x and z (a.no, case 0), a fresh ChunkPrimer (AO_: w1, the
// 65,536 block states), setBlocksInChunk (CO7, the noise terrain), the biomes (eil, through the biome
// cache), replaceBlocksForBiome (Em$, the surface), caves and ravines (EgL on duS and did), then the
// structures (they only record where they start and leave the primer alone), the Chunk (BVS, case 9),
// its biome bytes and its sky light.
// A terrain thread runs the same code in its own copy of classes.js (the world's level.dat, a world
// object without chunks, structures off) up to case 9 and hands over the primer and the ids of the 256
// biomes it used (the generator's b8a; BiomeGenBase.biomeID fr). In the game:
//   - $eaglanTgTake (case 0): a primer from a thread for (x, z) is copied into the fresh one, and the
//     game skips CO7, Em$, the caves and the ravines (n = 1); with the biomes too (n = 2) it also skips
//     the biome lookup at case 2 (eil: WorldChunkManager.getBiomeGenAt F6R through the biome cache) and
//     takes the thread's ($eaglanTgBiomes). Everything from the structures on runs as before.
//   - every 32nd one (every one with terrainVerify) is not used: the game makes its own as usual, and
//     $eaglanTgAt9 compares the two at case 9, blocks and biomes. A difference switches the hook off (from
//     then on the game makes all terrain itself) and is reported; with terrainVerify it is only counted.
// What the skipped code does besides the primer, and why skipping it changes nothing else:
//   - the generator's random (a.no) is seeded again at case 0 of every chunk and in populate;
//   - its noise arrays are scratch arrays, filled before each use;
//   - the caves and ravines (MapGenBase) seed their random from the world seed in each call. Where they
//     cut through grass they ask the world for the biome (CzN): the chunk being made is never loaded
//     yet (C7X, ChunkProviderServer.chunkExists ua), so the answer comes from the biome generator,
//     which the thread has too.
//   - the biome cache (getBiomeGenAt with its cache flag: BiomeCache.getCachedBiomes ELu) keeps the
//     biomes of 16 x 16 blocks for later lookups of chunks that are not loaded; without the lookup it
//     makes them when one is asked for, from the same generator: the same biomes, later. A loaded chunk
//     answers from its own biome bytes, which come from the same 256 ids either way.
// Off ($eaglanTg.on false): the game's own code (n = 0).
//   HMl  the server: gc.data[0] the overworld (C5 its ChunkProviderServer: I8 generator, tA loaded chunks;
//        bce its save handler: a81 the world's folder, a VFile2 whose path dT is a String)
function $eaglanTgId(x, z) { return (x + 2097152) * 4194304 + (z + 2097152); }
function $eaglanTgKey(x, z) { return Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)); }   // ChunkCoordIntPair.chunkXZ2Int
function $eaglanTgWorld() { var s = HMl; return s === null || s.gc === null ? null : s.gc.data[0]; }
function $eaglanTgLoaded(x, z) { var w = $eaglanTgWorld(); return !!w && Ld(w.C5.tA, $eaglanTgKey(x, z)) !== null; }
// A thread's chunk ({ d: the primer's 65,536 block states, bio: the 256 biome ids or null }) for (x, z): 0 none
// (the game makes it), 1 its terrain, 2 its terrain and biomes (t.bio, for $eaglanTgBiomes at case 2, which
// follows without a pause). The biome list (H1Y) is set once BiomeGenBase is set up, before any chunk is made.
function $eaglanTgTake(x, z, f) {
  var t = $eaglanTg; if (!t.on) return 0;
  var id = $eaglanTgId(x, z), r = t.ready.get(id);
  if (r === undefined) { t.missed++; return 0; }
  t.ready.delete(id);
  if (t.verify || ++t.n % t.every === 0) { if (t.checks.size > 16) t.checks.clear(); t.checks.set(id, r); return 0; }
  f.w1.data.set(r.d); t.used++;
  if (r.bio === null || H1Y === null) return 1;
  t.bio = r.bio; t.biomes++; return 2;
}
// The thread's biomes as getBiomeGenAt (F6R) gives them: in the array given (the generator's b8a) when it
// has room for 256, else in a new BiomeGenBase[256] (H(E9, 256)); each from the biome list (H1Y) as
// getBiomeFromBiomeList (Gre) takes it, an empty entry as its default (H2D).
function $eaglanTgBiomes(g) {
  var t = $eaglanTg, ids = t.bio, b = g !== null && g.data.length >= 256 ? g : H(E9, 256), d = b.data, l = H1Y.data, e, i;
  t.bio = null;
  for (i = 0; i < 256; i++) { e = l[ids[i]]; d[i] = e === null ? H2D : e; }
  return b;
}
// bm: the generator's biomes (b8a) for this chunk.
function $eaglanTgAt9(x, z, f, bm) {
  var t = $eaglanTg;
  if (t.primerOnly) { t.out = f; return true; }   // in a terrain thread: the primer is the result
  if (!t.checks.size) return false;
  var id = $eaglanTgId(x, z), r = t.checks.get(id);
  if (r === undefined) return false;
  t.checks.delete(id); t.checked++;
  var a = f.w1.data, d = r.d, n = 0, nb = 0, first = -1, i;
  for (i = 0; i < a.length; i++) if (a[i] !== d[i]) { if (first < 0) first = i; n++; }
  if (r.bio !== null) { t.checkedBiomes++; for (i = 0; i < 256; i++) if ((bm.data[i].fr & 255) !== r.bio[i]) nb++; }
  if (!n && !nb) { t.same++; return false; }
  t.differ++; t.differBlocks += n; t.differBiomes += nb;
  if (t.firstDiff === null) t.firstDiff = { x: x, z: z, blocks: n, biomes: nb, index: first, game: first < 0 ? null : a[first], thread: first < 0 ? null : d[first] };
  if (!t.verify) { t.on = false; t.ready.clear(); t.error = 'the terrain of chunk ' + x + ', ' + z + ' from a terrain thread differed from the game\'s in ' + n + ' blocks' + (nb ? ' and ' + nb + ' biomes' : ''); }
  return false;
}
function $eaglanTgErr(e) { try { var je = D(e); return je && je.l ? $rt_ustr(je.l) : String((e && e.stack) || e); } catch (x) { return String(e); } }
// The overworld's WorldInfo as level.dat has it (gzipped NBT, the info as "Data"), made as
// EaglerSaveHandler.saveWorldInfoWithPlayer (GaM) makes the file, but in memory, so that a world not
// saved yet has it too: cloneNBTCompound (ety), a new NBTTagCompound (CG, its map as GaM makes it)
// with it as "Data" (C(683), the map's put Eu$), CompressedStreamTools.writeCompressed (GOw) into an
// EaglerOutputStream (KOG; RS its bytes). The thread reads it back as SaveHandler.loadWorldInfo does.
function $eaglanTgLevel(a) {
  var b, c, d, e, f, g, h, i, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); i = $T.l(); h = $T.l(); g = $T.l(); f = $T.l(); e = $T.l(); d = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: $p = 1;
      case 1:
        $z = a.ety(null); if (B()) { break _; } b = $z;
        c = new CG; Co(); B6(); d = new BT; e = BO(16); d.G = 0; f = H(BW, e); g = f.data; d.o = f; d.U = 0.75; d.Y = g.length * 0.75 | 0; c.A = d; h = C(683); $p = 2;
      case 2: Eu$(d, h, b); if (B()) { break _; } i = KOG(); $p = 3;
      case 3: GOw(c, i); if (B()) { break _; } return RS(i);
      default: FO();
    }
  }
  DJ().s(a, b, c, d, e, f, g, h, i, $p);
}
function $eaglanTgStatus() {
  var t = $eaglanTg;
  return { on: t.on, verify: t.verify, every: t.every, ready: t.ready.size, used: t.used, biomes: t.biomes, checked: t.checked, checkedBiomes: t.checkedBiomes, same: t.same, differ: t.differ,
    differBlocks: t.differBlocks, differBiomes: t.differBiomes, firstDiff: t.firstDiff, missed: t.missed, late: t.late, dropped: t.dropped, error: t.error };
}
// The overworld's players, for the chunks they are about to reach (terrain.js): the server's player list
// (ServerConfigurationManager f1: e1), each player's dimension tk and position D, E (x, z), and name e7.eq.
function $eaglanTgPlayers() {
  var s = HMl, out = [], l, p, i; if (s === null || !s.f1) return out;
  l = s.f1.e1;
  for (i = 0; i < l.b; i++) { p = l.f.data[i]; if (p.tk === 0) out.push({ name: $rt_ustr(p.e7.eq), x: p.D, z: p.E }); }
  return out;
}
// The host's side (terrain.js): on / verify, primers in, which chunks are loaded, the overworld.
var $eaglanTgApi = {
  version: 1,
  set: function (o) {
    var t = $eaglanTg;
    if (o.on !== undefined) t.on = o.on === true;
    if (o.verify !== undefined) t.verify = o.verify === true;
    if (o.every > 0) t.every = o.every;
    if (o.max > 0) t.max = o.max;
    if (!t.on) { t.ready.clear(); t.checks.clear(); }
    return $eaglanTgStatus();
  },
  // A primer for (x, z): the buffer of an Int16Array of 65,536, and the buffer of its 256 biome ids (or
  // none). Not kept while off, or when the chunk is loaded already (the game made it meanwhile). At most
  // t.max are kept: the oldest goes first.
  put: function (x, z, buf, bio) {
    var t = $eaglanTg; if (!t.on) return false;
    if ($eaglanTgLoaded(x, z)) { t.late++; return false; }
    var id = $eaglanTgId(x, z);
    if (!t.ready.has(id) && t.ready.size >= t.max) { t.ready.delete(t.ready.keys().next().value); t.dropped++; }
    t.ready.set(id, { d: new Int16Array(buf), bio: bio ? new Uint8Array(bio) : null }); return true;
  },
  loaded: function (x, z) { return $eaglanTgLoaded(x, z); },
  players: function () { return $eaglanTgPlayers(); },
  // The overworld's folder in the store, and whether its generator is the one a thread can run.
  world: function () { var w = $eaglanTgWorld(); return w ? { dir: $rt_ustr(w.bce.a81.dT), generate: w.C5.I8 instanceof A_p } : null; },
  // Its settings as level.dat bytes (see $eaglanTgLevel): cb({ bytes }) or cb({ error }), from a thread of its own.
  level: function (cb) {
    var w = $eaglanTgWorld(); if (!w) { cb({ error: 'the world is not loaded' }); return; }
    $rt_startThread(function () { return $eaglanTgLevel(w.bR); }, function (r) {
      cb(r !== null && r !== undefined && r.data instanceof Int8Array ? { bytes: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length).slice() } : { error: r === null || r === undefined ? 'no bytes' : $eaglanTgErr(r) });
    });
  },
  status: function () { return $eaglanTgStatus(); },
};
const TERRAIN_CODE = 'var $eaglanTg={on:false,verify:false,every:32,max:64,primerOnly:false,out:null,bio:null,ready:new Map(),checks:new Map(),n:0,used:0,biomes:0,checked:0,checkedBiomes:0,same:0,differ:0,differBlocks:0,differBiomes:0,firstDiff:null,missed:0,late:0,dropped:0,error:null};\n' +
  [$eaglanTgId, $eaglanTgKey, $eaglanTgWorld, $eaglanTgLoaded, $eaglanTgTake, $eaglanTgBiomes, $eaglanTgAt9, $eaglanTgErr, $eaglanTgLevel, $eaglanTgStatus, $eaglanTgPlayers].map(String).join('\n') +
  '\nglobalThis.__eaglanTerrain={' + Object.entries($eaglanTgApi).map(([k, v]) => `${k}:${typeof v === 'function' ? String(v).replace(/^(set|put|loaded|players|world|level|status)\s*/, 'function') : v}`).join(',') + '};\n';

// A terrain thread's own side (terrain-worker.js), next to the game's entry: the generator of the world
// whose level.dat it gets, made as WorldServer makes it, and primers from it. Written as the game's
// code is (TeaVM: each step can pause, and the function then resumes there):
//   E$x  Bootstrap.register     Lv  EaglerInputStream(byte[])     HiQ  CompressedStreamTools.readCompressed
//   E2q  NBTTagCompound.getCompoundTag     Uv, BIy  WorldInfo, its constructor from NBT (as SaveHandler.loadWorldInfo)
//   FmP  WorldServer's class init (OY), as its constructor BUl calls first     AZK  WorldProviderSurface, as BUl makes it
//   Ejw  World.<init>(save handler, info, provider, remote)     Cmp  WorldProvider.registerWorld (the biome generator)
//   Gs0  WorldProvider.createChunkGenerator (A_p ChunkProviderGenerate: o2 mapFeaturesEnabled)
//   e.F  the world's chunk provider: here only ever asked chunkExists (ua) by the caves and ravines (see above)
function $eaglanTgWInit(a) {
  var b, c, d, e, f, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); f = $T.l(); e = $T.l(); d = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: $p = 1;
      case 1:
        E$x(); if (B()) { break _; }
        b = Cb(a.length); b.data.set(a); c = Lv(b); $p = 2;
      case 2: $z = HiQ(c); if (B()) { break _; } c = $z; $p = 3;
      case 3: $z = E2q(c, $rt_str('Data')); if (B()) { break _; } c = $z; d = new Uv(); $p = 4;
      case 4: BIy(d, c); if (B()) { break _; } $p = 5;
      case 5: FmP(); if (B()) { break _; } e = new OY(); f = new AZK(); f.bc6 = FH(16); f.bZ4 = FH(4); $p = 6;
      case 6: Ejw(e, null, d, f, 0); if (B()) { break _; } $p = 7;
      case 7: Cmp(f, e); if (B()) { break _; } $p = 8;
      case 8:
        $z = Gs0(f); if (B()) { break _; } b = $z;
        e.F = { ua: function () { return 0; } };
        if (b instanceof A_p) b.o2 = 0;
        return b;
      default: FO();
    }
  }
  DJ().s(a, b, c, d, e, f, $p);
}
function $eaglanTgWPrimer(a, b, c) {
  var $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); c = $T.l(); b = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: $eaglanTg.out = null; $p = 1;
      case 1: Fs1(a, b, c); if (B()) { break _; } return $eaglanTg.out;
      default: FO();
    }
  }
  DJ().s(a, b, c, $p);
}
var $eaglanTgWApi = {
  version: 1,
  // cb({gen}) or cb({error}); gen is the generator, for primer().
  init: function (bytes, cb) {
    $eaglanTg.primerOnly = true;
    $rt_startThread(function () { return $eaglanTgWInit(bytes); }, function (r) {
      cb(r instanceof A_p ? { gen: r, seed: String(Dj(r.jj.bR.vA())) } : { error: r === null || r === undefined ? 'no generator' : r instanceof G ? 'the world\'s generator is not the overworld\'s default one (' + (r.constructor && r.constructor.name) + ')' : $eaglanTgErr(r) });
    });
  },
  // cb({data, bio}) with the primer's Int16Array (the thread's: copy it before the next call) and the ids of the
  // biomes it was made with (the generator's b8a, as provideChunk copies them into the chunk), or cb({error}).
  primer: function (gen, x, z, cb) {
    $rt_startThread(function () { return $eaglanTgWPrimer(gen, x, z); }, function (r) {
      if (r === null || r === undefined || !r.w1) { cb({ error: r === null || r === undefined ? 'no primer' : $eaglanTgErr(r) }); return; }
      var b = gen.b8a, bio = null, i;
      if (b !== null && b.data.length >= 256) { bio = new Uint8Array(256); for (i = 0; i < 256; i++) bio[i] = b.data[i].fr & 255; }
      cb({ data: r.w1.data, bio: bio });
    });
  },
};
const TERRAIN_WORKER_CODE = [$eaglanTgWInit, $eaglanTgWPrimer].map(String).join('\n') +
  '\nglobalThis.__eaglanTgWorker={' + Object.entries($eaglanTgWApi).map(([k, v]) => `${k}:${typeof v === 'function' ? String(v).replace(/^(init|primer)\s*/, 'function') : v}`).join(',') + '};\n';

// ---------------------------------------------------------------- speedups (same results, less work)
// Six changes to how the compiled game does a thing, not to what it does (config speedups, on unless
// false; the sixth only with config collisionScan as well; README "Speedups"). Found in CPU profiles of the game
// thread (README "Entity processing"; the fourth and fifth in fresh terrain, README "Chunk work in fresh terrain";
// the sixth with many entities in one place, README "Many entities in one place"):
//  1. Chunk lookups. ChunkProviderServer.provideChunk (Cin, Eu0) and chunkExists (Feb) find a loaded chunk in
//     their LongObjectHashMap (tA) by its 64-bit key (ChunkCoordIntPair.chunkXZ2Int). TeaVM emulates 64-bit
//     integers with objects: building the key and hashing it (a 64-bit multiply) is most of a lookup, and
//     the game does millions of them (every block read). $eaglanCk keeps the answers for an 8 x 8 area of
//     chunk positions (one slot per x & 7, z & 7) and forgets all of them whenever the map changes: put (Dta)
//     and remove (ADP), the only ways the map's content changes, count the changes on the map ($eaglanMod).
//     So it returns what Ld would return for the same position. chunkExists uses it too: the map's values
//     are chunks, never null.
//  2. UUID text. EaglercraftUUID.toString (CTz) builds the text from the two 64-bit halves (c9, da) each
//     time; EntityLivingBase.getTeam calls it for every scoreboard team lookup (entity collisions, targets).
//     The text is kept on the UUID with the two halves it was made from, and made again if either was
//     replaced (TeaVM's 64-bit values are immutable objects).
//  3. Packet hand-over. Every packet to a player is one postMessage to the host (Fyr): 1.4 us each here.
//     During the entity tracking phase (EntityTracker.updateTrackedEntities, Fl0 in the tick) a player's
//     packets are kept and handed over together at its end, in the order sent. A packet sent outside the
//     phase hands over everything kept first, so each player's order never changes; the IPC channel is
//     never kept. The channel's name (a Java String, immutable) becomes a JavaScript string once per String
//     object, not once per packet ($rt_ustr in ServerPlatformSingleplayer.sendPacket, EmG).
//  4. 64-bit constants (longConstants below, applied to the whole text after the patches). TeaVM writes each
//     64-bit constant of the Java code as a call where it is used: Long_create (M) with the two 32-bit halves.
//     java.util.Random's multiplier and mask in every inlined next() (about 2,600 places each),
//     ChunkCoordIntPair.chunkXZ2Int's 0xFFFFFFFF, the hash constant of the position sets of the lighting
//     engine (com.carrotsearch.hppc LongHashSet, BitMixer.mixPhi), ...: 7,014 places, 1,075 values. With
//     BigInt (Node has it) each call makes the value anew in eight BigInt operations: 8 % of the game
//     thread in fresh terrain (terrain, structures, first lighting). Each call with two number literals
//     becomes a variable set once, by the same call, right where the code sets M. A BigInt is a value that
//     nothing can change, so every expression computes what it computed before.
//  5. The lighting engine's position sets. A chunk's first lighting (and every light change) queues block positions
//     in the world's lighting queues: a deque and, to queue each position once, an HPPC LongHashSet (We; add Ef0,
//     contains Qj, remove ABh, its shift Bs9, rehash XA). Its slot hash, BitMixer.mixPhi ((int)(h ^ h >>> 32) of
//     key * 0x9E3779B97F4A7C15), keeps a position's height (bits 52-63 of the key) in bits 20-31, so in any set below
//     2^20 slots all 256 heights of a column share one slot: queuing a column's heights probes quadratically (20 probes
//     a key in a lighting batch, each two BigInt comparisons; about 8 s in 100 s of play in fresh terrain). The sets the
//     lighting engine puts into its queues (AY: in its constructor BO_, the queue's init EOd and its shrink E_p) are
//     marked while still empty ($eaglanLhMark), and every slot of a marked set is computed with a hash that mixes both
//     halves of the key ($eaglanLhHash; 0.1-0.3 probes a key). A set holds the same keys whatever its hash: add, contains
//     and remove give the same answers. Only the order of its slots differs, and the lighting engine never walks them
//     (it only adds, then clears or replaces the set: E_p); every other set of the class, such as the chunks queued for
//     unloading, which the game does walk in slot order, keeps the game's hash.
//  6. Collision boxes of other entities (stage 6; off unless config collisionScan is true). Entity.moveEntity asks
//     World.getCollidingBoundingBoxes (F5z) for the boxes in its way: the blocks' first, then those of the entities
//     near it, which getEntitiesInAABBexcluding (CGv) finds by walking every entity of the chunk sections round the
//     box (Chunk.getEntitiesWithinAABBForEntity, Dbo): 15-26 % of the game thread with 500-1,000 entities in one
//     place. Of all entities only a boat has a box of its own (getCollisionBoundingBox: EntityBoat's Gxv; the
//     minecart's GZ8, a firework spark's G_F and every other entity's GOn give none), and only a moving boat or
//     minecart takes another entity's box (getCollisionBox: Eci, FfU; every other entity's CDr gives none). So when
//     anything else moves, the walk adds a box only if a boat is in a section it walks. A section
//     (ClassInheritanceMultiMap) keeps a list of its entities of each class it knows (add and remove keep the lists;
//     a new section knows the classes of a static set, Lfl); EntityBoat (SA) joins that set when the class is set up
//     (EIj), before any section is made. The walk is left out (an empty list instead) when the mover is neither a
//     boat nor a minecart and every section the walk would visit (the same chunks and sections, computed as CGv and
//     Dbo compute them) is empty or knows boats and has none. Anything else walks as before: a boat or minecart
//     moving, a boat in reach, a section that does not know boats.
// Verify mode (EAGLAN_DEBUG_SPEEDUPS_VERIFY): 1 and 2 also compute the game's own answer and count the
// differences; 3 numbers each player's packets so the host can check that none is lost or reordered; 4
// makes each constant again where it is used and counts those that differ; 5 keeps a plain set beside each marked set
// and counts every add whose answer differs from it; 6 walks the entities where it would not and counts the walks
// whose entities give a box (as F5z tests them: a box that meets the mover's).

// 1. chunk lookups
function $eaglanCk(p, x, z) {
  var s = $eaglanSpCk, m = p.tA;
  if (!s.on) return Ld(m, Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)));
  var c = p.$eaglanCc, mod = m.$eaglanMod || 0, i = ((x & 7) << 3) | (z & 7);
  if (c === undefined || c.m !== m) c = p.$eaglanCc = { m: m, x: new Int32Array(64), z: new Int32Array(64), mod: new Float64Array(64).fill(-1), v: new Array(64).fill(null) };
  if (c.mod[i] === mod && c.x[i] === x && c.z[i] === z) {
    s.hits++;
    if (s.verify && Ld(m, Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32))) !== c.v[i]) s.diff++;
    return c.v[i];
  }
  s.misses++;
  var v = Ld(m, Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)));
  c.x[i] = x; c.z[i] = z; c.v[i] = v; c.mod[i] = mod;
  return v;
}
function $eaglanCkHas(p, x, z) {
  var s = $eaglanSpCk;
  if (!s.on) return ABR(p.tA, Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32)));
  var has = $eaglanCk(p, x, z) !== null ? 1 : 0;
  if (s.verify && has !== (ABR(p.tA, Dq(X(L(x), M(4294967295, 0)), Cw(X(L(z), M(4294967295, 0)), 32))) ? 1 : 0)) s.diff++;
  return has;
}

// 2. UUID text: CTz is the game's own toString, renamed $eaglanCTz; this takes its name (also in the
// class's method table). Written as the game's code is (TeaVM): the game's toString can pause.
function $eaglanUuidText(a) {
  var s, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); s = $T.l(); a = $T.l(); }
  _: while (true) {
    switch ($p) {
      case 0: {
        var u = $eaglanSpUu;
        s = a.$eaglanS;
        if (u.on && s !== undefined && a.$eaglanC9 === a.c9 && a.$eaglanDa === a.da) {
          u.hits++;
          if (!u.verify) return s;
          $p = 2; continue _;
        }
        $p = 1;
      }
      case 1: {
        $z = $eaglanCTz(a); if (B()) { break _; }
        var u1 = $eaglanSpUu;
        if (u1.on) { u1.misses++; a.$eaglanS = $z; a.$eaglanC9 = a.c9; a.$eaglanDa = a.da; }
        return $z;
      }
      case 2:
        $z = $eaglanCTz(a); if (B()) { break _; }
        if ($rt_ustr($z) !== $rt_ustr(s)) $eaglanSpUu.diff++;
        return s;
      default: FO();
    }
  }
  DJ().s(a, s, $p);
}

// 3. packet hand-over
function $eaglanUstr(j) { var r = j.$eaglanU; if (r === undefined) { r = $rt_ustr(j); if ($eaglanSpPk.on) j.$eaglanU = r; } return r; }
// 8. packed hand-over (stage 8; config packedHandover, off by default): while packets are kept (speedup 3), each whole
// frame of the game's send (ServerPlatformSingleplayer.sendPacket, EmG) is copied into its player's buffer ($eaglanPkPack)
// instead of becoming an ArrayBuffer of its own: a small typed array lives on V8's heap and .buffer moves it out, and
// every ArrayBuffer handed over costs on both threads. The hand-over then posts one buffer per player, with each frame's
// end in it ({ch, pack, ix}: ix[i] >= 0 the end of the next frame in pack, < 0: -(k+1), the frame dats[k] kept as it
// came, e.g. multi-core mode's uncompressed packets); the host cuts them apart in the same order (daemon.js).
function $eaglanPkQ(s, ch) {
  var q = s.q.get(ch);
  if (q === undefined) { q = { d: [], z: [], any: 0 }; s.q.set(ch, q); }
  if (s.pack && q.ix === undefined) { q.ix = []; q.pn = 0; q.pb = s.ar.get(ch) || new Int8Array(16384); }
  if (s.n === 0) s.t = $eaglanPkNow();   // the first packet kept: the longest wait of this hand-over starts
  return q;
}
function $eaglanPkPack(ch, a8) {
  var s = $eaglanSpPk;
  if (!s.pack || !s.open || ch === '~!IPC') return false;
  var q = $eaglanPkQ(s, ch), n = a8.length, end = q.pn + n;
  if (end > q.pb.length) { var g = new Int8Array(Math.max(end, q.pb.length * 2)); g.set(q.pb.subarray(0, q.pn)); q.pb = g; }
  q.pb.set(a8, q.pn); q.pn = end; q.ix.push(end); s.n++; s.packed++;
  return true;
}
function $eaglanPkPost(ch, dat, z) {
  var s = $eaglanSpPk;
  if (ch === '~!IPC') {   // the host's own channel: never kept, and what is kept goes first
    if (s.n) $eaglanPkSend();
    $rt_globals.postMessage(z ? { ch: ch, dat: dat, z: 1 } : { ch: ch, dat: dat });
    return;
  }
  if (s.open) {
    var q = $eaglanPkQ(s, ch);
    if (s.pack) q.ix.push(-(q.d.length + 1));
    q.d.push(dat); q.z.push(z); q.any |= z; s.n++;
    return;
  }
  if (s.n) $eaglanPkSend();   // what is kept goes first: each player's order stays as sent
  var m = z ? { ch: ch, dat: dat, z: 1 } : { ch: ch, dat: dat };
  if (s.verify) { var c = (s.seq.get(ch) || 0) + 1; s.seq.set(ch, c); m.seq = c; }
  $rt_globals.postMessage(m);
}
function $eaglanPkSend() {
  var s = $eaglanSpPk;
  s.q.forEach(function (q, ch) {
    if (q.ix !== undefined) {   // pack mode: one buffer for this player (a copy of the used part; the buffer is kept)
      var pm = { ch: ch, pack: q.pb.slice(0, q.pn).buffer, ix: new Int32Array(q.ix).buffer };
      if (q.d.length) { pm.dats = q.d; if (q.any) pm.zs = q.z; }
      if (s.verify) { var pc = s.seq.get(ch) || 0; pm.seq = pc + 1; s.seq.set(ch, pc + q.ix.length); }
      s.ar.set(ch, q.pb); s.kept += q.ix.length; s.messages++;
      $rt_globals.postMessage(pm);
      return;
    }
    var m = q.d.length === 1 ? (q.z[0] ? { ch: ch, dat: q.d[0], z: 1 } : { ch: ch, dat: q.d[0] }) : (q.any ? { ch: ch, dats: q.d, zs: q.z } : { ch: ch, dats: q.d });
    if (s.verify) { var c = s.seq.get(ch) || 0; m.seq = c + 1; s.seq.set(ch, c + q.d.length); }
    s.kept += q.d.length; s.messages++;
    $rt_globals.postMessage(m);
  });
  var w = $eaglanPkNow() - s.t; s.held += w; if (w > s.heldMax) s.heldMax = w;
  if (s.pack) s.ar.forEach(function (v, ch) { if (!s.q.has(ch)) s.ar.delete(ch); });   // buffers of players gone quiet
  s.q.clear(); s.n = 0; s.flushes++;
}
function $eaglanPkNow() { var p = $rt_globals.performance; return p ? p.now() : Date.now(); }
function $eaglanPkOpen() { var s = $eaglanSpPk; if (!s.on) return; if (s.n) $eaglanPkSend(); s.open = true; }   // (anything left from a phase that did not end goes first)
function $eaglanPkClose() { var s = $eaglanSpPk; s.open = false; if (s.n) $eaglanPkSend(); }

// 7. encode once (stage 8; config encodeOnce, off by default): the entity tracker sends one packet object to every
// player watching an entity, in a loop (EntityTrackerEntry.sendPacketToTrackedPlayers CK2 and func_151261_b EeI: for
// each player NetHandlerPlayServer.sendPacket Gcp -> IntegratedServerPlayerNetworkManager.sendPacket CEM; nothing else
// runs in between). In such a loop, while the tracker's packets are kept for one hand-over (speedup 3), a whole frame
// (packets up to 1,024 bytes) made for one player is copied for the next instead of being made again: same packet
// object, same connection state and compression, nothing changed in between, so the same bytes. Verify mode: made
// again anyway and compared (diff). $eaglanEo.loop: the packet of the loop running now (null outside one).
function $eaglanEoLoop(f, a, b) {
  var s = $eaglanEo;
  if (!s.on) return f(a, b);
  var prev = s.loop; s.loop = b; s.pkt = null; s.f = null;
  try { return f(a, b); } finally { s.loop = prev; s.pkt = null; s.f = null; }
}
function $eaglanEoKeeping() { return typeof $eaglanSpPk !== 'undefined' && $eaglanSpPk.on && $eaglanSpPk.open; }
function $eaglanEoHit(a, b) {
  var s = $eaglanEo;
  if (!s.on) return null;
  // (a frame handed over already, e.g. by a flush in between, has a detached buffer: length 0)
  if (b === s.pkt && s.loop === b && a.b4Q === s.st && a.cmX === s.cmx && s.f !== null && s.f.data.length > 0 && $eaglanEoKeeping()) {
    if (!s.verify) { s.hits++; var g = Cb(s.f.data.length); g.data.set(s.f.data); return g; }
    s.cmp = s.f;   // verify mode: made again below, compared in $eaglanEoSet
  }
  s.pkt = null; s.f = null;
  return null;
}
function $eaglanEoSet(a, b, f) {
  var s = $eaglanEo;
  if (!s.on) return;
  if (s.cmp !== null) {
    var x = s.cmp.data, y = f.data, same = x.length === y.length, i;
    for (i = 0; same && i < x.length; i = i + 1 | 0) if (x[i] !== y[i]) same = false;
    if (same) s.checked++; else s.diff++;
    s.cmp = null;
  }
  if (s.loop === b && $eaglanEoKeeping()) { s.pkt = b; s.st = a.b4Q; s.cmx = a.cmX; s.f = f; s.encoded++; }
}

// 9. path ahead (stage 8, path 3; config pathAhead, off by default; src/path-ahead.js says how it works). Every block
// array of a chunk section is allocated on a SharedArrayBuffer ($eaglanPaBlk, $eaglanPaShare), so the path thread reads
// the game's own arrays. Chunk.setBlockState (E53) stamps its chunk with the current epoch ($eaglanPaMod). At the end
// of each tick, $eaglanPaDispatch starts a new epoch and hands the thread every path-following mob (EntityLiving Kr,
// navigator f9 a PathNavigateGround QH, with a path lv not finished: index rk < length vG) with what pathFollow (Ecw)
// will read, and the chunks its walk can reach. pathFollow ($eaglanPaFollow) takes the thread's answer only if the
// thread finished it for this epoch, the inputs are the same (path object, index, length, size, height requirement
// cB_, water flag, getEntityPosition exactly) and every chunk the thread read is loaded, is the one the thread was
// given in this epoch ($eaglanPaSentE) and was not changed since ($eaglanPaMod). Then it sets the index and ends as
// pathFollow does (checkForStuck BG1). Verify mode: pathFollow runs anyway and the index is compared.
function $eaglanPaBlk() { return $eaglanPa.on ? $rt_createNumericArray($rt_charcls(), new Uint16Array(new SharedArrayBuffer(8192))) : I(4096); }
function $eaglanPaShare(b) {
  if (!$eaglanPa.on || b === null || b.data.buffer instanceof SharedArrayBuffer) return b;
  var a = $rt_createNumericArray($rt_charcls(), new Uint16Array(new SharedArrayBuffer(b.data.length * 2)));
  a.data.set(b.data);
  return a;
}
function $eaglanPaApi() {
  var s = $eaglanPa;
  if (s.api === null && globalThis.__eaglanPathAhead) s.api = globalThis.__eaglanPathAhead.api();
  return s.api;
}
// A loaded chunk or null, straight from the provider's map (tA), not through speedup 1's lookup cache: this code asks
// for chunks the game itself does not, and leaves the game's cache as the game's own lookups leave it.
function $eaglanPaChunk(p, x, z) { return Ld(p.tA, $eaglanPgKey(x, z)); }
function $eaglanPaKey(wi, cx, cz) { return (wi * 4194304 + (cx + 2097152)) * 4194304 + (cz + 2097152); }
// Will this mob's chase search (EntityAIAttackOnCollide VC, in its goals en) run in the next tick? Its updateTask
// searches when its delay counter xD gets to 0 and its target t moved a block or more from where it was at the last
// search (a1U, Kp, Ko; all 0: none yet); (or by a 1 in 20 chance: not foreseen); its shouldExecute searches at the next
// goal setup (the goals' tick count dEI a multiple of their tick rate deq). A wrong guess only costs the thread time.
function $eaglanPaWillSearch(e, t) {
  var tk = e.en, ex = tk.vn, all = tk.fP, found = false, has = false, i;
  for (i = 0; i < ex.b; i++) {
    var act = ex.f.data[i].fE;
    if (!(act instanceof VC)) continue;
    found = true;
    if (act.xD > 1) continue;
    if (act.a1U === 0 && act.Kp === 0 && act.Ko === 0) return true;
    var dx = t.D - act.a1U, dy = t.J - act.Kp, dz = t.E - act.Ko;
    if (dx * dx + dy * dy + dz * dz >= 1.0) return true;
  }
  if (found || (tk.dEI % tk.deq | 0) !== 0) return false;
  for (i = 0; i < all.b && !has; i++) if (all.f.data[i].fE instanceof VC) has = true;   // (only mobs with a chase goal)
  return has;
}
// None of this code may call a game method that can pause the game's thread (a chunk loaded from disk, TeaVM's
// suspension): it is not written to resume. So positions and flags are read from fields, and what only the game's own
// code can do safely is left to it (the job is not handed out, or the game's own method runs).
// getMaxFallHeight without side effects: EntityLiving's (DqD) when its max health needs no computing, the creeper's
// (GaF: fields only); -1 when it cannot be had that way.
function $eaglanPaFall(e) {
  if (e instanceof Vx) return e.dJz();
  if (e.dJz !== Kr.prototype.dJz) return -1;
  if (e.p3 !== null) { EU(); var at = ErG(e, H3D); if (at === null || at.fv) return -1; }
  return e.dJz();
}
function $eaglanPaDispatch() {
  var s = $eaglanPa, api = $eaglanPaApi();
  if (api === null || !api.ready()) return;
  var srv = HGX; if (srv === null || !srv.gc) return;
  var prev = s.epoch, E = s.epoch = s.epoch + 1 | 0;
  var J = api.jobs, JW = api.JW, max = api.MAX, n = 0, newPaths = [], need = new Map(), regions = new Set(), ws = srv.gc.data;
  var addRange = function (w, wi, ax, az, bx, bz) {
    for (var cx = ax; cx <= bx; cx++) for (var cz = az; cz <= bz; cz++) { var key = $eaglanPaKey(wi, cx, cz); if (!need.has(key)) need.set(key, [w, wi, cx, cz]); }
  };
  for (var wi = 0; wi < ws.length; wi++) {
    var w = ws[wi]; if (!w) continue;
    var l = w.pP;
    for (var k = 0; k < l.b && n < max - 1; k++) {
      var e = l.f.data[k];
      if (!(e instanceof Kr)) continue;
      var nav = e.f9;
      if (!(nav instanceof QH)) continue;
      // isInWater: only mobs whose isInWater is the plain flag (Entity's, AOT: yd); a squid's (Flv) reads blocks and
      // may load a chunk, which pauses the game's thread (squids have a ground navigator but never a path)
      if (e.bj1 !== Kr.prototype.bj1) continue;
      var water = e.yd ? 1 : 0, o, i;
      // a chase search, before the path step (the mob's goals run before its navigator): getPathToEntityLiving's inputs
      var t = e.p3, at = nav.cLE;
      var fall = s.searches && t !== null && !t.dD && !at.fv && $eaglanPaWillSearch(e, t) ? $eaglanPaFall(e) : -1;
      if (fall >= 0) {
        var d = e.dz, pr = nav.sc, range = at.fw;
        o = n * JW;
        J[o] = 1; J[o + 1] = wi; J[o + 2] = e.D; J[o + 3] = e.J; J[o + 4] = e.E;
        J[o + 5] = d.cE; J[o + 6] = d.b2; J[o + 7] = d.cD; J[o + 8] = d.cJ; J[o + 9] = d.cG; J[o + 10] = d.cK;
        J[o + 11] = e.ey; J[o + 12] = e.eo; J[o + 13] = water; J[o + 14] = fall; J[o + 15] = range;
        J[o + 16] = pr.T3; J[o + 17] = pr.R$; J[o + 18] = pr.xv; J[o + 19] = pr.NV; J[o + 20] = t.D; J[o + 21] = t.dz.b2; J[o + 22] = t.E;
        s.jt[n] = t; s.jw[n] = w; nav.$eaglanPaSj = n; nav.$eaglanPaSe = E;
        // its ChunkCache's region: every chunk of it (a chunk the thread is not given ends the search there)
        var fx = Math.floor(e.D), fz = Math.floor(e.E), c = (range + 16.0) | 0, ax = (fx - c) >> 4, bx = (fx + c) >> 4, az = (fz - c) >> 4, bz = (fz + c) >> 4;
        var rk = wi + ':' + ax + ':' + az + ':' + bx + ':' + bz;
        if (!regions.has(rk)) { regions.add(rk); addRange(w, wi, ax, az, bx, bz); }
        n++; s.st.sJobs++;
      }
      var p = nav.lv;
      if (p === null || p.rk >= p.vG) continue;
      if (water && nav.sc.NV) continue;   // getPathablePosY looks up through the water there: left to the game
      var x = e.D + 0, y = e.dz.b2 + 0.5 | 0, z = e.E + 0, pts = p.bn_.data;   // getEntityPosition (Gd7, DNS) for it
      if (p.$eaglanPaId === 0) p.$eaglanPaId = ++s.pathSeq;
      if (p.$eaglanPaSentE !== prev) {   // not in the last tick's jobs: the thread may not have its points
        var a = new Int32Array(pts.length * 3);
        for (i = 0; i < pts.length; i++) { a[i * 3] = pts[i].qN; a[i * 3 + 1] = pts[i].r0; a[i * 3 + 2] = pts[i].rr; }
        newPaths.push([p.$eaglanPaId, a]);
      }
      p.$eaglanPaSentE = E;
      o = n * JW;
      J[o] = 0; J[o + 1] = p.$eaglanPaId; J[o + 2] = p.rk; J[o + 3] = p.vG; J[o + 4] = x; J[o + 5] = y; J[o + 6] = z;
      J[o + 7] = e.ey; J[o + 8] = e.eo; J[o + 9] = nav.cB_; J[o + 10] = water; J[o + 11] = wi;
      s.jp[n] = p; s.jw[n] = w; nav.$eaglanPaSlot = n; nav.$eaglanPaE = E;
      // the chunks its walk can reach: from where it stands to the path's points from its index on, 3 blocks round
      var x0 = Math.floor(x), x1 = x0, z0 = Math.floor(z), z1 = z0;
      for (i = p.rk; i < p.vG; i++) { var pt = pts[i]; if (pt.qN < x0) x0 = pt.qN; if (pt.qN > x1) x1 = pt.qN; if (pt.rr < z0) z0 = pt.rr; if (pt.rr > z1) z1 = pt.rr; }
      addRange(w, wi, (x0 - 3) >> 4, (z0 - 3) >> 4, (x1 + 3) >> 4, (z1 + 3) >> 4);
      n++; s.st.jobs++;
    }
  }
  // the chunks: the thread keeps those given now; a chunk new to it, or whose sections are other arrays now, is sent
  var chunks = [], now = new Map(), sent = s.sent;
  if ($eaglanPaW.debug === 'noChunks') need.clear();   // (debugging)
  need.forEach(function (v, key) {
    var c = $eaglanPaChunk(v[0].F, v[2], v[3]);
    if (c === null) return;   // not loaded: a job that reaches it ends there (the game does that one itself)
    var secs = c.xT.data, last = sent.get(key), same = last !== undefined && last.c === c, arrs = [], j;
    for (j = 0; j < secs.length; j++) {
      var r8 = secs[j] === null ? null : secs[j].R8;
      if (r8 !== null && !(r8.data.buffer instanceof SharedArrayBuffer)) return;   // (not shared: not given)
      arrs.push(r8);
      if (same && last.a[j] !== r8) same = false;
    }
    if (!same) chunks.push([v[1], v[2], v[3], arrs.map(function (r) { return r === null ? null : r.data.buffer; })]);
    now.set(key, { c: c, a: arrs, wi: v[1], cx: v[2], cz: v[3] });
    c.$eaglanPaSentE = E;
  });
  var keep = new Int32Array(now.size * 3), ki = 0;
  now.forEach(function (v) { keep[ki++] = v.wi; keep[ki++] = v.cx; keep[ki++] = v.cz; });
  s.sent = now;
  Atomics.store(api.ctl, 0, E);
  if ($eaglanPaW.debug !== 'noPost') api.post({ epoch: E, n: n, paths: newPaths, chunks: chunks, keep: keep });
  s.st.ticks++;
}
// The chunks a job read: each loaded, given to the thread in this epoch, and not changed since.
// The dispatch never takes the game down: an error switches path ahead off (the game finds its paths itself), logged.
function $eaglanPaSafeDispatch() {
  if ($eaglanPaW.debug === 'noDispatch') return;   // (debugging: EAGLAN_DEBUG_PATHAHEAD)
  var tr = $eaglanPaW.debug === 'trace' && $eaglanPa.epoch >= 640;
  if (tr) $rt_globals.console.error('[runtime] pa trace: dispatch start ' + ($eaglanPa.epoch + 1) + ' suspending=' + B());
  try { $eaglanPaDispatch(); if (tr) $rt_globals.console.error('[runtime] pa trace: dispatch end ' + $eaglanPa.epoch + ' suspending=' + B()); }
  catch (e) { $eaglanPa.on = false; try { $rt_globals.console.error('[runtime] path ahead stopped after an error (the game finds its paths itself now): ' + ((e && e.stack) || e)); } catch (e2) {} }
}
// The end of each tick (tick times' $eaglanTickDone calls it when it exists): the next epoch's jobs.
function $eaglanTickEnd() { if ($eaglanPa.on) $eaglanPaSafeDispatch(); if (typeof $eaglanDwTick === 'function' && ($eaglanDw.on || $eaglanDw.pregen)) $eaglanDwTick(); }
function $eaglanPaChunksOk(w, res, q, E) {
  for (var cx = res[q + 2]; cx <= res[q + 4]; cx++) for (var cz = res[q + 3]; cz <= res[q + 5]; cz++) {
    var c = $eaglanPaChunk(w.F, cx, cz);
    if (c === null || c.$eaglanPaSentE !== E || c.$eaglanPaMod === E) return false;
  }
  return true;
}
function $eaglanPaFollow(a) {
  var s = $eaglanPa, j = a.$eaglanPaSlot, api = s.api;
  if (j < 0 || a.$eaglanPaE !== s.epoch || api === null) { s.st.none++; return $eaglanEcw(a); }
  var res = api.res, q = j * api.RW, E = s.epoch, st = Atomics.load(res, q);
  if (st !== (E * 4 + 1 | 0)) { if (st === (E * 4 + 2 | 0) || st === (E * 4 + 3 | 0)) s.st.thread++; else s.st.late++; return $eaglanEcw(a); }
  var J = api.jobs, o = j * api.JW, p = a.lv, e = a.rS;
  if (p !== s.jp[j] || p.rk !== J[o + 2] || p.vG !== J[o + 3] || e.ey !== J[o + 7] || e.eo !== J[o + 8] || a.cB_ !== J[o + 9] || e.bj1 !== Kr.prototype.bj1 || (e.yd ? 1 : 0) !== J[o + 10]) { s.st.changed++; return $eaglanEcw(a); }
  if (J[o + 10] && a.sc.NV) { s.st.changed++; return $eaglanEcw(a); }   // (getPathablePosY would look up through the water)
  var x = e.D + 0, y = e.dz.b2 + 0.5 | 0, z = e.E + 0;   // getEntityPosition (Gd7, DNS), from the fields
  if (x !== J[o + 4] || y !== J[o + 5] || z !== J[o + 6]) { s.st.moved++; return $eaglanEcw(a); }
  if (!$eaglanPaChunksOk(s.jw[j], res, q, E)) { s.st.blocks++; return $eaglanEcw(a); }
  var idx = res[q + 1];
  if (s.verify) { $eaglanEcw(a); if (p.rk === idx) s.st.checked++; else s.st.diff++; return; }
  var b = new FD(); b.c6 = x; b.c_ = y; b.c$ = z;   // (the vector checkForStuck keeps, as getEntityPosition makes it)
  p.rk = idx; BG1(a, b); s.st.used++;
}
// getPathToEntityLiving (EQC): the thread's path when it holds, else the game's own search (with its ChunkCache).
function $eaglanPaSearch(a, b) {
  var s = $eaglanPa, j = a.$eaglanPaSj, api = s.api;
  if (j < 0 || a.$eaglanPaSe !== s.epoch || api === null) { s.st.sNone++; return $eaglanEQC(a, b); }
  var res = api.res, q = j * api.RW, E = s.epoch, st = Atomics.load(res, q);
  if (st !== (E * 4 + 1 | 0)) { if (st === (E * 4 + 2 | 0) || st === (E * 4 + 3 | 0)) s.st.sThread++; else s.st.sLate++; return $eaglanEQC(a, b); }
  var J = api.jobs, o = j * api.JW, e = a.rS, d = e.dz, pr = a.sc, at = a.cLE;
  if (b !== s.jt[j] || b.D !== J[o + 20] || b.dz.b2 !== J[o + 21] || b.E !== J[o + 22] || e.D !== J[o + 2] || e.J !== J[o + 3] || e.E !== J[o + 4] ||
      d.cE !== J[o + 5] || d.b2 !== J[o + 6] || d.cD !== J[o + 7] || d.cJ !== J[o + 8] || d.cG !== J[o + 9] || d.cK !== J[o + 10] ||
      e.ey !== J[o + 11] || e.eo !== J[o + 12] || e.bj1 !== Kr.prototype.bj1 || (e.yd ? 1 : 0) !== J[o + 13] || at.fv || at.fw !== J[o + 15] ||
      pr.T3 !== J[o + 16] || pr.R$ !== J[o + 17] || pr.xv !== J[o + 18] || pr.NV !== J[o + 19] || $eaglanPaFall(e) !== J[o + 14]) { s.st.sChanged++; return $eaglanEQC(a, b); }
  if (!e.fy) {   // canNavigate (D7L) from the fields: on the ground; or, unable to swim, a zombie riding a chicken
    if (pr.NV) return $eaglanEQC(a, b);   // (it would look for water and lava around it: the game's own code)
    var rd = e.fd;
    if (!(rd !== null && e instanceof R8 && rd instanceof P0)) return $eaglanEQC(a, b);   // it cannot navigate: the game's own answer (no path)
  }
  // its ChunkCache would load any chunk of the region that is not loaded: the thread's path only when all are loaded
  var w = s.jw[j], fx = Math.floor(e.D), fz = Math.floor(e.E), c = (at.fw + 16.0) | 0, cx, cz;
  for (cx = (fx - c) >> 4; cx <= (fx + c) >> 4; cx++) for (cz = (fz - c) >> 4; cz <= (fz + c) >> 4; cz++) if ($eaglanPaChunk(w.F, cx, cz) === null) { s.st.sUnloaded++; return $eaglanEQC(a, b); }
  if (!$eaglanPaChunksOk(w, res, q, E)) { s.st.sBlocks++; return $eaglanEQC(a, b); }
  var n = res[q + 1], path = n === 0 ? null : $eaglanPaPath(api.pts, res[q + 6], n);
  if (s.verify) { var own = $eaglanEQC(a, b); if ($eaglanPaSame(own, path)) s.st.sChecked++; else s.st.sDiff++; return own; }
  s.st.sUsed++;
  return path;
}
// The PathEntity the search made (Ba7): its points with every field (x qN, y r0, z rr, hash a4u, heap index OO, total
// distance cK9, distance to next duv, to target bAe, visited bUk; each one's previous djS is the point before it).
// The game keeps these as small integers; a number read from a Float64Array is a double to V8, and storing one where
// the game stores integers would change how V8 lays out every PathPoint (and slow all path code): whole numbers go
// in as integers ($eaglanPaInt: the same number).
function $eaglanPaInt(v) { return v === (v | 0) ? v | 0 : v; }
function $eaglanPaPath(P, off, n) {
  var arr = H(Pq, n), d = arr.data, prev = null, i;
  for (i = 0; i < n; i++) {
    var k = off + i * 9, q = new Pq();
    q.qN = P[k] | 0; q.r0 = P[k + 1] | 0; q.rr = P[k + 2] | 0; q.a4u = P[k + 3] | 0; q.OO = P[k + 4] | 0;
    q.cK9 = $eaglanPaInt(P[k + 5]); q.duv = $eaglanPaInt(P[k + 6]); q.bAe = $eaglanPaInt(P[k + 7]); q.bUk = P[k + 8] | 0; q.djS = prev;
    d[i] = q; prev = q;
  }
  var pe = new B0Y(); pe.bn_ = arr; pe.vG = n;
  return pe;
}
function $eaglanPaSame(x, y) {
  if (x === null || y === null) return x === y;
  if (x.vG !== y.vG || x.rk !== y.rk || x.bn_.data.length !== y.bn_.data.length) return false;
  var a = x.bn_.data, b = y.bn_.data, i;
  for (i = 0; i < a.length; i++) {
    var p = a[i], q = b[i];
    if (p.qN !== q.qN || p.r0 !== q.r0 || p.rr !== q.rr || p.a4u !== q.a4u || p.OO !== q.OO || p.cK9 !== q.cK9 || p.duv !== q.duv || p.bAe !== q.bAe || (p.bUk ? 1 : 0) !== (q.bUk ? 1 : 0)) return false;
    if ((p.djS === null) !== (q.djS === null) || (i > 0 && (p.djS !== a[i - 1] || q.djS !== b[i - 1]))) return false;
  }
  return true;
}

// 4. 64-bit constants: every M(<number>, <number>) in code (not in a name, not a method) becomes $eaglanLc<n>,
// set by the same call right after 'var M=Long_create;' (the only place M is set; TeaVM's locals are lower case).
// Verify mode: each place makes the value again and compares ($eaglanLcV). Returns { src, sites, values } or
// { src, error } (the text unchanged).
const LONG_CREATE = 'var M=Long_create;';
function longConstants(src, verify = false) {
  const at = src.indexOf(LONG_CREATE);
  if (at < 0 || src.indexOf(LONG_CREATE, at + 1) >= 0) return { src, error: 'Long_create is not where it is expected' };
  const names = new Map(); let sites = 0;
  const out = src.replace(/(?<![\w$.])M\((-?\d+), (-?\d+)\)/g, (m, lo, hi) => {
    let n = names.get(m);
    if (n === undefined) { n = '$eaglanLc' + names.size; names.set(m, n); }
    sites++;
    return verify ? `$eaglanLcV(${n},${m})` : n;
  });
  const decl = 'var ' + [...names].map(([m, n]) => `${n}=${m}`).join(',') + ';' +
    (verify ? 'var $eaglanLcD=0;function $eaglanLcV(c,v){if(Long_ne(c,v))$eaglanLcD++;return c;}' : 'var $eaglanLcD=null;') +
    `(globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={})).longConstants=function(){return {on:true,verify:${verify},sites:${sites},values:${names.size},diff:$eaglanLcD};};`;
  return { src: out.replace(LONG_CREATE, () => LONG_CREATE + decl), sites, values: names.size };
}

// 5. lighting sets: a set the lighting engine puts into a queue, marked while empty (not when off, or once more).
function $eaglanLhMark(s) {
  var t = $eaglanSpLh;
  if (t.on && s !== null && !s.$eaglanLh && s.sx === 0 && !s.s7) { s.$eaglanLh = 1; t.sets++; if (t.verify) s.$eaglanLhKeys = new Set(); }
  return s;
}
// The slot hash of a marked set: both 32-bit halves of the key (a BigInt, or TeaVM's Long object where there is no BigInt)
// mixed, so that every bit, the height's too, reaches the low bits a slot is taken from.
function $eaglanLhHash(k) {
  var t = $eaglanSpLh, lo, hi, h;
  if (typeof k === 'bigint') { lo = Number(k & t.m32) | 0; hi = Number(k >> t.s32) | 0; } else { lo = k.lo; hi = k.hi; }
  h = Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77); h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D); h ^= h >>> 15;
  return h;
}
// Verify mode: add's answer on a marked set (r: 1 added, 0 there already) against the plain set kept beside it.
function $eaglanLhSeen(a, b, r) {
  var t = $eaglanSpLh, s = a.$eaglanLhKeys, k = typeof b === 'bigint' ? b : b.hi + ':' + b.lo, had = s.has(k);
  if (!had) s.add(k);
  t.adds++; if ((r !== 0) === had) t.diff++;
  return r;
}
function $eaglanLhKey(b) { return typeof b === 'bigint' ? b : b.hi + ':' + b.lo; }

// 6. collision boxes of other entities: EntityBoat.class (SA) into the static set of classes every new section knows
// (ClassInheritanceMultiMap.<clinit>, EIj: before the first section is made), when on.
function $eaglanCsInit() {
  var s = $eaglanSpCs, c;
  if (!s || !s.on || Lfl === null) return;
  c = $rt_cls(SA);
  if (!c.$id$) c.$id$ = $rt_nextId();
  Lfl.bi.RF(c, Lfl);
  s.boat = c;
}
// Why the entities CGv would find near mover b (box c) might give a box: 0 they cannot (b is neither a boat nor a
// minecart, and no section the walk visits has a boat), 1 the mover is a boat or a minecart, 2 a boat is in one of
// those sections, 3 a section there does not know boats. The chunks and sections are CGv's and Dbo's, computed as
// they compute them; an empty chunk (AU0) finds nothing (DuM). Lookups as the game's code makes them: a section's
// known classes (bnD.n9, an IdentityHashMap) as Ecd looks, its lists (baM, a HashMap) as Cyo looks.
function $eaglanCsWhy(a, b, c) {
  var boat = $eaglanSpCs.boat, id, f, g, h, i, j, k, l, m, n, y0, y1, lo, hi, t, e, sec;
  if (boat === null) return 3;
  if (b === null || b instanceof SA || b instanceof Md) return 1;
  id = boat.$id$;
  f = (c.cE - 2.0) / 16.0; g = f | 0; if (f < g) g = g - 1 | 0; f = (c.cJ + 2.0) / 16.0; h = f | 0; if (f < h) h = h - 1 | 0;
  f = (c.cD - 2.0) / 16.0; i = f | 0; if (f < i) i = i - 1 | 0; f = (c.cK + 2.0) / 16.0; j = f | 0; if (f < j) j = j - 1 | 0;
  f = (c.b2 - 2.0) / 16.0; y0 = f | 0; if (f < y0) y0 = y0 - 1 | 0; f = (c.cG + 2.0) / 16.0; y1 = f | 0; if (f < y1) y1 = y1 - 1 | 0;
  for (; g <= h; g = g + 1 | 0) {
    for (k = i; k <= j; k = k + 1 | 0) {
      l = a.F;
      if (!l.ua(g, k)) continue;
      l = l.bk(g, k);
      if (l === null || l instanceof AU0) continue;
      m = l.R3.data; n = m.length - 1 | 0;
      lo = 0; if (y0 >= lo) lo = y0 <= n ? y0 : n;
      hi = 0; if (y1 >= hi) hi = y1 <= n ? y1 : n;
      for (; lo <= hi; lo = lo + 1 | 0) {
        sec = m[lo];
        if (!sec.a_f.b) continue;
        t = sec.bnD.n9.l8.data; e = t[id & (t.length - 1 | 0)];
        while (e !== null && !(e.AJ == id && e.n === boat)) e = e.ox;
        if (e === null) return 3;
        t = sec.baM.o.data; e = t[id & (t.length - 1 | 0)];
        while (e !== null && !(e.s == id && e.n === boat)) e = e.p;
        if (e !== null && e.q !== null && e.q.b) return 2;
      }
    }
  }
  return 0;
}
// F5z's walk (CGv: world a, mover b, box c, predicate d; bb the mover's own box): CGv's list, or, when none of the
// entities it would find can give a box, an empty list that is never changed (F5z only reads it).
function $eaglanCsScan(a, b, c, d, bb) {
  var s = $eaglanSpCs, w, r, i, o, x;
  if (!s.on) return CGv(a, b, c, d);
  s.calls++;
  w = $eaglanCsWhy(a, b, c);
  if (w !== 0) {
    if (w === 1) s.mover++; else if (w === 2) s.boats++; else s.unknown++;
    return CGv(a, b, c, d);
  }
  s.skipped++;
  if (s.verify) {
    r = CGv(a, b, c, d);
    for (i = 0; i < r.b; i = i + 1 | 0) {
      o = r.f.data[i];
      x = o.cXC(); if (x !== null && Lk(x, bb)) { s.diff++; break; }
      x = b.dlf(o); if (x !== null && Lk(x, bb)) { s.diff++; break; }
    }
    return r;
  }
  r = s.empty;
  if (r === null || r.b) { r = s.empty = new V(); r.f = H(G, 10); }
  return r;
}

const SPEEDUP_WANTED = 'var $eaglanSpW=globalThis.__eaglanSpeedupsWanted||{};var $eaglanSpApi=globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={});\n';
const CHUNK_CACHE_CODE = SPEEDUP_WANTED +
  'var $eaglanSpCk={on:$eaglanSpW.chunkCache!==false,verify:$eaglanSpW.verify===true,hits:0,misses:0,diff:0};\n' +
  [$eaglanCk, $eaglanCkHas].map(String).join('\n') +
  '\n$eaglanSpApi.chunkCache=function(){var s=$eaglanSpCk;return {on:s.on,verify:s.verify,hits:s.hits,misses:s.misses,diff:s.diff};};\n';
const UUID_TEXT_CODE = SPEEDUP_WANTED +
  'var $eaglanSpUu={on:$eaglanSpW.uuidText!==false,verify:$eaglanSpW.verify===true,hits:0,misses:0,diff:0};\n' +
  String($eaglanUuidText).replace(/^function \$eaglanUuidText\(/, 'function CTz(') +
  '\n$eaglanSpApi.uuidText=function(){var s=$eaglanSpUu;return {on:s.on,verify:s.verify,hits:s.hits,misses:s.misses,diff:s.diff};};\n';
const LIGHT_SETS_CODE = SPEEDUP_WANTED +
  'var $eaglanSpLh={on:$eaglanSpW.lightSets!==false,verify:$eaglanSpW.verify===true,sets:0,adds:0,diff:0,m32:typeof BigInt==="function"?BigInt(4294967295):null,s32:typeof BigInt==="function"?BigInt(32):null};\n' +
  [$eaglanLhMark, $eaglanLhHash, $eaglanLhSeen, $eaglanLhKey].map(String).join('\n') +
  '\n$eaglanSpApi.lightSets=function(){var t=$eaglanSpLh;return {on:t.on,verify:t.verify,sets:t.sets,adds:t.adds,diff:t.diff};};\n';
const COLLISION_SCAN_CODE = SPEEDUP_WANTED +
  'var $eaglanSpCs={on:$eaglanSpW.collisionScan===true,verify:$eaglanSpW.verify===true,boat:null,empty:null,calls:0,skipped:0,mover:0,boats:0,unknown:0,diff:0};\n' +
  [$eaglanCsInit, $eaglanCsWhy, $eaglanCsScan].map(String).join('\n') +
  '\n$eaglanSpApi.collisionScan=function(){var s=$eaglanSpCs;return {on:s.on,verify:s.verify,ready:s.boat!==null,calls:s.calls,skipped:s.skipped,mover:s.mover,boats:s.boats,unknown:s.unknown,diff:s.diff};};\n';
const PACKET_BATCH_CODE = SPEEDUP_WANTED +
  'var $eaglanSpPk={on:$eaglanSpW.packetBatch!==false,verify:$eaglanSpW.verify===true,pack:$eaglanSpW.packetBatch!==false&&$eaglanSpW.packedHandover===true,ar:new Map(),packed:0,open:false,q:new Map(),n:0,seq:new Map(),kept:0,messages:0,flushes:0,t:0,held:0,heldMax:0};\n' +
  [$eaglanUstr, $eaglanPkQ, $eaglanPkPost, $eaglanPkPack, $eaglanPkSend, $eaglanPkNow, $eaglanPkOpen, $eaglanPkClose].map(String).join('\n') +
  '\n$eaglanSpApi.packetBatch=function(){var s=$eaglanSpPk;return {on:s.on,verify:s.verify,kept:s.kept,messages:s.messages,flushes:s.flushes,heldMs:s.flushes?s.held/s.flushes:0,heldMaxMs:s.heldMax};};\n' +
  '$eaglanSpApi.packedHandover=function(){var s=$eaglanSpPk;return {on:s.pack,packed:s.packed,players:s.ar.size};};\n';
const PATH_AHEAD_CODE =
  'var $eaglanPaW=globalThis.__eaglanPathAheadWanted||{};var $eaglanSpApi2=globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={});\n' +
  'var $eaglanPa={on:$eaglanPaW.on===true,searches:$eaglanPaW.searches===true,verify:$eaglanPaW.verify===true,api:null,epoch:0,pathSeq:0,jp:[],jw:[],jt:[],sent:new Map(),st:{ticks:0,jobs:0,used:0,none:0,late:0,thread:0,changed:0,moved:0,blocks:0,checked:0,diff:0,sJobs:0,sUsed:0,sNone:0,sLate:0,sThread:0,sChanged:0,sUnloaded:0,sBlocks:0,sChecked:0,sDiff:0}};\n' +
  [$eaglanPaBlk, $eaglanPaShare, $eaglanPaApi, $eaglanPaChunk, $eaglanPaKey, $eaglanPaWillSearch, $eaglanPaFall, $eaglanPaDispatch, $eaglanPaSafeDispatch, $eaglanTickEnd, $eaglanPaChunksOk, $eaglanPaFollow, $eaglanPaSearch, $eaglanPaInt, $eaglanPaPath, $eaglanPaSame].map(String).join('\n') +
  '\n$eaglanSpApi2.pathAhead=function(){var s=$eaglanPa;var r={on:s.on,searches:s.searches,verify:s.verify,ready:!!(s.api&&s.api.ready())};for(var k in s.st)r[k]=s.st[k];var t=s.api&&s.api.stats;if(t){r.threadMs=Math.round(t[0]);r.stepMs=Math.round(t[1]);r.steps=t[2];r.searchMs=Math.round(t[3]);r.searches=t[4];}return r;};\n';
// The thread's side (path-worker.js): the functions it runs, by name, and how it sets the game code up (Bootstrap.register).
const PATH_WORKER_CODE = 'globalThis.__eaglanPw={init:function(cb){$rt_startThread(function(){E$x();return 1;},cb);},follow:Ecw,isDirect:ETm,getBlockState:Fuf,' +
  'vec:function(x,y,z){var v=new FD;v.c6=x;v.c_=y;v.c$=z;return v;},' +
  'newFinder:function(){var n={sc:null};return EXt(n);},initProc:G5Q,pointTo:CXp,pointToCoords:FMc,addToPath:Fhl,postProc:GOb,cacheGet:Fw3};\n';
const ENCODE_ONCE_CODE = SPEEDUP_WANTED +
  'var $eaglanEo={on:$eaglanSpW.encodeOnce===true,verify:$eaglanSpW.verify===true,loop:null,pkt:null,st:null,cmx:0,f:null,cmp:null,hits:0,encoded:0,checked:0,diff:0};\n' +
  [$eaglanEoLoop, $eaglanEoKeeping, $eaglanEoHit, $eaglanEoSet].map(String).join('\n') +
  '\n$eaglanSpApi.encodeOnce=function(){var s=$eaglanEo;return {on:s.on,verify:s.verify,hits:s.hits,encoded:s.encoded,checked:s.checked,diff:s.diff};};\n';

// Regions (src/regions.js, config "regions"): what the game threads of several instances on one world need. Inactive
// unless the host gives this instance its settings (worker-runtime.js: globalThis.__eaglanRegions = { id, region,
// entityIdBase }); without them the game runs as before (one comparison per broadcast and per packet sent).
// - Broadcasts (ServerConfigurationManager.sendPacketToAllPlayers, Guo, and sendChatMsgImpl, FBL: chat, join and
//   leave messages, deaths, the tab list, scoreboard): the packet also goes to a network manager of its own whose
//   channel is ~eaglan-bc/<instance>; the host hands those frames to the players of the other instances. That
//   manager is never ticked (it is not in the channel map HG0), so sendPacket (CEM) skips its open check for it.
// - Entity IDs: instance k counts from entityIdBase (Entity.<clinit>, DrM: H29), so IDs never repeat across instances.
// - A region instance loads no spawn area (MinecraftServer.initialWorldChunkLoad, C1Z), keeps none loaded
//   (World.isSpawnChunk, EZO) and does not put a joining player at the spawn's top block first (EntityPlayerMP.<init>,
//   BLj: the saved position is read right after): the main instance has those chunks.
// - For the host: the players' positions, the cells with loaded chunks (ChunkProviderServer C5, its list bdn), world
//   time and weather (WorldInfo bR of the overworld: time cak, raining cwB, rainTime cuK, thundering ckL, thunderTime
//   ciK, clear-weather time bxv), and the world spawn.
const REGIONS_CODE = 
  'var $eaglanBcM=null,$eaglanSbQuiet=0;\n' +
  [$eaglanRgRegion, $eaglanBcMgr, $eaglanRgPlayers, $eaglanRgLoadedCells, $eaglanRgWorldState, $eaglanRgSetWorldState, $eaglanRgSetId, $eaglanRgMoving, $eaglanRgDropCells, $eaglanRgRuleOn, $eaglanRgSleepSkip, $eaglanRgAskId, $eaglanRgDataId, $eaglanRgSaveData, $eaglanRgRefreshMaps, $eaglanRgDropMaps, $eaglanSbApply].map(String).join('\n') +
  '\nglobalThis.__eaglanRegionsApi={players:$eaglanRgPlayers,loadedCells:$eaglanRgLoadedCells,worldState:$eaglanRgWorldState,setWorldState:$eaglanRgSetWorldState,' +
  'dropCells:function(cells,cb){$rt_startThread(function(){return $eaglanRgDropCells(cells);},cb);},' +
  'sleepSkip:function(setTime,cb){$rt_startThread(function(){return $eaglanRgSleepSkip(setTime);},cb);},' +
  'dataId:function(key,cb){$rt_startThread(function(){return $eaglanRgDataId(key);},cb);},' +
  'saveData:function(cb){$rt_startThread(function(){return $eaglanRgSaveData();},cb);},' +
  'refreshMaps:function(cb){$rt_startThread(function(){return $eaglanRgRefreshMaps();},cb);},' +
  'score:function(m,cb){$rt_startThread(function(){return $eaglanSbApply(m.op,m.name,m.obj==null?null:m.obj,m.value|0);},cb);}};\n';
function $eaglanRgRegion() { var r = globalThis.__eaglanRegions; return !!(r && r.region); }
function $eaglanBcMgr() {
  var r = globalThis.__eaglanRegions; if (!r) return null;
  if ($eaglanBcM === null) {
    if (KOJ === null || HU8 === null) return null;   // PLAY state and the packet buffer exist once a player has connected
    var m = new AZL(); m.op = $rt_str('~eaglan-bc/' + r.id); m.b4Q = KOJ; m.cmX = 1; $eaglanBcM = m;
  }
  return $eaglanBcM;
}
function $eaglanRgPlayers() {
  var s = HGX, out = []; if (s === null || !s.f1) return out;
  var l = s.f1.e1;
  // sleep: 0 awake, 1 in bed, 2 fully asleep (isPlayerSleeping nu, sleepTimer uY >= 100); spec: a spectator (game type
  // qE of the ItemInWorldManager l3 is SPECTATOR HLu), who keeps the night from being skipped, as in the game
  for (var i = 0; i < l.b; i++) {
    var p = l.f.data[i];
    out.push({ name: $rt_ustr(p.e7.eq), dim: p.tk, x: p.D, y: p.J, z: p.E, sleep: p.nu ? (p.uY >= 100 ? 2 : 1) : 0, spec: !!(p.l3 && p.l3.qE === HLu) });
  }
  return out;
}
function $eaglanRgLoadedCells() {
  var s = HGX, out = []; if (s === null || !s.gc) return out;
  var dims = [0, -1, 1], w = s.gc.data, sh = (globalThis.__eaglanRegions && globalThis.__eaglanRegions.cellShift) || 3;   // cells: region-cells.js
  for (var i = 0; i < w.length && i < 3; i++) {
    var ws = w[i]; if (!ws || !ws.C5 || !ws.C5.bdn) continue;
    for (var n = ws.C5.bdn.fn; n !== null; n = n.iZ) { var c = n.jy; out.push(dims[i] + ':' + (c.sk >> sh) + ':' + (c.rL >> sh)); }
  }
  return out;
}
function $eaglanRgWorldState() {
  var s = HGX; if (s === null || !s.gc || !s.gc.data[0]) return null;
  var i = s.gc.data[0].bR;
  // (spawnX/spawnZ: WorldInfo.getSpawnX bAD, getSpawnZ bAf)
  // (sleepPct: the world's playersSleepingPercentage, null when the game's own rule applies; "players sleeping percentage")
  return { time: Dj(i.cak), raining: i.cwB ? 1 : 0, rainTime: i.cuK, thundering: i.ckL ? 1 : 0, thunderTime: i.ciK, clear: i.bxv, spawnX: i.bAD(), spawnZ: i.bAf(),
    sleepPct: typeof $eaglanSleep === 'object' ? $eaglanSleep.pct(s.gc.data[0]) : null };
}
// A player moved here from another instance keeps the entity ID its client has (regions.js gives it in
// __eaglanRegions.ids by name): set on the new EntityPlayerMP (NetHandlerLoginServer.tryAcceptPlayer, DWb, right after
// ServerConfigurationManager.createPlayerForUser), before it is in any world. Entity.entityId is dK.
function $eaglanRgSetId(p) {
  var r = globalThis.__eaglanRegions; if (!r || !r.ids || !p || !p.e7) return;
  var n = $rt_ustr(p.e7.eq).toLowerCase(), id = r.ids[n];
  if (typeof id === 'number') { p.dK = id; delete r.ids[n]; }
}
// A player the host is moving here (it gave this instance the player's entity ID): EntityPlayerMP.<init> (BLj) skips
// its spawn search, which would read the world spawn's chunks before the player's saved position replaces it.
function $eaglanRgMoving(p) {
  var r = globalThis.__eaglanRegions; if (!r || !r.ids || !p || !p.e7) return false;
  return typeof r.ids[$rt_ustr(p.e7.eq).toLowerCase()] === 'number';
}
// GameRules.getBoolean(name) of world w (its rules' TreeMap fO.bZ: key cr, value dp, boolean hl; String.compareTo GO).
function $eaglanRgRuleOn(w, name) {
  var key = $rt_str(name), b = w.bR.gv().fO.bZ, d;
  while (b !== null) { d = GO(key, b.cr); if (!d) break; b = d >= 0 ? b.M : b.bW; }
  var v = b === null ? null : b.dp; return v !== null && !!v.hl;
}
// The night skipped because every player of every instance sleeps (the host decides; WorldServer.tick does it for one
// world, EuX): with setTime (the main instance) the overworld's time goes to the next morning when doDaylightCycle is
// on; then wakeAllPlayers (DZS: wakes the sleeping players, ends rain and thunder). Resumable, as the game's code is.
function $eaglanRgSleepSkip(setTime) {
  var w, i, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); w = $T.l(); setTime = $T.l(); }
  _: while (true) { switch ($p) {
    case 0:
      w = HGX === null || !HGX.gc ? null : HGX.gc.data[0]; if (w === null) return 0;
      if (setTime && $eaglanRgRuleOn(w, 'doDaylightCycle')) { i = U(w.bR.rJ(), L(24000)); w.bR.a0N(CD(i, Fs(i, L(24000)))); }
      $p = 1;
    case 1:
      DZS(w); if (B()) { break _; }
      return 1;
    default: FO();
  } }
  DJ().s(setTime, w, $p);
}
// MapStorage.getUniqueDataId (CMZ) in a region instance (a new map's id): the main instance counts, with its
// idcounts.dat, through the host; the game's thread waits for the answer as it waits for a file (TeaVM's way, G02).
function $eaglanRgAskId(key) {
  var thread = $rt_nativeThread(), javaThread = $rt_getThread();
  if (thread.isResuming()) { thread.status = 0; var result = thread.attribute; if (result instanceof Error) throw result; return result; }
  thread.suspend(function () {
    globalThis.__eaglanRegionsAsk('dataId', $rt_ustr(key), function (v) { thread.attribute = v; $rt_setThread(javaThread); thread.resume(); });
  });
  return null;
}
// The next id of `key` in the main instance (getUniqueDataId of the overworld's MapStorage Gx), for a region instance.
function $eaglanRgDataId(key) { var s = HGX; if (s === null || !s.gc || !s.gc.data[0]) return -1; return CMZ(s.gc.data[0].Gx, $rt_str(key)); }
// MapStorage.saveAllData (GbE): the data files that changed (a region instance writes only its maps), before a move.
function $eaglanRgSaveData() { var s = HGX; if (s === null || !s.gc || !s.gc.data[0]) return 0; GbE(s.gc.data[0].Gx); return 1; }
// After players moved in (regions.js): the maps this instance has in memory are written (merged with their files, which
// another instance may have changed: region-data.js MapBaselines), then taken out of the world's MapStorage (AT9: its
// list bHK and its map Qy by name; a saved data's name is WG), so that the game loads them again from their files when
// next used, with what every instance drew. Returns how many maps were taken out. (Run as a thread: when GbE waits for
// a file, the thread comes back here later and GbE carries on where it was.)
function $eaglanRgRefreshMaps() {
  var s = HGX; if (s === null || !s.gc || !s.gc.data[0]) return 0;
  var st = s.gc.data[0].Gx;
  GbE(st); if (B()) return 0;
  return $eaglanRgDropMaps(st);
}
function $eaglanRgDropMaps(st) {
  var isMap = function (x) { return x !== null && x.WG !== null && /^map_\d+$/.test($rt_ustr(x.WG)); };
  var list = new V(), map = new BT(), n = BO(16), t = H(BW, n), old = st.bHK, d = st.Qy.o.data, i, e, x, k = 0;
  map.G = 0; map.o = t; map.U = 0.75; map.Y = t.data.length * 0.75 | 0;
  list.f = H(G, 10);
  for (i = 0; i < old.b; i++) { x = old.f.data[i]; if (isMap(x)) { k++; continue; } Be(list, list.b + 1 | 0); list.f.data[list.b] = x; list.b = list.b + 1 | 0; }
  for (i = 0; i < d.length; i++) for (e = d[i]; e !== null; e = e.p) if (!isMap(e.q)) Eu$(map, e.n, e.q);
  st.bHK = list; st.Qy = map;
  return k;
}
// A score that changed in another instance, here (regions.js _score): op 'set' (getValueFromObjective F1b,
// setScorePoints B8_) or 'reset' (removeObjectiveFromEntity E9l; obj null: all of that name's scores), on the overworld's
// scoreboard i6 (getObjective B43); quietly ($eaglanSbQuiet: not reported back). Resumable, as the game's code is.
function $eaglanSbApply(op, name, obj, value) {
  var sb, o, sc, $p, $z; $p = 0;
  if (FQ()) { var $T = DJ(); $p = $T.l(); sc = $T.l(); o = $T.l(); sb = $T.l(); value = $T.l(); obj = $T.l(); name = $T.l(); op = $T.l(); }
  _: while (true) { switch ($p) {
    case 0:
      sb = HGX === null || !HGX.gc || !HGX.gc.data[0] ? null : HGX.gc.data[0].i6; if (sb === null) return 0;
      o = null; if (obj === null) { $p = 3; continue _; }
      $p = 1;
    case 1:
      $z = B43(sb, $rt_str(obj)); if (B()) { break _; } o = $z; if (o === null) return 0;
      if (op !== 'set') { $p = 3; continue _; }
      $p = 2;
    case 2:
      $z = F1b(sb, $rt_str(name), o); if (B()) { break _; } sc = $z;
      $p = 4; continue _;
    case 3:
      $eaglanSbQuiet = 1; E9l(sb, $rt_str(name), o); $eaglanSbQuiet = 0; if (B()) { break _; }
      return 1;
    case 4:
      $eaglanSbQuiet = 1; B8_(sc, value); $eaglanSbQuiet = 0; if (B()) { break _; }
      return 1;
    default: FO();
  } }
  DJ().s(op, name, obj, value, sb, o, sc, $p);
}
// Queues the loaded chunks of the given cells ('dim:cx:cz') that no player watches for unloading, as the game's own
// dropChunk does (ChunkProviderServer C5: its dropped set zC, LongHashSet.add Ef0; a chunk with a PlayerInstance in
// the PlayerManager Ly, map beT, is watched; spawn chunks of the main instance stay). Runs on a game thread.
function $eaglanRgDropCells(cells) {
  var s = HGX; if (s === null || !s.gc) return 0;
  var want = new Set(cells), dims = [0, -1, 1], w = s.gc.data, n = 0, main = !$eaglanRgRegion(), sh = (globalThis.__eaglanRegions && globalThis.__eaglanRegions.cellShift) || 3;
  for (var i = 0; i < w.length && i < 3; i++) {
    var ws = w[i]; if (!ws || !ws.C5 || !ws.C5.bdn) continue;
    var p = ws.C5, pm = ws.Ly, keys = [], sx = 0, sz = 0;
    if (main && i === 0) { sx = ws.bR.bAD(); sz = ws.bR.bAf(); }
    for (var nd = p.bdn.fn; nd !== null; nd = nd.iZ) {
      var c = nd.jy;
      if (!want.has(dims[i] + ':' + (c.sk >> sh) + ':' + (c.rL >> sh))) continue;
      if (pm && pm.beT && Ld(pm.beT, Dq(U(L(c.sk), L(2147483647)), Cw(U(L(c.rL), L(2147483647)), 32))) !== null) continue;
      if (main && i === 0 && Math.abs(c.sk * 16 + 8 - sx) <= 128 && Math.abs(c.rL * 16 + 8 - sz) <= 128) continue;
      keys.push(Dq(X(L(c.sk), M(4294967295, 0)), Cw(X(L(c.rL), M(4294967295, 0)), 32)));
    }
    for (var k = 0; k < keys.length; k++) { Ef0(p.zC, keys[k]); n++; }
  }
  return n;
}
function $eaglanRgSetWorldState(st) {
  var s = HGX; if (s === null || !s.gc || !s.gc.data[0] || !st) return false;
  var i = s.gc.data[0].bR;
  i.cak = HE7(st.time); i.cwB = st.raining ? 1 : 0; i.cuK = st.rainTime | 0; i.ckL = st.thundering ? 1 : 0; i.ciK = st.thunderTime | 0; i.bxv = st.clear | 0;
  return true;
}
// Equivalence harness (test/harness; worker-runtime.js calls it after each tick only with EAGLAN_HARNESS): the state
// of the game, to compare two runs: the next entity ID (H29) and, per world (HGX.gc), its time (WorldInfo bR: cak), the
// random-tick generator (updateLCG, Zf), its random-number generators (EaglercraftRandom, Hn: every field) and every
// loaded entity (loadedEntityList, pP) in order: ID dK, class, position D J E, motion bw bp bx, rotation bN cQ, its own
// random-number generator W, isDead dD, ticksExisted j2.
function $eaglanHarnessState() {
  var s = HGX, out = { nextId: H29, worlds: [] };
  if (s === null || !s.gc) return out;
  for (var i = 0; i < s.gc.data.length; i++) {
    var w = s.gc.data[i]; if (!w) { out.worlds.push(null); continue; }
    var l = w.pP, ents = [];
    for (var k = 0; k < l.b; k++) { var e = l.f.data[k]; ents.push([e.dK, (e.constructor.$meta && e.constructor.$meta.name) || e.constructor.name, e.D, e.J, e.E, e.bw, e.bp, e.bx, e.bN, e.cQ, $eaglanHarnessRng(e.W), e.dD ? 1 : 0, e.j2]); }
    var rngs = [];
    for (var key in w) { var v = w[key]; if (v instanceof Hn) rngs.push(key + '=' + $eaglanHarnessRng(v)); }
    out.worlds.push({ time: String(w.bR.cak), lcg: w.Zf, rngs: rngs, entities: ents });
  }
  return out;
}
function $eaglanHarnessRng(r) {
  if (!r) return null;
  var o = [];
  for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && k !== '$id$' && k !== 'V$') o.push(k + ':' + String(r[k]));
  return o.join(',');
}
const HARNESS_CODE = [$eaglanHarnessState, $eaglanHarnessRng].map(String).join('\n') + '\nglobalThis.__eaglanHarness={version:1,state:$eaglanHarnessState};\n';
// Regions: an inlined copy of a broadcast's loop over the players. The packet (variable v), just made by the text
// made, first goes to the broadcast manager (case n), then the loop (text loop) runs as before (case n + 1); end is
// the end of the function.
const bcEdits = (made, loop, end, v, n) => [
  { find: made + loop, replace: made + 'if($eaglanBcMgr()!==null){$p=' + n + ';continue _;}case ' + (n + 1) + ':' + loop },
  { find: end, replace: end.replace('default:FO();', () => 'case ' + n + ':CEM($eaglanBcMgr(),' + v + ');if(B()){break _;}$p=' + (n + 1) + ';continue _;default:FO();') },
];

const PATCHES = [
  {
    // "LAN game mode for joiners" (IPCPacket17ConfigureLAN). In u53,
    // ServerConfigurationManager.setPlayerGameTypeBasedOnOther (TeaVM name DDV, see the name table) is:
    //   if (other != null && !other.name.equals(serverOwner)) { target.setGameType(lanGameType); return; }
    //   ...else the vanilla gameType field (never set in u53) or the world's game type
    // It gets the player's previous entity on respawn but null on join, so a joining player got the
    // world's game mode and the LAN game mode only after dying. Measured with the unmodified client:
    // LAN game mode Creative, two new players joined in Survival and were Creative after respawning.
    // Correction: on join (other == null), use the joining player as "other" once a LAN game type is
    // set, so the game's own rule (everyone but the owner gets the LAN game mode) applies on join too.
    name: 'LAN game mode on join',
    find: 'function DDV(a,b,c,d){var e,f,g,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:if(c!==null){e=c.e7.eq;f=a.pf.JM;$p=1;continue _;}',
    replace: 'function DDV(a,b,c,d){var e,f,g,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:if(c===null&&a.daS!==null&&a.daS.BF>=0)c=b;if(c!==null){e=c.e7.eq;f=a.pf.JM;$p=1;continue _;}',
    skipped: 'joiners get the LAN game mode only after respawning',
  },
  {
    // "Command blocks" switch (web page Game Rules). The integrated server's isCommandBlockEnabled
    // (Fby, called when a player edits a command block) always returns true; with the switch off it
    // returns false, and the game shows its own "Command blocks are not enabled" message.
    name: 'command block switch (editing)',
    find: 'function Fby(a){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return 1;default:FO();}}DJ().s(a,$p);}',
    replace: 'function Fby(a){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return a.$eaglanNoCommandBlocks?0:1;default:FO();}}DJ().s(a,$p);}',
    skipped: 'the command block switch has no effect',
  },
  {
    // CommandBlockLogic.trigger (F1m) runs a command block's command; the isCommandBlockEnabled check
    // was compiled away (always true). With the switch off it does what the game does for a
    // disabled server: nothing runs and the block's success count is 0.
    name: 'command block switch (running)',
    find: 'b=HMl;if(b===null){a.a2$=0;return;}c=b.bsz;try{a.Pz=null;b=a.Zb;$p=2;continue _;}',
    replace: 'b=HMl;if(b===null||b.$eaglanNoCommandBlocks){a.a2$=0;return;}c=b.bsz;try{a.Pz=null;b=a.Zb;$p=2;continue _;}',
    skipped: 'the command block switch has no effect',
  },
  {
    // Lets the host apply game rules and server switches while the world runs (see game-rules.js
    // and worker-runtime.js). u53 has no message for this, and classes.js is one closure, so a small
    // object is defined next to GameRules.setOrCreateGameRule (F3p). A game rule is set the way the
    // /gamerule command does it: setOrCreateGameRule on the overworld's rules (World.getGameRules,
    // KD; all dimensions share them), then CommandGameRule.func_175773_a (GU$), which tells players'
    // clients about reducedDebugInfo. Each call runs on its own game thread ($rt_startThread: the
    // game code may pause and resume there). (Running /gamerule itself is not possible: this build
    // dropped MinecraftServer's command-sender methods.) The switches are fields of MinecraftServer
    // (HMl): pvpEnabled (cu5), allowFlight (dWQ), maxPlayerIdleMinutes (cuU), plus the command block
    // flag read by the two corrections above. The names are checked against the code that uses them
    // (requires) before anything is changed.
    name: 'game rules from the host',
    find: 'function F3p(a,b,c){',
    replace: 'globalThis.__eaglanHost={version:1,' +
      'rule:function(name,value,done){var s=HMl;if(s===null||s.gc===null||!s.gc.data[0]){done(new Error("the world is not loaded"));return;}' +
      'var r=KD(s.gc.data[0]),n=$rt_str(name),v=$rt_str(value);' +
      '$rt_startThread(function(){F3p(r,n,v);return 1;},function(x){if(x!==1){done(x);return;}$rt_startThread(function(){GU$(r,n);return 1;},done);});},' +
      'set:function(k,v){var s=HMl;if(s===null)return false;if(k==="pvp")s.cu5=v?1:0;else if(k==="flight")s.dWQ=v?1:0;else if(k==="idleMinutes")s.cuU=v|0;else if(k==="commandBlocks")s.$eaglanNoCommandBlocks=!v;else return false;return true;},' +
      'get:function(){var s=HMl;return s===null?null:{pvp:!!s.cu5,flight:!!s.dWQ,idleMinutes:s.cuU|0,commandBlocks:!s.$eaglanNoCommandBlocks};}};\n' +
      'function F3p(a,b,c){',
    requires: ['HMl=a;a.cOI=b;', 'a.cuR=1;a.bSl=1;a.cu5=1;a.dWQ=1;', 'if(a.J0.cu5){', 'a.po.cuU>0', 'function KD(a){return a.bR.gv();}', 'function GU$(b,c){', '$p=17;case 17:GU$(d,f);',
      'function $rt_startThread(runner,callback)', 'function $rt_str(str)'],
    skipped: 'game rules and server switches apply only through the world itself',
  },
  {
    // Console commands from the web page (daemon /console). Like a dedicated server's console:
    // commands wait in a queue and run on the server thread at the start of a tick
    // (MinecraftServer.updateTimeLightAndEntities, Gm3, before its scheduled-task loop), never in
    // the middle of one. They run through CommandHandler.executeCommand (Ejc) with a sender named
    // "Server" that may use every command. Like a dedicated server's console it is a MinecraftServer
    // (ALS) to the game, so commands report to it what they report only to the server console
    // (notifyOperators checks "instanceof ALS": messages for the server only, and output while the
    // game rule sendCommandFeedback is off). It is made with Object.create, so none of
    // MinecraftServer's code runs and the real server object is untouched; the ten ICommandSender
    // methods (names from the class entry of AVk, a sender class of /execute) are its own, with
    // console behaviour. Its chat output is kept and returned as text (ChatComponentText Dg) or
    // translation keys with arguments (ChatComponentTranslation C3), which the host translates.
    // begin() tells the host when the command starts, so it can show the server log lines it causes.
    // __eaglanConsole.complete runs MinecraftServer.getTabCompletions (D9u) for the Tab key.
    name: 'console commands from the host',
    edits: [
      {
        find: 'function Gm3(a){var b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,$$je,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();r=$T.l();q=$T.l();p=$T.l();o=$T.l();n=$T.l();m=$T.l();l=$T.l();k=$T.l();j=$T.l();i=$T.l();h=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:b=a.cx6;$p=1;',
        replace: 'var $eaglanCommands=[];\n' +
          'function $eaglanText(c){if(c===null||c===undefined)return null;var o,i;' +
          'if(c instanceof Dg)o={t:$rt_ustr(c.d5)};' +
          'else if(c instanceof C3){var a=c.a2a?c.a2a.data:[],args=[];for(i=0;i<a.length;i++){var x=a[i];args.push(x instanceof Ls?$eaglanText(x):{t:x===null?"null":(x instanceof K?$rt_ustr(x):(typeof x.dq==="function"?$rt_ustr(x.dq()):String(x)))});}o={k:$rt_ustr(c.a6i),a:args};}' +
          'else o={t:String(c)};' +
          'var sib=c.cI;if(sib&&sib.b>0){o.s=[];for(i=0;i<sib.b;i++)o.s.push($eaglanText(sib.f.data[i]));}return o;}\n' +
          'function $eaglanSender(out){var n=Object.create(ALS.prototype);G.call(n);n.fF=function(){return $rt_str("Server");};n.uu=function(){return Ke($rt_str("Server"));};n.uI=function(c){out.push(c);};' +
          'n.bqh=function(){return 1;};n.P5=function(){return Dp(0,0,0);};n.a5I=function(){return G9(0,0,0);};n.HK=function(){return HMl.gc.data[0];};' +
          'n.a$u=function(){return null;};n.cQt=function(){return 1;};n.uS=function(){};return n;}\n' +
          'globalThis.__eaglanConsole={version:1,' +
          'run:function(cmd,done,begin){var s=HMl;if(s===null||s.bsz===null||s.gc===null||!s.gc.data[0]){done({error:"the world is not loaded"});return;}var out=[];' +
          '$eaglanCommands.push({sender:$eaglanSender(out),command:$rt_str(cmd),failure:null,begin:begin||null,finish:function(r){var lines=[];' +
          'for(var i=0;i<out.length;i++){try{lines.push($eaglanText(out[i]));}catch(e){lines.push({t:"(a message that could not be read)"});}}' +
          'done({result:r,error:this.failure?String(this.failure.message||this.failure):null,out:lines});}});},' +
          'complete:function(text,done){var s=HMl;if(s===null||s.bsz===null){done({error:"the world is not loaded"});return;}var n=$eaglanSender([]),t=$rt_str(text);' +
          '$rt_startThread(function(){return D9u(s,n,t,null);},function(l){var r=[];try{if(l&&l.f)for(var i=0;i<l.b;i++)r.push($rt_ustr(l.f.data[i]));}catch(e){}done({list:r});});}};\n' +
          'function Gm3(a){var b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,$$je,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();r=$T.l();q=$T.l();p=$T.l();o=$T.l();n=$T.l();m=$T.l();l=$T.l();k=$T.l();j=$T.l();i=$T.l();h=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:if($eaglanCommands.length){b=$eaglanCommands.shift();$p=34;continue _;}b=a.cx6;$p=1;',
      },
      {
        find: 'b.bpN=0;d=0;b=a.bnw;$p=26;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,$p);}',
        replace: 'b.bpN=0;d=0;b=a.bnw;$p=26;continue _;case 34:if(b.begin){try{b.begin();}catch($$e){}}try{$z=Ejc(a.bsz,b.sender,b.command);if(B()){break _;}}catch($$e){$z=-1;b.failure=$$e;}try{b.finish($z);}catch($$e){}$p=0;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,$p);}',
      },
    ],
    requires: ['ALS,"MinecraftServer",', '!(b instanceof ALS))return;', 'function G(){this.V$=null;this.$id$=0;}',
      'AVk,0,G,[AFm],\n0,0,0,0,["fF",HEY(Ggr),"uu",HEY(Dq3),"uI",HEZ(Fpf),"bqh",HE0(E2j),"P5",HEY(DkF),"a5I",HEY(GM6),"HK",HEY(D43),"a$u",HEY(GX1),"cQt",HEY(CK6),"uS",HE0(Fmi)]',
      'function Ke(a){var b=new Dg();P9(b,a);return b;}', 'function P9(a,b){var c;c=new V;c.f=H(G,10);a.cI=c;a.d5=b;}',
      'function Dp(a,b,c){var d=new BJ();U0(d,a,b,c);return d;}', 'function G9(a,b,c){var d=new FD();X3(d,a,b,c);return d;}',
      'function C3(){var a=this;Ls.call(a);a.a6i=null;a.a2a=null;', 'Dg,"ChatComponentText",101,Ls,', 'function D9u(a,b,c,d){',
      'case 0:c=a.po.bsz;d=a.dy;$p=1;case 1:Ejc(c,d,b);', 'HMl=a;a.cOI=b;b=new BNi;', '"dq",HEY(EzI),"cY",HEZ(FXM),"dX",HEY(FBq)', 'function $rt_startThread(runner,callback)', 'function $rt_str(str)', 'function $rt_ustr(str)'],
    skipped: 'the web page console cannot run commands',
  },
  {
    // OP list from the web page console (config ops). Who may use commands is decided by
    // ServerConfigurationManager.canSendCommands (DGw): in u53 "cheats for every player" (the LAN
    // setting, dhr), or a player whose name is the server owner's while the world allows cheats.
    // With the headless host nobody is the owner, so that branch only let a player who picks the
    // owner name use commands. It is replaced by the host's OP list (names, any case); the
    // LAN cheats setting works as before. u53 has no /op command, so no player can change the list.
    name: 'OP list from the host',
    find: 'function DGw(a,b){var c,d,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:a:{if(!a.dhr){c=a.pf;d=c.JM===null?0:1;if(!(d&&c.gc.data[0].bR.dkS()&&Dz(a.pf.JM,b.eq))&&!a.ehB){d=0;break a;}}d=1;}return d;default:FO();}}DJ().s(a,b,c,d,$p);}',
    replace: 'var $eaglanOps=new Set();function $eaglanIsOp(n){return n!==null&&$eaglanOps.has($rt_ustr(n).toLowerCase());}\n' +
      'globalThis.__eaglanOps={version:1,set:function(list){$eaglanOps=new Set(list.map(function(x){return String(x).toLowerCase();}));return $eaglanOps.size;}};\n' +
      'function DGw(a,b){var c,d,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return a.dhr||$eaglanIsOp(b.eq)?1:0;default:FO();}}DJ().s(a,b,c,d,$p);}',
    requires: ['function $rt_ustr(str)', 'd=b.e7.eq;'],
    skipped: 'the OP list has no effect, and a player who uses the owner name can use commands',
  },
  {
    // Mob caps as in Minecraft 1.8.8 (config mobCaps "vanilla", the default; "viewDistance": as this build ships).
    // SpawnerAnimals.findChunksForSpawning (Cwt) spawns a creature type only while the world's loaded count of it
    // (countEntities BXk: every loaded mob of the type that may despawn) is at most max * chunks / 289, chunks being
    // those round the players. Vanilla counts the chunks within 8 of each player (17 x 17 = 289: per player 70
    // monsters, 10 animals, 15 ambient, 5 water creatures); this build counts within the server's view distance
    // instead (ServerConfigurationManager.viewDistance bFX), for the cap as for where it spawns. At the host's view
    // distance 4 that is 81 chunks: 19 monsters, 2 animals, 4 bats, 1 squid per player, and with the animals already
    // loaded round a player (worldgen's, and those in the outer chunks of the loaded area, where entities do not
    // update) counted against the 2, animals never spawn again (measured: test/harness/scenarios/animals.js).
    // Correction: the chunks counted for the cap are vanilla's (within 8 of each player, the inner 15 x 15 of each
    // remembered so that players near each other share them, as vanilla's eligible set does; computed in
    // $eaglanMobCaps when the view distance is below 8, the world border taken as containing them); mobs still spawn
    // only within the view distance (loaded chunks; at most 8 as in vanilla). From a view distance of 8 up exactly
    // vanilla's numbers and area.
    name: 'vanilla mob caps',
    edits: [
      { find: 'case 0:if(!c&&!d)return 0;f=a.byy;', replace: 'case 0:if(!c&&!d)return 0;$eaglanMobCaps.start();f=a.byy;' },
      { find: 'h=CE(f.E/16.0);i=b.uf.f1.bFX<<24>>24;', replace: 'h=CE(f.E/16.0);i=b.uf.f1.bFX<<24>>24;if($eaglanMobCaps.on){k=k+$eaglanMobCaps.player(u,h,i)|0;if(i>8)i=8;}' },
      { find: 'if(!Qj(a.byy,y)){k=k+1|0;if(!x){f=b.oQ;$p=10;continue _;}}', replace: 'if(!Qj(a.byy,y)){if(!$eaglanMobCaps.own)k=k+1|0;if(!x){f=b.oQ;$p=10;continue _;}}' },
      { find: 'if(Qj(a.byy,y))continue;k=k+1|0;if(!x)break;}f=b.oQ;continue _;case 11:', replace: 'if(Qj(a.byy,y))continue;if(!$eaglanMobCaps.own)k=k+1|0;if(!x)break;}f=b.oQ;continue _;case 11:' },
      { find: 'if(Qj(a.byy,y))continue;k=k+1|0;if(!x)break;}f=b.oQ;$p=10;continue _;', replace: 'if(Qj(a.byy,y))continue;if(!$eaglanMobCaps.own)k=k+1|0;if(!x)break;}f=b.oQ;$p=10;continue _;' },
      { find: 'function Cwt(a,b,c,d,e){', replace: MOB_CAPS_CODE + 'function Cwt(a,b,c,d,e){' },
    ],
    requires: ['function Ei3(){LcN=Km(17.0,2.0)|0;}', 'BXk(b,BtZ(s))<=(Bp(BOk(s),k)/LcN|0)', 'function Ev7(a,b){', 'case 0:a.bFX=b;'],
    skipped: 'the mob caps are those of this build (counted over the view distance: at 4, 2 animals and 19 monsters per player)',
  },
  {
    // The game rule playersSleepingPercentage (Minecraft 1.17; web page Game Rules, or /gamerule playersSleepingPercentage
    // <n>, which 1.8.8 stores like any rule): the night is skipped once that share of the players who are not spectators
    // sleep (at least one; ceil(players * n / 100), as 1.17), instead of all of them. In 1.8.8 WorldServer.tick (EuX)
    // skips the night when areAllPlayersAsleep (B$Q) says so: allPlayersSleeping (cqW, set by
    // updateAllPlayersSleepingFlag Etc when a player lies down or wakes: every player who is not a spectator in bed) and
    // every player asleep for 100 ticks (a spectator keeps the night from being skipped); nothing else reads cqW.
    // Correction: with the rule, B$Q counts the share itself, every tick, as 1.17 does; without the rule, or at 100, the
    // game's own code decides, unchanged ($eaglanSleep.pct null). With regions the host decides for every instance
    // (regions.js, with the share the main instance reports in worldState).
    name: 'players sleeping percentage',
    edits: [
      { find: 'case 0:if(!a.cqW)return 0;b=0;c=a.pD.b;', replace: 'case 0:if((b=$eaglanSleep.pct(a))!==null)return $eaglanSleep.asleep(a,b);if(!a.cqW)return 0;b=0;c=a.pD.b;' },
      { find: 'function Etc(a){', replace: SLEEP_CODE + 'function Etc(a){' },
    ],
    requires: ['function GO(a,b){var c,d,e,f,g,h,i,j;if(a===b)return 0;', 'function $rt_str(str)', 'var HLu=null', 'function B$Q(a){var b,c,d,e,$p,$z;$p=0;',
      '(a.bR.gv()).fO.bZ;', 'f=new UX;f.ZN=d;f.a1r=c;', 'if(d.nu){e=0;f=0;g=1;$p=1;continue _;}'],
    skipped: 'the game rule playersSleepingPercentage has no effect (every player must sleep, as the game decides)',
  },
  {
    // Tick times for the host (status, "Can't keep up" explanations, load tests). MinecraftServer.tick
    // (Gnh) ends by storing how long the tick took in tickTimeArray (b9$, nanoseconds, a long);
    // the host keeps a copy of each duration until the worker collects them every 5 s
    // (__eaglanTicks.take). Nothing in the game changes. At the end of each tick it also calls $eaglanTickEnd when
    // another patch defines it (path ahead), and the equivalence harness's hook in harness runs.
    name: 'tick times for the host',
    edits: [
      {
        find: 'function Gnh(a){',
        replace: 'var $eaglanTicks={n:0,ms:0,max:0,list:[]};\n' +
          'function $eaglanTickDone(t){var ms=Dj(t)/1e6,s=$eaglanTicks;s.n++;s.ms+=ms;if(ms>s.max)s.max=ms;if(s.list.length<4000)s.list.push(Math.round(ms*10)/10);if(typeof $eaglanTickEnd==="function")$eaglanTickEnd();if(globalThis.__eaglanHarnessTick)globalThis.__eaglanHarnessTick();}\n' +
          'globalThis.__eaglanTicks={version:1,take:function(){var s=$eaglanTicks;$eaglanTicks={n:0,ms:0,max:0,list:[]};return s;}};\n' +
          'function Gnh(a){',
      },
      { find: 'g[h]=CD(HE7(b*1000000.0),c);return;', replace: 'g[h]=CD(HE7(b*1000000.0),c);$eaglanTickDone(g[h]);return;' },
    ],
    requires: ['c=HE7(b*1000000.0);a.a0B=a.a0B+1|0;', 'g=a.b9$.data;h=a.a0B%100|0;b=HHE;$p=8;continue _;', 'var Dj=Long_toNumber;'],
    skipped: 'tick times are not reported',
  },
  {
    // Equivalence harness (test/harness): the game's state after each tick (HARNESS_CODE above). Nothing calls it unless
    // the host runs with EAGLAN_HARNESS; the game is unchanged.
    name: 'harness state (equivalence tests)',
    find: 'var H29=0;',
    replace: HARNESS_CODE + 'var H29=0;',
    requires: ['var H29=0;', 'function Hn(', 'c=a.pP;e=a.yq;', 'e=(a.Zf*3|0)+1013904223|0;a.Zf=e;'],
    skipped: 'the equivalence harness cannot compare states',
  },
  {
    // World pre-generation (host command "pregen"): see the functions at the top of this file. Their
    // text goes next to ChunkProviderServer.loadChunk (EIs); MinecraftServer.tick (Gnh) calls the step
    // right after updateTimeLightAndEntities (Gm3: commands, the worlds' ticks, players' packets),
    // as a new case of its state machine (it uses 0-22), and $eaglanPgProtect right before it.
    // The anchors check every name the code uses.
    name: 'world pre-generation',
    edits: [
      { find: 'function EIs(a,b,c){', replace: PREGEN_CODE + 'function EIs(a,b,c){' },
      { find: 'case 5:Gm3(a);if(B()){break _;}b=a.gc.data[0].bR.gv();', replace: 'case 5:$eaglanPgProtect(a);Gm3(a);if(B()){break _;}$p=23;case 23:$eaglanPregenStep(a);if(B()){break _;}b=a.gc.data[0].bR.gv();' },
    ],
    requires: [
      // loadChunk: droppedChunksSet zC, id2ChunkMap tA, loadedChunks bdn; generated/read counters
      'ABh(a.zC,d);e=Ld(a.tA,d);if(e!==null)return e;$p=1;case 1:$z=Dev(a,b,c);', 'HVj=HVj+1|0;', 'HVi=HVi+1|0;', 'f=a.bdn;i=f.el;', 'var HVi=0;', 'var HVj=0;',
      // LinkedList.add: size el, last nb, entry jy / brJ
      'f=new A1z;f.jy=b;b=a.iW;f.brJ=b;g=a.ed;f.iZ=g;if(b===null)d.fn=f;else b.iZ=f;if(g===null)d.nb=f;else g.brJ=f;a.iW=f;d.el=d.el+1|0;',
      // unloadSpawnChunks: WorldServer.C5 with loadChunk, PlayerManager Ly.beT keyed as below, Chunk sk/rL, dropChunk = zC.add (Ef0)
      'g=b.C5;h=(c.k+e|0)>>4;i=(c.m+f|0)>>4;$p=4;continue _;', 'g=b.Ly;l=Dq(U(L(k.sk),L(2147483647)),Cw(U(L(k.rL),L(2147483647)),32));if(!(Ld(g.beT,l)===null?0:1)){g=b.C5;',
      'g=g.zC;l=Dq(X(L(i),M(4294967295, 0)),Cw(X(L(h),M(4294967295, 0)),32));$p=5;continue _;', 'case 5:Ef0(g,l);if(B()){break _;}d=d+1|0;',
      'function Ld(a,b){', 'function Ef0(a,b){var c,d,e,f,g,h,i,$p,$z;', 'function ABh(a,b){var c,d,e,f,g,h;c=Ik(b,BN);if(!c){c=a.s7;a.s7=0;return c;}d=a.tq;e=a.Fv;', 'g=d.data[h];if(DX(g,BN))break;if(DX(b,g)){Bs9(a,h);return 1;}', 'var DX=Long_eq;', 'var R=Long_lo;', 'var HE8=Long_hi;', 'c=a.zC;if(!(c.sx+(!c.s7?0:1)|0?0:1))',
      // the tick: bXY = loadSpawnChunks; the main loop: bGw = when this tick was due, HHE = its clock
      'if(a.bXY!=f){if(!f){$p=9;continue _;}$p=10;continue _;}', 'a.bGw=U(a.bGw,L(50));$p=10;continue _;', 'c=HHE;$p=4;case 4:$z=c();if(B()){break _;}c=$z;d=HE7(c);',
      // WorldInfo spawn x/z (World.isSpawnChunk reads them the same way)
      'function G9d(a){return a.cs9;}', 'function GGQ(a){return a.cs7;}', '"bAD",HEY(G9d)', '"bAf",HEY(GGQ)', 'k=a.bR.bAf();e.k=n;e.u=m;e.m=k;',
      'HMl=a;a.cOI=b;', 'var Dj=Long_toNumber;', 'var M=Long_create;', 'var D=$rt_wrapException;', 'function $rt_ustr(str)',
      // nobody on the server: MinecraftServer.getConfigurationManager (f1), its player list (e1: playerLoggedIn adds to it, b its size)
      'function CpY(a){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return a.f1;',
      'case 0:c=a.e1;Be(c,c.b+1|0);d=c.f.data;e=c.b;c.b=e+1|0;d[e]=b;c.h=c.h+1|0;c=a.TP;f=b.k1;',
      // Chunk.func_150809_p (D7o) as the chunk's tick (Gol) calls it; its neighbour check through
      // ChunkProviderServer.getLoadedChunk (bGb); light populated bdH as the chunk is saved (writeChunkToNBT:
      // Alfheim's brF, then isLightPopulated F7x over it) and loaded (setLightPopulated Fm5, and brF)
      'function D7o(a){var b,c,d,e,f,$p,$z;$p=0;', 'case 0:a.IU=1;if(!a.brF){b=a.ia;$p=1;continue _;}', 'a.b40=1;if(!a.bdH&&a.IU){$p=1;continue _;}', 'case 1:D7o(a);if(B()){break _;}',
      'case 2:$z=b.bGb(e,f);if(B()){break _;}b=$z;if(b!==null&&b.brF){', 'if(b!==null&&b.brF){c:{d:while(true){d=d+1|0;while(d>1){c=c+1|0;if(c>1)break d;d=(-1);}if(c)break c;if(d)break c;}a.bdH=1;return;}', '"bGb",HE0(EBV)]',
      'e=C(3676);f=(!b.brF?0:1)<<24>>24;', 'e=C(3676);$p=10;case 10:$z=F7x(b);if(B()){break _;}f=$z;$p=11;case 11:CXt(d,', 'function F7x(a){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return a.bdH;',
      'd=C(3676);$p=12;case 12:$z=FbP(c,d);if(B()){break _;}e=$z;$p=13;case 13:Fm5(g,e);', 'function Fm5(a,b){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:a.bdH=b;return;', 'b=C(3676);$p=41;case 41:$z=FbP(c,b);if(B()){break _;}e=$z;$p=42;case 42:Fbr(g,e);',
    ],
    skipped: 'world pre-generation is not available',
  },
  {
    // "Autosave spread over ticks", see AUTOSAVE_CODE. Its step runs at the start of the tick's last
    // case (8: the tick's time is taken there), as cases 24 and 25 of their own.
    name: 'spread autosave',
    edits: [
      { find: 'function Dq_(a,b){', replace: AUTOSAVE_CODE + 'function Dq_(a,b){' },
      { find: 'case 11:Dq_(a,h);if(B()){break _;}', replace: 'case 11:if($eaglanAutosave.on){$eaglanAsStart(a);}else{Dq_(a,h);if(B()){break _;}}' },
      { find: 'case 8:$z=b();if(B()){break _;}b=$z;', replace: 'case 8:$p=24;case 24:$eaglanAutosaveStep(a);if(B()){break _;}$p=25;case 25:$z=b();if(B()){break _;}b=$z;' },
    ],
    requires: [
      // MinecraftServer.tick: every 900 ticks the players' data, then saveAllWorlds(true) in case 11;
      // every path ends in case 8, with b = the clock
      'if(a.a0B%900|0){g=a.b9$.data;h=a.a0B%100|0;b=HHE;$p=8;continue _;}b=a.f1;h=0;i=b.e1.b;if(h>=i){h=1;$p=11;continue _;}',
      'case 11:Dq_(a,h);if(B()){break _;}g=a.b9$.data;h=a.a0B%100|0;b=HHE;$p=8;continue _;',
      // saveAllWorlds: nothing while dj7, saveAllChunks(true) for each world
      'case 0:a:{if(!a.dj7){', 'case 1:CgP(h,i,d);if(B()){break _;}',
      // saveAllChunks: saveLevel, saveChunks, then dropChunk for each loaded chunk no player sees
      'case 2:Dl9(a);if(B()){break _;}', 'case 3:d.dM2(b,c);if(B()){break _;}c=a.C5.bdn;',
      'k=Dq(U(L(c.sk),L(2147483647)),Cw(U(L(c.rL),L(2147483647)),32));if(!(Ld(d.beT,k)===null?0:1))',
      '{d=a.C5;e=c.sk;l=c.rL;if(d.rZ.eA.Un()){c=d.rZ;$p=8;continue _;}c=d.zC;', 'case 8:$z=EZO(c,e,l);if(B()){break _;}m=$z;if(!m){c=d.zC;',
      // saveChunks(true), for each chunk; needsSaving is Fwj; saveExtraChunkData does nothing in u53
      'case 1:$z=c.ejC(b);if(B()){break _;}k=$z;if(k){if(a.bdj!==null){try{n=ABc(a.rZ);$p=3;continue _;}',
      'case 3:try{B4f(c,n);if(B()){break _;}j=a.bdj;e=a.rZ;$p=4;continue _;}', 'case 4:try{DZt(j,e,c);if(B()){break _;}$p=5;continue _;}',
      'case 5:b:{try{Wz();if(B()){break _;}HVk=HVk+1|0;break b;}', 'c.uv=0;d=d+1|0;if(d==24&&!b)return 0;', '"ejC",HEZ(Fwj)',
      'function GaV(a,b,c){var $p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:return;default:FO();',
      'function ABc(a){return a.bR.tI();}', 'case 0:a.c_4=b;return;',
      // ChunkProviderServer: canSave (worldObj rZ, dWo), the loaded chunks (map tA, LinkedList bdn: fn first,
      // node iZ next, jy item)
      'if(!a.rZ.dWo){', 'd=new HM;g=c.fn;h=null;d.i0=c;d.iY=c.h;d.ed=g;', 'f=new A1z;f.jy=b;b=a.iW;f.brJ=b;g=a.ed;f.iZ=g;', 'function Ld(a,b){',
      // the tick's clock (bGw: when this tick was due), longs, exceptions
      'a.bGw=U(a.bGw,L(50));$p=10;continue _;', 'c=HHE;$p=4;case 4:$z=c();if(B()){break _;}c=$z;d=HE7(c);',
      'var Dq=Long_or;var X', '=Long_and;var C4=Long_xor;var Cw=Long_shl;', 'var U=Long_add;', 'var L=Long_fromInt;', 'var M=Long_create;', 'var Dj=Long_toNumber;',
      'var D=$rt_wrapException;', 'function $rt_ustr(str)',
    ],
    skipped: 'the autosave saves every chunk in one tick, as the game does',
  },
  {
    // Multi-core mode, see MULTICORE_CODE. IntegratedServerPlayerNetworkManager.sendPacket (CEM)
    // compresses a LAN packet over 1 KB with the game's JavaScript zlib (G13 = EaglerZLIB.deflateFull,
    // level 5, window 15) into [2][length][zlib], sent in parts of 65,279 bytes. While the mode is on,
    // the packet goes to the host uncompressed instead, which builds the same frames.
    name: 'multi-core packets',
    edits: [
      { find: 'function CEM(a,b){', replace: MULTICORE_CODE + 'function CEM(a,b){' },
      { find: 'if(i>1024){f=HU9;if(!(f!==null&&f.data.length>=i))HU9=Cb(i);try{f=EPd(c);h=0;g=HU9;k=g.data;e=0;j=k.length;$p=23;continue _;}',
        replace: 'if(i>1024){if($eaglanZ.on&&$eaglanZSend(a.op,c,i))return;f=HU9;if(!(f!==null&&f.data.length>=i))HU9=Cb(i);try{f=EPd(c);h=0;g=HU9;k=g.data;e=0;j=k.length;$p=23;continue _;}' },
    ],
    requires: [
      // the packet is written from index 0 (writer K, reader R reset), then the LAN branch (cmX)
      'c=HU8;d=c.N;d.K=0;d.R=0;',
      // the compressed branch: deflateFull (G13 -> EAn: level 5, method 8, window 15, memory 8,
      // strategy 0), [2][length][zlib], parts of 65,279 bytes
      'case 23:a:{try{$z=G13(f,h,i,g,e,j);if(B()){break _;}h=$z;break a;}', 'AJR(i,5,8,15,8,0);',
      'f=Cb(5+h|0);g=f.data;g[0]=2;g[1]=((i>>>24|0)&255)<<24>>24;', 'h=65279;m=e-1|0;n=m%65279|0;',
      // the packet buffer's array; the channel (a.op) as sendPacket posts it (Fyr)
      'function EPd(a){return a.N.X.f7;}', 'b=RC(a.op,f);', 'function Fyr(b,c){$rt_globals.postMessage({ch:b,dat:c});}', 'function $rt_ustr(str)',
    ],
    skipped: 'the multi-core mode cannot take over packet compression; the game compresses its packets as before',
  },
  {
    // Multi-core mode, see MULTICORE_CODE. EaglerChunkLoader.saveChunk (DZt) writes a chunk file:
    // a VFileOutputStream (case 7), CompressedStreamTools.writeCompressed (GOw: gzip, JavaScript zlib)
    // in case 8, then close (case 9: the whole buffer to the storage layer). While the mode is on, cases
    // 40 and 41 (new; DZt uses 0-10) write the NBT uncompressed after the header instead, through a
    // DataOutputStream (A7Q) as writeCompressed does, then go on to close.
    name: 'multi-core saves',
    edits: [
      { find: 'case 8:a:{try{GOw(b,c);if(B()){break _;}break a;}', replace: 'case 8:a:{try{if($eaglanZ.on&&$eaglanZSaveHead(c)){$p=40;continue _;}GOw(b,c);if(B()){break _;}break a;}' },
      {
        find: 'case 10:a:{try{EMc(c);if(B()){break _;}break a;}catch($$e){$$je=D($$e);if($$je instanceof N){c=$$je;}else{throw $$e;}}B9(b,c);}F(b);default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,$p);}',
        replace: 'case 10:a:{try{EMc(c);if(B()){break _;}break a;}catch($$e){$$je=D($$e);if($$je instanceof N){c=$$je;}else{throw $$e;}}B9(b,c);}F(b);' +
          'case 40:d=A7Q(c);$p=41;case 41:GQr(b,d);if(B()){break _;}$eaglanZSaveTail(c);$p=9;continue _;' +
          'default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,$p);}',
      },
    ],
    requires: [
      // saveChunk: the stream (case 7), close (case 9)
      'case 7:CiP(c,e);if(B()){break _;}', 'case 9:EMc(c);if(B()){break _;}return;',
      // DataOutputStream(out) and CompressedStreamTools.write(nbt, DataOutput), as writeCompressed uses them
      'function A7Q(a){var b=new ABI();B0B(b,a);return b;}', 'function B0B(a,b){a.dR=b;a.bb6=Cb(8);}', 'function GQr(b,c){var d,e,$p,$z;$p=0;',
      // VFileOutputStream: a fresh 256-byte ByteBuffer (Sx: nC, c7 position, cj limit), grown as written;
      // close flips it; the storage write gets the whole buffer (the length in the header says where the
      // file ends)
      'a.a0q=N3(new $rt_globals.Int8Array(c));a.cL3=b;', 'function Sx(){var a=this;Bhr.call(a);a.jp=null;a.nC=null;a.hd=0;a.c7=0;a.cj=0;a.hL=0;}',
      'f=e.cj;g=e.c7;if((f-g|0)>=d){e=a.a0q;', 'b=a.a0q;if(b===null)return;b.cj=b.c7;b.c7=0;b.hL=(-1);',
      'e=c.nC;f=c.c7;g=e.byteOffset;e=e.buffer;g=g+f|0;f=c.cj-f|0;e=(new $rt_globals.Uint8Array(e,g,f)).buffer;',
      // loadChunk reads chunk files as gzip (CompressedStreamTools.readCompressed: window 31)
      'i=ACm(h,31);',
    ],
    skipped: 'the multi-core mode cannot take over the compression of saved chunks; the game compresses them as before',
  },
  {
    // Terrain threads, see TERRAIN_CODE. provideChunk (Fs1) gets a local n, saved and restored with
    // the others when the function pauses; n = 1 skips CO7, Em$, the caves and the ravines.
    name: 'terrain threads',
    edits: [
      { find: 'function Fs1(a,b,c){var d,e,f,g,h,i,j,k,l,m,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();m=$T.l();',
        replace: TERRAIN_CODE + 'function Fs1(a,b,c){var d,e,f,g,h,i,j,k,l,m,n,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();n=$T.l();m=$T.l();' },
      { find: 'f=new AO_;f.w1=R4(65536);f.ccn=HLp.r;$p=1;case 1:CO7(a,b,c,f);if(B()){break _;}',
        replace: 'f=new AO_;f.w1=R4(65536);f.ccn=HLp.r;n=$eaglanTgTake(b,c,f);$p=1;case 1:if(!n){CO7(a,b,c,f);if(B()){break _;}}' },
      { find: 'case 3:Em$(a,b,c,f,g);if(B()){break _;}if(a.kF.dW8){d=a.duS;l=a.jj;$p=4;continue _;}if(a.kF.c7A){d=a.did;l=a.jj;$p=5;continue _;}',
        replace: 'case 3:if(!n){Em$(a,b,c,f,g);if(B()){break _;}}if(!n&&a.kF.dW8){d=a.duS;l=a.jj;$p=4;continue _;}if(!n&&a.kF.c7A){d=a.did;l=a.jj;$p=5;continue _;}' },
      { find: '=d.eil(g,h,i,j,k);if(B()){break _;}g=$z;a.b8a=g;$p=3;', replace: '=n===2?$eaglanTgBiomes(g):d.eil(g,h,i,j,k);if(B()){break _;}g=$z;a.b8a=g;$p=3;' },
      { find: 'case 9:BVS(d,l,f,b,c);', replace: 'case 9:if($eaglanTgAt9(b,c,f,a.b8a))return null;BVS(d,l,f,b,c);' },
      { find: 'case 12:ETc(d);if(B()){break _;}return d;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,$p);}',
        replace: 'case 12:ETc(d);if(B()){break _;}return d;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,$p);}' },
    ],
    requires: [
      // the steps of provideChunk as described above: the biomes, the caves/ravines and the structures with
      // the same call (MapGenBase.generate), the structures only with mapFeaturesEnabled (o2)
      'case 1:CO7(a,b,c,f);if(B()){break _;}d=a.jj.eA.MC;g=a.b8a;h=b*16|0;i=c*16|0;j=16;k=16;$p=2;case 2:$z', '=d.eil(g,h,i,j,k);if(B()){break _;}g=$z;a.b8a=g;$p=3;',
      'case 4:EgL(d,a,l,b,c,f);if(B()){break _;}if(a.kF.c7A)', '{d=a.did;l=a.jj;$p=5;continue _;}if(a.kF.cgc&&a.o2){d=a.b8t;l=a.jj;$p=6;continue _;}',
      'case 11:EgL(d,a,l,b,c,f);if(B()){break _;}d=new Ng;l=a.jj;$p=9;continue _;', 'var R4=$rt_createShortArray;',
      // getBiomeGenForCoords (CzN) asks isBlockLoaded (C7X: chunkExists ua on the world's chunk provider F)
      'if(!c){d=a.eA.MC;$p=2;continue _;}e=a.F;', 'case 0:if(!Bz(a,b))return 0;c=b.k>>4;d=b.m>>4;b=a.F;$p=1;case 1:$z=b.ua(c,d);',
      // the overworld: ChunkProviderServer (C5: I8 generator; tA loaded chunks, as loadChunk looks them up), the save handler (bce) and its folder (a81)
      'case 10:B1o(d,a,f,k);if(B()){break _;}c.a6a=d;c.rZ=a;c.bdj=b;c.I8=e;a.C5=c;return c;', 'ABh(a.zC,d);e=Ld(a.tA,d);if(e!==null)return e;',
      'a.bce=b;a.bR=c;a.eA=d;a.oQ=d.cZs();a.bC=e;', 'e[0]=a.a81;f=b.KF;', 'f=$z;b.dT=f;b.lN=d;a.a81=b;', 'function A_p(){', 'HMl=a;a.cOI=b;',
      // the world's settings as GaM saves level.dat (see $eaglanTgLevel)
      'case 1:$z=b.ety(c);if(B()){break _;}b=$z;c=new CG;Co();B6();d=new BT;e=BO(16);d.G=0;f=H(BW,e);g=f.data;d.o=f;d.U=0.75;d.Y=g.length*0.75|0;c.A=d;h=C(683);$p=2;case 2:Eu$(d,h,b);if(B()){break _;}',
      'case 10:try{a:{try{GOw(c,i);', 'function GOw(b,c){', 'function KOG(){var a=new O$();ECf(a);return a;}', 'function RS(a){var b,c,d,e,f;b=a.Sx.data;',
      'function $rt_startThread(runner,callback){', 'var D=$rt_wrapException;',
      'function Ld(a,b){', 'var Dq=Long_or;var X', '=Long_and;', 'var Cw=Long_shl;', 'var L=Long_fromInt;', 'var M=Long_create;', 'function $rt_ustr(str)',
      // the biomes: provideChunk copies their ids (fr) into the chunk; getBiomeGenAt (F6R) makes its array as BiomeGenBase[] (E9)
      // and getBiomeFromBiomeList (Gre) takes each from the list (H1Y), the default (H2D) for an empty entry
      'g[b]=a.b8a.data[b].fr<<24>>24;', 'if(!(b!==null&&b.data.length>=Bp(e,f)))b=H(E9,Bp(e,f));if(g&&e==16&&f==16&&!(c&15)&&!(d&15)){h=a.br2;',
      'if(b>=0){d=H1Y.data;if(b<=d.length){e=d[b];if(e===null)e=c;return e;}}', 'case 3:HG();if(B()){break _;}h\n=H2D;', 'var H1Y=null', 'var H2D=null', 'var H=$rt_createArray;',
      // the players: the server's config manager (f1), its player list (e1), a player's dimension (tk) and position (D, J, E)
      'a.gc=null;a.f1=null;', 'if(l!==b&&l.tk==g){f=c-l.D;m=d-l.J;n=e-l.E;',
    ],
    skipped: 'terrain threads are not available; the game makes all terrain itself',
  },
  {
    // Speedup 1, see "speedups": put (Dta) and remove (ADP) of LongObjectHashMap count the map's changes;
    // provideChunk (Cin, Eu0) and chunkExists (Feb) ask $eaglanCk instead of building the 64-bit key.
    name: 'speedup: chunk lookups',
    edits: [
      { find: 'function Dta(a,b,c){', replace: 'function Dta(a,b,c){a.$eaglanMod=(a.$eaglanMod||0)+1;' },
      { find: 'function ADP(a,b){', replace: 'function ADP(a,b){a.$eaglanMod=(a.$eaglanMod||0)+1;' },
      { find: 'function Cin(a,b,c){', replace: CHUNK_CACHE_CODE + 'function Cin(a,b,c){' },
      { find: 'case 0:a:{d=Ld(a.tA,Dq(X(L(b),M(4294967295, 0)),Cw(X(L(c),M(4294967295, 0)),32)));if(d===null){if(a.rZ.a2Z)break a;', replace: 'case 0:a:{d=$eaglanCk(a,b,c);if(d===null){if(a.rZ.a2Z)break a;' },
      { find: 'b=Ld(a.tA,Dq(X(L(c),M(4294967295, 0)),Cw(X(L(d),M(4294967295, 0)),32)));if(b===null){if(a.rZ.a2Z)break a;', replace: 'b=$eaglanCk(a,c,d);if(b===null){if(a.rZ.a2Z)break a;' },
      { find: 'case 0:return ABR(a.tA,Dq(X(L(b),M(4294967295, 0)),Cw(X(L(c),M(4294967295, 0)),32)));', replace: 'case 0:return $eaglanCkHas(a,b,c);' },
    ],
    requires: [
      // the key as ChunkCoordIntPair.chunkXZ2Int (BeV) builds it; LongObjectHashMap.get (Ld) and remove (ADP) as above
      'function BeV(b,c){return Dq(X(L(b),M(4294967295, 0)),Cw(X(L(c),M(4294967295, 0)),32));}', 'function Ld(a,b){var c,d,e,f,g;c=Ik(b,BN);', 'function ADP(a,b){var c,d,e,f,g;c=a.Xi;d=Ik(b,BN);',
      // the chunk map's only changes: loadChunk puts the chunk (Dta), unloadQueuedChunks removes it (ADP)
      'f=a.tA;$p=3;case 3:Dta(f,d,e);if(B()){break _;}f=a.bdn;', 'ADP(a.tA,g);k=a.bdn;',
      'var Dq=Long_or;var X', '=Long_and;', 'var Cw=Long_shl;', 'var L=Long_fromInt;', 'var M=Long_create;',
    ],
    skipped: 'chunk lookups work as the game has them',
  },
  {
    // Speedup 2, see "speedups": EaglercraftUUID.toString (CTz) keeps its text; the game's own is $eaglanCTz.
    name: 'speedup: UUID text',
    edits: [
      { find: 'function CTz(a){var b,c,d,e,f,g,h,i,j,k,l,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();l=$T.l();', replace: UUID_TEXT_CODE + 'function $eaglanCTz(a){var b,c,d,e,f,g,h,i,j,k,l,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();l=$T.l();' },
    ],
    requires: [
      // EaglercraftUUID (FA): c9 and da its two halves, set by its constructors
      'function FA(){var a=this;G.call(a);a.c9=BN;a.da=BN;a.bQ=0;a.dt=0;}', 'function Byt(a,b,c){a.bQ=0;a.c9=b;a.da=c;}',
      // EntityLivingBase.getTeam: the scoreboard (x.i6) looked up by the UUID's text
      'case 0:b=a.x.i6;c=a.k1;$p=1;case 1:$z=CTz(c);if(B()){break _;}c=$z;$p=2;case 2:$z=CTX(b,c);', 'function $rt_ustr(str)',
    ],
    skipped: 'entity UUIDs are turned into text as the game does',
  },
  {
    // Speedup 3, see "speedups": ServerPlatformSingleplayer's postMessage (Fyr) goes through $eaglanPkPost,
    // its channel name through $eaglanUstr; the tick opens the hand-over around EntityTracker.updateTrackedEntities.
    name: 'speedup: packet hand-over',
    edits: [
      { find: 'function Fyr(b,c){$rt_globals.postMessage({ch:b,dat:c});}', replace: PACKET_BATCH_CODE + 'function Fyr(b,c){$eaglanPkPost(b,c,0);}' },
      { find: 'c=b.gj;b=b.gX.data.buffer;c=$rt_ustr(c);$p=2;case 2:Fyr(c,b);', replace: 'c=$eaglanUstr(b.gj);if($eaglanPkPack(c,b.gX.data))return;b=b.gX.data.buffer;$p=2;case 2:Fyr(c,b);' },
      { find: 'case 23:$z=GjB(c);if(B()){break _;}b=$z;$p=24;case 24:Fl0(b);if(B()){break _;}', replace: 'case 23:$z=GjB(c);if(B()){break _;}b=$z;$p=24;case 24:$eaglanPkOpen();Fl0(b);if(B()){break _;}$eaglanPkClose();' },
    ],
    requires: ['"~!IPC"', 'function $rt_ustr(str)', 'function GjB(a){'],
    skipped: 'every packet is handed to the host on its own, as the game does',
  },
  {
    // Speedup 5, see "speedups": every LongHashSet (We) gets the fields $eaglanLh (marked) and $eaglanLhKeys (verify); the
    // lighting engine's sets are marked where it puts them into its queues (AY); the five places a slot is computed take
    // the marked sets' hash; add (Ef0) and remove (ABh) and the in-place clear of a queue's set (E_p) keep the verify set.
    name: 'speedup: lighting sets',
    edits: [
      { find: 'function We(){var a=this;AK1.call(a);a.tq=null;a.sx=0;a.Fv=0;a.a2j=0;a.s7=0;a.a6e=0.0;a.sF=0;}',
        replace: LIGHT_SETS_CODE + 'function We(){var a=this;AK1.call(a);a.tq=null;a.sx=0;a.Fv=0;a.a2j=0;a.s7=0;a.a6e=0.0;a.sF=0;a.$eaglanLh=0;a.$eaglanLhKeys=null;}' },
      // add (Ef0): the slot, and its answers for the verify set
      { find: 'e=a.s7?0:1;a.s7=1;return e;}f=a.tq;g=a.Fv;', replace: 'e=a.s7?0:1;a.s7=1;return a.$eaglanLhKeys===null?e:$eaglanLhSeen(a,b,e);}f=a.tq;g=a.Fv;' },
      { find: 'h=T(b,M(2135587861, 2654435769));c=R(C4(h,Ba(h,32)))&g;', replace: 'c=(a.$eaglanLh?$eaglanLhHash(b):(h=T(b,M(2135587861, 2654435769)),R(C4(h,Ba(h,32)))))&g;' },
      { find: 'if(DX(h,BN)){if(a.sx!=a.a2j){i[c]=b;a.sx=a.sx+1|0;return 1;}', replace: 'if(DX(h,BN)){if(a.sx!=a.a2j){i[c]=b;a.sx=a.sx+1|0;return a.$eaglanLhKeys===null?1:$eaglanLhSeen(a,b,1);}' },
      { find: 'c=(c+1|0)&g;}return 0;case 1:DRx(a,c,b);if(B()){break _;}a.sx=a.sx+1|0;return 1;',
        replace: 'c=(c+1|0)&g;}return a.$eaglanLhKeys===null?0:$eaglanLhSeen(a,b,0);case 1:DRx(a,c,b);if(B()){break _;}a.sx=a.sx+1|0;return a.$eaglanLhKeys===null?1:$eaglanLhSeen(a,b,1);' },
      // contains (Qj), remove (ABh) and its shift (Bs9), rehash (XA)
      { find: 'function Qj(a,b){var c,d,e,f,g;c=Ik(b,BN);if(!c)return a.s7;d=a.tq;e=a.Fv;if(!K9l&&!c){f=new CB;f.c=1;f.d=1;F(f);}g=T(b,M(2135587861, 2654435769));c=R(C4(g,Ba(g,32)))&e;',
        replace: 'function Qj(a,b){var c,d,e,f,g;c=Ik(b,BN);if(!c)return a.s7;d=a.tq;e=a.Fv;if(!K9l&&!c){f=new CB;f.c=1;f.d=1;F(f);}c=(a.$eaglanLh?$eaglanLhHash(b):(g=T(b,M(2135587861, 2654435769)),R(C4(g,Ba(g,32)))))&e;' },
      { find: 'g=T(b,M(2135587861, 2654435769));h=R(C4(g,Ba(g,32)))&e;', replace: 'h=(a.$eaglanLh?$eaglanLhHash(b):(g=T(b,M(2135587861, 2654435769)),R(C4(g,Ba(g,32)))))&e;' },
      { find: 'if(DX(b,g)){Bs9(a,h);return 1;}', replace: 'if(DX(b,g)){Bs9(a,h);if(a.$eaglanLhKeys!==null)a.$eaglanLhKeys.delete($eaglanLhKey(b));return 1;}' },
      { find: 'k=T(h,M(2135587861, 2654435769));if(((g-R(C4(k,Ba(k,32)))|0)&d)>=e)', replace: 'if(((g-(a.$eaglanLh?$eaglanLhHash(h):(k=T(h,M(2135587861, 2654435769)),R(C4(k,Ba(k,32)))))|0)&d)>=e)' },
      { find: 'j=T(i,M(2135587861, 2654435769));d=R(C4(j,Ba(j,32)))&e;', replace: 'd=(a.$eaglanLh?$eaglanLhHash(i):(j=T(i,M(2135587861, 2654435769)),R(C4(j,Ba(j,32)))))&e;' },
      // a queue's set cleared in place (E_p, after the queue was worked off)
      { find: 'if(((c*3|0)/2|0)<=d){b.sx=0;b.s7=0;f=0;', replace: 'if(((c*3|0)/2|0)<=d){b.sx=0;b.s7=0;if(b.$eaglanLhKeys!==null)b.$eaglanLhKeys.clear();f=0;' },
      // the lighting engine's sets, marked where they are put into its queues (AY): EOd, E_p, BO_
      { find: '{a.AY=c;', replace: '{a.AY=$eaglanLhMark(c);' },
      { find: ';a.AY=c;', replace: ';a.AY=$eaglanLhMark(c);' },
      { find: 'a.AY=b;return;}', replace: 'a.AY=$eaglanLhMark(b);return;}' },
      { find: 'a.AY=b;return;d', replace: 'a.AY=$eaglanLhMark(b);return;d' },
      { find: '{b.AY=c;c=new ADA;$', replace: '{b.AY=$eaglanLhMark(c);c=new ADA;$' },
      { find: ';b.AY=c;c=new ADA;$', replace: ';b.AY=$eaglanLhMark(c);c=new ADA;$' },
      { find: '{b.AY=c;c=new ADA;h', replace: '{b.AY=$eaglanLhMark(c);c=new ADA;h' },
      { find: ';b.AY=c;c=new ADA;h', replace: ';b.AY=$eaglanLhMark(c);c=new ADA;h' },
      { find: 'c.AY=b;', replace: 'c.AY=$eaglanLhMark(b);' },
    ],
    requires: [
      // a lighting queue (UZ): its deque sa and its set AY; positions queued for a light type's queue (Aq) of the engine (qJ)
      'function UZ(){var a=this;G.call(a);a.sa=null;a.AY=null;}', 'k=k.qJ;$p=9;continue _;', 'k=k.Aq.data[o.z];o=k.AY;$p=10;case 10:$z=Ef0(o,p);',
      // the set's methods as described: add, contains, remove and shift, rehash; the 64-bit helpers
      'function Ef0(a,b){', 'function ABh(a,b){', 'function Bs9(a,b){', 'function XA(a,b){', 'function E_p(a){', 'function EOd(a,b){', 'function BO_(a,b){',
      'var T=Long_mul;', 'var R=Long_lo;', 'var C4=Long_xor;', 'var Ba=Long_shru;', 'var DX=Long_eq;', 'var BN=Long_ZERO;', 'var M=Long_create;',
    ],
    skipped: 'the lighting engine\'s position sets use the game\'s own hash',
  },
  {
    // Speedup 6, see "speedups": EntityBoat.class joins the classes every new section knows when that class is set up
    // (EIj); getCollidingBoundingBoxes (F5z) has the entities near the mover walked by $eaglanCsScan.
    name: 'speedup: collision scan',
    edits: [
      { find: 'function EIj(){var b,c,d,e,f;b=new CW;c=new BT;d=BO(16);c.G=0;e=H(BW,d);f=e.data;c.o=e;c.U=0.75;c.Y=f.length*0.75|0;b.bi=c;Lfl=b;}',
        replace: COLLISION_SCAN_CODE + 'function EIj(){var b,c,d,e,f;b=new CW;c=new BT;d=BO(16);c.G=0;e=H(BW,d);f=e.data;c.o=e;c.U=0.75;c.Y=f.length*0.75|0;b.bi=c;Lfl=b;$eaglanCsInit();}' },
      { find: 'case 2:$z=CGv(a,b,w,q);if(B()){break _;}q=$z;i=0;$p=3;', replace: 'case 2:$z=$eaglanCsScan(a,b,w,q,c);if(B()){break _;}q=$z;i=0;$p=3;' },
    ],
    requires: [
      // F5z: the box grown by 0.25 (w) for CGv; then for each entity found, its own box (cXC) and the mover's box for it
      // (dlf), each kept if it meets the mover's box (c)
      'w=new DB;w.cE=Ca(g,u);w.b2=Ca(s,v);w.cD=Ca(t,e);w.cJ=Cc(g,u);w.cG=Cc(s,v);w.cK=Cc(t,e);q=H35;$p=2;continue _;',
      'w=q.f.data[i].cXC();if(w!==null&&Lk(w,c)){$p=6;continue _;}', 'case 5:$z=b.dlf(w);if(B()){break _;}w=$z;if(w!==null&&Lk(w,c)){$p=7;continue _;}',
      // an entity's own box only a boat's (Gxv); the mover's box for another only a boat's (Eci) and a minecart's (FfU)
      '"cXC",HEY(GOn)', '"cXC",HEY(GZ8)', '"cXC",HEY(G_F)', '"cXC",HEY(Gxv)', 'function GOn(a){return null;}', 'function GZ8(a){return null;}', 'function G_F(a){return null;}', 'function Gxv(a){return a.dz;}',
      '"dlf",HEZ(CDr)', '"dlf",HEZ(Eci)', '"dlf",HEZ(FfU)', 'function CDr(a,b){return null;}',
      'SA,"EntityBoat",140,ER,', 'Md,"EntityMinecart",140,ER,', 'AU0,"EmptyChunk",97,Ng,', '"el9",HE2(Dbo)', '"el9",HE2(DuM)', 'function DuM(a,b,c,d,e){}',
      // CGv's chunks (chunkExists ua, provideChunk bk, then the chunk's el9) and Dbo's sections
      'case 0:e=new V;e.f=H(G,10);f=(c.cE-2.0)/16.0;g=f|0;if(f<g)g=g-1|0;f=(c.cJ+2.0)/16.0;h=f|0;if(f<h)h=h-1|0;f=(c.cD-2.0)/16.0;i=f|0;if(f<i)i=i-1|0;f=(c.cK+2.0)/16.0;j=f|0;if(f<j)j=j-1|0;while(g<=h){k=i;if(k<=j){l=a.F;$p=1;continue _;}',
      'case 1:$z=l.ua(g,k);if(B()){break _;}m', 'case 2:$z=l.bk(g,k);if(B()){break _;}l=$z;if(l!==null){$p=3;continue _;}', 'case 3:l.el9(b,c,e,d);',
      'case 0:f=(c.b2-2.0)/16.0;g=f|0;if(f<g)g=g-1|0;f=(c.cG+2.0)/16.0;h=f|0;if(f<h)h=h-1|0;i=0;j=a.R3.data.length-1|0;if(g>=i)i=g<=j?g:j;k=0;if(h>=k)k=h<=j?h:j;while(i<=k){l=a.R3.data;if(!(l[i].a_f.b?0:1)){m=l[i];$p=1;continue _;}',
      // a section (AUM): its lists (baM), known classes (bnD), all its entities (a_f); a new one knows the static set's
      // classes (BML); add (Chunk.addEntity, EsZ) and remove (Cyo) keep the list of every known class the entity is one of
      'function AUM(){var a=this;K8.call(a);a.baM=null;a.bnD=null;a.do0=null;a.a_f=null;}', 'var Lfl=null;',
      'b=Lfl.bi;$p=2;case 2:$z=b.iI();if(B()){break _;}b=$z;$p=3;case 3:$z=b.bK();', 'c=Lfl;h=c.bi;$p=6;case 6:$z=h.RF(b,c);',
      'i=g[f];j=i.bnD.n9;if(j.cy===null)', 'function Cyo(a,b){',
      'q=m.l8.data;m=q[h&(q.length-1|0)];while(m!==null&&!(m.AJ==h&&(b!==m.n?0:1))){m=m.ox;}', 'l=j.o.data;d=l[k&(l.length-1|0)];while(d!==null){if(d.s==k){e=d.n;',
      'function V(){var a=this;R3.call(a);a.f=null;a.b=0;}', 'function Lk(a,b){return b.cJ>a.cE&&b.cE<a.cJ?(b.cG>a.b2&&b.b2<a.cG?(b.cK>a.cD&&b.cD<a.cK?1:0):0):0;}',
      'function $rt_cls(cls){return HK(cls);}', 'function $rt_nextId(){',
    ],
    skipped: 'a moving entity walks the entities near it as before',
  },
  {
    // Speedup 7 (stage 8, path 2), see "encode once" above: the tracker's two send loops run inside $eaglanEoLoop; CEM
    // takes the frame made for the previous player of the loop when there is one ($eaglanEoHit, straight to its send),
    // and keeps each whole frame it makes there ($eaglanEoSet).
    name: 'speedup: encode once',
    edits: [
      { find: 'function CK2(a,b){', replace: ENCODE_ONCE_CODE + 'function CK2(a,b){return $eaglanEoLoop($eaglanCK2,a,b);}\nfunction $eaglanCK2(a,b){' },
      { find: 'function EeI(a,b){', replace: 'function EeI(a,b){return $eaglanEoLoop($eaglanEeI,a,b);}\nfunction $eaglanEeI(a,b){' },
      { find: 'if(!(d!==HVd?0:1))return;try{d=a.b4Q;ABa();c=HVe;$p=3;continue _;}', replace: 'if(!(d!==HVd?0:1))return;c=$eaglanEoHit(a,b);if(c!==null){b=RC(a.op,c);$p=22;continue _;}try{d=a.b4Q;ABa();c=HVe;$p=3;continue _;}' },
      { find: 'case 21:B2C(c,f,e,i);if\n(B()){break _;}b=RC(a.op,f);$p=22;case 22:EmG(b);if(B()){break _;}return;', replace: 'case 21:B2C(c,f,e,i);if\n(B()){break _;}$eaglanEoSet(a,b,f);b=RC(a.op,f);$p=22;case 22:EmG(b);if(B()){break _;}return;' },
    ],
    requires: [
      // CK2 / EeI: over the entry's players (v8), each player's NetHandlerPlayServer (ch) gets the packet (Gcp), which
      // passes it to its network manager (ED) after the chat check
      'case 4:$z=d.bz();if(B()){break _;}c=$z;c=c.ch;$p=5;case 5:Gcp(c,b);if(B()){break _;}$p=3;continue _;',
      'try{c=a.ED;$p=1;continue _;}', 'case 1:a:{try{CEM(c,b);if(B()){break _;}}',
      // CEM: the packet's id from the connection state (b4Q), a whole frame [0, id, data] for up to 65,279 bytes when
      // compression is on (cmX) and the packet is up to 1,024 bytes, handed to the IPC send (RC, EmG)
      'case 3:a:{try{$z=DK6(d,c,b);if(B()){break _;}c=$z;e=Hq(c);}', 'if(i>1024){if($eaglanZ.on&&$eaglanZSend(a.op,c,i))return;',
      'e=65279;if(i<=e){f=Cb(i+', 'f.data[0]=0;e=1;$p=21;continue _;}', 'function RC(a,b){var c=new EX();G8A(c,a,b);return c;}',
      'case 0:$p=1;case 1:Es();if(B()){break _;}if(HG4){$p=3;continue _;}c=$eaglanUstr(b.gj);if($eaglanPkPack(c,b.gX.data))return;b=b.gX.data.buffer;$p=2;case 2:Fyr(c,b);',
    ],
    skipped: 'every player\'s packets are made for each of them',
  },
  {
    // Path 3 of stage 8 (config pathAhead), see "path ahead" above and src/path-ahead.js.
    name: 'path ahead',
    edits: [
      // fields of their own from the start (the same object shapes whether used or not)
      { find: 'function B0Y(){var a=this;G.call(a);a.bn_=null;a.rk=0;a.vG=0;}', replace: 'function B0Y(){var a=this;G.call(a);a.bn_=null;a.rk=0;a.vG=0;a.$eaglanPaId=0;a.$eaglanPaSentE=-1;}' },
      { find: 'function AT2(){var a=this;G.call(a);a.rS=null;', replace: 'function AT2(){var a=this;G.call(a);a.$eaglanPaSlot=-1;a.$eaglanPaE=-1;a.$eaglanPaSj=-1;a.$eaglanPaSe=-1;a.rS=null;' },
      { find: 'function Ng(){var a=this;G.call(a);a.xT=null;', replace: 'function Ng(){var a=this;G.call(a);a.$eaglanPaMod=-1;a.$eaglanPaSentE=-1;a.xT=null;' },
      // block arrays on shared memory (Chunk.<init> BVS, setBlockState E53, setLightFor DVg, fillChunk DOG, ExtendedBlockStorage.<init> G3L, setData BWn)
      { find: 'm.a_l=n;m.R8=I(4096);', replace: 'm.a_l=n;m.R8=$eaglanPaBlk();' },
      { find: 'o.a_l=q;o.R8=I(4096);', replace: 'o.a_l=q;o.R8=$eaglanPaBlk();' },
      { find: 'j.a_l=k;j.R8=I(4096);', replace: 'j.a_l=k;j.R8=$eaglanPaBlk();' },
      { find: 'i.a_l=j;i.R8=I(4096);', replace: 'i.a_l=j;i.R8=$eaglanPaBlk();' },
      { find: 'a.a_l=b;a.R8=I(4096);', replace: 'a.a_l=b;a.R8=$eaglanPaBlk();' },
      { find: 'function BWn(a,b){a.R8=b;}', replace: 'function BWn(a,b){a.R8=$eaglanPaShare(b);}' },
      // Chunk.setBlockState: the chunk changed in this epoch
      { find: 'case 0:d=b.k&15;e=b.u;f=b.m&15;g=f<<4;h=g|d;i=a.YD.data;', replace: 'case 0:a.$eaglanPaMod=$eaglanPa.epoch;d=b.k&15;e=b.u;f=b.m&15;g=f<<4;h=g|d;i=a.YD.data;' },
      // pathFollow: the thread's answer when it holds, the game's own code otherwise (and when resuming)
      { find: 'function Ecw(a){', replace: PATH_AHEAD_CODE + 'function Ecw(a){if(!$eaglanPa.on||FQ()||$eaglanPaW.debug==="noUse")return $eaglanEcw(a);return $eaglanPaFollow(a);}\nfunction $eaglanEcw(a){' },
      // getPathToEntityLiving: the thread's search when it holds, the game's own otherwise (and when resuming)
      { find: 'function EQC(a,b){', replace: 'function EQC(a,b){if(!$eaglanPa.on||FQ())return $eaglanEQC(a,b);return $eaglanPaSearch(a,b);}\nfunction $eaglanEQC(a,b){' },
    ],
    requires: [
      // the end of each tick: tick times' hook calls $eaglanTickEnd (the next epoch's jobs)
      'if(typeof $eaglanTickEnd==="function")$eaglanTickEnd();',
      // pathFollow (Ecw) as described: getEntityPosition (cS5), the path lv (length vG, index rk, points bn_ with y r0),
      // the mob rS (width ey, height eo), the height requirement cB_, isDirectPathBetweenPoints (ea3), checkForStuck BG1
      'case 0:$p=1;case 1:$z=a.cS5();if(B()){break _;}b=$z;c=a.lv;d=c.vG;e=c.rk;f=e;', 'if(c.bn_.data[f].r0!=(b.c_|0))break;f=f+1|0;}}g=a.rS.ey;h=g*g*a.cB_;',
      '$p=2;case 2:$z=a.ea3(b,c,e,l,e);if(B()){break _;}f=$z;if(f)a.lv.rk=d;', 'function BG1(a,b){var c,d,e,f,g;c=a.cga;if((c-a.b1D|0)>100){',
      // a ground navigator's getEntityPosition (Gd7) and getPathablePosY (DNS); the vector's points from the path (ACb)
      '"cS5",HEY(Gd7)', 'case 0:b=new FD;c=a.rS.D;$p=1;case 1:$z=DNS(a);if(B()){break _;}d=$z;e=d;f=a.rS.E;', 'if(c&&a.sc.NV){', 'return a.rS.dz.b2+0.5|0;',
      'function ACb(a,b,c){var d,e,f,g;d=a.bn_.data;e=d[c].qN;f=(b.ey+1.0|0)*0.5;e=e+f;g=d[c].r0;f=d[c].rr+f;',
      // QH is PathNavigateGround, Kr EntityLiving (navigator f9), the server HGX (worlds gc, each world's loaded entities pP)
      'QH,\n0,AT2,[],0,3,0,0,["d93",HEY(EXt),"cOe",HEY(D7L),"cS5",HEY(Gd7)', 'function RV(a){return a.f9;}', 'function QH(){var a=this;AT2.call(a);a.sc=null;a.cWN=0;}',
      'c=a.pP;e=a.yq;', 'function $eaglanCk(', 'function $rt_createNumericArray(cls,nativeArray)', 'function $rt_charcls()', 'var I=$rt_createCharArray;',
      // world.getBlockState (Fuf): the chunk provider F, provideChunk bk, Chunk.getBlockState ENM on the section arrays xT/R8
      'function Fuf(a,b){', 'if(!Bz(a,b))return HLp.r;c=a.F;d=b.k>>4;e=b.m>>4;$p=1;case 1:$z=c.bk(d,e);', 'e=a.xT.data;if(d<e.length){f=e[d];if(f!==null){',
      // canNavigate D7L (onGround fy, canSwim NV, riding fd, zombie R8, chicken P0), isInWater AOT (the squid's Flv reads blocks), getMaxFallHeight DqD/GaF (max health H3D via ErG)
      'if(!a.rS.fy){if(a.sc.NV){$p=1;continue _;}b=a.rS;c=b.fd;if(!(c===null?0:1))break b;if(!(b instanceof R8))break b;if(!(c instanceof P0))break b;}d=1;break a;}d=0;}return d;',
      'function AOT(a){return a.yd;}', '"bj1",HEY(Flv)', '"dJz",HEY(DqD)', '"dJz",HEY(GaF)', 'case 2:EU();if(B()){break _;}c=H3D;$p=3;case 3:$z=ErG(a,c);if(B()){break _;}c=$z;if(!c.fv){', 'function FD(){',
    ],
    skipped: 'mobs find their way along their paths on the game thread only, as before',
  },
  {
    // EntityPlayerMP.onUpdate (FyI) sends the chunks a player waits for, then has the entity tracker show the player
    // the entities of each one (EntityTracker.func_85172_a, Cla), which shows an entity only once its chunk is no
    // longer among the ones the player waits for (EntityTrackerEntry.updatePlayerEntity, F8f; that set: loadedChunks
    // Eu, by chunk key FjW). Minecraft 1.8.8 takes the chunk off that set as it picks it; u53 only after showing the
    // entities, so none is shown: an entity that does not move (a boat, an item frame, an armor stand, a mob or a
    // player standing still) stays unseen by a player who has just joined, respawned, teleported or been moved to
    // another instance (regions) until one of the two goes 4 blocks. Here the chunk is taken off first, as in 1.8.8.
    name: 'entities shown with their chunk',
    edits: [
      { find: 'case 33:$z=Dl(h,c);if(B()){break _;}b=$z;b=b;$p=34;case 34:$z=Ds3(a);', replace: 'case 33:$z=Dl(h,c);if(B()){break _;}b=$z;b=b;$p=90;case 90:$z=FjW(b);if(B()){break _;}l=$z;B5t(a.Eu,l);$p=34;case 34:$z=Ds3(a);' },
      { find: 'case 36:Cla(d,a,b);if(B()){break _;}d=a.Eu;$p=37;case 37:$z=FjW(b);if(B()){break _;}l=$z;B5t(d,l);c=c+1|0;', replace: 'case 36:Cla(d,a,b);if(B()){break _;}c=c+1|0;' },
    ],
    requires: ['function FjW(a){', 'function B5t(a,b){return !ABh(a,b)?0:1;}'],
    skipped: 'an entity that does not move is shown to a player who has just arrived only once one of the two goes 4 blocks, as in u53',
  },
  {
    // Regions (src/regions.js): see REGIONS_CODE. Each edit only acts when the host gave this instance its regions
    // settings; without them the game runs as before. The last one: World.playMoodSoundAndCheckLight (EuP, the cave
    // sound) checks the light of a block of the chunk it ticks, but builds the block's position without the chunk's
    // offset (as Minecraft 1.8 does), so it asks the world for chunk 0,0 and loads it, in every instance; with regions
    // it uses the block of that chunk, as Minecraft 1.9 and later do (the chunk is loaded: nothing else changes).
    // And VillageCollection.addDoorsAround (Czl), which looks for doors 16 blocks round a place a villager was a moment
    // ago, skips a place whose chunk is no longer loaded (the villager's chunk was unloaded: its players went to another
    // instance); otherwise it would load the chunks there again, which the other instance now has.
    name: 'regions: instance hooks',
    edits: [
      { find: "function Guo(a,b){var c,d,e,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:c=0;d=a.e1;e=Bc(c,d.b);if(e>=0)return;if(c>=0&&e<0){d=d.f.data[c].ch;$p=1;continue _;}b=new W;b.c=1;b.d=1;F(b);case 1:Gcp(d,b);if(B()){break _;}c=c+1|0;d=a.e1;e=Bc(c,d.b);if(e>=0)return;if(c>=0&&e<0){d=d.f.data[c].ch;continue _;}b=new W;b.c=1;b.d=1;F(b);default:FO();}}DJ().s(a,b,c,d,e,$p);}", replace: REGIONS_CODE + "function Guo(a,b){var c,d,e,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:if($eaglanBcMgr()!==null){$p=2;continue _;}case 3:c=0;d=a.e1;e=Bc(c,d.b);if(e>=0)return;if(c>=0&&e<0){d=d.f.data[c].ch;$p=1;continue _;}b=new W;b.c=1;b.d=1;F(b);case 1:Gcp(d,b);if(B()){break _;}c=c+1|0;d=a.e1;e=Bc(c,d.b);if(e>=0)return;if(c>=0&&e<0){d=d.f.data[c].ch;continue _;}b=new W;b.c=1;b.d=1;F(b);case 2:CEM($eaglanBcMgr(),b);if(B()){break _;}$p=3;continue _;default:FO();}}DJ().s(a,b,c,d,e,$p);}" },
      { find: "d.IB=b;d.J3=c;c=0;b=a.e1;g=Bc(c,b.b);if(g>=0)return;", replace: "d.IB=b;d.J3=c;if($eaglanBcMgr()!==null){$p=5;continue _;}case 6:c=0;b=a.e1;g=Bc(c,b.b);if(g>=0)return;" },
      { find: "F(b);default:FO();}}DJ().s(a,b,c,d,e,f,g,$p);}\nfunction FKJ(a,b){", replace: "F(b);case 5:CEM($eaglanBcMgr(),d);if(B()){break _;}$p=6;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,$p);}\nfunction FKJ(a,b){" },
      { find: "c=a.op;$p=1;case 1:LM();if(B()){break _;}d=HG0;$p=2;case 2:$z=EYO(d,c);if(B()){break _;}c=$z;if(!(c===null?0:1)){GA();d=HVc;}", replace: "c=a.op;$p=1;case 1:LM();if(B()){break _;}d=HG0;$p=2;case 2:$z=EYO(d,c);if(B()){break _;}c=$z;if(!(c===null?0:1)&&a!==$eaglanBcM){GA();d=HVc;}" },
      { find: "H28=b;H29=1;}", replace: "H28=b;H29=globalThis.__eaglanRegions&&globalThis.__eaglanRegions.entityIdBase?globalThis.__eaglanRegions.entityIdBase:1;}" },
      { find: "case 0:b=0;c=C(716);$p=1;case 1:FRM(a,c);", replace: "case 0:if($eaglanRgRegion()){a.dpU=null;a.daf=0;return;}b=0;c=C(716);$p=1;case 1:FRM(a,c);" },
      { find: "function EZO(a,b,c){var d,e,f,g,h,i,j,k,l,m,n,o,p,$p,$z;$p=0;", replace: "function EZO(a,b,c){if($eaglanRgRegion())return 0;var d,e,f,g,h,i,j,k,l,m,n,o,p,$p,$z;$p=0;" },
      { find: "case 12:$z=GfT(c);if(B()){break _;}e=$z;if(!c.eA.pq){d=c.bR.bh7();", replace: "case 12:$z=GfT(c);if(B()){break _;}e=$z;if(!c.eA.pq&&!$eaglanRgRegion()&&!$eaglanRgMoving(a)){d=c.bR.bh7();" },
      { find: "case 6:$z=Ct$(b,c);if(B()){break _;}c=$z;k=a.bqf.f1;", replace: "case 6:$z=Ct$(b,c);if(B()){break _;}c=$z;$eaglanRgSetId(c);k=a.bqf.f1;" },
      { find: "case 0:if(!a.bOG&&!a.bC){e=(a.Zf*3|0)+1013904223|0;a.Zf=e;e=e>>2;f=e&15;g=e>>8&15;h=e>>16&255;i=new BJ;i.k=f;i.u=h;i.m=g;$p=2;continue _;}",
        replace: "case 0:if(!a.bOG&&!a.bC){e=(a.Zf*3|0)+1013904223|0;a.Zf=e;e=e>>2;f=e&15;g=e>>8&15;h=e>>16&255;i=new BJ;i.k=globalThis.__eaglanRegions?f+b|0:f;i.u=h;i.m=globalThis.__eaglanRegions?g+c|0:g;$p=2;continue _;}" },
      // ServerScoreboard.func_96536_a (C5P: every change of a score's points calls it; a score Bhj: objective a0V (its name
      // AC), name bK_, points t2) and Scoreboard.removeObjectiveFromEntity (E9l): reported to the host, which sets them in
      // the other instances ($eaglanSbApply)
      { find: "function C5P(a,b){var c,d,e,f,g,h,i,$p,$z;$p=0;",
        replace: "function C5P(a,b){if(globalThis.__eaglanRegions&&!$eaglanSbQuiet&&!$rt_resuming())globalThis.__eaglanScore('set',$rt_ustr(b.bK_),$rt_ustr(b.a0V.AC),b.t2);var c,d,e,f,g,h,i,$p,$z;$p=0;" },
      { find: "function E9l(a,b,c){var d,e,f,g,h,i,$p,$z;$p=0;",
        replace: "function E9l(a,b,c){if(globalThis.__eaglanRegions&&!$eaglanSbQuiet&&!$rt_resuming())globalThis.__eaglanScore('reset',$rt_ustr(b),c===null?null:$rt_ustr(c.AC),0);var d,e,f,g,h,i,$p,$z;$p=0;" },
      // WorldServer.areAllPlayersAsleep (B$Q): with regions the host decides, for the players of every instance ($eaglanRgSleepSkip)
      // MapStorage.getUniqueDataId (CMZ): in a region instance the main instance's count ($eaglanRgAskId)
      { find: "function CMZ(a,b){var c,d,e,f,g,h,i,j,k,$$je,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();k=$T.l();j=$T.l();i=$T.l();h=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:c=a.bF6;",
        replace: "function CMZ(a,b){var c,d,e,f,g,h,i,j,k,$$je,$p,$z;$p=0;if(FQ()){var $T=DJ();$p=$T.l();k=$T.l();j=$T.l();i=$T.l();h=$T.l();g=$T.l();f=$T.l();e=$T.l();d=$T.l();c=$T.l();b=$T.l();a=$T.l();}_:while(true){switch($p){case 0:if($eaglanRgRegion()){$p=99;continue _;}c=a.bF6;" },
      { find: "$p=4;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,$p);}\nfunction Fkl(){",
        replace: "$p=4;continue _;case 99:$z=$eaglanRgAskId(b);if(B()){break _;}return $z;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,$p);}\nfunction Fkl(){" },
      { find: "function B$Q(a){var b,c,d,e,$p,$z;$p=0;", replace: "function B$Q(a){if(globalThis.__eaglanRegions&&!$rt_resuming())return 0;var b,c,d,e,$p,$z;$p=0;" },
      { find: "function Czl(a,b){var c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,$p,$z;$p=0;",
        replace: "function Czl(a,b){if(globalThis.__eaglanRegions&&!$rt_resuming()&&!Feb(a.Oc.F,b.k>>4,b.m>>4))return;var c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,$p,$z;$p=0;" },
    ],
    requires: ['var HGX=null', 'function AZL(){', 'function Feb(a,b,c){', 'function $rt_resuming(){', 'function GbE(a){', 'function $rt_nativeThread(){', 'function $rt_getThread(){', 'function $rt_setThread(', 'KOJ=b;', 'HU8=c;', 'var Dj=Long_toNumber;', 'var HE7=Long_fromNumber;', 'function $rt_str(str)', 'function $rt_ustr(str)', 'function CEM(a,b){', 'function Ef0(a,b){', 'function $rt_startThread(runner,callback){',
      // the world's MapStorage (AT9: saved data by name Qy, in a list bHK, as WorldServer.init makes them), a saved data's name (AGJ: WG),
      // a HashMap as the game makes one (BT), its put (Eu$), an ArrayList's room for more (Be)
      'function AT9(){var a=this;G.call(a);a.bSe=null;a.Qy=null;a.bHK=null;a.bF6=null;}', 'function AGJ(){var a=this;G.call(a);a.WG=null;a.s0=0;}', 'b.Qy=d;d=new V;d.f=H(G,10);b.bHK=d;',
      'd=new BT;e=BO(16);d.G=0;f=H(BW,e);g=f.data;d.o=f;d.U=0.75;d.Y=g.length*0.75|0;', 'function Eu$(a,b,c){', 'function Be(a,b){', 'function BT(){var a=this;Ub.call(a);a.G=0;a.o=null;a.fV=0;a.U=0.0;a.Y=0;}'],
    skipped: 'regions (config "regions") are not available',
  },
  {
    // Regions: the game's other broadcasts also go to the players of the other instances, as the two of "regions:
    // instance hooks" do. Each is its own copy of a loop over the players (TeaVM put it inline where it is used): the
    // tab-list entry of a player who logs in (playerLoggedIn, B91: the Player List Item Xr), and the chat of
    // sendChatMsg itself (FKJ: "joined the game", achievements), /say (CommandBroadcast, DzS), /me (CommandEmote, EGm),
    // a player's death message (EntityPlayerMP.onDeath, DQU) and "left the game" (NetHandlerPlayServer.onDisconnect,
    // D4X). Not passed on: the commands' feedback to the OPs (notifyOperators, EU7) and the death messages a team
    // hides from the others (GuE).
    name: 'regions: more broadcasts',
    edits: [
      ...bcEdits('case 2:Ezx(f,c,g);if(B()){break _;}', 'e=0;c=a.e1;h=Bc(e,c.b);if(h>=0){c=a.pf;', '$p=7;continue _;}b=new W;b.c=1;b.d=1;F(b);default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,$p);}', 'f', 90),
      ...bcEdits('c=new P4;c.IB=b;c.J3=1;', 'f=0;b=a.e1;g=Bc(f,b.b);if(g>=0)return;', 'b=b.f.data[f].ch;continue _;}b=new W;b.c=1;b.d=1;BB(b);F(b);default:FO();}}DJ().s(a,b,c,d,e,f,g,$p);}', 'c', 5),
      ...bcEdits('b=new P4;b.IB=g;b.J3=1;', 'e=0;g=j.e1;f=Bc(e,g.b);if(f>=0)return;', 'g=g;$p=19;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,$p);}', 'b', 90),
      ...bcEdits('b=new P4;b.IB=f;b.J3=1;', 'd=0;f=i.e1;e=Bc(d,f.b);if(e>=0)return;', 'f=f;$p=19;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,$p);}', 'b', 90),
      ...bcEdits('c=new P4;c.IB=b;c.J3=1;', 'e=0;b=f.e1;l=Bc(e,b.b);if(l>=0){', '$p=48;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,$p);}', 'c', 90),
      ...bcEdits('c=new P4;c.IB=b;c.J3=1;', 'f=0;b=e.e1;h=Bc(f,b.b);if(h<0){', 'if(B()){break _;}$p=24;continue _;default:FO();}}DJ().s(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,$p);}', 'c', 90),
    ],
    requires: ['function $eaglanBcMgr(', 'function CEM(a,b){'],
    skipped: 'with regions, the tab list shows only the players of the instance a player was in with them, and joins, leaves, deaths, achievements, say and me show only in the instance where they happen',
  },
  // Decoration ahead (stage 8, path 4; src/deco-patch.js): only with config decorationAhead or decorationAheadPregen.
  DECO.PATCH,
];

// The thread's side of "terrain threads", added to the same correction in a terrain thread's copy of
// classes.js (applyTerrainWorkerPatches), and what it uses.
const TERRAIN_WORKER_EDIT = { find: '$rt_exports.main=$rt_mainStarter(HdT);', replace: TERRAIN_WORKER_CODE + '$rt_exports.main=$rt_mainStarter(HdT);' };
const TERRAIN_WORKER_REQUIRES = [
  'function E$x(){', 'function Lv(a){var b=new AF0();GK9(b,a);return b;}', 'function HiQ(b){', 'function E2q(a,b){', 'function KO1(a){var b=new Uv();BIy(b,a);return b;}',
  'function KXC(a,b,c,d){var e=new OY();BUl(e,a,b,c,d);return e;}', 'case 1:FmP();if(B()){break _;}if(e==(-1)){f=new AT8;f.bc6=FH(16);f.bZ4=FH(4);}else if(!e){f=new AZK;f.bc6=FH(16);f.bZ4=FH(4);}',
  'function Ejw(a,b,c,d,e){', 'function Cmp(a,b){var $p,$z;$p=0;', 'case 0:a.TW=b;a.cfk=b.bR.FX();a.b6a=b.bR.Tl;', 'function Gs0(a){', 'c=new A_p;b=a.TW;d=b.bR.vA();e=a.TW.bR.cds();f=a.b6a;',
  'a.jj=b;a.o2=d;', 'var Cb=$rt_createByteArray;', 'var FH=$rt_createFloatArray;', 'function $rt_str(str)', 'var D=$rt_wrapException;', 'var Dj=Long_toNumber;', 'function G(){this.V$=null;this.$id$=0;}',
  'function $rt_startThread(runner,callback){',
  // the game's entry with two arguments only sets up the runtime (the classes' static parts), prints "???" and returns
  'd=b.length;if(d!=1){if(d)break a;$p=3;continue _;}', 'c=GEg();e=C(4);$p=2;case 2:c.dBN(e);if(B()){break _;}return;',
];

// A path-ahead thread's copy (path-worker.js): only the thread's side; nothing of the game changed.
const PATH_WORKER_EDIT = { find: '$rt_exports.main=$rt_mainStarter(HdT);', replace: PATH_WORKER_CODE + '$rt_exports.main=$rt_mainStarter(HdT);' };
function applyPathWorkerPatches(src, opts = {}) {
  return withLongConstants(applyPatchList([{ name: 'path ahead (thread side)', edits: [PATH_WORKER_EDIT],
    requires: ['function Ecw(a){', 'function ETm(a,b,c,d,e,f){', 'function Fuf(a,b){', 'function FD(){', 'function E$x(){', 'function $rt_startThread(runner,callback){'],
    skipped: 'the path-ahead thread cannot run' }], src), opts);
}

// A decoration-ahead thread's copy (deco-worker.js): the game's corrections as the game has them (decoration ahead
// among them: the recording), with the terrain threads' side (the world and its generator from level.dat) and its own.
function applyDecoWorkerPatches(src, opts = {}) {
  const list = PATCHES.map((p) => (p.name === 'terrain threads' ? { ...p, edits: [...p.edits, TERRAIN_WORKER_EDIT], requires: [...p.requires, ...TERRAIN_WORKER_REQUIRES] } : p));
  list.push({ name: 'decoration ahead (thread side)', edits: [DECO.WORKER_EDIT], requires: ['function $eaglanDwRun(', 'function $eaglanTgWInit('], skipped: 'the decoration-ahead thread cannot run' });
  return withLongConstants(applyPatchList(list, src), opts);
}

// Returns the corrected source and a list of problems (corrections that could not be applied).
// A correction with several edits is applied only when every edit finds its text exactly once.
// opts.longConstants (speedup 4) and opts.longConstantsVerify: the 64-bit constants, last, over all of it.
// A correction with "only" is applied only when opts has that switch (e.g. decoration ahead: opts.decoration).
function applyGamePatches(src, opts = {}) { return withLongConstants(applyPatchList(PATCHES.filter((p) => !p.only || opts[p.only] === true), src), opts); }
// A terrain thread's copy: only "terrain threads", with the thread's side (terrain-worker.js).
function applyTerrainWorkerPatches(src, opts = {}) {
  const p = PATCHES.find((x) => x.name === 'terrain threads');
  return withLongConstants(applyPatchList([{ ...p, name: 'terrain threads (thread side)', edits: [...p.edits, TERRAIN_WORKER_EDIT], requires: [...p.requires, ...TERRAIN_WORKER_REQUIRES] }], src), opts);
}
function withLongConstants(r, opts) {
  if (!opts.longConstants) return r;
  const c = longConstants(r.src, opts.longConstantsVerify === true);
  if (c.error) return { src: r.src, problems: [...r.problems, `speedup: 64-bit constants not applied: ${c.error} (the game makes its 64-bit constants where it uses them, as before)`] };
  return { src: c.src, problems: r.problems, longConstants: { sites: c.sites, values: c.values } };
}
function applyPatchList(list, src) {
  const problems = [];
  for (const p of list) {
    const edits = p.edits || [{ find: p.find, replace: p.replace }];
    const ok = edits.every((e) => { const at = src.indexOf(e.find); return at >= 0 && src.indexOf(e.find, at + 1) < 0; }) &&
      !(p.requires || []).some((t) => !src.includes(t));
    if (!ok) { problems.push(`${p.name} not applied: classes.js is not the expected u53 build (${p.skipped})`); continue; }
    for (const e of edits) { const at = src.indexOf(e.find); src = src.slice(0, at) + e.replace + src.slice(at + e.find.length); }
  }
  return { src, problems };
}

// pregenPlan: the pre-generation hook's planning functions (plain JavaScript), for the tests.
// terrainHook: the terrain threads' functions (plain JavaScript), for the tests; speedupCode: the speedups' code.
module.exports = { applyGamePatches, applyTerrainWorkerPatches, applyPathWorkerPatches, applyDecoWorkerPatches, PATCHES, longConstants, mobCapsCode: MOB_CAPS_CODE, sleepCode: SLEEP_CODE, speedupCode: { chunkCache: CHUNK_CACHE_CODE, uuidText: UUID_TEXT_CODE, packetBatch: PACKET_BATCH_CODE, lightSets: LIGHT_SETS_CODE, collisionScan: COLLISION_SCAN_CODE }, terrainHook: { id: $eaglanTgId, take: $eaglanTgTake, at9: $eaglanTgAt9, status: $eaglanTgStatus, api: $eaglanTgApi, code: () => TERRAIN_CODE }, pregenPlan: { ringPos: $eaglanPgRingPos, id: $eaglanPgId, xz: $eaglanPgXZ, done: $eaglanPgDone, lightDone: $eaglanPgLightDone, waiting: $eaglanPgWaiting, advance: $eaglanPgAdvance } };
