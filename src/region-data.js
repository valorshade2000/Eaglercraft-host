'use strict';
// Regions: the world's data files that more than one game instance writes (README "Regions"), merged by the storage
// layer when a file is written (idb-sqlite.js options.merge), byte for byte (nothing in them changes type):
// - structures (data/Village.dat, Temple.dat, Mineshaft.dat, Stronghold.dat, Fortress.dat, Monument.dat): every
//   instance only adds the structures of the terrain it makes, so the file keeps the union of their "Features";
// - villages (data/villages.dat, villages_nether.dat, villages_end.dat): the writing instance's villages where it has
//   had the chunks for a while (its own area: it knows what is there), the stored file's elsewhere, all on the writing
//   instance's tick count (the villages' and doors' tick stamps moved by the difference);
// - maps (data/map_<n>.dat): the pixels the writing instance changed, onto the stored file (MapBaselines).
// Anything not as expected is written as it comes.
const zlib = require('node:zlib');
const { cellKey } = require('./region-cells');

// NBT by the bytes: where a payload of type t that starts at o ends.
function nbtEnd(b, o, t) {
  switch (t) {
    case 1: return o + 1;
    case 2: return o + 2;
    case 3: case 5: return o + 4;
    case 4: case 6: return o + 8;
    case 7: return o + 4 + b.readInt32BE(o);
    case 8: return o + 2 + b.readUInt16BE(o);
    case 9: { const et = b[o], n = b.readInt32BE(o + 1); let p = o + 5; for (let i = 0; i < n; i++) p = nbtEnd(b, p, et); return p; }
    case 10: { let p = o; for (;;) { const tt = b[p++]; if (tt === 0) return p; p = nbtEnd(b, p + 2 + b.readUInt16BE(p), tt); } }
    case 11: return o + 4 + 4 * b.readInt32BE(o);
    default: throw new Error('NBT tag type ' + t);
  }
}
// The named tags of a compound whose payload starts at o: [{ type, name, start (of the tag), payload, end }].
function nbtTags(b, o) {
  const out = [];
  for (let p = o; ;) {
    const type = b[p]; if (type === 0) return out;
    const nl = b.readUInt16BE(p + 1), payload = p + 3 + nl, end = nbtEnd(b, payload, type);
    out.push({ type, name: b.toString('utf8', p + 3, payload), start: p, payload, end }); p = end;
  }
}
// The compounds of a list whose payload starts at o: [{ start, end }] (none when it holds something else).
function nbtList(b, o) {
  if (b[o] !== 10) return [];
  const out = []; let p = o + 5;
  for (let i = 0, n = b.readInt32BE(o + 1); i < n; i++) { const end = nbtEnd(b, p, 10); out.push({ start: p, end }); p = end; }
  return out;
}
const tag = (type, name, payload) => { const n = Buffer.from(name, 'utf8'), h = Buffer.alloc(3); h[0] = type; h.writeUInt16BE(n.length, 1); return Buffer.concat([h, n, payload]); };
const compound = (parts) => Buffer.concat([...parts, Buffer.from([0])]);
const list10 = (items) => { const h = Buffer.alloc(5); h[0] = 10; h.writeInt32BE(items.length, 1); return Buffer.concat([h, ...items]); };
// A saved data file (gzipped NBT { "": { data: {...} } }): its bytes and the tags of "data".
function dataTags(gz) {
  const b = zlib.gunzipSync(gz);
  if (b[0] !== 10) throw new Error('not a compound');
  const data = nbtTags(b, 3 + b.readUInt16BE(1)).find((t) => t.name === 'data' && t.type === 10);
  if (!data) throw new Error('no data');
  return { b, tags: nbtTags(b, data.payload) };
}
const fileOf = (dataParts) => zlib.gzipSync(compound([tag(10, '', compound([tag(10, 'data', compound(dataParts))]))]));

// Structures: the union of the two files' Features (the incoming file's own win).
function mergeFeatures(stored, incoming) {
  if (!stored) return incoming;
  try {
    const features = (gz) => { const { b, tags } = dataTags(gz), f = tags.find((t) => t.name === 'Features' && t.type === 10); return f ? nbtTags(b, f.payload).map((t) => [t.name, b.subarray(t.start, t.end)]) : []; };
    const all = new Map(features(stored));
    for (const [k, v] of features(incoming)) all.set(k, v);
    return fileOf([tag(10, 'Features', compound([...all.values()]))]);
  } catch { return incoming; }
}

