'use strict';
// Unit tests for the send-twice relay (src/redundant.js): candidate rewriting, STUN corrections,
// forwarding and copying, without WebRTC.   node --test test/redundant.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { RedundantSender, isPublicIp, parseCandidate, rewriteStun, ipBytes } = require('../src/redundant');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGIC = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

// A STUN message signed like an ICE agent signs it (MESSAGE-INTEGRITY with the password, FINGERPRINT).
function stun(type, attrs, password) {
  const tid = crypto.randomBytes(12);
  const header = (len) => { const b = Buffer.alloc(20); b.writeUInt16BE(type, 0); b.writeUInt16BE(len, 2); MAGIC.copy(b, 4); tid.copy(b, 8); return b; };
  let body = Buffer.concat(attrs);
  const mi = crypto.createHmac('sha1', password).update(Buffer.concat([header(body.length + 24), body])).digest();
  body = Buffer.concat([body, Buffer.from([0, 8, 0, 20]), mi]);
  const m = Buffer.concat([header(body.length + 8), body]);
  const fp = Buffer.alloc(8); fp.writeUInt16BE(0x8028, 0); fp.writeUInt16BE(4, 2); fp.writeUInt32BE((zlib.crc32(m) ^ 0x5354554e) >>> 0, 4);
  return Buffer.concat([m, fp]);
}
function attrs(m) { const at = {}; for (let o = 20; o < m.length;) { const t = m.readUInt16BE(o), l = m.readUInt16BE(o + 2); at[t] = o; o += 4 + l + ((4 - (l % 4)) % 4); } return at; }
function valid(m, password) {
  const at = attrs(m), mi = at[0x0008], fp = at[0x8028];
  const c = Buffer.from(m.subarray(0, mi)); c.writeUInt16BE(mi + 24 - 20, 2);
  return crypto.createHmac('sha1', password).update(c).digest().equals(m.subarray(mi + 4, mi + 24)) &&
    ((zlib.crc32(m.subarray(0, fp)) ^ 0x5354554e) >>> 0) === m.readUInt32BE(fp + 4) && m.readUInt16BE(2) === m.length - 20;
}
function xorMapped(address, port) {
  const ab = ipBytes(address), a = Buffer.alloc(8 + ab.length);
  a.writeUInt16BE(0x0020, 0); a.writeUInt16BE(4 + ab.length, 2); a[5] = ab.length === 4 ? 1 : 2; a.writeUInt16BE(port ^ 0x2112, 6);
  return { a, ab };
}
function readMapped(m) {
  const x = attrs(m)[0x0020], key = m.subarray(4, 20), n = m[x + 5] === 1 ? 4 : 16;
  const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = m[x + 8 + i] ^ key[i];
  return { port: m.readUInt16BE(x + 6) ^ 0x2112, bytes: b.toString('hex') };
}
// An ICE check from the player as a browser sends it: USERNAME "<our ufrag>:<theirs>", PRIORITY, signed.
function check(ufrag, password) {
  const u = Buffer.from(ufrag + ':player'), user = Buffer.alloc(4 + u.length + ((4 - (u.length % 4)) % 4));
  user.writeUInt16BE(0x0006, 0); user.writeUInt16BE(u.length, 2); u.copy(user, 4);
  const pr = Buffer.alloc(8); pr.writeUInt16BE(0x0024, 0); pr.writeUInt16BE(4, 2); pr.writeUInt32BE(1845501695, 4);
  return stun(0x0001, [user, pr], password);
}
async function udp(port = 0, address = '127.0.0.1') { const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(port, address, r)); return s; }
async function freePort() { const s = await udp(); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
const sdp = (ufrag, pwd) => `v=0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:${pwd}\r\n`;

test('addresses: only public addresses get a relay port', () => {
  for (const a of ['1.2.3.4', '78.46.170.2', '2a01:4f8::1']) assert.equal(isPublicIp(a), true, a);
  for (const a of ['10.0.0.1', '192.168.1.2', '172.16.5.5', '100.64.0.1', '127.0.0.1', '169.254.1.1', 'fe80::1', 'fd00::1', '::1', 'host.local']) assert.equal(isPublicIp(a), false, a);
  assert.equal(ipBytes('2a01:4f8::1').toString('hex'), '2a0104f8000000000000000000000001');
  assert.equal(ipBytes('::ffff:1.2.3.4').toString('hex'), '00000000000000000000ffff01020304');
});

test('candidates: an extra relay candidate with the original priority, the original one step lower', async () => {
  const rs = new RedundantSender({ allowPrivate: true });
  try {
    const out = await rs.rewrite('a=candidate:1 1 UDP 2122317823 127.0.0.1 40000 typ host');
    assert.equal(out.length, 2);
    const [extra, orig] = out.map(parseCandidate);
    assert.equal(extra.priority, 2122317823); assert.equal(orig.priority, 2122317823 - 256);
    assert.equal(orig.port, 40000); assert.notEqual(extra.port, 40000); assert.notEqual(extra.foundation, orig.foundation);
    assert.ok(out.every((c) => c.startsWith('a=candidate:')));
    // Same candidate again (SDP and trickle): same relay port.
    assert.equal(parseCandidate((await rs.rewrite('candidate:1 1 UDP 2122317823 127.0.0.1 40000 typ host'))[0]).port, extra.port);
    // Not handled: server-reflexive, TCP, mDNS names, private addresses without allowPrivate.
    for (const c of ['candidate:2 1 UDP 1686052607 1.2.3.4 5000 typ srflx raddr 0.0.0.0 rport 0', 'candidate:3 1 TCP 1518280447 1.2.3.4 9 typ host tcptype active', 'candidate:4 1 UDP 2122317823 abc.local 5000 typ host'])
      assert.deepEqual(await rs.rewrite(c), [c]);
    assert.deepEqual(await new RedundantSender().rewrite('candidate:1 1 UDP 2122317823 192.168.1.5 40000 typ host'), ['candidate:1 1 UDP 2122317823 192.168.1.5 40000 typ host']);
    const sdp = await rs.rewriteSdp('v=0\r\na=ice-pwd:pw123\r\na=candidate:1 1 UDP 2122317823 127.0.0.1 40000 typ host\r\n');
    assert.equal(sdp.split('\r\n').filter((l) => l.startsWith('a=candidate:')).length, 2);
    assert.equal(rs.localPwd, 'pw123');
  } finally { rs.close(); }
});

test('why no relay port: only private host candidates, and behind NAT when STUN saw a public address', async () => {
  const rs = new RedundantSender();
  try {
    assert.equal(rs.unavailableReason(), null, 'nothing seen yet');
    await rs.rewrite('candidate:1 1 UDP 2122317823 192.168.1.5 40000 typ host');
    assert.equal(rs.unavailableReason(), 'this server has no public address on its network interfaces');
    await rs.rewrite('candidate:2 1 UDP 1686052607 1.2.3.4 40001 typ srflx raddr 192.168.1.5 rport 40000');
    assert.match(rs.unavailableReason(), /behind NAT/);
  } finally { rs.close(); }
});

test('STUN: mapped address and priority are changed and the message is signed again', () => {
  const { a, ab } = xorMapped('5.6.7.8', 4444); const key = (m) => m.subarray(4, 20);
  let resp = stun(0x0101, [a], 'pw');
  for (let i = 0; i < 4; i++) resp[28 + i] = ab[i] ^ key(resp)[i];        // fill X-Address with the right key
  resp = stun(0x0101, [resp.subarray(20, 32)], 'pw');                      // re-sign with the filled attribute
  const fixed = rewriteStun(resp, 'pw', { mapped: { address: '9.8.7.6', port: 1234 } });
  assert.equal(fixed.length, resp.length);
  assert.ok(valid(fixed, 'pw'), 'MESSAGE-INTEGRITY and FINGERPRINT valid after the change');
  assert.deepEqual(readMapped(fixed), { port: 1234, bytes: '09080706' });
  assert.ok(!valid(rewriteStun(resp, 'wrong', { mapped: { address: '9.8.7.6', port: 1234 } }), 'pw'), 'signed with the given password');
  const pr = Buffer.alloc(8); pr.writeUInt16BE(0x0024, 0); pr.writeUInt16BE(4, 2); pr.writeUInt32BE(1845501695, 4);
  const req = stun(0x0001, [pr], 'pw'), up = rewriteStun(req, 'pw', { priority: 0x7effffff });
  assert.equal(up.readUInt32BE(attrs(up)[0x0024] + 4), 0x7effffff);
  assert.ok(valid(up, 'pw'));
  // Left alone: no password, other message types, DTLS, truncated data.
  assert.equal(rewriteStun(resp, undefined, { mapped: { address: '9.8.7.6', port: 1 } }), resp);
  assert.equal(rewriteStun(req, 'pw', { mapped: { address: '9.8.7.6', port: 1 } }), req);
  const dtls = Buffer.from([23, 254, 253, 0, 1]); assert.equal(rewriteStun(dtls, 'pw', { priority: 1 }), dtls);
  assert.equal(rewriteStun(resp.subarray(0, 30), 'pw', { mapped: { address: '9.8.7.6', port: 1 } }).length, 30);
});

test('forwarding: the player reaches the library through the relay; only small game data is copied', async () => {
  const lib = dgram.createSocket('udp4'); await new Promise((r) => lib.bind(0, '127.0.0.1', r));
  const libGot = [];
  lib.on('message', (b, ri) => {
    libGot.push([b.toString(), ri.port]);
    lib.send(Buffer.concat([Buffer.from([23]), Buffer.alloc(60)]), ri.port, ri.address);   // small game data: copied
    lib.send(Buffer.concat([Buffer.from([23]), Buffer.alloc(600)]), ri.port, ri.address);  // large: once
    lib.send(Buffer.concat([Buffer.from([22]), Buffer.alloc(60)]), ri.port, ri.address);   // DTLS handshake: once
  });
  const rs = new RedundantSender({ allowPrivate: true, copyGapMs: 10 });
  const player = dgram.createSocket('udp4'); await new Promise((r) => player.bind(0, '127.0.0.1', r));
  const got = []; player.on('message', (b, ri) => got.push({ n: b.length, first: b[0], port: ri.port, t: performance.now() }));
  try {
    const out = await rs.rewrite(`candidate:1 1 UDP 2122317823 127.0.0.1 ${lib.address().port} typ host`);
    const front = parseCandidate(out[0]).port;
    rs.addRemote(`candidate:9 1 udp 1686052607 127.0.0.1 ${player.address().port} typ srflx raddr 0.0.0.0 rport 0`);
    await sleep(50);
    assert.equal(got.filter((g) => g.n === 0 && g.port === front).length, 1, 'one zero-length firewall pinhole from the relay port');
    got.length = 0;
    player.send(Buffer.from('hello'), front, '127.0.0.1');
    await sleep(150);
    assert.deepEqual(libGot.map((x) => x[0]), ['hello'], 'forwarded to the library once');
    assert.equal(rs.owns('127.0.0.1', libGot[0][1]), true, 'the library sees the relay socket');
    const small = got.filter((g) => g.first === 23 && g.n === 61);
    assert.equal(small.length, 2, 'small game data sent twice');
    assert.ok(small[1].t - small[0].t >= 8, 'copy sent later');
    assert.equal(got.filter((g) => g.first === 23 && g.n === 601).length, 1, 'large data once');
    assert.equal(got.filter((g) => g.first === 22).length, 1, 'handshake once');
    assert.ok(got.every((g) => g.port === front), 'all replies come from the relay port');
    rs.close();
    await sleep(20); got.length = 0;
    player.send(Buffer.from('after close'), front, '127.0.0.1');
    await sleep(80);
    assert.equal(got.length, 0); assert.equal(libGot.length, 1, 'nothing forwarded after close');
  } finally { rs.close(); lib.close(); player.close(); }
});

test('a check the player did not sign is dropped, not signed again', async () => {
  const lib = await udp(), got = []; lib.on('message', (b) => got.push(b));
  const rs = new RedundantSender({ allowPrivate: true }), player = await udp();
  try {
    await rs.rewriteSdp(sdp('u1', 'goodPassword-123456789'));
    const front = parseCandidate((await rs.rewrite(`candidate:1 1 UDP 2122317823 127.0.0.1 ${lib.address().port} typ host`))[0]).port;
    player.send(check('u1', 'wrong-password'), front, '127.0.0.1');
    player.send(check('u1', 'goodPassword-123456789'), front, '127.0.0.1');
    await sleep(150);
    assert.equal(got.length, 1, 'only the signed check reaches the library');
    assert.ok(valid(got[0], 'goodPassword-123456789'));
    assert.equal(got[0].readUInt32BE(attrs(got[0])[0x0024] + 4), 0x7effffff, 'with the top priority');
    assert.equal(rs.stats.ignored, 1);
  } finally { rs.close(); lib.close(); player.close(); }
});

test('fixed port: players share one UDP port and each reaches only its own connection', async () => {
  const port = await freePort();
  const conn = async (ufrag, pwd) => {
    const lib = await udp(), got = []; lib.on('message', (b, ri) => got.push({ b, ri }));
    const rs = new RedundantSender({ allowPrivate: true, port, idleCloseMs: 150 });
    await rs.rewriteSdp(sdp(ufrag, pwd));
    const out = await rs.rewrite(`candidate:1 1 UDP 2122317823 127.0.0.1 ${lib.address().port} typ host`);
    return { lib, got, rs, out, pwd };
  };
  const A = await conn('ufragA', 'passwordA-123456789'), B = await conn('ufragB', 'passwordB-123456789');
  const pa = await udp(), pb = await udp(), stranger = await udp(), fromPort = [];
  pa.on('message', (b, ri) => fromPort.push({ to: 'a', b, port: ri.port }));
  try {
    assert.equal(parseCandidate(A.out[0]).port, port, 'player A is offered the fixed port');
    assert.equal(parseCandidate(B.out[0]).port, port, 'player B is offered the same port');
    pa.send(check('ufragA', A.pwd), port, '127.0.0.1');
    pb.send(check('ufragB', B.pwd), port, '127.0.0.1');
    await sleep(150);
    assert.equal(A.got.length, 1); assert.equal(B.got.length, 1);
    assert.ok(valid(A.got[0].b, A.pwd) && valid(B.got[0].b, B.pwd), "each check reaches its own connection's library, signed with its password");
    // Later datagrams from a known player address go to that player's connection.
    pa.send(Buffer.from([23, 1]), port, '127.0.0.1'); pb.send(Buffer.from([23, 2]), port, '127.0.0.1');
    await sleep(150);
    assert.deepEqual([...A.got[1].b], [23, 1]); assert.deepEqual([...B.got[1].b], [23, 2]);
    // An unknown address gets nowhere: plain data, or a check that is not signed with the password.
    stranger.send(Buffer.from([23, 9]), port, '127.0.0.1');
    stranger.send(check('ufragA', 'not-the-password'), port, '127.0.0.1');
    stranger.send(check('nobody', 'passwordA-123456789'), port, '127.0.0.1');
    await sleep(150);
    assert.equal(A.got.length, 2); assert.equal(B.got.length, 2);
    // The library's replies reach the player from the fixed port; small game data twice.
    A.lib.send(Buffer.concat([Buffer.from([23]), Buffer.alloc(40)]), A.got[1].ri.port, A.got[1].ri.address);
    await sleep(150);
    assert.equal(fromPort.filter((x) => x.b[0] === 23).length, 2, 'small game data sent twice');
    assert.ok(fromPort.every((x) => x.port === port), 'from the fixed port');
    // One player leaves: the other keeps the port.
    A.rs.close();
    pb.send(Buffer.from([23, 3]), port, '127.0.0.1');
    pa.send(Buffer.from([23, 4]), port, '127.0.0.1');
    await sleep(150);
    assert.deepEqual([...B.got[2].b], [23, 3]); assert.equal(A.got.length, 2, 'nothing for the connection that closed');
    // The last player leaves: the port is closed shortly after.
    B.rs.close();
    await sleep(400);
    const again = await udp(port);
    again.close();
  } finally { A.rs.close(); B.rs.close(); for (const s of [A.lib, B.lib, pa, pb, stranger]) s.close(); }
});

test('fixed port in use by another program: reported, and players connect without it', async () => {
  const blocker = await udp(), port = blocker.address().port;
  const rs = new RedundantSender({ allowPrivate: true, port });
  try {
    const c = 'candidate:1 1 UDP 2122317823 127.0.0.1 40000 typ host';
    assert.deepEqual(await rs.rewrite(c), [c], 'only the original candidate');
    assert.equal(rs.unavailableReason(), `UDP port ${port} cannot be opened (another program is using it)`);
  } finally { rs.close(); blocker.close(); }
});

test('behind NAT with a fixed port: the public address from STUN is offered with that port', async () => {
  const port = await freePort();
  const lib = await udp(), got = []; lib.on('message', (b, ri) => got.push({ b, ri }));
  const rs = new RedundantSender({ port, idleCloseMs: 150 });  // no allowPrivate: like a server behind NAT
  const player = await udp(), back = []; player.on('message', (b, ri) => back.push({ b, port: ri.port }));
  try {
    await rs.rewriteSdp(sdp('natU', 'natPassword-123456789'));
    rs.addRemote(sdp('player', 'playerPassword-123456789'));
    const host = `candidate:1 1 UDP 2122317823 127.0.0.1 ${lib.address().port} typ host`;
    const srflx = `candidate:6 1 UDP 1678768895 203.0.113.7 ${lib.address().port} typ srflx raddr 0.0.0.0 rport 0`;
    const out = (await rs.rewriteList([{ candidate: host }, { candidate: srflx }])).map((x) => x.candidate);
    assert.equal(out.length, 3); assert.equal(out[0], host, 'the private host candidate is unchanged');
    const extra = parseCandidate(out[1]), orig = parseCandidate(out[2]);
    assert.deepEqual([extra.address, extra.port, extra.type, extra.priority], ['203.0.113.7', port, 'srflx', 1678768895], 'public address, fixed port');
    assert.deepEqual([orig.port, orig.priority], [lib.address().port, 1678768895 - 256], 'the original one step lower');
    assert.equal(rs.unavailableReason(), null);
    // The forwarded port arrives at this server's own address: the relay listens on all of them.
    player.send(check('natU', 'natPassword-123456789'), port, '127.0.0.1');
    await sleep(150);
    assert.equal(got.length, 1, "the player's check reaches the library");
    // The library's own check through the relay, and the player's signed reply: the library is told
    // its own host address (not the public one), so it does not invent a new local candidate.
    const { a, ab } = xorMapped('203.0.113.7', port);
    let reply = stun(0x0101, [a], 'playerPassword-123456789');
    for (let i = 0; i < 4; i++) reply[28 + i] = ab[i] ^ reply.subarray(4, 20)[i];
    reply = stun(0x0101, [reply.subarray(20, 32)], 'playerPassword-123456789');
    player.send(reply, port, '127.0.0.1');
    await sleep(150);
    assert.equal(got.length, 2);
    assert.deepEqual(readMapped(got[1].b), { port: lib.address().port, bytes: '7f000001' }, "mapped to the library's host candidate");
    assert.ok(valid(got[1].b, 'playerPassword-123456789'));
    // Without a fixed port the server-reflexive candidate is left alone, as before.
    const rs2 = new RedundantSender();
    assert.deepEqual(await rs2.rewrite(srflx), [srflx]); rs2.close();
  } finally { rs.close(); lib.close(); player.close(); }
});
