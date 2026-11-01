'use strict';
// Local EaglercraftX relay (protocol v1) for deterministic tests. Follows the behaviour
// observed on real relays (see README "Relay protocol"):
//   host:   Handshake(1,1,"name;hidden") -> Handshake(1,1,code) + ICEServers
//   client: Handshake(2,1,code)          -> Handshake(2,1,clientId) + ICEServers, host gets NewClient
//   client must send Description, then ICECandidate, then ClientSuccess|ClientFailure (enforced
//   like the real relay: out of order -> DisconnectClient(3, ...) to the host)
// Failure modes (mode): normal | silent | garbage | version-error | bad-version-reply | no-ice |
//   http-503 | http-403 | freeze-after-active (stops answering, incl. WebSocket pings)
const http = require('node:http');
const { WebSocketServer } = require('ws');
const relay = require('../src/relay');

const rnd = (n, chars) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

class MockRelay {
  constructor({ mode = 'normal', iceServers = [] } = {}) {
    this.mode = mode; this.iceServers = iceServers;
    this.hosts = new Map();      // code -> { ws, name, hidden, clients:Set }
    this.clients = new Map();    // clientId -> { ws, host, state }
    this.stats = { connections: 0, hostRegistrations: 0, openHosts: 0, peakHosts: 0, joins: 0, outOfOrder: 0 };
    this.sockets = new Set();
  }

  get url() { return `ws://127.0.0.1:${this.port}/`; }

  start(port = 0) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => { res.writeHead(426); res.end('websocket only'); });
      this.wss = new WebSocketServer({ noServer: true });
      this.server.on('upgrade', (req, socket, head) => {
        this.stats.connections++;
        if (this.mode === 'http-503') { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
        if (this.mode === 'http-403') { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
        this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws));
      });
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this); });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const ws of this.sockets) { try { ws.terminate(); } catch {} }
      this.sockets.clear(); this.hosts.clear(); this.clients.clear(); this.stats.openHosts = 0;
      if (!this.server) return resolve();
      this.wss.close(); this.server.close(() => resolve()); this.server.closeAllConnections?.();
    });
  }

  // Abruptly drop every registered host (as a relay restart or network blip would).
  dropHosts() { for (const h of this.hosts.values()) { try { h.ws.terminate(); } catch {} } }

  // Stop processing a host socket without closing it (half-open connection).
  freezeHosts() { for (const h of this.hosts.values()) { try { h.ws._socket.pause(); } catch {} } }

  _onConnection(ws) {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => {});
    if (this.mode === 'silent') return; // accept the socket, never answer
    let role = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close();
      let p; try { p = relay.read(data); } catch { return ws.close(); }
      if (!role) {
        if (p.type !== 'Handshake') return ws.close();
        if (this.mode === 'garbage') { ws.send('this is not a relay'); return; }
        if (this.mode === 'version-error') { ws.send(relay.write.errorCode(1, 'Outdated protocol version')); return ws.close(); }
        if (p.connectionType === 1) { role = 'host'; return this._host(ws, p); }
        if (p.connectionType === 2) { role = 'client'; return this._client(ws, p); }
        if (p.connectionType === 4) { ws.send(relay.write.localWorlds([...this.hosts.entries()].filter(([, h]) => !h.hidden).map(([code, h]) => ({ name: h.name, code })))); return ws.close(); }
        return ws.close();
      }
      if (role === 'host') this._fromHost(ws, p);
      else this._fromClient(ws, p);
    });
  }

  _host(ws, p) {
    const [name, hidden] = String(p.code).split(';');
    if (this.mode === 'bad-version-reply') { ws.send(relay.write.handshake(1, 2, 'abcde')); return; }
    let code; do code = rnd(5, 'abcdefghijklmnopqrstuvwxyz0123456789'); while (this.hosts.has(code));
    const h = { ws, name, hidden: hidden === '1', clients: new Set() };
    this.hosts.set(code, h);
    this.stats.hostRegistrations++; this.stats.openHosts++; this.stats.peakHosts = Math.max(this.stats.peakHosts, this.stats.openHosts);
    ws.send(relay.write.handshake(1, 1, code));
    if (this.mode !== 'no-ice') ws.send(relay.write.iceServers(this.iceServers));
    if (this.mode === 'freeze-after-active') setTimeout(() => { try { ws._socket.pause(); } catch {} }, 50);
    ws.on('close', () => {
      if (this.hosts.get(code) === h) { this.hosts.delete(code); this.stats.openHosts--; }
      for (const cid of h.clients) { const c = this.clients.get(cid); if (c) { try { c.ws.close(); } catch {} } }
    });
  }

  _client(ws, p) {
    const h = this.hosts.get(p.code);
    if (!h) { ws.send(relay.write.errorCode(5, 'Invalid code')); return ws.close(); }
    const clientId = this.forceClientId || rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    const c = { ws, host: h, state: 'handshake', id: clientId };
    this.clients.set(clientId, c); h.clients.add(clientId);
    ws.send(relay.write.handshake(2, 1, clientId));
    ws.send(relay.write.iceServers(this.iceServers));
    h.ws.send(relay.write.newClient(clientId));
    ws.on('close', () => {
      if (this.clients.get(clientId) !== c) return;
      this.clients.delete(clientId); h.clients.delete(clientId);
      if (c.state !== 'done') { try { h.ws.send(relay.write.disconnectClient(clientId, 255, 'End of stream')); } catch {} }
    });
  }

  _fromClient(ws, p) {
    const c = [...this.clients.values()].find((x) => x.ws === ws); if (!c) return;
    const outOfOrder = (want) => {
      this.stats.outOfOrder++;
      try { c.host.ws.send(relay.write.disconnectClient(c.id, 3, `client is in state ${c.state} when it was supposed to be ${want}`)); } catch {}
      c.state = 'done'; ws.close();
    };
    if (p.type === 'Description') { if (c.state !== 'handshake') return outOfOrder('handshake'); c.state = 'description'; c.host.ws.send(relay.write.description(c.id, p.description)); return; }
    if (p.type === 'ICECandidate') { if (c.state !== 'description') return outOfOrder('description'); c.state = 'ice'; c.host.ws.send(relay.write.iceCandidate(c.id, p.candidate)); return; }
    if (p.type === 'ClientSuccess') { if (c.state !== 'ice') return outOfOrder('ice'); c.state = 'done'; this.stats.joins++; c.host.ws.send(relay.write.clientSuccess(c.id)); return; }
    if (p.type === 'ClientFailure') { c.state = 'done'; c.host.ws.send(relay.write.clientFailure(c.id)); c.host.ws.send(relay.write.disconnectClient(c.id, 1, 'Failed connection')); ws.close(); }
  }

  _fromHost(ws, p) {
    const c = this.clients.get(p.peerId != null ? p.peerId : p.clientId);
    if (!c || c.host.ws !== ws) return;
    if (p.type === 'Description') c.ws.send(relay.write.description('', p.description));
    else if (p.type === 'ICECandidate') c.ws.send(relay.write.iceCandidate('', p.candidate));
    else if (p.type === 'DisconnectClient') { c.state = 'done'; c.ws.close(); }
  }
}

module.exports = { MockRelay };
