import { has } from '../util/rng';
import { SHIP_SCALE } from '../game/field';

export type Layer = 'air' | 'ground' | 'both' | 'none';
export type SlotKind = 'W' | 'U';
export interface Part { id: string; tier: number; uid: number }
/**
 * Mount facing: eight compass steps of 45 degrees, clockwise from the bow (0 bow, 2 starboard, 4 stern, 6 port).
 * The facing belongs to the mount, not the part: it stays when parts are swapped. See allowedFacings().
 */
export type Facing = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const FACING_NAMES = ['bow', 'fore-starboard', 'starboard', 'aft-starboard', 'stern', 'aft-port', 'port', 'fore-port'] as const;
export const FACING_SHORT = ['F', 'FS', 'S', 'AS', 'A', 'AP', 'P', 'FP'] as const;
/** `face[i]` is the facing of slot i (weapon mounts only; missing or invalid entries use defaultFacing). */
export interface Section {
  type: SectionType; slots: (Part | null)[]; face?: (number | null)[];
  /** Turret ring level of each weapon mount (1..RING_MAX; missing = 1): a better ring widens the arc. See RING. */
  ring?: (number | null)[];
  /**
   * Where the module sits on the ship grid, in design units: [x of its centre from the keel line, y of its forward edge].
   * Multiples of GRID. When any module lacks one the ship is laid out as a single fore-aft column (autoLayout).
   */
  at?: [number, number];
}
export interface Build { sections: Section[] }

export interface WeaponDef { name: string; layer: Layer; cd: number; dmg: number; col: string; cost: number; desc: string }
export interface UtilDef { name: string; col: string; cost: number; desc: (t: number) => string }

export const WEAPONS: Record<string, WeaponDef> = {
  pulse: { name: 'Pulse Cannon', layer: 'air', cd: 0.16, dmg: 7, col: '#4fd1e8', cost: 40, desc: 'Rapid bolts. On the bow it hoses aircraft ahead; on a broadside it rips off twelve-round ripples.' },
  spread: { name: 'Scatter Laser', layer: 'air', cd: 0.36, dmg: 5, col: '#7ee0ff', cost: 55, desc: 'Fan of 3 bolts, 5 at Mk III and up. Broadside fans shell ground targets beside you.' },
  flak: { name: 'Flak Battery', layer: 'air', cd: 0.75, dmg: 16, col: '#ffd27a', cost: 60, desc: 'Shells burst at the target\'s range and damage every aircraft in the blast.' },
  missile: { name: 'Seeker Pods', layer: 'both', cd: 1.0, dmg: 16, col: '#ff9f5a', cost: 75, desc: 'Heavy. Paired homing missiles that lock the target nearest your reticle. Broadside pods launch outward.' },
  bomb: { name: 'Bomb Bay', layer: 'ground', cd: 0.6, dmg: 26, col: '#f2a541', cost: 45, desc: 'Heavy, ventral. Drops bombs on the ground under your reticle, within 420 of the bay.' },
  artillery: { name: 'Siege Mortar', layer: 'ground', cd: 1.1, dmg: 34, col: '#e88a3c', cost: 70, desc: 'Heavy, ventral. Lobs shells onto the ground under your reticle, up to 640 away.' },
  rail: { name: 'Rail Spine', layer: 'both', cd: 1.7, dmg: 48, col: '#c9a6ff', cost: 95, desc: 'Heavy. Charged slug pierces everything in a line toward your reticle, inside its mount\'s arc.' },
  tesla: { name: 'Arc Coil', layer: 'both', cd: 0.5, dmg: 9, col: '#9be7ff', cost: 80, desc: 'All-round. Lightning jumps between nearby targets, air or ground.' },
  pd: { name: 'Point Defense', layer: 'none', cd: 0.3, dmg: 0, col: '#b8f2c8', cost: 65, desc: 'All-round. Shoots down enemy shots and missiles near your hull.' },
};
/**
 * Weapon control. AUTO weapons (light guns, flak, arc coils, point defense) pick their own targets in their arc and keep
 * the screen alive with constant fire. HEAVY weapons (rails, missiles, mortars, bombs) are the deliberate layer: they
 * sit in numbered weapon groups by family and fire where the pilot puts the reticle (left mouse: the selected group;
 * right mouse: every heavy group). On touch screens, in the balance harness and on ghosts they aim themselves.
 */
