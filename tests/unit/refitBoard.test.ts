import { describe, it, expect } from 'vitest';
import { derive, mkPart, SECTIONS, type Build, type SectionType } from '../../src/data/parts';
import { HULLS, HULL_IDS } from '../../src/data/hulls';
import { mountDrawPos, planExtent } from '../../src/render/shipPreview';
import {
  layoutBoard, resolve1D, segmentsCross, countCrossings, segmentHitsRect, STACK_BELOW,
  checkMove, applyMove, previewMove, moveSection, canMoveSection, cutSection, firepower, statDeltas, type Anchor,
  coverage, quarters, weakestQuarter, rotateMount, rotateWhy, arcView, intersectSectors, mountDps, ROSE_BINS,
} from '../../src/ui/refitLogic';

// Anchors exactly as the board computes them: where each mount is drawn on the plan.
const anchorsOf = (b: Build): Anchor[] => {
  const d = derive(b);
  return d.mounts.map((m) => { const [ox, oy] = mountDrawPos(d, m); return { id: `${m.si}-${m.i}`, ox, oy, si: m.si, i: m.i, bow: m.si === 0 && b.sections[0].type === 'bridge' }; });
};
const armed = (b: Build): Build => ({ sections: b.sections.map((s) => ({ type: s.type, slots: SECTIONS[s.type].slots.map((k, i) => mkPart(k === 'W' ? (i === 1 ? 'bomb' : 'pulse') : 'plate', 1)) })) });
const build = (...types: SectionType[]): Build => ({ sections: types.map((t) => ({ type: t, slots: SECTIONS[t].slots.map(() => null) })) });
const BUILDS: [string, Build][] = [
  ...HULL_IDS.map((h) => [h, HULLS[h].build()] as [string, Build]),
  ['max batteries', build('bridge', 'battery', 'battery', 'battery', 'battery', 'battery', 'battery', 'battery')],
  ['max batteries armed', armed(build('bridge', 'battery', 'battery', 'battery', 'battery', 'battery', 'battery', 'battery'))],
  ['mixed eight armed', armed(build('bridge', 'gundeck', 'battery', 'spine', 'armor', 'battery', 'gundeck', 'engine'))],
  ['mixed eight', build('bridge', 'gundeck', 'battery', 'spine', 'armor', 'battery', 'gundeck', 'engine')],
  ['bridge only', build('bridge')],
  ['bridge amidships armed', armed(build('gundeck', 'battery', 'gundeck', 'bridge', 'battery', 'gundeck', 'engine', 'engine'))],
  ['bridge astern', armed(build('battery', 'gundeck', 'battery', 'gundeck', 'bridge'))],
  ['long spine', build('bridge', 'spine', 'spine', 'spine', 'engine', 'engine', 'engine', 'engine')],
];
const SIZES: [number, number][] = [[940, 760], [700, 640], [1200, 820], [660, 560]];

