'use strict';
// Host side of the network lab (child process of bench.js). Uses the same WebRTC stack and the
// same RTCPeerConnection setup as src/lan-host.js, with optional SCTP settings from NETLAB_SCTP,
// applied before any connection exists (they are process-wide).
const ndc = require('node-datachannel');
const { RTCPeerConnection } = require('node-datachannel/polyfill');

const sctp = process.env.NETLAB_SCTP ? JSON.parse(process.env.NETLAB_SCTP) : null;
// NETLAB_REDUNDANT=1: put the host's real send-twice relay (src/redundant.js) in front of the connection.
const { RedundantSender } = process.env.NETLAB_REDUNDANT ? require('../../src/redundant') : {};
let red = null;
if (sctp && Object.keys(sctp).length) ndc.setSctpSettings(sctp);

const clock = () => performance.timeOrigin + performance.now();
let pc = null, dc = null, t0 = 0;
const rx = [];            // [seq, sentRel, recvRel]
const rtt = [];           // [tRel, rtt ms] from getStats (SCTP smoothed RTT)
let maxBuffered = 0, sendTimer = null, rttTimer = null;

function stamp(size, seq) {
  const b = new ArrayBuffer(Math.max(8, size)), v = new DataView(b);
  v.setUint32(0, seq); v.setFloat32(4, clock() - t0);
  return b;
}

function replay(msgs) {
  let i = 0;
  const tick = () => {
    const rel = clock() - t0;
    while (i < msgs.length && msgs[i][0] <= rel) {
      try { dc.send(stamp(msgs[i][1], i)); } catch {}
      i++;
    }
    try { maxBuffered = Math.max(maxBuffered, dc.bufferedAmount); } catch {}
    if (i < msgs.length) sendTimer = setTimeout(tick, Math.max(0, msgs[i][0] - (clock() - t0)));
  };
  tick();
}

process.on('message', async (m) => {
  if (m.ping != null) return process.send({ pong: m.ping, t: clock() });
  if (m.offer) {
    pc = new RTCPeerConnection({ iceServers: [] });
    if (RedundantSender) red = new RedundantSender({ allowPrivate: true });
    const cands = [];
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) cands.push(String(e.candidate.candidate).replace(/^a=/, '')); };
    pc.ondatachannel = (e) => {
      dc = e.channel; dc.binaryType = 'arraybuffer';
      dc.onmessage = (ev) => {
        const d = ev.data, buf = d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        const v = new DataView(buf);
        rx.push([v.getUint32(0), v.getFloat32(4), clock() - t0]);
      };
      process.send({ open: true });
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: m.offer });
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await new Promise((r) => setTimeout(r, 1500)); // host candidates are gathered quickly (no STUN/TURN)
    let answer = (pc.localDescription || ans).sdp, candidates = cands;
    if (red) {
      answer = await red.rewriteSdp(answer);
      candidates = (await red.rewriteList(cands.map((candidate) => ({ candidate })))).map((x) => x.candidate);
    }
    return process.send({ answer, candidates });
  }
  if (m.start) {
    t0 = m.t0;
    setTimeout(() => replay(m.msgs), Math.max(0, t0 - clock()));
    if (process.env.NETLAB_DEBUG_PAIR) setInterval(() => { try { const p = pc.selectedCandidatePair(); console.log(`[host] t=${((clock() - t0) / 1000).toFixed(1)}s pair local ${p.local.type} ${p.local.address}:${p.local.port} remote ${p.remote.type} ${p.remote.address}:${p.remote.port}${red ? ` viaRelay=${red.owns(p.remote.address, p.remote.port)} toPlayer=${red.stats.toPlayer}` : ''}`); } catch {} }, 2000).unref();
    rttTimer = setInterval(async () => {
      try {
        const st = await pc.getStats();
        for (const s of st.values()) if (s.type === 'candidate-pair' && s.currentRoundTripTime != null) rtt.push([clock() - t0, s.currentRoundTripTime]);
      } catch {}
    }, 1000);
    return;
  }
  if (m.finish) {
    clearTimeout(sendTimer); clearInterval(rttTimer);
    let pair = null; try { const p = pc.selectedCandidatePair(); pair = { local: p.local.type, remote: p.remote.type, viaRelay: red ? red.owns(p.remote.address, p.remote.port) : false }; } catch {}
    process.send({ result: { rx, rtt, maxBuffered, pair, sctp, relay: red ? red.snapshot() : null } });
    if (red) red.close();
    setTimeout(() => { try { pc.close(); } catch {} try { ndc.cleanup(); } catch {} process.exit(0); }, 200);
  }
});
process.send({ ready: true });