export type WeaponControl = 'auto' | 'heavy';
export type HeavyFamily = 'rail' | 'missile' | 'mortar' | 'bomb';
export interface FamilyDef {
  name: string; /** Panel label. */ slot: string; short: string; icon: string; col: string;
  /** How the reticle is used: 'line' fires toward it, 'lock' locks the target nearest it, 'ground' hits the ground under it. */
  aim: 'line' | 'lock' | 'ground';
  /** Ground weapons: max distance from the mount to the reticle (0 = no limit). */ reach: number;
}
/** Heavy families in group order: a ship's groups are numbered 1.. in this order, skipping families it does not carry. */
export const HEAVY_FAMILIES: Record<HeavyFamily, FamilyDef> = {
  rail: { name: 'Rail Cannons', slot: 'RAILS', short: 'RAIL', icon: 'hypersonic-bolt', col: '#c9a6ff', aim: 'line', reach: 0 },
  missile: { name: 'Seeker Missiles', slot: 'MISSILES', short: 'MSL', icon: 'missile-pod', col: '#ff9f5a', aim: 'lock', reach: 0 },
  mortar: { name: 'Siege Mortars', slot: 'MORTARS', short: 'MRT', icon: 'mortar', col: '#e88a3c', aim: 'ground', reach: 640 },
  bomb: { name: 'Bomb Bays', slot: 'BOMBS', short: 'BMB', icon: 'falling-bomb', col: '#f2a541', aim: 'ground', reach: 420 },
};
export const FAMILY_ORDER: HeavyFamily[] = ['rail', 'missile', 'mortar', 'bomb'];
const PART_FAMILY: Record<string, HeavyFamily> = { rail: 'rail', missile: 'missile', artillery: 'mortar', bomb: 'bomb' };
/** The heavy family of a weapon part, or null for AUTO weapons. */
export const weaponFamily = (id: string): HeavyFamily | null => (has(PART_FAMILY, id) ? PART_FAMILY[id] : null);
export const weaponControl = (id: string): WeaponControl => (weaponFamily(id) ? 'heavy' : 'auto');
export interface WeaponGroup { key: number; family: HeavyFamily; def: FamilyDef; mounts: Mount[] }
/** The ship's heavy weapon groups, keyed 1.. in FAMILY_ORDER (only the families it carries). */
export function weaponGroups(mounts: Mount[]): WeaponGroup[] {
  const out: WeaponGroup[] = [];
  for (const f of FAMILY_ORDER) {
    const ms = mounts.filter((m) => m.part && weaponFamily(m.part.id) === f);
    if (ms.length) out.push({ key: out.length + 1, family: f, def: HEAVY_FAMILIES[f], mounts: ms });
  }
  return out;
}
/** AUTO weapon mounts: they fire on their own. */
export const autoMounts = (mounts: Mount[]) => mounts.filter((m) => m.part && has(WEAPONS, m.part.id) && weaponControl(m.part.id) === 'auto');
/**
 * Scrap magnet (field units): scrap within `base + perTier · magnet tiers + relic magnetAdd` of the hull's edge is pulled
 * in, accelerating; scrap within `collect` of the hull is taken at once. See combat.ts updatePickups.
 */
export const MAGNET = { base: 240, perTier: 80, collect: 26, accel: 2600, maxSpeed: 1500 } as const;
export const droneCount = (t: number) => Math.min(3, 1 + Math.floor((t - 1) / 2));
export const UTILS: Record<string, UtilDef> = {
  plate: { name: 'Armor Plating', col: '#9aa7b4', cost: 40, desc: (t) => `+${35 * t} max hull.` },
  shield: { name: 'Shield Generator', col: '#4fd1e8', cost: 70, desc: (t) => `${30 * t} shield that recharges after 2s without a hit.` },
  thruster: { name: 'Vector Thrusters', col: '#ffb86b', cost: 45, desc: (t) => `+${12 * t}% speed.` },
  reactor: { name: 'Overclock Reactor', col: '#ff7a6b', cost: 75, desc: (t) => `+${10 * t}% fire rate on every weapon.` },
  repair: { name: 'Repair Swarm', col: '#8fe39a', cost: 65, desc: (t) => `Repairs ${(1.2 * t).toFixed(1)} hull per second in combat.` },
  magnet: { name: 'Salvage Magnet', col: '#e0c35c', cost: 35, desc: (t) => `Scrap magnet reach +${MAGNET.perTier * t}, +${10 * t}% scrap.` },
  drones: { name: 'Drone Bay', col: '#7fb6ff', cost: 85, desc: (t) => `${droneCount(t)} escort drone${droneCount(t) > 1 ? 's' : ''} that shoot aircraft.` },
};

export type SectionType = 'bridge' | 'gundeck' | 'battery' | 'armor' | 'spine' | 'engine';
export interface SectionDef { name: string; w: number; h: number; hp: number; mass: number; thrust: number; slots: SlotKind[]; cost: number }
/**
 * Sections are long and narrow, like a real capital ship's hull: `w` is the beam (across), `h` the length along the
 * keel. A Broadside Battery's beam includes its sponsons; the hull itself is about `HULL_BEAM` wide.
 */
export const SECTIONS: Record<SectionType, SectionDef> = {
  bridge: { name: 'Command Bridge', w: 20, h: 30, hp: 60, mass: 2, thrust: 4, slots: ['W'], cost: 0 },
  gundeck: { name: 'Gun Deck', w: 22, h: 26, hp: 30, mass: 2, thrust: 0, slots: ['W', 'W'], cost: 70 },
  battery: { name: 'Broadside Battery', w: 30, h: 24, hp: 35, mass: 3, thrust: 0, slots: ['W', 'W', 'W'], cost: 140 },
  armor: { name: 'Armored Hull', w: 24, h: 18, hp: 90, mass: 3, thrust: 0, slots: ['U'], cost: 60 },
  spine: { name: 'Utility Spine', w: 20, h: 18, hp: 30, mass: 1.5, thrust: 0, slots: ['U', 'U'], cost: 80 },
  engine: { name: 'Engine Block', w: 22, h: 20, hp: 25, mass: 1, thrust: 8, slots: ['U'], cost: 55 },
};
/** Beam of the hull proper (design units), without sponsons. */
export const HULL_BEAM = 22;
export const MAX_SECTIONS = 8;
/** Module placement snaps to this many design units. */
export const GRID = 2;
export const TIER = ['', 'I', 'II', 'III', 'IV', 'V'];

