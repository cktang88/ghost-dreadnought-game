// Procedural carrier-scale warship built from a Derived hull layout (dv.rects / dv.mounts).
// Ship-local space: x to starboard (screen right), y up, +z toward the stern; field units
// (one unit is about one screen pixel, so a 150-unit starter hull is ~300 m of ship at 2 m/unit).
//
// Layers, outside in:
//   1. Hull: one continuous lofted slab (chamfered deck edge, armour belt, bilge, keel) whose plan
//      follows the section widths with 45-degree transitions and an ogival bow.
//   2. Deck: plating strakes that follow the hull lines, each strake a trim-sheet band.
//   3. Superstructure per section type (bridge tower stack, gun decks, broadside sponsons, armoured
//      flight deck, utility spine, engine block), with lit window bands and drop shadows.
//   4. Kitbash: Quaternius sci-fi kit pieces (vents, fans, barrels, lights, decals) merged per material.
//   5. Life: thousands of running lights, rotating radars, spinning fans, beacons and strobes.
import * as THREE from 'three';
import { WEAPONS, HULL_BEAM, drawnObstacles, type Derived, type Rect as HullRect, type Mount, type Obstacle } from '../../data/parts';
import { SHIP_SCALE } from '../../game/field';
import { has, mulberry32, type Rng } from '../../util/rng';
import { source, meshesOf } from '../assets';
import { Buckets, B, R, block, flat, flatRect, lathe, box, octagon, type V2, type V3, type Band } from './mesh';
import { KIT_MAT, STENCIL_CHARS, type Livery, type MatKey } from './materials';
import { LightSet, LMode, lightMaterial } from './lights';
import { buildMount, GunRig, type Turret } from './turrets';
import { mountTraverse } from './arcs';
import { occupied, claim, onDeck, deckGreebles, beltGreebles, stencil, antenna, dish, machinery, heatsink } from './greebles';
import { utilityModule, utilZone, type UCtx } from './utilities';

/** Ships are designed at this SHIP_SCALE; other scales build at the reference size and scale the body. */
const REF_SCALE = 2.6;

export const DECK = 8, KEEL = -16;
/** Broadside sponson roof above the main deck. */
const SPON_H = 3.2;

/** Engine exhaust anchor (root space on the model). `aft`: a small fixed jet that always fires aft (thruster pods). */
export interface Nozzle { x: number; y: number; z: number; r: number; main: boolean; aft?: boolean }
export interface Spinner { obj: THREE.Object3D; speed: number }
export interface ShipModel {
  /** root: placed and oriented by the layer. body: scaled by k; every mesh and every point below is in body space. */
  root: THREE.Group; body: THREE.Group; k: number;
  turrets: Turret[]; rig: GunRig; nozzles: Nozzle[]; dmgPts: V3[]; vents: V3[]; spinners: Spinner[];
  lights: THREE.Points; edges: THREE.LineSegments | null; scorch: THREE.Mesh; len: number; width: number; hostile: boolean; tris: number;
}

interface Ctx extends UCtx {
  rnd: Rng;
  dmg: V3[]; vents: V3[]; spin: Spinner[]; nozzles: Nozzle[]; root: THREE.Group; turrets: Turret[];
  edgeSegs: THREE.BufferGeometry[]; sig: number;
}

/* ---------------- helpers ---------------- */
const col = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Soft drop shadow on the surface at y, cast by something h tall over the plan rect. Moon is up-left-forward. */
function dropShadow(c: Ctx, x0: number, z0: number, x1: number, z1: number, y: number, h: number) {
  const ox = h * 0.8, oz = h * 0.62, g = 0.8 + h * 0.3;
  c.bk.get('shadow').quad([x0 - g + ox, y, z0 - g + oz], [x1 + g + ox, y, z0 - g + oz], [x1 + g + ox, y, z1 + g + oz], [x0 - g + ox, y, z1 + g + oz], [0, 0], [1, 0], [1, 1], [0, 1], c.L.paint.hull, [0, 1, 0]);
}

/** Additive pool of warm light on a surface (floodlights, window spill). */
function pool(c: Ctx, x: number, z: number, w: number, d: number, y: number, k = 1) {
  c.bk.get('pool').quad([x - w / 2, y, z - d / 2], [x + w / 2, y, z - d / 2], [x + w / 2, y, z + d / 2], [x - w / 2, y, z + d / 2], [0, 0], [1, 0], [1, 1], [0, 1], col(c.L.paint.full, k), [0, 1, 0]);
}

/** Roof clutter on a superstructure block: a machinery field, hatches, a skylight strip, masts and dishes. */
function roof(c: Ctx, x0: number, z0: number, x1: number, z1: number, y: number) {
  const P = c.L.paint, w = x1 - x0, d = z1 - z0;
  if (w < 3 || d < 3) return;
  // Big roofs carry a whole machinery field (the small-scale layer that makes the block a building).
  if (w * d > 40) { machinery(c, c.rnd, x0 + 0.4, z0 + 0.4, x1 - 0.4, z1 - 0.4, y, 0.9); return; }
  if (c.rnd() < 0.6 && d > 5) { const sx = x0 + w * (0.2 + c.rnd() * 0.6); flat(c.bk, 'window', sx - 0.25, z0 + 1, sx + 0.25, z1 - 1, y + 0.04, P.full, [[0, 0.25], [0, 0.5], [(d - 2) / 60, 0.5], [(d - 2) / 60, 0.25]]); }
  // Dense rooftop plant: the small-scale layer that gives the tower its size.
  const n = Math.min(14, Math.floor((w * d) / 14));
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(c.rnd() * 7), cx = x0 + 1 + c.rnd() * (w - 2), cz = z0 + 1 + c.rnd() * (d - 2);
    if (kind === 0) flatRect(c.bk, R.hatchRound, cx - 0.5, cz - 0.5, cx + 0.5, cz + 0.5, y + 0.05, P.plate);
    else if (kind === 1) flatRect(c.bk, R.ventSlots, cx - 0.8, cz - 0.35, cx + 0.8, cz + 0.35, y + 0.05, P.hull);
    else if (kind === 2) kit(c, 'Prop_Vent_Small', cx, y + 0.02, cz, c.rnd() < 0.5 ? 0 : Math.PI / 2, 0.9);
    else if (kind === 3) { const bw = 0.6 + c.rnd() * 1.4, bd = 0.5 + c.rnd() * 1.2, bh = 0.3 + c.rnd() * 0.7; box(c.bk, B.ribs, bw, bh, bd, col(P.hull, 0.9 + c.rnd() * 0.4), new THREE.Matrix4().makeTranslation(cx, y + bh / 2, cz)); }
    else if (kind === 4) antenna(c, cx, y, cz, 1.5 + c.rnd() * 3, c.rnd);
    else if (kind === 5) dish(c, cx, y, cz, 0.5 + c.rnd() * 0.6, c.rnd);
    else c.lights.add(cx, y + 0.15, cz, c.L.light.edge, 0.9, 0.16, LMode.Steady, c.rnd());
  }
}

/** Lit window band around a convex plan polygon between heights ya..yb. */
function windowBand(c: Ctx, poly: V2[], ya: number, yb: number, rows = 0.5, tile = 40) {
  let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
  const mb = c.bk.get('window'); let per = c.rnd() * 30;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1.5) { per += len; continue; }
    const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len, dir = (nx * ((a[0] + b[0]) / 2 - cx) + nz * ((a[1] + b[1]) / 2 - cz)) > 0 ? 1 : -1, o = 0.07 * dir;
    const v0 = Math.floor(c.rnd() * 2) * 0.5;
    mb.quad([a[0] + nx * o, ya, a[1] + nz * o], [b[0] + nx * o, ya, b[1] + nz * o], [b[0] + nx * o, yb, b[1] + nz * o], [a[0] + nx * o, yb, a[1] + nz * o],
      [per / tile, v0 + rows], [(per + len) / tile, v0 + rows], [(per + len) / tile, v0], [per / tile, v0], c.L.paint.full, [nx * dir, 0, nz * dir]);
    per += len;
  }
}

/** Lights along a polygon outline at height y, pushed outward by `out`. */
function outlineLights(c: Ctx, poly: V2[], y: number, step: number, hex: string, k: number, size: number, fill = 1, mode = LMode.Steady, out = 0.25) {
  let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ax = a[0] + Math.sign(a[0] - cx) * out, az = a[1] + Math.sign(a[1] - cz) * out, bx = b[0] + Math.sign(b[0] - cx) * out, bz = b[1] + Math.sign(b[1] - cz) * out;
    c.lights.row([ax, y, az], [bx, y, bz], step, hex, k, size, fill, mode, c.rnd);
  }
}

