'use strict';
// The donation message (src/donation.js; config donation; web page "Donation message"; players' page public/donate.js):
// off by default; the settings checked; the chat message (the address a link whose "Copy to Clipboard" copies it); when
// it goes out (lag below the threshold with players on, at most once per cooldown). The HTTP API and the real pages
// (chrome-headless-shell; skipped without it): the section, saving (kept across a restart of the web page server),
// /client/ and /donate showing the card only while on. With the real daemon and game and a player: the message in the
// player's chat when the server lags (simulated: EAGLAN_DEBUG_DONATION_TPS), not again within the cooldown, and when
// the owner sends it.
//   node --test test/donation.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-donation-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const donation = require('../src/donation');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const ADDRESS = 'TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const relays = [], bots = [], children = [];
after(async () => {
  for (const b of bots) b.close();
  for (const ch of children) ch.kill();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) { await sleep(500); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

test('settings, the chat message and when it goes out', () => {
  const def = donation.normalize(undefined).value;
  assert.equal(def.enabled, false, 'off by default');
  assert.equal(def.address, ADDRESS);
  assert.deepEqual(c.DEFAULT_CONFIG.donation, donation.DEFAULTS);
  // checked: each wrong field reported, its default kept
  const bad = donation.normalize({ enabled: 'yes', message: '', goal: -1, raised: 'x', address: 'has space', lagTps: 25, cooldownMinutes: 0.5, currency: 'x'.repeat(13), network: 'a\u0001b' });
  assert.equal(bad.errors.length, 9, bad.errors.join(' | '));
  assert.deepEqual(bad.value, def);
  const ok = donation.normalize({ enabled: true, message: '  Help   us\n grow ', goal: '100', raised: 25.5, currency: 'TRX', goalFor: 'more RAM', lagTps: 12.5, cooldownMinutes: 10 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.value.message, ok.value.goal, ok.value.raised, ok.value.lagTps], ['Help us grow', 100, 25.5, 12.5]);
  assert.equal(donation.goalText(ok.value), '25.5 of 100 TRX raised for more RAM');
  assert.equal(donation.goalText({ ...ok.value, raised: 0 }), 'Goal: 100 TRX for more RAM');
  assert.equal(donation.goalText({ ...ok.value, goal: 0 }), '', 'no goal: not shown');
  // the chat message: tellraw with the game's text components; the address a link (the game's "open or copy" screen),
  // shift-click inserts it, a hint shows on hover
  const cmd = donation.chatCommand(ok.value, { lag: true });
  assert.match(cmd, /^tellraw @a \[/);
  const parts = JSON.parse(cmd.slice('tellraw @a '.length));
  const addr = parts.find((p) => p.text === ADDRESS);
  assert.deepEqual(addr.clickEvent, { action: 'open_url', value: ADDRESS });
  assert.equal(addr.insertion, ADDRESS);
  assert.match(JSON.stringify(addr.hoverEvent), /Copy to Clipboard/);
  assert.ok(parts.some((p) => /running slow/.test(p.text)), 'the lag line');
  assert.ok(!JSON.stringify(donation.chatComponents(ok.value)).includes('running slow'), 'no lag line when sent by hand');
  assert.ok(parts.some((p) => p.text.includes('25.5 of 100 TRX raised for more RAM')));
  // what the players' page gets: nothing but "off" while off
  assert.deepEqual(donation.publicView(def), { enabled: false });
  assert.deepEqual(Object.keys(donation.publicView(ok.value, { lag: true })).sort(), ['address', 'cooldownMinutes', 'currency', 'enabled', 'goal', 'goalFor', 'goalText', 'lag', 'message', 'network', 'raised']);
  // when: below the threshold, players on, after the cooldown; never while off
  const at = (o) => donation.lagDecision(ok.value, { tps: 10, players: 2, now: 1e9, lastAt: null, ...o });
  assert.deepEqual(at({}), { lag: true, send: true });
  assert.deepEqual(at({ tps: 12.5 }), { lag: false, send: false }, 'at the threshold: no lag');
  assert.deepEqual(at({ tps: null }), { lag: false, send: false }, 'not measured yet');
  assert.deepEqual(at({ players: 0 }), { lag: true, send: false }, 'nobody to tell');
  assert.deepEqual(at({ lastAt: 1e9 - 9 * 60000 }), { lag: true, send: false }, 'within the cooldown');
  assert.deepEqual(at({ lastAt: 1e9 - 10 * 60000 }), { lag: true, send: true }, 'after it');
  assert.deepEqual(donation.lagDecision(def, { tps: 1, players: 5, now: 1e9, lastAt: null }), { lag: false, send: false }, 'off');
});

// ---- the HTTP API and the real pages
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const call = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
    let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s), text: s }); } catch { resolve({ status: res.statusCode, body: null, text: s }); } });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
