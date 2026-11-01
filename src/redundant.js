'use strict';
// Opt-in "send small packets twice" for players on lossy routes (config `redundantSend`).
//
// Measured in test/netlab (README "Network performance"): on emulated China <-> Germany links a
// copy of each small datagram sent 10 ms later cut the delay of game messages to the player by
// 24-43 % in steady play, with no change on a clean link, for ~70 % more upload per player.
//
// The WebRTC library (libdatachannel/libjuice) owns its UDP sockets, so it cannot be asked to send
// a packet twice. Instead each player connection gets a small UDP relay in front of it:
//   - For every host candidate of the library on a public address, a "front" socket is opened on
//     the same address. The player is offered one extra candidate (same IP, the front port) with
//     the library candidate's priority; the library's own candidate is still offered, one step
//     lower, so the player falls back to it if the front port cannot be reached.
//   - Datagrams from the player are forwarded to the library once (one "back" socket per player
//     address, so the library sees an ordinary peer address).
//   - Datagrams from the library are forwarded to the player at once, and small DTLS
//     application-data records (game messages and SCTP acknowledgements) again COPY_GAP_MS later.
//     The player's WebRTC stack discards a copy when the original arrived, so a lost original
//     costs nothing if its copy gets through. STUN and DTLS handshake packets are never copied,
//     so the relay cannot be used to amplify traffic.
//   - Like the library's own connectivity checks, a zero-length datagram from each front port to
//     each address in the player's candidates opens the server firewall's connection tracking
//     for the player's replies (players ignore it).
//   - ICE connectivity checks (STUN) are corrected so that both sides rank the relay path first.
//     Behind the relay the library sees the relay's socket instead of the player: without the
//     correction its check replies would tell the player's browser that its own address is the
//     relay's (a "peer-reflexive" candidate, ranked below the browser's real address), and the
//     browser switched to the direct path within a second (seen with Chrome and the u53 client).
//     So the relay puts the player's real address into the library's replies, its own address
//     into the player's replies, and a top priority into the player's checks, and signs each
//     message again with the ICE password from the session descriptions (as the library would).
//     A check or reply whose signature does not match that password is dropped, not signed again.
//   - Port: by default each front socket gets a free port from the system. With a fixed port
//     (config redundantPort) every player shares one socket on that port (SharedPort below), so a
//     firewall or NAT port forwarding can be set up for it. Behind NAT (only private addresses on
//     the network interfaces) the fixed port is offered on the public address the library learned
//     from STUN; this needs the port forwarded to this server.
const dgram = require('node:dgram');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const COPY_GAP_MS = 10;
const COPY_MAX_BYTES = 400;
const MAX_PLAYER_ADDRESSES = 8;   // per front socket: addresses the player's checks may come from
const MAX_REMOTE_CANDIDATES = 16;
const DTLS_APPLICATION_DATA = 23;
const STUN_MAGIC = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001, STUN_BINDING_SUCCESS = 0x0101;
const ATTR_USERNAME = 0x0006, ATTR_XOR_MAPPED_ADDRESS = 0x0020, ATTR_PRIORITY = 0x0024, ATTR_MESSAGE_INTEGRITY = 0x0008,
  ATTR_MESSAGE_INTEGRITY_SHA256 = 0x001c, ATTR_FINGERPRINT = 0x8028;
const TOP_PRIORITY = 0x7effffff; // highest host-candidate priority (type 126, local preference 65535, component 1)
const SHARED_IDLE_CLOSE_MS = 5000;  // a fixed port is closed this long after its last player left

function isPublicIp(a) {
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168));
  }
  if (net.isIPv6(a)) {
    const s = a.toLowerCase();
    return !(s === '::' || s === '::1' || /^fe[89ab]/.test(s) || /^f[cd]/.test(s) || s.startsWith('ff') || s.startsWith('::ffff:'));
  }
  return false;
}

