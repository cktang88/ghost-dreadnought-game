// Gun traverse for the renderer: how each mount is dressed (raised dorsal barbette, bow casemate, flank
// sponson, ventral bay), where its guns rest, and the yaw clamp. The arcs themselves are the game's:
// Mount.trav = mountTraverse(...) in src/data/parts.ts (ship space, 0 = bow, +PI/2 = starboard), with
// clampTraverse / inTraverse for field-space bearings (ghosts mirrored). Combat, ghosts, HUD and this
// renderer all read the same sectors.
//
// Turret yaw in the renderer is the three.js rotation about +Y: 0 points at the bow, +PI/2 to PORT. So
// yaw = -(ship angle).
import { WEAPONS, clampTraverse, fieldToShip, inTraverse, type Mount, type SectionType, type Traverse as GameTraverse } from '../../data/parts';
import { has } from '../../util/rng';

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
}

const FREE: GameTraverse = { arc: 'dorsal', sectors: [{ c: 0, h: Math.PI }], layers: 'air', down: false, blocked: [] };

export function mountTraverse(m: Mount, _section?: SectionType): Traverse {
  const id = m.part?.id ?? '', g = m.trav ?? FREE;
  const half = g.sectors.reduce((a, s) => Math.max(a, s.h), 0);
  const layer = g.layers === 'shots' || g.layers === 'none' ? 'none' : g.layers;
  // A battery's centre gun covers both beams: it rests fore and aft, so dress it as a centreline turret.
  const center = g.sectors.length === 1 ? -g.sectors[0].c : 0;
  if (!has(WEAPONS, id)) return { kind: 'dorsal', center: 0, half: 0, layer: 'none', elev: 0, game: g };
  if (id === 'bomb') return { kind: 'ventral', center: 0, half: 0, layer, elev: 0, game: g };
  if (id === 'artillery') return { kind: 'ventral', center: 0, half, layer, elev: 0.85, game: g };
  if (g.arc === 'omni') return { kind: 'omni', center, half, layer, elev: id === 'pd' ? 0.5 : 0, game: g };
  if (g.arc === 'broadside') return m.side ? { kind: 'side', center, half, layer, elev: -0.2, game: g } : { kind: 'dorsal', center, half, layer, elev: 0.15, game: g };
  if (g.arc === 'bow') return { kind: 'bow', center, half, layer, elev: -0.1, game: g };
  return { kind: 'dorsal', center, half, layer, elev: 0.5, game: g };
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
/** Rest: the centre of the sector nearest the current yaw (two-sector guns stay on their last beam). */
export function restYaw(t: Traverse, cur: number) {
  const ss = t.game.sectors; if (ss.length < 2) return t.center;
  let best = t.center, bd = Infinity;
  for (const s of ss) { const d = Math.abs(Math.atan2(Math.sin(-s.c - cur), Math.cos(-s.c - cur))); if (d < bd) { bd = d; best = -s.c; } }
  return best;
}
/** Keep a renderer yaw inside the traverse (ship space, so mirroring does not matter). */
export function holdYaw(t: Traverse, yaw: number) {
  const ss = t.game.sectors; if (!ss.length || t.half >= Math.PI) return yaw;
  const a = -yaw; let best = a, bd = Infinity;
  for (const s of ss) { const d = Math.atan2(Math.sin(a - s.c), Math.cos(a - s.c)), k = Math.max(-s.h, Math.min(s.h, d)), off = Math.abs(d - k); if (off < bd) { bd = off; best = s.c + k; } }
  return -best;
}
/** Is a field bearing inside the traverse? (player side, unmirrored) */
export const bearingIn = (t: Traverse, fieldAngle: number) => !t.game.sectors.length || inTraverse(t.game, fieldAngle, false);

/** Guns in a mount's cluster (the blueprint draws the same count). */
export const gunCount = (id: string, tier: number) =>
  id === 'rail' ? (tier >= 4 ? 2 : 1) : id === 'artillery' ? (tier >= 3 ? 2 : 1) : id === 'tesla' ? 1 : id === 'missile' ? (tier >= 3 ? 3 : 2) : tier >= 4 ? 4 : tier >= 2 ? 3 : 2;
