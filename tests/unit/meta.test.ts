import { describe, it, expect, beforeEach } from 'vitest';
import '../sim/env';
import { memoryStore } from '../sim/env';
import {
  emptyProfile, migrateProfile, rankOf, perksFor, hullUnlocked, maxHeat, settleRun, runXp, dailySeed, dateKey, dailyShareLine,
  loadProfile, saveProfile, PROFILE_VERSION, PROFILE_KEY, type RunSummary,
} from '../../src/game/meta';
import { RANKS, GOALS } from '../../src/data/goals';
import { HULLS, HULL_IDS } from '../../src/data/hulls';
import { HEAT, heatFx, MAX_HEAT } from '../../src/data/heat';
import { newRun, loadRun, saveRun, maxHp, migrateRunSave, heal, SAVE_KEY } from '../../src/game/run';
import { buildToGhost, derive } from '../../src/data/parts';

const summary = (o: Partial<RunSummary> = {}): RunSummary => ({
  outcome: 'dead', hull: 'vanguard', heat: 0, daily: null, endless: false, won: false, sector: 1, floor: 3, nodes: 4, score: 5000,
  kills: 120, elites: 0, bosses: 0, structures: 40, broadsides: 30, maxVolley: 1, overdrives: 3, lanceStructures: 10, scrapEarned: 300,
  peakCarnage: 2.2, flawless: 0, maxScrapHeld: 140, fights: 3, seen: { enemies: { tank: 30, jet: 12 }, parts: { pulse: 2 }, relics: ['heavy_keel'], ghosts: [] }, date: '2026-10-09', ...o,
});

beforeEach(() => memoryStore.clear());

describe('profile versioning', () => {
  it('round-trips an empty profile and survives junk', () => {
    const p = emptyProfile();
    expect(migrateProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
    for (const junk of [null, 42, 'x', [], { version: 0 }, { version: 'two' }]) expect(migrateProfile(junk)).toEqual(emptyProfile());
  });
  it('migrates a v1 profile (rankXp + flat codex) to the current version', () => {
    const p = migrateProfile({ version: 1, rankXp: 900, codex: ['tank', 'jet', 'tank'], goals: { first_blood: true, bogus: true }, hull: 'leviathan' });
    expect(p.version).toBe(PROFILE_VERSION);
    expect(p.xp).toBe(900);
    expect(p.codex.enemies).toEqual({ tank: 1, jet: 1 });
    expect(p.goals).toEqual({ first_blood: true });
    expect(p.hull).toBe('leviathan');
  });
  it('keeps what it understands from a newer save and refuses locked selections', () => {
    const p = migrateProfile({ version: PROFILE_VERSION + 5, xp: 10, hull: 'bastion', heat: 4 });
    expect(p.xp).toBe(10);
    expect(p.hull).toBe('vanguard');
    expect(p.heat).toBe(0);
  });
  it('saves and loads through localStorage', () => {
    const p = emptyProfile(); p.xp = 1234; saveProfile(p);
    expect(memoryStore.has(PROFILE_KEY)).toBe(true);
    expect(loadProfile().xp).toBe(1234);
  });
});

describe('admiralty rank and unlocks', () => {
  it('ranks climb with XP and hulls unlock on schedule', () => {
    expect(rankOf(0).rank).toBe(1);
    expect(rankOf(RANKS[1].xp).rank).toBe(2);
    expect(rankOf(1e9).rank).toBe(RANKS.length);
    expect(rankOf(1e9).progress).toBe(1);
    const p = emptyProfile();
    expect(HULL_IDS.filter((h) => hullUnlocked(p, h))).toEqual(['vanguard']);
    p.xp = RANKS.find((r) => r.hull === 'bastion')!.xp;
    expect(HULL_IDS.every((h) => hullUnlocked(p, h))).toBe(true);
  });
  it('perks accumulate', () => {
    expect(perksFor(0)).toEqual({ startScrap: 0, extraPart: 0, odStart: 0, hullPct: 0, startRelic: 0 });
    const top = perksFor(1e9);
    expect(top.startScrap).toBe(75); expect(top.odStart).toBe(0.25); expect(top.extraPart).toBe(1);
  });
  it('every hull has a distinct overdrive and a valid starting build', () => {
    expect(new Set(HULL_IDS.map((h) => HULLS[h].overdrive)).size).toBe(HULL_IDS.length);
    for (const h of HULL_IDS) { const d = derive(HULLS[h].build()); expect(d.maxHp, h).toBeGreaterThan(100); expect(d.mounts.some((m) => m.part), h).toBe(true); }
  });
});

describe('heat', () => {
  it('is locked until a victory, then opens one level at a time', () => {
    const p = emptyProfile();
    expect(maxHeat(p)).toBe(0);
    const won = settleRun(p, summary({ outcome: 'victory', won: true, sector: 3 }));
    expect(won.heatUnlocked).toBe(1);
    expect(maxHeat(won.profile)).toBe(1);
    const won3 = settleRun(won.profile, summary({ outcome: 'victory', won: true, sector: 3, heat: 3 }));
    expect(maxHeat(won3.profile)).toBe(4);
  });
  it('folds levels cumulatively', () => {
    expect(heatFx(0).enemyHp).toBe(1);
    expect(heatFx(1).enemyHp).toBeCloseTo(1.2);
    expect(heatFx(MAX_HEAT).heal).toBeCloseTo(0.7);
    expect(HEAT.map((h) => h.level)).toEqual(HEAT.map((_, i) => i + 1));
  });
});

describe('settling a run', () => {
  it('pays XP, completes goals and fills the codex', () => {
    const s = settleRun(emptyProfile(), summary());
    expect(s.profile.stats.runs).toBe(1);
    expect(s.profile.stats.deaths).toBe(1);
    expect(s.goals.map((g) => g.id)).toContain('first_blood');
    expect(s.profile.codex.enemies.tank).toBe(30);
    expect(s.profile.codex.relics.heavy_keel).toBe(1);
    expect(s.profile.xp).toBe(s.xpTotal);
    expect(s.newBest).toBe(true);
    expect(settleRun(s.profile, summary({ score: 10 })).newBest).toBe(false);
  });
  it('a victory pays the bonus, heat pays more and abandoning pays half', () => {
    const base = runXp(summary()).total;
    expect(runXp(summary({ won: true, outcome: 'victory' })).total).toBe(base + 500);
    expect(runXp(summary({ heat: 4 })).total).toBeGreaterThan(base);
    expect(runXp(summary({ outcome: 'abandoned' })).total).toBeCloseTo(base / 2, -1);
  });
  it('records the daily strike with a share line', () => {
    const s = settleRun(emptyProfile(), summary({ daily: '2026-10-09' }));
    expect(s.dailyLine).toMatch(/^GHOST DREADNOUGHT DAILY 2026-10-09 .* 120 KILLS/);
    expect(s.profile.daily?.date).toBe('2026-10-09');
    expect(s.newBest).toBe(false);
    expect(s.goals.map((g) => g.id)).toContain('daily');
  });
  it('every goal can be completed by some summary', () => {
    for (const g of GOALS) expect(g.goal, g.id).toBeGreaterThan(0);
  });
});

describe('daily seed', () => {
  it('is stable per date and differs between dates', () => {
    expect(dailySeed('2026-10-09')).toBe(dailySeed('2026-10-09'));
    expect(dailySeed('2026-10-09')).not.toBe(dailySeed('2026-10-10'));
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dailyShareLine({ date: 'd', sector: 2, floor: 4, kills: 9, score: 1234, won: false })).toContain('SECTOR 2 FLOOR 5');
  });
});

