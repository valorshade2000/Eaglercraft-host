'use strict';
// One thread of the multi-core pool (compute-pool.js). It only runs pure CPU jobs on the bytes it is
// given: it has no world, game or player state, so it can run at the same time as the game thread.
const { parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');

const ops = {
  // A zlib stream (2-byte header, Adler-32), with the settings of the game's own EaglerZLIB.deflateFull
  // (level 5, window 15, memory level 8, default strategy) that it uses for large network packets.
  deflate: (buf, o) => zlib.deflateSync(buf, { level: o.level ?? 5, windowBits: 15, memLevel: 8, strategy: 0 }),
  // A gzip file, as the game's CompressedStreamTools.writeCompressed writes chunk files (default level).
  gzip: (buf, o) => zlib.gzipSync(buf, { level: o.level ?? 6 }),
};
// Test hook: makes this thread fail, to test the pool's fallback.
if (workerData && workerData.debug) ops.crash = () => { process.exit(3); };

parentPort.on('message', ({ id, op, data, opts }) => {
  let out;
  try {
    if (!ops[op]) throw new Error('unknown job ' + op);
    out = ops[op](Buffer.from(data), opts || {});
  } catch (e) { parentPort.postMessage({ id, error: String((e && e.message) || e) }); return; }
  const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);   // a copy of its own, to hand over
  parentPort.postMessage({ id, data: ab }, [ab]);
});
