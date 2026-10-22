// Run state: everything that persists between nodes, plus save/load.
import { derive, starterBuild, mkPart, allParts, buildToGhost, ghostToBuild, isPart, partSlot, type Build, type Part, WEAPONS, UTILS, SECTIONS, type SectionType, MAX_SECTIONS, sectionCost } from '../data/parts';
import { RELICS, relicMods, type Rarity } from '../data/relics';
import { generateMap, type SectorMap } from './map';
import { mulberry32, pick, rint, clamp, has, type Rng } from '../util/rng';
import type { Ghost } from './ghosts';
import { HULLS, isHullId, type HullId } from '../data/hulls';
import { heatFx, MAX_HEAT } from '../data/heat';
import { noPerks, type RankPerks } from '../data/goals';
import { OD_NODE, canTakeOd, sanitizeOd } from '../data/overdriveTree';

/** Per-run counters, shown in the wreck report and folded into the profile when the run ends. */
export interface RunStats {
  kills: number; elites: number; bosses: number; scrapEarned: number; nodes: number; score: number;
  structures: number; broadsides: number; maxVolley: number; overdrives: number; lanceStructures: number;
  peakCarnage: number; flawless: number; maxScrapHeld: number; fights: number; dmgTaken: number; dmgDealt: number;
}
export const emptyRunStats = (): RunStats => ({
  kills: 0, elites: 0, bosses: 0, scrapEarned: 0, nodes: 0, score: 0, structures: 0, broadsides: 0, maxVolley: 0, overdrives: 0,
  lanceStructures: 0, peakCarnage: 1, flawless: 0, maxScrapHeld: 0, fights: 0, dmgTaken: 0, dmgDealt: 0,
});
/** What this run has met, for the codex. */
export interface RunSeen { enemies: Record<string, number>; ghosts: { id: string; name: string; sector: number; ai: boolean; outcome: 'killed' | 'lost' }[] }
/** Sectors in a campaign. Clearing the last one is a victory; the run may then continue in endless mode. */
export const CAMPAIGN_SECTORS = 3;

export interface RunState {
  v: 4; seed: number; pilot: string; callsign: string; sector: number; map: SectorMap; at: string | null; visited: string[];
  build: Build; inv: Part[]; scrap: number; hp: number; relics: string[]; jumpUsed: boolean;
  stats: RunStats;
  rngCalls: number; bossGhost: Ghost | null; bossGhostCount: number;
  /** Hull class flown, heat level, daily date key (null for a normal run). */
  hull: HullId; heat: number; daily: string | null;
  /** Campaign won (sector 3 cleared); endless: the pilot chose to push on past the victory. */
  won: boolean; endless: boolean;
  /** 'victory' while the victory screen is waiting for a choice (survives reloads). */
  phase: 'map' | 'victory';
  /** Overdrive charge each fight starts with (rank perk). */
  odStart: number;
  seen: RunSeen;
  /** Overdrive upgrade picks, in the order taken (node ids, data/overdriveTree.ts). */
  od: string[];
  /** Free Overdrive commissions banked (one per sector boss): a pick that costs no scrap. */
  odCredits: number;
}
export interface RunOptions { hull?: HullId; heat?: number; daily?: string | null; perks?: RankPerks }

export function getPilotId(): string {
  try {
    let id = localStorage.getItem('gd.pilot');
    if (!id) { id = 'p' + Math.random().toString(36).slice(2, 10); localStorage.setItem('gd.pilot', id); }
    return id;
  } catch { return 'anon'; }
}

export function newRun(callsign: string, seed = (Math.random() * 2 ** 31) | 0, opts: RunOptions = {}): RunState {
  const hull = HULLS[opts.hull ?? 'vanguard'], perks = opts.perks ?? noPerks(), heat = Math.max(0, Math.min(MAX_HEAT, opts.heat ?? 0));
  const run: RunState = {
    v: 4, seed, pilot: getPilotId(), callsign, sector: 1, map: generateMap(1, seed), at: null, visited: [],
    build: hull.build(), inv: hull.hold(), scrap: hull.scrap + perks.startScrap, hp: 0, relics: [], jumpUsed: false,
    stats: emptyRunStats(), rngCalls: 0, bossGhost: null, bossGhostCount: 0,
    hull: hull.id, heat, daily: opts.daily ?? null, won: false, endless: false, phase: 'map', odStart: perks.odStart,
    seen: { enemies: {}, ghosts: [] }, od: [], odCredits: 0,
  };
  const rng = runRng(run);
  for (let i = 0; i < perks.extraPart; i++) run.inv.push(mkPart(pick([...Object.keys(WEAPONS), ...Object.keys(UTILS)], rng), 1));
  if (perks.startRelic) { const [r] = relicChoices(run, 1, ['common']); if (r) run.relics.push(r); }
  if (perks.hullPct) run.relics.push('veteran_crews');
  run.hp = maxHp(run) * heatFx(heat).startHp;
  return run;
}
export const mods = (run: RunState) => relicMods(run.relics);
export const dv = (run: RunState) => derive(run.build, mods(run));
export const maxHp = (run: RunState) => dv(run).maxHp;
export const floorOf = (run: RunState) => (run.at ? run.map.nodes[run.at].floor : -1);
export function level(run: RunState, elite = false) { return 1 + (run.sector - 1) * 3.2 + Math.max(0, floorOf(run)) * 0.28 + (elite ? 1.2 : 0); }
export const bossLevel = (run: RunState) => run.sector * 3 + 0.6;