let UID = 1;
export const mkPart = (id: string, tier: number): Part => ({ id, tier, uid: UID++ });
export const isPart = (id: unknown): id is string => has(WEAPONS, id) || has(UTILS, id);
export const isWeapon = (id: string) => has(WEAPONS, id);
export const partDef = (id: string): WeaponDef | UtilDef => (has(WEAPONS, id) ? WEAPONS[id] : UTILS[id]);
export const partSlot = (id: string): SlotKind => (has(WEAPONS, id) ? 'W' : 'U');
export const partName = (p: Part) => `${partDef(p.id).name} Mk ${TIER[p.tier]}`;
export const partDesc = (p: Part) => { const d = partDef(p.id); return typeof d.desc === 'function' ? d.desc(p.tier) : d.desc; };
export const partCost = (p: Part) => Math.round(partDef(p.id).cost * Math.pow(p.tier, 1.35));
export const partLayer = (p: Part): Layer | 'util' => (has(WEAPONS, p.id) ? WEAPONS[p.id].layer : 'util');
export const wDmg = (p: Part) => WEAPONS[p.id].dmg * (1 + 0.45 * (p.tier - 1));
export const wCd = (p: Part) => WEAPONS[p.id].cd * (1 - 0.07 * (p.tier - 1));
export const sectionCost = (t: SectionType, count: number) => Math.round(SECTIONS[t].cost * (1 + 0.15 * count));

/** Stat modifiers granted by relics. Everything defaults to neutral. */
export interface Mods {
  hullAdd: number; hullMul: number; speedMul: number; fireMul: number; shieldAdd: number; magnetAdd: number;
  scrapMul: number; dmgAir: number; dmgGround: number; regen: number; priceMul: number; railCdMul: number; bossHpMul: number;
}
export const neutralMods = (): Mods => ({ hullAdd: 0, hullMul: 1, speedMul: 1, fireMul: 1, shieldAdd: 0, magnetAdd: 0, scrapMul: 1, dmgAir: 1, dmgGround: 1, regen: 0, priceMul: 1, railCdMul: 1, bossHpMul: 1 });

export interface Rect { x: number; y: number; w: number; h: number; type: SectionType }

/**
 * Firing arcs. Every weapon mount gets one from where it sits on the hull, and the weapon in it decides how it is used:
 *  - bow: the Command Bridge, at the front. A forward cone; engages air AND ground targets ahead.
 *  - dorsal: Gun Deck turrets on the top deck. Turn all the way round, but cannot depress below the hull, so they
 *    engage AIR targets only (aircraft and ghost dreadnoughts).
 *  - broadside: Broadside Battery sections. The outer mounts fire to port (left) or starboard (right) inside a flank
 *    sector, the centre mount to whichever side has a target. Air AND ground, in synchronized ripple volleys.
 *  - ventral: any bomb bay or mortar, wherever it is mounted. Drops ordnance on the ground only.
 *  - omni: point defense (shoots enemy fire) and arc coils (lightning in every direction; air only from the top deck).
 * mountTraverse() gives the exact sectors and target layers; combat, ghosts, the HUD and the ship renderer all read it.
 */
const wrapPi = (a: number) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
export type Arc = 'bow' | 'dorsal' | 'broadside' | 'ventral' | 'omni' | 'internal';
export const ARC_INFO: Record<Arc, { label: string; short: string; col: string; desc: string }> = {
  bow: { label: 'Bridge gun', short: 'BOW', col: '#4fd1e8', desc: 'Bridge mount: a narrow cone where it faces (fore, fore-port or fore-starboard), air and ground. Towers ahead of it block it.' },
  dorsal: { label: 'Top deck', short: 'TOP', col: '#7fb6ff', desc: 'Top-deck turret: an arc around its facing (120°, 180° or 360° by turret ring), but it cannot depress below the hull, so air targets only. The bridge tower and engine funnels block it.' },
  broadside: { label: 'Broadside', short: 'SIDE', col: '#f2a541', desc: 'Sponson: a 90-180° arc (by turret ring) outboard on its own side, angled fore, abeam or aft. Air and ground, in ripple volleys. Modules beside or ahead of it block it.' },
  ventral: { label: 'Ventral', short: 'BELLY', col: '#e88a3c', desc: 'Drops ordnance on the city and ground targets below and around the ship. Ground only; facing does not matter.' },
  omni: { label: 'All-round', short: 'OMNI', col: '#9be7ff', desc: 'Works in every direction around the hull; facing does not matter.' },
  internal: { label: 'Internal', short: 'BAY', col: '#9aa7b4', desc: 'Utility bay inside the hull.' },
};
/** The arc a mount position gives, before the weapon in it is considered. */
export function positionArc(type: SectionType, kind: SlotKind): Arc {
  if (kind === 'U') return 'internal';
  return type === 'battery' ? 'broadside' : type === 'gundeck' ? 'dorsal' : 'bow';
}
/** The arc a part actually fires in from a mount: bombs and mortars always drop ventrally, coils and PD are omni. */
export function mountArc(type: SectionType, kind: SlotKind, partId: string | null | undefined): Arc {
  if (kind === 'U') return 'internal';
  if (partId && has(WEAPONS, partId)) {
    if (WEAPONS[partId].layer === 'ground') return 'ventral';
    if (partId === 'tesla' || partId === 'pd') return 'omni';
  }
  return positionArc(type, kind);
}
/** Does the facing of a mount matter for the part in it? (Not for ventral ordnance, all-round weapons or bays.) */
export const facingMatters = (arc: Arc) => arc === 'bow' || arc === 'dorsal' || arc === 'broadside';

