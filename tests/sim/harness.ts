// Headless balance harness: steps the real combat simulation with a scripted pilot and reports what a fight
// costs and pays. Used by tests/unit/balance.test.ts; run `BALANCE=1 npx vitest run tests/unit/balance.test.ts`
// for the full table.
import './env';
import { S, keys, startCombat, updateCombat, endCombat, gunnery, aim, type CombatSetup } from '../../src/game/combat';
import { derive, mkPart, starterBuild, type Build } from '../../src/data/parts';
import { FIGHTS, ELITES, BOSS_ENCOUNTER, type Encounter } from '../../src/data/enemies';
import { HULLS, type HullId } from '../../src/data/hulls';
import { relicMods } from '../../src/data/relics';
import { aiGhost } from '../../src/game/ghosts';
import { heatFx } from '../../src/data/heat';
import { FIELD_W as W, FIELD_H as H } from '../../src/game/field';
import { EN } from '../../src/data/enemies';
import { mulberry32 } from '../../src/util/rng';

/** pilot: scripted flying, every weapon aims itself. gunner: the same flying, heavy groups fired by hand (right-mouse
 *  salvo at the best target, as a mouse player would). idle: parks mid-field. */
export type Bot = 'pilot' | 'gunner' | 'idle';
export interface FightResult {
  enc: string; kind: string; level: number; outcome: 'win' | 'dead' | 'timeout'; seconds: number;
  hullLostPct: number; scrap: number; kills: number; structures: number; overdrives: number; broadsides: number; maxVolley: number;
  peakCarnage: number; targetTtk: number | null; endHpPct: number;
  /** Top hull-damage sources, as percent of max hull. */ topDmg: string;
  dps: number; targetHp: number; targetDps: number;
}

const P = (id: string, t: number) => mkPart(id, t);
export const BUILDS: Record<string, () => Build> = {
  starter: starterBuild,
  /** End of sector 1: a few nodes of upgrades on the starter (the flak turret turned to cover astern). Later builds face
 *  their mounts the way a pilot who has met rear threats would (the fore battery angled forward, a gun aft) and have
 *  bought wide turret rings on their sponsons. */
  s1end: () => ({ sections: [
    { type: 'bridge', slots: [P('pulse', 2)] },
    { type: 'battery', slots: [P('pulse', 1), P('bomb', 1), P('pulse', 1)] },
    { type: 'gundeck', slots: [P('spread', 1), P('flak', 1)], face: [0, 4] },
    { type: 'armor', slots: [P('plate', 1)] },
    { type: 'engine', slots: [null] },
  ] }),
  mid: () => ({ sections: [
    { type: 'bridge', slots: [P('pulse', 2)] },
    { type: 'battery', slots: [P('pulse', 2), P('bomb', 2), P('flak', 2)], face: [7, 2, 3], ring: [2, 1, 2] },
    { type: 'gundeck', slots: [P('spread', 2), P('missile', 2)], face: [0, 4] },
    { type: 'armor', slots: [P('plate', 2)] },
    { type: 'spine', slots: [P('shield', 1), P('repair', 1)] },
    { type: 'engine', slots: [P('thruster', 1)] },
  ] }),
  late: () => ({ sections: [
    { type: 'bridge', slots: [P('rail', 3)] },
    { type: 'battery', slots: [P('pulse', 3), P('artillery', 3), P('pulse', 3)], face: [7, 2, 1], ring: [2, 1, 2] },
    { type: 'battery', slots: [P('flak', 3), P('bomb', 3), P('spread', 3)], face: [5, 2, 2], ring: [2, 1, 2] },
    { type: 'gundeck', slots: [P('missile', 3), P('tesla', 3)], ring: [2, 1] },
    { type: 'armor', slots: [P('plate', 3)] },
    { type: 'spine', slots: [P('shield', 2), P('reactor', 2)] },
    { type: 'engine', slots: [P('thruster', 2)] },
    { type: 'engine', slots: [P('repair', 2)] },
  ] }),
};
for (const id of Object.keys(HULLS) as HullId[]) BUILDS[`hull:${id}`] = HULLS[id].build;

/** Scripted pilot: keeps hostiles level with the hull and under the keel, side-steps telegraphed strikes and beams,
 *  sweeps up nearby scrap, and fires Overdrive when there is something worth spending it on. */
