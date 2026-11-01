// End-to-end test: unmodified EaglercraftX u53 client(s) join the headless host by
// join code through the normal GUI (Multiplayer > Direct Connect > Join Shared World).
// The client runs in chrome-headless-shell with SwiftShader (CPU WebGL) - this is the
// *joining player*, not the host.
//
//   node test/join-test.js <joinCode>[,<code2>,...] [numClients=1] [chatText]
// Client i uses code i (or the first code). Per-client relay lists for multi-relay tests:
//   RELAYS_1="wss://a/,wss://b/" RELAYS_2="wss://c/"   (default: the host's configured relays)
// CAPTURE_WS=1 records every relay WebSocket frame the client sends/receives (test/out/ws-c<i>.json).
// TRACE_DC=1 records the time and size of every data-channel message (test/out/dc-trace-c<i>.json).
// CHROME_ARGS="..." adds browser flags (e.g. --force-webrtc-ip-handling-policy=default_public_interface_only).
// ACTIONS="inv;cmd:/time set day;respawn" runs checks right after joining (see below).
// WALK_MS=<ms> walks forward that long (default 3000; longer walks load and save new chunks).
// JOIN_ONLY=1 leaves right after joining (sequential join tests with many clients);
// CONSOLE_DIR=<dir> saves each client's whole console with timestamps (<dir>/c<i>.log).
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const relayCodec = require('../src/relay');

const CODES = String(process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const N = +(process.argv[3] || 1);
const CHAT = process.argv[4] || 'hello from headless test';
if (!CODES.length) { console.error('usage: join-test.js <code>[,code2...] [n] [chat]'); process.exit(2); }
const codeFor = (i) => CODES[i - 1] || CODES[0];

const VENDOR = path.resolve(__dirname, '../vendor/eaglercraftx-1.8-u53');
const OUT = path.resolve(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const cfg = require('../src/control').loadConfig();
const shell = (() => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(require('os').homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'); if (fs.existsSync(p)) return p; const q = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'); if (fs.existsSync(q)) return q; }
  throw new Error('chrome-headless-shell not found');
})();

const page = (relays) => `<!DOCTYPE html><html style="width:100%;height:100%;background:black"><head><meta charset="UTF-8"><title>u53 test client</title>
<script src="classes.js"></script><script>
window.__screen=null;window.__screens=[];
window.addEventListener('load',function(){window.eaglercraftXOpts={container:'game_frame',assetsURI:'assets.epk',localesURI:'lang/',worldsDB:'worlds',
allowUpdateSvc:false,allowUpdateDL:false,checkRelaysForUpdates:false,
relays:${JSON.stringify(relays.map((a, i) => ({ addr: a, comment: 'relay ' + i, primary: i === 0 })))},
hooks:{screenChanged:function(name,sw,sh,rw,rh,sf){window.__screen={name:name,sw:sw,sh:sh,rw:rw,rh:rh,sf:sf,t:Date.now()};window.__screens.push(name);console.log('SCREEN '+name+' '+sw+'x'+sh+' sf'+sf);}}};main();});
</script></head><body style="margin:0;width:100%;height:100%;overflow:hidden" id="game_frame"></body></html>`;

