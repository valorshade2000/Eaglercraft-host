'use strict';
// Multi-relay hosting tests against local mock relays (deterministic, no internet needed).
//   node --test test/multi-relay.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { MockRelay } = require('./mock-relay');
const { LANHost } = require('../src/lan-host');
const { normalizeRelays, STATE } = require('../src/relay');
const { joinViaRelay } = require('../src/relay-client');

const FAST = {
  connectTimeoutMs: 1500, handshakeTimeoutMs: 1000, iceTimeoutMs: 800,
  backoffBaseMs: 200, backoffMaxMs: 1200, rateLimitMinMs: 1000,
  incompatibleRetryMs: 2500, stableAfterMs: 1500, heartbeatMs: 300, heartbeatTimeoutMs: 400,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(step); }
  return pred();
}

const cleanups = [];
after(async () => { for (const f of cleanups.reverse()) { try { await f(); } catch {} } try { require('node-datachannel').cleanup(); } catch {} });

async function relays(...modes) {
  const rs = [];
  for (const m of modes) { const r = await new MockRelay({ mode: m }).start(); rs.push(r); cleanups.push(() => r.stop()); }
  return rs;
}

// A LANHost with a stand-in for the integrated server: it records which player channels are
// opened and what each channel receives. One LANHost == one world.
function makeHost(urls, extra = {}) {
  const world = { opened: [], closed: [], data: new Map(), logs: [] };
  const host = new LANHost({
    log: (m) => world.logs.push(m),
    toWorker: (ch, buf) => { if (!world.data.has(ch)) world.data.set(ch, []); world.data.get(ch).push(Buffer.from(buf).toString()); },
    openPlayerChannel: (ch) => world.opened.push(ch),
    closePlayerChannel: (ch) => world.closed.push(ch),
    timings: FAST, ...extra,
  });
  host.start(urls, 'Test World', false);
  cleanups.push(() => host.close());
  return { host, world, link: (u) => host.links.get(u), state: (u) => host.links.get(u).state };
}

const conns = [];
cleanups.push(() => { for (const c of conns) c.close(); });
async function join(url, code) { const j = await joinViaRelay(url, code, { timeoutMs: 15000 }); conns.push(j); return j; }

test('1. registers the world on several compatible relays simultaneously', async () => {
  const [a, b, c] = await relays('normal', 'normal', 'normal');
  const { host, link } = makeHost([a.url, b.url, c.url]);
  assert.ok(await waitFor(() => host.activeRelays().length === 3, 5000), 'all three relays active');
  const codes = [a, b, c].map((r) => link(r.url).code);
  assert.equal(new Set(codes).size, 3, 'each relay assigns its own join code');
  for (const r of [a, b, c]) { assert.equal(r.stats.openHosts, 1); assert.equal(r.stats.hostRegistrations, 1); }
});

test('2. players joining through different relays share one host / world', async () => {
  const [a, b] = await relays('normal', 'normal');
  const { host, world, link } = makeHost([a.url, b.url]);
  await waitFor(() => host.activeRelays().length === 2, 5000);
  const ja = await join(a.url, link(a.url).code);
  const jb = await join(b.url, link(b.url).code);
  assert.ok(await waitFor(() => world.opened.length === 2, 8000), 'two player channels opened in the same world');
  assert.notEqual(world.opened[0], world.opened[1]);
  const [cha, chb] = [world.opened.find((c) => c.endsWith(ja.clientId)), world.opened.find((c) => c.endsWith(jb.clientId))];
  assert.ok(cha && chb, 'each player has its own channel');
  ja.dc.send(Buffer.from('from-a')); jb.dc.send(Buffer.from('from-b')); // the client sends binary frames
  assert.ok(await waitFor(() => (world.data.get(cha) || []).includes('from-a') && (world.data.get(chb) || []).includes('from-b')), 'data reaches the shared host on the right channel');
  let gotB = null; jb.dc.onmessage = (e) => { gotB = Buffer.from(e.data).toString(); };
  host.fromWorker(chb, new TextEncoder().encode('to-b').buffer);
  assert.ok(await waitFor(() => gotB === 'to-b'), 'host -> player routing');
  assert.equal(host.playerCount(), 2);
});

