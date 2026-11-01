'use strict';
// Game rules and server switches the host can set (web page "Game Rules", config gameRules).
//
// RULES are all game rules that EaglercraftX u53 registers (GameRules constructor in classes.js),
// with the game's defaults. They are stored in the world (level.dat) and set with the game's own
// /gamerule command, run as the server. HOST_RULES are game rules of later Minecraft versions that the host's
// corrections give this game (game-patches.js); 1.8.8 stores them in the world like its own, and /gamerule sets them
// too. SWITCHES are server settings that the integrated server
// keeps only while it runs (never saved in the world); the host sets them at every start.
// Not offered, on purpose: "spawn animals" and "spawn villagers" (in 1.8 switching them off removes
// every existing animal or villager in loaded areas, pets included), "max players" (u53 does not
// enforce it) and spawn protection (not used by the integrated server).

const GROUPS = [
  { id: 'players', label: 'Players' },
  { id: 'commands', label: 'Commands and command blocks' },
  { id: 'world', label: 'World' },
  { id: 'mobs', label: 'Mobs and drops' },
  { id: 'eagler', label: 'Eaglercraft' },
];

const RULES = [
  { name: 'keepInventory', type: 'bool', def: false, group: 'players', label: 'Keep inventory', desc: 'Players keep their items and experience when they die.' },
  { name: 'naturalRegeneration', type: 'bool', def: true, group: 'players', label: 'Natural regeneration', desc: 'Health comes back over time when the hunger bar is full enough.' },
  { name: 'showDeathMessages', type: 'bool', def: true, group: 'players', label: 'Death messages', desc: 'A chat message when a player dies.' },
  { name: 'reducedDebugInfo', type: 'bool', def: false, group: 'players', label: 'Reduced debug screen', desc: 'The F3 screen hides coordinates and other details.' },
  { name: 'sendCommandFeedback', type: 'bool', def: true, group: 'commands', label: 'Command feedback', desc: 'Players see the result messages of the commands they run.' },
  { name: 'logAdminCommands', type: 'bool', def: true, group: 'commands', label: 'Log commands', desc: 'Commands that players run are written to the server log.' },
  { name: 'commandBlockOutput', type: 'bool', def: true, group: 'commands', label: 'Command block output', desc: 'Command blocks report what they ran to players who can use commands.' },
  { name: 'doDaylightCycle', type: 'bool', def: true, group: 'world', label: 'Day and night', desc: 'The time of day moves on.' },
  { name: 'doWeatherCycle', type: 'bool', def: true, group: 'world', label: 'Weather changes', desc: 'Rain and thunder start and stop on their own.' },
  { name: 'doFireTick', type: 'bool', def: true, group: 'world', label: 'Fire spreads', desc: 'Fire spreads to nearby blocks and burns out.' },
  { name: 'mobGriefing', type: 'bool', def: true, group: 'world', label: 'Mob griefing', desc: 'Creepers, endermen, ghasts, withers, zombies and sheep can change blocks.' },
  { name: 'randomTickSpeed', type: 'int', def: 3, min: 0, max: 1000, group: 'world', label: 'Random tick speed', desc: 'How fast crops and trees grow, leaves decay, ice melts (default 3, 0 stops it). High values cost a lot of CPU.' },
  { name: 'doMobSpawning', type: 'bool', def: true, group: 'mobs', label: 'Mob spawning', desc: 'Animals and monsters spawn on their own (spawners and eggs still work).' },
  { name: 'doMobLoot', type: 'bool', def: true, group: 'mobs', label: 'Mob loot', desc: 'Mobs drop items and experience when killed.' },
  { name: 'doTileDrops', type: 'bool', def: true, group: 'mobs', label: 'Block drops', desc: 'Broken blocks drop items.' },
  { name: 'doEntityDrops', type: 'bool', def: true, group: 'mobs', label: 'Entity drops', desc: 'Minecarts, boats, item frames and paintings drop as items when broken.' },
  { name: 'bedSpawnPoint', type: 'bool', def: true, group: 'eagler', label: 'Beds set spawn', desc: "Sleeping in a bed sets the player's respawn point." },
  { name: 'clickToRide', type: 'bool', def: false, group: 'eagler', label: 'Ride players', desc: 'Right-click another player with an empty hand to ride on them.' },
  { name: 'clickToSit', type: 'bool', def: true, group: 'eagler', label: 'Sit on stairs and slabs', desc: 'Right-click a stair or slab to sit on it.' },
  { name: 'colorCodes', type: 'bool', def: true, group: 'eagler', label: 'Color codes', desc: 'Players may use & color codes in chat and similar text.' },
  { name: 'loadSpawnChunks', type: 'bool', def: false, group: 'eagler', label: 'Keep spawn loaded', desc: 'The spawn area stays loaded when nobody is near it (uses memory and CPU).' },
  { name: 'doSignEditing', type: 'bool', def: true, group: 'eagler', label: 'Sign editing', desc: 'Stored in the world, but this game version does not use it.' },
];

