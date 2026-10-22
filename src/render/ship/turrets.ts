// Weapon mounts at warship scale. A real battleship's turret is a small fraction of its hull, so a mount
// here is a CLUSTER of small guns (twin and triple houses, casemate barrels, PDC blisters) rather than one
// big blob, dressed by where it sits (arcs.ts): raised superfiring barbettes on the top deck, a forward
// casemate in the bow, outboard sponsons along the flanks, bays in the belly.
//
// Static parts (barbettes, casemates, sponsons, VLS cells, bay wells) merge into the hull's own buckets.
// Every moving gun of the ship merges into ONE mesh per material (GunRig), animated in the vertex shader
// from two small uniform arrays (pivot + yaw, recoil + door slide), so a hull with dozens of guns costs a
// handful of draw calls and the CPU only writes a few floats per gun per frame.
//
// Ship-local design space (reference SHIP_SCALE, see hull.ts): x starboard, y up, -z toward the bow.
import * as THREE from 'three';
import { Buckets, B, R, block, lathe, box, flatRect, octagon, type V2, type V3 } from './mesh';
import { gunMaterial, gunUniforms, MAX_GUNS, type GunUniforms, type Livery, type MatKey } from './materials';
import { LightSet, LMode } from './lights';
import { gunCount, type Traverse } from './arcs';

export type AimKind = 'track' | 'fixed' | 'spin';
export interface Gun {
  idx: number;
  /** Pivot in ship design space. */
  px: number; py: number; pz: number;
  /** Barrel tips in gun-local space (yaw 0 points at the bow), before the gun scale gs. */
  muzzles: V3[];
  /** Uniform scale of the gun's geometry (applied in the shader). */
  gs: number;
  kick: number; delay: number;
}
export interface Turret {
  uid: number; id: string; tier: number;
  /** Mount position in ship design space (deck height). */
  x: number; y: number; z: number;
  trav: Traverse;
  aim: AimKind; rate: number; layer: 'air' | 'ground' | 'both' | 'none';
  cur: number; recoil: number; guns: Gun[];
  /** Bomb bay doors 0..1 (kind 2 vertices slide by this). */
  door: number;
  /** Rail charge strip (gun-local start/end) for the charge glow, or null. */
  charge: [V3, V3] | null;
}

const M = () => new THREE.Matrix4();
const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (a: number) => new THREE.Matrix4().makeRotationX(a);
const RY = (a: number) => new THREE.Matrix4().makeRotationY(a);
const toFwd = RX(-Math.PI / 2); // lathe Y axis -> -Z (forward)
const GLOW = { m: 'glow' as MatKey, v0: 0, v1: 1 };

/** All moving guns of one ship: tagged geometry plus the uniforms that drive it. */
export class GunRig {
  bk = new Buckets(); u: GunUniforms = gunUniforms(); guns: Gun[] = []; mats: THREE.Material[] = [];
  add(px: number, py: number, pz: number, gs = 1): Gun | null {
    if (this.guns.length >= MAX_GUNS) return null;
    const g: Gun = { idx: this.guns.length, px, py, pz, muzzles: [], kick: 0, delay: 0, gs };
    this.guns.push(g);
    const a = this.u.uGunA.value; a[g.idx * 4] = px; a[g.idx * 4 + 1] = py; a[g.idx * 4 + 2] = pz;
    this.u.uGunB.value[g.idx * 4 + 2] = gs;
    return g;
  }
  /** One mesh per material; never frustum culled (vertices are pivot-relative until the shader moves them). */
  build(L: Livery, into: THREE.Object3D) {
    let tris = 0;
    for (const [k, mb] of this.bk.b) {
      if (!mb.tris) continue;
      const mat = gunMaterial(L.mats[k], this.u); this.mats.push(mat);
      const mesh = new THREE.Mesh(mb.geometry(), mat);
      mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = k === 't1' || k === 't2' || k === 'dark';
      mesh.userData.own = true; mesh.renderOrder = k === 'glow' ? 3 : 0;
      into.add(mesh); tris += mb.tris;
    }
    return tris;
  }
  dispose() { for (const m of this.mats) m.dispose(); }
}

