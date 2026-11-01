'use strict';
// The Game Rules list and its checks (src/game-rules.js).   node --test test/game-rules.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const paths = require('../src/paths');
const gr = require('../src/game-rules');

// The game rules that the vendored u53 GameRules constructor registers: [name, default] in order.
function gameRulesInClassesJs() {
  const s = fs.readFileSync(paths.classesJs, 'utf8');
  let i = s.indexOf('$rt_stringPool([') + '$rt_stringPool('.length, depth = 0, inStr = false, esc = false;
  const start = i;
  for (;; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  const pool = vm.runInNewContext('(' + s.slice(start, i + 1) + ')', {}, { timeout: 10000 });
  const at = s.indexOf('function Cp0(a){'), body = s.slice(at, s.indexOf('\nfunction ', at + 10));
  const first = [...body.slice(0, body.indexOf('E_l(')).matchAll(/C\((\d+)\)/g)].map((m) => pool[+m[1]]);
  const rest = [...body.matchAll(/b\s*=\s*C\((\d+)\);\s*e\s*=\s*C\((\d+)\);/g)].map((m) => [pool[+m[1]], pool[+m[2]]]);
  return [[first[0], first[1]], ...rest];
}

test('game rules: the list is exactly the rules u53 registers, with the same defaults', () => {
  const game = gameRulesInClassesJs();
  assert.equal(game.length, 22);
  assert.deepEqual(new Set(gr.RULES.map((r) => r.name)), new Set(game.map(([n]) => n)), 'same rule names');
  for (const [name, def] of game) assert.equal(String(gr.RULES.find((r) => r.name === name).def), def, `${name} default`);
  for (const x of [...gr.RULES, ...gr.SWITCHES]) assert.ok(gr.GROUPS.some((g) => g.id === x.group) && x.label && x.desc, x.name + ' has a group, label and description');
});

test('game rules: the host\'s own rule playersSleepingPercentage: not one of the game\'s, offered and sent like them', () => {
  const game = gameRulesInClassesJs().map(([n]) => n);
  assert.deepEqual(gr.HOST_RULES.map((r) => r.name), ['playersSleepingPercentage']);
  for (const r of gr.HOST_RULES) {
    assert.ok(!game.includes(r.name), r.name + ' is not a rule of the game code');
    assert.ok(gr.GROUPS.some((g) => g.id === r.group) && r.label && r.desc, r.name + ' has a group, label and description');
  }
  const p = gr.HOST_RULES[0];
  assert.deepEqual([p.type, p.def, p.min, p.max, p.group], ['int', 100, 0, 100, 'players'], '100 (everyone, as the game) by default');
  assert.equal(gr.defaults().playersSleepingPercentage, 100);
  assert.deepEqual(gr.normalize({ values: { playersSleepingPercentage: '50' } }).value.values, { playersSleepingPercentage: 50 });
  assert.match(gr.normalize({ values: { playersSleepingPercentage: 101 } }).errors.join(), /playersSleepingPercentage must be a whole number from 0 to 100/);
  assert.deepEqual(gr.plan({ keepInventory: true, playersSleepingPercentage: 50 }, null).rules, [['keepInventory', 'true'], ['playersSleepingPercentage', '50']], 'set like the game\'s rules');
  assert.deepEqual(gr.fromLevelDat({ playersSleepingPercentage: '25', keepInventory: 'false' }), { keepInventory: false, playersSleepingPercentage: 25 }, 'read back from the world');
});

test('game rules: settings are checked and cleaned', () => {
  const ok = gr.normalize({ enabled: true, live: '0', values: { keepInventory: 'true', randomTickSpeed: '10', pvp: false, idleMinutes: 30 } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { enabled: true, live: 0, values: { keepInventory: true, randomTickSpeed: 10, pvp: false, idleMinutes: 30 } });
  assert.deepEqual(gr.normalize(undefined).value, { enabled: false, live: 1, values: {} }, 'nothing saved: off, apply mode 1');
  const bad = gr.normalize({ enabled: true, live: 2, values: { nope: true, keepInventory: 'maybe', randomTickSpeed: 5000, idleMinutes: -1 } });
  assert.equal(bad.errors.length, 5, bad.errors.join(' | '));
  assert.match(bad.errors.join(' | '), /apply mode must be 1 .* or 0/);
  assert.match(bad.errors.join(' | '), /unknown game rule 'nope'/);
  assert.match(bad.errors.join(' | '), /randomTickSpeed must be a whole number from 0 to 1000/);
  assert.deepEqual(gr.normalize('x').errors, ['gameRules must be an object']);
});

test('game rules: what is sent to the game', () => {
  const all = gr.plan({ keepInventory: true, randomTickSpeed: 10, pvp: false }, null);
  assert.deepEqual(all.rules, [['keepInventory', 'true'], ['randomTickSpeed', '10']], 'only game rules, as text');
  assert.deepEqual(all.set, { pvp: false, flight: true, idleMinutes: 0, commandBlocks: true }, 'every switch, with the defaults filled in');
  const diff = gr.plan({ keepInventory: true, randomTickSpeed: 3 }, { keepInventory: true, randomTickSpeed: 10 });
  assert.deepEqual(diff.rules, [['randomTickSpeed', '3']], 'only the changed rules');
  assert.deepEqual(gr.plan({}, {}).set, { pvp: true, flight: true, idleMinutes: 0, commandBlocks: true }, "off: the game's own values");
  assert.deepEqual(gr.fromLevelDat({ keepInventory: 'true', randomTickSpeed: '7', unknownRule: 'x', doFireTick: 'nonsense' }), { keepInventory: true, randomTickSpeed: 7 });
});
