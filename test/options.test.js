'use strict';
// The web page's Option Manual (src/options.js; GET and POST /api/options in src/ui-server.js; the "Option Manual"
// section of public/index.html): every setting the code reads from data/config.json is accounted for; the ones without a
// control elsewhere on the page (the Settings form, its Game Rules, the Console's OP list) are shown, each with the
// control for its type; each Save changes only its own key of the file, with the value's type kept; an invalid value,
// or a setting changed elsewhere, is refused and the file stays as it was, byte for byte. Runs the real web UI server on
// a throwaway data folder; the page part runs the real page in chrome-headless-shell (skipped without it, like
// test/ui-log-viewer.test.js).
//   node --test test/options.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-options-'));
process.env.EAGLAN_DATA = path.join(tmp, 'unused');   // (control.js makes its data folder when loaded: never the real one)
const { DEFAULT_CONFIG } = require('../src/control');
const { OPTIONS, EXTRA_DEFAULTS, validate, describe } = require('../src/options');

const EDITABLE = OPTIONS.filter((o) => o.control !== 'elsewhere');   // (shown in the Option Manual)
const ELSEWHERE = OPTIONS.filter((o) => o.control === 'elsewhere');
const CONTROL = { boolean: 'toggle', integer: 'number', string: 'text', enum: 'select' };
const TAG = { live: 'applies at once', restart: 'restart the world', ui: 'restart the web page server' };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const defaultOf = (o) => (has(DEFAULT_CONFIG, o.key) ? DEFAULT_CONFIG[o.key] : EXTRA_DEFAULTS[o.key]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A data/config.json as a user may have it: some settings, one saved as text, keys of other tools.
const INITIAL = {
  ownerName: 'Steve_1', viewDistance: 6, encodeOnce: true, diskSync: 'normal', redundantPort: 25000,
  gameRules: { enabled: true, live: 0, values: { keepInventory: true } }, ops: ['Alex'], 'Pre-generationOnline': 'true',
  someOtherTool: { keep: [1, 2, 3] }, comment: 'a key of no setting, kept as it is',
};
function dataDir(name, config = INITIAL) {
  const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true });
  if (config) fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(config, null, 2));
  return d;
}
const readJson = (d) => JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