/** A run-scoped deterministic RNG stream (survives save/load). */
export function runRng(run: RunState): Rng {
  const r = mulberry32(run.seed + 7919 * ++run.rngCalls);
  return r;
}
/** Every repair outside combat scales with heat (No Quarter, heat 8: 0.7). Repair kits in combat use the same factor. */
export const repairMul = (run: RunState) => heatFx(run.heat).heal;
/** Hull a repair of `frac` of max hull would restore right now: after heat, capped by the hull actually missing. */
export const healAmount = (run: RunState, frac: number) => Math.max(0, Math.min(maxHp(run) - run.hp, maxHp(run) * frac * repairMul(run)));
/** Repair `frac` of max hull (less under No Quarter). Returns the hull restored. */
export function heal(run: RunState, frac: number) { const a = healAmount(run, frac); run.hp += a; return a; }
/**
 * Merchant repairs are bought by the hull point: `hullPerScrap` in sector 1, dearer each sector (`sectorTax`) so a
 * late-run refit still competes with new parts, and less again under No Quarter.
 */
export const REPAIR = { hullPerScrap: 3, sectorTax: 0.35 } as const;
export const repairHullPerScrap = (run: RunState) => (REPAIR.hullPerScrap / (1 + REPAIR.sectorTax * (run.sector - 1))) * repairMul(run);
/** What a full merchant repair costs now. */
export function repairQuote(run: RunState, priceMul = 1) {
  const missing = Math.max(0, maxHp(run) - run.hp);
  return { missing, cost: Math.ceil((missing / repairHullPerScrap(run)) * priceMul) };
}
/** Spend scrap on as much hull as it buys, up to full. Returns the hull restored and the scrap spent. */
export function buyRepair(run: RunState, priceMul = 1) {
  const hps = repairHullPerScrap(run), { missing } = repairQuote(run, priceMul);
  const fix = Math.min(missing, (run.scrap / priceMul) * hps);
  const cost = Math.min(run.scrap, Math.ceil((fix / hps) * priceMul - 1e-9));
  run.hp += fix; run.scrap -= cost;
  return { fix, cost };
}
export function hurt(run: RunState, amount: number) { run.hp = Math.max(1, run.hp - amount); }
/** Keep missing hull constant when the max changes (adding sections fills them). */
export function rebuildHp(run: RunState, oldMax: number) { const missing = oldMax - run.hp; run.hp = clamp(maxHp(run) - missing, 1, maxHp(run)); }
export function changeBuild(run: RunState, f: () => void) { const old = maxHp(run); f(); rebuildHp(run, old); }

export function maxTierFor(run: RunState) { return Math.min(5, 1 + Math.floor((run.sector - 1) * 1.3 + Math.max(0, floorOf(run)) / 5)); }
export function randomPart(run: RunState, rng: Rng, bonus = 0): Part {
  const ids = [...Object.keys(WEAPONS), ...Object.keys(UTILS)];
  const mt = Math.min(5, maxTierFor(run) + bonus);
  return mkPart(pick(ids, rng), clamp(rint(mt - 1, mt, rng), 1, 5));
}
export function partChoices(run: RunState, n: number, bonus = 0): Part[] {
  const rng = runRng(run), out: Part[] = [];
  while (out.length < n) { const p = randomPart(run, rng, bonus); if (!out.some((o) => o.id === p.id)) out.push(p); }
  return out;
}
export function relicChoices(run: RunState, n: number, rarities: Rarity[]): string[] {
  const rng = runRng(run);
  const pool = Object.keys(RELICS).filter((id) => rarities.includes(RELICS[id].rarity) && !run.relics.includes(id));
  const out: string[] = [];
  while (out.length < n && pool.length) { const i = Math.floor(rng() * pool.length); out.push(pool.splice(i, 1)[0]); }
  return out;
}
export function addRelic(run: RunState, id: string) { changeBuild(run, () => { if (!run.relics.includes(id)) run.relics.push(id); }); }
export function addSection(run: RunState, type: SectionType) {
  if (run.build.sections.length >= MAX_SECTIONS) return false;
  changeBuild(run, () => run.build.sections.push({ type, slots: SECTIONS[type].slots.map(() => null) }));
  return true;
}
export const nextSectionCost = (run: RunState, t: SectionType) => Math.round(sectionCost(t, run.build.sections.length) * mods(run).priceMul);

