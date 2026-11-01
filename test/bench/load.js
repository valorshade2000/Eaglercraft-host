'use strict';
// Repeatable game-server load test: the real host (daemon, integrated server, WebRTC) on a local
// mock relay, with N protocol-level players (test/bench/bot.js) moving along fixed paths. Reports
// what players feel as lag: game tick times, "Can't keep up!" lines, how busy the game thread was,
// garbage collection, and how many chunks were generated. One run per process, in a throwaway
// data directory; nothing outside it is touched.
//
//   node test/bench/load.js --make-template <file.sqlite> [--seed 12345] [--pregen <blocks>]
//       creates a world (and pre-generates it), saves it and keeps its database as a template
//   node test/bench/load.js --world <file.sqlite> --bots 12 --explorers 3 --seconds 120 [--out r.json]
//       loads a copy of the template, joins the bots, measures
//
// Paths: explorers fly round a circle of --radius blocks (default 400) around spawn at --speed
// blocks/s (default 8, a boat), each starting at its own point, so each one keeps reaching terrain
// nobody has loaded; the other bots fly round small circles near spawn at walking speed.
// Options: --view <chunks> (default 4), --disk-sync full|normal, --young <MB> (worker young
// generation, EAGLAN_DEBUG_YOUNG_MB), --warmup <s> (default 20), --join-gap <ms> (default 1500),
// --autosave spread|game (config spreadAutosave; default spread, as the host's default),
// --cap <players> (player limit), --pregen-during <blocks> [--pregen-rate <chunks/s>] (a pre-generation
// running during the measured time), --label <text>, --keep (keep the data directory),
// --profile <file.cpuprofile> (a CPU profile of the game thread during the first --profile-seconds,
// default 100, of the measured time), --multicore on|off (config multiCore; default off),
// --workers <n> (config multiCoreWorkers), --host-cpus <n> (the host on the first n CPUs only, as on a smaller server; this test's own players
// and relay on the other CPUs), --terrain <n> (config terrainThreads), --terrain-verify (config terrainVerify), --terrain-players
// (config terrainForPlayers),
// --pregen-fast on|off (config pregenFastWhenEmpty; default: the host's default, on), --mobs <z>,<v>,<a>[,<s>,<c>,<p>,<i>]
// (an arena of mobs above spawn, in every player's view: z zombies chasing v invulnerable villagers, which flee, and a
// animals; optionally s skeletons, c creepers, p spiders and i dropped items that never despawn; night kept; built during
// the warmup; for profiling entities), --mobs-only (before the arena: every entity but the players removed and natural
// spawning off, so the arena's counts are the world's entities; with --players-still no chunk loads later), --players-still
// (the players who are not exploring stay where they start, on their circle round their group), --speedups <list|none|all>
// (which of chunkCache, uuidText,
// packetBatch, longConstants, lightSets are on; EAGLAN_DEBUG_SPEEDUPS), --speedups-verify (EAGLAN_DEBUG_SPEEDUPS_VERIFY),
// --collision-scan (speedup 6, off by default: config collisionScan; with --speedups, added to the list).
// --host-cores <n>: the host on n whole cores, one logical CPU of each (0, 2, 4, ...: Windows numbers the two logical
// CPUs of a core next to each other), this test's players and relay on the cores left over; --host-cpu-list <a,b,..> and
// --players-cpu-list name the CPUs themselves. The result has the busy share of every logical CPU in the measured time.
// --groups <g> --group-offset <blocks>: the players who are not exploring in g groups round points that far from spawn
// (on a circle, the first at 45 degrees), each group with its own --mobs arena; --group-center <dx,dz>: one group there.
// --repeat-command '<cmd>|<cmd>': console commands run in turn, one after the other, for the whole measured time.
// --regions on (config regions), --region-instances <n> (config regionInstances), --rejoin <s>: once all players are
// at their paths' starts they leave, and join again s seconds later (where they join is decided by where they were).
// With regions, the arenas are built and the entities counted in each player group's own instance (execute <player>).
// --traveler <s>: one more player, Traveler, who during the measured time goes back and forth every s/2 seconds between
// the first group (above its arena) and 800 blocks east of spawn, far from every group (with regions: it is moved to an
// instance of its own when far, and into the first group's instance when back; what that costs the others). Its first
// trip, into terrain the world does not have yet, is made 10 s before the measured time (in both kinds of run).
// With --make-template and --pregen, the host's load and memory are sampled every 5 s while the job runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2), v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } }
}
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-bench-'));
process.env.EAGLAN_DATA = dataDir;
if (args.young) process.env.EAGLAN_DEBUG_YOUNG_MB = String(args.young);
if (args.profile) process.env.EAGLAN_DEBUG = '1';   // the host's /debug/cpu-profile
if (args.speedups) process.env.EAGLAN_DEBUG_SPEEDUPS = (args.speedups === 'all' ? 'chunkCache,uuidText,packetBatch,longConstants,lightSets' : args.speedups === 'none' ? '' : String(args.speedups)) + (args['collision-scan'] ? ',collisionScan' : '');
if (args['speedups-verify']) process.env.EAGLAN_DEBUG_SPEEDUPS_VERIFY = '1';
if (args['host-cpus']) {
  const n = num('host-cpus', 0), all = os.cpus().length;
  if (!(n >= 1 && n < all)) { console.error(`--host-cpus must be 1-${all - 1}`); process.exit(2); }
  process.env.EAGLAN_DEBUG_CPU_MASK = ((1 << n) - 1).toString(16);
  require('../../src/cpu').pinToCpus(((1 << all) - 1) & ~((1 << n) - 1));   // the players and the relay: the other CPUs
}
// --host-cores / --host-cpu-list: whole cores for the host (see the top).
let hostCpuList = null, playersCpuList = null;
if (args['host-cores'] || args['host-cpu-list']) {
  const all = os.cpus().length, list = (s) => String(s).split(',').map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < all);
  hostCpuList = args['host-cpu-list'] ? list(args['host-cpu-list']) : Array.from({ length: num('host-cores', 1) }, (_, i) => 2 * i).filter((i) => i < all);
  const lastCore = Math.max(...hostCpuList) >> 1;
  playersCpuList = args['players-cpu-list'] ? list(args['players-cpu-list']) : Array.from({ length: all }, (_, i) => i).filter((i) => (i >> 1) > lastCore);
  if (!hostCpuList.length || !playersCpuList.length || hostCpuList.some((i) => playersCpuList.includes(i))) { console.error('--host-cores / --host-cpu-list: no CPUs left for the players'); process.exit(2); }
  const mask = (l) => l.reduce((m, i) => m + 2 ** i, 0);
  process.env.EAGLAN_DEBUG_CPU_MASK = mask(hostCpuList).toString(16);
  require('../../src/cpu').pinToCpus(mask(playersCpuList));
}
const c = require('../../src/control');
const { MockRelay } = require('../mock-relay');
const { Bot } = require('./bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const logTime = (l) => Date.parse((/^\[([^\]]+)\]/.exec(l) || [])[1]);
async function waitFor(fn, ms, step = 500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
async function ctl(p, method = 'GET') { const st = await c.status(); return new Promise((resolve, reject) => require('node:http').request({ host: '127.0.0.1', port: st.controlPort, path: p, method }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject).end()); }

// Sum of the per-second chunk counters the game reports ("R: read, G: generated, W: written").
const chunkCounts = { R: 0, G: 0, W: 0, seconds: 0 };
let lastTps = null;
async function pollTps() {
  try {
    const st = await c.status(); const line = (st.tps || []).find((x) => /^R: /.test(x));
    if (line && line !== lastTps) { lastTps = line; for (const m of line.matchAll(/([RGW]): (\d+)/g)) chunkCounts[m[1]] += +m[2]; chunkCounts.seconds++; }
  } catch {}
}

// Regions: the measured time per instance (windows of region instances have instance: id; the main one's none).
function perInstance(windows, from, to) {
  const ids = [...new Set(windows.map((w) => w.instance || 0))].sort((a, b) => a - b);
  return ids.map((id) => { const s = summarize(windows.filter((w) => (w.instance || 0) === id), from, to); return { id, ticks: s.ticks, tps: s.tps, tickMs: s.tickMs, lateMs: s.lateMs, busyPct: s.busyPct }; });
}
function summarize(windows, from, to) {
  const ws = windows.filter((w) => w.t > from + 5000 && w.t <= to + 1000);
  const ticks = []; let gcMs = 0, maxGc = 0, writes = 0, writeMs = 0, busy = [];
  for (const w of ws) { if (w.ticks) ticks.push(...w.ticks.list); gcMs += w.gc.ms; maxGc = Math.max(maxGc, w.gc.maxMs); writes += w.storage.writes; writeMs += w.storage.ms; busy.push(w.busy); }
  const secs = ws.length * 5;
  const s = [...ticks].sort((a, b) => a - b);
  const pct = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  const over = (ms) => ticks.filter((v) => v > ms).length;
  return {
    seconds: secs, ticks: ticks.length, tps: secs ? Math.round((ticks.length / secs) * 10) / 10 : null,
    tickMs: { mean: ticks.length ? Math.round((ticks.reduce((a, b) => a + b, 0) / ticks.length) * 10) / 10 : null, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: s.length ? s[s.length - 1] : null },
    ticksOver: { 50: over(50), 100: over(100), 250: over(250), 1000: over(1000) },
    // Time the game thread spent in ticks longer than 50 ms beyond the 50 ms each may take: how far it fell behind.
    lateMs: Math.round(ticks.reduce((a, v) => a + Math.max(0, v - 50), 0)),
    busyPct: busy.length ? Math.round(busy.reduce((a, b) => a + b, 0) / busy.length) : null, busyMaxPct: busy.length ? Math.max(...busy) : null,
    gcMsPerMin: secs ? Math.round((gcMs / secs) * 60) : null, gcMaxMs: maxGc, writes, writeMs,
  };
}

// A failure stops the host it started too (finish), so that no host is left running.
let onFail = null;
(async () => {
  const relay = await new MockRelay().start();
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  const cfg = { viewDistance: num('view', 4), diskSync: args['disk-sync'] || 'full', lanGamemode: 0 };
  if (args.cap) cfg.playerLimit = num('cap', 0);
  cfg.spreadAutosave = args.autosave !== 'game';
  cfg.multiCore = args.multicore === 'on';
  if (args.workers) cfg.multiCoreWorkers = num('workers', 0);   // --workers n: fewer pool threads
  if (args.terrain) cfg.terrainThreads = num('terrain', 0);     // terrain threads for pre-generation
  if (args['terrain-verify']) cfg.terrainVerify = true;
  if (args['terrain-players']) cfg.terrainForPlayers = true;   // and for the chunks players are about to reach
  if (args['collision-scan']) cfg.collisionScan = true;          // speedup 6 (stage 6)
  if (args['pregen-fast']) cfg.pregenFastWhenEmpty = args['pregen-fast'] !== 'off';
  if (args.regions) cfg.regions = args.regions === 'on';
  if (args['region-instances'] !== undefined) cfg.regionInstances = num('region-instances', 0);
  c.saveConfig(cfg);
  const out = { label: args.label || null, args, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, hostCpus: args['host-cpus'] ? num('host-cpus', 0) : null, hostCpuList, playersCpuList, node: process.version, platform: process.platform }, startedAt: new Date().toISOString() };
  const finish = async (code) => {
    try { await c.stop(); } catch {}
    await relay.stop();
    try { require('node-datachannel').cleanup(); } catch {}
    if (!args.keep) fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
  };
  onFail = finish;

  if (args['make-template']) {
    // A world to start load tests from: created with a fixed seed, saved; optionally pre-generated.
    await c.create({ name: 'Bench World', seed: String(args.seed || '12345') });
    const st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s; }, 300000);
    if (!st) { console.error('the world did not start'); return finish(1); }
    await sleep(num('settle', 20) * 1000);
    if (args.pregen) {
      const r = await c.consoleCommand(`pregen start ${args.pregen}${args['pregen-rate'] ? ' ' + args['pregen-rate'] : ''}`, { allowOp: true });
      console.log(r.lines.join('\n'));
      const t0 = Date.now(), samples = []; let lastSample = 0;
      const done = await waitFor(async () => {
        const s = await c.status();
        if (s.pregen && Date.now() % 30000 < 600) console.log('pregen', JSON.stringify(s.pregen), s.terrain ? 'terrain ' + JSON.stringify(s.terrain) : '');
        if (s.hostLoad && s.hostLoad.at !== lastSample && s.pregen && s.pregen.running) { lastSample = s.hostLoad.at; samples.push({ ...s.hostLoad, ticks: s.gameServer && s.gameServer.ticks, gs: s.gameServer ? { gcMsPerMin: s.gameServer.gcMsPerMin, maxGcMs: s.gameServer.maxGcMs, writeMsPerMin: s.gameServer.writeMsPerMin, maxWriteMs: s.gameServer.maxWriteMs } : null }); }
        return s.pregen && !s.pregen.running && s.pregen.done && !s.pregen.loadedNow && !s.pregen.pendingLights ? s.pregen : null;
      }, num('pregen-timeout', 7200) * 1000, 500);
      const avg = (k) => (samples.length ? Math.round((samples.reduce((a, x) => a + (x[k] || 0), 0) / samples.length) * 10) / 10 : null);
      out.load = { samples: samples.length, cpuPct: avg('cpu'), gameBusyPct: avg('gameBusy'), rssMbMean: avg('rssMb'), rssMbMax: samples.length ? Math.max(...samples.map((x) => x.rssMb)) : null, gameHeapMbMax: samples.length ? Math.max(...samples.map((x) => x.gameHeapMb || 0)) : null, all: samples };
      out.terrain = (await c.status()).terrain || null;
      console.log(`load while it ran: CPU ${out.load.cpuPct}% of a core, game thread ${out.load.gameBusyPct}% busy, RSS ${out.load.rssMbMean} MB (max ${out.load.rssMbMax})`, out.terrain ? 'terrain ' + JSON.stringify(out.terrain) : '');
      console.log(`pre-generation ${done ? 'finished' : 'did NOT finish'} in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(done || (await c.status()).pregen)}`);
      out.pregen = done; out.pregenSeconds = Math.round((Date.now() - t0) / 1000);
    }
    await c.stop();
    // A consistent copy of the database, including what is still in its write-ahead log.
    const dest = path.resolve(args['make-template']); fs.rmSync(dest, { force: true });
    const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite')); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); db.close();
    console.log(`template saved: ${path.resolve(args['make-template'])} (${(fs.statSync(path.resolve(args['make-template'])).size / 1048576).toFixed(1)} MB)`);
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2));
    return finish(0);
  }

  if (!args.world) { console.error('usage: see the comment at the top of test/bench/load.js'); return finish(2); }
  fs.copyFileSync(path.resolve(args.world), path.join(dataDir, 'worlds.sqlite'));
  const world = c.store.list()[0];
  await c.start({ folder: world.folder });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 300000);
  if (!st) { console.error('the world did not start'); return finish(1); }
  await sleep(num('settle', 15) * 1000);   // past the start-up work (loading the spawn area)

  const windows = new Map();
  const collect = async () => { try { for (const w of (await ctl('/stats')).windows) windows.set((w.instance || 0) + ':' + w.t, w); } catch {} };
  const collector = setInterval(collect, 30000);
  const joinStart = Date.now();
  const N = num('bots', 8), K = Math.min(N, num('explorers', 0)), R = num('radius', 400), V = num('speed', 8);
  const [cx, , cz] = world.spawn || [0, 0, 0];   // paths are round the world spawn (where pre-generation is centred too)
  // --groups / --group-offset / --group-center: where the groups of players who are not exploring are (and their arenas).
  const G = Math.max(1, num('groups', 1)), GD = num('group-offset', 0), gc = args['group-center'] ? String(args['group-center']).split(',').map(Number) : [0, 0];
  const centers = Array.from({ length: G }, (_, g) => (G === 1 ? [cx + gc[0], cz + gc[1]] : [cx + GD * Math.cos(Math.PI / 4 + (2 * Math.PI * g) / G), cz + GD * Math.sin(Math.PI / 4 + (2 * Math.PI * g) / G)]).map(Math.round));
  out.groups = centers;
  const bots = [];
  const tpsTimer = setInterval(pollTps, 1000);
  // With regions everyone joins first and then all go to their places at once, so that each group arrives together
  // (a player teleported into an area a region instance already has makes it go into the main instance).
  const gather = !!cfg.regions;
  const placeBot = async (b) => {
    const [x, z] = b.startPos();
    await c.consoleCommand(`tp ${b.name} ${x.toFixed(1)} 170 ${z.toFixed(1)}`, { allowOp: true });
    await sleep(gather ? 100 : 300);
    b.go();
  };
  const joinBot = async (i, p, place = true) => {
    const b = new Bot({ name: `Bot${i + 1}`, relayUrl: relay.url, code: st.code, path: p, log: (m) => console.log(m) });
    try { await b.join(); } catch (e) { console.log(`Bot${i + 1} could not join: ${e.message}`); return null; }
    if (!(await Promise.race([b.ready, sleep(30000).then(() => false)]))) { console.log(`${b.name} did not get into the world`); return b; }
    if (place) await placeBot(b);   // to where its path starts
    return b;
  };
  const paths = [];
  for (let i = 0; i < N; i++) {
    // Explorers: a circle of radius R round the world spawn, each starting at its own point on it.
    // The others: small circles near spawn at walking speed, in terrain that is already loaded.
    const explorer = i < K;
    const p = explorer
      ? { kind: 'circle', cx, cz, radius: R, speed: V, phase: (2 * Math.PI * i) / K }
      : { kind: 'circle', cx: centers[(i - K) % G][0], cz: centers[(i - K) % G][1], radius: 12 + 8 * Math.floor((i - K) / G), speed: args['players-still'] ? 0 : 4.3, phase: (2 * Math.PI * i) / Math.max(1, N - K) };
    paths.push(p);
    const b = await joinBot(i, p, !gather); if (b) bots.push(b);
    await sleep(num('join-gap', 1500));
  }
  if (gather) for (const b of bots) if (b.spawn) await placeBot(b);
  // --rejoin s: everyone leaves where they are, and joins again s seconds later.
  if (args.rejoin) {
    for (const b of bots) b.close();
    console.log(`all players left; they join again in ${num('rejoin', 30)} s`);
    await sleep(num('rejoin', 30) * 1000);
    bots.length = 0;
    for (let i = 0; i < N; i++) { const b = await joinBot(i, paths[i]); if (b) bots.push(b); await sleep(num('join-gap', 1500)); }
    const rs = (await c.status()).regions;
    if (rs) console.log('regions after the rejoin:', JSON.stringify(rs.instances.map((x) => ({ id: x.id, players: x.players, cells: x.cells }))));
  }
  const inWorld = bots.filter((b) => b.spawn).length;
  console.log(`${inWorld}/${N} bots in the world (${K} explorers at ${V} blocks/s on a ${R}-block circle)`);
  const warm = num('warmup', 20), secs = num('seconds', 120);
  // --mobs z,v,a: a 64x64 stone floor at y 120 round spawn with glass walls (the players fly at about y 170, so
  // out of a zombie's 35-block follow range); z zombies, v villagers that take no damage (the zombies keep
  // chasing them, they keep fleeing), a animals (cows, sheep, pigs, chickens); night, the daylight cycle off.
  // Positions from a fixed seed. Given NBT, /summon skips the random start (equipment, babies).
  if (args.mobs) {
    const [nz, nv, na, ns = 0, nc = 0, np = 0, ni = 0] = String(args.mobs).split(',').map((v) => Number(v) || 0);
    const y = 120, cmds = ['time set 18000', 'gamerule doDaylightCycle false'];
    const items = ['cobblestone', 'dirt', 'sand', 'gravel', 'planks', 'log', 'stick', 'coal'];   // different kinds: they do not merge
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const animals = ['Cow', 'Sheep', 'Pig', 'Chicken'];
    for (const [ax, az] of centers) {
      const x0 = Math.round(ax) - 32, z0 = Math.round(az) - 32, x1 = x0 + 63, z1 = z0 + 63;
      // with regions in the instance of the group's first player (a command about a player runs in its instance)
      const g = centers.findIndex((c0) => c0[0] === ax && c0[1] === az), pre = cfg.regions && bots[K + g] ? `execute ${bots[K + g].name} ~ ~ ~ ` : '';
      for (let l = y + 1; l <= y + 24; l += 8) cmds.push(`${pre}fill ${x0} ${l} ${z0} ${x1} ${l + 7} ${z1} minecraft:air`);
      cmds.push(`${pre}fill ${x0} ${y} ${z0} ${x1} ${y} ${z1} minecraft:stone`,
        `${pre}fill ${x0} ${y + 1} ${z0} ${x1} ${y + 4} ${z0} minecraft:glass`, `${pre}fill ${x0} ${y + 1} ${z1} ${x1} ${y + 4} ${z1} minecraft:glass`,
        `${pre}fill ${x0} ${y + 1} ${z0} ${x0} ${y + 4} ${z1} minecraft:glass`, `${pre}fill ${x1} ${y + 1} ${z0} ${x1} ${y + 4} ${z1} minecraft:glass`);
      const at = () => `${(x0 + 2 + rnd() * 59).toFixed(1)} ${y + 1} ${(z0 + 2 + rnd() * 59).toFixed(1)}`;
      for (let i = 0; i < nz; i++) cmds.push(`${pre}summon Zombie ${at()} {PersistenceRequired:1}`);
      for (let i = 0; i < nv; i++) cmds.push(`${pre}summon Villager ${at()} {Invulnerable:1,PersistenceRequired:1}`);
      for (let i = 0; i < na; i++) cmds.push(`${pre}summon ${animals[i % 4]} ${at()} {PersistenceRequired:1}`);
      for (let i = 0; i < ns; i++) cmds.push(`${pre}summon Skeleton ${at()} {PersistenceRequired:1}`);
      for (let i = 0; i < nc; i++) cmds.push(`${pre}summon Creeper ${at()} {PersistenceRequired:1}`);
      for (let i = 0; i < np; i++) cmds.push(`${pre}summon Spider ${at()} {PersistenceRequired:1}`);
      for (let i = 0; i < ni; i++) cmds.push(`${pre}summon Item ${at()} {Item:{id:minecraft:${items[i % items.length]},Count:1},PickupDelay:32767,Age:-32768}`);
    }
    if (args['mobs-only']) {   // natural mobs gone before the arena, and what they drop: their loot at once, their XP a second later
      for (const cmd of ['gamerule doMobSpawning false', 'kill @e[type=!Player]']) await c.consoleCommand(cmd, { allowOp: true });
      await sleep(2500);
      for (const cmd of ['kill @e[type=Item]', 'kill @e[type=XPOrb]']) await c.consoleCommand(cmd, { allowOp: true });
    }
    let ok = 0;
    for (const cmd of cmds) { const r = await c.consoleCommand(cmd, { allowOp: true }); const t = (r.lines || []).join(' '); if (r.error || /unknown|usage|cannot|invalid|failed|error/i.test(t)) console.log(`${cmd} -> ${r.error || t}`); else ok++; }
    console.log(`mob arena${G > 1 ? 's' : ''}: ${ok}/${cmds.length} commands ok (${nz} zombies, ${nv} villagers, ${na} animals, ${ns} skeletons, ${nc} creepers, ${np} spiders, ${ni} items${G > 1 ? ` in each of ${G}` : ''})`);
    out.mobs = { zombies: nz, villagers: nv, animals: na, skeletons: ns, creepers: nc, spiders: np, items: ni, arenas: G, mobsOnly: !!args['mobs-only'], commandsOk: ok, commands: cmds.length };
  }
  await sleep(warm * 1000);
  // --pregen-during <blocks>: a pre-generation runs while the players play (its cost to them).
  if (args['pregen-during']) console.log((await c.consoleCommand(`pregen ${args['pregen-during']}${args['pregen-rate'] ? ' ' + args['pregen-rate'] : ''}`, { allowOp: true })).lines.join(' '));
  const pg0 = args['pregen-during'] ? (await c.status()).pregen : null;
  const census = async () => {
    const n = {};
    // with regions: in every instance, through one of its players
    const rs = cfg.regions ? (await c.status()).regions : null;
    const via = rs ? rs.instances.map((x) => (x.players.length ? `execute ${x.players[0]} ~ ~ ~ ` : x.id === 0 ? '' : null)).filter((x) => x !== null) : [''];
    for (const t of ['Zombie', 'Villager', 'Cow', 'Sheep', 'Pig', 'Chicken', 'Item', 'Skeleton', 'Creeper', 'Spider']) {
      n[t] = 0;
      for (const pre of via) { const r = await c.consoleCommand(`${pre}testfor @e[type=${t}]`, { allowOp: true }); n[t] += ((r.lines || []).join('\n').match(/Found /g) || []).length; }
      const r = { lines: [] };
      if (t === 'Zombie' && process.env.EAGLAN_DEBUG_CENSUS) console.log('census raw:', JSON.stringify(r).slice(0, 600));
    }
    return n;
  };
  if (args.mobs) { out.mobsAtStart = await census(); console.log('entities at the start:', JSON.stringify(out.mobsAtStart)); }
  if (args.profile) console.log('CPU profile:', JSON.stringify(await ctl(`/debug/cpu-profile?seconds=${Math.min(num('profile-seconds', 100), secs)}&file=${encodeURIComponent(path.resolve(args.profile))}`, 'POST')));
  // --traveler s: Traveler goes far away and back every s seconds during the measured time.
  let traveler = null, travelerTimer = null;
  if (args.traveler) {
    traveler = new Bot({ name: 'Traveler', relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: (m) => console.log(m) });
    try { await traveler.join(); await Promise.race([traveler.ready, sleep(30000)]); } catch (e) { console.log('Traveler could not join: ' + e.message); }
    let away = false;
    const hop = () => { away = !away; return c.consoleCommand(away ? `tp Traveler ${Math.round(cx + 800)} 170 ${Math.round(cz)}` : `tp Traveler ${centers[0][0] + 4} 170 ${centers[0][1] + 4}`, { allowOp: true }).catch(() => {}); };
    await hop(); await sleep(10000); travelerTimer = setInterval(hop, num('traveler', 60) * 500);
  }
  const st0 = await c.status(), load0 = st0.hostLoad;   // the process's CPU time (all threads) at the start
  const pool0 = st0.multiCore ? st0.multiCore.poolActiveMs : 0;
  const from = Date.now();
  const cpuSampler = require('./cpu-sample').startCpuSampler();   // the busy share of each logical CPU
  const rep = args['repeat-command'] ? { cmds: String(args['repeat-command']).split('|'), runs: 0, ms: 0, errors: 0, first: null } : null;
  let repStop = false;
  const repLoop = rep && (async () => {
    while (!repStop) {
      const t0 = Date.now(), r = await c.consoleCommand(rep.cmds[rep.runs % rep.cmds.length], { allowOp: true });
      rep.ms += Date.now() - t0; rep.runs++; if (r.error) rep.errors++; if (!rep.first) rep.first = JSON.stringify(r).slice(0, 400);
    }
  })();
  const progress0 = bots.map((b) => ({ d: b.stats.distance, blocked: b.stats.blockedMs, moving: b.stats.movingMs, ids: { ...b.stats.ids } }));
  Object.assign(chunkCounts, { R: 0, G: 0, W: 0, seconds: 0 });
  while (Date.now() - from < secs * 1000) await sleep(1000);
  const to = Date.now();
  const perCpu = await cpuSampler.stop();
  if (travelerTimer) clearInterval(travelerTimer);
  if (rep) { repStop = true; await repLoop; }
  // Cores used on average by the whole host process (all threads) in the measured time, and its memory.
  const st1 = await c.status(), load1 = st1.hostLoad;
  if (args.mobs) { out.mobsAtEnd = await census(); console.log('entities at the end:', JSON.stringify(out.mobsAtEnd)); }
  const poolCores = st1.multiCore && load1 && load0 && load1.at > load0.at ? Math.round(((st1.multiCore.poolActiveMs - pool0) / (load1.at - load0.at)) * 100) / 100 : null;
  const cpuCores = load0 && load1 && load1.at > load0.at ? Math.round(((load1.cpuTotalMs - load0.cpuTotalMs) / (load1.at - load0.at)) * 100) / 100 : null;
  const memory = load1 ? { rssMb: load1.rssMb, gameHeapMb: load1.gameHeapMb, gameExternalMb: load1.gameExternalMb, hostHeapMb: load1.hostHeapMb } : null;
  // How far each bot got in the measured time, and how long it waited at the edge of the terrain it had.
  // The packets the bots received in the measured time, by packet id (hex), all bots together.
  const ids = {};
  bots.forEach((b, i) => { for (const [id, n] of Object.entries(b.stats.ids)) { const k = '0x' + (+id).toString(16).padStart(2, '0'), d = n - (progress0[i].ids[id] || 0); if (d) ids[k] = (ids[k] || 0) + d; } });
  const travel = bots.map((b, i) => ({ name: b.name, explorer: i < K, blocks: Math.round(b.stats.distance - progress0[i].d), blockedS: Math.round((b.stats.blockedMs - progress0[i].blocked) / 100) / 10 }));
  await sleep(6000); await collect();
  clearInterval(collector); clearInterval(tpsTimer);
  const log = hostLog().split('\n');
  const inRun = (l) => { const t = logTime(l); return t >= from && t <= to + 6000; };
  const cku = log.filter((l) => /Can't keep up!/.test(l) && inRun(l)).map((l) => +(/Running (\d+)ms behind/.exec(l) || [])[1]);
  // The joins and the teleports to the paths' starts (whole areas loaded, or generated, at once).
  const setup = summarize([...windows.values()], joinStart, from - warm * 1000);
  out.setup = { seconds: setup.seconds, tickMax: setup.tickMs.max, ticksOver1000: setup.ticksOver[1000], lateMs: setup.lateMs };
  out.windows = [...windows.values()].sort((a, b) => a.t - b.t).map(({ pregen, ...w }) => w);
  // The autosave rounds that started in the measured time (game-patches.js "spread autosave").
  const rounds = new Map();
  for (const w of out.windows) { const a = w.autosave && w.autosave.last; if (a && a.startedAt >= from && a.startedAt <= to) rounds.set(a.startedAt, a); }
  const autosave = { spread: cfg.spreadAutosave, rounds: [...rounds.values()].map((a) => ({ ticks: a.ticks, saved: a.saved, dropped: a.dropped, mostInATick: a.mostInATick, ms: a.endedAt - a.startedAt })) };
  out.result = {
    ...summarize([...windows.values()], from, to),
    cantKeepUp: cku.length, cantKeepUpBehindMs: cku, cpuCores, poolCores, netBusyPct: load1 ? load1.netBusy : null, memory,
    multiCore: st1.multiCore ? (({ on, status, error, threads, cpu, packets, rawMb, compressedMb, compressedHere, redone, maxWaiting, maxDelayMs, threadsBusy }) => ({ on, status, error, threads, cpu, packets, rawMb, compressedMb, compressedHere, redone, maxWaiting, maxDelayMs, threadsBusy }))(st1.multiCore) : null,
    stallLines: log.filter((l) => /game server fell/.test(l) && inRun(l)).map((l) => l.replace(/^\[[^\]]+\] \[host\] /, '')),
    chunks: { ...chunkCounts },
    autosave,
    terrain: st1.terrain || null,
    msgsPerSec: load1 ? load1.msgsPerSec : null,   // player messages between the host and the game, both ways (last minute)
    speedups: st1.speedups || null,
    regions: st1.regions ? { ...st1.regions, perInstance: perInstance([...windows.values()], from, to) } : null,
    perCpu, hostCpuBusyPct: hostCpuList && perCpu.length ? hostCpuList.map((i) => (perCpu.find((p) => p.cpu === i) || {}).busyPct ?? null) : null,
    repeat: rep ? { commands: rep.cmds, runs: rep.runs, msPerRun: rep.runs ? Math.round((rep.ms / rep.runs) * 10) / 10 : null, errors: rep.errors, first: rep.first } : null,
    pregenStatus: st1.pregen || null,
    pregen: pg0 ? (({ processed, generated, read, yieldedTicks }) => ({ chunks: processed - pg0.processed, generated: generated - pg0.generated, read: read - pg0.read, pausedTicks: yieldedTicks - pg0.yieldedTicks }))((await c.status()).pregen) : null,
    travel, explorerBlocks: travel.filter((t) => t.explorer).reduce((a, t) => a + t.blocks, 0), explorerBlockedS: Math.round(travel.filter((t) => t.explorer).reduce((a, t) => a + t.blockedS, 0)),
    bots: { wanted: N, inWorld, explorers: K, kicked: bots.filter((b) => b.stats.kicked).map((b) => `${b.name}: ${b.stats.kicked}`), closed: bots.filter((b) => b.stats.closed).length, teleportsWhileMoving: bots.reduce((a, b) => a + b.stats.teleportsWhileMoving, 0), deaths: bots.reduce((a, b) => a + b.stats.deaths, 0), mbReceived: Math.round(bots.reduce((a, b) => a + b.stats.bytes, 0) / 1048576), respawns: bots.reduce((a, b) => a + b.stats.respawns, 0), moveMs: bots.flatMap((b) => b.stats.moveMs), traveler: traveler ? { respawns: traveler.stats.respawns, moveMs: traveler.stats.moveMs, kicked: traveler.stats.kicked } : null, packetsPerSec: Math.round(Object.values(ids).reduce((a, n) => a + n, 0) / ((to - from) / 1000)), packetsById: Object.fromEntries(Object.entries(ids).sort()) },
  };
  for (const b of bots) b.close();
  if (traveler) traveler.close();
  const r = out.result;
  console.log(`SETUP ${out.label || ''}: longest tick ${out.setup.tickMax} ms, ${out.setup.ticksOver1000} ticks over 1 s, behind ${out.setup.lateMs} ms in ${out.setup.seconds}s of joins and teleports`);
  console.log(`RESULT ${out.label || ''}: ${r.ticks} ticks in ${r.seconds}s (${r.tps}/s) | tick ms mean ${r.tickMs.mean} p50 ${r.tickMs.p50} p95 ${r.tickMs.p95} p99 ${r.tickMs.p99} max ${r.tickMs.max} | over 50/100/250/1000 ms: ${r.ticksOver[50]}/${r.ticksOver[100]}/${r.ticksOver[250]}/${r.ticksOver[1000]} | behind ${r.lateMs} ms | Can't keep up ${r.cantKeepUp} | busy ${r.busyPct}% (max ${r.busyMaxPct}%) | process CPU ${r.cpuCores} cores (pool ${r.poolCores ?? '-'}), RSS ${r.memory && r.memory.rssMb} MB | multi-core ${r.multiCore && r.multiCore.on ? `on, ${r.multiCore.threads} threads, ${r.multiCore.packets} packets, waited max ${r.multiCore.maxDelayMs} ms` : r.multiCore ? r.multiCore.status : '-'} | GC ${r.gcMsPerMin} ms/min (max ${r.gcMaxMs}) | chunks G ${r.chunks.G} R ${r.chunks.R} W ${r.chunks.W} | explorers travelled ${r.explorerBlocks} blocks, waited ${r.explorerBlockedS} s for terrain ${r.pregen ? ` | pre-generated ${r.pregen.chunks} chunks (paused ${r.pregen.pausedTicks} ticks)` : ''} | autosave ${r.autosave.spread ? 'spread: ' + (r.autosave.rounds.map((a) => `${a.saved} saved, ${a.dropped} dropped in ${a.ticks} ticks`).join('; ') || 'no round') : 'in one tick'} | bots ${r.bots.inWorld}/${N}, kicked ${r.bots.kicked.length}, put back ${r.bots.teleportsWhileMoving}`);
  if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2));
  return finish(0);
})().catch(async (e) => { console.error(e); if (onFail) await onFail(1); process.exit(1); });
