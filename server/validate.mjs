// Shared ghost validation. Mirrors the part/section ids in src/data/parts.ts; the client re-validates on load.
export const SECTION_SLOTS = {
  bridge: ['W'], gundeck: ['W', 'W'], battery: ['W', 'W', 'W'], armor: ['U'], spine: ['U', 'U'], engine: ['U'],
};
export const WEAPON_IDS = ['pulse', 'spread', 'flak', 'missile', 'bomb', 'artillery', 'rail', 'tesla', 'pd'];
export const UTIL_IDS = ['plate', 'shield', 'thruster', 'reactor', 'repair', 'magnet', 'drones'];
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export function validateGhost(g) {
  if (!g || typeof g !== 'object') return null;
  const sector = Number(g.sector);
  if (!Number.isInteger(sector) || sector < 1 || sector > 99) return null;
  if (!Array.isArray(g.sections) || g.sections.length < 1 || g.sections.length > 8) return null;
  const sections = [];
  for (const s of g.sections) {
    if (!s || !own(SECTION_SLOTS, s.type)) return null;
    const kinds = SECTION_SLOTS[s.type];
    const slots = kinds.map((k, i) => {
      const v = Array.isArray(s.slots) ? s.slots[i] : null;
      if (!Array.isArray(v)) return null;
      const id = v[0];
      const ok = k === 'W' ? WEAPON_IDS.includes(id) : UTIL_IDS.includes(id);
      if (!ok) return null;
      return [id, Math.min(5, Math.max(1, Math.round(Number(v[1]) || 1)))];
    });
    // Mount facings (0..7, clockwise from the bow); the client checks which are allowed where (allowedFacings).
    const face = kinds.map((_, i) => { const f = Array.isArray(s.face) ? Number(s.face[i]) : 0; return Number.isInteger(f) && f >= 0 && f < 8 ? f : 0; });
    sections.push({ type: s.type, slots, face });
  }
  if (!sections.some((s) => s.type === 'bridge')) return null;
  const name = String(g.name || '').toUpperCase().replace(/[^A-Z0-9 _.\-]/g, '').trim().slice(0, 16) || 'UNKNOWN';
  const pilot = String(g.pilot || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const id = String(g.id || '').replace(/[^a-z0-9\-]/gi, '').slice(0, 48) || `${pilot}-${Date.now().toString(36)}`;
  const relics = Array.isArray(g.relics) ? g.relics.filter((r) => typeof r === 'string' && /^[a-z_]{2,24}$/.test(r)).slice(0, 30) : [];
  return {
    id, pilot, name, sector,
    floor: Math.max(0, Math.min(20, Math.round(Number(g.floor) || 0))),
    sections, relics,
    score: Math.max(0, Math.round(Number(g.score) || 0)),
    at: Number(g.at) || Date.now(),
    v: 2,
  };
}

/* ---------------- daily strike leaderboard ---------------- */
// Mirrors src/data/hulls.ts; the score itself comes from dailyScore() in src/game/meta.ts (formula in docs/TECH.md).
export const HULL_IDS = ['vanguard', 'leviathan', 'lance', 'bastion'];
/** Hard ceilings: anything above these is not a run this game can produce. */
export const DAILY_LIMITS = { score: 20_000_000, kills: 100_000, sector: 99, floor: 20, callsign: 16, rawString: 40 };

/** UTC calendar day as YYYY-MM-DD. The daily strike seed and the board both run on UTC days. */
export function utcDateKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 10);
}
/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, junk). */
export function isDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && utcDateKey(t) === s;
}
/** Submissions are accepted for today's UTC date, and yesterday's (a run that started before midnight UTC). */
export function dailyDateOpen(date, now = Date.now()) {
  return isDateKey(date) && (date === utcDateKey(now) || date === utcDateKey(now - 86_400_000));
}

/** Callsigns use the hull-stencil alphabet (same rule as ghost names). Returns '' if unusable. */
export function cleanCallsign(raw) {
  if (typeof raw !== 'string' || raw.length > DAILY_LIMITS.rawString) return '';
  const s = raw.toUpperCase().trim().replace(/\s+/g, ' ');
  if (!s || s.length > DAILY_LIMITS.callsign || /[^A-Z0-9 _.\-]/.test(s)) return '';
  return s;
}

const intIn = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validate a daily submission. Returns { entry } or { error } (a message for a 400). Strict: wrong types,
 * out-of-range numbers, oversized strings and closed dates are rejected rather than clamped.
 */
export function validateDaily(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Body must be a JSON object.' };
  const callsign = cleanCallsign(b.callsign);
  if (!callsign) return { error: 'Callsign must be 1-16 characters: A-Z, 0-9, space, _ . -' };
  if (!isDateKey(b.date)) return { error: 'Date must be YYYY-MM-DD.' };
  if (!dailyDateOpen(b.date, now)) return { error: "Only today's or yesterday's (UTC) daily strike can be submitted." };
  if (!intIn(b.score, 0, DAILY_LIMITS.score)) return { error: 'Score is not a plausible whole number.' };
  if (!intIn(b.sector, 1, DAILY_LIMITS.sector)) return { error: 'Sector must be a whole number from 1 to 99.' };
  if (!intIn(b.floor, 0, DAILY_LIMITS.floor)) return { error: 'Floor must be a whole number from 0 to 20.' };
  if (!intIn(b.kills, 0, DAILY_LIMITS.kills)) return { error: 'Kills is not a plausible whole number.' };
  if (typeof b.hull !== 'string' || !HULL_IDS.includes(b.hull)) return { error: 'Unknown hull class.' };
  if (typeof b.won !== 'boolean') return { error: 'Victory flag must be true or false.' };
  if (b.won && b.sector < 3) return { error: 'A victory needs all three campaign sectors.' };
  return { entry: { callsign, date: b.date, score: b.score, sector: b.sector, floor: b.floor, kills: b.kills, hull: b.hull, won: b.won, at: now } };
}

/** Re-check a stored entry when loading the data file (its date need not be open any more). */
export function validStoredDaily(e) {
  if (!e || typeof e !== 'object') return null;
  const callsign = cleanCallsign(e.callsign);
  if (!callsign || !isDateKey(e.date) || !intIn(e.score, 0, DAILY_LIMITS.score) || !intIn(e.sector, 1, DAILY_LIMITS.sector)
    || !intIn(e.floor, 0, DAILY_LIMITS.floor) || !intIn(e.kills, 0, DAILY_LIMITS.kills) || !HULL_IDS.includes(e.hull)) return null;
  return { callsign, date: e.date, score: e.score, sector: e.sector, floor: e.floor, kills: e.kills, hull: e.hull, won: !!e.won, at: Number(e.at) || 0 };
}

/**
 * Per-key (IP) rate limit: at most `max` accepted hits per fixed `windowMs`, and at least `gapMs` between hits.
 * hit(key, now) returns 0 when allowed, otherwise the milliseconds to wait.
 */
export function rateLimiter({ max = 12, windowMs = 60 * 60_000, gapMs = 5_000 } = {}) {
  const seen = new Map();
  return {
    hit(key, now = Date.now()) {
      let s = seen.get(key);
      if (!s || now - s.start >= windowMs) { s = { start: now, n: 0, last: -Infinity }; seen.set(key, s); }
      if (now - s.last < gapMs) return gapMs - (now - s.last);
      if (s.n >= max) return windowMs - (now - s.start);
      s.n++; s.last = now;
      if (seen.size > 10_000) for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
      return 0;
    },
  };
}
