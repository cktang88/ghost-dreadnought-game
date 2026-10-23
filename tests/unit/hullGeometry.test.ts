import { describe, it, expect } from 'vitest';
import { derive, mkPart, inTraverse, mountTraverse, SECTIONS, RANGE, canPlace, pinLayout, layoutIssue, layoutOf, attachSpots, mountRing, allowedFacings, mountFacing, buildToGhost, ghostToBuild, starterBuild, type Build } from '../../src/data/parts';
import { rotateMount, placeModule, canCutSection, upgradeRing } from '../../src/ui/refitLogic';
import { validateGhost } from '../../server/validate.mjs';

const UP = -Math.PI / 2, DOWN = Math.PI / 2;
const turretBuild = (order: ('bridge' | 'gundeck' | 'engine')[]): Build => ({
  sections: order.map((type) => ({ type, slots: type === 'bridge' ? [mkPart('pulse', 1)] : type === 'gundeck' ? [mkPart('pulse', 1), mkPart('pulse', 1)] : [null] })),
});

describe('hull geometry: long, narrow ships', () => {
  it('a starter hull is at least twice as long as it is wide', () => {
    const d = derive(starterBuild());
    expect(d.len / d.width).toBeGreaterThan(2);
  });
  it('mounts spread out along the keel: section order moves guns', () => {
    const a = derive(turretBuild(['bridge', 'gundeck', 'engine'])), b = derive(turretBuild(['gundeck', 'bridge', 'engine']));
    const ya = a.mounts.find((m) => a.rects[m.si].type === 'gundeck')!.oy, yb = b.mounts.find((m) => b.rects[m.si].type === 'gundeck')!.oy;
    expect(ya - yb).toBeGreaterThan(60);
  });
});

describe('hull shadows: position decides what a gun can see', () => {
  it('the bridge tower blocks a turret behind it from firing dead ahead, and the nearer the wider', () => {
    const d = derive(turretBuild(['bridge', 'gundeck', 'gundeck', 'gundeck']));
    const fwd = d.mounts.filter((m) => m.arc === 'dorsal');
    expect(inTraverse(fwd[0].trav, UP)).toBe(false);
    expect(fwd[0].trav.blocked[0].by).toBe('bridge');
    const w = (i: number) => fwd[i].trav.blocked.find((s) => s.by === 'bridge')!.h;
    expect(w(0)).toBeGreaterThan(w(fwd.length - 1) * 2);
  });
  it('a turret ahead of the bridge fires dead ahead, but the tower blocks it aft', () => {
    const d = derive({ sections: [
      { type: 'gundeck', slots: [mkPart('pulse', 1), mkPart('pulse', 1)], face: [4, 4] },
      { type: 'bridge', slots: [mkPart('pulse', 1)] },
    ] });
    const g = d.mounts.filter((m) => m.arc === 'dorsal');
    expect(inTraverse(mountTraverse('gundeck', 'W', 'pulse', 0), UP)).toBe(true);
    expect(inTraverse(g[1].trav, DOWN)).toBe(false); // the tower is right behind it
  });
  it('engine funnels block turrets ahead of them from firing astern', () => {
    const d = derive({ sections: [
      { type: 'bridge', slots: [mkPart('pulse', 1)] },
      { type: 'gundeck', slots: [mkPart('pulse', 1), mkPart('pulse', 1)], face: [4, 4] },
      { type: 'engine', slots: [null] },
    ] });
    const aft = d.mounts.filter((m) => m.arc === 'dorsal')[1];
    expect(inTraverse(aft.trav, DOWN)).toBe(false);
    expect(aft.trav.blocked.some((s) => s.by === 'engine')).toBe(true);
  });
  it('a sponson angled forward is blocked by the battery sponson ahead of it', () => {
    const d = derive({ sections: [
      { type: 'bridge', slots: [mkPart('pulse', 1)] },
      { type: 'battery', slots: [mkPart('pulse', 1), null, mkPart('pulse', 1)] },
      { type: 'battery', slots: [mkPart('pulse', 1), null, mkPart('pulse', 1)], face: [7, 0, 1] },
    ] });
    const rear = d.mounts.filter((m) => m.si === 2 && m.part);
    for (const m of rear) expect(m.trav.blocked.some((s) => s.by === 'battery')).toBe(true);
  });
});