const types = { '.js': 'text/javascript', '.epk': 'application/octet-stream', '.png': 'image/png', '.lang': 'text/plain' };
const relaysFor = (i) => {
  const v = process.env['RELAYS_' + i] || process.env.RELAYS;
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : cfg.relays;
};
const srv = http.createServer((req, res) => {
  const [rawPath, qs] = req.url.split('?');
  const u = decodeURIComponent(rawPath);
  if (u === '/' || u === '/test.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(relaysFor(+new URLSearchParams(qs || '').get('c') || 1))); }
  const f = path.join(VENDOR, u);
  if (!f.startsWith(VENDOR) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function runClient(browser, idx) {
  const uname = process.env['NAME_' + idx] || `Tester${idx + (+process.env.NAME_OFFSET || 0)}`;   // NAME_<i>: client i's player name
  const tag = `[client${idx}]`;
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 960, height: 540 });
  const logs = [], timeline = [];
  p.on('console', (m) => { const t = m.text(); logs.push(t); timeline.push(`${new Date().toISOString()} ${t}`); if (/SCREEN|LAN|Relay|\bconnect|rror|kick|Disconnect/i.test(t) && !/ConnectedTextures|OptiFine/.test(t)) console.log(tag, t.slice(0, 240)); });
  p.on('pageerror', (e) => console.log(tag, 'pageerror', e.message));
  const frames = [];
  if (process.env.CAPTURE_WS) {
    // Record relay traffic as the real client sees it (Chrome DevTools protocol).
    const cdp = await p.createCDPSession();
    await cdp.send('Network.enable');
    const urls = new Map();
    cdp.on('Network.webSocketCreated', (e) => urls.set(e.requestId, e.url));
    const rec = (dir) => (e) => {
      const f = { t: Date.now(), dir, url: urls.get(e.requestId), opcode: e.response.opcode };
      if (e.response.opcode === 2) { const b = Buffer.from(e.response.payloadData, 'base64'); f.hex = b.toString('hex').slice(0, 64); try { const pk = relayCodec.read(b); f.pkt = { ...pk }; for (const k of ['description', 'candidate']) if (f.pkt[k]) f.pkt[k] = f.pkt[k].slice(0, 80) + (f.pkt[k].length > 80 ? '...' : ''); if (pk.servers) f.pkt.servers = pk.servers.length + ' servers'; } catch (err) { f.err = err.message; } }
      else f.text = String(e.response.payloadData).slice(0, 120);
      frames.push(f);
    };
    cdp.on('Network.webSocketFrameSent', rec('client->relay'));
    cdp.on('Network.webSocketFrameReceived', rec('relay->client'));
    cdp.on('Network.webSocketClosed', (e) => frames.push({ t: Date.now(), dir: 'closed', url: urls.get(e.requestId) }));
  }
  if (process.env.TRACE_DC) {
    // Record the size and time of every game message on the data channel (for test/netlab replay).
    await p.evaluateOnNewDocument(() => {
      const T = window.__dctrace = [];
      const orig = RTCPeerConnection.prototype.createDataChannel;
      const len = (d) => d.byteLength ?? d.size ?? d.length ?? 0;
      RTCPeerConnection.prototype.createDataChannel = function (...a) {
        const ch = orig.apply(this, a), send = ch.send;
        ch.send = function (d) { T.push([performance.now(), 0, len(d)]); return send.call(this, d); };
        ch.addEventListener('message', (e) => T.push([performance.now(), 1, len(e.data)]));
        ch.addEventListener('open', () => T.push([performance.now(), 2, 0]));
        return ch;
      };
    });
  }
  if (process.env.ICE_STATS) {
    // Keep the client's peer connections so their ICE candidate pairs can be printed (debugging).
    await p.evaluateOnNewDocument(() => {
      const Orig = window.RTCPeerConnection; window.__pcs = [];
      window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
      window.RTCPeerConnection.prototype = Orig.prototype;
    });
  }
  const CODE = codeFor(idx);
  await p.goto(`http://127.0.0.1:${srv.address().port}/test.html?c=${idx}`);
  const r = { client: idx, steps: [], relays: relaysFor(idx), code: CODE };
  r.frames = frames;
  const step = (s) => { r.steps.push(s); console.log(tag, 'STEP', s); };
  const shot = (n) => p.screenshot({ path: path.join(OUT, `c${idx}-${n}.png`) });
  const scr = () => p.evaluate(() => window.__screen);
  const waitScreen = async (re, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = await scr(); if (s && re.test(String(s.name))) return s; await sleep(250); }
    const s = await scr(); throw new Error(`timeout waiting for screen ${re} (current ${s && s.name})`);
  };
  const click = async (s, x, y) => { await p.mouse.click(Math.round(x * s.sf), Math.round(y * s.sf)); await sleep(400); };
  try {
    const gl = await p.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g) return 'NO WEBGL2'; const e = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : g.RENDERER); });
    step('client WebGL renderer: ' + gl);
    // First-launch screens of a fresh browser profile, then the main menu.
    let s = await waitScreen(/GuiMainMenu|GuiScreenContentWarning|GuiScreenEditProfile/, 120000);
    for (let guard = 0; !/GuiMainMenu/.test(s.name) && guard < 5; guard++) {
      await sleep(1000);
      if (/GuiScreenContentWarning/.test(s.name)) {
        await click(s, s.sw / 2, Math.floor(s.sh / 6) + 138 + 10);                     // Done
      } else if (/GuiScreenEditProfile/.test(s.name)) {
        await click(s, s.sw / 2 - 20 + 70, Math.floor(s.sh / 6) + 24 + 10);            // username field
        await p.keyboard.press('End');
        for (let k = 0; k < 20; k++) await p.keyboard.press('Backspace');
        await p.keyboard.type(uname, { delay: 40 });
        step(`set username ${uname}`); await shot('0-profile');
        await click(s, s.sw / 2, Math.floor(s.sh / 6) + 168 + 10);                     // Done
      }
      s = await waitScreen(/GuiMainMenu|GuiScreenContentWarning|GuiScreenEditProfile/, 30000);
    }
    await sleep(1500); await shot('1-mainmenu');
    step(`main menu (${s.sw}x${s.sh} scale ${s.sf})`);
    await click(s, s.sw / 2, Math.floor(s.sh / 4) + 48 + 24 + 10);                     // Multiplayer
    s = await waitScreen(/GuiMultiplayer/); await sleep(800); await shot('2-multiplayer');
    await click(s, s.sw / 2, s.sh - 42);                                                // Direct Connect
    s = await waitScreen(/GuiScreenConnectOption/); await sleep(500); await shot('3-connectoption');
    await click(s, s.sw / 2, Math.floor(s.sh / 4) - 60 + 115 + 10);                     // Join Shared World
    s = await waitScreen(/GuiScreenLANConnect$|GuiScreenLANInfo/);
    if (/GuiScreenLANInfo/.test(s.name)) {                                             // one-time info: Continue
      await sleep(800); await click(s, s.sw / 2, Math.floor(s.sh / 6) + 168 + 10);
      s = await waitScreen(/GuiScreenLANConnect$/);
    }
    await sleep(500);
    await click(s, s.sw / 2, Math.floor(s.sh / 4) + 27 + 10);                           // code field
    await p.keyboard.type(CODE, { delay: 60 }); await sleep(300); await shot('4-code');
    step('entered join code ' + CODE);
    await click(s, s.sw / 2, Math.floor(s.sh / 4) + 96 + 12 + 10);                      // Join
    const t0 = Date.now();
    // In game, the hook reports a null screen.
    for (;;) {
      const cur = await scr();
      if (cur && (cur.name == null || cur.name === 'null') && (await p.evaluate(() => window.__screens.some((n) => /LANConnecting/.test(n))))) break;
      if (cur && /Disconnected|NoRelays|Error|Failed/.test(cur.name)) { await shot('5-fail'); throw new Error('join failed: screen ' + cur.name); }
      if (Date.now() - t0 > 90000) { await shot('5-timeout'); throw new Error('timeout joining, screen ' + (cur && cur.name)); }
      await sleep(300);
    }
    step(`joined world in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    r.joinSec = (Date.now() - t0) / 1000;
    if (process.env.JOIN_ONLY) { r.ok = true; throw Object.assign(new Error('join only'), { joinOnly: true }); }
    if (process.env.ICE_STATS) {
      const dump = async () => {
        const pairs = await p.evaluate(async () => {
          const out = [];
          for (const pc of window.__pcs || []) {
            const st = await pc.getStats(); const by = new Map(); let sel = null;
            st.forEach((r) => { by.set(r.id, r); if (r.type === 'transport' && r.selectedCandidatePairId) sel = r.selectedCandidatePairId; });
            st.forEach((r) => {
              if (r.type !== 'candidate-pair') return;
              const l = by.get(r.localCandidateId), m = by.get(r.remoteCandidateId);
              out.push(`${r.id === sel ? 'SELECTED ' : ''}${r.state}${r.nominated ? ' nominated' : ''} prio ${r.priority} | local ${l && `${l.candidateType} ${l.address}:${l.port} p${l.priority} ${l.networkType || ''}`} | remote ${m && `${m.candidateType} ${m.address}:${m.port} p${m.priority}`} | sent ${r.bytesSent}`);
            });
          }
          return out;
        }).catch((e) => ['stats error ' + e.message]);
        console.log(tag, 'ICE pairs:\n  ' + pairs.filter((x) => /SELECTED|succeeded/.test(x)).join('\n  '));
      };
      await dump(); setTimeout(dump, 4000); setTimeout(dump, 10000);
    }
    await sleep(6000); await shot('6-ingame');
    const actions = process.env['ACTIONS_' + idx] || process.env.ACTIONS;
    if (actions) {
      // ACTIONS="inv;cmd:/time set day;respawn" (separated by ;): checks run right after joining.
      // ACTIONS_<i> gives client i its own list.
      //   inv      open the inventory and report its screen (GuiContainerCreative = Creative mode)
      //   cmd:<t>  type <t> in chat and report the chat lines it produced
      //   respawn  wait for the death screen and click Respawn
      //   wait:<ms> stay in the game that long (prints "STEP waiting" first, so a script can change host settings meanwhile)
      //   attack   left click without moving the mouse (hits what the crosshair points at)
      for (const act of actions.split(';').map((x) => x.trim()).filter(Boolean)) {
        if (act.startsWith('wait:')) { step(`waiting ${+act.slice(5)} ms`); await sleep(+act.slice(5)); continue; }
        if (act === 'attack') { await p.mouse.down(); await sleep(120); await p.mouse.up(); await sleep(1000); step('attacked (left click)'); continue; }
        if (act === 'inv') {
          await p.keyboard.press('KeyE'); await sleep(1500);
          const sc = await scr(); step(`inventory screen: ${sc && sc.name}`);
          for (const key of ['KeyE', 'Escape']) { const c2 = await scr(); if (!c2 || c2.name == null || c2.name === 'null') break; await p.keyboard.press(key); await sleep(800); }
        } else if (act.startsWith('cmd:')) {
          const before = logs.length;
          await p.keyboard.press('KeyT'); await sleep(700);
          await p.keyboard.type(act.slice(4), { delay: 30 }); await p.keyboard.press('Enter'); await sleep(2000);
          const said = logs.slice(before).filter((l) => /\[CHAT\]/.test(l)).map((l) => l.replace(/^.*\[CHAT\]\s*/, ''));
          step(`command ${act.slice(4)} -> ${said.join(' / ') || '(no chat reply)'}`);
        } else if (act === 'respawn') {
          const s2 = await waitScreen(/GuiGameOver/, 10000); await sleep(2000);
          await click(s2, s2.sw / 2, Math.floor(s2.sh / 4) + 72 + 10);
          for (let k = 0; k < 40; k++) { const c2 = await scr(); if (c2 && (c2.name == null || c2.name === 'null')) break; await sleep(250); }
          await sleep(2500); step('respawned');
        }
      }
    }
    // Gameplay: chat + walk.
    await p.keyboard.press('KeyT'); await sleep(700);
    await p.keyboard.type(`${CHAT} #${idx}`, { delay: 30 }); await p.keyboard.press('Enter');
    step('sent chat message');
    await sleep(800);
    await p.keyboard.down('KeyW'); await sleep(+(process.env.WALK_MS || 3000)); await p.keyboard.up('KeyW');
    await p.keyboard.press('Space'); await sleep(500);
    step('walked forward 3s and jumped');
    await sleep(3000); await shot('7-after-walk');
    if (process.env.BREAK) {
      // Look straight down and hold left click to mine the block underfoot.
      const cx = 480, cy = 270;
      await p.mouse.move(cx, cy); for (let k = 0; k < 12; k++) { await p.mouse.move(cx, cy + 40 * (k + 1)); await sleep(30); }
      await sleep(500); await shot('8-look-down');
      await p.mouse.down(); await sleep(5000); await p.mouse.up();
      await sleep(2500); await shot('9-after-mine');
      step('held attack 5s on the block below');
    }
    r.ok = true;
  } catch (e) { if (!e.joinOnly) { r.ok = false; r.error = e.message; console.log(tag, 'FAILED', e.message); } }
  // CONSOLE_DIR=<dir>: the client's whole console with timestamps (for comparing failed and good joins).
  if (process.env.CONSOLE_DIR) { try { fs.mkdirSync(process.env.CONSOLE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CONSOLE_DIR, `c${idx}.log`), timeline.join('\n') + '\n'); } catch {} }
  // JOIN_ONLY=1: leave right after joining (sequential join tests).
  if (process.env.JOIN_ONLY) { try { await ctx.close(); } catch {} }
  r.logTail = logs.filter((l) => /LAN|Relay|Shared|connect|kick|isconnect/i.test(l)).slice(-15);
  r.page = p; r.ctx = ctx;
  r.chat = () => logs.filter((l) => /\[CHAT\]/.test(l)).map((l) => l.replace(/^.*\[CHAT\]\s*/, ''));
  return r;
}

