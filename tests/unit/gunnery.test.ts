import '../sim/env';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WEAPONS, mkPart, derive, weaponControl, weaponFamily, weaponGroups, mountTraverse, inTraverse, clampTraverse, shipToField,
  layersHit, MAGNET, TRAVERSE, neutralMods, type Build, type Mount,
} from '../../src/data/parts';
import { relicMods } from '../../src/data/relics';
import {
  S, H, AFT, startCombat, updateCombat, endCombat, gunnery, aim, selectGroup, cycleGroup, fireLog, spawnGroup, bossGunBears, type Enemy,
} from '../../src/game/combat';
import { FIGHTS, BOSS_ENCOUNTER } from '../../src/data/enemies';
import { mulberry32 } from '../../src/util/rng';
import type { Ghost } from '../../src/game/ghosts';

const P = (id: string, t = 1) => mkPart(id, t);
/** Bridge rail, a top-deck pulse + missile pair, a broadside of pulse / mortar / bomb. */
const testBuild = (): Build => ({ sections: [
  { type: 'bridge', slots: [P('rail')] },
  { type: 'gundeck', slots: [P('pulse'), P('missile')] },
  { type: 'battery', slots: [P('pulse'), P('artillery'), P('bomb')] },
  { type: 'engine', slots: [null] },
] });
const PI = Math.PI;

describe('weapon control split', () => {
  it('light guns, flak, coils and point defense are AUTO; rails, missiles, mortars and bombs are HEAVY', () => {
    for (const id of ['pulse', 'spread', 'flak', 'tesla', 'pd']) expect(weaponControl(id), id).toBe('auto');
    for (const id of ['rail', 'missile', 'artillery', 'bomb']) expect(weaponControl(id), id).toBe('heavy');
    for (const id of Object.keys(WEAPONS)) expect(['auto', 'heavy']).toContain(weaponControl(id));
    expect(weaponFamily('artillery')).toBe('mortar');
    expect(weaponFamily('pulse')).toBeNull();
  });
  it('numbers heavy groups 1.. by family, only for families the ship carries', () => {
    const g = weaponGroups(derive(testBuild()).mounts);
    expect(g.map((x) => [x.key, x.family, x.mounts.length])).toEqual([[1, 'rail', 1], [2, 'missile', 1], [3, 'mortar', 1], [4, 'bomb', 1]]);
    const starter = weaponGroups(derive({ sections: [{ type: 'bridge', slots: [P('pulse')] }, { type: 'battery', slots: [P('pulse'), P('bomb'), P('bomb')] }] }).mounts);
    expect(starter.map((x) => [x.key, x.family, x.mounts.length])).toEqual([[1, 'bomb', 2]]);
  });
});

