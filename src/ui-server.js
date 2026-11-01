'use strict';
// Web UI + JSON API. Stateless: all hosting happens in the detached daemon, so
// this server (and any browser tab on it) can be closed without affecting players.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const c = require('./control');
const paths = require('./paths');
const options = require('./options');

const cfg = c.loadConfig();
const PORT = +(process.env.PORT || cfg.uiPort || 8090);
const HOST = process.env.BIND || '127.0.0.1';
const PUBLIC = path.join(paths.root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.epk': 'application/octet-stream', '.png': 'image/png', '.lang': 'text/plain; charset=utf-8', '.json': 'application/json' };

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? String(v) : v))); };
const body = (req, limit = 1e6) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
  req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
});
const serveFile = (res, f) => {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
};

// The vendored u53 client page for players (same relays as the host).
function clientPage() {
  const relays = c.loadConfig().relays.map((a, i) => ({ addr: a, comment: 'relay ' + (i + 1), primary: i === 0 }));
  return `<!DOCTYPE html><html style="width:100%;height:100%;background:black"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0"><title>EaglercraftX 1.8 u53</title><link rel="shortcut icon" href="favicon.png">
<script src="classes.js"></script><script>"use strict";window.addEventListener("load",function(){window.eaglercraftXOpts={container:"game_frame",assetsURI:"assets.epk",localesURI:"lang/",worldsDB:"worlds",servers:[],relays:${JSON.stringify(relays)}};main();});</script>
<script src="/donate.js" defer></script>
</head><body style="margin:0;width:100%;height:100%;overflow:hidden;background:black" id="game_frame"></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    // The donation message on the players' pages (donation.js): the card's script and its own page.
    if (u.pathname === '/donate.js') return serveFile(res, path.join(PUBLIC, 'donate.js'));
    if (u.pathname === '/donate' || u.pathname === '/donate/') return serveFile(res, path.join(PUBLIC, 'donate.html'));
    if (u.pathname === '/client/' || u.pathname === '/client/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(clientPage()); }
    if (u.pathname.startsWith('/client/')) {
      const f = path.join(paths.vendorDir, decodeURIComponent(u.pathname.slice(8)));
      if (!f.startsWith(paths.vendorDir)) { res.writeHead(403); return res.end(); }
      return serveFile(res, f);
    }
    if (u.pathname.startsWith('/exports/')) {
      const name = path.basename(decodeURIComponent(u.pathname.slice(9)));
      const f = path.join(paths.dataDir, 'exports', name);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` });
      return fs.createReadStream(f).pipe(res);
    }
    if (!u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }
    const api = u.pathname.slice(5);
    if (req.method === 'GET') {
      if (api === 'status') return json(res, 200, await c.status());
      if (api === 'worlds') return json(res, 200, c.store.list());
      if (api === 'logs') return json(res, 200, await c.logs(+u.searchParams.get('since') || 0));
      if (api === 'config') return json(res, 200, c.loadConfig());
      // Option Manual (options.js): every setting with its default and the value data/config.json has.
      if (api === 'options') { const f = c.readConfigFile(); return json(res, 200, { options: options.describe(c.DEFAULT_CONFIG, f.data), file: paths.configFile, error: f.error || null }); }
      if (api === 'gamerules') return json(res, 200, await c.gameRulesInfo());
      if (api === 'exports') return json(res, 200, c.listExports());
      if (api === 'deleted') return json(res, 200, c.listDeleted());
      // the donation message: what the players' page shows (nothing while off); the settings for this page
      if (api === 'donation') return json(res, 200, await c.donationPublic());
      if (api === 'donation/settings') return json(res, 200, await c.donationInfo());
    }
    if (req.method === 'POST') {
      // Basic CSRF guard: only same-origin JSON / octet-stream posts.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
      if (api === 'import') {
        const fmt = u.searchParams.get('format') === 'mca' ? 'mca' : 'epk';
        const data = await body(req, 512 * 1024 * 1024);
        if (!data.length) return json(res, 400, { error: 'empty file' });
        fs.mkdirSync(paths.importDir, { recursive: true });
        const file = path.join(paths.importDir, `${Date.now()}.${fmt === 'mca' ? 'zip' : 'epk'}`);
        fs.writeFileSync(file, data);
        return json(res, 200, await c.importWorld({ file, name: u.searchParams.get('name') || 'Imported World', format: fmt }));
      }
      const b = JSON.parse((await body(req)).toString('utf8') || '{}');
      if (api === 'start') return json(res, 200, await c.start({ folder: b.folder }));
      if (api === 'create') return json(res, 200, await c.create(b));
      if (api === 'export') return json(res, 200, await c.exportWorld({ folder: b.folder, format: b.format === 'mca' ? 'mca' : 'epk' }));
      // Worlds: rename; delete (into the deleted worlds), restore, delete permanently (typed name to confirm). Only while
      // no world runs (control.js).
      if (api === 'rename') return json(res, 200, await c.renameWorld({ folder: b.folder, name: b.name }));
      if (api === 'delete') return json(res, 200, await c.deleteWorld({ folder: b.folder, confirm: b.confirm }));
      if (api === 'restore') return json(res, 200, await c.restoreWorld({ id: b.id }));
      if (api === 'purge') return json(res, 200, await c.purgeWorld({ id: b.id, confirm: b.confirm }));
      // The donation message: save its settings (checked; a running world takes them at once); send it to the chat now.
      if (api === 'donation') return json(res, 200, await c.saveDonation(b));
      if (api === 'donation/send') return json(res, 200, await c.sendDonationNow());
      if (api === 'stop') return json(res, 200, await c.stop());
      if (api === 'restart') return json(res, 200, await c.restart());
      if (api === 'save') return json(res, 200, await c.save());
      // Console: every game command, and the only place where OP is given or taken.
      if (api === 'console') return json(res, 200, await c.consoleCommand(b.command, { allowOp: true }));
      if (api === 'console-complete') return json(res, 200, await c.consoleComplete(b.text));
      // The Pre-generate button: {action: "start", radius, rate} | {action: "resume"} | {action: "stop"}.
      if (api === 'pregen') {
        if (!['start', 'resume', 'stop', 'status'].includes(b.action)) return json(res, 400, { error: 'action must be start, resume, stop or status' });
        const r = await c.pregen(b.action === 'start' ? { action: 'start', radius: Number(b.radius), rate: b.rate === '' || b.rate == null ? null : Number(b.rate) } : { action: b.action });
        return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.lines.join(' ') });
      }
      // Option Manual: {key, value} saves that one setting (validated in options.js; every other key of the file stays as
      // it is). A setting a running world takes at once is sent to it (the host applies only what changed).
      if (api === 'options') {
        const v = options.validate(b.key, b.value);
        if (v.error) return json(res, 400, { error: v.error });
        const f = c.readConfigFile();
        if (f.error) return json(res, 400, { error: f.error + ': fix or remove the file first (nothing was saved)' });
        c.saveConfig({ [b.key]: v.value });
        const o = options.OPTIONS.find((x) => x.key === b.key);
        let applied = null;
        if (o.applies === 'live') { try { applied = await c.applySettings(); } catch (e) { applied = { applied: false, reason: e.message }; } }
        return json(res, 200, { ok: true, key: b.key, value: v.value, applies: o.applies, applied, options: options.describe(c.DEFAULT_CONFIG, c.readConfigFile().data) });
      }
      if (api === 'config') {
        const allowed = ['relays', 'ownerName', 'hidden', 'lanWorldName', 'lanGamemode', 'lanCheats', 'difficulty', 'viewDistance', 'redundantSend', 'redundantPort', 'gameRules', 'playerLimit', 'multiCore'];
        const patch = {}; for (const k of allowed) if (k in b) patch[k] = b[k];
        if ('redundantPort' in patch) {
          // Empty: a free port per player (automatic). Ports below 1024 need root, so they are not offered.
          if (patch.redundantPort === '' || patch.redundantPort === undefined) patch.redundantPort = null;
          if (patch.redundantPort !== null && !(Number.isInteger(patch.redundantPort) && patch.redundantPort >= 1024 && patch.redundantPort <= 65535)) return json(res, 400, { error: 'UDP port for send twice must be a whole number from 1024 to 65535, or empty for automatic' });
        }
        if ('playerLimit' in patch) {
          if (patch.playerLimit === '' || patch.playerLimit === null || patch.playerLimit === undefined) patch.playerLimit = 0;
          if (!(Number.isInteger(patch.playerLimit) && patch.playerLimit >= 0 && patch.playerLimit <= 1000)) return json(res, 400, { error: 'Player limit must be a whole number from 0 to 1000 (0 or empty: no limit)' });
        }
        if ('redundantSend' in patch && typeof patch.redundantSend !== 'boolean') return json(res, 400, { error: 'redundantSend must be true or false' });
        if ('multiCore' in patch && typeof patch.multiCore !== 'boolean') return json(res, 400, { error: 'multiCore must be true or false' });
        if ('lanCheats' in patch && typeof patch.lanCheats !== 'boolean') return json(res, 400, { error: 'lanCheats must be true or false' });
        if ('gameRules' in patch) {
          const g = require('./game-rules').normalize(patch.gameRules);
          if (g.errors.length) return json(res, 400, { error: 'Game rules: ' + g.errors.join('; ') });
          patch.gameRules = g.value;
        }
        if ('lanGamemode' in patch && ![0, 1, 2, 3].includes(patch.lanGamemode)) return json(res, 400, { error: 'lanGamemode must be 0 (Survival), 1 (Creative), 2 (Adventure) or 3 (Spectator)' });
        // Relays are validated/de-duplicated and stored in data/relays.txt (see control.js).
        const saved = c.saveConfig(patch);
        let relaysApplied = null;
        if ('relays' in patch) {
          try { relaysApplied = await c.applyRelays(); } catch (e) { relaysApplied = { applied: false, reason: e.message }; }
        }
        let settingsApplied = null;
        if (['redundantSend', 'redundantPort', 'lanGamemode', 'lanCheats', 'gameRules', 'playerLimit', 'multiCore'].some((k) => k in patch)) {
          try { settingsApplied = await c.applySettings(); } catch (e) { settingsApplied = { applied: false, reason: e.message }; }
        }
        return json(res, 200, { ...saved, relaysApplied, settingsApplied });
      }
    }
    json(res, 404, { error: 'unknown endpoint' });
  } catch (e) { json(res, 400, { error: e.message }); }
});

