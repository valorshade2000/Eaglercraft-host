'use strict';
// A protocol-level player for load tests: joins through a relay exactly like the u53 client
// (src/relay-client.js: relay signaling, then the "lan" WebRTC data channel), logs in with the
// Minecraft 1.8 login packet the client sends, answers keep-alives, confirms teleports and moves
// along a path by sending a position every tick (50 ms), as a client does. It does not render;
// the server does all the work it does for a real player (loading and generating chunks, sending
// them, tracking entities).
//
// Like the u53 client, it does not move into a chunk it has not received yet: a player cannot
// travel faster than the server delivers terrain, so a lagging server slows travellers down
// instead of letting them run ahead (the time spent waiting is reported as blockedMs).
//
// Frames on the data channel (IntegratedServerPlayerNetworkManager in u53): the first byte is the
// frame type. To the server: 0 = one whole packet. From the server: 0 = one whole packet,
// 1 = part of a large packet, 2 = its last part; a large packet is [4-byte length][zlib data].

const zlib = require('node:zlib');
const { joinViaRelay } = require('../../src/relay-client');

function varint(n) { const b = []; n >>>= 0; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); }
const str = (s) => { const u = Buffer.from(String(s), 'utf8'); return Buffer.concat([varint(u.length), u]); };
const dbl = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const flt = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const frame = (id, ...parts) => Buffer.concat([Buffer.from([0]), varint(id), ...parts]);

class Reader {
  constructor(b) { this.b = b; this.o = 0; }
  varint() { let r = 0, s = 0, x; do { x = this.b[this.o++]; r |= (x & 127) << s; s += 7; } while (x & 128 && s < 35); return r; }
  str() { const n = this.varint(); const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  dbl() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  flt() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  u8() { return this.b[this.o++]; }
  i64() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
}

// A point s blocks along a path, in world coordinates (x, z):
//   { kind: 'line', angle, speed }                    straight out from where the bot starts (a boat: ~8 blocks/s)
//   { kind: 'circle', cx, cz, radius, speed, phase }  round a circle (load tests teleport the bot to its start first)
//   { kind: 'still' }                                  stands where it is
function pathPos(p, s, from) {
  if (p.kind === 'line') return [from[0] + Math.cos(p.angle) * s, from[2] + Math.sin(p.angle) * s];
  if (p.kind === 'circle') { const a = (p.phase || 0) + s / p.radius; return [p.cx + p.radius * Math.cos(a), p.cz + p.radius * Math.sin(a)]; }
  return [from[0], from[2]];
}
const key = (cx, cz) => cx * 100000 + cz;

class Bot {
  constructor({ name, relayUrl, code, path = { kind: 'still' }, cruiseY = 170, log = () => {} }) {
    this.name = name; this.relayUrl = relayUrl; this.code = code; this.path = path; this.cruiseY = cruiseY; this.log = log;
    this.state = 'joining'; this.pos = null; this.spawn = null; this.moving = false; this.s = 0;
    this.chunks = new Set();   // chunks the server has sent and not unloaded
    this.stats = { joinMs: null, frames: 0, bytes: 0, chunkPackets: 0, keepAlives: 0, teleports: 0, teleportsWhileMoving: 0, deaths: 0, kicked: null, closed: false, distance: 0, blockedMs: 0, movingMs: 0, ids: {}, chat: [], listAdds: 0, time: null, raining: null, respawns: 0, moveMs: [] };   // moveMs: from a respawn to the next position (a move between instances)   // ids: packets received by id; chat: the last 50 messages (JSON)
    this.timer = null; this.conn = null; this._big = [];
    // Entities the server shows it (Spawn Object / Spawn Mob: id -> { kind: 'object' | 'mob', type, x, y, z }), its own
    // entity ID (Join Game), what it rides (Attach Entity, not a leash: the vehicle's ID or null) and the entities
    // leashed to it (Attach Entity with the leash flag).
    this.entities = new Map(); this.entityId = null; this.vehicle = null; this.leashed = new Set(); this.tab = new Map();
    this.ready = new Promise((resolve) => { this._ready = resolve; });
  }

