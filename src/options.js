'use strict';
// The web page's Option Manual: every setting of data/config.json this project has, with the values the host accepts,
// what it does and when a change takes effect. Used by the web UI server (ui-server.js: GET /api/options lists them
// with their values, POST /api/options saves one, validated here) and rendered by the page from that list, except the
// settings that have a control of their own elsewhere on the page (control 'elsewhere': the Settings form, its Game
// Rules, the Console's OP list), which are listed here only to keep every setting accounted for and for "needs".
// The defaults are control.js DEFAULT_CONFIG's (controlPort is not there: absent means 0, a free port).
//
// Each option:
//   type     boolean | integer | string | enum | gameRules | list
//   control  toggle | number | text | select | elsewhere (changed only where `where` says; not in the Option Manual)
//   applies  live:    saved, and a running world takes it at once (the host's /settings: control.applySettings)
//            restart: the world uses it from its next start (Host: Restart, or node cli.js restart)
//            ui:      the web page's own server uses it from its next start (node cli.js ui)
//            section: as its own part of the page says (Game Rules: the apply mode; the OP list: at once)
//   min, max (integers), nullable + nullLabel (null: the host chooses), not (integers refused inside the range),
//   minLength, maxLength (strings, trimmed), choices [[value, label]] (enum: the value keeps its type),
//   needs: another option this one works only with (shown; nothing is changed by itself), doc: the README section.
const OPTIONS = [
  // ---- the world and its players
  { key: 'ownerName', group: 'World and players', type: 'string', control: 'elsewhere', where: 'Settings', minLength: 1, maxLength: 16, applies: 'restart', label: 'Owner name (not OP)', doc: 'Console and OP',
    text: 'The integrated server\'s owner name. A player using it keeps their own game mode instead of the LAN game mode. It gives no commands: OP is given only in the Console. Do not let players use this name.' },
  { key: 'lanWorldName', group: 'World and players', type: 'string', control: 'elsewhere', where: 'Settings', minLength: 0, maxLength: 200, applies: 'restart', label: 'Shared world name', doc: 'Run, stop, configure, debug (CLI)',
    text: 'The world\'s name in the relays\' lists of shared worlds. Empty: the world\'s own name.' },
  { key: 'hidden', group: 'World and players', type: 'boolean', control: 'elsewhere', where: 'Settings', applies: 'restart', label: 'Hidden', doc: 'Run, stop, configure, debug (CLI)',
    text: 'Not listed in public lists of shared worlds; players join with the code.' },
  { key: 'difficulty', group: 'World and players', type: 'enum', control: 'elsewhere', where: 'Settings', choices: [[0, 'Peaceful'], [1, 'Easy'], [2, 'Normal'], [3, 'Hard']], applies: 'restart', label: 'Difficulty', doc: 'Run, stop, configure, debug (CLI)',
    text: 'The difficulty the world starts with (the /difficulty command changes it while it runs).' },
  { key: 'viewDistance', group: 'World and players', type: 'integer', control: 'elsewhere', where: 'Settings', min: 2, max: 16, applies: 'restart', label: 'View distance (chunks)', doc: 'Lag with many players',
    text: 'How many chunks round each player the server sends and keeps loaded.' },
  { key: 'lanGamemode', group: 'World and players', type: 'enum', control: 'elsewhere', where: 'Settings', choices: [[0, 'Survival'], [1, 'Creative'], [2, 'Adventure'], [3, 'Spectator']], applies: 'live', label: 'LAN game mode for joiners', doc: 'LAN game mode and cheats',
    text: 'The game mode of players who join or respawn. Applied to a running world at once.' },
  { key: 'lanCheats', group: 'World and players', type: 'boolean', control: 'elsewhere', where: 'Settings', applies: 'live', label: 'Cheats for every player', doc: 'LAN game mode and cheats',
    text: 'Every player can use all commands (gamemode, give, tp, kill...). Use only with players you trust. Applied to a running world at once.' },
  { key: 'playerLimit', group: 'World and players', type: 'integer', control: 'elsewhere', where: 'Settings', min: 0, max: 1000, applies: 'live', label: 'Player limit', doc: 'Player limit',
    text: 'Joins above this many players are refused with "This world is full". 0: no limit. Players already in the world stay.' },
  { key: 'mobCaps', group: 'World and players', type: 'enum', choices: [['vanilla', 'vanilla 1.8.8: 10 animals, 70 monsters per player'], ['viewDistance', 'as this game build ships (view distance 4: 2 animals, 19 monsters)']], applies: 'restart', needs: 'gamePatches', label: 'Mob caps', doc: 'Animals that never respawn: the mob caps (`mobCaps`)',
    text: 'How many mobs of a kind may be loaded before the game spawns more. vanilla counts the chunks within 8 of each player, as Minecraft 1.8.8 does: animals respawn where fewer than 10 per player are loaded. This game build counts only the view distance: at 4, 2 animals per player, always exceeded by the animals already loaded, so animals never respawn. Monsters, bats and squid follow the same rule (vanilla: 70, 15 and 5 per player).' },
  { key: 'donation', group: 'World and players', type: 'object', control: 'elsewhere', where: 'Donation message', applies: 'live', label: 'Donation message', doc: 'Donation message (`donation`, off by default)',
    text: 'The donation message (src/donation.js): on or off, the text, the fundraising goal, the wallet address, the lag threshold and the cooldown. Edited in its own section of the page.' },
  { key: 'gameRules', group: 'World and players', type: 'gameRules', control: 'elsewhere', where: 'Settings, Game Rules', applies: 'section', label: 'Game Rules', doc: 'Game Rules',
    text: 'The game rules the host sets in the world (the game\'s 22, and playersSleepingPercentage), whether it sets them, and when (apply mode 1: at once; 0: at the next start). Edited in Settings, Game Rules: it has a control for each rule.' },
  { key: 'ops', group: 'World and players', type: 'list', control: 'elsewhere', where: 'the Console (op and deop)', applies: 'section', label: 'OP list', doc: 'Console and OP',
    text: 'Players who may use every command. Changed only with op and deop in the Console (OP is given only there).' },
  // ---- the network
  { key: 'redundantSend', group: 'Network', type: 'boolean', control: 'elsewhere', where: 'Settings', applies: 'live', label: 'Send small packets twice', doc: 'Send small packets twice (opt-in)',
    text: 'Each small game packet goes to players a second time 10 ms later, so a lost packet usually costs nothing. For players who join from now on.' },
  { key: 'redundantPort', group: 'Network', type: 'integer', control: 'elsewhere', where: 'Settings', min: 1024, max: 65535, nullable: true, nullLabel: 'automatic (a free port per player)', applies: 'live', needs: 'redundantSend', label: 'UDP port for "send twice"', doc: 'Send small packets twice (opt-in)',
    text: 'The UDP port players send to for "send twice": allow it in the firewall. Automatic: a free port per player.' },
  { key: 'networkProcesses', group: 'Network', type: 'integer', min: 0, max: 16, applies: 'restart', label: 'Network processes', doc: 'Stage 8: more cores, exactly the same game (measured)',
    text: 'The players\' WebRTC connections in this many processes of their own, so sending to many players does not hold up the host. 0: off (one thread, as before).' },
  { key: 'controlPort', group: 'Network', type: 'integer', min: 0, max: 65535, not: [1, 1023], applies: 'restart', label: 'Host control port', doc: 'Run, stop, configure, debug (CLI)',
    text: 'The port of the host\'s control API on 127.0.0.1, which the CLI and this page use. 0: a free port at each start (the default; it is not in DEFAULT_CONFIG). Ports below 1024 need root.' },
  { key: 'uiPort', group: 'Network', type: 'integer', min: 1024, max: 65535, applies: 'ui', label: 'Web page port', doc: 'Run, stop, configure, debug (CLI)',
    text: 'The port of this web page (on 127.0.0.1 unless BIND is set). The PORT environment variable, when set, is used instead.' },
  // ---- the game thread
  { key: 'gamePatches', group: 'Game thread', type: 'boolean', applies: 'restart', label: 'Game code corrections', doc: 'What this project does',
    text: 'The corrections to the game code (LAN game mode on join, the console, the OP list, Game Rules, pre-generation, autosave spread, the speedups and every option below that changes how the game runs). Off: the game code exactly as shipped.' },
  { key: 'speedups', group: 'Game thread', type: 'boolean', applies: 'restart', needs: 'gamePatches', label: 'Speedups', doc: 'Speedups on the game thread',
    text: 'The same results with less work on the game thread (chunk lookups, UUID text, packet hand-over, 64-bit constants, lighting sets). On by default.' },
  { key: 'collisionScan', group: 'Game thread', type: 'boolean', applies: 'restart', needs: 'speedups', label: 'Collision scan', doc: 'Many entities in one place (stage 6, measured)',
    text: 'A moving entity skips the walk over the entities near it when none of them can give it a collision box (only boats and moving minecarts can). Same results; much faster with many mobs in one place.' },
  { key: 'encodeOnce', group: 'Game thread', type: 'boolean', applies: 'restart', needs: 'speedups', label: 'Encode once', doc: 'Stage 8: more cores, exactly the same game (measured)',
    text: 'A packet the entity tracker sends to several players is made once and copied for the others. Same bytes.' },
  { key: 'packedHandover', group: 'Game thread', type: 'boolean', applies: 'restart', needs: 'speedups', label: 'Packed hand-over', doc: 'Stage 8: more cores, exactly the same game (measured)',
    text: 'A player\'s packets of a tick go to the network side in one buffer instead of one message each. Same packets, same order.' },
  { key: 'spreadAutosave', group: 'Game thread', type: 'boolean', applies: 'restart', label: 'Spread the autosave', doc: 'Autosave spread over ticks (`spreadAutosave`, on by default)',
    text: 'The autosave\'s chunk saves are spread over the next ticks instead of all in one tick. On by default.' },
  { key: 'diskSync', group: 'Game thread', type: 'enum', choices: [['full', 'full: every world write synced to disk'], ['normal', 'normal: not synced one by one (faster on slow disks)']], applies: 'restart', label: 'Disk sync', doc: 'Game server stalls ("Can\'t keep up!")',
    text: 'normal: world writes are not synced to disk one by one; faster on slow disks, but the last writes can roll back after a power loss.' },
  { key: 'maxHeapMb', group: 'Game thread', type: 'integer', min: 256, max: 65536, applies: 'restart', label: 'Game heap (MB)', doc: 'Where CPU and memory go (measured)',
    text: 'The most memory the game thread\'s old generation may use, in MB.' },
  { key: 'youngGenerationMb', group: 'Game thread', type: 'integer', min: 16, max: 1024, nullable: true, nullLabel: 'Node\'s own choice', applies: 'restart', label: 'Young generation (MB)', doc: 'Young generation of the game thread (`youngGenerationMb`, opt-in)',
    text: 'The size of the game thread\'s young generation in MB (e.g. 128): fewer, longer garbage collections.' },
  // ---- other cores
  { key: 'multiCore', group: 'Other cores', type: 'boolean', control: 'elsewhere', where: 'Settings', applies: 'live', needs: 'gamePatches', label: 'Multi-core mode', doc: 'Multi-core mode (`multiCore`, opt-in, measured)',
    text: 'Large network packets and saved chunks are compressed on other CPU cores. Switched on or off in a running world at once.' },
  { key: 'multiCoreWorkers', group: 'Other cores', type: 'integer', min: 1, max: 64, nullable: true, nullLabel: 'automatic (2, or 1 on a 2-CPU server)', applies: 'restart', needs: 'multiCore', label: 'Multi-core pool threads', doc: 'Multi-core mode (`multiCore`, opt-in, measured)',
    text: 'The multi-core mode\'s pool threads; never more than the CPUs allow minus 1.' },
  { key: 'pathAhead', group: 'Other cores', type: 'boolean', applies: 'restart', needs: 'gamePatches', label: 'Path steps ahead', doc: 'Stage 8: more cores, exactly the same game (measured)',
    text: 'Mobs\' path following is worked out ahead on a thread of its own and used only when nothing it read has changed. Same game.' },
  { key: 'pathAheadSearches', group: 'Other cores', type: 'boolean', applies: 'restart', needs: 'pathAhead', label: 'Path searches ahead', doc: 'Stage 8: more cores, exactly the same game (measured)',
    text: 'Also the chase path searches mobs are about to make. Same game, but no measured gain.' },
  { key: 'decorationAhead', group: 'Other cores', type: 'boolean', applies: 'restart', needs: 'gamePatches', label: 'Decoration ahead (players)', doc: 'Decoration ahead (`decorationAhead`, `decorationAheadPregen`; exact, no measurable gain)',
    text: 'The decoration of the chunks players are about to reach is worked out on a thread of its own and replayed only when nothing it read has changed. Same game, but no measurable gain.' },
  { key: 'decorationAheadPregen', group: 'Other cores', type: 'boolean', applies: 'restart', needs: 'gamePatches', label: 'Decoration ahead (pre-generation)', doc: 'Decoration ahead (`decorationAhead`, `decorationAheadPregen`; exact, no measurable gain)',
    text: 'The same for the pre-generation job\'s chunks. Same game, but no measurable gain.' },
  // ---- terrain and pre-generation
  { key: 'terrainThreads', group: 'Terrain and pre-generation', type: 'integer', min: 0, max: 8, applies: 'restart', label: 'Terrain threads', doc: 'Terrain threads for pre-generation (`terrainThreads`, opt-in, measured)',
    text: 'Threads that make the terrain of chunks for a pre-generation job (and, with the next option, for players). 0: off; 1 is enough.' },
  { key: 'terrainVerify', group: 'Terrain and pre-generation', type: 'boolean', applies: 'restart', needs: 'terrainThreads', label: 'Terrain threads: compare every chunk', doc: 'Terrain threads for pre-generation (`terrainThreads`, opt-in, measured)',
    text: 'A check: every chunk a terrain thread makes is compared with the game\'s own instead of used.' },
  { key: 'terrainForPlayers', group: 'Terrain and pre-generation', type: 'boolean', applies: 'restart', needs: 'terrainThreads', label: 'Terrain threads for players', doc: 'Chunk work in fresh terrain (stage 5, measured)',
    text: 'The terrain threads also make the terrain of the chunks players are about to reach.' },
  { key: 'pregenFastWhenEmpty', group: 'Terrain and pre-generation', type: 'boolean', applies: 'restart', label: 'Faster pre-generation while nobody plays', doc: 'Pre-generating the world',
    text: 'A pre-generation job loads more than one chunk per tick while nobody is on the server (up to its speed). On by default.' },
  { key: 'Pre-generationOnline', group: 'Terrain and pre-generation', type: 'boolean', applies: 'restart', label: 'Resume pre-generation at start', doc: 'Pre-generating the world',
    text: 'An unfinished pre-generation is resumed when the world starts. Off: only when it is started again (Pre-generate, Resume).' },
  // ---- regions
  { key: 'regions', group: 'Regions (experimental)', type: 'boolean', applies: 'restart', label: 'Regions', doc: 'Regions (`regions`, off by default, experimental)',
    text: 'Groups of players far apart play on game instances of their own (one world), each on its own core. Experimental.' },
  { key: 'regionInstances', group: 'Regions (experimental)', type: 'integer', min: 0, max: 15, nullable: true, nullLabel: 'automatic (one per CPU left over, at most 7)', applies: 'restart', needs: 'regions', label: 'Region instances', doc: 'Regions (`regions`, off by default, experimental)',
    text: 'At most so many region instances besides the main one.' },
];
const CONTROL = { boolean: 'toggle', integer: 'number', string: 'text', enum: 'select' };
for (const o of OPTIONS) if (!o.control) o.control = CONTROL[o.type];
const BY_KEY = new Map(OPTIONS.map((o) => [o.key, o]));
// Keys the code reads that are not in control.js DEFAULT_CONFIG, with their default.
const EXTRA_DEFAULTS = { controlPort: 0 };

