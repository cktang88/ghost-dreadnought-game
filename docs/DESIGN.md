# Ghost Dreadnought — Design Bible

## The fantasy

You command a dreadnought the size of an aircraft carrier, crewed by thousands. It crosses the sky at the speed of weather. Below, cities go dark as you pass. Everything in the game should say one thing: **the world is afraid of you, and it is right to be.**

## Pillars

1. **Scale you can feel.** The ship is a building-sized object over a city of thousands of lit windows. Enemies are true to scale: small, numerous and brave, a tank a speck of light next to the hull, while a flak tower or a siege crawler is big because it is big. The fire-control computer (tactical symbology, the FLIR view) is how a dreadnought's crew sees them. The camera, the parallax, the sound and the pace of the ship all sell mass: it accelerates like a freighter, its broadsides shake the screen, and its shadow covers whole blocks.
2. **Power with weight.** Every weapon has wind-up, recoil, a muzzle event, travel, impact and an aftermath (scorch, fire, smoke, debris, secondary explosions). The player spends their time destroying things in ways that look and sound expensive.
3. **One world, one hand.** Every entity, effect, icon and panel comes from one material language: blackened gunmetal, worn hazard paint, plasma cyan, sodium amber city light, hostile red. No mismatched packs and no SaaS-dashboard UI.
4. **Craft in the basics.** Movement, aiming, readability of threats, menu transitions and saving are smooth, predictable and polished before any feature is added. Nothing appears or disappears without a transition. Nothing important is ever unreadable.

## Loops

### Seconds to minutes: the strike (core loop)
- Glide across the battlefield on the full width of a desktop screen. Movement is heavy but responsive: the ship eases in and out of motion and banks into turns.
- Two layers of fire. **Auto guns** (pulse cannons, scatter lasers, flak, arc coils, point defense) fire on their own at whatever is in their arc, so the screen is never quiet: move and the ship is already fighting. **Heavy weapons** (rail cannons, seeker missiles, siege mortars, bomb bays) are the deliberate, devastating layer: they sit in numbered **weapon groups** and fire where the pilot aims. Zero learning: steer with WASD and hold the left mouse button over anything you want gone. Depth: 1-9 (or Q / E, the wheel) pick a group, the right button salvoes every group at once.
- **Where a gun sits and which way it faces matters.** The hull is long and narrow like a real capital ship, so the order of its sections spreads the guns from bow to stern. Every weapon mount can be rotated: the bridge gun is a narrow cone ahead (air and ground); top-deck turrets cover 240° around their facing but cannot depress below the hull, so they only engage aircraft and ghost dreadnoughts; broadside sponsons cover 120° outboard, angled fore, abeam or aft (air and ground); bomb bays and mortars drop from the belly onto the ground only, whichever way they face. The ship blocks its own fire: the bridge tower and engine funnels mask the turrets behind and ahead of them, and sponsons mask the sponsons beside them. Threats come from ahead, the flanks and astern, so building a ship is choosing which bearings each gun covers and which blind spots you accept; player skill is positioning plus aim.
- The reticle tells the pilot everything: the selected group, its reload, a ground ring where bombs and shells will land, missile lock brackets, the firing lines of rails that bear, and why a group cannot fire (out of arc, out of reach, air only).
- **Scrap magnet:** wrecks spill scrap that streams into the hull from a generous radius, accelerating as it comes. Nothing you earn is lost off the screen. Salvage Magnets and the Magnetized Hull relic widen the pull.
- On touch screens the ship flies by drag and every gun aims itself.
- **FLIR** (hold Shift, or T to latch): the main view switches to a white-hot thermal camera, like a gunship's sensor turret. The city goes cool and dark, every engine, crew and fire glows, and a 4x zoom inset shows the true-scale target under the reticle. It costs nothing but attention: a way to find the tanks hiding in a lit city, and to feel how small they are.
- **Overdrive** (the active skill, on Space): charge it by destroying things, then unleash it. Each hull class has its own. The first is a *Ventral Lance*, a sustained beam that carves a burning line through the city below.
- **Dopamine beats:**
  - Chains of secondary explosions.
  - Buildings collapsing into dust plumes.
  - A *carnage meter* whose multiplier lifts scrap value, so a rampage pays.
  - Elite kills that freeze time for 80 ms.
  - Scrap streams that whoosh into the hull with a rising pitch.
  - Hull damage that shows on the ship as fires, sparks and venting.

### An hour or two: the campaign run (Spire loop)
- Three sectors. Each is a 10-floor branching route ending in a **ghost dreadnought**: a real fallen player's ship.
- Nodes are strikes, elites, merchants, signals (events), derelicts (relics) and drydocks.
- Build-crafting: hull sections and mounts, part tiers, relics that bend rules, curses taken for power, and synergies such as flak plus magnet, or mortars plus incendiary.
- Every run ends with a **wreck report**: what you destroyed, in totals that feel enormous (tons of ordnance, buildings levelled, hours of crew time), and the ghost you left behind.

### Ten hours and beyond: the fleet (meta loop)
- **Admiralty rank** earned per run unlocks new hull classes (Leviathan carrier, Lance destroyer, Bastion monitor), each with a different Overdrive and starting layout.
- **Codex**: an entry and an illustration for every enemy, part, relic and ghost you have killed.
- **Ghost ledger**: other players' ships you destroyed, and how many players your own ghosts have killed. The asynchronous rivalry is the long-term hook.
- **Heat levels**: harder runs after your first victory, each adding a named modifier.
- Daily strike: one seeded route a day for everyone, with a shared leaderboard.

