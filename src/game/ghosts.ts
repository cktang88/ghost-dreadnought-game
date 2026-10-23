// Client for the ghost registry. Falls back to ghosts stored on this device if the server is unreachable.
import { WEAPONS, UTILS, SECTIONS, MAX_SECTIONS, RING_MAX, type GhostSections, type SectionType } from '../data/parts';
import { has, pick, rint } from '../util/rng';

export interface Ghost { id: string; pilot: string; name: string; sector: number; floor: number; sections: GhostSections; relics: string[]; score: number; ai?: boolean }

export const sanitizeName = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 _.\-]/g, '').trim().slice(0, 16);

export function validGhost(g: any): Ghost | null {
  if (!g || typeof g !== 'object') return null;
  const sector = Number(g.sector);
  if (!Number.isInteger(sector) || sector < 1 || sector > 99) return null;
  if (!Array.isArray(g.sections) || g.sections.length < 1 || g.sections.length > MAX_SECTIONS) return null;
  const sections: GhostSections = [];
  for (const s of g.sections) {
    if (!s || !has(SECTIONS, s.type)) return null;
    const kinds = SECTIONS[s.type as SectionType].slots;
    // recorded mount facings (0..7); ghostToBuild drops any a mount cannot take
    const face = Array.isArray(s.face) ? { face: kinds.map((_, i) => { const f = Number(s.face[i]); return Number.isInteger(f) && f >= 0 && f < 8 ? f : 0; }) } : {};
    // turret rings (1..RING_MAX) and the grid position; ghostToBuild re-checks the layout is one joined hull
    const ring = Array.isArray(s.ring) ? { ring: kinds.map((_, i) => { const r = Number(s.ring[i]); return Number.isInteger(r) && r >= 1 && r <= RING_MAX ? r : 1; }) } : {};
    const at = Array.isArray(s.at) && s.at.length === 2 && s.at.every((v: unknown) => Number.isFinite(Number(v)) && Math.abs(Number(v)) < 400) ? { at: [Number(s.at[0]), Number(s.at[1])] as [number, number] } : {};
    sections.push({
      type: s.type, ...face, ...ring, ...at,
      slots: kinds.map((k, i) => {
        const v = Array.isArray(s.slots) ? s.slots[i] : null;
        if (!Array.isArray(v)) return null;
        const ok = k === 'W' ? has(WEAPONS, v[0]) : has(UTILS, v[0]);
        return ok ? [v[0] as string, Math.min(5, Math.max(1, Math.round(Number(v[1]) || 1)))] : null;
      }),
    });
  }
  if (!sections.some((s) => s.type === 'bridge')) return null;
  return {
    id: String(g.id ?? '').slice(0, 48), pilot: String(g.pilot ?? '').slice(0, 24), name: sanitizeName(g.name) || 'UNKNOWN',
    sector, floor: Math.max(0, Math.min(20, Math.round(Number(g.floor) || 0))), sections,
    relics: Array.isArray(g.relics) ? g.relics.filter((r: unknown) => typeof r === 'string').slice(0, 30) : [],
    score: Math.max(0, Number(g.score) || 0),
  };
}