// A valid value other than `cur`: what is sent and what the file then has (text is sent with spaces round it).
function another(o, cur) {
  if (o.type === 'boolean') return { send: cur !== true, saved: cur !== true };
  if (o.type === 'enum') { const c = o.choices.find((x) => x[0] !== cur); return { send: c[0], saved: c[0] }; }
  if (o.type === 'integer') { const v = [o.max, o.min, o.max - 1].find((x) => x !== cur); return { send: v, saved: v }; }
  const s = cur === 'Tester_' + o.key.length ? 'Tester_x' : 'Tester_' + o.key.length;
  return { send: '  ' + s + ' ', saved: s };
}
// Values the host does not accept for o (undefined: no "value" in the request).
function invalid(o) {
  const bad = [undefined, {}, []];
  if (o.type === 'boolean') bad.push('true', 'on', 1, 0, null);
  if (o.type === 'integer') {
    bad.push(o.min - 1, o.max + 1, o.min + 0.5, String(o.min), true, 'x');
    if (!o.nullable) bad.push(null, '');
    if (o.not) bad.push(o.not[0], o.not[1], 80);
  }
  if (o.type === 'enum') {
    bad.push(null, true, '');
    for (const [v] of o.choices) bad.push(typeof v === 'number' ? String(v) : v.toUpperCase());
    bad.push(typeof o.choices[0][0] === 'number' ? Math.max(...o.choices.map((c) => c[0])) + 1 : 'fast');
  }
  if (o.type === 'string') {
    bad.push(null, 5, true, 'a'.repeat(o.maxLength + 1), 'a\u0001b', 'a\nb');
    if (o.minLength) bad.push('', '   ');
  }
  return bad;
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const call = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
async function startUi(dir) {
  const port = await freePort();
  const env = { ...process.env, EAGLAN_DATA: dir, PORT: String(port), BIND: '127.0.0.1' };
  for (const k of ['EAGLAN_AUTOSTART', 'EAGLAN_RELAYS_FILE', 'EAGLAN_STOP_HOST_ON_EXIT']) delete env[k];
  const child = spawn(process.execPath, [path.join(root, 'src', 'ui-server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 150; i++) {
    try { if ((await call(port, 'GET', '/api/options')).status === 200) return { port, child, out: () => out }; } catch {}
    await sleep(100);
  }
  child.kill(); throw new Error('the web UI server did not start: ' + out);
}

test('every setting the code reads from data/config.json is accounted for; the ones not changed elsewhere on the page have the control for their type', () => {
  const keys = OPTIONS.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length, 'no setting twice');
  for (const k of Object.keys(DEFAULT_CONFIG)) assert.ok(keys.includes(k), `${k} (DEFAULT_CONFIG) is listed`);
  for (const k of keys) assert.ok(has(DEFAULT_CONFIG, k) || has(EXTRA_DEFAULTS, k), `${k} has a default`);
  // What the code reads: cfg.x / cf.x / cfg['x'] / loadConfig().x in the files that read the config, and the daemon's
  // list of opt-in speedups (read as cfg[k]). Not settings of the file: relays (data/relays.txt), and the two keys
  // loadConfig adds itself.
  const read = new Set();
  for (const f of [...fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.js')).map((n) => path.join(root, 'src', n)), path.join(root, 'cli.js')]) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\b(?:cfg|cf)\.([A-Za-z_][A-Za-z0-9_]*)|\bcfg\[['"]([^'"]+)['"]\]|loadConfig\(\)\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1] || m[2] || m[3]);
    const optIn = s.match(/const OPT_IN = \[([^\]]*)\]/);
    if (optIn) for (const m of optIn[1].matchAll(/'([^']+)'/g)) read.add(m[1]);
  }
  for (const k of ['relays', 'relayWarnings', 'configError']) read.delete(k);
  assert.ok(read.size >= 36, 'the scan finds the settings: ' + [...read].join(', '));
  for (const k of read) assert.ok(keys.includes(k), `${k} (read by the code) is listed`);
  for (const k of keys) assert.ok(read.has(k), `${k} is read by the code`);

  for (const o of OPTIONS) {
    assert.ok(o.label && o.text && o.group && o.doc, `${o.key}: label, description, group, README section`);
    assert.ok(['live', 'restart', 'ui', 'section'].includes(o.applies), `${o.key}: when it takes effect`);
    if (o.needs) assert.ok(keys.includes(o.needs), `${o.key} works with ${o.needs}, a setting`);
    const d = defaultOf(o);
    if (o.control === 'elsewhere') { assert.ok(o.where, `${o.key}: where it is changed`); assert.ok(validate(o.key, d).error, `${o.key}: not set here`); continue; }
    assert.equal(o.control, CONTROL[o.type], `${o.key}: a ${o.type} has a ${CONTROL[o.type]}`);
    assert.deepEqual(validate(o.key, d), { value: d }, `${o.key}: its default ${JSON.stringify(d)} is valid`);
    if (o.type === 'boolean') assert.equal(typeof d, 'boolean');
    if (o.type === 'integer') assert.ok(Number.isInteger(d) || (d === null && o.nullable), `${o.key}: default ${d}`);
    if (o.type === 'string') assert.equal(typeof d, 'string');
    if (o.type === 'enum') assert.ok(o.choices.some((c) => c[0] === d));
  }
  // The live ones are what the running host takes at once (control.js applySettings sends them to /settings).
  const live = fs.readFileSync(path.join(root, 'src', 'control.js'), 'utf8').match(/'POST', '\/settings', \d+, \{([^}]*)\}/)[1];
  const sent = [...live.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => k !== 'gameRules' && k !== 'ops');
  assert.deepEqual(OPTIONS.filter((o) => o.applies === 'live').map((o) => o.key).sort(), sent.sort());
  // Left out of the Option Manual: exactly what the Settings form saves (POST /api/config, the relays aside), the OP list
  // and the donation message (a section of its own).
  const form = fs.readFileSync(path.join(root, 'src', 'ui-server.js'), 'utf8').match(/const allowed = \[([^\]]*)\]/)[1];
  const formKeys = [...form.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((k) => k !== 'relays');
  assert.deepEqual(ELSEWHERE.map((o) => o.key).sort(), [...formKeys, 'ops', 'donation'].sort());
  assert.equal(EDITABLE.length, OPTIONS.length - formKeys.length - 2);
});