function ipBytes(address) {
  const a = String(address).split('%')[0];
  if (net.isIPv4(a)) return Buffer.from(a.split('.').map(Number));
  if (!net.isIPv6(a)) return null;
  const v4tail = (g) => { const l = g[g.length - 1]; if (l && l.includes('.')) { const b = l.split('.').map(Number); g.splice(-1, 1, ((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)); } return g; };
  const [h, t] = a.split('::');
  const head = v4tail(h ? h.split(':') : []), tail = t === undefined ? null : v4tail(t ? t.split(':') : []);
  const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

let crcTable = null;
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  if (!crcTable) { crcTable = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Changes a STUN Binding message (XOR-MAPPED-ADDRESS of a success response, or PRIORITY of a
// request) and recomputes MESSAGE-INTEGRITY (HMAC-SHA1, ICE short-term password) and FINGERPRINT.
// Returns the original buffer if the message is not one it can safely change.
function rewriteStun(buf, password, { mapped, priority } = {}) {
  if (!password || buf.length < 20 || buf.readUInt32BE(4) !== STUN_MAGIC || 20 + buf.readUInt16BE(2) !== buf.length) return buf;
  const type = buf.readUInt16BE(0);
  if (!((mapped && type === STUN_BINDING_SUCCESS) || (priority && type === STUN_BINDING_REQUEST))) return buf;
  const at = {};
  for (let off = 20; off + 4 <= buf.length;) {
    const t = buf.readUInt16BE(off), l = buf.readUInt16BE(off + 2);
    if (!(t in at)) at[t] = off;
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  const mi = at[ATTR_MESSAGE_INTEGRITY];
  if (mi === undefined || at[ATTR_MESSAGE_INTEGRITY_SHA256] !== undefined) return buf;
  const out = Buffer.from(buf);
  if (mapped) {
    const x = at[ATTR_XOR_MAPPED_ADDRESS], ab = ipBytes(mapped.address);
    if (x === undefined || x > mi || !ab || out[x + 5] !== (ab.length === 4 ? 1 : 2)) return buf;
    const key = out.subarray(4, 20); // magic cookie + transaction ID
    out.writeUInt16BE(mapped.port ^ (STUN_MAGIC >>> 16), x + 6);
    for (let i = 0; i < ab.length; i++) out[x + 8 + i] = ab[i] ^ key[i];
  }
  if (priority) {
    const pr = at[ATTR_PRIORITY];
    if (pr === undefined || pr > mi) return buf;
    out.writeUInt32BE(priority >>> 0, pr + 4);
  }
  const fullLength = out.readUInt16BE(2);
  out.writeUInt16BE(mi + 24 - 20, 2);
  crypto.createHmac('sha1', password).update(out.subarray(0, mi)).digest().copy(out, mi + 4);
  const fp = at[ATTR_FINGERPRINT];
  if (fp !== undefined && fp > mi) {
    out.writeUInt16BE(fp + 8 - 20, 2);
    out.writeUInt32BE((crc32(out.subarray(0, fp)) ^ 0x5354554e) >>> 0, fp + 4);
  }
  out.writeUInt16BE(fullLength, 2);
  return out;
}

// Offsets of a STUN message's attributes (the first of each type), or null if it is not STUN.
function stunAttrs(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== STUN_MAGIC || 20 + buf.readUInt16BE(2) !== buf.length) return null;
  const at = {};
  for (let off = 20; off + 4 <= buf.length;) {
    const t = buf.readUInt16BE(off), l = buf.readUInt16BE(off + 2);
    if (off + 4 + l > buf.length) return null;
    if (!(t in at)) at[t] = off;
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return at;
}

// Whether a STUN message carries a correct MESSAGE-INTEGRITY for the ICE password: true or false,
// or null when it cannot be checked here (no MESSAGE-INTEGRITY, or the password is not known yet).
function stunSigned(buf, password) {
  const at = stunAttrs(buf), mi = at && at[ATTR_MESSAGE_INTEGRITY];
  if (!password || mi === undefined || mi === null || buf.readUInt16BE(mi + 2) !== 20) return null;
  const c = Buffer.from(buf.subarray(0, mi)); c.writeUInt16BE(mi + 24 - 20, 2);
  return crypto.timingSafeEqual(crypto.createHmac('sha1', password).update(c).digest(), buf.subarray(mi + 4, mi + 24));
}

// USERNAME of an ICE check (STUN Binding request), "<recipient's ufrag>:<sender's ufrag>"; else null.
function stunUsername(buf) {
  const at = stunAttrs(buf), u = at && at[ATTR_USERNAME];
  if (u === undefined || u === null || buf.readUInt16BE(0) !== STUN_BINDING_REQUEST) return null;
  return buf.toString('utf8', u + 4, u + 4 + buf.readUInt16BE(u + 2));
}

// "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [...]"
function parseCandidate(str) {
  const f = String(str || '').trim().replace(/^a=/, '').split(/\s+/);
  if (f.length < 8 || !/^candidate:/.test(f[0]) || f[6] !== 'typ') return null;
  return { fields: f, foundation: f[0].slice(10), component: f[1], transport: f[2].toLowerCase(), priority: Number(f[3]), address: f[4], port: Number(f[5]), type: f[7] };
}

const familyOf = (address) => (net.isIPv6(address) ? 'udp6' : 'udp4');

// A fixed port (config redundantPort) open on one address, shared by every player connection that
// uses it. Datagrams are told apart by the address they come from. A new address is only accepted
// with an ICE check (STUN Binding request) whose USERNAME starts with the ICE user fragment of one
// of the connections and whose MESSAGE-INTEGRITY matches that connection's ICE password: a
// player's first datagram from any address is such a check. Everything else is dropped.
const sharedPorts = new Map();   // "<udp4|udp6>|<bind address>|<port>" -> SharedPort

class SharedPort {
  static get(type, address, port, idleCloseMs) {
    const key = `${type}|${address}|${port}`;
    let sp = sharedPorts.get(key);
    if (!sp || sp.closed) { sp = new SharedPort(key, type, address, port, idleCloseMs); sharedPorts.set(key, sp); }
    return sp;
  }

  constructor(key, type, address, port, idleCloseMs) {
    this.key = key; this.type = type; this.address = address; this.port = port; this.idleCloseMs = idleCloseMs;
    this.fronts = new Set();       // the fronts of the player connections on this port
    this.sources = new Map();      // "<address>|<port>" a player sends from -> that player's front
    this.ignored = 0; this.closed = false; this.error = null; this._idle = null;
    this.sock = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
    this.sock.on('message', (buf, rinfo) => this._dispatch(buf, rinfo));
    this.ready = new Promise((resolve) => {
      this.sock.once('error', (e) => { this.error = e; this.close(); resolve(null); });
      this.sock.bind(port, address, () => { this.sock.removeAllListeners('error'); this.sock.on('error', () => {}); resolve(this); });
    });
  }

  attach(front) { clearTimeout(this._idle); this._idle = null; this.fronts.add(front); try { this.sock.ref(); } catch {} }

  detach(front) {
    this.fronts.delete(front);
    for (const [src, f] of this.sources) if (f === front) this.sources.delete(src);
    if (!this.fronts.size && !this.closed && !this._idle) {
      try { this.sock.unref(); } catch {}  // an idle port does not keep the process running
      this._idle = setTimeout(() => { this._idle = null; if (!this.fronts.size) this.close(); }, this.idleCloseMs);
      this._idle.unref?.();
    }
  }

  _dispatch(buf, rinfo) {
    const src = rinfo.address + '|' + rinfo.port;
    let front = this.sources.get(src);
    if (!front) {
      const user = stunUsername(buf), ufrag = user && user.split(':')[0];
      if (ufrag) for (const f of this.fronts) if (f.owner.localUfrag === ufrag && stunSigned(buf, f.owner.localPwd) === true) { front = f; break; }
      if (!front || front.backs.size >= MAX_PLAYER_ADDRESSES) { this.ignored++; return; }
      this.sources.set(src, front);
    }
    front.owner._fromPlayer(front, buf, rinfo);
  }

  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this._idle);
    if (sharedPorts.get(this.key) === this) sharedPorts.delete(this.key);
    try { this.sock.close(); } catch {}
  }
}

const BIND_ERRORS = { EADDRINUSE: 'another program is using it', EACCES: 'permission denied', EADDRNOTAVAIL: 'the address is not available' };

class RedundantSender {
  constructor({ log = () => {}, copyGapMs = COPY_GAP_MS, copyMaxBytes = COPY_MAX_BYTES, allowPrivate = false, port = null, idleCloseMs = SHARED_IDLE_CLOSE_MS } = {}) {
    this.log = log; this.copyGapMs = copyGapMs; this.copyMaxBytes = copyMaxBytes; this.allowPrivate = allowPrivate;
    this.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;  // fixed port, or null: a free one per connection
    this.idleCloseMs = idleCloseMs;
    this.fronts = new Map();       // "<address>|<port>" of a library candidate -> front
    this.remotes = new Map();      // "<address>|<port>" of the player's candidates -> { address, port }
    this.stats = { fromPlayer: 0, toPlayer: 0, toPlayerBytes: 0, copies: 0, copyBytes: 0, ignored: 0, lastToPlayer: 0 };
    this.skippedPrivate = 0; this.sawSrflx = false;   // why no relay port could be offered (see unavailableReason)
    this.bindError = null;         // the fixed port could not be opened: { address, code }
    this.offered = false;          // an extra candidate was signaled to the player
    this.hosts = new Map();        // udp4/udp6 -> first host candidate of the library (its socket, for the NAT case)
    this.direct = new Set();       // udp4/udp6 with a host candidate the relay handles directly
    this.natFor = new Map();       // udp4/udp6 -> the server-reflexive candidate used for the NAT case
    this.kinds = {};               // first byte of datagrams to the player -> count (diagnostics)
    this.closed = false;
  }

  // Host candidates and the families handled directly; the NAT case needs them for srflx candidates.
  _note(c) {
    if (!c || c.transport !== 'udp' || c.component !== '1' || !net.isIP(c.address) || !(c.port > 0)) return;
    if (c.type === 'srflx') { this.sawSrflx = true; return; }
    if (c.type !== 'host') return;
    const fam = familyOf(c.address);
    if (this.allowPrivate || isPublicIp(c.address)) this.direct.add(fam);
    if (!this.hosts.has(fam) && !/^fe80:/i.test(c.address)) this.hosts.set(fam, { address: c.address, port: c.port });
  }

  // The candidate strings to signal for one library candidate: the extra front candidate first,
  // then the original one step lower. Candidates the relay does not handle come back unchanged.
  //   host candidate on a public address: the front listens on that address.
  //   server-reflexive candidate (behind NAT), only with a fixed port: the front listens on all
  //   addresses of the family and the extra candidate is the public address with the fixed port,
  //   which reaches this server only if that port is forwarded to it.
  async rewrite(candidate) {
    const c = parseCandidate(candidate);
    this._note(c);
    if (c && c.type === 'host' && c.transport === 'udp' && net.isIP(c.address) && !this.allowPrivate && !isPublicIp(c.address)) this.skippedPrivate++;
    if (this.closed || !c || c.transport !== 'udp' || c.component !== '1' || !net.isIP(c.address) || !(c.priority > 256) || !(c.port > 0) ||
        !(this.allowPrivate || isPublicIp(c.address))) return [candidate];
    let front = null;
    if (c.type === 'host') front = await this._front(c.address, c.port, c.address);
    else if (c.type === 'srflx' && this.port) {
      const fam = familyOf(c.address), base = this.hosts.get(fam), key = c.address + '|' + c.port;
      if (!this.natFor.has(fam)) this.natFor.set(fam, key);
      if (base && !this.direct.has(fam) && this.natFor.get(fam) === key) front = await this._front(base.address, base.port, fam === 'udp6' ? '::' : '0.0.0.0');
    }
    if (!front) return [candidate];
    this.offered = true;
    const prefix = /^a=/.test(String(candidate).trim()) ? 'a=' : '';
    const extra = c.fields.slice(); extra[0] = `candidate:${c.foundation}9`; extra[5] = String(front.port);
    const orig = c.fields.slice(); orig[3] = String(c.priority - 256);
    return [prefix + extra.join(' '), prefix + orig.join(' ')];
  }

  async rewriteList(list) {
    for (const item of list) this._note(parseCandidate(item.candidate));
    const out = [];
    for (const item of list) for (const s of await this.rewrite(item.candidate)) out.push({ ...item, candidate: s });
    return out;
  }

  async rewriteSdp(sdp) {
    const pwd = /^a=ice-pwd:(\S+)/m.exec(String(sdp)), ufrag = /^a=ice-ufrag:(\S+)/m.exec(String(sdp));
    if (pwd) this.localPwd = pwd[1];     // signs the library's checks and replies
    if (ufrag) this.localUfrag = ufrag[1]; // starts the USERNAME of the player's checks (fixed port)
    const lines = String(sdp).split(/\r\n|\n/);
    for (const line of lines) if (/^a=candidate:/.test(line)) this._note(parseCandidate(line));
    const out = [];
    for (const line of lines) {
      if (/^a=candidate:/.test(line)) out.push(...await this.rewrite(line));
      else out.push(line);
    }
    return out.join('\r\n');
  }

  // A candidate (or an SDP) from the player: remember its addresses for the firewall pinholes.
  addRemote(candidateOrSdp) {
    const pwd = /^a=ice-pwd:(\S+)/m.exec(String(candidateOrSdp || ''));
    if (pwd) this.remotePwd = pwd[1];  // signs the player's checks and replies
    for (const line of String(candidateOrSdp || '').split(/\r\n|\n/)) {
      const c = parseCandidate(line);
      if (!c || c.transport !== 'udp' || !net.isIP(c.address) || !(c.port > 0)) continue;
      const key = c.address + '|' + c.port;
      if (this.remotes.has(key) || this.remotes.size >= MAX_REMOTE_CANDIDATES) continue;
      this.remotes.set(key, { address: c.address, port: c.port });
      for (const f of this.fronts.values()) if (f.port) this._pinhole(f, c.address, c.port);
    }
  }

  // Why no relay port could be offered, once the candidates were seen (null if one was offered).
  unavailableReason() {
    if (this.fronts.size) return null;
    if (this.bindError) return `UDP port ${this.port} cannot be opened (${BIND_ERRORS[this.bindError.code] || this.bindError.code})`;
    if (!this.skippedPrivate) return null;
    if (this.sawSrflx) return this.port ? 'this server is behind NAT and STUN reported no public address for it'
      : 'this server is behind NAT (its network interfaces have only private addresses); a UDP port for send twice, forwarded to this server, makes it usable';
    return this.port ? 'this server has no public address on its network interfaces, and STUN reported none'
      : 'this server has no public address on its network interfaces';
  }

  // True if the library's selected remote address is one of this relay's back sockets.
  owns(address, port) {
    for (const f of this.fronts.values()) for (const b of f.backs.values()) if (b.port === port) return true;
    return false;
  }

  // 'IPv4' or 'IPv6': how the player reaches the relay, for the back socket the library talks to.
  playerFamily(port) {
    for (const f of this.fronts.values()) for (const b of f.backs.values()) if (b.port === port) return f.type === 'udp6' ? 'IPv6' : 'IPv4';
    return null;
  }

  snapshot() { return { ports: [...this.fronts.values()].map((f) => f.port).filter(Boolean), ...this.stats, kinds: { ...this.kinds } }; }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.fronts.values()) {
      if (f.shared) f.shared.detach(f); else if (!this.port) try { f.sock.close(); } catch {}
      for (const b of f.backs.values()) try { b.sock.close(); } catch {}
    }
  }

  // The socket the player talks to for one library candidate (target): a free port on bindAddress,
  // or the fixed port, shared with the other players.
  _front(address, port, bindAddress) {
    const key = address + '|' + port;
    const known = this.fronts.get(key);
    if (known) return known.ready;
    const type = familyOf(address);
    const front = { owner: this, type, target: { address, port }, backs: new Map(), port: 0, sock: null, shared: null };
    this.fronts.set(key, front);
    if (this.port) {
      const sp = SharedPort.get(type, bindAddress, this.port, this.idleCloseMs);
      sp.attach(front);
      front.ready = sp.ready.then((ok) => {
        if (!ok || this.closed) {
          sp.detach(front); this.fronts.delete(key);
          if (!ok) this.bindError = { address: bindAddress, code: (sp.error && (sp.error.code || sp.error.message)) || 'error' };
          return null;
        }
        front.sock = sp.sock; front.port = this.port; front.shared = sp;
        for (const r of this.remotes.values()) this._pinhole(front, r.address, r.port);
        return front;
      });
      return front.ready;
    }
    const sock = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
    front.sock = sock;
    front.ready = new Promise((resolve) => {
      sock.once('error', (e) => {
        this.log(`send twice: cannot open a port on ${address} (${e.code || e.message}); this address is used without it`);
        this.fronts.delete(key); try { sock.close(); } catch {} resolve(null);
      });
      sock.bind(0, bindAddress, () => {
        sock.removeAllListeners('error'); sock.on('error', () => {});
        front.port = sock.address().port;
        if (this.closed) { try { sock.close(); } catch {} resolve(null); return; }
        for (const r of this.remotes.values()) this._pinhole(front, r.address, r.port);
        resolve(front);
      });
    });
    sock.on('message', (buf, rinfo) => this._fromPlayer(front, buf, rinfo));
    return front.ready;
  }

  _fromPlayer(front, buf, rinfo) {
    if (this.closed) return;
    if (buf.length >= 20 && buf[0] < 2) { // STUN from the player: a check, or a reply to the library's check
      const request = buf.readUInt16BE(0) === STUN_BINDING_REQUEST, pwd = request ? this.localPwd : this.remotePwd;
      // Signed again below with the same password: a message the player did not sign is dropped.
      if (stunSigned(buf, pwd) === false) { this.stats.ignored++; return; }
      buf = request ? rewriteStun(buf, pwd, { priority: TOP_PRIORITY }) : rewriteStun(buf, pwd, { mapped: front.target });
    }
    const key = rinfo.address + '|' + rinfo.port;
    let back = front.backs.get(key);
    if (!back) {
      if (front.backs.size >= MAX_PLAYER_ADDRESSES) { this.stats.ignored++; return; }
      const sock = dgram.createSocket({ type: front.type, ipv6Only: front.type === 'udp6' });
      back = { sock, port: 0 };
      sock.on('error', () => {});
      sock.on('message', (b, ri) => { if (ri.port === front.target.port) this._toPlayer(front, b, rinfo); });
      sock.bind(0, front.target.address, () => { try { back.port = sock.address().port; } catch {} });
      front.backs.set(key, back);
    }
    this.stats.fromPlayer++;
    try { back.sock.send(buf, front.target.port, front.target.address); } catch {}
  }

  _toPlayer(front, buf, rinfo) {
    if (this.closed) return;
    this.stats.toPlayer++; this.stats.toPlayerBytes += buf.length; this.stats.lastToPlayer = Date.now();
    const k = buf.length ? buf[0] : -1; this.kinds[k] = (this.kinds[k] || 0) + 1;
    if (buf.length >= 20 && buf[0] < 2) buf = rewriteStun(buf, this.localPwd, { mapped: rinfo }); // the library's reply: the player's real address
    try { front.sock.send(buf, rinfo.port, rinfo.address); } catch {}
    // DTLS 1.2 application data (what Chrome and libdatachannel use today) or a DTLS 1.3 encrypted record.
    if (buf.length <= this.copyMaxBytes && (buf[0] === DTLS_APPLICATION_DATA || (buf[0] & 0xe0) === 0x20)) {
      this.stats.copies++; this.stats.copyBytes += buf.length;
      setTimeout(() => { if (!this.closed) try { front.sock.send(buf, rinfo.port, rinfo.address); } catch {} }, this.copyGapMs);
    }
  }

  _pinhole(front, address, port) {
    if ((front.type === 'udp6') !== net.isIPv6(address)) return;
    try { front.sock.send(Buffer.alloc(0), port, address); } catch {}
  }
}

module.exports = { RedundantSender, SharedPort, isPublicIp, parseCandidate, rewriteStun, stunSigned, stunUsername, ipBytes, COPY_GAP_MS, COPY_MAX_BYTES };
