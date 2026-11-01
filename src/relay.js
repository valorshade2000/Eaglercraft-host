'use strict';
// EaglercraftX relay protocol (relay version 1) + one managed host connection per relay.
//
// Wire format: one binary WebSocket frame = one packet: [id u8][fields...].
// Observed with the real u53 client (Chrome DevTools capture, see README):
//   host   -> relay  Handshake(type 1, v1, "<world name>;<hidden 0|1>")
//   relay  -> host   Handshake(type 1, v1, <join code>)   then ICEServers
//   client -> relay  Handshake(type 2, v1, <join code>)
//   relay  -> client Handshake(type 2, v1, <client id>)   then ICEServers
//   relay  -> host   NewClient(id) / Description(id, offer) / ICECandidate(id, ...) / ClientSuccess(id)
//   client -> relay  Description("", offer) / ICECandidate("", ...) / ClientSuccess("") | ClientFailure("")
//   world list query: Handshake(type 4, v1, "") -> LocalWorlds
// The join code is assigned by each relay; it cannot be chosen by the host, so every relay
// the world is registered on hands out its own code.

const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

const ascii = (s) => Buffer.from(String(s), 'latin1');

function writeASCII8(parts, s) {
  if (s == null) { parts.push(Buffer.from([0])); return; }
  const b = ascii(s); if (b.length > 255) throw new Error('ASCII8 too long');
  parts.push(Buffer.from([b.length]), b);
}
function writeBytes16(parts, b) {
  b = b == null ? Buffer.alloc(0) : Buffer.from(b);
  parts.push(Buffer.from([(b.length >>> 8) & 0xff, b.length & 0xff]), b);
}

const write = {
  handshake: (type, version, code) => { const p = [Buffer.from([0x00, type, version])]; writeASCII8(p, code); return Buffer.concat(p); },
  iceServers: (list) => {
    const p = [Buffer.from([0x01, (list.length >>> 8) & 0xff, list.length & 0xff])];
    for (const s of list) { p.push(Buffer.from([(s.username ? 'T' : 'S').charCodeAt(0)])); writeBytes16(p, ascii(s.address)); writeASCII8(p, s.username || null); writeASCII8(p, s.password || null); }
    return Buffer.concat(p);
  },
  newClient: (clientId) => { const p = [Buffer.from([0x02])]; writeASCII8(p, clientId); return Buffer.concat(p); },
  iceCandidate: (peerId, cand) => { const p = [Buffer.from([0x03])]; writeASCII8(p, peerId); writeBytes16(p, ascii(cand)); return Buffer.concat(p); },
  description: (peerId, desc) => { const p = [Buffer.from([0x04])]; writeASCII8(p, peerId); writeBytes16(p, ascii(desc)); return Buffer.concat(p); },
  clientSuccess: (clientId) => { const p = [Buffer.from([0x05])]; writeASCII8(p, clientId); return Buffer.concat(p); },
  clientFailure: (clientId) => { const p = [Buffer.from([0x06])]; writeASCII8(p, clientId); return Buffer.concat(p); },
  localWorlds: (worlds) => { const p = [Buffer.from([0x07, worlds.length & 0xff])]; for (const w of worlds) { writeASCII8(p, w.name); writeASCII8(p, w.code); } return Buffer.concat(p); },
  disconnectClient: (clientId, code, reason) => { const p = [Buffer.from([0xfe])]; writeASCII8(p, clientId); p.push(Buffer.from([code & 0xff])); writeBytes16(p, ascii(reason || '')); return Buffer.concat(p); },
  errorCode: (code, desc) => { const p = [Buffer.from([0xff, code & 0xff])]; writeBytes16(p, ascii(desc || '')); return Buffer.concat(p); },
};

