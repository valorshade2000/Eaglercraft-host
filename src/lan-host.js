'use strict';
// Headless port of the host side of EaglercraftX u53 World LAN, extended to keep the
// world registered on several relays at the same time:
//   LANServerController.updateLANServer()      -> LANHost._onRelayPacket()   (one per relay)
//   LANClientPeer (handshake state machine)     -> Peer
//   TeaVM PlatformWebRTC.LANServer / LANPeer    -> Peer._pc / data channel handling
//
// Every relay connection (RelayLink, see relay.js) is an independent host registration
// with its own join code, but all of them feed the SAME peer table and the SAME integrated
// server: there is one world, one player list and one authoritative state. A peer only
// needs its relay for the signaling handshake; once its WebRTC data channel is up it no
// longer depends on the relay, so a relay failure never disconnects connected players.
// The relay signaling, SDP exchange and data channel payloads are what the browser host sends.

const { RTCPeerConnection } = require('node-datachannel/polyfill');
const relay = require('./relay');
const { RedundantSender } = require('./redundant');
// Debug (EAGLAN_DEBUG_NETHASH=<folder>; test/bench/net-load.js): a running hash of every frame sent to each player, in
// order, with a checkpoint every 1,000 frames, written to <folder>/<player>.host.json when the player leaves; the test's
// players keep the same over what they receive. Equal checkpoints: every frame arrived, unchanged, in order.
const NETHASH_DIR = process.env.EAGLAN_DEBUG_NETHASH || null;
function nhAdd(st, b) {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let h = Math.imul(st.h ^ u.length, 16777619);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  st.h = h >>> 0; st.n++; if (st.n % 1000 === 0) st.cps.push([st.n, st.h]);
}

const PRE = 0, RECEIVED_ICE_CANDIDATE = 1, SENT_ICE_CANDIDATE = 2, RECEIVED_DESCRIPTION = 3,
  SENT_DESCRIPTION = 4, RECEIVED_SUCCESS = 5, CONNECTED = 6, CLOSED = 7;
const STATE_NAMES = ['PRE', 'RECEIVED_ICE', 'SENT_ICE', 'RECEIVED_DESC', 'SENT_DESC', 'RECEIVED_SUCCESS', 'CONNECTED', 'CLOSED'];

// The browser host gives up after 13s. Measured with the real u53 client: it sends
// ClientFailure 10s after it receives the host's ICE candidates (~15s after NewClient),
// and in real play successful joins took 4.8-11.4s, so 13s cut off joins the client was
// still waiting for. The client's own failure report (ClientFailure / DisconnectClient)
// now ends a failed handshake; this timeout is only a backstop.
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30000;
const MAX_PENDING_HANDSHAKES = 32; // bounds resources if a relay floods NewClient
// Network round-trip time of each connected player, read from the WebRTC stack (SCTP smoothed RTT,
// in ms; in test/netlab it tracked the emulated path RTT within ~5%). Cheap: one getStats() per
// player every RTT_SAMPLE_MS.
const RTT_SAMPLE_MS = 5000;
const RTT_KEEP = 240;              // recent samples kept for the median (20 minutes)