describe('facing', () => {
  it('each mount type has its own allowed facings', () => {
    expect(allowedFacings('bridge', 0)).toEqual([7, 0, 1]);
    expect(allowedFacings('battery', 0)).toEqual([7, 6, 5]);
    expect(allowedFacings('battery', 2)).toEqual([1, 2, 3]);
    expect(allowedFacings('gundeck', 1)).toHaveLength(8);
    expect(allowedFacings('spine', 0)).toEqual([]);
  });
  it('rotating walks the allowed facings and turns the arc', () => {
    const b: Build = { sections: [{ type: 'bridge', slots: [mkPart('pulse', 1)] }, { type: 'battery', slots: [mkPart('pulse', 1), null, mkPart('pulse', 1)] }] };
    expect(rotateMount(b, 1, 2, 1)).toBe(true);
    expect(mountFacing(b.sections[1], 2)).toBe(3);
    expect(rotateMount(b, 1, 2, 1)).toBe(true);
    expect(mountFacing(b.sections[1], 2)).toBe(1); // wraps past the hull side back to fore-starboard
    const m = derive(b).mounts.find((x) => x.si === 1 && x.i === 2)!;
    expect(inTraverse(m.trav, UP + 0.1)).toBe(true);
    expect(rotateMount(b, 0, 0, -1)).toBe(true);
    expect(mountFacing(b.sections[0], 0)).toBe(7);
  });
  it('facings survive the ghost round trip and server validation; invalid ones fall back', () => {
    const b: Build = { sections: [{ type: 'bridge', slots: [mkPart('pulse', 1)], face: [1] }, { type: 'gundeck', slots: [null, null], face: [5, 3] }] };
    const g = buildToGhost(b);
    const v = validateGhost({ sector: 1, sections: g, name: 'x', pilot: 'p' })!;
    const back = ghostToBuild(v.sections);
    expect(mountFacing(back.sections[0], 0)).toBe(1);
    expect(mountFacing(back.sections[1], 1)).toBe(3);
    expect(mountFacing({ type: 'bridge', slots: [null], face: [4] }, 0)).toBe(0); // a bridge gun cannot face aft
  });
});

describe('module grid', () => {
  const base = (): Build => ({ sections: [
    { type: 'bridge', slots: [mkPart('pulse', 1)] },
    { type: 'battery', slots: [mkPart('pulse', 1), null, mkPart('pulse', 1)] },
    { type: 'gundeck', slots: [mkPart('pulse', 1), null] },
  ] });
  it('modules can sit side by side, making a wider ship', () => {
    const b = base();
    expect(placeModule(b, 2, [SECTIONS.battery.w / 2 + SECTIONS.gundeck.w / 2, 30])).toBe(true);
    const d = derive(b);
    expect(d.width).toBeGreaterThan(derive(base()).width);
    // the gun deck beside the battery now masks its starboard sponson
    const stbd = d.mounts.find((m) => m.si === 1 && m.i === 2)!;
    expect(stbd.trav.blocked.some((s) => s.by === 'gundeck')).toBe(true);
  });
  it('refuses overlaps and loose modules; cutting cannot split the hull', () => {
    const b = base();
    expect(canPlace(b, 2, [0, 0])).toMatch(/overlap/);
    expect(canPlace(b, 2, [200, 0])).toMatch(/join/);
    pinLayout(b);
    expect(canCutSection(b, 1)).toBe(false); // the battery holds the gun deck to the bridge
    expect(canCutSection(b, 2)).toBe(true);
  });
  it('a new module without a spot goes astern; spots to attach are offered', () => {
    const b = base(); pinLayout(b);
    b.sections.push({ type: 'engine', slots: [null] });
    expect(layoutIssue(b)).toBe(null);
    expect(attachSpots(b, 'engine').length).toBeGreaterThan(4);
  });
  it('turret rings widen the arc: 120 -> 180 -> 360 on the top deck', () => {
    const b: Build = { sections: [{ type: 'gundeck', slots: [mkPart('pulse', 1), null] }, { type: 'bridge', slots: [null] }] };
    const span = () => derive(b).mounts[0].trav.sectors.reduce((n, s) => n + 2 * s.h, 0);
    expect(span()).toBeCloseTo((2 * Math.PI) / 3, 1);
    expect(upgradeRing(b, 0, 0)).toBe(true);
    expect(span()).toBeCloseTo(Math.PI, 1);
    expect(upgradeRing(b, 0, 0)).toBe(true);
    expect(span()).toBeGreaterThan(1.8 * Math.PI - 0.6); // full ring, less the bridge tower astern
    expect(upgradeRing(b, 0, 0)).toBe(false);
    expect(derive(b).mounts[0].range).toBe(RANGE.dorsal);
  });
  it('grid places, rings and facings survive the ghost round trip', () => {
    const b = base(); placeModule(b, 2, [SECTIONS.battery.w / 2 + SECTIONS.gundeck.w / 2, 30]); upgradeRing(b, 0, 0);
    const back = ghostToBuild(validateGhost({ sector: 1, sections: buildToGhost(b), name: 'x', pilot: 'p' })!.sections);
    expect(layoutOf(back)).toEqual(layoutOf(b));
    expect(mountRing(back.sections[0], 0)).toBe(2);
  });
});
