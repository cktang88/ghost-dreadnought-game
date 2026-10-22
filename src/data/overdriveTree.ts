// Overdrive upgrade trees: every hull's Overdrive (OVERDRIVES in hulls.ts) refits along branching paths.
// Pure data and rules (no DOM, no combat state): run.ts stores the picks, combat.ts reads the folded effects
// (odMods), the tree screen (src/ui/screens/odTree.ts) draws it.
//
// Shape: three tiers. Tier 1 picks a PATH (2-3 nodes, mutually exclusive); every tier-2 and tier-3 node belongs to
// one path (`requires` its tier-1 node), so only the chosen path's nodes are ever open. Tier 2 offers two nodes per
// path (pick one, the other locks); tier 3 is the path's capstone. Picking any node locks its tier siblings.
import type { OverdriveKind } from './hulls';

/**
 * Effects a node has. Numbers fold multiplicatively (`dur`, `dmg`, `width`, `charge`, `heal`) or additively (`count`);
 * flags switch on a behaviour. Which flags a kind reads is noted on each; combat ignores the rest.
 */
export interface OdFx {
  /** Duration multiplier. */ dur?: number;
  /** Damage multiplier (beam ticks, craft guns and bombs, shockwave, reflected shots). */ dmg?: number;
  /** Width multiplier: lance and spear beam width, bomb / intercept radius, aegis radius. */ width?: number;
  /** Extra craft (wing) or extra spears (spear, a fan either side of the bow). */ count?: number;
  /** Charge rate multiplier: kills and damage fill the gauge faster. */ charge?: number;
  /** Bulwark: hull mended per second while active, as a fraction of max hull (adds), and a multiplier on it. */ mend?: number; mendMul?: number;
  /** Bulwark: damage taken while active (replaces the 0.5 of the base aegis; lowest wins). */ taken?: number;
  /** Lance: the beam walks toward the reticle (or the nearest ground target) up to 300 from the keel. */ follow?: boolean;
  /** Lance: the column also burns aircraft above it. */ air?: boolean;
  /** Lance: the scorched furrow keeps burning ground units that cross it. */ furrow?: boolean;
  /** Lance: a second beam either side of the first. */ twin?: boolean;
  /** Lance: the column eats enemy fire inside it. */ skyburn?: boolean;
  /** Wing: craft carry bombs and attack ground targets first. */ bombs?: boolean;
  /** Wing: craft shoot down enemy fire near the hull. */ intercept?: boolean;
  /** Spear: the beam starts thin and swells for its whole run (charge and hold). */ hold?: boolean;
  /** Spear: the beams sweep side to side. */ sweep?: boolean;
  /** Spear: when it ends the column detonates along its length. */ finale?: boolean;
  /** Bulwark: shots the aegis eats are thrown back as our bolts. */ reflect?: boolean;
  /** Bulwark: the opening shockwave repeats every 1.5 s, smaller. */ pulse?: boolean;
  /** Bulwark: the aegis pulls in every scrap drop on the field. */ vacuum?: boolean;
}
export interface OdNode {
  id: string; kind: OverdriveKind; tier: 1 | 2 | 3;
  /** The tier-1 path node this one belongs to (tier 2 and 3). */ requires?: string;
  name: string; desc: string; /** Scrap at a drydock (the merchant adds its price multiplier). */ cost: number; fx: OdFx;
}
/** Scrap price by tier. */
export const OD_COST = { 1: 90, 2: 150, 3: 240 } as const;
const n = (kind: OverdriveKind, tier: 1 | 2 | 3, id: string, name: string, desc: string, fx: OdFx, requires?: string): OdNode =>
  ({ id, kind, tier, name, desc, fx, cost: OD_COST[tier], ...(requires ? { requires } : {}) });