/* ---------------- facing ---------------- */

/** Facings a weapon mount may take: the bridge gun looks forward, a sponson outboard on its own side, a top-deck turret anywhere. */
export function allowedFacings(type: SectionType, i: number): Facing[] {
  if (SECTIONS[type].slots[i] !== 'W') return [];
  if (type === 'bridge') return [7, 0, 1];
  if (type === 'battery') return i === 0 ? [7, 6, 5] : i === 2 ? [1, 2, 3] : [7, 6, 5, 1, 2, 3];
  return [0, 1, 2, 3, 4, 5, 6, 7];
}
/** A new mount's facing: sponsons abeam (the centre one to starboard), everything else forward. */
export const defaultFacing = (type: SectionType, i: number): Facing => (type === 'battery' ? (i === 0 ? 6 : 2) : 0);
/** The facing of slot i of a section (its stored facing if valid there, else the default). */
export function mountFacing(s: Section, i: number): Facing {
  const v = s.face?.[i];
  return allowedFacings(s.type, i).includes(v as Facing) ? (v as Facing) : defaultFacing(s.type, i);
}
/** The next facing a mount would take when rotated clockwise (dir 1) or anticlockwise (-1), or null if it cannot turn. */
export function nextFacing(s: Section, i: number, dir: 1 | -1): Facing | null {
  const ok = allowedFacings(s.type, i);
  if (ok.length < 2) return null;
  const cur = mountFacing(s, i), sorted = ok.slice().sort((a, b) => a - b);
  // Walk the compass from the current facing until an allowed one comes up.
  for (let k = 1; k <= 8; k++) { const f = (((cur + dir * k) % 8) + 8) % 8 as Facing; if (sorted.includes(f)) return f; }
  return null;
}
/** Ship-space angle of a facing (0 = bow, +PI/2 = starboard). */
export const facingAngle = (f: Facing) => wrapPi((f * Math.PI) / 4);

/** What a mount can engage: 'shots' is point defense (enemy fire), 'none' a utility bay. */
export type TargetLayers = 'air' | 'ground' | 'both' | 'shots' | 'none';
/** One traverse sector in SHIP space: radians, 0 = dead ahead (the bow), +PI/2 = starboard, -PI/2 = port. */
export interface Sector { c: number; h: number }
/** A bearing range the ship's own hull blocks for a mount, and what blocks it. */
export interface Blocked extends Sector { by: SectionType }
export interface Traverse {
  arc: Arc;
  /** Sectors the mount can train in (empty for utility bays, or a gun its own hull fully masks). A full circle is { c: 0, h: PI }. */ sectors: Sector[];
  /** What it can engage from here. */ layers: TargetLayers;
  /** Ventral ordnance falls; nothing to train. */ down: boolean;
  /** Bearings inside its facing's arc that the hull blocks (towers, funnels, neighbouring sponsons). */ blocked: Blocked[];
}
/**
 * Turret rings: every weapon mount can be refitted with a better ring that widens its arc (half-widths in radians,
 * centred on the facing, by ring level 1..3). A top-deck turret goes 120° -> 180° -> 360°; a sponson 90° -> 130° -> its
 * whole side; the bridge gun 70° -> 100° -> 140°. Bridge guns stay clipped to the forward half, sponsons to their side.
 */
export const RING = { bow: [0.6, 0.87, 1.22], broadside: [0.79, 1.13, Math.PI / 2], dorsal: [Math.PI / 3, Math.PI / 2, Math.PI] } as const;
export const RING_MAX = 3;
export const RING_NAMES = ['', 'Standard ring', 'Wide ring', 'Full ring'] as const;
/** Scrap to refit a mount from `level - 1` to `level`. */
export const ringCost = (level: number) => (level <= 1 ? 0 : level === 2 ? 60 : 140);
/** Ring level of slot i (1 when unset or out of range). */
export function mountRing(s: Section, i: number): number {
  const v = Math.round(Number(s.ring?.[i]) || 1);
  return SECTIONS[s.type].slots[i] === 'W' ? Math.max(1, Math.min(RING_MAX, v)) : 1;
}
/** Traverse half-widths by arc at the standard ring (radians), centred on the mount's facing. */
export const TRAVERSE = { bow: RING.bow[0], broadside: RING.broadside[0], dorsal: RING.dorsal[0] } as const;

/**
 * Reach of a weapon from a mount, in field units (what the auto guns engage at; the refit board draws it). Ventral
 * ordnance reaches the ground around the mount, coils and point defense work close to the hull.
 */
export const RANGE = { bow: 1000, dorsal: 720, broadside: 760, bomb: 420, artillery: 640, tesla: 240, pd: 200 } as const;
export function mountRange(arc: Arc, partId: string | null | undefined): number {
  if (partId === 'bomb' || partId === 'artillery' || partId === 'tesla' || partId === 'pd') return RANGE[partId];
  return arc === 'bow' || arc === 'dorsal' || arc === 'broadside' ? RANGE[arc] : 0;
}
const FULL: Sector[] = [{ c: 0, h: Math.PI }];

