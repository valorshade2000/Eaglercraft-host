'use strict';
// Console output as text (src/chat-text.js) and the console correction in the game code.
//   node --test test/console.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const paths = require('../src/paths');
const { chatText } = require('../src/chat-text');
const { applyGamePatches, PATCHES } = require('../src/game-patches');

const lang = new Map([
  ['commands.tp.success', 'Teleported %s to %s'],
  ['commands.generic.usage', 'Usage: %s'],
  ['ordered', '%2$s before %1$s'],
  ['percent', '%s%% done'],
  ['chat.type.admin', '[%s: %s]'],
]);

test('console text: translations are filled in like the game does', () => {
  assert.equal(chatText({ k: 'commands.tp.success', a: [{ t: 'Steve' }, { t: 'Alex' }] }, lang), 'Teleported Steve to Alex');
  assert.equal(chatText({ k: 'ordered', a: [{ t: 'B' }, { t: 'A' }] }, lang), 'A before B', 'numbered arguments');
  assert.equal(chatText({ k: 'percent', a: [{ t: '50' }] }, lang), '50% done');
  assert.equal(chatText({ k: 'chat.type.admin', a: [{ t: 'Server' }, { k: 'commands.tp.success', a: [{ t: 'A' }, { t: 'B' }] }] }, lang), '[Server: Teleported A to B]', 'nested translations');
  assert.equal(chatText({ k: 'no.such.key', a: [{ t: 'x' }] }, lang), 'no.such.key x', 'a key without a string is shown as the key');
  assert.equal(chatText({ t: '§cRed§r text', s: [{ t: ' and more' }] }, lang), 'Red text and more', 'siblings follow, formatting codes are removed');
  assert.equal(chatText(null, lang), '');
});

test('console correction: both edits or neither, and the OP list replaces the owner-name check', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const con = PATCHES.find((p) => p.name === 'console commands from the host');
  assert.equal(con.edits.length, 2);
  // Without the end of the tick function the console correction is skipped entirely.
  const broken = orig.replace(con.edits[1].find, con.edits[1].find.replace('$p=26;continue _;default', '$p=26;continue _; default'));
  const r = applyGamePatches(broken);
  assert.equal(r.problems.filter((x) => x.startsWith('console commands from the host not applied')).length, 1);
  assert.ok(r.src.includes(con.edits[0].find), 'the start of the tick function is left as it was');
  assert.ok(!r.src.includes('__eaglanConsole'), 'no console hook');
  // On the real build: the queue is drained at the start of a tick, and DGw no longer checks the owner name.
  const ok = applyGamePatches(orig);
  assert.deepEqual(ok.problems, []);
  assert.match(ok.src, /case 0:if\(\$eaglanCommands\.length\)\{b=\$eaglanCommands\.shift\(\);\$p=34;continue _;\}b=a\.cx6;/);
  assert.match(ok.src, /case 34:if\(b\.begin\)\{try\{b\.begin\(\);\}catch\(\$\$e\)\{\}\}try\{\$z=Ejc\(a\.bsz,b\.sender,b\.command\);/);
  // The sender is a MinecraftServer to the game (as a server console is) without running its code.
  assert.match(ok.src, /function \$eaglanSender\(out\)\{var n=Object\.create\(ALS\.prototype\);G\.call\(n\);/);
  assert.match(ok.src, /function DGw\(a,b\)\{[^\n]*case 0:return a\.dhr\|\|\$eaglanIsOp\(b\.eq\)\?1:0;/);
  assert.ok(!/function DGw\(a,b\)\{[^\n]*a\.pf\.JM/.test(ok.src), 'the owner name is no longer checked');
});

test('console correction: skipped when the game code it relies on differs', () => {
  const orig = fs.readFileSync(paths.classesJs, 'utf8');
  const con = PATCHES.find((p) => p.name === 'console commands from the host');
  for (const anchor of con.requires) {
    const changed = orig.split(anchor).join(anchor.replace(/.$/, (c) => (c === ';' ? ',' : ';')));
    const { src, problems } = applyGamePatches(changed);
    assert.equal(problems.filter((x) => x.startsWith('console commands from the host')).length, 1, 'skipped without ' + anchor);
    assert.ok(!src.includes('__eaglanConsole'), 'no console hook without ' + anchor);
  }
});
