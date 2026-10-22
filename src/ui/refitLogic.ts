// Pure logic behind the refit board (src/ui/refit.ts): where each socket tile sits around the ship and how its
// leader line runs to the mount, what a drag would do (valid or not, and why), and the stat deltas it previews.
// No DOM here, so tests/unit/refitBoard.test.ts can hold the layout to "no overlaps, no crossed leaders".
import {
  SECTIONS, RING_MAX, canPlace, derive, layoutIssue, layoutOf, isWeapon, layersHit, mountFacing, mountRing, nextFacing, pinLayout, ringCost, partDef, partSlot, wCd, wDmg,
  type Build, type Derived, type Mods, type Part, type SlotKind,
} from '../data/parts';

/* ---------------- moves ---------------- */

/** Where a dragged part comes from: the cargo hold, a mount, or the quartermaster's counter (bought on drop). */
export type Src =
  | { k: 'inv'; i: number }
  | { k: 'slot'; si: number; i: number }
  | { k: 'market'; i: number; part: Part; price: number; afford: boolean };
/** Where it can go: a mount, or back into the hold. */
export type Dst = { k: 'slot'; si: number; i: number } | { k: 'hold' };
/** Why a drop is refused. `same` and `noop` are neutral (dropping a part where it already is). */
export type Refusal = 'kind' | 'scrap' | 'same' | 'noop' | 'empty';
export interface Check { ok: boolean; why?: Refusal; reason?: string; /** The part that would come out of the target mount. */ out?: Part | null }

export const slotKind = (b: Build, si: number, i: number): SlotKind => SECTIONS[b.sections[si].type].slots[i];
const kindName = (k: SlotKind) => (k === 'W' ? 'weapon mount' : 'utility bay');
export function partAt(b: Build, inv: Part[], s: Src): Part | null {
  if (s.k === 'inv') return inv[s.i] ?? null;
  if (s.k === 'slot') return b.sections[s.si]?.slots[s.i] ?? null;
  return s.part;
}
export const sameLoc = (a: Src | Dst, b: Src | Dst) =>
  a.k === b.k && (a.k !== 'slot' || (b.k === 'slot' && a.si === b.si && a.i === b.i)) && (a.k !== 'inv' || (b.k === 'inv' && a.i === b.i));

/** Can the part at `src` go to `dst`? The rules are the refit's: a part only fits its own slot kind; bought parts need the scrap. */
export function checkMove(b: Build, inv: Part[], src: Src, dst: Dst): Check {
  const p = partAt(b, inv, src);
  if (!p) return { ok: false, why: 'empty', reason: 'Nothing to move.' };
  if (src.k === 'market' && !src.afford) return { ok: false, why: 'scrap', reason: `Short of scrap: ${src.price} needed.` };
  if (dst.k === 'hold') {
    if (src.k === 'inv') return { ok: false, why: 'noop', reason: 'Already in the hold.' };
    return { ok: true, out: null };
  }
  if (sameLoc(src, dst)) return { ok: false, why: 'same', reason: 'Already mounted here.' };
  const k = slotKind(b, dst.si, dst.i);
  if (partSlot(p.id) !== k) return { ok: false, why: 'kind', reason: `${partDef(p.id).name} needs a ${kindName(partSlot(p.id))}.` };
  return { ok: true, out: b.sections[dst.si].slots[dst.i] ?? null };
}

/**
 * Apply a checked move from the hold or a mount (bought parts are pushed into the hold first, then moved from there).
 * Mount to mount swaps; hold to mount sends the old part to the hold; mount to hold unmounts. Call inside changeBuild().
 */
export function applyMove(b: Build, inv: Part[], src: Src, dst: Dst) {
  if (src.k === 'market') throw new Error('buy market parts into the hold first');
  const p = partAt(b, inv, src); if (!p) return;
  if (dst.k === 'hold') {
    if (src.k === 'slot') { b.sections[src.si].slots[src.i] = null; inv.push(p); }
    return;
  }
  const sec = b.sections[dst.si], cur = sec.slots[dst.i] ?? null;
  if (src.k === 'slot') { b.sections[src.si].slots[src.i] = cur; sec.slots[dst.i] = p; }
  else { inv.splice(src.i, 1); if (cur) inv.push(cur); sec.slots[dst.i] = p; }
}

