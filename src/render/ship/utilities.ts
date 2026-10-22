// Utility modules at warship scale. A shield generator or reactor on a 300 m hull is not one big glowing
// disc: it is a handful of small installations (emitter pylons, an armoured containment block with
// heat-sink banks, a tractor array, drone hangars) bedded into the deck machinery around the mount.
// Rules: no single element wider than ~3 units (a few percent of a section), glows are pinpoint (light
// points or finger-sized emissive bits), and a higher tier adds MORE installations, never bigger ones.
// Everything merges into the hull's material buckets; every random choice comes from the section's
// seeded stream, so ghosts match their builds.
//
// Design space: the hull's reference scale (see hull.ts), y up, deck at y = DECK, -z toward the bow.
import * as THREE from 'three';
import { B, R, block, flatRect, lathe, box, octagon, type V3 } from './mesh';
import { LMode } from './lights';
import { occupied, claim, onDeck, machinery, heatsink, type GCtx, type Box4 } from './greebles';
import type { Rng } from '../../util/rng';

const DECK = 8;
export interface UNozzle { x: number; y: number; z: number; r: number; main: boolean; aft?: boolean }
export interface UCtx extends GCtx {
  vents: V3[]; dmg: V3[]; nozzles: UNozzle[];
  /** Belt stretches (side, z0, z1) taken by module hardware; the belt greebles keep off them. */
  belt: [number, number, number][];
}
export interface UtilSpec {
  id: string; tier: number;
  /** Mount point and the deck zone the module may use (it never draws outside it, except on the belt). */
  x: number; z: number; zone: Box4;
  /** The section's z range (armour bands and thruster pods run along it). */
  za: number; zb: number;
}

const Tm = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (a: number) => new THREE.Matrix4().makeRotationX(a);
const RY = (a: number) => new THREE.Matrix4().makeRotationY(a);
const RZ = (a: number) => new THREE.Matrix4().makeRotationZ(a);
const Sc = (k: number) => new THREE.Matrix4().makeScale(k, k, k);
const col = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
const GLOW = { m: 'glow' as const, v0: 0, v1: 1 }, CORE = { m: 'core' as const, v0: 0, v1: 1 }, BLACK = { m: 'black' as const, v0: 0, v1: 1 };

/** Small soft contact shadow (the moon is up-left-forward), sized for small kit. */
function shadow(c: UCtx, x0: number, z0: number, x1: number, z1: number, h: number, y = DECK + 0.06) {
  const ox = h * 0.8, oz = h * 0.62, g = 0.2 + h * 0.25;
  c.bk.get('shadow').quad([x0 - g + ox, y, z0 - g + oz], [x1 + g + ox, y, z0 - g + oz], [x1 + g + ox, y, z1 + g + oz], [x0 - g + ox, y, z1 + g + oz], [0, 0], [1, 0], [1, 1], [0, 1], c.L.paint.hull, [0, 1, 0]);
}
/** Thin hazard band (deck paint). */
function hazard(c: UCtx, x0: number, z0: number, x1: number, z1: number, y = DECK + 0.045) {
  const alongZ = z1 - z0 > x1 - x0, L = alongZ ? z1 - z0 : x1 - x0, wv = alongZ ? x1 - x0 : z1 - z0, u = L / (wv * 4), mb = c.bk.get('hazard');
  if (alongZ) mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 0], [0, 1], [u, 1], [u, 0], c.L.paint.accent, [0, 1, 0]);
  else mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 0], [u, 0], [u, 1], [0, 1], c.L.paint.accent, [0, 1, 0]);
}

/** Placement inside the module zone: free, on deck, then claimed. */
function fits(c: UCtx, s: UtilSpec, x: number, z: number, hw: number, hd: number) {
  const [zx0, zz0, zx1, zz1] = s.zone;
  if (x - hw < zx0 || x + hw > zx1 || z - hd < zz0 || z + hd > zz1) return false;
  return onDeck(c, x - hw, z - hd, x + hw, z + hd, 0.8) && !occupied(c, x - hw, z - hd, x + hw, z + hd, 0.25);
}
function take(c: UCtx, x: number, z: number, hw: number, hd: number) { claim(c, x - hw, z - hd, x + hw, z + hd); }
/** Nudge a preferred spot until it fits (spiral search), or null. */
function place(c: UCtx, s: UtilSpec, x: number, z: number, hw: number, hd: number, rnd: Rng): [number, number] | null {
  for (let k = 0; k < 14; k++) {
    const a = rnd() * Math.PI * 2, r = k === 0 ? 0 : 0.6 + k * 0.45, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    if (fits(c, s, px, pz, hw, hd)) { take(c, px, pz, hw, hd); return [px, pz]; }
  }
  return null;
}
/** Shift a formation centre so that it stays on deck: toward the hull centreline when the deck runs out. */
function inboard(c: UCtx, s: UtilSpec, halfW: number) {
  const e = c.de(s.z) - 1.2 - halfW;
  return Math.max(-e, Math.min(e, s.x));
}

/* ---------------- installations ---------------- */

