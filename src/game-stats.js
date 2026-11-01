'use strict';
// The game thread's reports (worker-runtime.js, every 5 s): what held up the game server's thread.
// Summed for status (the last minute) and to explain each "Can't keep up!" line (daemon.js).
//
// A report covers the time since the previous one (ms). While the game thread is stuck, its timer
// cannot fire, so the report sent after a long freeze covers more than 5 s; the time spans here are
// the real ones.

const span = (x) => x.ms || 5000;

// The reports whose time span overlaps [from, to] by more than minOverlapMs, summed. seconds: the
// real time they cover.
function summarize(reports, from, to, minOverlapMs = 0) {
  const xs = reports.filter((x) => Math.min(x.t, to) - Math.max(x.t - span(x), from) > minOverlapMs);
  if (!xs.length) return null;
  const last = xs[xs.length - 1], totalMs = xs.reduce((a, x) => a + span(x), 0);
  const r = { seconds: Math.round((last.t - (xs[0].t - span(xs[0]))) / 1000), writes: 0, writeMs: 0, maxWriteMs: 0, maxQueued: 0, gcMs: 0, maxGcMs: 0, busy: 0, maxBusy: 0, heapMb: 0, heapPhysMb: last.heapPhysMb, extMb: last.extMb, heapLimitMb: last.heapLimitMb };
  const tl = []; let ticks = 0, tickMax = 0;
  for (const x of xs) {
    r.writes += x.storage.writes; r.writeMs += x.storage.ms; r.maxWriteMs = Math.max(r.maxWriteMs, x.storage.maxMs); r.maxQueued = Math.max(r.maxQueued, x.storage.maxQueued || 0);
    r.gcMs += x.gc.ms; r.maxGcMs = Math.max(r.maxGcMs, x.gc.maxMs); r.busy += (x.busy * span(x)) / totalMs; r.maxBusy = Math.max(r.maxBusy, x.busy); r.heapMb = Math.max(r.heapMb, x.heapMb);
    if (x.ticks) { ticks += x.ticks.n; tickMax = Math.max(tickMax, x.ticks.max); for (const v of x.ticks.list) tl.push(v); }
  }
  r.busy = Math.round(r.busy);
  // Game ticks (one every 50 ms when the server keeps up): how long they took.
  if (tl.length) {
    tl.sort((a, b) => a - b);
    const pct = (p) => tl[Math.min(tl.length - 1, Math.floor(p * tl.length))];
    r.ticks = { n: ticks, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: Math.round(tickMax), over50: tl.filter((v) => v > 50).length };
  }
  return r;
}

// The log line explaining a stall of behindMs that ended when the game logged it (at), from the
// reports that cover it (by more than half a second: the next report starts just before the line).
// The report covering its end can come a few seconds later, so call this a few seconds after the line.
function explainStall(reports, behindMs, at, { diskSync = 'full' } = {}) {
  const r = summarize(reports, at - behindMs - 1000, at, 500);
  if (!r) return null;
  const cause = r.writeMs >= 0.4 * behindMs ? `saving world data: each write is synced to disk, and this disk is slow to sync${diskSync === 'normal' ? '' : ' (if this repeats, see README "Game server stalls": diskSync)'}`
    : r.gcMs >= 0.4 * behindMs ? 'garbage collection (memory use of the game server)'
    : r.maxBusy >= 60 ? 'CPU: the game server thread was busy (more players, mobs or loaded chunks than this CPU keeps up with, or a shared/throttled VPS CPU)'
    : 'not disk writes, garbage collection or this thread\'s own work: the whole process was probably paused (VPS CPU steal, swapping, or a clock jump)';
  const ticks = r.ticks ? `, longest tick ${r.ticks.max} ms` : '';
  return `game server fell ${(behindMs / 1000).toFixed(1)}s behind. In the ${r.seconds}s around it: disk writes ${r.writes} (blocked ${r.writeMs} ms, slowest ${r.maxWriteMs} ms), garbage collection ${r.gcMs} ms (longest ${r.maxGcMs} ms), thread busy up to ${r.maxBusy}%${ticks}, heap ${r.heapMb} of ${r.heapLimitMb} MB. Likely cause: ${cause}`;
}

module.exports = { summarize, explainStall };