function read(buf) {
  let o = 0;
  const u8 = () => { if (o >= buf.length) throw new Error('EOF'); return buf[o++]; };
  const asciiN = (n) => { if (o + n > buf.length) throw new Error('EOF'); const s = buf.subarray(o, o + n).toString('latin1'); o += n; return s; };
  const ascii8 = () => asciiN(u8());
  const ascii16 = () => { const n = (u8() << 8) | u8(); return asciiN(n); };
  const id = u8();
  switch (id) {
    case 0x00: return { id, type: 'Handshake', connectionType: u8(), connectionVersion: u8(), code: ascii8() };
    case 0x01: {
      const n = (u8() << 8) | u8(); const servers = [];
      for (let i = 0; i < n; i++) {
        const t = String.fromCharCode(u8());
        const address = ascii16(); const username = ascii8(); const password = ascii8();
        servers.push({ type: t === 'T' ? 'PASSWD' : 'NO_PASSWD', address, username, password });
      }
      return { id, type: 'ICEServers', servers };
    }
    case 0x02: return { id, type: 'NewClient', clientId: ascii8() };
    case 0x03: return { id, type: 'ICECandidate', peerId: ascii8(), candidate: ascii16() };
    case 0x04: return { id, type: 'Description', peerId: ascii8(), description: ascii16() };
    case 0x05: return { id, type: 'ClientSuccess', clientId: ascii8() };
    case 0x06: return { id, type: 'ClientFailure', clientId: ascii8() };
    case 0x07: { const n = u8(); const worlds = []; for (let i = 0; i < n; i++) worlds.push({ name: ascii8(), code: ascii8() }); return { id, type: 'LocalWorlds', worlds }; }
    case 0x69: return { id, type: 'Pong' };
    case 0x70: return { id, type: 'SpecialUpdate' };
    case 0xfe: { const clientId = ascii8(); const code = u8(); const reason = ascii16(); return { id, type: 'DisconnectClient', clientId, code, reason }; }
    case 0xff: { const code = u8(); const desc = ascii16(); return { id, type: 'ErrorCode', code, desc }; }
    default: return { id, type: 'Unknown' };
  }
}

// RelayPacketFFErrorCode codes (order confirmed from the u53 client's string table).
const ERROR_NAMES = ['INTERNAL_ERROR', 'PROTOCOL_VERSION', 'INVALID_PACKET', 'ILLEGAL_OPERATION', 'CODE_LENGTH', 'INCORRECT_CODE', 'SERVER_DISCONNECTED', 'UNKNOWN_CLIENT'];
const errorName = (c) => ERROR_NAMES[c] || 'ERROR_' + c;

// Same string as RelayServer.getICEString(): "url" or "url;user;pass".
const iceString = (s) => (s.type === 'PASSWD' || s.username ? `${s.address};${s.username};${s.password}` : s.address);

// ------------------------------------------------------------------ configuration
const MAX_RELAYS = 16;

// Normalises a relay list (array or newline-separated text). Ignores blank lines and '#'
// comments, rejects anything that is not a ws:// or wss:// URL, removes duplicates
// (case-insensitive host, default port, trailing slash) and caps the list length.
function normalizeRelays(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const relays = [], warnings = [], seen = new Set();
  for (const raw of lines) {
    const line = String(raw ?? '').replace(/#.*$/, '').trim();
    if (!line) continue;
    let u;
    try { u = new URL(line); } catch { warnings.push(`ignored "${line}": not a valid URL`); continue; }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') { warnings.push(`ignored "${line}": relays must use wss:// (or ws://)`); continue; }
    if (u.username || u.password) { warnings.push(`ignored "${line}": credentials in relay URLs are not supported`); continue; }
    u.hash = '';
    const norm = u.toString(); // lower-cases host, drops default port, adds "/" path
    const key = norm.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) { warnings.push(`ignored duplicate relay ${line}`); continue; }
    if (relays.length >= MAX_RELAYS) { warnings.push(`ignored ${line}: at most ${MAX_RELAYS} relays are used`); continue; }
    seen.add(key); relays.push(norm);
  }
  return { relays, warnings };
}

const shortName = (url) => { try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname : ''); } catch { return url; } };

// ------------------------------------------------------------------ one relay connection
const STATE = {
  DISCONNECTED: 'disconnected', CONNECTING: 'connecting', HANDSHAKING: 'handshaking', ACTIVE: 'active',
  BACKOFF: 'backoff', INCOMPATIBLE: 'incompatible', STOPPED: 'stopped',
};

const DEFAULTS = {
  connectTimeoutMs: 8000,       // TCP + TLS + HTTP upgrade
  handshakeTimeoutMs: 8000,     // our Handshake -> relay's Handshake (join code)
  iceTimeoutMs: 5000,           // join code -> ICEServers (the browser host allows 2.5s)
  backoffBaseMs: 5000,          // first retry 2.5-5s, then doubling ...
  backoffMaxMs: 300000,         // ... up to 2.5-5 min between attempts
  rateLimitMinMs: 60000,        // HTTP 429 / repeated drops: wait at least this long
  incompatibleRetryMs: 30 * 60000, // re-check an incompatible relay twice an hour
  stableAfterMs: 60000,         // an active period this long resets the failure count
  heartbeatMs: 30000,           // WebSocket ping (transport keepalive; not a relay packet)
  heartbeatTimeoutMs: 75000,    // declare the socket dead only after 75s without any pong, so a
                                // short network blip does not needlessly change the join code
  maxPayload: 256 * 1024,
};