describe('refit board layout', () => {
  it('resolve1D keeps order, spacing and bounds', () => {
    const p = resolve1D([10, 12, 14, 300], 40, 8, 0, 320);
    for (let k = 1; k < p.length; k++) expect(p[k] - p[k - 1]).toBeGreaterThanOrEqual(48 - 1e-9);
    expect(p[0]).toBeGreaterThanOrEqual(0);
    expect(p[p.length - 1] + 40).toBeLessThanOrEqual(320 + 1e-9);
  });
  it('segment crossing test', () => {
    expect(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsCross([0, 0], [10, 0], [0, 5], [10, 5])).toBe(false);
    expect(segmentsCross([0, 0], [10, 10], [10, 10], [20, 0])).toBe(false); // shared end
    expect(segmentHitsRect([0, 5], [20, 5], { x: 8, y: 0, w: 8, h: 10 })).toBe(true);
    expect(segmentHitsRect([0, 20], [20, 20], { x: 8, y: 0, w: 4, h: 10 })).toBe(false);
  });
  for (const [name, b] of BUILDS) for (const [w, h] of SIZES) it(`${name} at ${w}x${h}: tiles fit, never overlap, leaders never cross`, () => {
    const d = derive(b), anchors = anchorsOf(b);
    const L = layoutBoard({ w, h, len: d.len, width: d.width, anchors, ...planExtent(d) });
    expect(L.mode).toBe('callout');
    // The whole plan, pointed bow and stern included, fits between the top tiles and the bottom edge.
    const ext = planExtent(d), top = L.ship.cy + (-d.len / 2 - ext.lead) * L.ship.s, bot = L.ship.cy + (d.len / 2 + ext.tail) * L.ship.s;
    expect(bot).toBeLessThanOrEqual(h + 0.5);
    const tops = L.tiles.filter((t) => t.side === 'top');
    if (tops.length) expect(top).toBeGreaterThan(Math.max(...tops.map((t) => t.y + t.h)));
    expect(L.tiles.length).toBe(anchors.length);
    for (const t of L.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-0.5); expect(t.y).toBeGreaterThanOrEqual(-0.5);
      expect(t.x + t.w).toBeLessThanOrEqual(w + 0.5); expect(t.y + t.h).toBeLessThanOrEqual(h + 0.5);
    }
    for (let i = 0; i < L.tiles.length; i++) for (let j = i + 1; j < L.tiles.length; j++) {
      const a = L.tiles[i], c = L.tiles[j];
      const overlap = a.x < c.x + c.w - 0.5 && c.x < a.x + a.w - 0.5 && a.y < c.y + c.h - 0.5 && c.y < a.y + a.h - 0.5;
      expect(overlap, `${a.id} overlaps ${c.id}`).toBe(false);
    }
    expect(countCrossings(L.leaders)).toBe(0);
    // A leader never runs through another tile.
    for (const l of L.leaders) for (const t of L.tiles) if (t.id !== l.id)
      for (let k = 0; k < l.pts.length - 1; k++) expect(segmentHitsRect(l.pts[k], l.pts[k + 1], t), `${l.id} through ${t.id}`).toBe(false);
    // Port mounts on the left, starboard on the right, the bow mount on top; the ship sits between the columns.
    const dvA = Object.fromEntries(anchors.map((a) => [a.id, a]));
    for (const t of L.tiles) {
      const a = dvA[t.id];
      if (a.bow) expect(t.side).toBe('top');
      else if (a.ox < -1) expect(t.side).toBe('left');
      else if (a.ox > 1) expect(t.side).toBe('right');
    }
    const lefts = L.tiles.filter((t) => t.side === 'left'), rights = L.tiles.filter((t) => t.side === 'right');
    expect(Math.abs(lefts.length - rights.length)).toBeLessThanOrEqual(Math.max(1, Math.abs(anchors.filter((a) => a.ox < -1).length - anchors.filter((a) => a.ox > 1).length)));
    const hw = (d.width / 2) * L.ship.s;
    if (lefts.length) expect(L.ship.cx - hw).toBeGreaterThan(Math.max(...lefts.map((t) => t.x + t.w)));
    if (rights.length) expect(L.ship.cx + hw).toBeLessThan(Math.min(...rights.map((t) => t.x)));
  });
  it('stacks into a numbered list on a phone', () => {
    const b = HULLS.vanguard.build(), d = derive(b);
    const L = layoutBoard({ w: 358, h: 0, len: d.len, width: d.width, anchors: anchorsOf(b) });
    expect(358).toBeLessThan(STACK_BELOW);
    expect(L.mode).toBe('stacked');
    expect(L.tiles.map((t) => t.n)).toEqual([1, 2, 3, 4, 5]);
    expect(L.tiles[0].id).toBe('0-0'); // the bow gun is number 1
    for (const t of L.tiles) expect(t.x + t.w).toBeLessThanOrEqual(358 + 0.5);
    expect(L.h).toBeGreaterThan(L.tiles[L.tiles.length - 1].y);
  });
});