test('3. a relay failing during startup does not block the others', async () => {
  const [good, http503] = await relays('normal', 'http-503');
  const dead = 'ws://127.0.0.1:1/'; // nothing listens there
  const { host, link, state } = makeHost([dead, http503.url, good.url]);
  assert.ok(await waitFor(() => state(good.url) === STATE.ACTIVE, 4000), 'working relay becomes active');
  assert.ok(await waitFor(() => link(dead).lastError && link(http503.url).lastError, 4000));
  assert.match(link(dead).lastError, /ECONNREFUSED|connect/i);
  assert.match(link(http503.url).lastError, /HTTP 503/);
  assert.ok([STATE.BACKOFF, STATE.CONNECTING, STATE.HANDSHAKING].includes(state(dead)));
  assert.equal(host.activeRelays().length, 1);
});

test('4a. a relay that disconnects after startup recovers; its connected players stay connected', async () => {
  const [a, b] = await relays('normal', 'normal');
  const { host, world, link, state } = makeHost([a.url, b.url]);
  await waitFor(() => host.activeRelays().length === 2, 5000);
  const ja = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  const ch = world.opened[0];
  const oldCode = link(a.url).code, codeB = link(b.url).code;
  a.dropHosts(); // relay A loses the host registration
  assert.ok(await waitFor(() => state(a.url) !== STATE.ACTIVE, 3000), 'relay A noticed the drop');
  assert.equal(state(b.url), STATE.ACTIVE, 'relay B unaffected');
  assert.equal(link(b.url).code, codeB, 'relay B keeps its code');
  assert.ok(await waitFor(() => state(a.url) === STATE.ACTIVE, 6000), 'relay A re-registered automatically');
  assert.notEqual(link(a.url).code, oldCode, 'relay A issued a new code');
  // The change is reported: the code it replaced, when, and one log line.
  const snapA = link(a.url).snapshot();
  assert.equal(snapA.previousCode, oldCode);
  assert.equal(snapA.codeChangedAt, snapA.activeSince);
  assert.equal(link(b.url).snapshot().previousCode, null, 'relay B: no change');
  assert.ok(world.logs.some((l) => l.includes(`ACTIVE, join code ${snapA.code} (new: ${oldCode} no longer works)`)), 'logged');
  ja.dc.send(Buffer.from('still-here'));
  assert.ok(await waitFor(() => (world.data.get(ch) || []).includes('still-here')), 'player who joined via A is still connected');
  assert.equal(world.closed.length, 0);
});

test('4b. a relay that times out during the handshake is retried with backoff', async () => {
  const [silent, noIce] = await relays('silent', 'no-ice');
  const { link, state } = makeHost([silent.url, noIce.url]);
  assert.ok(await waitFor(() => /timed out/.test(link(silent.url).lastError || ''), 6000), link(silent.url).lastError);
  assert.ok(await waitFor(() => /no ICE server list|timed out/.test(link(noIce.url).lastError || ''), 6000), link(noIce.url).lastError);
  assert.ok([STATE.BACKOFF, STATE.CONNECTING, STATE.HANDSHAKING].includes(state(silent.url)));
});

test('4c. a half-open relay connection (stops answering pings) is detected and replaced', async () => {
  const [a] = await relays('normal');
  const { link, state } = makeHost([a.url]);
  await waitFor(() => state(a.url) === STATE.ACTIVE, 4000);
  await sleep(FAST.heartbeatMs * 2 + 100); // let at least one ping/pong happen
  const code = link(a.url).code;
  a.freezeHosts();
  assert.ok(await waitFor(() => state(a.url) !== STATE.ACTIVE, 4000), 'dead connection detected');
  assert.match(link(a.url).lastError || '', /closed|heartbeat/);
  assert.ok(await waitFor(() => state(a.url) === STATE.ACTIVE && link(a.url).code !== code, 6000), 're-registered');
});

test('4d. a relay that never answers pings is not dropped for it', async () => {
  const [a] = await relays('freeze-after-active');
  const { state } = makeHost([a.url]);
  await waitFor(() => state(a.url) === STATE.ACTIVE, 4000);
  await sleep(FAST.heartbeatMs * 4);
  assert.equal(state(a.url), STATE.ACTIVE);
});