/* ---------------- gun pieces (gun-local, built into the rig with a tag) ---------------- */
interface P { rig: GunRig; L: Livery }
/** Barrel along -Z from (x, y, z0), elevated by e: mantlet collar, tube, muzzle brake. Returns the tip. */
function barrel(p: P, x: number, y: number, z0: number, len: number, r: number, e: number, brake = true, tip = false): V3 {
  const m = T(x, y, z0).multiply(RX(e)).multiply(toFwd), bk = p.rig.bk, col = p.L.paint.dark;
  const prof: V2[] = [[r * 1.7, 0], [r * 1.7, len * 0.14], [r, len * 0.2], [r * 0.85, len * (brake ? 0.86 : 1)]];
  if (brake) prof.push([r * 1.35, len * 0.88], [r * 1.35, len], [r * 0.5, len]); else prof.push([r * 0.5, len]);
  lathe(bk, B.rail, prof, 6, col, m, false, 1);
  if (tip) lathe(bk, GLOW, [[r * 0.6, len - 0.02], [r * 0.6, len + 0.12], [0, len + 0.12]], 5, p.L.paint.full, m);
  return [x, y + Math.sin(e) * len, z0 - Math.cos(e) * len];
}
/** Small angular gun house (the top silhouette is what reads from the camera). */
function house(p: P, w: number, d: number, h: number, nose = 0.6, col?: THREE.Color) {
  const poly: V2[] = [[-w * nose, -d * 0.55], [-w, -d * 0.1], [-w, d * 0.42], [-w * 0.8, d * 0.5], [w * 0.8, d * 0.5], [w, d * 0.42], [w, -d * 0.1], [w * nose, -d * 0.55]];
  block(p.rig.bk, poly.reverse(), 0, h, { side: B.darkPanel, top: B.panels, col: col ?? p.L.paint.hull, topCol: (col ?? p.L.paint.hull).clone().multiplyScalar(1.25), bevel: Math.min(0.35, h * 0.4), taper: 0.12, tile: 6 });
  // Roof: range-finder hood and a crew hatch.
  box(p.rig.bk, B.ribs, w * 1.5, h * 0.25, 0.35, p.L.paint.dark, T(0, h + 0.1, d * 0.22));
  flatRect(p.rig.bk, R.hatchRound, -w * 0.45, -d * 0.05, -w * 0.05, d * 0.18, h + 0.02, p.L.paint.plate);
}
/** Ball mantlet for casemate guns. */
function ball(p: P, r: number) {
  lathe(p.rig.bk, B.panels, [[0, -r * 0.9], [r * 0.8, -r * 0.6], [r, 0], [r * 0.8, r * 0.6], [0, r * 0.9]], 8, p.L.paint.hull, M(), false, 1);
}

/* ---------------- per-weapon gun designs ---------------- */
/**
 * Gun designs. Each returns its barrels via `bar` (tagged as recoiling) after drawing the house (tagged as
 * turning). Sizes are in design units: a twin pulse house is under 2 units wide on a 140-unit hull.
 */
