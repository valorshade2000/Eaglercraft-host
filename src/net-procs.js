'use strict';
// Network processes (config networkProcesses, 0 = off: the host's own thread has every connection, as before).
// Sending a WebRTC message costs ~24 us of the sending thread (node-datachannel frames, encrypts and sends it there),
// and node-datachannel works in only one thread per process. With many players watching many entities that is more
// than one thread can do (12 players x 1,000 moving entities: ~240,000 messages a second), and while the host's thread
// sends, its status, console and relays wait. With networkProcesses n, the players' connections live in n processes
// (net-proc.js), each player in one of them (the one with the fewest at its join), and the host's thread only passes
// the packets on, in batches: a player's packets keep their order (one path, in order, for each player), their bytes
// are the game's. Everything else stays in the host: relays, the join steps (lan-host.js Peer, which talks to the
// proxies below as it talks to node-datachannel's own objects), the game, status and console.
// If a network process ends, its players' connections fail (they can join again); a new process takes its place.
const { fork } = require('node:child_process');
const path = require('node:path');

class RemoteDataChannel {
  constructor(pc) { this.pc = pc; this.readyState = 'open'; this.binaryType = 'arraybuffer'; this.bufferedAmount = 0; this.onmessage = null; this.onclose = null; this.label = 'eaglan'; }
  send(buf) {
    if (this.readyState !== 'open') throw new Error('DataChannel is closed');
    this.pc.proc.queue(this.pc, [this.pc.id, buf]);
  }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.pc.proc.post({ op: 'dcClose', id: this.pc.id }); }
  _closed() { if (this.readyState === 'closed' && this._told) return; this.readyState = 'closed'; this._told = true; if (this.onclose) this.onclose({}); }
}

class RemotePeerConnection {
  constructor(proc, id, config) {
    this.proc = proc; this.id = id; this.connectionState = 'new'; this.localDescription = null; this._pair = null; this.dc = null;
    this.onicecandidate = null; this.ondatachannel = null; this.onconnectionstatechange = null;
    proc.post({ op: 'create', id, config });
  }
  setRemoteDescription(d) { return this.proc.call(this, 'setRemoteDescription', { type: d.type, sdp: d.sdp }); }
  createAnswer() { return this.proc.call(this, 'createAnswer', null); }
  setLocalDescription(d) { return this.proc.call(this, 'setLocalDescription', d ? { type: d.type, sdp: d.sdp } : undefined).then((l) => { this.localDescription = l; }); }
  addIceCandidate(c) { return this.proc.call(this, 'addIceCandidate', { candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex, sdpMid: c.sdpMid }); }
  getStats() {
    return this.proc.call(this, 'getStats', null).then((list) => {
      const m = new Map(); (list || []).forEach((s, i) => { if (s.type === 'eaglan-buffered') { if (this.dc) this.dc.bufferedAmount = s.amount; } else m.set(String(i), s); });
      return m;
    });
  }
  selectedCandidatePair() { return this._pair; }
  close() { if (this._closed) return; this._closed = true; this.proc.post({ op: 'close', id: this.id }); this.proc.forget(this); }
  _event(m) {
    switch (m.ev) {
      case 'ice': if (this.onicecandidate) this.onicecandidate({ candidate: m.c }); break;
      case 'state':
        if (m.pair) this._pair = m.pair;
        if (m.s !== this.connectionState) { this.connectionState = m.s; if (this.onconnectionstatechange) this.onconnectionstatechange({}); }
        break;
      case 'dc':
        if (m.pair) this._pair = m.pair;
        this.dc = new RemoteDataChannel(this);
        if (this.ondatachannel) this.ondatachannel({ channel: this.dc });
        break;
      case 'dcClose': if (this.dc) this.dc._closed(); break;
      case 'sendErr': this.proc.log(`player connection ${this.id}: send failed in network process ${this.proc.n}: ${m.m}`); if (this.dc) this.dc._closed(); break;
      default: break;
    }
  }
  _in(buf) { if (this.dc && this.dc.onmessage) this.dc.onmessage({ data: buf }); }
  _failed() { this.connectionState = 'failed'; if (this.onconnectionstatechange) this.onconnectionstatechange({}); if (this.dc) this.dc._closed(); }
}

