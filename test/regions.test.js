'use strict';
// Regions without the game (src/regions.js, src/region-cells.js, the storage gate in idb-sqlite.js): which cell a chunk
// file is in, the saved player's position, the login name and tab-list frames, the empty chunk; who owns a cell;
// where a joining player goes; which instances are merged; which instance a console command concerns; and the
// storage of an instance: a chunk of a cell it does not have is read only after the host's answer (the empty chunk
// when another instance has it), a write of it is not kept, and a region instance does not write the world's files.
// With the real daemon and game: test/regions-daemon.test.js.
//   node --test test/regions.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const rc = require('../src/region-cells');
const { Ownership, placeFor, mergesFor, splitsFor, groupsOf, mergeBlocks, commandScope } = require('../src/regions');
const { chunkPath } = require('../src/terrain');
const { createIndexedDB } = require('../src/idb-sqlite');

test('regions: chunk files, cells, the player file, the frames, the empty chunk', () => {
  for (const [x, z] of [[0, 0], [-1, -1], [7, 8], [-8, 15], [123456, -654321]]) {
    assert.deepEqual(rc.chunkOfPath(chunkPath('worlds/W', x, z)), { dim: 0, x, z });
    assert.equal(rc.cellOfPath(chunkPath('worlds/W', x, z)), `0:${x >> 1}:${z >> 1}`, 'a cell is 2 x 2 chunks');
  }
  assert.equal(rc.cellKey(0, -1, 3), '0:-1:1');
  assert.equal(rc.chunkOfPath('worlds/W/level-1/0CDFC100EFC1.dat').dim, -1);
  assert.equal(rc.cellOfPath('worlds/W/level.dat'), null);
  assert.equal(rc.cellOfPath('worlds/W/player/bob.dat'), null);
  // a player file: gzipped NBT with Pos (three doubles) and Dimension
  const nbt = Buffer.concat([Buffer.from([10, 0, 0]), Buffer.from([3, 0, 9]), Buffer.from('Dimension'), Buffer.from([255, 255, 255, 255]),
    Buffer.from([9, 0, 3]), Buffer.from('Pos'), Buffer.from([6, 0, 0, 0, 3]), ...[10.5, 64, -20.25].map((v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; }), Buffer.from([0])]);
  assert.deepEqual(rc.playerPosFromFile(zlib.gzipSync(nbt)), { dim: -1, x: 10.5, y: 64, z: -20.25 });
  assert.equal(rc.playerPosFromFile(Buffer.from('nonsense')), null);
  // the client's login (frame type 0, Login Start id 0, the name) and a tab-list frame
  assert.equal(rc.loginName(Buffer.concat([Buffer.from([0, 0, 5]), Buffer.from('Alice'), Buffer.from([5, 1, 0])])), 'Alice');
  assert.equal(rc.loginName(Buffer.from([1, 0, 5, 65])), null);
  const uuid = Buffer.alloc(16, 0xab);
  assert.deepEqual(rc.playerListFrame(Buffer.concat([Buffer.from([0, 0x38, 4, 1]), uuid])), { action: 4, count: 1, uuids: ['ab'.repeat(16)], name: null });
  assert.equal(rc.playerListFrame(Buffer.from([0, 0x02, 1, 65, 0])), null);
  assert.equal(rc.frameId(Buffer.from([0, 0x01, 0, 0])), 1);
  const add = Buffer.concat([Buffer.from([0, 0x38, 0, 1]), uuid, Buffer.from([3]), Buffer.from('Bob'), Buffer.from([0, 1, 5, 0])]);
  assert.deepEqual(rc.playerListFrame(add), { action: 0, count: 1, uuids: ['ab'.repeat(16)], name: 'Bob' });
  // JoinGame -> what a move needs; Respawn as a BungeeCord network sends it; a chat message's JSON
  const jg = Buffer.concat([Buffer.from([0, 0x01, 0, 0, 1, 0x41, 9, 0xff, 2, 20, 7]), Buffer.from('default'), Buffer.from([0])]);
  assert.deepEqual(rc.joinGameFrame(jg), { entityId: 321, gamemode: 9, dimension: -1, difficulty: 2, levelType: 'default' });
  assert.deepEqual([...rc.respawnFrame(0, { difficulty: 2, gamemode: 9, levelType: 'flat' })], [0, 0x07, 0, 0, 0, 0, 2, 1, 4, ...Buffer.from('flat')]);
  const chat = Buffer.concat([Buffer.from([0, 0x02, 12]), Buffer.from('{"text":"x"}'), Buffer.from([0])]);
  assert.equal(rc.chatFrame(chat), '{"text":"x"}');
  // the frames the host makes: a system message (a text longer than 127 bytes: a two-byte length), a tab-list removal
  const long = { text: 'y'.repeat(200) };
  assert.equal(rc.chatFrame(rc.chatMessageFrame(long)), JSON.stringify(long));
  assert.equal(rc.chatMessageFrame(long).at(-1), 1, 'position: a system message');
  assert.deepEqual(rc.playerListFrame(rc.listRemoveFrame('ab'.repeat(16))), { action: 4, count: 1, uuids: ['ab'.repeat(16)], name: null });
  // the empty chunk: no sections, no entities, populated and lit, at its place
  const e = rc.readNBT(zlib.gunzipSync(rc.emptyChunkFile(-5, 9))).Level;
  assert.deepEqual([e.xPos, e.zPos, e.TerrainPopulated, e.LightPopulated, e.Sections.length, e.Entities.length, e.TileEntities.length], [-5, 9, 1, 1, 0, 0, 0]);
});

