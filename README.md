# eaglan-host: headless Eaglercraft World LAN host

EaglercraftX 1.8 · native World LAN (relay + WebRTC) · no client, no GPU

**Host an EaglercraftX 1.8 world on a server, around the clock, with the game's own World LAN ("Shared World").**

This project hosts an Eaglercraft world over the game's **own World LAN ("Shared World")** feature as a background process on a server. It registers the world on **several relays at once**, so it can be joined through any of them. Players join with the normal, unmodified client: **Multiplayer → Direct Connect → Join Shared World → code**.

It does not use EaglerXServer, Paper/Spigot, BungeeCord or Velocity. The Minecraft server that runs is the game's own integrated server.

> ❤️ **Like this project?** You can support it with a donation: see [Support this project](#support-this-project).

## Features

- **Headless and CPU-only:** plain Node.js, with no display, browser, rendering or GPU. Everything can be done from the command line; the web page is optional.
- **One world, many relays:** the world is registered on several relays at once, each with its own join code. A relay that fails is retried on its own while the others keep working, and the players in the world stay connected.
- **Web page** (optional, local only): status and join codes, the players with their round-trip time, a server console with OP, settings, Game Rules, the Option Manual, worlds (create, import, export, rename, delete, restore), pre-generation and the logs.
- **Corrections to the game,** made in memory (the game files stay unchanged): the LAN game mode on join, animals that never respawned (the mob caps), entities not shown after a join or a teleport, and Minecraft 1.17's game rule `playersSleepingPercentage`.
- **Less lag, measured:** world pre-generation, the autosave spread over ticks, speedups on the game thread, a multi-core mode, terrain threads, network processes, and regions on several cores (experimental).
- **Network:** each player's round-trip time, an opt-in mode that sends small packets twice for players on lossy routes, and route checks from real probes around the world.
- **Donation message** (off by default): asks players for support in the in-game chat when the server lags, and on the players' pages.
- **Safe with worlds:** nothing deletes or overwrites a world, and a deleted world can be restored.
- **Runs as a service:** systemd units and Docker files are included; the last world resumes at boot and is saved on stop.

## Requirements

- **Node.js ≥ 22.13** (for the built-in `node:sqlite`). The npm dependencies are `ws` and `node-datachannel` (WebRTC).
- **A Linux server** (x64, arm64 or arm; glibc ≥ 2.30 or musl) with outbound UDP; no inbound ports are needed. So far it has been tested on Windows 10 only (see [Limitations](#limitations)).
- **Game version:** EaglercraftX 1.8 **u53** (lax1dude), the official build linked from eaglercraft.com. The web build `u53_web.zip` is vendored in `vendor/eaglercraftx-1.8-u53/`:
  - `u53_web.zip` sha256 `843095ac…722c801`
  - `classes.js` sha256 `d8808775…bcc89e`
- **Nothing graphical:** the host is a plain Node.js process: the game's server logic in a worker thread, relay/WebRTC networking and SQLite storage. It has no GUI, display server, browser, rendering, GPU or graphics library.

## Quick start

In the project's folder (from the release zip or a copy of this repository):

```bash
bash install.sh                 # dependencies and a smoke test
node cli.js create "My World"   # a new world, hosted in the background
node cli.js status              # its join codes: one per relay
```

Players then join with **Multiplayer → Direct Connect → Join Shared World** and one of the codes. For the optional web page run `node cli.js ui` and open http://127.0.0.1:8090/ through an SSH tunnel (see [OP](#op)).

## Contents

- **Getting started:** [Install on a Linux server](#install-on-a-linux-server) · [Run, stop, configure, debug (CLI)](#run-stop-configure-debug-cli) · [Option Manual](#option-manual-web-page) · [Renaming and deleting worlds](#renaming-and-deleting-worlds)
- **In the game:** [LAN game mode and cheats](#lan-game-mode-and-cheats) · [Console and OP](#console-and-op) · [Game Rules](#game-rules) · [Animals that never respawn: the mob caps](#animals-that-never-respawn-the-mob-caps-mobcaps-measured) · [Donation message](#donation-message-donation-off-by-default)
- **Relays and network:** [Relays: one world, many relays](#relays-one-world-many-relays) · [How World LAN works](#how-world-lan-works-u53-source) · [What this project does](#what-this-project-does) · [Network notes](#network-notes) · [Network performance](#network-performance-players-far-from-the-server)
- **Performance (measured):** [Lag with many players](#lag-with-many-players-measured) · [Multi-core mode](#multi-core-mode-multicore-opt-in-measured) · [Terrain threads](#terrain-threads-for-pre-generation-terrainthreads-opt-in-measured) · [Entity processing](#entity-processing-what-could-run-in-parallel-measured) · [Speedups on the game thread](#speedups-on-the-game-thread-speedups-on-by-default-measured) · [Multi-core game simulation](#multi-core-game-simulation-what-this-engine-allows-measured) · [Regions](#regions-regions-off-by-default-experimental) · [Chunk work in fresh terrain](#chunk-work-in-fresh-terrain-stage-5-measured) · [Many entities in one place](#many-entities-in-one-place-stage-6-measured) · [Stage 8](#stage-8-more-cores-exactly-the-same-game-measured) · [Where CPU and memory go](#where-cpu-and-memory-go-measured)
- **The project:** [Limitations](#limitations) · [Tests](#tests) · [Support this project](#support-this-project)

## Install on a Linux server

```bash
unzip eaglan-host-linux.zip && cd eaglan-host
./install.sh                  # installs dependencies and runs a smoke test
```

From a copy of this repository, run `bash install.sh` in its folder instead: the same steps.

`node-datachannel` needs a native binary (glibc ≥ 2.30 or musl; x64/arm64/arm). Its installer normally downloads it from the package's release page. To install without that download, put the matching `node-datachannel-v0.32.3-napi-v8-linux-x64.tar.gz` (or `linuxmusl-…`, `…-arm64`) into `./prebuilds/` (or set `EAGLAN_PREBUILDS_DIR`). `install.sh` then unpacks it locally.

To start automatically, use either:
- `./install.sh --service` for a systemd *user* service, or
- `deploy/eaglan-host.service` for a system service (steps in the file header).

Both run the optional web UI as supervisor, resume the last world at boot, and save the world on stop.

## Run, stop, configure, debug (CLI)

```
node cli.js worlds                          list worlds
node cli.js create "<name>" [seed]          create a NEW world and host it (background)
node cli.js start "<folder>"                host an existing world (background)
node cli.js start "<folder>" --foreground   same, attached: logs on stdout, Ctrl+C saves and stops
node cli.js status                          state, join codes, per-relay status, players (with RTT)
node cli.js stop | restart | save | logs
node cli.js relays                          relay list + live state of each relay
node cli.js relays apply                    apply an edited data/relays.txt to the running world
node cli.js relays probe [url ...]          test relays end to end
node cli.js redundant [on|off]              send small packets to players twice (see "Network performance")
node cli.js redundant port <n|auto>         UDP port for it (1024-65535), or a free port per player
node cli.js settings apply                  apply game mode, cheats, send twice, Game Rules and the donation message from data/config.json now
node cli.js cmd <command ...>               run a server command, e.g. cmd kick Steve (op/deop: web page only)
node cli.js pregen <blocks> [chunks/s]      generate and save the terrain round spawn while the world runs (see "Lag with many players")
node cli.js pregen resume | stop | status   continue an unfinished one / stop it, or discard an unfinished one / progress
node cli.js limit [<players>|off]           refuse joins above that many players (default off)
node cli.js multicore [on|off]              multi-core mode: packets and saved chunks compressed on other CPU cores (default off)
node cli.js import <file.epk|.zip> [name] | export "<folder>" [epk|zip]
node cli.js rename "<folder>" "<new name>"  rename a world (see "Renaming and deleting worlds")
node cli.js delete "<folder>"               move a world to the deleted worlds; deleted | restore <id> | purge <id> --yes
node cli.js ui                              optional web UI on http://127.0.0.1:8090/
node tools/netcheck.js local | paths | compare   network checks (see "Network performance")
```

- **Logs:** `data/logs/host.log` (`tail -f` it); `daemon-stdout.log` holds early crash output.
- **State:** `data/host-state.json` has the machine-readable state, including every relay's state and code.
- **Load:** the `load:` line of `node cli.js status` (and *Host load* on the web page) splits the last minute's CPU into game thread, network thread and the rest, with player messages per second, and memory into game, host and runtime (see "Where CPU and memory go").
- **Config:** `data/config.json` holds `lanGamemode` (0 Survival, 1 Creative, 2 Adventure, 3 Spectator) and `lanCheats` (see "LAN game mode and cheats"), difficulty, view distance, hidden flag, owner name, `redundantSend` (send twice, default `false`) and `redundantPort` (its UDP port, default `null` = automatic), `diskSync` (`"full"` by default, see "Game server stalls"), `gamePatches` (default `true`), `gameRules` (see "Game Rules"), `ops`, the OP list (see "Console and OP"), `playerLimit` (default `0`, no limit), `spreadAutosave` (default `true`), `youngGenerationMb` (default `null`, Node's own choice) and `"Pre-generationOnline"` (default `false`), all in "Lag with many players"; `multiCore` (default `false`) and `multiCoreWorkers` (default `null`: 2, or 1 on a 2-CPU server), see "Multi-core mode"; `terrainThreads` (default `0`, off), `terrainVerify` (default `false`) and `terrainForPlayers` (default `false`), see "Terrain threads for pre-generation" and "Chunk work in fresh terrain"; `pregenFastWhenEmpty` (default `true`), see "Pre-generating the world"; `speedups` (default `true`) and `collisionScan` (default `false`), see "Speedups on the game thread" and "Many entities in one place"; `regions` (default `false`) and `regionInstances` (default `null`: one per CPU left over), see "Regions"; `encodeOnce`, `packedHandover`, `pathAhead`, `pathAheadSearches`, `decorationAhead`, `decorationAheadPregen` (default `false`) and `networkProcesses` (default `0`), see "Stage 8"; `maxHeapMb` (default `2048`), `uiPort` (default `8090`) and `controlPort` (the host's control port on 127.0.0.1, default `0`: a free port at each start); `mobCaps` (default `"vanilla"`), see "Animals that never respawn: the mob caps"; `donation` (the donation message, off by default), see "Donation message". `data/relays.txt` holds the relays; `data/pregen.json` a pre-generation that is not finished yet. The web page edits all of them: in Settings, in the Option Manual (see "Option Manual") or, for the donation message, in its own section.
- **Data directory:** `EAGLAN_DATA` moves it. `EAGLAN_RELAYS_FILE` moves just the relay list.

### Option Manual (web page)

The web page's **Option Manual** section lists the settings of `data/config.json` that have no control elsewhere on the page (25 of the 39 in `src/options.js`), in groups: its key, what it does, its default, the value the file has (or "not in data/config.json: the default applies"), the README section about it, and when a change takes effect:

- **restart the world**: saved now, used from the world's next Start/Restart (a note lists the ones saved while the world runs);
- **restart the web page server**: `uiPort` (the `PORT` environment variable, when set, is used instead).

The other 14 are not repeated there: the 11 of the Settings form (`ownerName`, `lanWorldName`, `hidden`, `difficulty`, `viewDistance`, `lanGamemode`, `lanCheats`, `playerLimit`, `redundantSend`, `redundantPort`, `multiCore`), its Game Rules (`gameRules`), the OP list (`ops`, changed only with `op` and `deop` in the Console) and the donation message (`donation`, in its own section: see "Donation message"); `POST /api/options` refuses them. The relays are in `data/relays.txt` (Settings).

On/off settings have an ON/OFF switch, numbers a number field with the accepted range (empty where `null` means "automatic" or "Node's own choice"), and settings with a fixed set of values a list. Each setting has its own **Save**, which writes only that key to `data/config.json`, with the value's type (true/false, a whole number or `null`, the list's value), and leaves every other key of the file as it is, keys of no setting included; **Default** puts the default in the field and Save writes it. A value the host does not accept is shown with the reason and cannot be saved (the server checks it again); a value in the file that the host does not accept is marked. Nothing is written when the page opens, and a file that is not valid JSON is never replaced: saving is refused until it is fixed. "works with" names the setting another one depends on (also one of Settings, such as `multiCore`), marked "off now" when that one is off; nothing is changed by itself. API: `GET /api/options`; `POST /api/options` with `{"key": ..., "value": ...}`.

### Renaming and deleting worlds

The web page's Worlds section has **Rename** and **Delete** for the selected world (and `node cli.js rename`, `delete`, `deleted`, `restore`, `purge`). Both work only while no world runs, like Create, Import and Export.

- **Rename** gives the world a new name, and its folder too: this game version names a world after its folder whenever it loads it (the integrated server sets `LevelName` in `level.dat` to the folder's name), so a name kept apart from the folder would be gone after the next session. Every file of the world moves to the new folder in one transaction, `level.dat` changes only in its name, and the world keeps its place in the list; the host's files that name the world by its folder follow (the last world for Restart and `EAGLAN_AUTOSTART=last`, a waiting pre-generation). Characters a folder cannot have become `_`, and a name another world has gets a `-`, as for a new world. A service that starts a world by its old name (`EAGLAN_AUTOSTART=<name>`) is warned about: it would make a new world of that name.
- **Delete** asks for the world's name (or folder) typed again, then moves the world to **Deleted worlds** (in `data/worlds.sqlite`, under `deleted/<time>/<folder>/`; the game no longer sees it): nothing is lost. **Restore** puts it back, into a new folder if its old one has been taken since. **Delete permanently** (the name typed again) removes its files for good; the space is reused by the database, the file does not shrink. A waiting pre-generation of a deleted world is dropped (its chunks stay in the world). A deleted world is never made again by Restart or `EAGLAN_AUTOSTART=last`: they report that it no longer exists.

## LAN game mode and cheats

Both settings apply to the running world as soon as you save them: in the web page's Settings, or by editing `data/config.json` and running `node cli.js settings apply`. No restart is needed. The log shows `LAN settings applied: ...`.

| Setting | Applies to | Takes effect |
|---|---|---|
| LAN game mode for joiners (`lanGamemode`) | every player except one using the owner name | when a player joins or respawns. Players already in the world keep their mode until they respawn. Returning players get it too, in place of the mode they had when they left. |
| Allow cheats for every player (`lanCheats`) | **every player**, OP or not. For single players, give OP in the console (see "Console and OP"). | at once, for players already in the world too |

**Game mode fix.** In u53 the LAN game mode reached players only when they respawned. The game's `setPlayerGameTypeBasedOnOther` gets the player's previous body on respawn but nothing on join, so a joining player got the world's game mode instead. Measured with the unmodified client: with LAN game mode Creative, two new players joined in Survival and became Creative only after dying.

The host now corrects this one function in memory when it loads `classes.js` (`src/game-patches.js`); the file on disk is unchanged. On join it now applies the same rule as on respawn, which is also what vanilla 1.8 does with Open to LAN. The correction is used only when the exact original code is found. Otherwise the log says `LAN game mode on join not applied: ...` and the game runs as shipped. To switch the correction off, set `"gamePatches": false` in `data/config.json` and restart.

So the game mode chosen when a world was created no longer decides the mode of players who join; the LAN game mode does, as it already did on respawn. The "Allow cheats" box in "Create world" is only saved in the world, for single-player after an export. On this host it gives nobody commands (see "Console and OP").

**What cheats allow.** Tested with the unmodified client, cheats on:

- **Work:** `/time`, `/kill`, `/list`, `/kick`, `/setidletimeout`, `/defaultgamemode` and `/gamerule`. The 22 game rules include `keepInventory`, `mobGriefing` and `doFireTick`; the host adds `playersSleepingPercentage` (see "Game Rules").
- **Not in u53** ("Unknown command"): `/op`, `/ban`, `/stop`, `/save-off`, `/publish`.
- **In the game code:** the other standard 1.8 commands, such as `/gamemode`, `/tp`, `/give`, `/fill`, `/setblock`, `/clone`, `/summon` and `/clear` (the full list is in "Console and OP"). `/gamemode` and `/tp` were also run from the console on connected players.

So with cheats on, any player can kick, kill or teleport other players, change anyone's game mode and the game rules, and change large parts of the world. No player can stop the server, turn off saving, ban anyone or give OP. Anyone with a join code can join, so turn cheats on only when you trust everyone who has it.

With cheats off, only OPs can use commands, and OP is given and taken only in the web page console (see "Console and OP").

## Console and OP

The web page has a **Console** below *How players join*. It runs commands as the server, like a dedicated server's console.

- **Game commands:** every command of the game, with every permission, also while cheats are off. `help` lists them. u53 has these 45: `achievement`, `blockdata`, `clear`, `clone`, `defaultgamemode`, `difficulty`, `effect`, `enchant`, `entitydata`, `execute`, `fill`, `gamemode`, `gamerule`, `give`, `help`, `kick`, `kill`, `list`, `me`, `particle`, `playsound`, `replaceitem`, `say`, `scoreboard`, `seed`, `setblock`, `setidletimeout`, `setworldspawn`, `spawnpoint`, `spreadplayers`, `stats`, `summon`, `tell`, `tellraw`, `testfor`, `testforblock`, `testforblocks`, `time`, `title`, `toggledownfall`, `tp`, `trigger`, `weather`, `worldborder`, `xp`. Eaglercraft's `eagskull` is listed too, but it runs only on a player's own client.
- **Host commands**, added by the console: `op <player>`, `deop <player>`, `ops` (the list), `save-all` (save now), `stop` (save and stop the world), `pregen <radius> [chunks/s]`, `pregen resume`, `pregen stop` and `pregen status` (see "Pre-generating the world").
- **Not in u53** ("Unknown command"): `ban`, `pardon`, `whitelist`, `save-on`, `save-off`, `publish`, `debug`. To remove a player, use `kick <player>`.
- **Output:** what the command reports, as a server console gets it. That includes messages only the server gets (e.g. `Set Steve's game mode to Creative Mode`) and output while the game rule `sendCommandFeedback` is off. Below it, in grey: what the command made the server log, such as `[Server] hello` for `say` or the death message for `kill`. Errors are red.
- **Keys:** Tab completes commands and their arguments (player names, game modes, ...). ↑/↓ recall earlier commands, which the browser keeps. Clicking a player under the console adds the name to the command.
- **When commands run:** at the start of the next game tick, on the game's own thread, as on a dedicated server. Game commands need a running world; `op`, `deop` and `ops` work at any time.
- **Log:** each command and its output are in `data/logs/host.log` as `[console]` lines. The game also logs a `[Server: ...]` line for most of them (game rule `logAdminCommands`).
- **From the server shell:** `node cli.js cmd <command ...>` runs the same commands, except `op`, `deop` and `ops`; `node cli.js pregen ...` is the same as the console's `pregen`.

### OP

An OP can use every command in the game. **Only the web page console gives and takes OP.**

- **In the game:** u53 has no `/op` or `/deop`, so no player can give OP, to themselves or anyone else. Tested with the unmodified client: `/op Tester2` → "Unknown command".
- **Other ways are closed:**
  - `node cli.js cmd op ...` is refused.
  - The web page's settings form (`/api/config`) does not write the list.
  - In u53, a player using the integrated server's owner name (default `HeadlessHost`) could use commands whenever the world allowed cheats. The host removes that rule, so the owner name gives nothing. Tested: a client named `HeadlessHost` gets "You do not have permission to use this command".
- **Where the list is kept:** `ops` in `data/config.json` (names, any case). It applies at once, and at every start before players can join. Editing that file takes shell access to the server, which is full control anyway.
- **Allow cheats for every player** still gives every player commands, OP or not. The console warns while it is on.
- **No accounts.** Eaglercraft has no logins, so anyone who joins with an OP's name gets OP. Give OP only while it is needed, and keep join codes private.
- **The web page has no login either.** It listens on 127.0.0.1 only (environment variable `BIND`). Keep it that way and reach it through an SSH tunnel: `ssh -L 8090:127.0.0.1:8090 user@server`, then open http://127.0.0.1:8090/. Anyone who can open the page can run every command and give OP.

**How it works.** As for the Game Rules, the host adds hooks to the game code in memory (`src/game-patches.js`; the file on disk is unchanged):

- *console commands from the host:* commands wait in a queue that the game's tick empties at its start. They run through the game's own command handler. The sender is named "Server" and counts as the server, as a dedicated server's console does.
- *OP list from the host:* replaces the game's check of who may use commands (`canSendCommands`). A player may if "Allow cheats for every player" is on, or if their name is on the OP list.

Each hook is added only when the exact game code it relies on is found. Otherwise the log says `console commands from the host not applied: ...` or `OP list from the host not applied: ...`, and the console says it is not available. With `"gamePatches": false` the game runs as shipped. The console then cannot run game commands, the OP list has no effect, and the owner-name rule applies again.

## Game Rules

On the web page, tick **Game Rules** to open its section. The box next to it takes `1` or `0`:

- `1`: when you click *Save settings*, the changes are set in the running world at once. No restart.
- `0`: the changes are saved and set at the next Start/Restart.

While Game Rules is ticked, the host also sets all the values at every start, before anyone can join.

| Group | Settings |
|---|---|
| Players | PvP, flying allowed, kick idle players after N minutes, `keepInventory`, `naturalRegeneration`, `showDeathMessages`, `reducedDebugInfo`, `playersSleepingPercentage` (0-100, see below) |
| Commands and command blocks | commands for every player (the same setting as *Allow cheats for every player*), command blocks, `sendCommandFeedback`, `logAdminCommands`, `commandBlockOutput` |
| World | `doDaylightCycle`, `doWeatherCycle`, `doFireTick`, `mobGriefing`, `randomTickSpeed` (0-1000) |
| Mobs and drops | `doMobSpawning`, `doMobLoot`, `doTileDrops`, `doEntityDrops` |
| Eaglercraft | `bedSpawnPoint`, `clickToRide`, `clickToSit`, `colorCodes`, `loadSpawnChunks`, `doSignEditing` (stored, but this game version does not use it) |

These are all 22 game rules that u53 has, with its own defaults (a test compares the list with the game code), the server switches of its integrated server, and one rule of later versions that the host adds:

- **`playersSleepingPercentage`** (Minecraft 1.17's rule; default 100): the night is skipped once this share of the players who are not spectators has slept (100 ticks in bed), at least one: `ceil(players x percentage / 100)`, as 1.17 counts. 50 with 4 players online: 2 must sleep; 0: one is enough. Above 100 (only with `/gamerule`) sleeping never skips the night. At 100, or while the world has no such rule, the game's own rule decides, unchanged: everyone must sleep, and a spectator keeps the night from being skipped. Set it here, or with `/gamerule playersSleepingPercentage 50` in the Console (or in the game, by an OP); 1.8.8 stores it in the world like any rule, and a new value counts at once. The correction is `src/game-patches.js` "players sleeping percentage" (`WorldServer.areAllPlayersAsleep`, checked every tick); with regions the host counts the players of every instance the same way. The players get no "x of y players sleeping" message: this game version has none.

- **Where they are kept:** game rules are saved in the world, as with `/gamerule`. PvP, flying, idle kick and command blocks exist only while the world runs, so the host sets them at every start.
- **Starting values:** when nothing is saved yet, the section starts from the game rules stored in the world that is, or was last, hosted. *Values in the world* loads those again and *Game defaults* puts everything to the game's defaults. Both take effect only when you save.
- **Unticking Game Rules** (with `1`): PvP, flying, idle kick and command blocks go back to the game's own values at once. The game rules stay as they are in the world. To undo those, set them back (e.g. *Game defaults*), save, then untick.
- **Command blocks:** this game version always allowed them. Off: command blocks and command block minecarts do not run, and editing one shows the game's "Command blocks are not enabled on this server".
- **How the host sets them:** u53 has no message for this, so the host adds a small hook to the game code in memory (`src/game-patches.js`; the file on disk stays unchanged). A game rule is set the way `/gamerule` sets it, including the update players' clients need for `reducedDebugInfo`. Players get no chat message about it. The hook is added only when the exact code it relies on is found. Otherwise the log says `game rules from the host not applied: ...`, and saving reports that the hook is not available. `"gamePatches": false` turns all corrections off.
- **Not offered, on purpose:**
  - "spawn animals" and "spawn villagers": in this game version, switching them off removes the animals or villagers already in loaded areas, pets included.
  - "max players": u53 does not enforce it. The host's own *Player limit* does (see "Player limit").
  - spawn protection: not used by the integrated server.
  - Difficulty, view distance and the LAN game mode stay in the main settings.
- **Log:** `game rules applied (world start): 3 game rules set (keepInventory, doDaylightCycle, randomTickSpeed); PvP off, flying allowed, idle kick 15 min, command blocks on | not the game default: ...`
- **From the server shell:** edit `gameRules` in `data/config.json`, e.g. `{"enabled": true, "live": 1, "values": {"keepInventory": true, "pvp": false}}`, then run `node cli.js settings apply`. `node cli.js status` shows a `rules:` line.

## Animals that never respawn: the mob caps (`mobCaps`, measured)

Minecraft 1.8.8 spawns a kind of mob (monsters, animals, bats, squid) only while the world has at most `max x chunks / 289` of it loaded, `chunks` being those within 8 of each player (17 x 17 = 289): per player 70 monsters, **10 animals**, 15 bats, 5 squid. Animals are tried every 400 ticks. Every loaded animal that may despawn counts, wherever it is.

**The cause.** This game build (EaglercraftX u53) counts the chunks within the server's *view distance* instead (`SpawnerAnimals.findChunksForSpawning`, TeaVM `Cwt`, reads `ServerConfigurationManager.viewDistance`). At this host's view distance 4 that is 81 chunks: per player **2 animals**, 19 monsters, 4 bats, 1 squid. The animals already loaded round a player are always more than 2 (those made with the chunks, and those in the outer two chunks of the loaded area, where the game does not update entities at all), so animals never spawn again, however many die. Measured with the harness (`test/harness/scenarios/animals.js`, `run.js --extra spawn` counts what the spawner compares): in the normal world, 10 to 18 animals counted against a cap of 2 on every animal tick, nothing spawned in 4,000 ticks, also with every animal killed (those killed in the outer chunks never finish dying, and still count).

**The correction** (game-patches.js "vanilla mob caps", on with `"mobCaps": "vanilla"`, the default): the caps are counted over vanilla's chunks (within 8 of each player; players near each other share chunks as in vanilla). Mobs still spawn only within the view distance (loaded chunks); from a view distance of 8 up, numbers and area are exactly vanilla's. `"mobCaps": "viewDistance"` (Option Manual: Mob caps) brings back the build's own caps; restart the world after changing it.

Measured in a superflat grass world (no animals made with the chunks), view distance 4, 6,000 ticks: as shipped, one group of 4 cows, then nothing; corrected, 4, 10, then 26 animals of four kinds. With the animals within 40 blocks of the player killed: as shipped none come back (4 left, more than 2); corrected, back from 8 to 24. At view distance 8 the corrected and uncorrected games are identical tick by tick.

What stays as in 1.8.8: animals come back only where fewer than 10 per player are loaded, so in an area with many animals left, killing a few brings none back (vanilla does the same); most animals are made with new chunks; breeding works as always. Monsters can now reach vanilla's 70 per player at night instead of 19, which costs some game-thread time with many players.

## Donation message (`donation`, off by default)

The web page's **Donation message** section (below Settings) asks players to support the server: your message, a fundraising goal and the wallet address to send to. It is off until you switch it on and save. The host takes and tracks no payments: there is no donation service, and *Raised so far* is the number you type in.

- **Fields:** the message (1-300 characters); the fundraising goal (0: no goal shown), raised so far, the currency (default `USDT`) and what the goal is for (default "a faster server"); the wallet address (20-100 letters and digits; the default, `TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC`, is the project author's: put your own there to receive donations for your server) and its network (default `TRON (TRC-20)`); the lag threshold and the cooldown (below). Previews of the chat message and of the players' card follow what you type.
- **Save** writes only `donation` in `data/config.json` and applies it to the running world at once; it stays across restarts. A value the host does not accept is refused with the reason, and nothing is written. **Defaults** puts the default values in the fields (Save keeps them).
- **In the in-game chat**, to every player:
  - *when the server lags:* the game thread reports every 5 s how many ticks it ran. When it ran fewer per second than the **lag threshold** (default 15; 20 is full speed) over the last 30 s while players are on, the message goes out, beginning "The server is running slow right now.", and not again by itself within the **cooldown** (default 30 minutes). The log says `donation message sent to the chat: the server lags (12.4 game ticks per second, below 15); again at the earliest in 30 min`; the section shows the ticks per second now.
  - *Send to chat now:* at once, whatever the speed and the cooldown, while the world runs and the saved setting is on. Log: `donation message sent to the chat (by the owner, to 3 players)`.
  - It goes out as the console's commands to `@a` do: with regions, in every instance.
- **The address in the chat** is underlined and clickable. The 1.8 chat has no click action that copies, so the address is a link: a click opens the game's own link screen ("Are you sure you want to open the following website?", with *Yes*, *Copy to Clipboard* and *No*), and **Copy to Clipboard** puts the address on the clipboard: two clicks, which the hover text and a grey line under the message explain. Shift-click puts the address in the chat box. Tested with the unmodified u53 client: the address on the clipboard exactly, and in the chat box after a shift-click.
- **On the players' pages:**
  - *the game client the host serves for players (`/client/`):* a small card in the bottom left corner while the game loads, folded after 20 s into a "♥ Support this server" button that opens it again (× folds it, and it then starts folded for the rest of that browser session). While the server lags it opens by itself for 30 s, at most once per cooldown, with "The server is running slow right now."
  - *`/donate`:* the card as a page of its own.
  - The card: the message, the goal with a progress bar, the network, and the address with a **Copy** button. While the message is off, neither shows anything (`/donate` says "Donations are not open right now.").
  - Both are on the web page's server, which has no login and listens on 127.0.0.1 only (see "OP"): players reach them only where you open that server to them, and they could then open the web page itself too. The chat message reaches every player, wherever they play from.
- **API:** `GET /api/donation` (what the players' pages get; only `{"enabled": false}` while it is off), `GET /api/donation/settings`, `POST /api/donation` (the settings), `POST /api/donation/send` (Send to chat now).
- **From the server shell:** edit `donation` in `data/config.json`, e.g. `{"enabled": true, "goal": 100, "raised": 20, "lagTps": 12, "cooldownMinutes": 60}` (keys left out keep their defaults), then run `node cli.js settings apply`.
- **For tests:** `EAGLAN_DEBUG_DONATION_TPS=8` makes the host take 8 ticks per second as measured, to see the lag message without real lag.

## Relays: one world, many relays

### How it works

Verified from the u53 client and by capturing the real client's relay traffic with Chrome DevTools:

```
host   -> relay   Handshake(type 1, v1, "<world name>;<hidden>")
relay  -> host    Handshake(type 1, v1, <join code>) + ICEServers(STUN/TURN)
client -> relay   Handshake(type 2, v1, <join code>)
relay  -> client  Handshake(type 2, v1, <client id>) + ICEServers;  relay -> host: NewClient(id)
client -> relay   Description("", offer)           relay -> host: Description(id, offer)
host   -> relay   Description(id, answer)          relay -> client
client -> relay   ICECandidate("", batched)        relay -> host;  host's candidates -> client
client -> relay   ClientSuccess("") | ClientFailure("")   (relays enforce this order)
```

After that, the player talks to the host directly over a WebRTC data channel. The relay is only needed to *start* a connection.

**Each relay assigns its own join code, and the host cannot choose it**: the code field in the host's handshake carries the world name. So the world necessarily has one code per relay. The host keeps one registration on every configured relay, and all of them feed the **same** peer table and the **same** integrated server. That means one world, one player list and one authoritative state. Player channels are namespaced per relay (`r2-<client id>`), so ids issued by different relays can never collide.

A player can use any code shown in `status` or the UI. A code only works on its own relay, and the client tries every relay in its list, so give players the code of a relay their client has. Others can be added in the client under *Network Settings*.

**One code for every relay is not possible.** Tested on all 5 working relays (2026-10-17): whatever the host sends in its handshake (`"abcde"`, `"name;1;abcde"`, …), each relay returns its own random code. The protocol has no way to request a code.

**The shared-world list in the game is only for players on the host's own network.** A relay lists a world that isn't hidden only to players with the host's public IP address (the "LAN" in Open to LAN). There, the u53 client shows it under **Multiplayer** as *Shared World — (the world's name)*. Checked on relay.eaglercraft.net on 2026-10-20: a list request from the host's own address got 1 world, the host's test world, while eaglercraft.com showed 5 live worlds on that relay; the relay's `/health` also reports `"public": false`. So players on other networks never see a server's world in that list and need a code. (An earlier check that looked as if the list was public had its clients on the host's own machine.)

**Same relay, two names:** `relay.webmc.xyz` and `relay.webmc.fun` are one backend. A code registered through one is listed and joinable through the other, so with both configured the world appears twice in that relay's list. Keeping one of them is enough.

### When the join code changes

Now and then a relay closes the host's connection. The host registers the world again within seconds, but the relay hands out a **new** code, and the old one stops working.

- **How often:** relay.eaglercraft.net closed the connection of a host on a VPS in Germany 6 times in 12 hours (2026-10-19/20), after 54 min to 5 h 45 min. Each time the log said `lost (connection closed (1006))`: closed by the relay or the network on the way, without a closing message. The host's own keepalive (below) never fired. The host was back within 3–4 s each time, with a new code.
- **The world is not affected.** It is not reset or restarted, and the players in it stay connected. In that log one player played 4 h 54 min through three code changes.
- **The old code cannot be kept.** A relay gives each registration a random code and never gives one back. Tested on relay.eaglercraft.net on 2026-10-20 (it reports itself as `poseidon-relay 0.1.0`): after a clean close, after an abrupt drop, and with the old code added to the world name in the handshake, every new registration got a new code. Only the relay's operators could change this, for example by keeping a host's code for a minute after its connection is lost.
- **eaglercraft.com listings:** the site's shared-worlds list takes worlds on relay.eaglercraft.net only. It checks the code with the relay, and closes a listing a few minutes after its code stops working. *Re-list* (on the site: *My worlds* → *Re-list*) takes the new code and keeps the listing: the site says its title, description, tags and screenshot stay the same. A new listing for each code starts again from nothing.
- **What the host shows:** the log says it once: `join code on relay.eaglercraft.net changed: dlffn -> gvl7m (the connection to the relay was lost; a relay never gives an old code back). The world and the players in it are not affected. A listing on eaglercraft.com closes …`. The web page shows the new code with the time and a note with a *Copy code and open My worlds* button. `node cli.js status` shows `codes: gvl7m (relay.eaglercraft.net, since 21:02, replaced dlffn, which no longer works)`.
- **Many registrations in a short time are refused:** after 6 test registrations from one address within about a quarter of an hour, relay.eaglercraft.net closed the next ones during the handshake (`closed during handshaking (1005)`) or let them time out. A host that is restarted again and again can run into this. Its own retries are spread out (see "Per-relay states and recovery").

### Configuration

`data/relays.txt` holds one `wss://` URL per line; `#` starts a comment. Invalid lines, non-WebSocket URLs, URLs with credentials and duplicates (case, default port, trailing slash) are ignored with a warning, and at most 16 relays are used. Edit the file and run `node cli.js relays apply`, or use the UI's Settings. The new list is applied to the running world **without a restart**. Unchanged relays keep their registration and code, and connected players are never affected. The default list is:

```
wss://relay.eaglercraft.net/
wss://relay.lax1dude.net/
wss://relay.shhnowisnottheti.me/
wss://relay.deev.is/
wss://relay.mcjs.link/
wss://relay.webmc.xyz/
wss://relay.neurosama.place/
wss://relay.webmc.fun/
```

### Per-relay states and recovery

Each relay is managed independently (`src/relay.js`, `RelayLink`):

| State | Meaning |
|---|---|
| `connecting` | TCP/TLS/WebSocket upgrade (8 s timeout) |
| `handshaking` | waiting for the join code (8 s) and ICE list (5 s) |
| `active` | registered, has a join code, accepting players |
| `backoff` | failed (network error, HTTP 5xx, timeout, dropped connection); retried with exponential backoff and jitter: 2.5–5 s, then doubling, capped at 2.5–5 min; HTTP 429 waits ≥ 60 s |
| `incompatible` | relay refused or doesn't speak relay protocol v1 (HTTP 4xx, `PROTOCOL_VERSION` error, text/garbage, wrong version, unexpected packet); re-checked every 30 min, never hammered |
| `stopped` | removed from the list or host shutting down |

Guarantees:

- **Isolation:** a failing relay never affects the others.
- **One registration per relay:** each relay has at most one socket and one registration at a time. A stale socket's events are ignored, so a reconnect can't create a duplicate registration.
- **Players stay connected:** a relay that drops after startup re-registers automatically (with a **new** code, see "When the join code changes"). Players connected through it stay connected, because they no longer need the relay; only half-finished joins on that relay are cancelled.
- **Dead connections are detected:** the host sends a WebSocket ping every 30 s. A connection with no pong for 75 s is treated as dead. Relays that never answer pings are not penalised for it.
- **Clean shutdown:** shutdown first closes every relay socket and cancels every pending retry, so nothing reconnects while the world is being saved.
- **Bounded resources:** at most 16 relays, one socket and one timer each, and at most 32 joins in progress.
- **Quiet logs:** state changes are logged once ("World reachable via 5/8 relays: …"). Repeated identical errors are logged only on the 1st–3rd and every 10th occurrence.

### Relay compatibility (tested 2026-10-17 from this host's network)

Tested with `node cli.js relays probe`. Each relay got a hidden test registration, a join by code through that relay, and data sent both ways over the WebRTC channel:

| Relay | Result | ICE servers |
|---|---|---|
| relay.eaglercraft.net | ✅ compatible | 3 (STUN + TURN udp/tcp) |
| relay.lax1dude.net | ✅ compatible | 17 (STUN + TURN/TURNS) |
| relay.shhnowisnottheti.me | ✅ compatible | 5 (STUN only) |
| relay.webmc.xyz | ✅ compatible | 13 (incl. TURN; also hands out a broken `stun:undefined` entry, which the host skips) |
| relay.webmc.fun | ✅ compatible | 13 (incl. TURN) |
| relay.deev.is | ❌ unavailable: HTTP 502 (Cloudflare, origin down) | – |
| relay.neurosama.place | ❌ unavailable: HTTP 530 / Cloudflare error 1033 (tunnel down) | – |
| relay.mcjs.link | ❌ refused: HTTP 403. A real Chrome WebSocket from this network is refused too, so it's a block on the relay side | – |

The failing relays are kept in the list and retried automatically. If they come back, the world registers on them without a restart.

**Real end-to-end multiplayer test, verified:** three unmodified u53 clients were each restricted to a *different* relay (relay.eaglercraft.net, relay.shhnowisnottheti.me, relay.webmc.xyz). Each joined with that relay's code, in 4.7–5.2 s. All three were in the same world and saw each other's joins and chat. relay.lax1dude.net and relay.webmc.fun were verified at the protocol level (probe) and by earlier real-client joins (lax1dude). All test clients ran on the host's own machine, so joins from other networks through TURN are not verified.

### Reading player sessions in the log

When a player leaves, the host writes one line, for example:

```
[LAN] Tester1 (r1-0WGD…) left after 42s: the player's connection went silent 20s before it closed (their network dropped,
      or their tab/browser was closed, crashed or frozen) | last data from player 19.6s before | received 5 KB, sent 112 KB
      | path direct/direct (via NAT) IPv4 | rtt 213 ms median (min 205, max 260) | via relay.eaglercraft.net
```

`rtt` is the network round-trip time to that player during the session, sampled every 5 s from the WebRTC connection (the SCTP smoothed RTT; it can include up to ~20 ms of acknowledgement delay). `IPv4`/`IPv6` is the address family of the connection. `node cli.js status` and the web page show the same value live for each connected player.

| Cause shown | Meaning |
|---|---|
| `the player left (their client closed the connection)` | normal leave: quit, disconnect, closed tab |
| `the player's connection went silent Ns before it closed (...)` | the player's side vanished. Measured with the real client: a killed browser is only noticed ~20 s after its last packet |
| `the connection to the player was lost / failed (network: ICE ...)` | the network path broke |
| `the server ended the session (reason)` | kick, login timeout (`Took too long to log in`), etc. With `received 0 B` from a 1.8 client, this was the lost-login-packet bug fixed on 2026-10-17 (see below) |
| `sending to the player failed` / `... already closed` | host-side send problem (none seen in real logs so far) |

`lost connection: End of stream` from the game server is what the u53 integrated server prints for **every** LAN player whose connection closes, whatever the cause. The browser host does the same. The session line above says what actually happened.

If a player's client is a different game version (the relays are shared by Eaglercraft 1.8, 1.12.2, 26.2, …), the server logs `fragment of unknown type: N` and kicks them after 30 s with `Took too long to log in`. The host now adds a line naming that player and saying they need EaglercraftX 1.8.8.

A join that never gets in gets one line too: why it ended, how far the connection got, and the *kinds* of network addresses each side offered (no addresses are logged):

```
[LAN] r1-JO4H… did not get in after 15s: the relay ended the join: Took too long to connect! | connection reached 'connecting'
      | player's candidates: 2 host, 2 hidden; 1 srflx | ours: 1 host; 1 srflx; 2 relay | via relay.eaglercraft.net
```

| Part | What it tells you |
|---|---|
| `the relay ended the join: Took too long to connect!` | relay.eaglercraft.net gives a join 15 s. Other causes: `the player's client gave up: it found no working network path`, `the join timed out` |
| `connection reached 'connecting'` | the two sides tried addresses but none worked (`never started`: the player's offer never arrived) |
| `host`, `hidden` | addresses on the device itself (browsers hide them behind `.local` names) |
| `srflx` | the public address a STUN server saw. Without one on the player's side, their network blocks STUN/UDP |
| `relay` | a TURN server address: the fallback when no direct path works. With none on either side, players behind strict NAT or UDP-blocking networks cannot connect |

### Join reliability changes (evidence-based)

- **Handshake timeout 13 s → 30 s.** The browser host gives up after 13 s. Measured: the real client sends `ClientFailure` 10 s after receiving the host's candidates (~15 s after `NewClient`). In real play on 2026-10-15, successful joins took 4.8–11.4 s, while 10 of 28 attempts were cut off at 13 s (one had already connected). The client's own failure report now ends a failed join.
- **Candidate format.** ICE candidates are sent as `candidate:…`, as browsers do; libdatachannel emits `a=candidate:…`.
- **Late candidates.** Local candidates gathered after the single ICE message (slow TURN allocations) are ignored instead of aborting the join.
- **Early data channel.** If the data channel opens before the client's trickled candidates arrive, the event is deferred instead of being fatal. The browser host drops the peer in that case. Relay messages are unchanged.
- **Lost login packet (fixed 2026-10-17).** About 1 join in 30 in real-client tests ended after 30 s with *Took too long to log in* and `received 0 B`. The cause:
  - The u53 client sends its login packet the moment the host's ICE candidates reach it.
  - The host attached its message listener only when it handed the data channel to its state machine, up to ~10 ms after sending those candidates.
  - The WebRTC library silently drops messages that arrive while no listener is attached.

  The listener is now attached as soon as the channel exists, and messages that arrive early are held and delivered in order. Measured:
  - A connection test that sends the first message at exactly that moment: before, 20 of 50 first messages were lost; after, 0 of 50 (`test/multi-relay.test.js`).
  - Unmodified u53 clients joining one after another: before, 29 of 30 through a local relay; after, 40 of 40 through a local relay and 10 of 10 through relay.eaglercraft.net.
  - The window is wider when the relay is close to both sides. Over the internet the relay round trip usually outlasts it, so real players hit this less often than local tests.

## How World LAN works (u53 source)

| Piece | Where it runs in the browser | Needs GPU/DOM? |
|---|---|---|
| Integrated server (MinecraftServer + world IO) | **Web Worker**: `classes.js` started with `main(["_worker_process_"])` | No |
| World storage | IndexedDB `_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_worlds`, store `filesystem` | No |
| LAN host control (`LANServerController`, `LANClientPeer`) | Page main thread | No |
| Signaling | WebSocket to a relay (see above) | No |
| Player transport | WebRTC data channel; raw messages are the IPC packets of the player's channel | No |
| Rendering, input, GUI | Main thread (WebGL) | Yes, but only needed for *playing* |

So a World LAN host is "integrated-server worker + relay sockets + WebRTC peers + IPC glue". None of that renders anything.

## What this project does

- **Reused:** `classes.js` (u53), the file unchanged. Its integrated-server worker runs inside a Node `worker_thread`, exactly as the browser starts it (`src/worker-runtime.js`). A few small corrections are applied in memory when it loads (`src/game-patches.js`): the LAN game mode on join (see "LAN game mode and cheats"), the command block switch and the Game Rules hook (see "Game Rules"), the console and the OP list (see "Console and OP"), tick times and world pre-generation (see "Lag with many players"), the multi-core hooks (see "Multi-core mode"), the terrain threads' hook (see "Terrain threads for pre-generation") and the speedups (see "Speedups on the game thread"); `"gamePatches": false` runs it exactly as shipped.
- **Ported to Node:**
  - `src/lan-host.js`: `LANServerController`, `LANClientPeer` and `PlatformWebRTC.LANServer`/`LANPeer`, extended to several relays
  - `src/relay.js`: relay codec, config validation, per-relay connection manager
  - `src/ipc.js`: worker IPC codec
  - `src/idb-sqlite.js`: the IndexedDB calls the worker uses, backed by SQLite (WAL, `synchronous=FULL`)
- **Diagnostics:** `src/relay-client.js` is a protocol-level stand-in for a joining client, and `src/relay-probe.js` implements the relay probe.
- **Daemon** (`src/daemon.js`): runs detached. It sends the client's IPC sequence (`InitWorld` → `StartServer` → `ConfigureLAN`), registers on all relays in parallel, and opens one player channel per joining peer. On Stop, it closes all relays and then sends `StopServer`, which saves players and chunks.
- **UI** (`src/ui-server.js`, `public/index.html`): optional and stateless. It controls the daemon over a localhost port and serves the vendored client at `/client/`.

### Safety of world data

- The host never sends the native `ListWorlds` IPC, because that call deletes worlds whose `level.dat` is missing. Worlds are listed read-only.
- New worlds and imports always get a fresh folder (`Name`, `Name-`, …). Restart reloads the world and never re-creates it.
- Nothing in the host deletes worlds.
- The game autosaves every 45 s, and Stop does a full save. A hard kill loses at most the time since the last save.
- With the multi-core mode on, a saved chunk file is committed a few milliseconds after the game wrote it, once it is compressed. Reads of it, *Save now* and Stop wait for it, and a file is never stored uncompressed (see "Multi-core mode").
- Terrain threads (opt-in) never write anything: the game uses their terrain for chunks it generates and saves them itself, as always (see "Terrain threads for pre-generation").
- Relay failures cannot touch the world. Relays only carry signaling; the world lives in the one integrated server.

## Network notes

- Players connect peer-to-peer over WebRTC (DTLS/SCTP over UDP). NAT is handled with each relay's STUN/TURN servers; a player uses the ICE servers of the relay they joined through. The host needs outbound UDP (or TCP/443 for TURN over TLS). No inbound ports are needed, except the UDP port of "send twice" when one is set (see "Send small packets twice").
- As in the normal game, peers can see the host's IP address and the host can see theirs.
- The host's "owner" name (default `HeadlessHost`) is the integrated server's owner. A player using it keeps their own game mode instead of the LAN game mode. It gives no commands (see "Console and OP"). Don't let players use that name.
- A world that isn't hidden is listed in each relay's shared-world list, which a relay shows only to players on the host's own network (the same public IP address; see "Relays").

## Network performance (players far from the server)

Investigated and measured on 2026-10-17, for players far from a VPS in Germany, such as players in China. In short:
- **The route between the player and the server decides the latency.** No host or Linux setting tested here shortens it.
- **The biggest lever is which network (provider) the server is on.** It can be measured before moving.

### What the server can and cannot influence

- **Game traffic is UDP.** Each player's game traffic is one WebRTC data channel, created by the client (`createDataChannel("lan")`, ordered and reliable). It is carried as SCTP over DTLS over UDP.
- **The WebRTC libraries handle it, not the Linux TCP stack.** Congestion control and retransmissions run in usrsctp (inside libdatachannel) on the host and in Chrome's own stack on the player's side.
- **Linux TCP tuning (BBR, `tcp_*` sysctls, …) has no effect on gameplay.** It only affects the relay WebSocket connections used for joining.
- **Packet loss costs more than distance.** Because the channel is ordered and reliable, one lost packet holds back every later message until it is retransmitted (at least one round trip). After losses, SCTP congestion control also slows the sending, so on a lossy 200 ms route messages to the player can queue for seconds right after a join.
- **The host exposes six SCTP settings.** All of them were measured in the lab below; none is worth changing.

### Real routes (Globalping probes, ICMP ping, 16 pings per probe)

China → Germany at 17:30 China time. Average RTT per probe, grouped by the probe's network:

| Probes in China | Vultr Frankfurt | Hetzner Falkenstein | Hetzner Nuremberg | Linode Frankfurt | Leaseweb Frankfurt | Vultr Tokyo |
|---|---|---|---|---|---|---|
| China Telecom (4) | 162–215 ms | 175–208 ms | 171–213 ms | 257–281 ms | 211–231 ms | 118–181 ms |
| China Unicom (5) | 156–215 ms | 148–216 ms | 210–252 ms | 193–236 ms | 283–327 ms | 90–116 ms |
| China Mobile (4) | 326–370 ms | 137–238 ms | 135–255 ms | 212–234 ms | 201–337 ms | 154–245 ms |
| Cloud (Tencent) (2) | 160–200 ms | 169–196 ms | 149–209 ms | 251–258 ms | 201–227 ms | 112–135 ms |
| **All: median RTT / mean ping loss** | **209 ms** / 5.8 % | **196 ms** / 6.7 % | **212 ms** / 8.8 % | **235 ms** / 6.7 % | **263 ms** / 8.3 % | **133 ms** / 13.3 % |

- **The same city can differ by more than 100 ms.** It depends on which networks the provider connects to China through. For example, China Mobile probes measured 326–370 ms to Vultr Frankfurt but 137–238 ms to Hetzner.
- **At the evening peak, delay holds steady but loss rises.** At 20:30 China time, with the same probes, the medians barely moved (191–246 ms), but ping loss rose from 6–8 % to 11–12.5 % for every German target. China's international links are busiest 20:00–23:00 China time, and that is when players notice lag.
- **IPv6 from China was slower than IPv4** for 7 of 8 probes to Hetzner. The median difference was +26 ms off-peak and +7 ms at the peak, and IPv6 lost more pings (15.6 % vs 5.5 % at the peak).
- **Budget Hong Kong servers lost 31–39 % of pings on average from mainland China** (two providers tested, up to 81 % on single probes), far worse than any German target.

Where the server is. Average RTT from home-internet probes, ranges over probes:

| Players in | Germany (Hetzner) | Singapore | Tokyo | Mumbai |
|---|---|---|---|---|
| Europe/Turkey (5) | 5–42 ms | 166–198 ms | 224–274 ms | – |
| Pakistan (5) | 123–147 ms | 81–177 ms | 198–377 ms | 136–271 ms |
| India (6) | 141–208 ms | 72–109 ms | 104–164 ms | 14–50 ms |
| China (15), median | 196 ms | 256 ms | 133 ms | – |

No location is better for everyone. Tokyo would save Chinese players ~60 ms but add ~200 ms for Europe and up to ~230 ms for Pakistan.

### Host settings tested in a network lab

`test/netlab/` replays a real game session between a real Chrome WebRTC client and the host's WebRTC stack, through an emulated network link, and measures the one-way delay of every game message.
- **The session** (`test/netlab/trace-u53.json`) was recorded from the unmodified u53 client: join, chat, walk, mine, idle. It is mostly 9-byte messages, about 150 per second to the player and 20 per second from the player, plus 20–43 KB chunk messages at join.
- **The emulated links** use the measured China ↔ Germany values:
  - typical: 200 ms RTT, 1 % loss
  - lossy: 210 ms, 5 % loss in bursts
  - China Mobile-like: 340 ms, 2 % loss
  - plus a clean local link, to catch regressions
- **Each variant was compared with the defaults on the same random loss pattern** (paired runs, 60 s each). The send window had 7 repeats per link and the other settings 3; the buffer settings were run on the lossy link only.

Change in the average delay to the player over the first minute, including the join. Lower is better:

| Host SCTP setting (libdatachannel default) | Typical | Lossy | China Mobile-like | Local |
|---|---|---|---|---|
| Initial congestion window 32 (10) | +0 ms | −18 ms | +22 ms | no change |
| Immediate ACKs, `delayedSackTime` 0 (20 ms) | +19 ms | −63 ms | **+463 ms** | no change |
| H-TCP congestion control (RFC 4960) | **+63 ms** | **+366 ms** | **+464 ms** | no change |
| RTCC congestion control (RFC 4960) | +1 ms | +84 ms | −11 ms | no change |
| Send/receive buffers 4 MiB (1 MiB) | – | +1 ms | – | – |
| Send/receive buffers 256 KiB (1 MiB) | – | +155 ms | – | – |
| Max queued chunks 100 000 (10 000) | – | −36 ms | – | – |

None is a consistent improvement, and H-TCP and immediate ACKs make things worse. **The defaults stay.**
- **The larger send window** helped in only 2–3 of 7 repeats per link.
- **Join outcomes vary a lot from run to run on the lossy link** (95 % intervals of several hundred ms), so only large, consistent changes count there.

**The only host-side technique that measurably helped: sending small packets to the player twice.** It was measured in steady gameplay after the join (4 paired repeats per link; average / slowest 1 %):

| Variant (extra data to the player) | Typical | Lossy | China Mobile-like | Local |
|---|---|---|---|---|
| **Copy of each small datagram (≤ 400 B) sent 10 ms later** (+70 %: ~11 → ~19 KB/s per player) | **140 → 107 ms** / 405 → 180 ms | **228 → 129 ms** / 614 → 350 ms | **334 → 201 ms** / 806 → 419 ms | no change |
| Back-to-back copy of every datagram (+100 %) | 140 → 122 ms / 405 → 318 ms | 228 → 199 ms / 614 → 553 ms | 334 → 256 ms / 806 → 603 ms | +3 ms (slowest 1 %) |

The spaced copy was better in 4 of 4 paired runs on every China link, and every one of those differences is outside run-to-run noise (95 % intervals). Messages *from* the player are unchanged; the host cannot duplicate them.

- **It hides lost packets.** The player's browser discards the second copy, so nothing changes for the client. This was verified with Chrome in the lab: no message lost or delivered twice in any run.
- **Joins are not faster.** Join lag comes from the chunk burst and its congestion-control slowdown.
- **It is now built in as an opt-in setting**, off by default: see "Send small packets twice" below.

### Send small packets twice (opt-in)

For players on lossy routes, for example China at the evening peak. **Off by default**; nothing changes unless it is switched on.

- **Switch on or off:** the web page checkbox *Send small packets twice*, or `node cli.js redundant on` / `off`, or `"redundantSend": true` in `data/config.json`. A running host applies it to players who join afterwards; connected players keep their connection. No restart is needed, and switching it off is the complete revert.
- **Cost:** about 70 % more upload per player (about 11 → 19 KB/s in the recorded session). Nothing changes for the client, and no player is excluded.
- **UDP port:** players send to one extra UDP port on the server.
  - **Automatic (default, field left empty):** the system picks a free port for each player. This works only when the server's public IP is on its network interface, as on a normal VPS, and no firewall blocks the port.
  - **Fixed port:** ticking the checkbox shows the field *UDP port for "send twice"*. Alternatively run `node cli.js redundant port 27015` (`auto` for automatic), or set `"redundantPort": 27015` in `data/config.json`. The port must be 1024-65535. Every player then uses that one port, and players who join afterwards get the new port without a restart.
  - **Firewall:** allow incoming UDP on the port, e.g. `sudo ufw allow 27015/udp`, and in the provider's firewall if it has one.
  - **Behind NAT** (only private addresses on the server's network interfaces): forward UDP on the port, same number, to this server. The host then offers the public address that STUN reported for this server, with that port. STUN comes from the relays' ICE servers. Without a fixed port, send twice is not used behind NAT.
  - **Errors in the log:** a port that another program uses is reported as `UDP port 27015 cannot be opened (another program is using it)`. If three joins in a row get nothing through, the log says `send twice: no player reached UDP port 27015 (3 joins in a row): allow incoming UDP on that port …`. The join line of such a player says `send twice not used: nothing from this player reached UDP port 27015`. In every case those players connect as before.
  - **Sharing:** players on one port are told apart by the address they send from. A new address is accepted only with an ICE connectivity check signed with that player's ICE password from the session description. Anything else sent to the port is dropped.
- **When it cannot be used:** without a public address (automatic port), or in a Docker container with bridge networking, players connect exactly as before. The shipped compose.yaml uses host networking, so it works there. The log says so once (`send twice is on, but it cannot be used on this server: this server is behind NAT …`), and `status` and the web page show it.
- **How to tell from the log:** a player path starting with `direct (via NAT)` (e.g. `path direct (via NAT)/direct (via NAT)`) means the server's side of the connection is behind NAT.
- **How it works** (`src/redundant.js`):
  - Each joining player is offered one extra connection candidate: the server's own IP with the relay's port, belonging to a small UDP relay in front of the WebRTC library. Behind NAT, with a fixed port, it is the public address instead. The library's own candidate is still offered as a fallback.
  - The relay forwards everything once, and sends small game-data packets (≤ 400 bytes, DTLS application data) a second time 10 ms later. The browser discards a copy whose original arrived.
  - The relay corrects and re-signs the ICE connectivity checks. Without this, Chrome moved to the direct path within a second, measured with the real client. A check or reply that the player did not sign with its ICE password is dropped instead of signed again.
  - If the relay port cannot be reached (e.g. a firewall), the player connects on the library's port as before; tested.
- **How to see it:** `node cli.js status` shows `send twice: on (UDP port 27015)` or `on (automatic port)`, and *small packets sent twice* for each player using it. The player's leave line shows `path direct (send-twice relay)` and `small packets sent twice (+N KB)`, or `send twice not used for this connection`.
- **Verified:**
  - **Automated tests:** unit tests (`test/redundant.test.js`) and connection tests with mock relays (on, off, live switch, unreachable relay port).
  - **Fixed port, automated:**
    - Two players share the port, and each reaches only its own connection.
    - Data and unsigned checks from unknown addresses are dropped.
    - The port closes after the last player leaves.
    - A port already in use is reported.
    - The NAT case: the public address offered with the port, and the forwarded datagrams arriving on the server's own address.
    - Two WebRTC players through one port, each message once.
    - An unreachable port is reported after three joins.
    - The live port change in the daemon.
  - **Fixed port, real client:** two unmodified u53 clients played at the same time through UDP port 27015, in 2 runs. The browsers selected the relay port, small packets were sent twice (e.g. 4,002 and 271 copies), and `status` showed `send twice: on (UDP port 27015)`.
  - **Real-client runs:** the unmodified u53 client joined and played with it on, through a mock relay and through relay.eaglercraft.net; the relay carried the server's traffic for the whole session (e.g. 1,778 copies, +122 KB in 49 s).
  - **The lab with the real module:** real Chrome against the host stack with this module, recorded game traffic, emulated links, paired runs:

    | Link | Average delay to the player (steady play) | Slowest 1 % |
    |---|---|---|
    | Typical China (200 ms, 1 % loss), 12 runs | 135 → 108 ms, better in 12/12 | 355 → 170 ms, better in 11/12 |
    | Lossy (5 % loss), 4 runs | 234 → 130 ms, 4/4 | 606 → 365 ms, 4/4 |
    | China Mobile-like (340 ms), 4 runs | 327 → 203 ms, 4/4 | 777 → 478 ms, 4/4 |
    | Clean local link, 4 runs | +0 ms | +1 ms (up to ~8 ms during the join's chunk burst: the extra hop) |

    Joins are not faster or slower within the noise: over 12 typical-link runs, chunk delivery at join changed by a median of +23 ms and was faster in 5 of 12. Joins vary from 0.5 to 3 s between runs, with or without it. The relay carried the traffic to the end of every run, with no message lost.
- **Not verified:**
  - Running on a Linux server.
  - Players on other networks: all test clients ran on the host's own machine.
  - The firewall pinhole: the relay sends a zero-length UDP packet to each player address, like the library's own connectivity checks, so a stateful firewall lets the replies in.
  - A real NAT router with port forwarding. The NAT case was tested by sending to the port on this machine's own address, which is where a forwarded datagram arrives.

### Game server stalls ("Can't keep up!")

`Can't keep up! … Running 2500ms behind` means the game server's thread was held up that long. Every player sees it as a freeze or rubber-banding (`moved wrongly!`). That thread runs the game logic and also saves the world, so a few seconds after each such line the host now explains it:

```
[host] game server fell 2.2s behind. In the 5s around it: disk writes 552 (blocked 303 ms, slowest 24 ms),
       garbage collection 79 ms (longest 6 ms), thread busy up to 84%, longest tick 1139 ms, heap 242 of 2240 MB.
       Likely cause: CPU: the game server thread was busy (more players, mobs or loaded chunks than this CPU
       keeps up with, or a shared/throttled VPS CPU)
```

(From the load test in "Lag with many players": 12 players, an autosave in that tick.)

"In the 10s around it" is the real time covered by the game thread's reports that overlap the stall. A report normally covers 5 s; the one sent after the thread was stuck covers the whole freeze. Until 2026-10-19 each report was counted as 5 s, so a 20 s freeze read "In the 5s around it: … garbage collection 8081 ms" (`test/game-stats.test.js` checks both).

| Likely cause | What to do |
|---|---|
| `saving world data … this disk is slow to sync` | set `"diskSync": "normal"` (below), or use a VPS with faster storage |
| `garbage collection` | the game server uses a lot of memory: lower `viewDistance`, or more RAM / a larger `maxHeapMb`; or try `youngGenerationMb` (see "Young generation of the game thread") |
| `CPU: the game server thread was busy` | more players, mobs or loaded chunks than this CPU keeps up with: a faster CPU (the game server uses one core), a lower `viewDistance`, fewer players |
| `the whole process was probably paused` | the VPS itself paused the process (CPU steal on a shared host, swapping); check `top` (`st` column) and `free -m` |
| `while starting up` | normal once after a start, while the world loads |

`node cli.js status` and the web page show the same numbers for the last minute (`game:` line), with the game's tick times, e.g. `ticks 1185 (median 8.5 ms, 95% 255.1 ms, longest 1426 ms, 193 over 50 ms)` (the load test of "Lag with many players", while players joined). A tick may take 50 ms; the server falls behind by whatever ticks take beyond that.

**`diskSync` (opt-in):** each world write is committed with a disk sync before the game continues, and the game saves chunks one at a time (measured: never more than 1 write waiting). On a disk that takes, say, 15 ms per sync, an autosave of 100–200 chunks holds the game for 1.5–3 s. (That is the game's own autosave; the host now spreads it over ticks, see "Autosave spread over ticks", and what still waits on the disk are the chunks unloaded together as players move.) With `"diskSync": "normal"` in `data/config.json` (applied at the next start), writes go to SQLite's write-ahead log without a sync each:
- **Measured on this build machine's fast SSD:**
  - 300 one-at-a-time chunk writes: 140 ms → 36 ms in total.
  - Real-client play: the game thread was blocked 25–32 ms per minute instead of 180–380 ms.
  - With writes made artificially slow (40 ms each, like a slow VPS disk), `"full"` produced the 2.5–3 s stalls about every 48 s, as in real logs.
- **The trade-off:** the database cannot be corrupted, and nothing is lost if the host process crashes or is killed. After a power loss or kernel crash, though, the last writes (up to a few minutes of world changes) can roll back.
- **Default:** `"full"`, unchanged. Use `"normal"` only if the stall lines blame the disk. Set it back to `"full"` to undo.

### Recommendations (measured)

1. **Keep the host's network settings as they are.** No SCTP setting improved latency consistently; two made it clearly worse.
2. **Don't tune Linux TCP (BBR etc.) for the game.** It has no effect on the UDP game traffic. Change Linux network settings only if `netcheck local` finds drops on your server; it prints the exact command and its revert.
3. **For players in China, check your provider's route first.** Run `node tools/netcheck.js paths --from CN,IN,PK,DE` and compare with the tables above. If China Mobile or Unicom probes are far above the best provider's numbers, a German provider with better China routes can save those players 50–150 ms without changing anything for Europe. Test a candidate server with `paths --target <its IP>` before moving.
4. **Stay in Germany for a mixed Europe / Pakistan / India / China player base.** Moving to Asia trades large losses for European players against smaller gains elsewhere.
5. **If the server has IPv6, measure both** with `paths --family both`. Don't disable IPv6 without that measurement: a player who only has IPv6 would lose the direct path.
6. **Use the per-player RTT to see who is affected and to compare before and after a change.** It is shown in `status`, on the web page and in every leave line.
7. **If players on lossy routes complain about lag and your upload allows ~70 % more per player, switch on *send small packets twice*.** It cut the delay of steady gameplay to the player by about 20–45 % on the emulated China links, and changed it by about 1 ms on a clean link. Switch it off again with one command.

### Measuring your own server

- **Live view:** `node cli.js status` shows each connected player's round-trip time and IPv4/IPv6, and the host's own event-loop delay. An idle Linux server reads about 0 ms (Windows about 6 ms, its timer resolution); a lasting value above ~20 ms adds to every player's latency. Each player's leave line in the log has their RTT for the session.
- **Server health:** `node tools/netcheck.js local --seconds 60`, run with players online, checks the server itself, read-only:
  - UDP socket-buffer drops
  - network-interface drops
  - outgoing-queue drops
  - the host's event-loop delay

  It suggests a fix, with its revert, only for a problem it actually finds. It changes nothing itself.
- **Routes to your server:** `node tools/netcheck.js paths` measures ping, jitter and loss to your server from real home-internet probes. By default these are in China, India, Pakistan and Germany. It uses the public measurement network Globalping: free, no account, about 250 probe-tests per hour. Options:
  - `--from CN,IN,PK,DE` and `--per 4` choose countries and probes per country
  - `--family both` measures IPv4 and IPv6
  - `--target <ip>` is needed if the public address is not on an interface

  Results are saved under `data/netcheck/`.
- **Before and after:** `node tools/netcheck.js paths --probes <saved file>` measures again with the same probes. `node tools/netcheck.js compare before.json after.json` shows the change per probe.
- **The lab:** `npm run test:netlab` reruns the lab, and `node test/netlab/bench.js --scenario cn-lossy --config default --runs 3` runs single cases. It needs chrome-headless-shell; it is test tooling, not needed on the server.

### Limits of these measurements

- **Ping is not game traffic.** The probes measure ICMP ping, not the game's UDP. Some routers rate-limit ping, so the loss figures are indicative; 16 pings per probe resolve loss in 6.25 % steps.
- **Routes change.** They vary with the time of day and over weeks. The tables are a snapshot of one day: measure your own server.
- **The lab ran on Windows**, where timers are coarser than on Linux. Both sides of every comparison ran under the same conditions; absolute values on Linux can differ slightly.
- **Nothing here was run on Linux.** The Linux checks in `netcheck local` read standard `/proc` counters and `tc` output and change nothing.

## Lag with many players (measured)

Measured on 2026-10-19 and 2026-10-20 on the build machine (Windows 10, Node 24.19) with the load test `test/bench/load.js`:

- **Players:** 12 protocol-level players (`test/bench/bot.js`). Each joins through a relay over WebRTC like the u53 client, logs in, answers keep-alives and sends its position every tick. Like the client, it never moves into terrain it has not received yet, so a lagging server slows travellers down instead of letting them run ahead.
- **What they do:** 9 fly round small circles near spawn at walking speed (4.3 blocks/s). 3 "explorers" fly round a 400-block circle at 8 blocks/s (a boat), each always reaching terrain nobody has been to.
- **Settings:** the defaults (view distance 4, `diskSync` "full"), a new world with seed 12345.
- **What is measured:** 115-120 s, once everyone is in. Tick times are the game's own tick timer. A tick may take 50 ms; whatever ticks take beyond that, the server falls behind ("behind" below), and a "Can't keep up!" line appears when it is more than 2 s behind (at most every 15 s). "Joins and teleports" is the minute before, while the players join and are moved to where their paths start.
- **Comparisons** are between runs made alternately in the same hour. This machine's results drifted by up to 20% over the night (the same fresh-terrain run: 35-39 s behind before midnight, 29-31 s after).

On this machine this load gives a "Can't keep up!" line every one to two minutes in fresh terrain, explained as CPU, and ticks of over a second.

### Pre-generating the world

When a player first comes near a chunk, the game generates it on its only thread, in that tick: the terrain, then trees, ores and structures once its neighbours exist, then its first lighting once the player is close. A player travelling into new terrain (or the first player of a new world) makes the server do this for dozens of chunks in one tick. `pregen` does that work ahead of time.

- **Start:** on the web page, *Pre-generate* (next to *Save now*): radius in blocks and speed in chunks per second, then *Start*. Or in its console `pregen 1000` (every chunk within 1000 blocks of the world spawn), optionally with the speed: `pregen 1000 10`. From the shell: `node cli.js pregen 1000`. Radius 16-4000 blocks, speed 0.5-50 chunks/s (default 4; above 20 only while nobody is on the server, see below). The chunk count it shows includes two rings of chunks beyond the radius, which the chunks at the radius need. It never starts by itself.
- **While it runs:** it loads chunks through the game's own chunk loading, at most the rate, and none while the server is behind (a tick more than 50 ms late).
  - With players on the server it loads at most one chunk per tick: players come first.
  - With nobody on it, as many per tick as fit before the tick is late (at most 16), so the game thread works on the job all the time instead of waiting for its next tick. A tick that is late loads none, so the server keeps its 20 ticks per second. Once a player is in the world, the next tick is back to one chunk. `"pregenFastWhenEmpty": false` in `data/config.json` keeps one chunk per tick then too, as before (for jobs started after the next world start).

  Each chunk then gets the game's own lighting step, the one its tick runs when a player stays near (`Chunk.func_150809_p`): once its eight neighbours exist, its first lighting; once theirs is done too, again, which marks it light populated (what the game saves as `LightPopulated`). Once every chunk within three of it exists, it is saved and unloaded through the game's own unloading. So trees and structures that cross chunk borders are complete, the light across chunk borders too, and about three rings of chunks are loaded at a time (at 4000 blocks, the largest radius, about 6,000 chunks). Chunks the game had loaded already get the same; those a player sees stay loaded, as the game wants them.
- **Progress:** `pregen status`, the `pregen:` line of `node cli.js status`, the web page, and the log once a minute. While it runs the button reads *Stop pre-generation*; that, or `pregen stop`, stops it, and what it has loaded is saved and unloaded over the next seconds.
- **Restarts:** an unfinished job is kept in `data/pregen.json`. When the world starts again it waits: the log says so, the web page shows *Unfinished pre-generation* and the button *Pre-generate (1 unfinished)*, whose panel has *Resume* (continue it) and *Discard*; in the console `pregen resume` and `pregen stop`. With `"Pre-generationOnline": true` in `data/config.json` it is resumed as soon as the world starts. Either way it continues four rings back (the last rings before a stop may not be lit yet).
- **The game code:** a hook added in memory like the others (`src/game-patches.js`, "world pre-generation"), only when the exact code it uses is found. Otherwise the log says `world pre-generation not applied: ...` and `pregen` says it is not available.

**What it costs (measured, nobody online, rate 50):** the 4,761 chunks for 512 blocks (the radius and the two rings beyond it) took 218 s, 21.9 chunks/s. That was 38 ms of game-thread time per chunk on average, the longest about 230 ms; the lighting steps were 4 s of it in total.

Several chunks per tick against one (2026-10-29: a new world, seed 12345, nobody online, rate 50; in turns; `test/bench/load.js --make-template --pregen 512 --pregen-rate 50 --pregen-fast on|off`):

| | One chunk per tick (before) | Several per tick (now) | Now, with a terrain thread |
|---|---|---|---|
| Job time, all 12 CPUs (3 runs each) | 245 s (19.4 chunks/s) | **218 s** (21.9 chunks/s) | **170 s** (27.9 chunks/s) |
| Job time, 2 CPUs of one core (1 run each) | 262 s (18.1 chunks/s) | **232 s** (20.5 chunks/s) | 269 s (17.7 chunks/s) |
| Game thread busy, once past the first minute (12 CPUs) | 85 % | 100 % | 100 % |
| Game thread time per chunk (12 CPUs) | 35.1 ms | 37.9 ms | 28.4 ms |
| Tick time p50 / p95 / p99 (12 CPUs) | 39.6 / 61.1 / 95.4 ms | 44.3 / 84.5 / 114.2 ms | 48.8 / 78.2 / 112.5 ms |
| Longest tick (12 CPUs) | 228 ms | 236 ms | 232 ms |
| Whole process CPU (12 CPUs) | 0.84 cores | 0.98 cores | 1.48 cores |
| Memory (RSS), mean (12 CPUs) | 636 MB | 644 MB | 842 MB |

- **Faster** by the time the game thread used to spend waiting for its next tick: 11 % shorter jobs on 12 CPUs and on 2. Each chunk costs the game thread a little more (37.9 ms against 35.1), probably the garbage collection it used to do while waiting.
- **Ticks are longer while nobody is online** (p95 85 ms against 61 ms), and the server keeps its 20 ticks per second: 1,200-1,207 ticks a minute in every run.
- **With players on the server, unchanged:** 12 players in the world and a job at 50 chunks/s: one chunk per tick, no extra loads.
- **The same world:** every chunk within the radius populated and light populated in all 12 runs (4,225 of 4,225). The saved worlds (`test/bench/compare-worlds.js`, 4,761 chunks each) differ only in blocks that move after a chunk is made: water, lava, sand and gravel (and one stone block where lava met water), about half of them in caves below y=40. Before against now: 1,056-1,077 of 312 million blocks, in 54-55 chunks; two runs before: 32 blocks in 3 chunks; two runs now: 274 blocks in 19 chunks. Where water has flowed and gravel has fallen depends on the tick in which a chunk's neighbours are loaded, which this changes. Terrain, ores, trees, structures, biomes, chests, spawners and entities: the same. The world's database grew by 26.6 MB (5.7 KB per chunk). Checked in the saved chunks: all 4,225 chunks within the radius were populated (trees, ores, structures) and light populated.

**What it changes for players** (the load test above; 3 runs each, alternating fresh / pre-generated / pre-generated without lighting; mean, with the range):

| | Fresh terrain | Pre-generated (512 blocks) | Pre-generated without lighting |
|---|---|---|---|
| Tick time, median | 10.9 ms (9.8-12.2) | 11.6 ms (10.1-14.1) | 9.8 ms (9.6-10.0) |
| Tick time, 95th percentile | 134 ms (124-152) | 58 ms (52-69) | 122 ms (120-123) |
| Tick time, 99th percentile | 348 ms (302-430) | 91 ms (78-106) | 261 ms (243-277) |
| Longest tick | 1.09 s (1.03-1.19) | 1.10 s (1.02-1.27) | 1.08 s (1.01-1.19) |
| Ticks over 250 ms | 46 (37-59) | 4 (3-6) | 27 (21-33) |
| Time behind in 115-120 s | 34.9 s (29.7-44.4) | 7.1 s (5.2-10.6) | 26.1 s (24.9-27.6) |
| "Can't keep up!" lines | 1.0 | 0 | 0.3 |
| Game thread busy | 68% (63-77) | 46% (42-55) | 60% (58-61) |
| Chunks generated | 425 | 0 | 0 |
| Joins and teleports: longest tick | 3.58 s (3.51-3.69) | 0.80 s (0.64-1.07) | 1.77 s (1.61-2.02) |
| Joins and teleports: ticks over 1 s | 15 (13-16) | 0.3 (0-1) | 7 |
| Joins and teleports: time behind | 59 s (58-60) | 8 s (5-13) | 41 s (39-43) |

- Every pre-generated run was better than every other run in the 95th and 99th percentile, the ticks over 250 ms, the time behind and how busy the game thread was.
- **With the final code** (the template made again: all 4,225 chunks within the radius light populated, against 99.5% for the runs above), two runs gave 5.3 and 6.2 s behind, 81 and 93 ms at the 99th percentile, 43 and 45% busy; a fresh-terrain run between them 29.8 s, 327 ms and 64%. A third run is left out: in it the disk of this machine stalled for 40 s (single world writes of 250-900 ms instead of under 1 ms), which held the game thread for 28 s.
- **The lighting is most of it.** The "without lighting" column is the first version of `pregen`: its chunks are populated but not lit, so the game lit each one when a player first came near, which was about 30% of the game thread's busy time (see the CPU profiles below). Saving does not keep a chunk's own lighting: u53 saves `LightPopulated` from the vanilla flag, which the game sets only once the chunk's eight neighbours are lit as well, and a chunk loaded without it is lit again from scratch. That is why each chunk gets the lighting step twice, and why a chunk is kept loaded until its neighbours are done.
- **The longest ticks left were the autosave.** The game saves every 45 s, and with 12 players it wrote 320-570 chunks in one tick each time (vanilla 1.8 saves every loaded chunk that has entities). Those ticks took 1.0-1.2 s, of which 0.2-0.3 s was the disk writes. These runs were made with the game's own autosave; the host now spreads it over ticks (see "Autosave spread over ticks").

**While players play** (12 players near spawn, nobody exploring; a pre-generation of 1000 blocks at the default rate of 4 chunks/s, or none; 2 runs each, alternating):

| | No pre-generation | Pre-generation at 4 chunks/s |
|---|---|---|
| Tick time, 95th percentile | 48 ms (47-50) | 64 ms (63-66) |
| Tick time, 99th percentile | 108 ms (107-109) | 103 ms (98-107) |
| Ticks over 250 ms | 6 | 6 (4-7) |
| Time behind in 115 s | 6.5 s (5.9-7.1) | 7.7 s (7.5-8.0) |
| "Can't keep up!" lines | 0 | 0 |
| Game thread busy | 32% (30-33) | 44% (42-46) |
| Chunks pre-generated in 115 s | - | 422 (420-424), 3.7 per second |
| Ticks it waited because the server was behind | - | 169 (154-183) |

A pre-generation at the default rate made the game thread 12 points busier and the 95th percentile 16 ms longer; the time behind went up by 1.2 s in 115 s, and there were no more long ticks.

**8 to 16 players** (a quarter of them exploring; one run each except where noted, so a rough guide only):

| | 8 players | 12 players (3 runs) | 16 players | 16 players, fresh terrain (2 runs) |
|---|---|---|---|---|
| Ticks per second | 20 | 20 | 20 | 0.3 and 1.3 |
| Tick time, 95th percentile | 46 ms | 58 ms | 68 ms | 5.3 s and 2.0 s |
| Tick time, 99th percentile | 71 ms | 91 ms | 100 ms | 5.5 s and 3.8 s |
| Time behind in 115 s | 3.1 s | 7.1 s | 8.4 s | 112 s and 111 s |
| Game thread busy | 31% | 46% | 55% | 100% |
| Joins and teleports: longest tick | 0.73 s | 0.80 s | 1.07 s | 5.8 s and 3.5 s |

With 16 players and 4 of them exploring fresh terrain, this machine did not keep up at all: from the joins on it fell further behind for the whole run (median ticks of 3.7 s and 0.55 s, the longest 5.5 and 9.9 s), like the freezes of 5-18 s in the logs this was measured for, only without end. In pre-generated terrain the same 16 players ran at 20 ticks per second.

**Recommendation:** pre-generate a new world before players spread out, and cover the area they travel in, e.g. `pregen 1000 50` while nobody is online: 17,161 chunks, about 13 min at the 21.9 chunks/s measured here (about 10 min with a terrain thread, on a server with a core of its own and 200 MB to spare), and about 98 MB at 5.7 KB per chunk. A slower VPS takes longer. While players are online, keep the default rate of 4 chunks/s or lower (see above).

### Autosave spread over ticks (`spreadAutosave`, on by default)

Every 45 s (900 ticks) the game saves the world: the players' data, `level.dat`, and every loaded chunk that has had entities since its last save or was changed (vanilla 1.8 `saveAllChunks(true)`). Then it queues every loaded chunk no player sees for unloading, and unloading saves each of those again, up to 100 per tick. The saving happens in that one tick: with 12 players about 280-360 chunks, a tick of about 1 s, then ticks of 100-240 ms while the queued chunks are unloaded.

The host now runs the same work with the game's own calls, but spread over ticks:
- **The autosave tick** saves the players' data, as before.
- **At the end of that tick and the next ones:** `level.dat`, then the chunks, as many per tick as fit until the tick is 40 ms old (at least one per tick), then the queueing of the chunks no player sees, 8 per tick.
- **Unchanged:** `save-all`, the web page's *Save now* and the save when the world stops still save everything at once.
- **The game code:** a hook added in memory like the others (`src/game-patches.js`, "spread autosave"), only when the exact code it uses is found; otherwise the log says `spread autosave not applied: ...` and the game's own autosave runs.

**Measured** (the load test above: 12 players, 3 of them exploring, pre-generated terrain; 3 runs each, alternating; mean, with the range):

| | The game's autosave (one tick) | Spread over ticks |
|---|---|---|
| Longest tick | 1.04 s (0.99-1.11) | 0.14 s (0.13-0.15) |
| Ticks over 250 ms | 3 | 0 |
| Tick time, 99th percentile | 83 ms (79-89) | 76 ms (73-79) |
| Tick time, 95th percentile | 55 ms (54-57) | 54 ms (53-55) |
| Time behind in 115 s | 5.4 s (5.1-6.0) | 2.3 s (2.0-2.7) |
| Game thread busy | 44% (42-46) | 43% (42-44) |
| Chunk writes in the measured time | 3,371 (3,295-3,420) | 3,348 (3,325-3,372) |

- Each spread autosave saved 283-357 chunks in 49-67 ticks (2.4-3.3 s), at most 13 in one tick, and queued 10-48 chunks no player saw. Each run had three autosaves in its measured time.
- Every spread run had a shorter longest tick and less time behind than every run with the game's autosave. The 3.1 s less behind is about what the three autosave ticks (about 1 s each) and the ticks after them added.
- **On a slow disk** (every world write made 10 ms longer with `EAGLAN_DEBUG_SLOW_WRITES_MS=10`; one run each): with the game's autosave the longest tick was 4.7 s, 4 ticks took over 1 s and there were 2 "Can't keep up!" lines; spread, the longest tick was 0.91 s, none took over 1 s, no "Can't keep up!", and a round took about 10.5 s (214-220 ticks, at most 3 chunks in one). The other long ticks on that disk come from the chunks the game unloads as players move (each written on its own); that is where `"diskSync": "normal"` helps (see "Game server stalls").
- The pre-generation measurements above were made with the game's own autosave; their longest ticks were these autosaves.

**The trade-off:** during a round (2-3 s here) the chunks are saved at slightly different moments, so an entity that crosses a chunk border meanwhile can be in two saved chunks or in none. That matters only if the host crashes before those chunks are saved again (at the next autosave, when they are unloaded, or at a stop). The game's own unloading already saves chunks at different moments, and nothing changes for `save-all`, *Save now* or a normal stop.

**Off:** `"spreadAutosave": false` in `data/config.json`, applied at the next start, restores the game's own autosave.

### Where the game thread's time goes (CPU profiles)

CPU profiles of the game thread, 100 s each, during the load test above (seconds of game-thread time in those 100 s, and the share of its busy time; the profiles of fresh terrain and of the first version were made the evening before):

| | Fresh terrain | Pre-generated | Pre-generated without lighting |
|---|---|---|---|
| Busy | 75.8 s | 41.8 s | 67.1 s |
| Lighting (a chunk's first lighting: Alfheim's `initChunkLighting`, and light updates) | 17.3 s (23%) | 0.9 s (2%) | 20.7 s (31%) |
| World generation (pre-generated: the game's structure and biome look-ups when a chunk is loaded) | 16.3 s (22%) | 3.9 s (9%) | 4.3 s (6%) |
| Entities (mobs, items, players) | 13.4 s (18%) | 12.3 s (29%) | 15.1 s (23%) |
| zlib in JavaScript (the game's JZlib: saving chunks, compressing chunk packets) | 10.7 s (14%) | 11.2 s (27%) | 11.1 s (17%) |
| Loading and saving chunks (NBT, storage) | 6.5 s (9%) | 4.5 s (11%) | 5.7 s (9%) |
| Block updates, random ticks | 5.3 s (7%) | 3.5 s (8%) | 3.8 s (6%) |
| Garbage collection | 2.2 s (3%) | 1.0 s (2%) | 2.0 s (3%) |
| Sending chunks, other network work | 3.0 s (4%) | 3.0 s (7%) | 3.2 s (5%) |

- **Lighting** in fresh or unlit terrain is mostly a chunk's first lighting, done in the tick when a player first comes near it, in one call path (`initChunkLighting` → `recheckGaps` → an HPPC `LongHashSet.add`, by itself 12.5% of the busy time in unlit pre-generated terrain). In pre-generated terrain it is gone.
- **What is left in pre-generated terrain** is entities and the JavaScript zlib, about the same amount of work as everywhere; see "What was not changed".

### Young generation of the game thread (`youngGenerationMb`, opt-in)

New JavaScript objects start in the heap's young generation; a larger one is collected less often. Node picks its size from the machine, and the heap limit in `status` (`heap … of N MB`) shows which: 2096 MB, as in the logs from the server this was measured for, is a 32 MB young generation for the game thread (with `maxHeapMb` 2048); 2240 MB, this machine's default, is 128 MB.

Measured with the load test above (fresh terrain), 32 MB and 128 MB alternating, 5 rounds; 64 and 256 MB in rounds 1-2 (mean, with the range):

| | 32 MB | 64 MB | 128 MB | 256 MB |
|---|---|---|---|---|
| Garbage collection per minute | 1.80 s (1.59-2.24) | 1.18 s (1.06-1.29) | 0.79 s (0.76-0.87) | 0.61 s (0.56-0.65) |
| Game thread busy | 70% (66-80) | 67% (64-70) | 65% (63-69) | 67% (62-72) |
| Tick time, 95th percentile | 146 ms (122-217) | 134 ms (123-145) | 124 ms (116-134) | 128 ms (121-134) |
| Tick time, 99th percentile | 439 ms (315-802) | 349 ms (332-366) | 341 ms (310-417) | 364 ms (320-408) |
| Time behind in 115-120 s | 38.3 s (31.3-56.3) | 32.8 s (29.3-36.3) | 31.3 s (28.6-37.0) | 33.4 s (27.9-39.0) |
| Game heap in memory (physical) | 286 MB | 311 MB | 380 MB | 504 MB |

- In every round, 128 MB had less than half the garbage collection of 32 MB (about 1 s less per minute, 1.7% of the game thread's time) and a less busy game thread (by 1-3 points; by 16 in the slow round below).
- The time behind and the 95th percentile were lower in 4 of the 5 rounds (median 35.0 → 30.7 s behind). The 99th percentile was lower in only 2 of 5. One 32 MB round was much slower than all others (56 s behind); without it, 32 MB averaged 33.8 s behind and 129 ms at the 95th percentile.
- It costs memory: about 95 MB more for 128 MB, 220 MB more for 256 MB.

**Setting (off by default):** `"youngGenerationMb": 128` in `data/config.json`, applied at the next start; the log says `game thread young generation: 128 MB (config youngGenerationMb)`, and `status` shows the heap limit 144 MB higher (2240 MB). Remove it to undo. Worth trying when the stall lines blame `garbage collection` and the server has the memory: here it halved the collection time and lowered lag a little, within the run-to-run variation of these tests. On a server whose logs show more garbage collection (the logs this was measured for had 2-9% of the game thread, and once 8.1 s within a 20 s stall, which these tests never reproduced), the gain can differ: compare the `game:` line of `node cli.js status` before and after.

### Player limit

u53 enforces no maximum number of players: anyone with a code gets in. The host can refuse joins above a limit. **Off by default.**

- **Set it:** web page *Settings → Player limit*, or `node cli.js limit 12`, or `"playerLimit": 12` in `data/config.json` and then `node cli.js settings apply`. Switch it off with an empty field, `node cli.js limit off` or `0`.
- **Takes effect:** for players who join from then on, without a restart. Players already in the world stay, also when the limit is lowered below their number.
- **What a refused player gets:** the game's own refusal at login, with the message `This world is full: 2 of 2 players are online. Try again later.` (here with a limit of 2). The world never sees the join: no login, and nothing is loaded for that player.
- **Log and status:** `refused: the world is full (2 of 2 players; config playerLimit)`, then the join line `… did not get in after 4s: refused: the world is full (2 of 2 players)`. `node cli.js status` shows `players:  2 (limit 2, 1 refused because the world was full)`.
- **Tested:** `test/multi-relay.test.js` (the message, nothing opened in the world, a raised limit lets the next player in), `test/daemon-relays.test.js` (the real daemon, the limit changed while players are in), and an unmodified u53 client joining a full world, which showed the message on the game's "Failed to connect to the server" screen.

### What was not changed

These showed up in the measurements above but were left as they are:

- **zlib in JavaScript.** The game compresses saved chunks and chunk packets with JZlib, compiled to JavaScript: 11 s of every 100 s in all three profiles, a quarter of the busy time in pre-generated terrain. The multi-core mode (opt-in, see "Multi-core mode") moves it to other cores, in native code; off, the game does it as before.
- **Entities** (mobs, items, players): 12-15 s of every 100 s; game logic. Three single-thread costs in it were cut later, with the same results (see "Speedups on the game thread").
- **Joins and teleports** still load about 80 chunks in one tick (the game's own chunk loading for a player's view): 0.6-1.1 s in pre-generated terrain, 3.5-3.7 s in fresh terrain.
- **Defaults:** view distance, `diskSync`, `maxHeapMb` and the young generation stay as they were, and `pregen` and the player limit do nothing until used. The autosave is spread over ticks by default; `"spreadAutosave": false` restores the game's own. The speedups are on by default; `"speedups": false` turns them off.
- **The rest:** the game still runs as its own integrated server in a worker thread, World LAN over relays as before. Pre-generation adds chunks only through the game's own loading and saving; no world is deleted or overwritten.

## Multi-core mode (`multiCore`, opt-in, measured)

**The game server stays single-threaded.** EaglercraftX 1.8 u53's integrated server is Java compiled to a single JavaScript thread (TeaVM). Its tick (players, mobs, block updates, world generation, lighting, saving) runs in a fixed order and has no locks. Running parts of it at the same time would change that order, and with it what happens in the world. The multi-core mode does not do that.

**What it moves to other cores** is work that only turns bytes into other bytes and never touches the world. Pool threads do it while the game thread carries on with its tick:

| Work | Share of the game thread's busy time with the mode off (CPU profiles, 12 players) |
|---|---|
| Compressing large network packets (over 1 KB: chunks, entity lists) | 13 % in pre-generated terrain, 7 % in fresh terrain |
| Gzipping chunk files when they are saved | 10 % in pre-generated terrain, 6.5 % in fresh terrain |

With the mode on, both run on pool threads, with Node's native zlib instead of the game's JavaScript zlib.

- **Packets:** the game hands a large packet over uncompressed, through the same message channel all its packets use. A pool thread compresses it with the game's own settings (zlib, level 5), and the host frames it the way the game does: `[2][length][zlib data]`, in parts of at most 65,279 bytes. **Every player's messages leave in the order the game sent them:** a packet waiting for its compression holds back everything after it to that player, compressed or not.
- **Saves:** the game writes the chunk uncompressed, behind a 16-byte header with its length, and goes on. The storage layer (`src/idb-sqlite.js`) has it gzipped on a pool thread, then commits it.
  - A read of that chunk file waits until it is committed.
  - A newer save or a delete of the same file wins over it.
  - *Save now* and a stop wait for all of them before they report done.
  - A file is never stored uncompressed: if the pool fails, the file is gzipped on the game thread.
  - A crash can lose only the saves still being compressed (a few milliseconds' worth); those files keep their previous version.
- **Threads:** at most 2 by default, and never more than the CPUs this process may use minus one, which stays with the game thread. "May use" means the CPU affinity and, on Linux, a cgroup CPU quota (containers, systemd `CPUQuota=`, some VPS panels). So a 2-CPU server gets 1 pool thread. `multiCoreWorkers` in `data/config.json` sets another number, still within that limit. With fewer than 2 CPUs the mode does not start, and says why.
- **Switching:** *Settings → Multi-core mode* on the web page, `node cli.js multicore on|off`, or `"multiCore": true` in `data/config.json`. It applies at once, without a restart, and players stay connected.
  - `node cli.js status` has a `multi-core:` line; the web page has a *Multi-core* row.
  - Both show the pool threads, how busy they are and what went through them; *Host load* shows the pool's CPU share.
- **Off (the default):** the game's own code runs, as before. While off, each of the two hooks (`src/game-patches.js` "multi-core packets" and "multi-core saves") costs one check. `"gamePatches": false` removes them; the mode then reports that it is not available.
- **Failures:** a job a pool thread could not finish is done on the main thread (packets) or on the game thread (saves), so nothing is lost. A thread that dies is replaced. After 3 deaths within a minute the mode switches itself off and says why (log, `status`, web page).

### Measured

Measured on 2026-10-28 on the build machine (12 CPUs, Windows 10, Node 24.19) with the load test of "Lag with many players": 12 players, 3 of them exploring, the same two saved worlds, and the mode off and on in turns. The figures are the mean of the runs, with the range in brackets. "Whole process CPU" is the CPU time of all the host's threads, in cores. One run (pre-generated world, mode off) is left out: this machine's disk stalled during it and blocked the game's writes for 62 s, against about 2 s in the other runs. Rule: more than 3 times the median of its group. The runs with 4 pool threads are summarised under *Pool size* below.

**All 12 CPUs, 2 pool threads (the default):**

| | Pre-generated, off | Pre-generated, on | Fresh, off | Fresh, on |
|---|---|---|---|---|
| Ticks per second | 20 | 20 | 20.3 | 20.0 |
| Tick time p50 / p95 / p99 | 11.7 / 54.3 / 81.2 ms | 11.0 / 39.9 / 63.2 ms | 11.1 / 130.1 / 315.7 ms | 10.9 / 113.5 / 311.5 ms |
| Longest tick | 143 ms (134-153) | 191 ms (90-348) | 711 ms (676-747) | 794 ms (683-904) |
| Time behind (accumulated tick delay) | 2.5 s (2.4-2.6) | 1.1 s (0.5-2.1) | 29.6 s (27.2-32) | 25.0 s (24.4-25.6) |
| Game thread busy | 43 % | 35 % | 67 % | 60 % |
| Whole process CPU (pool threads) | 0.55 cores | 0.53 cores (0.03) | 0.82 cores | 0.81 cores (0.03) |
| Memory (RSS) | 670 MB | 709 MB | 843 MB | 902 MB |
| Game thread GC per minute, longest pause | 365 ms, 14 ms | 298 ms, 5 ms | 827 ms, 14 ms | 806 ms, 7 ms |
| Longest wait of a packet for its compression | – | 10 ms | – | 14 ms |

**The host on 2 CPUs only (1 pool thread), as on a small VPS** (`--host-cpus 2`: the test's own players run on the other CPUs):

| | Pre-generated, off | Pre-generated, on | Fresh, off | Fresh, on |
|---|---|---|---|---|
| Ticks per second | 20 | 20 | **18.1** | **20.1** |
| Tick time p50 / p95 / p99 | 13.8 / 60.6 / 92.3 ms | 12.8 / 45.1 / 71.4 ms | 16.2 / 162.9 / 468 ms | 13.2 / 130.4 / 351.2 ms |
| Longest tick | 429 ms (269-589) | 155 ms (143-166) | 948 ms (829-1067) | 866 ms (738-994) |
| Time behind (accumulated tick delay) | 4.7 s | 1.7 s | 41.9 s | 31.1 s |
| Game thread busy | 49 % | 40 % | 80 % | 70 % |
| Whole process CPU (pool thread) | 0.60 cores | 0.57 cores (0.06) | 0.95 cores | 0.89 cores (0.05) |
| Memory (RSS) | 662 MB | 697 MB | 749 MB | 745 MB |
| Longest wait of a packet for its compression | – | 93 ms (82-104) | – | 109 ms (108-110) |

- **What got better:** the time the game thread spends per tick. In CPU profiles of the game thread (100 s each) its busy time fell from 44.7 s to 34.2 s in pre-generated terrain and from 74.1 s to 59.9 s in fresh terrain. The zlib left on it is the decompression of chunks it loads: 1.2 s and 0.8 s. Ticks that took long because of zlib are gone: in the tables above p95 fell by 13-27 % and the time behind by 16-64 %. On all 12 CPUs the game thread's longest garbage-collection pause halved (14 → 5-7 ms); on 2 CPUs it stayed about the same.
- **Most help where CPU is short:** on 2 CPUs in fresh terrain the server could not hold 20 ticks per second without the mode (18.1) and could with it (20.1).
- **What did not get better:** the longest ticks in fresh terrain, and the 99th percentile there. They come from world generation and lighting, which stay on the game thread (see below). In one pre-generated run with the mode on, the longest tick (348 ms) came during a disk slowdown (6.5 s of blocked writes, against about 2 s in the other runs).
- **The whole process used no more CPU, and a little less:** the pool's native zlib needs less CPU than the game's JavaScript zlib for the same work. Each pool thread was at most 5 % busy (14 % for the single one on 2 CPUs).
- **What it costs:**
  - Memory: 40-60 MB with 2 pool threads, 0-35 MB with 1, and 135-150 MB with 4. An idle pool thread takes about 13 MB; the rest is memory the threads keep after jobs.
  - Packets that wait for their compression: at most 10-14 ms. On 2 CPUs, where the pool thread shares the CPUs with the game thread, about 0.1 s for the largest chunk packets. With the mode off, the game thread itself spends that time compressing, holding up its whole tick.
- **Pool size:** with 4 pool threads (an earlier batch, 3 runs each) the results were similar: p95 38 ms pre-generated and 103 ms fresh, packet waits at most 10-12 ms. Memory was 65-115 MB higher than with 2. In that batch's one undisturbed 2-thread run the results equalled 4 threads. With 1 pool thread on all 12 CPUs, packets waited up to 30-130 ms in bursts; those two runs also hit the disk stalls above, so their tick times are not compared. Hence the default of 2; `multiCoreWorkers` can set more.
- **Correctness:** in all 36 runs every player stayed in the world (none kicked or disconnected). No job had to be redone outside the pool, and the explorers travelled as far as with the mode off. In fresh terrain the game put the fast explorers back a few times in 6 of 15 runs (3 off, 3 on): the game's own check for moving too fast while it lags. See also the tests below and the real-client check in the results table.

### What cannot run in parallel, and why

- **Lighting** (22 % of the game thread's busy time in fresh terrain): a light update reads and writes the light of neighbouring blocks, across chunk borders, in the order blocks change. Two updates at once would give results that depend on timing. Pre-generation (above) moves this work out of play time instead.
- **Entities** (19-30 %; 68-78 % with hundreds of mobs): mob AI, collisions and item pickups read and change each other and the blocks around them, in order. Measured part by part in "Entity processing: what could run in parallel".
- **Block updates, redstone, random ticks:** the same.
- **World generation** (22 % in fresh terrain): only part of it can move. A chunk's base terrain (noise, surface, caves, ravines) and its biomes depend only on the seed and its position, so another thread can make them, if it runs the game's own code and the host knows in advance which chunks will be needed. That is the case for a pre-generation job (see "Terrain threads for pre-generation"), and, from where players are going, for the chunks they walk into (`terrainForPlayers`, see "Chunk work in fresh terrain"). The rest stays on the game thread: the structures the game registers while generating (villages, strongholds, mineshafts), decoration (trees, ores: they reach into neighbouring chunks), and lighting.

## Terrain threads for pre-generation (`terrainThreads`, opt-in, measured)

**What it does.** While a pre-generation job runs (see "Pre-generating the world"), a thread of its own makes the terrain of the chunks the job loads next, and the game uses that terrain instead of making it itself. "Terrain" is the part of the game's chunk generation that depends only on the seed and the chunk's position: the noise terrain, the surface (grass, sand, snow), the caves and the ravines, and (since stage 5) the chunk's biomes. On the build machine that was about 10 of the 35 ms the game thread spends on a pre-generated chunk (measured before the biomes moved too). The rest stays on the game thread, in the game's own order:

- the structures it registers (villages, strongholds, mineshafts, temples, monuments);
- decoration (trees, ores, lakes), lighting and saving;
- the chunks players load, unless `terrainForPlayers` is on (see "Chunk work in fresh terrain": the same threads then also make the terrain of the chunks players are about to reach).

**How it stays the game's own terrain.**

- The thread runs the game's own code, in its own copy of `classes.js`, set up with the world's own settings. Those are the game's WorldInfo, written the way level.dat is, so a world that was never saved works too. The thread stops where the game would make the chunk from its terrain; the game copies the result into its own chunk and goes on from there (`src/terrain-worker.js`, `src/terrain.js`, and the "terrain threads" correction in `src/game-patches.js`).
- **Every 32nd chunk is not used:** the game makes it itself and compares the two, block by block and biome by biome. A difference switches the threads off until the world restarts and is logged (`terrain threads stopped: ...`); the game then makes all terrain itself.
- `"terrainVerify": true` compares every chunk and uses none: a check for a server or a world.

**When it runs.**

- Only while a job runs (with `terrainForPlayers` also while players reach new terrain). The thread starts with the job (2-6 s to load its copy of the game code; meanwhile the game makes the job's chunks itself) and ends 10 s after the job, which gives its memory back.
- Not for flat or debug worlds (another generator), and not with fewer than 2 CPUs: the thread needs a CPU besides the game thread's. `terrainThreads` is capped at the CPUs this process may use minus one (affinity and cgroup quota, as for the multi-core mode).
- One thread is enough. It makes a chunk's terrain in about 18 ms (55 per second), more than a job loads (at most 28 per second here); a second thread would only cost memory.

**Switching.** `"terrainThreads": 1` in `data/config.json` (`0`, the default, is off; it applies at the next world start). `node cli.js status` has a `terrain:` line. The log line at the end of a job says how many chunks the thread made, how many the game used and compared, and whether any differed.

### Measured

Measured on 2026-10-29 on the build machine (6 cores, 12 logical CPUs; Windows 10, Node 24.19), while a job still loaded one chunk per tick also with nobody online (with several per tick, see "Pre-generating the world": 218 s without the thread, 170 s with it). Each run made a new world (seed 12345) and pre-generated 512 blocks round spawn (4,757 chunks) at the job's top rate, with nobody online; off and on in turns (`test/bench/load.js --make-template --pregen 512 --pregen-rate 50 [--terrain 1]`). Figures are the mean of the runs, with the range in brackets. Tick times are the game thread's per-minute figures while the job ran, averaged over the minutes. "Game thread time per chunk" is the job's own count: the time its loads took, generation and decoration included.

**All 12 CPUs** (3 runs each):

| | Off | On (1 terrain thread) |
|---|---|---|
| Job time | 246 s (244-249) | 245 s (241-252) |
| Chunks per second | 19.4 (19.1-19.5) | 19.5 (18.9-19.8) |
| Game thread time per chunk | 34.5 ms (34.2-34.8) | **24.2 ms** (23.9-24.4) |
| Game thread busy | 73 % (72-74) | **59 %** (56-63) |
| Tick time p50 / p95 / p99 | 38.7 / 60.0 / 94.0 ms | 29.8 / 52.2 / 90.9 ms |
| Ticks over 50 ms per minute | 136 (126-148) | 79 (55-127) |
| Longest tick | 246 ms (208-312) | 326 ms (198-581) |
| Ticks the job waited because the server was behind | 106 (86-142) | 116 (54-232) |
| Whole process CPU | 0.81 cores | 1.01 cores |
| Memory (RSS), mean / max | 641 / 747 MB | 819 / 927 MB |
| Terrain thread, time per chunk | - | 18.2 ms |

One run with the thread on had one long tick of 581 ms in its third minute; the longest in the other two were 198 and 200 ms (with the thread off: 217, 312 and 208 ms). The game's garbage collection was not recorded in that run; in the runs where it was, its longest pause was 5-8 ms.

**Where the host may run** (one run each way, except where noted):

| Host CPUs | Game thread time per chunk, off → on | Game thread busy | Ticks over 50 ms per minute | Job time | Whole process CPU | RSS, mean |
|---|---|---|---|---|---|---|
| All 12 (3 runs each) | 34.5 → 24.2 ms | 73 → 59 % | 136 → 79 | 246 → 245 s | 0.81 → 1.01 cores | 641 → 819 MB |
| 4 logical CPUs of 2 cores (CPUs 0-3, as many 4-vCPU plans) | 32.1 → 24.4 ms | 69 → 58 % | 103 → 74 | 243 → 242 s | 0.76 → 1.02 cores | 623 → 817 MB |
| 2 separate cores (CPUs 0 and 2) | 32.0 → 22.9 ms | 68 → 54 % | 85 → 60 | 243 → 243 s | 0.72 → 0.90 cores | 603 → 791 MB |
| **2 logical CPUs of 1 core** (CPUs 0-1, hyperthreading, as many 2-vCPU plans; 2 runs each) | 34.9 → **37.2 ms** | 74 → 78 % | 158 → **309** | 251 → **274 s** | 0.80 → 1.34 cores | 605 → 799 MB |

On one core the two threads slow each other down: the terrain thread took 33 ms per chunk instead of 18, the game thread saved nothing, and the job and its ticks got slower. (A third 2-CPU run with the thread off is left out: one of my test runs shared its CPUs.)

**While players play** (12 players near spawn in a new world, a job of 1000 blocks at the default 4 chunks/s; 2 runs each, as in "Lag with many players"):

| | Off | On |
|---|---|---|
| Ticks per second | 20 | 20.1 |
| Tick time p50 / p95 / p99 | 10.6 / 65.0 / 101.6 ms | 10.9 / 63.6 / 98.1 ms |
| Ticks over 100 / 250 ms | 26 / 4 | 23 / 4 |
| Time behind (115 s) | 6.0 s (5.8-6.3) | 5.8 s (5.5-6.1) |
| Game thread busy | 45 % | 44 % (42-46) |
| Whole process CPU | 0.59 cores | 0.69 cores |
| Memory (RSS) | 718 MB (691-744) | 876 MB (795-957) |
| Chunks the job generated (of them from the thread) | 273 | 273 (255) |

**Correctness:**

- **Every chunk compared** (`terrainVerify`, one run on all CPUs): 4,708 chunks made by the thread, all 4,708 the same as the game's own, block by block. With both making every chunk, the game thread needed 35.4 ms per chunk, against 34.5 ms with the thread off.
- **Spot checks** in the 9 runs with the thread on: 32,418 chunks used, 1,043 compared, none different.
- **The saved worlds, block by block** (`test/bench/compare-worlds.js`; 4,761 chunks of 65,536 blocks in each world). Two worlds made with the thread off differed in 3 chunks (4 blocks); off against on in 1-4 chunks (6-10 blocks); two made with it on in 3 chunks (14 blocks). Every difference was water or lava flow, lava meeting water, or falling sand: block updates whose outcome depends on tick timing, as between two runs with it off. Biomes, tile entities (chests, spawners) and entities (2,107) were the same in every pair.

**Memory after a job** (a new world, a job of 256 blocks; the host's RSS every 5 s): at the job's peak 615 MB off and 809 MB on; from 15 s after the job (the thread ends after 10 s) 316-323 MB off and 325-329 MB on. The thread's memory goes when it ends.

**What it changes:**

- **With a core of its own** (all 12 CPUs, 4 CPUs of two cores, two separate cores): the game thread spends 24-30 % less time on each pre-generated chunk, and the ticks while a job runs are shorter (28-42 % fewer over 50 ms).
- **How fast a job runs, with nobody online:** a job then loads as many chunks per tick as fit, so the game thread's saved time goes to more chunks: 218 → 170 s for 512 blocks (21.9 → 27.9 chunks/s, 3 runs each; table in "Pre-generating the world"). With one chunk per tick (the tables above, and with players on the server) the job runs at about 19.5 chunks per second either way, and the thread only makes its ticks shorter.
- **On one core with hyperthreading** (2 logical CPUs, as on many 2-vCPU servers) it makes things worse: the job took 9 % longer and there were twice as many long ticks.
- **While players play** with a job at the default rate, the difference was within the spread of the runs: the job generated about 2.4 chunks per second, and the thread saves about 10 ms on each.
- **What it costs:** while a job runs, 160-195 MB more memory (the thread's own copy of the game code: a 155 MB heap) and 0.2-0.25 cores more CPU where it has a core of its own: the thread takes about 18 ms to make what takes the game thread about 10 ms (it runs with a small young generation to keep its memory down).

**Recommendation:** leave it off (the default) unless you pre-generate large areas while nobody is online, on a server with a core of its own and about 200 MB of memory to spare: then it cuts a job's time by about a fifth (218 → 170 s here). On a 2-vCPU server (one core with hyperthreading) it makes jobs slower (232 → 269 s), and with players online the difference was within the spread of the runs. For the chunks players walk into (`terrainForPlayers`, stage 5) it is a different case, and it helped on every server tested with 2 CPUs or more: see "Chunk work in fresh terrain".

## Entity processing: what could run in parallel (measured)

**Result: nothing in the entity part of the tick can move to other threads without changing gameplay, or without costing more than it saves on this engine. Nothing in the game was changed for this.** The measurements below show where the time goes and why. The costs that could be cut are single-thread ones, and three of them now are, with the same results (see "Speedups on the game thread").

**Measured** on 2026-10-29 on the build machine (Windows 10, Node 24.19): the load test of "Lag with many players" (12 players near spawn in the pre-generated world, nobody exploring) with `--mobs`. That option builds a 64x64 arena 50 blocks above spawn, in every player's view, and summons zombies chasing villagers that take no damage, so they keep chasing and fleeing, plus cows, sheep, pigs and chickens; it keeps the night. A CPU profile of the game thread was taken over 100 s of each run. These profiles were made before the speedups.

- **Medium:** 60 zombies, 40 villagers and 100 animals summoned, about 450 entities with the natural ones. 20 ticks per second, game thread 61 % busy, tick p95 56 ms, 12,300 messages a second to the players.
- **Heavy:** 150 zombies, 100 villagers and 250 animals. The game thread was 100 % busy and fell behind (4 "Can't keep up!").

**Where the game thread's time goes** (share of its busy time; a part includes what it calls, so the parts overlap):

| Part of the tick | Medium | Heavy |
|---|---|---|
| All entities (`WorldServer.updateEntities`) | 67.9 % | 78.1 % |
| Mob AI tasks (`EntityAITasks`) | 15.5 % | 20.9 % |
| of which pathfinding (`PathFinder`, `WalkNodeProcessor`) | 6.1 % | 7.8 % |
| of which finding targets and nearby entities | 5.4 % | 8.6 % |
| of which line of sight | 0.3 % | 1.3 % |
| Following a path (`PathNavigate.onUpdateNavigation`) | 7.1 % | 13.4 % |
| Movement (`moveEntityWithHeading`) | 13.1 % | 18.7 % |
| Collision boxes of blocks and entities (`World.getCollidingBoundingBoxes`) | 10.1 % | 18.8 % |
| Entities pushing each other (`collideWithNearbyEntities`) | 1.6 % | 3.5 % |
| Entity queries in a box (`getEntitiesWithinAABB*`) | 7.9 % | 18.2 % |
| Players (`EntityPlayerMP.onUpdate`, mostly chunk packets and their zlib) | 14.4 % | 3.3 % |
| Entity tracking (`EntityTracker`) | 8.7 % | 10.2 % |
| Packets out (building, compressing and handing each to the host) | 19.2 % | 10.3 % |
| Mob spawning | 2.5 % | 1.0 % |
| Block ticks (random and scheduled) | 3.3 % | 2.0 % |

Zombies alone took 26-35 % of the entity time. In the usual load test (natural mobs only) mob AI was 2.4 % and pathfinding 0.6 %.

**The order of the entity tick** (u53, the game's own code): each world in turn runs its tick (weather, mob spawning, block ticks), then every entity in its list, one after the other. For a mob that is: choosing targets and goals, pathfinding, following the path, moving with collision, pushing its neighbours. Then entity tracking (what each player sees) and the packets. Checked in the code:

- a push (`Entity.applyEntityCollision`) changes the motion of both entities, so a mob's push reaches a neighbour before that neighbour's own update in the same tick;
- a path search (`PathNavigate.getPathToEntityLiving`) builds a block cache over the follow range plus 16 blocks and runs at once, inside the mob's update; the cache reads the live chunks (`ChunkCache.getBlockState` → `Chunk.getBlockState`), so it sees every block changed earlier in the tick;
- target choice and collision read where the other entities are at that moment: those earlier in the list have moved this tick, the later ones not yet.

**What could run in parallel, part by part:**

| Part | What it depends on | In parallel without changing behavior? |
|---|---|---|
| Target choice, goals | Positions and health of entities in range now; the mob's own random numbers | No: the result depends on which neighbours have already moved this tick |
| Pathfinding | Live blocks over up to 103x103 blocks; the result is used in the same update | No. Another thread would need those blocks: 6.1 MB to copy per search (649 µs here), or a copy of the world kept in step with every block change. The mob would still wait for the answer |
| Path following, movement, collision | Blocks and the collision boxes of nearby entities at that moment | No: every later entity collides with the new positions |
| Pushing | Nearby entities' positions | No: it writes both entities' motion |
| Line of sight | Blocks along the ray | No: the AI needs the answer at once |
| Mob spawning, block ticks | The world's shared random numbers, blocks | No: the order of the random numbers decides the outcome |
| Entity tracking: who sees what, how far each moved | Final positions after all entities | In principle, as it is independent per entity, but there is little to gain: this deciding part is about 1.6 % of the busy time (medium scene). About three quarters of entity tracking is building its packets and handing them over, and those have to stay in each player's order with the game's other packets |
| Entity tracking and other packets: handing them to the host | Each player's packets, in order | Already on another thread: the host thread sends them. The game thread's cost is the hand-over itself |

Ways that change behavior are ruled out. Running regions of the world on their own threads (as some Java servers do) changes the order between regions. Running entities at the same time and redoing those that collided would need every game object in shared memory and a record of each update's reads and writes. The compiled game keeps its objects in one thread's heap, which no other thread can read.

**What handing work to another thread costs here** (Node worker threads, this machine):

| | Cost |
|---|---|
| A synchronous round trip through shared memory (`Atomics.wait` / `notify`) | 0.59 µs |
| A round trip with `postMessage` (needs the event loop, which game code inside a tick cannot wait for) | 13.5 µs |
| Handing one small packet to the host, as the game does now | 1.44 µs |
| The same packets 500 to a message | 0.08 µs each |
| Copying the blocks a zombie's path search may read (6.1 MB) | 649 µs |

The round trip itself is cheap. What decides it is that a piece of entity work can only start once the previous one is done: there is never a second, independent piece of work ready for another core. A mob's whole update averages about 45 µs (medium scene); its collision query about 7 µs.

**Already on other threads:** packet and save compression (multi-core mode, opt-in), terrain for pre-generation (terrain threads, opt-in), and V8's own garbage collection and compilation, which use helper threads.

**What does cost time, on the game thread itself** (self time, share of its busy time; profiles of the scenes above and of the usual load test with natural mobs):

| | Medium | Heavy | Usual load test |
|---|---|---|---|
| Chunk lookups by their 64-bit key, which compiled JavaScript has to emulate in software (`Long_*`, `LongObjectHashMap`, `ChunkProviderServer.provideChunk`) | 13.9 % | 15.9 % | 14.0 % |
| Turning entity UUIDs into text for scoreboard team lookups (`EntityLivingBase.getTeam`) | 4.3 % | 5.9 % | 0.1 % |
| Handing each packet to the host separately | 5.0 % | 5.6 % | 1.3 % |

They are not parallel work. All three are now cut on the game thread itself, with the same results, each measured before and after: see "Speedups on the game thread".

## Speedups on the game thread (`speedups`, on by default, measured)

Three costs found in the entity profiles (see "Entity processing: what could run in parallel"), two found in fresh terrain (see "Chunk work in fresh terrain") and one found with many entities in one place (see "Many entities in one place"; off by default for now) are cut on the game thread itself. The game computes the same things in the same order and sends the same packets in the same order; it does less work to get there. Each is its own game patch (`src/game-patches.js`, "speedup: ..."), applied whole or not at all like the other patches; the fourth is applied to the whole game code after them.

- **Chunk lookups.** The game finds a loaded chunk by a 64-bit key in a hash map (`ChunkProviderServer.provideChunk` and `chunkExists`), and entities ask for chunks all the time (movement, collision, light, AI). Compiled to JavaScript, every 64-bit operation is a call that makes an object, several per lookup. Now each world's chunk list keeps its last answers: 64 slots (by x and z modulo 8), each with the chunk, or "not loaded", found for one pair of coordinates. Every load and unload of a chunk (the map's own put and remove) counts as a change, and a slot is used only if no change came after it was filled. So the answer is always what the map would give at that moment. 92-96 % of the lookups came from the cache.
- **UUID text.** Every scoreboard team lookup of a living entity (`EntityLivingBase.getTeam`, e.g. each time a zombie checks a villager as a target) turned the entity's UUID into text again. Now the text is kept on the UUID with the two halves it was made from, and made again if either half is replaced. The game only reads it. It matters with many hostile mobs (375,480 texts kept in the medium scene below, 12 in the usual load test).
- **Packet hand-over.** Each packet for a player was handed from the game thread to the host thread on its own: one `postMessage` (about 1.4 µs) and the player channel's name made into text again. During entity tracking, which sends most of the packets (all entity movement), a player's packets are now kept and handed over together when entity tracking ends: one message per player per tick, about 40 packets in the medium scene, the same packets in the same order. Packets sent at any other time go at once, as before, after anything kept for that player. The host's own channel (log lines, status, a player's channel closed) is never kept, and a message on it hands over what is kept first, so it never overtakes a packet sent before it. The host passes the packets on one by one, as before. The cost is a short wait for the packets kept (below).
- **64-bit constants** (added 2026-10-30). The game's Java code uses 64-bit constants all the time: the multiplier and mask of `java.util.Random` in every random number, the mask in a chunk's 64-bit key, the hash constant of the lighting engine's position sets. TeaVM writes each one as a call that builds the value from its two 32-bit halves, right where it is used: 7,014 places, 1,075 values. In Node, 64-bit numbers are BigInts, and each such call took about eight BigInt operations. That was 8 % of the game thread in fresh terrain: in terrain, biomes, structures and lighting alike. Now each constant is made once, by the same call, when the game code loads. A BigInt cannot be changed, so every expression gets the value it got before. The terrain threads' copies of the game code get it too. In the load test in fresh terrain on 4 cores the game thread was busy 57 % of the time instead of 64 % (3 runs each), with 19 instead of 41 ticks over 250 ms a run; on 1 core it kept the server at 20 ticks a second where the old code fell to 0.6-2.5 (see "Chunk work in fresh terrain").
- **The lighting engine's position sets** (added 2026-10-30). When a block's light may have changed, the lighting engine (EaglercraftX's port of Alfheim) queues block positions to check, and keeps a hash set of the positions queued so each is queued once (`LongHashSet` from the HPPC library). That set's hash keeps a position's height out of the bits that choose its slot: in any set below a million slots, all 256 heights of a block column share one slot. Lighting a new chunk queues runs of heights column by column, so each new position stepped past the others first: about 20 steps a position, each two comparisons of 64-bit numbers. The sets the lighting engine makes for its queues now use a hash that mixes every bit of the position (0.1-0.3 steps a position). A set holds the same positions whatever its hash, so the engine queues the same positions in the same order. The engine never reads a set in slot order: it only adds to it, then empties or replaces it. Every other set of that kind keeps the game's hash, among them the chunks waiting to be unloaded, which the game does go through in slot order. In the load test in fresh terrain on 4 cores (3 runs each) the game thread was busy 46 % of the time instead of 57 % with speedup 4 alone, with 4 instead of 19 ticks over 250 ms a run, and the time behind went from 21.7 s to 9.6 s; a new chunk's first lighting took 1.5 s in 100 s instead of 12.3 s (see "Chunk work in fresh terrain"). In a verify run, 23.9 million adds to lighting sets were checked against a plain set kept beside each: none differed.
- **Collision boxes of other entities** (added 2026-10-30, **off by default**: `"collisionScan": true`). An entity that moves asks the world for the collision boxes in its way: the blocks', then those of the entities near it, which the game found by going through every entity of the chunk sections around it. Only a boat has a box of its own, and only a moving boat or minecart takes another entity's box, so for any other mover that walk adds nothing unless a boat is in one of those sections. Each section already keeps a list of its entities of each class the game asks about; with the speedup on, boats are one of those classes from the start. The walk is left out when the mover is neither a boat nor a minecart and none of the sections it would go through has a boat. With 1,000 entities in one area the mean tick went from 54-57 ms to 47 ms (from 79-92 % of the ticks over 50 ms to 18-21 %); with 500 in one area from 22.3-22.4 to 20.2-20.9 ms; with fewer, or spread over four areas, no measurable difference. In a verify run 2,499,561 walks left out were made anyway: none would have added a box. See "Many entities in one place".

Two more came with stage 8, both off by default: *encode once* and the *packed hand-over* (see "Stage 8: more cores, exactly the same game").

**Checked: the same results.** In verify mode (`EAGLAN_DEBUG_SPEEDUPS_VERIFY=1`, or `test/bench/load.js --speedups-verify`) the game also computes its own answer for every chunk lookup and UUID text the speedups give, makes every 64-bit constant again where it is used and compares, checks every add to a lighting set against a plain set kept beside it, makes every entity walk the collision scan leaves out and checks whether any entity it finds would have given a box, and counts every difference. The game numbers each player's packets, kept or not, and the host counts every gap or step back:

| Verify run (load test, 12 players) | Chunk lookups from the cache | UUID texts kept | Packets handed over together | Differences / order errors |
|---|---|---|---|---|
| Medium mob scene (below) | 142.75 million of 148.93 million | 375,480 | 1.72 million in 43,904 messages | 0 / 0 |
| Usual load test, 3 players exploring (chunks loaded and unloaded all the time) | 83.21 million of 90.16 million | 1,190 | 250,294 in 36,234 messages | 0 / 0 |
| Medium mob scene again, with the final code (a message on the host's own channel hands over what is kept first) | 139.73 million of 146.11 million | 354,512 | 1.71 million in 43,942 messages | 0 / 0 |

Every player stayed in the world in every run (12 of 12, 16 runs), and the players received the same amount of data with the speedups off and on.

**Measured** on 2026-10-29 on the build machine (Windows 10, Node 24.19) with the load test, off and on in turns, 3 runs each, mean (range).

*Medium mob scene:* 12 players near spawn in the pre-generated world, 60 zombies chasing 40 villagers that take no damage, 100 animals (`--mobs 60,40,100`, see "Entity processing"), about 450 entities:

| | Off | On |
|---|---|---|
| Game thread busy | 57 % (55-60) | 46 % (43-47) |
| Tick time p50 | 22.3 ms (20.9-23.8) | 16.0 ms (15.2-16.6) |
| Tick time p95 | 54.3 ms (52.6-56.4) | 47.9 ms (44.8-50.8) |
| Tick time p99 | 80.2 ms (76.5-83.5) | 72.1 ms (71.0-72.7) |
| Longest tick | 146 ms (133-167) | 115 ms (113-116) |
| Ticks over 50 ms (of about 2,300) | 157 (142-184) | 104 (88-122) |
| Time behind in 115 s | 2.5 s (2.1-2.8) | 1.6 s (1.5-1.6) |
| Whole process CPU | 1.26 cores (1.22-1.30) | 1.10 cores (1.03-1.14) |
| Network thread busy | 40 % (36-44) | 34 % (30-37) |
| Game thread garbage collection | 536 ms a minute | 383 ms a minute |
| Memory (RSS) | 679 MB (653-709) | 678 MB (658-714) |
| Data the players received | 41 MB | 41 MB (40-41) |
| Player messages a second (both ways) | 11,595 (11,340-11,908) | 11,460 (10,687-12,148) |

*Usual load test* of "Lag with many players": 12 players, 3 of them exploring, natural mobs only:

| | Off | On |
|---|---|---|
| Game thread busy | 44 % (42-45) | 40 % (39-40) |
| Tick time p50 | 11.4 ms (11.0-12.1) | 9.4 ms (8.9-9.8) |
| Tick time p95 | 55.7 ms (54.1-57.7) | 54.1 ms (52.9-54.9) |
| Tick time p99 | 82.8 ms (81.0-86.2) | 80.3 ms (79.4-81.5) |
| Longest tick | 144 ms (124-160) | 147 ms (130-165) |
| Ticks over 50 ms | 177 (154-198) | 155 (146-168) |
| Time behind in 115 s | 2.9 s (2.4-3.5) | 2.4 s (2.3-2.6) |
| Whole process CPU | 0.56 cores (0.54-0.57) | 0.52 cores (0.51-0.53) |
| Game thread garbage collection | 361 ms a minute | 319 ms a minute |
| Memory (RSS) | 679 MB | 678 MB |
| Data the players received | 29 MB | 29 MB (28-29) |
| Player messages a second (both ways) | 1,583 (1,510-1,622) | 1,460 (1,391-1,512) |

In the usual load test the longest ticks and most of the p95 come from loading chunks for the explorers, which the speedups do not touch. The player messages varied from run to run with what the mobs did: entity status packets, for example, from 617 to 12,839 in a run. In the third pair the players' packets were also counted by type: 1,613 a second off, 1,633 on. The verify run, which gives the speedups' answers but runs slower, had 1,614 messages a second.

**Where the saving comes from** (CPU profiles of the game thread, 100 s of the medium scene, first pair; the new code's own time included):

| Game thread time in 100 s | Off | On |
|---|---|---|
| Chunk lookups by 64-bit key (with the cache) | 8.47 s | 2.89 s |
| UUID text for team lookups | 2.15 s | 0.01 s |
| Handing packets to the host (with the keeping) | 2.86 s | 1.06 s |
| Entity tracking, all of it | 4.71 s | 2.14 s |
| Busy | 54.7 s | 46.3 s |

Each one saves time by itself: 5.6 s, 2.1 s and 1.8 s in 100 s. The busy time went down by 8.4 s (the rest of the work varies a little between runs). Garbage collection went down too: fewer 64-bit number objects and texts to collect.

**The wait for kept packets.** The first packet kept in a tick waited 0.85 ms on average until entity tracking ended, 5.2 ms at most (medium scene); 0.47 ms and 2.5 ms in the usual load test. In the medium scene the median tick got 6 ms shorter. A tick is 50 ms, and a player's own route adds 100-340 ms (see "Network performance").

**Switching.** Speedups 1-5 are on by default. The collision scan is on only with `"collisionScan": true` as well: it is new, and stays off by default until it has run on real servers for a while. `"speedups": false` in `data/config.json` turns all six off at the next world start, and the game runs as before; with `"gamePatches": false` they are off too. `node cli.js status` has a `speedups:` line, e.g. `chunk lookups (96 % from the cache), UUID text (100 % kept), 64-bit constants (1075 made once for 7026 places), lighting sets (465748 made with a hash that spreads heights), packet hand-over (38 packets a message while tracking entities, the first held 0.8 ms on average, 5.2 ms at most)`, and with the collision scan on `collision scan (100 % of the walks for the entities near a moving one left out)`. For measurements, `EAGLAN_DEBUG_SPEEDUPS` (a list of `chunkCache`, `uuidText`, `packetBatch`, `longConstants`, `lightSets` and `collisionScan`; empty: none) overrides the config; in the load test `--speedups all|none|<list>` and `--collision-scan`.

## Multi-core game simulation: what this engine allows (measured)

**Result: the game's simulation can use more cores only where the world can be divided into regions that cannot affect each other, each run by its own game instance (the model of Paper's Folia). Inside one busy area it cannot be split on this engine.** The first part of it, regions in one world, is built (off by default, see "Regions" below); the details, conflicts and costs are in `measurements/parallel/report.md`.

**Why.** The game server is Minecraft 1.8.8's integrated server compiled to one JavaScript program, on one thread; every world, chunk, entity, path and inventory is a JavaScript object in that thread's memory. JavaScript threads cannot share objects, only copies or raw bytes. So any simulation on another core needs its own copy of what it reads, and has to hand back what it changes, inside the tick. Measured in the mob scene: updating a zombie takes 38 µs; copying its state out and back in with the game's own save code takes 54 µs, in the same thread, before it could even be handed to another one. Splitting the entities of one area over threads would cost more than it shares out, and would change the game's order (an update would no longer see what the updates before it did in the same tick: pushes, hits, item pickups, new entities, the world's random numbers).

**What does work: regions.** Players far apart (in u53, 320 blocks or more with view distance 4) cannot affect each other within a tick: an entity is only updated while the 32 blocks round it are loaded, a zombie's path search reads 51 blocks, a chunk is loaded when something asks for it. Their areas can run in separate game instances at the same time, each one exactly the game's own simulation, and the result is the same as one after the other. When groups meet, their regions merge into one instance (its players are moved the way a BungeeCord network moves players between servers: a short "Downloading terrain"; groups that part are moved apart the same way); world-wide things (chat, tab list, time, weather, commands, settings, sleeping, scoreboard) go through the host.

**Measured: the same workloads on 1, 2 and 4 cores** (`measurements/parallel/run-cores.sh`; the host on whole cores, `test/bench/load.js --host-cores`; 12 players; "4 servers" runs each group of 3 on its own host and copy of the world, the upper bound of regions before their coordination):

| Workload | Host cores | TPS | Tick p50 / p95 / p99 / longest | Behind in 115 s | Game thread busy | Host CPUs busy | Memory (RSS; game heap) |
|---|---|---|---|---|---|---|---|
| Together: one arena at spawn | 1 | 20.2 | 18.2 / 74.7 / 118 / 379 ms | 10.2 s | 63 % | 94 % | 636 MB; 397 MB |
| | 2 | 20.1 | 15.3 / 47.0 / 72.7 / 268 ms | 1.7 s | 46 % | 41, 55 % | 691 MB; 430 MB |
| | 4 | 20.0 | 15.3 / 47.2 / 69.3 / 112 ms | 1.4 s | 44 % | 34, 37, 39, 33 % | 705 MB; 450 MB |
| Far apart: 4 groups and arenas, one server | 1 | 20.0 | 18.4 / 67.0 / 110 / 269 ms | 6.6 s | 55 % | 72 % | 714 MB; 433 MB |
| | 2 | 20.0 | 15.0 / 56.8 / 85.3 / 162 ms | 3.1 s | 46 % | 28, 43 % | 745 MB; 435 MB |
| | 4 | 20.0 | 15.8 / 56.5 / 80.6 / 129 ms | 2.6 s | 46 % | 28, 35, 27, 23 % | 723 MB; 455 MB |
| Far apart, each group on its own game instance (4 servers) | 1 | 20.1 | 5.6 / 54.3 / 163 / 759 ms | 10.8 s | 31, 28, 31, 28 % | 84 % | 2,222 MB; 1,394 MB |
| | 2 | 20.0 | 5.2 / 24.4 / 51.4 / 143 ms | 0.6 s | 17, 16, 16, 17 % | 45, 49 % | 2,089 MB; 1,378 MB |
| | 4 | 20.0 | 4.6 / 20.5 / 47.9 / 220 ms | 0.7 s | 15, 14, 15, 13 % | 31, 30, 28, 25 % | 2,262 MB; 1,512 MB |

For "4 servers" the ticks of the four are pooled (each player feels its own server's) and "behind" is the worst of them. Every player stayed in every run (12 of 12), and the entity counts at the start and the end matched (325-491 entities).

- **Together in one place, the game thread is the limit.** 2 cores help over 1 (the game thread no longer shares its core with the network thread and the garbage collector's helpers); 4 give nothing more (tick p95 47 ms on both, the game thread 44-46 % busy).
- **Far apart, but one server: the same.** The same players and mobs in four groups 512-724 blocks apart: p95 57 ms on 2 cores and on 4.
- **Far apart, one game instance per group: the ticks run at the same time.** On 2 and 4 cores the median tick was 4.6-5.2 ms instead of 15-16 ms, p95 20-24 ms instead of 57 ms, and 0.6-0.7 s behind instead of 2.6-3.1 s. On 1 core it is worse than one server (the four game threads take turns: p99 163 ms, longest 759 ms), so instances must not outnumber the cores. Each extra instance costs about 350 MB of game heap (1,512 MB for four against 455 MB for one; the RSS is higher here because the four were separate hosts with their own runtimes).
- These four servers had separate copies of the world and no coordination: this is what regions can give at most. Regions in one world (see "Regions") come close to it.

### Regions (`regions`, off by default, experimental)

`"regions": true` in `data/config.json` (at the next world start) runs groups of players who are far apart on game instances of their own: each one a worker thread running the game, in the host's one process, so that their ticks run on separate cores at the same time. Inside an instance everything is the game's own simulation (`src/regions.js`, `src/region-cells.js`, `src/region-gate.js`, `src/region-data.js`, the game patches "regions: instance hooks" and "regions: more broadcasts").

- **Who gets an instance of their own:** a group of players 384 blocks or more from every other player for 20 s, while its instance has other players: the group is moved to a region instance of its own while playing (below). And a player who joins 320 blocks or more from every other player and from the world spawn, by the saved position. Players saved near the world spawn join the main instance (it reads the spawn's top block for every player who joins it, so it needs that area; before, after a restart the first one there got a region instance, and the whole group there was moved into the main instance a minute later). Up to one region instance per CPU left over (`regionInstances` sets another number, 0-15); with none left, players stay where they are. New players join the main instance, which has `level.dat` and the world's data files (and the spawn chunks when the game rule `loadSpawnChunks` is on; u53 has it off).
- **When groups meet:** once players of two instances are within 320 blocks of each other, the smaller group is moved to the other one's instance (of two the same size, the group in the main instance moves; near the world spawn the region instance's group comes into the main instance); a region instance without players stops. Of a main instance's groups far apart, the one at the world spawn stays.
- **Moving a player between instances**, without a new join, the way a BungeeCord network moves players between servers: the client gets a respawn into another dimension, which clears its world and shows "Downloading terrain"; the old instance lets the player go and saves them, and hands over the cells round them; the new instance gets the player's own login again and gives them the same entity ID; its JoinGame becomes a second respawn, into the player's dimension, and the client's settings are sent to it again. The player keeps position, inventory, health, effects and experience (the player's file), and what they ride: the game saves it with the player and seats them on it again in the new instance, as when a player leaves and joins again (tested with a boat, moved into the main instance and out again: one boat in the world each time); an animal on a lead is in the cells handed over with the player and finds them again, as after a join. "Left the game", "joined the game" and the tab-list removal of the move are not shown (only those: a player who leaves the game right after a move is seen leaving), and the client shows the entities round the player at once (game patch "entities shown with their chunk", below). Nothing said is lost: chat and the other world-wide messages sent while the player moves reach them right after the move, and what they type meanwhile (chat, a command) is said in the instance they arrive in. Not taken along: an open chest or crafting window (closed; what was in the crafting grid or on the cursor is dropped, as on leaving). A move that fails asks the player to join again. A player who teleports or respawns into an area another instance has is brought together with the players there in one instance (into the main instance when it is one of the two, otherwise into the one that has the area), and only the players near that place move: the rest of their instance stays (a player who dies far away and respawns at the world spawn goes alone, and the others of their group stay where they are).
- **The distances** (view distance 4; they grow with it) are the larger of the x and z distances, as loaded areas are squares. An instance asks for chunks round its players up to the view distance and 3 chunks more (path searches, mob spawning; measured below: 4 chunks from the nearest player for most chunks, 5-6 for some, rarely 7; `reach` in the status). 320 blocks keeps what two instances may ask for apart: on each side the player's chunk and that reach rounded out to whole cells (144 blocks), plus 32 blocks. A group moves off on its own only at 384 blocks, so that a group at the edge does not go back and forth.
- **The world stays consistent:** chunks are owned per cell of 32 x 32 blocks (2 x 2 chunks) by one instance, in the storage layer through which the game reads and writes every chunk. An instance asks the host before it reads a chunk of a cell it does not have, and gives cells back once their chunks are saved and unloaded. No chunk is ever loaded by two instances: an instance that reaches a cell another one has (a teleport, a respawn, a far throw) gets an empty chunk there and its players near that cell, with the players near them, are moved at once into the instance that has the cell (all of them when nobody is near it; decided on the instance's next positions, at most a second later); the main instance waits instead, and the region instance's players near the cell come to it. Region instances write only their own chunks and their players' files. Entity IDs come from a separate range in each instance.
- **Three corrections to u53 with regions on** (game patch "regions: instance hooks"; without regions the game is as before), all places where the game asks for chunks far from every player: the cave sound's light check, which Minecraft 1.8 makes in chunk 0,0 instead of in the chunk it ticks, so that every instance kept asking for chunk 0,0 (now the chunk it ticks, as in Minecraft 1.9 and later); the villages' search for doors round a place a villager was a moment ago, now skipped when that chunk is no longer loaded (it loaded again the chunks a group had just taken to another instance); and the search for a spawn place at the world spawn for a player who is being moved in (their saved position replaces it; an ordinary join still makes it, as the game does). Found with `EAGLAN_DEBUG_CHUNKS=far`, which logs the game's call chain for every chunk asked for 10 chunks or more from an instance's players.
- **A correction to u53 for everyone** (game patch "entities shown with their chunk", with or without regions): when the game sends a player a chunk, it shows them the entities in it, but only those of chunks the player no longer waits for; Minecraft 1.8.8 takes the chunk off that list first, u53 only afterwards, so none was shown. An entity that does not move (a boat, an item frame, an armor stand, a mob or player standing still) stayed unseen by a player who had just joined, respawned, teleported or been moved to another instance, until one of the two went 4 blocks. Measured with connected players standing still, one world: a player who joined next to 3 boats and an armor stand saw none of them (now all 4); one teleported next to 2 armor stands saw neither (now both); with regions, after a move, 8 of the entities round the player shown instead of 17, and the boat next to them missing. Found by the stage 7 tests.
- **World-wide:** chat, join and leave messages, deaths, achievements, `/say` and `/me`, the tab list (the game's broadcasts also go to the players of the other instances: TeaVM put a copy of the game's loop over the players into each place that broadcasts, and each of the eight is hooked), world time and weather (the main instance's, every second), game rules, the OP list, LAN game mode and cheats, the multi-core mode. Console commands: world-wide ones (`time`, `weather`, `gamerule`, `difficulty`, the scoreboard's objectives and teams, ...) and those with `@a` or `@e` in every instance (each acts on its own players and entities; the console gets the answers of all of them), `say` and `me` with the players of every instance for `@a`, a bare `@p` (the player nearest to the world's origin, where the console is) or `@r` picked by the host among the players of every instance, `list` with the players of every instance, a command about a player (`tp Bob ...`, `execute Bob ...`) in that player's instance, the rest in the main one.
- **Commands players type:** `/tell` (`/msg`, `/w`) to a player of another instance is shown to both as the game shows a whisper; `/list` lists the players of every instance; a command with a selector of all players or all entities (`/give @a ...`, `/effect @e[type=Zombie] ...`; not one limited to an area round the player, nor one with `~`) of a player who may use it also runs in the other instances; a world-wide command (as above) of a player who may use commands also runs in the other instances (coordinates relative to the player made absolute: `setworldspawn`, `worldborder center`), so that `/time set` in a region instance holds (the main instance's time was put back over it every second); `/tp` to or from a player of another instance goes to that player's coordinates, after which the two instances become one; any other command about a player of another instance (`give`, `effect`, `kill`, `gamemode`, ...) runs in that player's instance, and its answer comes back to the one who typed it.
- **Sleeping:** the night is over once every player in the overworld of every instance sleeps (5 s in bed), as the game decides it for one world: the main instance sets the morning, every instance wakes its players and ends rain. A player alone in bed in one instance no longer skips the night for the others. With the game rule `playersSleepingPercentage` (see "Game Rules"), that share of the players of every instance (spectators aside) is enough.
- **Maps, villages, structures:** a new map's id comes from one count (the main instance counts; the region instance's game waits for it as it waits for a file), so no two maps share an id; a map held in two instances keeps what each one drew: an instance that writes a map's file puts the pixels it changed since it read the file onto the stored one (`src/region-data.js`), and the instance a player moves into reads its maps again, so the player sees what was drawn elsewhere (tested: two players drawing one map in two instances, the saved map has both areas). The world's other data files are merged when written: the structures of every instance are kept (their union), and the villages of the instance that has had their chunks for two minutes.
- **The scoreboard:** objectives and teams change by commands, which run in every instance; a score that changes in one instance (a command, a kill, a death, health) is set in every other at once, without a command; a new region instance starts from the scoreboard saved just before it.
- **When a region instance fails:** if its thread ends on its own (a crash), its players are disconnected with "this part of the world stopped unexpectedly; join again", the others see them leave (tab list, "left the game"), its cells are free for the others at once, the host logs it, and the players join again where they were last saved (what changed there since its last autosave, at most 45 s, is lost).
- **Nothing waits without end:** an instance that asked the host for a cell and got no answer asks again after 10 s; the main instance waits at most 10 s for a cell another instance holds (then that instance goes into the main one) and at most a minute (then it is stopped); a game thread that has not ticked for 15 s is logged with what it waits for (files, cells, questions to the host), every 30 s until it ticks again.
- **Not the same as one server:** a player's command with a selector limited to an area (`@a[r=20]`, `@e[dx=...]`), with `@p` or `@r`, or with `~` coordinates acts in that player's instance only, as do `/tp`, `/execute` and `/tell` with a selector; a command about a player of another instance with `~` coordinates is not passed on (except `/tp`, whose coordinates are the target's own); `say @a` typed by a player names the players of their instance (the console's names everyone); two players drawing one map in two instances see each other's drawing once one of them moves into the other's instance or the world starts again (the saved map has both); two instances changing the same score at the same moment end with the change that reached the host last; the commands' feedback to the OPs (`[Bob: Given ...]`) reaches the OPs of the same instance only, a death message a team hides from the others only the dying player's instance, and a change of game mode (`/gamemode`) the other instances' tab lists only once that player moves or joins again.
- **Memory:** about 350-400 MB per region instance.

**Measured, players joining far apart (stage 2)** on 2026-10-29 (`measurements/parallel/run-regions.sh`, `tables-regions.js`): the "far apart" workload above (12 players in 4 groups 512-724 blocks apart, each group with its own arena), the host on 1, 2 and 4 whole cores, in one world with `regions` on. The players joined, went to their groups, left, and joined again 25 s later. Ticks of all instances pooled; "behind" of the worst instance:

| Host cores: how | Tick p50 / p95 / p99 / longest | Behind (worst instance) | Game threads busy | Host CPUs busy | RSS; game heap | Players per instance |
| --- | --- | --- | --- | --- | --- | --- |
| 1 core: one server | 18.4 / 67 / 109.8 / 269 ms | 6.6 s | 55 % | 72.3 % | 714 MB; 433 MB | main: 12 |
| 1 core: regions | 16.6 / 56.7 / 82 / 178.4 ms | 2.8 s | 46 % | 58.6 % | 907 MB; 469 MB | main: 12 |
| 1 core: 4 separate servers | 5.6 / 54.3 / 163.1 / 758.8 ms | 10.8 s | 31, 28, 31, 28 % | 83.7 % | 2222 MB; 1394 MB | 4 x 3 |
| 2 cores: one server | 15 / 56.8 / 85.3 / 161.7 ms | 3.1 s | 46 % | 27.7, 42.8 % | 745 MB; 435 MB | main: 12 |
| 2 cores: regions | 10.3 / 39.3 / 71.5 / 143.9 ms | 1.6 s | 37, 16 % | 37.5, 43 % | 1188 MB; 839 MB | main: 9, r1: 3 |
| 2 cores: 4 separate servers | 5.2 / 24.4 / 51.4 / 142.6 ms | 0.6 s | 17, 16, 16, 17 % | 44.6, 49.1 % | 2089 MB; 1378 MB | 4 x 3 |
| 4 cores: one server | 15.8 / 56.5 / 80.6 / 128.5 ms | 2.6 s | 46 % | 27.7, 34.5, 26.5, 22.8 % | 723 MB; 455 MB | main: 12 |
| 4 cores: regions | 4.3 / 20.7 / 48.7 / 141.6 ms | 0.4 s | 14, 15, 13, 14 % | 27.4, 30.9, 28.7, 27.6 % | 1940 MB; 1397 MB | main: 3, r1: 3, r2: 3, r3: 3 |
| 4 cores: 4 separate servers | 4.6 / 20.5 / 47.9 / 219.5 ms | 0.7 s | 15, 14, 15, 13 % | 30.8, 30.3, 27.5, 24.5 % | 2262 MB; 1512 MB | 4 x 3 |
| 2 cores: regions, 3 region instances allowed | 5.2 / 25.9 / 53.8 / 176.2 ms | 0.9 s | 16, 17, 19, 17 % | 50.6, 48.7 % | 1951 MB; 1431 MB | main: 3, r1: 3, r2: 3, r3: 3 |

- With 4 cores, one world with regions gave the ticks of four separate servers: the median tick 4.3 ms instead of 15.8, p95 20.7 ms instead of 56.5, 0.4 s behind instead of 2.6 s. The coordination (cells, broadcasts, time and weather) cost nothing measurable.
- With 2 cores, the default (one region instance) helped everyone: the 9 players in the main instance had p50 12.6 ms and p95 48.9 ms, the 3 in r1 4.2 and 27.8 ms. Allowing 3 region instances on 2 cores was better still here, as each instance was lightly loaded; heavily loaded instances on too few cores are worse than one server (the 1-core row of "4 separate servers" above), which is why the default is one per CPU left over.
- With 1 core there is no CPU to spare and no region instance: as one server (the difference is within the variation from run to run).
- Every player stayed in every run (12 of 12), with no merge, no player asked to join again and no refused cell; the entity counts at the start and the end matched (463-483).
- Measured again after the stage 3 changes (cells of 2 x 2 chunks, the distances and the corrections of u53 above). In that batch two runs stalled, the 1-core one (its game thread waited about 3 minutes, its worker idle) and the 4-core one (all four instances at once for about 10 s); run again they gave the figures above (the stalled ones are kept as `regions-1.stall.*` and `regions-4.stall.*`). Not explained.

**Measured, groups moved while playing (stage 3)** on 2026-10-29 (`measurements/parallel/run-moves.sh`, `tables-moves.js`): the same workload, nobody joining again: the players joined at spawn and went to their groups together, and the groups were moved to region instances of their own while playing (20 s after they were far from everyone; one region instance per CPU left over); then measured 115 s:

| Host cores: how | Tick p50 / p95 / p99 / longest (pooled) | Behind (worst instance) | Game threads busy | RSS; game heap | Players per instance at the end | Moves | Downloading terrain per move, median / longest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 core: one server | 18.5 / 66.5 / 109.8 / 269 ms | 6.6 s | 55 % | 714 MB; 411 MB | main 12 | - | - |
| 1 core: regions, players rejoining (stage 2) | 16.6 / 56.7 / 82 / 178.4 ms | 2.8 s | 46 % | 907 MB; 469 MB | main 12 | - | - |
| 1 core: regions, groups moved while playing | 17.9 / 64.7 / 100.4 / 218.7 ms | 5.4 s | 52 % | 873 MB; 426 MB | main 12 | 0 moved, 0 failed (0 split, 0 merged) | - |
| 2 cores: one server | 15 / 56.8 / 85.3 / 161.7 ms | 3.1 s | 46 % | 745 MB; 437 MB | main 12 | - | - |
| 2 cores: regions, players rejoining (stage 2) | 10.3 / 39.3 / 71.5 / 143.9 ms | 1.6 s | 37, 16 % | 1188 MB; 839 MB | main 9, r1 3 | - | - |
| 2 cores: regions, groups moved while playing | 10.3 / 37.9 / 67.3 / 170.1 ms | 1.8 s | 38, 17 % | 1125 MB; 772 MB | main 9, r1 3 | 3 moved, 0 failed (1 split, 0 merged) | 1536 / 1546 ms |
| 4 cores: one server | 15.8 / 56.5 / 80.6 / 128.5 ms | 2.6 s | 46 % | 723 MB; 430 MB | main 12 | - | - |
| 4 cores: regions, players rejoining (stage 2) | 4.3 / 20.7 / 48.7 / 141.6 ms | 0.4 s | 14, 15, 13, 14 % | 1940 MB; 1397 MB | main 3, r1 3, r2 3, r3 3 | - | - |
| 4 cores: regions, groups moved while playing | 4.4 / 23.3 / 47.9 / 140.6 ms | 0.5 s | 15, 13, 16, 13 % | 1921 MB; 1480 MB | main 3, r1 3, r2 3, r3 3 | 9 moved, 0 failed (3 split, 0 merged) | 1314 / 1456 ms |

**Traveler** (between the first group and 800 blocks east of spawn, every 30 s; its first trip, into new terrain, before the measured time), 4 cores:

| How | Tick p50 / p95 / p99 / longest (pooled) | Each instance: p95 / longest | Behind (worst instance) | Ticks over 250 ms | Traveler moved (Downloading terrain) | All moves |
|---|---|---|---|---|---|---|
| one server: Traveler teleported | 16.4 / 58.3 / 87.4 / 516.6 ms | main 58.3 / 516.6 | 4.2 s | 2 | - | - |
| regions: Traveler moved between instances | 4.4 / 23.8 / 51 / 873 ms | main 30.3 / 635.3; r1 18.2 / 100.8; r2 20.5 / 81.1; r3 23.9 / 123.3; r4 6.5 / 873 | 2.2 s | 5 | 4 (1111, 617, 1206, 736 ms) | 13 moved, 0 failed, 2 merged, 196 chunk requests denied |

- With 4 cores, groups moved while playing gave the ticks of players rejoining: p50 4.4 ms and p95 23.3 ms (20.7 rejoining), 0.5 s behind (the worst instance). The 3 splits came 10 s apart in the warmup; each of the 9 players saw "Downloading terrain" for 1.2-1.5 s and stayed connected; no move failed. With 2 cores, one group moved: p95 37.9 ms. With 1 core there is no region instance.
- Traveler, one more player who goes back and forth every 30 s between the first group and 800 blocks east of spawn (4 cores, 4 region instances allowed for it): with regions it was moved 4 times (twice to an instance of its own, twice back into the main instance; "Downloading terrain" 0.6-1.2 s), and nobody else moved. Everyone's ticks: p50 4.4 / p95 23.8 ms against 16.4 / 58.3 with one server, 2.2 s behind against 4.2 s. A move costs about what a teleport costs in one server: the instance a player arrives in loads their area (its longest tick 873 ms; one server's 517 ms); the instances of the other groups were not affected (longest ticks 81-123 ms). Each return first asked for chunks of the main instance (196 refused: the empty chunk) and then moved Traveler's instance into the main one, as designed.

**Measured, the world-wide state (stage 4)** on 2026-10-30 (`measurements/parallel/stage4-*.json`), the same workload on 4 cores with groups moved while playing: with the stage 4 code the ticks were those of stage 3 (p50 4.2 / p95 22.7 / p99 49.8 / longest 145 ms, against 4.4 / 23.3 / 47.9 / 141; 0.5 s behind in the worst instance either way). Copying scores, at its worst: `scoreboard players add @a kills 1` from the console back to back (about 80 score changes a second, each set in all four instances): p50 4.9 / p95 24.5 / p99 50.2 / longest 167 ms, 0.7 s behind; the game threads 16-17 % busy instead of 13-15 %, the host's network thread 23 % instead of 16 %.

**Tested in play (stage 7)** on 2026-10-31 (`measurements/regions7/live.js`, `live.log`, `report.md`): ten connected players (protocol-level bots) on one host, 3 region instances allowed, 8 minutes: groups walking away and back and teleported far and back, chat, a whisper, `/list`, the tab list, time, weather and a game rule set by a player, a player joining and leaving while others are in region instances, `/me`, deaths both ways (one far away: back at the world spawn alone, the rest of the group stays), an OP's `/give @a`, the console's `@e` and `say @a`, `/tp` to a player of another instance, players joining far away, a far player leaving and coming back, a restart with players spread out (each where they were, nobody moved), a region instance ending abruptly, and two more minutes of walking. Two runs on the final code passed all 36 checks each: 12 moves per run, none failed (median 447 and 449 ms, longest 1.0 s of "Downloading terrain"), nobody asked to join again, no stall, no crash, and at the end every tab list held exactly the players in the world. Found on the way, each having passed the earlier tests, and fixed (`report.md` has each one): joins, leaves, deaths, achievements, `/say` and `/me` were not shown in the other instances; after a move the other instances lost that player from their tab lists; a crashed instance's players stayed in them; an entity next to a player who had just arrived was not shown (u53: correction "entities shown with their chunk"); a player who left right after a move was not seen leaving; chat said while a player was being moved was lost for them, and what they typed meanwhile; a player who died far away took their group along; after a restart the players at the spawn were moved a minute after joining.

Tests: `test/regions.test.js` (without the game), `test/regions-daemon.test.js` (the real daemon and game: a player who goes far away is moved to a region instance of their own while playing, and back into the main instance when they return, still connected, with the same entity ID and inventory; chat both ways, the tab list, `time set` and `weather rain` across the instances; a block placed in each instance, both in the saved chunks; the world starts without regions afterwards), `test/regions-world.test.js` (the real daemon and game, Alice in the main instance and Bob in a region instance: `/tell`, `/list`, `/time set` and `/gamerule` typed in the region instance holding everywhere, console `@a` and `@r`, `/give` to a player of the other instance, sleeping (Alice alone in bed: still night; both: the next morning for both), a new map in each instance with different ids and both files saved, the scoreboard both ways and a reset, `/tp` to a player of the other instance) and `measurements/parallel/client-move.js` (the unmodified u53 client in headless Chrome: moved to a region instance of its own and back into the main instance while it plays, in 1.0 and 1.2 s, and still in the game afterwards: its inventory opens, its chat reaches the server, it walks; screenshots in `measurements/parallel/client-move-shots`). Stage 7: `test/regions-play.test.js` (the real daemon and game: Bob, far away in a region instance of his own, is shown the boat that stood next to him before he was moved and rides it while he is moved into the main instance and out again, one boat in the world each time; the console's `@e` answers for every instance; Bob's `/give @a` reaches the others; the console's `say @a` names everyone and everyone sees it, as Bob's `/me`; two players drawing one map in two instances, the saved map has both areas; Bob's instance ends abruptly: he is disconnected with a message, the others see him leave and join again, and he comes back where he was saved, with his map; Bob dies in his instance: the others see the death message, and he comes back at the world spawn, in the main instance), `measurements/regions7/live.js` (above) and `measurements/regions7/client-move.js` (the client test above with the stage 7 code: moved in 0.9 and 0.3 s, still in the game, its chat after the moves reached the host).

**Stage 5** (2026-10-30), the chunk work inside each instance: see "Chunk work in fresh terrain". The terrain and biomes of the chunks players are about to reach are made on terrain threads (`terrainForPlayers`, off by default); the game's 64-bit constants are made once and the lighting engine's position sets use a hash that spreads heights (speedups 4 and 5, on by default).

## Chunk work in fresh terrain (stage 5, measured)

**Result.** When players reach terrain nobody has made yet, the longest ticks come from making, lighting and loading chunks. Three exact changes came out of measuring where that time goes:

- **The game's 64-bit constants are made once** (speedup 4, see "Speedups on the game thread"): on by default with the other speedups.
- **The lighting engine's position sets use a hash that spreads a block's height** (speedup 5, the same place): on by default with the other speedups. A new chunk's first lighting takes an eighth of the time it took.
- **The terrain threads also make the terrain and biomes of the chunks players are about to reach** (`terrainForPlayers`, off by default). It needs a second CPU (the other logical CPU of the same core was enough) and 190-420 MB of memory.

Measured with the load test in fresh terrain (12 players, 3 exploring; table below). On 4 cores the ticks over 250 ms went from 41 a run before stage 5 to 19 with speedup 4, 4 with speedups 4 and 5, and none with the terrain thread as well; the time the game ran behind from 28.5 s to 21.7 s, 9.6 s and 5.7 s (in 115-120 s); the 99th-percentile tick from 306 to 237, 186 and 109 ms; and the longest from 846 to 616, 557 and 238 ms. On 2 cores and on the two logical CPUs of one core it went the same way (29.8 and 33.3 s behind before, 6.3 and 8.8 s with all of it). On 1 core, where the terrain thread cannot run, the old code fell behind during the joins and did not catch up for minutes in either run (0.6 and 2.5 ticks a second over the measured time). With speedup 4 both runs held 20 ticks a second, and with speedups 4 and 5 they were 13.4-13.9 s behind: less than the old code on 4 cores.

Decoration and lighting stay on the game thread: no other thread could do them exactly (below).

**Where the time went** (CPU profile of the game thread, 100 s of the load test of "Lag with many players" in fresh terrain: 12 players, 3 of them exploring at 8 blocks/s; 4 cores, multi-core mode off; one run each):

| Game thread, 100 s | Before | Speedup 4 | Speedups 4 and 5 | Speedup 4 and terrain thread |
|---|---|---|---|---|
| Busy | 71.7 s | 58.7 s | **47.1 s** | 54.9 s |
| Making a new chunk, all of it | 9.3 s | 5.0 s | 5.3 s | **1.1 s** |
| - its noise terrain | 2.2 s | 1.3 s | 1.4 s | 0.05 s |
| - its surface (grass, sand, snow) | 2.0 s | 1.2 s | 1.3 s | 0.06 s |
| - its biomes | 2.7 s | 0.8 s | 1.0 s | 0.04 s |
| - its caves, ravines and structure starts | 1.4 s | 0.8 s | 0.8 s | 0.2 s |
| - the chunk object from all that | 0.9 s | 0.9 s | 0.9 s | 0.8 s |
| A new chunk's first lighting | 13.5 s | 12.3 s | **1.5 s** | 12.0 s |
| Decoration (trees, ores, lakes, animals) | 5.4 s | 4.5 s | 3.8 s | 4.3 s |
| Loading a saved chunk: reading it (decompress, NBT, the chunk object) | 2.3 s | 2.0 s | 2.0 s | 2.1 s |
| Loading a saved chunk: its structures recreated | 3.1 s | 1.0 s | 1.2 s | 1.1 s |
| JavaScript zlib for chunk packets (the multi-core mode moves it to other cores) | 6.3 s | 5.8 s | 5.8 s | 5.8 s |
| Making 64-bit constants (`Long_create`), all of it | 6.0 s | 0 | 0 | 0 |
| Garbage collection | 2.0 s | 1.7 s | 1.0 s | 1.7 s |
| Busy stretches over 250 ms (the long ticks): number, time | 68, 47.9 s | 58, 27.1 s | **33, 16.3 s** | 43, 19.1 s |

With the terrain thread, the noise and surface left on the game thread are the chunks it makes itself: every 32nd (compared) and those no thread had ready. With speedups 4 and 5, half of what is left of the long stretches is making and decorating new chunks (27 % and 20 %).

**What can run elsewhere, exactly, and what cannot:**

- **Terrain and biomes:** a chunk's noise terrain, surface, caves, ravines and biomes depend only on the world's seed and the chunk's position. With `terrainForPlayers`, the terrain threads make them for the chunks players are about to reach. The game copies them in and goes on from there (below).
- **A chunk's first lighting** (`Chunk.func_150809_p`, EaglercraftX's port of the Alfheim lighting engine): 97 % of it queued sky-light checks for the chunk's columns into the world's lighting queues. Those are a hash set of 64-bit block positions plus a list. The queues are shared with every light change in the world, and what gets queued depends on the heights of the neighbouring chunks at that moment, which decoration and players change. Another thread could only work on a copy and would have to hand back the same entries in the same order: no gain.
  - **What made it slow** was the set: its hash (HPPC's `BitMixer.mixPhi`, a 64-bit multiply) leaves a position's height in the bits above the 20th, so every set smaller than a million slots put all 256 heights of a column in one slot, and queuing a column's gap probed quadratically. Speedup 5 gives the lighting engine's own sets a hash that spreads the heights, on the game thread: 12.3 s → 1.5 s in 100 s.
- **Decoration:** a chunk's trees, lakes and ores reach into its neighbours and depend on what they hold, so the order in which chunks are loaded decides the result. Not exact elsewhere.
- **Loading saved chunks:** decompressing and reading the NBT is 1.3 s in 100 s (1.8 %). Building the chunk makes game objects, which only the game thread can hold. Most of the rest was the structures recreated for each loaded chunk, mostly making 64-bit constants: speedup 4.
- **The 64-bit constants** were 8 % of the game thread, in terrain, biomes, structures and lighting alike: speedup 4.

**The terrain threads for players** (`src/terrain.js`; the game's side is the "terrain threads" correction in `src/game-patches.js`):

- Every 250 ms the game thread looks at the overworld's players. For each one it takes the way the player will go in the next 4 s at their speed of the last second. The chunks of the player's view along that way that are neither loaded nor saved are asked of the terrain threads, the sooner-needed ones first.
- A player standing still asks for nothing. A teleport or respawn counts as a jump: only the view where the player landed is asked for. A thread makes a chunk in about 10.6 ms (19.8 ms on the other logical CPU of the game thread's core).
- When the game makes one of those chunks, it copies in the thread's terrain and biomes and skips its own noise, surface, caves, ravines and biome lookup. The structures, decoration and lighting run as before.
- **Checked:** every 32nd chunk is not used. The game makes it itself and compares, block by block and biome by biome; a difference switches the threads off until the world restarts and is logged. With `"terrainVerify": true` every chunk is compared and none is used.
- The threads start when a player first reaches new terrain (about 2.6 s to load their copy of the game code; meanwhile the game makes those chunks itself). They end a minute after the last chunk asked for players (10 s after a job), and their memory is given back. While a pre-generation job runs, its chunks come first.
- The same rules as for jobs apply: not for flat or debug worlds, and only with a CPU to spare besides the game thread's. With regions, each instance has its own threads for its own players.
- The game thread's own cost for the players mode was 0.1 s in 100 s.

**Measured** on 2026-10-30 on the build machine (Windows 10, Node 24.19): the load test in a world with little terrain made (`measurements/lag/fresh-12345.sqlite`), 12 players, 3 exploring, 115-120 s measured after 75-105 s of joins and teleports. The host was on 4, 2 and 1 whole cores (`--host-cores`, one logical CPU of each core) and on the two logical CPUs of one core (CPUs 0 and 1, as many 2-vCPU plans), with the multi-core mode off. "Before" is the code before stage 5 with speedups 1-3, as they were on by default. Several runs of one setting are pooled (`measurements/chunks/run-stage5.sh`, `run-stage5-ht.sh`, `run-lh.sh`, `run-lt.sh`, `tables-stage5.js`).

| Host cores: code (runs) | TPS | Tick p50 / p95 / p99 / longest | Ticks over 100 / 250 ms (a run) | Behind (in 115-120 s) | Game thread busy | Process CPU | Memory (RSS) | New chunks (a run) | Players in |
|---|---|---|---|---|---|---|---|---|---|
| 4 cores: before stage 5 (3) | 20.1 | 9.9 / 129 / 306 / 845.6 ms | 171 / 41 | 28.5 s | 64 % | 0.78 cores | 772 MB | 444 | 36/36 |
| 4 cores: 64-bit constants (3) | 20.1 | 9.4 / 115.4 / 236.7 / 616.1 ms | 151 / 19 | 21.7 s | 57 % | 0.71 cores | 807 MB | 436 | 36/36 |
| 4 cores: 64-bit constants + lighting sets (3) | 20 | 9.1 / 65.8 / 185.9 / 556.8 ms | 54 / 4 | 9.6 s | 46 % | 0.59 cores | 760 MB | 469 | 36/36 |
| 4 cores: 64-bit constants + terrain thread for players (3) | 20 | 9.2 / 109 / 185.4 / 478.1 ms | 140 / 12 | 18 s | 54 % | 0.7 cores | 1103 MB | 419 | 36/36 |
| 4 cores: all of it: both speedups + terrain thread (2) | 20 | 8.6 / 62.7 / 108.5 / 238.4 ms | 36 / 0 | 5.7 s | 41 % | 0.56 cores | 972 MB | 444 | 24/24 |
| 2 cores: before stage 5 (1) | 20.2 | 10.1 / 123.2 / 323.9 / 894.8 ms | 168 / 46 | 29.8 s | 66 % | 0.77 cores | 664 MB | 451 | 12/12 |
| 2 cores: 64-bit constants (1) | 20.1 | 9.9 / 122.2 / 253.8 / 559.3 ms | 168 / 26 | 24.6 s | 60 % | 0.67 cores | 775 MB | 424 | 12/12 |
| 2 cores: 64-bit constants + lighting sets (1) | 20.1 | 9.3 / 65.9 / 199.5 / 320.4 ms | 58 / 6 | 10.3 s | 47 % | 0.55 cores | 721 MB | 465 | 12/12 |
| 2 cores: 64-bit constants + terrain thread for players (1) | 20.1 | 9.7 / 112.9 / 203.1 / 464.7 ms | 149 / 12 | 19.2 s | 56 % | 0.67 cores | 967 MB | 434 | 12/12 |
| 2 cores: all of it: both speedups + terrain thread (1) | 20 | 9.3 / 63.3 / 128.5 / 216.7 ms | 41 / 0 | 6.3 s | 43 % | 0.56 cores | 974 MB | 448 | 12/12 |
| 2 CPUs of one core: before stage 5 (1) | 19.7 | 12.1 / 132.6 / 369.7 / 765.3 ms | 187 / 49 | 33.3 s | 70 % | 0.82 cores | 748 MB | 414 | 12/12 |
| 2 CPUs of one core: 64-bit constants (1) | 20.1 | 10.2 / 127.4 / 261 / 625.9 ms | 182 / 29 | 27.3 s | 63 % | 0.72 cores | 839 MB | 445 | 12/12 |
| 2 CPUs of one core: 64-bit constants + lighting sets (1) | 20.1 | 10.5 / 73.6 / 198 / 416.1 ms | 68 / 10 | 12.2 s | 50 % | 0.62 cores | 715 MB | 448 | 12/12 |
| 2 CPUs of one core: 64-bit constants + terrain thread for players (1) | 20 | 11.1 / 115.8 / 218.4 / 452.9 ms | 157 / 15 | 20.8 s | 59 % | 0.75 cores | 1047 MB | 440 | 12/12 |
| 2 CPUs of one core: all of it: both speedups + terrain thread (1) | 20 | 12 / 67.8 / 145.8 / 431.9 ms | 59 / 2 | 8.8 s | 49 % | 0.65 cores | 1023 MB | 463 | 12/12 |
| 1 core: before stage 5 (2) | 1.6 | 307 / 2463.9 / 3006.7 / 3133.8 ms | 117 / 96 | 107.7 s | 100 % | 0.93 cores | 762 MB | 340 | 24/24 |
| 1 core: 64-bit constants (2) | 19.8 | 11.9 / 140.8 / 295.8 / 1599.1 ms | 193 / 37 | 30.9 s | 69 % | 0.65 cores | 692 MB | 435 | 24/24 |
| 1 core: 64-bit constants + lighting sets (2) | 20.1 | 11.6 / 80.1 / 208.8 / 477 ms | 81 / 17 | 13.6 s | 53 % | 0.55 cores | 695 MB | 480 | 24/24 |

- The players wait for terrain, as the real client does, so the ticks per second stay near 20 while the server keeps up. The lag shows in the long ticks and in "behind": the time the game ran late, added up over the measured time.
- 4 cores: 3 runs of each setting (2 of "all of it"); the first of each of the other four settings also recorded the CPU profile above, which slows the game thread a little. 2 cores and 2 CPUs of one core: one run each; 1 core: two.
- On 1 core, before stage 5, both runs fell behind during the joins and teleports and stayed there: 2-20 ticks in 5 s instead of 100, ticks of 1-3 s, for 3-4 minutes (the second was starting to recover at the end). With speedup 4 both runs had the same rough start and were back at 100 ticks in 5 s within about 30 s. No player was kicked in any run.
- On the two logical CPUs of one core the terrain thread took 19.6-19.8 ms a chunk instead of 10.1-10.6 ms, and still helped. For pre-generation jobs that setup made things worse (see "Terrain threads for pre-generation"): a job keeps the game thread busy all the time, while in play it waits between ticks.

**Correctness:**

- **Every chunk compared** (`terrainVerify`, terrain thread for players, 4 cores, one run): the thread made 1,973 chunks ahead of the players. All 1,901 that the game then made were identical to the thread's, block by block and biome by biome.
- **Spot checks** in the runs with the thread on: in the nine measured runs with the thread on, the game used 16,486 of its chunks, all with their biomes, and compared 528 of them, none different.
- **Speedups 4 and 5 in verify mode** (one 4-core run): every add to a lighting set was checked against a plain set kept beside it, 23.9 million adds to 416,293 sets, none different; every 64-bit constant was made again where it is used and compared, none different.
- `test/terrain-daemon.test.js` (the real daemon and game): a player walks into new terrain with `terrainVerify`, and every chunk is the same. After a restart without it, the thread's chunks are used with their biomes and none differs. The chunks along the way are saved, populated and lit.
- `test/speedups.test.js`: each of the 7,014 places of speedup 4 gets the value the original call gives, and the rest of the code is byte for byte the same. The game's own set code, patched, holds the same keys as a plain set through 30,000 random adds, lookups and removes with growing, with either hash.

**What it costs:** Speedups 4 and 5 need no thread. With speedup 4 alone the game thread's heap was about 45 MB larger at the end of the runs (it collected garbage less often); with speedup 5 too, the whole process's memory was as before stage 5 or less (760 against 772 MB on 4 cores, 715 against 748 MB on 2 CPUs of one core), and it used less CPU (0.59 against 0.78 cores on 4 cores, 0.55 against 0.77 on 2). The terrain thread for players: 190-420 MB more memory (RSS at the end of a run; the thread's own heap 189 MB), and about the same CPU for the whole process (0.56 against 0.59 cores with both speedups on 4 cores, 0.65 against 0.62 on the two CPUs of one core). Its 10 ms a chunk replaces work the game thread no longer does.

**Switching.** Speedups 4 and 5 are two of the speedups (`"speedups": false` turns them all off; `EAGLAN_DEBUG_SPEEDUPS` without `longConstants` or `lightSets` turns one off alone). The players mode: `"terrainThreads": 1, "terrainForPlayers": true` in `data/config.json`, applied at the next world start. `node cli.js status` shows it on the `terrain:` line (e.g. `1 terrain thread for pre-generation and players: on; 1923 chunks made (10.5 ms each, 1923 for players), 1801 used (1801 with their biomes), 58 compared (58 the same), 169 made by the game itself`) and the speedups on the `speedups:` line.

**Recommendation:** nothing to do for speedups 4 and 5: they are on by default. Together they took the time behind from 28.5 s to 9.6 s on 4 cores, and on 1 core from a server that did not catch up for minutes to 13.4-13.9 s. Turn on `terrainForPlayers` (with `"terrainThreads": 1`) where players explore terrain nobody has made, on a server with at least 2 CPUs and about 400 MB of memory to spare: on top of the speedups it took the ticks over 250 ms from 4-10 a run to 0-2 and the time behind from 9.6-12.2 s to 5.7-8.8 s, on 4 cores, 2 cores and the two CPUs of one core. Pre-generating the world (see "Pre-generating the world") still does the most for exploring players: with the terrain made beforehand, none of this work happens while they play.

## Many entities in one place (stage 6, measured)

**Result.** The question was whether the movement, mob AI and pathfinding of one crowded area can run on several cores. On this engine no part of it can, exactly, for a worthwhile share of the work (below). What came out of measuring it instead is a single-thread change with the same results: **the collision scan** (speedup 6, `"collisionScan": true`, **off by default** until it has run on real servers). With 1,000 entities in one area it took the mean tick from 54-57 ms to 47 ms in both pairs of runs: from a server that fell behind all the time (79-92 % of the ticks over 50 ms) to one that mostly keeps up (18-21 %). With 500 in one area the mean tick went from 22.3-22.4 to 20.2-20.9 ms and the game thread was busy 43-44 % of the time instead of 47 %. With 250 or fewer per area, and with 500 or 1,000 spread over four areas, the difference was within what runs of the same code differ by.

**Where the time goes** (CPU profiles of the game thread with the arenas of the load test, all speedups 1-5 on; `measurements/entities6/report.md`): with 250-1,000 entities in one area, entities are 69-90 % of the game thread's work. Inside that: the AI's target and goal tasks 16-17 %, following paths 12-18 %, path searches 9-10 %, movement 18-26 % and, in it, the collision-box queries 16-33 %. Most of those queries' time was one wasted walk: for each moving entity the game went through every entity of the chunk sections around it, looking for collision boxes that only boats have: 4.5 % of the game thread with 100 entities in one area, 8.2 % with 250, 15.3 % with 500 and 26.1 % with 1,000.

**What could run on other cores, and why it does not** (Phase A of the report):

- **Choosing targets, goals, flee and wander decisions, following paths, movement, pushing:** each reads what other entities did earlier in the same tick (positions, motion, health), draws the mob's own random numbers in the order of the tick, or has side effects (pressure plates, damage, sounds, a push that moves both entities at once). On another thread, or in another order, they would see other states. They stay on the game thread.
- **Path searches** are the only pure computation: blocks, the mob's size and position and the target's position decide the path, with no random numbers. They are 7.5-12.6 % of the game thread, but only a chase's search can be known a tick ahead (1.8-3.3 %): flee and wander targets are drawn inside the same update. A worker would also need the blocks in shared memory and every block change counted (copying a zombie's search range: 6.1 MB, 649 µs). At best 2-3 % of the game thread would move to another core: not worth its risk and memory.
- **Entity tracking** is independent once every entity has moved, but its packets must keep the game's order, and it is 5-7 % of the game thread.
- And the engine itself: JavaScript threads share no objects, only copies (see "Multi-core game simulation").

**The collision scan** (speedup 6, `src/game-patches.js` "speedup: collision scan"):

- An entity that moves asks the world for the collision boxes in its way (`World.getCollidingBoundingBoxes`, from `Entity.moveEntity` and from following a path): first the blocks' boxes, then the boxes of the entities near it. To find those entities the game goes through every entity of the chunk sections (16 x 16 x 16 blocks) within 2 blocks of the box.
- In the game code only a boat has a box of its own that others bump into, and only a boat or minecart that moves takes the box of an entity it meets. For every other entity both give none. A test checks this in the vendored `classes.js`: the four kinds of the first and the three of the second.
- So when anything else moves, the walk adds a box only if a boat is in one of the sections it goes through. Each section already keeps a list of its entities of each class the game asks about, and the game itself keeps those lists up to date whenever an entity enters or leaves the section. With the speedup on, boats are one of those classes from the moment the game starts, before the first chunk exists.
- The walk is left out when the mover is neither a boat nor a minecart and none of the sections it would go through has a boat: the same chunks and sections, worked out the same way. Otherwise it runs as before. Instead of going through the entities of a section, the check looks up one list in it.
- The game gets the same boxes in the same order, and nothing else changes: the walk only reads.

**Measured** on 2026-10-30 on the build machine (Windows 10, Node 24.19): the load test in the pre-generated world with the arenas of stage 6 (`--mobs-only --players-still`: only the arenas' entities, the players in place; a quarter zombies chasing villagers that take no damage, the rest animals, skeletons, creepers, spiders and dropped items), 12 players (3 with 1,000 in one area), the host on 4 whole cores, 110-120 s measured, a CPU profile of the game thread in each run. Each pair ran back to back, the game's own walk first; the three largest ran again in the other order (`measurements/entities6/run-cs.sh`, `run-cs2.sh`, `tables-cs.js`, `table-cs.md`). Game's own walk → collision scan:

| Entities | Pairs | Game thread busy | Mean tick | Tick p95 | Ticks over 50 ms |
|---|---|---|---|---|---|
| one area, 100 | 1 | 14 → 13 % | 5.9 → 5.6 ms | 6.8 → 6.5 ms | 4 → 3 of 2,301 |
| 4 areas, 100 | 1 | 19 → 18 % | 8.0 → 7.8 ms | 12.5 → 11.9 ms | 4 → 3 of 2,300 |
| one area, 250 | 1 | 24 → 24 % | 11.1 → 10.7 ms | 12.8 → 12.4 ms | 4 → 4 of 2,300 |
| 4 areas, 250 | 1 | 26 → 26 % | 11.9 → 11.8 ms | 15.5 → 19.8 ms | 6 → 6 of 2,401 |
| one area, 500 | 2 | 47 → 44 % / 47 → 43 % | 22.3 → 20.9 / 22.4 → 20.2 ms | 27.7 → 24.8 / 27.6 → 25.2 ms | 2 → 3 / 3 → 3 of 2,300 |
| 4 areas, 500 | 1 | 43 → 43 % | 20.3 → 20.2 ms | 32.2 → 32.9 ms | 6 → 9 of 2,300 |
| 4 areas, 1,000 | 2 | 92 → 81 % / 81 → 80 % | 45.2 → 39.7 / 40.0 → 39.5 ms | 54.5 → 47.4 / 49.4 → 48.1 ms | 295 → 65 / 101 → 82 of 2,310-2,340 |
| one area, 1,000 (3 players) | 2 | 100 → 96 % / 100 → 93 % | 56.9 → 47.5 / 54.2 → 46.7 ms | 67.1 → 53.3 / 63.2 → 55.5 ms | 92 % → 18 % / 79 % → 21 % of the ticks |

- With 1,000 in one area the game thread was over its limit without the scan, and its 5-second reports came late, so the measured window of those runs was short (20-100 s) and their ticks per second and time behind cannot be compared; their tick times (1,800-2,313 ticks each) and CPU profiles can.
- With 1,000 over four areas, the game's own walk ran 92 % busy in one pair and 81 % in the other (90 % in stage 6's first measurement); the scan ran 80-81 % in both. That scenario varies from run to run more than the scan changes it.
- Where the time went (seconds of the game thread in the 100 s profiled): the walk was 0.5-25.9 s and is gone in every run; the check costs 0.2-1.7 s. With 1,000 in one area the collision-box queries went from 32.7-32.8 s to 8.6-9.3 s.
- Pushing (`collideWithNearbyEntities`) took longer with the scan: 2.3 → 4.7-4.8 s in 100 s with 500 in one area, 8.5-9.0 → 19.7-22.1 s with 1,000. Right after the collision query it goes through nearly the same entities, the same number of times. The walk left out had just brought them into the CPU's caches; now pushing fetches them itself. The work is gone (the game's walk code itself: 4.1 → 2.1 s with 500, 17.2 → 9.5 s with 1,000), but part of its memory traffic moved to pushing. That is why the saving is small with few entities.
- Memory: the game thread's heap at the end of a run differed between the two runs of a pair by -57 to +201 MB, both ways, as garbage collection happened to fall. The scan itself adds one entry to each loaded chunk section: about 1-2 MB here.

**Correctness:**

- **Verify mode** (`EAGLAN_DEBUG_SPEEDUPS_VERIFY=1`): every walk the scan leaves out is made anyway, and every entity it finds is tested as the game tests it. In the load test with 500 in one area: 2,499,561 walks left out, none of which would have added a box. In `test/entities-daemon.test.js` (the real daemon and game: a crowd of zombies, villagers and animals with boats in one corner and minecarts in another): 219,638 walks left out and none different; 25,681 kept for a boat in reach and 13,764 for a moving boat or minecart. That held while the boats were killed and summoned again, after the arena's chunks were unloaded and loaded again (new sections, the boats in their lists again) and after a restart. In every run and test, every section knew boats.
- `test/speedups.test.js` runs the game's own walk (`getEntitiesInAABBexcluding`, `Chunk.getEntitiesWithinAABBForEntity`, the entities' box methods, taken from `classes.js`) over 8,000 random moves among boats, minecarts and other entities. The walk was left out exactly when no section walked had a boat. In each of those moves no entity the walk found would have given a box, and the scan looked up the same chunks and sections as the walk.
- The unmodified u53 client (`measurements/entities6/client-cs.js`: headless Chrome, a local relay, verify mode, creative mode): the client's player stood, then walked, inside a ring of 8 boats on a stone floor among 20 zombies, 10 villagers, 12 animals and 2 minecarts. The client stayed in the game (inventory, chat, the walk), 59,716 walks were left out with none different, 81,257 were kept for a boat in reach, and the host log had no error.

**What it costs:** the check, 0.2-1.7 s in 100 s of the game thread in these runs (it looks up one list in each non-empty section the walk would visit); one entry in each loaded chunk section; and the cache effect on pushing above. Entity movement and the server's packets are the same.

**Switching.** `"collisionScan": true` in `data/config.json` (with `speedups` not `false`), at the next world start; `"collisionScan": false` (the default) turns it off again, and the game walks as before. `node cli.js status` shows it on the `speedups:` line, e.g. `collision scan (83 % of the walks for the entities near a moving one left out)` (in the test's arena with boats; 100 % in arenas without). For measurements: `EAGLAN_DEBUG_SPEEDUPS` with `collisionScan`, and `--collision-scan` in the load test.

**Recommendation:** turn it on (`"collisionScan": true`) on a server where many mobs crowd into one place: mob farms, big animal pens, a village under siege. There it is what keeps the server on time once the crowd reaches several hundred entities. With smaller crowds it made no measurable difference either way. It stays off by default until it has run on a real server with players for a while.

## Stage 8: more cores, exactly the same game (measured)

The question: which parts of the game's work can run on other cores while the game stays exactly Minecraft 1.8.8 as
u53 runs it: the same AI decisions, the same order, the same random numbers, the same packets in the same order and the
same saved world. Four paths were looked at, plus the network thread, and regions with pre-generation and with every
other option. The full report is `measurements/stage8/report.md`.

| | Result | Config (default) |
|---|---|---|
| Entity tracking and packet building | a packet the entity tracker sends to several players is made once; a player's packets of a tick handed over in one buffer. 1,000 mobs and 12 players: -19 % of the game thread | `encodeOnce`, `packedHandover` (`false`) |
| Pathfinding ahead of time | path steps (and chase searches) done on a thread of their own at the end of the tick before; used only when every input is unchanged. Steps: -1.3 to -2.2 % of the game thread with 1,000 mobs; searches: no gain | `pathAhead`, `pathAheadSearches` (`false`) |
| Network thread | the players' WebRTC connections in network processes; the host's thread only passes their packets on. 12 players, 1,000 mobs in view: 35,228 → 82,082 frames/s, `status` 4 s → 8 ms | `networkProcesses` (`0`) |
| Regions with pre-generation | pre-generation leaves out the cells a region instance owns | (with `regions`) |
| Entity updates in parallel | not built: an exact version would be slower (below) | - |
| Decoration ahead (lighting: not built) | decorations run ahead on a thread and replayed in order only when nothing they read has changed; exact, but no measurable gain | `decorationAhead`, `decorationAheadPregen` (`false`) |

Each option is off by default, can be switched on and off on its own (`data/config.json`, then restart), and with it
off the game runs its own code as before. The speedups line of `node cli.js status` names each one that is on, with
how much it was used, and `network processes` has a line of its own.

### How "exactly the same" is checked: the equivalence harness

`node test/harness/run.js <scenario> <out> [--config JSON]` runs a scenario with the real host and game in a
deterministic mode that exists only for tests: every unseeded random number comes from a seeded generator, the game's
clock is virtual, the host runs the game one tick at a time and the scenario's players act between ticks. After every
tick it hashes the game state (the next entity ID, every world's time and random generators, every entity's ID, class,
position, motion, rotation, random generator, age and dead flag), every packet every player receives, and at the end
every file of the saved world. `node test/harness/compare.js A B` names the first tick, packet or file that differs.
Two runs of the original are identical; with another seed they differ from the first tick. Scenarios: a crowd (zombies
chasing villagers, animals, players watching), players exploring fresh terrain and digging, and block updates across a
restart. `test/harness-equivalence.test.js` checks all of this in `npm test`.

### Entity tracking and packet building (`encodeOnce`, `packedHandover`)

With many players watching many entities, most packets are entity movement: the tracker sends the same packet object
to every player who sees the entity, and the game encoded it once for each of them. With `encodeOnce`, inside one such
loop the frame made for the first player is copied for the next (same packet, same connection state and compression,
nothing in between: the same bytes; frames up to 1,024 bytes). With `packedHandover`, the frames a player gets during
entity tracking go into one buffer per player and the hand-over to the host thread is one buffer and the frames' ends
(before: one `ArrayBuffer` per frame, each moved out of V8's heap); the host cuts them apart in the same order.

Why the tracking itself stays on the game thread: it reads and changes game state every tick (each tracker entry's last
sent position, the entities' watched data and its "changed" flags), which a thread would need copied first. What it
cost that could go without changing anything was making the same packet again for each player and the hand-over.

Measured with the harness (crowd of 1,000 mobs watched by 12 players, 400 ticks; 3 runs per configuration in turns;
game-thread time per tick over the last 80 % of the ticks; "paired": the median of the per-tick differences against
the original of the same round, since every tick has the same work in both runs). Every run was identical to the
original (every tick's state, every packet, every world file):

| | Mean per tick | p95 | Paired difference |
|---|---|---|---|
| Original | 59.9 ms (59.6-60.0) | 83.4-84.8 ms | - |
| `encodeOnce` + `packedHandover` | 48.8 ms (48.3-49.0) | 67.4-67.8 ms | -9.7 to -10.0 ms (-19 %) |
| + `pathAhead` + `pathAheadSearches` | 46.5 ms (46.1-46.8) | 65.6-66.4 ms | -10.6 to -12.0 ms (-21 to -23 %) |
| + `collisionScan` (stage 6): every exact option | 42.9 ms (42.6-43.0) | 59.9-61.1 ms | -14.6 to -15.5 ms (-29 to -30 %) |

92 % of the tracker's frames were copied instead of encoded; in CPU profiles, entity tracking went from 12.3 % to
5.9 % of the game thread's busy time and the packets sent (`sendPacket`, partly inside tracking) from 14.4 % to 8.3 %. In verify mode (`EAGLAN_DEBUG_SPEEDUPS_VERIFY=1`) every
copied frame is made again and compared: 4,426,298 compared, none different. In fresh terrain (players exploring) the
options change nothing measurable (paired median +0.1 and 0.0 ms over 1,213 ticks).

### Pathfinding ahead of time (`pathAhead`, `pathAheadSearches`)

Each tick, every mob that follows a path checks how far along its path it can walk straight (`pathFollow`): a walk over
the blocks between it and the next points. It depends only on the blocks, the path, the mob's size and where it stands,
and a mob stands where its last move left it. So at the end of each tick the game hands every path-following mob's
inputs to a thread of its own (`src/path-worker.js`, its own copy of the game code, reading the game's block arrays
in shared memory), which runs the game's own `pathFollow` while the game does the rest of the tick. When the mob's AI
then calls it, the game uses the thread's answer only if every input is still the same (the path object, index and
length, size, water flag, exact position) and every chunk the thread read is loaded and unchanged since; otherwise it
does it itself. With `pathAheadSearches`, the chase searches (`EntityAIAttackOnCollide`) that will run in the next tick
are foreseen the same way and searched on the thread by the game's own path finder; the game rebuilds the same path
from the thread's points only when the target, the mob and every chunk of the search region are as the thread had them.

Wander and flee searches are not foreseen (they start on a random draw in the same tick). Only mobs with a ground
navigator take part, and not those whose water check reads blocks (squids): the harness found that reading a block
from this code could load a chunk, which paused the game thread for good; fixed before any of the results here.

Measured with the harness (crowd of 1,000 mobs, 3 watchers, 600 ticks; 3 runs per configuration in turns; game-thread
time per tick over the last 80 % of the ticks; "paired": the median of the per-tick differences against the original
of the same round, since every tick has the same work in both runs). Every run was identical to the original:

| | Mean per tick | Paired difference |
|---|---|---|
| Original | 48.6 ms (48.4-48.6) | - |
| `pathAhead` | 47.7 ms (47.5-47.9) | -0.6 to -1.0 ms (-1.3 to -2.2 %) |
| `pathAhead` + `pathAheadSearches` | 47.4 ms (47.3-47.5) | against `pathAhead` alone: +0.05 to +0.31 ms (no gain) |

With 12 watchers, on top of encode once and the packed hand-over, both together saved another 1.0-2.1 ms per tick
(2.3-5.0 %). Of 274,507 path steps handed to the thread, 88 % were taken (the rest: a chunk read changed in the tick,
7.1 %, or an input changed, 3.1 %); the thread was busy 4.4 ms per tick. The chase searches were taken too (86 % of the
foreseen ones), but checking a search's inputs and every chunk of its region, and building the path from the thread's
points, cost about what the search costs: no measurable gain. **Recommendation:** `pathAhead` is a small, proven gain
where many mobs follow paths; leave `pathAheadSearches` off. The ceiling, all path following and chase searches moved
for free, would be 17 % of the game thread with 1,000 mobs (CPU profile); what the game thread still does for each
answer it takes (the checks) and the hand-out at the end of the tick eat most of it.

### Network processes (`networkProcesses`, 0-16)

Sending one WebRTC message costs about 24 µs of the sending thread (node-datachannel frames, encrypts and sends it
there), and node-datachannel works in one thread per process only. With 12 players and 1,000 mobs in view, that is far
more than one thread can send, and while the host's thread sends, its status, console and relays wait. With
`networkProcesses` n, the players' connections live in n processes (each new player in the one with the fewest), the
host's thread passes their packets on in batches (each player's packets in order, the game's bytes), and everything
else stays in the host (relays, joins, the game, status, console). A network process that ends takes its players'
connections with it (they can join again); a new one takes its place.

Measured (`test/bench/net-load.js`, 12 players in 4 bot processes on the same machine, 1,000 mobs in view, 60 s):

| | Frames sent per second | `status` answer | Every frame checked against the game's |
|---|---|---|---|
| Original | 35,228 | about 4 s (the host's thread was 97 s behind) | not possible (host stalled) |
| encode once + packed hand-over | 35,233 | about 4 s | - |
| + 2 network processes | 57,511 | p50 6.8 ms, max 15.5 ms | the same (4,892 checkpoints) |
| + 4 network processes | 82,082 | p50 7.9 ms, max 48 ms | the same (6,833 checkpoints) |

The 12 bots ran on the same 6 cores, so the frame rate is the machine's, not the limit: one network process sends
about 40,000 messages a second, so 240,000 a second needs about 6 network processes and the cores to run them.

### Regions with pre-generation and with the other options

With `regions` on, a pre-generation job (`pregen`) runs in the main instance and leaves out the cells a region
instance owns: it asks for each cell without waiting, never keeps a claim and never moves a player; `status` counts
the chunks left out (a later run fills them in). `test/regions-pregen.test.js`: 3,721 chunks in
226 s, 100 left out, nobody moved, no claim held. `test/regions-daemon.test.js` (players moved between instances while
playing, chat, tab list, time and weather, saves) passes with each stage 8 option on its own and with all of them
together (`EAGLAN_TEST_CONFIG`).

### With real clients

Two unmodified u53 clients at once (headless Chrome, local relay; `measurements/stage8/client-s8.js`) played with every
stage 8 option on, in verify mode: both joined, stood among zombies chasing villagers, opened their inventories, chatted
and walked, each player's connection in its own network process. 29,407 frames that encode once copied were made again
and compared, and 23,882 path steps and 1,639 path searches taken from the path thread were done by the game too and
compared: none different, and no packet out of order.

### Decoration ahead (`decorationAhead`, `decorationAheadPregen`; exact, no measurable gain)

A chunk's decoration (ores, lakes, trees, flowers, the animals) runs when the chunk and three neighbours are loaded,
inside the load of the last of them. With `decorationAhead` (players) or `decorationAheadPregen` (the pre-generation
job), a thread of its own runs ahead what the game is about to load: the next row of chunks a moving player's view will
add, or the next chunks of the job. It makes their terrain as the game will and runs each decoration their loads will
start, in the game's order, on copies of the chunks loaded now, recording every block write the decoration's own logic
makes. When the game reaches that decoration it replays the record (the writes through the game's own `setBlockState`,
the animals' spawning through the game's own function) only if everything the record read is unchanged: the same
chunks with the same contents and height maps, the same loaded chunks, no structure there, the same state of the
biomes' big tree generators. A decoration that reads light values (mushrooms, snow), touches chests or spawners, or
draws the world's random numbers is never replayed. Otherwise the game decorates the chunk itself. The correction is
added to the game code only with one of the two options on. `measurements/stage8/report.md` has the details,
including four ways in which a decoration depends on state outside its chunks (the big tree height limit, a liquid
spring's immediate updates, the structure maps' iteration seed, block states the game's numeric id does not keep),
all found by the harness and handled.

Identical to the original in the harness every time: players in fresh terrain (4 runs, about 230 decorations replayed
each), the pre-generation job (5 runs), with every other option, and with the terrain thread. Verify mode
(`EAGLAN_DEBUG_SPEEDUPS_VERIFY=1`: the game decorates every chunk itself and compares the record): 432 decorations
compared, none different.

Measured: no gain beyond the noise. Players in fresh terrain: 40.0 s of game-thread time without it, 39.5 s with it, but
the per-tick paired medians go both ways (+0.15, -1.60, +0.40 ms). Pre-generation of 625 chunks: 18.6 s, 18.5 s with it.
About 30 % of decorations are replayed; half of all of them read light values. Of a replayable decoration's cost, the
block writes are most, and a replay has to make every one of them again (2.6-2.9 ms per replay). **Leave both off.**

**Lighting in parallel: not built.** The lighting engine runs its queued updates when a light value is next read (mob
spawning, growth, AI), usually in the same tick as the change, over the light arrays of a chunk and its neighbours; a
thread would have to be waited for at that point.

### What was not built, and why

**Entity updates in parallel, committed in order.** Measured with the harness on a crowd of 1,000 (330,121 entity
updates): 55 % of updates read an entity already updated in the same tick (targets, collisions, pushing), 22 % were
pushed by one; with the updates cut into 4 parts for 4 threads, 36 % depend on another part. The world's shared random
generator and the global entity ID counter add more. Copying one entity's state takes 54 µs, its whole update 38 µs. An
exact version would redo a third or more of the updates in order after copying every entity: slower than the original.

## Where CPU and memory go (measured)

Measured on 2026-10-18 on Windows 10 with Node 24.19, to answer whether rewriting the host in another language (e.g. Rust) would help. `node cli.js status` shows the same split on any server (`load:` line). "Busy" is event-loop utilization (time not idle); it can read a little higher than CPU time.

**Real game, 3-4 unmodified u53 clients:**

| | Value |
|---|---|
| Whole process | 11-15 % of one core |
| Game thread (the Minecraft server) | ~10-12 % busy when settled; 25-42 % while a player joins (world generation, chunk sending) |
| Network thread (WebRTC callbacks, relays, messages to and from the game) | 0.8 % of one core over 285 s (CPU profile); our own host code in it: ~110 ms in 285 s |
| WebRTC library threads (encryption, SCTP, ICE) | a few % of one core |
| Memory, 3 players: 438-445 MB | game heap 202-225 MB + game arrays 49-52 MB (~60 %); runtime and libraries ~150 MB (~34 %); host JavaScript 17 MB (~4 %) |
| Web page server (separate process, optional) | ~57 MB |

**Inside the game thread** (CPU profile, 285 s, 3 players):
- 81 % is the game's own code.
- About 11 % of it is the JavaScript emulation of Java's 64-bit numbers (`Long_create`, `Long_shru`, ...), and about 3 % a JavaScript zlib. Most of the 64-bit work was chunk lookups, now mostly from a cache, and making the same 64-bit constants again and again, now made once (see "Speedups on the game thread").
- 4 % is garbage collection, and the storage layer (`idb-sqlite.js`) about 2 %.

The game is compiled Java (TeaVM), so this cost belongs to the game build, not to the host.

**Networking alone, many players:** the real `LANHost` and WebRTC stack, simulated players in another process, each sending and receiving the recorded traffic of a real session:

| Players | Messages/s | Network thread busy | Process CPU | Memory (RSS) | Delay added by the host, p99 / max |
|---|---|---|---|---|---|
| 1 | 143 | 1.1 % | 0.1 % | 78 MB | < 0.5 ms |
| 10 | 1,396 | 5.4 % | 4 % | 82 MB | < 0.5 ms |
| 20 | 2,729 | 9.6 % | 15 % | 87 MB | < 0.5 ms / 2 ms |
| 40 | 5,777 | 18 % | 25 % | 98 MB | < 0.5 ms / 2 ms |

That is about 35 µs per message on the network thread and about 0.9 MB per player. A player's own route adds 100-340 ms, and the game handles player input once per 50 ms tick.

**What this means:**
- **The limit is the game thread.** It is single-threaded and runs the compiled game (the multi-core mode only takes compression off it, see "Multi-core mode"). A host written in another language would still run the same compiled game in the same JavaScript engine, so the tick would not get faster. More cores speed up the simulation itself only for players far apart, each group on its own game instance (see "Multi-core game simulation").
- **Networking costs little.** The heavy work (encryption, SCTP, ICE, UDP) is already native C/C++ (libdatachannel). The JavaScript around it adds well under 1 ms.
- **Memory is mostly the game.** The Node runtime and host code are about 60 MB of a 440 MB process.

## Limitations

- One world hosted at a time per data directory.
- Join codes differ per relay; this is how the relay protocol works and can't be changed by the host. A relay also gives a new code each time it registers the world again after a lost connection (see "When the join code changes").
- OP works by player name only: Eaglercraft has no accounts (see "Console and OP"). u53 has no bans or whitelist.
- Voice chat is disabled on the host.
- **Linux has not been run.** No Linux runtime was available on the build machine (WSL disabled, Docker Desktop depends on it). Everything was tested on Windows 10 with Node 24.19. The code has no OS-specific paths. The linux-x64 WebRTC binary needs only glibc ≥ 2.30. `install.sh`, the systemd units and the Docker files have not been run on Linux.

## Tests

`npm test` runs the automated suite; the table lists it file by file, with the other test tools. The measurement scripts and reports named `measurements/...` in this README are kept apart from the project and are not included here.

| Command | What it does |
|---|---|
| `node --test test/multi-relay.test.js` | 25 tests against local mock relays (`test/mock-relay.js`, no internet): simultaneous registration, joins via different relays into one host, startup failures, timeouts, half-open sockets, drops and recovery (the new code reported with the code it replaced), several failing relays, config validation, incompatible handshakes, no duplicate registrations or sessions, clean shutdown, live reconfigure, session summaries, per-player round-trip time, send twice (off by default, live switch, through the relay, unreachable relay port), the player's first message sent the instant the join completes (10 joins), the failed-join line, send twice on a server without a public address, send twice with a fixed UDP port (two players on one port; an unreachable port reported after three joins), the player limit (the refusal message, nothing opened in the world, a raised limit lets the next player in) |
| `node --test test/redundant.test.js` | the send-twice relay alone: candidate rewriting, why no relay port could be offered (no public address / behind NAT), STUN corrections with valid signatures, forwarding and copying, unsigned checks dropped, a fixed port shared by players, a fixed port already in use, the NAT case with a fixed port |
| `node --test test/game-patches.test.js` | the in-memory game-code corrections: each applied exactly once to the vendored `classes.js`, the corrected code still parses, the file on disk unchanged, other code left alone and reported, the Game Rules hook skipped when any code it relies on differs |
| `node --test test/pregen.test.js` | world pre-generation, tick by tick as the hook does it: the order (rings round spawn, every chunk once), a chunk lit only once its eight neighbours are loaded, light populated only once theirs are lit, and handed back to the game's unloading only once every chunk within three of it is and no waiting lighting call needs it, every chunk within the radius light populated, about three rings loaded at a time; the hook (and the tick-time hook) applied once, and skipped when any game code it relies on differs |
| `node --test test/multicore.test.js` | the multi-core mode without the game: the frames a player gets (around the 65,280-byte limits, and parts that come out exactly even), the CPU detection (cgroup v1 and v2 quotas on the way to the root, affinity, pool sizes), the pool (jobs, a thread that dies: its jobs come back for redoing and it is replaced; 3 deaths: failed), every player's messages in order whatever order the compressions finish in, a failed pool switching the mode off with nothing lost, too few CPUs reported; the storage rules (stored gzipped, never raw; a read waits; the newest write wins; a delete wins; flush waits; gzipped here when the pool fails; a damaged header refused) |
| `node --test test/multicore-daemon.test.js` | the multi-core mode with the real daemon and game: two players get their chunks through the pool, a placed block is in its chunk file after an autosave (a file written through the pool), nothing stored uncompressed, the mode off and on while the players play, *Save now* waiting for the files being compressed, a stop and a restart in which the game finds all three placed blocks in the pool's files, and without the game hook (`gamePatches` false) the reason reported |
| `node --test test/pregen-step.test.js` | world pre-generation's own step, run tick by tick on stand-ins for the game (a clock, the tick schedule, chunks of 35 ms): with nobody on the server several chunks a tick, within the rate, the server on schedule; with players on it, or with `pregenFastWhenEmpty` false, at most one a tick and none while late; at most 16 a tick; every chunk once, in order, and every chunk within the radius lit and light populated |
| `node --test test/terrain.test.js` | terrain threads without the game: the game's side of the hook (run on stand-ins for the game's objects): off, a thread's terrain used once, every 32nd compared instead, a difference switching it off, with `terrainVerify` every chunk compared and none used, at most so many kept; a thread's biomes taken with its terrain as the game's own lookup gives them (in the game's array or a new one, an empty entry as the default), compared, a biome difference switching it off; the overworld's players; the thread's side applies to the vendored `classes.js`; the chunk file names and the job's order; the manager with stand-in threads: started by a job, the chunks ahead of it that are neither loaded nor saved, ended after it, not used without a CPU to spare or for a flat world, switched off by a thread that fails or by a difference; for players: the chunks of their view on the way they go (the column reached first first, not the loaded or saved ones, none for a player standing still, only the landing view after a jump), not asked twice, a player who left forgotten, started for them, fed as chunks come back, a job first, ended a while after the last chunk wanted |
| `node --test test/terrain-daemon.test.js` | terrain threads with the real daemon and game: a job with `terrainVerify` (every chunk the thread made the same as the game's own, block by block), a second job over the saved chunks (the thread asked for none), the thread ended after the job, then after a restart a job using the thread's terrain (every 32nd compared: the same) with every chunk of it saved, populated and lit; for players (`terrainForPlayers`): a player walking into new terrain with `terrainVerify` (every chunk made ahead of him the same as the game's own, blocks and biomes), then after a restart the thread's terrain and biomes used (every 32nd compared: the same), the chunks along his way saved, populated and lit |
| `node --test test/speedups.test.js` | the speedups on stand-ins for the game's functions: chunk lookups from the cache the same as the map's over 20,000 random loads, unloads and lookups (chunks 8 apart sharing a slot), off the map itself, verify mode counting a change the map did not count; a UUID's text made once and again when a half is replaced, off, verify mode counting a wrong text; a player's packets kept during entity tracking reaching the host in the order sent, one message per player, the host's channel never kept, a tracking phase that did not end, off; verify mode numbering each player's packets without a gap; how long the first packet kept waited; the three patches; the 64-bit constants: each of the 7,014 places in the vendored `classes.js` getting the value its own call gives (1,075 values, made once), the rest of the code byte for byte the same, the same results, verify mode counting a wrong constant, not applied to a method of that name or to other code, applied last over the patched game and in the terrain threads' copy; the lighting sets: the game's own set code (add, contains, remove, rehash, growing) holding the same keys as a plain set over 30,000 random operations, marked or not, verify mode counting no difference; a column's 256 heights over 240+ slots instead of 1; marked only while empty, and not when off; filling a set at least 3 times faster; the collision scan: in the vendored `classes.js` only a boat's own box and a moving boat's or minecart's box for another entity are not null, the patch not applied to a build that differs; the game's own entity walk (`World.getEntitiesInAABBexcluding`, `Chunk.getEntitiesWithinAABBForEntity`, the entities' box methods) over 8,000 random moves among boats, minecarts and other entities, in chunks loaded or not, empty, and sections that know boats or not: the walk left out exactly when the mover is neither a boat nor a minecart and no section walked has a boat or does not know boats, then never where an entity found gives a box, with the same chunks and sections looked up; the reasons to walk, verify mode counting a walk left out wrongly, the one empty list never changed, off |
| `node --test test/entities-daemon.test.js` | the collision scan with the real daemon and game, in verify mode (every walk left out made anyway and checked): a crowd of zombies, villagers and animals in an arena away from spawn, boats in one corner, minecarts in another; walks left out, walks kept for a boat in reach and for a moving boat or minecart, none left out wrongly, every section knowing boats; the boats killed (no walk kept for a boat any more) and summoned again; the arena's chunks unloaded and loaded again (the player, teleported back and standing still, is shown the boats there: the correction "entities shown with their chunk"); a restart; then without verify mode, and with the config as it comes (off: the game's own walk) |
| `node --test test/regions.test.js` | regions without the game: which cell a chunk file is in (cells of 2 x 2 chunks), the saved player's position, the login name, tab-list, JoinGame, respawn and chat frames, the empty chunk; who owns a cell; where a joining player goes (a new player and one near others: their instance; far from everyone: a new region instance, or main when none is left; the instance that has the cell of the saved position); which instances merge (the smaller group moves; of two the same size, the one in main); which groups move off on their own (far from everyone, not the largest; between 320 and 384 blocks neither; the larger of the x and z distances); where a console command runs; an instance's storage (a chunk of a cell it does not have read only after the host's answer, the empty chunk when another instance has it, its writes not kept, the world's files not written by a region instance; without regions as before); the gate asking again, the main instance's time limits, maps two instances write, commands across instances; who moves (players saved near the world spawn join the main instance, the group there stays in it, only the group near a cell another instance has goes into it, decided on that instance's next positions, a report made before a move not counted) and what a move hides (only its own leave and join); a moving player misses no chat (held for them, and what they say said once there) |
| `node --test test/regions-daemon.test.js` | regions with the real daemon and game: a player who goes far from everyone is moved, while playing, to a region instance of their own (no new join: a respawn and the new instance's world, the same entity ID, the inventory), and back into the main instance when they return (the region instance stops); chat both ways, the tab list, `time set` and `weather rain` across the instances, a command about a player in that player's instance, a block placed in each instance, both in the saved chunks; the world starting without regions afterwards |
| `node --test test/regions-world.test.js` | regions, the world-wide state, with the real daemon and game (Alice in the main instance, Bob in a region instance): `/tell` and `/list` across instances, a world-wide command typed in a region instance (`/time set`, `/gamerule`) holding everywhere, console `@a` (every instance) and `@r` (one player of all), `/give` to a player of another instance (and its answer back), the night skipped only when both sleep, two new maps with different ids and both files saved, scores set in one instance in the other (both ways, and a reset), `/tp` to a player of another instance (the two instances become one) |
| `node --test test/regions-play.test.js` | regions in play with the real daemon and game (stage 7, three players): a player far away in a region instance of his own is shown the boat that stood next to him before he was moved and rides it while he is moved into the main instance and out again (one boat in the world each time); the console's `@e` answers for every instance; an OP's `/give @a` reaches the other instance; the console's `say @a` names everyone and everyone sees it, as `/me`; two players drawing one map in two instances (the saved map has both areas); a region instance ending abruptly (its player disconnected with a message, seen leaving and joining again, back where he was saved); a death in a region instance (the others see it; back at the world spawn, in the main instance); no stall |
| `node --test test/regions-pregen.test.js` | regions with a world pre-generation (stage 8), the real daemon and game: one player at spawn, the other 400 blocks away in a region instance of their own; a job whose radius reaches past them runs to its end, the chunks of that instance's cells left out and counted, that player never moved for it, no claim of the main instance held, the main instance keeps ticking |
| `node --test test/deco-ahead.test.js` | decoration ahead (stage 8, path 4) with the equivalence harness: players in fresh terrain with `decorationAhead` and a pre-generation job with `decorationAheadPregen`, each identical to the original (ticks, packets, world files) with decorations replayed from the thread; both again in verify mode, no difference |
| `node --test test/harness-equivalence.test.js` | the equivalence harness (stage 8): two runs of the original identical tick by tick, packet by packet and file by file; another seed not; the crowd with `encodeOnce`, `packedHandover`, `pathAhead`, `pathAheadSearches` and `collisionScan` on identical to the original, each of them used |
| `node test/harness/run.js <scenario> <out> [--config JSON]` | the equivalence harness: a scenario (`crowd`, `explore`, `blocks`, `pregen`, `animals` in `test/harness/scenarios/`) with the real host and game, deterministic, one tick at a time (`--world-type 1 --generator <preset>`: a superflat world); `compare.js A B` (the first tick, packet or world file that differs), `timing.js` (game-thread time per tick), `paired.js A B` (tick by tick differences), `--extra conflicts` (path 1's dependency counts), `--extra deco` (what each decoration does that a thread could not reproduce), `--extra spawn` (what the mob spawner counts, compares and spawns, step by step) |
| `node test/bench/net-load.js [--bots 12] [--bot-procs 4] [--mobs 1000] [--net-procs n] [--check]` | network load (stage 8): players in processes of their own watching an arena of mobs; frames per second, the status answer's latency, tick times, CPU of the host and its network processes; `--check`: every frame each player got checked against what the host sent, in order |
| `node --test test/autosave.test.js` | the autosave spread over ticks: the hook applied once (also without the pre-generation hook) and skipped when any game code it relies on differs; with the real daemon and a player in the world, a block placed by a command is in the saved chunk after the next autosave, without a save command; `"spreadAutosave": false` reaches the game |
| `node --test test/game-stats.test.js` | the stall line's time window: the real time the game thread's reports cover, also after a 20 s freeze; busy weighted by time; tick times |
| `node --test test/game-rules.test.js` | the Game Rules list is exactly the 22 rules of the game code with the same defaults, and the host's own `playersSleepingPercentage` is not one of them but offered, checked and sent like them; checking of saved settings; what is sent to the game |
| `node --test test/console.test.js` | the console's text output (translations filled in as the game does), the console correction applied whole or not at all, its sender counting as the server, the correction skipped when any code it relies on differs, the OP list in place of the owner-name check |
| `node --test test/daemon-relays.test.js` | the real daemon and integrated server with mock relays: hosting on 2 of 4 relays, players via both, a relay dropping the host's connection (a new code; `status` names the code it replaced; one log line; both players stay), a relay outage, live relay change, live change of LAN game mode and cheats, Game Rules (apply mode 1 set at once and saved in the world, mode 0 saved for the next start, unticked), the console (output, also with `sendCommandFeedback` off, server log lines, OP given and taken, OP refused outside the web page, Tab completion), tick times in status, the player limit changed live (the next join refused with the message, players in the world stay), the young generation from the config (`youngGenerationMb`: log line and heap limit), pre-generation (the 121 chunks for 40 blocks saved, the 49 inside the radius populated and saved light populated; a running job waiting after a restart, then resumed or discarded; resumed by itself with `"Pre-generationOnline": true`; `pregen stop`), graceful save, restart into the same world |
| `node --test test/ui-log-viewer.test.js` | the web page's log view against a fake API with slow, out-of-order responses and a host restart: every line shown once and in order (skips without chrome-headless-shell) |
| `node --test test/options.test.js` | the web page's Option Manual: every setting the code reads from `data/config.json` accounted for (found by a scan of the code), the ones left out exactly what the Settings form saves and the OP list, the others with the control for their type and a valid default; the accepted values and their boundaries; with the real web UI server on a throwaway data folder, each of the 25 settings saved on its own (the file then has that key with its type and every other key as it was), invalid values, the settings changed elsewhere, unknown keys, another site and a broken file refused with the file unchanged byte for byte, nothing written by reading; the real page in chrome-headless-shell: the 25 rows with key, description, when the change takes effect, the control for the type and the file's values, each setting changed with its control and saved on its own, invalid values shown and not saved, Default, "works with" following a save in Settings, the filter (the page part skips without chrome-headless-shell) |
| `node --test test/world-admin.test.js` | renaming and deleting worlds: on a throwaway worlds database, a rename into the folder of the new name (every file the same bytes, `level.dat` with only its name changed, the list order kept, the last world and a waiting pre-generation following, names made safe and free), delete with the name typed again (moved, the list without it, its waiting pre-generation dropped), restore byte for byte (into a free folder when its old one is in use), delete permanently (only its files), every other world untouched, everything refused while a world runs, Restart refusing a deleted world; the HTTP API and the real page (Rename, Delete enabled only with the full name, Deleted worlds, Restore, Delete permanently); the real game: a renamed world hosted with its new name also after Restart and keeping it after the game saved, a deleted world neither started nor restarted, a restored one hosted again |
| `node --test test/sleep.test.js` | the game rule `playersSleepingPercentage`: its count the same as 1.17's for 0 to 40 players and many shares (spectators aside), the rule read from the world's game rules, the game's own code without it or at 100; with the real daemon and game, three players in beds at night: without the rule one asleep keeps the night; at 50 two of three skip it for everyone (the new value counting while one was already in bed); at 0 one is enough; at 100 a spectator keeps the night as in 1.8.8, at 99 the spectator does not count |
| `node --test test/donation.test.js` | the donation message: off by default, each wrong setting reported with its default kept, the goal text, the chat message (`tellraw @a`; the address a link with the copy hint on hover and shift-click insertion; the lag line only when the server lags), what the players' pages get (only "off" while off), when it goes out (below the threshold with players on, not at the threshold, not before the speed is measured, nobody on, within the cooldown, off); with the real web UI server on a throwaway data folder: invalid values refused with the file unchanged byte for byte, a save adding only `donation` to `data/config.json`, kept across a restart of the web page server; the real page in chrome-headless-shell: the section with the saved values, the previews following the fields, a save, an invalid value not saved, *Send to chat now* off with no world running, the card on `/client/` (× folds it into the button) and on `/donate`, nothing on either while off; the real daemon and game with a player (the lag simulated with `EAGLAN_DEBUG_DONATION_TPS`): the message in the player's chat with the address clickable, not again within the cooldown, *Send to chat now* reaching them, off at once (the page skips without chrome-headless-shell) |
| `node --test test/mob-caps.test.js` | the mob caps correction: applied once and skipped when the spawner differs; its chunk count the same as vanilla's for 300 sets of players; with the harness in a superflat world at view distance 4, as shipped spawning stopping at the first animals, corrected up to the vanilla cap and animals back after the ones near the player were killed; at view distance 8 the corrected and uncorrected games identical |
| `node test/worker-smoke.js` | boots the native integrated server, creates a world, starts it and stops it |
| `node test/service-test.js` | service mode (autostart, SIGTERM → graceful save, resume without duplicates), hermetic with a mock relay |
| `node test/join-test.js <code>[,code2…] [n]` | unmodified u53 clients (headless Chrome, SwiftShader) join through the GUI. This is the *player* side and is not part of the server. `RELAYS_<i>` restricts client *i* to given relays; `CAPTURE_WS=1` records relay frames; `TRACE_DC=1` records the size and time of every game message; `ACTIONS="inv;cmd:/time set day;respawn;wait:5000;attack"` checks game mode (inventory screen), commands, respawn and hits after joining; `ACTIONS_<i>` gives client *i* its own list |
| `node test/bench/load.js` | game-server load test (see "Lag with many players"): the real host on a local mock relay with N protocol-level players (`test/bench/bot.js`: they join through the relay over WebRTC like the u53 client, log in, answer keep-alives, move every tick and never into terrain they have not received). Reports tick times, "Can't keep up!" lines, how busy the game thread was, the whole process's CPU and memory, GC and chunk counts. `--make-template` creates (and with `--pregen` pre-generates) the world it starts from. `--multicore on\|off`, `--workers <n>` (pool threads), `--host-cpus <n>` (the host on the first n CPUs only, as on a smaller server) and `--profile <file>` (a CPU profile of the game thread) are for "Multi-core mode". `--mobs <zombies>,<villagers>,<animals>` builds a mob arena above spawn (see "Entity processing: what could run in parallel"). `--speedups all\|none\|<list>` and `--speedups-verify` are for "Speedups on the game thread"; the result also counts the packets the players received, by type. `--host-cores <n>` (the host on n whole cores, the busy share of every CPU in the result), `--groups <g> --group-offset <blocks>` and `--group-center <dx,dz>` (players and arenas far apart), `--repeat-command`, `--regions on`, `--region-instances <n>` and `--rejoin <s>` are for "Multi-core game simulation" |
| `node test/netlab/bench.js` | network lab: a real Chrome WebRTC client and the host's WebRTC stack exchange a recorded real game session over an emulated link (delay, jitter, bursty loss); measures the one-way delay of every message (see "Network performance") |
| `node tools/netcheck.js local \| paths \| compare` | network checks for the server (see "Network performance") |
| `node cli.js relays probe` | live compatibility check of the configured relays |

### Results (2026-10-17 to 2026-11-01, Windows 10, Node 24.19)

| Test | Result |
|---|---|
| Full `npm test` (2026-11-01), with world pre-generation, tick times, the stall line window, the player limit, the young generation setting, the spread autosave, the join code change report, the multi-core mode, the terrain threads (for players too), several chunks per tick for pre-generation, the speedups (the 64-bit constants, the lighting sets and the collision scan too), the collision scan with the real game, regions (moving players, the world-wide state, regions in play), regions with pre-generation, the equivalence harness with the stage 8 options and decoration ahead, the Option Manual, renaming and deleting worlds, the mob caps, the game rule `playersSleepingPercentage`, the donation message | **131/131 pass** (2026-11-01); `test/worker-smoke.js` pass; `test/service-test.js` **7/7** |
| Donation message with an unmodified u53 client (2026-11-01, headless Chrome, local relay, `measurements/donation/client-click.js`): the message sent with *Send to chat now*, the chat opened, the address found on the screen by its colour, pointed at, shift-clicked (then Enter), clicked, *Copy to Clipboard* | **pass**, twice: the message in the chat as designed (the gold header, the message, the goal, the network, the address underlined on a line of its own, the hint); the hover text shown; shift-click put the address in the chat box (sent: the host logged `<Tester1> TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC`); the click opened the game's link screen, and *Copy to Clipboard* put exactly the address on the clipboard (written once by the game, read back the same), then back in the chat; no error in the host log |
| Donation message on the web page in a browser (2026-11-01): off by default, the default values and previews, switched on and saved; `/donate` at 1100 px and phone width | pass. Found and fixed during the check: `/donate` scrolled by 48 px on an almost empty page (the card's margin went through the page's body) |
| `playersSleepingPercentage` with the real game (2026-11-01): three players in beds at night | pass: without the rule, 1 of 3 asleep: still night; at 50 the next morning once 2 of 3 slept (the rule set while one was already in bed); at 0 one is enough; at 100 a spectator keeps the night as in 1.8.8, at 99 not; the regions sleeping test unchanged; the web page's Game Rules shows it (0-100) and saves it |
| Option Manual in a browser (2026-11-01): the page on a copy of the project's own `data/config.json`; a setting saved; an invalid value; phone width, 1620 px, light and dark | pass: the file's values shown; only the saved key changed in the copy (the real file untouched); a player limit of 1001 refused with the reason. Found and fixed during the checks: lists with long choices (disk sync, mob caps) were wider than their column and covered the description |
| Rename and Delete in a browser (2026-11-01): two test worlds in the copy; Delete with the name typed, Deleted worlds, Restore | pass |
| Animal spawning (2026-11-01, harness, view distance 4): a normal world and a superflat one, as shipped and corrected | as shipped: animal cap 2 per player, nothing spawned in 4,000 ticks (also with every animal killed); corrected: cap 10, up to 26 animals in the superflat world and back from 8 to 24 after the ones near the player were killed; at view distance 8 corrected and uncorrected identical (see "Animals that never respawn") |
| Game-server load test (`test/bench/load.js`, 2026-10-19/20): pre-generation, the young generation, 8-16 players | see "Lag with many players" |
| Pre-generation of 512 blocks, saved chunks checked (2026-10-20) | all 4,225 chunks within the radius populated and saved light populated |
| Player limit 1 with an unmodified u53 client joining a full world (2026-10-20) | refused; the client shows "Failed to connect to the server" with "This world is full: 1 of 1 players are online. Try again later."; nothing opened in the world |
| Autosave spread over ticks (2026-10-20): load test, 3 runs each, alternating; a block placed next to a player, then only the autosave | longest tick 1.04 → 0.14 s, time behind 5.4 → 2.3 s per 115 s; the block was in the saved chunk with no save command |
| Multi-core mode, load test (2026-10-28): 12 players, off and on in turns; all 12 CPUs with 2 and 4 pool threads, and the host on 2 CPUs | see "Multi-core mode": e.g. pre-generated terrain, 2 threads: tick p95 54 → 40 ms, time behind 2.5 → 1.1 s; fresh terrain on 2 CPUs: 18.1 → 20.1 ticks per second. Every player stayed in every run (36 runs) |
| Entity processing, CPU profiles (2026-10-29): 12 players with about 450 entities (20 ticks per second) and with 500 summoned mobs (overloaded); thread hand-over costs on this machine | see "Entity processing: what could run in parallel": entities 68-78 % of the game thread; no part can run on other threads without changing gameplay or costing more than it saves; the costs that could be cut are single-thread ones (64-bit chunk keys 14-16 %, UUID text 4-6 %, per-packet hand-over 5-6 %) |
| Regions (2026-10-29): 12 players in 4 groups far apart, one world, the host on 1, 2 and 4 whole cores | see "Regions": with 4 cores the ticks of four separate servers, with players joining far apart (p50 15.8 → 4.3 ms, p95 56.5 → 20.7 ms, behind 2.6 → 0.4 s per 115 s against one server) and with groups moved while playing (4.4 / 23.3 ms, 0.5 s; "Downloading terrain" 1.2-1.5 s per move, none failed); 2 cores p95 56.8 → 39.3 ms; 1 core as one server; about 350-400 MB per region instance; every player stayed; the world-wide state (stage 4) (commands, sleeping, maps, villages, structures and the scoreboard across instances): ticks as before (p95 22.7 ms); scores copied 80 times a second: p95 24.5 ms |
| Multi-core game simulation (2026-10-29): what one entity costs to update (38 µs) and to copy (54 µs); the same workloads on 1, 2 and 4 whole cores, players together and far apart, one server and 4 | see "Multi-core game simulation": the entities of one area cannot be split over threads on this engine; far-apart areas on their own game instances: with 4 cores tick p95 20.5 ms instead of 56.5 ms for players far apart, no gain for players together; every player stayed in every run |
| Speedups on the game thread (2026-10-29): load test, off and on in turns, 3 runs each, in the medium mob scene and in the usual load test; verify runs in both | see "Speedups on the game thread": medium scene busy 57 → 46 %, tick p50 22.3 → 16.0 ms, time behind 2.5 → 1.6 s; usual load test busy 44 → 40 %, p50 11.4 → 9.4 ms; verify (3 runs): 366 million chunk lookups from the cache and 731,182 UUID texts with no difference, 3.68 million packets kept with no order error; every player stayed in every run |
| Pre-generation with several chunks per tick while nobody is online (2026-10-29): 512 blocks, before / now / now with a terrain thread in turns, 3 runs each on all 12 CPUs, 1 each on 2 CPUs; 12 players with a job at 50 chunks/s | see "Pre-generating the world": 245 → 218 s (→ 170 s with a terrain thread); 2 CPUs 262 → 232 s; with players on the server one chunk per tick as before; every chunk within the radius light populated in every run; the saved worlds differ only in water, lava, sand and gravel |
| Terrain threads for pre-generation (2026-10-29): 512 blocks, off and on in turns; all 12 CPUs (3 runs each), 4 CPUs, 2 separate cores, 2 CPUs of one core; 12 players with a job running | see "Terrain threads for pre-generation": every chunk compared once (4,708, all the same), 1,043 spot checks (none different), the saved worlds the same but for tick-timed liquids and sand, as between two runs off; game thread time per chunk 34.5 → 24.2 ms with a core to spare, but the job no faster, and slower on 2 CPUs of one core; 160-195 MB more memory while a job runs |
| Chunk work in fresh terrain, stage 5 (2026-10-30): the load test in fresh terrain, 12 players, 3 exploring; before, with speedup 4, with speedups 4 and 5, with speedup 4 and a terrain thread for players, and with all of it, on 4 cores (2-3 runs each), 2 cores, 2 CPUs of one core and 1 core (2 runs each); a `terrainVerify` run and a speedups verify run | see "Chunk work in fresh terrain": 4 cores ticks over 250 ms 41 → 19 → 4 → 0 a run, behind 28.5 → 21.7 → 9.6 → 5.7 s; 1 core 0.6-2.5 ticks a second → 20 (13.4-13.9 s behind with speedups 4 and 5); every chunk the thread made compared once (1,901 identical), 528 spot checks, 23.9 million lighting-set adds checked, none different; the thread +190-420 MB |
| Many entities in one place, stage 6 (2026-10-30): the load test with the stage 6 arenas (100-1,000 entities, in one area and over 4 areas), the game's own walk and the collision scan back to back, the three largest again in the other order; CPU profiles; a verify run | see "Many entities in one place": with 1,000 in one area the mean tick 54-57 → 47 ms and the ticks over 50 ms 79-92 % → 18-21 %; with 500 in one area 22.3-22.4 → 20.2-20.9 ms; with fewer, or spread out, no measurable difference; 2,499,561 walks left out in the verify run, none different |
| Regions in play, stage 7 (2026-10-31): ten connected players for 8 minutes (`measurements/regions7/live.js`) and the unmodified u53 client moved between instances (`measurements/regions7/client-move.js`) | **36/36 checks**, twice on the final code (12 moves each, none failed, median 447-449 ms); the client stayed in the game, moved in 0.9 and 0.3 s; see "Regions" and `measurements/regions7/report.md` |
| Equivalence harness, stage 8 (2026-11-01): crowds of 250, 500 and 1,000 mobs (3 and 12 watchers), explore (fresh terrain, digging, monsters, an autosave), blocks across a restart; each exact option alone and all together against the original, 3 rounds | **identical** every time: every tick's game state, every packet, every world file (e.g. explore 1,213 ticks, 865 files); two runs of the original identical, another seed differs from tick 1; verify mode: 4,426,298 copied frames, 165,644 path steps and 4,679 path searches compared, none different |
| Stage 8 speed, harness (2026-11-01): 3 runs per configuration in turns, paired per tick | 1,000 mobs and 12 watchers: 59.9 → 48.8 ms per tick with encode once and the packed hand-over (-19 %), 42.9 ms with every exact option (-29 %); path steps ahead -1.3 to -2.2 %, chase searches ahead no gain; fresh terrain unchanged (see "Stage 8") |
| Network processes (2026-11-01): 12 players in 4 bot processes, 1,000 mobs in view, 60 s | 35,228 → 82,082 frames/s with 4 processes; `status` answer 4 s → 8 ms; every frame checked against what the host sent: the same (6,833 checkpoints) |
| Regions with pre-generation; regions with each stage 8 option and with all options together (2026-11-01) | pass: 3,721 chunks, 100 left out for the region instance, nobody moved, no claim held; `regions-daemon` 6 of 6 |
| Two unmodified u53 clients at once with every stage 8 option, verify mode (2026-11-01, headless Chrome, local relay, `measurements/stage8/client-s8.js`) | **pass**: both joined, played among chasing zombies, chatted and walked, each in its own network process; 29,407 copied frames, 23,882 path steps and 1,639 path searches compared, none different; no packet out of order |
| Decoration ahead, stage 8 path 4 (2026-11-01): players in fresh terrain and the pre-generation job, each with and without, 3 rounds in turns; with every option; with the terrain thread; regions with it; verify mode | identical every time (12 runs); verify: 432 decorations compared, none different; regions-daemon pass; no measurable gain (players 40.0 → 39.5 s within the noise, pre-generation 18.6 → 18.5 s): see "Decoration ahead" |
| The collision scan with an unmodified u53 client (2026-10-31, headless Chrome, local relay, verify mode) | pass: the client stood and walked inside a ring of boats among mobs, stayed in the game; 59,716 walks left out, none different; 81,257 kept for a boat in reach; no error in the log |
| Multi-core mode with an unmodified u53 client (2026-10-28, headless Chrome, local relay) | pass: joined in 10 s, inventory, chat seen, walked; its chunk packets (2.2 MB → 0.1 MB) and 90 chunk files went through the pool; no error in the log |
| Join code change (2026-10-20): a mock relay drops the host; on relay.eaglercraft.net a registration again after a clean close, after an abrupt drop, and with the old code in the handshake | the change is reported (log once, `status`, web page note); relay.eaglercraft.net gave a new code all three times |
| Join code change note on the web page (2026-10-28): a status with a new code on relay.eaglercraft.net and on another relay; *Hide*; *Copy code and open My worlds*; phone width | pass: the note with the button on relay.eaglercraft.net, the short note on the other relay; a hidden note stays hidden after a reload; the code was copied, and the button asked the browser to open eaglercraft.com's *My worlds* (the test browser blocks new tabs from automated clicks, so the tab itself was not seen); no sideways scrolling at 375 px. Found and fixed during the check: the code box was redrawn every 2 s, so a click during a redraw was lost (now redrawn only when it changes), and copying also works on a plain http page |
| *Pre-generate* button with a running world (2026-10-20): start, stop, restart with a job running, then *Resume* and *Discard*; phone width | pass: nothing started by itself after the restart ("Pre-generate (1 unfinished)", the waiting row); *Resume* continued from ring 0 of 21; *Discard* removed it; the panel's buttons work again after use (fixed during the check) |
| Web page with a running world (2026-10-20): `pregen 40` in the console, the Pre-generation row, *Player limit* 12 saved | pass: "finished: 121 of 121 chunks … 49 lit"; "0 connected (limit 12)"; the limit applied without a restart |
| Multi-relay automated suite (mock relays), incl. session summaries, per-player RTT, send twice, the first-message test and the failed-join line | **24/24 pass** (full `npm test`: 44/44 on 2026-10-18) |
| Game server stall explanation, with world writes made artificially slow (`EAGLAN_DEBUG_SLOW_WRITES_MS=40`, two walking clients) | each `Can't keep up` attributed to `saving world data` (59–66 writes, 2.4–2.7 s blocked) |
| `diskSync: "normal"` with the unmodified client: join, walk, save | pass; game thread blocked 25–32 ms/min instead of 180–380 ms/min |
| Sequential joins of unmodified u53 clients (join, then leave) | before the login-packet fix 29/30 (local relay); after **40/40** (local relay) and **10/10** (relay.eaglercraft.net) |
| Send-twice relay unit tests | **9/9 pass** |
| Unmodified u53 client with send twice on: mock relay and relay.eaglercraft.net; off: mock relay | pass; the relay carried the server's traffic for the whole session |
| Send twice with a fixed UDP port (27015), two unmodified u53 clients at the same time (mock relay, 2026-10-18) | pass: both players on the fixed port in 2 runs; small packets sent twice (e.g. 4,002 and 271 copies); `status` shows `send twice: on (UDP port 27015)` |
| Web page: port field shown only while *Send small packets twice* is ticked; saved and shown again after reload; 80 and 25001.5 refused; empty = automatic; phone width | pass |
| Web page log view: duplicated/out-of-order lines (seen in real use with ~15 players) | reproduced with the old view (92 duplicates in 30 s); **fixed**, 0 duplicates |
| Daemon multi-relay integration (real worker, mock relays) | **pass** |
| Worker smoke test; service test | pass; 7/7 |
| Live relay probe, 8 relays | 5 compatible, 3 unavailable/refused (table above) |
| **Real multiplayer through 3 different public relays into one world** (unmodified clients, each restricted to one relay) | **pass** |
| Live relay-list change via UI/CLI on the running host: duplicates/invalid lines reported, codes unchanged, no re-registration | pass |
| Install of the WebRTC binary from a local file with downloads blocked | pass (Windows binary, same mechanism) |
| Per-player RTT and IPv4/IPv6 in `status`, the web page and the leave line, with the unmodified client (mock relay) | pass |
| Host event-loop delay line in `status` (idle world) | pass |
| Network lab: 145 runs (host SCTP settings, duplicate sending; 16 early duplicate runs superseded after an emulator fix), real Chrome client, recorded real game traffic | 0 lost messages; results in "Network performance" |
| `netcheck paths` + `compare` (2 probes in China to a public German server); `netcheck local` | pass; `local` only on Windows (Linux counters not run) |
| LAN game mode Creative, unmodified u53 clients (2026-10-18) | before the fix: 2/2 new players joined in Survival, Creative only after respawning. After: new players join in Creative; returning players follow the current setting; with `"gamePatches": false` the old behaviour returns |
| Live change with players in the world: web page save (Creative, cheats on), then `cli.js settings apply` (cheats off) | pass: the connected player's `/time set day` was refused, then worked without rejoining; the next player joined in Creative; cheats off refused commands at once |
| Game mode changed while a Survival player is connected, then `/kill` and respawn | pass: the player stayed in Survival, then respawned in Creative |
| Which commands cheats give (unmodified client) | see "LAN game mode and cheats" |
| Game-code correction tests, with the console's | **6/6 pass** |
| Game Rules with two unmodified u53 clients, changed from the web page in apply mode 1 while they played (2026-10-18) | pass: `keepInventory` set at world start (`/gamerule keepInventory` = true); a command block ran, and after command blocks were switched off a second one did not; `doDaylightCycle` changed live (`/gamerule` = false); a player's hit did no damage with PvP off and took 1 health point with PvP switched on, from the same spot |
| Game Rules with the real game server: values at world start, a live change, apply mode 0, restart | pass: rules saved in the world (read back from level.dat), mode 0 values set at the next start, switches reported by the game |
| Game Rules section on the web page: opens with the checkbox, the 1/0 box takes only 1 or 0, the cheats checkbox in it follows the main one, values saved and shown again after reload, a random tick speed of 5000 refused, *Game defaults*, phone width | pass |
| Console with the real game server, no players (2026-10-18): `help` (7 pages, 45 commands), `time`, `gamerule`, `weather`, `difficulty`, `seed`, `list`, `say`, `me`, a missing player, unloaded chunks, unknown commands, `op`/`deop`/`ops`, Tab completion | pass; output also with `sendCommandFeedback` off; `say` and `me` show the line the server logged |
| Console and OP with two unmodified u53 clients, commands sent through the web page's API (2026-10-18) | pass: refused before OP; `op Tester1` → the same command worked without rejoining; in-game `/op Tester2` → "Unknown command"; refused again after `deop`; `gamemode creative Tester1` → Creative inventory and "Set Tester1's game mode to Creative Mode" in the console; a client named `HeadlessHost` (the owner name) refused; Tab completed online player names; `tp` and `kill` worked, the death message shown in the console; the console's `say` arrived in the players' chat. In 1 of 5 runs the first test player died seconds after joining, before any console game command (cause not captured), so its later chat checks got no reply |
| Console on the web page: output, grey server log lines, red errors, `op` updates the OP line, Tab completion, ↑ history, phone width | pass |
| Joins from another network / through TURN; Linux run | **not tested** |

Earlier results (2026-10-15, single relay, still valid for the unchanged parts), all passing:
- No browser/GPU on the host (single `node` process, no graphics DLLs).
- Gameplay (walk, chat, mine; inventory saved server-side).
- Hosting continues with the UI closed.
- Graceful stop and persistence across restarts.
- Never-overwrite world naming.
- Hard-kill recovery.
- EPK/zip export/import round trip.

## Support this project

If eaglan-host is useful to you, you can support its development with a donation.

**Trust Wallet**, TRON network (TRC-20): TRX or USDT

```text
TQqxb8H1QFghCMpV7eHMZEkBEoR8HNXSYC
```

Send on the TRON network (TRC-20) only: coins sent to this address on another network can be lost.

---

**Trust Wallet**, TON network: TON or USDT (TON Jetton)

```text
UQAzaTcekoV0FsQlGlFpWvjToOIsTxWO9o3wip1y2NpCW3DZ
```

Send on the TON network only: coins sent to this address on another network can be lost.

---

**Trust Wallet**, Polygon network (Polygon PoS): POL or USDT

```text
0x8888495C96173811d2cfb5A6BF83b6e534fEB8a6
```

Send on the Polygon PoS network only: coins sent to this address on another network can be lost.

**Thank you for your support!** ❤️
