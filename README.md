# Ghost Dreadnought

A vertical-scrolling shmup roguelite for the browser. You fly a flying battleship that you build one hull section at a time. You chart a route through each sector the way you would in Slay the Spire. At the end of every sector you fight a **ghost dreadnought**: the wreck of a real pilot who died there. When you die, your ship joins the pool and becomes someone else's boss.

<p align="center"><img src="docs/readme/hero-ghost-broadside.jpg" width="900" alt="A ghost dreadnought comes alongside in its last phase and fires every gun it has; enemy fire is magenta, the player's missiles trail smoke across the harbour"></p>

## Run it

```bash
npm install
npm run dev          # Vite client on http://localhost:5173 + ghost registry API on :8787
```

For production, `npm start` builds the client and serves `dist/` and the API from one Node process (`PORT`, default 8787). Ghosts and the daily roster are stored in `data/`. Set `GHOST_DATA_DIR` to store them somewhere else, and `GD_WEB_PORT` / `GD_API_PORT` to run several dev servers side by side.

## How a run works

- **Sector map.** Each sector has 10 floors of branching paths and ends with the boss. You can only move forward along connected nodes.
  - **Fight**: one of five engagement types (patrol, air wing, armored column, fortress line, drone swarm). You get scrap plus a choice of 1 of 3 parts.
  - **Elite**: an Ace Gunship, a Siege Crawler or a Drone Carrier, with escorts. It drops a relic and better parts.
  - **Merchant**: buy parts, hull sections and a relic; repair; sell spares; purge curses; open the refit board with the counter beside it.
  - **Unknown signal**: 11 events with choices, risks and rewards. Some lead to ambush fights. One lets you loot a real dead pilot's wreck.
  - **Derelict**: a relic plus scrap. The middle floor of every sector is all derelicts.
  - **Drydock**: repair, upgrade a part by one tier, or weld on a free hull section. The floor before the boss is all drydocks.
  - **Ghost Dreadnought**: the boss. Its dossier (blueprint, armament, who flew it) is pinned beside the map before you commit.
- **The world below.** Each sector flies over two of six biomes (night city, harbour, forest, snow mountains, desert, airbase) and crosses from one to the next mid-sector. Everything burns its own way: buildings collapse, tank farms chain-react, forests catch and spread, frozen lakes crack.
- **True scale.** The ship is the size of a carrier and the enemies are true to scale: a tank is a speck of light beside the hull. A fire-control overlay boxes every contact with a NATO-style symbol, and the FLIR view shows them by their heat.
- **Scrap** drops from destroyed enemies and structures, supply caches, wreckage and floating salvage canisters. Caches and wreckage sometimes drop repair kits. A magnet radius pulls scrap in.
- **Your ship** is a stack of sections: bridge, gun decks, broadside batteries, armor, utility spines and engines. Where a gun sits decides what it can hit: the bow gun covers a forward cone, top-deck turrets only engage aircraft, broadsides cover their flank, bomb bays and mortars hit the ground below. You refit on a blueprint board by dragging parts onto sockets; the board lights the sockets that fit and draws the firing arc you would get.
- **Weapons**: pulse cannon, scatter laser, flak, seeker missiles, bomb bay, siege mortar, rail spine, arc coil and point defense, Mk I to Mk V. Light guns fire on their own; the heavy ones (rails, missiles, mortars, bombs) are numbered groups you aim with the mouse.
- **Overdrive** charges as you destroy things. Each hull class has its own: the Vanguard's Ventral Lance, the Leviathan's Strike Wing, the Lance's spinal beam, the Bastion's Aegis.
- **Relics** are 22 passive modifiers, including curses picked up from risky choices.
- **Death** uploads your exact build to the registry for the sector you died in. Bosses are drawn at random from everyone who died in that sector, preferring other pilots. If nobody has died there yet, a procedurally armed AI defense core holds it.
- **The fleet.** Runs earn XP toward ten Admiralty ranks, which unlock three more hull classes and launch perks. There are standing orders (goals), a codex, heat levels after your first victory, and a **daily strike**: one seeded route a day for everyone, ranked on a shared duty roster.

### Controls