test('regions: who has a cell, where a player joins, which instances merge, where a command runs', () => {
  const own = new Ownership();
  assert.equal(own.claim(0, '0:1:1'), 'ok'); assert.equal(own.claim(0, '0:1:1'), 'ok');
  assert.deepEqual(own.claim(1, '0:1:1'), { owner: 0 });
  assert.equal(own.release(1, '0:1:1'), false, 'only the owner gives a cell back');
  assert.equal(own.release(0, '0:1:1'), true); assert.equal(own.claim(1, '0:1:1'), 'ok');
  own.claim(1, '0:2:2'); assert.deepEqual(own.releaseAll(1).sort(), ['0:1:1', '0:2:2']); assert.equal(own.count(1), 0);

  const at = mergeBlocks(4);
  assert.equal(at, 320, 'view distance 4: what each instance may load (7 chunks) rounded out by a cell, both sides, plus 32');
  const opt = { mergeAt: at, maxRegions: 2 };
  const main = { id: 0, region: false, accepting: true, players: [{ dim: 0, x: 0, z: 0 }], channels: 1 };
  assert.deepEqual(placeFor(null, [main], new Ownership(), opt), { id: 0 }, 'a new player: main');
  assert.deepEqual(placeFor({ dim: 0, x: 100, z: 100 }, [main], new Ownership(), opt), { id: 0 }, 'close to a main player');
  assert.deepEqual(placeFor({ dim: 0, x: 1000, z: 0 }, [main], new Ownership(), opt), { start: true }, 'far from everyone: a new region instance');
  const r1 = { id: 1, region: true, accepting: true, players: [{ dim: 0, x: 1000, z: 0 }], channels: 1 };
  assert.deepEqual(placeFor({ dim: 0, x: 1100, z: 40 }, [main, r1], new Ownership(), opt), { id: 1 }, 'near the region instance\'s player');
  assert.deepEqual(placeFor({ dim: -1, x: 1100, z: 40 }, [main, r1], new Ownership(), opt), { start: true }, 'another dimension counts as far');
  const o = new Ownership(); o.claim(1, rc.cellKey(0, 2000 >> 4, 0));
  assert.deepEqual(placeFor({ dim: 0, x: 2000, z: 0 }, [main, r1], o, opt), { id: 1 }, 'the instance that has the cell of the saved position');
  const r2 = { id: 2, region: true, accepting: true, players: [{ dim: 0, x: -3000, z: 0 }], channels: 1 };
  assert.deepEqual(placeFor({ dim: 0, x: 0, z: 5000 }, [main, r1, r2], new Ownership(), opt), { id: 0 }, 'no region instance left: main');
  const idle = { id: 3, region: true, accepting: true, players: [], channels: 0 };
  assert.deepEqual(placeFor({ dim: 0, x: 0, z: 5000 }, [main, r1, idle], new Ownership(), opt), { id: 3 }, 'an idle region instance first');

  assert.deepEqual(mergesFor([main, r1], { mergeAt: at }), [], 'far apart: no merge');
  const close = { ...r1, players: [{ dim: 0, x: 200, z: 0 }] };
  const bob = { ...close, players: close.players.map((p) => ({ ...p, name: 'Bob' })) };
  assert.deepEqual(mergesFor([{ ...main, players: [{ ...main.players[0], name: 'Al' }] }, bob], { mergeAt: at }), [{ from: 0, into: 1, names: ['Al'] }], 'the same size: the group in main joins the region instance');
  const main2 = { ...main, players: [{ dim: 0, x: 0, z: 0, name: 'Al' }, { dim: 0, x: 10, z: 0, name: 'Cy' }] };
  assert.deepEqual(mergesFor([main2, bob], { mergeAt: at }), [{ from: 1, into: 0, names: ['Bob'] }], 'the smaller group moves: into main');
  const a = { id: 1, region: true, accepting: true, players: [{ dim: 0, x: 5000, z: 0 }, { dim: 0, x: 5010, z: 0 }] }, b = { id: 2, region: true, accepting: true, players: [{ dim: 0, x: 5100, z: 0 }] };
  const named = (i, ns) => ({ ...i, players: i.players.map((p, k) => ({ ...p, name: ns[k] })) });
  assert.deepEqual(mergesFor([main, named(a, ['A1', 'A2']), named(b, ['B1'])], { mergeAt: at }), [{ from: 2, into: 1, names: ['B1'] }], 'the one with fewer players moves its group');
  // groups, and a group far from everyone else (it moves to an instance of its own); the largest group stays
  const ps = [{ name: 'a', dim: 0, x: 0, z: 0 }, { name: 'b', dim: 0, x: 200, z: 0 }, { name: 'c', dim: 0, x: 420, z: 0 }, { name: 'd', dim: 0, x: 2000, z: 0 }, { name: 'e', dim: -1, x: 0, z: 0 }];
  assert.deepEqual(groupsOf(ps, at).map((g) => g.map((p) => p.name).sort()), [['a', 'b', 'c'], ['d'], ['e']], 'chained within 320 blocks, per dimension');
  assert.equal(groupsOf([{ name: 'p', dim: 0, x: 0, z: 0 }, { name: 'q', dim: 0, x: 250, z: 250 }], at).length, 1, 'on a diagonal too: the larger of the x and z distances (the areas are squares)');
  const m0 = { id: 0, region: false, players: ps };
  assert.deepEqual(splitsFor([m0], { mergeAt: at, splitAt: at + 64 }).map((x) => x.names), [['d'], ['e']], 'the far group and the other dimension');
  const m1 = { id: 0, region: false, players: [ps[0], { name: 'f', dim: 0, x: 350, z: 0 }] };
  assert.deepEqual(splitsFor([m1], { mergeAt: at, splitAt: at + 64 }), [], 'between 320 and 384 blocks: neither merged nor split (hysteresis)');
  assert.deepEqual(splitsFor([{ id: 0, region: false, players: [ps[0]] }, { id: 1, region: true, players: [ps[3]] }], { mergeAt: at, splitAt: at + 64 }), [], 'alone in its instance: nothing to split');

  assert.deepEqual(commandScope('/time set 6000'), { all: true });
  assert.deepEqual(commandScope('gamerule doDaylightCycle false'), { all: true });
  assert.deepEqual(commandScope('tp Bob 1 2 3'), { player: 'Bob' });
  assert.deepEqual(commandScope('execute Alice ~ ~ ~ setblock ~ ~ ~ stone'), { player: 'Alice' });
  assert.deepEqual(commandScope('say hello'), { player: null }, 'say: the main instance (every player sees it anyway)');
  assert.deepEqual(commandScope('give hello stone'), { player: 'hello' }, 'a word that is no player name: the daemon finds no such player and runs it in main');
  assert.deepEqual(commandScope('list'), { list: true }, 'the players of every instance');
  assert.deepEqual(commandScope('give @a minecraft:stone'), { all: true, selector: true }, '@a: every instance (each gives to its players, each answers)');
  assert.deepEqual(commandScope('kill @e[type=Zombie]'), { all: true, selector: true });
  assert.deepEqual(commandScope('say @a hello'), { say: true }, 'say and me naming players: the host names those of every instance');
  assert.deepEqual(commandScope('me waves'), { player: null }, 'say and me: the main instance (every player sees it anyway)');
  assert.deepEqual(commandScope('tp @p 0 64 0'), { pick: '@p' }, 'a bare @p or @r: the host picks the player');
  assert.deepEqual(commandScope('tp @p[r=5] 0 64 0'), { player: null }, 'with arguments: the main instance');
});