class RelayLink extends EventEmitter {
  // opts: { worldName, hidden, log, tag, timings }
  constructor(url, opts) {
    super();
    this.url = url; this.name = shortName(url); this.tag = opts.tag || this.name;
    this.worldName = opts.worldName; this.hidden = !!opts.hidden;
    this.t = { ...DEFAULTS, ...(opts.timings || {}) };
    this._log = opts.log || (() => {});
    this.state = STATE.DISCONNECTED;
    this.code = null; this.iceServers = []; this.ws = null; this.gen = 0;
    this.failures = 0; this.attempts = 0; this.lastError = null; this.lastErrorAt = null;
    this.nextRetryAt = null; this.activeSince = null; this.lastActiveAt = null; this.registrations = 0;
    // A registration after a lost connection always gets a new code (relays never give one back):
    // lostCode is the code that was lost, previousCode / codeChangedAt the last change.
    this.lostCode = null; this.previousCode = null; this.codeChangedAt = null;
    this._timers = new Set(); this._repeat = { reason: null, count: 0 };
    this.on('error', () => {}); // never let an EventEmitter 'error' crash the host
  }

  log(m) { this._log(`Relay [${this.name}] ${m}`); }

  snapshot() {
    return {
      url: this.url, name: this.name, state: this.state, code: this.state === STATE.ACTIVE ? this.code : null,
      iceServers: this.iceServers.length, turn: this.iceServers.some((s) => /^turns?:/i.test(s)),
      lastError: this.lastError, lastErrorAt: this.lastErrorAt, failures: this.failures, attempts: this.attempts,
      nextRetryAt: this.nextRetryAt, activeSince: this.activeSince, registrations: this.registrations,
      previousCode: this.previousCode, codeChangedAt: this.codeChangedAt,
    };
  }

  isActive() { return this.state === STATE.ACTIVE && this.ws && this.ws.readyState === WebSocket.OPEN; }

  send(buf) {
    if (!this.isActive()) return false;
    try { this.ws.send(buf); return true; } catch (e) { this.log('send failed: ' + e.message); return false; }
  }

  start() {
    if (this.state === STATE.STOPPED) return;
    if ([STATE.CONNECTING, STATE.HANDSHAKING, STATE.ACTIVE].includes(this.state)) return; // one socket per relay
    this._clearTimers();
    this._attempt();
  }

  // Terminal: cancels timers, closes the socket. Safe to call repeatedly.
  stop() {
    if (this.state === STATE.STOPPED) return;
    const wasActive = this.state === STATE.ACTIVE;
    this._clearTimers();
    this._dropSocket(1000);
    this._setState(STATE.STOPPED);
    this.code = null; this.nextRetryAt = null;
    if (wasActive) this.emit('down', { reason: 'stopped', wasActive });
  }

  // Test / debug helper: simulate an abrupt connection loss.
  dropConnection() { if (this.ws) this.ws.terminate(); }

  _setState(s) { if (this.state !== s) { const prev = this.state; this.state = s; this.emit('state', s, prev); } }

  _timer(fn, ms) {
    const h = setTimeout(() => { this._timers.delete(h); fn(); }, ms);
    if (h.unref) h.unref();
    this._timers.add(h); return h;
  }
  _clearTimers() { for (const h of this._timers) clearTimeout(h); this._timers.clear(); if (this._hb) { clearInterval(this._hb); this._hb = null; } }

  _dropSocket(code) {
    const ws = this.ws; this.ws = null;
    if (!ws) return;
    ws.removeAllListeners(); // incl. 'error': a dead socket must not report (or overwrite) failures
    ws.on('error', () => {}); // ... but late errors from it must not throw either
    try { if (code && ws.readyState === WebSocket.OPEN) { ws.close(code); setTimeout(() => { try { ws.terminate(); } catch {} }, 2000).unref(); } else ws.terminate(); } catch {}
  }

