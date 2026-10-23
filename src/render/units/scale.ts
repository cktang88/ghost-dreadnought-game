// True scale. One world unit is one metre: a finished dreadnought hull is 330-370 field units long on the flight
// plane, a 330 m carrier. Aircraft fly on that plane, so a 19 m interceptor is 19 field units. The city is far below:
// a ground object of m metres covers m / groundScale (~1.65) field units on screen, so a 10 m tank is about 6.
// Enemy models are drawn at these sizes and nothing is cheated bigger; the tactical symbology overlay
// (symbology.ts) is what keeps a 6-unit tank findable, and gameplay radii (EN[type].r) stay generous on their own.
import type { EnemyType } from '../../data/enemies';

/** Largest horizontal extent of each unit in metres (rotors and footprint of a battery included). */
export const TRUE_M: Record<EnemyType, number> = {
  // air: fighter-sized and up
  jet: 19,        // an F-15 is 19.4 m long
  drone: 6,       // loitering munition / small UCAV
  heli: 17,       // attack helicopter, rotor tips to tail
  gunship: 26,    // tiltrotor gunship, rotor tip to rotor tip
  bomber: 56,     // a B-52 spans 56 m
  canister: 6,    // drifting cargo pod
  ace: 52,        // elite heavy gunship, rotor tip to rotor tip
  carrier: 210,   // the drone carrier: a flying deck two thirds the length of the dreadnought
  // ground: true size, seen from altitude
  tank: 10,       // main battle tank including the gun
  infantry: 1.8,  // one soldier (a fire team spreads over ~8 m)
  turret: 30,     // AA battery: two twin-gun pits in a revetment
  sam: 48,        // SAM battery: three launchers round a radar in a revetment
  bunker: 44,     // flak tower: a 40 m concrete keep
  cache: 12,      // pallet stack of supply crates
  wreck: 64,      // a downed warship's hull section
  crawler: 180,   // siege crawler: a land battleship
};

/** Air units' drop shadows land this far (field units) down-right of them: the moon is up-left. The symbology's
 *  drop line ends on the same spot. Shadows fade out by SHADOW_ALT of visual altitude. */
export const SHADOW_DX = 34, SHADOW_DY = 44, SHADOW_ALT = 900;

/** Published by the unit layer: ground scale k (field units per ground metre is 1 / k), and the camera's field
 *  position and height over the flight plane (to place a marker on an aircraft that is climbing or descending). */
export const SCALE_STATE = { k: 1.65, camFx: 800, camFy: 1092, camH: 1838 };
/** Field point that projects to the same pixel as an aircraft at (x, y) flying alt above the flight plane. */
export function altShift(x: number, y: number, alt: number, out: { x: number; y: number }) {
  const S = SCALE_STATE, t = S.camH / Math.max(1, S.camH - alt);
  out.x = S.camFx + (x - S.camFx) * t; out.y = S.camFy + (y - S.camFy) * t;
  return out;
}

/** Visual half-extent of a unit on screen, field units. */
export function visualHalf(type: EnemyType, air: boolean) {
  return TRUE_M[type] * 0.5 / (air ? 1 : SCALE_STATE.k);
}
