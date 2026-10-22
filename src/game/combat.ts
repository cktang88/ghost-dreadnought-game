// The shmup itself: one combat encounter on the 1600x900 field (y points down the screen, the bow points up).
// Gameplay state that renderers, HUD and audio read is documented in docs/TECH.md under "Gameplay state".
import { clamp, rnd, pick, has, angDiff } from '../util/rng';
import {
  WEAPONS, derive, wCd, wDmg, type Build, type Derived, type Part, type Mods, type Mount, type Arc, ghostToBuild,
  weaponFamily, weaponGroups, HEAVY_FAMILIES, MAGNET, RANGE, inTraverse, clampTraverse, layersHit, shipToField, fieldToShip, facingAngle,
  type WeaponGroup, type HeavyFamily, type TargetLayers, type Traverse, type Facing,
} from '../data/parts';
import { EN, type EnemyType, type Encounter } from '../data/enemies';
import { hasFlag } from '../data/relics';
import { OVERDRIVES, type OverdriveKind } from '../data/hulls';
import { neutralHeat, type HeatFx } from '../data/heat';
import { V, boomFx, spark, muzzle, addFx, updateFx, resetFx, broadsideFx, addTrauma, kick } from './vfx';
import { sfx } from './audio';
import type { Ghost } from './ghosts';
import {
  stepShipVelocity, arriveWish, stepBank, newStop, requestStop, stepStop, hitstopFor, HITSTOP,
  newSlow, requestSlow, stepSlow, slowIntensity, SLOWMO, SLOWMO_SHORT, SLOWMO_BOSS,
  newCarnage, addCarnage, stepCarnage, type Carnage,
} from './feel';

import { FIELD_W, FIELD_H, SHIP_SCALE } from './field';
export const W = FIELD_W, H = FIELD_H;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Ent { [k: string]: any; x: number; y: number; r: number; dead: boolean }
/**
 * An enemy. Besides the fields below, renderers may read: `hdg` (heading in field radians, aircraft), `ang` (turret
 * aim), `tele` (0..1 wind-up before a shot: draw a growing hostile glint), `vx`.
 */
export interface Enemy extends Ent { type: EnemyType; layer: 'air' | 'ground'; hp: number; maxHp: number; t: number; cd: number; flash: number; ang: number; tele: number }
export interface Player {
  x: number; y: number; build: Build; dv: Derived; hp: number; shield: number; cds: Record<number, number>;
  lastHit: number; flash: number; tx: number | null; ty: number | null; droneCd: number[];
  /** Velocity in field units/s. */
  vx: number; vy: number;
  /** Eased bank input, -1 (rolling left) .. 1 (rolling right). Renderers tilt the hull by it. */
  bank: number;
}
export interface Boss extends Ent {
  ghost: Ghost; build: Build; dv: Derived; s: number; homeY: number; halfW: number; layer: 'both'; isBoss: true; alive: boolean;
  hp: number; maxHp: number; shield: number; shieldMax: number; shieldHitT: number; regen: number; tractor: number; droneEvery: number; droneT: number;
  speedMul: number; fireMul: number; cdMul: number; t: number; flash: number; entered: boolean;
  /** 1..3 by hull (BOSS_PHASES): lanes, rake, full broadside. */ phase: number;
  /** Lateral velocity (it moves like a ship, not a turret). */ vx: number;
  weps: BossGun[];
  /** Broadside state, index 0 port (screen left), 1 starboard. */ volley: [BossVolley, BossVolley];
  /** Broadside wind-ups this frame, for the FX layer (hostile glint and lane markers). */ glints: BossGlint[];
}
export type { Decor } from './worldgen';
import type { Decor } from './worldgen';
export interface Pickup { x: number; y: number; vx: number; vy: number; val: number; t: number; kind: 'scrap' | 'repair'; dead?: boolean; /** Seconds the magnet has held it. */ pull?: number }
export interface Beam { x1: number; y1: number; x2: number; y2: number; col: string; life: number; max: number; w: number; zig?: boolean }

/** Sim -> renderer/audio/UI event. Consumers remember the last `id` they handled. */
export interface GameEvent {
  id: number; t: number;
  type: 'broadside' | 'kill' | 'eliteKill' | 'bossDown' | 'overdrive' | 'overdriveReady' | 'overdriveEnd' | 'structure' | 'carnageTier' | 'playerHit';
  x: number; y: number;
  /** broadside: -1 port / 1 starboard. */ side?: number;
  /** broadside: guns in the volley; carnageTier: new whole multiplier; kill: enemy max hull; playerHit: damage. */ n?: number;
  /** overdrive kind or enemy type. */ kind?: string;
}

/** Ventral Lance / Lance Spear beam: a line from (x1,y1) to (x2,y2). `ground: true` means x2,y2 is on the ground plane. */
export interface OdBeam { x1: number; y1: number; x2: number; y2: number; w: number; ground: boolean; col: string }
/** A strike craft from the Leviathan's Strike Wing. */
export interface Ally { x: number; y: number; vx: number; vy: number; hdg: number; cd: number; tg: Ent | null; t: number }
export interface Overdrive {
  /** 0..1; full means ready. */ charge: number; active: boolean; kind: OverdriveKind;
  /** Seconds left while active, and the full duration. */ t: number; dur: number;
  /** Lance and spear: the live beam, else null. */ beam: OdBeam | null;
  /** Lance: burning scorch points on the ground (they scroll with the city). life counts down from max. */
  trail: { x: number; y: number; life: number; max: number }[];
  /** Strike Wing craft. */ allies: Ally[];
  /** Bulwark: radius of the aegis field around the ship, 0 when off. */ radius: number;
  tick: number;
}
export interface FightStats {
  kills: number; airKills: number; groundKills: number; elites: number; structures: number; broadsides: number; maxVolley: number;
  overdrives: number; lanceStructures: number; dmgTaken: number; peakCarnage: number; scrapRaw: number;
  /** Hull damage by source, for the wreck report and balance. */ dmgBy: Record<string, number>;
  /** Damage the player dealt (ordnance delivered), and to the boss/elite alone. */ dmgDealt: number; dmgToTarget: number;
}

export interface CombatSetup {
  enc: Encounter; level: number; sector: number; build: Build; hp: number; relics: string[]; mods: Mods;
  ghost?: Ghost; cheatDeathAvailable: boolean;
  overdrive?: OverdriveKind; heat?: HeatFx;
  /** Overdrive charge to start with (0..1), from rank perks. */ odCharge?: number;
  /** Map floor of the node (boss = 10) and the run seed: they pick the biomes below (biomes.ts biomeFor). */
  floor?: number; seed?: number;
}
export type CombatMode = 'play' | 'clear' | 'bossdown' | 'dying' | 'done';

const newOverdrive = (kind: OverdriveKind = 'lance'): Overdrive => ({ charge: 0, active: false, kind, t: 0, dur: OVERDRIVES[kind].duration, beam: null, trail: [], allies: [], radius: 0, tick: 0 });
const newStats = (): FightStats => ({ kills: 0, airKills: 0, groundKills: 0, elites: 0, structures: 0, broadsides: 0, maxVolley: 0, overdrives: 0, lanceStructures: 0, dmgTaken: 0, peakCarnage: 1, scrapRaw: 0, dmgBy: {}, dmgDealt: 0, dmgToTarget: 0 });

export const S = {
  active: false, mode: 'play' as CombatMode, outcome: null as null | 'win' | 'dead',
  enc: null as Encounter | null, level: 1, sector: 1, relics: [] as string[],
  t: 0, time: 0, scroll: 62, scrollY: 0, budget: 0, spawnCd: 0, endT: 0, chain: 0, escortT: 0, salvageT: 0, salvageLeft: 0,
  banner: null as null | { text: string; sub: string; t: number; max: number; col: string },
  P: null as Player | null, boss: null as Boss | null, elite: null as Enemy | null,
  enemies: [] as Enemy[], pb: [] as Ent[], eb: [] as Ent[], pickups: [] as Pickup[], beams: [] as Beam[], decor: [] as Decor[], clouds: [] as { x: number; y: number; w: number; h: number }[],
  god: false, scrap: 0, kills: 0, score: 0, firstHitUsed: false, cheatDeath: false, cheatDeathUsed: false, theme: 0,
  /** Biome the fight crosses into part-way (-1 none); S.theme is the biome under the ship (worldgen.ts). */
  biomeB: -1,
  overdrive: newOverdrive(), carnage: newCarnage() as Carnage, heat: neutralHeat(),
  /** Hitstop: while stop.left > 0 the simulation is frozen (render keeps drawing). */
  stop: newStop(),
  /** Slow-mo timeline; slowK is the time scale applied this frame, slowFx 0..1 for the cinematic look. */
  slowmo: newSlow(), slowK: 1, slowFx: 0,
  events: [] as GameEvent[], eventId: 0,
  /** Rising-pitch scrap pickup streak: n pickups within 0.5 s of each other. */
  pickStreak: { n: 0, t: 9 },
  stats: newStats(), seen: {} as Partial<Record<EnemyType, number>>,
  timers: [] as { at: number; fn: () => void }[],
  /** Broadside volley state per side (index 0 = port, 1 = starboard). */
  volley: [{ wait: 0, queue: [] as { at: number; m: Mount }[] }, { wait: 0, queue: [] as { at: number; m: Mount }[] }],
  /** Heavy weapon groups of the player's ship (keys 1..), see weaponGroups() in data/parts.ts. */
  groups: [] as WeaponGroup[],
};
export const keys: Record<string, boolean> = {};
/** Weapon uid -> S.t of its last shot (player and boss). Read by the ship renderer for recoil. */
export const fireLog = new Map<number, number>();

const hpMult = () => (1 + 0.3 * (S.level - 1)) * S.heat.enemyHp;
const bspd = () => Math.min(300, 170 * (1 + 0.03 * (S.level - 1)));
/** Base enemy shot damage. The player is a tank: many small hits, never one-shots. */
const edmg = () => 1.0 * (1 + 0.12 * (S.level - 1)) * S.heat.enemyDmg;
const aimAng = (x: number, y: number) => Math.atan2(S.P!.y - y, S.P!.x - x);
export const setBanner = (text: string, sub: string, t: number, col = '#f2a541') => { S.banner = { text, sub, t, max: t, col }; };
const later = (sec: number, fn: () => void) => { S.timers.push({ at: S.time + sec, fn }); };
export function emit(e: Omit<GameEvent, 'id' | 't'>) {
  S.events.push({ ...e, id: ++S.eventId, t: S.t });
  if (S.events.length > 160) S.events.splice(0, S.events.length - 160);
}

/* ---------------- bearings: every gun fires inside its mount's masked traverse ---------------- */
// A mount's traverse (m.trav, data/parts.ts) is centred on its facing and masked by the hull (towers, funnels,
// neighbouring sponsons). Player and ghost guns only fire along a bearing inside it; a ghost is mirrored (bow down).
/** Field angle a mount faces. */
export const faceAngle = (f: Facing, mirrored = false) => shipToField(facingAngle(f), mirrored);
/** Where a gun points with nothing to shoot: its facing, held inside the masked traverse. */
export const restAngle = (m: { facing: Facing; trav: Traverse }, mirrored = false) => clampTraverse(m.trav, faceAngle(m.facing, mirrored), mirrored);
/** Is a field bearing inside one of the sectors the hull blocks for this mount? */
export const blockedAt = (t: Traverse, a: number, mirrored = false) =>
  t.blocked.some((s) => Math.abs(angDiff(fieldToShip(a, mirrored), s.c)) <= s.h + 1e-9);
/** Points of a hull worth aiming at: centre, along the keel and out to the beams (a long ship can be half in an arc). */
function hullPts(x: number, y: number, hw: number, hl: number): [number, number][] {
  return [[x, y], [x, y - hl * 0.5], [x, y + hl * 0.5], [x, y - hl * 0.85], [x, y + hl * 0.85], [x - hw * 0.7, y], [x + hw * 0.7, y]];
}
const aimPts = (e: Ent): [number, number][] => (e.isBoss ? hullPts(e.x, e.y, e.halfW, (e.dv.len * e.s) / 2) : [[e.x, e.y]]);
const playerPts = () => { const P = S.P!; return hullPts(P.x, P.y, P.dv.width / 2, P.dv.len / 2); };
/** The first field bearing from (x, y) to one of `pts` that the traverse allows, or null (out of arc or blocked). */
function bearingTo(t: Traverse, x: number, y: number, pts: [number, number][], mirrored = false): number | null {
  for (const [px, py] of pts) { const a = Math.atan2(py - y, px - x); if (inTraverse(t, a, mirrored)) return a; }
  return null;
}

/* ---------------- setup ---------------- */
export function startCombat(c: CombatSetup) {
  resetFx();
  const dv = derive(c.build, c.mods);
  Object.assign(S, {
    active: true, mode: 'play', outcome: null, enc: c.enc, level: c.level, sector: c.sector, relics: c.relics,
    t: 0, time: 0, budget: 3, spawnCd: 1.0, endT: 0, chain: 0, escortT: 7,
    salvageLeft: c.enc.salvage, salvageT: 3, banner: null, boss: null, elite: null,
    enemies: [], pb: [], eb: [], pickups: [], beams: [], scrap: 0, kills: 0, score: 0,
    firstHitUsed: false, cheatDeath: c.cheatDeathAvailable && hasFlag(c.relics, 'cheat_death'), cheatDeathUsed: false,
    theme: biomeFor(c.sector, c.floor, c.seed).a, biomeB: biomeFor(c.sector, c.floor, c.seed).b,
    overdrive: newOverdrive(c.overdrive ?? 'lance'), carnage: newCarnage(), heat: c.heat ?? neutralHeat(),
    stop: newStop(), slowmo: newSlow(), slowK: 1, slowFx: 0, events: [], pickStreak: { n: 0, t: 9 },
    stats: newStats(), seen: {}, timers: [],
    volley: [{ wait: 0, queue: [] }, { wait: 0, queue: [] }],
  });
  keys.od = false;
  S.groups = weaponGroups(dv.mounts);
  resetAim();
  S.overdrive.charge = Math.max(0, Math.min(0.99, c.odCharge ?? 0));
  S.P = { x: W / 2, y: clamp(H - 190, dv.len / 2 + 56, H - dv.len / 2 - 8), build: c.build, dv, hp: Math.min(c.hp, dv.maxHp), shield: dv.shieldMax, cds: {}, lastHit: 9, flash: 0, tx: null, ty: null, droneCd: [0, 0, 0], vx: 0, vy: 0, bank: 0 };
  seedDecor();
  if (c.enc.kind === 'boss' && c.ghost) {
    spawnBoss(c.ghost);
    const g = c.ghost;
    setBanner(g.ai ? 'DEFENSE CORE' : 'GHOST DREADNOUGHT', g.ai ? g.name : `${g.name} · fell in sector ${g.sector}`, 3.2, '#ff5a4e');
    sfx('alarm');
  } else if (c.enc.kind === 'elite') {
    setBanner('ELITE CONTACT', c.enc.name, 2.6, '#ff5a4e'); sfx('alarm');
    later(2.2, () => { if (S.active && S.mode === 'play') spawnElite(c.enc.elite!); });
  } else {
    setBanner(c.enc.name.toUpperCase(), `Sector ${c.sector} · ${biomeName(S.theme)}`, 2.2);
  }
}

/* ---------------- world ---------------- */
// World generation (city, roads, clouds) lives in ./worldgen; re-exported for existing callers.
export { seedDecor, updateBg } from './worldgen';
import { seedDecor, updateBg, worldBlast, cityPay } from './worldgen';
import { biomeFor, biomeName } from './biomes';
/** Every ground blast goes through here: buildings it destroys pay scrap (times carnage) and feed carnage/overdrive. */
export function groundBlast(x: number, y: number, r: number, d: number, lance = false) {
  const sc = worldBlast(x, y, r, d) * cityPay(); // cityPay(): the city is drawn far below at a small scale (worldgen.ts)
  if (sc > 0) {
    S.stats.structures++; if (lance) S.stats.lanceStructures++;
    // Buildings feed the rampage, but less than kills: the city is dense, and at the old 3 + 1.5/scrap every street
    // pinned carnage at x3. Their scrap is scaled by STRUCTURE_SCRAP (see docs/TECH.md "Scrap economy").
    addCarnage(S.carnage, 2 + sc); feedOverdrive(0.006 + sc * 0.0025);
    dropScrap(x, y, sc * STRUCTURE_SCRAP, Math.min(6, Math.ceil(sc / 4)));
    emit({ type: 'structure', x, y, n: sc });
  }
}

