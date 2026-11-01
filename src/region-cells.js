'use strict';
// Shared by the host (regions.js) and the game threads (worker-runtime.js) for regions (config "regions"):
// which cell a chunk file belongs to, the player file's position, the frames of a few packets, and the empty
// chunk an instance gets for a chunk another instance has (it never happens while regions are kept apart).
//
// A cell is 2 x 2 chunks (32 x 32 blocks) of one dimension; chunks are owned per cell by one game instance. Small cells
// keep what two far-apart groups need apart (regions.js: the merge distance counts one cell on each side).

const zlib = require('node:zlib');

const CELL_SHIFT = 1;
const cellKey = (dim, cx, cz) => `${dim}:${cx >> CELL_SHIFT}:${cz >> CELL_SHIFT}`;

// The game's chunk file (VFSChunkLoader): worlds/<folder>/level<dimension>/<x><z>.dat, x and z plus 1,900,000 as
// six hex digits each, the lowest first (as terrain.js chunkPath).
const CHUNK_FILE = /\/level(-?\d+)\/([0-9A-F]{12})\.dat$/;
function chunkOfPath(p) {
  const m = CHUNK_FILE.exec(String(p)); if (!m) return null;
  const hex = (s) => { let v = 0; for (let i = 5; i >= 0; i--) v = v * 16 + parseInt(s[i], 16); return v - 1900000; };
  return { dim: +m[1], x: hex(m[2].slice(0, 6)), z: hex(m[2].slice(6)) };
}
function cellOfPath(p) { const c = chunkOfPath(p); return c ? cellKey(c.dim, c.x, c.z) : null; }

// ---------------------------------------------------------------- NBT (what the player file needs)
function readNBT(buf) {
  const b = Buffer.from(buf); let o = 0;
  const str = () => { const n = b.readUInt16BE(o); o += 2; const s = b.toString('utf8', o, o + n); o += n; return s; };
  const value = (t) => {
    switch (t) {
      case 1: return b.readInt8(o++);
      case 2: { const v = b.readInt16BE(o); o += 2; return v; }
      case 3: { const v = b.readInt32BE(o); o += 4; return v; }
      case 4: { const v = b.readBigInt64BE(o); o += 8; return v; }
      case 5: { const v = b.readFloatBE(o); o += 4; return v; }
      case 6: { const v = b.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = b.readInt32BE(o); o += 4; const v = b.subarray(o, o + n); o += n; return v; }
      case 8: return str();
      case 9: { const et = b[o++], n = b.readInt32BE(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(value(et)); return a; }
      case 10: { const c = {}; for (;;) { const tt = b[o++]; if (tt === 0) return c; const name = str(); c[name] = value(tt); } }
      case 11: { const n = b.readInt32BE(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(b.readInt32BE(o)); o += 4; } return a; }
      default: throw new Error('NBT tag type ' + t);
    }
  };
  const t = b[o++]; if (t !== 10) throw new Error('not an NBT compound'); str();
  return value(10);
}

// A saved player (worlds/<folder>/player/<name>.dat, gzipped NBT): { dim, x, y, z }, or null.
function playerPosFromFile(data) {
  try {
    const raw = data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data) : Buffer.from(data);
    const n = readNBT(raw), p = n.Pos;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return null;
    return { dim: Number.isInteger(n.Dimension) ? n.Dimension : 0, x: p[0], y: p[1], z: p[2] };
  } catch { return null; }
}