test('5. automatic fallback and reconnection when a relay goes away and comes back', async () => {
  const [a, b] = await relays('normal', 'normal');
  const port = b.port;
  const { host, link, state } = makeHost([a.url, b.url]);
  await waitFor(() => host.activeRelays().length === 2, 5000);
  await b.stop(); // relay B goes offline completely
  assert.ok(await waitFor(() => state(b.url) === STATE.BACKOFF, 3000));
  assert.equal(host.activeRelays().length, 1, 'still reachable via relay A');
  const ja = await join(a.url, link(a.url).code); // joins keep working via A
  assert.ok(ja.clientId);
  const b2 = new MockRelay(); await b2.start(port); cleanups.push(() => b2.stop()); // B is back
  assert.ok(await waitFor(() => state(b.url) === STATE.ACTIVE, 8000), 'relay B recovered');
  assert.equal(b2.stats.openHosts, 1);
  const jb = await join(b.url, link(b.url).code);
  assert.ok(jb.clientId, 'joins via the recovered relay work');
});

test('6. several relays failing while one remains operational', async () => {
  const [good, r503, silent, garbage] = await relays('normal', 'http-503', 'silent', 'garbage');
  const urls = ['ws://127.0.0.1:1/', r503.url, silent.url, garbage.url, good.url];
  const { host, world, link } = makeHost(urls);
  assert.ok(await waitFor(() => host.activeRelays().length === 1, 5000));
  await sleep(1500);
  assert.deepEqual(host.activeRelays().map((r) => r.url), [good.url]);
  await join(good.url, link(good.url).code);
  assert.ok(await waitFor(() => world.opened.length === 1, 8000), 'player joins via the remaining relay');
  assert.ok(world.logs.some((l) => /World reachable via 1\/5 relays/.test(l)));
});

test('7. duplicate relay URLs and invalid configurations', async () => {
  const r = normalizeRelays([
    'wss://relay.example.net/', 'WSS://Relay.Example.NET', 'wss://relay.example.net:443/', '  wss://relay.example.net/  ',
    'https://relay.example.net/', 'not a url', '', '# comment', 'wss://u:p@relay.example.net/', 'ws://127.0.0.1:9/x',
  ]);
  assert.deepEqual(r.relays, ['wss://relay.example.net/', 'ws://127.0.0.1:9/x']);
  assert.equal(r.warnings.filter((w) => /duplicate/.test(w)).length, 3);
  assert.ok(r.warnings.some((w) => /must use wss/.test(w)));
  assert.ok(r.warnings.some((w) => /not a valid URL/.test(w)));
  assert.ok(r.warnings.some((w) => /credentials/.test(w)));
  const many = normalizeRelays(Array.from({ length: 20 }, (_, i) => `wss://r${i}.example/`));
  assert.equal(many.relays.length, 16);
  assert.equal(normalizeRelays('wss://a.example/\n#x\nwss://a.example\nwss://b.example/').relays.length, 2, 'newline-separated text');
  // An empty list is valid: nothing is hosted, nothing crashes.
  const { host } = makeHost([]);
  assert.equal(host.relaySnapshot().length, 0);
  // Unreachable / malformed hosts never throw.
  const { host: h2 } = makeHost(['wss://bad host name/', 'ws://[::1/']);
  await sleep(300);
  assert.ok(h2.relaySnapshot().length >= 0);
});

test('8. incompatible relay handshakes are marked incompatible and only re-checked slowly', async () => {
  const [verr, garbage, badVer, r403] = await relays('version-error', 'garbage', 'bad-version-reply', 'http-403');
  const { link, state } = makeHost([verr.url, garbage.url, badVer.url, r403.url]);
  for (const r of [verr, garbage, badVer, r403]) assert.ok(await waitFor(() => state(r.url) === STATE.INCOMPATIBLE, 4000), r.mode);
  assert.match(link(verr.url).lastError, /PROTOCOL_VERSION/);
  assert.match(link(garbage.url).lastError, /text data/);
  assert.match(link(badVer.url).lastError, /protocol v2/);
  assert.match(link(r403.url).lastError, /HTTP 403/);
  const before = verr.stats.connections;
  await sleep(1500); // shorter than incompatibleRetryMs: no hammering
  assert.equal(verr.stats.connections, before, 'not retried before the re-check interval');
  await waitFor(() => verr.stats.connections > before, 4000);
  assert.ok(verr.stats.connections <= before + 2, 'bounded re-checks');
});

