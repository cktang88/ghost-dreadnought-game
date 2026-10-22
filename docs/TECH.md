# Technical Map and Ownership

## Run it
- `npm run dev`: Vite client plus ghost API. Set `GD_WEB_PORT` / `GD_API_PORT` to run several checkouts at once.
- `npm test`: vitest. `npm run typecheck`: tsc.
- `npm run e2e`: Playwright in Chromium. Set `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in this sandbox.
- Kit preview: `node scripts/contact-sheet.mjs <kit> [nameRegex] [out.png] [cols] [iso|top]` (dev server running).
- Asset kits: `scripts/assets/fetch-sources.sh`, then `node scripts/assets/build-kits.mjs` writes `public/assets/kits/{city,scifi}.glb` plus a JSON list of model names. Raw sources are cached in `/home/user/asset-cache` (Kenney kits are there too, unzipped).
- The sandbox renders WebGL in software, so it is slow. Use `__gd.debug.timeScale` and `__gd.god()` from the console or Playwright to fast-forward fights. Judge the visuals from screenshots.

## Coordinates (read `src/render/engine.ts` header)
- Gameplay is 2D on a 1600×900 field (`src/game/field.ts`), with y pointing down the screen.
- Flight-plane objects use `engine.toFlight(x, y, alt)`. Ground objects use `engine.toGround(x, y)` and must be scaled by `engine.groundScale`.
- Ship hulls are `SECTIONS` design units × `SHIP_SCALE` (3.1; it was 2.6 before the scale pass). `derive()` already returns scaled rects and mounts.
- The city is authored in its own design units and shrunk by `CITY_K` (0.25) into field units (`src/game/worldgen.ts`, see "City").
- **True scale: one world unit is one metre.** A finished hull is 330-550 field units long and under 100 wide; aircraft fly on the flight plane,
  so a 19 m interceptor is 19 field units; a ground object of m metres covers m / groundScale (~1.65) field units, so a 10 m tank is ~6.
  Enemy models are drawn at `TRUE_M[type]` metres (`src/render/units/scale.ts`; `UnitSpec.scale` is computed from each model's extent).
  Gameplay radii (`EN[type].r`) are unchanged and decoupled from the drawing: they were already generous, and now act as the marker radius.
- **Field <-> screen** (`src/render/view.ts`): the camera tilt makes the field a trapezoid on screen (field (800, 450) is drawn at screen
  y 421; the top corners are ~110 units in). `engine.fitCamera` sets a homography: `fieldToScreen(x, y)` for anything the HUD draws over the
  world (symbology, the reticle, lock brackets, rail lines, reach rings) and `screenToField(x, y)` for the mouse (`aim` is the field point
  under the cursor). Because `toGround` puts ground objects under the flight-plane pixel, one homography serves both layers.

## Module ownership (parallel work)
Each workstream owns its files. Edit outside your area only at the integration points listed, and keep those edits small.

| Workstream | Owns | Integration points |
| --- | --- | --- |
| Ship | `src/render/ship/**` | `ShipLayer` API used by `main.ts` |
| City and world | `src/render/world/**`, `src/game/worldgen.ts`, `biomegen.ts`, `terrain.ts`, `biomes.ts` | `worldBlast()` and `cityPay()` called by combat; `biomeFor()` in `startCombat`; terrain queries for spawns; `S.decor` / `S.clouds` shapes |
| Units | `src/render/units/**` | Reads `S.enemies` (types in `src/data/enemies.ts`) |
| VFX and post | `src/render/fx/**`, `src/game/vfx.ts`, post section of `src/render/engine.ts` | Spawner functions called by combat (`boomFx`, `spark`, `muzzle`, ...) |
| Audio | `src/audio/**` (move `src/game/audio.ts` there), `public/assets/audio/**` | `sfx(name)` calls; a `music.setScene()` call from `main.ts` |
| UI | `src/styles.css`, `src/ui/**`, `src/render/hud.ts`, `index.html` | Screen-building functions in `main.ts` (markup only) |
| Gameplay and meta | `src/game/combat.ts`, `src/game/run.ts`, `src/data/**`, new `src/game/meta*.ts` | Flow in `main.ts` |

Shared files that anyone may read but should change only with care: `src/render/engine.ts` (core), `src/render/palette.ts`, `src/render/assets.ts`, `src/render/fx/quads.ts`.

## Definition of done for any workstream
1. `npm run typecheck` and `npm test` pass, and `npm run e2e` still passes. Fix any e2e step your change breaks.
2. You looked at real screenshots of your work in the running game, at 1600×900, and fixed what looked wrong.
3. New assets are credited in `CREDITS.md` with the exact license.
4. Commit with a clear message.

## Audio API (`src/audio/`)
Import from `src/audio` (`src/game/audio.ts` re-exports it for old callers). Nothing plays until the first user gesture; every call is safe before that and never throws.

| Call | What it does |
| --- | --- |
| `sfx(name, opts?)` | One-shot cue. `opts`: `x` (0..1600, stereo pan), `y`, `layer` (`'ship'` our hull and guns: close, narrow; `'air'`: aircraft and flak, panned; `'ground'`: the city far below, low-passed, quieter, wetter and 45-105 ms late; `'ui'`: dry, centred), `ground: true` (shorthand for the ground layer), `size` (field radius, scales explosions), `vol`, `pitch`. Each cue has a min gap, a burst cap and a priority; low-priority cues are dropped first when voices run out. |
| Cue names | Our guns: `pew` (bow autocannon), `spread`, `cannon` (a broadside shell lobbed at the ground; dips the music), `mortar`, `broadside` (whole ripple volley: `size` rounds 35 ms apart, panned hard to the `x` side; played from the `broadside` event), `flak`, `missile`, `bombDrop`, `rail`, `zap` (arc), `pd`, `lance` (Overdrive). Overdrive: `od_lance`, `od_spear`, `od_wing`, `od_bulwark` (`size` = duration), `odReady`, `odEnd`. Impacts: `boom` (kill; uses `size` and `ground`), `bossDown`, `carnageTier` (`size` = tier), `groundBoom` (bombs and shells in the city), `big` (elite, boss or our death; ducks and muffles), `collapse` (building), `flakPop`, `hit` (our hull), `shield`. Enemy: `eshot`, `eMissile`, `railCharge`, `jet`. Salvage and state: `pick` (rises a semitone per pickup in a stream), `alarm` (ship klaxon), `clear`. UI: `ui` (relay click), `uiHover`, `uiSwitch`, `uiToggle`, `uiOpen`, `uiClose`, `uiConfirm`, `uiError`, `uiFlap` (split-flap rattle; `size` = number of flaps), `buy` / `uiStamp` (stamp thunk). Full list in `src/audio/cues.ts`. |
| `music.setScene(s)` | `'title' \| 'map' \| 'combat' \| 'elite' \| 'boss' \| 'victory' \| 'death' \| 'silent'`. Changes land on the playing track's next bar line with an equal-power crossfade. Escalations are immediate; calm-downs wait 2.5 s; `victory` plays out, then hands over to `map`; `death` is a tape-stop into a requiem drone. `main.ts` calls this at every screen change. |
| `music.sting(kind)` | `'eliteKill' \| 'bossPhase2' \| 'clear' \| 'sectorClear' \| 'carnage'`: orchestral hit on the next beat, music ducks under it. The per-frame watcher already fires elite kill, boss phase 2, area clear and the carnage drop (8 kills in 3 s, once per 20 s). |
| `music.beat()` | `{ index, phase, bar, beatInBar, bpm }` of the beat audible now, or null. Use it to pulse visuals on the music. |
| `music.setIntensity(0..1)` | War-drum layer on the music's beat. Set automatically from the fight by `updateAudio`. |
| `setShipThrottle(0..1)` | Engine drone swell. When not called for 0.5 s, the watcher derives it from ship motion. `setHullIntegrity(0..1)` makes a damaged engine cough. |
| `updateAudio(dt, combatState \| null, paused)` | Once per frame from `main.ts`, after the sim. Reads the combat state structurally (`CombatView`). It consumes `S.events` by id: `broadside` -> the ripple (and mutes per-round gun cues for its length), `kill` -> an explosion sized and placed (ground or air) from `EN`, `eliteKill` -> blast + sting, `bossDown` -> cascade, `structure` -> collapse, `carnageTier` -> rising swell (tier 3 adds the carnage drop), `overdrive*` -> the kind's signature, a heavy `playerHit` -> muffle. `S.slowFx` closes a low-pass over the whole mix; a hitstop of 90 ms or more ducks the effects for its length; `S.pickStreak.n` (passed as `size` to `pick`) climbs a pentatonic ladder. It also drives the engine, sirens, fires, enemy radio chatter (cut by a squelch when the speaker dies), jet fly-bys, intensity, stings, low-hull muffling and pause ducking. |
| `audioSettings.get() / set(patch) / onChange(f)` | Persisted volumes `{ master, music, sfx, muted }`, 0..1, in `localStorage['gd.audio.v1']` (the old `gd.mute` flag is honoured). Shortcuts: `getVolume(kind)`, `setVolume(kind, v)`, `setMuted(b)`, `isMuted()`, `audio.on`. Sliders map through a perceptual curve. |
| `chatter(id, x)` / `cutChatter(id, x)` | Manual enemy radio burst, and the squelch cut. |

Mix: cues -> distance gain, altitude low-pass and pan -> sfx bus (with a generated open-air reverb) and ambience bus -> muffle low-pass -> glue compressor (-14 dB, 8:1) -> tanh soft clip -> master; music has its own bus with ducking; master -> limiter (-1 dB) -> soft ceiling at -0.3 dBFS. Levels: music about -18 LUFS, the engine about -27 LUFS idle to -23 at full ahead, the city bed about -30 to -24 LUFS, single SFX peaks below -3 dBFS, nothing clips under the worst-case barrage.

Assets and tools (`scripts/audio/`, need ffmpeg):
- `build-music.mjs <srcDir>`: cuts each recording to a whole-bar loop that wraps on the music's own repetition, crossfades the seam, normalises to -18 LUFS, writes `public/assets/audio/music/*.mp3` and `src/audio/trackdata.ts`. Helpers: `analyze-track.mjs` (tempo grid, downbeat, per-bar loudness), `find-repeat.mjs` (where a recording repeats), `seam-check.mjs` (waveform and spectrogram of the loop wrap).
- `build-sfx.mjs <srcDir>`: cuts, trims, fades and peak-normalises (-3 dBFS) the sampled layers into mono MP3s.
- `probe.mjs <files>`: duration, bitrate, integrated LUFS, true peak.
- `render-cues.mjs [outDir] [scenario...]`: renders every cue, a worst-case barrage, the music through all scenes, the engine and the city through the real mix graph in headless Chromium (`/src/audio/lab.html` on the dev server), writes WAVs and fails if anything clips.

## Gameplay state

Everything below lives on the combat state `S` (`src/game/combat.ts`) unless noted. Field units, y down, bow points up.
Renderers read it every frame; nothing here needs to be written by them.

### Player ship (`S.P`)
- `x, y` hull centre. `vx, vy` velocity (units/s). `bank` eased roll input in -1..1 (negative rolls left): tilt the hull by it.
- `dv` is `derive(build, mods)`: `speed` (top), `accel`, `brake` (units/s²), `rects`, `mounts`, `maxHp`, ...
- `tx, ty` pointer-steer target (null when keys steer). Movement math: `src/game/feel.ts` (`stepShipVelocity`, `arriveWish`, `stepBank`).
- Bounds: the whole 1600×900 field minus the hull's half size (56 units kept clear at the top for the HUD).

### Firing arcs, facing, hull shadows and target layers (`src/data/parts.ts`)
Where a gun is mounted, which way it faces and what stands around it decide where it can point and what it can hit.

**Hull shape.** Sections are long and narrow (`SECTIONS[t].w` is the beam, `h` the length along the keel; the hull proper is
`HULL_BEAM` wide, a battery's sponsons stand out of it). A starter is ~229 × 93 field units, an eight-section ship ~550 long, so
section order really moves guns along the keel. `slotPos(type, i)` places mounts: the bridge gun ahead of the tower, Gun Deck turrets
on the centreline fore and aft, battery sponsons port and starboard with a centreline casemate between. Any section, the bridge too,
may sit anywhere in the order.

**Module grid.** Modules are placed on a grid (`Section.at` = [centre x from the keel line, forward y], design units, multiples of
`GRID`), so a ship can be any joined shape: a single column, a wide hammerhead, outrigger batteries. `layoutOf(build)` gives every
module's spot (`autoLayout` stacks a column when none is placed; a module without a spot goes astern on the keel line).
`layoutIssue` refuses overlaps and modules that do not join the hull edge to edge; `canPlace`, `attachSpots`, `pinLayout` and
`placeModule` / `canCutSection` (refitLogic.ts) keep the ship in one piece. `derive` centres the ship on its bounding box.

**Facing.** Every weapon mount has a facing (`Facing` 0..7, 45° steps clockwise from the bow: 0 bow, 2 starboard, 4 stern, 6 port),
stored per slot in `Section.face` (it belongs to the mount, not the part). `allowedFacings(type, i)`, `defaultFacing`,
`mountFacing(section, i)`, `nextFacing` and `rotateMount` (refitLogic.ts) handle it.

**Turret rings.** Every weapon mount has a ring level (`Section.ring`, 1..`RING_MAX` 3, `mountRing`); a refit (`upgradeRing`, scrap
`ringCost(level)`: 60, then 140) widens the arc. Half-widths by level in `RING`: top deck 120° / 180° / 360°, sponson 90° / 130° /
its whole side, bridge gun 70° / 100° / 140°. `TRAVERSE` is the standard ring.

| Arc | Mounts | Facings | Traverse about the facing | Engages |
| --- | --- | --- | --- | --- |
| `bow` | Command Bridge | fore, fore-port, fore-starboard | `RING.bow`, clipped to the forward half | air and ground |
| `dorsal` | Gun Deck turrets (top deck) | any | `RING.dorsal` | air only: they cannot depress below the hull |
| `broadside` | Broadside Battery | outboard on its side: fore / abeam / aft quarter (the centre casemate either side) | `RING.broadside`, clipped to its own side | air and ground |
| `ventral` | any bomb bay or mortar | ignored | falls (`down: true`) | ground only; a flying ghost is out of reach |
| `omni` | point defense, arc coils | ignored | all round | PD: enemy fire (`shots`); coils: air from the top deck, air and ground elsewhere |

**Ranges.** `RANGE` / `mountRange(arc, partId)` (also `Mount.range`): bridge gun 1000, top deck 720, broadside 760, bombs 420, mortars
640, arc coils 240, point defense 200 field units.

**Hull shadows.** `hullObstacles(rects)` lists what stands in the way: the bridge tower and engine funnels (tall: they block the bridge
gun and top-deck turrets of other modules) and every module's hull (it blocks sponsons of other modules: a sponson cannot fire
through the ship, so a module beside or ahead of a battery masks it).
`hullShadows(trav, x, y, si, obstacles)` removes the bearings each obstacle subtends from the mount (a turret right behind the tower
loses about ±31° dead ahead, one far aft only a few degrees), so sectors can come out in two pieces, and records them in
`trav.blocked` (`{ c, h, by }`). `Derived.obstacles` keeps the list; `traverseIn(d, si, i, partId)` previews a part in a mount.

- Every `Mount` has `facing`, `arc`, `side: -1 | 0 | 1` (broadside port/starboard from its facing; 0 for other arcs) and
  `trav: Traverse` = `mountTraverse(sectionType, slotKind, partId, facing)` masked by `hullShadows`:
  `{ arc, sectors: { c, h }[], layers, down, blocked }`. Sector angles are in SHIP space
  (radians, 0 = dead ahead, +PI/2 = starboard). `shipToField(a, mirrored)` / `fieldToShip` convert (the player's bow points up the
  screen, a ghost's down: `mirrored = true`), `inTraverse(trav, fieldAngle, mirrored)` tests a bearing and
  `clampTraverse(trav, fieldAngle, mirrored)` clamps one into the nearest sector. The ship renderer should clamp turret yaw with the same
  helpers. `layersHit(layers, enemyLayer)` decides what a mount may engage (a ghost dreadnought is layer `both`: air guns reach it,
  ground ordnance does not). `LAYERS_TAG` gives the HUD / refit tag (AIR, GND, ALL, PD). `placementNote(partId)` is the part slip line.
- Ghosts carry facings (`GhostSections[].face`, validated 0..7 by `server/validate.mjs`; the client falls back to the default where a
  facing is not allowed). Older ghosts without `face` get the defaults.
- `ARC_INFO[arc]` gives `label`, `short`, `col` and `desc` for the UI. `positionArc(sectionType, slotKind)` is the arc a mount position
  gives (bridge bow, gun deck dorsal, battery broadside); `mountArc(sectionType, slotKind, partId)` the effective arc (bombs and mortars
  are always ventral, arc coils and PD omni).
- Combat honours the masked traverse everywhere (`arcTarget(m, x, y)` in combat.ts returns `{ e, a }`: a target and a field bearing to
  it inside `m.trav`, or null). A gun only picks targets with a bearing inside its sectors (for a ghost hull, any of its keel, beam or
  centre points), prefers what lies near its facing (`OFF_FACING`), and every round, fan bolt and missile launch is clamped into the
  traverse: an aft-angled sponson fires aft, a turret turned astern engages astern, and a bearing the hull blocks is never fired
  through. With nothing to shoot a broadside round goes out along its facing (`restAngle`). Muzzles are the mount's real `ox, oy`
  along the keel; rails start there. `blockedAt(trav, a)` tells a blocked bearing from one outside the arc.
- Ranges are data (`RANGE` / `Mount.range` in parts.ts; `ARC_RANGE` in combat.ts is the same table): bow 1000, dorsal 720 (air only),
  broadside 760 (ground targets get lobbed shells; bow flak lobs them too), mortars 640 and coils 240 from the mount, point defense 200,
  bomb bays under the hull. A gun with nothing in its arc holds fire. Missiles and rails also respect the mount's layers.
- Broadside cadence (`BROADSIDE`): each side fires one ripple volley about every 1.7 s, stern to bow, 35 ms between rounds; each gun packs
  `broadsideRounds(part)` rounds (period / cooldown, max 12) at 1.2x damage, +10% per extra gun on the side.
- Enemy weapons have `range` (`EN[type].range`, measured to the hull by `hullDist`). Out-ranging them is the positional game.

### Gunnery: AUTO guns and aimed HEAVY groups (`src/data/parts.ts`, gunnery section of combat.ts)
- `weaponControl(id)`: **AUTO** (pulse, scatter, flak, arc coil, point defense) fire on their own at the best target in their arc and keep
  the screen alive; **HEAVY** (rail, missile, mortar, bomb) are fired by the pilot. `weaponFamily(id)` maps heavy parts to a family
  (`rail`, `missile`, `mortar` = artillery, `bomb`); `HEAVY_FAMILIES[f]` = `{ name, slot, short, icon, col, aim, reach }`.
- `weaponGroups(mounts)` numbers the families the ship carries 1.. in `FAMILY_ORDER` (rails, missiles, mortars, bombs); `S.groups` holds
  them for the fight. `autoMounts(mounts)` lists the AUTO guns.
- `gunnery = { manual, family }`: `manual` is on when a mouse flies the guns (main.ts sets it from `(pointer: fine)` and from the pointer type
  of each press); off (touch, the balance harness, headless tests) every heavy gun aims itself exactly as before. `family` remembers the
  selected group across fights.
- `aim = { x, y, fire, salvo, group, lock, lockT, hover, bears, why, shotAt }`: the reticle in field units (the point under the mouse; ground
  ordnance hits the ground under that pixel). `fire` = left button (the selected group), `salvo` = right button (every group).
  `selectGroup(i)`, `cycleGroup(d)`, `firingGroups()`. Each frame `updateAim` sets `hover` (target under the reticle), the missile `lock`
  (target nearest the reticle within `MANUAL.lockR` 170, while a missile group is selected or salvoing) and per heavy mount
  `why[uid]` = `heavyWhy(m, x, y, target)`: `''` (bears), `'arc'` (outside its facing's arc), `'blocked'` (inside it, but the ship's
  own hull masks the bearing: `m.trav.blocked`), `'range'` (ground ordnance beyond `reach`:
  bombs 420, mortars 640 from the mount), `'air'` (a top-deck gun and the target is on the ground), `'ground'`. `bears[uid]` is `why === ''`.
- Manual fire (`fireHeavy`): a loaded heavy gun whose group is pulled and that bears fires at `MANUAL.dmgMul` (1.1x, in place of the
  broadside ripple's 1.2x): rails along the line to the reticle (clamped to the traverse), missile pairs on the lock (or to the point,
  detonating there), mortar shells and bombs onto the ground under it (fall time grows with distance). Heavy shots kick the camera
  (`kick`, `addTrauma`), set `fireLog` (turret recoil) and `aim.shotAt` (reticle punch). `manualAimFor(uid)` is the renderer hook that
  trains a heavy turret on the reticle or lock.
- Input (main.ts): mouse moves the reticle (through `screenToField`); left button fires the selected group, right button salvoes; `1`-`9`
  select, `Q` / `E` and the wheel cycle (`uiSwitch`, or `uiError` when there is no such group); the system cursor hides over the field.
  Touch: drag steers, every gun aims itself. Space stays Overdrive. Hold Shift (or T to latch) for the FLIR thermal view.
- HUD (`src/render/hud.ts`): bottom-left weapon panel with a numbered slot per heavy group (keycap, icon, AIR/GND/ALL tag, a reload pip
  per mount, dimmed when it cannot bear, READY / n/m BEAR / NO BEARING / BLOCKED) and an AUTO lamp bank; the reticle (brackets, reload
  ring per mount, group tag, a slash and OUT OF ARC / BLOCKED / OUT OF REACH / AIR ONLY when nothing bears, a dashed impact ring for
  ground ordnance and the reach circles when out of reach, dashed firing lines from rails that bear and, for those that do not, every
  open sector of their masked traverse as a wedge drawn through the camera with the hull-blocked bearings in hostile red, closing lock
  brackets for missiles, and a HOLD LMB prompt until the first heavy shot). Rear entries holding off the bottom edge show a pulsing
  ASTERN double chevron with a fill bar (`asternWarnings`), one per group.
- Ghost bosses keep their own fire control (`bossFire`, ghost broadsides) but train every gun inside its mount's recorded facing and
  masked traverse (mirrored), and an aimed gun with no bearing on the player's hull holds fire (see "Ghost bosses").

### Events (`S.events`, `S.eventId`)
Sim to audio/VFX/UI queue, capped at 160. Each `GameEvent` has an increasing `id`; consumers remember the last id they handled
(so `debug.timeScale` multi-steps lose nothing). Types: `broadside` (`side`, `n` guns, `kind` = rounds as a string, x/y at the hull side),
`kill` (`kind` enemy type, `n` max hull), `eliteKill`, `bossDown`, `overdrive` / `overdriveReady` / `overdriveEnd` (`kind`),
`structure` (`n` scrap it paid), `carnageTier` (`n` new whole multiplier), `playerHit` (`n` damage).

### Overdrive (`S.overdrive`)
`{ charge 0..1, active, kind, t (seconds left), dur, beam, extra, off, pulseT, ticks, trail, allies, radius }`. `extra[]` are upgrade
beams drawn like `beam` (Twin Lances, a Spear Fan). Every number below is before the upgrade tree (`S.odm`, see "Overdrive upgrade tree"). Space (`keys.od = true`, or `triggerOverdrive()`)
fires it when `charge >= 1`. Charge comes from kills (elites 0.5), structures and damage to a ghost. While active every battery fires 1.5x faster.
Kinds (`OVERDRIVES` in `src/data/hulls.ts`):
- `lance` Ventral Lance (Vanguard, 3.6 s): `beam = { x1, y1, x2, y2, w: 38, ground: true, col }` where (x1, y1) is the keel on the flight
  plane and (x2, y2) the same field point on the ground: draw a vertical column from `toFlight(x1, y1)` down to `toGround(x2, y2)`.
  Every 50 ms it calls `worldBlast(x, y, 44, dmg)` and burns ground units in radius 50. `trail[]` = `{ x, y, life, max }` scorch points
  that scroll with the city (draw burning ground, fade by life / max).
  The camera sees the beam end-on (the ground point under the keel is behind the hull), so the FX layer sells it by what
  spills past the silhouette: a glare disc on the city that backlights the hull, three impact rings racing out to about
  2.4x the hull radius, a molten furrow joining the trail points (white-hot, cooling as it scrolls out from under the
  stern), a halo rim, a screen-wide anamorphic flare and a bloom swell (eased). Combat also throws molten sparks and a
  dust front past the hull every burn tick.
- `spear` Lance Spear (Lance, 2.6 s): `beam = { x1, y1 (bow), x2: x1, y2: -60, w: 54, ground: false }` on the flight plane. Deletes enemy shots in it.
- `wing` Strike Wing (Leviathan, 7 s): `allies[]` = `{ x, y, vx, vy, hdg, cd, tg, t }`, eight strike craft on the flight plane. Their shots are normal `S.pb` bolts.
- `bulwark` Bulwark Aegis (Bastion, 5 s): a 460-radius shockwave on activation, then `radius` > 0: an aegis around the hull that eats enemy shots; damage taken halved.

### Overdrive upgrade tree (`src/data/overdriveTree.ts`, run.ts `takeOd`, `src/ui/screens/odTree.ts`)
Every Overdrive refits along branching paths. Three tiers: tier 1 picks a **path** (2-3 nodes; taking one locks the others), tier 2
offers two refits on that path (one locks the other), tier 3 is the path's capstone. Every tier-2/3 node `requires` its path's tier-1
node; `odState(id, taken)` gives `taken | open | locked | later`, `openOdNodes`, `canTakeOd`, `sanitizeOd` (untrusted lists).
Nodes carry typed effects (`OdFx`); `odMods(kind, taken)` folds them into `OdMods` = `{ dur, dmg, width, count, charge, mend, taken,
follow, air, furrow, twin, skyburn, bombs, intercept, hold, sweep, finale, reflect, pulse, vacuum }`, which `startCombat` stores as
`S.odm` (from `CombatSetup.odTree`). Combat reads only those fields:
- Lance: **Sweep** (wider, `follow`: the ground point walks to the reticle, or the nearest ground target, `OD_SWEEP` 300 reach at
  380/s; `beam.x2, y2` is that point) → Broad Swath / Burning Furrow (the trail keeps burning ground units) → Twin Lances (two more
  beams `OD_TWIN.gap` either side, 60% damage). **Pierce** (narrower, 30% longer, burns aircraft within `OD_PIERCE` of the column) →
  Hot Core / Long Burn → Skyburner (double air damage, enemy fire dies in the column).
- Wing: **Swarm** (+4 craft) → Tight Formation / Long Patrol → Wolfpack (+4). **Heavy Bombers** (4 slower craft, `bomber: true`,
  bomb ground targets first: S.pb `bomb` bolts, aoe 60·width) → Cluster Bombs / Second Sortie → Heavy Payload. **Interceptors** (the
  craft hold a screen round the hull and shoot down enemy fire within 90·width, with S.beams tracer lines) → Wide Screen / Aces →
  Quick Turnaround (charge ×1.4).
- Spear: **Spear Fan** (1 + count beams `OD_FAN.step` 0.3 rad apart, in `beam` + `extra`, hits by segment distance) → Fivefold / Broad
  Heads → Scythe (the fan sweeps ±0.35 rad). **Charge and Hold** (width swells 0.6 → 2.0 over the run, +30%) → Focus / Sustain → Nova
  (as it ends the column detonates every 90 units).
- Bulwark: **Reflect** (eaten shots come back as our bolts, `OD_REFLECT`) → Mirror / Wide Aegis → Riposte. **Long Watch** (×1.6 time,
  40% damage taken) → Ironclad (30%) / Pulse (a 300-radius shockwave every 1.5 s, `OD_PULSE`) → Citadel. **Mend** (2.5% max hull/s,
  times heat healing) → Damage Crews / Salvage Field (a vacuum on every scrap drop) → Phoenix.

Earning picks (Spire-like): every sector boss banks a free **commission** (`run.odCredits`); the tree opens right after the trophy
(Continue banks it) and from the map's Overdrive button, where only commissions can be spent. Scrap buys refits at a **drydock** (its
one job: `OD_COST` 90 / 150 / 240 by tier) and at a **merchant** (times its price multiplier, any number). `takeOd(run, id, priceMul)`
spends a commission first. Picks are per run (`run.od`, in order); ghosts do not record them (a ghost has no Overdrive).
`tests/unit/overdriveTree.test.ts` holds the tree's shape and rules, the save migration, and that every node measurably changes a
fixed proving-ground fight (`tests/sim/odScenario.ts`).

### Carnage (`S.carnage`) and scrap
`{ value, mult 1..3, since, peak }` (`src/game/feel.ts`, `CARNAGE`). Kills and structures add value; after a 1.6 s grace it decays at
8 + 35% of value per second. `mult = 1 + value / 80`, capped at 3. Every scrap drop is `base * SCRAP_SCALE (0.31) * scrapSectorMul(sector) * carnage.mult *
heat.scrap * dv.scrapMult` (see "Scrap economy" below). Scrap magnet (`MAGNET` in parts.ts): scrap within `dv.magnet` (240 + 80 per Salvage Magnet tier + relic `magnetAdd`, e.g. Magnetized Hull +90) of the hull's edge is pulled in with an acceleration that grows as it nears and the longer it is held (`p.pull`), sideways drift is bled off so it curls into the hull, speed capped at 1500, and fast scrap throws a gold streak; anything within `MAGNET.collect` (26) of the hull is taken at once. All scrap also homes on its own after ~0.9 s (sooner with magnets) and is never lost off the bottom of the field (repair kits only come inside the reach); `S.pickStreak = { n, t }`
counts pickups landing within 0.5 s of each other (rising pitch for audio). City agent: `worldBlast()` should return about 1-4 scrap per
building destroyed; combat (`groundBlast`) first multiplies it by `cityPay()` (below), then pays `STRUCTURE_SCRAP` (0.4) of it with the usual scaling, adds `2 + scrap` carnage, counts it as a structure and feeds Overdrive.

### World and biomes (`src/game/worldgen.ts`, `biomegen.ts`, `terrain.ts`, `biomes.ts`; rendering in `src/render/world/`)
- **Biomes** (`biomes.ts`): `Biome` City 0, Port 1, Airfield 2, Desert 3, Snow 4, Forest 5; `BIOMES[b]` = `{ name, kind, pay }`;
  `RING` is the journey order. `biomeFor(sector, floor, seed)` returns `{ a, b }` (b = -1 when the fight stays in one biome).
  `startCombat` takes optional `floor` and `seed` (main.ts passes the node's floor, 10 for the boss, and `run.seed`) and sets
  `S.theme = a`, `S.biomeB = b`; without a seed (the balance harness) the ring starts at the city. The banner reads
  "Sector N · <biome>". `THEMES` (palette.ts) and `GRADES` (post.ts) have one entry per biome.
- **Rows**: the world is generated in rows (`CITY.chunks`) in a fixed city space: field y = `cy + S.scrollY`. `S.decor` holds every
  live structure (`type: 'bldg'`, dead ones stay as rubble) and crater, with field `x, y` kept in sync with the scroll. A row that
  holds night city is whole block rows (design units, shrunk by `CITY_K` 0.25, see `shrinkRow`); any other row is a 120-unit band.
  Each biome's generator (`GEN[b]` in biomegen.ts) fills the same band in field units and masks every object with
  `inBiome(b, x, cy)`, so two biomes share a band along a ragged, dithered edge; city rows are clipped the same way (`maskCity`).
- **Biome edge**: `BIO.edge` (city y, -760 by default: the edge reaches the ship about 20 s in), wandering ±250 across the field;
  `weightB(x, cy)` is 0..1 across a 220-unit band. When the ship's point crosses it `S.theme` and `CITY.theme` become the second
  biome (grade, `cityPay`) and the banner flashes the new name. Debug: `__city.setBiome(a, b, edgeCy)` reseeds immediately.
- **Terrain** (`terrain.ts`): analytic fields per biome, deterministic per fight (`CITY.seed`): height (shading only, the ground is
  flat), water, canopy cover, blended across the edge (`sampleCy`). Paths are analytic too (`coastX`, `riverX`, `valleyX`,
  `wadiX`, `highwayX`, `RUNWAY_X`), so generators, the baked grid and queries agree. Dams register in `DAMS` and fill their
  reservoir upstream. Noise is value noise with rotated octaves (no lattice creases).
- **Baked grid** `TERR`: a 600 x 512 RGBA8 ring of 4-unit cells (moon shade, water, cover, biome-B weight) baked a few rows per
  frame ahead of the generated rows (`bakeTerrain`, a rolling three-row window for the slope; the whole screen at seed time),
  uploaded when it changes. The ground is a patched `MeshStandardMaterial` (`terrainMaterial`): moon, explosion lights and the ship's
  shadow still land on it.
- **Structures**: `fb(ch, kind, x, cy, w, h, hgt, style, opts, tiers?)` places one in field units with hit points and `value` from
  its design size. Kinds add cranes, ships, hangars, planes, domes, igloos, rockets, gantries, walls, dams, bridges, cabins,
  lighthouses, pumps, masts, stands; `bGeo(kind)` picks the batch (box, cylinder, dome). New fields: `tint` (colour override),
  `roof` (snow 1 / sand 0.5), `fuel` (fireball and chain-blast size; tanks, silos, flares default 1), `spill` (ground fire it
  leaves, `Burn`). Styles add Adobe, Hangar (lit doors), Shell (pale, no windows), Hull (deck lights). Tier offsets rotate with `rot`.
- **Lights, roads, movers**: `ch.lights` (`WLight`: colour `LC`, kind 0 lamp that blacks out, 2 always on, 3 blink, 4 pool that
  never blacks out, 6 sequenced strobe, 7 rotating beacon, 8 lighthouse, 9 glowing line with `len` along cy (`ax` 0) or x (`ax` 1) that never blacks out), `ch.segs` (strips at any angle: country roads, tracks,
  breakwaters), `ch.movers` (boats with wakes, convoys and cars with headlights, barges, taxiing aircraft `jet`; drawn per frame from `CITY.time` into the
  engine's glow/dark batches), `ch.zones` (rects of a known surface for queries).
- **Destruction**: `worldBlast(x, y, r, dmg)` damages footprints (and roofs as seen), ignites, collapses, leaves a crater (spray
  instead on open water) and returns the scrap of what collapsed; it also sets `CITY.payK` to the pay of the biome it landed in, which
  `cityPay()` returns (combat multiplies by it). Fuel chain-reacts through combat's `groundBlast` so follow-ups pay like any other
  blast. The ground burns through the **event grid** `FIRE` (same layout as `DARK`: 128 x 128 cells of 20 units, RG float: start
  time, `Burn` kind): canopy hits start a wildfire that spreads downwind (`spreadFire`, every 0.25 s, capped at 420 cells, burning
  cells set structures alight), scrub fires stay small, spills burn in place (oil 26 s), frozen lakes crack (`Burn.Ice`: black water
  and steam). The ground shader draws flames, char and holes; the layer adds smoke columns for a sample of cells.
- **Pay**: `BIOMES[b].pay` is tuned so a random blast pays about what it does in the night city (sparser biomes pay more per
  structure): city 0.12, harbour 0.073, airbase 0.44, desert 0.2, mountains 0.18, forest 0.37. With them the economy table is
  s1 139 / s2 191 / s3 263 a fight (stock share 0.83 / 0.67 / 0.62), and `tests/unit/economy.test.ts` passes.
- `DARK`: the blackout grid. The power dies around the dreadnought as it passes (windows, street lamps, pools of kind 1); shaders sample it.
- **Renderer** (`city.ts`; materials are Lambert with `cheapLights`): terrain ground, flats (pads, roads, strips), buildings in three geometry batches, props, lights,
  traffic (masked to the night city through the terrain's biome weight), craters, up to four searchlight beams: about 10 draw calls,
  refilled only when a row enters or leaves; per frame only damaged buildings and a few dozen glow/dark quads (vessels, convoys,
  flares, lighthouse sweeps, ground-fire smoke). No per-frame allocation.
- **FLIR**: every world shader reads `uFlir` (`flirUniform`, src/render/flir.ts) and blends to a heat value: terrain, water, snow
  and sand cool (about 0.07-0.12), lit windows +0.12, lamps and pinpoints down to 18%, traffic 55%, burning buildings and ground
  fires hot (0.6-1.2).
- **Performance** (SwiftShader, 1600 x 900 at 0.6 scale). Measure the world with a synchronous scene render (`renderer.render`
  plus a 1-pixel `readPixels`, best of 8, world on minus world off, sim frozen): the frame interval on this shared sandbox swings
  by half between runs. The world tick averages 0.05-0.14 ms (worst 1-7 ms when a row is generated).
  - Night city: about 990 ms before the polish pass (median of four runs, 942-1040) and about 650 ms after (561-857), about -35%.
    What it took: world materials are Lambert instead of Standard (rough matte surfaces, cheaper BRDF); `cheapLights()` gives every
    lit world material a point-light loop that skips lights that are off or out of range (the seven FX point lights sit at zero
    intensity most frames, yet every world fragment paid for all of them: about 370 ms in the city); the full-block sidewalk pads are
    gone (the city ground is their colour), one hash per window instead of four, urban ground skips the fine detail noise, narrower
    road glows, boxes without bottom faces.
  - Mountains about 130-190 ms, airbase about 190-280 ms; the polished harbour costs more than before (about 375-405 ms against
    217-281) for its floodlight washes and denser yards, still well under the city.
  Structures on screen: city ~2900, harbour ~1700, desert ~200, airbase ~180, mountains ~160, forest ~120.
- Debug: `window.__city` = `{ CITY, DARK, TERR, FIRE, BIO, worldBlast, setBiome(a, b, edgeCy), setPieceIn(name), surfaceAt,
  isWater, isRunway, terrainAt }`; set piece names: stadium, tvtower, lighthouse, oilterminal, drydock, bigtransport, shelters,
  radar, launchsite, gasplant, citadel, dam, fort, mill, lookout. In dev, `window.__cityLayer`.

### Terrain queries (for naval and ground spawns; `src/game/worldgen.ts`)
All take field coordinates as on screen now and answer for the generated band (field y about -380 to 990; beyond it the analytic
fields still answer for the ground). None allocates except `terrainAt` without `out` and `findSurface`.

| Call | Answers |
| --- | --- |
| `biomeAt(x, y)` | The `Biome` at that point (the edge wanders across the field). |
| `isWater(x, y)` / `isLand(x, y)` | Open water (harbour, rivers, lakes that are not frozen) where naval units can sail / anything else. |
| `isIce(x, y)` | A frozen lake: walkable, cracks under fire. |
| `isRunway(x, y)` | On a runway or taxiway: aircraft can roll along it. |
| `isRoad(x, y)` | Road, runway, apron or quay: wheeled convoys prefer these. |
| `surfaceAt(x, y)` | `SurfaceKind`: water, ice, sand, snow, rock, forest, grass, urban, road, runway, apron, dock. |
| `terrainAt(x, y, out?)` | `{ biome, surface, h, water, cover }`. |
| `findSurface(kind or predicate, x0, y0, x1, y1, tries)` | A random point of that surface in a box (default: the top of the screen, where spawns enter) or null, e.g. `findSurface('water')` for a gunboat, `findSurface('runway')` for a jet's take-off roll. |

### Hitstop and slow-mo
- `S.stop = { left, since, total }`: while `left > 0` the simulation is frozen; the renderer keeps drawing (shake keeps decaying).
  Ordinary kills use the dead-air formula capped at 60 ms with a 240 ms cooldown; elite kill 120 ms, boss death 350 ms, heavy player hit 100 ms always land.
- `S.slowmo` timeline (tinwar shape: 0.25x, 100 ms ramp in, 1.2 s total, 300 ms ramp out); `SLOWMO_BOSS` 0.2x for 2 s, `SLOWMO_SHORT` on Overdrive.
  `S.slowK` is this frame's time scale, `S.slowFx` 0..1 intensity for a cinematic look (letterbox, vignette, audio low-pass).

### Enemies
Besides `x, y, r, hp, maxHp, layer, type`: `hdg` heading (aircraft), `ang` turret aim, `tele` 0..1 wind-up before a shot (draw a growing hostile glint),
`vx`. Enemy shots in `S.eb` carry `src` (who fired). Kinds unchanged: `bullet`, `orb`, `mine`, `missile`, `beam` (warn then fire), `strike` (growing ring).
- **Threats from astern** (`AFT` in combat.ts): a share of director groups come up from behind the ship, so facings matter: interceptors
  overtake up one side of the hull (`overtake`, one snap shot as they draw level with the stern), drone columns climb the field
  (`dir: -1`), helicopters and gunships take station off an aft quarter (`quarter: side`, `quarterPoint`), and the ace holds an aft
  quarter on 12% of its stations in sector 1, 28% from sector 3. Shares (jet 22%, drones 30%, helis 32%, gunships 38%) ramp in with
  the level (`aftRamp`: ×0.35 in the first fights, full from level 3.5). A rear entry (`aft: true`) first holds off the bottom edge
  (`AFT.y`, below the camera) for `AFT.warn` (1.3 s, `e.warnT` counts down; it neither moves nor fires nor is targeted), under the HUD's
  ASTERN chevron. `spawnGroup(type, true)` forces rear entries. Ground units the ship has passed over keep firing aft while in range.
- Elite hull by sector: `eliteSectorHp` (0.7 + 0.3 per sector, but 1.15 in sector 2). The carrier launches drones every 4.6 s and
  fans every 3.3 s.

### Ghost bosses (`S.boss`, boss section of combat.ts)
A ghost flies its recorded build (`ghostToBuild`), mirrored: its bow points down the screen, so a mount at design offset
(ox, oy) sits at field (x + ox·s, y − oy·s). Every `BossGun` keeps its mount's `arc` and `side`:
- every gun keeps its recorded facing and ring (`BossGun.facing`, masked `trav`) and fires only along a bearing on the player's hull
  inside it (`bossGunBears`, using the keel, beam and centre points of our hull): **a ghost's blind arcs are safe water**. Bridge and
  top-deck guns hold fire (stay loaded) while the player is outside their arcs; bridge and turret rails aim along their bearing
  (`eb` beam with `x2, y2`). Muzzles sit on the real mounts along the keel (`bossGunPos`). Ghosts are drawn at most 440 long
  (`s = min(1.6, 440 / len, 700 / width)`, `homeY = len·s/2 + 60`) so a long player hull keeps sea room beside and under them;
- every ghost round is scaled by `bossHitEase()` = 2.6 / SHIP_SCALE (×0.85 more from sector 3): the scale pass made our hull a
  bigger target. Scripted pilot hull lost per boss: s1 32% / s2 60% / s3 70%;
- ventral (bombs: mines; mortars: telegraphed strikes) and omni (arc coil rings, point defense) as before;
- broadside lanes lock on each sponson's bearing to the player (`bossLock`), and a flank engages when at least one of its sponsons
  bears (`bossFiring`; phase 3 fires every sponson, blind ones along the nearest edge of their arc). Rakes, weaves and the slow second
  layer are clamped into each sponson's arc; slipping into its blind arc during the wind-up spoils the volley;
- broadside guns fire **volleys** per flank (`B.volley[0]` port / screen left, `[1]` starboard): a flank whose arc holds the
  player winds up for `BOSS_BROADSIDE.tele[phase]` s (the FX layer draws `B.glints`: a hostile glint per gun and its lane,
  or the arc it will rake), then ripples stern to bow, `stagger` 75 ms per round. Rounds per gun `bossRounds(part, phase)`.
  Pulse fires twin-barrel pairs, scatter a 3-fan, flak an orb that bursts into 6, seekers a pair, rail a telegraphed beam
  across the field (`eb` beam with `x2, y2`). Every sponson has a side from its facing (the centre mount too).
- Phases by hull (`BOSS_PHASES` 66% / 33%, notches on the HUD bar): 1 **lanes** (each gun's rounds on one locked line;
  the ghost sweeps the field), 2 **rake** (rounds sweep ±0.45 rad across the locked line with a 0.34 rad hole; the ghost
  comes about to hold the player on its beam, at about 85 units/s), 3 **full broadside** (both flanks every volley,
  ±0.15 weave plus a slow second layer, 40 units lower). Fire rate ×1 / ×1.25 / ×1.45. Under its bow you face the bow
  guns; beside it, the broadsides. The player's hull is shouldered out of the ghost's bounding box.
- Hull: `(1800·sector^1.55 + 2·ghost hull) · max(1, 2.15 − 0.4·sector)` (×1.75 in sector 1, ×1.35 in 2): a ghost that comes
  about to bring its broadsides to bear also takes ours, and early builds are broadside-heavy. Hull damage from its
  broadsides is tallied as `boss:broadside` in `S.stats.dmgBy` (rails `boss:broadside:rail`), bow, ventral and omni as `boss`.
- Defense cores (`aiGhost`, no player ghost available) always carry a Broadside Battery behind the bridge, a second
  from sector 3, with broadside-capable guns on its flanks, and deliberate facings (`AI_FACE`) and rings (`AI_RING`): sector 1 has
  sponsons angled aft and turrets astern, so off its bow quarters (about 35-90° off its bow) nothing bears; sector 2 sponsons abeam,
  one turret forward and one astern on wide rings; sector 3+ the fore battery angled forward, wide rings everywhere, full turret
  rings from sector 4. Client ghost validation (`validGhost`) keeps recorded `face`, `ring` and `at`.

### Scrap economy (`tests/sim/economy.ts`, `tests/unit/economy.test.ts`)
`BALANCE=1 npx vitest run tests/unit/economy.test.ts --disable-console-intercept` prints, per sector, the mean scrap of
every fight (floors 2 and 6), elite and boss (plus the boss strip option) with the harness builds, the income of an
average route (4.3 fights, 0.9 elites, a derelict, a boss), and the price of an average merchant part and a merchant's
whole stock (3 parts, 2 a tier better, 2 sections, a relic, patching half the hull).
Before tuning, sector 3 paid 542 a fight against a 341 average part (1.59 parts per fight vs 0.84 in sector 1) and a
sector's income bought 117% of a merchant's stock. With city destruction merged (`worldBlast` pays 1-4 scrap per
collapsed building) sectors 1 and 2 rose another ~55% (148 and 294 a fight). The levers, all in combat.ts:
- `SCRAP_SECTOR_TAX = 0.45`: every drop is divided by `1 + 0.45·(sector − 1)` (×0.69 in sector 2, ×0.53 in sector 3,
  ×0.45 in 4); the boss's death scrap too.
- `STRUCTURE_SCRAP = 0.4`: a building pays 40% of `worldBlast`'s scrap, and adds `2 + scrap` carnage (was `3 + 1.5·scrap`,
  which pinned the multiplier at x3 on any street).
- Merchant repairs cost by the hull point (run.ts `REPAIR`): 3 hull per scrap in sector 1, divided by `1 + 0.35·(sector − 1)`
  (3, 2.2, 1.76), times the heat repair factor.

| Sector | Fight | Elite | Boss + strip | Route income | Avg part | Merchant stock | Half-hull repair | Parts / fight | Income / stock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 136 | 104 | 279 | 1008 | 111 | 1237 | 46 | 1.23 | 0.82 |
| 2 | 218 | 139 | 311 | 1423 | 217 | 1883 | 77 | 1.00 | 0.76 |
| 3 | 251 | 120 | 310 | 1548 | 341 | 2573 | 124 | 0.74 | 0.60 |

(After the scrap magnet and placement arcs: bow guns now reach ground targets and no scrap is lost off the field, which lifted
sector 1 fights to 154; `SCRAP_SCALE` went from 0.35 to 0.31 to bring the curve back.)

Early rampages pay a little more (a fight buys about one part in sectors 1-2), and by sector 3 a fight buys 0.74 of an
average part and a whole sector about 60% of one merchant's stock, so the last shop is a choice between parts, a
section, a relic and repairs. The unit test fails if a sector 3 fight buys more than 15% more than a sector 1 fight, or
if sector 3 income leaves the 0.35–0.85 stock band.

### Repairs and heat 8
All out-of-combat repairs go through `run.ts`: `healAmount(run, frac)` (what a heal would restore now, after heat and
capped at the missing hull; screens quote it), `heal(run, frac)` (drydock 35%, signals, boss salvage 30%, Nanite Vats) and
`repairQuote` / `buyRepair` (merchant, by the hull point). Heat 8 *No Quarter* multiplies all of them, and repair kits
picked up in combat, by 0.7; `tests/unit/repair.test.ts` holds the heat description to that number.

### Fight stats (`S.stats`, `S.seen`)
`kills, airKills, groundKills, elites, structures, broadsides, maxVolley, overdrives, lanceStructures, dmgTaken, dmgDealt, dmgToTarget,
peakCarnage, scrapRaw, dmgBy{src: dmg}`. `S.seen` = kills per enemy type this fight (codex). main.ts folds them into `run.stats` / `run.seen`.

### Run (`src/game/run.ts`, save v4)
`RunState` adds `hull`, `heat`, `daily` (date key or null), `won`, `endless`, `phase: 'map' | 'victory'`, `odStart`, `seen`, the wider
`RunStats`, and the Overdrive tree: `od` (node ids, sanitized on load and filtered to the hull's Overdrive) and `odCredits` (banked
commissions, 0..9). Saved under `gd.run.v4`; `migrateRunSave` steps v2 (to the Vanguard at heat 0) → v3 → v4 (no picks, one commission
per boss already beaten); old `gd.run.v3` / `gd.run.v2` keys are still read. `CAMPAIGN_SECTORS = 3`:
clearing sector 3 shows the victory screen; the pilot banks the run or pushes on into endless sectors.

### Profile and the fleet loop (`src/game/meta.ts`, `src/data/goals.ts`, `src/data/hulls.ts`, `src/data/heat.ts`)
- `Profile` in localStorage `gd.profile`, `PROFILE_VERSION` 2 with step migrations (`migrateProfile` takes anything).
  Fields: `xp`, `stats` (lifetime `MetaStats`), `goals`, `flown`, selected `hull` and `heat`, `codex { enemies, parts, relics, ghosts }`, `best`, `daily`, `history`.
- Rank: `rankOf(xp)` over `RANKS` (10 ranks, Ensign to Fleet Admiral); hulls unlock at ranks 2 / 4 / 6; `perksFor(xp)` gives launch perks.
- `settleRun(profile, summary)` is pure and returns XP lines, goals completed, rank change, new hulls, heat unlocked, best/daily records.
  main.ts settles exactly once per run: on death, on retiring after victory, or on abandoning (half XP).
- Heat: `maxHeat(profile)` is 0 until the first victory, then one above the highest heat won (max 8). `heatFx(level)` folds the modifiers.
- Daily strike: `dailySeed(utcDateKey())` (UTC days, so every time zone flies the same route), Vanguard, heat 0, no perks; `dailyShareLine` for sharing. Ranked on the duty roster below.
- Screens: `src/game/metaScreens.ts` (launch panel on the title, Admiralty with service record / goals / codex tabs, wreck report, victory, port).

### Daily strike duty roster (leaderboard)
- **Score** (`dailyScore` in `src/game/meta.ts`, constants `DAILY_SCORE`), from the run's existing stats:

  `daily score = combat score + 2500 × nodes charted + 1500 × elites + 6000 × ghosts laid to rest + 5 × structures + 25000 if victory`

  Combat score (`run.stats.score`) already carries enemy value, enemy level and the carnage multiplier. The route terms make depth
  count: one more node is worth more than a typical fight's kills, so a pilot who reaches sector 3 outranks one who farms sector 1.
  Endless sectors after a victory keep adding. The profile's `daily` record and the share line use this score.
- **API** (`server/server.mjs`, validation in `server/validate.mjs`, the board in `server/daily.mjs`, stored in `GHOST_DATA_DIR/daily.json`, 60 days kept):
  - `GET /api/daily/:date[?callsign=X&limit=N]` -> `{ today, date, count, entries: top 50 [{ rank, callsign, date, score, sector, floor, kills, hull, won, at }], you? }`. `you` is that callsign's row and rank, even outside the top 50. Bad dates are a 400.
  - `POST /api/daily` with `{ callsign, date, score, sector, floor, kills, hull, won }` -> `201 { ok, improved: true, rank, count, entry }`, or `200 { improved: false, ... }` when the callsign already has a better run that day (the best run per callsign per day is kept). Strict validation, no clamping: `date` must be a real `YYYY-MM-DD` equal to today's or yesterday's UTC date; integers only, `score` 0..20,000,000, `sector` 1..99, `floor` 0..20, `kills` 0..100,000; `hull` a known class; `won` a boolean (and needs sector 3+); callsign 1-16 of `A-Z 0-9 space _ . -` (case-folded; raw strings over 40 chars refused); body under 2 KB. Rate limit per IP: 12 filings an hour, 5 s apart (429 with `retry-after`; `DAILY_RATE_MAX` raises the hourly cap, the e2e server sets it).
  - Ranking: score, then sector, then floor, then the earlier filing.
- **Client** (`src/game/daily.ts`): `filingFor(callsign, settlement)` builds the filing from `Settlement.summary` / `dailyScore`; `submitDaily` returns `filed | kept | queued | rejected`. Offline, 429 or 5xx queue the filing in `localStorage['gd.daily.pending']` (best per callsign and day); `flushPendingDaily()` resends them when the roster is next opened and drops ones whose day has closed. `fetchDailyBoard(date, callsign)` returns `online: false` instead of throwing.
- **UI** (`src/ui/screens/roster.ts`): the roster is fan-fold line-printer paper (pin-feed margins, green bars, line-by-line print), the pilot's row marked with a highlighter, a rubber stamp for the filing result (Filed / On file / Held / Refused). It prints on the wreck report (death) and the port report (retiring after victory) of daily runs, and in the Daily Strike briefing on the title (today / yesterday tabs, then the launch switch, `#btn-daily-launch`). Offline it says "No carrier" and shows this device's own run, unranked.

### Balance harness
`tests/sim/harness.ts` runs real fights headless with a scripted pilot and seeded `Math.random`. Bots: `pilot` (every gun aims
itself), `gunner` (same flying, `gunnery.manual` on, the reticle on the boss / elite or the nearest target and every heavy group
salvoing: what a mouse player does) and `idle`. A unit test holds the gunner's mean DPS over four seeds within 0.85-1.6x of the
pilot's (one fight swings about a quarter either way with threats from every bearing). The `s1end`, `mid` and `late` builds face their
mounts and carry wide rings as a mid-run pilot would. `BALANCE=1 npx vitest run
tests/unit/balance.test.ts --disable-console-intercept` prints the table (`ONLY=s2-boss,ace` narrows it).

### Debug hooks (`window.__gd`)
`run`, `profile`, `S`, `debug.timeScale`, `god()`, `winNow()` (kills boss/elite outright), `killPlayer()`, `overdrive()` (charge and fire),
`travelTo(type)`, `forceNext(type)`, `addScrap(n)`, `aim`, `gunnery`, `selectGroup(i)`, `spawn(type)` (one director group), `spawnElite(type)`.

## Units, symbology and FLIR (`src/render/units/`, `src/render/flir.ts`)
- **True-scale models** (`specs.ts`, `scale.ts`): `buildSpecs` authors each unit at any size, then sets `spec.scale` so its largest
  horizontal extent (slots, rotors, revetments included) is `TRUE_M[type]` metres. Multi-model units use `spec.squad` slots
  (`{x, z, yaw, s}`): an infantry entity is a fire team of four soldiers, an AA battery two gun pits, a SAM battery three launchers;
  `PartDef.once` parts (the revetment) are drawn once. Heads in slotted units keep yaw 0.
- **Ground lift**: true-scale ground units stand inside city blocks, so their livery material (`liveryMaterial(..., { ground: true })`)
  slides each vertex along the eye ray by `GROUND_LIFT` (110) world units of depth: same pixels, but the depth test sees them above the
  rooftops and still far below the flight plane (the ship covers them). Their light quads are lifted the same way (`UnitLayer.gq`).
- **Light is what you see at true scale** (`unitLayer.ts`): every light has a floor in screen units (`LIGHT_MIN`) so a lamp stays a point;
  `heat` lights are thermal cores (engine deck, rotor heads, crew) in warm white; barrels stay hot after firing (`Vis.barrel`); units below
  55% hull smoke from their first heat core (fire below 25%); wrecks stay hot for 22 s. Headlight beams, dust plumes, contrails, rotor
  discs and drop shadows are sized in metres. Effects use `fxs(v)` (half-size in metres with a floor).
- **Tactical symbology** (`symbology.ts`, drawn by `drawHud` under the panels in one canvas pass, preallocated arrays): per contact a tracker
  box (corner ticks round the unit's real footprint, never covering the unit) and a NATO-style symbol above it. Layer styles live in
  `marks.ts` (pure, `tests/unit/marks.test.ts`): air = hostile red open tent with a bob and a dashed drop line to a pip on its shadow
  (`SHADOW_DX/DY/ALT` in `scale.ts`, shared with the unit layer's drop shadow); ground = burnt amber filled diamond plus a ring decal;
  salvage = dim scrap gold square. Symbol size by threat tier from `EN` (light / standard / heavy / elite). Frames (ground diamond, air tent,
  salvage square; glyphs for armour, infantry, AA, SAM, flak tower, rotary, fixed wing, UAV, bomber, carrier, crate, pod, wreck). Contacts
  larger than `BIG` get a designator (SAM, FLAK, BOMBER...), elites a double box. Out of weapon range = 60% alpha, under our hull = 30%.
  `tele` wind-up turns the contact pale and closes a ring on it. `aim.hover` / `aim.lock` = white lock box. Damaged = a health tick.
  Same-class contacts within `GROUP_R` (30 screen units, single link) merge into one box with a count. Kills leave a short opening-box
  splash. Aircraft markers follow their visual altitude (`visAlt`, `altShift`).
- **FLIR** (`flir.ts`): `FLIR.on` (main.ts: Shift held or T latched, combat only), eased `FLIR.k` / `flirUniform`. The post grade remaps
  luminance to white-hot greyscale with scanlines and heavier grain; the livery shader swaps unit emissive for body heat (hotter low hull,
  lamps, burning wrecks); city windows, neon and lamps drop to ~15-20% (`uFlir` in `src/render/world/shaders.ts`), traffic to 55%; fires
  keep their light. The HUD adds crop marks, a readout and a 4x zoom inset on the target (copied from the WebGL canvas in the same frame).
  Costs: one uniform and a branch in the grade; nothing extra on the low tier.

## Refit board (`src/ui/refit.ts`, `src/ui/refitLogic.ts`, `src/ui/drag.ts`)
At true warship scale the guns are a few pixels on the hull, so the refit screen is an engineering callout drawing: the
ship's plan (`drawBlueprint` with an explicit `fit`) on a blueprint sheet, and every mount called out by a leader line to a
hand-sized, not-to-scale socket tile around it. Opened from the map (`#btn-refit`) and from the merchant's "Refit ship"
service, which also passes the counter (`market`, `sections` getters on `RefitExtras`).
- **Layout** (`layoutBoard`, pure): bow mount tile above the ship, port mounts (`ox < 0`) in the left column, starboard in the
  right, centreline mounts to the shorter column. Tiles sit level with their mount where they can (`resolve1D` spreads
  them in order inside the column), shrinking to 40 px when a column is crowded (`compact`). Anchors are where the mount is
  drawn (`mountDrawPos` in `shipPreview.ts`: broadside guns sit on their sponsons). Leaders run tile edge -> stub ->
  diagonal across the gutter -> level run over the hull -> mount; the diagonals share two vertical lines in the same order
  as the level runs, so a column's leaders cannot cross. Mounts level with each other (a battery's flank gun and centre
  bay) get runs `LEVEL_STEP` (15 px) apart. Below `STACK_BELOW` (640 px board width, phones) it stacks: ship on top with
  numbered balloons, numbered tiles listed under it. `tests/unit/refitBoard.test.ts` holds every hull and the worst
  8-section builds at four board sizes to: tiles in bounds, no overlaps, zero crossings, no leader through a tile, sides correct.
- **Moves** (pure): `Src` = hold / mount / counter, `Dst` = mount / hold. `checkMove` gives `ok` or a refusal (`kind`: wrong slot
  kind, `scrap`: counter part not affordable, `same`, `noop`) with the reason shown on the socket; `applyMove` swaps mount to
  mount, sends a replaced part to the hold, unmounts to the hold; `previewMove` returns the build a move would leave. Sections:
  `canMoveSection` / `moveSection` (insert; the bridge stays at the bow), `canCutSection` / `cutSection` (parts to the hold).
  The board applies every one inside `changeBuild(run, ...)` exactly as the old refit did; counter parts are bought with the
  merchant's own purchase function (`buyPart` in main.ts: scrap, sold flag, part into the hold) and then moved from the hold.
- **Preview**: while a part is picked or carried, every socket gets `.cand` (lit, with the arc tag and target layers the part
  would get there from `mountTraverse`, and its top stat deltas) or `.nope` (dimmed, with the reason). The socket under the
  pointer draws the firing-arc wedge on the plan (ventral ordnance: drop rings), redraws the ship with the previewed build and
  shows `statDeltas` in the particulars panel (hull, speed, fire rate, shield, rated anti-air / anti-ground dmg/s from
  `firepower()`, mass, thrust, PD, repair, drones). A section drag redraws the reordered hull at its own fit.
- **Drag** (`draggable(el, hooks)`): pointer events, one path for mouse, pen and touch. Mouse/pen start after 6 px of travel,
  a finger after a 260 ms press-and-hold (a quick swipe still scrolls). Targets are `[data-drop]` elements
  (`slot:<si>:<i>`, `hold`, `sec:<i>`, `cut`); the carried tile is a clone hung below-right of the pointer (so the socket under it stays
  readable) that snaps into the target (150 ms overshoot) or springs back. Edge auto-scroll while carrying (phones: hold below the board). Escape cancels. The board does not re-render
  mid-drag (`dragging()`).
- **Feedback**: landing plays `uiSound('stamp')` (a counter purchase `'buy'`), the socket does a clunk (scale overshoot and a
  well flash) and its leader and ring flash; refused drops `'deny'` and wobble. Gauges rebuild only when the committed fit
  changes, so needles swing once per refit.
- **Click and keyboard**: click (or Enter) a hold part to pick it, then a socket to place it; click a mounted part to pick it
  up, then another socket to swap or "Return to hold"; Delete unmounts the focused socket; Esc lets go. Sections also keep
  their ▲ ▼ buttons and guarded Cut switch; dropping a section in the cut bin asks for confirmation.
- Screenshots: `docs/shots/ui-refit-*.jpg` (board idle, drag over a lit / refused socket, equipped, swap, section drag,
  merchant counter, an 8-section build, phone).
- Hooks for tests: `.mtile[data-slot="si-i"]` (`.cand`, `.nope`, `.over`), `[data-inv]`, `[data-mkt]`, `.rf-hold`,
  `li.sec[data-sec]`, `.rf-toast`, `.board-lines .lead` / `.arc-w.hot`.

## Ship rendering (`src/render/ship/`)
- `hull.ts` builds a hull at the reference scale (`SHIP_SCALE` 2.6) and scales a `body` group by `SHIP_SCALE / 2.6`, so every detail keeps its proportion if the ship scale changes. Layer-facing points (`nozzles`, `vents`, `dmgPts`) are in root space; turret pivots are in body space (`model.k`).
- Three detail scales, all merged per material: superstructure (bridge stack, citadels), medium equipment (vents, tanks, deck houses), and the dense greeble layer in `greebles.ts` (recursively split machinery fields, masts, dishes, PDC blisters, heat sinks, hangar mouths, belt pipes, stencils). Seeded per hull section, so a build always looks the same and ghosts match their builds. Plate seams are procedural in the hull shader (`materials.ts`, fwidth-faded).
- Weapon mounts (`turrets.ts`) are clusters of small guns dressed by their traverse (`arcs.ts`, on `Mount.trav`): raised dorsal barbettes, a bow casemate, flank sponsons, ventral bays. All guns of a ship are one mesh per material, animated in the vertex shader from `uGunA` (pivot, yaw) and `uGunB` (recoil, door slide, gun scale). Yaw is clamped with `clampTraverse` (ghosts mirrored); `manualAimFor` overrides the target for heavy groups.
- Utility modules (`utilities.ts`) are clusters of small installations bedded into the deck, never one big glowing part: shield = a ring of emitter pylons with capacitors, conduits and a faint flickering spark shimmer strung between the tips; reactor = an armoured containment block (tiny core glow, the module's steam vent) with heat-sink banks, coolant tanks and, at higher tiers, secondary pods; salvage magnet = a grid of tractor dishes, a control house, cranes over scrap bins; repair = a row of drone hangars with lit doors and landing pads; drone bay = lit launch slots with parked drones and a control cab; armour plating = bolted slabs over the outboard gallery, then belt courses and a gallery bulwark (no deck blob); vector thrusters = nozzle pods on the outboard gallery (`Nozzle.aft`: small fixed aft jets) fed by a plenum on deck. No element exceeds ~3-4 units (reference scale); a higher tier adds installations, not size; glows are light points or finger-sized emissive bits. Each module owns a zone around its mount (`utilZone`, claimed before the sections build), places installations inside it, beds the gaps with low machinery, and reserves belt stretches (`GCtx.belt`) so belt greebles keep off its hardware. Seeded per section and slot. Spine radiator fields and armour-deck elevators follow the same rule (grids of small fin banks, 6-unit lifts).
- Lights are one `THREE.Points` per ship (`lights.ts`): portholes, deck lamps, nav lights (red port, green starboard, white strobes). `uDmg` knocks out steady lights as the hull fails; `uAlarm` (ghosts) brightens and quickens the beacon-mode lights.
- Ghost bosses (look in docs/ART.md "Ghost bosses") build the same hull with the hostile `livery(true)`: the same trim sheets with darker, cooler tints, and shader patches in `ghostPatches` (`materials.ts`): soot and rust value noise on `t1/t2/t3/dark` (on the seam patch's `vGdP`/`vGdN`) plus a faint red Fresnel rim (`uPulse`); emissive flicker (`uFlick`); dead cabin windows (`uDead`, per window cell, a few flashing); embers in the scorch decals (`uEmber`). The layer drives all of them per frame from an eased escalation `Rig.esc` (phase - 1) and a blackout timer on each phase change (`Rig.outage`), and `damage()` takes `esc`: scorch from the start, smoke trails from the first `dmgPts`, fires and venting from phase 2. The hostile edge lines are kept as one hairline `LineSegments` (hull silhouette at full weight, roof rings at 0.35 via vertex colour, opacity breathing well under the bloom threshold); small deck houses get none. Nothing here adds a draw call or allocates per frame.
- Dev viewer: `/tools/ship.html?build=starter|big|max|<json>&zoom=&tilt=&orbit=&lx=&ly=&ghost=1&px=&py=&hp=&phase=`; `window.__shipInfo()` reports draw calls and triangles.

## VFX API (`src/game/vfx.ts`, rendering in `src/render/fx/`)
Particles live in field coordinates plus a height `h` (ground particles: field units above the city; flight particles: world units above or below the flight plane). They are pooled; `V.cap` (set by the quality tier) bounds the live count.
- Spawners: `boomFx(x, y, r, col, ground)` (fireball, smoke, sparks, embers, debris; ground adds scorch, dust ring, smoke column, lingering fire; flak colour `#ffd27a` gives a flak burst, `#9ff3ff` an energy discharge), `flakFx`, `energyBurst`, `broadsideFx(x, y, side, n, len)`, `railFx(x1, y1, x2, y2, col, hostile)`, `spark(x, y, col, n)` (seeker colour `#ff9f5a` becomes a small warhead blast), `muzzle(x, y, col, size)` (also drives the hull muzzle light), `addFx(spec)` for single particles.
- Feel: `addTrauma(0..1)` (shake = 16 units × trauma^1.5, three-sine noise, small roll, decays in real time so hitstop keeps shaking), `kick(dx, dy)` (recoil shove, springs back in ~120 ms), `pulseCA(0..1)` (chromatic split), `setTimeGrade(0..1)` (slow-time desaturation that keeps hot light). Writing `V.shake` still works: it is converted to trauma (sqrt(shake / 22)) every tick.
- The FX layer reads `S.events` (broadside, overdrive, overdriveReady, carnageTier, playerHit, eliteKill, bossDown), `S.overdrive` (lance pillar, burning trail, spear, strike wing, aegis), enemy `tele` glints and `S.slowFx` (letterbox, vignette and desaturation in post).
- Post (`src/render/fx/post.ts`, `engine.post`): RenderPass (half float) → N8AO (high tier) → distortion + chromatic aberration → bloom (threshold on 0.5·(luma + max RGB)) → ACES → per-sector grade, slow-time, vignette, grain, letterbox → SMAA. `engine.setQuality('high' | 'low')` switches tiers at runtime (saved to `localStorage gd.quality`; `?quality=` overrides). Software GL renders at 0.6 resolution (`?scale=` overrides).
- Draw calls: ground FX batch, ribbon trails, air FX batch, hostile batch (enemy fire in the threat magenta family, always on top with dark rims; see docs/ART.md "Readability"), one distortion batch. Debug hook: `window.__gdfx`.
- Chromatic aberration pulses only on blasts of radius 44+ (up to 0.6) and gently on broadsides, so the frame stays clean in a long fight.