describe('mount traverse arcs', () => {
  it('bow mounts get a forward cone for air and ground, top-deck turrets a ring-sized arc around their facing for air only', () => {
    const bow = mountTraverse('bridge', 'W', 'pulse');
    expect(bow).toMatchObject({ arc: 'bow', layers: 'both', sectors: [{ c: 0, h: TRAVERSE.bow }] });
    const top = mountTraverse('gundeck', 'W', 'pulse');
    expect(top).toMatchObject({ arc: 'dorsal', layers: 'air' });
    expect(top.sectors[0].h).toBeCloseTo(TRAVERSE.dorsal);
    // player ship: bow points up the screen (field angle -PI/2)
    expect(inTraverse(bow, -PI / 2)).toBe(true);
    expect(inTraverse(bow, -PI / 2 + TRAVERSE.bow - 0.01)).toBe(true);
    expect(inTraverse(bow, 0)).toBe(false);
    expect(inTraverse(bow, PI / 2)).toBe(false);
    expect(inTraverse(top, -PI / 2)).toBe(true);
    expect(inTraverse(top, 0)).toBe(false); // a standard ring (120°) does not reach abeam
    expect(inTraverse(mountTraverse('gundeck', 'W', 'pulse', 0, 2), 0)).toBe(true); // a wide ring (180°) does
    for (const a of [0, PI / 2, PI]) expect(inTraverse(mountTraverse('gundeck', 'W', 'pulse', 0, 3), a)).toBe(true); // full ring
    const aft = mountTraverse('gundeck', 'W', 'pulse', 4);
    expect(inTraverse(aft, PI / 2)).toBe(true);
    expect(inTraverse(aft, -PI / 2)).toBe(false);
  });
  it('broadside mounts cover their own flank where they face; never across the hull', () => {
    const port = mountTraverse('battery', 'W', 'pulse', 6), stbd = mountTraverse('battery', 'W', 'pulse', 2);
    expect(port.layers).toBe('both');
    expect(inTraverse(port, PI)).toBe(true); // straight out to the left
    expect(inTraverse(port, 0)).toBe(false);
    expect(inTraverse(stbd, 0)).toBe(true);
    expect(inTraverse(stbd, PI)).toBe(false);
    expect(inTraverse(stbd, -PI / 2)).toBe(false); // dead ahead is the bow's job
    // angled forward, a sponson reaches toward the bow but is clipped at the centreline
    const fwd = mountTraverse('battery', 'W', 'pulse', 1);
    expect(inTraverse(fwd, -PI / 2 + 0.05)).toBe(true);
    expect(inTraverse(fwd, -PI / 2 - 0.05)).toBe(false);
    expect(inTraverse(fwd, PI / 2 - 0.3)).toBe(false); // nothing aft-starboard any more
  });
  it('ventral ordnance is ground only; point defense hunts shots; coils follow placement', () => {
    expect(mountTraverse('gundeck', 'W', 'bomb')).toMatchObject({ arc: 'ventral', layers: 'ground', down: true });
    expect(mountTraverse('bridge', 'W', 'artillery')).toMatchObject({ arc: 'ventral', layers: 'ground' });
    expect(mountTraverse('battery', 'W', 'pd').layers).toBe('shots');
    expect(mountTraverse('gundeck', 'W', 'tesla').layers).toBe('air');
    expect(mountTraverse('battery', 'W', 'tesla').layers).toBe('both');
    expect(mountTraverse('spine', 'U', 'plate').sectors).toEqual([]);
    expect(layersHit('air', 'ground')).toBe(false);
    expect(layersHit('air', 'both')).toBe(true); // a ghost dreadnought is fair game for the top deck
    expect(layersHit('ground', 'air')).toBe(false);
    expect(layersHit('ground', 'both')).toBe(false); // bombs fall past a flying ghost
  });
  it('clamps to the nearest sector and mirrors for ghosts (bow down the screen)', () => {
    const bow = mountTraverse('bridge', 'W', 'rail');
    expect(clampTraverse(bow, 0)).toBeCloseTo(-PI / 2 + TRAVERSE.bow);
    expect(clampTraverse(bow, PI)).toBeCloseTo(-PI / 2 - TRAVERSE.bow);
    expect(shipToField(0, true)).toBeCloseTo(PI / 2);
    expect(inTraverse(bow, PI / 2, true)).toBe(true);
    expect(inTraverse(bow, -PI / 2, true)).toBe(false);
    const stbd = mountTraverse('battery', 'W', 'pulse', 2);
    expect(inTraverse(stbd, 0, true)).toBe(true); // starboard stays screen-right on the mirrored ghost
  });
  it('derive() stores the traverse on every mount', () => {
    const d = derive(testBuild());
    expect(d.mounts.map((m) => m.trav.arc)).toEqual(['bow', 'dorsal', 'dorsal', 'broadside', 'ventral', 'ventral', 'internal']);
  });
});

