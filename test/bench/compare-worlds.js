'use strict';
// Compares the saved chunks of two worlds (two world databases, e.g. load.js templates made with the
// same seed), block by block: every chunk file in both is read as the game saves it (gzipped NBT,
// Level.Sections: Blocks, Add, Data; Level.Biomes; Level.TileEntities) and compared.
//   node test/bench/compare-worlds.js <a.sqlite> <b.sqlite> [--world "Bench World"] [--out r.json]
// Prints: chunks in both / only in one, chunks with the same blocks, the differing blocks by kind
// (block id in a -> in b), biomes and tile entities that differ.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

// A small NBT reader (big-endian, as the game writes it).
function readNbt(buf) {
  let p = 0;
  const u8 = () => buf[p++], i16 = () => { const v = buf.readInt16BE(p); p += 2; return v; }, i32 = () => { const v = buf.readInt32BE(p); p += 4; return v; };
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return buf.readInt8(p++);
      case 2: return i16();
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(p); p += 8; return v; }
      case 5: { const v = buf.readFloatBE(p); p += 4; return v; }
      case 6: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 7: { const n = i32(); const v = buf.subarray(p, p + n); p += n; return v; }
      case 8: return str();
      case 9: { const et = u8(), n = i32(), a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const o = {}; for (;;) { const ct = u8(); if (ct === 0) return o; const k = str(); o[k] = payload(ct); } }
      case 11: { const n = i32(), a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i32(); return a; }
      default: throw new Error('NBT tag type ' + t);
    }
  };
  const t = u8(); str(); return payload(t);
}
function gunzip(data) {
  const b = Buffer.from(data);
  try { return zlib.gunzipSync(b); } catch {}
  return zlib.inflateRawSync(b.subarray(10), { finishFlush: zlib.constants.Z_SYNC_FLUSH });   // trailing padding after the gzip data
}
// The chunk's blocks as one array of 65,536 (id << 4 | meta), y-major as the sections are; biomes; tile entities.
function chunkBlocks(data) {
  const L = readNbt(gunzip(data)).Level, blocks = new Uint16Array(65536);
  for (const s of L.Sections || []) {
    const base = s.Y * 4096;
    for (let i = 0; i < 4096; i++) {
      const add = s.Add ? (s.Add[i >> 1] >> ((i & 1) * 4)) & 15 : 0, meta = (s.Data[i >> 1] >> ((i & 1) * 4)) & 15;
      blocks[base + i] = (((add << 8) | (s.Blocks[i] & 255)) << 4) | meta;
    }
  }
  const te = (L.TileEntities || []).map((t) => `${t.id}@${t.x},${t.y},${t.z}`).sort();
  return { x: L.xPos, z: L.zPos, blocks, biomes: L.Biomes ? Buffer.from(L.Biomes) : null, te, entities: (L.Entities || []).length, populated: L.TerrainPopulated, lit: L.LightPopulated };
}
function chunks(file, world) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT path, data FROM files WHERE path LIKE ? AND path LIKE ?').all(`worlds/${world}/level0/%`, '%.dat');
  db.close();
  const m = new Map(); for (const r of rows) m.set(r.path.slice(r.path.lastIndexOf('/') + 1), r.data);
  return m;
}

function compare(fileA, fileB, world = 'Bench World') {
  const A = chunks(fileA, world), B = chunks(fileB, world);
  const r = { a: fileA, b: fileB, chunksA: A.size, chunksB: B.size, both: 0, onlyA: 0, onlyB: 0, sameBlocks: 0, differentBlocks: 0, blocksDiffering: 0, biomesDiffer: 0, tileEntitiesDiffer: 0, entitiesA: 0, entitiesB: 0, kinds: {}, examples: [] };
  for (const k of A.keys()) if (!B.has(k)) r.onlyA++;
  for (const k of B.keys()) if (!A.has(k)) r.onlyB++;
  for (const [k, da] of A) {
    const db = B.get(k); if (!db) continue;
    r.both++;
    const a = chunkBlocks(da), b = chunkBlocks(db);
    r.entitiesA += a.entities; r.entitiesB += b.entities;
    let n = 0;
    for (let i = 0; i < 65536; i++) {
      if (a.blocks[i] === b.blocks[i]) continue;
      n++;
      const kind = `${a.blocks[i] >> 4}:${a.blocks[i] & 15} -> ${b.blocks[i] >> 4}:${b.blocks[i] & 15}`;
      r.kinds[kind] = (r.kinds[kind] || 0) + 1;
    }
    if (n) { r.differentBlocks++; r.blocksDiffering += n; if (r.examples.length < 10) r.examples.push({ x: a.x, z: a.z, blocks: n }); } else r.sameBlocks++;
    if (!a.biomes || !b.biomes || !a.biomes.equals(b.biomes)) r.biomesDiffer++;
    if (a.te.join() !== b.te.join()) r.tileEntitiesDiffer++;
  }
  r.kinds = Object.fromEntries(Object.entries(r.kinds).sort((x, y) => y[1] - x[1]).slice(0, 25));
  return r;
}

if (require.main === module) {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const r = compare(files[0], files[1], opt('world') || 'Bench World');
  console.log(`${r.both} chunks in both (${r.onlyA} only in a, ${r.onlyB} only in b): ${r.sameBlocks} with the same blocks, ${r.differentBlocks} differing in ${r.blocksDiffering} blocks; biomes differ in ${r.biomesDiffer}, tile entities in ${r.tileEntitiesDiffer}; entities ${r.entitiesA} / ${r.entitiesB}`);
  if (r.differentBlocks) console.log('differing blocks by kind (id:meta in a -> in b):', JSON.stringify(r.kinds), '\nexamples:', JSON.stringify(r.examples));
  if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(r, null, 2));
}
module.exports = { compare, chunkBlocks, readNbt };