/**
 * Overdrive refits. A pick costs a banked commission (sector bosses award one) or the node's scrap price times
 * `priceMul` (drydock 1, merchant its price multiplier). Returns what it cost, or null if it could not be taken.
 */
export function odPrice(run: RunState, id: string, priceMul = 1) { return run.odCredits > 0 ? 0 : Math.round(OD_NODE[id].cost * priceMul); }
export function takeOd(run: RunState, id: string, priceMul = 1): { cost: number; credit: boolean } | null {
  if (!canTakeOd(id, run.od) || OD_NODE[id].kind !== HULLS[run.hull].overdrive) return null;
  const credit = run.odCredits > 0, cost = odPrice(run, id, priceMul);
  if (!credit && run.scrap < cost) return null;
  if (credit) run.odCredits--; else run.scrap -= cost;
  run.od.push(id);
  return { cost, credit };
}
export function enterNextSector(run: RunState) {
  run.sector++; run.map = generateMap(run.sector, run.seed); run.at = null; run.visited = []; run.bossGhost = null; run.bossGhostCount = 0;
}
export function deathGhost(run: RunState): Ghost {
  return { id: `${run.pilot}-${Date.now().toString(36)}`, pilot: run.pilot, name: run.callsign, sector: run.sector, floor: Math.max(0, floorOf(run)), sections: buildToGhost(run.build), relics: run.relics.slice(), score: Math.round(run.stats.score) };
}

/* ---- save / load ---- */
export const SAVE_KEY = 'gd.run.v4';
const LEGACY_KEYS = ['gd.run.v3', 'gd.run.v2'];
export function saveRun(run: RunState) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...run, build: buildToGhost(run.build), inv: run.inv.map((p) => [p.id, p.tier]) })); } catch { /* storage full or blocked */ }
}
export function clearSave() { try { localStorage.removeItem(SAVE_KEY); for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch { /* ignore */ } }
/**
 * Run-save migrations, one step per version: v2 (before hull classes and the meta loop) -> v3 adds the hull
 * (Vanguard), heat 0, no daily, the new stats counters and the codex tally; v3 -> v4 adds the Overdrive tree (no
 * picks; a run already past a sector boss gets one banked commission per boss beaten).
 */
export function migrateRunSave(o: any): any | null {
  if (!o || typeof o !== 'object' || !o.map?.nodes) return null;
  if (o.v === 2) o = { ...o, v: 3, hull: 'vanguard', heat: 0, daily: null, won: false, endless: false, phase: 'map', odStart: 0, seen: { enemies: {}, ghosts: [] }, stats: { ...emptyRunStats(), ...(o.stats || {}) } };
  if (o.v === 3) o = { ...o, v: 4, od: [], odCredits: Math.max(0, Math.floor(Number(o.stats?.bosses) || 0)) };
  if (o.v !== 4) return null;
  return o;
}
export function loadRun(): RunState | null {
  try {
    let raw = localStorage.getItem(SAVE_KEY);
    for (const k of LEGACY_KEYS) if (!raw) raw = localStorage.getItem(k);
    if (!raw) return null;
    const o = migrateRunSave(JSON.parse(raw)); if (!o) return null;
    const run: RunState = { ...o, build: ghostToBuild(o.build), inv: (Array.isArray(o.inv) ? o.inv : []).filter((v: unknown) => Array.isArray(v) && isPart(v[0])).map((v: [string, number]) => mkPart(v[0], clamp(Number(v[1]) || 1, 1, 5))) };
    run.relics = (run.relics || []).filter((r) => has(RELICS, r));
    run.hull = isHullId(run.hull) ? run.hull : 'vanguard';
    run.heat = clamp(Math.floor(Number(run.heat) || 0), 0, MAX_HEAT);
    run.stats = { ...emptyRunStats(), ...(run.stats || {}) };
    run.seen = { enemies: { ...(run.seen?.enemies || {}) }, ghosts: Array.isArray(run.seen?.ghosts) ? run.seen.ghosts : [] };
    run.phase = run.phase === 'victory' ? 'victory' : 'map';
    run.od = sanitizeOd(run.od).filter((id) => OD_NODE[id].kind === HULLS[run.hull].overdrive);
    run.odCredits = clamp(Math.floor(Number(run.odCredits) || 0), 0, 9);
    run.hp = clamp(Number(run.hp) || 1, 1, maxHp(run));
    return run;
  } catch { return null; }
}
export { allParts, partSlot };
