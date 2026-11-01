'use strict';
// A network process (config networkProcesses, see net-procs.js): the WebRTC connections of some of the players, in a
// process of its own. node-datachannel works in one thread per process, and it encrypts and sends every message on
// the thread that sends it (~24 us each), so with many players watching many entities the host's own thread could
// not keep up. Here: the peer connections and data channels (the library's browser-like API, as lan-host.js uses
// in the host itself), each player's packets sent in the order they come, and what the player sends passed back.
// The host keeps the relays, the join steps and everything else. Messages (advanced serialization):
//   in:  { op: 'create', id, config }         a peer connection
//        { op: 'call', rq, id, fn, arg }      setRemoteDescription / createAnswer / setLocalDescription /
//                                             addIceCandidate / getStats (answer: { rq, ok, v } or { rq, err })
//        { op: 'close', id } { op: 'dcClose', id }
//        { op: 'out', q: [[id, buf] | [id, pack, ix]] }   packets, in order: one frame, or a packed batch (frame i
//                                             ends at ix[i] in pack; daemon.js / game-patches.js "packed hand-over")
//   out: { ev: 'ice', id, c }  { ev: 'state', id, s, pair }  { ev: 'dc', id, pair }  { ev: 'dcClose', id }
//        { ev: 'in', q: [[id, buf], ...] }    what players sent, in order
//        { ev: 'sendErr', id, m }             a send failed (the channel is gone)
//        { ev: 'stats', sent, bytes, busyMs }  every 5 s
const { RTCPeerConnection } = require('node-datachannel/polyfill');

const pcs = new Map();   // id -> { pc, dc }
const post = (m) => { try { process.send(m); } catch {} };
let inQ = [], inTimer = false, sent = 0, bytes = 0, busy = 0n;

function flushIn() { inTimer = false; if (inQ.length) { const q = inQ; inQ = []; post({ ev: 'in', q }); } }
function pairOf(pc) {
  try { const cp = pc.selectedCandidatePair(); if (!cp) return null; const f = (c) => ({ type: c.type, address: c.address, port: c.port }); return { local: f(cp.local), remote: f(cp.remote) }; }
  catch { return null; }
}

function create(id, config) {
  let pc;
  try { pc = new RTCPeerConnection(config); } catch (e) { post({ ev: 'state', id, s: 'failed', pair: null, err: e.message }); return; }
  const e = { pc, dc: null };
  pcs.set(id, e);
  pc.onicecandidate = (evt) => {
    const c = evt.candidate;
    if (c && c.candidate) post({ ev: 'ice', id, c: { candidate: String(c.candidate), sdpMLineIndex: c.sdpMLineIndex, sdpMid: c.sdpMid } });
  };
  pc.ondatachannel = (evt) => {
    const ch = evt.channel; if (!ch) return;
    if (e.dc) { try { ch.close(); } catch {} return; }   // one channel per player, as the host keeps it
    e.dc = ch; ch.binaryType = 'arraybuffer';
    // listen at once: the client's login packet can come right away (lan-host.js onDC)
    ch.onmessage = (m) => {
      const d = m.data, buf = d instanceof ArrayBuffer ? d : (ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : null);
      if (!buf) return;
      inQ.push([id, buf]); if (!inTimer) { inTimer = true; setImmediate(flushIn); }
    };
    ch.onclose = () => { flushIn(); post({ ev: 'dcClose', id }); };
    post({ ev: 'dc', id, pair: pairOf(pc) });
  };
  pc.onconnectionstatechange = () => post({ ev: 'state', id, s: pc.connectionState, pair: pairOf(pc) });
}

async function call(m) {
  const e = pcs.get(m.id);
  if (!e) { post({ rq: m.rq, err: 'no such connection' }); return; }
  try {
    let v = null;
    switch (m.fn) {
      case 'setRemoteDescription': await e.pc.setRemoteDescription(m.arg); break;
      case 'createAnswer': { const a = await e.pc.createAnswer(); v = { type: a.type, sdp: a.sdp }; break; }
      case 'setLocalDescription': { await e.pc.setLocalDescription(m.arg); const l = e.pc.localDescription; v = l ? { type: l.type, sdp: l.sdp } : null; break; }
      case 'addIceCandidate': await e.pc.addIceCandidate(m.arg); break;
      case 'getStats': { const st = await e.pc.getStats(); v = []; for (const s of st.values()) if (s.type === 'candidate-pair') v.push({ type: s.type, currentRoundTripTime: s.currentRoundTripTime }); v.push({ type: 'eaglan-buffered', amount: e.dc ? e.dc.bufferedAmount : 0 }); break; }
      default: throw new Error('unknown call ' + m.fn);
    }
    post({ rq: m.rq, ok: true, v });
  } catch (err) { post({ rq: m.rq, err: (err && err.message) || String(err) }); }
}

function sendOne(id, e, b) {
  try { e.dc.send(b); sent++; bytes += b.byteLength; return true; }
  catch (err) { post({ ev: 'sendErr', id, m: (err && err.message) || String(err) }); e.dead = true; return false; }
}
function out(q) {
  const t = process.hrtime.bigint();
  for (const item of q) {
    const id = item[0], e = pcs.get(id);
    if (!e || !e.dc || e.dead || e.dc.readyState !== 'open') continue;   // gone meanwhile: the host hears it from the events
    if (item.length === 2) { sendOne(id, e, Buffer.from(item[1])); continue; }
    const pack = item[1], ix = new Int32Array(item[2]); let start = 0;
    for (let i = 0; i < ix.length; i++) { if (!sendOne(id, e, Buffer.from(pack, start, ix[i] - start))) break; start = ix[i]; }
  }
  busy += process.hrtime.bigint() - t;
}

process.on('message', (m) => {
  switch (m.op) {
    case 'out': out(m.q); break;
    case 'create': create(m.id, m.config); break;
    case 'call': call(m); break;
    case 'dcClose': { const e = pcs.get(m.id); if (e && e.dc) { try { e.dc.close(); } catch {} } break; }
    case 'close': { const e = pcs.get(m.id); pcs.delete(m.id); if (e) { try { e.dc && e.dc.close(); } catch {} try { e.pc.close(); } catch {} } break; }
    default: break;
  }
});
process.on('disconnect', () => process.exit(0));   // the host is gone
setInterval(() => { post({ ev: 'stats', sent, bytes, busyMs: Number(busy) / 1e6, peers: pcs.size }); }, 5000).unref();
post({ ev: 'ready', pid: process.pid });