describe('run save v4', () => {
  it('migrates a v2 save to the Vanguard at heat 0', () => {
    const r = newRun('OLD', 7);
    const v2 = { ...r, v: 2, build: buildToGhost(r.build), inv: r.inv.map((p) => [p.id, p.tier]), stats: { kills: 5, elites: 0, bosses: 0, scrapEarned: 1, nodes: 2, score: 9 } } as any;
    delete v2.hull; delete v2.heat; delete v2.seen;
    memoryStore.set('gd.run.v2', JSON.stringify(v2));
    const back = loadRun()!;
    expect(back.v).toBe(4);
    expect(back.od).toEqual([]);
    expect(back.hull).toBe('vanguard');
    expect(back.heat).toBe(0);
    expect(back.stats.kills).toBe(5);
    expect(back.stats.structures).toBe(0);
    expect(migrateRunSave({ v: 1, map: { nodes: {} } })).toBeNull();
  });
  it('round-trips hull, heat and daily', () => {
    const r = newRun('NEW', 9, { hull: 'leviathan', heat: 6, daily: '2026-10-09' });
    expect(r.hp).toBeCloseTo(maxHp(r) * 0.75);
    saveRun(r);
    expect(memoryStore.has(SAVE_KEY)).toBe(true);
    const back = loadRun()!;
    expect(back.hull).toBe('leviathan'); expect(back.heat).toBe(6); expect(back.daily).toBe('2026-10-09');
    expect(buildToGhost(back.build)).toEqual(buildToGhost(HULLS.leviathan.build()));
  });
  it('applies rank perks and heat to new runs', () => {
    const r = newRun('P', 3, { perks: perksFor(1e9), heat: 8 });
    expect(r.scrap).toBe(HULLS.vanguard.scrap + 75);
    expect(r.inv.length).toBe(HULLS.vanguard.hold().length + 1);
    expect(r.relics).toContain('veteran_crews');
    expect(r.odStart).toBe(0.25);
    r.hp = 1; heal(r, 0.5);
    expect(r.hp).toBeCloseTo(1 + maxHp(r) * 0.5 * 0.7);
  });
});
