'use strict';
// The equivalence harness inside the host (daemon.js loads it when EAGLAN_HARNESS is set; test/harness/run.js starts the
// host that way). The game runs one tick per step on a clock of its own, with seeded random numbers (worker-runtime.js).
// Its players are protocol-level clients in this process (test/bench/bot.js) instead of WebRTC peers, and what they send
// reaches the game between two ticks, in a fixed order. So a run gives the same result every time, and two runs that
// differ only in a setting can be compared tick by tick (compare.js). Written to the output folder:
//   ticks.jsonl          one line per tick: the hash of the game's state (game-patches.js "harness state") and, per
//                        player, how many packets it got in that tick and the hash of their bytes (decompressed, as the
//                        client reads them); ms: how long the step took (real time)
//   states/<tick>.json   the whole state, every EAGLAN_HARNESS_DUMP_EVERY ticks
//   packets/<player>.bin every packet, with EAGLAN_HARNESS_PACKETS=1: [u32 tick][u32 length][bytes]
//   world.json           each file of the world after the last save: the hash of its content (decompressed)
//   result.json          ok or the error, ticks, the scenario's own results
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Bot } = require('../bench/bot');
const { WORLDS_DB } = require('../../src/worlds');

function varint(n) { const b = []; n >>>= 0; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); }
const str = (s) => { const u = Buffer.from(String(s), 'utf8'); return Buffer.concat([varint(u.length), u]); };
const dbl = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const flt = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const frame = (id, ...parts) => Buffer.concat([Buffer.from([0]), varint(id), ...parts]);
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
// a line of the console's output as text: a translation key with its arguments as key(arg,...)
const text = (o) => !o ? '' : (o.t !== undefined ? o.t : o.k + (o.a && o.a.length ? '(' + o.a.map(text).join(',') + ')' : '')) + (o.s ? o.s.map(text).join('') : '');

