'use strict';
// Renaming and deleting worlds (the web page's Worlds section; cli.js rename, delete, deleted, restore, purge) in the
// worlds database the game uses (data/worlds.sqlite, table files: see idb-sqlite.js). control.js calls these only while
// no world runs, so nothing else writes the database meanwhile.
//
// Rename: this game version names a world after its folder whenever it loads it (the integrated server sets
// Data.LevelName to the folder's name), so a new name lasts only with the folder of that name. Rename moves every file
// of the world to the new folder (control.js picks it: the name made safe for a folder, and free) and sets
// Data.LevelName in level.dat to it, leaving every other byte as it was.
// Delete moves every file of the world from worlds/<folder>/ to deleted/<time>/<folder>/ and takes the folder out of
// worlds_list.txt: the game no longer sees the world, and nothing is lost. Restore moves it back (into a free folder if
// the old one has been taken since). Only purge removes the files.

const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { WORLDS_DB, parseNBT } = require('./worlds');

const LIST = 'worlds_list.txt';
const TRASH = 'deleted/';

function open(file) { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000;'); return db; }
function inTx(file, fn) {
  const db = open(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(db); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  } finally { db.close(); }
}
// Every path that starts with prefix p (ending in '/') sorts in [p, p without its '/' + '0').
const range = (p) => [p, p.slice(0, -1) + '0'];
const get = (db, p) => { const r = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, p); return r ? Buffer.from(r.data) : null; };
const put = (db, p, data) => db.prepare('INSERT INTO files(db, path, data) VALUES(?, ?, ?) ON CONFLICT(db, path) DO UPDATE SET data = excluded.data').run(WORLDS_DB, p, data);
const count = (db, prefix) => db.prepare('SELECT COUNT(*) AS n FROM files WHERE db = ? AND path >= ? AND path < ?').get(WORLDS_DB, ...range(prefix)).n;
// (SQLite's substr counts characters, not UTF-16 units: an emoji in a folder name is one)
const move = (db, from, to) => db.prepare('UPDATE files SET path = ? || substr(path, ?) WHERE db = ? AND path >= ? AND path < ?').run(to, [...from].length + 1, WORLDS_DB, ...range(from));
// worlds_list.txt as the game writes it: folder names joined by "\n" (repeats happen; each is a line of its own).
const readList = (db) => { const b = get(db, LIST); return b ? b.toString('utf8').split('\n') : []; };
const writeList = (db, lines) => put(db, LIST, Buffer.from(lines.join('\n'), 'utf8'));

// A string as Java's DataOutput.writeUTF writes it (NBT strings): U+0000 and U+0080-U+07FF in 2 bytes, others in 3,
// each half of a surrogate pair on its own.
function javaUtf(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c <= 0x7f) out.push(c);
    else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

// level.dat's NBT (uncompressed) with Data.LevelName set to name; every other byte as it was.
function setLevelName(nbt, name) {
  let o = 0;
  const u16 = () => { const v = nbt.readUInt16BE(o); o += 2; return v; };
  const i32 = () => { const v = nbt.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = u16(); const v = nbt.subarray(o, o + n).toString('utf8'); o += n; return v; };
  const skip = (t) => {
    switch (t) {
      case 1: o += 1; return;
      case 2: o += 2; return;
      case 3: case 5: o += 4; return;
      case 4: case 6: o += 8; return;
      case 7: { const n = i32(); o += n; return; }
      case 8: { const n = u16(); o += n; return; }
      case 9: { const et = nbt[o++]; const n = i32(); for (let i = 0; i < n; i++) skip(et); return; }
      case 10: for (;;) { const tt = nbt[o++]; if (tt === 0) return; str(); skip(tt); }
      case 11: { const n = i32(); o += n * 4; return; }
      default: throw new Error('level.dat: unknown NBT tag ' + t);
    }
  };
  // a compound's entries from o: calls each(type, name, start of its value) until one returns true; else returns where
  // its End tag is
  const scan = (each) => {
    for (;;) {
      const at = o, t = nbt[o++];
      if (t === 0) return { end: at };
      const n = str();
      if (each(t, n)) return null;
      skip(t);
    }
  };
  if (nbt[o++] !== 10) throw new Error('level.dat: not an NBT compound');
  str();
  let found = false;
  const top = scan((t, n) => { if (t === 10 && n === 'Data') { found = true; return true; } return false; });
  if (!found || top) throw new Error('level.dat: no Data compound');
  let value = null;
  const data = scan((t, n) => { if (t === 8 && n === 'LevelName') { value = o; return true; } return false; });
  const bytes = javaUtf(name);
  if (bytes.length > 65535) throw new Error('name too long');
  const len = Buffer.alloc(2); len.writeUInt16BE(bytes.length);
  if (value !== null) { const end = value + 2 + nbt.readUInt16BE(value); return Buffer.concat([nbt.subarray(0, value), len, bytes, nbt.subarray(end)]); }
  // (no LevelName yet: added before Data's End tag, as setString does)
  const key = javaUtf('LevelName'), klen = Buffer.alloc(2); klen.writeUInt16BE(key.length);
  return Buffer.concat([nbt.subarray(0, data.end), Buffer.from([8]), klen, key, len, bytes, nbt.subarray(data.end)]);
}

