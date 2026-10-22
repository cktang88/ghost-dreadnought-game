import { describe, it, expect } from 'vitest';
import { derive, mkPart } from '../../src/data/parts';
import { mountTraverse, aimYaw, holdYaw, gunCount } from '../../src/render/ship/arcs';

// Renderer yaw: 0 at the bow, +PI/2 to port. Field bearings: atan2(dy, dx) with y down the screen.
describe('ship gun traverse (render, on the shared mount traverse)', () => {
  const dv = derive({ sections: [
    { type: 'bridge', slots: [mkPart('pulse', 1)] },
    { type: 'gundeck', slots: [mkPart('flak', 1), mkPart('missile', 1)] },
    { type: 'battery', slots: [mkPart('pulse', 1), mkPart('pulse', 1), mkPart('rail', 1)] },
    { type: 'battery', slots: [mkPart('tesla', 1), mkPart('artillery', 1), mkPart('bomb', 1)] },
  ] });
  const tr = (si: number, i: number) => mountTraverse(dv.mounts.find((q) => q.si === si && q.i === i)!);
  const RIGHT = 0, UP = -Math.PI / 2, LEFT = Math.PI, DOWN = Math.PI / 2;

  it('dresses each mount by where it sits', () => {
    expect(tr(0, 0).kind).toBe('bow');
    expect(tr(1, 0).kind).toBe('dorsal');
    expect(tr(2, 0).kind).toBe('side');
    expect(tr(3, 0).kind).toBe('omni');
    expect(tr(3, 1).kind).toBe('ventral');
    expect(tr(3, 2).kind).toBe('ventral');
  });

  it('dorsal guns are anti-air and train round their facing, short of dead astern', () => {
    expect(tr(1, 0).layer).toBe('air');
    expect(Math.abs(aimYaw(tr(1, 0), DOWN, false, 0))).toBeLessThan(Math.PI - 0.5);
  });

  it('broadside guns rest outboard and train only across their own beam', () => {
    const port = tr(2, 0), star = tr(2, 2);
    expect(port.center).toBeCloseTo(Math.PI / 2);
    expect(star.center).toBeCloseTo(-Math.PI / 2);
    expect(aimYaw(port, LEFT, false, port.center)).toBeCloseTo(Math.PI / 2);
    expect(aimYaw(star, RIGHT, false, star.center)).toBeCloseTo(-Math.PI / 2);
    // A target across the hull: back to rest, not swung through the deck.
    expect(aimYaw(port, RIGHT, false, port.center)).toBeCloseTo(port.center);
    expect(Math.abs(holdYaw(star, 0) - star.center)).toBeLessThanOrEqual(star.half + 1e-9);
  });

  it('ghosts are mirrored: a starboard ghost gun trains toward screen right', () => {
    const star = tr(2, 2);
    expect(aimYaw(star, RIGHT, true, star.center)).toBeCloseTo(-Math.PI / 2);
    expect(aimYaw(star, LEFT, true, star.center)).toBeCloseTo(star.center);
  });

  it('bow casemates stay in their forward cone', () => {
    const bow = tr(0, 0);
    expect(aimYaw(bow, UP, false, 0)).toBeCloseTo(0);
    expect(Math.abs(aimYaw(bow, UP + 0.5, false, 0))).toBeLessThanOrEqual(bow.half + 1e-9);
  });

  it('heavier tiers field more guns per mount', () => {
    expect(gunCount('pulse', 1)).toBeLessThan(gunCount('pulse', 5));
  });
});