/* ---------------- spawning ---------------- */
function spawnEnemy(type: EnemyType, x: number, y: number, o: Record<string, any> = {}): Enemy {
  const d = EN[type];
  const hp = d.salvage ? d.hp : d.hp * hpMult() * (d.elite ? (0.7 + 0.3 * S.sector) * S.heat.eliteHp : 1);
  const e: Enemy = { type, layer: d.layer, x, y, r: d.r, hp, maxHp: hp, t: 0, cd: rnd(1.0, 2.4), flash: 0, dead: false, ang: Math.PI / 2, hdg: Math.PI / 2, tele: 0, ...o };
  S.enemies.push(e); return e;
}
function director(dt: number) {
  const enc = S.enc!;
  if (S.time > enc.duration && enc.kind === 'fight') return;
  S.budget += dt * (2.3 + 0.4 * (S.level - 1)) * enc.rate * S.heat.spawn;
  S.spawnCd -= dt; if (S.spawnCd > 0) return;
  const opts = (Object.keys(enc.weights) as EnemyType[]).filter((k) => (EN[k].min || 1) <= S.level + 1 && EN[k].cost <= S.budget);
  if (!opts.length) return;
  let total = 0; for (const k of opts) total += enc.weights[k]!;
  let r = Math.random() * total, k = opts[0];
  for (const o of opts) { r -= enc.weights[o]!; if (r <= 0) { k = o; break; } }
  S.budget -= EN[k].cost; spawnGroup(k);
  S.spawnCd = rnd(0.25, 0.8) / (1 + 0.05 * S.level);
}
function spawnSalvage(dt: number) {
  if (S.salvageLeft <= 0) return;
  S.salvageT -= dt; if (S.salvageT > 0) return;
  S.salvageLeft--; S.salvageT = rnd(5, 8);
  const r = Math.random();
  if (r < 0.45) spawnEnemy('cache', rnd(60, W - 60), -24);
  else if (r < 0.7) spawnEnemy('wreck', rnd(60, W - 60), -30, { ang: rnd(0, 6.28) });
  else spawnEnemy('canister', rnd(80, W - 80), -20, { baseX: 0, phase: rnd(0, 6) });
}
/** A point level with the player's hull on one side: where flankers take station so broadsides matter. */
function flankPoint(side: number, dist: number) {
  const P = S.P!;
  return { x: clamp(P.x + side * dist, 40, W - 40), y: clamp(P.y + rnd(-P.dv.len * 0.5, P.dv.len * 0.5), 90, H - 60) };
}
/** A point off the player's quarter, astern of the hull on one side: only aft-facing guns cover it. */
function quarterPoint(side: number, dist: number) {
  const P = S.P!, hw = P.dv.width / 2, hl = P.dv.len / 2;
  return { x: clamp(P.x + side * (hw + dist * 0.6), 40, W - 40), y: clamp(P.y + hl + dist * 0.45, 90, H - 50) };
}
/**
 * Rear entries: aircraft that come up from astern first hold just off the bottom edge for `warn` seconds (e.warnT; the
 * HUD flashes an ASTERN chevron where they will break in), then run in. Shares of each director group that do so:
 * interceptors overtaking, drone columns climbing the field, helicopters and gunships taking station on a quarter.
 * They ramp in with the level (`aftRamp`: a third of the shares in the first fights, all of them from level 3.5).
 */
export const AFT = { warn: 1.3, y: H + 90, jet: 0.22, drone: 0.3, heli: 0.32, gunship: 0.38 } as const;
export const aftRamp = () => clamp((S.level - 1) / 2.5, 0.35, 1);
const aftEntry = (o: Record<string, any> = {}) => ({ aft: true, warnT: AFT.warn, ...o });
/** An x beside the hull (outside its beam), so a run from astern passes the broadsides instead of ramming the stern. */
function besideX(side: number, off: number) {
  const P = S.P!, hw = P.dv.width / 2;
  let x = P.x + side * (hw + off);
  if (x < 40 || x > W - 40) x = P.x - side * (hw + off);
  return clamp(x, 40, W - 40);
}
/** Spawns one group of type k the way the director does (also the `__gd.spawn` debug hook). */
export function spawnGroup(k: EnemyType, aftOnly = false) {
  const P = S.P!, x = rnd(60, W - 60), side = pick([-1, 1]), r = Math.random();
  const ramp = aftRamp(), aft = (share: number) => aftOnly || r < share * ramp;
  switch (k) {
    case 'heli': {
      const n = S.level >= 2 && Math.random() < 0.5 ? 2 : 1;
      if (aft(AFT.heli)) { for (let i = 0; i < n; i++) spawnEnemy('heli', besideX(side, 120 + i * 60), AFT.y + i * 30, aftEntry({ station: null, restation: 0, life: rnd(14, 18), quarter: side })); break; }
      for (let i = 0; i < n; i++) {
        const fromSide = Math.random() < 0.55, sx = side < 0 ? -30 : W + 30;
        spawnEnemy('heli', fromSide ? sx : clamp(x + i * 50, 40, W - 40), fromSide ? rnd(120, H - 200) : -20, { station: null, restation: 0, life: rnd(14, 18) });
      }
      break;
    }
    case 'jet': {
      if (aft(AFT.jet)) {
        // overtaking run from astern, up one side of the hull: the aft quarter guns get the first shot
        const n = S.level >= 3 ? 3 : 2, bx = besideX(side, rnd(90, 220));
        for (let i = 0; i < n; i++) spawnEnemy('jet', clamp(bx + side * i * 34, 30, W - 30), AFT.y + i * 46, aftEntry({ vx: 0, vy: -330, overtake: true, hdg: -Math.PI / 2 }));
      } else if (r < AFT.jet * ramp + 0.38) {
        // strafing run across the field, level with the hull: broadside bait
        const y = clamp(P.y + pick([-1, 1]) * (P.dv.len / 2 + rnd(40, 80)), 100, H - 60), n = S.level >= 3 ? 3 : 2;
        for (let i = 0; i < n; i++) spawnEnemy('jet', side < 0 ? -40 - i * 60 : W + 40 + i * 60, y + (i - 1) * 34, { vx: -side * 360, vy: 0, strafe: true, hdg: side < 0 ? 0 : Math.PI });
      } else {
        const n = S.level >= 3 && Math.random() < 0.5 ? 3 : 1;
        for (let i = 0; i < n; i++) spawnEnemy('jet', clamp(x + (i - 1) * 40, 20, W - 20), -20 - Math.abs(i - 1) * 26, { vx: (P.x - x) * 0.15, vy: 290 });
      }
      break;
    }
    case 'drone': {
      if (aft(AFT.drone)) { const bx = besideX(side, rnd(170, 260)); for (let i = 0; i < 7; i++) spawnEnemy('drone', bx, AFT.y + i * 24, aftEntry({ baseX: bx, phase: i * 0.5, dir: -1 })); break; }
      const bx = rnd(120, W - 120); for (let i = 0; i < 7; i++) spawnEnemy('drone', bx, -20 - i * 24, { baseX: bx, phase: i * 0.5 }); break;
    }
    case 'gunship':
      if (aft(AFT.gunship)) spawnEnemy('gunship', besideX(side, 200), AFT.y, aftEntry({ side, life: 20, quarter: side }));
      else spawnEnemy('gunship', side < 0 ? -40 : W + 40, rnd(150, H - 250), { side, life: 20 });
      break;
    case 'bomber': { const y = clamp(P.y + rnd(-160, 60), 90, H - 120); spawnEnemy('bomber', side < 0 ? -50 : W + 50, y, { vx: -side * 70, hdg: side < 0 ? 0 : Math.PI }); break; }
    case 'tank': {
      // a platoon drives as a column down one street: true-scale armour reads as a convoy (one marker, a count)
      const n = S.level >= 2 ? 3 : 2, dir = pick([-1, 1]), v = rnd(12, 24), y = -20 - rnd(0, 20);
      for (let i = 0; i < n; i++) spawnEnemy('tank', clamp(x - dir * i * 15, 30, W - 30), y + rnd(-2, 2), { vx: dir * v });
      break;
    }
    case 'infantry': for (let i = 0; i < 7; i++) spawnEnemy('infantry', clamp(x + rnd(-36, 36), 10, W - 10), -20 + rnd(-24, 24)); break;
    default: spawnEnemy(k, x, -24);
  }
}
export function spawnElite(type: EnemyType) {
  const e = type === 'crawler' ? spawnEnemy('crawler', W / 2, -60, { holdY: H * 0.42 })
    : type === 'ace' ? spawnEnemy('ace', W / 2, -60, { dir: pick([-1, 1]) })
      : spawnEnemy(type, W / 2, -60, { hoverY: 150, dir: 1 });
  e.cd2 = 3; e.cd3 = 4.5; e.phase2 = false;
  S.elite = e;
}

/* ---------------- boss ---------------- */
// A ghost flies the wreck it was recorded as, and every weapon keeps the arc its mount gives it, mirrored (its bow
// points down the screen, at you):
//  - every gun trains inside its mount's recorded facing and masked traverse (m.trav, mirrored): the bridge gun a cone
//    below it, top-deck turrets 240 degrees about their facing (the player is an aircraft to them), sponsons their 120;
//    a gun whose arc holds no part of the player's hull holds fire, so its blind arcs are safe water;
//  - Broadside Battery guns fire telegraphed ripple volleys off its flanks, stern to bow, like ours;
//  - bombs and mortars work ventrally (mines and telegraphed strikes), coils and point defense all round.
// So it has zones, as the player does: under its bow you eat the bow guns, beside it the broadsides.
// Three phases by hull (BOSS_PHASES): 1 "lanes" (each gun fires along one locked, telegraphed line), 2 "rake"
// (the stream sweeps across your line with a hole in it, and the ghost comes about to keep you on its beam),
// 3 "full broadside" (both flanks every volley, more rounds, a weave plus a slow second layer).
export const BOSS_PHASES = [0.66, 0.33] as const;
export const BOSS_BROADSIDE = {
  /** Seconds between volleys on a side, before cdMul, the ghost's fire rate and the phase. */ period: 3.6,
  /** Wind-up per phase: the guns glow and their lanes show before the ripple. */ tele: [0.85, 0.7, 0.6],
  /** Seconds between rounds in the ripple (heavier than ours). */ stagger: 0.075,
  /** Phase 2 rake: total sweep (radians) and the hole left in it. */ rake: 0.9, hole: 0.34,
  /** Phase 3 weave offset either side of the aimed line. */ weave: 0.15,
} as const;
const BOSS_CD: Record<string, number> = { pulse: 1.5, spread: 2.5, flak: 2.9, missile: 3.6, bomb: 3.1, artillery: 3.4, rail: 4.6, tesla: 2.6, pd: 0.45 };
/** A ghost gun: mount offset (its own hull's field units, times Boss.s), arc, facing and side as on the player's ship. */
export interface BossGun { part: Part; ox: number; oy: number; cd: number; arc: Arc; side: -1 | 0 | 1; facing: Facing; /** Masked mount traverse (ship space; the ghost is mirrored). */ trav: Traverse }
/** Broadside state for one flank: cooldown, wind-up (-1 idle) and the ripple's scheduled rounds. */
export interface BossVolley { cd: number; wind: number; queue: { at: number; fire: () => void }[] }
/** A wind-up glint for the FX layer: field point, 0..1 progress, lane angle, and the sweep half-angle (0: one line). */
export interface BossGlint { x: number; y: number; tele: number; ang: number; spread: number; len: number }
export const bossPhaseOf = (hpFrac: number) => (hpFrac > BOSS_PHASES[0] ? 1 : hpFrac > BOSS_PHASES[1] ? 2 : 3);
/** Rounds each gun packs into a ghost broadside (ours is broadsideRounds; ghosts fire fewer, heavier-telegraphed rounds). */
export const bossRounds = (p: Part, phase: number) =>
  p.id === 'missile' || p.id === 'rail' ? 1 : p.id === 'flak' ? 2 : clamp(Math.round(broadsideRounds(p) * 0.4), 2, 5) + (phase >= 3 ? 1 : 0);

function spawnBoss(g: Ghost) {
  const sec = S.sector, build = ghostToBuild(g.sections), dv = derive(build);
  // Hulls are long now (an eight-section ship is ~550): a ghost is drawn at most 440 long, so even a long player hull
  // keeps sea room beside and under it on a 900-tall field.
  const s = Math.min(1.6, 440 / dv.len, 700 / dv.width);
  // Sector dominates: player power grows several-fold across a run, so the ghosts must too. The ghost's own hull adds on top.
  // A ghost that comes about to bring its broadsides to bear also takes ours. Early hulls are broadside-heavy, so the
  // early ghosts get the most extra hull (x1.75 in sector 1, x1.35 in 2, none from 3): every duel lasts about half a minute.
  const duel = Math.max(1, 2.15 - 0.4 * sec);
  // SHIP_SCALE / 2.6: hulls grew with the scale pass (more of our guns bear on it), so the duel keeps its length.
  const maxHp = (1800 * Math.pow(sec, 1.55) + dv.maxHp * 2) * duel * (SHIP_SCALE / 2.6) * S.P!.dv.mods.bossHpMul * S.heat.bossHp;
  const u = dv.u, shield = u.shield * 40 * (0.8 + 0.35 * sec);
  S.boss = {
    ghost: g, build, dv, s, x: W / 2, y: -(dv.len * s) / 2 - 10, homeY: (dv.len * s) / 2 + 60, halfW: (dv.width * s) / 2, r: (dv.width * s) / 2,
    layer: 'both', isBoss: true, alive: true, dead: false, hp: maxHp, maxHp, shieldMax: shield, shield, shieldHitT: 9,
    regen: u.repair * 0.0025 * maxHp, tractor: u.magnet * 14, droneEvery: u.drones ? Math.max(5, 10 - u.drones) : 0, droneT: 6,
    speedMul: 1 + 0.12 * u.thruster, fireMul: (1 + 0.1 * u.reactor) * S.heat.bossFire, cdMul: clamp(1.15 - 0.06 * sec, 0.6, 1.1),
    t: 0, phase: 1, flash: 0, entered: false, vx: 0,
    weps: dv.mounts.filter((m) => m.part && has(WEAPONS, m.part.id)).map((m, i) => ({ part: m.part!, ox: m.ox, oy: m.oy, cd: 1.2 + i * 0.45, arc: m.arc, side: m.side, facing: m.facing, trav: m.trav })),
    // first volleys come a beat after the bow guns open up, port and starboard out of step
    volley: [{ cd: 2.2, wind: -1, queue: [] }, { cd: 3.4, wind: -1, queue: [] }], glints: [],
  };
}
const bossMount = (w: { ox: number; oy: number }) => ({ x: S.boss!.x + w.ox * S.boss!.s, y: S.boss!.y - w.oy * S.boss!.s });
/** Ghost fire hits a bigger hull since the scale pass (SHIP_SCALE 2.6 -> 3.1), and the late ghosts carry the most guns:
 *  shrink each hit to match the larger target, and ease the sector-3+ ghost a little more. */
const bossHitEase = () => (2.6 / SHIP_SCALE) * (S.sector >= 3 ? 0.85 : 1);
let shooter = 'unknown';
function eShot(x: number, y: number, a: number, spd: number, o: Record<string, any> = {}) {
  sfx(o.kind === 'missile' ? 'eMissile' : 'eshot', { x, y, layer: 'air' });
  S.eb.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 4.5, dmg: edmg(), col: '#ff5a4e', kind: 'bullet', life: 8, t: 0, dead: false, src: shooter, ...o });
}
function ring(x: number, y: number, n: number, spd: number, o: Record<string, any> = {}) { const off = rnd(0, Math.PI * 2); for (let i = 0; i < n; i++) eShot(x, y, off + (i * Math.PI * 2) / n, spd, o); }
/** The bearing a ghost gun has on the player's hull (mirrored traverse), or null when the player is in its blind arc. */
const bossBearing = (w: BossGun, x: number, y: number) => bearingTo(w.trav, x, y, playerPts(), true);
/** Does this aimed ghost gun (bridge, top deck, sponson) bear on the player's hull right now? (Omni and ventral guns always do.) */
export function bossGunBears(w: BossGun) {
  if (w.arc !== 'bow' && w.arc !== 'dorsal' && w.arc !== 'broadside') return true;
  const p = bossMount(w); return bossBearing(w, p.x, p.y) !== null;
}
/** One shot from a ghost's bridge, top-deck or omni/ventral gun. Returns false (holding fire) when an aimed gun has no
 *  bearing on the player: its facing and the ghost's own hull leave the player in a blind arc. */
