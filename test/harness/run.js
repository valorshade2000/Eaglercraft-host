'use strict';
// Runs one scenario of the equivalence harness (daemon-side.js) with the real host and game:
//   node test/harness/run.js <scenario> <out> [--config JSON] [--args JSON] [--seed N] [--world-seed S]
//                            [--world-type T] [--generator G] [--dump-every N] [--packets] [--phases N] [--keep] [--timeout-min M]
// --world-type: 0 default, 1 superflat (--generator: its preset, e.g. '2;7,2x3,2;1;'), 2 large biomes, 3 amplified.
// <scenario>: a file, or a name in test/harness/scenarios/. --config: data/config.json settings for this run (e.g.
// '{"collisionScan":true}'). --seed: the game's random numbers. The host runs the scenario, saves the world, writes
// everything compare.js needs to <out> and stops; this prints result.json. Each run gets a new data folder (--keep keeps it).
// --phases 2: then the host is started again on the same world and the scenario runs again with h.phase 2 (a restart:
// what was saved is loaded); phase 1 writes to <out>/phase1, the last phase to <out>.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const opt = (k, def) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : def; };
const flag = (k) => argv.includes('--' + k);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--packets', '--keep'].includes(argv[i - 1])));
if (pos.length < 2) { console.error('usage: node test/harness/run.js <scenario> <out> [--config JSON] [--args JSON] [--seed N] ...'); process.exit(2); }
const scenario = fs.existsSync(pos[0]) ? path.resolve(pos[0]) : path.join(__dirname, 'scenarios', pos[0] + '.js');
const out = path.resolve(pos[1]);
const phases = Math.max(1, Number(opt('phases', '1')) | 0);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-hns-'));
Object.assign(process.env, {
  EAGLAN_DATA: dataDir, EAGLAN_HARNESS: '1', EAGLAN_HARNESS_SCENARIO: scenario,
  EAGLAN_HARNESS_ARGS: opt('args', '{}'), EAGLAN_HARNESS_SEED: opt('seed', '1'), EAGLAN_HARNESS_DUMP_EVERY: opt('dump-every', '0'),
});
if (flag('packets')) process.env.EAGLAN_HARNESS_PACKETS = '1';
// --extra <name>: test/harness/extra-<name>.js applied to the game code (instrumentation for measurements; not exact runs)
if (opt('extra')) process.env.EAGLAN_HARNESS_EXTRA = path.join(__dirname, `extra-${opt('extra')}.js`);
const c = require('../../src/control');
const paths = require('../../src/paths');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  c.saveConfig({ viewDistance: 4, lanGamemode: 1, ...JSON.parse(opt('config', '{}')) });
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), '');
  const t0 = Date.now(), limit = Number(opt('timeout-min', '60')) * 60000;
  let r = null;
  for (let ph = 1; ph <= phases; ph++) {
    const dir = ph < phases ? path.join(out, 'phase' + ph) : out;
    fs.mkdirSync(dir, { recursive: true });
    process.env.EAGLAN_HARNESS_OUT = dir; process.env.EAGLAN_HARNESS_PHASE = String(ph);
    if (ph === 1) await c.create({ name: 'Harness', seed: opt('world-seed', '12345'), worldType: Number(opt('world-type', '0')), generatorOptions: opt('generator', '') });
    else await c.start({ folder: JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8')).world });
    for (;;) {
      await sleep(1000);
      const s = await c.status().catch(() => null);
      if (!s || !s.running) break;
      if (Date.now() - t0 > limit) { console.error('timed out: stopping the host'); await c.stop().catch(() => {}); break; }
    }
    try { fs.copyFileSync(path.join(dataDir, 'logs', 'host.log'), path.join(dir, 'host.log')); } catch {}
    r = null; try { r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch {}
    if (phases > 1) console.log(`phase ${ph}: ${r ? (r.ok ? 'ok' : 'failed') : 'no result.json'}`);
    if (!r || !r.ok) break;
  }
  console.log(JSON.stringify(r ? { ok: r.ok, ticks: r.ticks, files: r.files, realS: r.realMs && Math.round(r.realMs / 100) / 10, error: r.error, result: r.result } : { ok: false, error: 'no result.json (see host.log)' }, null, 1));
  if (!flag('keep')) fs.rmSync(dataDir, { recursive: true, force: true }); else console.log('data: ' + dataDir);
  process.exit(r && r.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