test('9. no duplicate host registrations or player sessions', async () => {
  const [a, b] = await relays('normal', 'normal');
  const { host, world, link, state } = makeHost([a.url, b.url]);
  await waitFor(() => host.activeRelays().length === 2, 5000);
  // Flap relay A several times: at most one registration may ever be open.
  for (let i = 0; i < 4; i++) {
    a.dropHosts();
    assert.ok(await waitFor(() => state(a.url) !== STATE.ACTIVE, 3000), 'drop noticed');
    assert.ok(await waitFor(() => state(a.url) === STATE.ACTIVE, 8000), 're-registered');
  }
  assert.equal(a.stats.peakHosts, 1, 'never two simultaneous registrations on one relay');
  assert.equal(a.stats.openHosts, 1);
  assert.equal(link(a.url).registrations, 5);
  // The same client id issued by two different relays must not collide inside the world.
  a.forceClientId = 'SAMECLIENTID0001'; b.forceClientId = 'SAMECLIENTID0001';
  await join(a.url, link(a.url).code);
  await join(b.url, link(b.url).code);
  assert.ok(await waitFor(() => world.opened.length === 2, 8000));
  assert.equal(new Set(world.opened).size, 2, 'distinct channels for colliding relay client ids');
  // A relay repeating NewClient for an existing id is ignored.
  const before = host.peers.size;
  host._onRelayPacket(link(a.url), { type: 'NewClient', clientId: 'SAMECLIENTID0001' });
  assert.equal(host.peers.size, before);
  // Re-applying the same list does not create new registrations.
  const regs = link(a.url).registrations;
  host.reconfigure([a.url, b.url]);
  await sleep(300);
  assert.equal(link(a.url).registrations, regs);
  assert.equal(a.stats.openHosts, 1);
});

test('10. shutdown closes every relay, cancels pending reconnects and leaves nothing behind', async () => {
  const [a, silent] = await relays('normal', 'silent');
  const dead = 'ws://127.0.0.1:1/';
  const { host, link } = makeHost([a.url, silent.url, dead]);
  await waitFor(() => host.activeRelays().length === 1, 4000);
  await join(a.url, link(a.url).code);
  await waitFor(() => host.playerCount() === 1, 8000);
  const links = [...host.links.values()];
  host.close();
  for (const l of links) { assert.equal(l.state, STATE.STOPPED); assert.equal(l.ws, null); assert.equal(l._timers.size, 0); }
  assert.equal(host.playerCount(), 0);
  await waitFor(() => a.stats.openHosts === 0, 2000);
  assert.equal(a.stats.openHosts, 0, 'relay sees the registration closed');
  const conns = a.stats.connections + silent.stats.connections;
  await sleep(1500); // longer than any backoff in FAST
  assert.equal(a.stats.connections + silent.stats.connections, conns, 'no reconnect attempts after shutdown');
});

test('reconfigure: adding and removing relays at runtime keeps connected players', async () => {
  const [a, b] = await relays('normal', 'normal');
  const { host, world, link, state } = makeHost([a.url]);
  await waitFor(() => state(a.url) === STATE.ACTIVE, 4000);
  const ja = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  host.reconfigure([b.url]); // drop A, add B
  assert.ok(await waitFor(() => state(b.url) === STATE.ACTIVE, 4000));
  assert.equal(host.links.has(a.url), false);
  await waitFor(() => a.stats.openHosts === 0, 2000);
  assert.equal(a.stats.openHosts, 0, 'registration on removed relay closed');
  ja.dc.send(Buffer.from('after-reconfigure'));
  assert.ok(await waitFor(() => (world.data.get(world.opened[0]) || []).includes('after-reconfigure')), 'player stays connected');
});