## Environments (after all mechanics are in)
Owner's direction: **gameplay first.** Environment work that doesn't affect gameplay starts only once every mechanic is in place.
- Stylized, not literal. A night city reads as lit rectangles: building masses with window grids, street-light lines and traffic streams. No need for real building models.
- Many distinct biomes, each with its own silhouette and color story: desert (dunes, convoys, dust), snow-covered mountains (ridges, pass forts), forests (canopy, firebreaks, logging rail), ports (docks, cranes, ships), airfields (runways, hangars, taxiing jets), plus the night city.
- Biomes should be unique and creative. Pick each sector's biome from the route so the run reads as a journey.

### The six biomes (built)
Everything is seen from very high up at night, in one stylized language: dark masses, crisp pinpoint lights, restrained colour, strong graphic shapes. Each biome has its own palette accent, signature set pieces that scroll by every several rows, and its own way of burning.

| Biome | Ground | Lights and structures | Set pieces | Destruction |
| --- | --- | --- | --- | --- |
| **Sodium City** (night city) | Asphalt grid, parks | Window grids, street glows, a teal-amber neon strip down one side of the core, traffic drift, searchlights | Floodlit stadium (a green pitch inside a ring of twelve floodlight masts), TV tower with a beacon | Collapse, burning floors, rubble, craters; the blackout follows the ship |
| **Iron Harbour** (port) | Black water on the left with moonlit glitter and surf; pale concrete quays and yards; a darker district inland | Gantry cranes with booms over the berths and work lights on the ships, colour-blocked container stacks under broad sodium washes, straddle carriers, a logistics belt of lit loading docks and truck parks, ships alongside, at anchor and under way with V-wakes, channel buoys. Every natural-shore stretch carries something: a shipyard (hulls on slipways, tower cranes, welding sparks), a coastal refinery with a flare, a marina behind a lit breakwater, or a fishing village. Port lights run on their own generators: they stay on when the city grid dies under the ship | Lighthouse at the end of a long breakwater sweeping a twin beam over the sea, oil terminal (tanker at a T-jetty, a big floodlit tank farm), drydock (a ship in a black basin under two portal cranes) | Cranes, containers, ships and tank farms collapse and burn; tankers and tanks chain-react and spill burning oil; blasts on open water throw spray, no crater |
| **Kestrel Airbase** | Near-black grass; dark runway asphalt with pale shoulders; a pale floodlit apron | Runways along the flight path drawn as two rails of white light (edge and centre lights plus a faint glowing line), teal threshold bars, amber end bars, an approach-light "rabbit" strobing toward the threshold; parallel taxiways with glowing blue edge lines and green centre lines; aircraft taxiing with wingtip lights and a pulsing beacon, service trucks on the apron; hangars with lit doors, control tower with a rotating white/teal beacon | Giant transport on its own floodlit pad, a row of hardened shelters with lit mouths, radar station with a rotating beacon | Parked aircraft burn and spill fuel; ammunition igloos and fuel farms chain-react |
| **Glass Desert** | Long soft dune swells catching the moon (no knife-edge crests), flat-topped mesas with hard escarpments, a dry wadi with palms | Walled adobe compounds with one warm light, a highway with convoys (headlight trains), a pipeline with pump stations, truck stops, oil fields of nodding donkeys with flare stacks, an oasis village with a dome and minaret | Rocket launch site (a ring of floodlights, two searchlights sweeping the sky, lit gantry, flame trench), gas-oil separation plant with a line of flares, old citadel with its town | Wellheads, flares, tanks and the rocket go up in fireballs and leave burning oil on the sand |
| **White Range** (snow mountains) | Ridged mountains with cold moonlit faces and blue shadows, valleys, pines below the tree line, frozen lakes with crack lines | Valley roads with a few headlights, villages of snow-roofed cabins with warm windows and sodium street lamps, ice-fishing huts, ski-lift lights | Dam holding a frozen reservoir, its crest lit and the spillway glowing below; star fort astride the pass with a searchlight; radar on the summit | Cabins collapse and burn; frozen lakes crack open into black water with steam; pines near a blast catch |
| **Deepwood** (forest) | Dense canopy of clumped crowns catching the moon, clearings, clear-cuts, a winding river and lakes | Logging roads and spurs to clear-cut landings with log piles, small towns and farmsteads, river barges, a bridge where the road crosses the river | Lumber mill with a smoking stack, log decks, log rafts and sodium yard lights; a river dam with a glowing spillway; fire lookout tower with a beacon | **Wildfire**: hits on the canopy start fires that run downwind through the trees for many seconds, setting cabins alight |

Set pieces are placed before the rest of their row (so the yards and fields fill in around them), centred well inside the field so they scroll through the whole view clear of the HUD's side panels.

The run is a journey around a ring of neighbours, **city → harbour → forest → mountains → desert → airbase → city**. Each sector covers two neighbours (the run seed picks where on the ring it starts): floors 0-2 fly over the first, floors 3-5 cross from the first into the second part-way through the fight (a coastline, a wooded shore, the snowline, a cold desert edge, a desert airstrip, the city's airport), and floors 6-10 and the boss fly over the second. The fight banner names the biome ("Sector 2 · White Range") and crossing the edge flashes the new name.