server.listen(PORT, HOST, () => {
  console.log(`Eaglercraft headless World LAN host UI: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/  (client for players: /client/)`);
  autostart().catch((e) => console.error('autostart failed:', e.message));
});

// Service mode helpers (Docker / systemd):
//   EAGLAN_AUTOSTART=<world folder> | last   host a world when the UI server starts (if none is running)
//   EAGLAN_STOP_HOST_ON_EXIT=1                on SIGTERM/SIGINT, stop the host gracefully (saves the world) before exiting
async function autostart() {
  const want = process.env.EAGLAN_AUTOSTART;
  if (!want) return;
  const st = await c.status();
  if (st.running) { console.log(`autostart: host already running (world '${st.world}')`); return; }
  if (want === 'last') {
    try { const r = await c.restart(); console.log(`autostart: hosting last world '${r.world}'`); }
    catch (e) { console.log('autostart: no previous world to resume (' + e.message + ')'); }
    return;
  }
  // Match by folder first, then by display name, so a world created here is found again next boot.
  const worlds = c.store.list();
  const w = worlds.find((x) => x.folder === want) || worlds.find((x) => x.name === want);
  const exists = !!w;
  const r = exists ? await c.start({ folder: w.folder }) : await c.create({ name: want });
  console.log(`autostart: ${exists ? 'hosting' : 'created and hosting new'} world '${r.world}'`);
}

let exiting = false;
async function onSignal(sig) {
  if (exiting) return; exiting = true;
  if (process.env.EAGLAN_STOP_HOST_ON_EXIT === '1') {
    console.log(`${sig}: stopping host gracefully (saving world)…`);
    try { const r = await c.stop(); console.log('host stopped', r.graceful === false ? '(forced)' : '(graceful)'); } catch (e) { console.error('stop failed:', e.message); }
  }
  server.close(); process.exit(0);
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => onSignal(s));