| Input | Action |
| --- | --- |
| WASD / arrow keys | Steer |
| Mouse | Aim the heavy weapons (the light guns fire on their own) |
| Left button | Fire the selected heavy group |
| Right button | Salvo every group |
| 1-9, Q / E, wheel | Select a group |
| Space | Overdrive |
| Shift (hold) / T (toggle) | FLIR thermal view with a 4x zoom inset on the target |
| P / Esc | Pause (audio mix, quality, screen shake) |
| M | Mute |

On a touch screen, drag to steer and every gun aims itself. In the refit board, drag (or press and hold on touch) a part onto a socket, between sockets to swap, or back to the hold; click-to-pick and the keyboard work too. Runs are saved after every node and can be continued from the title screen.

## Screenshots

### Menus

<table>
<tr>
<td width="50%"><img src="docs/readme/title.jpg" alt="Title screen"><br><sub><b>Hangar.</b> Callsign, Admiralty rank, the four hull classes and the daily strike.</sub></td>
<td width="50%"><img src="docs/readme/route-map.jpg" alt="Sector route map"><br><sub><b>Route plot.</b> Hover a node to plot it. The ghost's dossier is pinned beside the map: the fallen pilot's wreck and everything it carried.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/refit-drag.jpg" alt="Refit board mid-drag"><br><sub><b>Refit board.</b> A rail spine carried over the port battery: weapon sockets light up, utility bays dim, and the plan draws the arc it would cover.</sub></td>
<td><img src="docs/readme/merchant.jpg" alt="Merchant"><br><sub><b>Merchant.</b> Requisition slips, an insignia (relic), repairs and a counter for selling spares.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/signal.jpg" alt="Unknown signal event"><br><sub><b>Unknown signal.</b> One of eleven intercepts; some choices are bait.</sub></td>
<td><img src="docs/readme/salvage.jpg" alt="Salvage after an elite"><br><sub><b>Salvage.</b> After an elite: a relic recovered and one part of three to keep.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/pause.jpg" alt="Pause menu"><br><sub><b>Paused.</b> Audio mix, quality tier and screen shake, over the frozen fight.</sub></td>
<td><img src="docs/readme/wreck-report.jpg" alt="Wreck report with the daily duty roster"><br><sub><b>Wreck report.</b> The run in totals, the Admiralty pay slip, and the daily strike duty roster with your row highlighted.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/admiralty.jpg" alt="Admiralty"><br><sub><b>Admiralty.</b> Service record and the ten ranks; goals and the codex sit on the other tabs.</sub></td>
<td><img src="docs/readme/daily-roster.jpg" alt="Daily strike briefing"><br><sub><b>Daily strike.</b> Today's roster on line-printer paper before you launch the shared route.</sub></td>
</tr>
</table>

### Combat and effects

<table>
<tr>
<td width="50%"><img src="docs/readme/combat-city.jpg" alt="Combat over the night city"><br><sub><b>Night city.</b> An armored column under fire: tactical boxes on every true-scale contact, the bow gun's cone, broadsides and missiles firing, and the salvo reticle.</sub></td>
<td width="50%"><img src="docs/readme/missile-lock.jpg" alt="Missile lock"><br><sub><b>Missile lock.</b> Group 2 selected: lock brackets close on a helicopter and seeker pods arc out on smoke trails.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/explosions.jpg" alt="Mortar and bomb salvo"><br><sub><b>Salvo.</b> Mortars and bombs on a fortress line: fireballs, burning blocks and smoke over the city.</sub></td>
<td><img src="docs/readme/ventral-lance.jpg" alt="Ventral Lance overdrive"><br><sub><b>Ventral Lance.</b> The Vanguard's overdrive fires straight down from the keel; impact rings race out past the hull and the city lights up beneath it.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/flir.jpg" alt="FLIR thermal view"><br><sub><b>FLIR.</b> Hold Shift: the city goes cool grey, engines and fires burn white, and a 4x inset shows the tank under the reticle.</sub></td>
<td><img src="docs/readme/elite-crawler.jpg" alt="Siege Crawler elite"><br><sub><b>Elite.</b> A Siege Crawler gets a double box and a designator; the bow rail lances into it while its escorts fire back.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/ghost-telegraph.jpg" alt="Ghost dreadnought full broadside"><br><sub><b>Full broadside.</b> The ghost's last phase: rail telegraphs and every flank gun firing at once. Anything magenta can hit you.</sub></td>
<td><img src="docs/readme/ghost-closeup.jpg" alt="Ghost dreadnought close-up"><br><sub><b>The ghost.</b> A fallen pilot's exact build, rebuilt as a derelict: soot, dead windows, a red rim and fires from its breached decks.</sub></td>
</tr>
</table>