async function startUi(dir) {
  const port = await freePort();
  const env = { ...process.env, EAGLAN_DATA: dir, PORT: String(port), BIND: '127.0.0.1' };
  for (const k of ['EAGLAN_AUTOSTART', 'EAGLAN_RELAYS_FILE', 'EAGLAN_STOP_HOST_ON_EXIT']) delete env[k];
  const child = spawn(process.execPath, [path.join(root, 'src', 'ui-server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (let i = 0; i < 150; i++) { try { if ((await call(port, 'GET', '/api/donation')).status === 200) return { port, child }; } catch {} await sleep(100); }
  throw new Error('the web UI server did not start');
}
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  try {
    for (const d of fs.readdirSync(base)) for (const exe of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(base, d, exe); if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}
const chrome = findChrome();

test('API and pages: off by default, saved and kept across a restart, the card on /client/ and /donate only while on', { timeout: 180000 }, async () => {
  const dir = path.join(dataDir, 'ui'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ viewDistance: 6, other: { keep: 1 } }, null, 2));
  let ui = await startUi(dir);
  assert.deepEqual((await call(ui.port, 'GET', '/api/donation')).body, { enabled: false });
  let info = (await call(ui.port, 'GET', '/api/donation/settings')).body;
  assert.equal(info.settings.enabled, false); assert.equal(info.settings.address, ADDRESS);
  // refused: the file unchanged
  const before = fs.readFileSync(path.join(dir, 'config.json'));
  const bad = await call(ui.port, 'POST', '/api/donation', { ...info.settings, enabled: true, message: '', lagTps: 30 });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Message: 1 to 300 characters/); assert.match(bad.body.error, /Lag threshold/);
  assert.ok(fs.readFileSync(path.join(dir, 'config.json')).equals(before));
  // saved: only the donation key added
  const s = { ...info.settings, enabled: true, message: 'Help the server grow!', goal: 80, raised: 20, lagTps: 14, cooldownMinutes: 15 };
  const r = await call(ui.port, 'POST', '/api/donation', s);
  assert.equal(r.status, 200, r.text); assert.equal(r.body.applied, false, 'no world running');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(file, { viewDistance: 6, other: { keep: 1 }, donation: { ...donation.DEFAULTS, ...s } });
  // kept across a restart of the web page server
  ui.child.kill(); await sleep(500);
  ui = await startUi(dir);
  const pub = (await call(ui.port, 'GET', '/api/donation')).body;
  assert.deepEqual([pub.enabled, pub.message, pub.goalText, pub.address, pub.lag], [true, 'Help the server grow!', '20 of 80 USDT raised for a faster server', ADDRESS, false]);
  // the players' pages
  assert.match((await call(ui.port, 'GET', '/client/')).text, /<script src="\/donate\.js" defer><\/script>/);
  assert.match((await call(ui.port, 'GET', '/donate.js')).text, /Support this server/);
  assert.match((await call(ui.port, 'GET', '/donate')).text, /id="donate-page"/);
  assert.equal((await call(ui.port, 'POST', '/api/donation/send')).status, 400, 'send: no world running');

  if (!chrome) return;
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] });
  try {
    const p = await browser.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    // the section: the saved values, the previews, a change saved, the toggle
    await p.goto(`http://127.0.0.1:${ui.port}/`);
    await p.waitForFunction(() => document.getElementById('dMsg').value === 'Help the server grow!', { timeout: 15000 });
    assert.equal(await p.$eval('#dOn', (e) => e.checked), true);
    assert.equal(await p.$eval('#dOnV', (e) => e.textContent), 'ON');
    assert.match(await p.$eval('#dChat', (e) => e.textContent), /Support this server[\s\S]*Help the server grow![\s\S]*20 of 80 USDT raised[\s\S]*TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC[\s\S]*Copy to Clipboard/);
    assert.match(await p.$eval('#dCard', (e) => e.textContent), /Support this server[\s\S]*TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC/);
    await p.$eval('#dRaised', (e) => { e.value = ''; }); await p.type('#dRaised', '40');
    assert.match(await p.$eval('#dChat', (e) => e.textContent), /40 of 80 USDT raised/, 'the preview follows the field');
    assert.equal(await p.$eval('#donMsg', (e) => e.textContent), 'Not saved yet.');
    await p.click('#bDon');
    await p.waitForFunction(() => /^Saved/.test(document.getElementById('donMsg').textContent), { timeout: 10000 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).donation.raised, 40);
    await p.$eval('#dTps', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.click('#bDon');
    await p.waitForFunction(() => /^Not saved/.test(document.getElementById('donMsg').textContent), { timeout: 10000 });
    assert.match(await p.$eval('#donMsg', (e) => e.textContent), /Lag threshold/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).donation.lagTps, 14, 'an invalid value is not saved');
    assert.equal(await p.$eval('#bDonSend', (e) => e.disabled), true, 'send: no world running');
    // the players' card on /client/ (the game itself is not needed for it) and /donate: in the shadow DOM
    const card = (pg) => pg.evaluate(() => { const h = [...document.querySelectorAll('div')].find((d) => d.shadowRoot); return h ? h.shadowRoot.querySelector('.wrap').textContent : null; });
    const g = await browser.newPage();
    await g.setRequestInterception(true);
    g.on('request', (q) => (/\/client\/classes\.js$/.test(q.url()) ? q.respond({ status: 200, contentType: 'text/javascript', body: 'function main(){}' }) : q.continue()));
    await g.goto(`http://127.0.0.1:${ui.port}/client/`);
    await g.waitForFunction(() => [...document.querySelectorAll('div')].some((d) => d.shadowRoot && /Support this server/.test(d.shadowRoot.textContent)), { timeout: 10000 });
    const text = await card(g);
    assert.match(text, /Help the server grow![\s\S]*40 of 80 USDT raised[\s\S]*TRON \(TRC-20\)[\s\S]*TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC[\s\S]*Copy/);
    // folded: a small button
    await g.evaluate(() => [...document.querySelectorAll('div')].find((d) => d.shadowRoot).shadowRoot.querySelector('.x').click());
    assert.equal((await card(g)).trim(), '♥ Support this server');
    const d = await browser.newPage();
    await d.goto(`http://127.0.0.1:${ui.port}/donate`);
    await d.waitForFunction(() => [...document.querySelectorAll('div')].some((x) => x.shadowRoot && /Copy/.test(x.shadowRoot.textContent)), { timeout: 10000 });
    // off: nothing on /client/, "not open" on /donate
    await call(ui.port, 'POST', '/api/donation', { ...JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).donation, enabled: false });
    await g.reload(); await sleep(1500);
    assert.equal(((await card(g)) || '').trim(), '', 'off: nothing on the game page');
    await d.reload();
    await d.waitForFunction(() => /not open/.test(document.body.textContent), { timeout: 10000 });
    assert.deepEqual(errors, [], 'no errors on the page');
  } finally { await browser.close(); }
});