function bossFire(w: BossGun): boolean {
  const P = S.P!, { x, y } = bossMount(w), t = w.part.tier, dmg = edmg() * 0.65 * (1 + 0.15 * (t - 1)) * bossHitEase(), spd = bspd(), sec = S.sector;
  const aimed = w.arc === 'bow' || w.arc === 'dorsal' || w.arc === 'broadside';
  const a = aimed ? bossBearing(w, x, y) : aimAng(x, y);
  if (a === null) return false;
  const inArc = (aa: number) => (aimed ? clampTraverse(w.trav, aa, true) : aa);
  if (w.part.id !== 'pd' && w.part.id !== 'artillery') muzzle(x + Math.cos(a) * 8, y + Math.sin(a) * 8, '#ff7a5c', w.part.id === 'rail' ? 22 : 14);
  switch (w.part.id) {
    case 'pulse': { for (let k = 0; k < 3 + (t >= 3 ? 1 : 0); k++) eShot(x, y, a + rnd(-0.04, 0.04), spd * (1 - 0.12 * k), { dmg }); break; }
    case 'spread': { const n = 7 + Math.min(4, t); for (let i = 0; i < n; i++) eShot(x, y, inArc(a + (i - (n - 1) / 2) * 0.17), spd * 0.85, { dmg, col: '#ff7a6b' }); break; }
    case 'flak': { const d = Math.hypot(P.x - x, P.y - y); eShot(x, y, a, 150, { kind: 'orb', r: 8, life: clamp(d / 150, 0.6, 2.4), col: '#ffd27a', dmg }); break; }
    case 'missile': for (const s of [-1, 1]) eShot(x + s * 6, y, inArc(a + s * 0.7), 140, { kind: 'missile', turn: 1.6 + 0.2 * t, spd: 150 + 10 * t, hp: 5 * sec, life: 5, r: 5, col: '#ff9f5a', dmg: dmg * 1.5 }); break;
    case 'bomb': for (let i = -1; i <= 1; i++) eShot(x + i * 18, y, Math.PI / 2, 90 + rnd(0, 40), { kind: 'mine', r: 7, life: rnd(1.3, 2.1), col: '#f2a541', dmg }); break;
    case 'artillery': { const n = t >= 3 ? 4 : 2; for (let k = 0; k < n; k++) strike(P.x + (k ? rnd(-110, 110) : 0), P.y + (k ? rnd(-90, 90) : 0), dmg * 2.2, 46); break; }
    case 'rail': S.eb.push({ kind: 'beam', x, y, x2: x + Math.cos(a) * 1900, y2: y + Math.sin(a) * 1900, warn: 1.0, dur: 0.3, w: 18 + 3 * t, dmg: dmg * 4, t: 0, life: 9, vx: 0, vy: 0, r: 0, col: '#c9a6ff', dead: false, src: 'boss', gun: w }); break;
    case 'tesla': ring(x, y, 12 + t, spd * 0.6, { r: 3.5, col: '#9be7ff', dmg: dmg * 0.8 }); sfx('zap', { x, y }); break;
    case 'pd': {
      let best: Ent | null = null, bd = 160 * 160;
      for (const b of S.pb) { if (!['missile', 'shell', 'bomb', 'flak'].includes(b.kind)) continue; const dd = (b.x - x) ** 2 + (b.y - y) ** 2; if (dd < bd) { bd = dd; best = b; } }
      if (best) { best.dead = true; S.beams.push({ x1: x, y1: y, x2: best.x, y2: best.y, col: '#ff9f9f', life: 0.12, max: 0.12, w: 1.5 }); spark(best.x, best.y, '#ffb3a8', 4); }
      break;
    }
  }
  return true;
}
/** A telegraphed ground-to-air strike: a hostile ring grows for `delay` seconds, then detonates. */
const strike = (x: number, y: number, dmg: number, rad = 42, delay = 1.2) => S.eb.push({ kind: 'strike', x: clamp(x, 20, W - 20), y: clamp(y, 20, H - 20), delay, rad, dmg, t: 0, life: 9, vx: 0, vy: 0, r: 0, dead: false });

/* ---- ghost broadsides ---- */
/** Where a ghost gun's muzzle is: its real mount along the keel, mirrored (stern up). */
const bossGunPos = (b: Boss, w: BossGun) => ({ x: b.x + w.ox * b.s, y: b.y - w.oy * b.s });
/** A flank's sponsons that can train at all (the hull may mask one completely). */
const bossGuns = (b: Boss, side: number) => b.weps.filter((w) => w.arc === 'broadside' && w.side === side && w.trav.sectors.length);
/** The sponsons of a flank that join this volley: those with a bearing on the player's hull (phase 3: all of them). */
function bossFiring(b: Boss, side: number) {
  const g = bossGuns(b, side);
  return b.phase >= 3 ? g : g.filter(bossGunBears);
}
/** A sponson's locked line: its bearing on the player, or the nearest edge of its arc (phase 3 fires blind). */
function bossLock(b: Boss, w: BossGun) { const p = bossGunPos(b, w); return bossBearing(w, p.x, p.y) ?? clampTraverse(w.trav, aimAng(p.x, p.y), true); }
function updateBossBroadsides(b: Boss, dt: number, fm: number) {
  const BS = BOSS_BROADSIDE;
  b.glints.length = 0;
  for (let si = 0; si < 2; si++) {
    const side = si ? 1 : -1, v = b.volley[si];
    if (v.queue.length) {
      for (const q of v.queue) if (q.at <= S.time) { q.at = -1; q.fire(); }
      v.queue = v.queue.filter((q) => q.at !== -1);
    }
    if (!bossGuns(b, side).length) { v.wind = -1; continue; }
    if (v.wind >= 0) {
      const tele = BS.tele[b.phase - 1], guns = bossFiring(b, side);
      v.wind += dt;
      const k = clamp(v.wind / tele, 0, 1);
      for (const w of guns) {
        const p = bossGunPos(b, w);
        b.glints.push({ x: p.x, y: p.y, tele: k, ang: bossLock(b, w), spread: b.phase === 2 ? BS.rake / 2 : b.phase === 3 ? BS.weave : 0, len: 220 + 260 * k });
      }
      // slipping into its blind arc during the wind-up spoils the volley
      if (v.wind >= tele) { v.wind = -1; v.cd = guns.length ? BS.period : 0.6; if (guns.length) releaseBossVolley(b, side, guns); }
      continue;
    }
    if (v.queue.length) continue; // the ripple is still running down the hull
    v.cd -= dt * fm;
    if (v.cd > 0) continue;
    if (!bossFiring(b, side).length) { v.cd = 0.2; continue; }
    v.wind = 0;
  }
}
/** Schedule one flank's ripple: every gun's rounds, stern (top) to bow, `stagger` apart, aimed lines locked now. */
function releaseBossVolley(b: Boss, side: number, guns: BossGun[]) {
  const BS = BOSS_BROADSIDE, ph = b.phase;
  const order = [...guns].sort((a, c) => c.oy - a.oy);
  const rounds = order.map((w) => bossRounds(w.part, ph)), maxR = Math.max(...rounds);
  const locks = order.map((w) => bossLock(b, w));
  const hole = rnd(0.2, 0.8);
  let k = 0;
  for (let r = 0; r < maxR; r++) order.forEach((w, gi) => {
    if (r >= rounds[gi]) return;
    const R = rounds[gi], lock = locks[gi];
    b.volley[side > 0 ? 1 : 0].queue.push({ at: S.time + (k++) * BS.stagger, fire: () => bossRound(b, w, side, r, R, lock, hole) });
  });
  const ys = order.map((w) => b.y - w.oy * b.s), y0 = Math.min(...ys), y1 = Math.max(...ys);
  broadsideFx(b.x + side * b.halfW, (y0 + y1) / 2, side, order.length, Math.max(90, y1 - y0 + 90));
  sfx('broadside', { x: side < 0 ? 100 : W - 100, y: (y0 + y1) / 2, size: Math.min(14, k), vol: 0.8 });
}
/** One round of a ghost broadside from gun w. The pattern depends on the phase; the weapon decides the projectile. */
function bossRound(b: Boss, w: BossGun, side: number, r: number, R: number, lock: number, hole: number) {
  if (!b.alive || S.mode !== 'play') return;
  const BS = BOSS_BROADSIDE, P = S.P!, p = w.part, t = p.tier, ph = b.phase;
  const { x, y } = bossGunPos(b, w);
  const dmg = edmg() * 0.7 * (1 + 0.15 * (t - 1)) * bossHitEase(), spd = bspd() * 0.9;
  let d = lock;
  if (ph === 2 && R > 1) {
    // rake: sweep from above the line to below it, skipping a hole the player can sit in
    const u = r / (R - 1);
    if (Math.abs(u - hole) < BS.hole / BS.rake / 2) return;
    d = lock + (u - 0.5) * BS.rake;
  } else if (ph === 3) d = lock + (r % 2 ? BS.weave : -BS.weave);
  // every round stays inside the sponson's masked arc: a rake or weave never sweeps through its own hull
  const a = clampTraverse(w.trav, d, true);
  shooter = 'boss:broadside';
  switch (p.id) {
    case 'spread': for (const o of [-0.08, 0, 0.08]) eShot(x, y, a + o, spd * 0.85, { dmg, col: '#ff7a6b' }); break;
    case 'flak': { const dist = clamp(Math.hypot(P.x - x, P.y - y), 140, 700); eShot(x, y, a, 160, { kind: 'orb', r: 8, life: dist / 160, col: '#ffd27a', dmg, burst: 6 }); break; }
    case 'missile': for (const o of [-1, 1]) eShot(x, y + o * 8, a + o * 0.25, 150, { kind: 'missile', turn: 1.5 + 0.2 * t, spd: 150 + 10 * t, hp: 5 * S.sector, life: 5, r: 5, col: '#ff9f5a', dmg: dmg * 2 }); break;
    case 'rail': S.eb.push({ kind: 'beam', x, y, x2: x + Math.cos(a) * 1900, y2: y + Math.sin(a) * 1900, warn: 0.55, dur: 0.3, w: 16 + 3 * t, dmg: dmg * 6, t: 0, life: 9, vx: 0, vy: 0, r: 0, col: '#c9a6ff', dead: false, src: 'boss:broadside', gun: w, side }); break;
    default: for (const o of [-7, 7]) eShot(x, y + o, a, spd, { dmg }); // twin barrels: pulse and anything else
  }
  // phase 3 adds a slow second layer under the fast one
  if (ph === 3 && r % 2 === 0 && p.id !== 'rail' && p.id !== 'missile') eShot(x, y, clampTraverse(w.trav, lock + side * 0.42, true), spd * 0.55, { dmg, r: 5.5, col: '#ff7a6b' });
  const cs = Math.cos(a), sn = Math.sin(a);
  muzzle(x + cs * 8, y + sn * 8, '#ff7a5c', 15);
  addFx({ type: 'smoke', x: x + cs * 14, y: y + sn * 14, vx: cs * rnd(60, 120), vy: sn * rnd(60, 120), life: 0.9, max: 0.9, size: 7, grow: 2.2, a: 0.45, drag: 2 });
  fireLog.set(p.uid, S.t);
}
/** A heavy ship: phase 1 sweeps the field; later it comes about to keep the player on its beam. */
function moveBoss(b: Boss, dt: number) {
  const P = S.P!, lo = b.halfW + 12, hi = W - b.halfW - 12;
  let tx: number;
  if (b.phase === 1) tx = W / 2 + Math.sin(b.t * 0.35 * b.speedMul) * Math.max(0, W / 2 - b.halfW - 12);
  else { const side = P.x >= b.x ? 1 : -1; tx = P.x - side * (b.halfW + 260); }
  tx = lo < hi ? clamp(tx, lo, hi) : W / 2;
  const maxV = (b.phase === 1 ? 240 : 85) * b.speedMul;
  b.vx += (clamp((tx - b.x) * 1.2, -maxV, maxV) - b.vx) * Math.min(1, dt * 1.6);
  b.x += b.vx * dt;
  const ty = b.homeY + (b.phase === 3 ? 40 : 0) + Math.sin(b.t * 0.7) * 24;
  b.y += (ty - b.y) * Math.min(1, dt * 2);
}
function updateBoss(dt: number) {
  const b = S.boss; if (!b || !b.alive) return;
  const P = S.P!;
  b.t += dt; b.flash -= dt;
  if (!b.entered) { b.y += 70 * dt; if (b.y >= b.homeY) { b.y = b.homeY; b.entered = true; b.t = 0; } }
  else moveBoss(b, dt);
  for (const r of b.dv.rects) if (r.type === 'engine') for (const sx of [-0.22, 0.22]) if (Math.random() < 0.6) addFx({ type: 'fire', x: b.x + (r.x + r.w * (0.5 + sx)) * b.s, y: b.y - (r.y + r.h) * b.s - 10, vx: rnd(-10, 10), vy: rnd(-160, -110), life: 0.25, max: 0.25, size: rnd(5, 8), grow: 0.4 });
  if (b.phase >= 2 && Math.random() < dt * (b.phase === 3 ? 34 : 22)) {
    const r = pick(b.dv.rects), x = b.x + rnd(r.x, r.x + r.w) * b.s, y = b.y - (r.y + rnd(0, r.h)) * b.s;
    addFx({ type: 'fire', x, y, vx: rnd(-10, 10), vy: rnd(-30, 10), life: 0.45, max: 0.45, size: rnd(6, 10), grow: 0.8 });
    addFx({ type: 'smoke', x, y, vx: rnd(-10, 10), vy: rnd(40, 80), life: 1.4, max: 1.4, size: 7, grow: 2.4, a: 0.55 });
  }
  if (b.shieldMax) { b.shieldHitT += dt; if (b.shieldHitT > 3) b.shield = Math.min(b.shieldMax, b.shield + b.shieldMax * 0.12 * dt); }
  if (b.regen) b.hp = Math.min(b.maxHp, b.hp + b.regen * dt);
  const ph = bossPhaseOf(b.hp / b.maxHp);
  if (ph > b.phase) {
    b.phase = ph;
    if (ph === 2) setBanner('HULL BREACHED', 'Its batteries are raking', 1.8, '#ff5a4e');
    else setBanner('FULL BROADSIDE', 'Every gun it has, both flanks', 1.8, '#ff5a4e');
    sfx('alarm'); requestStop(S.stop, 0.08, true); V.shake = Math.max(V.shake, ph === 3 ? 14 : 10);
    boomFx(b.x + rnd(-b.halfW, b.halfW) * 0.6, b.y + rnd(-30, 30), 22, '#ffb347');
  }
  if (b.tractor && S.mode === 'play') P.vx += Math.sign(b.x - P.x) * b.tractor * 4 * dt;
  if (b.droneEvery && b.entered) { b.droneT -= dt; if (b.droneT <= 0) { b.droneT = b.droneEvery; for (let i = 0; i < 2; i++) spawnEnemy('drone', b.x, b.y - i * 24, { baseX: clamp(b.x, 80, W - 80), phase: i * 0.6 }); } }
  S.escortT -= dt; if (S.escortT <= 0) { S.escortT = rnd(8, 11); spawnGroup(pick(['heli', 'turret', 'tank', 'jet', 'infantry'] as EnemyType[])); }
  if (!b.entered) return;
  // Escalation lives mostly in the broadsides; the bow guns only quicken a little.
  const fmBow = b.fireMul * (b.phase === 1 ? 1 : b.phase === 2 ? 1.12 : 1.22), fm = b.fireMul * (b.phase === 1 ? 1 : b.phase === 2 ? 1.25 : 1.45);
  shooter = 'boss';
  for (const w of b.weps) {
    if (w.arc === 'broadside') continue; // fired by the flank volleys
    w.cd -= dt * fmBow; if (w.cd > 0) continue;
    if (!bossFire(w)) { w.cd = 0.25; continue; } // the player is in its blind arc: hold, loaded
    w.cd = BOSS_CD[w.part.id] * b.cdMul * rnd(0.85, 1.15); fireLog.set(w.part.uid, S.t);
  }
  updateBossBroadsides(b, dt, fm);
}
function damageBoss(d: number) {
  const b = S.boss; if (!b || !b.alive || S.mode !== 'play') return;
  d *= S.P!.dv.mods.dmgAir;
  if (b.shield > 0) { const a = Math.min(b.shield, d); b.shield -= a; d -= a; b.shieldHitT = 0; }
  const dealt = Math.min(d, Math.max(0, b.hp)); b.hp -= d; b.flash = 0.06; S.stats.dmgDealt += dealt; S.stats.dmgToTarget += dealt;
  feedOverdrive((d / b.maxHp) * 1.6);
  if (b.hp <= 0) bossDown();
}
function bossDown() {
  const b = S.boss!; b.alive = false; b.dead = true; b.hp = 0;
  S.mode = 'bossdown'; S.endT = 3.2; S.chain = 0; clearEnemyFire(true);
  S.score += 2000 * S.sector; S.kills++;
  addCarnage(S.carnage, 120);
  for (let i = 0; i < 24; i++) S.pickups.push({ x: b.x + rnd(-b.halfW, b.halfW), y: b.y + rnd(-40, 40), vx: rnd(-80, 80), vy: rnd(-80, 40), val: (4 + 2 * S.sector) * scrapSectorMul(S.sector) * S.P!.dv.scrapMult * S.heat.scrap, t: 0, kind: 'scrap' });
  setBanner(b.ghost.ai ? 'CORE DESTROYED' : 'GHOST LAID TO REST', b.ghost.name, 3, '#8fe39a');
  V.shake = 18; V.flashA = 0.35;
  requestStop(S.stop, HITSTOP.bossDeath, true); requestSlow(S.slowmo, SLOWMO_BOSS);
  emit({ type: 'bossDown', x: b.x, y: b.y });
  boomFx(b.x, b.y, 46, '#ffb347');
  later(1.5, () => { if (S.mode === 'bossdown') { boomFx(b.x, b.y + 30, 80, '#fff1c1'); V.flashA = 0.45; V.shake = 22; sfx('big', { x: b.x, y: b.y }); } });
}