test('validate: boundaries, types and invalid values; describe: the file\'s values, invalid ones marked', () => {
  for (const o of EDITABLE) {
    if (o.type === 'integer') {
      assert.deepEqual(validate(o.key, o.min), { value: o.min }); assert.deepEqual(validate(o.key, o.max), { value: o.max });
      if (o.nullable) assert.deepEqual(validate(o.key, null), { value: null });
    }
    if (o.type === 'boolean') { assert.deepEqual(validate(o.key, true), { value: true }); assert.deepEqual(validate(o.key, false), { value: false }); }
    if (o.type === 'enum') for (const [v] of o.choices) assert.deepEqual(validate(o.key, v), { value: v });
    if (o.type === 'string') {
      assert.deepEqual(validate(o.key, '  ab  '), { value: 'ab' }, 'trimmed');
      assert.deepEqual(validate(o.key, 'a'.repeat(o.maxLength)), { value: 'a'.repeat(o.maxLength) });
    }
    for (const v of invalid(o)) assert.ok(validate(o.key, v).error, `${o.key}: ${JSON.stringify(v)} refused`);
  }
  assert.ok(validate('controlPort', 0).value === 0 && validate('controlPort', 1024).value === 1024);
  assert.ok(validate('nothing', 1).error && validate('__proto__', 1).error && validate('relays', []).error);

  const all = describe(DEFAULT_CONFIG, {});
  assert.equal(all.length, OPTIONS.length);
  for (const d of all) { assert.equal(d.inFile, false); assert.deepEqual(d.value, defaultOf(d)); assert.equal(d.fileError, undefined); }
  const f = describe(DEFAULT_CONFIG, { maxHeapMb: 99, regions: 'yes', diskSync: 'fast', 'Pre-generationOnline': 'TRUE', viewDistance: 99, ops: ['A'], other: 1 });
  const by = Object.fromEntries(f.map((d) => [d.key, d]));
  assert.equal(f.length, OPTIONS.length, 'keys of no setting are not listed');
  for (const k of ['maxHeapMb', 'regions', 'diskSync']) assert.ok(by[k].inFile && by[k].fileError, k + ': invalid value marked');
  assert.deepEqual([by.maxHeapMb.value, by.regions.value], [99, 'yes'], 'shown as it is in the file');
  assert.ok(by.viewDistance.inFile && by.viewDistance.value === 99 && !by.viewDistance.fileError, 'a setting changed elsewhere: its value, not checked here');
  assert.ok(by['Pre-generationOnline'].value === true && by['Pre-generationOnline'].fileNote && !by['Pre-generationOnline'].fileError, 'text "true" read as the host reads it');
  assert.deepEqual(by.ops.value, ['A']);
  assert.ok(!by.lanCheats.inFile && by.lanCheats.value === false);
});

