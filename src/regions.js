'use strict';
// Regions (config "regions", off by default; README "Regions"): groups of players far apart run on their own game
// instances, each a worker thread running the game itself, so that their ticks use separate cores. Inside an
// instance everything is the game's own simulation; instances are kept so far apart that nothing in one can reach
// another within a tick.
//
// - The main instance is the world as without regions: level.dat and the world's data files, the console (and the
//   spawn chunks, with the game rule loadSpawnChunks on). Region instances (up to the CPUs left over) are started for
//   players far from everyone else.
// - Chunks are owned per cell (2 x 2 chunks, region-cells.js) by one instance: a game thread asks here before it
//   reads a chunk of a cell it does not have, and gives cells back when it has saved and unloaded their chunks.
//   An instance that asks for a cell another one has is a mistake of the distances below; it is resolved by
//   moving its players into the other instance, never by two instances having one chunk.
// - Where a player joins: the instance that has the cell of the player's saved position, or that has players
//   within the merge distance, or a new region instance, or the main one.
// - Moving a player between instances (as a BungeeCord network moves a player between servers): the client gets a
//   respawn into another dimension, which clears its world ("Downloading terrain"); the old instance lets the player
//   go and saves them; it gives back the cells round them; the new instance gets the player's own login again and
//   gives them the same entity ID; its JoinGame becomes a second respawn, into the player's dimension; the client's
//   settings are sent again. "Left the game" / "joined the game" and the tab-list removal of that player are not
//   shown. If anything of it fails, the player is asked to join again (and then joins where they are).
// - Two groups of players of different instances within the merge distance: the smaller group moves to the other's
//   instance (of two the same size, the one in the main instance). A group far from everyone else for 20 s while its
//   instance has others: it moves to a region instance of its own, if one is left. A player moves at most every 30 s (except to resolve a
//   conflict of cells).
// - World-wide: chat and other broadcasts and the tab list (the game sends its broadcasts also to a channel of its
//   own, ~eaglan-bc/<instance>, which goes to the players of the other instances), world time and weather (from the
//   main instance, every second), game rules, OP list, LAN settings, multi-core mode; commands a player types about a
//   player of another instance (/tell, /tp, ...) and world-wide ones (_playerCommand); sleeping (the night is over when
//   every player of every instance sleeps); map ids (counted by the main instance); the scoreboard (_score); villages
//   and structures (merged when written, region-data.js).

const { CELL_SHIFT, cellKey, loginName, frameId, playerListFrame, playerPosFromFile, joinGameFrame, respawnFrame, chatFrame, clientChat, chatMessageFrame, listRemoveFrame } = require('./region-cells');

const ENTITY_ID_RANGE = 2 ** 26;   // entity IDs of instance k: k * 2^26 + 1, ... (the game counts from there)
const SPLIT_AFTER_MS = 20000, MOVE_EVERY_MS = 30000;

// Who has which cell. claim -> 'ok' or { owner }; release only by the owner.
class Ownership {
  constructor() { this.owner = new Map(); }
  claim(id, cell) { const o = this.owner.get(cell); if (o === undefined || o === id) { this.owner.set(cell, id); return 'ok'; } return { owner: o }; }
  release(id, cell) { if (this.owner.get(cell) === id) { this.owner.delete(cell); return true; } return false; }
  releaseAll(id) { const out = []; for (const [c, o] of this.owner) if (o === id) { this.owner.delete(c); out.push(c); } return out; }
  count(id) { let n = 0; for (const o of this.owner.values()) if (o === id) n++; return n; }
}

// How far round its players an instance asks for chunks, in chunks from a player's chunk: the view distance and 3 more
// (path searches, mob spawning; measured with view distance 4: up to 7, `reach` in the status; README "Regions").
const reachChunks = (viewDistance) => viewDistance + 3;
// Distance in blocks within which two players must be in one instance: on each side the farthest block their instance
// may ask for (the player's chunk and the reach round it, rounded out to whole cells), plus 32 blocks. Distances are the
// larger of the x and z distances, as the areas are squares. A group is moved off on its own only beyond 64 blocks more.
// View distance 4: 320 and 384 blocks.
const mergeBlocks = (viewDistance) => 2 * ((reachChunks(viewDistance) + 1) * 16 + ((1 << CELL_SHIFT) - 1) * 16) + 32;
const dist = (p, q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z));
const near = (p, q, d) => p.dim === q.dim && dist(p, q) < d;

// Near the world spawn ({ x, z } in the overworld; null: not known): the main instance's area. It reads the spawn's top
// block for every player who joins it and has the spawn chunks, so players there join it, a group there stays in it,
// and groups that meet there come into it.
const atSpawn = (p, spawn, d) => !!spawn && p.dim === 0 && dist(p, spawn) < d;

// Where a joining player goes. instances: [{ id, region, accepting, players: [{ dim, x, z }] }].
function placeFor(pos, instances, ownership, { mergeAt, maxRegions, spawn = null }) {
  if (!pos) return { id: 0 };
  const cell = cellKey(pos.dim, Math.floor(pos.x) >> 4, Math.floor(pos.z) >> 4);
  const owner = ownership.owner.get(cell);
  if (owner !== undefined && instances.some((i) => i.id === owner && i.accepting)) return { id: owner };
  if (atSpawn(pos, spawn, mergeAt)) return { id: 0 };
  let best = null;
  for (const i of instances) {
    if (!i.accepting) continue;
    for (const p of i.players) {
      if (p.dim !== pos.dim) continue;
      const d = dist(p, pos);
      if (d < mergeAt && (!best || d < best.d)) best = { id: i.id, d };
    }
  }
  if (best) return { id: best.id };
  const idle = instances.find((i) => i.region && i.accepting && !i.players.length && !i.channels);
  if (idle) return { id: idle.id };
  if (instances.filter((i) => i.region).length < maxRegions) return { start: true };
  return { id: 0 };
}

// The names of the players near cell `cell` (a cellKey), with the players within `d` of them (chained): the group to
// move when their instance reached that cell of another instance. Empty when nobody is within `d` of it.
function groupAt(players, cell, d) {
  const [dim, cx, cz] = cell.split(':').map(Number), size = 16 << CELL_SHIFT, at = { dim, x: cx * size + size / 2, z: cz * size + size / 2 };
  return groupsOf(players, d).filter((g) => g.some((p) => near(p, at, d))).flat().map((p) => p.name);
}

// The groups of an instance's players: players within `d` of each other (chained) are one group.
function groupsOf(players, d) {
  const left = players.slice(), out = [];
  while (left.length) {
    const g = [left.shift()];
    for (let k = 0; k < g.length; k++) for (let j = left.length - 1; j >= 0; j--) if (near(g[k], left[j], d)) g.push(left.splice(j, 1)[0]);
    out.push(g);
  }
  return out;
}

// Groups of different instances to bring together: [{ from, into, names }], the group of `from` goes into `into`: the
// smaller group moves; of two the same size, the one in the main instance (a region instance is there for its area), or
// of two region instances the one with fewer players. Near the world spawn the region instance's group comes into the
// main instance.
function mergesFor(instances, { mergeAt, spawn = null }) {
  const out = [], moving = new Set();
  for (let a = 0; a < instances.length; a++) for (let b = a + 1; b < instances.length; b++) {
    const A = instances[a], B = instances[b];
    if (!A.region && !B.region) continue;
    for (const ga of groupsOf(A.players, mergeAt)) for (const gb of groupsOf(B.players, mergeAt)) {
      if (!ga.some((p) => gb.some((q) => near(p, q, mergeAt)))) continue;
      const home = (!A.region || !B.region) && [...ga, ...gb].some((p) => atSpawn(p, spawn, mergeAt));
      const aGoes = home ? A.region : ga.length !== gb.length ? ga.length < gb.length : !A.region ? true : !B.region ? false : A.players.length <= B.players.length;
      const [from, into, g] = aGoes ? [A, B, ga] : [B, A, gb];
      if (g.some((p) => moving.has(p.name))) continue;
      g.forEach((p) => moving.add(p.name));
      out.push({ from: from.id, into: into.id, names: g.map((p) => p.name) });
    }
  }
  return out;
}

