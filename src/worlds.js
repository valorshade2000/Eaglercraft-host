'use strict';
// Read-only access to the worlds database (same layout the browser keeps in IndexedDB).
// Deliberately does NOT use the native IPCPacket0EListWorlds, because the integrated
// server deletes any world whose level.dat it cannot find while listing.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const WORLDS_DB = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_worlds';

// NBT strings are Java's modified UTF-8 (DataOutput.writeUTF): like UTF-8, but U+0000 in 2 bytes and each half of a
// surrogate pair in 3 (4-byte UTF-8 from other tools is read too).
function javaUtfDecode(b) {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
    else if ((c & 0xe0) === 0xc0) { s += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if ((c & 0xf0) === 0xe0) { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    else { s += String.fromCodePoint(((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f)); i += 4; }
  }
  return s;
}

function parseNBT(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const i16 = () => { const v = buf.readInt16BE(o); o += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = javaUtfDecode(buf.subarray(o, o + n)); o += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: { const v = buf.readInt8(o); o += 1; return v; }
      case 2: return i16();
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(o); o += 8; return v; }
      case 5: { const v = buf.readFloatBE(o); o += 4; return v; }
      case 6: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = i32(); o += n; return `<${n} bytes>`; }
      case 8: return str();
      case 9: { const et = u8(); const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const c = {}; for (;;) { const tt = u8(); if (tt === 0) return c; const name = str(); c[name] = payload(tt); } }
      case 11: { const n = i32(); o += n * 4; return `<${n} ints>`; }
      default: throw new Error('bad NBT tag ' + t);
    }
  };
  const t = u8(); str(); return payload(t);
}

class WorldStore {
  constructor(file) {
    this.file = file;
  }
  _open() {
    if (!fs.existsSync(this.file)) return null;
    const db = new DatabaseSync(this.file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
  }
  _read(db, path) {
    const r = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, path);
    return r ? Buffer.from(r.data) : null;
  }
  list() {
    const db = this._open(); if (!db) return [];
    try {
      const listRaw = this._read(db, 'worlds_list.txt');
      const names = listRaw ? listRaw.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
      // Also surface world folders missing from worlds_list.txt (never hide data).
      const extra = db.prepare("SELECT DISTINCT substr(path, 8, instr(substr(path, 8), '/') - 1) AS f FROM files WHERE db = ? AND path LIKE 'worlds/%/level.dat%'").all(WORLDS_DB).map((r) => r.f);
      const out = [];
      for (const folder of [...new Set([...names, ...extra])]) {
        const w = { folder, listed: names.includes(folder) };
        const dat = this._read(db, `worlds/${folder}/level.dat`) || this._read(db, `worlds/${folder}/level.dat_old`);
        if (dat) {
          try {
            const d = parseNBT(zlib.gunzipSync(dat)).Data || {};
            w.name = d.LevelName || folder; w.lastPlayed = d.LastPlayed != null ? Number(d.LastPlayed) : null;
            w.gameType = d.GameType; w.hardcore = !!d.hardcore; w.cheats = !!d.allowCommands;
            w.seed = d.RandomSeed != null ? String(d.RandomSeed) : null; w.version = d.version;
            w.spawn = [d.SpawnX, d.SpawnY, d.SpawnZ]; w.time = d.Time != null ? Number(d.Time) : null;
          } catch (e) { w.error = 'level.dat unreadable: ' + e.message; }
        } else w.error = 'level.dat missing';
        const s = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)),0) AS b FROM files WHERE db = ? AND path >= ? AND path < ?').get(WORLDS_DB, `worlds/${folder}/`, `worlds/${folder}0`);
        w.files = s.n; w.bytes = s.b;
        out.push(w);
      }
      out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
      return out;
    } finally { db.close(); }
  }
  // The game rules stored in a world's level.dat (Data.GameRules: name -> string), or null.
  gameRules(folder) {
    const db = this._open(); if (!db) return null;
    try {
      const dat = this._read(db, `worlds/${folder}/level.dat`) || this._read(db, `worlds/${folder}/level.dat_old`);
      if (!dat) return null;
      const g = (parseNBT(zlib.gunzipSync(dat)).Data || {}).GameRules;
      return g && typeof g === 'object' ? g : null;
    } catch { return null; } finally { db.close(); }
  }
  exists(folder) {
    const db = this._open(); if (!db) return false;
    try {
      const r = db.prepare('SELECT 1 AS x FROM files WHERE db = ? AND path >= ? AND path < ? LIMIT 1').get(WORLDS_DB, `worlds/${folder}/`, `worlds/${folder}0`);
      const listRaw = this._read(db, 'worlds_list.txt');
      const listed = listRaw ? listRaw.toString('utf8').split('\n').map((s) => s.trim()).includes(folder) : false;
      return !!r || listed;
    } finally { db.close(); }
  }
  // GuiCreateWorld folder naming, but any existing data blocks a name (never overwrite). except: a folder that counts as
  // free (a world's own folder when it is renamed).
  freeFolderName(displayName, except) {
    let s = String(displayName || '').trim();
    for (const c of ['/', '\n', '\r', '\t', '\u0000', '\f', '`', '?', '*', '\\', '<', '>', '|', '"', ':']) s = s.split(c).join('_');
    if (!s) s = 'World';
    s = s.replace(/[./"]/g, '_');
    const bad = ['CON', 'COM', 'PRN', 'AUX', 'CLOCK$', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    if (bad.includes(s.toUpperCase())) s = '_' + s + '_';
    while (s !== except && this.exists(s)) s += '-';
    return s;
  }
}

module.exports = { WorldStore, WORLDS_DB, parseNBT, javaUtfDecode };
