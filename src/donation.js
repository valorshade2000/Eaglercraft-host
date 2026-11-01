'use strict';
// The donation message (web page "Donation message", config donation; off by default): the server owner's message, a
// fundraising goal and the wallet address to send to. It goes to the in-game chat when the game server lags (fewer
// ticks per second than lagTps over the last 30 s, while players are on; at most once per cooldownMinutes; daemon.js)
// and when the owner sends it from the web page, and it is shown on the players' page (/client/ and /donate,
// public/donate.js). No payment service and no tracking: "raised" is what the owner types in.

const DEFAULTS = Object.freeze({
  enabled: false,
  message: 'Enjoying the game? This server is run by its owner on one machine. A donation helps pay for a faster server, so everyone gets less lag. Thank you for your support!',
  goal: 50,          // fundraising goal (0: none shown)
  raised: 0,         // raised so far, as the owner types it
  currency: 'USDT',
  goalFor: 'a faster server',
  address: 'TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC',
  network: 'TRON (TRC-20)',
  lagTps: 15,        // lag: fewer game ticks per second than this over the last 30 s (20 is full speed)
  cooldownMinutes: 30,
});
const LAG_WINDOW_MS = 30000;
const TEXT = { message: [1, 300], currency: [0, 12], goalFor: [0, 60], network: [0, 40] };

// The donation settings checked: { value } (every field, defaults filled in) and the errors (a wrong field keeps its
// default in value).
function normalize(input) {
  const out = { ...DEFAULTS }, errors = [];
  if (input === undefined || input === null) return { value: out, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { value: out, errors: ['donation must be an object'] };
  const num = (k, min, max, label, step) => {
    if (!(k in input)) return;
    const v = typeof input[k] === 'string' && input[k].trim() !== '' ? Number(input[k]) : input[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (step === 1 && !Number.isInteger(v))) errors.push(`${label}: a ${step === 1 ? 'whole ' : ''}number from ${min} to ${max}`);
    else out[k] = step === 1 ? v : Math.round(v * 100) / 100;
  };
  if ('enabled' in input) { if (typeof input.enabled === 'boolean') out.enabled = input.enabled; else errors.push('enabled: on or off (true or false)'); }
  for (const [k, [min, max]] of Object.entries(TEXT)) {
    if (!(k in input)) continue;
    const v = typeof input[k] === 'string' ? input[k].replace(/\s+/g, ' ').trim() : null;
    if (v === null || v.length < min || v.length > max) errors.push(`${k === 'goalFor' ? 'Goal for' : k[0].toUpperCase() + k.slice(1)}: ${min ? `${min} to ` : 'at most '}${max} characters`);
    else if (/[\u0000-\u001f\u007f§]/.test(v)) errors.push(`${k}: no control characters or §`);
    else out[k] = v;
  }
  if ('address' in input) {
    const v = typeof input.address === 'string' ? input.address.trim() : '';
    if (!/^[A-Za-z0-9]{20,100}$/.test(v)) errors.push('Wallet address: 20 to 100 letters and digits, no spaces');
    else out.address = v;
  }
  num('goal', 0, 1e9, 'Goal', 0.01);
  num('raised', 0, 1e9, 'Raised so far', 0.01);
  num('lagTps', 1, 19.5, 'Lag threshold (ticks per second)', 0.1);
  num('cooldownMinutes', 1, 1440, 'Cooldown (minutes)', 1);
  return { value: out, errors };
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));
// "12 of 50 USDT raised for a faster server" / "Goal: 50 USDT for a faster server" / '' (no goal)
function goalText(d) {
  if (!(d.goal > 0)) return '';
  const cur = d.currency ? ' ' + d.currency : '', what = d.goalFor ? ' for ' + d.goalFor : '';
  return d.raised > 0 ? `${fmt(d.raised)} of ${fmt(d.goal)}${cur} raised${what}` : `Goal: ${fmt(d.goal)}${cur}${what}`;
}

// The message as the game's chat text components (Minecraft 1.8 JSON), for tellraw. The address is a link: clicked, the
// game asks "open the link or copy it" and its "Copy to Clipboard" puts the address on the clipboard (1.8 has no
// copy action of its own; EaglercraftX passes the address to that screen as it is). Shift-click puts it in the chat box.
function chatComponents(d, { lag = false } = {}) {
  const parts = [{ text: '' }, { text: 'Support this server', color: 'gold', bold: true }];
  parts.push({ text: '\n' + (lag ? 'The server is running slow right now. ' : '') + d.message, color: 'gray' });
  const goal = goalText(d);
  if (goal) parts.push({ text: '\n' + goal, color: 'yellow' });
  parts.push({ text: `\nSend${d.network ? ' ' + d.network : ''} to: `, color: 'gray' });
  parts.push({ text: d.address, color: 'aqua', underlined: true, insertion: d.address,
    clickEvent: { action: 'open_url', value: d.address },
    hoverEvent: { action: 'show_text', value: { text: 'Click, then "Copy to Clipboard"', color: 'yellow' } } });
  parts.push({ text: '\n(click the address, then Copy to Clipboard)', color: 'dark_gray', italic: true });
  return parts;
}
const chatCommand = (d, opts) => 'tellraw @a ' + JSON.stringify(chatComponents(d, opts));

// What the players' page gets (GET /api/donation): nothing but "off" while off.
function publicView(d, { lag = false } = {}) {
  if (!d.enabled) return { enabled: false };
  return { enabled: true, message: d.message, goal: d.goal, raised: d.raised, currency: d.currency, goalFor: d.goalFor, goalText: goalText(d),
    address: d.address, network: d.network, lag: !!lag, cooldownMinutes: d.cooldownMinutes };
}

// Whether the game server lags now, and whether the message goes to the chat: tps (game ticks per second over the
// last 30 s, null while not known), players on, the last automatic message (lastAt).
function lagDecision(d, { tps, players, now, lastAt }) {
  const lag = d.enabled && tps !== null && tps !== undefined && tps < d.lagTps;
  const send = lag && players > 0 && (!lastAt || now - lastAt >= d.cooldownMinutes * 60000);
  return { lag, send };
}

module.exports = { DEFAULTS, LAG_WINDOW_MS, normalize, goalText, chatComponents, chatCommand, publicView, lagDecision };
