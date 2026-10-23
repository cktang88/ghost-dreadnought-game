// Hull classes: the meta-loop's big unlocks. Each has its own starting layout, starting hold and Overdrive.
import { mkPart, starterBuild, type Build, type Part } from './parts';

export type OverdriveKind = 'lance' | 'wing' | 'spear' | 'bulwark';
export interface OverdriveDef { name: string; desc: string; duration: number; col: string }

/**
 * Overdrive: the active skill on Space. It charges from destruction (S.overdrive.charge 0..1) and runs for
 * `duration` seconds once fired. Combat (src/game/combat.ts) implements each kind; the shapes the VFX layer draws
 * are documented in docs/TECH.md under "Gameplay state".
 */
export const OVERDRIVES: Record<OverdriveKind, OverdriveDef> = {
  lance: { name: 'Ventral Lance', duration: 3.6, col: '#ffb347', desc: 'A sustained beam from the keel to the ground. Steer it to carve a burning line through the city.' },
  wing: { name: 'Strike Wing', duration: 7, col: '#7fb6ff', desc: 'Launch eight strike craft that hunt everything on the field.' },
  spear: { name: 'Lance Spear', duration: 2.6, col: '#c9a6ff', desc: 'A spinal beam that burns a column straight up the field through anything in the air.' },
  bulwark: { name: 'Bulwark Aegis', duration: 5, col: '#4fd1e8', desc: 'A shockwave clears every shot in the sky, then a field eats incoming fire and halves damage.' },
};

export type HullId = 'vanguard' | 'leviathan' | 'lance' | 'bastion';
export interface HullDef {
  id: HullId; name: string; cls: string; desc: string; overdrive: OverdriveKind;
  /** Admiralty rank needed to fly it (rank 1 = everyone). */
  rank: number;
  build: () => Build; hold: () => Part[]; scrap: number;
}

export const HULLS: Record<HullId, HullDef> = {
  vanguard: {
    id: 'vanguard', name: 'Vanguard', cls: 'dreadnought', rank: 1, overdrive: 'lance', scrap: 60,
    desc: 'The line dreadnought. A bow gun, a broadside pair and a bomb bay: a little of every arc.',
    build: starterBuild, hold: () => [mkPart('plate', 1)],
  },
  leviathan: {
    id: 'leviathan', name: 'Leviathan', cls: 'carrier', rank: 2, overdrive: 'wing', scrap: 50,
    desc: 'A flight-deck carrier. Two escort drones from the start, flak broadsides, and a strike wing on Overdrive.',
    build: () => ({ sections: [
      { type: 'bridge', slots: [mkPart('pulse', 1)] },
      { type: 'spine', slots: [mkPart('drones', 3), mkPart('magnet', 1)] },
      { type: 'battery', slots: [mkPart('flak', 1), mkPart('bomb', 1), mkPart('flak', 1)] },
      { type: 'engine', slots: [null] },
    ] }),
    hold: () => [],
  },
  lance: {
    id: 'lance', name: 'Lance', cls: 'destroyer', rank: 4, overdrive: 'spear', scrap: 70,
    desc: 'A fast spinal-gun destroyer. No broadsides: everything points forward, with a rail spine on the bridge.',
    build: () => ({ sections: [
      { type: 'bridge', slots: [mkPart('rail', 1)] },
      { type: 'gundeck', slots: [mkPart('pulse', 1), mkPart('pulse', 1)], face: [1, 7] },
      { type: 'gundeck', slots: [mkPart('spread', 1), mkPart('bomb', 1)], face: [4, 0] },
      { type: 'engine', slots: [mkPart('thruster', 1)] },
      { type: 'engine', slots: [null] },
    ] }),
    hold: () => [],
  },
  bastion: {
    id: 'bastion', name: 'Bastion', cls: 'monitor', rank: 6, overdrive: 'bulwark', scrap: 40,
    desc: 'A slow armored monitor. Mortars, a broadside battery and plate; it does not dodge, it endures.',
    build: () => ({ sections: [
      { type: 'bridge', slots: [mkPart('pulse', 1)] },
      { type: 'armor', slots: [mkPart('plate', 1)] },
      { type: 'battery', slots: [mkPart('pulse', 1), mkPart('artillery', 1), mkPart('pulse', 1)] },
      { type: 'engine', slots: [null] },
    ] }),
    hold: () => [mkPart('shield', 1)],
  },
};
export const HULL_IDS = Object.keys(HULLS) as HullId[];
export const isHullId = (v: unknown): v is HullId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(HULLS, v);