/* ---------------- the real sim, with manual gunnery ---------------- */
const enc = { ...FIGHTS[0], duration: 999 };
function fight(build = testBuild(), relics: string[] = []) {
  startCombat({ enc, level: 1, sector: 1, build, hp: 999, relics, mods: relics.length ? relicMods(relics) : neutralMods(), cheatDeathAvailable: false });
  S.god = true; S.enemies = []; S.banner = null;
}
/** Step the fight with the director held off. */
function step(sec: number) { for (let t = 0; t < sec; t += 1 / 60) { S.spawnCd = 1e9; S.salvageLeft = 0; updateCombat(1 / 60); } }
function addEnemy(type: Enemy['type'], layer: 'air' | 'ground', x: number, y: number): Enemy {
  const e = { type, layer, x, y, r: 12, hp: 1e6, maxHp: 1e6, t: 0, cd: 99, flash: 0, dead: false, ang: 0, hdg: 0, tele: 0, vx: 0, life: 1e9, station: { x, y }, restation: 1e9 } as unknown as Enemy;
  S.enemies.push(e); return e;
}
const shotsOf = (kind: string) => S.pb.filter((b) => b.kind === kind);

describe('manual heavy fire', () => {
  beforeEach(() => { gunnery.manual = true; gunnery.family = null; });
  afterEach(() => { gunnery.manual = false; gunnery.family = null; aim.fire = aim.salvo = false; endCombat(); });

  it('number keys select groups; cycling wraps; the choice carries to the next fight', () => {
    fight();
    expect(S.groups.map((g) => g.family)).toEqual(['rail', 'missile', 'mortar', 'bomb']);
    expect(aim.group).toBe(0);
    expect(selectGroup(3)).toBe(true); expect(aim.group).toBe(3);
    expect(selectGroup(7)).toBe(false); expect(aim.group).toBe(3);
    cycleGroup(1); expect(aim.group).toBe(0);
    cycleGroup(-1); expect(aim.group).toBe(3);
    endCombat(); fight();
    expect(S.groups[aim.group].family).toBe('bomb');
  });
  it('heavy weapons hold fire until the trigger is pulled, then drop bombs on the ground under the reticle', () => {
    fight(); selectGroup(3);
    const Pl = S.P!; aim.x = Pl.x + 150; aim.y = Pl.y - 200;
    step(1);
    expect(shotsOf('bomb').length + shotsOf('shell').length).toBe(0);
    aim.fire = true; step(0.1);
    const bombs = shotsOf('bomb');
    expect(bombs.length).toBeGreaterThan(0);
    expect(Math.abs(bombs[0].tx - aim.x)).toBeLessThan(20);
    expect(shotsOf('shell').length).toBe(0); // the mortar group is not selected
  });
  it('ground ordnance out of reach and rails outside their cone cannot bear, and say why', () => {
    fight(); selectGroup(3);
    const Pl = S.P!; aim.x = Pl.x; aim.y = Pl.y - 700; aim.fire = true;
    step(0.3);
    expect(shotsOf('bomb').length).toBe(0);
    expect(Object.values(aim.why)).toContain('range');
    selectGroup(0); aim.x = Pl.x + 600; aim.y = Pl.y + 40; // abeam: outside the bridge rail's forward cone
    const railUid = S.groups[0].mounts[0].part!.uid; fireLog.delete(railUid);
    step(0.3);
    expect(aim.why[railUid]).toBe('arc');
    expect(fireLog.has(railUid)).toBe(false);
    aim.x = Pl.x + 100; aim.y = Pl.y - 500; step(0.2); // ahead: in the cone
    expect(fireLog.has(railUid)).toBe(true);
  });
  it('missiles lock the target nearest the reticle; a top-deck pod will not take a ground lock', () => {
    fight(); selectGroup(1);
    const Pl = S.P!, jet = addEnemy('heli', 'air', Pl.x - 300, Pl.y - 350);
    aim.x = jet.x + 40; aim.y = jet.y + 30; step(0.4);
    expect(aim.lock).toBe(jet);
    aim.fire = true; step(0.1);
    const ms = shotsOf('missile');
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((m) => m.tg === jet)).toBe(true);
    aim.fire = false; S.pb = []; S.enemies = [];
    const tank = addEnemy('tank', 'ground', Pl.x + 300, Pl.y - 300);
    aim.x = tank.x; aim.y = tank.y; step(1.2); aim.fire = true; step(0.2);
    expect(aim.why[S.groups[1].mounts[0].part!.uid]).toBe('air');
    expect(shotsOf('missile').length).toBe(0);
  });
  it('right mouse salvoes every heavy group that can bear', () => {
    fight();
    const Pl = S.P!; aim.x = Pl.x + 60; aim.y = Pl.y - 300;
    for (const g of S.groups) fireLog.delete(g.mounts[0].part!.uid);
    step(0.4); aim.salvo = true; step(0.1);
    for (const g of S.groups) expect(fireLog.has(g.mounts[0].part!.uid), g.family).toBe(true);
  });
  it('without manual gunnery (touch, harness, tests) heavy weapons aim themselves as before', () => {
    gunnery.manual = false; fight();
    const Pl = S.P!; addEnemy('tank', 'ground', Pl.x + 200, Pl.y - 200);
    step(2);
    expect(S.stats.dmgDealt).toBeGreaterThan(0);
  });
});