/* ---------------- player ---------------- */
function updatePlayer(dt: number) {
  const P = S.P!, dv = P.dv, tune = { topSpeed: dv.speed, accel: dv.accel, brake: dv.brake };
  let ix = 0, iy = 0;
  if (keys.l) ix--; if (keys.r) ix++; if (keys.u) iy--; if (keys.d) iy++;
  let wish = { x: ix, y: iy };
  if (ix || iy) P.tx = P.ty = null;
  else if (P.tx != null && P.ty != null) wish = arriveWish(P.x, P.y, P.tx, P.ty, tune);
  const v = stepShipVelocity({ x: P.vx, y: P.vy }, wish, tune, dt);
  P.vx = v.x; P.vy = v.y;
  P.x += P.vx * dt; P.y += P.vy * dt;
  const hw = dv.width / 2, hl = dv.len / 2, x0 = hw + 6, x1 = W - hw - 6, y0 = hl + 56, y1 = H - hl - 8;
  if (P.x < x0) { P.x = x0; P.vx = Math.max(0, P.vx); } else if (P.x > x1) { P.x = x1; P.vx = Math.min(0, P.vx); }
  if (P.y < y0) { P.y = y0; P.vy = Math.max(0, P.vy); } else if (P.y > y1) { P.y = y1; P.vy = Math.min(0, P.vy); }
  if (P.tx != null && P.ty != null) { P.tx = clamp(P.tx, x0, x1); P.ty = clamp(P.ty, y0, y1); }
  keepClearOfBoss(P);
  P.bank = stepBank(P.bank, P.vx, dv.speed, dt);
  P.lastHit += dt;
  if (dv.regen) P.hp = Math.min(dv.maxHp, P.hp + dv.regen * dt);
  if (dv.shieldMax && P.lastHit > 2) P.shield = Math.min(dv.shieldMax, P.shield + dv.shieldRegen * dt);
  P.flash = Math.max(0, P.flash - dt * 5);
  for (const r of dv.rects) if (r.type === 'engine') for (const sx of [-0.22, 0.22]) if (Math.random() < 0.7) addFx({ type: 'fire', x: P.x + r.x + r.w * (0.5 + sx) + rnd(-1, 1), y: P.y + r.y + r.h + 9, vx: rnd(-8, 8), vy: rnd(150, 220), life: 0.2, max: 0.2, size: rnd(3, 4.5), grow: 0.4 });
  if (P.hp < dv.maxHp * 0.45 && Math.random() < dt * 16) {
    const r = pick(dv.rects), x = P.x + rnd(r.x, r.x + r.w), y = P.y + r.y + rnd(0, r.h);
    addFx({ type: 'smoke', x, y, vx: rnd(-10, 10), vy: rnd(70, 110), life: 1, max: 1, size: 4, grow: 2.4, a: 0.6 });
    if (Math.random() < 0.5) addFx({ type: 'fire', x, y, vx: 0, vy: 60, life: 0.3, max: 0.3, size: 5, grow: 0.6 });
  }
  if (P.hp < dv.maxHp * 0.25) V.hurt = Math.max(V.hurt, 0.22 + 0.12 * Math.sin(S.t * 6));
}
/** Two dreadnoughts do not pass through each other: the player's hull is shouldered out of the ghost's bounding box
 *  along the shallower overlap (and never pushed off the field). */
function keepClearOfBoss(P: Player) {
  const b = S.boss; if (!b || !b.alive || !b.entered) return;
  const hw = P.dv.width / 2, hl = P.dv.len / 2, bl = (b.dv.len * b.s) / 2;
  const ox = hw + b.halfW - Math.abs(P.x - b.x), oy = hl + bl - Math.abs(P.y - b.y);
  if (ox <= 0 || oy <= 0) return;
  const x0 = hw + 6, x1 = W - hw - 6, y1 = H - hl - 8;
  const sx = P.x >= b.x ? 1 : -1, canX = sx > 0 ? P.x + ox <= x1 : P.x - ox >= x0;
  if (oy < ox || !canX) { P.y = Math.min(y1, P.y + oy); P.vy = Math.max(0, P.vy); if (P.ty != null) P.ty = Math.max(P.ty, P.y); }
  else { P.x += sx * ox; P.vx = sx > 0 ? Math.max(0, P.vx) : Math.min(0, P.vx); }
}
/** `src` names what hit the ship (enemy type, 'boss', 'ram:<type>', 'strike', 'beam'); tallied in S.stats.dmgBy. */
export function damagePlayer(d: number, src = 'unknown') {
  const P = S.P!;
  if (S.mode !== 'play' || S.god) return;
  if (!S.firstHitUsed && hasFlag(S.relics, 'first_hit_free')) { S.firstHitUsed = true; spark(P.x, P.y, '#9aa7b4', 10); setBanner('REACTIVE PLATING', 'First hit absorbed', 1.2, '#9aa7b4'); return; }
  if (S.overdrive.active && S.overdrive.kind === 'bulwark') d *= 0.5;
  P.lastHit = 0;
  if (P.shield > 0) { const a = Math.min(P.shield, d); P.shield -= a; d -= a; }
  if (d > 0) {
    P.hp -= d; S.stats.dmgTaken += d; S.stats.dmgBy[src] = (S.stats.dmgBy[src] || 0) + d; P.flash = 1; V.hurt = Math.min(1, V.hurt + 0.25 + d / (P.dv.maxHp * 0.08)); V.shake = Math.min(10, V.shake + d * 0.5); sfx('hit', { x: P.x, layer: 'ship' });
    const heavy = d >= P.dv.maxHp * 0.07;
    requestStop(S.stop, heavy ? HITSTOP.playerHurt : hitstopFor(false, d * 4), heavy);
    emit({ type: 'playerHit', x: P.x, y: P.y, n: d });
  }
  if (P.hp <= 0) {
    if (S.cheatDeath && !S.cheatDeathUsed) {
      S.cheatDeathUsed = true; P.hp = P.dv.maxHp * 0.3; clearEnemyFire(true); V.flashA = 0.5; setBanner('EMERGENCY JUMP', 'Hull restored to 30%', 1.8, '#7fb6ff'); sfx('alarm');
      return;
    }
    playerDie();
  }
}
function playerDie() {
  const P = S.P!; P.hp = 0; S.mode = 'dying'; S.endT = 2.4; endOverdrive();
  for (let i = 0; i < 8; i++) later(i * 0.12, () => boomFx(P.x + rnd(-P.dv.width / 2, P.dv.width / 2), P.y + rnd(-P.dv.len / 2, P.dv.len / 2), rnd(14, 28), pick(['#ffb347', '#ff6a3d', '#fff1c1'])));
  sfx('big', { x: P.x, layer: 'ship' }); V.shake = 16; V.flashA = 0.4; boomFx(P.x, P.y, 40, '#ffb347');
  requestStop(S.stop, 0.2, true); requestSlow(S.slowmo, SLOWMO);
}
/** Escort drones orbit the hull on an ellipse that hugs a long, narrow ship. */
export function dronePos(i: number, n: number) { const P = S.P!, a = S.t * 1.8 + (i * Math.PI * 2) / n; return { x: P.x + Math.cos(a) * (P.dv.width / 2 + 70), y: P.y + Math.sin(a) * (P.dv.len / 2 + 24) }; }
function updateDrones(dt: number) {
  const P = S.P!, n = P.dv.drones; if (!n) return;
  for (let i = 0; i < n; i++) {
    P.droneCd[i] = (P.droneCd[i] || 0) - dt * P.dv.fireMult; if (P.droneCd[i] > 0) continue; P.droneCd[i] = 0.42;
    const p = dronePos(i, n);
    const tg = nearest(p.x, p.y, (e) => e.layer !== 'ground', 520);
    const a = tg ? Math.atan2(tg.y - p.y, tg.x - p.x) : -Math.PI / 2;
    S.pb.push(bolt(p.x, p.y, Math.cos(a) * 650, Math.sin(a) * 650, 4 * (1 + 0.3 * (P.dv.droneTier - 1)), 'air', '#7fb6ff', 2));
  }
}

/* ---------------- overdrive ---------------- */
export function feedOverdrive(amount: number) {
  const o = S.overdrive; if (o.active || amount <= 0 || S.mode !== 'play') return;
  const was = o.charge; o.charge = Math.min(1, o.charge + amount);
  if (was < 1 && o.charge >= 1) { emit({ type: 'overdriveReady', x: S.P!.x, y: S.P!.y, kind: o.kind }); }
}
/** Fire Overdrive if it is charged. Returns whether it started. */
export function triggerOverdrive(): boolean {
  const o = S.overdrive, P = S.P;
  if (!P || o.active || o.charge < 1 || S.mode !== 'play') return false;
  o.active = true; o.charge = 0; o.dur = OVERDRIVES[o.kind].duration; o.t = o.dur; o.tick = 0;
  S.stats.overdrives++;
  setBanner(OVERDRIVES[o.kind].name.toUpperCase(), 'Overdrive', 1.2, OVERDRIVES[o.kind].col);
  requestSlow(S.slowmo, SLOWMO_SHORT); V.shake = Math.max(V.shake, 8); V.flashA = Math.max(V.flashA, 0.2);
  emit({ type: 'overdrive', x: P.x, y: P.y, kind: o.kind });
  if (o.kind === 'wing') {
    for (let i = 0; i < 8; i++) { const a = -Math.PI / 2 + (i - 3.5) * 0.35; o.allies.push({ x: P.x, y: P.y, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300, hdg: a, cd: 0.4 + i * 0.05, tg: null, t: 0 }); }
  }
  if (o.kind === 'bulwark') {
    o.radius = Math.max(P.dv.width, P.dv.len) / 2 + 110;
    for (const b of S.eb) if (!b.dead && b.kind !== 'beam' && b.kind !== 'strike' && Math.hypot(b.x - P.x, b.y - P.y) < 700) { b.dead = true; spark(b.x, b.y, '#4fd1e8', 2); }
    for (const e of [...S.enemies]) if (!e.dead && Math.hypot(e.x - P.x, e.y - P.y) < 460 + e.r) damageTarget(e, 70 * (1 + 0.25 * (S.level - 1)));
    if (S.boss?.alive && Math.hypot(S.boss.x - P.x, S.boss.y - P.y) < 460 + S.boss.r) damageBoss(120);
    boomFx(P.x, P.y, 90, '#9ff3ff');
  }
  return true;
}
function endOverdrive() {
  const o = S.overdrive; if (!o.active) return;
  o.active = false; o.beam = null; o.radius = 0; o.allies = [];
  emit({ type: 'overdriveEnd', x: S.P?.x ?? 0, y: S.P?.y ?? 0, kind: o.kind });
}
function updateOverdrive(dt: number) {
  const o = S.overdrive, P = S.P!;
  for (const p of o.trail) { p.life -= dt; p.y += S.scroll * dt; }
  o.trail = o.trail.filter((p) => p.life > 0 && p.y < H + 60);
  if (keys.od) { keys.od = false; triggerOverdrive(); }
  if (!o.active) return;
  o.t -= dt; o.tick -= dt;
  const lvl = 1 + 0.25 * (S.level - 1);
  if (o.kind === 'lance') {
    o.beam = { x1: P.x, y1: P.y, x2: P.x, y2: P.y, w: 38, ground: true, col: OVERDRIVES.lance.col };
    if (o.tick <= 0) {
      o.tick = 0.05;
      groundBlast(P.x, P.y, 44, 40 * lvl, true);
      for (const e of S.enemies) if (!e.dead && e.layer === 'ground' && Math.hypot(e.x - P.x, e.y - P.y) < 50 + e.r) damageTarget(e, 16 * lvl);
      o.trail.push({ x: P.x + rnd(-6, 6), y: P.y + rnd(-4, 4), life: 6, max: 6 });
      addFx({ type: 'fire', x: P.x + rnd(-14, 14), y: P.y + rnd(-10, 10), vx: rnd(-30, 30), vy: rnd(-30, 30), life: 0.7, max: 0.7, size: rnd(10, 18), grow: 1.4, ground: true });
      if (Math.random() < 0.4) addFx({ type: 'smoke', x: P.x, y: P.y, vx: rnd(-15, 15), vy: rnd(-15, 15), life: 2, max: 2, size: 12, grow: 2, a: 0.5, ground: true });
      // Molten spray and a dust front thrown out past the hull's silhouette, so the burn reads from above.
      const R = Math.max(P.dv.width, P.dv.len) / 2;
      for (let i = 0; i < 3; i++) {
        const an = rnd(0, Math.PI * 2), sp = rnd(320, 640);
        addFx({ type: 'spark', x: P.x, y: P.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: rnd(0.5, 0.9), max: 0.9, size: rnd(1.6, 2.6), drag: 1.3, ground: true, h: 4, vh: rnd(60, 200), grav: -320, tint: '#ffd27a' });
      }
      if (Math.random() < 0.6) { const an = rnd(0, Math.PI * 2); addFx({ type: 'dust', x: P.x + Math.cos(an) * R * 0.8, y: P.y + Math.sin(an) * R * 0.8, vx: Math.cos(an) * 140, vy: Math.sin(an) * 140, life: 1.1, max: 1.1, size: 18, grow: 2.4, drag: 1.6, a: 0.4, ground: true, h: 2, col: '#6a5d50', rot: rnd(0, 6.28) }); }
      V.shake = Math.max(V.shake, 3);
    }
  } else if (o.kind === 'spear') {
    const x = P.x, y = P.y - P.dv.len / 2, w = 54;
    o.beam = { x1: x, y1: y, x2: x, y2: -60, w, ground: false, col: OVERDRIVES.spear.col };
    if (o.tick <= 0) {
      o.tick = 0.05;
      for (const e of S.enemies) if (!e.dead && e.layer === 'air' && e.y < y && Math.abs(e.x - x) < w / 2 + e.r) damageTarget(e, 26 * lvl);
      const B = S.boss; if (B && B.alive && B.y < y && Math.abs(B.x - x) < B.halfW) damageBoss(30 * lvl);
      for (const b of S.eb) if (!b.dead && b.kind !== 'beam' && b.kind !== 'strike' && b.y < y && Math.abs(b.x - x) < w / 2 + 6) b.dead = true;
      V.shake = Math.max(V.shake, 4);
    }
  } else if (o.kind === 'wing') {
    for (const a of o.allies) {
      a.t += dt;
      if (!a.tg || a.tg.dead) a.tg = nearest(a.x, a.y, () => true, 1400);
      const tx = a.tg ? a.tg.x : P.x + Math.cos(a.t * 2) * 200, ty = a.tg ? a.tg.y + 90 : P.y - 200;
      const want = Math.atan2(ty - a.y, tx - a.x), na = a.hdg + clamp(angDiff(want, a.hdg), -5 * dt, 5 * dt);
      a.hdg = na; a.vx = Math.cos(na) * 520; a.vy = Math.sin(na) * 520; a.x += a.vx * dt; a.y += a.vy * dt;
      a.cd -= dt;
      if (a.tg && a.cd <= 0 && Math.hypot(a.tg.x - a.x, a.tg.y - a.y) < 320) {
        a.cd = 0.22; const ang = Math.atan2(a.tg.y - a.y, a.tg.x - a.x);
        S.pb.push(bolt(a.x, a.y, Math.cos(ang) * 800, Math.sin(ang) * 800, 9 * lvl, 'both', '#7fb6ff', 2.5));
      }
    }
  } else if (o.kind === 'bulwark') {
    for (const b of S.eb) if (!b.dead && b.kind !== 'beam' && b.kind !== 'strike' && Math.hypot(b.x - P.x, b.y - P.y) < o.radius) { b.dead = true; spark(b.x, b.y, '#4fd1e8', 3); }
  }
  if (o.t <= 0) endOverdrive();
}