  _attempt() {
    const gen = ++this.gen;
    this.attempts++; this.code = null; this.nextRetryAt = null;
    this._setState(STATE.CONNECTING);
    const mine = () => gen === this.gen && this.state !== STATE.STOPPED;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: this.t.connectTimeoutMs, maxPayload: this.t.maxPayload, perMessageDeflate: false });
    } catch (e) { return this._fail(gen, 'invalid', 'cannot open WebSocket: ' + e.message); }
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    ws.on('error', (e) => { if (mine()) this._fail(gen, classifyNetError(e), describeNetError(e)); });
    ws.on('unexpected-response', (req, res) => {
      const sc = res.statusCode;
      try { res.destroy(); req.destroy(); } catch {}
      if (!mine()) return;
      if (sc === 429) this._fail(gen, 'ratelimit', `HTTP 429 (rate limited)`);
      else if (sc >= 500 || sc === 408) this._fail(gen, 'transient', `HTTP ${sc} from relay`);
      else this._fail(gen, 'incompatible', `HTTP ${sc} instead of a WebSocket upgrade${sc === 403 ? ' (relay refused this client)' : ''}`);
    });
    // Whole-attempt deadline: connect + handshake + ICE list.
    const deadline = this._timer(() => { if (mine()) this._fail(gen, 'transient', `timed out while ${this.state}`); },
      this.t.connectTimeoutMs + this.t.handshakeTimeoutMs + this.t.iceTimeoutMs);
    ws.on('open', () => {
      if (!mine()) return;
      this._setState(STATE.HANDSHAKING);
      let name = String(this.worldName || 'World');
      if (name.length > 252) name = name.slice(0, 252); // as GuiShareToLan does
      try { ws.send(write.handshake(1, 1, `${name};${this.hidden ? 1 : 0}`)); } catch (e) { this._fail(gen, 'transient', 'send failed: ' + e.message); }
    });
    ws.on('close', (c, r) => {
      if (!mine()) return;
      if (this.state === STATE.ACTIVE) this._down(gen, `connection closed (${c}${r && r.length ? ' ' + r : ''})`);
      else this._fail(gen, 'transient', `closed during ${this.state} (${c}${r && r.length ? ' ' + r : ''})`);
    });
    ws.on('message', (data, isBinary) => {
      if (!mine()) return;
      if (!isBinary) {
        if (this.state !== STATE.ACTIVE) return this._fail(gen, 'incompatible', 'relay sent text data instead of the relay protocol');
        return;
      }
      let p;
      try { p = read(data); } catch (e) {
        if (this.state !== STATE.ACTIVE) return this._fail(gen, 'incompatible', 'malformed relay packet: ' + e.message);
        return this._noteRepeat('malformed packet ignored: ' + e.message);
      }
      if (p.type === 'SpecialUpdate') return;
      if (this.state === STATE.ACTIVE) { this.emit('packet', p); return; }
      if (this.code == null) {
        if (p.type === 'Handshake') {
          if (!p.code || !/^[\x21-\x7e]{1,64}$/.test(p.code)) return this._fail(gen, 'incompatible', 'relay returned an invalid join code');
          if (p.connectionVersion !== 1) return this._fail(gen, 'incompatible', `relay speaks protocol v${p.connectionVersion}, not v1 (u53)`);
          this.code = p.code;
          this._timer(() => { if (mine() && this.state !== STATE.ACTIVE) this._fail(gen, 'transient', 'relay sent no ICE server list'); }, this.t.iceTimeoutMs);
          return;
        }
        if (p.type === 'ErrorCode') {
          const kind = p.code === 1 ? 'incompatible' : 'transient';
          return this._fail(gen, kind, `relay error ${errorName(p.code)}${p.desc ? ': ' + p.desc : ''}`);
        }
        return this._fail(gen, 'incompatible', `unexpected ${p.type} packet during handshake`);
      }
      if (p.type === 'ICEServers') {
        clearTimeout(deadline); this._timers.delete(deadline);
        this.iceServers = p.servers.map(iceString);
        this._becomeActive(gen);
        return;
      }
      if (p.type === 'ErrorCode') return this._fail(gen, p.code === 1 ? 'incompatible' : 'transient', `relay error ${errorName(p.code)}${p.desc ? ': ' + p.desc : ''}`);
      return this._fail(gen, 'incompatible', `unexpected ${p.type} packet instead of ICE servers`);
    });
  }

  _becomeActive(gen) {
    for (const h of this._timers) clearTimeout(h); this._timers.clear();
    this.activeSince = Date.now(); this.lastActiveAt = this.activeSince; this.registrations++;
    const recovered = this.failures > 0 ? ` (recovered after ${this.failures} failed attempt${this.failures > 1 ? 's' : ''})` : '';
    this._repeat = { reason: null, count: 0 };
    if (this.lostCode && this.lostCode !== this.code) { this.previousCode = this.lostCode; this.codeChangedAt = this.activeSince; }
    this.lostCode = null;
    const replaced = this.codeChangedAt === this.activeSince ? ` (new: ${this.previousCode} no longer works)` : '';
    this._setState(STATE.ACTIVE);
    const turn = this.iceServers.some((s) => /^turns?:/i.test(s));
    this.log(`ACTIVE, join code ${this.code}${replaced} (${this.iceServers.length} ICE servers${turn ? ', TURN available' : ', no TURN'})${recovered}`);
    // Transport keepalive: detects half-open sockets. Only enforced once the relay has
    // answered a ping, so relays that don't implement pong are never dropped for it.
    const ws = this.ws; let pongSeen = false, waiting = null;
    ws.on('pong', () => { pongSeen = true; if (waiting) { clearTimeout(waiting); waiting = null; } });
    this._hb = setInterval(() => {
      if (gen !== this.gen || ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch {}
      if (pongSeen && !waiting) {
        waiting = setTimeout(() => { waiting = null; if (gen === this.gen && this.state === STATE.ACTIVE) { this.log(`no heartbeat reply for ${this.t.heartbeatTimeoutMs / 1000}s`); ws.terminate(); } }, this.t.heartbeatTimeoutMs);
        if (waiting.unref) waiting.unref();
      }
    }, this.t.heartbeatMs);
    if (this._hb.unref) this._hb.unref();
    this.emit('active', { code: this.code, iceServers: this.iceServers, previousCode: replaced ? this.previousCode : null });
  }

  _down(gen, reason) {
    const lived = Date.now() - (this.activeSince || Date.now());
    this.activeSince = null;
    this._clearTimers();
    this._dropSocket();
    this.lastError = reason; this.lastErrorAt = Date.now();
    // A long, healthy session means this is an isolated drop: retry quickly.
    if (lived >= this.t.stableAfterMs) this.failures = 0;
    this.failures++;
    const code = this.code; this.code = null; if (code) this.lostCode = code;
    this.emit('down', { reason, wasActive: true, code });
    const delay = lived < 5000 ? Math.max(this._backoff(), this.t.rateLimitMinMs / 4) : this._backoff();
    this._schedule(delay, `lost (${reason}); join code ${code} is no longer valid`, `lost (${reason})`);
  }

  _fail(gen, kind, reason) {
    if (gen !== this.gen || this.state === STATE.STOPPED) return;
    if (this.state === STATE.ACTIVE) return this._down(gen, reason);
    this._clearTimers();
    this._dropSocket();
    this.code = null;
    this.lastError = reason; this.lastErrorAt = Date.now();
    if (kind === 'incompatible' || kind === 'invalid') {
      this.failures++;
      this._setState(STATE.INCOMPATIBLE);
      if (kind === 'invalid') { this.log(`unusable: ${reason}`); return; }
      this.nextRetryAt = Date.now() + this.t.incompatibleRetryMs;
      this.log(`INCOMPATIBLE: ${reason}; re-checking in ${Math.round(this.t.incompatibleRetryMs / 60000)} min`);
      this._timer(() => { if (this.state === STATE.INCOMPATIBLE) this._attempt(); }, this.t.incompatibleRetryMs);
      return;
    }
    this.failures++;
    let delay = this._backoff();
    if (kind === 'ratelimit') delay = Math.max(delay, this.t.rateLimitMinMs);
    this._schedule(delay, `failed: ${reason}`);
  }

  _backoff() {
    const exp = Math.min(this.t.backoffMaxMs, this.t.backoffBaseMs * 2 ** Math.max(0, this.failures - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
  }

  _schedule(delay, what, key = what) {
    this._setState(STATE.BACKOFF);
    this.nextRetryAt = Date.now() + delay;
    this._noteRepeat(`${what}; retry ${this.failures} in ${Math.round(delay / 1000)}s`, key);
    this._timer(() => { if (this.state === STATE.BACKOFF) this._attempt(); }, delay);
  }

  // Logs repeated identical failures sparsely (1st, 2nd, 3rd, then every 10th).
  _noteRepeat(line, key = line) {
    const k = key.replace(/\d+/g, '#');
    if (this._repeat.reason === k) this._repeat.count++; else this._repeat = { reason: k, count: 1 };
    const n = this._repeat.count;
    if (n <= 3 || n % 10 === 0) this.log(n > 3 ? `${line} (same error x${n})` : line);
  }
}

function classifyNetError(e) {
  const msg = String(e && e.message || e);
  if (/Invalid URL|Invalid WebSocket frame|Unexpected server response: 4\d\d/.test(msg)) return 'incompatible';
  if (/Unexpected server response: 429/.test(msg)) return 'ratelimit';
  return 'transient';
}
function describeNetError(e) {
  const code = e && e.code ? e.code + ' ' : '';
  return (code + String(e && e.message || e)).replace(/\s+/g, ' ').slice(0, 200);
}

module.exports = { read, write, iceString, normalizeRelays, shortName, RelayLink, STATE, DEFAULTS, ERROR_NAMES, errorName, MAX_RELAYS };
