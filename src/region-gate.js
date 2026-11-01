'use strict';
// Regions (config regions; regions.js): the storage gate of one game instance (worker-runtime.js, idb-sqlite.js
// options.gate): which cells of chunks this instance has. Before it reads a chunk of a cell it does not have, it asks
// the host (claim); a cell another instance has gives an empty chunk (that instance takes this one's players at once,
// regions.js). A region instance writes only its cells' chunks and its players' files. Cells without loaded chunks
// for two checks (10 s) are given back once their files are committed.
// deps: post(message to the host), log(line), api() (the game's regions hooks, game-patches.js __eaglanRegionsApi),
// flush() (a promise: every file handed over is committed), mergeFor(path, mine) (region-data.js).
const { cellOfPath, chunkOfPath, emptyChunkFile, cellKey } = require('./region-cells');

const ASK_AGAIN_MS = 10000;

function makeRegionGate(r, deps) {
  const { post, log, api, flush, mergeFor } = deps;
  const owned = new Set(), ownedAt = new Map(), claims = new Map(), releasing = new Map(), busy = new Map(), idle = new Map(), waiters = new Map(), told = new Set();
  const tries = new Map(), triesById = new Map(), taken = new Map();   // pre-generation: cells asked for (try), cells another instance has (until when)
  let seq = 0;
  const inc = (c) => busy.set(c, (busy.get(c) || 0) + 1);
  const dec = (c) => { const n = (busy.get(c) || 1) - 1; if (n > 0) busy.set(c, n); else busy.delete(c); };
  const note = (k, why) => { if (told.has(why)) return; told.add(why); log(`[runtime] regions: not written (${why}): ${k}`); };
  // A claim the host has not answered within 10 s is asked again (logged): the game's thread waits for it. The host
  // answers each copy; the first answer counts.
  const ask = (w) => { w.sentAt = Date.now(); try { post({ __host: 'claim', id: w.id, cells: [w.c], chunk: w.chunk }); } catch (e) { log(`[runtime] regions: asking for cell ${w.c} failed (${e.message}); asked again in 10 s`); } };
  const claim = (c, k) => {   // k: the chunk file that asks first (the host counts how far from the players it is)
    let p = claims.get(c); if (p) return p;
    p = new Promise((resolve) => {
      const w = { id: ++seq, c, chunk: chunkOfPath(k), resolve, t0: Date.now(), sentAt: 0, asked: 1 };
      waiters.set(w.id, w); ask(w);
    }).then((res) => { claims.delete(c); if (res[c] === 'ok') { owned.add(c); if (!ownedAt.has(c)) ownedAt.set(c, Date.now()); return 'ok'; } return 'empty'; });
    claims.set(c, p); return p;
  };
  const gate = {
    // null: not a chunk file; otherwise a promise of 'ok' or 'empty', and end(k) once the read is done
    read(k) {
      const c = cellOfPath(k); if (!c) return null;
      if (owned.has(c)) { inc(c); return Promise.resolve('ok'); }
      const rel = releasing.get(c);
      return (rel ? rel.then(() => claim(c, k)) : claim(c, k)).then((v) => { inc(c); return v; });
    },
    end(k) { const c = cellOfPath(k); if (c) dec(c); },
    // whether a write or delete of k may go to disk (end(k) once it is committed, for chunk files)
    write(k) {
      const c = cellOfPath(k);
      if (c) { if (owned.has(c)) { inc(c); return true; } note(k, 'a chunk of a cell another instance has, or none'); return false; }
      if (!r.region || /\/(player|stats)\//.test(k) || /\/data\/map_\d+\.dat$/.test(k)) return true;   // maps: merged with the stored file (region-data.js MapBaselines)
      if (mergeFor(k, () => false)) return true;   // villages and structures: merged with the stored file (region-data.js)
      note(k, 'the world\'s own files are written by the main instance'); return false;
    },
    empty(k) { const ch = chunkOfPath(k); return emptyChunkFile(ch.x, ch.z); },
    // Pre-generation (game-patches.js $eaglanPgNextLoad, the main instance): may the job load overworld chunk x, z now?
    // 'mine': this instance has its cell; 'wait': asked for it (a try: the host answers at once, never holds it and never
    // moves players for it, regions.js _claim), the answer comes in a moment; 'skip': another instance has it (asked
    // again after 30 s for a later chunk of it).
    pregenCell(x, z) {
      const c = cellKey(0, x, z);
      if (owned.has(c) && !releasing.has(c)) return 'mine';
      const t = taken.get(c); if (t !== undefined) { if (Date.now() < t) return 'skip'; taken.delete(c); }
      if (tries.has(c) || releasing.has(c) || claims.has(c)) return 'wait';
      const id = ++seq; tries.set(c, id); triesById.set(id, c);
      try { post({ __host: 'claim', id, cells: [c], try: true }); } catch { tries.delete(c); triesById.delete(id); }
      return 'wait';
    },
    claimResult(m) {
      const tc = triesById.get(m.id);
      if (tc !== undefined) {
        triesById.delete(m.id); tries.delete(tc);
        const v = (m.results || {})[tc];
        if (v === 'ok') { owned.add(tc); if (!ownedAt.has(tc)) ownedAt.set(tc, Date.now()); } else taken.set(tc, Date.now() + 30000);
        return;
      }
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); if (w.asked > 1) log(`[runtime] regions: cell ${w.c} answered after ${Math.round((Date.now() - w.t0) / 1000)} s`); w.resolve(m.results || {}); } },
    // Claims without an answer for 10 s are asked again (the worker calls this every 2 s).
    recheck(now = Date.now()) {
      for (const w of waiters.values()) if (now - w.sentAt >= ASK_AGAIN_MS) {
        w.asked++; log(`[runtime] regions: no answer for cell ${w.c} after ${Math.round((now - w.t0) / 1000)} s; asked again (${w.asked})`); ask(w);
      }
    },
    // For the stall report: claims without an answer (cell, seconds), cells being given back, cells in use, cells held.
    snapshot() {
      const now = Date.now();
      return { claims: [...waiters.values()].map((w) => `${w.c} ${Math.round((now - w.t0) / 1000)} s`), releasing: releasing.size, busy: busy.size, owned: owned.size };
    },
    async releaseIdle(now) {   // now: without waiting for a second idle check (a player was moved away)
      const a = api(); if (!a) return;
      let loaded; try { loaded = new Set(a.loadedCells()); } catch { return; }
      const out = [];
      for (const c of owned) {
        if (loaded.has(c) || busy.has(c)) { idle.delete(c); continue; }
        const n = (idle.get(c) || 0) + 1; idle.set(c, n); if (n >= 2 || now) out.push(c);
      }
      if (!out.length) return;
      let done; const p = new Promise((res) => { done = res; });
      for (const c of out) { owned.delete(c); ownedAt.delete(c); idle.delete(c); releasing.set(c, p); }
      try { await flush(); await new Promise((res) => setImmediate(res)); } catch {}
      for (let i = 0; i < 100 && out.some((c) => busy.has(c)); i++) await new Promise((res) => setTimeout(res, 20));   // writes started before
      post({ __host: 'release', cells: out });
      for (const c of out) releasing.delete(c);
      done();
    },
    owned: () => owned.size,
    // Whether this instance has had cell c for two minutes (its villages there are known: region-data.js).
    mine: (c) => owned.has(c) && Date.now() - (ownedAt.get(c) || Date.now()) >= 120000,
  };
  return gate;
}

module.exports = { makeRegionGate, ASK_AGAIN_MS };