  async join() {
    const t0 = Date.now();
    // The login packet the u53 client sends (C00PacketLoginStart): name, skin and cape (preset 0).
    const login = frame(0x00, str(this.name), varint(5), Buffer.from([1, 0, 0, 0, 0]), varint(5), Buffer.from([1, 0, 0, 0, 0]));
    this.conn = await joinViaRelay(this.relayUrl, this.code, { firstMessage: login, timeoutMs: 40000 });
    this.stats.joinMs = Date.now() - t0;
    this.state = 'login';
    const dc = this.conn.dc;
    dc.onmessage = (e) => this._onFrame(Buffer.from(e.data));
    dc.onclose = () => { this.stats.closed = true; if (this.state !== 'closed') { this.state = 'closed'; this.log(`${this.name}: data channel closed`); } this._stop(); };
    return this;
  }

  _send(buf) { try { this.conn.dc.send(buf); } catch {} }

  _onFrame(b) {
    this.stats.frames++; this.stats.bytes += b.length;
    if (b[0] === 1) { this._big.push(b.subarray(1)); return; }
    if (b[0] === 2) {
      const all = Buffer.concat([...this._big.splice(0), b.subarray(1)]);
      let pk; try { pk = zlib.inflateSync(all.subarray(4)); } catch { return; }
      return this._onPacket(pk);
    }
    if (b[0] === 0) this._onPacket(b.subarray(1));
  }