/** Shield emitter: hex plinth, short armoured pylon, a small dome with a hairline glow seam and a tip light. */
function emitter(c: UCtx, x: number, z: number, h: number, hex: string, rnd: Rng, k = 1.35) {
  const P = c.L.paint, L = (dx: number, dy: number, dz: number) => Tm(x, DECK, z).multiply(Sc(k)).multiply(Tm(dx, dy, dz));
  lathe(c.bk, B.ribs, [[0, 0], [0.95, 0], [0.95, 0.3], [0.7, 0.42]], 6, col(P.hull, 0.85), L(0, 0, 0), true);
  box(c.bk, B.darkPanel, 0.62, h, 0.62, col(P.hull, 0.95), L(0, 0.42 + h / 2, 0));
  for (const a of [0, Math.PI / 2]) box(c.bk, B.rail, 0.08, h * 0.8, 0.9, P.dark, L(0, 0.42 + h * 0.45, 0).multiply(RY(a)));
  const top = 0.42 + h;
  lathe(c.bk, B.panels, [[0.55, 0], [0.55, 0.12], [0.48, 0.32], [0.3, 0.5], [0, 0.56]], 10, col(P.plate, 1.3), L(0, top, 0), false, 1);
  lathe(c.bk, GLOW, [[0.57, 0.1], [0.57, 0.15]], 12, col(P.full, 0.22), L(0, top, 0));
  c.lights.add(x, DECK + (top + 0.62) * k, z, hex, 1.6, 0.2, LMode.Beacon, rnd());
  shadow(c, x - 0.7 * k, z - 0.7 * k, x + 0.7 * k, z + 0.7 * k, 0.9 * k);
}

/** Capacitor / transformer box with vent slots and a status lamp. */
function capacitor(c: UCtx, x: number, z: number, w: number, d: number, h: number, hex: string, rnd: Rng) {
  const P = c.L.paint;
  block(c.bk, octagon(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 0.18), DECK, DECK + h, { side: B.ribs, top: B.darkPanel, col: col(P.hull, 0.8), topCol: col(P.hull, 1.15), bevel: 0.1 });
  flatRect(c.bk, R.ventSlots, x - w * 0.35, z - d * 0.3, x + w * 0.35, z + d * 0.3, DECK + h + 0.02, P.hull, w < d);
  c.lights.add(x + w / 2 + 0.03, DECK + h * 0.6, z, hex, 1.1, 0.12, LMode.Steady, rnd());
  shadow(c, x - w / 2, z - d / 2, x + w / 2, z + d / 2, h);
}

/** Straight conduit along the deck between two points (low pipe pair with clamps). */
function conduit(c: UCtx, ax: number, az: number, bx: number, bz: number, r = 0.12) {
  const L = Math.hypot(bx - ax, bz - az); if (L < 0.5) return;
  const yaw = Math.atan2(bx - ax, bz - az), P = c.L.paint;
  for (const o of [-1, 1]) {
    const ox = Math.cos(yaw) * o * r * 1.3, oz = -Math.sin(yaw) * o * r * 1.3;
    lathe(c.bk, B.rail, [[r, 0], [r, L]], 5, P.dark, Tm(ax + ox, DECK + r + 0.04, az + oz).multiply(RY(yaw)).multiply(RX(Math.PI / 2)), false, 1);
  }
  for (let t = 0.8; t < L - 0.4; t += 1.4) box(c.bk, B.ribs, r * 6, r * 2.4, 0.16, P.hull, Tm(ax + Math.sin(yaw) * t, DECK + r, az + Math.cos(yaw) * t).multiply(RY(yaw)));
}

/** Tractor dish: pedestal, upward-facing dish tilted outboard, feed horn and an amber tip. */
function tractorDish(c: UCtx, x: number, z: number, r: number, tilt: number, hex: string, rnd: Rng) {
  const P = c.L.paint;
  lathe(c.bk, B.ribs, [[0, 0], [r * 0.6, 0], [r * 0.55, r * 0.25], [r * 0.2, r * 0.35]], 8, col(P.hull, 0.8), Tm(x, DECK, z), true);
  box(c.bk, B.rail, r * 0.24, r * 0.9, r * 0.24, P.dark, Tm(x, DECK + r * 0.7, z));
  const m = Tm(x, DECK + r * 1.15, z).multiply(RZ(tilt));
  lathe(c.bk, B.panels, [[0.08, 0], [r * 0.5, 0.1 * r], [r, 0.38 * r], [r * 0.98, 0.42 * r]], 12, col(P.plate, 1.25), m, false, 1);
  lathe(c.bk, B.ribs, [[r * 0.97, 0.36 * r], [r * 1.04, 0.43 * r], [r * 0.98, 0.45 * r]], 14, col(P.plate, 1.8), m);
  lathe(c.bk, B.rail, [[0.06 * r, 0], [0.05 * r, 0.85 * r], [0, 0.9 * r]], 4, P.dark, m);
  const tip = new THREE.Vector3(0, 0.95 * r, 0).applyMatrix4(m);
  c.lights.add(tip.x, tip.y, tip.z, hex, 1.4, 0.16, LMode.Flicker, rnd());
  shadow(c, x - r * 0.8, z - r * 0.8, x + r * 0.8, z + r * 0.8, r * 0.7);
}

