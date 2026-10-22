import { memoryStore } from '../sim/env';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OD_NODES, OD_NODE, odNodesFor, odState, canTakeOd, openOdNodes, sanitizeOd, odMods, neutralOd, type OdNode,
} from '../../src/data/overdriveTree';
import { HULLS, type OverdriveKind, type HullId } from '../../src/data/hulls';
import { newRun, saveRun, loadRun, migrateRunSave, takeOd, odPrice, SAVE_KEY } from '../../src/game/run';
import { buildToGhost } from '../../src/data/parts';
import { odScenario, type OdResult } from '../sim/odScenario';

const KINDS: OverdriveKind[] = ['lance', 'wing', 'spear', 'bulwark'];
const HULL_OF: Record<OverdriveKind, HullId> = { lance: 'vanguard', wing: 'leviathan', spear: 'lance', bulwark: 'bastion' };

describe('overdrive tree data', () => {
  it('every Overdrive has 2-3 paths, each with two tier-2 refits and a capstone, ids unique', () => {
    expect(new Set(OD_NODES.map((x) => x.id)).size).toBe(OD_NODES.length);
    for (const k of KINDS) {
      const ns = odNodesFor(k), paths = ns.filter((x) => x.tier === 1);
      expect(paths.length, k).toBeGreaterThanOrEqual(2); expect(paths.length, k).toBeLessThanOrEqual(3);
      for (const p of paths) {
        expect(p.requires).toBeUndefined();
        expect(ns.filter((x) => x.tier === 2 && x.requires === p.id).length, p.id).toBe(2);
        expect(ns.filter((x) => x.tier === 3 && x.requires === p.id).length, p.id).toBe(1);
      }
      for (const x of ns.filter((q) => q.tier > 1)) { expect(OD_NODE[x.requires!]?.tier, x.id).toBe(1); expect(OD_NODE[x.requires!].kind).toBe(k); }
      for (const x of ns) { expect(x.cost).toBeGreaterThan(0); expect(x.name.length).toBeGreaterThan(2); expect(Object.keys(x.fx).length, x.id).toBeGreaterThan(0); }
    }
  });
  it('a tier-1 pick closes the other paths; a pick closes its tier siblings; tiers open in order', () => {
    const [a, b] = odNodesFor('lance').filter((x) => x.tier === 1);
    const a2 = odNodesFor('lance').filter((x) => x.tier === 2 && x.requires === a.id), a3 = odNodesFor('lance').find((x) => x.tier === 3 && x.requires === a.id)!;
    const b2 = odNodesFor('lance').find((x) => x.tier === 2 && x.requires === b.id)!;
    expect(openOdNodes('lance', []).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(odState(a2[0].id, [])).toBe('later');
    expect(odState(a3.id, [a.id])).toBe('later');
    const t = [a.id];
    expect(odState(b.id, t)).toBe('locked');
    expect(odState(b2.id, t)).toBe('locked');
    expect(openOdNodes('lance', t).map((x) => x.id).sort()).toEqual(a2.map((x) => x.id).sort());
    t.push(a2[0].id);
    expect(odState(a2[1].id, t)).toBe('locked');
    expect(canTakeOd(a3.id, t)).toBe(true);
    t.push(a3.id);
    expect(openOdNodes('lance', t)).toEqual([]);
    // other kinds are untouched
    expect(openOdNodes('wing', t).length).toBe(3);
  });
  it('sanitizes untrusted pick lists and folds effects', () => {
    expect(sanitizeOd(['lance_core', 'lance_sweep', 'lance_pierce', 'nope', 'lance_swath', 'lance_twin', 'lance_sky'])).toEqual(['lance_sweep', 'lance_swath', 'lance_twin']);
    expect(sanitizeOd('x')).toEqual([]);
    expect(odMods('lance', [])).toEqual(neutralOd());
    const m = odMods('lance', ['lance_sweep', 'lance_swath']);
    expect(m.width).toBeCloseTo(1.5 * 1.3); expect(m.dmg).toBeCloseTo(1.15); expect(m.follow).toBe(true);
    expect(odMods('wing', ['lance_sweep'])).toEqual(neutralOd());
    expect(odMods('bulwark', ['bulwark_bastion', 'bulwark_iron']).taken).toBe(0.3);
    expect(odMods('bulwark', ['bulwark_mend', 'bulwark_crews', 'bulwark_phoenix']).mend).toBeCloseTo(0.025 * 1.6 * 1.5);
  });
});

describe('overdrive picks in the run', () => {
  beforeEach(() => memoryStore.clear());
  it('commissions are spent first, then scrap; the wrong hull or a closed node is refused', () => {
    const r = newRun('OD', 3); r.scrap = 100;
    expect(takeOd(r, 'wing_swarm')).toBeNull(); // a Vanguard flies the Lance
    r.odCredits = 1;
    expect(odPrice(r, 'lance_sweep')).toBe(0);
    expect(takeOd(r, 'lance_sweep')).toEqual({ cost: 0, credit: true });
    expect(r.odCredits).toBe(0); expect(r.scrap).toBe(100);
    expect(takeOd(r, 'lance_pierce')).toBeNull();
    expect(takeOd(r, 'lance_swath')).toBeNull(); // 150 scrap, 100 held
    r.scrap = 400;
    expect(takeOd(r, 'lance_swath', 1.2)).toEqual({ cost: 180, credit: false });
    expect(r.scrap).toBe(220); expect(r.od).toEqual(['lance_sweep', 'lance_swath']);
  });
  it('save v4 round-trips the picks; a v3 save migrates with no picks and a commission per boss beaten', () => {
    const r = newRun('OD', 4); r.od = ['lance_pierce', 'lance_long']; r.odCredits = 2;
    saveRun(r);
    expect(SAVE_KEY).toBe('gd.run.v4');
    const back = loadRun()!;
    expect(back.v).toBe(4); expect(back.od).toEqual(['lance_pierce', 'lance_long']); expect(back.odCredits).toBe(2);
    memoryStore.clear();
    const v3 = { ...r, v: 3, build: buildToGhost(r.build), inv: [], stats: { ...r.stats, bosses: 2 } } as any;
    delete v3.od; delete v3.odCredits;
    memoryStore.set('gd.run.v3', JSON.stringify(v3));
    const mig = loadRun()!;
    expect(mig.v).toBe(4); expect(mig.od).toEqual([]); expect(mig.odCredits).toBe(2);
    expect(migrateRunSave({ ...v3, v: 3 }).od).toEqual([]);
    // tampered picks are dropped, and picks for another hull's Overdrive too
    memoryStore.set(SAVE_KEY, JSON.stringify({ ...JSON.parse(memoryStore.get(SAVE_KEY) ?? '{}'), ...v3, v: 4, od: ['lance_long', 'wing_swarm', 'lance_sweep'], odCredits: 99 }));
    const bad = loadRun()!;
    expect(bad.od).toEqual(['lance_sweep']); expect(bad.odCredits).toBe(9);
  });
});

/** The picks that lead to node x: its path's tier-1 node, and for a capstone the first tier-2 refit on the path. */
function prefix(x: OdNode): string[] {
  if (x.tier === 1) return [];
  const t2 = OD_NODES.find((q) => q.tier === 2 && q.requires === x.requires)!;
  return x.tier === 2 ? [x.requires!] : [x.requires!, t2.id];
}
const rel = (a: number, b: number, floor = 1) => Math.abs(a - b) / Math.max(floor, Math.abs(a), Math.abs(b));
const diff = (a: OdResult, b: OdResult) => Math.max(rel(a.dealt, b.dealt), rel(a.taken, b.taken), rel(a.hp, b.hp), rel(a.scrap, b.scrap), rel(a.charge, b.charge, 0.01), rel(a.shots, b.shots));

describe('every refit changes the fight', () => {
  for (const k of KINDS) {
    it(`${k}: each node measurably changes what the Overdrive does`, () => {
      const cache = new Map<string, OdResult>();
      const run = (p: string[]) => { const key = p.join(','); if (!cache.has(key)) cache.set(key, odScenario(HULL_OF[k], p)); return cache.get(key)!; };
      for (const x of odNodesFor(k)) {
        const pre = prefix(x), a = run(pre), b = run([...pre, x.id]);
        expect(diff(a, b), `${x.id}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeGreaterThan(0.05);
      }
    }, 60_000);
  }
  it('the headline effects point the right way', () => {
    const base = odScenario('vanguard', []), core = odScenario('vanguard', ['lance_pierce', 'lance_core']), pierce = odScenario('vanguard', ['lance_pierce']);
    expect(core.dealt).toBeGreaterThan(pierce.dealt);
    void base;
    const b0 = odScenario('bastion', []), iron = odScenario('bastion', ['bulwark_bastion']), mend = odScenario('bastion', ['bulwark_mend']);
    expect(iron.taken).toBeLessThan(b0.taken);
    expect(mend.hp).toBeGreaterThan(b0.hp);
    const w0 = odScenario('leviathan', []), swarm = odScenario('leviathan', ['wing_swarm']), inter = odScenario('leviathan', ['wing_intercept']);
    expect(swarm.dealt).toBeGreaterThan(w0.dealt);
    expect(inter.taken).toBeLessThan(w0.taken);
    const s0 = odScenario('lance', []), fan = odScenario('lance', ['spear_fan']);
    expect(fan.dealt).toBeGreaterThan(s0.dealt);
  }, 60_000);
});

void HULLS;