// The world in folder `folder` into folder `target` (its new name), listed in worlds_list.txt where it was.
function renameWorld(file, folder, target) {
  return inTx(file, (db) => {
    const dat = get(db, `worlds/${folder}/level.dat`);
    if (!dat) throw new Error(`world '${folder}' has no level.dat`);
    const old = zlib.gunzipSync(dat), nbt = setLevelName(old, target);
    if (target === folder && nbt.equals(old)) return { folder, name: target, unchanged: true };
    if (parseNBT(nbt).Data.LevelName !== target) throw new Error('level.dat: the new name did not read back');   // (never: a check)
    if (target !== folder) {
      if (count(db, `worlds/${target}/`)) throw new Error(`folder '${target}' is in use`);   // (never: control.js picked a free one)
      move(db, `worlds/${folder}/`, `worlds/${target}/`);
      const list = readList(db);
      if (list.some((l) => l.trim() === folder)) writeList(db, list.map((l) => (l.trim() === folder ? target : l)));
      else writeList(db, list.length && !(list.length === 1 && list[0] === '') ? [...list, target] : [target]);
    }
    put(db, `worlds/${target}/level.dat`, zlib.gzipSync(nbt));
    return { folder: target, name: target, previousFolder: folder };
  });
}

function trashWorld(file, folder, now = Date.now()) {
  return inTx(file, (db) => {
    const from = `worlds/${folder}/`, files = count(db, from), list = readList(db);
    const listed = list.some((l) => l.trim() === folder);
    if (!files && !listed) throw new Error(`world '${folder}' not found`);
    const id = `${String(now).padStart(13, '0')}/${folder}`, to = TRASH + id + '/';
    if (count(db, to)) throw new Error(`deleted world '${id}' already exists`);
    move(db, from, to);
    if (listed) writeList(db, list.filter((l) => l.trim() !== folder));
    return { id, folder, files };
  });
}

// The deleted worlds, newest first: { id, folder, deletedAt, name, files, bytes }.
function listTrash(file) {
  const db = open(file);
  try {
    // id: '<13-digit time>/<folder>', the path after 'deleted/' up to the folder's '/'
    const rows = db.prepare(`SELECT substr(path, ${TRASH.length + 1}, 13 + instr(substr(path, ${TRASH.length + 15}), '/')) AS id, COUNT(*) AS files, COALESCE(SUM(length(data)), 0) AS bytes
      FROM files WHERE db = ? AND path >= ? AND path < ? GROUP BY id`).all(WORLDS_DB, ...range(TRASH));
    return rows.map((r) => {
      const id = r.id.replace(/\/$/, ''), folder = id.slice(14);
      let name = null;
      try { const dat = get(db, `${TRASH}${id}/level.dat`) || get(db, `${TRASH}${id}/level.dat_old`); if (dat) name = parseNBT(zlib.gunzipSync(dat)).Data.LevelName || null; } catch {}
      return { id, folder, deletedAt: Number(id.slice(0, 13)), name, files: r.files, bytes: r.bytes };
    }).sort((a, b) => b.deletedAt - a.deletedAt);
  } finally { db.close(); }
}

// freeFolder(folder): the folder to restore into (the old one, or a free one when it has been taken since).
function restoreWorld(file, id, freeFolder) {
  const folder = String(id).slice(14), target = freeFolder(folder);
  return inTx(file, (db) => {
    const from = `${TRASH}${id}/`;
    if (!/^\d{13}\//.test(String(id)) || !count(db, from)) throw new Error(`deleted world '${id}' not found`);
    if (count(db, `worlds/${target}/`)) throw new Error(`folder '${target}' is in use`);   // (never: freeFolder checked)
    move(db, from, `worlds/${target}/`);
    const list = readList(db);
    if (!list.some((l) => l.trim() === target)) writeList(db, list.length && !(list.length === 1 && list[0] === '') ? [...list, target] : [target]);
    return { id, folder: target, movedFrom: target !== folder ? folder : null };
  });
}

function purgeWorld(file, id) {
  return inTx(file, (db) => {
    const from = `${TRASH}${id}/`;
    if (!/^\d{13}\//.test(String(id)) || !count(db, from)) throw new Error(`deleted world '${id}' not found`);
    const r = db.prepare('DELETE FROM files WHERE db = ? AND path >= ? AND path < ?').run(WORLDS_DB, ...range(from));
    return { id, files: Number(r.changes) };
  });
}

module.exports = { renameWorld, trashWorld, listTrash, restoreWorld, purgeWorld, setLevelName, javaUtf };
