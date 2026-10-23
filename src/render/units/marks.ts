// Marker styles for the tactical symbology (symbology.ts): which layer a contact is on, what colour family it is
// drawn in and how loud it is. Pure data (no DOM, no three.js), so it is unit tested (tests/unit/marks.test.ts).
//
//   AIR    hostile red. An open tent frame (NATO hostile air) that rides at flight altitude with a slight bob, and a
//          faint drop line down to a pip on the aircraft's shadow: "this thing is above the city".
//   GROUND burnt amber. A closed, filled diamond (NATO hostile ground) and a ring decal flat on the ground round the
//          unit's footprint: "this thing is on the city". Amber is hotter and redder than sodium street light, and
//          every stroke carries a dark keyline, so it holds over the lit grid.
//   SALVAGE scrap gold, smaller and dimmer: it never shoots. Air salvage keeps the drop line, ground salvage the ring.
//
// Size says threat: light contacts (drones, infantry) are small, heavy ones (SAM, flak tower, gunship, bomber) large,
// elites larger still.
import { EN, type EnemyType } from '../../data/enemies';

export const MARK_COL = {
  air: '#ff5a4e', airHot: '#ffd6cc',
  gnd: '#ff9028', gndHot: '#ffe6b8',
  scrap: '#e0c35c', scrapHot: '#f4e6b0',
};

export const enum Tier { Salvage, Light, Standard, Heavy, Elite }
/** Symbol half-size per tier (screen units). */
export const TIER_SIZE: Record<Tier, number> = { [Tier.Salvage]: 4.8, [Tier.Light]: 5.4, [Tier.Standard]: 6.6, [Tier.Heavy]: 7.8, [Tier.Elite]: 9.6 };

export interface MarkStyle {
  air: boolean; salvage: boolean; tier: Tier;
  /** Symbol half-size, screen units. */ size: number;
  col: string; hot: string;
  /** Alpha multiplier (salvage is dimmer). */ alpha: number;
}

/** Threat tier from the enemy's data: elites, then heavy (score 120+), light (score under 20), standard. */
export function tierOf(type: EnemyType): Tier {
  const d = EN[type];
  if (d.salvage) return Tier.Salvage;
  if (d.elite) return Tier.Elite;
  if (d.score >= 120) return Tier.Heavy;
  if (d.score < 20) return Tier.Light;
  return Tier.Standard;
}

export function markStyle(type: EnemyType): MarkStyle {
  const d = EN[type], air = d.layer === 'air', salvage = !!d.salvage, tier = tierOf(type);
  return {
    air, salvage, tier, size: TIER_SIZE[tier],
    col: salvage ? MARK_COL.scrap : air ? MARK_COL.air : MARK_COL.gnd,
    hot: salvage ? MARK_COL.scrapHot : air ? MARK_COL.airHot : MARK_COL.gndHot,
    alpha: salvage ? 0.62 : 1,
  };
}

/** Every type's style, built once. */
export const MARK: Record<EnemyType, MarkStyle> = Object.fromEntries(
  (Object.keys(EN) as EnemyType[]).map((t) => [t, markStyle(t)]),
) as Record<EnemyType, MarkStyle>;

/** The air marker's bob (screen units): slow, small, phase per contact so a squadron does not bob in step. */
export const bob = (now: number, phase: number) => Math.sin(now * 2.1 + phase * 1.7) * 1.4;

/** WCAG-style relative luminance of a #rrggbb colour (for the contrast test). */
export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export const contrast = (a: string, b: string) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