/* ---------------- gunnery: AUTO batteries and manually aimed HEAVY groups ---------------- */
/**
 * Who aims the heavy weapons. `manual` false (the default: touch screens, the balance harness, headless tests) keeps
 * every weapon on its own targeting; main.ts turns it on for a mouse. `family` remembers the selected group's family
 * across fights. Ghost bosses fly their own fire control (bossFire / ghost broadsides) and are unaffected.
 */
export const gunnery = { manual: false, family: null as HeavyFamily | null };
/** Manual fire numbers: the heavy-shot damage bonus (a deliberate shot replaces the broadside ripple's 1.2x), and how
 *  close to the reticle a missile lock reaches. Cones are the mount traverses (mountTraverse in data/parts.ts). */
export const MANUAL = { dmgMul: 1.1, lockR: 170 } as const;
/**
 * The reticle (field units, the point under the mouse). `fire`: left mouse held (the selected group); `salvo`: right
 * mouse held (every heavy group). `group` indexes S.groups. `lock` is the missile lock (target nearest the reticle
 * while a missile group is selected or firing), `lockT` how long it has held. `bears[uid]` whether that heavy mount can
 * bear on the reticle now; `shotAt` the S.t of the last heavy shot (HUD punch).
 */
export const aim = {
  x: W / 2, y: H * 0.35, fire: false, salvo: false, group: 0,
  lock: null as Ent | null, lockT: 0, bears: {} as Record<number, boolean>, why: {} as Record<number, NoBear>, shotAt: -9,
  /** The target right under the reticle, if any. */ hover: null as Ent | null,
};
function resetAim() {
  aim.fire = aim.salvo = false; aim.lock = null; aim.hover = null; aim.lockT = 0; aim.bears = {}; aim.why = {}; aim.shotAt = -9;
  const i = gunnery.family ? S.groups.findIndex((g) => g.family === gunnery.family) : -1;
  aim.group = Math.max(0, i);
}
/** Select heavy group `i` (0-based; key 1 is 0). Returns false if the ship has no such group. */
export function selectGroup(i: number): boolean {
  if (i < 0 || i >= S.groups.length) return false;
  aim.group = i; gunnery.family = S.groups[i].family; return true;
}
export function cycleGroup(d: number): boolean {
  const n = S.groups.length; if (n < 2) return false;
  return selectGroup((aim.group + d + n) % n);
}
/** The groups the trigger is pulling this frame. */
export function firingGroups(): WeaponGroup[] {
  if (aim.salvo) return S.groups;
  return aim.fire && S.groups[aim.group] ? [S.groups[aim.group]] : [];
}
/** Why a heavy mount cannot bear: '' (it can), 'arc' (outside its facing's arc), 'blocked' (inside it, but the ship's own
 *  hull masks that bearing), 'range' (ground ordnance out of reach), 'air' (a top-deck mount and the reticle is on a
 *  ground target), 'ground' (ventral ordnance on an aircraft lock). */
export type NoBear = '' | 'arc' | 'blocked' | 'range' | 'air' | 'ground';
/**
 * Can heavy mount m bear on field point (ax, ay), with `hover` the target under the reticle? Line weapons (rails)
 * must have the point inside their traverse; ground ordnance has a reach; missiles are guided and launch from any
 * mount, but a top-deck pod cannot take a ground lock. A mount never engages a layer its placement cannot reach.
 */