/** Deck crane: pedestal, slewing post, lattice boom, cable and a hook block. */
function crane(c: UCtx, x: number, z: number, yaw: number, len: number, rnd: Rng) {
  const P = c.L.paint;
  block(c.bk, octagon(x - 0.8, z - 0.8, x + 0.8, z + 0.8, 0.3), DECK, DECK + 0.7, { side: B.ribs, top: B.brackets, col: col(P.hull, 0.9), bevel: 0.1 });
  box(c.bk, B.darkPanel, 0.75, 0.6, 1.1, col(P.hull, 1.1), Tm(x, DECK + 1.0, z).multiply(RY(yaw)));
  box(c.bk, B.darkPanel, 0.5, 1.6, 0.5, col(P.hull, 1.1), Tm(x, DECK + 1.5, z));
  const el = 0.45 + rnd() * 0.25, m = Tm(x, DECK + 2.3, z).multiply(RY(yaw)).multiply(RX(-el));
  for (const o of [-0.16, 0.16]) box(c.bk, B.grille, 0.1, 0.32, len, P.accent.clone().multiplyScalar(0.6), m.clone().multiply(Tm(o, 0, -len / 2)));
  for (let t = 0.6; t < len; t += 0.7) box(c.bk, B.rail, 0.34, 0.05, 0.05, P.dark, m.clone().multiply(Tm(0, 0.12, -t)));
  const tip = new THREE.Vector3(0, 0, -len).applyMatrix4(m), drop = Math.max(0.6, tip.y - DECK - 0.9);
  box(c.bk, B.rail, 0.04, drop, 0.04, P.dark, Tm(tip.x, tip.y - drop / 2, tip.z));
  box(c.bk, B.ribs, 0.4, 0.4, 0.4, P.accent.clone().multiplyScalar(0.7), Tm(tip.x, tip.y - drop - 0.12, tip.z));
  c.lights.add(tip.x, tip.y + 0.12, tip.z, c.L.light.port, 1.3, 0.16, LMode.Beacon, rnd());
  shadow(c, Math.min(x, tip.x) - 0.4, Math.min(z, tip.z) - 0.4, Math.max(x, tip.x) + 0.4, Math.max(z, tip.z) + 0.4, 1.4);
}

/**
 * Small hangar with its door facing `face` (unit vector in x/z): armoured block, dark door opening with a
 * lit interior strip, pinpoint lamps along the lintel and hazard paint on the apron.
 */
function hangar(c: UCtx, x: number, z: number, w: number, d: number, h: number, fx: number, fz: number, hex: string, rnd: Rng) {
  const P = c.L.paint;
  // Plan extents with w across the door and d into the hangar.
  const ax = Math.abs(fx) > 0.5, hw = ax ? d / 2 : w / 2, hd = ax ? w / 2 : d / 2;
  block(c.bk, octagon(x - hw, z - hd, x + hw, z + hd, 0.25), DECK, DECK + h, { side: B.darkPanel, top: B.brackets, col: col(P.hull, 0.85), topCol: col(P.hull, 1.2), bevel: 0.15, taper: 0.05 });
  // Door on the face: black opening, warm interior strip, lamps along the lintel.
  const dw = w * 0.62, dh = h * 0.62, fxp = x + fx * (hw + 0.03), fzp = z + fz * (hd + 0.03), tx = -fz, tz = fx;
  const p0: V3 = [fxp - tx * dw / 2, DECK + 0.02, fzp - tz * dw / 2], p1: V3 = [fxp + tx * dw / 2, DECK + 0.02, fzp + tz * dw / 2];
  c.bk.get('black').quad(p0, p1, [p1[0], DECK + dh, p1[2]], [p0[0], DECK + dh, p0[2]], [0, 0], [1, 0], [1, 1], [0, 1], P.dark, [fx, 0, fz]);
  const ix = fx * 0.02, iz = fz * 0.02;
  c.bk.get('window').quad([p0[0] + ix + tx * 0.08, DECK + 0.08, p0[2] + iz + tz * 0.08], [p1[0] + ix - tx * 0.08, DECK + 0.08, p1[2] + iz - tz * 0.08], [p1[0] + ix - tx * 0.08, DECK + dh * 0.45, p1[2] + iz - tz * 0.08], [p0[0] + ix + tx * 0.08, DECK + dh * 0.45, p0[2] + iz + tz * 0.08], [0, 0.25], [dw / 40, 0.25], [dw / 40, 0.5], [0, 0.5], col(P.full, 0.75), [fx, 0, fz]);
  c.lights.row([p0[0] + fx * 0.08, DECK + dh + 0.1, p0[2] + fz * 0.08], [p1[0] + fx * 0.08, DECK + dh + 0.1, p1[2] + fz * 0.08], 0.32, hex, 1.2, 0.12, 1, LMode.Steady, rnd);
  // Apron: hazard band in front of the door.
  const ap = 0.22, ex = fxp + fx * 0.45, ez = fzp + fz * 0.45;
  if (ax) hazard(c, Math.min(ex, ex + fx * ap), ez - dw / 2, Math.max(ex, ex + fx * ap), ez + dw / 2);
  else hazard(c, ex - dw / 2, Math.min(ez, ez + fz * ap), ex + dw / 2, Math.max(ez, ez + fz * ap));
  flatRect(c.bk, R.ventSlots, x - hw * 0.5, z - hd * 0.4, x + hw * 0.5, z + hd * 0.4, DECK + h + 0.02, P.hull, !ax);
  shadow(c, x - hw, z - hd, x + hw, z + hd, h);
}