/* Sector algebra: sectors as [lo, hi] intervals in ship radians (unwrapped, hi - lo <= 2 PI). */
type Iv = [number, number];
const toIv = (s: Sector): Iv => [s.c - s.h, s.c + s.h];
const toSector = ([lo, hi]: Iv): Sector => ({ c: wrapPi((lo + hi) / 2), h: (hi - lo) / 2 });
/** Remove `cut` from every interval (trying it at every turn of the circle). Slivers under ~1° are dropped. */
function subtractIv(ivs: Iv[], cut: Iv): Iv[] {
  let out = ivs;
  for (const k of [-2 * Math.PI, 0, 2 * Math.PI]) {
    const a = cut[0] + k, b = cut[1] + k, next: Iv[] = [];
    for (const [lo, hi] of out) {
      if (b <= lo || a >= hi) { next.push([lo, hi]); continue; }
      if (a > lo) next.push([lo, a]);
      if (b < hi) next.push([b, hi]);
    }
    out = next;
  }
  return out.filter(([lo, hi]) => hi - lo > 0.02);
}
/** Keep only the half of the compass centred on `c` (a sponson cannot fire through its own hull, a bridge gun aft). */
const clipHalf = (ivs: Iv[], c: number) => subtractIv(ivs, [c + Math.PI / 2, c + (3 * Math.PI) / 2]);

/**
 * The traverse of a weapon in a mount facing `facing`, before the rest of the hull is considered (derive() then masks
 * what towers, funnels and sponsons block: see hullShadows). Ghosts and the player share it; the ship renderer clamps
 * turret yaw to it.
 */
export function mountTraverse(type: SectionType, kind: SlotKind, partId: string | null | undefined, facing: Facing = 0, ring = 1): Traverse {
  const arc = mountArc(type, kind, partId), pos = positionArc(type, kind), c = facingAngle(facing);
  const r = Math.max(0, Math.min(RING_MAX, ring) - 1);
  const mk = (ivs: Iv[], layers: TargetLayers): Traverse => ({ arc, sectors: ivs.map(toSector), layers, down: false, blocked: [] });
  switch (arc) {
    case 'internal': return { arc, sectors: [], layers: 'none', down: false, blocked: [] };
    case 'bow': return mk(clipHalf([toIv({ c, h: RING.bow[r] })], 0), 'both');
    case 'dorsal': return mk(RING.dorsal[r] >= Math.PI ? [[-Math.PI, Math.PI]] : [toIv({ c, h: RING.dorsal[r] })], 'air');
    case 'broadside': return mk(clipHalf([toIv({ c, h: RING.broadside[r] })], Math.sign(Math.sin(c)) * Math.PI / 2), 'both');
    case 'ventral': return { arc, sectors: FULL, layers: 'ground', down: true, blocked: [] };
    case 'omni': return { arc, sectors: FULL, layers: partId === 'pd' ? 'shots' : pos === 'dorsal' ? 'air' : 'both', down: false, blocked: [] };
  }
}

/* ---------------- hull shadows ---------------- */

/** A box on the hull that blocks fire (field units, centre and half sizes; y grows toward the stern). */
export interface Obstacle { x: number; y: number; hw: number; hl: number; by: SectionType; si: number; kind: 'tower' | 'hull' }
/**
 * What stands in the way of a hull's guns: the bridge tower and engine funnels rise above the top deck (they block
 * the bridge gun and turrets of other modules); every module's hull blocks the sponsons of other modules (a sponson
 * cannot fire through the ship, so modules placed beside or ahead of a battery mask it).
 */
export function hullObstacles(rects: Rect[]): Obstacle[] {
  const out: Obstacle[] = [];
  rects.forEach((r, si) => {
    const cx = r.x + r.w / 2;
    if (r.type === 'bridge') out.push({ x: cx, y: r.y + r.h * 0.6, hw: r.w * 0.36, hl: r.h * 0.22, by: r.type, si, kind: 'tower' });
    if (r.type === 'engine') out.push({ x: cx, y: r.y + r.h * 0.45, hw: r.w * 0.22, hl: r.h * 0.2, by: r.type, si, kind: 'tower' });
    // Sponsons bulge out of a battery's middle; the rest of every module is plain hull.
    const hl = r.type === 'battery' ? r.h * 0.38 : r.h / 2;
    out.push({ x: cx, y: r.y + r.h / 2, hw: r.w / 2, hl, by: r.type, si, kind: 'hull' });
  });
  return out;
}
/**
 * The structures to draw from a hull's obstacles: towers and funnels as they are, a battery's hull box as its two
 * sponsons (the casemates outboard of the hull beam). Plain module hull is not a structure. Kind 'hull' marks sponsons here.
 */