type Design = (p: P, g: Gun, e: number, cm: boolean, tier: number, tagBody: () => void, tagBar: () => void) => void;
const DESIGNS: Record<string, Design> = {
  pulse: (p, g, e, cm, _t, tb, tr) => {
    tb(); if (cm) ball(p, 0.75); else house(p, 0.95, 2.2, 0.75);
    tr(); for (const bx of [-0.36, 0.36]) g.muzzles.push(barrel(p, bx, 0.45, -0.7, 2.9, 0.1, e, true, true));
  },
  spread: (p, g, e, cm, t, tb, tr) => {
    tb(); if (cm) ball(p, 0.8); else house(p, 1.2, 1.9, 0.65, 0.85);
    tr();
    const n = t >= 3 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const a = (i - (n - 1) / 2) * 0.16, m = T(0, 0.42, -0.6).multiply(RY(-a)).multiply(RX(e));
      box(p.rig.bk, B.rail, 0.16, 0.16, 1.9, p.L.paint.dark, m.clone().multiply(T(0, 0, -0.95)));
      box(p.rig.bk, GLOW, 0.12, 0.12, 0.14, p.L.paint.full, m.clone().multiply(T(0, 0, -1.92)));
    }
    g.muzzles.push([0, 0.42 + Math.sin(e) * 1.9, -0.6 - 1.9]);
  },
  flak: (p, g, e, cm, _t, tb, tr) => {
    tb(); if (cm) ball(p, 0.85); else block(p.rig.bk, octagon(-1.05, -1.0, 1.05, 1.15, 0.35), 0, 0.85, { side: B.darkPanel, top: B.brackets, col: p.L.paint.hull, bevel: 0.25, taper: 0.1, tile: 6 });
    tr(); for (const bx of [-0.6, -0.2, 0.2, 0.6]) { const tp = barrel(p, bx, 0.55, -0.8, 2.1, 0.085, e, true); if (bx === -0.2 || bx === 0.2) g.muzzles.push(tp); }
  },
  missile: (p, g, e, _cm, _t, tb, tr) => {
    // Trainable box launcher: 2 x 3 cells, glowing tubes when it ripples.
    tb(); lathe(p.rig.bk, B.ribs, [[0, 0], [0.9, 0], [0.8, 0.45]], 8, p.L.paint.hull, M());
    tr(); const m = T(0, 0.85, 0).multiply(RX(Math.max(0.25, e)));
    box(p.rig.bk, B.darkPanel, 1.7, 0.9, 2.0, p.L.paint.plate, m);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) box(p.rig.bk, { m: 'black', v0: 0, v1: 1 }, 0.36, 0.28, 0.05, p.L.paint.dark, m.clone().multiply(T(-0.55 + i * 0.55, -0.2 + j * 0.4, -1.01)));
    g.muzzles.push([0, 0.85 + Math.sin(Math.max(0.25, e)) * 1.0, -1.0]);
  },
  rail: (p, g, e, cm, t, tb, tr) => {
    const L = t >= 3 ? 11 : 9;
    tb(); if (cm) ball(p, 1.0); else house(p, 1.15, 3.2, 0.95, 0.7);
    tr(); const m = T(0, 0.6, -0.8).multiply(RX(e * 0.5));
    for (const bx of [-0.42, 0.42]) box(p.rig.bk, B.rail, 0.3, 0.42, L, p.L.paint.dark, m.clone().multiply(T(bx, 0, -L / 2)));
    box(p.rig.bk, B.ribs, 1.15, 0.22, L, p.L.paint.hull, m.clone().multiply(T(0, -0.22, -L / 2)));
    for (let k = 0; k < 5; k++) box(p.rig.bk, B.ribs, 1.4, 0.75, 0.3, p.L.paint.hull, m.clone().multiply(T(0, 0, -1.4 - k * (L - 2) / 5)));
    box(p.rig.bk, GLOW, 0.32, 0.08, L - 0.6, p.L.paint.full, m.clone().multiply(T(0, 0.12, -L / 2)));
    g.muzzles.push([0, 0.6 + Math.sin(e * 0.5) * L, -0.8 - L]);
  },
  artillery: (p, g, e, _cm, _t, tb, tr) => {
    tb(); lathe(p.rig.bk, B.panels, [[0, 0], [1.7, 0], [1.7, 0.45], [1.45, 0.95], [0.9, 1.3], [0, 1.38]], 10, p.L.paint.hull, M(), false, 1);
    flatRect(p.rig.bk, R.hatchCross, -0.5, 0.2, 0.5, 1.0, 1.39, p.L.paint.hull);
    tr(); for (const bx of [-0.48, 0.48]) g.muzzles.push(barrel(p, bx, 0.95, -0.6, 2.6, 0.26, e, true));
  },
  tesla: (p, g, _e, _cm, _t, tb) => {
    tb();
    lathe(p.rig.bk, B.ribs, [[0, 0], [1.3, 0], [1.3, 0.35], [0.8, 0.55]], 10, p.L.paint.hull, M());
    lathe(p.rig.bk, B.rail, [[0, 0.5], [0.55, 0.5], [0.35, 0.8], [0.28, 2.6], [0, 2.6]], 8, p.L.paint.dark, M());
    for (let k = 0; k < 3; k++) lathe(p.rig.bk, B.ribs, [[0.25, 0.95 + k * 0.48], [0.95 - k * 0.14, 1.0 + k * 0.48], [0.95 - k * 0.14, 1.16 + k * 0.48], [0.25, 1.22 + k * 0.48]], 10, p.L.paint.plate, M());
    lathe(p.rig.bk, GLOW, [[0, 2.5], [0.42, 2.62], [0.42, 2.9], [0, 3.05]], 8, p.L.paint.full, M());
    // Static spark gaps round the crown.
    for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2; box(p.rig.bk, B.rail, 0.08, 0.6, 0.08, p.L.paint.dark, T(Math.cos(a) * 1.05, 0.6, Math.sin(a) * 1.05)); }
    g.muzzles.push([0, 2.8, 0]);
  },
  pd: (p, g, e, _cm, _t, tb, tr) => {
    // Point-defence blister: a dome with a single six-barrel gatling.
    tb(); lathe(p.rig.bk, B.panels, [[0, 0], [0.72, 0], [0.7, 0.3], [0.5, 0.62], [0, 0.72]], 8, p.L.paint.plate, M(), false, 1);
    box(p.rig.bk, { m: 'glass', v0: 0, v1: 1 }, 0.3, 0.12, 0.05, p.L.paint.full, T(0, 0.5, -0.5));
    tr(); g.muzzles.push(barrel(p, 0, 0.38, -0.45, 1.25, 0.09, e, false));
  },
};

/* ---------------- capital turrets ---------------- */
/**
 * A dreadnought gun house for the top deck and the bridge mount: one armoured turret of radius R on its
 * barbette, sloped face, rangefinder ears across the roof, `nb` barrels run out through the face (gun-local,
 * gs 1, yaw 0 toward the bow). The weapon changes what is mounted, not the silhouette.
 */
