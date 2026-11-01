'use strict';
// How much CPU this process may use: the CPUs it may run on (affinity, os.availableParallelism)
// and, on Linux, a CPU quota from its cgroup (containers, systemd CPUQuota=, some VPS panels).
// The quota is the smallest one on the way from the process's cgroup up to the root.
//   cgroup v2: <cgroup>/cpu.max            "max 100000" (no limit) or "<quota> <period>"
//   cgroup v1: <cpu cgroup>/cpu.cfs_quota_us and cpu.cfs_period_us (quota -1: no limit)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// read(file) -> text or null; root: where the cgroup file systems are mounted. Both can be replaced
// in tests.
function cgroupQuota({ read = defaultRead, root = '/sys/fs/cgroup', procCgroup = '/proc/self/cgroup' } = {}) {
  const self = read(procCgroup);
  if (!self) return null;
  const lines = self.split('\n').map((l) => l.trim()).filter(Boolean);
  let best = null;
  const take = (cores, file) => { if (cores > 0 && (!best || cores < best.cores)) best = { cores, file }; };
  const walk = (base, rel, fn) => {
    // From the process's own cgroup up to the root of that hierarchy.
    let p = rel.replace(/\/+$/, '') || '/';
    for (;;) {
      fn(path.posix.join(base, p));
      if (p === '/' || p === '') break;
      p = path.posix.dirname(p);
    }
  };
  for (const l of lines) {
    const [, controllers, rel] = /^\d+:([^:]*):(.*)$/.exec(l) || [];
    if (rel === undefined) continue;
    if (controllers === '') {   // v2 (unified)
      walk(root, rel, (dir) => {
        const t = read(dir + '/cpu.max'); if (!t) return;
        const [q, per] = t.trim().split(/\s+/);
        if (q !== 'max' && +q > 0 && +per > 0) take(+q / +per, dir + '/cpu.max');
      });
    } else if (controllers.split(',').includes('cpu')) {   // v1
      for (const mount of [controllers, 'cpu,cpuacct', 'cpu']) {
        walk(path.posix.join(root, mount), rel, (dir) => {
          const q = +read(dir + '/cpu.cfs_quota_us'), per = +read(dir + '/cpu.cfs_period_us');
          if (q > 0 && per > 0) take(q / per, dir + '/cpu.cfs_quota_us');
        });
      }
    }
  }
  return best;
}

function defaultRead(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

// { online, affinity, quota, cores, limitedBy }: cores is what this process can really use (may be
// fractional with a quota).
function availableCpus(opts = {}) {
  const online = (opts.cpus || os.cpus()).length || 1;
  const affinity = opts.affinity || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : online);
  const quota = process.platform === 'linux' || opts.read ? cgroupQuota(opts) : null;
  const cores = Math.min(affinity, quota ? quota.cores : Infinity);
  const limitedBy = quota && quota.cores < affinity ? `CPU quota ${Math.round(quota.cores * 100) / 100} (${quota.file})`
    : affinity < online ? `CPU affinity (${affinity} of ${online} CPUs)` : null;
  return { online, affinity, quota: quota ? Math.round(quota.cores * 100) / 100 : null, cores, limitedBy };
}

// Workers for the multi-core mode: one CPU stays with the game thread, which runs the game itself,
// so the pool gets the rest (whole CPUs only), at most `max`. Fewer than 1 means the mode cannot
// help on this machine. `wanted` (config multiCoreWorkers) sets another number, never more than the
// CPUs allow. Measured (README "Multi-core mode"): 2 threads gave the same tick times and packet waits
// as 4, with about 80 MB less memory; with 1, packets waited up to 30-130 ms in bursts.
function poolSize(cpu, { wanted = null, max = 2 } = {}) {
  const room = Math.floor(cpu.cores + 1e-9) - 1;
  const auto = Math.max(0, Math.min(room, max));
  if (wanted == null) return auto;
  return Math.max(0, Math.min(Math.floor(wanted), room));
}

// Debug (measurements: test/bench/load.js --host-cpus): runs this process, all its threads, on the CPUs
// of a bit mask only (3: the first two), as on a smaller server. Windows and Linux.
function pinToCpus(mask) {
  const { execFileSync } = require('node:child_process');
  if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`], { stdio: 'ignore' });
  else execFileSync('taskset', ['-a', '-p', mask.toString(16), String(process.pid)], { stdio: 'ignore' });
}

module.exports = { availableCpus, cgroupQuota, poolSize, pinToCpus };