interface TowerOpts { side?: Band; top?: Band; col?: THREE.Color; bevel?: number; taper?: number; win?: [number, number][]; edgeLights?: boolean; shadow?: boolean; claim?: boolean; roof?: boolean }
/** A superstructure block: geometry, drop shadow, window bands, roof-edge lights, occupancy. */
function tower(c: Ctx, poly: V2[], y0: number, y1: number, o: TowerOpts = {}) {
  const base = o.col ?? c.L.paint.hull;
  // Roofs catch the moon; walls sit in shadow.
  block(c.bk, poly, y0, y1, { side: o.side ?? B.darkPanel, top: o.top ?? B.panels, col: col(base, 0.7), topCol: col(base, 1.3), bevel: o.bevel ?? 1, taper: o.taper ?? 0.3 });
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (o.shadow !== false) dropShadow(c, x0, z0, x1, z1, y0 + 0.06, y1 - y0);
  for (const [a, b] of o.win ?? []) windowBand(c, poly, a, b);
  if (o.win?.length) {
    // Window light spilling onto the deck round the base.
    const k = 0.55;
    pool(c, (x0 + x1) / 2, z1 + 1.2, x1 - x0, 4, y0 + 0.09, k); pool(c, (x0 + x1) / 2, z0 - 1.2, x1 - x0, 4, y0 + 0.09, k * 0.7);
    pool(c, x0 - 1.2, (z0 + z1) / 2, 4, z1 - z0, y0 + 0.09, k * 0.8); pool(c, x1 + 1.2, (z0 + z1) / 2, 4, z1 - z0, y0 + 0.09, k * 0.8);
  }
  const bev = Math.min(o.bevel ?? 1, (y1 - y0) * 0.45), ins = bev + (o.taper ?? 0.3);
  if (o.roof !== false) roof(c, x0 + ins, z0 + ins, x1 - ins, z1 - ins, y1);
  if (o.edgeLights !== false) outlineLights(c, poly.map(([x, z]) => [x * 0.985, z] as V2), y1 + 0.12, 1.1, c.L.light.edge, 0.9, 0.22, 0.75, LMode.Steady, -0.4);
  if (o.claim !== false) claim(c, x0, z0, x1, z1);
  if (o.edgeLights !== false) c.edgeSegs.push(edgeRing(poly, y1)); // small deck houses get no hostile rim line
  return { x0, x1, z0, z1 };
}
function edgeRing(poly: V2[], y: number) {
  const p: number[] = [];
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; p.push(a[0], y, a[1], b[0], y, b[1]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); return g;
}

/* ---------------- kitbash ---------------- */
const kitCache = new Map<string, { geo: THREE.BufferGeometry; m: THREE.Matrix4; key: MatKey }[]>();
function kitParts(name: string) {
  let k = kitCache.get(name); if (k) return k;
  k = [];
  const src = source('scifi', name);
  if (src) for (const { mesh, matrix } of meshesOf(src)) {
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    k.push({ geo: mesh.geometry, m: matrix, key: KIT_MAT[mat.name] ?? 't2' });
  }
  kitCache.set(name, k); return k;
}
function kitCol(c: Ctx, key: MatKey) {
  const P = c.L.paint;
  if (key === 'glass' || key === 'lamp' || key === 'window' || key === 'glow' || key === 'core') return P.full;
  return key === 't1' ? P.hull : key === 't2' ? P.plate : key === 't3' ? P.plate : key === 'dark' ? P.dark : key === 'hazard' ? P.accent : P.hull;
}
/** Place a kit model: position, yaw, uniform scale (and optional extra matrix). */
function kit(c: Ctx, name: string, x: number, y: number, z: number, yaw = 0, s = 1, pre?: THREE.Matrix4, into?: Buckets) {
  const parts = kitParts(name); if (!parts.length) return false;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));
  if (pre) m.multiply(pre);
  for (const p of parts) (into ?? c.bk).get(p.key).addGeometry(p.geo, m.clone().multiply(p.m), kitCol(c, p.key));
  return true;
}

/* ---------------- hull outline ---------------- */
/**
 * The hull is one lofted volume of nearly constant beam (sections only nudge it: the bridge and spine a
 * little finer, the armoured hull a little fuller), with a long clipper prow ahead of the first section
 * and a rounded transom after the last. Stations carry the half beam at the main deck edge and how far
 * toward an end they are (`f`: 0 amidships, 1 at the stem or the transom), which lifts the keel and pulls
 * the lower hull in under the flared deck.
 */
const HULL_HW: Record<string, number> = { bridge: 0.94, gundeck: 1, battery: 1, armor: 1.06, spine: 0.9, engine: 0.97 };
interface Station { z: number; hw: number; f: number; bow?: boolean }
/** Half beam of the hull proper (body units). */
const HHW = (HULL_BEAM * REF_SCALE) / 2;
/** Clipper prow length ahead of the first section, and how far into it the entry runs. */
export const prowLen = (hw: number) => hw * 1.45;
function stations(rects: HullRect[]): Station[] {
  const st: Station[] = [], hws = rects.map((r) => HHW * (HULL_HW[r.type] ?? 1));
  const r0 = rects[0], zA = r0.y, P = prowLen(hws[0]), S = Math.min(r0.h * 0.24, 18), L = P + S;
  // Clipper prow: a hollow, knife-fine entry that swells into the shoulders.
  for (let k = 0; k <= 10; k++) { const t = k / 10; st.push({ z: zA - P + L * t, hw: Math.max(0.3, hws[0] * Math.pow(1 - Math.pow(1 - t, 2.2), 1.5)), f: Math.pow(1 - t, 1.4), bow: true }); }
  // Section to section: long smooth fairings, never a step.
  rects.forEach((r, i) => {
    if (!i || Math.abs(hws[i] - hws[i - 1]) < 0.05) return;
    const R = Math.min(16, r.h * 0.45, rects[i - 1].h * 0.45);
    for (let k = 0; k <= 4; k++) { const t = k / 4, s = t * t * (3 - 2 * t); st.push({ z: r.y - R / 2 + R * t, hw: hws[i - 1] + (hws[i] - hws[i - 1]) * s, f: 0 }); }
  });
  // Rounded stern: the quarters tuck in to a transom a little past the last section.
  const rl = rects[rects.length - 1], zB = rl.y + rl.h, hl = hws[hws.length - 1], SL = hl * 0.5;
  for (let k = 0; k <= 6; k++) { const t = k / 6; st.push({ z: zB - 6 + (SL + 6) * t, hw: hl * Math.sqrt(1 - Math.pow(t * 0.82, 2)), f: Math.pow(t, 1.6) * 0.6 }); }
  st.sort((a, b) => a.z - b.z);
  // Monotonic guard (fairings can meet the prow or stern runs).
  const out: Station[] = [];
  for (const s of st) { const p = out[out.length - 1]; if (p && s.z - p.z < 1.5) { if (s.bow || s.f > p.f) out[out.length - 1] = s; continue; } out.push(s); }
  return out;
}
function hwFn(st: Station[]) {
  return (z: number) => {
    if (z <= st[0].z) return st[0].hw; if (z >= st[st.length - 1].z) return st[st.length - 1].hw;
    for (let i = 1; i < st.length; i++) if (z <= st[i].z) { const a = st[i - 1], b = st[i], t = (z - a.z) / (b.z - a.z || 1); return a.hw + (b.hw - a.hw) * t; }
    return st[st.length - 1].hw;
  };
}
/** Inner edge of the outboard gallery: the main deck spans +-terrace(hw). */
export const terrace = (hw: number) => hw - Math.min(Math.max(5, hw * 0.13), hw * 0.4);
/**
 * Starboard half-profile, top to bottom: main deck edge, terrace wall, gallery, gunwale, upper side
 * (portholes), the sloped armour belt standing proud of the side like a waterline, then the hull tucking
 * under to a deep keel. Toward the ends the belt fades, the keel lifts and the lower hull narrows.
 */
function profile(s: Station): V2[] {
  const hw = s.hw, T = terrace(hw), e = Math.min(1, hw / 14) * (1 - s.f * 0.6), n = 1 - 0.3 * s.f;
  const kY = KEEL + (DECK - 9 - KEEL) * Math.pow(s.f, 1.2), sc = (DECK - 8 - kY) / (DECK - 8 - KEEL);
  const lo = (y: number) => DECK - 8 + (y - (DECK - 8)) * sc;
  return [[T, DECK], [T + 0.5, DECK - 2.4], [hw - 1.4, DECK - 2.4], [hw, DECK - 3.6], [hw, DECK - 8],
    [hw * n + 1.8 * e, lo(DECK - 9.2)], [hw * n + 1.8 * e, lo(DECK - 12.4)], [hw * n - 0.6, lo(DECK - 13.8)],
    [hw * n * 0.8, lo(KEEL + 4.5)], [hw * n * 0.45, lo(KEEL + 1)], [Math.max(0.2, hw * 0.1), kY]];
}
const PROFILE_BANDS: Band[] = [B.lightbar, B.grille, B.ribs, B.panels, B.brackets, B.panels, B.ribs, B.darkPanel, B.darkPanel, B.darkPanel];
const PROFILE_SHADE = [1.0, 0.8, 1.0, 1.0, 1.25, 1.05, 0.75, 0.55, 0.45, 0.4];

