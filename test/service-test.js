// Service-mode test (what Docker/systemd do): boot the UI server with EAGLAN_AUTOSTART and
// EAGLAN_STOP_HOST_ON_EXIT=1 against a throwaway data dir, deliver SIGTERM, check the world was
// saved, then boot again and check the SAME world is resumed (no duplicate created).
//   node test/service-test.js
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-svc-'));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };

// Runs the UI server in a child process; SIGTERM is simulated through IPC because Windows
// cannot deliver catchable POSIX signals to another process.
function boot(autostart) {
  const child = spawn(process.execPath, ['-e', `
    require('./src/ui-server');
    process.on('message', (m) => { if (m === 'SIGTERM') process.emit('SIGTERM'); });
  `], { cwd: root, env: { ...process.env, EAGLAN_DATA: dataDir, PORT: '8097', EAGLAN_AUTOSTART: autostart, EAGLAN_STOP_HOST_ON_EXIT: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out };
}
async function waitFor(fn, ms, step = 500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

(async () => {
  // Hermetic: host on a local mock relay, never on the public relays.
  const { MockRelay } = require('./mock-relay');
  const mock = await new MockRelay().start();
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), mock.url + '\n');
  process.env.EAGLAN_DATA = dataDir;
  const c = require('../src/control');

  const a = boot('Svc World');
  const st1 = await waitFor(async () => { const s = await c.status(); return s.running && s.status === 'hosting' ? s : null; }, 90000);
  check('boot 1: autostart creates and hosts a world', !!st1, st1 && `world '${st1.world}', code ${st1.code}`);
  const pid1 = st1 && st1.pid;

  a.child.send('SIGTERM');
  const exited = await waitFor(() => a.child.exitCode !== null, 90000);
  const s1 = await c.status();
  check('SIGTERM: UI server exits after stopping host', !!exited && !s1.running, `host status '${s1.status}'`);
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8');
  check('SIGTERM: world saved and server stopped cleanly', /world saved and integrated server stopped cleanly/.test(log));
  let alive = true; try { process.kill(pid1, 0); } catch { alive = false; }
  check('SIGTERM: no orphan host process left', !alive);

  const b = boot('Svc World');
  const st2 = await waitFor(async () => { const s = await c.status(); return s.running && s.status === 'hosting' && s.pid !== pid1 ? s : null; }, 90000);
  const worlds = c.store.list();
  check('boot 2: autostart resumes the same world (no duplicate)', !!st2 && worlds.length === 1 && st2.world === worlds[0].folder, `${worlds.length} world(s): ${worlds.map((w) => w.folder).join(', ')}`);
  b.child.send('SIGTERM'); await waitFor(() => b.child.exitCode !== null, 90000);

  const d = boot('last');
  const st3 = await waitFor(async () => { const s = await c.status(); return s.running && s.status === 'hosting' && s.pid !== (st2 && st2.pid) ? s : null; }, 90000);
  check('boot 3: EAGLAN_AUTOSTART=last resumes last world', !!st3 && st3.world === 'Svc World', st3 && st3.world);
  d.child.send('SIGTERM'); await waitFor(() => d.child.exitCode !== null, 90000);
  check('final: host stopped', !(await c.status()).running);

  await mock.stop();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed (data dir ${dataDir})`);
  if (!failed) fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