function steer(bot: Bot) {
  const p = S.P!; keys.l = keys.r = keys.u = keys.d = false;
  if (bot === 'idle') { p.tx = W / 2; p.ty = H * 0.7; if (S.overdrive.charge >= 1) keys.od = true; return; }
  const foes = S.enemies.filter((e) => !EN[e.type].salvage);
  let gx = W / 2, gy = H * 0.66;
  const el = S.elite && !S.elite.dead ? S.elite : null;
  if (S.boss?.alive) { gx = S.boss.x + Math.sin(S.time * 0.7) * 120; gy = H * 0.72; }
  else if (el) {
    const level = el.layer === 'air' && Math.abs(el.y - S.P!.y) < S.P!.dv.len / 2 + 80;
    gx = level ? S.P!.x : el.x; gy = el.layer === 'ground' ? el.y + 30 : level ? S.P!.y : Math.min(H * 0.82, el.y + 300);
  }
  else if (foes.length) {
    let sx = 0, sy = 0, n = 0;
    for (const e of foes) { const w = EN[e.type].elite ? 4 : e.layer === 'ground' ? 1 : 1.5; sx += e.x * w; sy += (e.layer === 'air' ? e.y : H * 0.66) * w; n += w; }
    gx = sx / n; gy = Math.min(H * 0.8, Math.max(H * 0.45, sy / n + 60));
    // Ground-heavy: stand off to the side so batteries out-range the guns (broadsides 760 vs flak tanks 440).
    const ground = foes.filter((e) => e.layer === 'ground').length;
    if (ground > foes.length * 0.6) gx = gx + (gx > W / 2 ? -1 : 1) * 560;
  } else if (S.pickups.length) { gx = S.pickups[0].x; gy = S.pickups[0].y; }
  // threats: telegraphed strikes and charging beams that would land on the hull
  for (const b of S.eb) {
    if (b.kind === 'strike' && Math.abs(b.x - p.x) < p.dv.width / 2 + b.rad && Math.abs(b.y - p.y) < p.dv.len / 2 + b.rad) gx = p.x + (p.x > b.x ? 1 : -1) * (p.dv.width + b.rad);
    // charging rails (straight down, or aimed along a ghost gun's bearing): step off the line, square to it
    if (b.kind === 'beam' && !b.fired) {
      const x2 = b.x2 ?? b.x, y2 = b.y2 ?? H + 400, L = Math.hypot(x2 - b.x, y2 - b.y) || 1, ux = (x2 - b.x) / L, uy = (y2 - b.y) / L;
      const k = (p.x - b.x) * ux + (p.y - b.y) * uy;
      if (k > 0) {
        let nx = p.x - (b.x + ux * k), ny = p.y - (b.y + uy * k), d = Math.hypot(nx, ny);
        if (d < 1) { nx = -uy; ny = ux; d = 1; }
        nx /= d; ny /= d;
        const ext = Math.abs(nx) * p.dv.width / 2 + Math.abs(ny) * p.dv.len / 2;
        if (d < ext + b.w) { gx = p.x + nx * (ext + b.w * 2); gy = p.y + ny * (ext + b.w * 2); }
      }
    }
  }
  p.tx = gx; p.ty = gy;
  if (bot === 'gunner') aimHeavies(foes);
  if (S.overdrive.charge >= 1 && (foes.length >= 6 || S.boss?.alive || S.elite)) keys.od = true;
}

/** The gunner's aiming policy: the boss or elite if there is one, else the nearest real target; the reticle sits on it
 *  (ground targets lead the scroll a little) and every heavy group salvoes. */