const cloneBuild = (b: Build): Build => ({ sections: b.sections.map((s) => ({
  type: s.type, slots: s.slots.slice(), ...(s.face ? { face: s.face.slice() } : {}), ...(s.ring ? { ring: s.ring.slice() } : {}), ...(s.at ? { at: [s.at[0], s.at[1]] as [number, number] } : {}),
})) });
/** The build a move would leave (for previews); the real build is untouched. */
export function previewMove(b: Build, inv: Part[], src: Src, dst: Dst): Build | null {
  if (!checkMove(b, inv, src, dst).ok) return null;
  const nb = cloneBuild(b), ni = inv.slice();
  let s: Src = src;
  if (src.k === 'market') { ni.push(src.part); s = { k: 'inv', i: ni.length - 1 }; }
  applyMove(nb, ni, s, dst);
  return nb;
}

/**
 * Hull section order: any section, the bridge too, may move to any position. Order decides where every mount sits along
 * the keel, so what the bridge tower, funnels and sponsons block (hullShadows in data/parts.ts).
 */
export function canMoveSection(b: Build, from: number, to: number) {
  const n = b.sections.length;
  return from !== to && from >= 0 && from < n && to >= 0 && to < n;
}
/** Move a section to position `to` (insertion, the others close up). Call inside changeBuild(). */
export function moveSection(b: Build, from: number, to: number) {
  if (!canMoveSection(b, from, to)) return false;
  const [s] = b.sections.splice(from, 1); b.sections.splice(to, 0, s);
  return true;
}
export function previewSectionMove(b: Build, from: number, to: number) { const nb = cloneBuild(b); return moveSection(nb, from, to) ? nb : null; }
/** Turn a weapon mount to its next allowed facing (dir 1 clockwise, -1 anticlockwise). Call inside changeBuild(). */
export function rotateMount(b: Build, si: number, i: number, dir: 1 | -1) {
  const s = b.sections[si]; if (!s) return false;
  const f = nextFacing(s, i, dir); if (f === null) return false;
  const face = SECTIONS[s.type].slots.map((_, k) => mountFacing(s, k) as number);
  face[i] = f; s.face = face;
  return true;
}
export function previewRotate(b: Build, si: number, i: number, dir: 1 | -1) { const nb = cloneBuild(b); return rotateMount(nb, si, i, dir) ? nb : null; }
/** The scrap a ring refit of mount (si, i) to the next level costs, or null at the best ring / not a weapon mount. */
export function ringUpgradeCost(b: Build, si: number, i: number): number | null {
  const s = b.sections[si]; if (!s || SECTIONS[s.type].slots[i] !== 'W') return null;
  const lv = mountRing(s, i);
  return lv >= RING_MAX ? null : ringCost(lv + 1);
}
/** Fit the next turret ring to mount (si, i) (the caller pays ringUpgradeCost). Call inside changeBuild(). */
export function upgradeRing(b: Build, si: number, i: number) {
  if (ringUpgradeCost(b, si, i) === null) return false;
  const s = b.sections[si];
  s.ring = SECTIONS[s.type].slots.map((_, k) => mountRing(s, k));
  s.ring[i] = mountRing(s, i) + 1;
  return true;
}
/** Move module si to grid spot `at` (design units; the rest of the ship is pinned where it is). Call inside changeBuild(). */
export function placeModule(b: Build, si: number, at: [number, number]) {
  if (!b.sections[si] || canPlace(b, si, at)) return false;
  pinLayout(b); b.sections[si].at = at;
  return true;
}
export function previewPlace(b: Build, si: number, at: [number, number]) { const nb = cloneBuild(b); return placeModule(nb, si, at) ? nb : null; }
/** Cutting a section loose: never the bridge; its parts land in the hold. Call inside changeBuild(). */
export function canCutSection(b: Build, si: number) {
  if (!b.sections[si] || b.sections[si].type === 'bridge') return false;
  // On a placed grid the rest must stay one joined hull.
  const lay = layoutOf(b);
  return !b.sections.some((s) => s.at) || !layoutIssue({ sections: b.sections.filter((_, k) => k !== si) }, lay.filter((_, k) => k !== si));
}
export function cutSection(b: Build, inv: Part[], si: number) {
  if (!canCutSection(b, si)) return null;
  const [s] = b.sections.splice(si, 1);
  for (const p of s.slots) if (p) inv.push(p);
  return s;
}
export function previewCut(b: Build, si: number) { const nb = cloneBuild(b); return cutSection(nb, [], si) ? nb : null; }

/* ---------------- stats ---------------- */