const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}s` : t < 3600 ? `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s` : `${Math.floor(t / 3600)}h${String(Math.floor(t / 60) % 60).padStart(2, '0')}m`; };
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
const PATH_NAMES = { host: 'direct', srflx: 'direct (via NAT)', prflx: 'direct (via NAT)', relay: 'TURN relay' };

// Kind of an ICE candidate for the failed-join line (no addresses are logged).
function candKind(str) {
  const f = String(str || '').trim().replace(/^a=/, '').split(/\s+/);
  if (f.length < 8 || !/^candidate:/.test(f[0]) || f[6] !== 'typ') return null;
  return { type: f[7], tcp: f[2].toLowerCase() === 'tcp', hidden: /\.local$/i.test(f[4]), v6: f[4].includes(':') };
}
function fmtCands(list) {
  if (!list.length) return 'none';
  const by = new Map();
  for (const k of list) {
    const key = k.type + (k.tcp ? ' (TCP)' : '');
    const x = by.get(key) || { n: 0, hidden: 0, v6: 0 }; x.n++; if (k.hidden) x.hidden++; if (k.v6) x.v6++; by.set(key, x);
  }
  return [...by].map(([t, x]) => `${x.n} ${t}${x.hidden ? `, ${x.hidden} hidden` : ''}${x.v6 ? `, ${x.v6} IPv6` : ''}`).join('; ');
}

function iceConfig(iceStrings) {
  // PlatformWebRTC.LANServer.setIceServers: "url" or "url;user;pass"
  const out = [];
  for (const s of iceStrings) {
    // Skip malformed entries some relays hand out (e.g. relay.webmc.xyz sends "stun:undefined").
    if (!/^(stun|stuns|turn|turns):[^\s;:?]+/i.test(s) || /^[a-z]+:(undefined|null)\b/i.test(s)) continue;
    const e = s.split(';');
    if (e.length === 1) out.push({ urls: e[0] });
    else if (e.length === 3) out.push({ urls: e[0], username: e[1], credential: e[2] });
  }
  return out;
}

class Peer {
  constructor(host, link, clientId, channel) {
    this.host = host; this.link = link; this.clientId = clientId; this.channel = channel;
    this.iceServers = link.iceServers.slice();
    this.state = PRE; this.dead = false;
    this.startTime = Date.now(); this.localICECandidate = null; this.localChannel = false;
    this.packetPreBuffer = null; this.dc = null; this.mapped = false;
    this.events = []; this.lateIce = 0;
    // Diagnostics for the session summary logged when the player leaves.
    this.stats = { inBytes: 0, inMsgs: 0, outBytes: 0, outMsgs: 0, lastIn: 0, lastOut: 0 };
    this.openedAt = null; this.endCause = null; this.playerName = null; this.firstByte = null; this.path = null;
    this.family = null; this.rtt = { n: 0, sum: 0, min: Infinity, max: 0, last: null, recent: [] }; this._rttTimer = null;
    // Opt-in "send small packets twice" relay (config redundantSend, see redundant.js).
    this.redundant = host.redundant ? new RedundantSender({ ...host.redundant, log: (m) => this.log(m) }) : null;
    this.redundantInUse = false; this._icePending = false;
    this.cands = { local: [], remote: [] }; // kinds of ICE candidates, for the failed-join line
    this._nh = NETHASH_DIR ? { n: 0, h: 0x811c9dc5, cps: [] } : null;   // debug: EAGLAN_DEBUG_NETHASH
    this._createPC();
  }

  _cause(c) { if (!this.endCause) this.endCause = c; }

  _sampleRtt() {
    if (this.dead || !this.pc) return;
    this.pc.getStats().then((st) => {
      if (this.dead) return;
      for (const s of st.values()) {
        const v = s.type === 'candidate-pair' ? Number(s.currentRoundTripTime) : NaN;
        if (!(v > 0 && v < 60000)) continue;
        const r = this.rtt; r.n++; r.sum += v; r.last = v;
        if (v < r.min) r.min = v; if (v > r.max) r.max = v;
        r.recent.push(v); if (r.recent.length > RTT_KEEP) r.recent.shift();
      }
    }).catch(() => {});
  }

  rttInfo() {
    const r = this.rtt;
    if (!r.n) return null;
    const sorted = [...r.recent].sort((a, b) => a - b);
    return { last: Math.round(r.last), avg: Math.round(r.sum / r.n), median: Math.round(sorted[sorted.length >> 1]), min: Math.round(r.min), max: Math.round(r.max), samples: r.n };
  }

  _summary() {
    const st = this.stats, now = Date.now();
    const who = this.playerName ? `${this.playerName} (${this.channel})` : this.channel;
    const since = st.lastIn ? `${((now - st.lastIn) / 1000).toFixed(1)}s` : 'never';
    let buffered = 0; try { buffered = this.dc ? this.dc.bufferedAmount : 0; } catch {}
    // A connection that closes right after the player's last packet was ended by the client (quit,
    // disconnect, tab closed). One that had been silent first was lost: measured with a real u53
    // client whose browser was killed, the close only arrives ~20s after the last packet.
    let cause = this.endCause || 'closed by the host';
    if (/^the player's client closed/.test(cause)) {
      const silent = st.lastIn ? now - st.lastIn : 0;
      cause = silent > 5000
        ? `the player's connection went silent ${fmtDur(silent)} before it closed (their network dropped, or their tab/browser was closed, crashed or frozen)`
        : 'the player left (their client closed the connection)';
    }
    const rtt = this.rttInfo();
    const twice = this.redundantInUse ? ` | small packets sent twice (+${fmtBytes(this.redundant.stats.copyBytes)})` : this.redundant ? ' | send twice not used for this connection' : '';
    return `${who} left after ${fmtDur(now - this.openedAt)}: ${cause}` +
      ` | last data from player ${since} before | received ${fmtBytes(st.inBytes)}, sent ${fmtBytes(st.outBytes)}` +
      `${buffered > 65536 ? `, ${fmtBytes(buffered)} still queued to the player` : ''} | path ${this.path || 'unknown'}${this.family ? ` ${this.family}` : ''}` +
      `${rtt ? ` | rtt ${rtt.median} ms median (min ${rtt.min}, max ${rtt.max})` : ''}${twice} | via ${this.link.name}`;
  }

  // One line for a join that did not get in: why, how far the connection got, and the kinds of
  // addresses both sides offered (e.g. no relay candidates on either side = no TURN to fall back on).
  _joinSummary() {
    return `${this.channel} did not get in after ${fmtDur(Date.now() - this.startTime)}: ${this.endCause || 'the join ended'}` +
      ` | connection ${this._lastConnState ? `reached '${this._lastConnState}'` : 'never started'}` +
      ` | player's candidates: ${fmtCands(this.cands.remote)} | ours: ${fmtCands(this.cands.local)} | via ${this.link.name}`;
  }

  log(m) { this.host.log(`[LAN ${this.channel}] ${m}`); }

  // Signaling goes back through the relay this peer arrived on.
  relaySend(buf) {
    if (this.link.send(buf)) return true;
    this.remoteDisconnect(`relay ${this.link.name} is not connected; cannot finish the handshake`);
    return false;
  }

  _createPC() {
    let pc;
    // in a network process (net-procs.js; the same API), or here
    try { pc = (this.host.netProcs && this.host.netProcs.createPC({ iceServers: iceConfig(this.iceServers) })) || new RTCPeerConnection({ iceServers: iceConfig(this.iceServers) }); }
    catch (e) { this.log('Failed to create peer: ' + e.message); this.events.push({ t: 'disconnect' }); return; }
    this.pc = pc;
    const cands = [];
    pc.onicecandidate = (evt) => {
      if (!evt.candidate || !evt.candidate.candidate) return;
      if (cands.length === 0) {
        // Same batching as the browser: wait 2s, re-wait while new candidates keep arriving (max 3 trials).
        const st = [0, 0];
        const run = () => {
          if (this.dead || pc.connectionState === 'disconnected') return;
          const trial = ++st[1];
          if (st[0] !== cands.length && trial < 3) { st[0] = cands.length; setTimeout(run, 2000); return; }
          const list = cands.splice(0);
          const emit = (l) => { this.events.push({ t: 'ice', candidates: JSON.stringify(l) }); this.host._kick(); };
          if (!this.redundant) { emit(list); return; }
          // Add the send-twice relay's candidates; the data channel event waits until they are sent.
          this._icePending = true;
          this.redundant.rewriteList(list).catch(() => list).then((l) => {
            this._icePending = false;
            this.host.noteRedundant(this.redundant.unavailableReason());
            if (!this.dead) emit(l);
          });
        };
        setTimeout(run, 2000);
      }
      const kind = candKind(evt.candidate.candidate); if (kind) this.cands.local.push(kind);
      // libdatachannel reports "a=candidate:..."; browsers produce (and expect) "candidate:...".
      cands.push({ sdpMLineIndex: String(evt.candidate.sdpMLineIndex ?? 0), candidate: String(evt.candidate.candidate).replace(/^a=/, '') });
    };
    const onDC = (evt) => {
      const ch = evt.channel; if (!ch) return;
      if (this.dc || this._dcPending) { try { ch.close(); } catch {} return; }
      this._dcPending = true; ch.binaryType = 'arraybuffer';
      // Listen at once. The u53 client sends its login packet the moment our ICE candidates reach
      // it, and the WebRTC library drops messages that arrive while no listener is attached: when
      // the listener was only attached once the channel was handed over below, about 1 join in 30
      // lost that packet and ended with "Took too long to log in" (0 bytes received).
      const early = [];
      const deliver = (buf) => {
        if (this.mapped) this.host.toWorker(this.channel, buf);
        else { this.events.push({ t: 'packet', payload: buf }); this.host._kick(); }
      };
      ch.onmessage = (e2) => {
        const data = e2.data;
        const buf = data instanceof ArrayBuffer ? data : (ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null);
        if (!buf) return;
        this.stats.inBytes += buf.byteLength; this.stats.inMsgs++; this.stats.lastIn = Date.now();
        if (this.firstByte === null && buf.byteLength) this.firstByte = new Uint8Array(buf)[0];
        if (this.dc !== ch) { early.push(buf); return; }
        deliver(buf);
      };
      ch.onclose = () => { this._cause("the player's client closed the connection (data channel closed)"); this.remoteDisconnect('data channel closed'); };
      // Hand the channel to the state machine only after our ICE message went out (the browser host's
      // order), then any messages that arrived meanwhile, in order.
      const announce = () => {
        if (this.dead) return;
        if (cands.length || this._icePending) { setTimeout(announce, 10); return; }
        this.dc = ch;
        this.events.push({ t: 'datachannel' }); this.host._kick();
        for (const b of early.splice(0)) deliver(b);
      };
      announce();
    };
    pc.ondatachannel = onDC;
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === this._lastConnState) return; this._lastConnState = s;
      this.log('connection state: ' + s);
      if (s === 'closed' && !this.dead) this._cause("the player's client closed the connection");
      if (s === 'disconnected') this._cause('the connection to the player was lost (network: ICE disconnected)');
      if (s === 'failed') this._cause('the connection to the player failed (network: ICE failed)');
      if (s === 'disconnected' || s === 'failed') this.remoteDisconnect('peer connection ' + s);
    };
  }

  remoteDisconnect(why) {
    if (this._remoteGone) return; this._remoteGone = true;
    if (why) this.log(why);
    this.events.push({ t: 'disconnect' }); this.host._kick();
  }

  async handleDescription(desc) {
    if (this.state !== PRE) return this.log('unexpected Description');
    this.state = RECEIVED_DESCRIPTION;
    try {
      const d = JSON.parse(desc);
      for (const line of String(d.sdp || '').split(/\r?\n/)) { const k = /^a=candidate:/.test(line) && candKind(line); if (k) this.cands.remote.push(k); }
      if (this.redundant) this.redundant.addRemote(d.sdp);
      await this.pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        const local = this.pc.localDescription || ans;
        let sdp = local.sdp;
        if (this.redundant) sdp = await this.redundant.rewriteSdp(sdp).catch(() => local.sdp);
        this.events.push({ t: 'desc', description: JSON.stringify({ type: local.type, sdp }) });
        this.host._kick();
      }
    } catch (e) { this.log('Failed to handle description: ' + (e && e.message)); this.remoteDisconnect(); }
  }

  handleICECandidates(str) {
    if (this.state !== SENT_DESCRIPTION) return this.log('unexpected ICECandidate');
    try {
      for (const c of JSON.parse(str)) {
        const k = candKind(c.candidate); if (k) this.cands.remote.push(k);
        if (this.redundant) this.redundant.addRemote(c.candidate);
        this.pc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: parseInt(c.sdpMLineIndex, 10) || 0, sdpMid: '0' }).catch((e) => this.log('addIceCandidate: ' + e.message));
      }
    } catch (e) { this.log('bad ICE candidates: ' + e.message); this.remoteDisconnect(); return; }
    if (this.localICECandidate != null) {
      if (!this.relaySend(relay.write.iceCandidate(this.clientId, this.localICECandidate))) return;
      this.localICECandidate = null; this.state = SENT_ICE_CANDIDATE;
    } else this.state = RECEIVED_ICE_CANDIDATE;
  }

  _openChannel() {
    const limit = this.host.playerLimit, online = this.host.playerCount();
    if (limit && online >= limit) return this._refuseFull(online, limit);
    this.host.openPlayerChannel(this.channel);
    this.mapped = true; this.openedAt = Date.now();
    try {
      const cp = this.pc.selectedCandidatePair();
      if (cp) {
        this.path = `${PATH_NAMES[cp.local.type] || cp.local.type}/${PATH_NAMES[cp.remote.type] || cp.remote.type}`;
        const addr = String(cp.remote.address || cp.local.address || '');
        this.family = addr.includes(':') && !/^::ffff:\d/i.test(addr) ? 'IPv6' : 'IPv4';
        // Through the send-twice relay the library sees the relay's socket, not the player's address.
        if (this.redundant && this.redundant.owns(cp.remote.address, cp.remote.port)) {
          this.redundantInUse = true; this.path = 'direct (send-twice relay)';
          this.family = this.redundant.playerFamily(cp.remote.port) || this.family;
        }
      }
    } catch {}
    if (this.redundant && !this.redundantInUse) this.redundant.close(); // connected on the library's own port: free the relay
    this._rttTimer = setInterval(() => this._sampleRtt(), RTT_SAMPLE_MS); this._rttTimer.unref?.();
    if (this.packetPreBuffer) { for (const b of this.packetPreBuffer) this.host.toWorker(this.channel, b); this.packetPreBuffer = null; }
    this.state = CONNECTED;
    const r = this.redundant, unreached = r && !this.redundantInUse && r.port && r.offered && !r.stats.fromPlayer;
    const twice = this.redundantInUse ? ', small packets sent twice' : unreached ? ` (send twice not used: nothing from this player reached UDP port ${r.port})` : r ? ' (send twice not used for this connection)' : '';
    this.log(`connected via ${this.link.name} after ${((Date.now() - this.startTime) / 1000).toFixed(1)}s, player channel opened${twice}`);
    if (r) this.host.noteRedundantReach(this);
  }

  // Player limit (config playerLimit; u53 enforces none): the joining player gets the game's own
  // refusal at login, with the reason, and the world never sees the join. The packet is a LOGIN-state
  // Disconnect (id 0x00, the reason as chat JSON) in the integrated server's frame (type 0: one whole packet).
  _refuseFull(online, limit) {
    if (this._refused) return; this._refused = true;
    this.host.refusedFull++;
    const json = Buffer.from(JSON.stringify({ text: `This world is full: ${online} of ${limit} players are online. Try again later.` }), 'utf8');
    const len = []; for (let n = json.length; ; n >>>= 7) { if (n < 128) { len.push(n); break; } len.push((n & 127) | 128); }
    try { this.dc.send(Buffer.concat([Buffer.from([0, 0x00, ...len]), json])); } catch {}
    this._cause(`refused: the world is full (${online} of ${limit} players)`);
    this.log(`refused: the world is full (${online} of ${limit} players; config playerLimit)`);
    // Give the message time to arrive before the connection closes.
    setTimeout(() => this.disconnect(), 2000).unref?.();
  }

  handleSuccess() {
    if (this.state === SENT_ICE_CANDIDATE) {
      if (this.localChannel) this._openChannel(); else this.state = RECEIVED_SUCCESS;
    } else if (this.state !== CONNECTED) this.log('unexpected ClientSuccess');
  }

  handleFailure() {
    if (this.state === SENT_ICE_CANDIDATE || this.state === RECEIVED_ICE_CANDIDATE || this.state === SENT_DESCRIPTION) {
      this.log('client reported that it could not connect');
      this._cause("the player's client gave up: it found no working network path to this server");
      this.disconnect();
    }
    else if (this.state !== CONNECTED) this.log('unexpected ClientFailure');
  }

  update() {
    if (this.state === CLOSED) { this.disconnect(); return; }
    if (this.state !== CONNECTED && Date.now() - this.startTime > this.host.handshakeTimeoutMs) { this.log('handshake timed out'); this._cause('the join timed out'); this.disconnect(); return; }
    const evs = this.events.splice(0);
    const deferred = [];
    for (const ev of evs) {
      if (ev.t === 'disconnect') { this.log('disconnected'); this.disconnect(); return; }
      // libdatachannel can connect using candidates already inside the SDP, so the data
      // channel (and early packets / local ICE) may show up before the relay has delivered
      // the client's trickled candidates. The browser's state machine would drop the peer
      // here; keep the events until the handshake catches up instead. Relay messages are unchanged.
      if ((this.state === RECEIVED_DESCRIPTION || this.state === SENT_DESCRIPTION) && (ev.t === 'datachannel' || ev.t === 'packet')) { deferred.push(ev); continue; }
      if (this.state === RECEIVED_DESCRIPTION && ev.t === 'ice') { deferred.push(ev); continue; }
      // Candidates gathered after our one ICE message (e.g. slow TURN allocations) cannot be
      // signaled anymore; the browser host would treat them as fatal. Ignore them.
      if (ev.t === 'ice' && (this.state === SENT_ICE_CANDIDATE || this.state === CONNECTED)) { this.lateIce++; continue; }
      switch (this.state) {
        case SENT_DESCRIPTION: if (ev.t === 'ice') { this.localICECandidate = ev.candidates; continue; } break;
        case RECEIVED_DESCRIPTION: if (ev.t === 'desc') { if (!this.relaySend(relay.write.description(this.clientId, ev.description))) return; this.state = SENT_DESCRIPTION; continue; } break;
        case RECEIVED_ICE_CANDIDATE:
          if (ev.t === 'ice') { if (!this.relaySend(relay.write.iceCandidate(this.clientId, ev.candidates))) return; this.state = SENT_ICE_CANDIDATE; continue; }
          if (ev.t === 'datachannel') { this.localChannel = true; continue; }
          if (ev.t === 'packet') { (this.packetPreBuffer ||= []).push(ev.payload); continue; }
          break;
        case SENT_ICE_CANDIDATE:
          if (ev.t === 'datachannel') { this.localChannel = true; continue; }
          if (ev.t === 'packet') { (this.packetPreBuffer ||= []).push(ev.payload); continue; }
          break;
        case RECEIVED_SUCCESS:
          if (ev.t === 'datachannel') { this._openChannel(); continue; }
          if (ev.t === 'ice') continue;
          if (ev.t === 'packet') { (this.packetPreBuffer ||= []).push(ev.payload); continue; }
          break;
        case CONNECTED: if (ev.t === 'packet') { this.host.toWorker(this.channel, ev.payload); continue; } break;
      }
      if (this.state !== CLOSED) this.log(`had an accident: ${ev.t} (state ${STATE_NAMES[this.state]})`);
      this.disconnect(); return;
    }
    if (deferred.length) this.events.unshift(...deferred);
  }

  send(buf) {
    if (this.dc && this.dc.readyState === 'open') {
      if (this._nh) nhAdd(this._nh, buf);
      try { this.dc.send(buf); this.stats.outBytes += buf.byteLength || 0; this.stats.outMsgs++; this.stats.lastOut = Date.now(); return; }
      catch (e) {
        if (!this._sendFailed) { this._sendFailed = true; this.log('send failed: ' + e.message); } // the game keeps sending until it hears: log once
        // "DataChannel is closed" / "errno=2" (the SCTP association is gone): the connection itself ended.
        this._cause(/DataChannel is closed|errno=2\b/.test(e.message) ? 'the connection to the player closed (noticed while sending to them)' : 'sending to the player failed: ' + e.message);
      }
    }
    this._cause('the data channel to the player was already closed');
    this.remoteDisconnect('send on closed channel');
  }

  disconnect() {
    if (this.dead) return;
    clearInterval(this._rttTimer);
    if (this.state === CONNECTED) {
      this.host.log(`[LAN] ${this._summary()}`); this.host.closePlayerChannel(this.channel);
      if (this._nh) { try { require('node:fs').writeFileSync(require('node:path').join(NETHASH_DIR, String(this.playerName || this.channel).replace(/[^A-Za-z0-9_.-]/g, '_') + '.host.json'), JSON.stringify(this._nh)); } catch {} }
    }
    else if (this.state !== CLOSED) this.host.log(`[LAN] ${this._joinSummary()}`);
    this.state = CLOSED; this.dead = true;
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
    if (this.redundant) this.redundant.close();
  }
}

