'use strict';
// Regions with a world pre-generation (stage 8, E6), real daemon and game: Alice plays at spawn (the main instance),
// Bob 400 blocks away (moved to a region instance of his own). A pre-generation job (in the main instance) whose
// radius reaches past Bob runs to its end: the chunks of the cells Bob's instance has are left out (counted), Bob is
// never moved for it, nobody waits for a cell (no claim of the main instance held), and the main instance keeps ticking.
//   node --test test/regions-pregen.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglan-rgp-'));
process.env.EAGLAN_DATA = dataDir;
const c = require('../src/control');
const { MockRelay } = require('./mock-relay');
const { Bot } = require('./bench/bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return fn();
}
const hostLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
const cmd = async (s) => { const r = await c.consoleCommand(s, { allowOp: true }); assert.ok(!r.error, `${s}: ${JSON.stringify(r)}`); return r; };
const where = async () => Object.fromEntries((await c.status()).regions.instances.flatMap((i) => i.players.map((p) => [p, i.id])));

const relays = [], bots = [];
after(async () => {
  for (const b of bots) b.close();
  try { await c.stop(); } catch {}
  for (const r of relays) await r.stop();
  try { require('node-datachannel').cleanup(); } catch {}
  if (!process.env.KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('daemon: regions + pre-generation: cells of a region instance are left out; nobody moved, nothing held', { timeout: 1200000 }, async () => {
  const relay = await new MockRelay().start(); relays.push(relay);
  fs.writeFileSync(path.join(dataDir, 'relays.txt'), relay.url + '\n');
  c.saveConfig({ regions: true, regionInstances: 2, viewDistance: 4, lanGamemode: 1 });
  await c.create({ name: 'Regions Pregen', seed: '12345' });
  const st = await waitFor(async () => { const s = await c.status(); return s.status === 'hosting' && s.code && s; }, 180000);
  assert.ok(st && st.regions && st.regions.on, 'hosting with regions');
  const world = await waitFor(() => { const x = c.store.list()[0]; return x && x.spawn && x; }, 60000), [sx, , sz] = world.spawn;
  const join = async (name) => {
    const b = new Bot({ name, relayUrl: relay.url, code: st.code, path: { kind: 'still' }, log: () => {} });
    await b.join(); bots.push(b);
    assert.ok(await Promise.race([b.ready, sleep(30000).then(() => false)]), `${name} got into the world`);
    return b;
  };
  const alice = await join('Alice'), bob = await join('Bob');
  // Bob 400 blocks east: after 20 s far from everyone he is in a region instance of his own
  const bx = Math.round(sx + 400), bz = Math.round(sz);
  await cmd(`tp Bob ${bx} 120 ${bz}`);
  const w = await waitFor(async () => { const x = await where(); return x.Bob > 0 && x.Alice === 0 && x; }, 90000, 500);
  assert.ok(w, 'Bob in a region instance: ' + JSON.stringify(await where()));
  const r1 = w.Bob, movesBefore = (hostLog().match(/moving Bob/g) || []).length;

  // a pre-generation of 448 blocks round spawn: it reaches Bob's cells (25 chunks east)
  const t0 = Date.now();
  const r = await c.pregen({ action: 'start', radius: 448, rate: 50 });
  assert.ok(!r.error, 'pre-generation started: ' + JSON.stringify(r));
  let last = null, maxGap = 0, prevN = -1, prevAt = Date.now();
  const done = await waitFor(async () => {
    const s = await c.status(); last = s.pregen;
    const x = await where(); assert.equal(x.Bob, r1, 'Bob stays in his instance: ' + JSON.stringify(x));
    if (last && last.processed !== prevN) { maxGap = Math.max(maxGap, Date.now() - prevAt); prevN = last.processed; prevAt = Date.now(); }
    return last && last.done && !last.running;
  }, 900000, 1000);
  assert.ok(done, 'the pre-generation finished: ' + JSON.stringify(last));
  console.log(`pre-generation: ${last.processed}/${last.total} in ${Math.round((Date.now() - t0) / 1000)} s; ${last.generated} generated, ${last.skippedRegion} left out; longest wait between progress reports ${Math.round(maxGap / 1000)} s`);
  assert.ok(last.skippedRegion > 0, 'some chunks left out (Bob\'s cells): ' + JSON.stringify(last));
  assert.ok(last.skippedRegion < last.total / 4, 'only those: ' + last.skippedRegion + ' of ' + last.total);
  const log = hostLog();
  assert.ok(!/the main instance needs its chunks/.test(log), 'no player moved for the main instance\'s chunks');
  assert.equal((log.match(/moving Bob/g) || []).length, movesBefore, 'Bob was not moved');
  assert.ok(!/no answer for cell/.test(log), 'no claim of the main instance waited');
  assert.match(log, /pre-generation finished[^\n]*left out \(region instances have them/, 'the end line says what was left out');
  assert.equal(bob.stats.kicked, null); assert.equal(alice.stats.kicked, null);
  // both still play: a block placed in each instance
  assert.equal((await cmd(`execute Bob ~ ~ ~ setblock ${bx} 100 ${bz} minecraft:gold_block`)).ok, true);
  assert.equal((await cmd(`execute Alice ~ ~ ~ setblock ${sx} 100 ${sz} minecraft:diamond_block`)).ok, true);
});