  _onPacket(pk) {
    const r = new Reader(pk), id = r.varint();
    if (this.state === 'login') {
      if (id === 0x02) this.state = 'play';
      else if (id === 0x00) { this.stats.kicked = r.str(); this.state = 'closed'; this.log(`${this.name}: refused at login: ${this.stats.kicked}`); this._ready(false); }
      return;
    }
    this.stats.ids[id] = (this.stats.ids[id] || 0) + 1;
    switch (id) {
      case 0x00: { const k = r.varint(); this.stats.keepAlives++; this._send(frame(0x00, varint(k))); break; }
      case 0x08: {   // Player Position And Look: take it, and confirm it by sending it back, as the client does
        let x = r.dbl(), y = r.dbl(), z = r.dbl(); const yaw = r.flt(), pitch = r.flt(), flags = r.u8();
        if (this.pos) { if (flags & 1) x += this.pos[0]; if (flags & 2) y += this.pos[1]; if (flags & 4) z += this.pos[2]; }
        this.pos = [x, y, z]; this.stats.teleports++;
        if (this._respawnAt) { this.stats.moveMs.push(Date.now() - this._respawnAt); this._respawnAt = null; }
        if (this.moving) { this.stats.teleportsWhileMoving++; this._rebase(); }
        this._send(frame(0x06, dbl(x), dbl(y), dbl(z), flt(yaw), flt(pitch), Buffer.from([0])));
        if (!this.spawn) {
          this.spawn = [x, y, z];
          this._send(frame(0x15, str('en_US'), Buffer.from([4, 0, 1, 127])));   // client settings, as the client sends them
          this._send(frame(0x17, str('MC|Brand'), str('eaglercraft')));
          this._idle();
          this._ready(true);
        }
        break;
      }
      case 0x21: {   // Chunk Data; ground-up with no sections = unload
        this.stats.chunkPackets++;
        const cx = r.i32(), cz = r.i32(), full = r.u8(), mask = r.u16();
        if (full && !mask) this.chunks.delete(key(cx, cz)); else this.chunks.add(key(cx, cz));
        break;
      }
      case 0x26: {   // Map Chunk Bulk
        this.stats.chunkPackets++;
        r.u8(); const n = r.varint();
        for (let i = 0; i < n; i++) { const cx = r.i32(), cz = r.i32(); r.u16(); this.chunks.add(key(cx, cz)); }
        break;
      }
      case 0x06: { const h = r.flt(); if (h <= 0) { this.stats.deaths++; this._send(frame(0x16, varint(0))); } break; }   // dead: respawn
      case 0x07: { this.stats.respawns++; this.chunks.clear(); this.entities.clear(); this.vehicle = null; this.leashed.clear(); if (!this._respawnAt) this._respawnAt = Date.now(); break; }   // Respawn: a new world (another dimension), its chunks and entities come again
      case 0x01: { this.entityId = r.i32(); break; }   // Join Game
      case 0x0e: { const eid = r.varint(), type = r.u8(), x = r.i32() / 32, y = r.i32() / 32, z = r.i32() / 32; this.entities.set(eid, { kind: 'object', type, x, y, z }); break; }   // Spawn Object (1 boat, 10 minecart, 2 item)
      case 0x0f: { const eid = r.varint(), type = r.u8(), x = r.i32() / 32, y = r.i32() / 32, z = r.i32() / 32; this.entities.set(eid, { kind: 'mob', type, x, y, z }); break; }   // Spawn Mob (90 pig, 92 cow, 100 horse)
      case 0x13: { for (let n = r.varint(); n > 0; n--) { const eid = r.varint(); this.entities.delete(eid); this.leashed.delete(eid); } break; }   // Destroy Entities
      case 0x1b: {   // Attach Entity: riding (leash 0) or a leash (1); vehicle -1: off
        const eid = r.i32(), veh = r.i32(), leash = r.u8();
        if (leash) { if (veh === this.entityId) this.leashed.add(eid); else this.leashed.delete(eid); }
        else if (eid === this.entityId) this.vehicle = veh === -1 ? null : veh;
        break;
      }
      case 0x02: { this.stats.chat.push(r.str()); if (this.stats.chat.length > 50) this.stats.chat.shift(); break; }   // Chat Message
      case 0x38: {   // Player List Item: the tab list (UUID -> name), 0 add, 4 remove (the other actions change an entry)
        const action = r.varint(), n = r.varint(); if (action === 0) this.stats.listAdds += n;
        for (let i = 0; i < n; i++) {
          const u = r.b.toString('hex', r.o, r.o + 16); r.o += 16;
          if (action === 4) { this.tab.delete(u); continue; }
          if (action !== 0) break;
          const name = r.str();
          for (let p = r.varint(); p > 0; p--) { r.str(); r.str(); if (r.u8()) r.str(); }   // properties (the skin): name, value, signature
          r.varint(); r.varint(); if (r.u8()) r.str();   // game mode, ping, display name
          this.tab.set(u, name);
        }
        break;
      }
      case 0x03: { r.i64(); this.stats.time = Number(r.i64()); break; }   // Time Update: world age, time of day
      case 0x2b: { const reason = r.u8(); if (reason === 1) this.stats.raining = true; if (reason === 2) this.stats.raining = false; break; }   // Change Game State: 1 rain begins, 2 it ends
      case 0x40: { this.stats.kicked = r.str(); this.log(`${this.name}: kicked: ${this.stats.kicked}`); this.state = 'closed'; this._stop(); break; }
      default: break;
    }
  }

  // Before go(): one packet per tick where it is, as a client standing still sends.
  _idle() {
    this._stop();
    this.timer = setInterval(() => { if (this.state === 'play') this._send(frame(0x03, Buffer.from([1]))); }, 50);
  }