export function heavyWhy(m: Mount, ax: number, ay: number, hover: Ent | null): NoBear {
  const P = S.P!, fam = m.part ? weaponFamily(m.part.id) : null; if (!fam) return 'arc';
  const x = P.x + m.ox, y = P.y + m.oy, def = HEAVY_FAMILIES[fam], t = m.trav;
  if (def.aim === 'ground') return Math.hypot(ax - x, ay - y) <= def.reach ? '' : 'range';
  if (hover && !layersHit(t.layers, hover.layer)) return t.layers === 'air' ? 'air' : 'ground';
  if (def.aim === 'lock') return '';
  const a = Math.atan2(ay - y, ax - x);
  return inTraverse(t, a) ? '' : blockedAt(t, a) ? 'blocked' : 'arc';
}
export const heavyBears = (m: Mount, ax: number, ay: number, hover: Ent | null = null) => heavyWhy(m, ax, ay, hover) === '';
/** Where a heavy turret should point (renderer hook): the reticle or the missile lock, or null when it aims itself. */
export function manualAimFor(uid: number): { x: number; y: number } | null {
  const P = S.P; if (!gunnery.manual || !P || !S.active) return null;
  const m = P.dv.mounts.find((q) => q.part?.uid === uid);
  const fam = m?.part ? weaponFamily(m.part.id) : null;
  if (!fam) return null;
  if (fam === 'missile' && aim.lock && !aim.lock.dead) return aim.lock;
  return aim;
}
/** Missile lock: the target nearest the reticle (bosses by their hull), within MANUAL.lockR. */
export function lockNear(x: number, y: number, layer = 'both'): Ent | null {
  let best: Ent | null = null, bd: number = MANUAL.lockR;
  for (const e of allTargets()) {
    if (e.dead || EN[e.type as EnemyType]?.salvage || !layerOk(layer, e.layer)) continue;
    const d = e.isBoss ? Math.max(0, Math.abs(e.x - x) - e.halfW) + Math.max(0, Math.abs(e.y - y) - (e.dv.len * e.s) / 2) : Math.hypot(e.x - x, e.y - y) - e.r;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function updateAim(dt: number) {
  // the target under the reticle (tighter than a missile lock): what a line or lock weapon would be aimed at
  const hover = lockNear(aim.x, aim.y);
  aim.hover = hover && Math.hypot(hover.x - aim.x, hover.y - aim.y) - (hover.isBoss ? hover.halfW : hover.r) < 60 ? hover : null;
  const wantLock = S.groups[aim.group]?.family === 'missile' || (aim.salvo && S.groups.some((g) => g.family === 'missile'));
  const tg = wantLock ? lockNear(aim.x, aim.y) : null;
  if (tg !== aim.lock) { aim.lock = tg; aim.lockT = 0; } else if (tg) aim.lockT += dt;
  // missiles judge their lock, everything else what is under the reticle
  for (const g of S.groups) for (const m of g.mounts) {
    const w = heavyWhy(m, aim.x, aim.y, g.family === 'missile' ? aim.lock ?? aim.hover : aim.hover);
    aim.why[m.part!.uid] = w; aim.bears[m.part!.uid] = w === '';
  }
}
/** One manually aimed heavy shot from mount m at the reticle. */
function fireHeavy(m: Mount, x: number, y: number) {
  const P = S.P!, p = m.part!, fam = weaponFamily(p.id)!, d = wDmg(p) * MANUAL.dmgMul, c = WEAPONS[p.id].col;
  const ax = aim.x, ay = aim.y, dist = Math.hypot(ax - x, ay - y);
  switch (fam) {
    case 'rail': {
      const a = clampTraverse(m.trav, Math.atan2(ay - y, ax - x));
      railLine(x, y, x + Math.cos(a) * 1900, y + Math.sin(a) * 1900, d, c, m.trav.layers);
      muzzle(x + Math.cos(a) * 10, y + Math.sin(a) * 10, c, 24);
      kick(-Math.cos(a) * 9, -Math.sin(a) * 9); addTrauma(0.2); V.flashA = Math.max(V.flashA, 0.05);
      break;
    }
    case 'missile': {
      // launched from the pod along its bearing (inside its traverse), then guided onto the lock or the point
      const a0 = m.trav.sectors.length ? clampTraverse(m.trav, Math.atan2(ay - y, ax - x)) : -Math.PI / 2;
      for (const s of [-1, 1]) {
        const la = m.trav.sectors.length ? clampTraverse(m.trav, a0 + s * 0.45) : a0 + s * 0.45, vx = Math.cos(la) * 280, vy = Math.sin(la) * 280;
        const lay = m.trav.layers === 'air' ? 'air' : 'both', lk = aim.lock && !aim.lock.dead && layerOk(lay, aim.lock.layer) ? aim.lock : null;
        const b = bolt(x + s * 5, y, vx, vy, d, lay, c, 3);
        Object.assign(b, { kind: 'missile', turn: 6, speed: 520, life: 3.2, manual: true, tg: lk, dest: { x: ax, y: ay } });
        S.pb.push(b);
      }
      muzzle(x + Math.cos(a0) * 6, y + Math.sin(a0) * 6, c, 14); sfx('missile', { x, layer: 'ship' }); addTrauma(0.07);
      break;
    }
    case 'mortar': {
      shell(x, y, ax + rnd(-8, 8), ay + rnd(-8, 8), d, c, 40, 0.42 + dist / 1300);
      muzzle(x, y - 6, c, 18); sfx('mortar', { x, layer: 'ship' });
      kick(((x - ax) / Math.max(1, dist)) * 6, ((y - ay) / Math.max(1, dist)) * 6); addTrauma(0.12);
      break;
    }
    case 'bomb': {
      const n = p.tier >= 3 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const life = 0.45 + dist / 1000 + i * 0.06, b = bolt(x, y, 0, 0, d, 'ground', c, 4);
        Object.assign(b, { kind: 'bomb', life, max: life, aoe: 50, sx: x, sy: y, tx: ax + rnd(-16, 16), ty: ay + rnd(-16, 16) });
        S.pb.push(b);
      }
      sfx('bombDrop', { x, layer: 'ship' }); addTrauma(0.05); kick(0, -3);
      break;
    }
  }
  aim.shotAt = S.t;
}

/* ---------------- player weapons: batteries by arc ---------------- */
const bolt = (x: number, y: number, vx: number, vy: number, dmg: number, layer: string, col: string, r: number): Ent => ({ x, y, vx, vy, dmg, layer, col, r, kind: 'bolt', life: 2.5, dead: false });
const layerOk = (bl: string, el: string) => bl === 'both' || el === 'both' || bl === el;
export const allTargets = (): Ent[] => (S.boss && S.boss.alive ? [...S.enemies, S.boss] : S.enemies);
function nearest(x: number, y: number, f: (e: Ent) => boolean, maxD: number) {
  let best: Ent | null = null, bd = maxD;
  for (const e of allTargets()) { if (e.dead || !f(e)) continue; const d = Math.hypot(e.x - x, e.y - y) - (e.isBoss ? e.r * 0.6 : 0); if (d < bd) { bd = d; best = e; } }
  return best;
}
/** Reach by arc and part (to the target's edge): the data in parts.ts (RANGE, Mount.range), which the builder shows.
 *  Cones are the masked mount traverses (m.trav). */
export const ARC_RANGE = RANGE;
/** How much a target off the mount's facing costs in target choice (field units per radian): guns prefer what they face. */
const OFF_FACING = { bow: 260, dorsal: 90, broadside: 170 } as const;
/** A target and the bearing a mount fires at it along. */
export interface ArcHit { e: Ent; a: number }
/** Is an enemy on the field and live enough to shoot at (rear entries still holding off the edge are not)? */
const onFieldTarget = (e: Ent) => !e.dead && !(e.warnT > 0) && e.y > -40 && e.y < H + 20 && e.x > -40 && e.x < W + 40;
/**
 * The best target for a bow, top-deck or broadside mount, or null when nothing is in its arc (the gun then holds fire).
 * Every bearing must lie inside the mount's masked traverse: an aft-angled sponson only fires aft, a turret facing
 * astern only engages what is astern, and a bearing the hull blocks is never fired through. A ghost's hull counts if
 * any part of it is in the arc. Bow and broadside mounts engage air and ground, top-deck turrets aircraft and ships.
 */
export function arcTarget(m: Mount, x: number, y: number): ArcHit | null {
  const t = m.trav, arc = m.arc;
  if (arc !== 'bow' && arc !== 'dorsal' && arc !== 'broadside') return null;
  const range = m.range || RANGE[arc], face = faceAngle(m.facing);
  let best: ArcHit | null = null, bd = Infinity;
  for (const e of allTargets()) {
    if (!onFieldTarget(e) || !layersHit(t.layers, e.layer)) continue;
    const dist = e.isBoss ? Math.hypot(Math.max(0, Math.abs(e.x - x) - e.halfW), Math.max(0, Math.abs(e.y - y) - (e.dv.len * e.s) / 2)) : Math.hypot(e.x - x, e.y - y) - e.r;
    if (dist > range) continue;
    const a = bearingTo(t, x, y, aimPts(e));
    if (a === null) continue;
    const d = dist + Math.abs(angDiff(a, face)) * OFF_FACING[arc] + (EN[e.type as EnemyType]?.salvage ? 300 : 0);
    if (d < bd) { bd = d; best = { e, a }; }
  }
  return best;
}
function fireWeapons(dt: number) {
  const P = S.P!, o = S.overdrive;
  const fm = P.dv.fireMult * (o.active ? 1.5 : 1);
  const manual = gunnery.manual && S.groups.length > 0;
  if (manual) updateAim(dt);
  const pulling = manual ? firingGroups() : [];
  for (const m of P.dv.mounts) {
    const p = m.part; if (!p || !has(WEAPONS, p.id)) continue;
    if (P.cds[p.uid] === undefined) P.cds[p.uid] = rnd(0, 0.3);
    P.cds[p.uid] -= dt * fm; if (P.cds[p.uid] > 0) continue;
    const x = P.x + m.ox, y = P.y + m.oy;
    if (manual && weaponFamily(p.id)) {
      // HEAVY, manual: loaded and waiting until the trigger pulls its group and it can bear on the reticle.
      P.cds[p.uid] = 0;
      if (!pulling.some((g) => g.mounts.includes(m)) || !aim.bears[p.uid]) continue;
      fireHeavy(m, x, y); fireLog.set(p.uid, S.t);
      P.cds[p.uid] = wCd(p) * (p.id === 'rail' ? P.dv.mods.railCdMul : 1);
      continue;
    }
    if (m.arc === 'broadside') {
      if (!arcTarget(m, x, y)) { P.cds[p.uid] = 0.08; continue; }
      const v = S.volley[m.side < 0 ? 0 : 1];
      if (!v.queue.some((q) => q.m === m)) v.queue.push({ at: 0, m });
      P.cds[p.uid] = Infinity; // armed: the volley releases it
      continue;
    }
    const ok = fireWeapon(p, m, x, y, 1);
    if (ok) fireLog.set(p.uid, S.t);
    P.cds[p.uid] = ok ? wCd(p) * (p.id === 'rail' ? P.dv.mods.railCdMul : 1) : 0.1;
    if (ok && p.id !== 'pd' && p.id !== 'tesla' && m.arc !== 'ventral') muzzle(x + Math.cos(lastAim) * 7, y + Math.sin(lastAim) * 7, WEAPONS[p.id].col, p.id === 'rail' ? 20 : 10);
  }
  updateVolleys(dt);
}
/** Broadside cadence: a side fires one ripple volley per period, each gun firing as many rounds as fit its cooldown. */
export const BROADSIDE = { period: 1.7, stagger: 0.035, maxRounds: 12, dmgMul: 1.2, gather: 0.45 } as const;
export const broadsideRounds = (p: Part) => Math.max(1, Math.min(BROADSIDE.maxRounds, Math.round(BROADSIDE.period / wCd(p))));
/**
 * Broadside volleys: every armed gun on a side waits (up to `gather` s) for its sisters, then the whole side fires as
 * one ripple from stern to bow, `stagger` s between rounds. A side fires about once per `period`; every gun packs
 * period / cooldown rounds into the ripple, at `dmgMul` damage, and more guns per side add up to +40%.
 */
function updateVolleys(dt: number) {
  const P = S.P!;
  for (let si = 0; si < 2; si++) {
    const v = S.volley[si], side = si === 0 ? -1 : 1;
    if (!v.queue.length) { v.wait = 0; continue; }
    const armedQ = v.queue.filter((q) => q.at === 0);
    if (armedQ.length && !v.queue.some((q) => q.at > 0)) {
      v.wait += dt;
      const need = P.dv.mounts.filter((m) => m.arc === 'broadside' && m.part && m.side === side && m.trav.sectors.length).length;
      if (armedQ.length < need && v.wait < BROADSIDE.gather) continue;
      const guns = armedQ.map((q) => q.m).sort((a, b) => b.oy - a.oy), n = guns.length;
      const rounds = guns.map((m) => broadsideRounds(m.part!)), maxR = Math.max(...rounds);
      const sched: { at: number; m: Mount }[] = [];
      let k = 0;
      for (let r = 0; r < maxR; r++) guns.forEach((m, gi) => { if (r < rounds[gi]) sched.push({ at: S.time + (k++) * BROADSIDE.stagger + 1e-6, m }); });
      v.queue = sched; v.wait = 0;
      guns.forEach((m, gi) => { P.cds[m.part!.uid] = Math.max(BROADSIDE.period, wCd(m.part!) * rounds[gi]) * (m.part!.id === 'rail' ? P.dv.mods.railCdMul : 1) + k * BROADSIDE.stagger; });
      (v as any).n = n;
      S.stats.broadsides++; S.stats.maxVolley = Math.max(S.stats.maxVolley, n);
      emit({ type: 'broadside', x: P.x + side * P.dv.width / 2, y: P.y + guns.reduce((s, m) => s + m.oy, 0) / n, side, n, kind: String(k) });
      V.shake = Math.min(14, V.shake + 2 + n * 1.5);
      if (k >= 6) requestStop(S.stop, 0.025 + 0.01 * Math.min(4, n));
    }
    const n = (v as any).n || 1, mul = BROADSIDE.dmgMul * (1 + 0.1 * Math.min(4, n - 1));
    for (const q of v.queue) {
      if (q.at <= 0 || q.at > S.time) continue;
      q.at = -1;
      // the muzzle is the sponson itself (its real place along the keel), and the round leaves along its bearing
      const m = q.m, p = m.part!, x = P.x + m.ox, y = P.y + m.oy;
      if (fireWeapon(p, m, x, y, mul)) fireLog.set(p.uid, S.t);
      const cs = Math.cos(lastAim), sn = Math.sin(lastAim);
      muzzle(x + cs * 10, y + sn * 10, WEAPONS[p.id].col, 16);
      addFx({ type: 'smoke', x: x + cs * 14, y: y + sn * 14, vx: cs * rnd(60, 120), vy: sn * rnd(60, 120), life: 0.9, max: 0.9, size: 6, grow: 2.2, a: 0.45, drag: 2 });
    }
    v.queue = v.queue.filter((q) => q.at !== -1);
  }
}
/** Field angle of the last shot fireWeapon aimed (muzzle flashes and smoke follow it). */
let lastAim = -Math.PI / 2;
function fireWeapon(p: Part, m: Mount, x: number, y: number, mul: number): boolean {
  const d = wDmg(p) * mul, c = WEAPONS[p.id].col, arc = m.arc, trav = m.trav;
  // aim for bow, top-deck and broadside guns: a bearing inside the mount's masked traverse, or (a broadside round with
  // its target gone, a missile) along its facing, held inside the traverse
  let a = -Math.PI / 2, tg: Ent | null = null;
  if (arc === 'bow' || arc === 'broadside' || arc === 'dorsal') {
    const hit = arcTarget(m, x, y);
    if (!hit && arc !== 'broadside' && p.id !== 'missile') return false;
    if (!trav.sectors.length) return false; // the hull masks it completely
    tg = hit?.e ?? null; a = hit ? hit.a : restAngle(m);
  }
  lastAim = a;
  /** Any spread of rounds stays inside the traverse too. */
  const inArc = (aa: number) => (trav.sectors.length && arc !== 'ventral' && arc !== 'omni' ? clampTraverse(trav, aa) : aa);
  // Bolts engage what the mount can engage: top-deck guns cannot hit the ground.
  const lay = trav.layers === 'air' ? 'air' : trav.layers === 'ground' ? 'ground' : 'both';
  // Broadside guns (and bow flak) shelling a ground target lob a shell onto it instead of a flat bolt; other bow guns
  // strafe it with bolts.
  if ((arc === 'broadside' || (arc === 'bow' && p.id === 'flak')) && tg && tg.layer === 'ground' && p.id !== 'rail' && p.id !== 'missile') {
    const n = p.id === 'spread' ? (p.tier >= 3 ? 3 : 2) : 1;
    for (let i = 0; i < n; i++) shell(x, y, tg.x + rnd(-14, 14) * i, tg.y + S.scroll * 0.5 + rnd(-10, 10) * i, d * (p.id === 'flak' ? 1.4 : 1.15), c, 28, 0.5);
    sfx('cannon', { x, layer: 'ship' }); return true;
  }
  switch (p.id) {
    case 'pulse': S.pb.push(bolt(x, y, Math.cos(a) * 760, Math.sin(a) * 760, d, lay, c, 3.5)); sfx('pew', { x, layer: 'ship' }); return true;
    case 'spread': { const n = p.tier >= 3 ? 5 : 3; for (let i = 0; i < n; i++) { const aa = inArc(a + (i - (n - 1) / 2) * 0.15); S.pb.push(bolt(x, y, Math.cos(aa) * 640, Math.sin(aa) * 640, d, lay, c, 3)); } sfx('spread', { x, layer: 'ship' }); return true; }
    case 'flak': {
      const dist = tg ? clamp(Math.hypot(tg.x - x, tg.y - y), 80, 700) : 260;
      const b = bolt(x, y, Math.cos(a) * 560, Math.sin(a) * 560, d, lay, c, 4); Object.assign(b, { kind: 'flak', life: dist / 560, aoe: 56 }); S.pb.push(b); sfx('flak', { x, layer: 'ship' }); return true;
    }
    case 'missile': {
      // the pair leaves the pod either side of its bearing, then homes
      for (const s of [-1, 1]) {
        const la = inArc(a + s * 0.45);
        const b = bolt(x + s * 4, y, Math.cos(la) * 260, Math.sin(la) * 260, d, lay, c, 3); Object.assign(b, { kind: 'missile', turn: 5, speed: 470, life: 2.6 }); S.pb.push(b);
      }
      sfx('missile', { x, layer: 'ship' }); return true;
    }
    case 'bomb': {
      // Ventral bomb bay: carpet-bombs the ground under the hull. Prefers ground targets beneath the ship.
      const P = S.P!, under = nearest(x, y, (e) => e.layer === 'ground' && Math.abs(e.x - P.x) < P.dv.width / 2 + 50 && Math.abs(e.y - P.y) < P.dv.len / 2 + 70, 400);
      const n = p.tier >= 3 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const tx = under ? under.x + rnd(-10, 10) : P.x + rnd(-P.dv.width * 0.45, P.dv.width * 0.45), ty = under ? under.y : P.y + rnd(-P.dv.len * 0.45, P.dv.len * 0.45);
        const b = bolt(x, y, 0, 0, d, 'ground', c, 4); Object.assign(b, { kind: 'bomb', life: 0.55, max: 0.55, aoe: 46, sx: x, sy: y, tx, ty }); S.pb.push(b);
      }
      sfx('bombDrop', { x, layer: 'ship' }); return true;
    }
    case 'artillery': {
      const P = S.P!;
      const reach = m.range || RANGE.artillery;
      const tg2 = nearest(x, y, (e) => (e.layer === 'ground' && !EN[e.type as EnemyType].salvage), reach)
        ?? nearest(x, y, (e) => e.layer === 'ground', reach);
      const tx = tg2 ? tg2.x : P.x + rnd(-260, 260), ty = tg2 ? (tg2.isBoss ? tg2.y : tg2.y + S.scroll * 0.6) : P.y - rnd(80, 320);
      shell(x, y, tx, ty, d, c, 36, 0.6); sfx('mortar', { x, layer: 'ship' }); return true;
    }
    case 'rail': {
      railLine(x, y, x + Math.cos(a) * 1500, y + Math.sin(a) * 1500, d, c, trav.layers);
      return true;
    }
    case 'tesla': {
      let cx = x, cy = y, range: number = m.range || RANGE.tesla, any = false; const hit = new Set<Ent>();
      for (let k = 0; k < 2 + p.tier; k++) {
        let best: Ent | null = null, bd = range;
        for (const e of allTargets()) { if (e.dead || hit.has(e) || !layersHit(trav.layers, e.layer)) continue; const dd = Math.hypot(e.x - cx, e.y - cy) - (e.isBoss ? e.r * 0.6 : 0); if (dd < bd) { bd = dd; best = e; } }
        if (!best) break; hit.add(best);
        S.beams.push({ x1: cx, y1: cy, x2: best.x, y2: best.y, col: c, life: 0.14, max: 0.14, w: 2, zig: true });
        damageTarget(best, d); cx = best.x; cy = best.y; range = 150; any = true;
      }
      if (any) sfx('zap', { x, y }); return any;
    }
    case 'pd': {
      const pr = m.range || RANGE.pd; let best: Ent | null = null, bd = pr * pr;
      for (const b of S.eb) { if (b.kind === 'beam' || b.kind === 'strike' || b.dead) continue; const dd = (b.x - x) ** 2 + (b.y - y) ** 2; if (dd < bd) { bd = dd; best = b; } }
      if (!best) return false;
      best.dead = true; S.beams.push({ x1: x, y1: y, x2: best.x, y2: best.y, col: c, life: 0.12, max: 0.12, w: 1.5 }); spark(best.x, best.y, c, 4); sfx('pd', { x, layer: 'ship' }); return true;
    }
  }
  return false;
}
function shell(x: number, y: number, tx: number, ty: number, d: number, col: string, aoe: number, t: number) {
  const b = bolt(x, y, 0, 0, d, 'ground', col, 4);
  Object.assign(b, { kind: 'shell', sx: x, sy: y, tx, ty, life: t, max: t, aoe }); S.pb.push(b);
}
function railLine(x1: number, y1: number, x2: number, y2: number, d: number, c: string, layers: TargetLayers = 'both') {
  S.beams.push({ x1, y1, x2, y2, col: c, life: 0.28, max: 0.28, w: 5 });
  const L = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / L, uy = (y2 - y1) / L;
  for (let i = 0; i < 16; i++) { const k = rnd(0, L); addFx({ type: 'spark', x: x1 + ux * k, y: y1 + uy * k, vx: rnd(-160, 160), vy: rnd(-60, 60), life: rnd(0.15, 0.4), max: 0.4, size: 1.5, drag: 3, tint: '#e6d6ff' }); }
  const distTo = (px: number, py: number) => { const k = clamp((px - x1) * ux + (py - y1) * uy, 0, L); return Math.hypot(x1 + ux * k - px, y1 + uy * k - py); };
  for (const e of S.enemies) if (!e.dead && layersHit(layers, e.layer) && distTo(e.x, e.y) < e.r + 6) damageTarget(e, d);
  const B = S.boss; if (B && B.alive && distTo(B.x, B.y) < B.halfW) damageBoss(d);
  sfx('rail', { x: x1, layer: 'ship' });
}
export function damageTarget(e: Ent, d: number) {
  if (e.isBoss) { damageBoss(d); return; }
  if (e.dead) return;
  const m = S.P!.dv.mods;
  const dd = d * (e.layer === 'air' ? m.dmgAir : m.dmgGround);
  const dealt = Math.min(dd, Math.max(0, e.hp)); e.hp -= dd; e.flash = 0.07; S.stats.dmgDealt += dealt; if (e === S.elite) S.stats.dmgToTarget += dealt;
  if (e.hp <= 0) killEnemy(e as Enemy);
}
/** Global scrap tuning: kill and salvage values in data/enemies.ts are multiplied by this before carnage. */
export const SCRAP_SCALE = 0.31;
/**
 * Late sectors spawn several times as much to kill, and carnage sits at its cap, so raw scrap grows faster than
 * merchant prices. Each sector past the first divides drops by 1 + SCRAP_SECTOR_TAX: a fight buys about the same
 * share of an average part in every sector (see docs/TECH.md "Scrap economy" and tests/unit/economy.test.ts).
 */