// A value for option `key` as the host accepts it: { value } (normalised: strings trimmed) or { error }.
function validate(key, value) {
  const o = BY_KEY.get(key);
  if (!o) return { error: `${key}: not a setting of data/config.json` };
  if (o.control === 'elsewhere') return { error: `${key}: changed in ${o.where} on the web page, not here` };
  const name = `${o.label} (${key})`;
  if (o.type === 'boolean') return typeof value === 'boolean' ? { value } : { error: `${name}: on or off (true or false)` };
  if (o.type === 'integer') {
    if (value === null && o.nullable) return { value: null };
    const range = `a whole number from ${o.min} to ${o.max}${o.not ? `, not ${o.not[0]}-${o.not[1]}` : ''}${o.nullable ? `, or empty for ${o.nullLabel}` : ''}`;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < o.min || value > o.max) return { error: `${name}: ${range}` };
    if (o.not && value >= o.not[0] && value <= o.not[1]) return { error: `${name}: ${range} (ports below 1024 need root)` };
    return { value };
  }
  if (o.type === 'string') {
    if (typeof value !== 'string') return { error: `${name}: text` };
    const v = value.trim();
    if (v.length < o.minLength || v.length > o.maxLength) return { error: `${name}: ${o.minLength ? `${o.minLength} to ` : 'at most '}${o.maxLength} characters` };
    if (/[\u0000-\u001f\u007f]/.test(v)) return { error: `${name}: no control characters` };
    return { value: v };
  }
  if (o.type === 'enum') {
    const c = o.choices.find((x) => x[0] === value);
    return c ? { value: c[0] } : { error: `${name}: one of ${o.choices.map((x) => JSON.stringify(x[0])).join(', ')}` };
  }
  return { error: `${name}: cannot be set here` };
}

// The list for the page: each option with its default and the value data/config.json has for it (absent: not there).
function describe(defaults, file) {
  return OPTIONS.map((o) => {
    const d = { ...o, default: o.key in defaults ? defaults[o.key] : EXTRA_DEFAULTS[o.key] };
    if (Object.prototype.hasOwnProperty.call(file, o.key)) {
      d.inFile = true; d.value = file[o.key];
      // (the host also reads "true" as text for this one: daemon.js pregenOnline)
      if (o.key === 'Pre-generationOnline' && typeof d.value === 'string') { d.value = d.value.toLowerCase() === 'true'; d.fileNote = 'saved as text in data/config.json; the host reads it as ' + (d.value ? 'on' : 'off'); }
      if (o.control !== 'elsewhere') { const v = validate(o.key, d.value); if (v.error) d.fileError = v.error; }
    } else { d.inFile = false; d.value = d.default; }
    return d;
  });
}

module.exports = { OPTIONS, EXTRA_DEFAULTS, validate, describe };