function hull(c: Ctx, st: Station[]) {
  const P = c.L.paint, LL = c.L.light;
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1], pa = profile(a), pb = profile(b);
    for (const sx of [1, -1]) {
      for (let k = 0; k < pa.length - 1; k++) {
        const band = PROFILE_BANDS[k], h = Math.hypot(pa[k + 1][0] - pa[k][0], pa[k + 1][1] - pa[k][1]), tile = Math.max(1, h / (band.v1 - band.v0)) || 10;
        const out: V3 = [sx * (pa[k][0] + pa[k + 1][0]) / 2, (pa[k][1] + pa[k + 1][1]) / 2 - (DECK - 6), 0];
        if (k === 1) { out[0] = 0; out[1] = 1; } // gallery deck faces up
        c.bk.get(band.m).quad([sx * pa[k][0], pa[k][1], a.z], [sx * pb[k][0], pb[k][1], b.z], [sx * pb[k + 1][0], pb[k + 1][1], b.z], [sx * pa[k + 1][0], pa[k + 1][1], a.z],
          [a.z / tile, band.v0], [b.z / tile, band.v0], [b.z / tile, band.v1], [a.z / tile, band.v1], col(k === 1 ? P.plate : P.hull, PROFILE_SHADE[k]), out);
      }
      // Safety line inboard of the deck edge.
      { const ia = terrace(a.hw) - 1.6, ib = terrace(b.hw) - 1.6, y = DECK + 0.03;
        if (ia > 1 && ib > 1) c.bk.get('paint').quad([sx * ia, y, a.z], [sx * (ia - 0.45), y, a.z], [sx * (ib - 0.45), y, b.z], [sx * ib, y, b.z], [0, a.z / 30], [0.02, a.z / 30], [0.02, b.z / 30], [0, b.z / 30], col(P.accent, 0.55), [0, 1, 0]); }
      if (a.hw < 3) continue;
      // Life along the hull: main-deck edge lamps, terrace portholes, gallery walkway lamps, belt portholes.
      const T0 = terrace(a.hw), T1 = terrace(b.hw);
      // Thousands of crew: dense, faint porthole rows on four decks of the side, deck-edge lamps above.
      c.lights.row([sx * (T0 - 0.4), DECK + 0.15, a.z], [sx * (T1 - 0.4), DECK + 0.15, b.z], 1.6, LL.edge, 1.0, 0.24, 0.8, LMode.Steady, c.rnd);
      c.lights.row([sx * (T0 + 0.55), DECK - 1.0, a.z], [sx * (T1 + 0.55), DECK - 1.0, b.z], 0.55, LL.window, 0.9, 0.2, 0.55, LMode.Steady, c.rnd);
      c.lights.row([sx * (a.hw - 1.6), DECK - 2.25, a.z], [sx * (b.hw - 1.6), DECK - 2.25, b.z], 1.2, LL.window, 1.0, 0.22, 0.7, LMode.Steady, c.rnd);
      for (const [yy, f] of [[DECK - 4.6, 0.55], [DECK - 5.5, 0.5], [DECK - 6.4, 0.42], [DECK - 7.3, 0.32]]) c.lights.row([sx * (a.hw + 0.12), yy, a.z], [sx * (b.hw + 0.12), yy, b.z], 0.5, LL.window, 0.85, 0.19, f, LMode.Steady, c.rnd);
      // Waterline: a sparse string of lamps along the top of the armour belt.
      if (a.f < 0.4) { const qa = pa[5], qb = pb[5]; c.lights.row([sx * (qa[0] + 0.1), qa[1] + 0.1, a.z], [sx * (qb[0] + 0.1), qb[1] + 0.1, b.z], 3.2, LL.edge, 0.8, 0.22, 0.6, LMode.Steady, c.rnd); }
    }
    const kA = pa[pa.length - 1], kB = pb[pb.length - 1];
    c.bk.get('t1').quad([-kA[0], kA[1], a.z], [kA[0], kA[1], a.z], [kB[0], kB[1], b.z], [-kB[0], kB[1], b.z], [0, 0.6], [1, 0.6], [1, 0.9], [0, 0.9], P.dark, [0, -1, 0]);
  }
  // Bow and stern caps (the transom faces the camera).
  const cap = (s: Station, dir: number) => {
    const half = profile(s), ring: V2[] = [...half, ...half.slice().reverse().map(([x, y]) => [-x, y] as V2)];
    const mb = c.bk.get('t1'), cz = s.z, tile = 24;
    const uv = (x: number, y: number): V2 => [x / tile, B.darkPanel.v0 + ((DECK - y) / (DECK - KEEL)) * (B.darkPanel.v1 - B.darkPanel.v0)];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      mb.tri([0, DECK - 5, cz], [p[0], p[1], cz], [q[0], q[1], cz], uv(0, DECK - 5), uv(p[0], p[1]), uv(q[0], q[1]), col(P.hull, 0.7), [0, 0, dir]);
    }
  };
  cap(st[0], -1); cap(st[st.length - 1], 1);
  // Stern: rows of cabin lights across the transom, and a hazard band at the deck edge.
  const s = st[st.length - 1];
  for (const [yy, f] of [[DECK - 1.2, 0.7], [DECK - 4, 0.75], [DECK - 4.9, 0.6], [DECK - 5.8, 0.6], [DECK - 6.7, 0.5]]) c.lights.row([-s.hw + 2.5, yy, s.z + 0.3], [s.hw - 2.5, yy, s.z + 0.3], 0.5, LL.window, 0.95, 0.2, f, LMode.Steady, c.rnd);
  const zt = s.z - 0.2, hz = c.bk.get('hazard'), e = terrace(s.hw) - 0.3;
  hz.quad([-e, DECK + 0.04, zt - 2.2], [e, DECK + 0.04, zt - 2.2], [e, DECK + 0.04, zt], [-e, DECK + 0.04, zt], [0, 0], [e / 4, 0], [e / 4, 1], [0, 1], P.accent, [0, 1, 0]);
  // Edge silhouette for the ghost livery: the gunwale and the belt.
  const ep: number[] = [];
  for (let i = 0; i < st.length - 1; i++) for (const sx of [1, -1]) for (const k of [3, 5]) {
    const pa = profile(st[i])[k], pb = profile(st[i + 1])[k]; ep.push(sx * pa[0], pa[1], st[i].z, sx * pb[0], pb[1], st[i + 1].z);
  }
  const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3)); eg.userData.k = 1; c.edgeSegs.push(eg);
}

/** Deck plating: parallel strakes (fixed x lanes), broken into staggered plates of varied tone, clipped to the deck edge. */
function deck(c: Ctx, st: Station[], rects: HullRect[], maxHw: number) {
  const SW = 7.5, E = terrace(maxHw), N = Math.max(5, (Math.round((E * 2) / SW) | 1)), half = (N - 1) / 2;
  const typeAt = (z: number) => { for (const r of rects) if (z >= r.y && z <= r.y + r.h) return r.type; return z < rects[0].y ? rects[0].type : rects[rects.length - 1].type; };
  const zS = st[0].z, zE = st[st.length - 1].z;
  for (let k = 0; k < N; k++) {
    const d = Math.abs(k - half), x0 = -E + (2 * E * k) / N, x1 = -E + (2 * E * (k + 1)) / N;
    let cur = zS - c.rnd() * 10;
    while (cur < zE) {
      const L = 7 + c.rnd() * 11, za = Math.max(cur, zS), zb = Math.min(cur + L, zE); cur += L;
      if (zb - za < 0.05) continue;
      const rr = c.rnd(), tone = rr < 0.06 ? 0.62 : rr > 0.95 ? 1.18 : 0.84 + c.rnd() * 0.22;
      const zs = [za]; for (const s0 of st) if (s0.z > za + 0.01 && s0.z < zb - 0.01) zs.push(s0.z); zs.push(zb);
      for (let j = 0; j < zs.length - 1; j++) {
        const z0 = zs[j], z1 = zs[j + 1], type = typeAt((z0 + z1) / 2);
        let band: Band;
        if (type === 'armor') band = d <= 2 ? B.doors : d <= 3 ? B.brackets : d % 2 ? B.darkPanel : B.panels;
        else if (type === 'engine') band = d === 0 ? B.grille : d <= 2 ? B.darkPanel : d % 2 ? B.panels : B.brackets;
        else if (type === 'battery') band = d === 0 ? B.doors : d % 2 ? B.darkPanel : B.panels;
        else band = d === 0 ? B.doors : d % 3 === 1 ? B.panels : d % 3 === 2 ? B.brackets : B.darkPanel;
        const ea = c.de(z0), eb = c.de(z1), cl = (x: number, e: number) => Math.max(-e, Math.min(e, x));
        const xa0 = cl(x0, ea), xa1 = cl(x1, ea), xb0 = cl(x0, eb), xb1 = cl(x1, eb);
        if (xa1 - xa0 < 0.01 && xb1 - xb0 < 0.01) continue;
        const tile = (x1 - x0) / (band.v1 - band.v0), vv = (x: number) => band.v0 + ((x - x0) / (x1 - x0)) * (band.v1 - band.v0);
        const shade = col(type === 'armor' && d <= 2 ? c.L.paint.plate : c.L.paint.hull, tone);
        c.bk.get(band.m).quad([xa0, DECK, z0], [xa1, DECK, z0], [xb1, DECK, z1], [xb0, DECK, z1],
          [z0 / tile, vv(xa0)], [z0 / tile, vv(xa1)], [z1 / tile, vv(xb1)], [z1 / tile, vv(xb0)], shade, [0, 1, 0]);
      }
    }
  }
}