test('the real game: the message in the player\'s chat when the server lags, not again within the cooldown, and when sent', { timeout: 600000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ viewDistance: 4, donation: { ...donation.DEFAULTS, enabled: true, cooldownMinutes: 10 } });
  process.env.EAGLAN_DEBUG_DONATION_TPS = '8';   // (the server taken as lagging: 8 ticks per second)
  try { await c.create({ name: 'Donation World', seed: '12345' }); } finally { delete process.env.EAGLAN_DEBUG_DONATION_TPS; }
  const st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st, 'hosting');
  const bot = new Bot({ name: 'Player', relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: () => {} }); bots.push(bot);
  await bot.join();
  assert.ok(await Promise.race([bot.ready, sleep(30000).then(() => false)]), 'the player is in the world');
  const got = () => bot.stats.chat.filter((j) => j.includes(ADDRESS));
  assert.ok(await waitFor(() => got().length >= 1, 20000), 'the message reached the player: ' + JSON.stringify(bot.stats.chat.slice(-3)));
  const m = JSON.parse(got()[0]);
  const flat = (x) => (typeof x === 'string' ? [x] : [x.text || '', ...(x.extra || []).flatMap(flat)]).join('');
  assert.match(flat(m), /Support this server[\s\S]*running slow right now[\s\S]*Send TRON \(TRC-20\) to: TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC/);
  // (as the game sent it: its own JSON, the parts in "extra")
  const parts = (x) => (typeof x === 'object' && x ? [x, ...(x.extra || []).flatMap(parts)] : []);
  const addr = parts(m).find((x) => x.text === ADDRESS);
  assert.ok(addr && addr.clickEvent && addr.clickEvent.action === 'open_url' && addr.clickEvent.value === ADDRESS, 'the address is clickable: ' + JSON.stringify(addr));
  assert.ok(addr.hoverEvent && /Copy to Clipboard/.test(JSON.stringify(addr.hoverEvent)) && addr.insertion === ADDRESS, 'with the hint, and shift-click');
  const s1 = (await c.status()).donation;
  assert.deepEqual([s1.enabled, s1.tps, s1.lag, s1.sent], [true, 8, true, 1]);
  assert.equal((await c.donationPublic()).lag, true, 'the players\' page knows the server lags');
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'), /donation message sent to the chat: the server lags \(8 game ticks per second, below 15\)/);
  await sleep(15000);   // three more reports, all lagging: within the cooldown nothing more
  assert.equal(got().length, 1, 'not again within the cooldown');
  // sent by the owner: at once
  const r = await c.sendDonationNow();
  assert.equal(r.players, 1);
  assert.ok(await waitFor(() => got().length === 2, 10000), 'sent by the owner');
  // off, live: no message, the page shows nothing
  await c.saveDonation({ ...donation.normalize(c.loadConfig().donation).value, enabled: false });
  assert.deepEqual(await c.donationPublic(), { enabled: false });
  await assert.rejects(c.sendDonationNow(), /off/);
  bot.close(); await c.stop();
});