test('session summary: who ended a session, with the player name and data counters', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url]);
  await waitFor(() => host.activeRelays().length === 1, 4000);
  // 1) The player's client closes the connection.
  const j1 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  host.setPlayerName(world.opened[0], 'Alice');
  j1.dc.send(Buffer.from('hello'));
  await waitFor(() => (world.data.get(world.opened[0]) || []).length === 1);
  j1.close();
  const s1 = await waitFor(() => world.logs.find((l) => /Alice .* left after/.test(l)), 8000);
  assert.ok(s1, 'summary logged');
  assert.match(s1, /the player left \(their client closed the connection\)/);
  assert.match(s1, /received 5 B/);
  assert.match(s1, /path (direct|TURN)/);
  // 2) The server ends a session (e.g. login timeout): the reason is reported.
  const j2 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 2, 8000);
  host.setPlayerName(world.opened[1], 'Bob');
  host.serverClosedChannel(world.opened[1], 'Took too long to log in');
  assert.ok(world.logs.some((l) => /Bob .* left after .*the server ended the session \(Took too long to log in\)/.test(l)));
  j2.close();
  // 3) A client of another game version: its first byte is a packet type the server rejects.
  const j3 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 3, 8000);
  j3.dc.send(Buffer.from([16, 1, 2, 3]));
  await waitFor(() => (world.data.get(world.opened[2]) || []).length === 1);
  host.flagUnreadable(16);
  assert.ok(world.logs.some((l) => /cannot read \(packet type 16\).*different Eaglercraft version/.test(l)));
  assert.equal(world.logs.filter((l) => /packet type 16/.test(l)).length, 1, 'flagged once');
  host.flagUnreadable(16);
  assert.equal(world.logs.filter((l) => /packet type 16/.test(l)).length, 1, 'still once');
});

test('round-trip time: measured for each connected player, in the player list and the leave line', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url]);
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  host.setPlayerName(world.opened[0], 'Carol');
  // Game-like traffic both ways, then wait for the first 5 s sample.
  const tick = setInterval(() => { try { j.dc.send(Buffer.from('x')); host.fromWorker(world.opened[0], Buffer.from('y')); } catch {} }, 50);
  const peer = await waitFor(() => host.peerList().find((p) => p.name === 'Carol' && p.rtt), 15000, 200);
  clearInterval(tick);
  assert.ok(peer, 'rtt reported in the player list');
  assert.ok(peer.rtt.median > 0 && peer.rtt.median < 1000 && peer.rtt.min <= peer.rtt.median && peer.rtt.median <= peer.rtt.max, 'plausible rtt ' + JSON.stringify(peer.rtt));
  assert.ok(['IPv4', 'IPv6'].includes(peer.family), 'address family ' + peer.family);
  j.close();
  const line = await waitFor(() => world.logs.find((l) => /Carol .* left after/.test(l)), 8000);
  assert.match(line, / IPv[46] \| rtt \d+ ms median \(min \d+, max \d+\) \| via /);
});

// The u53 client sends its login packet the moment the host's ICE candidates arrive. Real-client runs
// showed ~1 in 30 joins ending with "Took too long to log in" and 0 bytes received: that first
// packet was lost on the host. Every join here sends its first message at that exact moment.
test('the player\'s first message, sent the instant the join completes, always reaches the world', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url]);
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const lost = [];
  for (let i = 0; i < 10; i++) {
    const j = await joinViaRelay(a.url, link(a.url).code, { timeoutMs: 15000, firstMessage: Buffer.from('login-' + i) });
    conns.push(j);
    const ok = await waitFor(() => [...world.data.values()].some((msgs) => msgs.includes('login-' + i)), 3000);
    if (!ok) lost.push(i);
    j.close();
  }
  assert.deepEqual(lost, [], `first messages lost for joins ${lost.join(', ')}`);
});