/* ---------------- section features ---------------- */
function paintQuad(c: Ctx, x0: number, z0: number, x1: number, z1: number, colr: THREE.Color, y = DECK + 0.03) {
  flat(c.bk, 'paint', x0, z0, x1, z1, y, colr, [[x0 / 30, z0 / 30], [x1 / 30, z0 / 30], [x1 / 30, z1 / 30], [x0 / 30, z1 / 30]]);
}
function hazardStrip(c: Ctx, x0: number, z0: number, x1: number, z1: number, y = DECK + 0.04) {
  const alongZ = z1 - z0 > x1 - x0, L = alongZ ? z1 - z0 : x1 - x0, wv = alongZ ? x1 - x0 : z1 - z0, u = L / (wv * 4);
  const mb = c.bk.get('hazard');
  if (alongZ) mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 0], [0, 1], [u, 1], [u, 0], c.L.paint.accent, [0, 1, 0]);
  else mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 0], [u, 0], [u, 1], [0, 1], c.L.paint.accent, [0, 1, 0]);
}
/** Forward-pointing chevron painted on deck. */
function chevron(c: Ctx, x: number, z: number, w: number, th: number, colr: THREE.Color) {
  const mb = c.bk.get('paint'), y = DECK + 0.035;
  for (const s of [-1, 1]) mb.quad([0 + x, y, z], [s * w + x, y, z + w * 0.7], [s * w + x, y, z + w * 0.7 + th], [0 + x, y, z + th], [0, 0], [1, 0], [1, 1], [0, 1], colr, [0, 1, 0]);
}
function digits(c: Ctx, text: string, x: number, z: number, s: number) {
  const w = 0.82 * s; let cx = x - ((text.length - 1) * w) / 2;
  for (const ch of text) { kit(c, `Decal_${ch}`, cx, DECK + 0.05, z, 0, s); cx += w; }
}
function mast(c: Ctx, x: number, y: number, z: number, h: number) {
  box(c.bk, B.rail, 0.7, h, 0.7, c.L.paint.dark, new THREE.Matrix4().makeTranslation(x, y + h / 2, z));
  box(c.bk, B.rail, 9, 0.4, 0.5, c.L.paint.dark, new THREE.Matrix4().makeTranslation(x, y + h * 0.7, z));
  box(c.bk, B.rail, 5, 0.35, 0.45, c.L.paint.dark, new THREE.Matrix4().makeTranslation(x, y + h * 0.88, z));
  for (const ax of [-3.5, -1.2, 1.4, 3.3]) box(c.bk, B.rail, 0.18, 4, 0.18, c.L.paint.dark, new THREE.Matrix4().makeTranslation(x + ax, y + h * 0.7 + 2, z));
  c.lights.add(x, y + h + 0.4, z, c.L.light.strobe, 3, 1.4, LMode.Strobe, c.rnd());
  c.lights.add(x - 4.5, y + h * 0.7, z, c.L.light.port, 2.2, 1.0, LMode.Beacon, 0.1);
  c.lights.add(x + 4.5, y + h * 0.7, z, c.L.light.star, 2.2, 1.0, LMode.Beacon, 0.6);
  dropShadow(c, x - 0.4, z - 0.4, x + 0.4, z + 0.4, DECK + 0.07, h * 0.6);
}
function radar(c: Ctx, x: number, y: number, z: number, r: number, speed: number) {
  const g = new THREE.Group(); g.position.set(x, y, z);
  const bk = new Buckets();
  box(bk, B.rail, 0.8, 1.6, 0.8, c.L.paint.dark, new THREE.Matrix4().makeTranslation(0, 0.8, 0));
  // Dish: shallow paraboloid facing sideways, on a yoke.
  const dm = new THREE.Matrix4().makeTranslation(0, 1.9, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - 0.35));
  lathe(bk, B.panels, [[0, 0], [r * 0.45, 0.12 * r], [r * 0.8, 0.32 * r], [r, 0.5 * r]], 12, c.L.paint.plate, dm);
  lathe(bk, B.rail, [[0, 0], [r * 0.12, 0], [r * 0.08, 0.9 * r], [0, 0.95 * r]], 6, c.L.paint.dark, dm);
  bk.meshes(c.L.mats, g, true);
  g.rotation.y = c.rnd() * Math.PI * 2;
  c.root.add(g); c.spin.push({ obj: g, speed });
  c.lights.add(x, y + 2.2 + r * 0.3, z, c.L.light.port, 1.6, 0.8, LMode.Beacon, c.rnd());
}
function fan(c: Ctx, x: number, z: number, s: number, y = DECK) {
  kit(c, 'Prop_Fan_Small', x, y + 0.25 * s, z, 0, s);
  const parts = kitParts('Prop_Fan_Small_Propeller'); if (!parts.length) return;
  // Only the big engine intakes spin (each spinner is its own draw call); small fans are merged, static.
  if (s < 2) { kit(c, 'Prop_Fan_Small_Propeller', x, y + 0.3 * s, z, c.rnd() * 6, s); return; }
  const g = new THREE.Group(); g.position.set(x, y + 0.3 * s, z); g.scale.setScalar(s);
  const bk = new Buckets(); for (const p of parts) bk.get(p.key).addGeometry(p.geo, p.m, kitCol(c, p.key));
  bk.meshes(c.L.mats, g, false); c.root.add(g); c.spin.push({ obj: g, speed: 7 + c.rnd() * 4 });
  c.vents.push([x, y + 1, z]);
}
function pipeRun(c: Ctx, x: number, y: number, z0: number, z1: number, r: number) {
  const m = new THREE.Matrix4().makeTranslation(x, y, z0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  lathe(c.bk, B.rail, [[r, 0], [r, z1 - z0]], 8, c.L.paint.dark, m);
  for (let z = z0 + 3; z < z1 - 1; z += 7) box(c.bk, B.ribs, r * 2 + 1, r * 2 + 0.6, 0.9, c.L.paint.hull, new THREE.Matrix4().makeTranslation(x, y, z));
}
function flood(c: Ctx, x: number, z: number, yaw: number) {
  kit(c, 'Prop_Light_Wide', x, DECK, z, yaw, 0.8);
  pool(c, x - Math.sign(x) * 3, z, 6, 5, DECK + 0.09, 0.6);
}

/** A round strut from a to b (tripod legs, yards, booms). */
function strut(c: Ctx, a: V3, b: V3, r: number, seg = 6) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length();
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...a), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1));
  lathe(c.bk, B.rail, [[r, 0], [r * 0.85, L]], seg, c.L.paint.dark, m, false, 1);
}
/** Plan rect of an obstacle in body space (hullObstacles works in field units). */
interface OBox { x0: number; x1: number; z0: number; z1: number }
const obox = (o: Obstacle, ik: number): OBox => ({ x0: (o.x - o.hw) * ik, x1: (o.x + o.hw) * ik, z0: (o.y - o.hl) * ik, z1: (o.y + o.hl) * ik });

/** Forecastle on the prow: breakwater, anchor gear, hull number and the jackstaff. */
function forecastle(c: Ctx, st: Station[], zA: number) {
  const P = c.L.paint, LL = c.L.light, zs = st[0].z, L = zA - zs;
  digits(c, String(10 + (c.sig % 89)).padStart(2, '0'), 0, zs + L * 0.55, 3.2);
  for (let k = 0; k < 3; k++) chevron(c, 0, zs + L * 0.3 + k * 1.6, 2.2, 0.55, col(P.deckLine, 0.9));
  // Breakwater: a low V across the deck that throws spray (here, slipstream) off the forward turrets.
  const zb = zA + 1, e = c.de(zb) - 1.5;
  for (const sx of [-1, 1]) {
    const a = new THREE.Vector3(0, 0, zb - 7), b = new THREE.Vector3(sx * e, 0, zb), d = b.clone().sub(a), len = d.length();
    box(c.bk, B.ribs, 0.5, 1.4, len, col(P.hull, 1.1), new THREE.Matrix4().makeTranslation((a.x + b.x) / 2, DECK + 0.7, (a.z + b.z) / 2).multiply(new THREE.Matrix4().makeRotationY(Math.atan2(d.x, d.z))));
    // Anchor gear: hawse pipe, chain run and the windlass.
    const hx = sx * (c.hw(zs + L * 0.45) - 2.5), hz = zs + L * 0.45;
    flatRect(c.bk, R.hatchRound, hx - 0.9, hz - 0.9, hx + 0.9, hz + 0.9, DECK + 0.05, P.plate);
    box(c.bk, B.rail, 0.5, 0.25, 9, P.dark, new THREE.Matrix4().makeTranslation(hx * 0.6, DECK + 0.12, hz + 5).multiply(new THREE.Matrix4().makeRotationY(-sx * 0.18)));
    lathe(c.bk, B.ribs, [[0, 0], [1.1, 0], [1.1, 0.9], [0.6, 1.1], [0, 1.1]], 10, P.hull, new THREE.Matrix4().makeTranslation(sx * 3, DECK, hz + 9.5));
    c.lights.add(sx * (c.hw(zs + L * 0.3) + 0.2), DECK - 2, zs + L * 0.3, LL.edge, 1.2, 0.3, LMode.Steady);
  }
  claim(c, -e, zb - 8, e, zb + 1);
  mastLite(c, 0, zs + 2.5, 7);
  c.lights.row([0, DECK + 0.1, zs + 3], [0, DECK + 0.1, zA - 2], 1.1, LL.deck, 1.3, 0.22, 1, LMode.Chase, c.rnd);
}
/** A slim jackstaff / ensign staff with a strobe. */
function mastLite(c: Ctx, x: number, z: number, h: number) {
  strut(c, [x, DECK, z], [x, DECK + h, z], 0.25);
  c.lights.add(x, DECK + h + 0.3, z, c.L.light.strobe, 2.4, 0.5, LMode.Strobe, c.rnd());
}

/**
 * Command bridge: a pagoda tower exactly where the rules put it (hullObstacles: it masks the guns behind
 * it), stepped in six tiers to a tripod foremast with the main director and a radar crown. The bridge gun
 * stands ahead of it.
 */