/** A parked drone: a tiny body with stub wings and a nav pip. */
function drone(c: UCtx, x: number, z: number, yaw: number, hex: string, rnd: Rng, y = DECK + 0.05) {
  const P = c.L.paint, m = Tm(x, y + 0.1, z).multiply(RY(yaw));
  box(c.bk, B.panels, 0.45, 0.2, 0.85, col(P.plate, 1.3), m);
  box(c.bk, B.rail, 1.2, 0.06, 0.3, col(P.plate, 1.1), m.clone().multiply(Tm(0, 0, 0.1)));
  for (const sx of [-1, 1]) lathe(c.bk, B.rail, [[0.22, 0], [0.22, 0.05]], 8, P.dark, m.clone().multiply(Tm(sx * 0.62, 0.04, 0.1)), true);
  c.lights.add(x, y + 0.22, z, hex, 0.9, 0.09, LMode.Steady, rnd());
}

/* ---------------- modules ---------------- */

function shieldModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const hex = c.L.light.energy, n = Math.min(8, 3 + s.tier), R0 = 3.6 + n * 0.4, cx = inboard(c, s, R0 + 1.3), cz = s.z;
  const pts: [number, number][] = [];
  const a0 = rnd() * Math.PI;
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2, p = place(c, s, cx + Math.cos(a) * R0, cz + Math.sin(a) * R0, 1.1, 1.1, rnd);
    if (!p) continue;
    emitter(c, p[0], p[1], 1 + rnd() * 0.9, hex, rnd); pts.push(p);
  }
  // Central capacitor bank feeding the ring, with conduits out to the emitters.
  const cap = place(c, s, cx, cz, 1.6, 1.1, rnd);
  if (cap) {
    capacitor(c, cap[0], cap[1] - 0.55, 2.8, 0.9, 1.1, hex, rnd); capacitor(c, cap[0], cap[1] + 0.55, 2.8, 0.9, 0.8, hex, rnd);
    for (const p of pts) { const dx = p[0] - cap[0], dz = p[1] - cap[1], L = Math.hypot(dx, dz); conduit(c, cap[0] + (dx / L) * 1.6, cap[1] + (dz / L) * 1.1, p[0] - (dx / L) * 1.2, p[1] - (dz / L) * 1.2, 0.11); }
  }
  // The shared shimmer: faint flickering sparks strung between neighbouring emitter tips.
  for (let k = 0; k < pts.length && pts.length > 1; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length], y = DECK + 3.2;
    c.lights.row([a[0], y, a[1]], [b[0], y, b[1]], 0.5, hex, 0.45, 0.09, 0.55, LMode.Flicker, rnd);
  }
  c.dmg.push([cx, DECK + 0.4, cz]);
}

function reactorModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const P = c.L.paint, hot = c.L.light.engine, cx = inboard(c, s, 4), cz = s.z;
  // Primary containment: armoured octagonal block with buttresses, a recessed cap and a tiny core window.
  const core = (x: number, z: number, r: number, h: number) => {
    block(c.bk, octagon(x - r, z - r, x + r, z + r, r * 0.42), DECK, DECK + h, { side: B.darkPanel, top: B.brackets, col: col(P.hull, 0.75), topCol: col(P.hull, 1.1), bevel: 0.2, taper: 0.1 });
    for (const [bx, bz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) box(c.bk, B.ribs, bx ? 0.5 : 0.7, h * 0.7, bz ? 0.5 : 0.7, col(P.hull, 0.9), Tm(x + bx * (r + 0.2), DECK + h * 0.35, z + bz * (r + 0.2)));
    const top = DECK + h;
    lathe(c.bk, B.ribs, [[r * 0.62, 0], [r * 0.62, 0.22], [r * 0.4, 0.3]], 8, P.dark, Tm(x, top, z));
    lathe(c.bk, CORE, [[r * 0.22, 0.3], [0, 0.31]], 8, col(P.full, 0.55), Tm(x, top, z));
    c.lights.add(x, top + 0.4, z, hot, 1.5, 0.2, LMode.Flicker, rnd());
    for (const sx of [-1, 1]) hazard(c, x - r, z + sx * (r + 0.45) - 0.11, x + r, z + sx * (r + 0.45) + 0.11);
    shadow(c, x - r, z - r, x + r, z + r, h);
    c.vents.push([x, top + 0.4, z]);
  };
  const main = place(c, s, cx, cz, 2.5, 2.5, rnd);
  if (main) core(main[0], main[1], 2.0, 2.0 + s.tier * 0.12);
  // Tier: secondary containment pods and heat-sink banks around the core.
  const pods = s.tier >= 3 ? (s.tier >= 5 ? 2 : 1) : 0;
  for (let k = 0; k < pods; k++) { const sd = k ? -1 : 1, p = place(c, s, cx + sd * 5, cz - 3 + k * 6, 1.5, 1.5, rnd); if (p) { core(p[0], p[1], 1.2, 1.4); conduit(c, p[0] - sd * 1.4, p[1], cx + sd * 2.5, cz, 0.12); } }
  const sinks = Math.min(6, 1 + s.tier);
  for (let k = 0; k < sinks; k++) {
    const sd = k % 2 ? -1 : 1, row = Math.floor(k / 2), alongX = rnd() < 0.5, w = alongX ? 3 : 1.7, d = alongX ? 1.7 : 3;
    const p = place(c, s, cx + sd * (3.6 + row * 1.4), cz + (row - 1) * 3.4 + (alongX ? 0 : 0.6), w / 2, d / 2, rnd);
    if (!p) continue;
    heatsink(c, p[0] - w / 2, p[1] - d / 2, p[0] + w / 2, p[1] + d / 2, DECK, 0.7 + rnd() * 0.4);
    shadow(c, p[0] - w / 2, p[1] - d / 2, p[0] + w / 2, p[1] + d / 2, 0.7);
  }
  // Coolant tanks.
  for (let k = 0; k < 1 + (s.tier >> 1); k++) {
    const p = place(c, s, cx + (rnd() * 2 - 1) * 5, cz + (rnd() < 0.5 ? -1 : 1) * (4.5 + rnd() * 2), 0.6, 1.1, rnd);
    if (!p) continue;
    lathe(c.bk, B.panels, [[0, 0], [0.42, 0.1], [0.45, 0.4], [0.45, 1.6], [0.42, 1.9], [0, 2]], 8, col(P.plate, 1.1), Tm(p[0], DECK + 0.48, p[1] - 1).multiply(RX(Math.PI / 2)), false, 1);
    for (const dz of [-0.6, 0.6]) box(c.bk, B.ribs, 0.95, 0.4, 0.18, P.dark, Tm(p[0], DECK + 0.2, p[1] + dz));
  }
  if (main) c.dmg.push([main[0], DECK + 0.4, main[1] + 2.5]);
}

function magnetModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const hex = c.L.light.port, n = Math.min(8, 3 + s.tier), cols = Math.ceil(n / 2), pitch = 3, cx = inboard(c, s, (cols * pitch) / 2 + 1), cz = s.z;
  const out = Math.sign(cx) || 1;
  // Tractor array: a regular grid of identical dishes, all canted outboard.
  for (let k = 0; k < n; k++) {
    const i = k % cols, j = Math.floor(k / cols);
    const x = cx + (i - (cols - 1) / 2) * pitch, z = cz - 1.5 + j * 3;
    if (!fits(c, s, x, z, 1.3, 1.3)) continue;
    take(c, x, z, 1.3, 1.3);
    tractorDish(c, x, z, 1.25, -out * 0.22, hex, rnd);
  }
  // Array control house and a salvage crane or two working over scrap bins.
  const hut = place(c, s, cx - out * ((cols * pitch) / 2 + 1.4), cz, 1.1, 1.0, rnd);
  if (hut) capacitor(c, hut[0], hut[1], 2, 1.8, 1.2, hex, rnd);
  for (let k = 0; k < (s.tier >= 3 ? 2 : 1); k++) {
    const p = place(c, s, cx + (k ? -1 : 1) * 2.6, cz + (k ? -1 : 1) * 5.4, 0.9, 0.9, rnd);
    if (!p) continue;
    crane(c, p[0], p[1], (k ? 0.6 : -2.4) + rnd() * 0.6, 4.4 + rnd() * 1.2, rnd);
    for (let b = 0; b < 2; b++) {
      const q = place(c, s, p[0] + (b ? 1.9 : -1.9), p[1] + (k ? -1.6 : 1.6), 0.65, 0.55, rnd);
      if (q) { box(c.bk, B.brackets, 1.2, 0.6, 1.0, col(c.L.paint.accent, 0.42), Tm(q[0], DECK + 0.23, q[1])); flatRect(c.bk, R.grate, q[0] - 0.5, q[1] - 0.4, q[0] + 0.5, q[1] + 0.4, DECK + 0.62, c.L.paint.dark); }
    }
  }
  c.dmg.push([cx, DECK + 0.4, cz]);
}

function repairModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const hex = c.L.hostile ? c.L.light.window : '#8fe39a', n = Math.min(5, 1 + Math.ceil(s.tier * 0.8)), pitch = 3.2;
  const cx = inboard(c, s, 4), cz = s.z, z0 = cz - ((n - 1) * pitch) / 2, hx = cx - 2;
  // A row of drone hangars along z, doors facing a narrow landing apron.
  for (let k = 0; k < n; k++) {
    const z = z0 + k * pitch;
    if (!fits(c, s, hx, z, 1.3, 1.35)) continue;
    take(c, hx, z, 1.3, 1.35);
    hangar(c, hx, z, 2.6, 2.5, 1.4 + rnd() * 0.3, 1, 0, hex, rnd);
  }
  // Landing pads on the apron: round hatch, pinpoint corner lamps, a drone parked on some.
  for (let k = 0; k < Math.ceil(n / 2) + (s.tier >= 4 ? 1 : 0); k++) {
    const z = z0 + k * pitch * 2, x = cx + 1.8;
    if (!fits(c, s, x, z, 1.15, 1.15)) continue;
    take(c, x, z, 1.15, 1.15);
    flatRect(c.bk, R.hatchRound, x - 1, z - 1, x + 1, z + 1, DECK + 0.05, c.L.paint.plate);
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) c.lights.add(x + dx * 1.05, DECK + 0.1, z + dz * 1.05, hex, 1, 0.1, LMode.Chase, ((dx + 1) + (dz + 1) * 2) / 8);
    if (rnd() < 0.6) drone(c, x, z, rnd() * 6, hex, rnd);
  }
  // Spares locker and a gantry mast with a beacon.
  const lk = place(c, s, cx + 1.8, z0 - 2.6, 0.9, 0.7, rnd);
  if (lk) capacitor(c, lk[0], lk[1], 1.7, 1.2, 0.9, hex, rnd);
  c.dmg.push([hx, DECK + 1.4, cz]);
}

function droneBayModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const hex = c.L.light.deck, n = Math.min(8, 2 + s.tier), pitch = 1.9, cx = inboard(c, s, (n * pitch) / 2 + 1), cz = s.z;
  const x0 = cx - ((n - 1) * pitch) / 2, L = 4.2, P = c.L.paint;
  // Launch slots: dark recessed rails pointing at the bow, hazard thresholds, chase lights, parked drones.
  for (let k = 0; k < n; k++) {
    const x = x0 + k * pitch;
    if (!fits(c, s, x, cz, 0.7, L / 2 + 0.3)) continue;
    take(c, x, cz, 0.7, L / 2 + 0.3);
    c.bk.get('black').quad([x - 0.65, DECK + 0.03, cz - L / 2], [x + 0.65, DECK + 0.03, cz - L / 2], [x + 0.65, DECK + 0.03, cz + L / 2], [x - 0.65, DECK + 0.03, cz + L / 2], [0, 0], [1, 0], [1, 1], [0, 1], P.dark, [0, 1, 0]);
    for (const sx of [-1, 1]) box(c.bk, B.rail, 0.14, 0.2, L, col(P.hull, 1.1), Tm(x + sx * 0.7, DECK + 0.1, cz));
    hazard(c, x - 0.65, cz - L / 2 - 0.35, x + 0.65, cz - L / 2 - 0.05);
    c.lights.row([x, DECK + 0.06, cz + L / 2 - 0.2], [x, DECK + 0.06, cz - L / 2 + 0.2], 0.55, hex, 1.1, 0.1, 1, LMode.Chase, rnd);
    if (rnd() < 0.55) drone(c, x, cz + 0.4, 0, hex, rnd, DECK + 0.03);
  }
  // Launch control cab aft of the slots, with a lit window strip.
  const cab = place(c, s, cx, cz + L / 2 + 1.4, 1.3, 0.6, rnd);
  if (cab) {
    block(c.bk, octagon(cab[0] - 1.2, cab[1] - 0.5, cab[0] + 1.2, cab[1] + 0.5, 0.2), DECK, DECK + 1, { side: B.darkPanel, top: B.brackets, col: col(P.hull, 0.85), topCol: col(P.hull, 1.2), bevel: 0.1 });
    c.bk.get('window').quad([cab[0] - 0.9, DECK + 0.45, cab[1] - 0.53], [cab[0] + 0.9, DECK + 0.45, cab[1] - 0.53], [cab[0] + 0.9, DECK + 0.75, cab[1] - 0.53], [cab[0] - 0.9, DECK + 0.75, cab[1] - 0.53], [0, 0.25], [0.05, 0.25], [0.05, 0.5], [0, 0.5], col(P.full, 0.8), [0, 0, -1]);
    shadow(c, cab[0] - 1.2, cab[1] - 0.5, cab[0] + 1.2, cab[1] + 0.5, 1);
  }
  // Higher tiers: a second, staggered rank of slots forward.
  if (s.tier >= 4) for (let k = 0; k < n - 2; k++) {
    const x = x0 + (k + 1) * pitch, z = cz - L - 0.9;
    if (!fits(c, s, x, z, 0.6, 1.2)) continue;
    take(c, x, z, 0.6, 1.2);
    c.bk.get('black').quad([x - 0.45, DECK + 0.03, z - 1.0], [x + 0.45, DECK + 0.03, z - 1.0], [x + 0.45, DECK + 0.03, z + 1.0], [x - 0.45, DECK + 0.03, z + 1.0], [0, 0], [1, 0], [1, 1], [0, 1], P.dark, [0, 1, 0]);
    c.lights.row([x, DECK + 0.06, z + 0.8], [x, DECK + 0.06, z - 0.8], 0.5, hex, 1, 0.1, 1, LMode.Chase, rnd);
  }
  c.dmg.push([cx, DECK + 0.4, cz]);
}

/** Sides a hull-side module covers: its own flank, or both when it sits on the centreline. */
const sidesOf = (x: number) => (x < -1 ? [-1] : x > 1 ? [1] : [-1, 1]);