export const OD_NODES: OdNode[] = [
  // Ventral Lance: Sweep (a broad beam you steer) or Pierce (a narrow, long burn that reaches the sky).
  n('lance', 1, 'lance_sweep', 'Sweep', 'The beam widens by half and walks toward your reticle, up to 300 from the keel.', { width: 1.5, follow: true }),
  n('lance', 1, 'lance_pierce', 'Pierce', 'A narrower beam that burns 30% longer and also burns aircraft above the column.', { width: 0.65, dur: 1.3, air: true }),
  n('lance', 2, 'lance_swath', 'Broad Swath', 'Another third wider, 15% hotter.', { width: 1.3, dmg: 1.15 }, 'lance_sweep'),
  n('lance', 2, 'lance_furrow', 'Burning Furrow', 'The scorched furrow keeps burning: ground units crossing it take fire.', { furrow: true }, 'lance_sweep'),
  n('lance', 2, 'lance_core', 'Hot Core', 'Half again the damage.', { dmg: 1.5 }, 'lance_pierce'),
  n('lance', 2, 'lance_long', 'Long Burn', 'Burns another 30% longer.', { dur: 1.3 }, 'lance_pierce'),
  n('lance', 3, 'lance_twin', 'Twin Lances', 'Two more beams burn either side of the first.', { twin: true }, 'lance_sweep'),
  n('lance', 3, 'lance_sky', 'Skyburner', 'Double damage to aircraft, and enemy fire dies in the column.', { skyburn: true }, 'lance_pierce'),
  // Strike Wing: a bigger swarm, heavy bombers, or interceptors that guard the hull.
  n('wing', 1, 'wing_swarm', 'Swarm', 'Launch twelve craft instead of eight.', { count: 4 }),
  n('wing', 1, 'wing_bombers', 'Heavy Bombers', 'Four heavy bombers: they hunt ground targets and drop bombs that hit hard.', { count: -4, bombs: true }),
  n('wing', 1, 'wing_intercept', 'Interceptors', 'The craft fly a screen round the hull and shoot down enemy fire.', { intercept: true }),
  n('wing', 2, 'wing_tight', 'Tight Formation', 'Craft guns hit 35% harder.', { dmg: 1.35 }, 'wing_swarm'),
  n('wing', 2, 'wing_patrol', 'Long Patrol', 'The wing stays up 40% longer.', { dur: 1.4 }, 'wing_swarm'),
  n('wing', 2, 'wing_cluster', 'Cluster Bombs', 'Bomb blasts 60% wider.', { width: 1.6 }, 'wing_bombers'),
  n('wing', 2, 'wing_sortie', 'Second Sortie', 'The bombers stay up 40% longer.', { dur: 1.4 }, 'wing_bombers'),
  n('wing', 2, 'wing_screen', 'Wide Screen', 'Interceptors reach enemy fire 60% farther out.', { width: 1.6 }, 'wing_intercept'),
  n('wing', 2, 'wing_aces', 'Aces', 'Interceptor guns hit 50% harder.', { dmg: 1.5 }, 'wing_intercept'),
  n('wing', 3, 'wing_wolfpack', 'Wolfpack', 'Four more craft.', { count: 4 }, 'wing_swarm'),
  n('wing', 3, 'wing_payload', 'Heavy Payload', 'Bombs hit 50% harder.', { dmg: 1.5 }, 'wing_bombers'),
  n('wing', 3, 'wing_turnaround', 'Quick Turnaround', 'Overdrive charges 40% faster.', { charge: 1.4 }, 'wing_intercept'),
  // Lance Spear: a fan of spears, or one beam you charge and hold.
  n('spear', 1, 'spear_fan', 'Spear Fan', 'Three spears: the bow beam and two angled out either side.', { count: 2, width: 0.75 }),
  n('spear', 1, 'spear_hold', 'Charge and Hold', 'One beam that starts thin and swells to twice the width, 30% hotter.', { hold: true, dmg: 1.3 }),
  n('spear', 2, 'spear_more', 'Fivefold', 'Two more spears in the fan.', { count: 2 }, 'spear_fan'),
  n('spear', 2, 'spear_wide', 'Broad Heads', 'Every spear a quarter wider.', { width: 1.25 }, 'spear_fan'),
  n('spear', 2, 'spear_focus', 'Focus', 'Half again the damage.', { dmg: 1.5 }, 'spear_hold'),
  n('spear', 2, 'spear_sustain', 'Sustain', 'Holds 40% longer.', { dur: 1.4 }, 'spear_hold'),
  n('spear', 3, 'spear_sweep', 'Scythe', 'The fan sweeps side to side across the field.', { sweep: true }, 'spear_fan'),
  n('spear', 3, 'spear_nova', 'Nova', 'When the beam ends the whole column detonates.', { finale: true }, 'spear_hold'),
  // Bulwark Aegis: throw fire back, endure longer, or mend.
  n('bulwark', 1, 'bulwark_reflect', 'Reflect', 'Shots the aegis eats are thrown back at the enemy as bolts.', { reflect: true }),
  n('bulwark', 1, 'bulwark_bastion', 'Long Watch', 'The aegis holds 60% longer and you take 40% damage, not half.', { dur: 1.6, taken: 0.4 }),
  n('bulwark', 1, 'bulwark_mend', 'Mend', 'Crews patch 2.5% of max hull every second the aegis holds.', { mend: 0.025 }),
  n('bulwark', 2, 'bulwark_mirror', 'Mirror', 'Reflected bolts hit 60% harder.', { dmg: 1.6 }, 'bulwark_reflect'),
  n('bulwark', 2, 'bulwark_wide', 'Wide Aegis', 'The aegis reaches 40% farther and holds 15% longer.', { width: 1.4, dur: 1.15 }, 'bulwark_reflect'),
  n('bulwark', 2, 'bulwark_iron', 'Ironclad', 'You take only 30% damage under the aegis.', { taken: 0.3 }, 'bulwark_bastion'),
  n('bulwark', 2, 'bulwark_pulse', 'Pulse', 'The shockwave repeats every 1.5 s while the aegis holds.', { pulse: true }, 'bulwark_bastion'),
  n('bulwark', 2, 'bulwark_crews', 'Damage Crews', 'Mending 60% faster.', { mendMul: 1.6 }, 'bulwark_mend'),
  n('bulwark', 2, 'bulwark_salvage', 'Salvage Field', 'The aegis pulls in every scrap drop on the field, and Overdrive charges 30% faster.', { vacuum: true, charge: 1.3 }, 'bulwark_mend'),
  n('bulwark', 3, 'bulwark_riposte', 'Riposte', 'Overdrive charges 40% faster.', { charge: 1.4 }, 'bulwark_reflect'),
  n('bulwark', 3, 'bulwark_citadel', 'Citadel', 'The aegis holds another 30% longer and reaches 20% farther.', { dur: 1.3, width: 1.2 }, 'bulwark_bastion'),
  n('bulwark', 3, 'bulwark_phoenix', 'Phoenix', 'Mending half again faster, and the aegis holds 25% longer.', { mendMul: 1.5, dur: 1.25 }, 'bulwark_mend'),
];
export const OD_NODE: Record<string, OdNode> = Object.fromEntries(OD_NODES.map((x) => [x.id, x]));
export const odNodesFor = (kind: OverdriveKind) => OD_NODES.filter((x) => x.kind === kind);
export const isOdNode = (id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(OD_NODE, id);

/** Where a node stands for a run that has taken `taken`. */
export type OdState = 'taken' | 'open' | 'locked' | 'later';
/**
 * 'taken'; 'locked' (a sibling in its tier was taken, or it belongs to another path); 'later' (its tier is not open
 * yet: take one node of the tier below first); 'open' (it can be taken now).
 */
export function odState(id: string, taken: readonly string[]): OdState {
  const x = OD_NODE[id];
  if (taken.includes(id)) return 'taken';
  const mine = taken.map((t) => OD_NODE[t]).filter((t) => t && t.kind === x.kind);
  if (mine.some((t) => t.tier === x.tier)) return 'locked';
  if (x.requires && mine.some((t) => t.tier === 1) && !taken.includes(x.requires)) return 'locked';
  if (x.tier > 1 && !mine.some((t) => t.tier === x.tier - 1)) return 'later';
  return 'open';
}
/** Can the node be taken now? */
export const canTakeOd = (id: string, taken: readonly string[]) => isOdNode(id) && odState(id, taken) === 'open';
/** Nodes open to take right now for this Overdrive. */
export const openOdNodes = (kind: OverdriveKind, taken: readonly string[]) => odNodesFor(kind).filter((x) => odState(x.id, taken) === 'open');
/** Keep only a legal sequence of picks (save / ghost data is untrusted): in order, each must be open when taken. */
export function sanitizeOd(ids: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(ids)) for (const id of ids) if (canTakeOd(id, out)) out.push(id);
  return out;
}