// Send small packets twice (src/redundant.js). The test machine's addresses are private, which the
// relay normally skips (it needs a public IP on an interface), so the tests allow them.
const RELAY_OPTS = { allowPrivate: true };
async function freeUdpPort() {
  const s = require('node:dgram').createSocket('udp4');
  await new Promise((r) => s.bind(0, r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}

test('send twice: off by default; switched on, it applies to players who join next', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url]);
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j1 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  const p1 = host.peers.get(world.opened[0]);
  assert.equal(p1.redundant, null, 'no relay when the setting is off');
  assert.equal(host.peerList()[0].sentTwice, null);
  host.setRedundant(RELAY_OPTS);
  const j2 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 2, 8000);
  const p2 = host.peers.get(world.opened[1]);
  assert.ok(p2.redundant && p2.redundantInUse, 'the new player connects through the relay: ' + p2.path);
  assert.equal(p1.redundant, null, 'the player already connected is unchanged');
  j1.dc.send(Buffer.from('p1')); j2.dc.send(Buffer.from('p2'));
  assert.ok(await waitFor(() => (world.data.get(world.opened[0]) || []).includes('p1') && (world.data.get(world.opened[1]) || []).includes('p2')), 'both players connected');
  j1.close();
  const line = await waitFor(() => world.logs.find((l) => /r1-\S+ left after/.test(l)), 8000);
  assert.doesNotMatch(line, /sent twice|send twice/, 'no send-twice note for a player without the relay');
  j2.close();
});

test('send twice: the player talks to the relay port, small packets are copied, each message arrives once', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url], { redundant: RELAY_OPTS });
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 1, 8000);
  const ch = world.opened[0], peer = host.peers.get(ch);
  host.setPlayerName(ch, 'Dana');
  assert.equal(peer.redundantInUse, true, 'connected through the relay: ' + peer.path);
  const cp = j.pc.selectedCandidatePair();
  assert.ok(peer.redundant.snapshot().ports.includes(cp.remote.port), `the player's selected candidate is the relay port (${cp.remote.port})`);
  const got = []; j.dc.onmessage = (e) => got.push(Buffer.from(e.data).toString());
  for (let i = 0; i < 30; i++) { host.fromWorker(ch, Buffer.from('small-' + i)); await sleep(5); }
  host.fromWorker(ch, Buffer.alloc(5000, 'x'));            // sent as ~1200-byte datagrams: not copied
  j.dc.send(Buffer.from('from-player'));
  assert.ok(await waitFor(() => got.length === 31 && (world.data.get(ch) || []).includes('from-player'), 8000), 'messages both ways');
  await sleep(300);                                        // copies arrive 10 ms later: give them time
  assert.equal(got.length, 31, 'every message delivered exactly once');
  assert.deepEqual(got.slice(0, 30), Array.from({ length: 30 }, (_, i) => 'small-' + i), 'in order');
  const st = peer.redundant.snapshot();
  assert.ok(st.copies >= 30 && st.copies < st.toPlayer, `small datagrams copied, others not (${st.copies} copies of ${st.toPlayer} datagrams)`);
  assert.ok(st.copyBytes <= 400 * st.copies, 'only datagrams up to 400 bytes are copied');
  assert.equal(host.peerList()[0].sentTwice, true);
  j.close();
  const line = await waitFor(() => world.logs.find((l) => /Dana .* left after/.test(l)), 8000);
  assert.match(line, /path direct \(send-twice relay\) IPv[46] .*\| small packets sent twice \(\+\d+/);
  assert.equal(peer.redundant.closed, true, 'relay sockets closed with the connection');
});