export const SCRAP_SECTOR_TAX = 0.45;
/** City destruction pays this share of worldBlast()'s 1-4 scrap per building (before SCRAP_SCALE and carnage). */
export const STRUCTURE_SCRAP = 0.4;
export const scrapSectorMul = (sector: number) => 1 / (1 + SCRAP_SECTOR_TAX * Math.max(0, sector - 1));
function dropScrap(x: number, y: number, total: number, n: number) {
  S.stats.scrapRaw += total;
  const v = total * SCRAP_SCALE * scrapSectorMul(S.sector) * S.carnage.mult * S.heat.scrap * S.P!.dv.scrapMult;
  for (let i = 0; i < n; i++) S.pickups.push({ x, y, vx: rnd(-70, 70), vy: rnd(-90, 20), val: v / n, t: 0, kind: 'scrap' });
}
function killEnemy(e: Enemy) {
  e.dead = true; const d = EN[e.type];
  const big = e.r > 15;
  boomFx(e.x, e.y, e.r * (d.elite ? 2 : 1.25), e.layer === 'air' ? '#ffb347' : '#ff8a3d', e.layer === 'ground');
  if (big) V.shake = Math.min(d.elite ? 16 : 8, V.shake + (d.elite ? 12 : 3));
  if (e.layer === 'ground') groundBlast(e.x, e.y, e.r * 1.4, 20);
  const tierBefore = Math.floor(S.carnage.mult);
  if (!d.salvage) {
    S.kills++; S.stats.kills++; if (e.layer === 'air') S.stats.airKills++; else S.stats.groundKills++;
    S.seen[e.type] = (S.seen[e.type] || 0) + 1;
    addCarnage(S.carnage, d.elite ? 60 : 3 + Math.min(20, d.hp / 6));
    feedOverdrive(d.elite ? 0.5 : 0.026 + Math.min(0.06, d.hp / 1200));
  }
  if (Math.floor(S.carnage.mult) > tierBefore) emit({ type: 'carnageTier', x: e.x, y: e.y, n: Math.floor(S.carnage.mult) });
  S.stats.peakCarnage = Math.max(S.stats.peakCarnage, S.carnage.mult);
  S.score += d.score * (1 + 0.1 * (S.level - 1)) * S.carnage.mult;
  dropScrap(e.x, e.y, d.scrap * (1 + 0.03 * S.level), Math.min(d.elite ? 14 : 6, Math.ceil(d.scrap / 2)));
  if (d.salvage && Math.random() < (e.type === 'wreck' ? 0.45 : 0.25)) S.pickups.push({ x: e.x, y: e.y, vx: rnd(-30, 30), vy: -40, val: 0.1, t: 0, kind: 'repair' });
  if (d.elite) {
    S.stats.elites++;
    V.flashA = 0.35; setBanner('ELITE DESTROYED', d.name || '', 2, '#8fe39a');
    requestStop(S.stop, HITSTOP.elite, true); requestSlow(S.slowmo, SLOWMO);
    emit({ type: 'eliteKill', x: e.x, y: e.y, kind: e.type, n: e.maxHp });
  } else {
    requestStop(S.stop, hitstopFor(true, e.maxHp) * (big ? 1 : 0.5));
    emit({ type: 'kill', x: e.x, y: e.y, kind: e.type, n: e.maxHp });
  }
  if (hasFlag(S.relics, 'kill_explode') && !d.salvage) explode(e.x, e.y, 46, 10 * (1 + 0.2 * S.level), 'both', '#ff9f5a');
}
function explode(x: number, y: number, r: number, d: number, layer: string, col: string) {
  boomFx(x, y, r * 0.7, col, layer === 'ground');
  if (layer !== 'air') groundBlast(x, y, r, d);
  for (const e of S.enemies) if (!e.dead && layerOk(layer, e.layer) && Math.hypot(e.x - x, e.y - y) < r + e.r) damageTarget(e, d);
  // ground ordnance (bombs, mortar and broadside shells) bursts in the city far below a flying ghost dreadnought
  const B = S.boss; if (layer !== 'ground' && B && B.alive && shipHit(x, y, r * 0.6, B.x, B.y, B.dv, B.s, -1)) damageBoss(d);
}
function updatePB(dt: number) {
  for (const b of S.pb) {
    if (b.dead) continue;
    b.life -= dt;
    if (b.kind === 'shell' || b.kind === 'bomb') {
      b.ty += S.scroll * dt; // the ground keeps moving under falling ordnance
      const k = 1 - b.life / b.max; b.x = b.sx + (b.tx - b.sx) * k; b.y = b.sy + (b.ty - b.sy) * k;
      if (b.life <= 0) { explode(b.x, b.y, b.aoe, b.dmg, 'ground', b.col); sfx('groundBoom', { x: b.x, y: b.y, size: b.aoe }); b.dead = true; }
      continue;
    }
    if (b.kind === 'missile') {
      // Manual missiles keep their lock; without one (or when it dies) they look for a target near the aim point,
      // and failing that fly to the point itself and detonate there.
      if (!b.tg || b.tg.dead) b.tg = b.manual ? lockNear(b.dest.x, b.dest.y, b.layer) : nearest(b.x, b.y, (e) => layerOk(b.layer, e.layer), 700);
      if (b.manual && !b.tg && Math.hypot(b.dest.x - b.x, b.dest.y - b.y) < 22) { explode(b.x, b.y, 38, b.dmg, 'both', b.col); b.dead = true; continue; }
      const ca = Math.atan2(b.vy, b.vx);
      const goal = b.tg ? Math.atan2(b.tg.y - b.y, b.tg.x - b.x) : b.manual ? Math.atan2(b.dest.y - b.y, b.dest.x - b.x) : -Math.PI / 2;
      const na = ca + clamp(angDiff(goal, ca), -b.turn * dt, b.turn * dt);
      b.vx = Math.cos(na) * b.speed; b.vy = Math.sin(na) * b.speed;
      pushTrail(b, 12);
      if (Math.random() < 0.7) addFx({ type: 'smoke', x: b.x, y: b.y, vx: rnd(-8, 8), vy: rnd(-8, 8), life: 0.55, max: 0.55, size: 3, grow: 2.2, a: 0.4 });
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.life <= 0) { if (b.kind === 'flak') explode(b.x, b.y, b.aoe, b.dmg, 'air', b.col); b.dead = true; continue; }
    if (b.y < -40 || b.x < -40 || b.x > W + 40 || b.y > H + 40) { b.dead = true; continue; }
    for (const e of S.enemies) { if (e.dead || !layerOk(b.layer, e.layer)) continue; if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (e.r + b.r) ** 2) { hitWith(b, e); break; } }
    const B = S.boss;
    if (!b.dead && B && B.alive && shipHit(b.x, b.y, b.r, B.x, B.y, B.dv, B.s, -1)) hitWith(b, B);
    if (!b.dead && b.layer !== 'ground') for (const m of S.eb) { if (m.kind === 'missile' && !m.dead && (m.x - b.x) ** 2 + (m.y - b.y) ** 2 < 130) { m.hp -= b.dmg; if (m.hp <= 0) { m.dead = true; boomFx(m.x, m.y, 10, '#ffb36b'); } b.dead = true; break; } }
  }
  S.pb = S.pb.filter((b) => !b.dead);
}
function hitWith(b: Ent, e: Ent) {
  if (b.kind === 'flak') explode(b.x, b.y, b.aoe, b.dmg, 'air', b.col);
  else { damageTarget(e, b.dmg); spark(b.x, b.y, b.col, 3); if (!e.isBoss && e.dead) requestStop(S.stop, hitstopFor(false, b.dmg)); }
  b.dead = true;
}
export function pushTrail(b: Ent, n: number) { (b.trail || (b.trail = [])).push(b.x, b.y); if (b.trail.length > n * 2) b.trail.splice(0, 2); }

/* ---------------- enemies ---------------- */
/** Telegraphed fire: wind up for `tele` seconds (e.tele rises 0..1), then call fire(). */
function windup(e: Enemy, dt: number, tele: number, can: boolean, fire: () => void, cd: number) {
  if (e.wind == null) e.wind = -1;
  if (e.wind < 0) { e.tele = 0; if (e.cd <= 0 && can) { e.wind = 0; } return; }
  e.wind += dt; e.tele = clamp(e.wind / tele, 0, 1);
  if (e.wind >= tele) { e.wind = -1; e.tele = 0; e.cd = cd; if (can) fire(); }
}
function steerTo(e: Enemy, tx: number, ty: number, spd: number, dt: number) {
  const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
  if (d < 2) return;
  const m = Math.min(d, spd * dt); e.x += (dx / d) * m; e.y += (dy / d) * m; e.hdg = Math.atan2(dy, dx);
}
/** Distance from a point to the player's hull rectangle (0 inside). Enemy weapons have ranges measured to the hull. */
export function hullDist(x: number, y: number) {
  const P = S.P!, hw = P.dv.width / 2, hl = P.dv.len / 2;
  const dx = Math.max(0, Math.abs(x - P.x) - hw), dy = Math.max(0, Math.abs(y - P.y) - hl);
  return Math.hypot(dx, dy);
}
/** Aim at the hull with a little scatter so a stream of fire reads as a stream, not a laser. */
const aimNoisy = (x: number, y: number, k = 0.06) => aimAng(x, y) + rnd(-k, k);
function updateEnemies(dt: number) {
  const P = S.P!, live = S.mode === 'play' || S.mode === 'dying';
  const onField = (e: Enemy) => live && e.y > 10 && e.y < H - 30 && e.x > 0 && e.x < W;
  for (const e of S.enemies) {
    if (e.dead) continue;
    if (e.warnT > 0) { e.warnT -= dt; e.tele = 0; continue; } // a rear entry holding off the bottom edge (telegraphed)
    e.t += dt; e.flash -= dt; e.cd -= dt; shooter = e.type;
    if (e.layer === 'ground' && e.type !== 'crawler') e.y += S.scroll * dt;
    const inRange = onField(e) && hullDist(e.x, e.y) <= (EN[e.type].range ?? 9999);
    switch (e.type) {
      case 'heli': {
        if (e.t > e.life) { e.y -= 120 * dt; e.hdg = -Math.PI / 2; if (e.y < -40) e.dead = true; break; }
        e.restation -= dt;
        if (!e.station || e.restation <= 0) { e.station = e.quarter ? quarterPoint(e.quarter, rnd(240, 420)) : flankPoint(e.x < P.x ? -1 : 1, rnd(300, 500)); e.restation = rnd(3.5, 5.5); }
        steerTo(e, e.station.x, e.station.y, 120, dt);
        e.ang = aimAng(e.x, e.y);
        windup(e, dt, 0.45, inRange, () => { eShot(e.x, e.y, aimNoisy(e.x, e.y), bspd()); }, 3.0);
        break;
      }
      case 'jet':
        if (e.overtake) {
          // climbing past the hull from astern: fire once in range, edge away from the side of the hull, leave ahead
          e.y += e.vy * dt; e.hdg = -Math.PI / 2;
          const gap = Math.abs(e.x - P.x) - P.dv.width / 2;
          if (gap < 70 && Math.abs(e.y - P.y) < P.dv.len / 2 + 120) e.x += Math.sign(e.x - P.x || 1) * 260 * dt;
          // one snap shot as it draws level with the stern (no fan: it is going too fast to line one up)
          if (!e.fired && e.y < Math.min(H - 40, P.y + P.dv.len / 2 + 40) && inRange) { e.fired = true; eShot(e.x, e.y, aimAng(e.x, e.y), bspd() * 1.2); }
          if (e.y < -60) e.dead = true;
        } else if (e.strafe) {
          e.x += e.vx * dt; e.hdg = e.vx > 0 ? 0 : Math.PI;
          // pull clear of the hull if the dreadnought moves into the strafing lane
          const lane = P.dv.len / 2 + 30, dy = e.y - P.y;
          if (Math.abs(dy) < lane && Math.abs(e.x - P.x) < P.dv.width / 2 + 260) e.y += (dy < 0 ? -1 : 1) * 320 * dt;
          if (!e.fired && inRange) { e.fired = true; eShot(e.x, e.y, aimAng(e.x, e.y), bspd() * 1.2); }
          if ((e.vx > 0 && e.x > W + 80) || (e.vx < 0 && e.x < -80)) e.dead = true;
        } else {
          // dive, fire, then break off before the dreadnought's hull: jets do not ram a building
          const close = e.y > P.y - P.dv.len / 2 - 230 && Math.abs(e.x - P.x) < P.dv.width / 2 + 120;
          if (close && !e.breakDir) e.breakDir = e.x < P.x ? -1 : 1;
          if (e.breakDir) { e.vx += e.breakDir * 1400 * dt; e.vy = Math.max(60, e.vy - 500 * dt); }
          e.y += e.vy * dt; e.x += e.vx * dt; e.hdg = Math.atan2(e.vy, e.vx);
          if (!e.fired && e.y > 120 && inRange) { e.fired = true; const a = aimAng(e.x, e.y); eShot(e.x, e.y, a, bspd() * 1.2); if (S.level >= 5) { eShot(e.x, e.y, a - 0.18, bspd() * 1.2); eShot(e.x, e.y, a + 0.18, bspd() * 1.2); } }
        }
        break;
      case 'drone':
        e.y += (e.dir ?? 1) * 105 * dt; e.x = e.baseX + Math.sin(e.t * 2.4 + e.phase) * 80; e.hdg = (e.dir ?? 1) * Math.PI / 2;
        if (e.dir < 0 && e.y < -40) e.dead = true;
        if (e.cd <= 0) { e.cd = rnd(2.5, 4); if (inRange && Math.random() < 0.3) eShot(e.x, e.y, aimNoisy(e.x, e.y), bspd() * 0.8, { r: 3.5, dmg: edmg() * 0.6 }); }
        break;
      case 'gunship': {
        if (e.t > e.life) { e.x += (e.side < 0 ? -1 : 1) * 90 * dt; if (e.x < -60 || e.x > W + 60) e.dead = true; break; }
        const st = e.quarter ? quarterPoint(e.quarter, 380) : flankPoint(e.side, 400);
        steerTo(e, st.x, st.y, 70, dt); e.hdg = aimAng(e.x, e.y); e.ang = e.hdg;
        windup(e, dt, 0.8, inRange, () => { const a = aimAng(e.x, e.y); for (let i = -2; i <= 2; i++) eShot(e.x, e.y, a + i * 0.16, bspd() * 0.9); }, 3.2);
        break;
      }
      case 'bomber':
        e.x += e.vx * dt; e.hdg = e.vx > 0 ? 0 : Math.PI;
        if (e.cd <= 0 && inRange) { e.cd = 1.6; for (let i = -1; i <= 1; i++) eShot(e.x, e.y + 10, Math.PI / 2 + i * 0.35, bspd() * 0.7, { r: 5.5, col: '#ff7a4e' }); }
        if ((e.vx > 0 && e.x > W + 70) || (e.vx < 0 && e.x < -70)) e.dead = true;
        break;
      case 'tank':
        e.x += e.vx * dt; if (e.x < 20 || e.x > W - 20) e.vx *= -1;
        e.ang = aimAng(e.x, e.y);
        windup(e, dt, 0.5, inRange, () => eShot(e.x + Math.cos(e.ang) * 12, e.y + Math.sin(e.ang) * 12, aimNoisy(e.x, e.y, 0.05), bspd() * 0.95, { r: 5, dmg: edmg() * 0.85 }), 3.6);
        break;
      case 'infantry':
        e.x += Math.sin(e.t * 3 + e.y) * 8 * dt;
        if (e.cd <= 0 && inRange) { e.cd = rnd(3.5, 5); eShot(e.x, e.y, aimNoisy(e.x, e.y, 0.12), bspd() * 0.65, { r: 3, dmg: edmg() * 0.4 }); }
        break;
      case 'turret':
        e.ang = aimAng(e.x, e.y);
        windup(e, dt, 0.6, inRange, () => { e.burst = 3; e.bt = 0; }, 3.4);
        if (e.burst > 0) { e.bt -= dt; if (e.bt <= 0 && onField(e)) { e.burst--; e.bt = 0.13; eShot(e.x, e.y, aimNoisy(e.x, e.y, 0.04), bspd()); } }
        break;
      case 'sam':
        windup(e, dt, 0.7, inRange, () => eShot(e.x, e.y - 8, -Math.PI / 2, 120, { kind: 'missile', turn: 1.8, spd: 160, hp: 4 * hpMult(), life: 5, r: 5, col: '#ff9f5a', dmg: edmg() * 2.2 }), 4.5);
        break;
      case 'bunker':
        windup(e, dt, 0.9, inRange, () => ring(e.x, e.y, 12, bspd() * 0.65, { r: 5, col: '#ff7a6b' }), 3.8);
        break;
      case 'canister':
        e.y += 55 * dt; e.x += Math.sin(e.t * 1.3 + e.phase) * 22 * dt; e.ang = (e.ang || 0) + dt;
        break;
      case 'ace': updateAce(e, dt, onField(e)); break;
      case 'crawler': updateCrawler(e, dt, onField(e)); break;
      case 'carrier': updateCarrier(e, dt, onField(e)); break;
    }
    if (!EN[e.type].elite && ((e.y > H + 60 && !(e.aft && e.t < 6)) || e.x < -100 || e.x > W + 100)) e.dead = true;
    if (S.mode === 'play' && e.layer === 'air' && !e.dead && !EN[e.type].elite && shipHit(e.x, e.y, e.r * 0.7, P.x, P.y, P.dv, 1, 1)) {
      // Ramming: the dreadnought wins every collision; aircraft only scratch the paint.
      if (EN[e.type].salvage) damageTarget(e, 999); else { damagePlayer(1.5 + e.r * 0.12, 'ram:' + e.type); damageTarget(e, 999); }
    }
  }
  S.enemies = S.enemies.filter((e) => !e.dead);
}
function elitePhase(e: Enemy) { if (!e.phase2 && e.hp < e.maxHp * 0.5) { e.phase2 = true; setBanner('ELITE ENRAGED', EN[e.type].name || '', 1.4, '#ff5a4e'); sfx('alarm'); requestStop(S.stop, 0.06, true); } return e.phase2 ? 1.35 : 1; }
/** Ace gunship: circles the dreadnought at broadside range, sweeping a laser sight before each burst. */
function updateAce(e: Enemy, dt: number, fire: boolean) {
  const P = S.P!, rage = elitePhase(e);
  // Runs: take a flank station level with the hull (some off its aft quarter: 12% in sector 1, 28% from 3), hold and
  // fire, then cross over the bow to the other flank.
  e.restation = (e.restation ?? 0) - dt;
  if (!e.station || e.restation <= 0) { e.dir = -(e.dir || 1); e.station = { side: e.dir, dist: rnd(380, 520), dy: Math.random() < 0.12 + 0.08 * clamp(S.sector - 1, 0, 2) ? rnd(0.55, 0.8) : rnd(-0.4, 0.4) }; e.restation = rnd(3.2, 4.2) / rage; }
  const st = e.station, tx = clamp(P.x + st.side * st.dist, 60, W - 60), ty = clamp(P.y + st.dy * P.dv.len, 80, H - 60);
  const crossing = Math.sign(e.x - P.x) !== st.side && Math.abs(e.x - P.x) < st.dist;
  steerTo(e, tx, crossing ? Math.max(70, Math.min(ty, P.y - P.dv.len / 2 - 140)) : ty, e.t < 3 ? 260 : 230 * rage, dt); e.ang = aimAng(e.x, e.y);
  windup(e, dt, 0.65, fire && !crossing, () => { const a = aimAng(e.x, e.y); for (let i = 0; i < 4; i++) eShot(e.x, e.y, a + (i - 1.5) * 0.05, bspd() * (1.15 - i * 0.04)); muzzle(e.x, e.y, '#ff7a5c', 14); }, 2.6 / rage);
  e.cd2 -= dt; if (e.cd2 <= 0 && fire) { e.cd2 = 6 / rage; ring(e.x, e.y, 12, bspd() * 0.6, { r: 5, col: '#ff7a6b' }); }
  e.cd3 -= dt; if (e.cd3 <= 0 && fire) { e.cd3 = 5.5; for (const s of [-1, 1]) eShot(e.x + s * 20, e.y, e.ang + s * 0.9, 140, { kind: 'missile', turn: 2.0, spd: 170, hp: 6 * hpMult(), life: 5, r: 5, col: '#ff9f5a', dmg: edmg() * 2 }); }
}
/** Siege crawler: a ground fortress that walks a creeping barrage of telegraphed strikes across the ship's path. */
function updateCrawler(e: Enemy, dt: number, fire: boolean) {
  const P = S.P!, rage = elitePhase(e);
  if (e.y < e.holdY) e.y += 40 * dt; else { e.x = W / 2 + Math.sin(e.t * 0.22) * 520; e.y = e.holdY + Math.sin(e.t * 0.15) * 90; }
  e.ang = aimAng(e.x, e.y);
  if (!fire) return;
  if (e.cd <= 0) { e.cd = 2 / rage; for (const ox of [-30, 0, 30]) { const a = aimAng(e.x + ox, e.y); eShot(e.x + ox, e.y, a, bspd() * 0.95, { r: 5.5 }); muzzle(e.x + ox, e.y, '#ff7a5c', 10); } }
  e.cd2 -= dt;
  if (e.cd2 <= 0) {
    e.cd2 = 5 / rage;
    // creeping barrage: a line of strikes across the ship's predicted row, left to right or right to left
    const dir = pick([-1, 1]), row = P.y + P.vy * 0.8, n = rage > 1 ? 9 : 7;
    for (let i = 0; i < n; i++) { const x = W / 2 + dir * (i - (n - 1) / 2) * 150; later(i * 0.12, () => strike(x, row + rnd(-30, 30), edmg() * 3, 60, 1.3)); }
  }
  e.cd3 -= dt; if (e.cd3 <= 0) { e.cd3 = 6; for (let i = 0; i < 5; i++) spawnEnemy('infantry', e.x + rnd(-40, 40), e.y + 30 + rnd(0, 10)); spawnEnemy('tank', e.x + pick([-60, 60]), e.y + 20, { vx: rnd(-20, 20) }); }
}
/** Drone carrier: holds the top of the field, launching drone waves and sweeping a slow fan that the hull must weather. */
function updateCarrier(e: Enemy, dt: number, fire: boolean) {
  const rage = elitePhase(e);
  if (e.y < e.hoverY) e.y += 50 * dt; else e.x = W / 2 + Math.sin(e.t * 0.25) * 420;
  if (!fire) return;
  if (e.cd <= 0) { e.cd = 4 / rage; for (let i = 0; i < 4; i++) spawnEnemy('drone', e.x + (i - 1.5) * 30, e.y + 20, { baseX: clamp(e.x + (i - 1.5) * 60, 80, W - 80), phase: i }); }
  e.cd2 -= dt; if (e.cd2 <= 0) { e.cd2 = 2.8 / rage; const n = 11, off = Math.sin(e.t) * 0.3; for (let i = 0; i < n; i++) eShot(e.x, e.y + 30, Math.PI / 2 + off + (i - (n - 1) / 2) * 0.15, bspd() * 0.75, { col: '#ff7a6b' }); }
  e.cd3 -= dt; if (e.cd3 <= 0) { e.cd3 = 5; for (const s of [-1, 1]) eShot(e.x + s * 40, e.y, Math.PI / 2 + s * 0.9, 130, { kind: 'missile', turn: 1.8, spd: 160, hp: 6 * hpMult(), life: 5, r: 5, col: '#ff9f5a', dmg: edmg() * 2 }); }
}
function updateEB(dt: number) {
  const P = S.P!, canHit = S.mode === 'play';
  for (const b of S.eb) {
    if (b.dead) continue;
    b.t += dt; b.life -= dt;
    if (b.kind === 'beam') {
      // a ghost's broadside rail rides with its gun as the ship moves; the line keeps its angle
      const G = S.boss;
      if (b.gun && G && G.alive) { const p = bossGunPos(G, b.gun), dx = p.x - b.x, dy = p.y - b.y; b.x += dx; b.y += dy; b.x2 += dx; b.y2 += dy; }
      if (!b.charged) { b.charged = true; sfx('railCharge', { x: b.x, y: b.y, layer: 'air' }); }
      if (b.t >= b.warn && !b.fired) {
        b.fired = true; sfx('rail', { x: b.x, layer: 'air' }); V.shake = Math.min(10, V.shake + 5); V.flashA = Math.max(V.flashA, 0.12);
        for (let i = 0; i < 22; i++) addFx({ type: 'spark', x: b.x + rnd(-b.w / 2, b.w / 2), y: rnd(b.y, H), vx: rnd(-220, 220), vy: rnd(-80, 80), life: rnd(0.2, 0.5), max: 0.5, size: 1.8, drag: 3, tint: '#e3d0ff' });
        if (canHit && beamHits(b)) damagePlayer(b.dmg, b.src ? `${b.src}:rail` : 'beam');
      }
      if (b.t > b.warn + b.dur) b.dead = true; continue;
    }
    if (b.kind === 'strike') {
      b.y += S.scroll * dt * 0.5;
      if (b.t >= b.delay) { boomFx(b.x, b.y, b.rad * 0.8, '#ff7a4e'); sfx('boom', { x: b.x, y: b.y, size: b.rad }); if (canHit && shipHit(b.x, b.y, b.rad * 0.7, P.x, P.y, P.dv, 1, 1)) damagePlayer(b.dmg, 'strike'); b.dead = true; }
      continue;
    }
    if (b.kind === 'missile') {
      const ca = Math.atan2(b.vy, b.vx), na = ca + clamp(angDiff(aimAng(b.x, b.y), ca), -b.turn * dt, b.turn * dt);
      b.vx = Math.cos(na) * b.spd; b.vy = Math.sin(na) * b.spd;
      pushTrail(b, 12);
      if (Math.random() < 0.7) addFx({ type: 'smoke', x: b.x, y: b.y, vx: rnd(-8, 8), vy: rnd(-8, 8), life: 0.6, max: 0.6, size: 3.2, grow: 2.2, a: 0.4 });
    }
    if (b.kind === 'mine') b.vy *= 1 - dt * 0.8;
    if ((b.kind === 'mine' || b.kind === 'orb') && b.life <= 0) { ring(b.x, b.y, b.burst ?? 8, bspd() * 0.75, { r: 4, col: b.col, dmg: b.dmg, src: b.src }); boomFx(b.x, b.y, 10, b.col); b.dead = true; continue; }
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.life <= 0 || b.y > H + 20 || b.y < -60 || b.x < -20 || b.x > W + 20) { b.dead = true; continue; }
    if (canHit && shipHit(b.x, b.y, b.r, P.x, P.y, P.dv, 1, 1)) { damagePlayer(b.dmg, b.src || 'unknown'); b.dead = true; spark(b.x, b.y, '#ff9f8a', 5); }
  }
  S.eb = S.eb.filter((b) => !b.dead);
}
/** Does a fired hostile beam cross the player's hull? Vertical beams (no x2) run straight down the screen from (x, y). */
function beamHits(b: Ent) {
  const P = S.P!;
  if (b.x2 === undefined) return Math.abs(P.x - b.x) < b.w / 2 + P.dv.width * 0.35 && P.y > b.y;
  const L = Math.hypot(b.x2 - b.x, b.y2 - b.y) || 1, n = Math.ceil(L / 16);
  for (let i = 0; i <= n; i++) { const k = i / n; if (shipHit(b.x + (b.x2 - b.x) * k, b.y + (b.y2 - b.y) * k, b.w * 0.35, P.x, P.y, P.dv, 1, 1)) return true; }
  return false;
}
function clearEnemyFire(all: boolean) {
  for (const b of S.eb) if (all || b.kind !== 'strike') { if (b.kind !== 'beam' && b.kind !== 'strike') spark(b.x, b.y, '#ffb36b', 1); }
  S.eb = [];
}
export function shipHit(x: number, y: number, r: number, sx: number, sy: number, dv: Derived, s: number, dir: number) {
  const pad = dir > 0 ? 3 : 0;
  for (const R of dv.rects) {
    const x0 = sx + R.x * s, x1 = x0 + R.w * s;
    let y0: number, y1: number;
    if (dir > 0) { y0 = sy + R.y * s; y1 = y0 + R.h * s; } else { y1 = sy - R.y * s; y0 = y1 - R.h * s; }
    if (x + r > x0 + pad && x - r < x1 - pad && y + r > y0 + pad && y - r < y1 - pad) return true;
  }
  return false;
}