const HOST_RULES = [
  // game-patches.js "players sleeping percentage" (Minecraft 1.17's rule; any whole number through /gamerule: above 100
  // the night is never skipped by sleeping)
  { name: 'playersSleepingPercentage', type: 'int', def: 100, min: 0, max: 100, group: 'players', label: 'Players sleeping to skip the night (%)', desc: 'How many of the players (spectators aside) must sleep to skip the night: 50 = half, 0 = one player. 100 = everyone, as the game does (the default).' },
];

const SWITCHES = [
  { name: 'pvp', type: 'bool', def: true, group: 'players', label: 'PvP', desc: 'Players can hurt each other.' },
  { name: 'flight', type: 'bool', def: true, group: 'players', label: 'Flying allowed', desc: 'Off: a player who flies without creative or spectator mode (a hacked client) is kicked after a few seconds, as on a normal server.' },
  { name: 'idleMinutes', type: 'int', def: 0, min: 0, max: 10080, group: 'players', label: 'Kick idle players after (minutes)', desc: 'Players who do nothing this long are kicked. 0 = never.' },
  { name: 'commandBlocks', type: 'bool', def: true, group: 'commands', label: 'Command blocks', desc: 'Command blocks and command block minecarts run their commands, and players who can use commands can edit them.' },
];

const ALL = [...RULES, ...HOST_RULES, ...SWITCHES];
const BY_NAME = new Map(ALL.map((x) => [x.name, x]));
const defaults = () => Object.fromEntries(ALL.map((x) => [x.name, x.def]));

// One value from the page, config or level.dat ("true"/"false"/"3" strings in level.dat).
function parseValue(spec, v) {
  if (spec.type === 'bool') {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return undefined;
  }
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : undefined;
}

// Checks the gameRules config ({ enabled, live, values }) and returns it cleaned, with the errors.
function normalize(input) {
  const errors = [], out = { enabled: false, live: 1, values: {} };
  if (input === undefined || input === null) return { value: out, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { value: out, errors: ['gameRules must be an object'] };
  out.enabled = input.enabled === true;
  if ('live' in input) {
    if (input.live === 1 || input.live === '1') out.live = 1;
    else if (input.live === 0 || input.live === '0') out.live = 0;
    else errors.push('the apply mode must be 1 (now) or 0 (at the next start)');
  }
  for (const [k, v] of Object.entries(input.values || {})) {
    const spec = BY_NAME.get(k);
    if (!spec) { errors.push(`unknown game rule '${k}'`); continue; }
    const p = parseValue(spec, v);
    if (p === undefined) { errors.push(spec.type === 'bool' ? `${k} must be on or off` : `${k} must be a whole number from ${spec.min} to ${spec.max}`); continue; }
    out.values[k] = p;
  }
  return { value: out, errors };
}

// What to send to the game for these values: game rules as [name, value text] (only rules that
// differ from `before`, or all when before is null) and the switches (always all, defaults filled in).
function plan(values, before) {
  const rules = [];
  for (const r of [...RULES, ...HOST_RULES]) {
    if (!(r.name in values)) continue;
    if (before && before[r.name] === values[r.name]) continue;
    rules.push([r.name, String(values[r.name])]);
  }
  const set = {};
  for (const s of SWITCHES) set[s.name] = s.name in values ? values[s.name] : s.def;
  return { rules, set };
}

// Game rules stored in a world's level.dat (Data.GameRules: name -> string), as typed values.
function fromLevelDat(gameRules) {
  const out = {};
  for (const r of [...RULES, ...HOST_RULES]) if (gameRules && r.name in gameRules) { const p = parseValue(r, gameRules[r.name]); if (p !== undefined) out[r.name] = p; }
  return out;
}

module.exports = { GROUPS, RULES, HOST_RULES, SWITCHES, defaults, normalize, plan, fromLevelDat, parseValue };