describe('refit moves', () => {
  const fresh = () => ({ b: HULLS.vanguard.build(), inv: [mkPart('plate', 1), mkPart('flak', 2)] });
  it('a part only fits its own slot kind', () => {
    const { b, inv } = fresh();
    expect(checkMove(b, inv, { k: 'inv', i: 0 }, { k: 'slot', si: 0, i: 0 })).toMatchObject({ ok: false, why: 'kind' });
    expect(checkMove(b, inv, { k: 'inv', i: 0 }, { k: 'slot', si: 2, i: 0 })).toMatchObject({ ok: true, out: null });
    expect(checkMove(b, inv, { k: 'slot', si: 1, i: 0 }, { k: 'slot', si: 1, i: 0 }).why).toBe('same');
    expect(checkMove(b, inv, { k: 'inv', i: 1 }, { k: 'hold' }).why).toBe('noop');
  });
  it('hold to mount sends the old part to the hold; mount to mount swaps; mount to hold unmounts', () => {
    const { b, inv } = fresh();
    const old = b.sections[1].slots[0]!, flak = inv[1];
    applyMove(b, inv, { k: 'inv', i: 1 }, { k: 'slot', si: 1, i: 0 });
    expect(b.sections[1].slots[0]).toBe(flak); expect(inv).toContain(old); expect(inv).not.toContain(flak);
    const bow = b.sections[0].slots[0]!;
    applyMove(b, inv, { k: 'slot', si: 1, i: 0 }, { k: 'slot', si: 0, i: 0 });
    expect(b.sections[0].slots[0]).toBe(flak); expect(b.sections[1].slots[0]).toBe(bow);
    const n = inv.length;
    applyMove(b, inv, { k: 'slot', si: 0, i: 0 }, { k: 'hold' });
    expect(b.sections[0].slots[0]).toBe(null); expect(inv.length).toBe(n + 1);
  });
  it('previews leave the real build alone and show the change', () => {
    const { b, inv } = fresh(), d0 = derive(b);
    const nb = previewMove(b, inv, { k: 'inv', i: 0 }, { k: 'slot', si: 2, i: 0 })!;
    expect(b.sections[2].slots[0]).toBe(null);
    const dl = statDeltas(d0, derive(nb));
    expect(dl.hull).toEqual({ d: 35, good: true });
    // a pulse gun moved from a broadside to... an empty slot of the wrong kind is refused
    expect(previewMove(b, inv, { k: 'slot', si: 1, i: 0 }, { k: 'slot', si: 2, i: 0 })).toBe(null);
    // a market part needs the scrap
    const m = { k: 'market' as const, i: 0, part: mkPart('pulse', 1), price: 50, afford: false };
    expect(checkMove(b, inv, m, { k: 'slot', si: 0, i: 0 }).why).toBe('scrap');
    expect(previewMove(b, inv, { ...m, afford: true }, { k: 'slot', si: 0, i: 0 })!.sections[0].slots[0]!.id).toBe('pulse');
  });
  it('top-deck guns add anti-air only; bow guns reach both', () => {
    const b = build('bridge', 'gundeck');
    b.sections[1].slots[0] = mkPart('pulse', 1);
    const f1 = firepower(derive(b));
    expect(f1.air).toBeGreaterThan(0); expect(f1.ground).toBe(0);
    b.sections[0].slots[0] = mkPart('pulse', 1);
    const f2 = firepower(derive(b));
    expect(f2.ground).toBeGreaterThan(0); expect(f2.air).toBeCloseTo(f1.air * 2);
  });
  it('sections reorder anywhere, the bridge too, and cut loose into the hold', () => {
    const b = HULLS.lance.build(), inv: ReturnType<typeof mkPart>[] = [];
    expect(canMoveSection(b, 2, 2)).toBe(false);
    expect(canMoveSection(b, 9, 0)).toBe(false);
    expect(moveSection(b, 4, 1)).toBe(true);
    expect(b.sections.map((s) => s.type)).toEqual(['bridge', 'engine', 'gundeck', 'gundeck', 'engine']);
    expect(moveSection(b, 0, 2)).toBe(true);
    expect(b.sections.map((s) => s.type)).toEqual(['engine', 'gundeck', 'bridge', 'gundeck', 'engine']);
    expect(moveSection(b, 2, 0)).toBe(true);
    expect(cutSection(b, inv, 0)).toBe(null);
    expect(cutSection(b, inv, 2)!.type).toBe('gundeck');
    expect(inv.map((p) => p.id)).toEqual(['pulse', 'pulse']);
  });
});

