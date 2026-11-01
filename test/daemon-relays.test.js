'use strict';
// Daemon-level multi-relay test with the real integrated server (worker) and local mock relays.
// Uses a throwaway data directory.   node --test test/daemon-relays.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-relays-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { joinViaRelay } = require('../src/relay-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const relayState = (st, url) => (st.relays || []).find((r) => r.url === url) || {};

const mocks = [], joins = [];
after(async () => {
  try { await c.stop(); } catch {}
  for (const j of joins) j.close();
  for (const m of mocks) await m.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: one world on several relays, failures, live relay changes, graceful stop and restart', { timeout: 240000 }, async () => {
  const a = await new MockRelay().start(); const b = await new MockRelay().start(); const bad = await new MockRelay({ mode: 'http-503' }).start();
  mocks.push(a, b, bad);
  const dead = 'ws://127.0.0.1:1/';
  // Config file with a duplicate, a comment and an invalid line: all must be handled.
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), `# test relays\n${a.url}\n${b.url}\n${a.url.toUpperCase()}\nnot-a-url\n${bad.url}\n${dead}\n`);
  const cfg = c.loadConfig();
  assert.deepEqual(cfg.relays, [a.url, b.url, bad.url, dead]);
  assert.equal(cfg.relayWarnings.length, 2);
  // The game thread's young generation from the config (32 MB: smaller than Node's own choice on most
  // machines, so the heap limit shows it was applied; 2096 MB with maxHeapMb 2048 on Node 24).
  c.saveConfig({ youngGenerationMb: 32 });

  await c.create({ name: 'Relay Test World' });
  let st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && (s.codes || []).length === 2 && s; }, 90000);
  assert.ok(st, 'hosting on both healthy relays: ' + JSON.stringify((await c.status()).relays));
  assert.equal(relayState(st, a.url).state, 'active');
  assert.equal(relayState(st, b.url).state, 'active');
  assert.ok(['backoff', 'connecting'].includes(relayState(st, bad.url).state));
  assert.ok(['backoff', 'connecting'].includes(relayState(st, dead).state));
  assert.equal(a.stats.openHosts, 1); assert.equal(b.stats.openHosts, 1);

  // Players via both relays end up in the same integrated server.
  const ja = await joinViaRelay(a.url, relayState(st, a.url).code); joins.push(ja);
  const jb = await joinViaRelay(b.url, relayState(st, b.url).code); joins.push(jb);
  assert.ok(await waitFor(() => (hostLog().match(/player channel opened/g) || []).length >= 2, 20000), 'two player channels opened in the one world');
  st = await waitFor(async () => { const s = await c.status(); return s.playerCount === 2 && s; }, 10000);
  assert.ok(st, 'both players connected to the same host process');

  // Relay A loses the host's connection: it registers the world again with a new code. status
  // names the code it replaced, the log says so once, and both players stay.
  const codeA = relayState(st, a.url).code;
  a.dropHosts();
  st = await waitFor(async () => { const s = await c.status(); const x = (s.codes || []).find((r) => r.relay === a.url); return x && x.code !== codeA && s; }, 30000);
  assert.ok(st, 'relay A registered the world again');
  const ca = st.codes.find((r) => r.relay === a.url);
  assert.equal(ca.previousCode, codeA);
  assert.equal(ca.changedAt, ca.since);
  assert.equal(st.codes.find((r) => r.relay === b.url).previousCode, null, 'relay B kept its code');
  assert.ok(await waitFor(() => new RegExp(`join code on 127\\.0\\.0\\.1:\\d+ changed: ${codeA} -> ${ca.code} \\(the connection to the relay was lost; a relay never gives an old code back\\)\\. The world and the players in it are not affected\\. Give new players the new code\\.`).test(hostLog()), 5000), 'code change logged');
  assert.equal((hostLog().match(/join code on 127\.0\.0\.1:\d+ changed/g) || []).length, 1, 'logged once');
  assert.equal((await c.status()).playerCount, 2, 'no player was disconnected by the code change');

  // Relay A goes down: hosting continues via B; the player who came via A stays connected.
  await a.stop();
  st = await waitFor(async () => { const s = await c.status(); return relayState(s, a.url).state === 'backoff' && s; }, 15000);
  assert.ok(st, 'relay A marked unavailable');
  assert.equal(st.status, 'hosting');
  assert.equal(relayState(st, b.url).state, 'active');
  await sleep(1000);
  assert.equal((await c.status()).playerCount, 2, 'no player was disconnected by the relay failure');

  // Live relay list change: drop the broken relays without restarting the world.
  c.saveRelays([b.url]);
  const ap = await c.applyRelays();
  assert.equal(ap.applied, true);
  st = await c.status();
  assert.deepEqual(st.relays.map((r) => r.url), [b.url]);
  assert.equal(st.playerCount, 2, 'players unaffected by the relay list change');

  // What holds up the game server is reported (disk writes, garbage collection, how busy it is).
  st = await waitFor(async () => { const s = await c.status(); return s.gameServer && s; }, 15000);
  assert.ok(st && typeof st.gameServer.busy === 'number' && typeof st.gameServer.writesPerMin === 'number' && st.gameServer.heapLimitMb > 0, 'game server stats in status: ' + JSON.stringify(st && st.gameServer));

  // "Send twice" is off by default and can be switched on and off without a restart, also with a fixed UDP port.
  assert.equal(st.redundantSend, false, 'send twice off by default');
  assert.equal(st.redundantPort, null, 'automatic port by default');
  c.saveConfig({ redundantSend: true });
  const sa = await c.applySettings();
  assert.equal(sa.applied, true); assert.equal(sa.redundantSend, true);
  st = await c.status();
  assert.equal(st.redundantSend, true, 'status shows send twice on');
  assert.equal(st.playerCount, 2, 'connected players unaffected');
  assert.match(hostLog(), /send twice on for players who join from now on \(automatic port/);
  const twicePort = await new Promise((resolve) => { const s = require('node:dgram').createSocket('udp4'); s.bind(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  c.saveConfig({ redundantPort: twicePort });
  assert.equal((await c.applySettings()).redundantPort, twicePort);
  st = await c.status();
  assert.equal(st.redundantPort, twicePort, 'status shows the port');
  assert.match(hostLog(), new RegExp(`send twice: UDP port ${twicePort}: allow it in the server's firewall.*for players who join from now on`));
  c.saveConfig({ redundantSend: false, redundantPort: null });
  const off = await c.applySettings();
  assert.equal(off.redundantSend, false); assert.equal(off.redundantPort, null);

  // LAN game mode and cheats: the game-code correction is applied, and both settings change without a restart.
  assert.match(hostLog(), /LAN game mode for joiners: Survival; cheats off/);
  assert.doesNotMatch(hostLog(), /not applied: classes\.js is not the expected u53 build/);
  c.saveConfig({ lanGamemode: 1, lanCheats: true });
  const la = await c.applySettings();
  assert.equal(la.applied, true); assert.equal(la.lanGamemode, 1); assert.equal(la.lanCheats, true);
  st = await c.status();
  assert.equal(st.lanGamemode, 1); assert.equal(st.lanCheats, true);
  assert.match(hostLog(), /LAN settings applied: game mode Creative for players who join or respawn from now on; cheats ON for every player/);
  c.saveConfig({ lanGamemode: 0, lanCheats: false });
  assert.equal((await c.applySettings()).lanCheats, false);
  assert.match(hostLog(), /LAN settings applied: game mode Survival .*; cheats off/);
  assert.equal((await c.status()).playerCount, 2, 'connected players unaffected');
  assert.doesNotMatch(hostLog(), /worker uncaught/);

  // Game Rules, apply mode 1: set in the running world at once, and the game rules saved in it.
  c.saveConfig({ gameRules: { enabled: true, live: 1, values: { keepInventory: true, randomTickSpeed: 7, pvp: false, commandBlocks: false } } });
  const ga = await c.applySettings();
  assert.equal(ga.gameRules.applied, true, JSON.stringify(ga.gameRules));
  assert.deepEqual(ga.gameRules.failed, []);
  assert.deepEqual(ga.gameRules.switches, { pvp: false, flight: true, idleMinutes: 0, commandBlocks: false }, 'the switches as the game has them now');
  const saves = (hostLog().match(/manual save complete/g) || []).length;
  await c.save();
  assert.ok(await waitFor(() => (hostLog().match(/manual save complete/g) || []).length > saves, 30000), 'world saved');
  const stored = require('../src/game-rules').fromLevelDat(c.store.gameRules((await c.status()).world));
  assert.equal(stored.keepInventory, true); assert.equal(stored.randomTickSpeed, 7);
  // Apply mode 0: only saved; unticked: the switches go back to the game's values, the rules stay.
  c.saveConfig({ gameRules: { enabled: true, live: 0, values: { keepInventory: false } } });
  assert.equal((await c.applySettings()).gameRules.pending, true);
  c.saveConfig({ gameRules: { enabled: false, live: 1, values: { keepInventory: false } } });
  const go = await c.applySettings();
  assert.equal(go.gameRules.off, true); assert.deepEqual(go.gameRules.switches, { pvp: true, flight: true, idleMinutes: 0, commandBlocks: true });
  assert.match(hostLog(), /game rules applied \(saved\): 2 game rules set \(keepInventory, randomTickSpeed\); PvP off, flying allowed, idle kick off, command blocks off/);
  assert.equal((await c.status()).playerCount, 2, 'connected players unaffected');

  // Console: game commands run as the server, with their output as text; OP only where allowed.
  assert.deepEqual((await c.consoleCommand('time set day', { allowOp: true })).lines, ['Set the time to 1000']);
  const help = await c.consoleCommand('/help', { allowOp: true });
  assert.match(help.lines[0], /^--- Showing help page 1 of \d+ \(\/help <page>\) ---$/);
  assert.match(help.lines[help.lines.length - 1], /^Host commands: op <player>, deop <player>, ops/);
  assert.deepEqual((await c.consoleCommand('blah', { allowOp: true })), { ok: false, lines: ['Unknown command. Try /help for a list of commands'], log: [] });
  // Like a server console it is told what players are not: here while sendCommandFeedback is off.
  await c.consoleCommand('gamerule sendCommandFeedback false', { allowOp: true });
  assert.deepEqual((await c.consoleCommand('time set night', { allowOp: true })).lines, ['Set the time to 13000']);
  await c.consoleCommand('gamerule sendCommandFeedback true', { allowOp: true });
  // What a command makes the server log is shown too, but not the game's copy of what the console was told.
  const said = await c.consoleCommand('say hello §cthere', { allowOp: true });
  assert.deepEqual([said.lines, said.log], [[], ['[Server] hello there']]);
  assert.match(hostLog(), /\[Server: Set the time to 13000\]/, 'the game logs its copy (logAdminCommands)');
  assert.deepEqual((await c.consoleCommand('time set day', { allowOp: true })).log, [], 'that copy is not shown in the console');
  assert.deepEqual((await c.consoleCommand('op Alex', { allowOp: false })).lines, ['OP can only be given or taken in the web page console.']);
  assert.equal((await c.consoleCommand('op Alex', { allowOp: true })).lines[1], 'In effect now.');
  assert.deepEqual(c.loadConfig().ops, ['Alex'], 'OP list saved');
  assert.deepEqual((await c.status()).ops, ['Alex']);
  assert.match(hostLog(), /\[console\] OP list \(changed\): Alex/);
  assert.equal((await c.consoleCommand('deop alex', { allowOp: true })).lines[0], 'Alex is no longer an OP.');
  assert.deepEqual(c.loadConfig().ops, []);
  assert.ok((await c.consoleComplete('ti')).list.includes('/time'), 'Tab completion');
  assert.match(hostLog(), /\[console\] > \/time set day\n(?:.*\[server\] .*\[Server: Set the time to 1000\]\n)?.*\[console\] Set the time to 1000/);
  assert.doesNotMatch(hostLog(), /not applied: classes\.js is not the expected u53 build/);

  // Tick times in status (game-patches.js "tick times for the host").
  st = await waitFor(async () => { const s = await c.status(); return s.gameServer && s.gameServer.ticks && s; }, 15000);
  assert.ok(st && st.gameServer.ticks.n > 0 && st.gameServer.ticks.max >= st.gameServer.ticks.p50, 'tick times in status: ' + JSON.stringify(st && st.gameServer));
  assert.match(hostLog(), /game thread young generation: 32 MB \(config youngGenerationMb\)/);
  assert.ok(st.gameServer.heapLimitMb > 2048 && st.gameServer.heapLimitMb <= 2112, 'heap limit with a 32 MB young generation: ' + st.gameServer.heapLimitMb);

  // Player limit: two players are connected; with a limit of 2 the next join gets the game's refusal.
  c.saveConfig({ playerLimit: 2 });
  assert.equal((await c.applySettings()).playerLimit, 2);
  st = await c.status();
  assert.equal(st.playerLimit, 2);
  const jc = await joinViaRelay(b.url, relayState(st, b.url).code); joins.push(jc);
  let refusal = null; jc.dc.onmessage = (e) => { refusal = Buffer.from(e.data); };
  assert.ok(await waitFor(() => refusal, 10000), 'the third player is refused with a message');
  assert.match(refusal.toString('utf8'), /"This world is full: 2 of 2 players are online\. Try again later\."/);
  assert.equal((await c.status()).refusedFull, 1);
  assert.equal((await c.status()).playerCount, 2, 'the players in the world stay');
  c.saveConfig({ playerLimit: 0 });
  assert.equal((await c.applySettings()).playerLimit, 0);
  assert.match(hostLog(), /player limit 2: more players are refused with a message, from now on[\s\S]*refused: the world is full \(2 of 2 players; config playerLimit\)[\s\S]*no player limit any more/);

  // World pre-generation: within 40 blocks of spawn (121 chunks: two rings round the radius), while
  // the world runs; saved, populated and lit.
  assert.match((await c.consoleCommand('pregen 5000', { allowOp: true })).lines[0], /^the radius must be a whole number of blocks from 16 to 4000/);
  assert.match((await c.consoleCommand('pregen soon', { allowOp: true })).lines[0], /^Usage: pregen <radius in blocks>/);
  const pg = await c.consoleCommand('pregen 40 50', { allowOp: true });
  assert.match(pg.lines[0], /^Pre-generating the 121 chunks within 40 blocks of spawn \(-?\d+, -?\d+\) at up to 50 chunks\/s/);
  const pgDone = await waitFor(async () => { const s = await c.status(); return s.pregen && s.pregen.done && !s.pregen.loadedNow && !s.pregen.pendingUnloads && s.pregen; }, 90000, 500);
  assert.ok(pgDone, 'pre-generation finished: ' + JSON.stringify((await c.status()).pregen));
  assert.equal(pgDone.processed, 121);
  assert.ok(pgDone.lit >= 49 - pgDone.alreadyLoaded, 'lit: ' + pgDone.lit);
  assert.equal(pgDone.generated + pgDone.read + pgDone.alreadyLoaded >= 121, true);
  assert.match((await c.consoleCommand('pregen status', { allowOp: true })).lines[0], /^Finished: 121 of 121 chunks within 40 blocks of spawn/);
  assert.match(hostLog(), /pre-generation started: the 121 chunks within 40 blocks of spawn[\s\S]*pre-generation finished after .*: 121\/121 chunks \(100%/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'pregen.json')), 'no job left to resume');
  const savesBefore = (hostLog().match(/manual save complete/g) || []).length;
  await c.save();
  assert.ok(await waitFor(() => (hostLog().match(/manual save complete/g) || []).length > savesBefore, 30000), 'world saved');
  {
    const { parseNBT, WORLDS_DB } = require('../src/worlds');
    const w = c.store.list().find((x) => x.folder === st.world), [sx, , sz] = w.spawn;
    const db = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'worlds.sqlite'), { readOnly: true });
    const hex = (v) => Array.from({ length: 6 }, (_, i) => '0123456789ABCDEF'[((v + 1900000) >>> (4 * i)) & 15]).join('');
    let populated = 0, lit = 0;
    for (let x = (sx >> 4) - 3; x <= (sx >> 4) + 3; x++) for (let z = (sz >> 4) - 3; z <= (sz >> 4) + 3; z++) {
      const row = db.prepare('SELECT data FROM files WHERE db = ? AND path = ?').get(WORLDS_DB, `worlds/${st.world}/level0/${hex(x)}${hex(z)}.dat`);
      assert.ok(row, `chunk ${x},${z} saved`);
      const level = parseNBT(require('node:zlib').gunzipSync(Buffer.from(row.data))).Level;
      if (level.TerrainPopulated) populated++;
      if (level.LightPopulated) lit++;
    }
    db.close();
    assert.equal(populated, 49, 'every chunk within the radius is populated (trees, ores, structures)');
    // ... and light populated (saved LightPopulated), so the game does not light it again when a player
    // first comes near (a chunk the game had loaded already, e.g. near a player, is left as it is)
    assert.ok(lit >= 49 - pgDone.alreadyLoaded, `lit: ${lit} of 49 (${pgDone.alreadyLoaded} were loaded already)`);
  }

  // A pre-generation that is still running when the world stops waits at the next start: it does not
  // start by itself, unless config "Pre-generationOnline" is true (below).
  assert.match((await c.consoleCommand('pregen 200 1', { allowOp: true })).lines[0], /^Pre-generating the 961 chunks within 200 blocks/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'pregen.json'), 'utf8')).radius, 200);

  // Graceful stop: world saved, no relay activity after shutdown begins.
  const connsBefore = b.stats.connections;
  const stop = await c.stop();
  assert.equal(stop.graceful, true);
  const log = hostLog();
  assert.match(log, /world saved and integrated server stopped cleanly/);
  const afterShutdown = log.slice(log.lastIndexOf('shutting down'));
  assert.doesNotMatch(afterShutdown, /ACTIVE, join code|failed: .*retry/);
  await sleep(1500);
  assert.equal(b.stats.connections, connsBefore, 'no reconnect after shutdown');
  assert.equal(b.stats.openHosts, 0);

  // Restart: same world (not re-created), relays register again with new codes.
  const worldsBefore = c.store.list().map((w) => w.folder);
  await c.restart();
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && (s.codes || []).length === 1 && s; }, 90000);
  assert.ok(st);
  assert.equal(st.world, worldsBefore[0]);
  assert.deepEqual(c.store.list().map((w) => w.folder), worldsBefore, 'no duplicate world created');
  assert.equal(b.stats.openHosts, 1);
  assert.equal(b.stats.peakHosts, 1, 'never two registrations at once, even across restart');
  assert.match(hostLog(), /pre-generation: an unfinished job is waiting \(200 blocks, ring \d+ of 15\); it continues only when started again/);
  assert.doesNotMatch(hostLog(), /pre-generation resumed/);
  st = await c.status();
  assert.ok(!st.pregen || !st.pregen.running, 'not resumed by itself');
  assert.equal(st.pregenWaiting.radius, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'pregen.json')), 'the job is kept');
  assert.match((await c.consoleCommand('pregen status', { allowOp: true })).lines[0], /An unfinished pre-generation is waiting: 200 blocks, ring \d+ of 15/);
  // Resume, as the web page's button does (POST /api/pregen {action: "resume"} -> control.pregen).
  const resumed = await c.pregen({ action: 'resume' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.match(resumed.lines[0], /^Pre-generation resumed: the 961 chunks within 200 blocks of spawn .*, from ring \d+ of 15, at up to 1 chunks\/s\./);
  st = await c.status();
  assert.equal(st.pregen.running, true);
  assert.equal(st.pregenWaiting, null);
  assert.equal((await c.pregen({ action: 'resume' })).lines[0], 'a pre-generation is running already');
  assert.match((await c.consoleCommand('pregen stop', { allowOp: true })).lines[0], /^Pre-generation stopped/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'pregen.json')), 'a stopped job is not kept');
  assert.equal((await c.pregen({ action: 'resume' })).lines[0], 'there is no unfinished pre-generation to resume');

  // Discard: a waiting job removed with pregen stop (the button's Discard).
  assert.match((await c.consoleCommand('pregen 200 1', { allowOp: true })).lines[0], /^Pre-generating/);
  await c.restart();
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.pregenWaiting && s; }, 90000);
  assert.ok(st, 'waiting again after a restart');
  assert.match((await c.pregen({ action: 'stop' })).lines[0], /^The unfinished pre-generation \(200 blocks, ring \d+ of 15\) was discarded; it will not be resumed\./);
  assert.ok(!fs.existsSync(path.join(dataDir, 'pregen.json')), 'a discarded job is gone');
  assert.equal((await c.status()).pregenWaiting, null);

  // Config "Pre-generationOnline": true: an unfinished job is resumed when the world starts.
  assert.match((await c.consoleCommand('pregen 200 1', { allowOp: true })).lines[0], /^Pre-generating/);
  c.saveConfig({ 'Pre-generationOnline': true });
  await c.restart();
  st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.pregen && s.pregen.running && s; }, 90000);
  assert.ok(st, 'resumed by itself');
  assert.match(hostLog(), /pre-generation resumed after the restart \(config "Pre-generationOnline"\): the 961 chunks within 200 blocks of spawn/);
  assert.match((await c.consoleCommand('pregen stop', { allowOp: true })).lines[0], /^Pre-generation stopped/);
  c.saveConfig({ 'Pre-generationOnline': false });
  await c.stop();
});