/**
 * Rated firepower: damage per second each mount could pour into air and ground targets from where it sits
 * (a top-deck gun cannot reach the ground). A nominal figure for comparing fits, not a combat simulation:
 * scatter fans and paired pods count every bolt, flak counts two aircraft per burst, reactor and relic bonuses apply.
 */
export function firepower(d: Derived) {
  let air = 0, ground = 0, pd = 0;
  for (const m of d.mounts) {
    const p = m.part;
    if (!p || !isWeapon(p.id)) continue;
    // Every bolt of a scatter fan and both seeker pods count; a flak burst is rated as catching two aircraft.
    const shots = p.id === 'spread' ? (p.tier >= 3 ? 5 : 3) : p.id === 'missile' || p.id === 'flak' ? 2 : 1;
    if (p.id === 'pd') { pd += (1 / wCd(p)) * d.fireMult; continue; }
    const dps = (wDmg(p) / wCd(p)) * shots * d.fireMult;
    if (layersHit(m.trav.layers, 'air')) air += dps * d.mods.dmgAir;
    if (layersHit(m.trav.layers, 'ground')) ground += dps * d.mods.dmgGround;
  }
  return { air, ground, pd };
}
export interface Stat { key: string; label: string; v: number; text: string; /** Is a bigger number better? */ up: boolean }
export function shipStats(d: Derived): Stat[] {
  const f = firepower(d);
  return [
    { key: 'hull', label: 'Hull', v: d.maxHp, text: String(d.maxHp), up: true },
    { key: 'shield', label: 'Shield', v: d.shieldMax, text: d.shieldMax ? String(d.shieldMax) : 'none', up: true },
    { key: 'speed', label: 'Speed', v: Math.round(d.speed), text: String(Math.round(d.speed)), up: true },
    { key: 'mass', label: 'Mass', v: d.mass, text: String(d.mass), up: false },
    { key: 'thrust', label: 'Thrust', v: d.thrust, text: String(d.thrust), up: true },
    { key: 'fire', label: 'Fire rate', v: Math.round(d.fireMult * 100), text: `${Math.round(d.fireMult * 100)}%`, up: true },
    { key: 'air', label: 'Anti-air', v: Math.round(f.air), text: String(Math.round(f.air)), up: true },
    { key: 'ground', label: 'Anti-ground', v: Math.round(f.ground), text: String(Math.round(f.ground)), up: true },
    { key: 'pd', label: 'Point defense', v: Math.round(f.pd * 10) / 10, text: f.pd ? `${f.pd.toFixed(1)}/s` : 'none', up: true },
    { key: 'regen', label: 'Repair', v: Math.round(d.regen * 10) / 10, text: d.regen ? `${d.regen.toFixed(1)}/s` : 'none', up: true },
    { key: 'drones', label: 'Drones', v: d.drones, text: String(d.drones), up: true },
  ];
}
/** Stat-by-stat change from `a` to `b` (only the ones that move). */
export function statDeltas(a: Derived, b: Derived): Record<string, { d: number; good: boolean }> {
  const sa = shipStats(a), sb = shipStats(b), out: Record<string, { d: number; good: boolean }> = {};
  sa.forEach((s, k) => { const d = Math.round((sb[k].v - s.v) * 10) / 10; if (d) out[s.key] = { d, good: (d > 0) === s.up }; });
  return out;
}
export const deriveOf = (b: Build, mods?: Mods) => derive(b, mods);

/* ---------------- board layout ---------------- */

export interface Anchor { id: string; ox: number; oy: number; si: number; i: number; /** On the bow section: the tile goes above the ship. */ bow: boolean }
export interface BoardIn { w: number; h: number; len: number; width: number; anchors: Anchor[] }
export type Side = 'top' | 'left' | 'right' | 'list';
export interface TilePos { id: string; side: Side; x: number; y: number; w: number; h: number; n: number }
export interface Leader { id: string; pts: [number, number][] }
export interface Board {
  mode: 'callout' | 'stacked'; w: number; h: number;
  /** Ship origin and pixels per field unit on the board. */ ship: { cx: number; cy: number; s: number };
  tiles: TilePos[]; leaders: Leader[]; anchors: Record<string, [number, number]>; compact: boolean;
}
/** Below this board width the callouts give way to a numbered list under the ship (phones). */
export const STACK_BELOW = 640;
const TILE_H = 58, TILE_MIN_H = 40, GAP = 8;
/** Vertical offset between the runs of leaders to mounts level with each other (clears a broadside sponson). */
const LEVEL_STEP = 15;

