'use strict';
// The web page's log viewer must show every host log line exactly once and in order, even when
// /api/logs responses are slow and arrive out of order, and must start over when the host restarts.
// Runs the real public/index.html in chrome-headless-shell against a fake API.
//   node --test test/ui-log-viewer.test.js        (PAGE=<path> to test another copy of the page)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
test('log viewer shows each line once, in order, with slow out-of-order responses and a restart', { skip: !chrome && 'chrome-headless-shell not installed', timeout: 90000 }, async () => {
  const puppeteer = require('puppeteer-core');
  const page = fs.readFileSync(process.env.PAGE || path.join(__dirname, '..', 'public', 'index.html'));
  let ring = [], seq = 0, instance = 'A';
  const add = () => { seq++; ring.push({ seq, line: `[${instance}] line ${String(seq).padStart(4, '0')}` }); if (ring.length > 2000) ring.shift(); };
  const tick = setInterval(add, 50);
  const restart = setTimeout(() => { instance = 'B'; ring = []; seq = 0; }, 12000); // host restarts: numbering starts at 1 again
  const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    if (u.pathname === '/api/status') return json(res, { running: true, status: 'hosting', world: 'W', pid: 1, startedAt: Date.now(), codes: [], relays: [], peers: [] });
    if (u.pathname === '/api/worlds' || u.pathname === '/api/exports') return json(res, []);
    if (u.pathname === '/api/config') return json(res, { relays: [], relayWarnings: [], lanGamemode: 0, difficulty: 2, viewDistance: 4, ownerName: 'H', lanWorldName: '', lanCheats: false, hidden: false });
    if (u.pathname === '/api/logs') {
      const since = +u.searchParams.get('since') || 0, inst = instance;
      // Answer after 0-3s: longer than the 1.5s poll interval, so polls would overlap.
      return setTimeout(() => json(res, { live: true, instance: inst, lines: ring.filter((l) => l.seq > since) }), Math.random() * 3000);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] });
  try {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${srv.address().port}/`);
    await new Promise((r) => setTimeout(r, 24000));
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 6000)); // let in-flight polls finish
    const shown = (await p.$eval('#log', (el) => el.innerText)).split('\n').filter(Boolean);
    const dupes = shown.length - new Set(shown).size;
    const nums = shown.map((l) => +l.match(/line (\d+)/)[1]);
    let outOfOrder = 0; for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) outOfOrder++;
    console.log(`shown ${shown.length} lines, duplicates ${dupes}, out of order ${outOfOrder}, instance ${instance}, last seq ${seq}`);
    assert.equal(dupes, 0, 'no duplicated lines');
    assert.equal(outOfOrder, 0, 'lines in order');
    assert.ok(shown.every((l) => l.startsWith('[B]')), 'view restarted with the new host instance');
    assert.equal(nums[nums.length - 1], seq, 'caught up to the newest line');
    assert.equal(nums[0], 1, 'nothing missing after the restart');
  } finally { await browser.close(); srv.close(); clearInterval(tick); clearTimeout(restart); }
});