describe('placement decides what auto guns engage', () => {
  afterEach(() => endCombat());
  it('top-deck turrets ignore ground units; bow and broadside guns engage them', () => {
    const top: Build = { sections: [{ type: 'bridge', slots: [null] }, { type: 'gundeck', slots: [P('pulse'), P('pulse')] }, { type: 'engine', slots: [null] }] };
    fight(top);
    const Pl = S.P!; addEnemy('tank', 'ground', Pl.x, Pl.y - 250);
    step(2);
    expect(S.pb.length).toBe(0);
    expect(S.stats.dmgDealt).toBe(0);
    endCombat();
    const bow: Build = { sections: [{ type: 'bridge', slots: [P('pulse')] }, { type: 'engine', slots: [null] }] };
    fight(bow);
    addEnemy('tank', 'ground', S.P!.x, S.P!.y - 250);
    step(2);
    expect(S.stats.dmgDealt).toBeGreaterThan(0);
  });
});

describe('scrap magnet', () => {
  afterEach(() => endCombat());
  const drop = (x: number, y: number) => { S.pickups.push({ x, y, vx: 0, vy: 0, val: 1, t: 0, kind: 'scrap' }); return S.pickups[S.pickups.length - 1]; };
  it('pulls scrap inside the reach and accelerates it into the hull', () => {
    fight();
    const Pl = S.P!, x = Pl.x + Pl.dv.width / 2 + Pl.dv.magnet - 30, p = drop(x, Pl.y);
    const d0 = x - Pl.x;
    step(0.1);
    const v1 = Math.hypot(p.vx, p.vy);
    expect(Pl.x - p.x).toBeLessThan(d0); // moved in
    step(0.1);
    expect(Math.hypot(p.vx, p.vy)).toBeGreaterThan(v1); // and faster
    step(1);
    expect(S.pickups.length).toBe(0);
    expect(S.scrap).toBeCloseTo(1);
  });
  it('collects at once within the collection radius of the hull', () => {
    fight();
    const Pl = S.P!; drop(Pl.x + Pl.dv.width / 2 + MAGNET.collect - 4, Pl.y);
    step(1 / 60);
    expect(S.pickups.length).toBe(0);
  });
  it('never loses scrap that scrolled off the bottom of the field', () => {
    fight();
    const Pl = S.P!; Pl.y = 200; const p = drop(60, 940);
    step(4);
    expect(S.pickups.includes(p)).toBe(false);
    expect(p.dead).toBe(true);
    expect(S.scrap).toBeGreaterThanOrEqual(1);
  });
  it('magnet parts and the Magnetized Hull relic widen the reach', () => {
    const base = derive(testBuild()).magnet;
    expect(base).toBe(MAGNET.base);
    const b = testBuild(); b.sections[3].slots[0] = P('magnet', 2);
    expect(derive(b).magnet).toBe(MAGNET.base + 2 * MAGNET.perTier);
    expect(derive(testBuild(), relicMods(['magnetic_hull'])).magnet).toBe(MAGNET.base + 90);
  });
});

