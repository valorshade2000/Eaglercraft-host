'use strict';
// Protocol-level stand-in for a joining u53 client: connects to a relay as type 2 with a
// join code and opens the same WebRTC data channel ("lan") the browser client opens.
// Message order follows a Chrome DevTools capture of the real client:
//   Handshake(2,1,code) -> [Handshake(clientId), ICEServers] -> Description("", offer)
//   -> [Description(answer)] -> ICECandidate("", batched) -> [ICECandidate] -> ClientSuccess("")
// Used by `node cli.js relays probe` and by the automated tests. It does not speak the
// Minecraft protocol; it proves relay routing and the WebRTC path into the host.

const WebSocket = require('ws');
const { RTCPeerConnection } = require('node-datachannel/polyfill');
const relay = require('./relay');
const { iceConfig } = require('./lan-host');

// firstMessage: sent on the data channel together with ClientSuccess, the moment the join completes,
// as the u53 client sends its login handshake right after it receives the host's candidates.
function joinViaRelay(url, code, { timeoutMs = 25000, log = () => {}, firstMessage = null } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timings = {};
    let ws, pc, dc, clientId = null, done = false, answered = false, iceSent = false, hostIce = false, dcOpen = false;
    const cands = []; let batchTimer = null;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(deadline); clearTimeout(batchTimer);
      if (err) {
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(relay.write.clientFailure('')); } catch {}
        try { ws && ws.terminate(); } catch {}
        try { dc && dc.close(); } catch {} try { pc && pc.close(); } catch {}
        err.timings = timings; err.clientId = clientId;
        reject(err);
      } else resolve(val);
    };
    const deadline = setTimeout(() => finish(new Error('join timed out after ' + timeoutMs + 'ms')), timeoutMs);
    const sendIce = () => {
      if (iceSent || !answered || done) return;
      iceSent = true; timings.iceSent = Date.now() - t0;
      ws.send(relay.write.iceCandidate('', JSON.stringify(cands.splice(0))));
      maybeSuccess();
    };
    // Relays enforce the client's order: Description -> ICECandidate -> ClientSuccess. Like the
    // browser client, report success only once our candidates are out and the host's arrived.
    const maybeSuccess = () => {
      if (done || timings.success || !dcOpen || !iceSent || !hostIce) return;
      timings.success = Date.now() - t0;
      ws.send(relay.write.clientSuccess(''));
      if (firstMessage) { try { dc.send(firstMessage); } catch {} }
      setTimeout(() => { try { ws.close(); } catch {} }, 1000).unref();
      log(`joined via ${relay.shortName(url)} as ${clientId} in ${timings.success}ms`);
      finish(null, { clientId, pc, dc, timings, close: () => { try { dc.close(); } catch {} try { pc.close(); } catch {} } });
    };
    try { ws = new WebSocket(url, { handshakeTimeout: 8000, perMessageDeflate: false }); }
    catch (e) { return finish(e); }
    ws.binaryType = 'nodebuffer';
    ws.on('error', (e) => finish(new Error('relay socket error: ' + e.message)));
    ws.on('unexpected-response', (req, res) => { const sc = res.statusCode; try { res.destroy(); req.destroy(); } catch {} finish(new Error(`HTTP ${sc}`)); });
    ws.on('close', (c) => { if (!done && !timings.success) finish(new Error(`relay closed the client connection (${c})`)); });
    ws.on('open', () => { timings.open = Date.now() - t0; ws.send(relay.write.handshake(2, 1, code)); });
    ws.on('message', async (data, isBinary) => {
      if (!isBinary || done) return;
      let p; try { p = relay.read(data); } catch (e) { return finish(new Error('malformed relay packet: ' + e.message)); }
      try {
        if (p.type === 'ErrorCode') return finish(Object.assign(new Error(`relay error ${relay.errorName(p.code)}: ${p.desc}`), { relayError: p.code }));
        if (p.type === 'Handshake' && clientId == null) { clientId = p.code; timings.handshake = Date.now() - t0; return; }
        if (p.type === 'ICEServers' && !pc) {
          timings.iceServers = Date.now() - t0;
          pc = new RTCPeerConnection({ iceServers: iceConfig(p.servers.map(relay.iceString)) });
          pc.onicecandidate = (e) => {
            if (!e.candidate || !e.candidate.candidate) return;
            cands.push({ sdpMLineIndex: String(e.candidate.sdpMLineIndex ?? 0), candidate: String(e.candidate.candidate).replace(/^a=/, '') });
          };
          dc = pc.createDataChannel('lan');
          dc.binaryType = 'arraybuffer';
          dc.onopen = () => { dcOpen = true; timings.dcOpen = Date.now() - t0; maybeSuccess(); };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          // Browser-style batching: send our candidates ~2s after gathering starts, re-waiting
          // (max 3 rounds) while new ones keep arriving, and never before the answer is in.
          let rounds = 0, lastCount = -1;
          const tick = () => { if (done) return; rounds++; if ((cands.length !== lastCount && rounds < 3) || !answered) { lastCount = cands.length; batchTimer = setTimeout(tick, answered ? 2000 : 250); return; } sendIce(); };
          batchTimer = setTimeout(tick, 2000);
          const local = pc.localDescription || offer;
          ws.send(relay.write.description('', JSON.stringify({ sdp: local.sdp, type: local.type })));
          return;
        }
        if (p.type === 'Description' && pc) { await pc.setRemoteDescription(JSON.parse(p.description)); answered = true; timings.answer = Date.now() - t0; return; }
        if (p.type === 'ICECandidate' && pc) {
          timings.hostIce = Date.now() - t0;
          for (const c of JSON.parse(p.candidate)) await pc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: parseInt(c.sdpMLineIndex, 10) || 0, sdpMid: '0' }).catch(() => {});
          hostIce = true; maybeSuccess();
        }
      } catch (e) { finish(e); }
    });
  });
}

module.exports = { joinViaRelay };
