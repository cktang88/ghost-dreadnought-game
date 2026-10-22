// A fixed Overdrive proving ground for tests/unit/overdriveTree.test.ts: the hull parked mid-field, held targets in
// the air and on the ground at set distances (so beam width, reach, fan angle and count all matter), a steady
// stream of enemy fire at the hull, scrap lying out of reach, the scroll stopped. Fire the Overdrive with a set of
// tree picks, run it out, and read what changed.
import './env';
import { S, startCombat, updateCombat, endCombat, triggerOverdrive, feedOverdrive, type Enemy } from '../../src/game/combat';
import { HULLS, type HullId } from '../../src/data/hulls';
import { neutralMods } from '../../src/data/parts';
import { mulberry32 } from '../../src/util/rng';

export interface OdResult { dealt: number; taken: number; hp: number; scrap: number; charge: number; shots: number }
const enc = { id: 'od-test', name: 'Proving ground', kind: 'fight' as const, duration: 999, rate: 0, salvage: 0, weights: {} };

function hold(type: 'heli' | 'tank', layer: 'air' | 'ground', x: number, y: number, vx = 0): Enemy {
  const e = { type, layer, x, y, r: 12, hp: 1e6, maxHp: 1e6, t: 0, cd: 99, flash: 0, dead: false, ang: 0, hdg: 0, tele: 0, vx, life: 1e9, station: { x, y }, restation: 1e9 } as unknown as Enemy;
  S.enemies.push(e); return e;
}
export function odScenario(hull: HullId, picks: string[], sec = 14): OdResult {
  const real = Math.random; Math.random = mulberry32(5);
  try {
    const build = HULLS[hull].build();
    startCombat({ enc, level: 3, sector: 1, build, hp: 9999, relics: [], mods: neutralMods(), cheatDeathAvailable: false, overdrive: HULLS[hull].overdrive, odTree: picks });
    const P = S.P!; P.x = 800; P.y = 620; P.hp = P.dv.maxHp * 0.85; S.banner = null; S.enemies = [];
    // air: a column ahead (spear), a fan of offsets, a ring near the hull; ground: under and around the keel
    for (const dx of [-260, -160, -90, -40, 0, 40, 90, 160, 260]) for (const y of [120, 320]) hold('heli', 'air', P.x + dx, y);
    for (const [dx, dy] of [[0, 0], [60, 0], [-110, 30], [150, -60], [-200, -150], [85, 40], [-85, -40], [260, 120], [-300, 60]]) hold('tank', 'ground', P.x + dx, P.y + dy, dx > 0 ? -18 : 18);
    for (const a of [0.4, 1.2, 2.4, 3.4]) hold('heli', 'air', P.x + Math.cos(a) * 140, P.y + Math.sin(a) * 160);
    hold('heli', 'air', P.x + 75, P.y); // an aircraft hugging the beam, by the keel
    for (let i = 0; i < 8; i++) S.pickups.push({ x: 120 + i * 40, y: 120, vx: 0, vy: 0, val: 1, t: -1e9, kind: 'scrap' });
    S.overdrive.charge = 1; triggerOverdrive();
    const hp0 = P.hp;
    let k = 0;
    for (let t = 0; t < sec; t += 1 / 60) {
      S.scroll = 0; S.spawnCd = 1e9; P.vx = P.vy = 0; P.tx = P.ty = null; P.x = 800; P.y = 620;
      // a steady stream of fire at the hull from four bearings
      if (++k % 12 === 0) for (const a of [-2.6, -1.9, -1.2, -0.5]) { const sx = P.x + Math.cos(a) * 520, sy = P.y + Math.sin(a) * 520, d = Math.atan2(P.y - sy, P.x - sx); S.eb.push({ x: sx, y: sy, vx: Math.cos(d) * 220, vy: Math.sin(d) * 220, r: 4.5, dmg: 0.2, col: '#f00', kind: 'bullet', life: 8, t: 0, dead: false, src: 'test' }); }
      // telegraphed strikes on the hull: no aegis eats them, only damage reduction helps
      if (k % 60 === 0) S.eb.push({ kind: 'strike', x: P.x, y: P.y, delay: 0.5, rad: 40, dmg: 3, t: 0, life: 9, vx: 0, vy: 0, r: 0, dead: false, src: 'test' });
      // scrap that would never home on its own in this window (t pinned), so only a vacuum takes it
      for (const p of S.pickups) p.t = -1e9;
      updateCombat(1 / 60);
    }
    const shots = S.eb.length;
    S.overdrive.charge = 0; S.overdrive.active = false; S.mode = 'play'; feedOverdrive(0.1);
    const res = { dealt: S.stats.dmgDealt, taken: S.stats.dmgTaken, hp: P.hp - hp0, scrap: S.scrap, charge: S.overdrive.charge, shots };
    endCombat();
    return res;
  } finally { Math.random = real; }
}