/** The folded effects combat reads. Neutral for no picks. */
export interface OdMods {
  dur: number; dmg: number; width: number; count: number; charge: number; mend: number; taken: number;
  follow: boolean; air: boolean; furrow: boolean; twin: boolean; skyburn: boolean; bombs: boolean; intercept: boolean;
  hold: boolean; sweep: boolean; finale: boolean; reflect: boolean; pulse: boolean; vacuum: boolean;
}
export const neutralOd = (): OdMods => ({
  dur: 1, dmg: 1, width: 1, count: 0, charge: 1, mend: 0, taken: 0.5,
  follow: false, air: false, furrow: false, twin: false, skyburn: false, bombs: false, intercept: false,
  hold: false, sweep: false, finale: false, reflect: false, pulse: false, vacuum: false,
});
const FLAGS = ['follow', 'air', 'furrow', 'twin', 'skyburn', 'bombs', 'intercept', 'hold', 'sweep', 'finale', 'reflect', 'pulse', 'vacuum'] as const;
/** Fold the picks for one Overdrive kind (picks for other kinds are ignored). */
export function odMods(kind: OverdriveKind, taken: readonly string[]): OdMods {
  const m = neutralOd();
  let mendMul = 1;
  for (const id of taken) {
    const x = OD_NODE[id]; if (!x || x.kind !== kind) continue;
    const f = x.fx;
    m.dur *= f.dur ?? 1; m.dmg *= f.dmg ?? 1; m.width *= f.width ?? 1; m.charge *= f.charge ?? 1; m.count += f.count ?? 0;
    m.mend += f.mend ?? 0; mendMul *= f.mendMul ?? 1; if (f.taken !== undefined) m.taken = Math.min(m.taken, f.taken);
    for (const k of FLAGS) if (f[k]) m[k] = true;
  }
  m.mend *= mendMul;
  return m;
}
/** One-line summary of what a set of picks changes (tree screen preview). */
export function odSummary(kind: OverdriveKind, taken: readonly string[]): string[] {
  const m = odMods(kind, taken), out: string[] = [];
  const pct = (v: number) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  if (m.dur !== 1) out.push(`duration ${pct(m.dur)}`);
  if (m.dmg !== 1) out.push(`damage ${pct(m.dmg)}`);
  if (m.width !== 1) out.push(`width ${pct(m.width)}`);
  if (m.count) out.push(`${m.count > 0 ? '+' : ''}${m.count} ${kind === 'spear' ? 'spears' : 'craft'}`);
  if (m.charge !== 1) out.push(`charge ${pct(m.charge)}`);
  if (m.mend) out.push(`mends ${(m.mend * 100).toFixed(1)}%/s`);
  if (m.taken !== 0.5) out.push(`damage taken ${Math.round(m.taken * 100)}%`);
  return out;
}