srv.listen(0, '127.0.0.1', async () => {
  const browser = await puppeteer.launch({
    executablePath: shell, headless: true,
    args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', ...(process.env.CHROME_ARGS || '').split(' ').filter(Boolean)],
  });
  const rs = [];
  for (let i = 1; i <= N; i++) rs.push(await runClient(browser, i));
  const hold = +(process.env.HOLD_MS || 0);
  if (hold) { console.log(`holding clients connected for ${hold / 1000}s`); await sleep(hold); }
  for (const r of rs) {
    try { await r.page.screenshot({ path: path.join(OUT, `c${r.client}-z-final.png`) }); } catch {}
    console.log(JSON.stringify({ client: r.client, ok: r.ok, error: r.error, steps: r.steps, chatSeen: r.chat() }, null, 1));
  }
  if (process.env.TRACE_DC) for (const r of rs) { try { fs.writeFileSync(path.join(OUT, `dc-trace-c${r.client}.json`), JSON.stringify(await r.page.evaluate(() => window.__dctrace))); } catch (e) { console.log('trace', e.message); } }
  for (const r of rs) if (r.frames.length) fs.writeFileSync(path.join(OUT, `ws-c${r.client}.json`), JSON.stringify(r.frames, null, 1));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rs.map(({ page, ctx, chat, frames, ...x }) => ({ ...x, chatSeen: chat() })), null, 2));
  await browser.close(); srv.close();
  process.exit(rs.every((r) => r.ok) ? 0 : 1);
});