  // A chat message, as the client sends it.
  say(text) { this._send(frame(0x01, str(text))); }
  // Right-click with what the player holds, at nothing (Player Block Placement, face 255): an empty map, food, a bow.
  useItem() { this._send(frame(0x08, Buffer.alloc(8, 0xff), Buffer.from([255, 0xff, 0xff, 0, 0, 0]))); }
  // Right click on an entity (Use Entity, interact): get into a boat or minecart, onto a saddled horse; with a lead in
  // hand, leash an animal. The server allows it within 6 blocks.
  useEntity(eid) { this._send(frame(0x02, varint(eid), varint(0))); }
  // Gets off what it rides, as the client does when the player sneaks: Steer Vehicle with the unmount flag, and sneaking
  // (Entity Action 0) for a moment (the game dismounts a sneaking rider in its next tick).
  sneak() {
    if (this.entityId == null) return;
    this._send(frame(0x0c, flt(0), flt(0), Buffer.from([2])));
    this._send(frame(0x0b, varint(this.entityId), varint(0), varint(0)));
    setTimeout(() => this._send(frame(0x0b, varint(this.entityId), varint(1), varint(0))), 300);
  }
  // The nearest entity of a kind and type the server showed it (e.g. ('object', 1) a boat), or null.
  nearest(kind, type) {
    let best = null, bd = Infinity; const [x, y, z] = this.pos || [0, 0, 0];
    for (const [id, e] of this.entities) if (e.kind === kind && e.type === type) { const d = (e.x - x) ** 2 + (e.y - y) ** 2 + (e.z - z) ** 2; if (d < bd) { bd = d; best = id; } }
    return best;
  }
  // Right-click on block (x, y, z) with the hand empty (Player Block Placement): a bed, a door, a lever.
  useBlock(x, y, z, face = 1) {
    const pos = Buffer.alloc(8); pos.writeBigUInt64BE((BigInt(x & 0x3ffffff) << 38n) | (BigInt(y & 0xfff) << 26n) | BigInt(z & 0x3ffffff));
    this._send(frame(0x08, pos, Buffer.from([face, 0xff, 0xff, 8, 8, 8])));
  }

  hasChunkAt(x, z) { return this.chunks.has(key(Math.floor(x) >> 4, Math.floor(z) >> 4)); }

  // Put back by the server: carry on along the path from where it put the bot.
  _rebase() {
    if (this.path.kind === 'circle') { this.path = { ...this.path, phase: Math.atan2(this.pos[2] - this.path.cz, this.pos[0] - this.path.cx) }; this.s = 0; }
    else if (this.path.kind === 'line') { this.from = this.pos.slice(); this.s = 0; }
  }

  // Follows the path at its speed, one position per tick, at the cruise height (above trees and
  // hills, so it is never blocked). It first rises there where it is. It waits wherever the next
  // step would enter a chunk it has not received.
  go() {
    if (this.path.kind === 'still' || !this.pos) return;
    this._stop();
    this.from = this.pos.slice(); this.s = 0;
    let last = Date.now();
    this.timer = setInterval(() => {
      if (this.state !== 'play') return;
      const now = Date.now(), dt = now - last; last = now;
      if (this.pos[1] < this.cruiseY) {
        const y = Math.min(this.cruiseY, this.pos[1] + 2);
        this.pos = [this.pos[0], y, this.pos[2]];
        this._send(frame(0x04, dbl(this.pos[0]), dbl(y), dbl(this.pos[2]), Buffer.from([0])));
        return;
      }
      this.moving = true;
      const ds = this.path.speed * 0.05;
      const [nx, nz] = pathPos(this.path, this.s + ds, this.from);
      if (this.hasChunkAt(nx, nz)) { this.s += ds; this.stats.distance += ds; this.stats.movingMs += dt; } else this.stats.blockedMs += dt;
      const [x, z] = pathPos(this.path, this.s, this.from);
      this.pos = [x, this.cruiseY, z];
      this._send(frame(0x04, dbl(x), dbl(this.cruiseY), dbl(z), Buffer.from([0])));
    }, 50);
  }

  // Walks (flies, at its cruising height) straight on from where it is at `speed` blocks/s towards `angle` (radians,
  // 0 = +x, PI/2 = +z), until stand().
  walk(angle, speed) { this.path = { kind: 'line', angle, speed }; this.go(); }
  // Stays where it is, as a bot that does not move.
  stand() { this._stop(); this.moving = false; this.path = { kind: 'still' }; this.timer = setInterval(() => { if (this.state === 'play') this._send(frame(0x03, Buffer.from([1]))); }, 50); }

  // Where the path starts (load tests teleport the bot there before go()).
  startPos() { return pathPos(this.path, 0, this.spawn || [0, 0, 0]); }

  _stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  close() { this._stop(); this.state = 'closed'; try { this.conn && this.conn.close(); } catch {} }
}

module.exports = { Bot, pathPos };