const LOCAL_KEY = 'gd.ghosts.v2';
function localGhosts(): Ghost[] {
  try { const a = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(a) ? a.map(validGhost).filter((g): g is Ghost => !!g) : []; } catch { return []; }
}
function saveLocal(g: Ghost) {
  try { const a = localGhosts(); a.push(g); localStorage.setItem(LOCAL_KEY, JSON.stringify(a.slice(-60))); } catch { /* storage blocked */ }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

export async function registryOnline(): Promise<{ online: boolean; total: number }> {
  try { const r = await withTimeout(fetch('/api/health'), 2500); if (!r.ok) throw new Error(); const j = await r.json(); return { online: true, total: j.ghosts | 0 }; } catch { return { online: false, total: 0 }; }
}

export async function fetchGhosts(sector: number): Promise<{ ghosts: Ghost[]; count: number; online: boolean }> {
  const local = localGhosts().filter((g) => g.sector === sector);
  try {
    const r = await withTimeout(fetch(`/api/ghosts?sector=${sector}`), 3500);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const list = (Array.isArray(j.ghosts) ? j.ghosts : []).map(validGhost).filter((g: Ghost | null): g is Ghost => !!g);
    return { ghosts: list.length ? list : local, count: Number(j.count) || list.length, online: true };
  } catch {
    return { ghosts: local, count: local.length, online: false };
  }
}

export async function submitGhost(g: Ghost): Promise<'shared' | 'local'> {
  saveLocal(g);
  try {
    const r = await withTimeout(fetch('/api/ghosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(g) }), 4000);
    return r.ok ? 'shared' : 'local';
  } catch { return 'local'; }
}

const AI_NAMES = ['IRON WARDEN', 'HOLLOW REGENT', 'CINDER MATRON', 'GREY TITHE', 'LAST BASTION', 'PALE ARBITER', 'RUST SOVEREIGN', 'NULL CHOIR'];
/**
 * Defense core mount facings and turret rings, by sector. A ghost's guns hold fire while the player is outside their
 * arcs (it is mirrored: its bow points down the screen, its stern up), so a core can leave a hole in its cover:
 *  - sector 1: sponsons angled aft, turrets astern, standard rings. Off its bow quarters (about 35-90 degrees
 *    off its bow, between the bridge gun's cone and the sponsons'), nothing bears.
 *  - sector 2: sponsons abeam, one turret forward and one astern on wide rings: covered all round but for the hull's
 *    own shadows.
 *  - sector 3+: the fore battery angled forward, the aft one abeam, wide rings everywhere; full turret rings from 4.
 * Battery mounts are [port, centre, starboard]; gun decks [fore, aft].
 */
const AI_FACE = (sector: number, type: SectionType, nth: number): number[] | undefined => {
  if (type === 'battery') return sector <= 1 ? [5, 6, 3] : sector >= 3 && nth === 0 ? [7, 6, 1] : [6, 2, 2];
  if (type === 'gundeck') return sector <= 1 ? [4, 4] : [0, 4];
  return undefined;
};
const AI_RING = (sector: number, type: SectionType): number => {
  if (type === 'gundeck') return sector >= 4 ? 3 : sector >= 2 ? 2 : 1;
  return (type === 'battery' || type === 'bridge') && sector >= 3 ? 2 : 1;
};
export function aiGhost(sector: number): Ghost {
  const n = Math.min(MAX_SECTIONS, 3 + sector);
  // Every defense core is a dreadnought: a Broadside Battery right behind the bridge, a second one from sector 3.
  const order: SectionType[] = ['battery', 'gundeck', 'armor', 'engine', 'battery', 'spine', 'gundeck', 'armor'];
  const maxT = Math.min(5, 1 + Math.floor(sector / 2));
  const wids = Object.keys(WEAPONS).filter((k) => k !== 'pd'), uids = Object.keys(UTILS);
  /** Flank mounts of a battery get guns that can fire a broadside; its centre may be anything. */
  const sideGuns = ['pulse', 'pulse', 'spread', 'flak', 'missile', 'rail'];
  const rings = (type: SectionType) => SECTIONS[type].slots.map(() => AI_RING(sector, type));
  const sections: GhostSections = [{ type: 'bridge', slots: [['pulse', maxT]], face: [0], ring: rings('bridge') }];
  const seen: Partial<Record<SectionType, number>> = {};
  for (let i = 1; i < n; i++) {
    const type = order[(i - 1) % order.length], nth = seen[type] ?? 0, face = AI_FACE(sector, type, nth);
    seen[type] = nth + 1;
    sections.push({ type, slots: SECTIONS[type].slots.map((k, j) => [k === 'W' ? pick(type === 'battery' && j !== 1 ? sideGuns : wids) : pick(uids), rint(Math.max(1, maxT - 1), maxT)] as [string, number]), ...(face ? { face } : {}), ring: rings(type) });
  }
  return { id: `ai-${sector}`, pilot: 'ai', name: AI_NAMES[(sector - 1) % AI_NAMES.length], sector, floor: 10, sections, relics: [], score: 0, ai: true };
}
export function chooseGhost(list: Ghost[], sector: number, myPilot: string): Ghost {
  if (!list.length) return aiGhost(sector);
  const others = list.filter((g) => g.pilot !== myPilot);
  return pick(others.length && Math.random() < 0.85 ? others : list);
}