class LANHost {
  constructor({ log, toWorker, openPlayerChannel, closePlayerChannel, onChange, timings, handshakeTimeoutMs, redundant, playerLimit, netProcs }) {
    this.log = log; this.toWorker = toWorker; this.openPlayerChannel = openPlayerChannel;
    this.netProcs = netProcs || null;   // config networkProcesses: the players' connections in network processes (net-procs.js)
    this.closePlayerChannel = closePlayerChannel; this.onChange = onChange || (() => {});
    this.timings = timings; this.handshakeTimeoutMs = handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.playerLimit = playerLimit || 0; this.refusedFull = 0;   // 0: no limit (see Peer._refuseFull)
    this.redundant = redundant || null;  // options for RedundantSender, or null (off); used for players who join later
    this.redundantUnavailable = null; this.redundantUnreached = null; this._twiceMisses = 0;  // see noteRedundant*
    this.links = new Map();   // relay url -> RelayLink (each with .peers: clientId -> Peer)
    this.order = [];          // configured order, for display and "primary" code
    this.peers = new Map();   // player channel -> Peer, across all relays
    this._tagSeq = 0; this._timer = null; this._kickPending = false; this.closed = false;
    this._lastSummary = null;
  }

  // Registers the world on every relay in `relays` (non-blocking; each relay connects,
  // fails and retries independently).
  start(relays, worldName, hidden) {
    this.worldName = worldName; this.hidden = !!hidden;
    if (!this._timer) { this._timer = setInterval(() => this.update(), 50); }
    this.reconfigure(relays);
  }