test('regions: an instance\'s storage: chunks of cells it does not have, the world\'s files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgs-')), file = path.join(dir, 'w.sqlite');
  try {
    const answers = new Map();   // cell -> 'ok' | 'empty', what the host answers
    const asked = [];
    const owned = new Set();
    const gate = {
      read(k) { const c = rc.cellOfPath(k); if (!c) return null; if (owned.has(c)) return Promise.resolve('ok'); asked.push(c); return new Promise((res) => setTimeout(() => { const v = answers.get(c) || 'ok'; if (v === 'ok') owned.add(c); res(v); }, 20)); },
      end() {},
      write(k) { const c = rc.cellOfPath(k); if (c) return owned.has(c); return !/level\.dat|\/data\//.test(k); },
      empty(k) { const ch = rc.chunkOfPath(k); return rc.emptyChunkFile(ch.x, ch.z); },
    };
    const idb = createIndexedDB(file, () => {}, 'normal', { gate });
    const open = () => new Promise((res) => { const r = idb.open('db', 1); r.onupgradeneeded = () => {}; r.onsuccess = () => res(r.result); });
    const db = await open(), st = () => db.transaction('filesystem', 'readwrite').objectStore('filesystem');
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const mine = chunkPath('worlds/W', 1, 1), theirs = chunkPath('worlds/W', 100, 100);
    answers.set(rc.cellOfPath(theirs), 'empty');
    // a chunk of a cell this instance does not have yet: asked first, then read
    assert.equal(await req(st().get(mine)), undefined); assert.deepEqual(asked, [rc.cellOfPath(mine)]);
    await req(st().put({ path: mine, data: new Uint8Array([1, 2, 3]) }));
    assert.deepEqual([...new Uint8Array((await req(st().get(mine))).data)], [1, 2, 3], 'written: its cell is this instance\'s');
    assert.equal(asked.length, 1, 'asked once per cell');
    // another instance has this cell: the empty chunk, and a write of it is not kept
    const e = await req(st().get(theirs));
    assert.equal(rc.readNBT(zlib.gunzipSync(Buffer.from(e.data))).Level.Sections.length, 0);
    assert.equal(await req(st().count(theirs)), 1, 'the empty chunk counts as there');
    await req(st().put({ path: theirs, data: new Uint8Array([9]) }));
    const raw = idb._sql.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(theirs).n;
    assert.equal(raw, 0, 'nothing written for a cell of another instance');
    // the world's own files: not written by a region instance (this gate), the players' files are
    await req(st().put({ path: 'worlds/W/level.dat', data: new Uint8Array([7]) }));
    await req(st().put({ path: 'worlds/W/player/bob.dat', data: new Uint8Array([8]) }));
    assert.equal(idb._sql.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get('worlds/W/level.dat').n, 0);
    assert.equal(idb._sql.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get('worlds/W/player/bob.dat').n, 1);
    // without a gate (regions off): everything as before
    const plain = createIndexedDB(file, () => {}, 'normal');
    const db2 = await new Promise((res) => { const r = plain.open('db', 1); r.onsuccess = () => res(r.result); });
    const st2 = () => db2.transaction('filesystem', 'readwrite').objectStore('filesystem');
    await req(st2().put({ path: theirs, data: new Uint8Array([5]) }));
    assert.deepEqual([...new Uint8Array((await req(st2().get(theirs))).data)], [5]);
    idb._sql.close(); plain._sql.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// NBT for the data files below: a named tag, an int, a compound, a list of compounds.
const tagOf = (type, name, payload) => { const n = Buffer.from(name), h = Buffer.alloc(3); h[0] = type; h.writeUInt16BE(n.length, 1); return Buffer.concat([h, n, payload]); };
const int32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const nInt = (name, v) => tagOf(3, name, int32(v));
const body = (parts) => Buffer.concat([...parts, Buffer.from([0])]);
const nCompound = (name, parts) => tagOf(10, name, body(parts));
const nList = (name, items) => tagOf(9, name, Buffer.concat([Buffer.from([10]), int32(items.length), ...items.map(body)]));
const dataFile = (parts) => zlib.gzipSync(body([nCompound('', [nCompound('data', parts)])]));
const readData = (gz) => rc.readNBT(zlib.gunzipSync(gz)).data;

test('regions: world data files several instances write: structures (union), villages (by area, one tick count), in the storage', async () => {
  const rd = require('../src/region-data');
  // structures: every feature of both files, the incoming file's own where both have one
  const feature = (key, v) => nCompound(key, [nInt('ChunkX', v)]);
  const merged = readData(rd.mergeFeatures(dataFile([nCompound('Features', [feature('[1,2]', 1), feature('[3,4]', 2)])]), dataFile([nCompound('Features', [feature('[3,4]', 9), feature('[5,6]', 3)])])));
  assert.deepEqual(Object.keys(merged.Features).sort(), ['[1,2]', '[3,4]', '[5,6]']);
  assert.equal(merged.Features['[3,4]'].ChunkX, 9, 'the incoming file\'s own');
  assert.equal(rd.mergeFeatures(null, Buffer.from('x')).toString(), 'x', 'nothing stored: as it comes');
  assert.equal(rd.mergeFeatures(Buffer.from('broken'), Buffer.from('y')).toString(), 'y', 'not NBT: as it comes');
  // villages: the incoming file's where its instance has had the chunks (mine), the stored file's elsewhere, all on the
  // incoming file's tick count (stamps moved by the difference: 5000 - 1000)
  const village = (cx, tick, door) => [nInt('CX', cx), nInt('CY', 64), nInt('CZ', 0), nInt('Tick', tick), nInt('Stable', tick - 5), nInt('MTick', 0), nList('Doors', [[nInt('X', cx), nInt('TS', door)]])];
  const stored = dataFile([nInt('Tick', 1000), nList('Villages', [village(0, 1000, 990), village(1000, 1000, 995)])]);
  const incoming = dataFile([nInt('Tick', 5000), nList('Villages', [village(1000, 5000, 4999), village(2000, 5000, 4998)])]);
  const mine = (cell) => cell === rc.cellKey(0, 1000 >> 4, 0);
  const v = readData(rd.mergeVillages(stored, incoming, 0, mine));
  assert.equal(v.Tick, 5000);
  assert.deepEqual(v.Villages.map((x) => x.CX).sort((a, b) => a - b), [0, 1000], 'stored elsewhere, incoming where it has the chunks');
  const old = v.Villages.find((x) => x.CX === 0), fresh = v.Villages.find((x) => x.CX === 1000);
  assert.deepEqual([old.Tick, old.Stable, old.MTick, old.Doors[0].TS], [5000, 4995, 0, 4990], 'the stored village moved onto the new tick count (MTick 0 stays)');
  assert.deepEqual([fresh.Tick, fresh.Doors[0].TS], [5000, 4999], 'the incoming village as it is');
  assert.equal(rd.mergeFor('worlds/W/data/Temple.dat', mine), rd.mergeFeatures);
  assert.ok(rd.mergeFor('worlds/W/data/villages_nether.dat', mine));
  assert.equal(rd.mergeFor('worlds/W/data/scoreboard.dat', mine), null);
  // in the storage: two instances (two connections to one file) write the same structure file; both features stay
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgd-')), file = path.join(dir, 'w.sqlite');
  try {
    const open = (idb) => new Promise((res) => { const r = idb.open('db', 1); r.onupgradeneeded = () => {}; r.onsuccess = () => res(r.result); });
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const a = createIndexedDB(file, () => {}, 'normal', { merge: (k) => rd.mergeFor(k, () => true) }), b = createIndexedDB(file, () => {}, 'normal', { merge: (k) => rd.mergeFor(k, () => true) });
    const [da, db] = [await open(a), await open(b)];
    const put = (d, data) => req(d.transaction('filesystem', 'readwrite').objectStore('filesystem').put({ path: 'worlds/W/data/Temple.dat', data }));
    await put(da, dataFile([nCompound('Features', [feature('[1,1]', 1)])]));
    await put(db, dataFile([nCompound('Features', [feature('[2,2]', 2)])]));
    const row = a._sql.prepare('SELECT data FROM files WHERE path = ?').get('worlds/W/data/Temple.dat');
    assert.deepEqual(Object.keys(readData(Buffer.from(row.data)).Features).sort(), ['[1,1]', '[2,2]'], 'both instances\' structures kept');
    a._sql.close(); b._sql.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('regions: an instance\'s gate: a claim without an answer is asked again after 10 s, the first answer counts; idle cells given back', async () => {
  const { makeRegionGate, ASK_AGAIN_MS } = require('../src/region-gate');
  const posts = [], logs = [], loaded = new Set();
  const gate = makeRegionGate({ id: 1, region: true }, { post: (m) => posts.push(m), log: (l) => logs.push(l), api: () => ({ loadedCells: () => [...loaded] }), flush: async () => {}, mergeFor: () => null });
  const k = chunkPath('worlds/W', 3, 3), c = rc.cellOfPath(k);
  let verdict = null; const p = gate.read(k).then((v) => { verdict = v; });
  assert.deepEqual(posts.map((m) => [m.__host, m.id, m.cells]), [['claim', 1, [c]]]);
  assert.equal(gate.snapshot().claims.length, 1, 'the stall report names the claim');
  gate.recheck(Date.now() + 1000); assert.equal(posts.length, 1, 'not again within 10 s');
  gate.recheck(Date.now() + ASK_AGAIN_MS + 1);
  assert.deepEqual(posts.map((m) => [m.__host, m.id]), [['claim', 1], ['claim', 1]], 'asked again, the same claim');
  assert.match(logs.join('\n'), /no answer for cell .* asked again \(2\)/);
  gate.claimResult({ __host: 'claimResult', id: 1, results: { [c]: 'ok' } });
  gate.claimResult({ __host: 'claimResult', id: 1, results: { [c]: 'deny' } });   // the answer to the copy: ignored
  await p; gate.end(k);
  assert.equal(verdict, 'ok'); assert.equal(gate.owned(), 1); assert.match(logs.join('\n'), /answered after/);
  assert.equal(gate.snapshot().claims.length, 0);
  assert.equal(gate.write(k), true, 'its cell: written'); gate.end(k);
  assert.equal(gate.write(chunkPath('worlds/W', 300, 300)), false, 'a cell it does not have: not written');
  // no loaded chunk in the cell for two checks: given back
  await gate.releaseIdle(); assert.equal(gate.owned(), 1);
  await gate.releaseIdle(); assert.equal(gate.owned(), 0);
  assert.deepEqual(posts.at(-1), { __host: 'release', cells: [c] });
});

test('regions: the main instance never waits without end for a cell: after 10 s its owner goes into it, after a minute it stops', async () => {
  const { Regions } = require('../src/regions');
  const logs = [], replies = [];
  const R = new Regions({ log: (l) => logs.push(l), viewDistance: 4, maxRegions: 1, lan: () => null, boot: {},
    main: { ipc() {}, call: async () => ({}), toGame() {}, openChannel() {}, closeChannel() {}, reply: (m) => replies.push(m) } });
  clearInterval(R._timer);
  const region = (id) => { const r = { id, region: true, state: 'running', players: [], channels: new Set(), stats: [], merging: null, call: async () => ({}), stopped: null }; r.stop = async (why) => { r.stopped = why; }; return r; };
  const r1 = region(1); R.instances.set(1, r1); R.own.claim(1, 'X');
  // a player moving from r1 into the main instance: the main instance's claim of r1's cell waits (it comes with the move)
  R.sessions.set('ch', { name: 'Bob', move: { from: 1, to: 0, phase: 'leaving' } });
  R.fromInstance(0, { __host: 'claim', id: 5, cells: ['X'] });
  assert.equal(replies.length, 0); assert.equal(R.held.length, 1); assert.equal(r1.merging, null);
  R.held[0].at = Date.now() - 11000; await R._everySecond();
  assert.match(logs.join('\n'), /the main instance has waited 11 s for cell X of r1/);
  assert.ok(r1.merging, 'after 10 s r1 goes into the main instance'); assert.equal(r1.stopped, null);
  R.held[0].at = Date.now() - 61000; await R._everySecond();
  assert.equal(r1.stopped, 'the main instance waited a minute for its cells');
  // when r1 is gone its cells are free, and the main instance gets its answer
  R.own.releaseAll(1); R._grantHeld();
  assert.deepEqual(replies, [{ __host: 'claimResult', id: 5, results: { X: 'ok' } }]);
  assert.equal(R.held.length, 0);
});

test('regions: a map two instances write keeps the pixels each changed (without regions the last write wins)', async () => {
  const rd = require('../src/region-data');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgm-')), file = path.join(dir, 'w.sqlite'), opened = [];
  try {
    const mapFile = (colors) => dataFile([tagOf(1, 'dimension', Buffer.from([0])), nInt('xCenter', 64), nInt('zCenter', -64), tagOf(1, 'scale', Buffer.from([0])),
      tagOf(2, 'width', Buffer.from([0, 128])), tagOf(2, 'height', Buffer.from([0, 128])), tagOf(7, 'colors', Buffer.concat([int32(colors.length), Buffer.from(colors)]))]);
    const instance = (merging) => {
      const maps = new rd.MapBaselines();
      const idb = createIndexedDB(file, () => {}, 'normal', merging ? { merge: (k) => maps.merge(k), onRead: (k, d) => maps.read(k, d) } : {}); opened.push(idb);
      const db = new Promise((res) => { const r = idb.open('db', 1); r.onupgradeneeded = () => {}; r.onsuccess = () => res(r.result); });
      const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const st = async () => (await db).transaction('filesystem', 'readwrite').objectStore('filesystem');
      return { idb, put: async (p, gz) => req((await st()).put({ path: p, data: new Uint8Array(gz) })), get: async (p) => req((await st()).get(p)) };
    };
    // (the stored file read straight from the table: a read through an instance is the game loading the map into memory)
    const p = 'worlds/W/data/map_0.dat', stored = () => Array.from(readData(Buffer.from(opened[0]._sql.prepare('SELECT data FROM files WHERE path = ?').get(p).data)).colors);
    const blank = new Array(16384).fill(0), a = instance(true), b = instance(true);
    await a.put(p, mapFile(blank));   // the map made in one instance
    await a.get(p); await b.get(p);   // both have it in memory
    const ca = blank.slice(); for (let i = 0; i < 10; i++) ca[i] = 34;          // a's player explores the west
    const cb = blank.slice(); for (let i = 100; i < 110; i++) cb[i] = 50;       // b's player the east, with a copy
    await a.put(p, mapFile(ca)); await b.put(p, mapFile(cb));
    let c = stored();
    assert.deepEqual([c.slice(0, 10).every((v) => v === 34), c.slice(100, 110).every((v) => v === 50)], [true, true], 'both explorations kept');
    ca[5] = 40; await a.put(p, mapFile(ca));   // a changes a pixel again: b's stay
    c = stored();
    assert.deepEqual([c[5], c[0], c[100], c[109], c[200]], [40, 34, 50, 50, 0]);
    // regions off: no merge, the instance that writes last wins
    const plain = instance(false); await plain.put(p, mapFile(cb));
    c = stored(); assert.deepEqual([c[0], c[100]], [0, 50]);
  } finally { for (const x of opened) try { x._sql.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test('regions: commands across instances: selectors of all players or entities, say naming the players of every instance', () => {
  const { Regions, worldSelector, joinNames } = require('../src/regions');
  assert.deepEqual(['', 'A', 'A and B', 'A, B and C'], [[], ['A'], ['A', 'B'], ['A', 'B', 'C']].map(joinNames), 'as the game joins names');
  for (const x of ['@a', '@e', '@e[type=Zombie]', '@a[team=red]', '@a[m=1,l=5]', '@e[type=Item,name=diamond]']) assert.equal(worldSelector(x), true, x);
  for (const x of ['@p', '@r', '@e[r=5]', '@a[x=1,y=2,z=3]', '@e[type=Cow,c=1]', '@a[rm=10]', '@e[dx=4]']) assert.equal(worldSelector(x), false, x);
  const ran = [];
  const R = new Regions({ log() {}, viewDistance: 4, maxRegions: 2, lan: () => null, boot: { lan: () => ({ cheats: false }), ops: () => ['Alice', 'Bob'] },
    main: { ipc() {}, call: async (fn, cmd) => { ran.push([0, cmd]); return {}; }, toGame() {}, openChannel() {}, closeChannel() {}, reply() {} } });
  clearInterval(R._timer);
  const r1 = { id: 1, region: true, state: 'running', players: [{ name: 'Bob', dim: 0, x: 900, y: 70, z: 0 }], channels: new Set(['b']), stats: [], merging: null, call: async (fn, cmd) => { ran.push([1, cmd]); return {}; } };
  R.instances.set(1, r1); R.instances.get(0).players = [{ name: 'Alice', dim: 0, x: 10, y: 70, z: 5 }, { name: 'Carl', dim: 0, x: 40, y: 70, z: 5 }];
  for (const [ch, name, id] of [['a', 'Alice', 0], ['b', 'Bob', 1], ['c', 'Carl', 0]]) { R.sessions.set(ch, { name }); R.channelOf.set(ch, id); R.instances.get(id).channels.add(ch); }
  // the console: say naming every player; @p the one nearest the origin; a selector in every instance, each answering
  assert.deepEqual(R.commandTarget('say Hello @a'), { id: 0, command: 'say Hello Alice, Bob and Carl' });
  assert.deepEqual(R.commandTarget('/me greets @p'), { id: 0, command: 'me greets Alice' });
  assert.deepEqual(R.commandTarget('kill @e[type=Zombie]'), { all: true, selector: true });
  assert.deepEqual(R.commandTarget('time set day'), { all: true });
  // a player (an OP) typing a command with a selector of all players: also run in the other instances
  const typed = (ch, text) => R._playerCommand(ch, R.sessions.get(ch), text);
  assert.equal(typed('a', '/give @a minecraft:diamond 1'), false, 'and in the player\'s own instance, as the player');
  assert.deepEqual(ran.splice(0), [[1, 'give @a minecraft:diamond 1']]);
  assert.equal(typed('b', '/effect @e[type=Zombie] 1 30'), false); assert.deepEqual(ran.splice(0), [[0, 'effect @e[type=Zombie] 1 30']]);
  for (const t of ['/kill @e[r=5]', '/tp @a Bob', '/give @a stone ~', '/execute @e ~ ~ ~ say hi', '/say hi @a', '/give @p stone']) { assert.equal(typed('a', t), false, t); assert.deepEqual(ran.splice(0), [], t + ': only in the player\'s instance'); }
  // a player who may not use commands: nothing passed on (the game answers them)
  assert.equal(typed('c', '/give @a minecraft:diamond 1'), false); assert.deepEqual(ran.splice(0), []);
});

test('regions: who moves: players near the world spawn stay with the main instance; a player who reached another instance\'s area goes with the players near them only; a move hides only its own leave and join', async () => {
  const { Regions, groupAt } = require('../src/regions');
  const spawn = { dim: 0, x: -173, z: 174 }, at = { mergeAt: 320, maxRegions: 3, spawn };
  const own = new Ownership();
  // joining: near the spawn the main instance even with nobody online (it reads the spawn's top block for every join);
  // far away an instance of one's own; without the spawn known, as before
  assert.deepEqual(placeFor({ dim: 0, x: -170, z: 180 }, [{ id: 0, region: false, accepting: true, players: [] }], own, at), { id: 0 });
  assert.deepEqual(placeFor({ dim: 0, x: -170, z: 180 }, [{ id: 0, region: false, accepting: true, players: [] }], own, { ...at, spawn: null }), { start: true });
  assert.deepEqual(placeFor({ dim: 0, x: -2170, z: 1780 }, [{ id: 0, region: false, accepting: true, players: [] }], own, at), { start: true });
  assert.deepEqual(placeFor({ dim: -1, x: -170, z: 180 }, [{ id: 0, region: false, accepting: true, players: [] }], own, at), { start: true }, 'the nether is not the spawn');
  // splitting: the group at the spawn stays in the main instance, even when the far one is larger
  const main = { id: 0, region: false, players: [{ name: 'Ann', dim: 0, x: -170, z: 170 }, { name: 'F1', dim: 0, x: 1800, z: 0 }, { name: 'F2', dim: 0, x: 1801, z: 0 }] };
  assert.deepEqual(splitsFor([main], { mergeAt: 320, splitAt: 384, spawn }).map((x) => x.names.sort()), [['F1', 'F2']]);
  assert.deepEqual(splitsFor([main], { mergeAt: 320, splitAt: 384 }).map((x) => x.names), [['Ann']], 'without the spawn: the largest group stays');
  // meeting at the spawn: the region instance's group comes into the main instance, even when it is larger
  const r = { id: 1, region: true, players: [{ name: 'R1', dim: 0, x: -100, z: 170 }, { name: 'R2', dim: 0, x: -101, z: 170 }] };
  const m0 = { id: 0, region: false, players: [{ name: 'Ann', dim: 0, x: -170, z: 170 }] };
  assert.deepEqual(mergesFor([m0, r], { mergeAt: 320, spawn }), [{ from: 1, into: 0, names: ['R1', 'R2'] }]);
  assert.deepEqual(mergesFor([m0, r], { mergeAt: 320 }), [{ from: 0, into: 1, names: ['Ann'] }], 'without the spawn: the smaller group moves');
  // the players near a cell (and those near them); nobody near: none
  const ps = [{ name: 'Tom', dim: 0, x: -170, z: 175 }, { name: 'Tia', dim: 0, x: -172, z: -1325 }, { name: 'Tim', dim: 0, x: 0, z: 150 }];
  assert.deepEqual(groupAt(ps, '0:-6:5', 320).sort(), ['Tim', 'Tom']);
  assert.deepEqual(groupAt(ps, '0:40:40', 320), []);

  // the host: Tom of r1 respawns at the world spawn (a cell of the main instance): only Tom moves; Tia stays in r1
  const R = new Regions({ log() {}, viewDistance: 4, maxRegions: 2, lan: () => null, boot: {},
    main: { ipc() {}, call: async () => ({}), toGame() {}, openChannel() {}, closeChannel() {}, reply() {} } });
  clearInterval(R._timer);
  const moved = []; R.moveGroup = async (names, from, to) => { moved.push([names, from.id, to.id]); return names.length; };
  const region = (id, names) => {
    for (const n of names) { R.sessions.set('ch-' + n, { name: n }); R.channelOf.set('ch-' + n, id); }
    return { id, region: true, state: 'running', players: [], channels: new Set(names.map((n) => 'ch-' + n)), stats: [], merging: null, call: async () => ({}), reply() {} };
  };
  const r1 = region(1, ['Tom', 'Tia']); R.instances.set(1, r1);
  R.own.claim(0, '0:-6:5');
  R.fromInstance(1, { __host: 'claim', id: 1, cells: ['0:-6:5'] });
  assert.ok(r1.reached && !r1.merging && !moved.length, 'decided on its next positions');
  R.fromInstance(1, { __host: 'positions', players: [{ name: 'Tia', dim: 0, x: -172, y: 120, z: -1325 }] });   // Tom respawning: in no list yet
  assert.ok(r1.reached && !r1.merging && !moved.length, 'nobody near yet: not decided');
  R.fromInstance(1, { __host: 'positions', players: [{ name: 'Tom', dim: 0, x: -170, y: 70, z: 175 }, { name: 'Tia', dim: 0, x: -172, y: 120, z: -1325 }] });
  assert.deepEqual(moved.splice(0), [[['Tom'], 1, 0]]); assert.equal(r1.merging, null, 'r1 stays, with Tia');
  await new Promise((res) => setImmediate(res));
  R.fromInstance(1, { __host: 'claim', id: 2, cells: ['0:-6:5'] });   // a claim made before Tom left: no move of Tia
  assert.ok(!r1.reached); assert.equal(moved.length, 0);
  // Tom is in the main instance now, near Ann; r1's last report still has him at the spawn: r1 is not a group there
  r1.channels.delete('ch-Tom'); R.channelOf.set('ch-Tom', 0); R.instances.get(0).channels.add('ch-Tom');
  R.sessions.set('ch-Ann', { name: 'Ann' }); R.channelOf.set('ch-Ann', 0); R.instances.get(0).channels.add('ch-Ann');
  R.instances.get(0).players = [{ name: 'Ann', dim: 0, x: -170, y: 70, z: 170 }];
  assert.deepEqual(mergesFor(R._view(), { mergeAt: 320, spawn }), [], 'r1 has only Tia, far away');
  // alone in r2: all of r2 goes, as before; r3, with nobody near the cell for 5 s (an entity's reach): all of r3 goes
  const r2 = region(2, ['Bob']); R.instances.set(2, r2);
  R.fromInstance(2, { __host: 'claim', id: 3, cells: ['0:-6:5'] });
  R.fromInstance(2, { __host: 'positions', players: [{ name: 'Bob', dim: 0, x: -170, y: 70, z: 175 }] });
  assert.ok(r2.merging, 'r2 goes into the main instance');
  const r3 = region(3, ['Cy', 'Di']); R.instances.set(3, r3);
  R.fromInstance(3, { __host: 'claim', id: 4, cells: ['0:-6:5'] });
  R.fromInstance(3, { __host: 'positions', players: [{ name: 'Cy', dim: 0, x: 3000, y: 70, z: 0 }, { name: 'Di', dim: 0, x: 3001, y: 70, z: 0 }] });
  assert.ok(r3.reached && !r3.merging);
  r3.reached.at -= 6000; await R._everySecond();
  assert.ok(r3.merging && !r3.reached, 'after 5 s r3 goes into the main instance');

  // a move from r1 to the main instance hides r1's "left the game" and tab-list removal, and the main instance's
  // "joined the game"; not a leave from the main instance (Bob left the game right after arriving), nor a join elsewhere
  const uuid = 'ab'.repeat(16), chat = (k) => rc.chatMessageFrame({ translate: `multiplayer.player.${k}`, with: [{ text: 'Bob' }] });
  R.listCache.set(uuid, { from: 0, frame: Buffer.alloc(0), name: 'Bob' });
  R.quiet.set('bob', { from: 1, to: 0, t0: Date.now(), until: Date.now() + 5000 });
  assert.equal(R._quietDrop(chat('left'), 1), true); assert.equal(R._quietDrop(rc.listRemoveFrame(uuid), 1), true); assert.equal(R._quietDrop(chat('joined'), 0), true);
  assert.equal(R._quietDrop(chat('left'), 0), false); assert.equal(R._quietDrop(rc.listRemoveFrame(uuid), 0), false); assert.equal(R._quietDrop(chat('joined'), 2), false);
  R.quiet.get('bob').until = Date.now() - 1;
  assert.equal(R._quietDrop(chat('joined'), 0), false, 'after the move\'s 5 s');
  // Bob leaves the game while the host is still finishing his move, and joins again at once: that join is shown
  R.quiet.set('bob', { from: 1, to: 0, t0: Date.now(), until: Date.now() + 5000 });
  R.sessions.set('ch-Bob', { name: 'Bob', move: { from: 1, to: 0, phase: 'done' } }); R.channelOf.set('ch-Bob', 0);
  R.close('ch-Bob');
  assert.equal(R._quietDrop(chat('joined'), 0), false, 'a join after leaving is shown');
});

test('regions: a player moving between instances misses no chat: what others say reaches them once there, and what they say is said there', () => {
  const { Regions } = require('../src/regions');
  const sent = [], toMain = [];
  const R = new Regions({ log() {}, viewDistance: 4, maxRegions: 2, lan: () => ({ fromWorker: (c, b) => sent.push([c, Buffer.from(b)]) }), boot: {},
    main: { ipc() {}, call: async () => ({}), toGame: (c, d) => toMain.push([c, Buffer.from(d)]), openChannel() {}, closeChannel() {}, reply() {} } });
  clearInterval(R._timer);
  R.instances.set(2, { id: 2, region: true, state: 'running', players: [], channels: new Set(['ch-Ann']), stats: [], merging: null, call: async () => ({}), toGame() {} });
  R.sessions.set('ch-Ann', { name: 'Ann' }); R.channelOf.set('ch-Ann', 2);
  // Bob leaves r1 for the main instance: Ann (r2) says something, Bob types something
  R.sessions.set('ch-Bob', { name: 'Bob', move: { from: 1, to: 0, phase: 'leaving', t0: Date.now(), said: [], held: [] } });
  const said = (t) => Buffer.concat([Buffer.from([0, 0x01, t.length]), Buffer.from(t)]);
  R.broadcast('~eaglan-bc/2', rc.chatMessageFrame({ text: 'hello from Ann' }));
  R.toGame('ch-Bob', said('hello from Bob'));
  assert.deepEqual(sent.map(([c]) => c), [], 'nothing to Bob while he moves'); assert.equal(toMain.length, 0, 'nor from him');
  // he arrives: the main instance's JoinGame becomes the second respawn, followed by Ann's line; his line goes to the main instance
  R.sessions.get('ch-Bob').move.phase = 'joining'; R.channelOf.set('ch-Bob', 0); R.instances.get(0).channels.add('ch-Bob');
  const joinGame = Buffer.concat([Buffer.from([0, 0x01, 0, 0, 0, 5, 1, 0, 2, 20, 7]), Buffer.from('default'), Buffer.from([0])]);
  const out = R.outgoing('ch-Bob', joinGame);
  assert.equal(out.length, 2); assert.equal(out[0][1], 0x07, 'the second respawn');
  assert.equal(rc.chatFrame(out[1]), JSON.stringify({ text: 'hello from Ann' }));
  assert.deepEqual(toMain.map(([c, d]) => [c, rc.clientChat(d)]), [['ch-Bob', 'hello from Bob']]);
});