/* ---------------- facings in combat: guns fire where their mount faces, never through the hull ---------------- */
/** Park the ship mid-field (so targets astern are on the field) and clear what spawned. */
const park = () => { const Pl = S.P!; Pl.x = 800; Pl.y = 330; Pl.vx = Pl.vy = 0; S.pb = []; return Pl; };
/** Bolts in flight, as field angles. */
const boltAngles = () => S.pb.filter((b) => b.kind === 'bolt').map((b) => Math.atan2(b.vy, b.vx));
/** Fore battery with one starboard gun angled aft-starboard; the aft battery's sponson masks part of its arc. */
const maskedSponson = (id: string): Build => ({ sections: [
  { type: 'bridge', slots: [null] },
  { type: 'battery', slots: [null, null, P(id)], face: [6, 2, 3] },
  { type: 'battery', slots: [null, null, null] },
] });
/** A field bearing inside one of the mount's blocked sectors and outside its traverse. */
function blockedBearing(m: Mount) {
  for (const b of m.trav.blocked) for (let k = -0.9; k <= 0.9; k += 0.1) { const a = shipToField(b.c + k * b.h); if (!inTraverse(m.trav, a)) return a; }
  return null;
}

describe('mount facings decide where guns fire', () => {
  afterEach(() => endCombat());
  it('a turret turned astern engages a target astern, and holds fire on one ahead', () => {
    const aft: Build = { sections: [{ type: 'bridge', slots: [null] }, { type: 'gundeck', slots: [P('pulse'), null], face: [4, 0] }] };
    fight(aft); const Pl = park();
    addEnemy('heli', 'air', Pl.x + 30, Pl.y - 320); // dead ahead
    step(1.5);
    expect(boltAngles().length).toBe(0);
    const tg = addEnemy('heli', 'air', Pl.x + 30, Pl.y + 320); // astern
    step(1.5);
    const as = boltAngles();
    expect(as.length).toBeGreaterThan(0);
    for (const a of as) expect(Math.sin(a)).toBeGreaterThan(0.5); // every bolt goes down the screen, astern
    expect(tg.hp).toBeLessThan(tg.maxHp);
  });
  it('a sponson angled aft fires aft, and never along a bearing the hull blocks', () => {
    fight(maskedSponson('pulse')); const Pl = park();
    const m = Pl.dv.mounts.find((q) => q.part)!, mx = Pl.x + m.ox, my = Pl.y + m.oy, ba = blockedBearing(m);
    expect(m.trav.blocked.length).toBeGreaterThan(0);
    expect(ba).not.toBeNull();
    addEnemy('heli', 'air', mx + Math.cos(ba!) * 320, my + Math.sin(ba!) * 320);
    step(2.5);
    expect(boltAngles().length).toBe(0);
    // a target in its open arc, aft of the beam: the sponson fires aft, and every round stays inside its traverse
    const oa = shipToField(m.trav.sectors[0].c);
    addEnemy('heli', 'air', mx + Math.cos(oa) * 320, my + Math.sin(oa) * 320);
    step(2.5);
    const as = boltAngles();
    expect(as.length).toBeGreaterThan(0);
    for (const a of as) { expect(inTraverse(m.trav, a)).toBe(true); expect(Math.sin(a)).toBeGreaterThan(0); }
  });
  it('a blocked bearing reads BLOCKED on the reticle, not OUT OF ARC', () => {
    gunnery.manual = true;
    try {
      fight(maskedSponson('rail')); const Pl = park(); selectGroup(0);
      const m = Pl.dv.mounts.find((q) => q.part)!, mx = Pl.x + m.ox, my = Pl.y + m.oy, a = blockedBearing(m)!;
      aim.x = mx + Math.cos(a) * 300; aim.y = my + Math.sin(a) * 300; step(0.1);
      expect(aim.why[m.part!.uid]).toBe('blocked');
      aim.x = mx - 400; aim.y = my; step(0.1); // across the hull to port: outside its arc altogether
      expect(aim.why[m.part!.uid]).toBe('arc');
    } finally { gunnery.manual = false; }
  });
});