export function drawnObstacles(obstacles: Obstacle[]): Obstacle[] {
  return obstacles.flatMap((o): Obstacle[] => {
    if (o.kind === 'tower') return [o];
    if (o.by !== 'battery') return [];
    const hw = (o.hw * 2 - HULL_BEAM * SHIP_SCALE) / 2 + 2 * SHIP_SCALE;
    return [-1, 1].map((sd) => ({ ...o, x: o.x + sd * (o.hw - hw), hw }));
  });
}
/** The bearing range (ship space) an obstacle covers as seen from (x, y), or null if the point is inside it. */
export function shadowOf(x: number, y: number, o: Obstacle): Sector | null {
  if (Math.abs(x - o.x) <= o.hw && Math.abs(y - o.y) <= o.hl) return null;
  const bearing = (dx: number, dy: number) => Math.atan2(dx, -dy);
  const a0 = bearing(o.x - x, o.y - y);
  let lo = 0, hi = 0;
  for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const d = wrapPi(bearing(o.x + cx * o.hw - x, o.y + cy * o.hl - y) - a0);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return { c: wrapPi(a0 + (lo + hi) / 2), h: (hi - lo) / 2 };
}
/** Mask a mount's traverse by the hull around it: towers block bridge guns and turrets, other modules block sponsons. */
export function hullShadows(t: Traverse, x: number, y: number, si: number, obstacles: Obstacle[]): Traverse {
  const kind = t.arc === 'broadside' ? 'hull' : t.arc === 'bow' || t.arc === 'dorsal' ? 'tower' : null;
  if (!kind) return t;
  let ivs = t.sectors.map(toIv);
  const blocked: Blocked[] = [];
  for (const o of obstacles) {
    if (o.kind !== kind || o.si === si) continue;
    const sh = shadowOf(x, y, o);
    if (!sh) continue;
    const before = ivs;
    ivs = subtractIv(ivs, toIv(sh));
    const lost = before.reduce((n, [lo, hi]) => n + hi - lo, 0) - ivs.reduce((n, [lo, hi]) => n + hi - lo, 0);
    if (lost > 0.01) blocked.push({ ...sh, by: o.by });
  }
  return { ...t, sectors: ivs.map(toSector), blocked };
}
/** Field angle of a ship-space angle. The player's bow points up the screen; a ghost's (mirrored: y flipped) down. */
export const shipToField = (a: number, mirrored = false) => (mirrored ? Math.PI / 2 - a : a - Math.PI / 2);
export const fieldToShip = (a: number, mirrored = false) => (mirrored ? Math.PI / 2 - a : a + Math.PI / 2);
/** Is a field-space bearing inside the traverse? */
export function inTraverse(t: Traverse, fieldAngle: number, mirrored = false) {
  const a = fieldToShip(fieldAngle, mirrored);
  return t.sectors.some((s) => Math.abs(wrapPi(a - s.c)) <= s.h + 1e-9);
}
/** Clamp a field-space bearing into the nearest traverse sector (field angle out). */
export function clampTraverse(t: Traverse, fieldAngle: number, mirrored = false) {
  if (!t.sectors.length) return fieldAngle;
  const a = fieldToShip(fieldAngle, mirrored);
  let best = a, bd = Infinity;
  for (const s of t.sectors) {
    const d = wrapPi(a - s.c), k = Math.max(-s.h, Math.min(s.h, d)), off = Math.abs(d - k);
    if (off < bd) { bd = off; best = s.c + k; }
  }
  return shipToField(best, mirrored);
}
/** Can a mount that engages `layers` hit a target on `layer`? Enemy layers are 'air', 'ground', or 'both' for a ghost
 *  dreadnought: a flying ship, so air guns reach it and ground ordnance does not. */
export const layersHit = (layers: TargetLayers, layer: string) =>
  layers === 'both' || layers === layer || (layer === 'both' && layers === 'air');
/** Short HUD/refit tag for target layers. */
export const LAYERS_TAG: Record<TargetLayers, string> = { air: 'AIR', ground: 'GND', both: 'ALL', shots: 'PD', none: '' };
/** Where a weapon works, for part cards: what each placement lets it engage. */
export function placementNote(id: string): string {
  if (!has(WEAPONS, id)) return 'Utility bay.';
  if (id === 'pd') return 'Any weapon mount: shoots down enemy fire all round.';
  if (WEAPONS[id].layer === 'ground') return 'Any weapon mount: drops from the belly, ground only.';
  if (id === 'tesla') return 'All round. Bridge or side: air and ground. Top deck: air only.';
  return 'Bridge (narrow forward cone) or sponson (outboard): air and ground. Top deck: 120-360° around its facing by turret ring, air only. Rotate the mount to aim its arc; towers and other modules block it.';
}
export interface Mount {
  ox: number; oy: number; kind: SlotKind; part: Part | null; si: number; i: number;
  /** Which way the mount points (weapon mounts; 0 for bays). */
  facing: Facing;
  /** Turret ring level (1..RING_MAX). */ ring: number;
  /** Reach of its part from here, field units (mountRange; 0 when empty or a bay). */ range: number;
  /** Arc this mount fires in with its current part (see Arc). */
  arc: Arc;
  /** Broadside side from its facing: -1 port (left), 1 starboard (right). 0 for other arcs. */
  side: -1 | 0 | 1;
  /** Traverse sectors and target layers (mountTraverse, masked by hullShadows). */
  trav: Traverse;
}
export interface Derived {
  /** Top speed (field units/s), acceleration and braking (units/s²): mass makes all three worse, thrust better. */
  accel: number; brake: number;
  maxHp: number; speed: number; shieldMax: number; shieldRegen: number; regen: number; fireMult: number; magnet: number;
  scrapMult: number; drones: number; droneTier: number; rects: Rect[]; mounts: Mount[]; /** What blocks fire on this hull. */ obstacles: Obstacle[]; len: number; width: number; mass: number; thrust: number;
  u: Record<string, number>; mods: Mods;
}

/**
 * Where slot i sits in its section, as fractions of the section's beam (x, from the centreline) and length (y, from its
 * forward edge). The bridge gun stands ahead of the tower; Gun Deck turrets on the centreline, one forward and one aft;
 * Broadside sponsons port and starboard with a centreline casemate between them.
 */
export function slotPos(type: SectionType, i: number): [number, number] {
  switch (type) {
    case 'bridge': return [0, 0.2];
    case 'gundeck': return [0, i ? 0.74 : 0.26];
    case 'battery': return [(i - 1) * 0.4, 0.5];
    case 'spine': return [(i ? 1 : -1) * 0.22, 0.5];
    default: return [0, 0.5];
  }
}

/* ---------------- module grid ---------------- */