### World

<table>
<tr>
<td width="50%"><img src="docs/readme/biome-harbour.jpg" alt="Iron Harbour"><br><sub><b>Iron Harbour.</b> Black water, pale quays and container stacks under sodium light.</sub></td>
<td width="50%"><img src="docs/readme/biome-mountains.jpg" alt="White Range"><br><sub><b>White Range.</b> Moonlit ridges and a frozen lake; a rail slug lances up the valley.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/biome-desert.jpg" alt="Glass Desert"><br><sub><b>Glass Desert.</b> Dune swells, walled compounds and burning wreckage on the sand.</sub></td>
<td><img src="docs/readme/biome-forest.jpg" alt="Deepwood"><br><sub><b>Deepwood.</b> Bombs and mortar shells on the canopy start wildfires that spread through the trees.</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/readme/ship-closeup.jpg" alt="Dreadnought close-up"><br><sub><b>Up close</b> (dev viewer, <code>/tools/ship.html</code>). The bridge stack, barbettes and deck machinery: every hull section is seeded greebles, and every gun is a cluster of small turrets dressed by its traverse.</sub></td>
</tr>
</table>

## Code map

| Path | What it does |
| --- | --- |
| `src/main.ts` | Screen flow, node handlers, input, the `window.__gd` debug hooks |
| `src/game/combat.ts` | The shmup simulation: player, gunnery, enemies, elites, ghost bosses, overdrive, salvage, pickups |
| `src/game/map.ts`, `run.ts` | Sector map generation (seeded, non-crossing paths, floor rules); run state, rewards, save/load |
| `src/game/ghosts.ts`, `daily.ts` | Ghost registry client and AI fallback bosses; daily strike roster client |
| `src/game/meta.ts`, `metaScreens.ts` | Profile, Admiralty rank, goals, codex, heat; launch panel, Admiralty, wreck report, victory |
| `src/game/worldgen.ts`, `biomegen.ts`, `biomes.ts`, `terrain.ts` | The six biomes: structures, set pieces, terrain fields, destruction and wildfire |
| `src/game/vfx.ts`, `feel.ts` | Pooled particles, camera trauma, hitstop and slow-motion |
| `src/data/` | Parts and hull sections, hull classes, enemies and encounters, relics, events, goals, heat |
| `src/render/engine.ts`, `view.ts` | Three.js renderer, camera and layers; field-to-screen mapping |
| `src/render/ship/` | Procedural dreadnought hulls, greebles, turrets, utilities, lights, the ghost livery, the dev viewer |
| `src/render/units/` | True-scale enemy models, livery, tactical symbology |
| `src/render/world/` | The ground: city, terrain and biome shaders |
| `src/render/fx/` | Effect batches, ribbons, distortion and the post chain (bloom, grade, SMAA) |
| `src/render/hud.ts`, `flir.ts`, `shipPreview.ts` | Combat HUD and reticle; FLIR state; 2D blueprint drawings for menus |
| `src/ui/` | DOM screens (`screens/`), the refit board (`refit.ts`, `refitLogic.ts`, `drag.ts`), the map view, settings |
| `src/audio/` | Music, cues, ambience and the mix |
| `server/` | Zero-dependency Node registry: ghosts (`GET/POST /api/ghosts`) and the daily roster (`/api/daily`), with server-side validation |
| `tools/` | Dev viewers: `ship.html` (one ship through the real engine), `contact.html` (model kits) |
| `docs/` | Design bible, art direction and technical notes (`DESIGN.md`, `ART.md`, `TECH.md`) |

## Tests

```bash
npm run typecheck
npm test             # vitest: map invariants, ship stats and arcs, gunnery, refit board layout, economy, ghost and daily validation, every event choice
npm run e2e          # Playwright: plays the real game in Chromium
```

The end-to-end suite starts the dev servers and plays through the title, map, a fight, salvage, the refit board (drag, swap, reorder, buy), merchant, event, drydock, derelict, elite, boss, next sector, death (checking the ghost reaches the registry and becomes the next boss), save and continue, the phone layout, overdrive, gunnery, the Admiralty, victory and the daily duty roster. It saves screenshots to `test-results/shots/`. To use a preinstalled Chromium, set `CHROMIUM_PATH`.