/** Armour plating: thicker bolted strakes along this section's belt and gallery, never a blob on deck. */
function plateModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const P = c.L.paint, za = s.za + 1.5, zb = s.zb - 1.5;
  for (const sx of sidesOf(s.x)) {
    // Tier 1: the outboard gallery is plated over with thick bolted slabs (visible from above).
    for (let z = za; z < zb - 1;) {
      const L = Math.min(zb - z, 2.6 + rnd() * 1.6), gi = Math.max(c.de(z), c.de(z + L)) + 0.6, go = Math.min(c.hw(z), c.hw(z + L)) - 1.5;
      if (go - gi > 0.8) {
        const x = sx * (gi + go) / 2;
        box(c.bk, B.panels, go - gi, 0.32, L - 0.15, col(P.hull, 0.9 + rnd() * 0.25), Tm(x, DECK - 2.4 + 0.16, z + L / 2));
        for (const e of [gi + 0.2, go - 0.2]) for (const bz of [z + 0.3, z + L - 0.45]) box(c.bk, B.rail, 0.1, 0.06, 0.1, P.dark, Tm(sx * e, DECK - 2.05, bz));
      }
      z += L;
    }
    if (s.tier < 2) continue;
    c.belt.push([sx, za, zb]);
    // Tier 2+: courses bolted along the belt, from the waterline up; each tier adds one.
    const courses: [number, number, number][] = [[DECK - 6.3, DECK - 4.1, 0.55], [DECK - 7.9, DECK - 6.5, 0.4], [DECK - 3.9, DECK - 3.0, 0.35]];
    courses.slice(0, Math.min(3, s.tier - 1)).forEach(([y0, y1, th], ci) => {
      let z = za + (ci % 2) * 1.6;
      while (z < zb - 1) {
        const L = Math.min(zb - z, 3.2 + rnd() * 2.2), hw = Math.min(c.hw(z), c.hw(z + L)), x = sx * (hw + th / 2 + 0.02);
        box(c.bk, ci === 1 ? B.ribs : B.panels, th, y1 - y0, L - 0.18, col(P.hull, 0.82 + rnd() * 0.2), Tm(x, (y0 + y1) / 2, z + L / 2));
        // Bolt heads along the top edge.
        for (let b = z + 0.4; b < z + L - 0.3; b += 0.7) box(c.bk, B.rail, 0.08, 0.08, 0.08, P.dark, Tm(x + sx * (th / 2 + 0.03), y1 - 0.18, b));
        z += L;
      }
    });
    // Tier 3+: a low armoured bulwark along the gallery edge.
    if (s.tier >= 3) {
      for (let z = za; z < zb - 1; z += 4) {
        const L = Math.min(zb - z, 3.8), hw = Math.min(c.hw(z), c.hw(z + L)), x = sx * (hw - 1.1);
        box(c.bk, B.ribs, 0.35, 0.7, L - 0.2, col(P.hull, 0.9), Tm(x, DECK - 2.4 + 0.35, z + L / 2));
      }
    }
  }
  // On deck only spare-plate pallets by the mount (stacked, low, a couple of units long).
  const piles = 1 + Math.ceil(s.tier / 2);
  for (let k = 0; k < piles; k++) {
    const p = place(c, s, s.x + (k - (piles - 1) / 2) * 2.4, s.z + (rnd() * 2 - 1), 0.9, 0.6, rnd);
    if (!p) continue;
    const layers = 2 + Math.floor(rnd() * 3);
    for (let l = 0; l < layers; l++) box(c.bk, l % 2 ? B.ribs : B.panels, 1.6 - l * 0.06, 0.13, 1.0 - l * 0.04, col(P.hull, 0.85 + l * 0.06), Tm(p[0] + (rnd() - 0.5) * 0.08, DECK + 0.07 + l * 0.14, p[1]).multiply(RY((rnd() - 0.5) * 0.12)));
    shadow(c, p[0] - 0.8, p[1] - 0.5, p[0] + 0.8, p[1] + 0.5, 0.4);
  }
}