function aimHeavies(foes: typeof S.enemies) {
  const p = S.P!;
  const el = S.elite && !S.elite.dead ? S.elite : null;
  let tg: { x: number; y: number; layer: string } | null = S.boss?.alive ? S.boss : el;
  if (!tg) {
    let bd = Infinity;
    for (const e of foes) { const d = Math.hypot(e.x - p.x, e.y - p.y) + (e.y > p.y ? 200 : 0); if (e.y > 0 && d < bd) { bd = d; tg = e; } }
  }
  aim.salvo = !!tg;
  if (tg) { aim.x = tg.x; aim.y = tg.y + (tg.layer === 'ground' ? S.scroll * 0.4 : 0); }
}
export interface FightSpec { enc: Encounter; level: number; sector: number; build: string; bot?: Bot; heat?: number; hull?: HullId; relics?: string[]; seed?: number }
/** Runs one fight to its end. Math.random is swapped for a seeded stream so a spec always plays out the same way. */
export function runFight(spec: FightSpec, dt = 1 / 60, maxT = 240): FightResult {
  const realRandom = Math.random; Math.random = mulberry32(spec.seed ?? 1);
  gunnery.manual = spec.bot === 'gunner'; gunnery.family = null;
  try { return runFightInner(spec, dt, maxT); } finally { Math.random = realRandom; gunnery.manual = false; aim.salvo = aim.fire = false; }
}
function runFightInner(spec: FightSpec, dt: number, maxT: number): FightResult {
  const build = BUILDS[spec.build](), relics = spec.relics ?? [], mods = relicMods(relics);
  const dv = derive(build, mods), hf = heatFx(spec.heat ?? 0);
  const setup: CombatSetup = {
    enc: spec.enc, level: spec.level, sector: spec.sector, build, hp: dv.maxHp * hf.startHp, relics, mods, cheatDeathAvailable: false,
    ghost: spec.enc.kind === 'boss' ? aiGhost(spec.sector) : undefined, overdrive: HULLS[spec.hull ?? 'vanguard'].overdrive, heat: hf,
  };
  startCombat(setup);
  const hp0 = S.P!.hp;
  let t = 0, targetSeen: number | null = null, targetDown: number | null = null, decide = 0;
  while (!S.outcome && t < maxT) {
    decide -= dt; if (decide <= 0) { decide = 0.1; steer(spec.bot ?? 'pilot'); }
    updateCombat(dt); t += dt;
    const tg = S.boss ?? S.elite;
    if (tg && targetSeen === null && (S.boss ? S.boss.entered : true)) targetSeen = S.time;
    if (tg && targetDown === null && (tg.dead || (S.boss && !S.boss.alive))) targetDown = S.time;
  }
  const res: FightResult = {
    enc: spec.enc.id, kind: spec.enc.kind, level: +spec.level.toFixed(1), outcome: S.outcome ?? 'timeout', seconds: Math.round(S.time),
    hullLostPct: Math.round((S.stats.dmgTaken / dv.maxHp) * 100), scrap: Math.round(S.scrap), kills: S.stats.kills, structures: S.stats.structures,
    overdrives: S.stats.overdrives, broadsides: S.stats.broadsides, maxVolley: S.stats.maxVolley, peakCarnage: +S.stats.peakCarnage.toFixed(2),
    targetTtk: targetSeen !== null && targetDown !== null ? Math.round(targetDown - targetSeen) : null,
    endHpPct: Math.round((Math.max(0, S.P!.hp) / dv.maxHp) * 100),
    dps: Math.round(S.stats.dmgDealt / Math.max(1, S.time)), targetHp: Math.round((S.boss ?? S.elite)?.maxHp ?? 0),
    targetDps: targetSeen !== null ? Math.round(S.stats.dmgToTarget / Math.max(1, (targetDown ?? S.time) - targetSeen)) : 0,
    topDmg: Object.entries(S.stats.dmgBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${Math.round((v / dv.maxHp) * 100)}`).join(' '),
  };
  void hp0;
  endCombat();
  return res;
}

/** The standard balance table: every fight type early and late in each sector, elites and bosses. */
export function balanceSpecs(bot: Bot = 'pilot', reps = 1): FightSpec[] {
  const out: FightSpec[] = [];
  const stage = [{ sector: 1, build: 'starter' }, { sector: 2, build: 'mid' }, { sector: 3, build: 'late' }];
  for (const st of stage) {
    const lv = (floor: number, elite = false) => 1 + (st.sector - 1) * 3.2 + floor * 0.28 + (elite ? 1.2 : 0);
    for (let r = 0; r < reps; r++) {
      for (const f of FIGHTS) out.push({ enc: f, level: lv(r % 2 ? 7 : 1), sector: st.sector, build: st.build, bot });
      const late = st.build === 'starter' ? 's1end' : st.build;
      for (const e of ELITES) out.push({ enc: e, level: lv(6, true), sector: st.sector, build: late, bot });
      out.push({ enc: BOSS_ENCOUNTER, level: st.sector * 3 + 0.6, sector: st.sector, build: late, bot });
    }
  }
  return out;
}