/** Design-unit box of a module at `at` ([centre x, forward y]). */
export const moduleBox = (type: SectionType, at: [number, number]) => ({ x: at[0] - SECTIONS[type].w / 2, y: at[1], w: SECTIONS[type].w, h: SECTIONS[type].h });
type Box = ReturnType<typeof moduleBox>;
const snap = (v: number) => Math.round(v / GRID) * GRID;
/** The classic single column, bow to stern, every module on the keel line. */
export function autoLayout(sections: Section[]): [number, number][] {
  let y = 0;
  return sections.map((s) => { const at: [number, number] = [0, y]; y += SECTIONS[s.type].h; return at; });
}
/**
 * Where every module sits: its own `at`, or for modules without one (none placed yet, or just bought) the next spot
 * astern on the keel line.
 */
export function layoutOf(b: Build): [number, number][] {
  if (!b.sections.some((s) => Array.isArray(s.at))) return autoLayout(b.sections);
  let tail = Math.max(...b.sections.map((s) => (s.at ? snap(s.at[1]) + SECTIONS[s.type].h : -Infinity)));
  return b.sections.map((s) => {
    if (s.at) return [snap(s.at[0]), snap(s.at[1])];
    const at: [number, number] = [0, tail]; tail += SECTIONS[s.type].h; return at;
  });
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
/** Modules touch when they share a stretch of edge at least GRID * 2 long (a corner is not a joint). */
function touches(a: Box, b: Box) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const near = (u: number, v: number) => Math.abs(u - v) < 1e-6;
  return ((near(a.y + a.h, b.y) || near(b.y + b.h, a.y)) && ox >= GRID * 2 - 1e-6) || ((near(a.x + a.w, b.x) || near(b.x + b.w, a.x)) && oy >= GRID * 2 - 1e-6);
}
/** Why a layout is not a ship (overlapping or loose modules), or null if it is. */
export function layoutIssue(b: Build, at: [number, number][] = layoutOf(b)): string | null {
  const boxes = b.sections.map((s, i) => moduleBox(s.type, at[i]));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) return 'Modules overlap.';
  const seen = new Set([0]), todo = [0];
  while (todo.length) { const i = todo.pop()!; boxes.forEach((bx, j) => { if (!seen.has(j) && touches(boxes[i], bx)) { seen.add(j); todo.push(j); } }); }
  return boxes.length && seen.size < boxes.length ? 'Every module must join the hull edge to edge.' : null;
}
/** Can module si move to `at`? (Snapped; the ship must stay one joined hull.) */
export function canPlace(b: Build, si: number, at: [number, number]): string | null {
  const lay = layoutOf(b).slice(); lay[si] = [snap(at[0]), snap(at[1])];
  return layoutIssue(b, lay);
}
/** Pin every module to its current place, so one can then be moved freely. */
export function pinLayout(b: Build) { layoutOf(b).forEach((at, i) => (b.sections[i].at = at)); }
/** Open spots where a new module of `type` would join the hull: flush against an edge of any module, snapped. */
export function attachSpots(b: Build, type: SectionType): [number, number][] {
  const lay = layoutOf(b), d = SECTIONS[type], out: [number, number][] = [], key = new Set<string>();
  const nb: Build = { sections: [...b.sections, { type, slots: [] }] };
  b.sections.forEach((s, i) => {
    const m = moduleBox(s.type, lay[i]), cx = lay[i][0];
    const cands: [number, number][] = [
      [cx, m.y - d.h], [cx, m.y + m.h], // ahead, astern, centred
      [m.x - d.w / 2, m.y + (m.h - d.h) / 2], [m.x + m.w + d.w / 2, m.y + (m.h - d.h) / 2], // port, starboard, level
      [m.x - d.w / 2, m.y], [m.x + m.w + d.w / 2, m.y], // port, starboard, flush with its bow
    ];
    for (const c of cands) {
      const at: [number, number] = [snap(c[0]), snap(c[1])], k = at.join(',');
      if (key.has(k)) continue; key.add(k);
      if (!layoutIssue(nb, [...lay, at])) out.push(at);
    }
  });
  return out;
}