/** Spread boxes of `size` along a line, each as close to its ideal centre as it can be, inside [lo, hi], in order. */
export function resolve1D(ideal: number[], size: number, gap: number, lo: number, hi: number): number[] {
  const n = ideal.length, p = ideal.map((c) => c - size / 2);
  for (let k = 0; k < n; k++) p[k] = Math.max(p[k], k ? p[k - 1] + size + gap : lo);
  for (let k = n - 1; k >= 0; k--) p[k] = Math.min(p[k], k < n - 1 ? p[k + 1] - size - gap : hi - size);
  for (let k = 0; k < n; k++) p[k] = Math.max(p[k], k ? p[k - 1] + size + gap : lo);
  return p;
}

/** Proper intersection of segments ab and cd (touching at a shared end does not count). */
export function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d), e = 1e-6;
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}
export function leadersCross(a: Leader, b: Leader) {
  for (let i = 0; i < a.pts.length - 1; i++) for (let j = 0; j < b.pts.length - 1; j++)
    if (segmentsCross(a.pts[i], a.pts[i + 1], b.pts[j], b.pts[j + 1])) return true;
  return false;
}
export function countCrossings(ls: Leader[]) {
  let n = 0;
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) if (leadersCross(ls[i], ls[j])) n++;
  return n;
}
/** Does segment pq pass through the rectangle (shrunk by `pad`)? */
export function segmentHitsRect(p: [number, number], q: [number, number], r: { x: number; y: number; w: number; h: number }, pad = 2) {
  const x0 = r.x + pad, y0 = r.y + pad, x1 = r.x + r.w - pad, y1 = r.y + r.h - pad;
  let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]] as const) {
    if (Math.abs(pp) < 1e-9) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 < t1;
}

/**
 * Lay out the refit board: the ship in the middle at a scale that fits, the bow mount's tile above it, port tiles in
 * the left column and starboard tiles in the right (centreline mounts go to whichever column is shorter), each tile
 * as close to level with its mount as the column allows, and a leader from each tile to its mount. Within a column
 * tiles keep the mounts' bow-to-stern order, and neighbouring tiles trade mounts when that uncrosses their leaders.
 * Narrow boards (phones) stack instead: ship on top, numbered tiles in a list below, numbered balloons on the hull.
 */
