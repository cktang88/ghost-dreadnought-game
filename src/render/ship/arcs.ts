// Gun traverse for the renderer: how each mount is dressed (raised dorsal barbette, bow casemate, flank
// sponson, ventral bay), where its guns rest, and the yaw clamp. The arcs themselves are the game's:
// Mount.trav = mountTraverse(...) in src/data/parts.ts (ship space, 0 = bow, +PI/2 = starboard), with
// clampTraverse / inTraverse for field-space bearings (ghosts mirrored). Combat, ghosts, HUD and this
// renderer all read the same sectors.
//
// Turret yaw in the renderer is the three.js rotation about +Y: 0 points at the bow, +PI/2 to PORT. So
// yaw = -(ship angle).
import { WEAPONS, clampTraverse, facingAngle, fieldToShip, inTraverse, type Mount, type SectionType, type Traverse as GameTraverse } from '../../data/parts';
import { has } from '../../util/rng';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export type MountKind = 'dorsal' | 'bow' | 'side' | 'ventral' | 'omni';
export interface Traverse {
  kind: MountKind;
  /** Rest yaw (renderer yaw: 0 toward the bow, +PI/2 to port). */
  center: number;
  /** Widest sector half-width; PI is free 360-degree training. */
  half: number;
  /** What the mount may engage (the game's layers; point defence engages shots, shown as 'none'). */
  layer: 'air' | 'ground' | 'both' | 'none';
  /** Barrel elevation for the look (radians): high-angle AA up, casemate guns depressed toward the city. */
  elev: number;
  /** The shared traverse (sectors in ship space). */
  game: GameTraverse;
  /**
   * Slew range in ship space relative to the facing (`face`, ship radians): the gun turns only inside
   * [face + lo, face + hi], never across the back of its arc, but it may swing past bearings the hull
   * masks (towers block fire, not training). `free` turrets turn all round.
   */
  face: number; lo: number; hi: number; free: boolean;
}

const FREE: GameTraverse = { arc: 'dorsal', sectors: [{ c: 0, h: Math.PI }], layers: 'air', down: false, blocked: [] };

/** Clamp a ship angle into the nearest sector. */
function intoSectors(ss: GameTraverse['sectors'], a: number) {
  let best = a, bd = Infinity;
  for (const s of ss) { const d = wrap(a - s.c), k = Math.max(-s.h, Math.min(s.h, d)), off = Math.abs(d - k); if (off < bd) { bd = off; best = s.c + k; } }
  return wrap(best);
}

export function mountTraverse(m: Mount, _section?: SectionType): Traverse {
  const id = m.part?.id ?? '', g = m.trav ?? FREE;
  const half = g.sectors.reduce((a, s) => Math.max(a, s.h), 0);
  const layer: Traverse['layer'] = g.layers === 'shots' || g.layers === 'none' ? 'none' : g.layers;
  const free = g.sectors.some((s) => s.h >= Math.PI - 1e-6) || g.down || g.arc === 'omni';
  // Rest on the mount's facing, or the nearest bearing the hull leaves open when the facing itself is masked.
  const face = free ? 0 : facingAngle(m.facing ?? 0), rest = free ? 0 : intoSectors(g.sectors, face);
  let lo = 0, hi = 0;
  for (const s of g.sectors) { const r = wrap(s.c - face); lo = Math.min(lo, r - s.h); hi = Math.max(hi, r + s.h); }
  const base = { center: -rest, half, layer, game: g, face, lo: Math.max(-Math.PI, lo), hi: Math.min(Math.PI, hi), free };
  if (!has(WEAPONS, id)) return { ...base, kind: 'dorsal', center: 0, half: 0, layer: 'none', elev: 0, free: true };
  if (id === 'bomb') return { ...base, kind: 'ventral', center: 0, half: 0, elev: 0, free: true };
  if (id === 'artillery') return { ...base, kind: 'ventral', center: 0, elev: 0.85, free: true };
  if (g.arc === 'omni') return { ...base, kind: 'omni', center: 0, elev: id === 'pd' ? 0.5 : 0, free: true };
  if (g.arc === 'broadside') return { ...base, kind: m.side ? 'side' : 'dorsal', elev: m.side ? -0.2 : 0.15 };
  if (g.arc === 'bow') return { ...base, kind: 'bow', elev: -0.1 };
  return { ...base, kind: 'dorsal', elev: 0.5 };
}

/**
 * Renderer yaw for a field-space bearing, clamped into the traverse (clampTraverse; ghosts are mirrored).
 * A bearing well outside every sector (across the hull) sends the gun back to rest instead.
 */
export function aimYaw(t: Traverse, fieldAngle: number, mirrored: boolean, cur: number) {
  if (!t.game.sectors.length) return t.center;
  const c = clampTraverse(t.game, fieldAngle, mirrored);
  const off = Math.abs(Math.atan2(Math.sin(c - fieldAngle), Math.cos(c - fieldAngle)));
  if (off > 0.5) return restYaw(t, cur);
  return -fieldToShip(c, mirrored);
}
/** Rest: the mount's facing (clamped into an open sector). */
export function restYaw(t: Traverse, _cur?: number) { return t.center; }
/** Renderer yaw as an offset from the facing, in ship radians (inside the slew range when the gun is). */
const rel = (t: Traverse, yaw: number) => wrap(-yaw - t.face);
/** Keep a renderer yaw inside the slew range (ship space, so mirroring does not matter). */
export function holdYaw(t: Traverse, yaw: number) {
  if (t.free) return yaw;
  return -(t.face + Math.max(t.lo, Math.min(t.hi, rel(t, yaw))));
}
/**
 * Yaw change from `cur` toward `want` the way the gun can actually turn: the short way for free turrets,
 * otherwise inside its own arc (never across the back of it, through its stops).
 */
export function slewDelta(t: Traverse, cur: number, want: number) {
  if (t.free) return wrap(want - cur);
  return -(rel(t, want) - rel(t, cur));
}
/** Is a field bearing inside the traverse? (player side, unmirrored) */
export const bearingIn = (t: Traverse, fieldAngle: number) => !t.game.sectors.length || inTraverse(t.game, fieldAngle, false);

/** Guns in a mount's cluster (the blueprint draws the same count). */
export const gunCount = (id: string, tier: number) =>
  id === 'rail' ? (tier >= 4 ? 2 : 1) : id === 'artillery' ? (tier >= 3 ? 2 : 1) : id === 'tesla' ? 1 : id === 'missile' ? (tier >= 3 ? 3 : 2) : tier >= 4 ? 4 : tier >= 2 ? 3 : 2;