describe('threats from astern', () => {
  afterEach(() => endCombat());
  it('rear entries hold off the bottom edge (telegraphed), then come up from astern', () => {
    fight(); const Pl = S.P!; Pl.y = 330; S.enemies = [];
    for (const k of ['jet', 'drone', 'heli', 'gunship'] as const) spawnGroup(k, true);
    expect(S.enemies.length).toBeGreaterThan(5);
    for (const e of S.enemies) { expect(e.y).toBeGreaterThan(H); expect(e.warnT).toBeGreaterThan(0); }
    const y0 = S.enemies.map((e) => e.y);
    step(AFT.warn * 0.8);
    expect(S.enemies.map((e) => e.y)).toEqual(y0); // still holding: the HUD shows ASTERN
    expect(S.eb.length).toBe(0);
    step(3);
    for (const e of S.enemies) expect(e.y).toBeLessThan(H); // all of them came up onto the field
    // helicopters and gunships take station off the quarter: astern of the hull's centre, out to one side
    const quarter = S.enemies.filter((e) => e.quarter);
    expect(quarter.length).toBeGreaterThan(0);
    for (const e of quarter) expect(e.y).toBeGreaterThan(Pl.y);
  });
  it('the director sends some of every air fight up from astern', () => {
    const real = Math.random; Math.random = mulberry32(11);
    try {
      startCombat({ enc: { ...FIGHTS[1], duration: 40 }, level: 3, sector: 1, build: testBuild(), hp: 999, relics: [], mods: neutralMods(), cheatDeathAvailable: false });
      S.god = true;
      const seen = new Set<Enemy>();
      for (let t = 0; t < 40; t += 1 / 30) { updateCombat(1 / 30); for (const e of S.enemies) if (e.aft) seen.add(e); }
      expect(seen.size).toBeGreaterThan(3);
      expect([...seen].some((e) => e.type === 'jet' || e.type === 'drone')).toBe(true);
    } finally { Math.random = real; }
  });
});

describe('ghost guns follow their recorded facings', () => {
  afterEach(() => endCombat());
  /** A ghost with a bridge gun and a battery whose sponsons are angled aft: off its bow quarter nothing bears. */
  const ghost = (): Ghost => ({ id: 't', pilot: 't', name: 'TEST', sector: 1, floor: 10, relics: [], score: 0, sections: [
    { type: 'bridge', slots: [['pulse', 1]], face: [0] },
    { type: 'battery', slots: [['pulse', 1], null, ['pulse', 1]], face: [5, 6, 3] },
    { type: 'engine', slots: [null] },
  ] });
  function duel() {
    startCombat({ enc: BOSS_ENCOUNTER, level: 3, sector: 1, build: testBuild(), hp: 999, relics: [], mods: neutralMods(), cheatDeathAvailable: false, ghost: ghost() });
    const B = S.boss!; B.y = B.homeY; B.entered = true; S.god = true; S.banner = null;
    return B;
  }
  /** Step with the ghost and the player held still and no escorts; returns how many shots the ghost fired. */
  function hold(sec: number, x: number, y: number) {
    let shots = 0; const seen = new Set<unknown>();
    for (let t = 0; t < sec; t += 1 / 60) {
      const Pl = S.P!, B = S.boss!; Pl.x = x; Pl.y = y; Pl.vx = Pl.vy = 0; Pl.tx = Pl.ty = null; B.x = 800; B.vx = 0; S.escortT = 1e9; S.enemies = [];
      updateCombat(1 / 60);
      for (const b of S.eb) if (String(b.src).startsWith('boss') && !seen.has(b)) { seen.add(b); shots++; }
    }
    return shots;
  }
  it('off its bow quarter no aimed gun bears and the ghost holds fire; under its bow the bridge gun opens up', () => {
    const B = duel();
    // search its bow quarters for a spot where none of its guns bear on any part of our hull
    let spot: { x: number; y: number } | null = null;
    for (let y = 560; y <= 800 && !spot; y += 20) for (let dx = 160; dx <= 760 && !spot; dx += 20) {
      S.P!.x = 800 + dx; S.P!.y = y;
      if (B.weps.every((w) => !bossGunBears(w))) spot = { x: 800 + dx, y };
    }
    expect(spot).not.toBeNull();
    S.eb = [];
    expect(hold(4, spot!.x, spot!.y)).toBe(0);
    S.eb = [];
    expect(hold(4, 800, 720)).toBeGreaterThan(0); // dead under its bow
  });
});