/** The sheet rects (the turret radius below is called R). */
const R_ = R;
function capital(p: P, g: Gun, id: string, nb: number, R: number, e: number, tier: number, tb: () => void, tr: () => void): number {
  const P0 = p.L.paint, bk = p.rig.bk, H = R * (id === 'missile' ? 0.42 : 0.55), w = R * 0.92;
  const poly: V2[] = [[-w * 0.6, -R * 0.95], [-w, -R * 0.42], [-w, R * 0.72], [-w * 0.72, R * 1.08], [w * 0.72, R * 1.08], [w, R * 0.72], [w, -R * 0.42], [w * 0.6, -R * 0.95]];
  tb();
  block(bk, poly.reverse(), 0, H, { side: B.darkPanel, top: B.panels, col: P0.hull, topCol: P0.hull.clone().multiplyScalar(1.3), bevel: R * 0.16, taper: R * 0.05, tile: 9 });
  // Rangefinder ears across the rear roof, a cupola and hatches.
  box(bk, B.ribs, w * 2.5, R * 0.16, R * 0.24, P0.dark, T(0, H + R * 0.06, R * 0.6));
  for (const sx of [-1, 1]) box(bk, B.rail, R * 0.16, R * 0.2, R * 0.3, P0.plate, T(sx * w * 1.25, H + R * 0.06, R * 0.6));
  lathe(bk, B.panels, [[0, 0], [R * 0.2, 0], [R * 0.17, R * 0.14], [0, R * 0.17]], 8, P0.plate, T(-w * 0.45, H, R * 0.1), false, 1);
  flatRect(bk, R_.hatchRound, w * 0.2, R * 0.05, w * 0.55, R * 0.4, H + 0.02, P0.plate);
  flatRect(bk, R_.ventSlots, -w * 0.5, R * 0.78, w * 0.5, R * 0.95, H + 0.02, P0.hull);
  if (id === 'missile') {
    // Trainable box launcher on the turntable: nb rows of cells.
    tr(); const m = T(0, H + R * 0.42, -R * 0.1).multiply(RX(0.3)), bw = R * 1.35, bh = R * 0.25 * Math.max(2, nb);
    box(bk, B.darkPanel, bw, bh, R * 1.5, P0.plate, m);
    for (let i = 0; i < 4; i++) for (let j = 0; j < Math.max(2, nb); j++) box(bk, { m: 'black', v0: 0, v1: 1 }, bw * 0.18, R * 0.16, 0.05, P0.dark, m.clone().multiply(T(-bw * 0.36 + i * bw * 0.24, -bh / 2 + R * 0.13 + j * R * 0.25, -R * 0.76)));
    g.muzzles.push([0, H + R * 0.42 + Math.sin(0.3) * R * 0.75, -R * 0.1 - R * 0.75]);
    return H;
  }
  tr();
  const face = -R * 0.8, yb = H * 0.5;
  if (id === 'rail') {
    const L = R * (tier >= 3 ? 3.1 : 2.7), m = T(0, yb, face).multiply(RX(e * 0.5)), n = Math.max(1, nb);
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * R * 0.62, mi = m.clone().multiply(T(x, 0, 0));
      for (const bx of [-0.16, 0.16]) box(bk, B.rail, R * 0.1, R * 0.17, L, P0.dark, mi.clone().multiply(T(bx * R, 0, -L / 2)));
      for (let k = 0; k < 6; k++) box(bk, B.ribs, R * 0.5, R * 0.3, R * 0.08, P0.hull, mi.clone().multiply(T(0, 0, -R * 0.3 - k * (L - R * 0.6) / 5)));
      box(bk, GLOW, R * 0.09, R * 0.04, L - R * 0.3, P0.full, mi.clone().multiply(T(0, R * 0.06, -L / 2)));
      g.muzzles.push([x, yb + Math.sin(e * 0.5) * L, face - Math.cos(e * 0.5) * L]);
    }
    return H;
  }
  if (id === 'spread') {
    // Emitter fan: lens tubes splayed across the face.
    const n = nb + 2;
    for (let i = 0; i < n; i++) {
      const a = (i - (n - 1) / 2) * 0.14, m = T((i - (n - 1) / 2) * R * 0.2, yb, face).multiply(RY(-a)).multiply(RX(e));
      box(bk, B.rail, R * 0.12, R * 0.12, R * 1.1, P0.dark, m.clone().multiply(T(0, 0, -R * 0.55)));
      box(bk, GLOW, R * 0.09, R * 0.09, R * 0.1, P0.full, m.clone().multiply(T(0, 0, -R * 1.12)));
    }
    g.muzzles.push([0, yb + Math.sin(e) * R * 1.1, face - R * 1.1]);
    return H;
  }
  // Gun barrels: long rifles (pulse) or a bank of short quick-firers (flak).
  const flak = id === 'flak', n = flak ? nb * 2 : nb, sp = Math.min(R * 0.42, (w * 1.5) / n), len = R * (flak ? 1.15 : 1.9), rad = R * (flak ? 0.045 : 0.07);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * sp, tip = barrel(p, x, yb, face + R * 0.1, len, rad, e, true, !flak);
    if (!flak || i % 2) g.muzzles.push(tip);
  }
  return H;
}