// d: { log, step(ms), call(fn, arg, ms), save(), pendingPackets(), shutdown(reason, code), dbFile, world, out, scenario, args }
function setup(d) {
  const out = path.resolve(d.out || 'harness-out');
  fs.mkdirSync(path.join(out, 'states'), { recursive: true });
  const keepPackets = process.env.EAGLAN_HARNESS_PACKETS === '1';
  if (keepPackets) fs.mkdirSync(path.join(out, 'packets'), { recursive: true });
  const ticksFd = fs.openSync(path.join(out, 'ticks.jsonl'), 'w');
  const players = [], byCh = new Map();   // in the order they joined
  const queued = [];                       // [channel, frame]: what the clients sent since the last step, in order
  let net = null, waiter = null, tick = 0;

  // In place of lan-host.js: no relays; a player's frames from the game wait in its inbox until the end of the tick.
  function lan(cb) {
    net = cb;
    return {
      start() {}, close() {}, reconfigure() {}, setRedundant() {}, setPlayerLimit() {}, flagUnreadable() {}, setPlayerName() {},
      relaySnapshot: () => [], activeRelays: () => [], links: new Map(), refusedFull: 0, redundantUnavailable: null,
      peerList: () => players.filter((p) => !p.gone).map((p) => ({ channel: p.ch, name: p.name })),
      playerCount: () => players.filter((p) => !p.gone).length,
      fromWorker(ch, buf) { const p = byCh.get(ch); if (!p || p.gone) return false; p.inbox.push(Buffer.from(buf)); return true; },
      serverClosedChannel(ch, reason) { const p = byCh.get(ch); if (p && !p.gone) p.gone = reason || 'closed by the server'; },
    };
  }

  function onTick(m) {
    if (m.state) fs.writeFileSync(path.join(out, 'states', `${m.tick}.json`), m.state);
    const w = waiter; waiter = null;
    if (w) w(m); else d.log(`harness: tick ${m.tick} was not asked for`);
  }

  // One tick: the clients' packets of this tick go to the game, the game's clock moves 50 ms, and once the tick is over
  // (and every packet of it has reached its player: multi-core mode compresses large ones on the pool) the clients read
  // what came, in the order they joined; their answers go to the game in the next step.
  async function step() {
    const t0 = process.hrtime.bigint();
    for (const p of players) {
      if (p.gone || p.bot.state !== 'play' || !p.bot.spawn) continue;
      if (p.next) { const [x, y, z, ground] = p.next; p.next = null; p.bot.pos = [x, y, z]; p.bot._send(frame(0x04, dbl(x), dbl(y), dbl(z), Buffer.from([ground ? 1 : 0]))); }
      else p.bot._send(frame(0x03, Buffer.from([1])));   // a client that does not move: one packet per tick
    }
    for (const [ch, buf] of queued.splice(0)) net.toWorker(ch, buf);
    const done = new Promise((r) => { waiter = r; });
    d.step(50);
    const m = await done;
    while (d.pendingPackets() > 0) await new Promise((r) => setImmediate(r));
    tick = m.tick;
    const rec = { tick, state: m.hash, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100, game: m.gameMs, players: {} };
    for (const p of players) {
      if (p.gone && !p.inbox.length) continue;
      p.hash = crypto.createHash('sha1'); p.count = 0;
      for (const f of p.inbox.splice(0)) p.bot._onFrame(f);
      rec.players[p.name] = [p.count, p.count ? p.hash.digest('hex').slice(0, 16) : ''];
    }
    fs.writeSync(ticksFd, JSON.stringify(rec) + '\n');
  }

  function addPlayer(name) {
    const ch = 'h-' + name, bot = new Bot({ name, relayUrl: 'harness', code: 'harness' });
    const p = { name, ch, bot, inbox: [], gone: null, next: null, hash: null, count: 0, fd: keepPackets ? fs.openSync(path.join(out, 'packets', name + '.bin'), 'w') : null };
    bot._idle = () => {}; bot.stand = () => {}; bot.go = () => {};   // no timers: the harness sends its packets each tick
    bot.conn = { dc: { send: (b) => { if (!p.gone) queued.push([ch, Buffer.from(b)]); } }, close() {} };
    bot.state = 'login';
    const read = bot._onPacket.bind(bot);
    bot._onPacket = (pk) => {
      p.count++; if (p.hash) p.hash.update(pk);
      if (p.fd !== null) { const h = Buffer.alloc(8); h.writeUInt32BE(tick, 0); h.writeUInt32BE(pk.length, 4); fs.writeSync(p.fd, h); fs.writeSync(p.fd, pk); }
      read(pk);
    };
    players.push(p); byCh.set(ch, p);
    net.openPlayerChannel(ch);
    // the login packet the u53 client sends (name, skin and cape preset 0), as bot.js joins
    queued.push([ch, frame(0x00, str(name), varint(5), Buffer.from([1, 0, 0, 0, 0]), varint(5), Buffer.from([1, 0, 0, 0, 0]))]);
    return p;
  }
  // What a scenario does with a player.
  const handle = (p) => ({
    name: p.name, bot: p.bot,
    get gone() { return p.gone; },
    say: (text) => p.bot.say(text),                                         // chat, or a command with "/"
    move: (x, y, z, ground = true) => { p.next = [x, y, z, ground]; },      // its position in the next tick (C04)
    attack: (eid) => p.bot._send(frame(0x02, varint(eid), varint(1))),     // Use Entity: attack
    use: (eid) => p.bot.useEntity(eid),                                     // Use Entity: interact (boat, minecart)
    send: (buf) => p.bot._send(buf),
    leave: () => { if (!p.gone) { p.gone = 'left'; net.closePlayerChannel(p.ch); } },
  });

  const h = {
    args: d.args || {}, log: d.log, out, result: {},
    phase: Number(process.env.EAGLAN_HARNESS_PHASE || 1),   // run.js --phases: 2 after a restart on the saved world
    get tick() { return tick; },
    async steps(n = 1) { for (let i = 0; i < n; i++) await step(); },
    // a player who joins; it is in the world once it has its position (at most maxTicks ticks)
    async join(name, { maxTicks = 400 } = {}) {
      const p = addPlayer(name);
      for (let i = 0; i < maxTicks && !(p.bot.state === 'play' && p.bot.spawn); i++) await step();
      if (!p.bot.spawn) throw new Error(`${name} did not get into the world within ${maxTicks} ticks (${p.gone || p.bot.stats.kicked || p.bot.state})`);
      return handle(p);
    },
    // a console command: it runs at the start of the next tick (await h.steps(1), or use command()); lines: its output
    cmd: (c) => d.call('console', c, 600000).then((r) => ({ ...r, lines: (r.out || []).map(text) })),
    async command(c) { const r = h.cmd(c); await step(); return r; },
    // a CPU profile of the game thread for `seconds` (real time) from now, written to file (node --cpu-prof format)
    profile: (file, seconds = 15) => d.call('cpuProfile', { seconds, file: path.resolve(file) }, 10000),
    // a call to the game's worker (worker-runtime.js hostCall), e.g. call('pregen', { action: 'start', ... })
    call: (name, arg, ms = 60000) => d.call(name, arg, ms),
    frame, varint, str, dbl, flt,
  };

  // The end of a run: every player leaves (the server logs them out and writes their files), then the world is saved
  // the way the host's "Save now" does (every chunk, level.dat, players; committed), and each file's hash written.
  async function dumpWorld() {
    for (const p of players) if (!p.gone) { p.gone = 'left'; net.closePlayerChannel(p.ch); }
    await h.steps(5);
    await d.save();
    const db = new (require('node:sqlite').DatabaseSync)(d.dbFile, { readOnly: true });
    try {
      const base = `worlds/${d.world}/`, files = {};
      for (const row of db.prepare('SELECT path, data FROM files WHERE db = ? AND path LIKE ?').all(WORLDS_DB, base + '%')) {
        let b = Buffer.from(row.data);
        if (b[0] === 0x1f && b[1] === 0x8b) { try { b = zlib.gunzipSync(b); } catch {} }
        files[row.path.slice(base.length)] = crypto.createHash('sha1').update(b).digest('hex');
      }
      fs.writeFileSync(path.join(out, 'world.json'), JSON.stringify(sortKeys(files), null, 1));
      return Object.keys(files).length;
    } finally { db.close(); }
  }

  async function start() {
    const t0 = Date.now();
    try {
      await require(path.resolve(d.scenario))(h);
      const files = await dumpWorld();
      const sp = await d.call('speedups', {}, 10000).catch(() => null);
      const summary = { ok: true, ticks: tick, files, realMs: Date.now() - t0, players: players.map((p) => ({ name: p.name, gone: p.gone, kicked: p.bot.stats.kicked, deaths: p.bot.stats.deaths, frames: p.bot.stats.frames })), result: h.result, speedups: sp && sp.status };
      fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 1));
      d.log(`harness: scenario done: ${tick} ticks in ${((Date.now() - t0) / 1000).toFixed(1)} s; the world has ${files} files`);
      fs.closeSync(ticksFd); for (const p of players) if (p.fd !== null) fs.closeSync(p.fd);
      d.shutdown('equivalence harness finished', 0);
    } catch (e) {
      fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: String((e && e.stack) || e), ticks: tick, result: h.result }, null, 1));
      d.log('harness: the scenario failed: ' + ((e && e.stack) || e));
      d.shutdown('equivalence harness failed', 1);
    }
  }

  return { lan, onTick, start };
}

module.exports = { setup };