test('send twice with a fixed UDP port: players share it, and each message arrives once', async () => {
  const port = await freeUdpPort();
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url], { redundant: { ...RELAY_OPTS, port } });
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j1 = await join(a.url, link(a.url).code), j2 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 2, 8000);
  const chs = [j1, j2].map((j) => world.opened.find((c) => c.endsWith(j.clientId)));
  for (const [i, j] of [j1, j2].entries()) {
    const p = host.peers.get(chs[i]);
    assert.equal(p.redundantInUse, true, `player ${i + 1} connected through the relay: ${p.path}`);
    assert.equal(j.pc.selectedCandidatePair().remote.port, port, `player ${i + 1} sends to the fixed port`);
  }
  const got = [[], []];
  [j1, j2].forEach((j, i) => { j.dc.onmessage = (e) => got[i].push(Buffer.from(e.data).toString()); });
  for (let k = 0; k < 20; k++) { host.fromWorker(chs[0], Buffer.from('a-' + k)); host.fromWorker(chs[1], Buffer.from('b-' + k)); await sleep(5); }
  j1.dc.send(Buffer.from('from-1')); j2.dc.send(Buffer.from('from-2'));
  assert.ok(await waitFor(() => got[0].length === 20 && got[1].length === 20 && (world.data.get(chs[0]) || []).includes('from-1') && (world.data.get(chs[1]) || []).includes('from-2'), 8000), 'messages both ways for both players');
  await sleep(300);                                        // copies arrive 10 ms later: give them time
  assert.deepEqual(got[0], Array.from({ length: 20 }, (_, k) => 'a-' + k), "player 1: each message once, in order, none of player 2's");
  assert.deepEqual(got[1], Array.from({ length: 20 }, (_, k) => 'b-' + k), 'player 2: each message once, in order');
  // One player leaves; the other keeps going through the same port.
  j1.close();
  assert.ok(await waitFor(() => world.logs.find((l) => /left after/.test(l)), 8000));
  host.fromWorker(chs[1], Buffer.from('still-here'));
  assert.ok(await waitFor(() => got[1].includes('still-here'), 4000), 'the other player is unaffected');
  j2.close();
});

test('send twice with a fixed UDP port that players cannot reach: they connect as before, reported once after three joins', async () => {
  const { SharedPort } = require('../src/redundant');
  const orig = SharedPort.prototype._dispatch;
  SharedPort.prototype._dispatch = function () {};       // the port drops everything (e.g. a firewall)
  try {
    const port = await freeUdpPort();
    const [a] = await relays('normal');
    const { host, world, link } = makeHost([a.url], { redundant: { ...RELAY_OPTS, port } });
    await waitFor(() => host.activeRelays().length === 1, 4000);
    for (let i = 1; i <= 3; i++) { await join(a.url, link(a.url).code); assert.ok(await waitFor(() => world.opened.length === i, 8000), `player ${i} connected`); }
    assert.match(world.logs.find((l) => /connected via/.test(l)), new RegExp(`send twice not used: nothing from this player reached UDP port ${port}`));
    assert.match(host.redundantUnreached || '', new RegExp(`no player reached UDP port ${port} \\(3 joins in a row\\)`));
    assert.equal(world.logs.filter((l) => /send twice: no player reached UDP port/.test(l)).length, 1, 'reported once');
    for (const ch of world.opened) assert.equal(host.peers.get(ch).redundantInUse, false);
  } finally { SharedPort.prototype._dispatch = orig; }
});

test('a join that does not get in is logged once, with the reason and the kinds of candidates (no addresses)', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url], { handshakeTimeoutMs: 2500 });
  await waitFor(() => host.activeRelays().length === 1, 4000);
  // A player whose join never finishes: it sends its offer but never its ICE candidates.
  const WebSocket = require('ws');
  const { RTCPeerConnection } = require('node-datachannel/polyfill');
  const relayCodec = require('../src/relay');
  const ws = new WebSocket(a.url); ws.binaryType = 'nodebuffer';
  const pc = new RTCPeerConnection({ iceServers: [] });
  cleanups.push(() => { try { ws.terminate(); } catch {} try { pc.close(); } catch {} });
  await new Promise((r) => ws.on('open', r));
  ws.send(relayCodec.write.handshake(2, 1, link(a.url).code));
  pc.createDataChannel('lan');
  await pc.setLocalDescription(await pc.createOffer());
  await sleep(500);
  ws.send(relayCodec.write.description('', JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp })));
  const line = await waitFor(() => world.logs.find((l) => / did not get in after /.test(l)), 8000);
  assert.ok(line, 'failed-join line logged');
  assert.match(line, /: the join timed out \| connection (reached '\w+'|never started) \| player's candidates: (none|\d+ host[^|]*) \| ours: \d+ host/);
  assert.doesNotMatch(line.split(' | via ')[0], /\d+\.\d+\.\d+\.\d+/, 'no IP addresses (the relay name after via is the relay)');
  assert.equal(world.logs.filter((l) => / did not get in after /.test(l)).length, 1, 'logged once');
});