// A village compound (bytes) with its tick stamps moved by d: Tick, Stable (last door added), MTick (no breeding until;
// 0 is none) and every door's TS (last seen).
function rebaseVillage(b, v, d) {
  const out = Buffer.from(b.subarray(v.start, v.end)), at = (o) => o - v.start;
  for (const t of nbtTags(b, v.start)) {
    if (t.type === 3 && (t.name === 'Tick' || t.name === 'Stable' || (t.name === 'MTick' && b.readInt32BE(t.payload) !== 0))) out.writeInt32BE((b.readInt32BE(t.payload) + d) | 0, at(t.payload));
    if (t.type === 9 && t.name === 'Doors') {
      for (const door of nbtList(b, t.payload)) for (const dt of nbtTags(b, door.start)) if (dt.type === 3 && dt.name === 'TS') out.writeInt32BE((b.readInt32BE(dt.payload) + d) | 0, at(dt.payload));
    }
  }
  return out;
}
// Villages of dimension `dim`: the incoming file's where its instance has had the chunks for a while (mine(cell)), the
// stored file's elsewhere, moved onto the incoming file's tick count.
function mergeVillages(stored, incoming, dim, mine) {
  if (!stored) return incoming;
  try {
    const read = (gz) => {
      const { b, tags } = dataTags(gz), tick = tags.find((t) => t.name === 'Tick' && t.type === 3), l = tags.find((t) => t.name === 'Villages' && t.type === 9);
      const villages = (l ? nbtList(b, l.payload) : []).map((v) => {
        const int = (name) => { const t = nbtTags(b, v.start).find((x) => x.name === name && x.type === 3); return t ? b.readInt32BE(t.payload) : 0; };
        return { ...v, cell: cellKey(dim, int('CX') >> 4, int('CZ') >> 4) };
      });
      return { b, tick: tick ? b.readInt32BE(tick.payload) : 0, villages };
    };
    const S = read(stored), I = read(incoming), keep = [];
    for (const v of I.villages) if (mine(v.cell)) keep.push(I.b.subarray(v.start, v.end));
    for (const v of S.villages) if (!mine(v.cell)) keep.push(rebaseVillage(S.b, v, I.tick - S.tick));
    const tick = Buffer.alloc(4); tick.writeInt32BE(I.tick);
    return fileOf([tag(3, 'Tick', tick), tag(9, 'Villages', list10(keep))]);
  } catch { return incoming; }
}

// Maps (data/map_<n>.dat): one instance keeps a map's pixels in memory as it last read or wrote them (its baseline);
// when it writes the map, only the pixels it changed since then go onto the stored file, which keeps those another
// instance changed. Two instances whose players explore with copies of one map keep both explorations (the game has
// one MapData per world; without this the instance that saves last would win). The rest of the file is the writing
// instance's (centre, scale and dimension never change).
const MAP = /\/data\/map_\d+\.dat$/;
function mapColors(gz) {
  const { b, tags } = dataTags(gz), t = tags.find((x) => x.name === 'colors' && x.type === 7);
  if (!t) throw new Error('no colors');
  return { b, at: t.payload + 4, n: b.readInt32BE(t.payload) };
}
class MapBaselines {
  constructor() { this.base = new Map(); }   // path -> the pixels as this instance last read or wrote them
  read(path, gz) {
    if (!MAP.test(path)) return;
    try { const c = mapColors(Buffer.from(gz)); this.base.set(path, Buffer.from(c.b.subarray(c.at, c.at + c.n))); } catch {}
  }
  // The merge for a map file this instance writes, or null for any other file.
  merge(path) {
    if (!MAP.test(path)) return null;
    return (stored, incoming) => {
      let out = incoming;
      try {
        const I = mapColors(incoming), base = this.base.get(path);
        if (stored && base && base.length === I.n) {
          const S = mapColors(stored);
          if (S.n === I.n) {
            const b = Buffer.from(I.b);
            for (let i = 0; i < I.n; i++) if (I.b[I.at + i] === base[i]) b[I.at + i] = S.b[S.at + i];
            out = zlib.gzipSync(b);
          }
        }
        this.base.set(path, Buffer.from(I.b.subarray(I.at, I.at + I.n)));
      } catch { /* not as expected: written as it comes */ }
      return out;
    };
  }
}

// The merge for a world file written with regions on, or null (written as it comes). mine(cell): this instance has had
// the cell for a while.
const STRUCTURES = /\/data\/(Village|Temple|Mineshaft|Stronghold|Fortress|Monument)\.dat$/, VILLAGES = /\/data\/villages(_nether|_end)?\.dat$/;
function mergeFor(path, mine) {
  if (STRUCTURES.test(path)) return mergeFeatures;
  const v = VILLAGES.exec(path);
  if (v) { const dim = v[1] === '_nether' ? -1 : v[1] === '_end' ? 1 : 0; return (stored, incoming) => mergeVillages(stored, incoming, dim, mine); }
  return null;
}

module.exports = { nbtEnd, nbtTags, nbtList, mergeFeatures, mergeVillages, mergeFor, MapBaselines, STRUCTURES, VILLAGES, MAP };
