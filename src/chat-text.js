'use strict';
// Chat messages from the game as plain text, for the web page console. The game hands over each
// message as {t: text} or {k: translation key, a: [arguments]}, with siblings in s (see the console
// correction in game-patches.js); keys are looked up in the game's en_US strings and filled in the way
// ChatComponentTranslation does it: %s, %1$s and %%. A key without a string is shown as the key, as
// the game does. Formatting codes (section sign + one character) are removed.
function chatText(o, lang) {
  if (!o) return '';
  let s;
  if (o.k !== undefined) {
    const args = (o.a || []).map((x) => chatText(x, lang)), fmt = lang.get(o.k);
    if (fmt === undefined) s = o.k + (args.length ? ' ' + args.join(' ') : '');
    else { let n = 0; s = fmt.replace(/%(?:(\d+)\$)?([A-Za-z%]|$)/g, (m, idx, t) => (t === '%' ? '%' : (idx ? args[+idx - 1] : args[n++]) ?? '')); }
  } else s = o.t || '';
  for (const x of o.s || []) s += chatText(x, lang);
  return s.replace(/§./g, '');
}

module.exports = { chatText };
