import { describe, it, expect } from 'vitest';
import { EN, type EnemyType } from '../../src/data/enemies';
import { MARK, MARK_COL, Tier, tierOf, contrast } from '../../src/render/units/marks';

const TYPES = Object.keys(EN) as EnemyType[];
/** Hue in degrees of a #rrggbb colour. */
function hue(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('symbology marker styles', () => {
  it('every enemy type has a style on its own layer', () => {
    for (const t of TYPES) {
      expect(MARK[t], t).toBeDefined();
      expect(MARK[t].air, t).toBe(EN[t].layer === 'air');
    }
  });

  it('air and ground shooters are drawn in different colour families', () => {
    for (const t of TYPES) {
      if (EN[t].salvage) continue;
      expect(MARK[t].col, t).toBe(EN[t].layer === 'air' ? MARK_COL.air : MARK_COL.gnd);
    }
    expect(Math.abs(hue(MARK_COL.air) - hue(MARK_COL.gnd))).toBeGreaterThan(20);
  });

  it('salvage is scrap gold, dimmer and smaller than anything that shoots', () => {
    const shooters = TYPES.filter((t) => !EN[t].salvage);
    const minShooter = Math.min(...shooters.map((t) => MARK[t].size));
    for (const t of TYPES.filter((t) => EN[t].salvage)) {
      expect(MARK[t].col).toBe(MARK_COL.scrap);
      expect(MARK[t].alpha).toBeLessThan(1);
      expect(MARK[t].size).toBeLessThan(minShooter);
    }
  });

  it('sizes rise with threat: light < standard < heavy < elite', () => {
    expect(tierOf('drone')).toBe(Tier.Light);
    expect(tierOf('infantry')).toBe(Tier.Light);
    expect(tierOf('tank')).toBe(Tier.Standard);
    expect(tierOf('sam')).toBe(Tier.Heavy);
    expect(tierOf('bomber')).toBe(Tier.Heavy);
    for (const t of ['ace', 'crawler', 'carrier'] as EnemyType[]) expect(tierOf(t)).toBe(Tier.Elite);
    expect(MARK.drone.size).toBeLessThan(MARK.jet.size);
    expect(MARK.jet.size).toBeLessThan(MARK.gunship.size);
    expect(MARK.gunship.size).toBeLessThan(MARK.ace.size);
  });

  it('marker colours hold contrast over night ground and over the dark keyline every stroke sits on', () => {
    for (const col of [MARK_COL.air, MARK_COL.gnd, MARK_COL.scrap]) {
      expect(contrast(col, '#0a0e13'), col).toBeGreaterThan(4.5); // void: night city, forest canopy
      expect(contrast(col, '#06080b'), col).toBeGreaterThan(4.5); // keyline (over pale snow it carries the stroke)
    }
  });
});
