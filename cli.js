#!/usr/bin/env node
'use strict';
// eaglan-host CLI (everything works without the web UI)
//   node cli.js ui                          start the optional web UI (http://127.0.0.1:8090)
//   node cli.js worlds                      list worlds
//   node cli.js start <folder> [--foreground]   host an existing world (background daemon;
//                                           --foreground: stay attached, logs on stdout, Ctrl+C saves and stops)
//   node cli.js create <name> [seed] [--foreground]   create a NEW world and host it
//   node cli.js stop | restart | status | save | logs
//   node cli.js relays                      show the relay list (data/relays.txt) and live relay states
//   node cli.js relays apply                apply an edited data/relays.txt to the running world (no restart)
//   node cli.js relays probe [url ...]      test relays end to end (registration, join code, data channel)
//   node cli.js redundant [on|off]          send small packets to players twice (see README)
//   node cli.js redundant port <n|auto>     UDP port for send twice (1024-65535), or a free port per player
//   node cli.js settings apply              apply game mode, cheats, send twice and Game Rules from data/config.json now
//   node cli.js cmd <command ...>           run a server command (OP only in the web page console)
//   node cli.js pregen <blocks> [chunks/s]  generate and save the terrain within that radius of spawn while the world runs
//   node cli.js pregen resume | stop | status   (default 4 chunks/s; it pauses whenever the server falls behind;
//                                           resume continues an unfinished one, stop also discards it)
//   node cli.js limit [<players>|off]       refuse joins above that many players (default off)
//   node cli.js multicore [on|off]          multi-core mode: packets and saved chunks compressed on other CPU cores
//   node cli.js import <file.epk|.zip> [name]
//   node cli.js export <folder> [epk|zip]   (writes data/exports/...)
//   node cli.js rename <folder> <new name>  change a world's name (the folder stays)
//   node cli.js delete <folder>             move a world to the deleted worlds (restore brings it back)
//   node cli.js deleted                     list the deleted worlds
//   node cli.js restore <id>                put a deleted world back
//   node cli.js purge <id> --yes            remove a deleted world's files for good
//                                           (rename, delete, restore and purge only while no world runs)

const c = require('./src/control');
const argv = process.argv.slice(2);
const foreground = argv.includes('--foreground');
const [cmd, ...args] = argv.filter((a) => a !== '--foreground');
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));

function relayTable(relays) {
  if (!relays || !relays.length) return '  (no relay state reported)';
  const inS = (t) => (t ? Math.max(0, Math.round((t - Date.now()) / 1000)) + 's' : '');
  return relays.map((r) => {
    const extra = r.state === 'active' ? `code ${r.code}${r.turn ? ', TURN' : ''}, players ${r.players || 0}${r.joining ? ` (+${r.joining} joining)` : ''}`
      : `${r.lastError || ''}${r.nextRetryAt ? ` (retry in ${inS(r.nextRetryAt)})` : ''}`;
    return `  ${r.name.padEnd(28)} ${r.state.padEnd(13)} ${extra}`;
  }).join('\n');
}

async function finishForeground(p) {
  const r = await p;
  if (r && 'exitCode' in r) process.exit(r.exitCode || 0);
  return out(r);
}