  // Applies a new relay list without touching the world or connected players:
  // removed relays are closed, new ones are started, unchanged ones keep their registration.
  reconfigure(relays) {
    if (this.closed) return;
    const want = new Set(relays);
    for (const [url, link] of this.links) {
      if (!want.has(url)) { link.log('removed from configuration'); link.stop(); this.links.delete(url); }
    }
    for (const url of relays) if (!this.links.has(url)) this._addLink(url);
    this.order = relays.slice();
    this._summary();
    this.onChange();
  }

  _addLink(url) {
    const link = new relay.RelayLink(url, { worldName: this.worldName, hidden: this.hidden, log: this.log, tag: 'r' + (++this._tagSeq), timings: this.timings });
    link.peers = new Map();
    link.on('packet', (p) => this._onRelayPacket(link, p));
    link.on('active', () => { if (!this.closed) { this._summary(); this.onChange(); } });
    link.on('down', ({ reason }) => { this._linkDown(link, reason); if (!this.closed) { this._summary(); this.onChange(); } });
    link.on('state', () => { if (!this.closed) this.onChange(); });
    this.links.set(url, link);
    link.start();
  }

  _linkDown(link, reason) {
    let dropped = 0;
    for (const peer of link.peers.values()) {
      if (peer.state !== CONNECTED && !peer.dead) { peer.log(`relay lost before the handshake finished (${reason})`); peer.disconnect(); dropped++; }
    }
    // Connected players keep their direct WebRTC connection; they no longer need the relay.
    link.peers.clear();
    if (dropped) this._kick();
  }