describe('facing and coverage', () => {
  const starter = () => HULLS.vanguard.build();
  it('rotating a sponson aft swings its fire astern; the rose sees it', () => {
    const b = starter(), aft = (bb: Build) => quarters(coverage(derive(bb))).find((q) => q.key === 'aft')!.air;
    const before = aft(b), si = b.sections.findIndex((s) => s.type === 'battery');
    expect(rotateWhy(b, si, 2)).toBe(null);
    expect(rotateMount(b, si, 2, 1)).toBe(true); // starboard abeam -> aft-starboard
    expect(derive(b).mounts.find((m) => m.si === si && m.i === 2)!.facing).toBe(3);
    expect(aft(b)).toBeGreaterThan(before);
  });
  it('coverage sums each mount on the bearings its masked arc covers, and matches firepower', () => {
    const b = build('bridge', 'gundeck'); b.sections[1].slots[0] = mkPart('pulse', 1);
    const d = derive(b), cov = coverage(d), dps = mountDps(d, d.mounts[1]).air;
    expect(cov.air.length).toBe(ROSE_BINS);
    expect(Math.max(...cov.air)).toBeCloseTo(dps);
    expect(cov.air[0]).toBe(0); // dead ahead: the bridge tower masks the turret behind it
    expect(Math.max(...cov.ground)).toBe(0);
    expect(firepower(d).air).toBeCloseTo(dps);
  });
  it('calls out the weakest quarter: a bow gun alone leaves it blind astern', () => {
    const b = build('bridge', 'engine'); b.sections[0].slots[0] = mkPart('pulse', 1);
    const g = weakestQuarter(coverage(derive(b)));
    expect(g.severity).toBe('blind'); expect(g.label).toBe('BLIND ASTERN');
    const s = starter(), gs = weakestQuarter(coverage(derive(s)));
    expect(gs.label).toBe('NO AA ASTERN'); // the bomb bay reaches all round, the guns do not
  });
  it('bays, bombs and all-round weapons cannot be rotated', () => {
    const b = starter(), si = b.sections.findIndex((s) => s.type === 'battery');
    expect(rotateWhy(b, si, 1)).toMatch(/belly/);
    expect(rotateWhy(b, b.sections.findIndex((s) => s.type === 'engine'), 0)).toMatch(/Utility/);
    b.sections[si].slots[1] = mkPart('pd', 1);
    expect(rotateWhy(b, si, 1)).toMatch(/All-round/);
    b.sections[si].slots[1] = null;
    expect(rotateWhy(b, si, 1)).toBe(null); // an empty weapon mount can be pre-aimed
  });
  it('arc views clip what blocks a gun to its own arc', () => {
    const b = build('bridge', 'gundeck'); b.sections[1].slots[0] = mkPart('pulse', 1);
    const av = arcView(derive(b), 1, 0)!;
    expect(av.blocked.length).toBe(1); expect(av.blocked[0].by).toBe('bridge');
    expect(Math.abs(av.blocked[0].c)).toBeLessThan(0.05);
    expect(intersectSectors([{ c: 3, h: 0.3 }], [{ c: -3, h: 0.3 }]).length).toBe(1); // across the stern seam
  });
});