export function derive(build: Build, mods: Mods = neutralMods()): Derived {
  let hp = 0, mass = 0, thrust = 0;
  const rects: Rect[] = [], mounts: Mount[] = [], lay = layoutOf(build);
  const u: Record<string, number> = { plate: 0, shield: 0, thruster: 0, reactor: 0, repair: 0, magnet: 0, drones: 0 };
  build.sections.forEach((s, si) => {
    const d0 = SECTIONS[s.type], d = { ...d0, w: d0.w * SHIP_SCALE, h: d0.h * SHIP_SCALE };
    const cx = lay[si][0] * SHIP_SCALE, y = lay[si][1] * SHIP_SCALE;
    hp += d.hp; mass += d.mass; thrust += d.thrust;
    rects.push({ x: cx - d.w / 2, y, w: d.w, h: d.h, type: s.type });
    d.slots.forEach((k, i) => {
      const [fx, fy] = slotPos(s.type, i);
      const p = s.slots[i] ?? null, facing = k === 'W' ? mountFacing(s, i) : 0, ring = mountRing(s, i);
      const arc = mountArc(s.type, k, p?.id);
      const side: -1 | 0 | 1 = arc === 'broadside' ? (Math.sin(facingAngle(facing)) < 0 ? -1 : 1) : 0;
      mounts.push({
        ox: cx + fx * d.w, oy: y + fy * d.h, kind: k, part: p, si, i, facing, ring, range: mountRange(arc, p?.id), arc, side,
        trav: mountTraverse(s.type, k, p?.id, facing as Facing, ring),
      });
      if (p && has(UTILS, p.id)) u[p.id] += p.tier;
    });
  });
  // Centre the ship on its bounding box: (0, 0) is the middle of the hull.
  const x0 = Math.min(...rects.map((r) => r.x)), x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y0 = Math.min(...rects.map((r) => r.y)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2, y = y1 - y0, width = x1 - x0;
  rects.forEach((r) => { r.x -= ox; r.y -= oy; });
  mounts.forEach((m) => { m.ox -= ox; m.oy -= oy; });
  const obstacles = hullObstacles(rects);
  mounts.forEach((m) => (m.trav = hullShadows(m.trav, m.ox, m.oy, m.si, obstacles)));
  hp = (hp + 35 * u.plate + mods.hullAdd) * mods.hullMul;
  const speed = (290 * (1 + thrust * 0.05)) / (1 + mass * 0.075) * (1 + 0.12 * u.thruster) * mods.speedMul;
  // Seconds to reach top speed: a starter hull answers in about a third of a second, a full eight-section
  // dreadnought takes most of a second to get going and to stop.
  const accelTime = Math.max(0.24, Math.min(1, 0.22 + mass * 0.032 - thrust * 0.006 - u.thruster * 0.02));
  const accel = speed / accelTime, brake = accel * 1.25;
  const shieldMax = 30 * u.shield + mods.shieldAdd;
  return {
    accel, brake,
    maxHp: Math.round(hp), speed, shieldMax, shieldRegen: shieldMax ? 8 + 4 * u.shield + (u.shield ? 0 : 6) : 0,
    regen: 1.2 * u.repair + mods.regen, fireMult: (1 + 0.1 * u.reactor) * mods.fireMul,
    magnet: MAGNET.base + MAGNET.perTier * u.magnet + mods.magnetAdd, scrapMult: (1 + 0.1 * u.magnet) * mods.scrapMul,
    drones: u.drones ? droneCount(Math.min(5, u.drones)) : 0, droneTier: Math.min(5, u.drones),
    rects, mounts, obstacles, len: y, width, mass, thrust, u, mods,
  };
}

/** The traverse a part would have in mount (si, i) of a derived hull: its facing, masked by the hull (for previews). */
export function traverseIn(d: Derived, si: number, i: number, partId: string | null | undefined): Traverse {
  const m = d.mounts.find((x) => x.si === si && x.i === i)!, type = d.rects[si].type;
  return hullShadows(mountTraverse(type, m.kind, partId, m.facing, m.ring), m.ox, m.oy, si, d.obstacles);
}

/** The Vanguard starter: one bow gun, a broadside pair either side of a ventral bomb bay. Other hulls: data/hulls.ts. */
export const starterBuild = (): Build => ({
  sections: [
    { type: 'bridge', slots: [mkPart('pulse', 1)] },
    { type: 'battery', slots: [mkPart('pulse', 1), mkPart('bomb', 1), mkPart('pulse', 1)] },
    { type: 'engine', slots: [null] },
  ],
});

export type GhostSections = { type: string; slots: ([string, number] | null)[]; face?: number[]; ring?: number[]; at?: [number, number] }[];
export const buildToGhost = (b: Build): GhostSections => {
  const lay = layoutOf(b);
  return b.sections.map((s, si) => ({
    type: s.type, slots: s.slots.map((p) => (p ? [p.id, p.tier] as [string, number] : null)),
    face: s.slots.map((_, i) => mountFacing(s, i)), ring: s.slots.map((_, i) => mountRing(s, i)), at: lay[si],
  }));
};
export function ghostToBuild(sections: unknown): Build {
  const secs: Section[] = [];
  const arr = Array.isArray(sections) ? sections.slice(0, MAX_SECTIONS) : [];
  for (const s of arr) {
    if (!s || !has(SECTIONS, s.type)) continue;
    const d = SECTIONS[s.type as SectionType];
    const slots = d.slots.map((k, i) => {
      const v = Array.isArray(s.slots) ? s.slots[i] : null;
      if (!Array.isArray(v)) return null;
      const id = v[0];
      if (!isPart(id) || partSlot(id) !== k) return null;
      return mkPart(id, Math.min(5, Math.max(1, Math.round(Number(v[1]) || 1))));
    });
    const sec: Section = { type: s.type as SectionType, slots };
    if (Array.isArray(s.face)) sec.face = d.slots.map((_, i) => mountFacing({ ...sec, face: s.face }, i));
    if (Array.isArray(s.ring)) sec.ring = d.slots.map((_, i) => mountRing({ ...sec, ring: s.ring }, i));
    if (Array.isArray(s.at) && s.at.length === 2 && s.at.every((v: unknown) => Number.isFinite(Number(v)) && Math.abs(Number(v)) < 400)) sec.at = [snap(Number(s.at[0])), snap(Number(s.at[1]))];
    secs.push(sec);
  }
  // A layout that is not one joined hull falls back to the single column.
  if (secs.some((s) => !s.at) || layoutIssue({ sections: secs })) secs.forEach((s) => delete s.at);
  if (!secs.some((s) => s.type === 'bridge')) secs.unshift({ type: 'bridge', slots: [mkPart('pulse', 1)] });
  return { sections: secs };
}
export const allParts = (b: Build) => b.sections.flatMap((s) => s.slots.filter((p): p is Part => !!p));
