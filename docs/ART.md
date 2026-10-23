# Art Bible

**One sentence:** a carrier-sized warship crosses a city at night, and everything it touches turns to light, fire and smoke.

Every entity, effect and panel must look like it belongs in that sentence. If a new thing would look at home in a cheerful mobile game, it is wrong.

## Scale and camera

- The camera looks down at the **flight plane** with a slight forward tilt (`src/render/engine.ts`). The **city is far below**: `groundScale` is about 1.6, so ground objects are drawn larger in world space to read at their gameplay size, and perspective makes them sit visibly deeper.
- **The dreadnought is an aircraft carrier (~330 m) over a city seen from very high up.** `SHIP_SCALE` is 3.1: the starter hull is about 180 field units long on a 1600×900 field (a fifth of the screen height), a full hull far more. The city is shrunk by `CITY_K` (0.25, `src/game/worldgen.ts`): a block is 25-55 field units, so the hull covers four to six blocks, buildings are tiny lit rectangles (window grids fade to their average glow, no facade detail), and street lamps become faint lines of light. The hull needs detail at three distances:
  - **Silhouette:** stepped superstructure, bridge tower, broadside sponsons, engine block.
  - **Panels:** plate seams, hatches, vents, trims and stripes from the sci-fi trim sheets.
  - **Life:** hundreds of tiny running lights, window strips, deck floodlights, blinking beacons and steam vents. *Thousands of crew* should be implied by thousands of lit portholes.
- **Everything is true scale** (one world unit = one metre, `src/render/units/scale.ts`). A 10 m tank is ~6 pixels next to a 330 m dreadnought, a fighter 19, an infantry fire team a cluster of four 2-pixel figures, while what is big in reality is big on screen: a 44 m flak tower, a 48 m SAM battery, a 56 m bomber, a 180 m siege crawler, a 210 m drone carrier. Size itself says how dangerous a thing is, and the dreadnought dwarfs every one of them.
- **You find a true-scale unit by its light and by the fire-control computer, not by cheating its size**: heat cores, headlight beams, muzzle flashes, hot barrels, dust plumes behind armour, contrails, nav lights and rotor discs on aircraft, drop shadows on the city, and the tactical symbology the HUD draws round every hostile (see "Readability"). Units come in fire teams, platoons, batteries and squadrons, so an army reads as a mass.

## Palette (`src/render/palette.ts`, mirrored in `src/styles.css`)

| Token | Use |
| --- | --- |
| `void #0a0e13` | Night, UI ground |
| `gunmetal / steel` | Every friendly hull: blackened metal, worn edges catch the sun |
| `hazard #f2a541` | Friendly accent: stripes, UI, our ordnance tracers |
| `sodium #ffb347` | City light: street lamps, windows, fires |
| `plasma #4fd1e8` | Friendly energy: shields, rail and arc weapons, our engines' core |
| `hostile #ff5a4e` | Enemy units and warnings: unit rims, target brackets, enemy lamps, alert banners |
| `hostileGnd #ff9028` | Ground-layer enemy markers in the symbology only (air markers stay hostile red) |
| `threat #ff2f8e` / `threatHot #ff9ad5` | Enemy fire only: bullets, missiles, shells, beams, wind-up glints and lane markers |
| `good #8fe39a` | Repair only |
| `scrap #e0c35c` | Salvage only |

Rules:
- Hostile red is never used for decoration. If it is red, it is an enemy (or a warning about one).
- Threat magenta is never used for anything but enemy fire. If it is pink and glowing, it can hit you.
- Emissive colors exceed 1.0 only for things that should bloom (muzzles, engines, explosions, beams, window clusters). Matte surfaces never bloom.
- Each biome (`THEMES`, indexed by `S.theme`, see `src/game/biomes.ts`) changes ground tones, fog, window colour and the post grade, but never the meaning of the palette.

## Readability (the visual hierarchy)

The screen must read at a glance, like a top-down arcade shooter: a calm backdrop, chunky targets, unmistakable fire. From loudest to quietest:

| Layer | Treatment | Where |
| --- | --- | --- |
| Enemy fire | **Threat magenta** family, drawn on top of everything with dark rims. Bullets: round magenta cores with white-hot centres and a short smear, no wide haze. Missiles: long pale darts with a magenta exhaust ribbon and a blinking seeker ring. Flak orbs and mines: larger pulsing rounds with a ring. Ground-to-air shells: a dashed reticle on the target plus the climbing shell. Beams: magenta warning line, then a white-cored beam. Wind-ups: a magenta star glint and a closing ring. | `src/render/fx/fxLayer.ts` (`enemyShot`, `glints`), `PAL.threat` |
| Player fire | Plasma cyan and white (bolts, rails, arcs, the Lance); our shells and bombs are hazard amber. | `fxLayer.ts` |
| Scrap | Gold diamonds and gold-rimmed salvage, gold brackets on caches and wrecks. | `fxLayer.ts`, unit liveries |
| Tactical symbology | The fire-control computer's picture, drawn by the HUD at a fixed screen size (never magenta): a thin **tracker box** of corner ticks round each unit's real footprint (the unit itself stays visible inside) and a NATO-style symbol above it. **Air and ground must never be confused** (our guns are layer-restricted): **air** is hostile red, an open tent (the diamond's upper half) that bobs gently at flight altitude, with a faint dashed **drop line** down to a pip on the aircraft's shadow on the city; **ground** is burnt amber (`#ff9028`, redder and brighter than sodium light), a closed, filled diamond and a faint **ring decal** flat on the ground round the unit; **salvage** is a scrap gold square, smaller and dimmer (it never shoots), keeping its layer's drop line or ring. Symbol size follows threat (drones and infantry small, SAM / flak / gunship / bomber large, elites larger). Every stroke has a dark keyline. Class glyphs (armour oval, infantry cross, AA dome, SAM dome + missile, flak keep, rotary bow tie, fixed-wing sweep, UAV V, bomber double sweep, carrier deck). Big contacts carry a designator (SAM, FLAK, BOMBER), elites a double box. Clusters of one class merge into one box with a count (no confetti). Threat priority: units that can reach the hull at full strength, others at 60%, units under our hull ghosted; a unit winding up a shot turns pale and a ring closes on it. White lock box on the reticle's target; health tick when damaged. | `src/render/units/symbology.ts`, called from `src/render/hud.ts` |
| Enemy units | **True scale.** Dark, matte military paint with a moonlit fill and a thin hostile red rim; what makes them pop is light: small crisp **heat cores** (warm white with a breath of red, never magenta) on engine decks, rotor heads and crews, barrels that glow after firing, red lamps and nav lights, headlight beams on the street, dust plumes behind armour, contrails, smoke from damaged engines, wrecks that stay hot. Ground units sit on a dark halo; aircraft cast a true-size **drop shadow** on the city far below (offset down-right, away from the moon), which sells their altitude. | `src/render/units/livery.ts`, `unitLayer.ts` (`draw`, `lights`) |
| FLIR view (Shift / T) | White-hot thermal grade: the city goes cool grey and its windows and lamps nearly out, every machine glows by its body heat (engines and lower hulls hottest), people are bright specks, fires and fresh wrecks burn white. Scanlines, grain, crop marks, a fire-control readout and a 4x zoom inset on the target. The symbology stays on top. | `src/render/flir.ts`, grade in `src/render/fx/post.ts`, `symbology.ts` (`flirOverlay`) |
| The world (every biome) | The quietest layer: near-black ground and blocks, windows at 70% of their old glow, dim road glows, pinpoint lights small and crisp (a hot core and a faint halo, never a blob), floodlight pools faint. Moonlit faces of dunes, ridges and canopy stay well below the bloom threshold; only fires, flares and burning oil bloom. Nothing in the world is magenta and nothing red is decoration: runway end bars are amber, port-side nav lights amber, threshold bars teal. Nothing in it is as bright as a bullet. | `src/render/world/*`, `src/game/worldgen.ts`, `biomegen.ts`, `terrain.ts` |

### Biome palettes (`GROUND` in `src/render/world/city.ts`, `THEMES` in `palette.ts`, grades in `post.ts`)

| Biome | Ground | Accent light | Grade |
| --- | --- | --- | --- |
| Sodium City | asphalt near-black | sodium windows, teal and warm-white neon strip | cold shadows, sodium highlights |
| Iron Harbour | black water, cool grey quays | silver moon glitter, sodium masts, muted container colours | sea-cold |
| Kestrel Airbase | dark olive grass, lighter runway asphalt | white runway and approach lights, blue taxi edges, teal centre lines | neutral night |
| Glass Desert | warm sand, pale moonlit dune faces | orange flares, warm compound windows | warm dust |
| White Range | blue-white snow, blue shadows, black pines | warm cabin windows against cold snow | steel blue |
| Deepwood | green-black canopy, moonlit crowns | sodium village lamps; wildfire orange | green-black |

Rules for the world: shade relief comes from the moon (upper left), baked per terrain cell; lit faces are a cold emissive tint, never white. Pinpoints are authored at real size and drawn at least about 3 field units so they read, but stay just under the bloom threshold: a crisp point, never a glowing ball. Floodlights are a broad, soft wash on the ground (a lit patch of concrete, not a disc). Long lines of lights (runway and taxiway edges, quay edges, loading docks, spillways) also carry a faint glowing line so they read as lines from this altitude. Each biome needs a clear value structure: in the harbour black water, pale quays and yards, a darker district; at the airbase near-black grass, dark runway with pale shoulders, a pale floodlit apron. In the FLIR view terrain, water, snow and sand go cool grey, windows and lamps drop to 15-20%, fires, flares and burning oil stay white-hot.

Rules:
- Background glows never compete with gameplay: chromatic aberration pulses only on big blasts, and city lights stay below the bloom threshold except fires.
- A new enemy type needs a real-world size in `TRUE_M` (`src/render/units/scale.ts`), a class glyph and designator in `symbology.ts`, a livery with a rim, at least one `heat` light, and lights that say what it is (headlights for vehicles, nav lights for aircraft).
- A new enemy projectile uses the threat family and a shape no other projectile uses.

## Materials

- **One PBR material library.** Hull, turrets, enemy armor and props all use the Quaternius sci-fi trim sheets (`T_Trim_*` BaseColor/Normal/ORM/Emissive), tinted per faction:
  - player: gunmetal plus hazard
  - ghost bosses: the player's gunmetal, blackened and weathered (see "Ghost bosses" below)
  - enemy military: olive-drab and desert, with hostile lights
- The city uses the Downtown kit textures (brick, concrete, metal, windows) under the same lighting.
- No flat-colored primitives in the final game. A box is acceptable only as a placeholder in a baseline layer.

## Ghost bosses

A ghost is a dead player's dreadnought, rebuilt from their build at the same detail level as ours (same hull, greebles, turrets, utilities) and flown back at us bow-first. **The idea: a derelict warship whose crew is dead but whose guns still work.** It must read as colossal and menacing, never as a neon sign.

| Element | Treatment |
| --- | --- |
| Hull | Our gunmetal trims, darker and colder, with soot blotches across the plating and rust and grime streaking down the walls (procedural, `ghostPatches` in `materials.ts`). Stencils and hazard stripes faded. Weaker sky reflection. |
| Old wounds | Scorch scars from the first frame, their densest soot smouldering like banked embers; thin smoke trails stream aft from the worst of them. |
| Lighting signature: **corpse light** | Every light that still works burns a cold, sickly pale teal-white (`#d0f0e6`, windows `#a8d4c8`), never our warm amber. Half the cabin windows and portholes are dead; a few of the dead ones flash as circuits fail. Floodlight pools are faint and cold. The whole ship's power breathes and stutters (brownouts). |
| Emergency lights | Sparse red beacons (the masts' and pylons' beacon lights), the only red light on the hull. They pulse slowly in phase 1 and burn brighter and faster as the boss escalates. |
| Drives | Guttering ember-orange plumes; past phase 2 they sputter, one nozzle cutting out at a time. |
| Hostile identification | A **hairline** red rim on the hull silhouette (and a third as strong on superstructure roof edges), plus a faint red Fresnel rim on sloped plates, both breathing slowly; a very faint red breath under the hull. Nothing on the hull blooms red. Combined with the HUD's boss bar, symbology and the ship's sheer size, that is enough. |
| Phase 2 (66%) | A blackout (the lights die for a second, then come back with fewer of them), fires break out at the wounds, coolant and atmosphere vent in pale jets, more smoke, sparks, faster emergency beacons. |
| Phase 3 (33%) | Another blackout, the hull burning along its length, most lights dead, constant stutters, drives sputtering, more venting. The last third of its hull adds fires on top. |

Reference shots: `docs/shots/ghost-after-*.jpg` (game zoom, phase 2, phase 3 with a broadside wind-up, close-ups at phase 1 and 3); the old neon-outline look for comparison in `ghost-before-*.jpg`. A hit flash on the boss is a faint pulse, never a wash over the hull.

Rules: no magenta anywhere on the ghost (its broadside telegraphs, glints and lane markers are the brightest magenta things near it, drawn on top); red only for the beacons, the hairline rim and its own muzzle flashes; everything else in the corpse-light or fire families.

## Light

- It is night. Key light is a cold moon (`engine.sun`) for silhouettes. The real lighting comes from emissives and the four explosion point lights.
- Every muzzle flash, impact and explosion lights its surroundings for a few frames.
- Bloom is tuned so only HDR emissives bloom (threshold about 0.8). The ACES tone map is the final grade.

## Motion

- Big things move slowly and settle: the dreadnought eases and banks, and turrets slew instead of snapping.
- Small things are quick and cheap: drones jitter, infantry scatters.
- Nothing pops in or out. Spawn with a fade, a descent or a reveal, and die with an explosion that leaves smoke and a wreck or scorch.

## UI

The interface is the ship's own equipment: stencilled plate labels, split-flap counters, warning lamps, gauge needles and amber CRT telemetry. It is never rounded SaaS cards, gradients or emoji. Fonts: Chakra Petch (UI), Saira Stencil One (titles and stencils), Share Tech Mono (telemetry).

Four materials, one vocabulary (`src/styles.css`, parts in `src/ui/kit.ts` and `src/ui/cards.ts`):

| Material | Used for | Parts |
| --- | --- | --- |
| Steel | Consoles, the status rail, switches, the HUD plates | Riveted panels, stencil plates, steel keys (press travel, no hover lift), heavy hazard-bezel switches, guarded switches, lamps, split-flap drums, segmented bars, needle gauges |
| CRT | Telemetry and comms | Amber phosphor on near-black glass with scanlines: plot readout, quartermaster terminal, intercepted transmissions (teletype), registry line |
| Paper | Orders and documents | Requisition slips (parts), work orders (drydock, derelict), salvage manifest, ghost dossier, wreck report, till roll. Rubber stamps in blue-black (approved) or oxblood (void) ink |
| Enamel | Relics | Insignia pins: steel round (common), brass shield (rare), brass star (boss), tarnished spiked (curse) |

Rules for new UI:
- Icons come from `src/ui/icons.ts` (game-icons.net, CC BY 3.0); map a new id there rather than drawing one-off glyphs.
- Screens are built in `src/ui/screens/*.ts` and shown with `show()`, which transitions automatically. Give each screen a `data-screen` key; re-rendering the same key swaps in place.
- UI sounds go through `uiSound()` in `src/ui/sound.ts` (hooks: press, hover, buy, stamp, flap, type, deny).
- The refit board is a callout drawing, not a parts list: the ship's plan on blueprint paper, thin pale leader lines to steel socket tags (stencil number strip, recessed socket well, arc and target-layer tags). Tags are deliberately not to scale. Lit means "fits" (plasma), dimmed means "refused" (with the reason); gains read in plasma, losses in hazard amber, never hostile red. A part lands with a snap and a clunk, never a fade.
- Map node symbols follow military plotting conventions: hostile diamonds (fight, elite, boss), neutral squares (merchant, derelict), unknown quatrefoil (signal), friendly circle (drydock).