function bridgeSection(c: Ctx, r: HullRect, ob: OBox) {
  const P = c.L.paint, LL = c.L.light, A = (ob.x1 - ob.x0) / 2, za = ob.z0, zb = ob.z1, Lz = zb - za, D = DECK;
  // Citadel and the lower tiers fill the obstacle; the tower narrows and steps back as it climbs.
  tower(c, octagon(-A, za, A, zb, 4), D, D + 7, { side: B.darkPanel, top: B.brackets, win: [[D + 1.3, D + 3], [D + 4, D + 5.8]] });
  tower(c, octagon(-A * 0.8, za + Lz * 0.08, A * 0.8, zb - Lz * 0.06, 3.2), D + 7, D + 13, { side: B.panels, top: B.darkPanel, win: [[D + 8, D + 9.6], [D + 10.6, D + 12.2]], claim: false });
  // Navigating bridge: wide wings thrown out over the citadel, glazed all round.
  tower(c, octagon(-A * 1.08, za + Lz * 0.1, A * 1.08, za + Lz * 0.36, 2.4), D + 13, D + 16.5, { side: B.lightbar, top: B.panels, win: [[D + 13.7, D + 15.9]], claim: false, roof: false });
  tower(c, octagon(-A * 0.6, za + Lz * 0.14, A * 0.6, zb - Lz * 0.16, 2.6), D + 13, D + 20, { side: B.darkPanel, top: B.brackets, win: [[D + 17, D + 18.8]], claim: false });
  tower(c, octagon(-A * 0.44, za + Lz * 0.18, A * 0.44, zb - Lz * 0.3, 2), D + 20, D + 26, { side: B.panels, top: B.darkPanel, win: [[D + 21, D + 22.6], [D + 23.6, D + 25.2]], claim: false });
  // Spotting top high on the foremast.
  const zt = za + Lz * 0.32, top = D + 38;
  tower(c, octagon(-A * 0.34, zt - 4, A * 0.34, zt + 4.5, 1.6), D + 33, top, { side: B.ribs, top: B.darkPanel, win: [[D + 34, D + 36.4]], claim: false, roof: false });
  // Tripod: a main leg through the tiers and two raked legs from the citadel roof aft.
  strut(c, [0, D + 26, zt], [0, top, zt], 1.1, 8);
  for (const sx of [-1, 1]) strut(c, [sx * A * 0.55, D + 20, zb - Lz * 0.22], [sx * 0.8, D + 33, zt + 1.5], 0.7);
  // Main director: a rangefinder hood with long arms, trained forward.
  box(c.bk, B.darkPanel, 4.5, 2.2, 4, col(P.hull, 1.1), new THREE.Matrix4().makeTranslation(0, top + 1.1, zt - 0.5));
  box(c.bk, B.rail, A * 0.95, 0.7, 0.9, P.dark, new THREE.Matrix4().makeTranslation(0, top + 1.4, zt + 0.5));
  mast(c, 0, top + 2.2, zt + 1.2, 12);
  // Wing-tip lights and searchlights.
  c.lights.add(-A * 1.08 - 0.5, D + 15.5, za + Lz * 0.23, LL.port, 2.4, 1.1, LMode.Beacon, 0.2);
  c.lights.add(A * 1.08 + 0.5, D + 15.5, za + Lz * 0.23, LL.star, 2.4, 1.1, LMode.Beacon, 0.7);
  for (const sx of [-1, 1]) c.lights.add(sx * A * 0.36, D + 26.4, za + Lz * 0.2, LL.deck, 2.2, 0.6, LMode.Steady);
  radar(c, -A * 0.3, D + 26, zb - Lz * 0.38, 2.6, 1.1);
  radar(c, A * 0.5, D + 20, zb - Lz * 0.25, 1.7, -1.9);
  for (let k = 0; k < 5; k++) antenna(c, (c.rnd() * 2 - 1) * A * 0.3, D + 26, za + Lz * (0.3 + c.rnd() * 0.2), 2 + c.rnd() * 4, c.rnd);
  for (let k = 0; k < 3; k++) dish(c, (c.rnd() * 2 - 1) * A * 0.5, D + 20, za + Lz * (0.2 + c.rnd() * 0.45), 0.6 + c.rnd() * 0.6, c.rnd);
  // Boat deck aft of the tower: launches in their cradles either side.
  for (const sx of [-1, 1]) for (const dz of [2.5, 7.5]) {
    const z = zb + dz, x = sx * (c.de(z) - 4); if (z > r.y + r.h - 3) continue;
    lathe(c.bk, B.panels, [[0, -2], [0.9, -1.4], [1.1, 0], [0.9, 1.6], [0, 2.1]], 8, col(P.plate, 0.9), new THREE.Matrix4().makeTranslation(x, DECK + 1.1, z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    claim(c, x - 1.4, z - 2.4, x + 1.4, z + 2.4);
  }
  c.dmg.push([-A * 0.5, D + 13.1, zb - 4], [A * 0.8, D + 7.1, za + 3], [-A * 0.8, D + 7.1, zb - 3], [A * 0.3, D + 26.1, za + Lz * 0.5]);
}

/** Gun Deck: two centreline turrets fore and aft (the hull holds their barbettes), a low deckhouse between. */
function gundeckSection(c: Ctx, r: HullRect) {
  const z0 = r.y, z1 = r.y + r.h, zc = (z0 + z1) / 2, P = c.L.paint, hx = Math.min(c.de(zc) * 0.42, 9);
  tower(c, octagon(-hx, zc - 6.5, hx, zc + 6.5, 2), DECK, DECK + 3.4, { side: B.darkPanel, top: B.doors, win: [[DECK + 1, DECK + 2.6]], roof: false });
  kit(c, 'Prop_Vent_Big', -hx * 0.45, DECK + 3.45, zc, Math.PI / 2, 1.2); kit(c, 'Prop_Vent_Big', hx * 0.45, DECK + 3.45, zc, Math.PI / 2, 1.2);
  for (const sx of [-1, 1]) {
    // Ventilator cowls and ready-use lockers along the waist.
    for (const dz of [-4, 4]) lathe(c.bk, B.ribs, [[0, 0], [0.7, 0], [0.7, 1.8], [1.1, 2.3], [0.9, 2.6]], 8, P.hull, new THREE.Matrix4().makeTranslation(sx * (hx + 3), DECK, zc + dz));
    hazardStrip(c, sx * hx - 0.3, zc - 7, sx * hx + 0.3, zc + 7);
  }
  claim(c, -hx - 4.5, zc - 7, hx + 4.5, zc + 7);
  c.dmg.push([-hx * 1.5, DECK + 0.4, zc], [hx * 1.5, DECK + 0.4, zc + 5], [0, DECK + 3.5, zc]);
}

/**
 * Broadside Battery: an armoured casemate sponson each side, where the rules put it (it masks the
 * neighbouring sponsons): a deckhouse inboard and a bulge standing out of the hull side over the belt.
 */
function batterySection(c: Ctx, r: HullRect, obs: OBox[]) {
  const P = c.L.paint, LL = c.L.light, top = DECK + SPON_H;
  for (const o of obs) {
    const sd = o.x0 + o.x1 > 0 ? 1 : -1, xi = sd > 0 ? o.x0 : o.x1, xo = sd > 0 ? o.x1 : o.x0, za = o.z0, zb = o.z1;
    const x0 = Math.min(xi, xo), x1 = Math.max(xi, xo);
    tower(c, octagon(x0, za, x1, zb, 5), DECK - 9, top, { side: B.darkPanel, top: B.brackets, col: col(P.hull, 0.8), bevel: 1.6, taper: 0.8, win: [[DECK + 1, DECK + 2.6]], roof: false, shadow: false });
    dropShadow(c, x0, za, x1, zb, DECK + 0.06, SPON_H);
    // Sloped skirt under the bulge, back into the belt.
    const hwz = (z: number) => c.hw(z) * 0.92, mb = c.bk.get('t1'), yb = DECK - 9;
    for (let z = za + 5; z < zb - 5 - 0.01; z += 4) {
      const zz = Math.min(zb - 5, z + 4);
      mb.quad([xo, yb, z], [xo, yb, zz], [sd * hwz(zz), DECK - 14, zz], [sd * hwz(z), DECK - 14, z], [z / 8, B.darkPanel.v0], [zz / 8, B.darkPanel.v0], [zz / 8, B.darkPanel.v1], [z / 8, B.darkPanel.v1], col(P.hull, 0.5), [sd, -1, 0]);
    }
    // Casemate ports (lit) along the outboard wall, two decks of them.
    for (const yy of [DECK - 4, DECK - 6.5]) c.lights.row([xo + sd * 0.1, yy, za + 5], [xo + sd * 0.1, yy, zb - 5], 0.6, LL.window, 0.95, 0.22, 0.65, LMode.Steady, c.rnd);
    hazardStrip(c, sd > 0 ? xo - 1.1 : xo + 0.5, za + 5, sd > 0 ? xo - 0.5 : xo + 1.1, zb - 5, top + 0.04);
    // Inboard citadel: an armoured house standing behind the casemate guns, stepped up from the gun deck.
    const xm = xi + (xo - xi) * 0.5, hx0 = Math.min(xi, xm), hx1 = Math.max(xi, xm);
    tower(c, octagon(hx0, za + 3, hx1, zb - 3, 3), top, top + 4.2, { side: B.panels, top: B.darkPanel, col: col(P.hull, 0.9), taper: 0.5, win: [[top + 1, top + 2.6]], claim: false });
    flatRect(c.bk, R.hatchCross, (xm + xo) / 2 - 1.2, za + 4, (xm + xo) / 2 + 1.2, za + 6.4, top + 0.05, P.hull);
    box(c.bk, B.rail, 0.8, 0.8, 6, P.dark, new THREE.Matrix4().makeTranslation(xm + sd * 1.2, top + 0.5, (za + zb) / 2 - 6));
    c.belt.push([sd, za, zb]);
    c.dmg.push([(xi + xo) / 2, top + 0.1, (za + zb) / 2], [xo, DECK - 3, (za + zb) / 2 + 6]);
  }
}

function armorSection(c: Ctx, r: HullRect) {
  const W = r.w, z0 = r.y, z1 = r.y + r.h, zc = (z0 + z1) / 2, P = c.L.paint, LL = c.L.light;
  // Flight deck: edge lines, dashed centreline, threshold bars and chase lights.
  const lx = W * 0.2, line = col(P.deckLine, 0.85);
  for (const sx of [-1, 1]) {
    paintQuad(c, sx * lx - 0.35, z0 + 1.5, sx * lx + 0.35, z1 - 1.5, line);
    c.lights.row([sx * (lx + 1.3), DECK + 0.15, z0 + 2], [sx * (lx + 1.3), DECK + 0.15, z1 - 2], 3, LL.deck, 1.5, 0.8, 1, LMode.Chase, c.rnd);
    for (let k = 0; k < 4; k++) paintQuad(c, sx * (lx - 2 - k * 1.6) - 0.5, z0 + 2, sx * (lx - 2 - k * 1.6) + 0.5, z0 + 7, line);
  }
  for (let z = z0 + 9; z < z1 - 4; z += 5.5) if (Math.abs(z - zc) > 10) paintQuad(c, -0.3, z, 0.3, z + 3, line);
  // Deck elevators: lit wells with hazard borders.
  for (const sx of [-1, 1]) {
    const ex = sx * W * 0.34, x0 = ex - 3, x1 = ex + 3, ez0 = zc - 3.4, ez1 = zc + 3.4;
    if (!onDeck(c, x0, ez0, x1, ez1, 0.5)) continue;
    c.bk.get('black').quad([x0, DECK + 0.02, ez0], [x1, DECK + 0.02, ez0], [x1, DECK + 0.02, ez1], [x0, DECK + 0.02, ez1], [0, 0], [1, 0], [1, 1], [0, 1], P.dark, [0, 1, 0]);
    flatRect(c.bk, R.hatchCross, x0 + 0.5, ez0 + 0.5, x1 - 0.5, ez1 - 0.5, DECK + 0.05, P.plate);
    hazardStrip(c, x0, ez0 - 0.35, x1, ez0); hazardStrip(c, x0, ez1, x1, ez1 + 0.35);
    for (const [px, pz] of [[x0, ez0], [x1, ez0], [x0, ez1], [x1, ez1]]) c.lights.add(px, DECK + 0.2, pz, LL.port, 1.6, 0.22, LMode.Beacon, c.rnd());
    claim(c, x0 - 0.5, ez0 - 0.8, x1 + 0.5, ez1 + 0.8);
  }
  // Armour strakes bolted along the belt.
  for (const sx of [-1, 1]) for (let z = z0 + 1; z < z1 - 2; z += 9.5) {
    const hz = c.hw(z + 4.3), xa = sx * (hz - 0.6), xb = sx * (hz + 1.8);
    block(c.bk, octagon(Math.min(xa, xb), z, Math.max(xa, xb), z + 8.6, 0.8), DECK - 7.2, DECK - 1.6, { side: B.panels, top: B.ribs, col: col(P.hull, 0.9), bevel: 0.6 });
  }
  c.dmg.push([-W * 0.25, DECK + 0.4, zc - 6], [W * 0.22, DECK + 0.4, zc + 8], [0, DECK + 0.4, z0 + 6]);
}

function spineSection(c: Ctx, r: HullRect) {
  const W = r.w, z0 = r.y, z1 = r.y + r.h, zc = (z0 + z1) / 2, P = c.L.paint;
  // Central trunk of pipes and cable trays.
  claim(c, -6, z0, 6, z1);
  for (const [px, pr] of [[-3.6, 1.2], [0, 1.6], [3.6, 1.2]] as [number, number][]) pipeRun(c, px, DECK + pr + 0.2, z0 - 0.5, z1 + 0.5, pr);
  dropShadow(c, -5, z0, 5, z1, DECK + 0.06, 2.4);
  // Radiator fields fore and aft of the module mounts: a grid of small fin banks (each a couple of units,
  // dim glowing roots) with gaps the deck machinery fills, not one big glowing slab.
  for (const sx of [-1, 1]) for (const [za, zb] of [[z0 + 2, zc - 10], [zc + 10, z1 - 2]]) {
    if (zb - za < 4) continue;
    const xa = sx * (W * 0.12), xb = sx * (W * 0.38), x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), cw = 2.6, cd = 2.3;
    for (let z = za; z + cd <= zb + 0.01; z += cd + 0.5) for (let x = x0; x + cw <= x1 + 0.01; x += cw + 0.5) {
      if (c.rnd() < 0.3 || !onDeck(c, x, z, x + cw, z + cd, 0.8)) continue;
      const h = 0.5 + c.rnd() * 0.5;
      heatsink(c, x, z, x + cw, z + cd, DECK, h);
      dropShadow(c, x + 0.6, z + 0.6, x + cw - 0.6, z + cd - 0.6, DECK + 0.06, h * 0.6); claim(c, x, z, x + cw, z + cd);
    }
    c.dmg.push([(x0 + x1) / 2, DECK + 1.2, (za + zb) / 2]);
  }
}

/**
 * Engine Block: a raked funnel on its casing exactly where the rules put it (it masks the guns behind it),
 * and a drive nacelle low on each flank, over the belt, exhausting aft.
 */
function engineSection(c: Ctx, r: HullRect, ob: OBox, last: boolean) {
  const z0 = r.y, z1 = r.y + r.h, P = c.L.paint, LL = c.L.light;
  const cx = (ob.x0 + ob.x1) / 2, cz = (ob.z0 + ob.z1) / 2, hx = (ob.x1 - ob.x0) / 2, hz = (ob.z1 - ob.z0) / 2;
  // Uptake casing filling the obstacle, then the funnel: an oval stack raked aft, with a cap band.
  tower(c, octagon(cx - hx, cz - hz, cx + hx, cz + hz, 3.5), DECK, DECK + 5, { side: B.darkPanel, top: B.brackets, win: [[DECK + 1.2, DECK + 3]], roof: false });
  const H = 24, rake = 0.32, rx = hx * 0.7, rz = hz * 0.78, y0 = DECK + 5;
  const m = new THREE.Matrix4().set(rx, 0, 0, cx, 0, 1, 0, y0, 0, rake, rz, cz - 1.5, 0, 0, 0, 1);
  lathe(c.bk, B.panels, [[1.08, 0], [1, 0.6], [0.94, H * 0.86]], 16, col(P.hull, 1.5), m, false, 3);
  lathe(c.bk, B.hazard, [[0.95, H * 0.78], [0.945, H * 0.82]], 16, col(P.accent, 0.6), m, false, 6);
  lathe(c.bk, B.ribs, [[0.94, H * 0.86], [1.0, H * 0.88], [1.0, H], [0.9, H]], 16, P.dark, m, false, 4);
  lathe(c.bk, { m: 'black', v0: 0, v1: 1 }, [[0.9, H], [0.85, H - 1.5], [0, H - 1.5]], 16, P.dark, m);
  // Steam pipes up the after face, a searchlight platform round the stack.
  for (const sx of [-0.35, 0.35]) strut(c, [cx + sx * rx, y0, cz + rz * 0.95 - 1.5], [cx + sx * rx, y0 + H * 0.95, cz + rz * 0.95 - 1.5 + rake * H * 0.95], 0.45);
  lathe(c.bk, B.ribs, [[1.25, 0], [1.25, 0.5], [0.98, 0.5]], 16, P.dark, new THREE.Matrix4().set(rx, 0, 0, cx, 0, 1, 0, y0 + H * 0.45, 0, rake, rz, cz - 1.5 + rake * H * 0.45, 0, 0, 0, 1));
  for (const sx of [-1, 1]) c.lights.add(cx + sx * rx * 1.2, y0 + H * 0.45 + 0.7, cz - 1.5 + rake * H * 0.45, LL.deck, 2, 0.5, LMode.Steady);
  c.lights.add(cx, y0 + H + 0.6, cz - 1.5 + rake * H, LL.port, 2.2, 0.9, LMode.Beacon, c.rnd());
  dropShadow(c, cx - rx, cz - rz, cx + rx, cz + rz + 4, DECK + 5.06, H * 0.7);
  c.vents.push([cx, y0 + H, cz - 1.5 + rake * H], [cx, y0 + H, cz + rake * H]);
  c.dmg.push([cx, DECK + 5.1, cz + hz - 1], [cx - hx * 0.7, DECK + 5.1, cz]);
  // Flank drive nacelles over the belt.
  const rad = 4.2, yc = DECK - 9.5, za = z0 + 5, zb = last ? z1 + 4 : z1 - 3;
  for (const sx of [-1, 1]) {
    const x = sx * (Math.min(c.hw(za), c.hw(zb - 6)) + rad * 0.45);
    const mm = new THREE.Matrix4().makeTranslation(x, yc, za).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    lathe(c.bk, B.panels, [[0, -1], [rad * 0.6, 0], [rad, 3], [rad, zb - za - 6], [rad * 0.92, zb - za - 3]], 14, col(P.hull, 1.15), mm, false, 3);
    for (let zz = 5; zz < zb - za - 6; zz += 4.5) lathe(c.bk, B.ribs, [[rad * 1.04, zz], [rad * 1.04, zz + 1.1]], 14, P.dark, mm, false, 4);
    const mb = new THREE.Matrix4().makeTranslation(x, yc, zb - 3).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    lathe(c.bk, B.ribs, [[rad * 0.92, 0], [rad * 0.85, 1.2], [rad * 0.95, 3.5], [rad * 1.1, 6], [rad, 6.1]], 14, P.dark, mb);
    lathe(c.bk, { m: 'black', v0: 0, v1: 1 }, [[rad * 0.98, 6.05], [rad * 0.8, 3], [rad * 0.7, 1.5]], 14, P.dark, mb);
    lathe(c.bk, { m: 'core', v0: 0, v1: 1 }, [[rad * 0.7, 1.5], [0, 1.8]], 14, P.full, mb);
    c.nozzles.push({ x, y: yc, z: zb + 3, r: rad * 0.85, main: true });
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; c.lights.add(x + Math.cos(a) * rad * 1.15, yc + Math.sin(a) * rad * 1.15, zb + 3.2, LL.engine, 1.4, 0.3, LMode.Flicker, c.rnd()); }
    c.belt.push([sx, za - 1, zb]);
    c.dmg.push([x, yc + rad, (za + zb) / 2]);
  }
}