  _summary() {
    const links = this.order.map((u) => this.links.get(u)).filter(Boolean);
    const active = links.filter((l) => l.state === relay.STATE.ACTIVE);
    const line = active.length
      ? `World reachable via ${active.length}/${links.length} relay${links.length === 1 ? '' : 's'}: ${active.map((l) => `${l.name}=${l.code}`).join(', ')}`
      : `No relay is active (${links.length} configured): new players cannot join until one connects; connected players are not affected`;
    if (line !== this._lastSummary) { this._lastSummary = line; this.log(line); }
  }

  _onRelayPacket(link, p) {
    const id = p.peerId != null ? p.peerId : p.clientId;
    const peer = id != null ? link.peers.get(id) : null;
    switch (p.type) {
      case 'NewClient': {
        const cid = p.clientId;
        if (!cid || cid.startsWith('~!') || !/^[\x21-\x7e]{1,64}$/.test(cid)) { link.log(`ignored invalid client id '${cid}'`); break; }
        if (link.peers.has(cid)) { link.log(`relay provided duplicate client '${cid}'`); break; }
        let pending = 0; for (const x of this.peers.values()) if (x.state !== CONNECTED) pending++;
        if (pending >= MAX_PENDING_HANDSHAKES) { link.log(`ignored client '${cid}': ${pending} joins already in progress`); link.send(relay.write.disconnectClient(cid, 0, 'host busy')); break; }
        // Channel names are namespaced per relay connection, so ids issued by different
        // relays can never collide inside the integrated server.
        const channel = `${link.tag}-${cid}`;
        if (this.peers.has(channel)) { link.log(`duplicate player channel '${channel}' ignored`); break; }
        const np = new Peer(this, link, cid, channel);
        link.peers.set(cid, np); this.peers.set(channel, np);
        np.log(`new client via ${link.name}`);
        break;
      }
      case 'ICECandidate': if (peer) peer.handleICECandidates(p.candidate); else link.log(`ICECandidate for unknown client '${id}'`); break;
      case 'Description': if (peer) peer.handleDescription(p.description); else link.log(`Description for unknown client '${id}'`); break;
      case 'ClientSuccess': if (peer) peer.handleSuccess(); else link.log(`ClientSuccess for unknown client '${id}'`); break;
      case 'ClientFailure': if (peer) peer.handleFailure(); else link.log(`ClientFailure for unknown client '${id}'`); break;
      case 'DisconnectClient':
        // Relay reports that a joining client gave up / failed.
        if (peer && !peer.dead && peer.state !== CONNECTED) {
          peer.log(`relay: client disconnected (${p.code}: ${p.reason})`);
          peer._cause(`the relay ended the join: ${p.reason || 'code ' + p.code}`);
          peer.disconnect();
        }
        break;
      case 'ErrorCode': link.log(`relay error ${relay.errorName(p.code)}: ${p.desc}`); break;
      case 'SpecialUpdate': case 'Pong': break;
      default: link.log('unexpected relay packet: ' + p.type);
    }
    this._kick();
  }