/* ---------------- static dressing (merged into the hull) ---------------- */
interface Ctx2 { hb: Buckets; L: Livery; lights: LightSet }
/** Stepped armoured barbette under a dorsal gun, with a painted keep-clear ring and crew lights. */
function barbette(c: Ctx2, x: number, z: number, r: number, y0: number, y1: number) {
  const P0 = c.L.paint;
  block(c.hb, octagon(x - r, z - r, x + r, z + r, r * 0.42), y0, y1, { side: B.ribs, top: B.darkPanel, col: P0.hull.clone().multiplyScalar(0.85), topCol: P0.plate, bevel: 0.2, taper: 0.1, tile: 6 });
  lathe(c.hb, B.hazard, [[r * 0.98, 0], [r * 0.86, 0]], 16, P0.accent.clone().multiplyScalar(0.7), T(x, y1 + 0.02, z), false, 6);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + 0.3; c.lights.add(x + Math.cos(a) * r * 1.02, y1 - 0.15, z + Math.sin(a) * r * 1.02, c.L.light.edge, 0.9, 0.22, LMode.Steady); }
}

export interface MountSpec {
  uid: number; id: string; tier: number; x: number; z: number; deck: number; trav: Traverse;
  /** Hull geometry at the mount: half width at the deck edge, the outboard gallery height, terrace edge. */
  hw: number; terrace: number; gallery: number;
  /** Barbette height above the deck (superfiring turrets stand higher). */
  lift?: number;
  /** Broadside sponson the hull built under this mount: its outboard face (|x|) and roof height. */
  sponson?: { outer: number; top: number; z0: number; z1: number };
}
export interface MountOut { t: Turret; claim: [number, number, number, number] }
/** Weapons that mount as one capital turret on the top deck, the bridge and a battery's centreline. */
const CAPITAL = new Set(['pulse', 'spread', 'flak', 'rail', 'missile']);