/* ---------------- pickups ---------------- */
export let onScrap: (v: number) => void = () => {};
export const setScrapHandler = (f: (v: number) => void) => { onScrap = f; };
function updatePickups(dt: number) {
  const P = S.P!, vac = S.mode === 'clear' || S.mode === 'bossdown' || hasFlag(S.relics, 'vacuum');
  S.pickStreak.t += dt; if (S.pickStreak.t > 0.5) S.pickStreak.n = 0;
  const reach = P.dv.magnet, alive = S.mode !== 'dying';
  for (const p of S.pickups) {
    p.t += dt;
    const dx = P.x - p.x, dy = P.y - p.y, d = Math.hypot(dx, dy) || 1, hd = hullDist(p.x, p.y);
    // Scrap magnet (MAGNET in data/parts.ts): inside the reach scrap is pulled in, accelerating the closer it gets and
    // the longer it is held; every scrap drop also homes on its own after a beat, so none is lost off the bottom.
    // Repair kits only come inside the reach.
    const homing = p.kind === 'scrap' && p.t > Math.max(0.25, 0.9 - 0.12 * P.dv.u.magnet);
    if (alive && (vac || homing || hd < reach)) {
      p.pull = (p.pull ?? 0) + dt;
      const near = 1 - clamp(hd / Math.max(1, reach), 0, 1);
      const acc = MAGNET.accel * (0.45 + 1.6 * near * near) * (vac ? 1.4 : 1) + p.pull * 2200;
      const ux = dx / d, uy = dy / d;
      p.vx += ux * acc * dt; p.vy += uy * acc * dt;
      // bleed off sideways drift so it curls into the hull instead of orbiting it
      const along = p.vx * ux + p.vy * uy, sx = p.vx - ux * along, sy = p.vy - uy * along, k = Math.min(1, dt * 7);
      p.vx -= sx * k; p.vy -= sy * k;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAGNET.maxSpeed) { p.vx *= MAGNET.maxSpeed / sp; p.vy *= MAGNET.maxSpeed / sp; }
      const step = Math.hypot(p.vx, p.vy) * dt;
      if (step >= d) { p.x = P.x; p.y = P.y; } else { p.x += p.vx * dt; p.y += p.vy * dt; }
      // a streak behind fast scrap: the stream whooshing into the hull
      if (sp > 380 && p.kind === 'scrap' && Math.random() < 0.7) addFx({ type: 'spark', x: p.x, y: p.y, vx: p.vx * 0.5, vy: p.vy * 0.5, life: 0.2, max: 0.2, size: 2.2, drag: 5, tint: '#ffe08a' });
    } else { p.x += p.vx * dt; p.y += (p.vy + S.scroll) * dt; p.vx *= 1 - dt * 2; p.vy *= 1 - dt * 2; }
    if (alive && (hullDist(p.x, p.y) < MAGNET.collect || Math.hypot(P.x - p.x, P.y - p.y) < 28)) {
      if (p.kind === 'repair') { const amt = P.dv.maxHp * p.val * S.heat.heal; P.hp = Math.min(P.dv.maxHp, P.hp + amt); spark(P.x, P.y, '#8fe39a', 12); setBanner('REPAIR KIT', `+${Math.round(amt)} hull`, 0.9, '#8fe39a'); }
      else { S.scrap += p.val; onScrap(p.val); S.pickStreak.n++; S.pickStreak.t = 0; spark(p.x, p.y, '#ffe08a', 2); }
      p.dead = true; sfx('pick', { x: P.x, layer: 'ship', size: S.pickStreak.n });
    }
    // Repair kits can drift away; scrap only goes when the ship is lost.
    if (p.y > H + 20 && (p.kind === 'repair' || !alive)) p.dead = true;
  }
  S.pickups = S.pickups.filter((p) => !p.dead);
}

/* ---------------- main update ---------------- */
function checkEnd() {
  const enc = S.enc!;
  if (enc.kind === 'fight' && S.time > enc.duration && (!S.enemies.some((e) => !EN[e.type].salvage) || S.time > enc.duration + 9)) win();
  if (enc.kind === 'elite' && S.elite && S.elite.dead) win();
}
function win() {
  for (const e of S.enemies) if (!EN[e.type].salvage) boomFx(e.x, e.y, e.r, '#ff9f5a', e.layer === 'ground');
  S.enemies = S.enemies.filter((e) => EN[e.type].salvage); clearEnemyFire(true); endOverdrive();
  S.mode = 'clear'; S.endT = 2.4; setBanner('AREA CLEAR', 'Collecting salvage', 2.2, '#8fe39a'); sfx('clear');
}
function runTimers() {
  if (!S.timers.length) return;
  const due = S.timers.filter((t) => t.at <= S.time);
  if (!due.length) return;
  S.timers = S.timers.filter((t) => t.at > S.time);
  for (const t of due) t.fn();
}
/** Advance the fight by rawDt real seconds. Hitstop freezes the simulation (effects keep animating); slow-mo scales dt. */
export function updateCombat(rawDt: number) {
  if (!S.active) return;
  if (S.banner) { S.banner.t -= rawDt; if (S.banner.t <= 0) S.banner = null; }
  if (stepStop(S.stop, rawDt)) { V.shake = Math.max(0, V.shake - rawDt * 10); return; }
  S.slowK = stepSlow(S.slowmo, rawDt); S.slowFx = slowIntensity(S.slowmo);
  const dt = rawDt * S.slowK;
  S.t += dt; updateBg(dt);
  if (S.mode === 'done') { updateFx(dt, S.scroll); return; }
  S.time += dt;
  runTimers();
  stepCarnage(S.carnage, dt);
  if (S.mode !== 'dying') { updatePlayer(dt); updateDrones(dt); fireWeapons(dt); updateOverdrive(dt); }
  if (S.mode === 'play') { if (S.enc!.kind === 'boss') updateBoss(dt); else director(dt); spawnSalvage(dt); }
  updateEnemies(dt); updatePB(dt); updateEB(dt); updatePickups(dt); updateFx(dt, S.scroll);
  for (const b of S.beams) b.life -= dt; S.beams = S.beams.filter((b) => b.life > 0);
  if (S.mode === 'bossdown' && S.boss) {
    S.chain -= dt;
    if (S.chain <= 0) { const b = S.boss; S.chain = 0.12; boomFx(b.x + rnd(-b.halfW, b.halfW), b.y + rnd((-b.dv.len * b.s) / 2, (b.dv.len * b.s) / 2), rnd(14, 30), pick(['#ffb347', '#ff6a3d', '#fff1c1'])); sfx('boom', { x: b.x, y: b.y, size: 26 }); V.shake = Math.min(10, V.shake + 2); }
  }
  if (S.mode === 'play') checkEnd();
  else { S.endT -= dt; if (S.endT <= 0) { S.outcome = S.mode === 'dying' ? 'dead' : 'win'; S.mode = 'done'; } }
}
export function endCombat() { S.active = false; endOverdrive(); S.timers = []; }