  _kick() { if (!this._kickPending) { this._kickPending = true; setImmediate(() => { this._kickPending = false; this.update(); }); } }

  update() {
    for (const [ch, peer] of this.peers) {
      peer.update();
      if (peer.dead) { this.peers.delete(ch); if (peer.link.peers.get(peer.clientId) === peer) peer.link.peers.delete(peer.clientId); }
    }
  }

  // Data from the integrated server on a player channel -> that player's data channel.
  fromWorker(channel, buf) { const p = this.peers.get(channel); if (p && p.mapped) { p.send(buf); return true; } return false; }
  // A packed batch of a player's packets (frame i ends at ix[i] in pack) for a player whose connection is in a network
  // process: passed on whole, after what was sent before (net-procs.js keeps one ordered queue per process). false: not
  // such a player now (the caller sends frame by frame).
  sendPacked(channel, pack, ix) {
    const p = this.peers.get(channel), np = this.netProcs;
    if (!np || !p || !p.mapped || !p.dc || p.dc.readyState !== 'open' || !np.isRemote(p.pc)) return false;
    p.stats.outMsgs += ix.byteLength >> 2; p.stats.outBytes += pack.byteLength; p.stats.lastOut = Date.now();
    if (p._nh) { const e = new Int32Array(ix); let s = 0; for (let i = 0; i < e.length; i++) { nhAdd(p._nh, new Uint8Array(pack, s, e[i] - s)); s = e[i]; } }
    np.sendPacked(p.pc, pack, ix);
    return true;
  }