export function buildMount(s: MountSpec, rig: GunRig, hb: Buckets, L: Livery, lights: LightSet): MountOut {
  const { id, tier, trav } = s, P0 = L.paint, LL = L.light, c2: Ctx2 = { hb, L, lights };
  const t: Turret = {
    uid: s.uid, id, tier, x: s.x, y: s.deck, z: s.z, trav, aim: 'track', rate: 1.6, layer: trav.layer,
    cur: trav.center, recoil: 0.45, guns: [], door: 0, charge: null,
  };
  if (id === 'tesla') { t.aim = 'spin'; t.rate = 0.8; }
  if (id === 'bomb') t.aim = 'fixed';
  t.rate = id === 'pd' ? 6 : id === 'artillery' ? 0.9 : id === 'rail' ? 0.7 : id === 'missile' ? 2.5 : 1.8;
  t.recoil = id === 'artillery' ? 0.7 : id === 'rail' ? 0.9 : id === 'pd' ? 0.12 : 0.35;
  const p: P = { rig, L }, design = DESIGNS[id];
  let claim: [number, number, number, number] = [s.x - 3, s.z - 3, s.x + 3, s.z + 3];
  // Gun size: a secondary-battery house is ~3 units on a 140-unit hull; heavier tiers grow a little.
  const gs = (trav.kind === 'dorsal' ? 1.5 : id === 'pd' ? 1.15 : 1.35) * (1 + 0.05 * (tier - 1));
  const place = (px: number, py: number, pz: number, cm: boolean) => {
    const g = rig.add(px, py, pz, gs); if (!g || !design) return g;
    design(p, g, trav.elev, cm, tier, () => rig.bk.tag([g.idx, 0]), () => rig.bk.tag([g.idx, 1]));
    rig.bk.tag(null);
    t.guns.push(g); return g;
  };
  const n = gunCount(id, tier);

  if (id === 'bomb') {
    // Ventral bays seen through the deck: lit wells under sliding armoured doors.
    const nb = tier >= 3 ? 2 : 1, bw = 4.4, bd = 6.5;
    for (let b = 0; b < nb; b++) {
      const bx = s.x + (nb > 1 ? (b ? 1 : -1) * (bw / 2 + 0.8) : 0), y = s.deck;
      block(hb, octagon(bx - bw / 2 - 0.5, s.z - bd / 2 - 0.5, bx + bw / 2 + 0.5, s.z + bd / 2 + 0.5, 0.6), y - 0.3, y + 0.25, { side: B.ribs, top: B.ribs, col: P0.dark, bevel: 0.1, capTop: false });
      hb.get('black').quad([bx - bw / 2, y + 0.05, s.z - bd / 2], [bx + bw / 2, y + 0.05, s.z - bd / 2], [bx + bw / 2, y + 0.05, s.z + bd / 2], [bx - bw / 2, y + 0.05, s.z + bd / 2], [0, 0], [1, 0], [1, 1], [0, 1], P0.dark, [0, 1, 0]);
      // Bomb racks glowing in the well.
      for (let k = 0; k < 4; k++) hb.get('core').quad([bx - bw * 0.35, y + 0.08, s.z - bd * 0.4 + k * bd * 0.22], [bx + bw * 0.35, y + 0.08, s.z - bd * 0.4 + k * bd * 0.22], [bx + bw * 0.35, y + 0.08, s.z - bd * 0.4 + k * bd * 0.22 + 0.5], [bx - bw * 0.35, y + 0.08, s.z - bd * 0.4 + k * bd * 0.22 + 0.5], [0, 0], [1, 0], [1, 1], [0, 1], P0.full.clone().multiplyScalar(0.09), [0, 1, 0]);
      const g = rig.add(bx, y + 0.3, s.z); if (!g) continue;
      rig.bk.tag([g.idx, 2]);
      for (const sd of [-1, 1]) {
        box(rig.bk, B.brackets, bw / 2, 0.16, bd, P0.plate, T(sd * bw / 4, 0, 0));
        rig.bk.get('hazard').quad([sd * 0.05, 0.09, -bd / 2], [sd * 0.5, 0.09, -bd / 2], [sd * 0.5, 0.09, bd / 2], [sd * 0.05, 0.09, bd / 2], [0, 0], [0, 1], [3, 1], [3, 0], P0.accent, [0, 1, 0]);
      }
      rig.bk.tag(null); t.guns.push(g);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) lights.add(bx + lx * (bw / 2 + 0.4), y + 0.35, s.z + lz * (bd / 2 + 0.4), LL.port, 1.6, 0.35, LMode.Beacon, (lx + lz) * 0.1 + 0.5);
    }
    claim = [s.x - (nb > 1 ? bw + 1.8 : bw / 2 + 1), s.z - bd / 2 - 1.5, s.x + (nb > 1 ? bw + 1.8 : bw / 2 + 1), s.z + bd / 2 + 1.5];
    return { t, claim };
  }

  const centre = Math.abs(s.x) < 1;
  if ((trav.kind === 'dorsal' || trav.kind === 'bow' || (trav.kind === 'side' && centre)) && CAPITAL.has(id)) {
    // A capital turret on its own barbette, raised by `lift` (superfiring over the turret or casemates ahead).
    const R = (trav.kind === 'side' ? 4.8 : id === 'rail' ? 6 : 5.6) * (1 + 0.05 * (tier - 1)), yb = s.deck + (s.lift ?? 1.6);
    const nb = id === 'rail' ? (tier >= 4 ? 2 : 1) : id === 'flak' ? (tier >= 3 ? 3 : 2) : Math.min(4, gunCount(id, tier));
    if (yb - s.deck > 2.5) {
      // Superfiring: a tall armoured trunk with a ring of lit ports, the barbette crowning it.
      block(hb, octagon(s.x - R * 1.12, s.z - R * 1.12, s.x + R * 1.12, s.z + R * 1.12, R * 0.46), s.deck, yb - 1.2, { side: B.darkPanel, top: B.ribs, col: P0.hull.clone().multiplyScalar(0.75), topCol: P0.hull, bevel: 0.3, taper: 0.15, tile: 8 });
      lights.row([s.x - R * 0.9, yb - 2.2, s.z + R * 1.14], [s.x + R * 0.9, yb - 2.2, s.z + R * 1.14], 0.7, LL.window, 0.9, 0.22, 0.7, LMode.Steady);
      hb.get('shadow').quad([s.x - R + 2, s.deck + 0.07, s.z - R + 1.5], [s.x + R * 1.6, s.deck + 0.07, s.z - R + 1.5], [s.x + R * 1.6, s.deck + 0.07, s.z + R * 1.8], [s.x - R + 2, s.deck + 0.07, s.z + R * 1.8], [0, 0], [1, 0], [1, 1], [0, 1], P0.hull, [0, 1, 0]);
    }
    barbette(c2, s.x, s.z, R * 1.02, yb - 1.2, yb);
    const g = rig.add(s.x, yb, s.z, 1);
    if (g) {
      capital(p, g, id, nb, R, trav.elev * (id === 'flak' ? 1.4 : 0.6), tier, () => rig.bk.tag([g.idx, 0]), () => rig.bk.tag([g.idx, 1]));
      rig.bk.tag(null); t.guns.push(g);
    }
    t.recoil = id === 'rail' ? 2.2 : id === 'flak' ? 0.7 : 1.4;
    if (id === 'rail') { const L = R * (tier >= 3 ? 3.1 : 2.7); t.charge = [[0, R * 0.34, -R], [0, R * 0.34 + Math.sin(trav.elev * 0.3) * L, -R * 0.8 - L]]; }
    claim = [s.x - R * 1.25, s.z - R * 1.25 - (trav.kind === 'side' ? 0 : 1), s.x + R * 1.25, s.z + R * 1.25];
    return { t, claim };
  }

  if (trav.kind === 'side' && s.sponson) {
    // Casemate guns along the outboard edge of the battery sponson (the hull builds the sponson itself).
    const sd = s.x < 0 ? -1 : 1, g2 = gs * 1.8, sp = (id === 'rail' ? 4.6 : 3.3) * g2, nn = n, x = sd * (s.sponson.outer - 1.6 * g2), y = s.sponson.top;
    const zL = (nn - 1) * sp, za = Math.max(s.sponson.z0 + 2.5 * g2, s.z - zL / 2);
    for (let i = 0; i < nn; i++) {
      const gz = za + i * sp;
      lathe(hb, B.ribs, [[1.2 * g2, 0], [1.2 * g2, 0.22], [1.0 * g2, 0.3]], 10, P0.dark, T(x, y, gz));
      const g = rig.add(x, y + 0.25, gz, g2); if (!g || !design) continue;
      design(p, g, trav.elev, false, tier, () => rig.bk.tag([g.idx, 0]), () => rig.bk.tag([g.idx, 1]));
      rig.bk.tag(null); t.guns.push(g);
      lights.add(x + sd * 1.5 * g2, y - 0.6, gz, LL.window, 1, 0.25, LMode.Steady);
    }
    claim = [x - 2.2 * g2, za - 2 * g2, x + 2.2 * g2, za + zL + 2 * g2];
    if (id === 'rail' && t.guns.length) { const L = tier >= 3 ? 11 : 9; t.charge = [[0, 0.75, -1.2], [0, 0.75 + Math.sin(trav.elev * 0.5) * L, -0.8 - L]]; }
    return { t, claim };
  }
  if (trav.kind === 'side') {
    // Flank sponson on the outboard gallery: guns in a row along the hull, resting outboard.
    const sd = s.x < 0 ? -1 : 1, sp = (id === 'rail' ? 4.5 : 3.2) * gs, nn = n, x0 = sd * (s.terrace + 0.4), x1 = sd * (s.hw + 1.6 + gs), y0 = s.gallery - 4.2, y1 = s.gallery + 0.15;
    const zL = (nn - 1) * sp + 3.4 * gs, za = s.z - zL / 2, zb = s.z + zL / 2;
    block(hb, octagon(Math.min(x0, x1), za, Math.max(x0, x1), zb, 1.0), y0, y1, { side: B.grille, top: B.darkPanel, col: P0.hull.clone().multiplyScalar(0.8), topCol: P0.plate, bevel: 0.25, taper: 0.2, tile: 6 });
    hb.get('hazard').quad([x1 - sd * 0.1, y1 + 0.02, za + 0.6], [x1 - sd * 0.6, y1 + 0.02, za + 0.6], [x1 - sd * 0.6, y1 + 0.02, zb - 0.6], [x1 - sd * 0.1, y1 + 0.02, zb - 0.6], [0, 0], [0, 1], [zL / 2, 1], [zL / 2, 0], P0.accent.clone().multiplyScalar(0.6), [0, 1, 0]);
    lights.row([x1 + sd * 0.1, y0 + 1.2, za + 0.8], [x1 + sd * 0.1, y0 + 1.2, zb - 0.8], 0.7, LL.window, 0.9, 0.2, 0.7, LMode.Steady);
    for (let i = 0; i < nn; i++) {
      const gz = za + 1.7 * gs + i * sp, gx = sd * (s.hw - 0.6 + gs * 0.6);
      lathe(hb, B.ribs, [[1.15 * gs, 0], [1.15 * gs, 0.2]], 10, P0.dark, T(gx, y1, gz));
      place(gx, y1 + 0.18, gz, false);
    }
    claim = [Math.min(sd * (s.terrace - 1.5), x1), za - 0.5, Math.max(sd * (s.terrace - 1.5), x1), zb + 0.5];
  } else if (trav.kind === 'bow') {
    // Forward casemate: an armoured wedge with the barrels run out through its face.
    const sp = (id === 'rail' ? 2.4 : 1.9) * gs, nn = id === 'rail' ? Math.max(1, n) : n + 1, W = (nn - 1) * sp / 2 + 1.6 * gs, D = 5.5 * gs, y0 = s.deck, y1 = s.deck + 2.0 * gs;
    const poly: V2[] = [[s.x - W * 0.75, s.z - D / 2], [s.x - W, s.z - D * 0.2], [s.x - W, s.z + D / 2], [s.x + W, s.z + D / 2], [s.x + W, s.z - D * 0.2], [s.x + W * 0.75, s.z - D / 2]];
    block(hb, poly.slice().reverse(), y0, y1, { side: B.darkPanel, top: B.panels, col: P0.hull.clone().multiplyScalar(0.8), topCol: P0.hull.clone().multiplyScalar(1.2), bevel: 0.35, taper: 0.15, tile: 6 });
    flatRect(hb, R.ventSlots, s.x - W * 0.5, s.z + 0.5, s.x + W * 0.5, s.z + 1.5, y1 + 0.02, P0.hull);
    lights.row([s.x - W * 0.7, y1 - 0.4, s.z - D / 2 - 0.05], [s.x + W * 0.7, y1 - 0.4, s.z - D / 2 - 0.05], 0.55, LL.window, 0.9, 0.2, 0.8, LMode.Steady);
    for (let i = 0; i < nn; i++) place(s.x + (i - (nn - 1) / 2) * sp, y0 + 0.9 * gs, s.z - D / 2 + 0.4 * gs, true);
    claim = [s.x - W - 1, s.z - D / 2 - 3, s.x + W + 1, s.z + D / 2 + 1];
  } else if (id === 'tesla') {
    barbette(c2, s.x, s.z, 2.1 * gs, s.deck, s.deck + 0.7 * gs);
    place(s.x, s.deck + 0.7 * gs, s.z, false);
    claim = [s.x - 3, s.z - 3, s.x + 3, s.z + 3];
  } else if (id === 'pd') {
    // A scatter of PDC blisters round the mount.
    for (let i = 0; i < n + 1; i++) {
      const a = (i / (n + 1)) * Math.PI * 2 + 0.4, r = 2.4 * gs, gx = s.x + Math.cos(a) * r, gz = s.z + Math.sin(a) * r;
      lathe(hb, B.ribs, [[0.95 * gs, 0], [0.95 * gs, 0.25], [0.75 * gs, 0.32]], 8, P0.dark, T(gx, s.deck, gz));
      place(gx, s.deck + 0.3, gz, false);
    }
    claim = [s.x - 3.6 * gs, s.z - 3.6 * gs, s.x + 3.6 * gs, s.z + 3.6 * gs];
  } else {
    // Dorsal battery: guns in superfiring pairs along the centreline of the mount on stepped barbettes.
    const sp = (id === 'rail' ? 6.5 : id === 'artillery' ? 4.4 : 3.6) * gs, r = (id === 'artillery' ? 2.0 : id === 'rail' ? 1.6 : 1.45) * gs;
    const pos: [number, number, number][] = [];
    if (n === 4) for (const [dx, dz, up] of [[-1.9, -1.9, 1], [1.9, -1.9, 1], [-1.9, 1.9, 0], [1.9, 1.9, 0]]) pos.push([s.x + dx * gs, s.z + dz * gs, up]);
    else for (let i = 0; i < n; i++) { const dz = (i - (n - 1) / 2) * sp; pos.push([s.x, s.z + dz, i === 0 && n > 1 ? 1 : 0]); }
    // Common armoured deck plate under the group.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [px, pz] of pos) { x0 = Math.min(x0, px - r - 0.7); x1 = Math.max(x1, px + r + 0.7); z0 = Math.min(z0, pz - r - 0.7); z1 = Math.max(z1, pz + r + 0.7); }
    block(hb, octagon(x0, z0, x1, z1, 1.0), s.deck, s.deck + 0.35, { side: B.ribs, top: B.brackets, col: P0.hull.clone().multiplyScalar(0.9), bevel: 0.12, tile: 6 });
    for (const [px, pz, up] of pos) {
      const yb = s.deck + 0.35 + (0.45 + up * 0.9) * gs;
      barbette(c2, px, pz, r, s.deck + 0.35, yb);
      place(px, yb, pz, false);
    }
    if (id === 'missile') {
      // Dorsal missile mounts also get a VLS field beside the launchers.
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) flatRect(hb, R.slot, x1 + 0.3 + j * 1.0, z0 + 0.5 + i * 1.1, x1 + 1.2 + j * 1.0, z0 + 1.4 + i * 1.1, s.deck + 0.05, P0.dark);
      x1 += 2.4;
    }
    claim = [x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5];
  }
  if (id === 'rail' && t.guns.length) {
    const L = tier >= 3 ? 11 : 9; t.charge = [[0, 0.75, -1.2], [0, 0.75 + Math.sin(trav.elev * 0.5) * L, -0.8 - L]];
    // (gun-local, pre-scale: the layer multiplies by the gun's gs)
  }
  return { t, claim };
}
