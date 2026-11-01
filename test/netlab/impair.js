'use strict';
// UDP link emulator for the network lab. Sits between a WebRTC client and the host and forwards
// datagrams with per-direction delay, jitter, loss (Gilbert model: bursts of losses) and an
// optional bandwidth limit, using a seeded random generator so runs are repeatable.
//
//   const link = await createImpairedLink({ up: {...}, down: {...}, seed: 1 });
//   link.setTarget('192.168.1.5', 51234);   // the host's real ICE candidate
//   // give the client  link.port  (on this machine's address) as the host's candidate
//
// Direction "up" is client -> host, "down" is host -> client. Per direction:
//   delay   one-way base delay, ms              jitter  extra delay, ms (half-normal, keeps order)
//   loss    average loss rate 0..1              burst   mean length of a loss burst, packets (1 = independent)
//   rateKbps bottleneck rate (0 = unlimited)    queueMs tail-drop when the bottleneck queue exceeds this
//   dup     send each datagram twice (the copy dupGapMs later, only datagrams up to dupMaxBytes);
//           lets the lab measure what redundancy would gain
// Delays are timed with a polling loop (not setTimeout), so they are accurate to well under 1 ms
// on every OS (Windows timers only have 15.6 ms resolution).
const dgram = require('node:dgram');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = () => performance.now();

class Direction {
  constructor(opt = {}, rand) {
    this.delay = +opt.delay || 0; this.jitter = +opt.jitter || 0;
    this.loss = Math.min(Math.max(+opt.loss || 0, 0), 0.99); this.burst = Math.max(+opt.burst || 1, 1);
    this.rateKbps = +opt.rateKbps || 0; this.queueMs = opt.queueMs == null ? 200 : +opt.queueMs;
    this.dup = !!opt.dup; this.dupGapMs = opt.dupGapMs == null ? 10 : +opt.dupGapMs;
    this.dupMaxBytes = opt.dupMaxBytes == null ? Infinity : +opt.dupMaxBytes;
    this.rand = rand;
    // Gilbert model: loss only in the bad state; mean burst = 1/r; stationary loss = p/(p+r).
    this.r = 1 / this.burst; this.p = this.loss > 0 ? (this.loss * this.r) / (1 - this.loss) : 0;
    this.bad = false; this.busyUntil = 0; this.lastRelease = 0;
    this.queue = [];   // [releaseTime, buf, send] in release order
    this.later = [];   // copies waiting to be sent: [sendTime, buf, send]
    this.stats = { packets: 0, bytes: 0, lost: 0, queueDrops: 0, delivered: 0, duplicates: 0, dupBytes: 0 };
  }

  _gauss() { // standard normal (Box-Muller)
    const u = 1 - this.rand(), v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  _lost() {
    if (!this.p) return false;
    if (this.bad) { if (this.rand() < this.r) this.bad = false; } else if (this.rand() < this.p) this.bad = true;
    return this.bad;
  }

  push(buf, send) {
    this.stats.packets++; this.stats.bytes += buf.length;
    this._admit(buf, send, now());
    if (this.dup && buf.length <= this.dupMaxBytes) {
      this.stats.duplicates++; this.stats.dupBytes += buf.length;
      // The copy enters the link when it is sent (dupGapMs later), behind what was sent before it,
      // and never holds back packets sent in between.
      if (this.dupGapMs > 0) this.later.push([now() + this.dupGapMs, buf, send]);
      else this._admit(buf, send, now());
    }
  }

  _admit(buf, send, t) {
    if (this._lost()) { this.stats.lost++; return; }
    if (this.rateKbps) {
      const start = Math.max(t, this.busyUntil);
      if (start - t > this.queueMs) { this.stats.queueDrops++; return; }
      this.busyUntil = start + (buf.length * 8) / this.rateKbps; t = this.busyUntil;
    }
    let rel = t + this.delay + (this.jitter ? Math.abs(this._gauss()) * this.jitter : 0);
    rel = Math.max(rel, this.lastRelease); // queues keep packet order
    this.lastRelease = rel;
    this.queue.push([rel, buf, send]);
  }

  due(t) {
    while (this.later.length && this.later[0][0] <= t) { const [st, buf, send] = this.later.shift(); this._admit(buf, send, st); }
    let n = 0;
    while (this.queue.length && this.queue[0][0] <= t) { const [, buf, send] = this.queue.shift(); send(buf); this.stats.delivered++; n++; }
    return n;
  }

  next() { return Math.min(this.queue.length ? this.queue[0][0] : Infinity, this.later.length ? this.later[0][0] : Infinity); }
}

async function createImpairedLink({ up = {}, down = {}, seed = 1, listenHost = '0.0.0.0' } = {}) {
  // One generator per direction: each direction's loss pattern depends only on its own packets.
  const dirs = { up: new Direction(up, mulberry32(seed)), down: new Direction(down, mulberry32(seed + 7919)) };
  let target = null, closed = false, timer = null, spinning = false;
  const front = dgram.createSocket('udp4');
  const backs = new Map(); // client "ip:port" -> socket towards the host

  const pump = () => {
    if (closed) return;
    const t = now();
    dirs.up.due(t); dirs.down.due(t);
    const wait = Math.min(dirs.up.next(), dirs.down.next()) - now();
    spinning = false;
    if (wait === Infinity) return;                       // idle until the next datagram
    if (wait > 20) { timer = setTimeout(pump, wait - 17); return; }
    spinning = true; setImmediate(pump);                 // precise for short waits
  };
  const kick = () => { if (!spinning) { clearTimeout(timer); pump(); } };

  front.on('message', (buf, rinfo) => {
    if (!target) return;
    const key = rinfo.address + ':' + rinfo.port;
    let back = backs.get(key);
    if (!back) {
      back = dgram.createSocket('udp4');
      back.bind(0);
      back.on('message', (b) => { dirs.down.push(b, (x) => front.send(x, rinfo.port, rinfo.address)); kick(); });
      back.on('error', () => {});
      backs.set(key, back);
    }
    dirs.up.push(buf, (x) => back.send(x, target.port, target.address)); kick();
  });
  front.on('error', () => {});
  await new Promise((r) => front.bind(0, listenHost, r));

  return {
    port: front.address().port,
    setTarget(address, port) { target = { address, port }; },
    stats: () => ({ up: { ...dirs.up.stats }, down: { ...dirs.down.stats } }),
    close() { closed = true; clearTimeout(timer); try { front.close(); } catch {} for (const b of backs.values()) try { b.close(); } catch {} },
  };
}

module.exports = { createImpairedLink, mulberry32 };