/** Vector thrusters: small nozzle pods on the outboard gallery (aft-facing), fed by a plenum installation on deck. */
function thrusterModule(c: UCtx, s: UtilSpec, rnd: Rng) {
  const P = c.L.paint, hot = c.L.light.engine, pods = Math.min(4, 1 + Math.ceil(s.tier / 2)), spacing = 4.2;
  for (const sx of sidesOf(s.x)) {
    for (let k = 0; k < pods; k++) {
      const z = s.z + (k - (pods - 1) / 2) * spacing;
      if (z < s.za + 2 || z > s.zb - 2.5) continue;
      // Pods sit on the outboard gallery (seen from above), nozzles out of the aft face.
      const gi = Math.max(c.de(z - 1.4), c.de(z + 1.4)) + 0.5, go = Math.min(c.hw(z - 1.4), c.hw(z + 1.4)) - 1.3;
      const w = Math.min(1.8, go - gi); if (w < 0.9) continue;
      const x = sx * (gi + go) / 2, y = DECK - 2.4 + 0.6;
      block(c.bk, octagon(x - w / 2, z - 1.4, x + w / 2, z + 1.3, 0.3), DECK - 2.4, y + 0.5, { side: B.panels, top: B.ribs, col: col(P.hull, 0.95), topCol: col(P.hull, 1.25), bevel: 0.15, taper: 0.06 });
      box(c.bk, B.rail, w * 0.6, 0.1, 1.6, P.dark, Tm(x, y + 0.52, z - 0.2));
      const nb = s.tier >= 3 ? 3 : 2;
      for (let b = 0; b < nb; b++) {
        const bx = x + (b - (nb - 1) / 2) * (w / nb), m = Tm(bx, y, z + 1.25).multiply(RX(Math.PI / 2));
        const r = Math.min(0.3, w / nb / 2 - 0.04);
        lathe(c.bk, B.ribs, [[r * 0.8, 0], [r * 0.75, 0.2], [r, 0.65], [r * 0.95, 0.68]], 8, P.dark, m);
        lathe(c.bk, BLACK, [[r * 0.9, 0.66], [r * 0.6, 0.25]], 8, P.dark, m);
        lathe(c.bk, CORE, [[r * 0.58, 0.26], [0, 0.27]], 8, col(P.full, 0.45), m);
      }
      c.lights.add(x, y + 0.65, z - 1.2, hot, 0.9, 0.1, LMode.Steady, rnd());
      shadow(c, x - w / 2, z - 1.4, x + w / 2, z + 1.3, 0.8, DECK - 2.34);
      c.nozzles.push({ x, y, z: z + 2.1, r: 0.75, main: false, aft: true });
    }
  }
  // Plenum on deck: twin propellant tanks, a pump house and feed lines out to the hull edge.
  const p = place(c, s, inboard(c, s, 2.5), s.z, 1.3, 1.5, rnd);
  if (p) {
    for (const dx of [-0.55, 0.55]) lathe(c.bk, B.panels, [[0, 0], [0.42, 0.1], [0.45, 0.35], [0.45, 2.3], [0.42, 2.55], [0, 2.65]], 8, col(P.plate, 1.15), Tm(p[0] + dx, DECK + 0.5, p[1] - 1.3).multiply(RX(Math.PI / 2)), false, 1);
    for (const dz of [-0.9, 0.9]) box(c.bk, B.ribs, 2.1, 0.45, 0.2, P.dark, Tm(p[0], DECK + 0.22, p[1] + dz));
    shadow(c, p[0] - 1.1, p[1] - 1.3, p[0] + 1.1, p[1] + 1.3, 1);
    const pump = place(c, s, p[0] + (p[0] > 0 ? 1 : -1) * 2.2, p[1], 0.6, 0.6, rnd);
    if (pump) {
      capacitor(c, pump[0], pump[1], 1.1, 1.1, 0.75, hot, rnd);
      for (const sx of sidesOf(s.x)) { const ex = sx * (c.de(pump[1]) - 0.8); if (Math.sign(ex - pump[0]) === sx) conduit(c, pump[0] + sx * 0.6, pump[1], ex, pump[1], 0.1); }
    }
  }
  c.dmg.push([s.x, DECK + 0.4, s.z]);
}

/** An empty utility bay: a closed hatch with bollards. */
function emptyBay(c: UCtx, s: UtilSpec, rnd: Rng) {
  const p = place(c, s, s.x, s.z, 1.4, 1.4, rnd); if (!p) return;
  flatRect(c.bk, R.hatchCross, p[0] - 1.2, p[1] - 1.2, p[0] + 1.2, p[1] + 1.2, DECK + 0.05, c.L.paint.plate);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lathe(c.bk, B.rail, [[0.1, 0], [0.1, 0.3], [0, 0.32]], 5, c.L.paint.dark, Tm(p[0] + dx * 1.35, DECK, p[1] + dz * 1.35));
}

/**
 * Build one utility module into the zone around its mount. The zone is held claimed by the caller; it is
 * released here so installations can claim their own footprints, the gaps get low machinery (the deck's
 * own greeble language), and the whole zone is claimed again so nothing big lands on top later.
 */
export function utilityModule(c: UCtx, rnd: Rng, s: UtilSpec) {
  const zi = c.occ.findIndex((o) => o[0] === s.zone[0] && o[1] === s.zone[1] && o[2] === s.zone[2] && o[3] === s.zone[3]);
  if (zi >= 0) c.occ.splice(zi, 1);
  switch (s.id) {
    case 'shield': shieldModule(c, s, rnd); break;
    case 'reactor': reactorModule(c, s, rnd); break;
    case 'magnet': magnetModule(c, s, rnd); break;
    case 'repair': repairModule(c, s, rnd); break;
    case 'drones': droneBayModule(c, s, rnd); break;
    case 'plate': plateModule(c, s, rnd); break;
    case 'thruster': thrusterModule(c, s, rnd); break;
    default: emptyBay(c, s, rnd);
  }
  // Fill what is left of the zone with low machinery so the module beds into the deck.
  const [x0, z0, x1, z1] = s.zone, cell = 2.6;
  for (let z = z0; z < z1 - 0.8; z += cell) for (let x = x0; x < x1 - 0.8; x += cell) {
    const xb = Math.min(x1, x + cell), zb = Math.min(z1, z + cell);
    if (xb - x < 1.2 || zb - z < 1.2) continue;
    if (!onDeck(c, x, z, xb, zb, 1.2) || occupied(c, x, z, xb, zb, 0.2) || rnd() < 0.25) continue;
    machinery(c, rnd, x + 0.15, z + 0.15, xb - 0.15, zb - 0.15, DECK, 1.0);
    claim(c, x, z, xb, zb);
  }
  claim(c, x0, z0, x1, z1);
}

/** The deck zone a utility module may use around its mount (reference scale). */
export function utilZone(type: string, x: number, z: number): Box4 {
  const hx = type === 'engine' ? 7.5 : type === 'spine' ? 8.5 : 9.5, hz = type === 'engine' ? 7.5 : 8.5;
  return [x - hx, z - hz, x + hx, z + hz];
}