test('API: each setting saved on its own, with its type; invalid values, other keys and broken files refused; nothing written otherwise', { timeout: 120000 }, async () => {
  const dir = dataDir('api'), file = path.join(dir, 'config.json');
  const ui = await startUi(dir);
  try {
    const bytes0 = fs.readFileSync(file);
    const g = await call(ui.port, 'GET', '/api/options');
    assert.equal(g.status, 200); assert.equal(g.body.error, null);
    assert.deepEqual(g.body.options.map((o) => o.key), OPTIONS.map((o) => o.key), 'every setting, in order');
    for (const o of g.body.options) {
      if (o.key === 'Pre-generationOnline') { assert.equal(o.value, true); assert.ok(o.fileNote); continue; }
      assert.deepEqual([o.inFile, o.value], has(INITIAL, o.key) ? [true, INITIAL[o.key]] : [false, defaultOf(o)], o.key);
    }
    assert.ok(fs.readFileSync(file).equals(bytes0), 'starting the server and reading the settings writes nothing');

    for (const o of EDITABLE) {
      const before = readJson(dir), cur = has(before, o.key) ? before[o.key] : defaultOf(o);
      const { send, saved } = another(o, cur);
      const r = await call(ui.port, 'POST', '/api/options', { key: o.key, value: send });
      assert.equal(r.status, 200, `${o.key} = ${JSON.stringify(send)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual([r.body.key, r.body.value, r.body.applies], [o.key, saved, o.applies]);
      if (o.applies === 'live') assert.equal(r.body.applied.applied, false, 'no world running: not applied');
      else assert.equal(r.body.applied, null);
      const after = readJson(dir);
      assert.deepEqual(after[o.key], saved, `${o.key}: the file has the new value`);
      assert.equal(typeof after[o.key], typeof saved, `${o.key}: with its type`);
      assert.deepEqual(without(after, o.key), without(before, o.key), `${o.key}: every other key as it was`);
      const listed = r.body.options.find((x) => x.key === o.key);
      assert.deepEqual([listed.inFile, listed.value, listed.fileError], [true, saved, undefined]);
      // refused: the file stays as it was, byte for byte
      const bytes = fs.readFileSync(file);
      for (const v of invalid(o)) {
        const x = await call(ui.port, 'POST', '/api/options', { key: o.key, value: v });
        assert.equal(x.status, 400, `${o.key} = ${JSON.stringify(v)} refused`); assert.ok(x.body.error);
        assert.ok(fs.readFileSync(file).equals(bytes), `${o.key} = ${JSON.stringify(v)}: file unchanged`);
      }
      // the boundaries are accepted
      if (o.type === 'integer') for (const v of [o.min, o.max, ...(o.nullable ? [null] : [])]) {
        const x = await call(ui.port, 'POST', '/api/options', { key: o.key, value: v });
        assert.equal(x.status, 200, `${o.key} = ${v}`); assert.deepEqual(readJson(dir)[o.key], v);
      }
    }
    const end = readJson(dir);
    for (const k of Object.keys(INITIAL).filter((x) => !EDITABLE.some((o) => o.key === x))) assert.deepEqual(end[k], INITIAL[k], k + ' never touched');
    assert.deepEqual(Object.keys(end).sort(), [...new Set([...Object.keys(INITIAL), ...EDITABLE.map((o) => o.key)])].sort(), 'only the saved keys were added');

    // changed elsewhere on the page, not a setting, another site, a broken or missing file
    const bytes = fs.readFileSync(file);
    const refused = [...ELSEWHERE.map((o) => [{ key: o.key, value: o.key === 'ops' ? ['Eve'] : another(o, defaultOf(o)).saved }, `${o.key}: changed in ${o.where}`]), [{ key: 'gameRules', value: INITIAL.gameRules }, 'Game Rules: in Settings'], [{ key: 'relays', value: [] }, 'relays: data/relays.txt'], [{ key: 'nothing', value: 1 }, 'unknown'], [{ key: '__proto__', value: 1 }, 'unknown'], [{ value: 1 }, 'no key']];
    for (const [body, why] of refused) {
      const x = await call(ui.port, 'POST', '/api/options', body);
      assert.equal(x.status, 400, why); assert.ok(fs.readFileSync(file).equals(bytes), why + ': file unchanged');
    }
    const cross = await call(ui.port, 'POST', '/api/options', { key: 'regions', value: true }, { origin: 'http://elsewhere.example' });
    assert.equal(cross.status, 403); assert.ok(fs.readFileSync(file).equals(bytes), 'cross-origin: file unchanged');
    fs.writeFileSync(file, '{ "maxHeapMb": 3000, ');
    const bad = await call(ui.port, 'GET', '/api/options');
    assert.ok(bad.body.error, 'a broken file is reported');
    const nb = await call(ui.port, 'POST', '/api/options', { key: 'maxHeapMb', value: 4096 });
    assert.equal(nb.status, 400); assert.match(nb.body.error, /nothing was saved/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "maxHeapMb": 3000, ', 'a broken file is never replaced');
    fs.rmSync(file);
    const none = await call(ui.port, 'GET', '/api/options');
    assert.ok(none.body.options.every((o) => !o.inFile) && none.body.error === null);
    assert.equal((await call(ui.port, 'POST', '/api/options', { key: 'maxHeapMb', value: 4096 })).status, 200);
    assert.deepEqual(readJson(dir), { maxHeapMb: 4096 }, 'no defaults written with it');
  } finally { ui.child.kill(); }
});

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

test('page: the Option Manual section shows the settings not changed elsewhere, each with its control and value, and saves each one on its own', { skip: !chrome && 'chrome-headless-shell not installed', timeout: 180000 }, async () => {
  const puppeteer = require('puppeteer-core');
  const dir = dataDir('page'), file = path.join(dir, 'config.json');
  const ui = await startUi(dir);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] });
  try {
    const p = await browser.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    const bytes0 = fs.readFileSync(file);
    await p.goto(`http://127.0.0.1:${ui.port}/`);
    await p.waitForFunction((n) => document.querySelectorAll('#optList .opt').length === n, { timeout: 20000 }, EDITABLE.length);
    assert.equal(await p.$eval('#optSec h2', (e) => e.textContent), 'Option Manual');

    // every setting shown: its key, name, description, when it takes effect, and the control for its type; the ones
    // changed elsewhere on the page (Settings, Game Rules, the Console's OP list) not repeated
    const rows = await p.$$eval('#optList .opt', (els) => els.map((el) => {
      const i = el.querySelector('.ctl input, .ctl select');
      return { key: el.dataset.key, code: el.querySelector('code').textContent, label: el.querySelector('.n').textContent, text: el.querySelector('.d').textContent,
        tag: ([...el.querySelectorAll('.tag')].find((t) => !t.hasAttribute('data-needs')) || { textContent: '' }).textContent, tagName: i.tagName, type: i.type, role: i.getAttribute('role'),
        min: i.getAttribute('min'), max: i.getAttribute('max'), maxlength: i.getAttribute('maxlength'), choices: i.tagName === 'SELECT' ? [...i.options].map((x) => x.value) : null,
        value: i.type === 'checkbox' ? i.checked : i.value, save: !!el.querySelector('[data-save]'), info: el.querySelector('[data-info]').textContent };
    }));
    assert.deepEqual(rows.map((r) => r.key), EDITABLE.map((o) => o.key), 'exactly the settings not changed elsewhere');
    for (const o of EDITABLE) {
      const r = rows.find((x) => x.key === o.key), v = o.key === 'Pre-generationOnline' ? true : has(INITIAL, o.key) ? INITIAL[o.key] : defaultOf(o);
      assert.deepEqual([r.code, r.label, r.text, r.tag], [o.key, o.label, o.text, TAG[o.applies]], o.key);
      if (o.control === 'toggle') assert.deepEqual([r.tagName, r.type, r.role, r.value], ['INPUT', 'checkbox', 'switch', v], o.key);
      if (o.control === 'number') assert.deepEqual([r.tagName, r.type, r.min, r.max, r.value], ['INPUT', 'number', String(o.min), String(o.max), v === null ? '' : String(v)], o.key);
      if (o.control === 'text') assert.deepEqual([r.tagName, r.type, r.maxlength, r.value], ['INPUT', 'text', String(o.maxLength), v], o.key);
      if (o.control === 'select') assert.deepEqual([r.tagName, r.choices, r.value], ['SELECT', o.choices.map((c) => JSON.stringify(c[0])), JSON.stringify(v)], o.key);
      assert.equal(r.save, true, o.key);
      assert.match(r.info, has(INITIAL, o.key) ? /(^|· )data\/config\.json: / : /not in data\/config\.json/, o.key);
    }
    assert.ok(fs.readFileSync(file).equals(bytes0), 'opening the page writes nothing');

    const sel = (o) => `#optList .opt[data-key="${o.key}"]`;
    const type = async (s, text) => { await p.$eval(s, (e) => { e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); if (text) await p.keyboard.type(text); };
    const save = async (o) => {
      await p.$eval(`${sel(o)} [data-msg]`, (e) => { e.textContent = ''; });
      await p.click(`${sel(o)} [data-save]`);
      await p.waitForFunction((s) => /^(Saved|Not saved)/.test(document.querySelector(s).textContent), { timeout: 10000 }, `${sel(o)} [data-msg]`);
      return p.$eval(`${sel(o)} [data-msg]`, (e) => e.textContent);
    };
    const set = async (o, v) => {
      if (o.control === 'toggle') { if (await p.$eval(`${sel(o)} input`, (e) => e.checked) !== v) await p.click(`${sel(o)} label.sw`); }
      else if (o.control === 'select') await p.select(`${sel(o)} select`, JSON.stringify(v));
      else await type(`${sel(o)} input`, v === null ? '' : String(v));
    };
    // change and save every setting through its control
    for (const o of EDITABLE) {
      const before = readJson(dir), cur = has(before, o.key) ? before[o.key] : defaultOf(o);
      const { send, saved } = another(o, cur);
      await set(o, send);
      assert.equal(await p.$eval(`${sel(o)} [data-save]`, (e) => e.disabled), false, o.key + ': Save enabled after a change');
      const m = await save(o);
      assert.match(m, o.applies === 'live' ? /^Saved\. Not applied now: host not running/ : o.applies === 'ui' ? /^Saved\. The web page server uses it from its next start/ : /^Saved\. The world uses it from its next start/, o.key);
      const after = readJson(dir);
      assert.deepEqual(after[o.key], saved, o.key);
      assert.equal(typeof after[o.key], typeof saved, o.key + ': type kept');
      assert.deepEqual(without(after, o.key), without(before, o.key), o.key + ': every other key as it was');
      assert.equal(await p.$eval(`${sel(o)} [data-save]`, (e) => e.disabled), true, o.key + ': nothing left to save');
    }
    // invalid values: the error is shown, Save stays disabled, the file is not touched
    const bytes = fs.readFileSync(file);
    const O = Object.fromEntries(OPTIONS.map((o) => [o.key, o]));
    for (const [k, v] of [['maxHeapMb', '255'], ['maxHeapMb', '65537'], ['maxHeapMb', ''], ['terrainThreads', '2.5'], ['terrainThreads', '9'], ['networkProcesses', '-1'], ['controlPort', '80'], ['uiPort', '70000']]) {
      await type(`${sel(O[k])} input`, v);
      const st = await p.$eval(sel(O[k]), (el) => ({ err: el.querySelector('[data-err]').textContent, save: el.querySelector('[data-save]').disabled }));
      assert.ok(st.err && st.save, `${k} = "${v}": ${JSON.stringify(st)}`);
      await p.$eval(`${sel(O[k])} [data-save]`, (e) => e.click());
      await p.keyboard.press('Enter');
    }
    await sleep(300);
    assert.ok(fs.readFileSync(file).equals(bytes), 'invalid values: file unchanged');
    // Default puts the default in the control; Save writes it
    await p.click(`${sel(O.maxHeapMb)} [data-def]`);
    assert.equal(await p.$eval(`${sel(O.maxHeapMb)} input`, (e) => e.value), String(DEFAULT_CONFIG.maxHeapMb));
    assert.match(await save(O.maxHeapMb), /^Saved/);
    assert.equal(readJson(dir).maxHeapMb, DEFAULT_CONFIG.maxHeapMb);
    // "works with" a setting changed in Settings: multiCoreWorkers is marked while multiCore is off, and no longer once
    // Settings has switched it on
    const needs = () => p.$eval(`${sel(O.multiCoreWorkers)} [data-needs]`, (e) => e.textContent);
    assert.equal(await needs(), 'works with multiCore (off now)');
    await p.click('#sMultiCore'); await p.click('#bCfg');
    await p.waitForFunction(() => /^Saved/.test(document.getElementById('cfgMsg').textContent), { timeout: 10000 });
    await p.waitForFunction((s) => document.querySelector(s).textContent === 'works with multiCore', { timeout: 5000 }, `${sel(O.multiCoreWorkers)} [data-needs]`);
    assert.equal(readJson(dir).multiCore, true);
    // the filter
    await type('#optFilter', 'decoration');
    const shown = await p.$$eval('#optList .opt', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.key));
    assert.deepEqual(shown, ['decorationAhead', 'decorationAheadPregen']);
    assert.deepEqual(errors, [], 'no errors on the page');
  } finally { await browser.close(); ui.child.kill(); }
});

test.after(async () => {
  if (process.env.KEEP_DATA) return;
  await sleep(500);   // (the servers' worlds.sqlite files are open until their processes have ended)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});