/** Main drives in the transom: two to four bells by how many engine blocks the hull carries. */
function sternDrives(c: Ctx, s: Station, engines: number) {
  const P = c.L.paint, LL = c.L.light, n = Math.min(4, 2 + Math.floor(engines / 2)), rad = Math.min(6.5, (s.hw * 1.5) / n) * (engines ? 1 : 0.75), y = DECK - 8;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * ((s.hw * 1.5) / n), mb = new THREE.Matrix4().makeTranslation(x, y, s.z - 2).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    lathe(c.bk, B.ribs, [[rad * 1.1, 0], [rad, 1.5], [rad * 1.06, 4.5], [rad * 1.22, 7.5], [rad * 1.12, 7.6]], 16, P.dark, mb);
    lathe(c.bk, { m: 'black', v0: 0, v1: 1 }, [[rad * 1.1, 7.55], [rad * 0.9, 4], [rad * 0.8, 2]], 16, P.dark, mb);
    lathe(c.bk, { m: 'core', v0: 0, v1: 1 }, [[rad * 0.8, 2], [rad * 0.5, 2.2], [0, 2.4]], 16, P.full, mb);
    lathe(c.bk, { m: 'glow', v0: 0, v1: 1 }, [[rad * 0.3, 2.45], [0, 2.5]], 10, P.full, mb);
    c.nozzles.push({ x, y, z: s.z + 8, r: rad, main: true });
    for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; c.lights.add(x + Math.cos(a) * rad * 1.25, y + Math.sin(a) * rad * 1.25, s.z + 5.8, LL.engine, 1.4, 0.3, LMode.Flicker, c.rnd()); }
  }
  // Manoeuvring thrusters at the quarters.
  for (const sx of [-1, 1]) {
    const x = sx * (s.hw - 1.2), zz = s.z - 4;
    c.bk.get('core').quad([x - 0.9, DECK - 3.5, zz - 1.3], [x + 0.9, DECK - 3.5, zz - 1.3], [x + 0.9, DECK - 3.5, zz + 1.3], [x - 0.9, DECK - 3.5, zz + 1.3], [0, 0], [1, 0], [1, 1], [0, 1], col(P.full, 0.3), [sx, 0, 0]);
    c.nozzles.push({ x: x + sx * 1.5, y: DECK - 3.5, z: zz, r: 1.4, main: false });
  }
}

