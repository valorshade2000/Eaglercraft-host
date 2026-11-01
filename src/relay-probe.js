'use strict';
// Compatibility probe for relays: `node cli.js relays probe`.
// For each relay, using the same host code as the daemon (LANHost/RelayLink):
//   1. register a temporary, hidden test world as a host (type 1 handshake -> join code + ICE list)
//   2. join that code through the same relay as a client (type 2) and open the WebRTC data channel
//   3. send bytes client -> host and host -> client over that channel
// No game world or worker is involved; this only exercises relay routing and WebRTC.

const { LANHost } = require('./lan-host');
const { joinViaRelay } = require('./relay-client');
const relay = require('./relay');

function probeRelay(url, { timeoutMs = 45000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const res = { url, name: relay.shortName(url), registration: null, join: null, data: null, verdict: null, detail: null };
    const t0 = Date.now();
    let channel = null, fromClient = null, hostRef = null, clientConn = null, finished = false;
    const host = new LANHost({
      log: () => {},
      toWorker: (ch, buf) => { if (ch === channel) fromClient = Buffer.from(buf); },
      openPlayerChannel: (ch) => { channel = ch; },
      closePlayerChannel: () => {},
      timings: { backoffBaseMs: 1e9, incompatibleRetryMs: 1e9 },
    });
    hostRef = host;
    const finish = (verdict, detail) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearInterval(poll);
      res.verdict = verdict; res.detail = detail; res.ms = Date.now() - t0;
      try { clientConn && clientConn.close(); } catch {}
      try { hostRef.close(); } catch {}
      log(`${res.name}: ${verdict}${detail ? ' - ' + detail : ''}`);
      resolve(res);
    };
    const deadline = setTimeout(() => finish(res.registration ? 'host-only' : 'unavailable', 'probe timed out'), timeoutMs);
    host.start([url], 'eaglan relay probe', true);
    const link = host.links.get(url);
    let joining = false;
    const poll = setInterval(async () => {
      if (finished) return;
      const s = link.snapshot();
      if (!res.registration && (s.state === 'backoff' || s.state === 'incompatible')) {
        return finish(s.state === 'incompatible' ? 'incompatible' : 'unavailable', s.lastError);
      }
      if (s.state === 'active' && !res.registration) {
        res.registration = { code: s.code, iceServers: s.iceServers, turn: s.turn, ms: Date.now() - t0 };
      }
      if (res.registration && !joining) {
        joining = true;
        try {
          const j = await joinViaRelay(url, res.registration.code, { timeoutMs: 25000 });
          clientConn = j;
          res.join = { clientId: j.clientId, ms: j.timings.success };
          // client -> host
          const waitFor = async (pred, ms) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return pred(); };
          await waitFor(() => channel, 5000);
          j.dc.send(Buffer.from('eaglan-probe-c2s'));
          const c2s = await waitFor(() => fromClient && fromClient.toString() === 'eaglan-probe-c2s', 5000);
          // host -> client
          let got = null; j.dc.onmessage = (e) => { got = Buffer.from(e.data).toString(); };
          host.fromWorker(channel, new TextEncoder().encode('eaglan-probe-s2c').buffer);
          const s2c = await waitFor(() => got === 'eaglan-probe-s2c', 5000);
          res.data = { clientToHost: !!c2s, hostToClient: !!s2c };
          finish(c2s && s2c ? 'compatible' : 'host-only', c2s && s2c ? null : 'data channel did not carry data both ways');
        } catch (e) {
          res.join = { error: e.message };
          finish('host-only', 'registration works but joining failed: ' + e.message);
        }
      }
    }, 100);
  });
}

async function probeRelays(urls, opts = {}) {
  return Promise.all(urls.map((u) => probeRelay(u, opts)));
}

module.exports = { probeRelay, probeRelays };