export function layoutBoard(o: BoardIn): Board {
  const { w, anchors } = o;
  const len = Math.max(1, o.len), width = Math.max(1, o.width);
  // Number the mounts bow to stern, port before starboard: the balloons on the hull and the tiles share it.
  const ord = anchors.slice().sort((a, b) => (a.bow === b.bow ? 0 : a.bow ? -1 : 1) || a.oy - b.oy || a.ox - b.ox);
  const num = new Map(ord.map((a, k) => [a.id, k + 1]));

  if (w < STACK_BELOW) {
    const pad = 12, shipH = Math.min(Math.max(240, w * 0.95), 460);
    const s = Math.min((w - pad * 2) / width, (shipH - pad * 2) / len, 5);
    const cx = w / 2, cy = shipH / 2;
    const cols = w >= 420 ? 2 : 1, tw = (w - (cols - 1) * GAP) / cols, th = 54;
    const tiles: TilePos[] = ord.map((a, k) => ({ id: a.id, side: 'list', n: k + 1, w: tw, h: th, x: (k % cols) * (tw + GAP), y: shipH + 12 + Math.floor(k / cols) * (th + GAP) }));
    const rows = Math.ceil(ord.length / cols);
    const an: Record<string, [number, number]> = {};
    for (const a of anchors) an[a.id] = [cx + a.ox * s, cy + a.oy * s];
    return { mode: 'stacked', w, h: shipH + 12 + rows * (th + GAP), ship: { cx, cy, s }, tiles, leaders: [], anchors: an, compact: false };
  }

  const h = o.h;
  const colW = Math.round(Math.min(236, Math.max(164, w * 0.215))), gutter = Math.round(Math.min(64, Math.max(30, w * 0.05)));
  // Sides: port (ox < 0) left, starboard right; centreline mounts balance the columns, alternating at ties.
  const top = ord.filter((a) => a.bow), rest = ord.filter((a) => !a.bow);
  const left: Anchor[] = [], right: Anchor[] = [];
  const centre: Anchor[] = [];
  for (const a of rest) (a.ox < -1 ? left : a.ox > 1 ? right : centre).push(a);
  let flip = false;
  for (const a of centre) {
    if (left.length < right.length) left.push(a); else if (right.length < left.length) right.push(a);
    else { (flip ? right : left).push(a); flip = !flip; }
  }
  const nMax = Math.max(left.length, right.length, 1);
  const tileH = Math.max(TILE_MIN_H, Math.min(TILE_H, (h - (nMax - 1) * GAP) / nMax));
  const gap = Math.min(GAP, Math.max(3, (h - nMax * tileH) / Math.max(1, nMax - 1)));
  const topH = top.length ? tileH + 44 : 16;
  const ax0 = colW + gutter, ax1 = w - colW - gutter, ay0 = topH, ay1 = h - 14;
  const s = Math.min(((ax1 - ax0) * 0.96) / width, ((ay1 - ay0) * 0.96) / len, 5);
  const cx = w / 2, cy = (ay0 + ay1) / 2;
  const an: Record<string, [number, number]> = {};
  for (const a of anchors) an[a.id] = [cx + a.ox * s, cy + a.oy * s];

  const tiles: TilePos[] = [], leaders: Leader[] = [];
  const stub = Math.min(18, gutter * 0.4), hullHalf = (width / 2) * s;
  /*
   * A side leader runs: tile edge -> short stub -> diagonal across the gutter -> level run over the hull -> mount.
   * The diagonals all live between two vertical lines (stub end, hull edge) in the same top-to-bottom order as the
   * level runs, and the runs are horizontal at distinct heights, so no two leaders of a column can cross. Mounts
   * level with each other (a battery's flank gun and its centre bay) get runs LEVEL_STEP apart, the deeper one
   * above, ending in a short tick down to the mount.
   */
  const column = (list: Anchor[], side: 'left' | 'right') => {
    const depth = (a: Anchor) => Math.abs(an[a.id][0] - (side === 'left' ? cx - hullHalf : cx + hullHalf));
    list.sort((a, b) => an[a.id][1] - an[b.id][1] || depth(a) - depth(b));
    const run = new Map<string, number>();
    for (let k = 0; k < list.length; k++) {
      const y = an[list[k].id][1];
      let j = 0; while (k - j - 1 >= 0 && Math.abs(an[list[k - j - 1].id][1] - y) < 2) j++;
      run.set(list[k].id, y - j * LEVEL_STEP);
    }
    list.sort((a, b) => run.get(a.id)! - run.get(b.id)!);
    const ys = resolve1D(list.map((a) => run.get(a.id)!), tileH, gap, 0, h);
    const x = side === 'left' ? 0 : w - colW, dir = side === 'left' ? 1 : -1;
    list.forEach((a, k) => {
      const t: TilePos = { id: a.id, side, n: num.get(a.id)!, x, y: ys[k], w: colW, h: tileH };
      const ex = side === 'left' ? x + colW : x, ey = t.y + t.h / 2, sx = ex + dir * stub;
      const hx = cx - dir * (hullHalf + Math.min(12, gutter * 0.25));
      const gx = dir > 0 ? Math.max(sx + 6, hx) : Math.min(sx - 6, hx);
      const [ax, ay] = an[a.id], ry = run.get(a.id)!;
      const pts: [number, number][] = [[ex, ey], [sx, ey], [gx, ry], [ax, ry]];
      if (Math.abs(ry - ay) > 0.5) pts.push([ax, ay]);
      tiles.push(t); leaders.push({ id: a.id, pts });
    });
  };
  column(left, 'left'); column(right, 'right');
  if (top.length) {
    const tw = Math.min(colW, (ax1 - ax0 - (top.length - 1) * GAP) / top.length);
    top.sort((a, b) => an[a.id][0] - an[b.id][0]);
    const xs = resolve1D(top.map((a) => an[a.id][0]), tw, GAP, ax0, ax1);
    top.forEach((a, k) => {
      const t: TilePos = { id: a.id, side: 'top', n: num.get(a.id)!, x: xs[k], y: 0, w: tw, h: tileH };
      const [ax, ay] = an[a.id], bx = t.x + t.w / 2, by = t.y + t.h;
      tiles.push(t); leaders.push({ id: a.id, pts: [[bx, by], [bx, by + stub], [ax, ay]] });
    });
  }
  return { mode: 'callout', w, h, ship: { cx, cy, s }, tiles, leaders, anchors: an, compact: tileH < 52 };
}