// Groups to move to a region instance of their own: [{ from, names }]: a group far (beyond `splitAt`) from every other
// player of every instance, while its instance has other players; the largest group of an instance stays (in the main
// instance, the group at the world spawn).
function splitsFor(instances, { mergeAt, splitAt, spawn = null }) {
  const all = instances.flatMap((i) => i.players.map((p) => ({ ...p, inst: i.id })));
  const out = [];
  for (const i of instances) {
    const gs = groupsOf(i.players, mergeAt);
    if (gs.length < 2) continue;
    const home = (g) => (!i.region && g.some((p) => atSpawn(p, spawn, mergeAt)) ? 1 : 0);
    gs.sort((x, y) => home(y) - home(x) || y.length - x.length);
    for (const g of gs.slice(1)) {
      const names = new Set(g.map((p) => p.name));
      const far = all.every((q) => names.has(q.name) || !g.some((p) => near(p, q, splitAt)));
      if (far) out.push({ from: i.id, names: [...names] });
    }
  }
  return out;
}

// What a console command concerns: { all } (world-wide: every instance, the main one answers), { all, selector } (with a
// selector of all players or entities: every instance, each answers for its own), { list }, { say } (say or me naming
// players with a bare @a, @p or @r: the host names them), { pick } (a bare @p or @r: the host picks the player), or
// { player } (the name of a player it is about; none: the main instance).
const WORLD_COMMANDS = new Set(['time', 'weather', 'gamerule', 'difficulty', 'toggledownfall', 'defaultgamemode', 'setworldspawn', 'worldborder', 'save-all', 'save-on', 'save-off']);
// A world-wide command: one of WORLD_COMMANDS, or a change of the scoreboard's objectives or teams (the scores follow by
// themselves: Regions._score), or enabling a trigger.
const worldWide = (w) => { const v = (w[0] || '').toLowerCase(), s = (w[1] || '').toLowerCase(); return WORLD_COMMANDS.has(v) || (v === 'scoreboard' && (s === 'objectives' || s === 'teams' || (s === 'players' && (w[2] || '').toLowerCase() === 'enable'))); };
// A selector of all players or entities with no argument about where (position, distance, volume, count): the same
// entities whichever instance runs it, so every instance runs it for its own.
const POSITIONAL = /[[,]\s*(x|y|z|r|rm|dx|dy|dz|c)\s*=/;
const worldSelector = (x) => /^@[ae](\[|$)/.test(x) && !POSITIONAL.test(x);
function commandScope(cmd) {
  const w = String(cmd).trim().replace(/^\//, '').split(/\s+/);
  const verb = (w[0] || '').toLowerCase();
  if (worldWide(w)) return { all: true };
  if (verb === 'list') return { list: true };
  if (verb === 'say' || verb === 'me') return w.slice(1).some((x) => x === '@a' || x === '@p' || x === '@r') ? { say: true } : { player: null };
  if (w.some((x) => /^@[ae](\[|$)/.test(x))) return { all: true, selector: true };
  if (w.some((x) => x === '@p' || x === '@r')) return { pick: w.includes('@p') ? '@p' : '@r' };
  const name = w[1] && /^[A-Za-z0-9_]{1,16}$/.test(w[1]) ? w[1] : null;
  return { player: name };
}
// Commands a player types with a selector that stay in the player's own instance: teleports (to a player of another
// instance: Regions._teleport), commands run relative to each entity found (execute), say and me (the game's own
// broadcast reaches every player), and whispers (they would come from the server instead of the player).
const OWN_INSTANCE = new Set(['tp', 'teleport', 'spreadplayers', 'execute', 'say', 'me', 'tell', 'msg', 'w']);
// Names as the game joins them in a message (CommandBase.join): "A", "A and B", "A, B and C".
const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
// The game's chat object as the console hands it over ({t} or {k, a}, siblings in s) as JSON for tellraw.
const chatJson = (o) => {
  if (!o || typeof o !== 'object') return { text: String(o ?? '') };
  const j = o.k !== undefined ? { translate: o.k, with: (o.a || []).map(chatJson) } : { text: o.t || '' };
  if (o.s && o.s.length) j.extra = o.s.map(chatJson);
  return j;
};
// A coordinate of a command typed by a player: as it is, or (~, ~n) relative to the player's own.
const coord = (s, base, floor) => { if (!String(s).startsWith('~')) return s; const v = base + (Number(String(s).slice(1)) || 0); return floor ? String(Math.floor(v)) : String(v); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A copy of a frame (the original's memory goes to a game thread, transferred, when it is passed on).
const copyOf = (d) => Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d);

class Regions {
  // env: { log(msg, src), lan(), main: { ipc(buf), call(fn, arg, ms), toGame(ch, data), openChannel(ch), closeChannel(ch), reply(m) },
  //   makeWorker(regionsData) -> Worker, enc, decode, IPC_CHANNEL, boot: { msg, locale(), startServer(), rules(), ops(), lan(), multiCore() },
  //   fromGame(m) (a player's packets from a region instance), zjob(m, worker), readPlayerFile(name) -> Buffer | null, maxRegions, viewDistance }
  constructor(env) {
    this.env = env; this.log = env.log;
    this.view = env.viewDistance || 4;
    this.mergeAt = mergeBlocks(this.view); this.splitAt = this.mergeAt + 64;
    this.maxRegions = env.maxRegions;
    this.own = new Ownership();
    this.instances = new Map();   // id -> instance
    this.pending = new Map();     // channel -> { queue, placing } before the player's instance is known
    this.channelOf = new Map();   // channel -> instance id
    this.sessions = new Map();    // channel -> { name, login, entityId, join, settings, brand, uuid, move, movedAt }
    this.held = [];               // claims waiting for another instance to give cells back
    this.listCache = new Map();   // player UUID -> { from: instance id, frame, name } (Player List Item "add" of every player)
    this.quiet = new Map();       // player name (lower case) -> { from, to, t0, until }: a move's leave and join not shown (_quietDrop)
    this.farSince = new Map();    // player name -> since when its group is far from everyone else
    this.spawn = null;            // the world spawn { dim, x, z }, from the main instance (_spawnFrom)
    this.busy = new Set();        // instance ids with a move in progress
    this.reach = { max: 0, counts: [] };   // how far from its players an instance asked for chunks (_countReach)
    this.scores = new Map(); this.scoreLog = [];   // the scores as last set (objective, name -> value); changes of the last two minutes
    this.nextId = 1; this.merges = 0; this.splits = 0; this.started = 0; this.kicked = 0; this.denied = 0;
    this.moves = { done: 0, failed: 0, ms: [], lastMs: null };
    const main = { id: 0, region: false, state: 'running', players: [], channels: new Set(), stats: [], ...env.main };
    this.instances.set(0, main);
    this._timer = setInterval(() => this._everySecond().catch((e) => this.log(`regions: ${e.stack || e}`)), 1000); this._timer.unref();
  }

  // ------------------------------------------------------------ players: the host's side of their channels
  open(ch) { this.pending.set(ch, { queue: [], placing: false }); }
  toGame(ch, data) {
    const p = this.pending.get(ch);
    if (p) { p.queue.push(data); if (!p.placing) { p.placing = true; this._place(ch, data).catch((e) => this.log(`regions: placing a player failed (${e.message}); the main instance takes the player`)); } return; }
    const s = this.sessions.get(ch);
    if (s) {
      const id = frameId(data);
      if (id === 0x15) s.settings = copyOf(data); else if (id === 0x17) s.brand = copyOf(data);   // client settings, MC|Brand: sent again after a move
      if (s.move && s.move.phase !== 'done') {   // moving: what the client sends now is for neither instance; what it says (chat, a command) is said once it is there (outgoing)
        if (id === 0x01 && s.move.said && s.move.said.length < 20) s.move.said.push(copyOf(data));
        return;
      }
      if (id === 0x01) { const text = clientChat(data); if (text && text[0] === '/' && this._playerCommand(ch, s, text)) return; }
    }
    const i = this.instances.get(this.channelOf.get(ch));
    if (i) i.toGame(ch, data);
  }
  close(ch) {
    if (this.pending.delete(ch)) return;
    const s = this.sessions.get(ch);
    const i = this.instances.get(this.channelOf.get(ch));
    if (i) { i.closeChannel(ch); i.channels.delete(ch); }
    this.channelOf.delete(ch); this.sessions.delete(ch);
    if (s) { this.farSince.delete(s.name); this.quiet.delete(s.name.toLowerCase()); }   // (gone, during a move too: a leave or join after it is the player's own)
    if (s && s.move) s.move.gone = true;
  }
  async _place(ch, first) {
    const name = loginName(first);
    let target = 0;
    const online = name && [...this.sessions].find(([c, x]) => x.name.toLowerCase() === name.toLowerCase() && this.channelOf.has(c));
    if (online) target = this.channelOf.get(online[0]);   // the same name again: where it is (the game ends the old session)
    else if (name) {
      let pos = null; try { const f = this.env.readPlayerFile(name); pos = f ? playerPosFromFile(f) : null; } catch {}
      if (!this.spawn) await this._readSpawn();
      const plan = placeFor(pos, this._view(), this.own, { mergeAt: this.mergeAt, maxRegions: this.maxRegions, spawn: this.spawn });
      if (plan.start) { const inst = await this._startRegion(); target = inst ? inst.id : 0; } else target = plan.id;
      if (target) this.log(`regions: ${name} joins region instance r${target} (saved at ${pos ? `${Math.round(pos.x)}, ${Math.round(pos.z)}` : '-'})`, 'lan');
    }
    const p = this.pending.get(ch); if (!p) return;   // the player left meanwhile
    let inst = this.instances.get(target);
    if (!inst || inst.state !== 'running' || inst.merging) inst = this.instances.get(0);
    this.pending.delete(ch);
    this.channelOf.set(ch, inst.id);
    this.sessions.set(ch, { name: name || ch, login: copyOf(first), entityId: null, join: null, settings: null, brand: null, uuid: null, move: null, movedAt: 0, needsList: true });
    inst.channels.add(ch);
    const lan = this.env.lan(); if (lan && name) lan.setPlayerName(ch, name);
    inst.openChannel(ch);
    for (const d of p.queue) inst.toGame(ch, d);
  }
  _view() {
    return [...this.instances.values()].filter((i) => i.state === 'running').map((i) => ({ id: i.id, region: i.region, accepting: !i.merging, players: this._here(i), channels: i.channels.size }));
  }
  // The players of instance `i` by its last report (every second), without those the host has since moved out of it or
  // that are moving (a report made before a move would show them in two instances, or in one they have left).
  _here(i) {
    const names = new Set([...i.channels].map((c) => this.sessions.get(c)).filter((s) => s && !s.move).map((s) => s.name.toLowerCase()));
    return (i.players || []).filter((p) => names.has(p.name.toLowerCase()));
  }
  _channelByName(name) { for (const [c, s] of this.sessions) if (s.name.toLowerCase() === String(name).toLowerCase()) return c; return null; }
  _running() { return [...this.instances.values()].filter((i) => i.state === 'running'); }
  // Every player with the position its instance last reported (every second), and that instance's id.
  _online() { return this._running().flatMap((i) => this._here(i).map((p) => ({ ...p, inst: i.id }))); }

  // ------------------------------------------------------------ commands across instances (README "Regions")
  // A command a player typed: done here when it concerns a player of another instance (true: not passed on), or passed
  // to the player's instance (false); a world-wide one of a player who may use commands also runs in the others.
  _playerCommand(ch, s, text) {
    const from = this.channelOf.get(ch), line = text.slice(1).trim(), args = line.split(/\s+/), verb = (args.shift() || '').toLowerCase();
    const at = (name) => { const c = /^[A-Za-z0-9_]{1,16}$/.test(name || '') && this._channelByName(name); return c ? { name: this.sessions.get(c).name, id: this.channelOf.get(c) } : null; };
    const elsewhere = (name) => { const t = at(name); return t && t.id !== from ? t : null; };
    if (verb === 'tell' || verb === 'msg' || verb === 'w') {   // a whisper to a player of another instance: shown to both, as the game does
      const t = args.length >= 2 && elsewhere(args[0]); if (!t) return false;
      const msg = line.replace(/^\S+\s+\S+\s+/, ''), say = (key, other) => ({ translate: key, with: [{ text: other }, { text: msg }], color: 'gray', italic: true });
      this._tell(t.name, say('commands.message.display.incoming', s.name)); this._tell(s.name, say('commands.message.display.outgoing', t.name));
      return true;
    }
    if (verb === 'list') { this.listLines().then((ls) => { for (const l of ls) this._tell(s.name, chatJson(l)); }); return true; }
    if (!this._mayCommand(s.name)) return false;   // the game tells the player they may not
    if (worldWide([verb, ...args]) && !args.some((x) => /^@[pr]/.test(x))) {   // also in the other instances (time and weather are the main instance's)
      const cmd = this._absolute(verb, args, this._online().find((p) => p.name.toLowerCase() === s.name.toLowerCase()));
      if (cmd) for (const i of this._running()) if (i.id !== from) this._run(i.id, cmd);
      return false;
    }
    // Selectors: in the player's own instance (as the player); one of all players or entities with nothing about where
    // (give @a, kill @e[type=Zombie], effect @a, tellraw @a, ...) also in the others, their answers to the player.
    const sels = args.filter((x) => x.startsWith('@'));
    if (sels.length) {
      if (!OWN_INSTANCE.has(verb) && sels.some((x) => /^@[ae]/.test(x)) && sels.every(worldSelector) && !args.some((x) => x.startsWith('~'))) {
        for (const i of this._running()) if (i.id !== from) this._run(i.id, line, s.name);
      }
      return false;
    }
    if (verb === 'tp') return this._teleport(from, s, args, at);
    // any other command about a player of another instance (give, effect, kill, gamemode, ...): run there
    const named = args.slice(0, 3).map(elsewhere).filter(Boolean);
    if (!named.length || named.some((t) => t.id !== named[0].id) || args.some((x) => x.startsWith('~'))) return false;
    this._run(named[0].id, line, s.name);
    return true;
  }
  // /tp to or from a player of another instance: to that player's coordinates, in the instance of the one who moves (the
  // two instances then become one, as for any player who reaches another instance's chunks).
  _teleport(from, s, args, at) {
    const pos = (name) => this._online().find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (args.length === 1 || args.length === 2) {
      const t = at(args.length === 1 ? s.name : args[0]), d = at(args[args.length - 1]); if (!t || !d) return false;
      if (t.id === d.id) { if (t.id === from) return false; this._run(t.id, `tp ${t.name} ${d.name}`, s.name); return true; }
      const tp = pos(t.name), dp = pos(d.name); if (!tp || !dp || tp.dim !== dp.dim) return false;
      this._run(t.id, `tp ${t.name} ${dp.x} ${dp.y} ${dp.z}`, s.name);
      return true;
    }
    if (args.length === 4 || args.length === 6) {   // a player of another instance and coordinates (relative ones: that player's)
      const t = at(args[0]); if (!t || t.id === from) return false;
      this._run(t.id, `tp ${args.join(' ')}`, s.name);
      return true;
    }
    return false;
  }
  // A world-wide command for the other instances: coordinates relative to the player who typed it made absolute.
  _absolute(verb, args, p) {
    if (verb === 'setworldspawn') {
      if (!p) return null;
      const a = args.length ? args : ['~', '~', '~'];
      return `setworldspawn ${coord(a[0], p.x, true)} ${coord(a[1], p.y, true)} ${coord(a[2], p.z, true)}`;
    }
    if (verb === 'worldborder' && (args[0] || '').toLowerCase() === 'center' && args.slice(1, 3).some((x) => x.startsWith('~'))) {
      return p ? `worldborder center ${coord(args[1], p.x)} ${coord(args[2], p.z)}` : null;
    }
    return [verb, ...args].join(' ');
  }
  _mayCommand(name) { return !!this.env.boot.lan().cheats || this.env.boot.ops().some((o) => o.toLowerCase() === String(name).toLowerCase()); }
  // A console command in instance `id` (the server runs it); what it answers goes to player `to` when given.
  _run(id, cmd, to) {
    const i = this.instances.get(id); if (!i || i.state !== 'running') return Promise.resolve(null);
    return i.call('console', cmd, 10000).then((r) => {
      if (r && r.error) this.log(`regions: "${cmd}" in ${id ? 'r' + id : 'the main instance'} failed: ${r.error}`);
      if (to) for (const o of (r && r.out) || []) this._tell(to, chatJson(o));
      return r;
    }, (e) => { this.log(`regions: "${cmd}" in ${id ? 'r' + id : 'the main instance'} failed: ${e.message}`); return null; });
  }
  // A chat message (JSON) to one player, in the instance the player is in now.
  _tell(name, json) { const c = this._channelByName(name); if (c && this.channelOf.has(c)) this._run(this.channelOf.get(c), `tellraw ${this.sessions.get(c).name} ${JSON.stringify(json)}`); }
  // /list for the whole world: the game's own lines ({k, a} / {t}, as the console hands them over), with the maximum of
  // the main instance.
  async listLines() {
    const names = [...this.sessions].filter(([c]) => this.channelOf.has(c)).map(([, x]) => x.name);
    if (this.listMax == null) { const r = await this._run(0, 'list'); const o = r && r.out && r.out[0]; this.listMax = (o && o.a && o.a[1] && (o.a[1].t ?? o.a[1])) || '?'; }
    return [{ k: 'commands.players.list', a: [{ t: String(names.length) }, { t: String(this.listMax) }] }, { t: names.join(', ') }];
  }

  // ------------------------------------------------------------ frames
  // A player's packets from instance `id` (before the multi-core pool): only from the instance the player is in.
  fromSource(id, ch) {
    if (typeof ch !== 'string' || ch.startsWith('~')) return true;
    const cur = this.channelOf.get(ch);
    return cur === undefined ? !this.sessions.has(ch) : cur === id;
  }
  // The game of instance `id` closed channel `ch`: false when the daemon should end the player's connection (not
  // during a move, when the old instance closes it on the host's word).
  onGameClosed(id, ch) {
    const s = this.sessions.get(ch);
    if (s && s.move && s.move.from === id) return true;
    const i = this.instances.get(id); if (i) i.channels.delete(ch);
    if (this.channelOf.get(ch) === id) { this.channelOf.delete(ch); this.sessions.delete(ch); }
    return false;
  }
  // What goes to a player instead of a frame from the game: null (the frame as it is) or a list of frames (none: dropped).
  // A packed batch of a player's packets may go on whole (daemon.js, network processes): nothing here needs to see its
  // frames now (no move under way, no names kept quiet, its JoinGame seen, no tab list to add).
  canPassPacked(ch) {
    const s = this.sessions.get(ch);
    return !this.quiet.size && !!s && !!s.join && !s.needsList && !(s.move && s.move.phase !== 'done');
  }
  outgoing(ch, buf) {
    const s = this.sessions.get(ch); if (!s) return null;
    if (this.quiet.size && this._quietDrop(buf, this.channelOf.get(ch))) return [];
    const id = frameId(buf);
    if (s.move && s.move.phase !== 'done') {
      if (s.move.phase !== 'joining') return [];   // late frames of the old instance
      if (id !== 0x01) return [];                  // the new instance's login answer, until its JoinGame
      const j = joinGameFrame(buf); if (j) s.join = { ...j, entityId: s.entityId };
      s.move.phase = 'done'; s.move.doneAt = Date.now();
      const to = this.instances.get(this.channelOf.get(ch));
      if (to) { if (s.settings) to.toGame(ch, copyOf(s.settings)); if (s.brand) to.toGame(ch, copyOf(s.brand)); }   // the client's settings, as after its first JoinGame
      for (const d of s.move.said || []) this.toGame(ch, d);   // what it said while moving
      // the second respawn, then the world-wide broadcasts it missed while moving (broadcast)
      return [respawnFrame(s.join ? s.join.dimension : 0, s.join || { difficulty: 2, gamemode: 0, levelType: 'default' }), ...(s.move.held || [])];
    }
    if (id === 0x01 && !s.join) {
      const j = joinGameFrame(buf); if (j) { s.join = j; s.entityId = j.entityId; }
      if (s.needsList) {   // right after its JoinGame, the players of the other instances for its tab list
        s.needsList = false;
        const here = this.channelOf.get(ch);
        return [buf, ...[...this.listCache.values()].filter((e) => e.from !== here).map((e) => Buffer.from(e.frame))];
      }
    }
    return null;
  }
  // A move (frame `buf` of instance `src`): "<name> left the game" and the tab-list removal of that player from the
  // instance they leave, and "joined the game" from the one they go to, are not shown. Only those: a player who leaves
  // the game right after a move is seen leaving.
  _quietDrop(buf, src) {
    const now = Date.now();
    for (const [n, q] of this.quiet) if (q.until < now) this.quiet.delete(n);
    const id = frameId(buf);
    if (id === 0x02) {
      const j = chatFrame(buf), m = j && /multiplayer\.player\.(left|joined)/.exec(j);
      if (m) for (const [n, q] of this.quiet) if ((m[1] === 'left' ? q.from : q.to) === src && j.toLowerCase().includes(`"${n}"`)) return true;
    } else if (id === 0x38) {
      const pl = playerListFrame(buf);
      if (pl && pl.action === 4) for (const u of pl.uuids) { const e = this.listCache.get(u), q = e && this.quiet.get(e.name.toLowerCase()); if (q && q.from === src) return true; }
    }
    return false;
  }
  // A broadcast of instance `id` (its frames on ~eaglan-bc/<id>) to the players of the other instances.
  broadcast(ch, buf) {
    const from = +String(ch).slice('~eaglan-bc/'.length);
    const pl = playerListFrame(buf);
    if (pl && pl.action === 0 && pl.count === 1 && pl.name) this.listCache.set(pl.uuids[0], { from, frame: Buffer.from(buf), name: pl.name });
    if (this.quiet.size && this._quietDrop(buf, from)) return;
    if (pl && pl.action === 4) for (const u of pl.uuids) this.listCache.delete(u);
    const lan = this.env.lan(); if (!lan) return;
    for (const [c, id] of this.channelOf) { const s = this.sessions.get(c); if (id !== from && s && (!s.move || s.move.phase === 'done')) lan.fromWorker(c, Buffer.from(buf)); }
    // a player moving between instances gets it once there (outgoing): the client shows chat and keeps its tab list all along
    for (const s of this.sessions.values()) if (s.move && s.move.phase !== 'done' && s.move.held && s.move.held.length < 500) s.move.held.push(Buffer.from(buf));
  }

  // ------------------------------------------------------------ cells
  // From any instance's worker (the main one through the daemon): claims, releases, positions.
  fromInstance(id, m) {
    const i = this.instances.get(id); if (!i) return false;
    if (m.__host === 'claim') { this._claim(i, m); return true; }
    if (m.__host === 'ask') { this._answer(i, m); return true; }
    if (m.__host === 'score') { this._score(i, m); return true; }
    if (m.__host === 'release') { for (const c of m.cells) this.own.release(id, c); this._grantHeld(); return true; }
    if (m.__host === 'positions') {
      // a player who jumped (teleported, moved here, respawned): what the instance asks for in the next 5 s is not counted in reach
      const was = new Map((i.players || []).map((p) => [p.name, p]));
      for (const p of m.players) { const q = was.get(p.name); if (!q || q.dim !== p.dim || Math.max(Math.abs(q.x - p.x), Math.abs(q.z - p.z)) > 48) i.jumpedAt = Date.now(); }
      if (was.size !== m.players.length) i.jumpedAt = Date.now();
      i.players = m.players; i.positionsAt = Date.now();
      if (i.reached && !this.busy.has(i.id) && !this.busy.has(i.reached.owner.id)) this._onReached(i);
      // what it asked for since the last positions, against these (a claim comes before the positions that explain it)
      const asked = i.asked || []; i.asked = [];
      const now = Date.now(), still = now - (i.jumpedAt || 0) > 5000 && !this.busy.has(i.id) && now - (i.movedInAt || 0) > 5000;
      if (still) for (const a of asked) this._countReach(i, a);
      return true;
    }
    return false;
  }
  // Scores (README "Regions"): a score that changes in one instance is set in every instance (also the one it came from,
  // so that two changes at once end the same everywhere), quietly, with no command; objectives and teams change only by
  // commands, which run in every instance. What an instance loads at its start is the world's file (not passed on).
  _score(i, m) {
    if (i.state !== 'running') return;
    const key = (o, n) => `${o}\n${n}`;
    if (m.op === 'set') { if (this.scores.get(key(m.obj, m.name)) === m.value) return; this.scores.set(key(m.obj, m.name), m.value); }
    else {   // a reset: only of a name with scores (an entity that dies resets its scores, mostly none)
      const had = [...this.scores.keys()].filter((k) => k.endsWith(`\n${m.name}`) && (m.obj == null || k === key(m.obj, m.name)));
      if (!had.length) return; for (const k of had) this.scores.delete(k);
    }
    const op = { op: m.op, name: m.name, obj: m.obj ?? null, value: m.value | 0 };
    this.scoreLog.push({ ...op, at: Date.now() }); while (this.scoreLog.length > 5000 || (this.scoreLog.length && Date.now() - this.scoreLog[0].at > 120000)) this.scoreLog.shift();
    for (const o of this._running()) o.call('score', op, 10000).catch(() => {});
  }
  // A region instance's question the game waits for: a new map's id, which the main instance counts (README "Regions").
  _answer(i, m) {
    const reply = (value) => i.reply({ __host: 'answer', id: m.id, value });
    if (m.what !== 'dataId') return reply(null);
    this.instances.get(0).call('dataId', { key: m.arg }, 30000).then((r) => {
      if (r && typeof r.status === 'number' && r.status >= 0) return reply(r.status);
      const id = 32000 + Math.floor(Math.random() * 700); this.log(`regions: the main instance gave no id for r${i.id}'s new ${m.arg} (${r && r.error}); it gets ${id}`); reply(id);
    });
  }
  _moving(from, to) { for (const s of this.sessions.values()) if (s.move && s.move.from === from && s.move.to === to) return true; return false; }
  _claim(i, m) {
    const results = {}; let waiting = 0;
    if (m.chunk) { (i.asked || (i.asked = [])).push(m); if (i.asked.length > 500) i.asked.shift(); }
    for (const c of m.cells) {
      const r = this.own.claim(i.id, c);
      if (r === 'ok') { results[c] = 'ok'; continue; }
      if (m.try) { results[c] = 'busy'; continue; }   // a try (the main instance's pre-generation): no wait, nobody moved
      const owner = this.instances.get(r.owner);
      // It gives the cell back soon: it stops, or players move from it to this instance.
      if (owner && (owner.merging || this._moving(owner.id, i.id))) { waiting++; this.held.push({ inst: i, cell: c, m, results, at: Date.now() }); continue; }
      if (!i.region) {   // the main instance waits; the players of the region instance that has the cell near it move into it
        waiting++; this.held.push({ inst: i, cell: c, m, results, at: Date.now() });
        if (owner && owner.region && !owner.merging && !owner.leaving) {
          const why = `the main instance needs its chunks (${c})`, names = groupAt(this._here(owner), c, this.mergeAt);
          if (names.length >= owner.channels.size) this._mergeAway(owner, i, why);
          else if (names.length) this._leave(owner, names, i, why);
          // (nobody near: the cell's chunks unload, and the held claim asks the owner to give it back)
        }
      } else {
        results[c] = 'deny'; this.denied++;
        const into = owner || this.instances.get(0);
        if (!i.merging && !i.reached && !i.leaving && !(Date.now() < (i.leftUntil || 0))) i.reached = { owner: into, cell: c, at: Date.now(), why: `it reached chunks of ${into.region ? 'r' + into.id : 'the main instance'} (${c})` };
      }
    }
    if (!waiting) i.reply({ __host: 'claimResult', id: m.id, results });
  }
  // Region instance `i` reached a cell of another instance (it got the empty chunk there), and its positions now say who
  // is near that cell (a player who has just teleported had not said it yet; one who respawns is in none of its lists
  // until the game has loaded the chunks round the spawn, so a report without anyone near is not the answer yet): those
  // players and the ones within the merge distance of them move into the instance that has the cell, and the others stay
  // (a player far from the world spawn who dies is not followed to it by the rest of the group). When that is all of
  // them, or after 5 s nobody is near it (an entity's reach; _everySecond), they all go, as before.
  _onReached(i) {
    const { owner, cell, why } = i.reached;
    const names = groupAt(this._here(i), cell, this.mergeAt);
    if (!names.length) return;
    i.reached = null;
    if (names.length >= i.channels.size || owner.state !== 'running' || owner.merging) return this._mergeAway(i, owner, why);
    this._leave(i, names, owner, why);
  }
  // Some players of region instance `inst` move into `into`; what it asks for of `into` meanwhile and for 5 s after (claims
  // made before they left) does not move the others.
  _leave(inst, names, into, why) {
    inst.leaving = true;
    this.moveGroup(names, inst, into, why).catch(() => {}).finally(() => { inst.leaving = false; inst.leftUntil = Date.now() + 5000; inst.reached = null; });
  }
  // Claims of `inst` still waiting are answered 'deny' (the empty chunk): it is going away, or waited too long.
  _denyHeld(inst) {
    for (const h of this.held.slice()) {
      if (h.inst !== inst) continue;
      h.results[h.cell] = 'deny'; this.held.splice(this.held.indexOf(h), 1); this.denied++;
      if (!this.held.some((x) => x.m === h.m)) h.inst.reply({ __host: 'claimResult', id: h.m.id, results: h.results });
    }
  }
  _grantHeld() {
    for (const h of this.held.slice()) {
      if (this.own.claim(h.inst.id, h.cell) !== 'ok') continue;
      h.results[h.cell] = 'ok'; this.held.splice(this.held.indexOf(h), 1);
      if (!this.held.some((x) => x.m === h.m)) h.inst.reply({ __host: 'claimResult', id: h.m.id, results: h.results });
    }
  }
  // How far from its players an instance asked for a chunk (the first of a cell it did not have): to the nearest player
  // of the instance, in chunks, the larger of the x and z distances; counted while its players stay put (README "Regions").
  _countReach(i, m) {
    const ch = m.chunk; let d = Infinity;
    for (const p of i.players || []) if (p.dim === ch.dim) d = Math.min(d, Math.max(Math.abs((Math.floor(p.x) >> 4) - ch.x), Math.abs((Math.floor(p.z) >> 4) - ch.z)));
    if (!Number.isFinite(d)) return;
    this.reach.counts[d] = (this.reach.counts[d] || 0) + 1; if (d > this.reach.max) this.reach.max = d;
  }
  // The cells an instance may have because of player p (its reach and a chunk more): handed over when p moves away.
  _cellsAround(p) {
    const out = new Set(), cx = Math.floor(p.x) >> 4, cz = Math.floor(p.z) >> 4, r = reachChunks(this.view) + 1;
    for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) out.add(cellKey(p.dim, x, z));
    return out;
  }

  // ------------------------------------------------------------ moving players between instances
  // Moves the players named (all in `from`) to `to`. Resolves with how many arrived.
  async moveGroup(names, from, to, why) {
    const chs = names.map((n) => this._channelByName(n)).filter((c) => c && this.channelOf.get(c) === from.id && this.sessions.get(c) && !this.sessions.get(c).move);
    if (!chs.length || from === to || to.state !== 'running') return 0;
    const t0 = Date.now(), lan = this.env.lan(), pos = new Map(from.players.map((p) => [p.name.toLowerCase(), p]));
    const ss = chs.map((c) => this.sessions.get(c));
    this.log(`regions: moving ${ss.map((s) => s.name).join(', ')} from ${from.region ? 'r' + from.id : 'the main instance'} to ${to.region ? 'r' + to.id : 'the main instance'} (${why})`);
    this.busy.add(from.id); this.busy.add(to.id);
    try {
      for (const [k, c] of chs.entries()) {
        const s = ss[k]; s.move = { from: from.id, to: to.id, phase: 'leaving', t0, said: [], held: [] }; s.movedAt = t0;
        this.quiet.set(s.name.toLowerCase(), { from: from.id, to: to.id, t0, until: t0 + 60000 });
        // the client clears its world and waits: a respawn into another dimension
        if (lan && s.join) lan.fromWorker(c, respawnFrame(s.join.dimension === -1 ? 0 : -1, s.join));
        from.channels.delete(c); this.channelOf.delete(c);
        from.closeChannel(c);
      }
      // the old instance has let them go (saved them), and their files are written
      const left = await this._until(async () => { const r = await from.call('players', {}, 5000); return r.status && !r.status.some((p) => names.some((n) => n.toLowerCase() === p.name.toLowerCase())); }, 10000);
      if (!left) throw new Error('the old instance did not let them go');
      await from.call('saveData', {}, 10000).catch(() => {});   // its maps (and the main instance's data files), for the next instance
      await from.call('flush', {}, 20000);
      // it gives back the cells round them (their chunks unload once nobody looks at them)
      const cells = new Set(); for (const s of ss) { const p = pos.get(s.name.toLowerCase()); if (p) for (const c of this._cellsAround(p)) cells.add(c); }
      const t1 = Date.now();
      if (!(await this._handOver(from, cells, 8000))) {   // the rest is handed over while the new instance asks for it (held claims)
        const kept = [...cells].filter((c) => this.own.owner.get(c) === from.id);
        this.log(`regions: ${from.region ? 'r' + from.id : 'the main instance'} still had ${kept.length} of the ${cells.size} cells round them after ${Date.now() - t1} ms (${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ', ...' : ''})`);
      }
      // the new instance takes them with their entity IDs; its JoinGame becomes the second respawn (outgoing)
      for (const [k, c] of chs.entries()) {
        const s = ss[k]; if (s.move.gone) continue;
        if (s.entityId != null) await to.call('playerId', { name: s.name, id: s.entityId });
        s.move.phase = 'joining';
        to.channels.add(c); this.channelOf.set(c, to.id);
        to.openChannel(c); to.toGame(c, copyOf(s.login));
      }
      await this._until(() => ss.every((s) => s.move.gone || s.move.phase === 'done'), 20000);
      to.movedInAt = Date.now(); from.movedInAt = Date.now();
      // the maps it has in memory again from their files: what the old instance drew is in them (merged, region-data.js)
      to.call('refreshMaps', {}, 20000).then((r) => { if (r && r.error) this.log('regions: reloading the maps of ' + (to.region ? 'r' + to.id : 'the main instance') + ' failed: ' + r.error); });
    } catch (e) { this.log(`regions: moving ${ss.map((s) => s.name).join(', ')} failed: ${e.message}`); }
    let arrived = 0;
    for (const [k, c] of chs.entries()) {
      const s = ss[k];
      if (s.move && s.move.phase === 'done') { arrived++; this.moves.done++; const ms = s.move.doneAt - t0; this.moves.ms.push(ms); if (this.moves.ms.length > 50) this.moves.ms.shift(); this.moves.lastMs = ms; }
      else if (!s.move || !s.move.gone) { this.moves.failed++; this.kicked++; if (lan) lan.serverClosedChannel(c, 'moving to another part of the world failed; join again'); this.close(c); }
      if (s.move) s.move = null;
      const q = this.quiet.get(s.name.toLowerCase()); if (q && q.t0 === t0) q.until = Date.now() + 5000;   // (the new instance's "joined the game" comes after its JoinGame)
    }
    this.busy.delete(from.id); this.busy.delete(to.id);
    // a cell of another instance that `from` reached (_onReached) is answered when a player near it has left (moved by
    // whichever rule); what it asks for of it in the next 5 s (claims made before) moves nobody else
    if (from.reached && ss.some((s) => { const p = pos.get(s.name.toLowerCase()); return p && groupAt([p], from.reached.cell, this.mergeAt).length; })) { from.reached = null; from.leftUntil = Date.now() + 5000; }
    this.log(`regions: ${arrived} of ${chs.length} moved in ${Date.now() - t0} ms`);
    return arrived;
  }
  async _handOver(from, cells, ms) {
    const mine = () => [...cells].filter((c) => this.own.owner.get(c) === from.id);
    if (!mine().length) return true;
    await from.call('dropCells', mine(), 5000);
    return this._until(async () => { await from.call('releaseNow', {}, 5000); return !mine().length; }, ms, 250);
  }
  async _until(fn, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return !!(await fn()); }

  // ------------------------------------------------------------ region instances
  async _startRegion() {
    const id = this.nextId++;
    await this.instances.get(0).call('saveData', {}, 10000).catch(() => {});   // it starts from the world's data files as they are now (scoreboard.dat)
    const startedAt = Date.now();
    const worker = this.env.makeWorker({ id, region: true, entityIdBase: id * ENTITY_ID_RANGE + 1, cellShift: CELL_SHIFT });
    const inst = new RegionInstance(id, worker, this);
    this.instances.set(id, inst); this.started++;
    this.log(`regions: starting region instance r${id} (${this.instances.size - 1} of up to ${this.maxRegions})`);
    try { await inst.boot(); }
    catch (e) { this.log(`regions: region instance r${id} did not start: ${e.message}`); await inst.stop('failed to start'); return null; }
    this.log(`regions: region instance r${id} is running`);
    for (const op of this.scoreLog) if (op.at >= startedAt) inst.call('score', op, 10000).catch(() => {});   // scores changed while it started
    return inst;
  }
  // Region instance `inst` goes into `into`: its players move there (or, failing that, are asked to join again); it
  // stops once it has none.
  _mergeAway(inst, into, why) {
    if (!inst || !inst.region || inst.merging) return;
    into = into && into.state === 'running' && !into.merging ? into : this.instances.get(0);
    inst.merging = { into: into.id, at: Date.now() }; this.merges++;
    this._denyHeld(inst);   // it must not wait for cells of others while its players move out (each could wait for the other)
    const names = [...inst.channels].map((c) => this.sessions.get(c)).filter(Boolean).map((s) => s.name);
    this.log(`regions: region instance r${inst.id} goes into ${into.region ? 'r' + into.id : 'the main instance'}: ${why}; its players (${names.join(', ') || 'none'}) move there`);
    if (names.length) this.moveGroup(names, inst, into, 'merge').catch(() => {});
  }
  async _everySecond() {
    const running = [...this.instances.values()].filter((i) => i.state === 'running');
    const now = Date.now(), view = this._view().filter((v) => !this.instances.get(v.id).merging);
    // Groups of different instances that came close: one goes into the other's instance.
    for (const m of mergesFor(view, { mergeAt: this.mergeAt, spawn: this.spawn })) {
      const from = this.instances.get(m.from), into = this.instances.get(m.into);
      if (this.busy.has(m.from) || this.busy.has(m.into)) continue;
      if (from.region && m.names.length === from.channels.size) this._mergeAway(from, into, `its players came within ${this.mergeAt} blocks of others`);
      else this.moveGroup(m.names, from, into, `within ${this.mergeAt} blocks of others`).catch(() => {});
    }
    // A group far from everyone else for 20 s: an instance of its own (not while players move, and only once every
    // instance has said where its players are: a group moved a moment ago would look far from everyone).
    const far = new Set();
    const settled = !this.busy.size && ![...this.sessions.values()].some((x) => x.move) && running.every((i) => i.positionsAt && now - i.positionsAt < 3000 && (!i.movedInAt || now - i.movedInAt > 5000));
    for (const sp of settled ? splitsFor(view, { mergeAt: this.mergeAt, splitAt: this.splitAt, spawn: this.spawn }) : []) {
      sp.names.forEach((n) => far.add(n));
      const since = Math.min(...sp.names.map((n) => this.farSince.get(n) || now));
      const recent = sp.names.some((n) => { const c = this._channelByName(n), s = c && this.sessions.get(c); return s && now - s.movedAt < MOVE_EVERY_MS; });
      if (now - since < SPLIT_AFTER_MS || recent || this.busy.has(sp.from)) continue;
      const from = this.instances.get(sp.from);
      let to = [...this.instances.values()].find((i) => i.region && i.state === 'running' && !i.merging && !i.channels.size && !this.busy.has(i.id));
      if (!to && this.instances.size - 1 >= this.maxRegions) continue;
      this.busy.add(sp.from);
      (async () => {
        try {
          if (!to) to = await this._startRegion();
          if (to) { this.splits++; await this.moveGroup(sp.names, from, to, `${this.splitAt} blocks or more from everyone else for ${SPLIT_AFTER_MS / 1000} s`); }
        } finally { this.busy.delete(sp.from); }
      })().catch(() => {});
    }
    // (while not settled the clocks go on: the next group far from everyone moves as soon as the last move is done)
    if (settled) for (const i of running) for (const p of i.players) { if (far.has(p.name)) { if (!this.farSince.has(p.name)) this.farSince.set(p.name, now); } else this.farSince.delete(p.name); }
    for (const i of running) {
      // A merged or idle region instance stops once its players are gone (an idle one after a minute).
      if (i.region && !i.channels.size && !this.busy.has(i.id) && (i.merging || now - i.lastPlayerAt > 60000)) i.stop(i.merging ? 'merged' : 'no players for a minute');
      if (i.channels.size) i.lastPlayerAt = now;
    }
    // A region instance waiting more than 5 s for a cell: the empty chunk, and it goes into the instance that has the cell.
    for (const h of this.held.slice()) if (h.inst.region && now - h.at > 5000 && this.held.includes(h)) {
      const owner = this.instances.get(this.own.owner.get(h.cell));
      this._mergeAway(h.inst, owner, `it waited 5 s for a cell of ${owner && owner.region ? 'r' + owner.id : 'the main instance'} (${h.cell})`);
      this._denyHeld(h.inst);
    }
    // The main instance waits for its cells (its game's thread with it): after 10 s the region instance that has the
    // cell goes into it (its players come to the main instance and it gives its cells back); after a minute (that went
    // wrong) it is stopped, which gives the cells back at once. Nothing else lets the main instance wait.
    for (const h of this.held.slice()) if (!h.inst.region && this.held.includes(h)) {
      const age = now - h.at, owner = this.instances.get(this.own.owner.get(h.cell));
      if (!owner || !owner.region) continue;
      if (age > 10000 && !h.escalated) {
        h.escalated = 1; this.log(`regions: the main instance has waited ${Math.round(age / 1000)} s for cell ${h.cell} of r${owner.id}`);
        if (!owner.merging) this._mergeAway(owner, h.inst, `the main instance waited for its cell ${h.cell}`);
      } else if (age > 60000 && h.escalated === 1) {
        h.escalated = 2; this.log(`regions: the main instance has waited a minute for cell ${h.cell}: r${owner.id} is stopped`);
        owner.stop('the main instance waited a minute for its cells').catch(() => {});
      }
    }
    // Claims held for a while: the instance that has the cell is asked to give back what it no longer uses.
    const owners = new Map();
    for (const h of this.held) if (now - h.at > 1000) { const o = this.own.owner.get(h.cell); if (o !== undefined) (owners.get(o) || owners.set(o, new Set()).get(o)).add(h.cell); }
    for (const [o, cells] of owners) { const inst = this.instances.get(o); if (inst && inst.state === 'running') inst.call('dropCells', [...cells], 3000).then(() => inst.call('releaseNow', {}, 3000)).catch(() => {}); }
    // Sleeping (README "Regions"): the night is over once every player in the overworld of every instance sleeps
    // (fully: 100 ticks in bed; a spectator keeps it from it), as the game decides for one world: the main instance sets
    // the morning, every instance wakes its players and ends rain. With the game rule playersSleepingPercentage (as the
    // main instance last reported it, game-patches.js "players sleeping percentage"): that share of the players who are
    // not spectators, at least one, as 1.17 counts.
    const over = this._online().filter((p) => p.dim === 0);
    const pct = this.sleepPct ?? null, active = over.filter((p) => !p.spec), deep = active.filter((p) => p.sleep === 2).length;
    const enough = pct === null ? over.length > 0 && over.every((p) => p.sleep === 2 && !p.spec) : active.length > 0 && deep >= Math.max(1, Math.ceil(active.length * pct / 100));
    if (enough && now - (this.sleptAt || 0) > 5000 && ![...this.sessions.values()].some((x) => x.move)) {
      this.sleptAt = now; this.log(pct === null ? `regions: every player sleeps (${over.length}): the night is over` : `regions: ${deep} of ${active.length} players sleep (playersSleepingPercentage ${pct}): the night is over`);
      for (const i of running) i.call('sleepSkip', { setTime: !i.region }, 5000).catch(() => {});
    }
    // World time and weather of the region instances follow the main instance's; the world spawn comes with them (every
    // 10 s while no region instance runs).
    if (running.some((i) => i.region) || now - (this.spawnAt || 0) > 10000) {
      this.instances.get(0).call('worldState', {}, 2000).then((r) => {
        if (!r || !r.status) return;
        this._spawnFrom(r.status); this.sleepPct = r.status.sleepPct ?? null;
        for (const i of running) if (i.region && i.state === 'running') i.call('setWorldState', r.status, 2000).catch(() => {});
      }, () => {});
    }
    // A region instance that reached a cell of another one and whose positions have not shown anyone near it for 5 s:
    // all of its players go (_onReached).
    for (const i of running) if (i.reached && now - i.reached.at > 5000) { const r = i.reached; i.reached = null; this._mergeAway(i, r.owner, r.why); }
  }
  _spawnFrom(st) { if (st && st.spawnX != null) { this.spawn = { dim: 0, x: st.spawnX, z: st.spawnZ }; this.spawnAt = Date.now(); } }
  async _readSpawn() { const r = await this.instances.get(0).call('worldState', {}, 2000).catch(() => null); this._spawnFrom(r && r.status); }
  forEachRegion(fn) { for (const i of this.instances.values()) if (i.region && i.state === 'running') fn(i); }

  // The instance a console command runs in: { all } (world-wide: every instance, the main one answers), { all, selector }
  // (every instance, each answers for its own entities), or one id (with the command to run there, when the host
  // changed it).
  commandTarget(cmd) {
    const s = commandScope(cmd), text = String(cmd).trim().replace(/^\//, '');
    if (s.all) return s.selector ? { all: true, selector: true } : { all: true };
    if (s.list) return { list: true };
    if (s.say) {   // say / me: the players of every instance named, as the game names them (the main instance says it)
      const names = this._names(), near = this._pick('@p'), any = this._pick('@r');
      const out = text.replace(/(^|\s)@([apr])(?=\s|$)/g, (m, sp, k) => sp + (k === 'a' ? (names.length ? joinNames(names) : m.trim()) : ((k === 'p' ? near : any) || { name: m.trim() }).name));
      return { id: 0, command: out };
    }
    if (s.pick) { const p = this._pick(s.pick); return p ? { id: p.inst, command: text.replace(/(^|\s)@[pr](?=\s|$)/, (m, sp) => sp + p.name) } : { id: 0 }; }
    if (s.player) { const c = this._channelByName(s.player); if (c) return { id: this.channelOf.get(c) ?? 0 }; }
    return { id: 0 };
  }
  // The players of every instance, in the order they joined (the game's @a lists an instance's players in that order).
  _names() { return [...this.sessions].filter(([c]) => this.channelOf.has(c)).map(([, x]) => x.name); }
  // @p for the console: the player nearest to the world's origin, where the console is; @r: any player.
  _pick(sel) {
    const ps = this._online().filter((p) => sel === '@r' || p.dim === 0);
    return sel === '@r' ? ps[Math.floor(Math.random() * ps.length)] : ps.sort((a, b) => (a.x ** 2 + a.y ** 2 + a.z ** 2) - (b.x ** 2 + b.y ** 2 + b.z ** 2))[0];
  }
  async saveAll() {
    await Promise.all([...this.instances.values()].filter((i) => i.region && i.state === 'running').map((i) => i.save().catch((e) => this.log(`regions: saving r${i.id} failed: ${e.message}`))));
  }
  async stopAll() { clearInterval(this._timer); await Promise.all([...this.instances.values()].filter((i) => i.region).map((i) => i.stop('the host stops'))); }
  windows(since) { const out = []; for (const i of this.instances.values()) if (i.region) for (const w of i.stats) if (w.t > since) out.push({ ...w, instance: i.id }); return out; }
  status() {
    const ms = this.moves.ms.slice().sort((a, b) => a - b);
    return {
      on: true, maxRegions: this.maxRegions, mergeBlocks: this.mergeAt, splitBlocks: this.splitAt, merges: this.merges, splits: this.splits, started: this.started, kicked: this.kicked, denied: this.denied,
      reach: { max: this.reach.max, counts: Array.from(this.reach.counts, (n) => n || 0) },
      moves: { done: this.moves.done, failed: this.moves.failed, lastMs: this.moves.lastMs, medianMs: ms.length ? ms[ms.length >> 1] : null, maxMs: ms.length ? ms[ms.length - 1] : null },
      instances: [...this.instances.values()].map((i) => ({ id: i.id, region: i.region, state: i.state, merging: i.merging || null, players: [...i.channels].map((c) => (this.sessions.get(c) || {}).name || c), cells: this.own.count(i.id),
        busy: i.region && i.stats.length ? i.stats[i.stats.length - 1].busy : null })),
    };
  }
}

// A region instance: its worker, the IPC to it, its replies, its game's messages.
class RegionInstance {
  constructor(id, worker, regions) {
    this.id = id; this.worker = worker; this.R = regions; this.env = regions.env; this.region = true;
    this.state = 'starting'; this.players = []; this.channels = new Set(); this.stats = []; this.lastPlayerAt = Date.now(); this.merging = null;
    this.acks = []; this.calls = new Map(); this.rulesWaiters = new Map(); this.seq = 0;
    worker.on('message', (m) => this._message(m));
    worker.on('error', (e) => { this.R.log(`regions: r${id} worker error: ${e && e.stack || e}`); this._gone(); });
    worker.on('exit', (c) => { if (this.state !== 'stopped') this.R.log(`regions: r${id} worker exited (${c})`); this._gone(); });
  }
  ipc(buf) { this.toGame(this.env.IPC_CHANNEL, buf); }
  toGame(ch, data) {
    const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.worker.postMessage({ ch, dat: ab }, [ab]);
  }
  openChannel(ch) { this.ipc(this.env.enc.playerChannel(ch, true)); }
  closeChannel(ch) { this.ipc(this.env.enc.playerChannel(ch, false)); }
  reply(m) { this.worker.postMessage(m); }
  call(fn, arg, ms = 20000) {
    return new Promise((resolve) => {
      if (this.state === 'stopped') { resolve({ error: `r${this.id} stopped` }); return; }
      const id = ++this.seq, w = { resolve };
      w.timer = setTimeout(() => { this.calls.delete(id); resolve({ error: `r${this.id} did not answer within ${ms / 1000} s` }); }, ms);
      this.calls.set(id, w); this.worker.postMessage({ __host: 'call', id, fn, arg });
    });
  }
  waitAck(ack, ms) {
    return new Promise((resolve, reject) => {
      const w = { ack, resolve, reject };
      w.timer = setTimeout(() => { this.acks.splice(this.acks.indexOf(w), 1); reject(new Error(`r${this.id}: no answer 0x${ack.toString(16)}`)); }, ms);
      this.acks.push(w);
    });
  }
  runRules(rules, set) {
    return new Promise((resolve) => {
      const id = ++this.seq; const timer = setTimeout(() => { this.rulesWaiters.delete(id); resolve({ error: 'no answer' }); }, 20000);
      this.rulesWaiters.set(id, { resolve, timer }); this.worker.postMessage({ __host: 'rules', id, rules, set });
    });
  }
  async boot() {
    const b = this.env.boot;
    this.worker.postMessage({ msg: b.msg });
    await this.waitAck(0xff, 60000);
    const lang = b.locale(); if (lang) this.ipc(this.env.enc.stringList(1, lang));
    this.ipc(this.env.enc.startServer(b.startServer()));
    await this.waitAck(0x00, 300000);
    const rules = b.rules(); if (rules) { const r = await this.runRules(rules.rules, rules.set); if (r.error) this.R.log(`regions: r${this.id} game rules: ${r.error}`); }
    const ops = await this.call('ops', b.ops()); if (ops.error) this.R.log(`regions: r${this.id} OP list: ${ops.error}`);
    this.ipc(this.env.enc.configureLAN({ ...b.lan(), iceServers: [] }));
    if (b.multiCore()) this.call('multicore', { on: true }).catch(() => {});
    this.state = 'running';
  }
  async save() { this.ipc(this.env.enc.autosave()); await this.waitAck(0x19, 60000); await this.call('flush', {}, 60000); }
  async stop(why) {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    const was = this.state; this.state = 'stopping';
    try {
      if (was === 'running') { this.ipc(this.env.enc.stopServer()); await this.waitAck(0x01, 60000); await this.call('flush', {}, 60000); }
    } catch (e) { this.R.log(`regions: r${this.id} did not stop cleanly: ${e.message}`); }
    try { await this.worker.terminate(); } catch {}
    this._gone();
    this.R.log(`regions: region instance r${this.id} stopped (${why})`);
  }
  // Its thread is gone: stopped, or ended on its own (a crash; nothing of it saved since its last save). Its cells are
  // free for the others (the world as last saved there), its claims still waiting are dropped, and its players are
  // disconnected with a message: they join again where they last were saved.
  _gone() {
    if (this.state === 'stopped') return;
    const unexpected = this.crashed || this.state !== 'stopping';
    this.state = 'stopped';
    const freed = this.R.own.releaseAll(this.id);
    this.R.held = this.R.held.filter((h) => h.inst !== this);
    this.R._grantHeld();
    const names = [];
    for (const c of this.channels) {
      const s = this.R.sessions.get(c); if (s) { names.push(s.name); this.R.farSince.delete(s.name); }
      const lan = this.env.lan(); if (lan) lan.serverClosedChannel(c, unexpected ? 'this part of the world stopped unexpectedly; join again' : 'its region instance stopped');
      this.R.channelOf.delete(c); this.R.sessions.delete(c);
    }
    if (unexpected) this.R.log(`regions: region instance r${this.id} ended unexpectedly${names.length ? `; its players (${names.join(', ')}) were disconnected and can join again (the world as last saved there)` : ''}`);
    // Players of it still in the others' tab lists (its game did not say they left: its thread ended) leave them, with
    // "left the game", as the game shows a player who goes.
    for (const [u, e] of [...this.R.listCache]) if (e.from === this.id) {
      this.R.broadcast(`~eaglan-bc/${this.id}`, listRemoveFrame(u));
      this.R.broadcast(`~eaglan-bc/${this.id}`, chatMessageFrame({ translate: 'multiplayer.player.left', with: [{ text: e.name }], color: 'yellow' }));
    }
    this.channels.clear(); this.players = [];
    for (const w of this.calls.values()) { clearTimeout(w.timer); w.resolve({ error: `r${this.id} stopped` }); } this.calls.clear();
    this.R.instances.delete(this.id);
    if (freed.length) this.R.log(`regions: r${this.id} gave back ${freed.length} cells`);
  }
  _message(m) {
    if (this.R.fromInstance(this.id, m)) return;
    if (m.__host === 'callResult') { const w = this.calls.get(m.id); if (w) { this.calls.delete(m.id); clearTimeout(w.timer); w.resolve(m); } return; }
    if (m.__host === 'callStart') return;
    if (m.__host === 'rulesResult') { const w = this.rulesWaiters.get(m.id); if (w) { this.rulesWaiters.delete(m.id); clearTimeout(w.timer); w.resolve(m); } return; }
    if (m.__host === 'stats') { this.stats.push(m); while (this.stats.length > 36) this.stats.shift(); return; }
    if (m.__host === 'zjob') { this.env.zjob(m, this.worker); return; }
    if (m.__host) { if (/^\[(err|worker uncaught|runtime)\]|IDB error/.test(m.msg || '')) this.R.log(`[r${this.id}] ${m.msg}`, 'runtime'); return; }
    if (m.dats || m.pack || m.ch !== this.env.IPC_CHANNEL) { if (this.R.fromSource(this.id, m.ch)) this.env.fromGame(m); return; }
    const p = this.env.decode(m.dat);
    switch (p.type) {
      case 'Logger': this.R.log(`[r${this.id}] ${p.message}`, 'server'); break;
      case 'PlayerChannel':
        if (!p.open && !this.R.onGameClosed(this.id, p.channel)) { const lan = this.env.lan(); if (lan) lan.serverClosedChannel(p.channel, null); }
        break;
      case 'KeepAlive': {
        const i = this.acks.findIndex((w) => w.ack === p.ack);
        if (i >= 0) { const w = this.acks.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(); }
        else if (p.ack === 0xfc || p.ack === 0x01) { if (this.state === 'running') { this.R.log(`regions: r${this.id} stopped on its own`); this._gone(); } }
        break;
      }
      case 'Crashed': this.R.log(`regions: r${this.id} CRASHED:\n${p.report}`, 'server'); this.crashed = true; this.stop('crashed'); break;
      default: break;
    }
  }
}

module.exports = { Regions, Ownership, placeFor, mergesFor, splitsFor, groupsOf, groupAt, mergeBlocks, commandScope, worldSelector, joinNames, ENTITY_ID_RANGE };