// ---------------------------------------------------------------- the integrated server's frames
// A frame of type 0 is one whole packet: [0][VarInt packet id][fields] (test/bench/bot.js has the protocol).
function varint(b, o) { let v = 0, s = 0, x; do { if (o >= b.length) return null; x = b[o++]; v |= (x & 127) << s; s += 7; } while (x & 128 && s < 35); return [v >>> 0, o]; }
function frameId(buf) { const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength); if (b[0] !== 0) return null; const r = varint(b, 1); return r ? r[0] : null; }
// The name in a client's first packet, LOGIN state Login Start (id 0): [0][0x00][VarInt length][name][skin...].
function loginName(buf) {
  const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (b[0] !== 0) return null; const r = varint(b, 1); if (!r || r[0] !== 0) return null;
  const l = varint(b, r[1]); if (!l || l[0] < 1 || l[0] > 16 || l[1] + l[0] > b.length) return null;
  const name = b.toString('utf8', l[1], l[1] + l[0]);
  return /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : null;
}
// Player List Item (PLAY state, id 0x38): { action (0 add, 1 game mode, 2 latency, 3 display name, 4 remove),
// uuids: [hex, ...] }, or null for another frame.
function playerListFrame(buf) {
  const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (b[0] !== 0) return null; let r = varint(b, 1); if (!r || r[0] !== 0x38) return null;
  const a = varint(b, r[1]); if (!a) return null; const n = varint(b, a[1]); if (!n) return null;
  const uuids = []; let o = n[1], name = null;
  for (let i = 0; i < n[0]; i++) {
    if (o + 16 > b.length) return null;
    uuids.push(b.toString('hex', o, o + 16)); o += 16;
    if (a[0] === 0 && i === 0) { const l = varint(b, o); if (l && l[1] + l[0] <= b.length) name = b.toString('utf8', l[1], l[1] + l[0]); }
    if (a[0] !== 4) break;   // only "remove" entries are a bare UUID; the others' fields are not needed here
  }
  return { action: a[0], count: n[0], uuids, name };
}
// JoinGame (PLAY, id 0x01): [Int entity id][UByte game mode][Byte dimension][UByte difficulty][UByte max players][String level type][Bool reduced debug info].
function joinGameFrame(buf) {
  const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (b[0] !== 0) return null; const r = varint(b, 1); if (!r || r[0] !== 0x01 || r[1] + 8 > b.length) return null;
  let o = r[1]; const entityId = b.readInt32BE(o); o += 4;
  const gamemode = b[o++], dimension = b.readInt8(o++), difficulty = b[o++]; o++;
  const l = varint(b, o); const levelType = l && l[1] + l[0] <= b.length ? b.toString('utf8', l[1], l[1] + l[0]) : 'default';
  return { entityId, gamemode, dimension, difficulty, levelType };
}
// Respawn (PLAY, id 0x07): [Int dimension][UByte difficulty][UByte game mode][String level type]. Into another dimension,
// the client makes a new world: what a BungeeCord network sends when it moves a player to another server.
function respawnFrame(dimension, { difficulty, gamemode, levelType }) {
  const t = Buffer.from(levelType || 'default', 'utf8'), d = Buffer.alloc(4); d.writeInt32BE(dimension | 0);
  return Buffer.concat([Buffer.from([0, 0x07]), d, Buffer.from([difficulty & 255, gamemode & 7]), Buffer.from([t.length]), t]);
}
// A packet that is one string (PLAY, id `id`): its text, or null.
function stringFrame(buf, id) {
  const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (b[0] !== 0) return null; const r = varint(b, 1); if (!r || r[0] !== id) return null;
  const l = varint(b, r[1]); return l && l[1] + l[0] <= b.length ? b.toString('utf8', l[1], l[1] + l[0]) : null;
}
// A Chat Message's JSON (server to client, id 0x02); what the client typed (client to server, id 0x01: a command
// starts with /). Null for other packets.
const chatFrame = (buf) => stringFrame(buf, 0x02);
const clientChat = (buf) => stringFrame(buf, 0x01);
// Frames the host makes: a Chat Message (id 0x02) with the JSON text, as the game sends its broadcasts (position 1:
// a system message); a Player List Item "remove" (id 0x38, action 4) of one player (UUID in hex).
const varintBytes = (v) => { const out = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; out.push(b); } while (v); return Buffer.from(out); };
function chatMessageFrame(json) { const t = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf8'); return Buffer.concat([Buffer.from([0, 0x02]), varintBytes(t.length), t, Buffer.from([1])]); }
function listRemoveFrame(uuid) { return Buffer.concat([Buffer.from([0, 0x38, 4, 1]), Buffer.from(uuid, 'hex')]); }

// ---------------------------------------------------------------- the empty chunk
// What an instance reads instead of a chunk that another instance has (the safety net of regions.js: that instance
// is moved into the other one at once): no blocks, no entities, populated and lit, so the game neither generates
// nor populates it. Writes of it are never kept (worker-runtime.js: only chunks of owned cells are written).
function emptyChunkFile(x, z) {
  const parts = [];
  const u8 = (v) => parts.push(Buffer.from([v & 255]));
  const name = (s) => { const n = Buffer.from(s, 'utf8'), l = Buffer.alloc(2); l.writeUInt16BE(n.length); parts.push(l, n); };
  const tag = (t, n) => { u8(t); name(n); };
  const i32 = (v) => { const x = Buffer.alloc(4); x.writeInt32BE(v | 0); parts.push(x); };
  const i64 = (v) => { const x = Buffer.alloc(8); x.writeBigInt64BE(BigInt(v)); parts.push(x); };
  tag(10, '');
  tag(10, 'Level');
  tag(3, 'xPos'); i32(x); tag(3, 'zPos'); i32(z);
  tag(4, 'LastUpdate'); i64(0); tag(4, 'InhabitedTime'); i64(0);
  tag(1, 'TerrainPopulated'); u8(1); tag(1, 'LightPopulated'); u8(1);
  tag(7, 'Biomes'); i32(256); parts.push(Buffer.alloc(256, 1));
  tag(11, 'HeightMap'); i32(256); parts.push(Buffer.alloc(1024));
  tag(9, 'Sections'); u8(10); i32(0);
  tag(9, 'Entities'); u8(10); i32(0);
  tag(9, 'TileEntities'); u8(10); i32(0);
  u8(0);   // end of Level
  u8(0);   // end of the root
  return zlib.gzipSync(Buffer.concat(parts));
}

module.exports = { CELL_SHIFT, cellKey, chunkOfPath, cellOfPath, readNBT, playerPosFromFile, varint, frameId, loginName, playerListFrame, joinGameFrame, respawnFrame, chatFrame, clientChat, chatMessageFrame, listRemoveFrame, emptyChunkFile };