test('send twice on a server without a public address: explained once, players connect as before', { skip: Object.values(require('node:os').networkInterfaces()).flat().some((x) => !x.internal && require('../src/redundant').isPublicIp(x.address)) && 'this machine has a public address' }, async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url], { redundant: {} });
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j1 = await join(a.url, link(a.url).code);
  const j2 = await join(a.url, link(a.url).code);
  await waitFor(() => world.opened.length === 2, 8000);
  const notes = world.logs.filter((l) => /send twice is on, but it cannot be used on this server/.test(l));
  assert.equal(notes.length, 1, 'explained once');
  assert.match(host.redundantUnavailable, /no public address|behind NAT/);
  j1.dc.send(Buffer.from('ok')); 
  assert.ok(await waitFor(() => (world.data.get(world.opened[0]) || []).includes('ok')), 'players connect as before');
  j1.close(); j2.close();
});

test('send twice: if the relay port cannot be reached, the player connects directly as before', async () => {
  const { RedundantSender } = require('../src/redundant');
  const orig = RedundantSender.prototype._fromPlayer;
  RedundantSender.prototype._fromPlayer = function () {};  // the relay port drops everything (e.g. a firewall)
  try {
    const [a] = await relays('normal');
    const { host, world, link } = makeHost([a.url], { redundant: RELAY_OPTS });
    await waitFor(() => host.activeRelays().length === 1, 4000);
    const j = await join(a.url, link(a.url).code);
    await waitFor(() => world.opened.length === 1, 8000);
    const peer = host.peers.get(world.opened[0]);
    assert.equal(peer.redundantInUse, false, 'fell back to the library port: ' + peer.path);
    assert.equal(peer.redundant.closed, true, 'unused relay freed at once');
    j.dc.send(Buffer.from('direct'));
    assert.ok(await waitFor(() => (world.data.get(world.opened[0]) || []).includes('direct')), 'player connected and sending');
    j.close();
    const line = await waitFor(() => world.logs.find((l) => /left after/.test(l)), 8000);
    assert.match(line, /send twice not used for this connection/);
  } finally { RedundantSender.prototype._fromPlayer = orig; }
});

test('player limit: joins above it get the game\'s login refusal with the reason; the world never sees them', async () => {
  const [a] = await relays('normal');
  const { host, world, link } = makeHost([a.url], { playerLimit: 1 });
  await waitFor(() => host.activeRelays().length === 1, 4000);
  const j1 = await join(a.url, link(a.url).code);
  assert.ok(await waitFor(() => world.opened.length === 1, 8000), 'the first player gets in');
  // The second player's join completes, but instead of the world it gets a LOGIN-state Disconnect packet.
  let got = null, closed = false;
  const j2 = await joinViaRelay(a.url, link(a.url).code, { timeoutMs: 15000 }); conns.push(j2);
  j2.dc.onmessage = (e) => { got = Buffer.from(e.data); };
  j2.dc.onclose = () => { closed = true; };
  assert.ok(await waitFor(() => got, 8000), 'the refused player receives a message');
  assert.equal(got[0], 0, 'one whole packet'); assert.equal(got[1], 0x00, 'login Disconnect');
  assert.deepEqual(JSON.parse(got.subarray(3).toString('utf8')), { text: 'This world is full: 1 of 1 players are online. Try again later.' });
  assert.ok(await waitFor(() => closed, 6000), 'and its connection is closed');
  assert.equal(world.opened.length, 1, 'no player channel was opened for it');
  assert.equal(host.refusedFull, 1);
  assert.ok(await waitFor(() => world.logs.find((l) => /did not get in after .*: refused: the world is full \(1 of 1 players\)/.test(l))), 'logged with the reason');
  // A higher limit applies to the next join; players already in the world stay.
  host.setPlayerLimit(2);
  await join(a.url, link(a.url).code);
  assert.ok(await waitFor(() => world.opened.length === 2, 8000), 'the next player gets in');
  assert.equal(host.playerCount(), 2);
  j1.close();
});
