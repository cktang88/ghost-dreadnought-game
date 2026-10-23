import { describe, it, expect } from 'vitest';
import { runFight, balanceSpecs, type FightResult } from '../sim/harness';
import { FIGHTS, ELITES, BOSS_ENCOUNTER } from '../../src/data/enemies';

// BALANCE=1 npx vitest run tests/unit/balance.test.ts --disable-console-intercept   prints the full table.
// ONLY=s2-boss,ace narrows it.
const REPORT = !!process.env.BALANCE;
const line = (sector: number, r: FightResult) =>
  `s${sector} ${r.enc.padEnd(15)} L${String(r.level).padEnd(4)} ${r.outcome.padEnd(5)} ${String(r.seconds).padStart(3)}s  hull lost ${String(r.hullLostPct).padStart(3)}%  ` +
  `scrap ${String(r.scrap).padStart(4)}  kills ${String(r.kills).padStart(3)}  ttk ${String(r.targetTtk ?? '-').padStart(3)}  od ${r.overdrives}  broadsides ${String(r.broadsides).padStart(2)}  ` +
  `carnage x${r.peakCarnage}  dps ${String(r.dps).padStart(3)}  target ${r.targetHp}@${r.targetDps}/s | ${r.topDmg}`;

describe('balance harness (headless combat)', () => {
  it('a starter ship wins the first patrol with a scripted pilot and real scrap to show for it', () => {
    const r = runFight({ enc: FIGHTS[0], level: 1, sector: 1, build: 'starter' });
    expect(r.outcome).toBe('win');
    expect(r.kills).toBeGreaterThan(20);
    expect(r.scrap).toBeGreaterThan(30);
    expect(r.hullLostPct).toBeLessThan(75);
    expect(r.broadsides).toBeGreaterThan(5);
    expect(r.overdrives).toBeGreaterThanOrEqual(1);
  }, 30_000);
  it('elites die in a reasonable time and bosses are a real fight', () => {
    const e = runFight({ enc: ELITES[0], level: 3.9, sector: 1, build: 's1end' });
    expect(e.outcome).toBe('win');
    expect(e.targetTtk!).toBeGreaterThan(10);
    expect(e.targetTtk!).toBeLessThan(70);
    const b = runFight({ enc: BOSS_ENCOUNTER, level: 3.6, sector: 1, build: 's1end' });
    expect(b.outcome).toBe('win');
    expect(b.targetTtk!).toBeGreaterThan(25);
    expect(b.hullLostPct).toBeGreaterThan(5);
  }, 30_000);
  it('every hull class can win its first fight and fire its Overdrive', () => {
    for (const hull of ['vanguard', 'leviathan', 'lance', 'bastion'] as const) {
      const r = runFight({ enc: FIGHTS[0], level: 1.3, sector: 1, build: `hull:${hull}`, hull });
      expect(r.outcome, hull).toBe('win');
      expect(r.overdrives, hull).toBeGreaterThanOrEqual(1);
    }
  }, 30_000);
  it('a mouse gunner firing the heavy groups by hand does at least as well as the self-aiming batteries', () => {
    // Mean over four seeds: with threats from every bearing one fight's DPS swings by a quarter either way.
    const seeds = [1, 2, 3, 4], mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    for (const [enc, level, sector, build] of [[FIGHTS[0], 1, 1, 'starter'], [BOSS_ENCOUNTER, 6.6, 2, 'mid'], [FIGHTS[2], 7.7, 3, 'late']] as const) {
      const auto = seeds.map((seed) => runFight({ enc, level, sector, build, seed }));
      const hand = seeds.map((seed) => runFight({ enc, level, sector, build, seed, bot: 'gunner' }));
      for (const h of hand) expect(h.outcome, `${build} ${enc.id}`).toBe('win');
      const a = mean(auto.map((r) => r.dps)), h = mean(hand.map((r) => r.dps));
      expect(h, `${build} ${enc.id}`).toBeGreaterThan(a * 0.85);
      expect(h, `${build} ${enc.id}`).toBeLessThan(a * 1.6);
    }
  }, 120_000);
  it.runIf(REPORT)('prints the full table', async () => {
    const only = (process.env.ONLY || '').split(',').filter(Boolean);
    for (const bot of ['pilot', 'gunner', 'idle'] as const) {
      console.log(`\n=== bot: ${bot} ===`);
      for (const spec of balanceSpecs(bot, 1)) {
        if (only.length && !only.some((o) => `s${spec.sector}-${spec.enc.id}`.includes(o))) continue;
        console.log(line(spec.sector, runFight(spec)));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }, 900_000);
});