/* ---------------- medium equipment ---------------- */
/** Medium-scale kit equipment (vents, fans, tanks, deck houses) and edge floodlights for one section. */
function equipment(c: Ctx, r: HullRect, rnd: Rng) {
  const P = c.L.paint;
  const items: { w: number; d: number; f: (x: number, z: number) => void }[] = [
    { w: 2.4, d: 1.4, f: (x, z) => kit(c, 'Prop_Vent_Big', x, DECK + 0.02, z, 0, 1.1) },
    { w: 1.4, d: 2.6, f: (x, z) => kit(c, 'Prop_Vent_Big', x, DECK + 0.02, z, Math.PI / 2, 1.1) },
    { w: 1.4, d: 1.0, f: (x, z) => kit(c, 'Prop_Vent_Small', x, DECK + 0.02, z, 0, 1.1) },
    { w: 2.6, d: 0.7, f: (x, z) => kit(c, 'Prop_Vent_Wide', x, DECK + 0.02, z, 0, 1.2) },
    { w: 3.0, d: 3.0, f: (x, z) => { fan(c, x, z, 1.2); } },
    { w: 1.8, d: 3.6, f: (x, z) => {
      for (const dx of [-0.45, 0.45]) kit(c, 'Prop_Barrel_Large', x + dx, DECK + 0.42, z + 1.5, 0, 1.6, new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      dropShadow(c, x - 0.9, z - 1.7, x + 0.9, z + 1.7, DECK + 0.06, 0.9);
    } },
    { w: 3.2, d: 2.4, f: (x, z) => {
      // Small deck house with lit windows.
      tower(c, octagon(x - 1.6, z - 1.2, x + 1.6, z + 1.2, 0.4), DECK, DECK + 1.3, { side: B.darkPanel, top: B.brackets, bevel: 0.15, taper: 0.08, win: [[DECK + 0.45, DECK + 0.95]], edgeLights: false, roof: false, claim: false });
    } },
  ];
  const area = r.w * r.h, tries = Math.round(area / 70);
  for (let i = 0; i < tries; i++) {
    const it = items[Math.floor(rnd() * items.length)];
    const x = (rnd() * 2 - 1) * (r.w / 2), z = r.y + 2 + rnd() * (r.h - 4);
    const x0 = x - it.w / 2, x1 = x + it.w / 2, z0 = z - it.d / 2, z1 = z + it.d / 2;
    if (!onDeck(c, x0, z0, x1, z1, 1.5) || occupied(c, x0, z0, x1, z1, 0.8)) continue;
    it.f(x, z); claim(c, x0, z0, x1, z1);
  }
  // Deck floodlights in pairs along the deck edges.
  for (let z = r.y + 5; z < r.y + r.h - 3; z += 11) for (const sx of [-1, 1]) {
    const x = sx * (c.de(z) - 1.2);
    if (!occupied(c, x - 0.8, z - 0.6, x + 0.8, z + 0.6, 0.2) && onDeck(c, x - 0.8, z - 0.6, x + 0.8, z + 0.6, -0.6)) { flood(c, x, z, sx > 0 ? Math.PI / 2 : -Math.PI / 2); claim(c, x - 0.8, z - 0.6, x + 0.8, z + 0.6); }
  }
}

/** Navigation lights: red to port, green to starboard at the beam, white at bow and stern, strobes on top. */
function navLights(c: Ctx, st: { z: number; hw: number }[]) {
  const LL = c.L.light; let wide = st[0];
  for (const s of st) if (s.hw > wide.hw) wide = s;
  const zs = [wide.z, (st[0].z + wide.z) / 2];
  for (const z of zs) {
    const hw = c.hw(z);
    c.lights.add(-hw - 0.3, DECK - 2.2, z, LL.navPort, 2.0, 0.35, LMode.Steady);
    c.lights.add(hw + 0.3, DECK - 2.2, z, LL.navStar, 2.0, 0.35, LMode.Steady);
  }
  const zs0 = st[0].z, zs1 = st[st.length - 1].z;
  c.lights.add(0, DECK + 0.4, zs0 + 0.3, LL.strobe, 1.6, 0.35, LMode.Steady);
  c.lights.add(0, DECK + 0.3, zs1 + 0.4, LL.strobe, 1.6, 0.35, LMode.Steady);
  for (const sx of [-1, 1]) c.lights.add(sx * (c.hw(zs1 - 2) - 0.5), DECK + 0.4, zs1 - 1, LL.strobe, 3, 0.45, LMode.Strobe, sx > 0 ? 0.5 : 0);
}

/** Sheer: the forecastle rises toward the stem (everything ahead of the first section is bent up, lights too). */
function sheer(c: Ctx, zA: number, zs: number) {
  const lift = (z: number) => (z < zA ? 4.5 * Math.pow((zA - z) / (zA - zs), 1.8) : 0);
  const bend = (p: number[]) => { for (let i = 0; i < p.length; i += 3) if (p[i + 2] < zA) p[i + 1] += lift(p[i + 2]); };
  for (const mb of c.bk.b.values()) bend(mb.p);
  bend(c.lights.p);
}

/* ---------------- build ---------------- */
export function buildShip(dv: Derived, L: Livery, sigText: string, callsign = ''): ShipModel {
  // Build at the reference ship scale so every detail keeps its proportion to the hull, then scale the body.
  const k = SHIP_SCALE / REF_SCALE, ik = 1 / k;
  const rects: HullRect[] = dv.rects.map((r) => ({ ...r, x: r.x * ik, y: r.y * ik, w: r.w * ik, h: r.h * ik }));
  const mounts: Mount[] = dv.mounts.map((m) => ({ ...m, ox: m.ox * ik, oy: m.oy * ik }));
  const sig = hash(sigText), st = stations(rects), hw = hwFn(st);
  const root = new THREE.Group(); root.name = L.hostile ? 'ghost-dreadnought' : 'dreadnought';
  const body = new THREE.Group(); body.scale.setScalar(k); root.add(body);
  const c: Ctx = {
    bk: new Buckets(), L, lights: new LightSet(), rnd: mulberry32(sig), occ: [], dmg: [], vents: [], spin: [], nozzles: [], root: body, turrets: [],
    hw, de: (z: number) => terrace(hw(z)), z0: st[0].z, z1: st[st.length - 1].z, edgeSegs: [], sig, belt: [],
  };
  // Each section draws from its own seeded stream: type, position and the parts it carries.
  const secRng = (i: number, salt = 0) => mulberry32(hash(`${i}|${rects[i].type}|${mounts.filter((m) => m.si === i).map((m) => m.part ? m.part.id + m.part.tier : '-').join(',')}|${salt}`));
  const maxHw = Math.max(...st.map((s) => s.hw));
  // What blocks fire in the rules is what stands tallest in the model: towers, funnels, sponsons.
  const obs = drawnObstacles(dv.obstacles).map((o) => ({ o, b: obox(o, ik) }));
  const obOf = (si: number) => obs.filter((q) => q.o.si === si).map((q) => q.b);
  const towerZ = obs.find((q) => q.o.by === 'bridge')?.b, tz = towerZ ? (towerZ.z0 + towerZ.z1) / 2 : 0;
  // Utility bays of an engine block sit aft of its funnel.
  const utilAt = (m: Mount): [number, number] => { const r = rects[m.si]; return [m.ox, r.type === 'engine' ? r.y + r.h * 0.81 : m.oy]; };
  // Weapon mounts first: their barbettes, casemates and sponsons claim deck before anything else.
  const rig = new GunRig();
  for (const m of mounts) {
    const p = m.part, r = rects[m.si];
    if (!p || !has(WEAPONS, p.id)) { const [ux, uz] = utilAt(m), zn = utilZone(r.type, ux, uz); claim(c, zn[0], zn[1], zn[2], zn[3]); continue; }
    const trav = mountTraverse(m, r.type), h = hw(m.oy);
    // Superfiring: of a Gun Deck's two turrets the one nearer the tower stands higher; a battery's centre turret fires over its casemates.
    const mate = mounts.find((q) => q.si === m.si && q !== m && r.type === 'gundeck');
    const lift = r.type === 'battery' ? (Math.abs(m.ox) < 1 ? SPON_H + 5.5 : 0) : r.type === 'bridge' ? 3.2 : mate && Math.abs(m.oy - tz) < Math.abs(mate.oy - tz) ? 6 : 1.6;
    const sb = r.type === 'battery' && Math.abs(m.ox) >= 1 ? obOf(m.si).find((b) => Math.sign(b.x0 + b.x1) === Math.sign(m.ox)) : undefined;
    const sponson = sb ? { outer: Math.max(Math.abs(sb.x0), Math.abs(sb.x1)), top: DECK + SPON_H, z0: sb.z0, z1: sb.z1 } : undefined;
    const { t, claim: cl } = buildMount({ uid: p.uid, id: p.id, tier: p.tier, x: m.ox, z: m.oy, deck: sponson ? sponson.top : DECK, trav, hw: h, terrace: terrace(h), gallery: DECK - 2.4, lift, sponson }, rig, c.bk, L, c.lights);
    c.turrets.push(t); claim(c, cl[0], cl[1], cl[2], cl[3]);
  }
  hull(c, st);
  deck(c, st, rects, maxHw);
  navLights(c, st);
  c.rnd = mulberry32(sig ^ 0x2c1b3c6d);
  forecastle(c, st, rects[0].y);
  sternDrives(c, st[st.length - 1], rects.filter((r) => r.type === 'engine').length);
  rects.forEach((r, i) => {
    c.rnd = secRng(i);
    const ob = obOf(i);
    switch (r.type) {
      case 'bridge': bridgeSection(c, r, ob[0]); break;
      case 'gundeck': gundeckSection(c, r); break;
      case 'battery': batterySection(c, r, ob); break;
      case 'armor': armorSection(c, r); break;
      case 'spine': spineSection(c, r); break;
      case 'engine': engineSection(c, r, ob[0], i === rects.length - 1); break;
    }
    // Section seams: a raised rib across the deck, a line of lights and a stencilled frame number.
    if (i > 0) {
      const z = r.y, e = Math.min(c.de(z - 0.5), c.de(z + 0.5)) - 0.2;
      box(c.bk, B.ribs, 2 * e, 0.35, 0.7, col(L.paint.hull, 0.8), new THREE.Matrix4().makeTranslation(0, DECK + 0.17, z));
      c.lights.row([-e + 1, DECK + 0.45, z], [e - 1, DECK + 0.45, z], 1.2, L.light.edge, 0.9, 0.2, 0.7, LMode.Steady, c.rnd);
      const fx = e - 4;
      if (!occupied(c, fx - 2, z + 0.6, fx + 2, z + 2, 0)) { stencilText(c, `FR ${String(i * 40 + 12).padStart(3, '0')}`, fx, z + 1.3, 0.8); claim(c, fx - 2, z + 0.6, fx + 2, z + 2); }
    }
  });
  // Callsign stencilled across the aft deck, and again small on the bow.
  const cs = (callsign || (L.hostile ? 'UNKNOWN' : 'DREADNOUGHT')).toUpperCase().replace(/[^A-Z0-9 .\-]/g, '').slice(0, 14);
  {
    const last = rects[rects.length - 1], zz = last.y + last.h - 8, w = cs.length * 1.4 * 0.72;
    if (!occupied(c, -w / 2, zz - 1, w / 2, zz + 1, 0)) { stencilText(c, cs, 0, zz, 1.4); claim(c, -w / 2, zz - 1, w / 2, zz + 1); }
    stencilText(c, cs, 0, st[0].z + (rects[0].y - st[0].z) * 0.82, 0.7);
  }
  // Utility modules: small installations bedded into the deck (utilities.ts), seeded per section and slot.
  for (const m of mounts) {
    const p = m.part; if (p && has(WEAPONS, p.id)) continue;
    const r = rects[m.si], [ux, uz] = utilAt(m);
    utilityModule(c, secRng(m.si, 10 + m.i), { id: p?.id ?? '', tier: p?.tier ?? 1, x: ux, z: uz, zone: utilZone(r.type, ux, uz), za: r.y, zb: r.y + r.h });
  }
  // Medium equipment, then the dense small layer, section by section; hull-side detail last.
  rects.forEach((r, i) => {
    const rnd = secRng(i, 1);
    equipment(c, r, rnd);
    deckGreebles(c, rnd, r.y, r.y + r.h, r.type);
    beltGreebles(c, rnd, r.y, r.y + r.h, r.type, DECK);
  });
  // Fill damage points so fires can break out anywhere on the hull.
  c.rnd = mulberry32(sig ^ 0x5bd1e995);
  for (let i = 0; i < 26; i++) { const z = c.z0 + 8 + c.rnd() * (c.z1 - c.z0 - 14), w = c.de(z) - 4; c.dmg.push([(c.rnd() * 2 - 1) * w, DECK + 0.4, z]); }

  sheer(c, rects[0].y, st[0].z);
  c.bk.meshes(L.mats, body, true);
  const gunTris = rig.build(L, body);
  const lights = c.lights.points(lightMaterial(L.hostile)); body.add(lights);
  // Scorch decals: hidden until the hull is hurt (draw range grows with damage).
  const sb = new Buckets(), dm = sb.get('scorch');
  for (const p of c.dmg) { const r = 3 + c.rnd() * 5, a = c.rnd() * Math.PI; const ca = Math.cos(a) * r, sa = Math.sin(a) * r; const y = p[1] + 0.12;
    dm.quad([p[0] - ca + sa, y, p[2] - sa - ca], [p[0] + ca + sa, y, p[2] + sa - ca], [p[0] + ca - sa, y, p[2] + sa + ca], [p[0] - ca - sa, y, p[2] - sa + ca], [0, 0], [1, 0], [1, 1], [0, 1], L.paint.hull, [0, 1, 0]); }
  const scorch = sb.meshes(L.mats, body, false)[0];
  scorch.geometry.setDrawRange(0, 0);
  let edges: THREE.LineSegments | null = null;
  if (L.hostile && c.edgeSegs.length) {
    // The hostile identification: a hairline rim, not a neon outline. The hull silhouette carries it at
    // full strength, superstructure roof edges at a third; the layer breathes the opacity slowly. It stays
    // well under the bloom threshold, so it never thickens into a glow.
    const pos: number[] = [], cl: number[] = [];
    for (const g of c.edgeSegs) {
      const a = g.getAttribute('position'), w = g.userData.k ?? 0.35;
      for (let i = 0; i < a.count; i++) { pos.push(a.getX(i), a.getY(i) + 0.05, a.getZ(i)); cl.push(w, w, w); }
      g.dispose();
    }
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); eg.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
    const em = new THREE.LineBasicMaterial({ color: '#ff4636', vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }); em.color.multiplyScalar(0.9); em.toneMapped = false;
    edges = new THREE.LineSegments(eg, em); edges.userData.own = true; body.add(edges);
  } else for (const g of c.edgeSegs) g.dispose();
  let tris = 0; body.traverse((o) => { const g = (o as THREE.Mesh).geometry; if ((o as THREE.Mesh).isMesh && g) tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3; });
  void gunTris;
  // Layer-facing data lives in root space (body space x k).
  const toRoot = (p: V3): V3 => [p[0] * k, p[1] * k, p[2] * k];
  return {
    root, body, k, turrets: c.turrets, rig,
    nozzles: c.nozzles.map((n) => ({ ...n, x: n.x * k, y: n.y * k, z: n.z * k, r: n.r * k })),
    dmgPts: c.dmg.map(toRoot), vents: c.vents.map(toRoot), spinners: c.spin, lights, edges, scorch, len: dv.len, width: dv.width, hostile: L.hostile, tris,
  };
}

/** Stencilled deck lettering (callsign, frame numbers). */
function stencilText(c: Ctx, text: string, x: number, z: number, h: number) {
  const tx = c.L.mats.stencil as THREE.MeshStandardMaterial, ud = tx.alphaMap?.userData as { cols: number; rows: number } | undefined;
  stencil(c.bk, text, x, z, DECK + 0.05, h, c.L.paint.full, STENCIL_CHARS, ud?.cols ?? 8, ud?.rows ?? 5);
}

export function disposeShip(m: ShipModel) {
  m.root.traverse((o) => {
    if (!o.userData.own) return;
    const mesh = o as THREE.Mesh; mesh.geometry?.dispose();
    if (o === m.lights || o === m.edges) (mesh.material as THREE.Material).dispose();
  });
  m.rig.dispose();
}