(async () => {
  switch (cmd) {
    case 'ui': require('./src/ui-server'); return;
    case 'worlds': return out(c.store.list());
    case 'start': return finishForeground(c.start({ folder: args[0], foreground }));
    case 'create': return finishForeground(c.create({ name: args[0], seed: args[1], foreground }));
    case 'import': return out(await c.importWorld({ file: require('path').resolve(args[0]), name: args[1], format: /\.zip$/i.test(args[0]) ? 'mca' : 'epk' }));
    case 'export': return out(await c.exportWorld({ folder: args[0], format: args[1] === 'zip' ? 'mca' : 'epk' }));
    case 'rename': return out(await c.renameWorld({ folder: args[0], name: args[1] }));
    case 'delete': return out(await c.deleteWorld({ folder: args[0], confirm: args[0] }));
    case 'deleted': return out(c.listDeleted());
    case 'restore': return out(await c.restoreWorld({ id: args[0] }));
    case 'purge': {
      if (!args.includes('--yes')) { console.error('purge removes the deleted world\'s files for good: add --yes'); process.exit(1); }
      const id = args.find((a) => a !== '--yes'), t = c.listDeleted().find((x) => x.id === id);
      return out(await c.purgeWorld({ id, confirm: t ? t.folder : '' }));
    }
    case 'stop': return out(await c.stop());
    case 'restart': return out(await c.restart());
    case 'save': return out(await c.save());
    case 'status': {
      const s = await c.status();
      console.log(`status:   ${s.status}${s.running ? ` (pid ${s.pid})` : ''}`);
      if (s.world) console.log(`world:    ${s.world}`);
      if (s.running) {
        console.log(`players:  ${s.playerCount || 0}${s.playerLimit ? ` (limit ${s.playerLimit}${s.refusedFull ? `, ${s.refusedFull} refused because the world was full` : ''})` : ''}`);
        for (const p of (s.peers || []).filter((x) => x.state === 'CONNECTED')) {
          const r = p.rtt ? `rtt ${p.rtt.last} ms now, ${p.rtt.median} median (${p.rtt.min}-${p.rtt.max})` : 'rtt not measured yet';
          console.log(`  ${(p.name || p.id).padEnd(18)} ${r.padEnd(40)} ${p.path || ''}${p.family ? ' ' + p.family : ''}, via ${p.relay}${p.sentTwice ? ', small packets sent twice' : ''}`);
        }
        const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        console.log(`codes:    ${(s.codes || []).map((x) => `${x.code} (${x.name}${x.since ? ', since ' + hm(x.since) : ''}${x.previousCode && x.changedAt === x.since ? ', replaced ' + x.previousCode + ', which no longer works' : ''})`).join(', ') || 'none - no relay active yet'}`);
        console.log('relays:\n' + relayTable(s.relays));
        const hl = s.hostLoad;
        if (hl) console.log(`load:     CPU ${hl.cpu}% of one core (game thread ${hl.gameBusy ?? '?'}%, network thread ${hl.netBusy}%, ${hl.poolBusy != null ? `multi-core pool ${hl.poolBusy}%, ` : ''}WebRTC/GC/other ${hl.other ?? '?'}%), ${hl.msgsPerSec} player messages/s; memory ${hl.rssMb} MB (game heap ${hl.gameHeapMb ?? '?'} MB + game arrays ${hl.gameExternalMb ?? '?'} MB, host heap ${hl.hostHeapMb} MB + buffers ${hl.hostExternalMb ?? '?'} MB, runtime and libraries ${hl.gameHeapMb != null ? hl.rssMb - hl.gameHeapMb - (hl.gameExternalMb || 0) - hl.hostHeapMb - (hl.hostExternalMb || 0) : '?'} MB) (last minute)`);
        if (s.hostLoopDelay) console.log(`host:     event-loop delay p50 ${s.hostLoopDelay.p50} ms, p99 ${s.hostLoopDelay.p99} ms, max ${s.hostLoopDelay.max} ms (last minute)`);
        console.log(`lan:      game mode ${['Survival', 'Creative', 'Adventure', 'Spectator'][s.lanGamemode] || s.lanGamemode} for players who join or respawn, cheats ${s.lanCheats ? 'ON for every player' : 'off'}`);
        const g = s.gameRules;
        if (g && g.enabled) console.log(`rules:    set by the host (apply mode ${g.live})${g.appliedAt ? ', last applied ' + new Date(g.appliedAt).toLocaleTimeString() : ''}${g.pending ? ', changes wait for the next start' : ''}${g.switches ? `; PvP ${g.switches.pvp ? 'on' : 'off'}, flying ${g.switches.flight ? 'allowed' : 'not allowed'}, idle kick ${g.switches.idleMinutes ? g.switches.idleMinutes + ' min' : 'off'}, command blocks ${g.switches.commandBlocks ? 'on' : 'off'}` : ''}${g.error ? ' | ' + g.error : ''}`);
        const tp = s.redundantPort ? `UDP port ${s.redundantPort}` : 'automatic port';
        console.log(`send twice: ${s.redundantSend ? (s.redundantUnavailable ? `on (${tp}), but not usable here: ${s.redundantUnavailable}` : `on (${tp})`) : 'off'}`);
        const mc = s.multiCore;
        if (mc) console.log(`multi-core: ${mc.on ? `on, ${mc.threads} pool thread${mc.threads === 1 ? '' : 's'} (${mc.cpu && mc.cpu.cores != null ? Math.round(mc.cpu.cores * 100) / 100 : '?'} CPUs available${mc.cpu && mc.cpu.limitedBy ? ', limited by ' + mc.cpu.limitedBy : ''}); ${mc.packets} packets and ${mc.saves || 0} chunk files compressed on them` : mc.status === 'off' ? 'off' : `not on (${mc.status}): ${mc.error}`}`);
        const np = s.netProcs;
        if (np) console.log(`network processes: ${np.processes} (${np.list.map((p) => `${p.dead ? 'restarting' : `${p.peers} player${p.peers === 1 ? '' : 's'}, ${p.sent} packets sent`}`).join('; ')})${np.restarts ? `; started again ${np.restarts} time${np.restarts === 1 ? '' : 's'}` : ''}`);
        const sp = s.speedups;
        if (sp) {
          const pct = (h, m) => (h + m ? Math.round((h / (h + m)) * 100) : 0);
          const on = [sp.chunkCache && sp.chunkCache.on && `chunk lookups (${pct(sp.chunkCache.hits, sp.chunkCache.misses)} % from the cache)`,
            sp.uuidText && sp.uuidText.on && `UUID text (${pct(sp.uuidText.hits, sp.uuidText.misses)} % kept)`,
            sp.longConstants && sp.longConstants.on && `64-bit constants (${sp.longConstants.values} made once for ${sp.longConstants.sites} places${sp.longConstants.diff ? `, ${sp.longConstants.diff} DIFFERENT` : ''})`,
            sp.lightSets && sp.lightSets.on && `lighting sets (${sp.lightSets.sets} made with a hash that spreads heights${sp.lightSets.verify ? `; ${sp.lightSets.adds} adds checked, ${sp.lightSets.diff} DIFFERENT` : ''})`,
            sp.collisionScan && sp.collisionScan.on && `collision scan (${pct(sp.collisionScan.skipped, sp.collisionScan.calls - sp.collisionScan.skipped)} % of the walks for the entities near a moving one left out${sp.collisionScan.verify ? `; ${sp.collisionScan.skipped} checked, ${sp.collisionScan.diff} DIFFERENT` : ''})`,
            sp.encodeOnce && sp.encodeOnce.on && `encode once (${pct(sp.encodeOnce.hits, sp.encodeOnce.encoded)} % of the tracker's frames copied${sp.encodeOnce.verify ? `; ${sp.encodeOnce.checked} made again and compared, ${sp.encodeOnce.diff} DIFFERENT` : ''})`,
            sp.pathAhead && sp.pathAhead.on && `path ahead (${pct(sp.pathAhead.used, sp.pathAhead.jobs - sp.pathAhead.used)} % of the path steps handed out taken from the thread${sp.pathAhead.searches ? `, ${sp.pathAhead.sUsed} of ${sp.pathAhead.sJobs} chase searches` : ''}${sp.pathAhead.ready ? '' : ', thread not ready'}${sp.pathAhead.verify ? `; ${sp.pathAhead.checked + sp.pathAhead.sChecked} checked, ${sp.pathAhead.diff + sp.pathAhead.sDiff} DIFFERENT` : ''})`,
            sp.decoAhead && (sp.decoAhead.on || sp.decoAhead.pregen) && `decoration ahead (${[sp.decoAhead.on && 'players', sp.decoAhead.pregen && 'pre-generation'].filter(Boolean).join(' and ')}: ${sp.decoAhead.used} of ${sp.decoAhead.used + sp.decoAhead.none + sp.decoAhead.notUsable + sp.decoAhead.changed + sp.decoAhead.loadedDiff + sp.decoAhead.structure + sp.decoAhead.biome + sp.decoAhead.busy} decorations replayed from the thread${sp.decoAhead.ready ? '' : ', thread not ready'}${sp.decoAhead.verify ? `; ${sp.decoAhead.checked} compared, ${sp.decoAhead.diff} DIFFERENT` : ''})`,
            sp.packedHandover && sp.packedHandover.on && `packed hand-over (${sp.packedHandover.packed} frames handed over in one buffer per player)`,
            sp.packetBatch && sp.packetBatch.on && `packet hand-over (${sp.packetBatch.messages ? Math.round(sp.packetBatch.kept / sp.packetBatch.messages) : 0} packets a message while tracking entities` +
              (sp.packetBatch.heldMs != null ? `, the first held ${sp.packetBatch.heldMs.toFixed(1)} ms on average, ${sp.packetBatch.heldMaxMs.toFixed(1)} ms at most)` : ')')].filter(Boolean);
          console.log(`speedups: ${on.length ? on.join(', ') : 'off'}`);
        }
        const tt = s.terrain;
        if (tt && tt.wanted) {
          const tg = tt.game || {};
          console.log(`terrain:  ${tt.wanted} terrain thread${tt.wanted === 1 ? '' : 's'} for pre-generation${tt.forPlayers ? ' and players' : ''}${tt.verify ? ' (terrainVerify: compared, not used)' : ''}: ${tt.state}${tt.error ? ` (${tt.error})` : ''}` +
            (tt.runs ? `; ${tt.made} chunks made (${tt.meanMs ?? '-'} ms each${tt.forPlayers ? `, ${tt.playAsked} for players` : ''}), ${tg.used || 0} used (${tg.biomes || 0} with their biomes), ${tg.checked || 0} compared (${tg.same || 0} the same${tg.differ ? `, ${tg.differ} DIFFERENT` : ''}), ${tg.missed || 0} made by the game itself` : ''));
        }
        const pg = s.pregen;
        if (pg) console.log(`pregen:   ${pg.running ? 'running' : pg.done ? 'finished' : 'stopped'}, ${pg.processed}/${pg.total} chunks within ${pg.radius} blocks of spawn (${pg.total ? Math.floor((pg.processed / pg.total) * 100) : 0}%), ${pg.generated} generated, ${pg.read} read from disk, ${pg.lit} lit; paused for players in ${pg.yieldedTicks} ticks`);
        const pw = s.pregenWaiting;
        if (pw && !(pg && pg.running)) console.log(`pregen:   unfinished, waiting: ${pw.radius} blocks, ring ${pw.ring} of ${pw.rings} (node cli.js pregen resume continues it, pregen stop discards it)`);
        const gs = s.gameServer;
        if (gs) console.log(`game:     thread busy ${gs.busy}%, ${gs.ticks ? `ticks ${gs.ticks.n} (median ${gs.ticks.p50} ms, 95% ${gs.ticks.p95} ms, longest ${gs.ticks.max} ms, ${gs.ticks.over50} over 50 ms), ` : ''}disk writes ${gs.writesPerMin}/min (blocked ${gs.writeMsPerMin} ms, slowest ${gs.maxWriteMs} ms), garbage collection ${gs.gcMsPerMin} ms/min (longest ${gs.maxGcMs} ms), heap ${gs.heapMb}/${gs.heapLimitMb} MB (last minute)`);
      } else if (s.stopReason) console.log(`stopped:  ${s.stopReason}`);
      const cfg = c.loadConfig();
      if (cfg.configError) console.log(`WARNING:  ${cfg.configError} (defaults are used)`);
      return;
    }
    case 'cmd': {
      // A server command, as in the web page console (without op/deop: OP only changes there).
      if (!args.length) { console.log('usage: node cli.js cmd <command ...>   e.g. node cli.js cmd list'); process.exitCode = 2; return; }
      const r = await c.consoleCommand(args.join(' '), { allowOp: false });
      for (const l of r.lines) console.log(l);
      for (const l of r.log || []) console.log('[server log] ' + l);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'pregen': {
      // World pre-generation round the world spawn (see README "Pre-generating the world").
      const r = await c.consoleCommand(['pregen', ...args].join(' '), { allowOp: false });
      for (const l of r.lines) console.log(l);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'limit': {
      // Player limit (u53 itself enforces none): joins above it get a message and are refused.
      const v = String(args[0] || '').toLowerCase(), n = v === 'off' ? 0 : Number(v);
      if (!v) { const cf = c.loadConfig(); console.log(`player limit: ${cf.playerLimit ? cf.playerLimit + ' players' : 'off'}   (change with: node cli.js limit <players>|off)`); return; }
      if (!(Number.isInteger(n) && n >= 0 && n <= 1000)) { console.log('usage: node cli.js limit <1-1000|off>'); process.exitCode = 2; return; }
      c.saveConfig({ playerLimit: n });
      let r; try { r = await c.applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
      console.log(`player limit: ${n ? n + ' players' : 'off'}${r.applied ? ' (applied to players who join from now on)' : ` (saved; ${r.reason})`}`);
      return;
    }
    case 'settings': {
      // Apply data/config.json's live settings (LAN game mode, cheats, send twice) to the running world.
      if (args[0] !== 'apply') { console.log('usage: node cli.js settings apply'); process.exitCode = 2; return; }
      let r; try { r = await c.applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
      if (!r.applied) { console.log(`not applied: ${r.reason}`); return; }
      console.log(`applied: LAN game mode ${['Survival', 'Creative', 'Adventure', 'Spectator'][r.lanGamemode]} (players who join or respawn from now on), cheats ${r.lanCheats ? 'ON for every player' : 'off'}, send twice ${r.redundantSend ? 'on' : 'off'}`);
      const g = r.gameRules;
      if (g) console.log('game rules: ' + (g.error ? 'NOT applied: ' + g.error : g.pending ? 'saved, they apply at the next start' : g.off ? "no longer set by the host (switches back to the game's values)" : g.unchanged ? 'unchanged' : `applied (${(g.changed || []).length} game rules changed${g.failed && g.failed.length ? '; refused: ' + g.failed.join(', ') : ''})`));
      return;
    }
    case 'multicore': {
      // Multi-core mode (README "Multi-core mode"): saved, then applied to the running world at once.
      const v = String(args[0] || '').toLowerCase();
      if (v === 'on' || v === 'off') {
        c.saveConfig({ multiCore: v === 'on' });
        let r; try { r = await c.applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
        const m = r.multiCore;
        console.log(`multi-core mode: ${v}${!r.applied ? ` (saved; ${r.reason})` : m && v === 'on' && !m.on ? `, saved, but not on: ${m.error}` : m && m.on ? ` (applied now: ${m.threads} pool thread${m.threads === 1 ? '' : 's'})` : ' (applied now)'}`);
        return;
      }
      if (v) { console.log('usage: node cli.js multicore [on|off]'); process.exitCode = 2; return; }
      const cf = c.loadConfig(), s = await c.status(), m = s.running ? s.multiCore : null;
      console.log(`multi-core mode: ${cf.multiCore ? 'on' : 'off'} in the config${m ? `; now ${m.on ? `on, ${m.threads} pool thread${m.threads === 1 ? '' : 's'}` : m.status + (m.error ? ': ' + m.error : '')}` : ''}   (change with: node cli.js multicore on|off)`);
      return;
    }
    case 'redundant': {
      // Send small packets to players twice (see README "Network performance").
      const v = args[0];
      if (v === 'port') {
        const a = String(args[1] || '').toLowerCase(), n = Number(a);
        if (a !== 'auto' && !(Number.isInteger(n) && n >= 1024 && n <= 65535)) { console.log('usage: node cli.js redundant port <1024-65535|auto>'); process.exitCode = 2; return; }
        c.saveConfig({ redundantPort: a === 'auto' ? null : n });
        let r; try { r = await c.applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
        console.log(`send twice port: ${a === 'auto' ? 'automatic' : 'UDP ' + n}${r.applied ? ' (applied to players who join from now on)' : ` (saved; ${r.reason})`}`);
        return;
      }
      if (v === 'on' || v === 'off') {
        c.saveConfig({ redundantSend: v === 'on' });
        let r; try { r = await c.applySettings(); } catch (e) { r = { applied: false, reason: e.message }; }
        console.log(`send twice: ${v}${r.applied ? ' (applied to players who join from now on)' : ` (saved; ${r.reason})`}`);
        return;
      }
      if (v) { console.log('usage: node cli.js redundant [on|off|port <n|auto>]'); process.exitCode = 2; return; }
      const cf = c.loadConfig();
      console.log(`send twice: ${cf.redundantSend ? 'on' : 'off'}, ${cf.redundantPort ? 'UDP port ' + cf.redundantPort : 'automatic port'}   (change with: node cli.js redundant on|off, node cli.js redundant port <n|auto>)`);
      return;
    }
    case 'relays': {
      const sub = args[0] || 'show';
      if (sub === 'apply') {
        const r = await c.applyRelays();
        for (const w of r.warnings) console.log('warning: ' + w);
        console.log(r.applied ? `applied ${r.relays.length} relays to the running world` : `not applied: ${r.reason}`);
        if (r.state) console.log(relayTable(r.state));
        return;
      }
      if (sub === 'probe') {
        const urls = args.length > 1 ? require('./src/relay').normalizeRelays(args.slice(1)).relays : c.loadRelays().relays;
        console.log(`probing ${urls.length} relays (temporary hidden test registrations, ~10-45s)...`);
        const rs = await require('./src/relay-probe').probeRelays(urls, {});
        for (const r of rs) {
          const ok = r.verdict === 'compatible';
          const info = r.registration ? `registration ${r.registration.ms}ms, ${r.registration.iceServers} ICE servers${r.registration.turn ? ' incl. TURN' : ', no TURN'}` : '';
          const join = r.join && r.join.ms ? `, join via code ${r.join.ms}ms` : '';
          console.log(`${ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(28)} ${r.verdict.padEnd(12)} ${info}${join}${r.detail ? ' - ' + r.detail : ''}`);
        }
        process.exit(0);
      }
      const r = c.loadRelays();
      console.log(`relay list: ${r.file}`);
      for (const u of r.relays) console.log('  ' + u);
      for (const w of r.warnings) console.log('warning: ' + w);
      const s = await c.status();
      if (s.running) console.log('live state:\n' + relayTable(s.relays));
      return;
    }
    case 'logs': return (await c.logs(0)).lines.forEach((l) => console.log(l.line));
    default: {
      // The comment block at the top of this file.
      const ls = require('fs').readFileSync(__filename, 'utf8').split(/\r?\n/).slice(2);
      console.log(ls.slice(0, ls.findIndex((l) => !l.startsWith('//'))).join('\n').replace(/^\/\/ ?/gm, ''));
    }
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