  // Player name from the server's "<name>[channel:<ch>] logged in" line, for readable logs.
  setPlayerName(channel, name) { const p = this.peers.get(channel); if (p) p.playerName = name; }

  // The server could not read a packet of this type. Point at the player who sent it: almost
  // always a client of another Eaglercraft version (1.12.2, 26.2, ...) on the same relay.
  flagUnreadable(type) {
    for (const p of this.peers.values()) {
      if (p.state === CONNECTED && p.firstByte === type && !p.flaggedUnreadable && Date.now() - p.openedAt < 120000) {
        p.flaggedUnreadable = true;
        p.log(`sent data the 1.8.8 server cannot read (packet type ${type}): this player is probably using a different Eaglercraft version (e.g. 1.12.2 or 26.2) or a modified client, and needs EaglercraftX 1.8.8 to join`);
      }
    }
  }

  // Integrated server closed a channel (kick / logout).
  serverClosedChannel(channel, reason) {
    const p = this.peers.get(channel);
    if (p) {
      if (p.state === CONNECTED && !p.dead) { p._cause(`the server ended the session${reason ? ' (' + reason + ')' : ' (kick, logout or login timeout)'}`); this.log(`[LAN] ${p._summary()}`); }
      p.state = CLOSED; p.dead = true;
      try { p.dc && p.dc.close(); } catch {} try { p.pc.close(); } catch {}
      this.peers.delete(channel);
      if (p.link.peers.get(p.clientId) === p) p.link.peers.delete(p.clientId);
    }
  }