class NetProc {
  constructor(owner, n) {
    this.owner = owner; this.n = n; this.pcs = new Map(); this.q = []; this.flushing = false; this.rq = 0; this.waits = new Map();
    this.stats = { sent: 0, bytes: 0, busyMs: 0, peers: 0 }; this.dead = false; this.started = Date.now();
    this.child = fork(path.join(__dirname, 'net-proc.js'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    this.child.on('message', (m) => this._message(m));
    this.child.on('exit', (code, sig) => this._exit(code, sig));
    this.child.on('error', (e) => this.log(`network process ${n}: ${e.message}`));
  }
  log(m) { this.owner.log(m); }
  post(m) { if (this.dead) return; try { this.child.send(m); } catch (e) { this.log(`network process ${this.n}: ${e.message}`); } }
  load() { return this.pcs.size; }
  add(config) { const id = ++this.owner.ids; const pc = new RemotePeerConnection(this, id, config); this.pcs.set(id, pc); return pc; }
  forget(pc) { this.pcs.delete(pc.id); }
  call(pc, fn, arg) {
    if (this.dead) return Promise.reject(new Error('the network process ended'));
    const rq = ++this.rq;
    return new Promise((resolve, reject) => { this.waits.set(rq, { resolve, reject }); this.post({ op: 'call', rq, id: pc.id, fn, arg }); });
  }
  // packets go out in one message per turn of the host's loop, in the order they were given
  queue(pc, item) { this.q.push(item); if (!this.flushing) { this.flushing = true; setImmediate(() => this.flush()); } }
  flush() { this.flushing = false; if (!this.q.length) return; const q = this.q; this.q = []; this.post({ op: 'out', q }); }
  _message(m) {
    if (m.rq !== undefined) { const w = this.waits.get(m.rq); if (w) { this.waits.delete(m.rq); if (m.err !== undefined) w.reject(new Error(m.err)); else w.resolve(m.v); } return; }
    if (m.ev === 'in') { for (const [id, buf] of m.q) { const pc = this.pcs.get(id); if (pc) pc._in(buf); } return; }
    if (m.ev === 'stats') { this.stats = { sent: m.sent, bytes: m.bytes, busyMs: m.busyMs, peers: m.peers }; return; }
    if (m.ev === 'ready') { this.pid = m.pid; return; }
    const pc = this.pcs.get(m.id); if (pc) pc._event(m);
  }
  _exit(code, sig) {
    this.dead = true;
    for (const w of this.waits.values()) w.reject(new Error('the network process ended'));
    this.waits.clear();
    const lost = [...this.pcs.values()]; this.pcs.clear();
    if (!this.owner.closing) this.log(`network process ${this.n} ended (${sig || 'exit code ' + code}); ${lost.length} player connection${lost.length === 1 ? '' : 's'} in it closed (they can join again)`);
    for (const pc of lost) pc._failed();
    this.owner._replace(this);
  }
}

class NetProcs {
  constructor({ count, log }) {
    this.count = count; this.log = log || (() => {}); this.ids = 0; this.closing = false; this.restarts = 0;
    this.procs = []; for (let i = 0; i < count; i++) this.procs.push(new NetProc(this, i + 1));
  }
  // a peer connection for a joining player, in the process with the fewest
  createPC(config) { let best = null; for (const p of this.procs) if (!p.dead && (!best || p.load() < best.load())) best = p; return best ? best.add(config) : null; }
  isRemote(pc) { return pc instanceof RemotePeerConnection; }
  // a packed batch of a player's packets (frame i ends at ix[i] in pack), after whatever was given before
  sendPacked(pc, pack, ix) { pc.proc.queue(pc, [pc.id, pack, ix]); }
  _replace(old) {
    if (this.closing) return;
    const i = this.procs.indexOf(old); if (i < 0) return;
    this.restarts++;
    setTimeout(() => { if (!this.closing && this.procs[i] === old) { this.procs[i] = new NetProc(this, old.n); this.log(`network process ${old.n} started again`); } }, Date.now() - old.started < 10000 ? 5000 : 500).unref?.();
  }
  status() { return { processes: this.procs.length, restarts: this.restarts, list: this.procs.map((p) => ({ n: p.n, pid: p.pid || null, dead: p.dead, peers: p.load(), sent: p.stats.sent, bytes: p.stats.bytes, busyMs: Math.round(p.stats.busyMs) })) }; }
  close() { this.closing = true; for (const p of this.procs) { try { p.flush(); p.child.disconnect(); } catch {} try { p.child.kill(); } catch {} } }
}

module.exports = { NetProcs, RemotePeerConnection };