  playerCount() { let n = 0; for (const p of this.peers.values()) if (p.state === CONNECTED) n++; return n; }
  // Player limit for joins from now on (0: none); players already in the world stay.
  setPlayerLimit(n) { this.playerLimit = n || 0; }
  // New send-twice options (null: off) for players who join from now on; earlier notes start over.
  setRedundant(opts) { this.redundant = opts || null; this.redundantUnavailable = null; this.redundantUnreached = null; this._twiceMisses = 0; }
  // Send twice is on but the server has no public address for its relay port: say so once.
  noteRedundant(why) {
    if (why && why !== this.redundantUnavailable) {
      this.redundantUnavailable = why;
      this.log(`send twice is on, but it cannot be used on this server: ${why}. Players connect as before. It needs the server's public IP on a network interface, or a UDP port for it that is forwarded to this server (see README "Send small packets twice")`);
    } else if (!why && this.redundantUnavailable) { this.redundantUnavailable = null; this.log('send twice: players who join can use it now'); }
  }
  // With a fixed port: a player connected without a single datagram reaching that port (a firewall
  // or a missing port forwarding). Three such joins in a row are reported once.
  noteRedundantReach(p) {
    const r = p.redundant;
    if (!r.port || !r.offered) return;
    if (p.redundantInUse || r.stats.fromPlayer) {
      this._twiceMisses = 0;
      if (this.redundantUnreached) { this.redundantUnreached = null; this.log(`send twice: players reach UDP port ${r.port} now`); }
      return;
    }
    if (++this._twiceMisses >= 3 && !this.redundantUnreached) {
      this.redundantUnreached = `no player reached UDP port ${r.port} (${this._twiceMisses} joins in a row): allow incoming UDP on that port in the server's firewall, and forward it to this server if it is behind NAT`;
      this.log(`send twice: ${this.redundantUnreached}. Players connect without it`);
    }
  }
  // Send-twice details for status: whether the connection runs through the relay right now
  // (the player's browser can change its selected path later) and what was copied.
  _twiceInfo(p) {
    if (!p.redundant) return null;
    let now = false;
    try { const cp = p.pc.selectedCandidatePair(); now = !!cp && !p.redundant.closed && p.redundant.owns(cp.remote.address, cp.remote.port); } catch {}
    const st = p.redundant.stats;
    return { inUse: now, copies: st.copies, copyBytes: st.copyBytes, datagrams: st.toPlayer, lastSentAgoMs: st.lastToPlayer ? Date.now() - st.lastToPlayer : null };
  }
  peerList() { return [...this.peers.values()].map((p) => ({ id: p.channel, name: p.playerName, relay: p.link.name, state: STATE_NAMES[p.state], since: p.startTime, path: p.path, family: p.family, rtt: p.rttInfo(), sentTwice: p.redundant ? p.redundantInUse : null, twice: this._twiceInfo(p) })); }

  relaySnapshot() {
    return this.order.map((u) => this.links.get(u)).filter(Boolean).map((l) => {
      let players = 0, joining = 0;
      for (const p of this.peers.values()) if (p.link === l) { if (p.state === CONNECTED) players++; else joining++; }
      return { ...l.snapshot(), players, joining };
    });
  }

  activeRelays() { return this.relaySnapshot().filter((r) => r.state === relay.STATE.ACTIVE); }

  close() {
    this.closed = true;
    if (this._timer) clearInterval(this._timer); this._timer = null;
    for (const link of this.links.values()) link.stop();
    for (const p of this.peers.values()) { p._cause('the host is shutting down'); p.disconnect(); }
    this.peers.clear();
  }
}

module.exports = { LANHost, Peer, DEFAULT_HANDSHAKE_TIMEOUT_MS, iceConfig };
