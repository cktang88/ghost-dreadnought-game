// 2D blueprint view of a ship, used on menus (refit, merchant, boss intel).
// The plan of a long, narrow capital ship: a pointed bow ahead of the first frame, a tapered stern behind the last,
// frames of plating and machinery between, battery sponsons bulging from the sides, and the raised structures that
// mask the ship's own guns (bridge tower, engine funnels) drawn with a shadow and a dashed "above deck" outline.
// Every weapon mount is drawn where it sits and turned to its facing, so the drawing reads as a warship plan.
import { HULL_BEAM, WEAPONS, facingAngle, facingMatters, partDef, positionArc, type Derived, type Obstacle, type Rect } from '../data/parts';
import { SHIP_SCALE } from '../game/field';
import { has, mulberry32 } from '../util/rng';
import { gunCount } from './ship/arcs';

const PTH = { hull: '#4b5968', edge: '#a9bccb', panel: '#33404c', deck: '#5d6e7f', glass: '#4fd1e8', fine: 'rgba(169,188,203,0.16)', light: '#ffcf8a', raised: '#f2a541' };
const BTH = { hull: '#3f2226', edge: '#ff6a5c', panel: '#5c2e33', deck: '#56303a', glass: '#ffcf5c', fine: 'rgba(255,106,92,0.16)', light: '#ff7a5c', raised: '#ffb347' };
type Theme = typeof PTH;
type M = Derived['mounts'][number];

/** Half-beam of the hull proper in a section (a battery's rect includes its sponsons). */
export const halfBeam = (r: Rect) => (r.type === 'battery' ? Math.min(r.w, HULL_BEAM * SHIP_SCALE) : r.w) / 2;
/** Plan length drawn ahead of the first frame (the pointed bow) and behind the last (the stern), ship units. */
export function planExtent(dv: Derived) {
  if (!dv.rects.length) return { lead: 0, tail: 0 };
  return { lead: halfBeam(dv.rects[0]) * 1.5, tail: halfBeam(dv.rects[dv.rects.length - 1]) * 0.45 };
}

/** Port side of the hull outline, bow point to stern corner (the starboard side mirrors it). */
function outlinePts(dv: Derived): [number, number][] {
  const rs = dv.rects, { lead, tail } = planExtent(dv), pts: [number, number][] = [];
  const b0 = halfBeam(rs[0]), y0 = rs[0].y;
  // Clipper bow: a sharp stem ahead of the first frame, swelling to the full beam with a fair tangent.
  for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push([-b0 * (1 - (1 - t) ** 2.2), y0 - lead * (1 - t)]); }
  rs.forEach((r, i) => {
    const b = halfBeam(r), nb = rs[i + 1] ? halfBeam(rs[i + 1]) : b, ch = Math.min(5, r.h * 0.2);
    if (i) pts.push([-b, r.y + (Math.abs(halfBeam(rs[i - 1]) - b) > 0.5 ? ch : 0)]);
    pts.push([-b, r.y + r.h - (Math.abs(nb - b) > 0.5 ? ch : 0)]);
  });
  // Tapered stern: a quarter-round into a narrow transom.
  const L = rs[rs.length - 1], bl = halfBeam(L), yl = L.y + L.h;
  for (let k = 1; k <= 6; k++) { const t = (k / 6) * Math.PI / 2; pts.push([-bl * (0.58 + 0.42 * Math.cos(t)), yl + tail * Math.sin(t)]); }
  return pts;
}
function outline(c: CanvasRenderingContext2D, pts: [number, number][]) {
  c.beginPath(); pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
  for (let k = pts.length - 1; k >= 0; k--) c.lineTo(-pts[k][0], pts[k][1]);
  c.closePath();
}

/** Plating, machinery blocks and portholes inside one frame (seeded by section, like the 3D greebles). */
function sectionDetail(c: CanvasRenderingContext2D, r: Rect, si: number, th: Theme, px: number) {
  const rnd = mulberry32(si * 7919 + r.type.length * 104729 + Math.round(r.w)), b = halfBeam(r), x0 = -b, w = b * 2;
  c.strokeStyle = th.fine; c.lineWidth = px;
  for (let x = x0 + 4; x < x0 + w - 2; x += 7.5) { c.beginPath(); c.moveTo(x, r.y); c.lineTo(x, r.y + r.h); c.stroke(); }
  for (let x = x0 + 4; x < x0 + w - 2; x += 7.5) for (let y = r.y + rnd() * 9; y < r.y + r.h; y += 7 + rnd() * 11) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + 7.5, y); c.stroke(); }
  // Inner deck edge (gallery terrace).
  c.strokeStyle = th.panel; c.lineWidth = px * 1.4; c.strokeRect(x0 + 4.5, r.y + 0.5, w - 9, r.h - 1);
  // Machinery drafted as thin outlines (a plan, not a photo), a few filled, the odd lit edge.
  const n = Math.round((w * r.h) / 70);
  c.lineWidth = px * 0.8; c.strokeStyle = th.edge;
  for (let i = 0; i < n; i++) {
    const bw = 1.2 + rnd() * 4.5, bh = 1.2 + rnd() * 4.5, x = x0 + 6 + rnd() * (w - 12 - bw), y = r.y + 1.5 + rnd() * (r.h - 3 - bh);
    if (rnd() < 0.3) { c.fillStyle = th.panel; c.globalAlpha = 0.6; c.fillRect(x, y, bw, bh); }
    c.globalAlpha = 0.28; c.strokeRect(x, y, bw, bh);
    if (rnd() < 0.12) { c.fillStyle = th.light; c.globalAlpha = 0.7; c.fillRect(x, y + bh - px, bw, px); }
  }
  c.globalAlpha = 1;
  // Portholes along both sides.
  c.fillStyle = th.light;
  for (let y = r.y + 1; y < r.y + r.h - 0.5; y += 1.3) for (const sx of [-1, 1]) if (rnd() < 0.55) { c.globalAlpha = 0.35 + rnd() * 0.5; c.fillRect(sx * (b - 1.2) - px * 0.6, y, px * 1.2, px * 1.2); }
  c.globalAlpha = 1;
}

/** A battery sponson: a gun platform bulging out of the side, chamfered fore and aft. */
function sponson(c: CanvasRenderingContext2D, dv: Derived, o: Obstacle, th: Theme, px: number) {
  const sd = Math.sign(o.x) || 1, b = halfBeam(dv.rects[o.si]), out = Math.abs(o.x) + o.hw;
  c.beginPath();
  c.moveTo(sd * (b - 1), o.y - o.hl - 5); c.lineTo(sd * out, o.y - o.hl * 0.55); c.lineTo(sd * out, o.y + o.hl * 0.55); c.lineTo(sd * (b - 1), o.y + o.hl + 5);
  c.closePath(); c.fillStyle = th.hull; c.strokeStyle = th.edge; c.lineWidth = 1.2 * px; c.fill(); c.stroke();
  c.strokeStyle = th.panel; c.lineWidth = px; c.beginPath(); c.moveTo(sd * (out - 2.5), o.y - o.hl * 0.45); c.lineTo(sd * (out - 2.5), o.y + o.hl * 0.45); c.stroke();
}

/** Raised structure: drop shadow, hatching and a dashed "above deck" outline (it masks the guns around it). */
function raised(c: CanvasRenderingContext2D, o: Obstacle, th: Theme, px: number, body: () => void) {
  const x = o.x - o.hw, y = o.y - o.hl, w = o.hw * 2, h = o.hl * 2;
  c.fillStyle = 'rgba(0,0,0,0.42)'; c.fillRect(x + 3, y + 4, w, h);
  body();
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.strokeStyle = th.edge; c.globalAlpha = 0.16; c.lineWidth = px;
  for (let k = -h; k < w; k += 3) { c.beginPath(); c.moveTo(x + k, y + h); c.lineTo(x + k + h, y); c.stroke(); }
  c.restore();
  c.strokeStyle = th.raised; c.globalAlpha = 0.7; c.lineWidth = 1.1 * px; c.setLineDash([3 * px, 2 * px]);
  c.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3); c.setLineDash([]); c.globalAlpha = 1;
}
function tower(c: CanvasRenderingContext2D, o: Obstacle, th: Theme, px: number) {
  raised(c, o, th, px, () => {
    // Stepped bridge tower, the forward face of each tier glazed.
    for (const k of [1, 0.74, 0.5]) {
      const w = o.hw * k, h = o.hl * k, y = o.y + o.hl * (1 - k) * 0.35;
      c.fillStyle = th.panel; c.strokeStyle = th.edge; c.lineWidth = px;
      c.beginPath(); c.moveTo(o.x - w * 0.7, y - h); c.lineTo(o.x + w * 0.7, y - h); c.lineTo(o.x + w, y - h * 0.6); c.lineTo(o.x + w, y + h); c.lineTo(o.x - w, y + h); c.lineTo(o.x - w, y - h * 0.6); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = th.glass; c.globalAlpha = 0.65; c.fillRect(o.x - w * 0.62, y - h + px * 0.8, w * 1.24, px * 1.6); c.globalAlpha = 1;
    }
    c.fillStyle = th.light; c.beginPath(); c.arc(o.x, o.y + o.hl * 0.2, 1.4, 0, Math.PI * 2); c.fill();
  });
}
function funnels(c: CanvasRenderingContext2D, o: Obstacle, th: Theme, px: number) {
  raised(c, o, th, px, () => {
    for (const sx of [-0.5, 0.5]) {
      const x = o.x + sx * o.hw, rx = o.hw * 0.42, ry = o.hl * 0.82;
      c.fillStyle = th.panel; c.strokeStyle = th.edge; c.lineWidth = px * 1.2;
      c.beginPath(); c.ellipse(x, o.y, rx, ry, 0, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = '#05070a'; c.beginPath(); c.ellipse(x, o.y, rx * 0.62, ry * 0.66, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffb347'; c.globalAlpha = 0.35; c.beginPath(); c.ellipse(x, o.y, rx * 0.3, ry * 0.32, 0, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
    }
  });
}

export interface BlueprintOpts {
  /** Ship origin and scale in canvas pixels (the refit board lays the ship out itself); `k` is the device pixel ratio. */
  fit?: { cx: number; cy: number; s: number; k: number };
  /** Hull section to outline (the refit board's section list hover). */
  section?: number | null;
  /** Draw each mount's traverse fan on the canvas (the refit board draws its own on top; default true). */
  arcs?: boolean;
}
export function drawBlueprint(canvas: HTMLCanvasElement, dv: Derived, hostile = false, highlight: { si: number; i: number } | null = null, opts: BlueprintOpts = {}) {
  const c = canvas.getContext('2d')!, w = canvas.width, h = canvas.height, th = hostile ? BTH : PTH;
  const k = opts.fit?.k ?? 1, step = 32 * k;
  c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#0a0e13'; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#17212b'; c.lineWidth = k;
  for (let x = 0; x <= w; x += step) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
  for (let y = 0; y <= h; y += step) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
  if (!dv.rects.length) return;
  const ext = planExtent(dv), full = dv.len + ext.lead + ext.tail;
  const s = opts.fit ? opts.fit.s * k : Math.min(5, (h - 60) / full, (w - 60) / dv.width), px = 1 / s;
  c.save();
  c.translate(opts.fit ? opts.fit.cx * k : w / 2, opts.fit ? opts.fit.cy * k : h / 2 + ((hostile ? -1 : 1) * (ext.lead - ext.tail) / 2) * s);
  if (hostile) c.scale(s, -s); else c.scale(s, s);
  c.lineWidth = 1.2 * px;
  const pts = outlinePts(dv);
  for (const o of dv.obstacles) if (o.kind === 'sponson') sponson(c, dv, o, th, px);
  c.fillStyle = th.hull; c.strokeStyle = th.edge; c.lineWidth = 1.4 * px; outline(c, pts); c.fill(); c.stroke();
  c.save(); outline(c, pts); c.clip();
  dv.rects.forEach((r, si) => { c.save(); c.beginPath(); c.rect(-r.w, r.y, r.w * 2, r.h); c.clip(); sectionDetail(c, r, si, th, px); c.restore(); });
  // Frame seams, the keel line and the forecastle: breakwater chevron and hawse pipes.
  c.strokeStyle = th.edge; c.lineWidth = px;
  dv.rects.forEach((r, si) => { if (si) { c.globalAlpha = 0.55; c.beginPath(); c.moveTo(-r.w, r.y); c.lineTo(r.w, r.y); c.stroke(); } });
  const y0 = dv.rects[0].y, b0 = halfBeam(dv.rects[0]), yEnd = dv.rects[dv.rects.length - 1].y + dv.rects[dv.rects.length - 1].h + ext.tail;
  c.globalAlpha = 0.3; c.setLineDash([6 * px, 4 * px]); c.beginPath(); c.moveTo(0, y0 - ext.lead + 4); c.lineTo(0, yEnd - 2); c.stroke(); c.setLineDash([]);
  c.globalAlpha = 0.6; c.beginPath(); c.moveTo(-b0 * 0.78, y0 - 2); c.lineTo(0, y0 - ext.lead * 0.42); c.lineTo(b0 * 0.78, y0 - 2); c.stroke();
  c.globalAlpha = 1; c.fillStyle = th.panel;
  for (const sx of [-1, 1]) { c.beginPath(); c.arc(sx * b0 * 0.32, y0 - ext.lead * 0.62, 1.6, 0, Math.PI * 2); c.fill(); c.stroke(); }
  c.restore();
  c.strokeStyle = th.edge; c.lineWidth = 1.4 * px; outline(c, pts); c.stroke();
  // Thrust: an engine block at the stern glows through the transom.
  const last = dv.rects[dv.rects.length - 1];
  if (last.type === 'engine') { c.fillStyle = '#ffb347'; const bl = halfBeam(last); for (const sx of [-0.3, 0.3]) c.fillRect(bl * sx - 3, yEnd - 0.5, 6, 3); }
  for (const o of dv.obstacles) if (o.kind === 'tower') (o.by === 'bridge' ? tower : funnels)(c, o, th, px);
  if (opts.section != null && dv.rects[opts.section]) {
    // Section outline: a hazard-amber frame with corner ticks, like a marked-up drawing.
    const r = dv.rects[opts.section], m = 3;
    c.save(); c.strokeStyle = '#f2a541'; c.lineWidth = 1.6 * px; c.setLineDash([4 * px, 3 * px]);
    c.strokeRect(r.x - m, r.y - 0.5, r.w + m * 2, r.h + 1); c.setLineDash([]);
    c.fillStyle = 'rgba(242,165,65,0.10)'; c.fillRect(r.x - m, r.y - 0.5, r.w + m * 2, r.h + 1); c.restore();
  }
  if (opts.arcs !== false) for (const m of dv.mounts) if (m.part && has(WEAPONS, m.part.id)) arcFan(c, m, partDef(m.part.id).col, !!highlight && highlight.si === m.si && highlight.i === m.i);
  for (const m of dv.mounts) {
    const p = m.part, hl = !!highlight && highlight.si === m.si && highlight.i === m.i;
    if (hl) { c.strokeStyle = '#4fd1e8'; c.lineWidth = 1.6 * px; c.beginPath(); c.arc(m.ox, m.oy, 10, 0, Math.PI * 2); c.stroke(); }
    if (!p) { emptyMount(c, dv, m, th, px, hl); continue; }
    const col = partDef(p.id).col;
    if (has(WEAPONS, p.id)) drawMount(c, m, col, th, px, hl);
    else { c.save(); c.translate(m.ox, m.oy); c.rotate(Math.PI / 4); c.fillStyle = col; c.globalAlpha = 0.85; c.fillRect(-3.2, -3.2, 6.4, 6.4); c.globalAlpha = 1; c.lineWidth = px; c.strokeStyle = hl ? '#4fd1e8' : th.edge; c.strokeRect(-3.2, -3.2, 6.4, 6.4); c.restore(); }
  }
  c.restore();
}

/** Where a mount is drawn on the plan (ship units): exactly where it sits, so the arcs the board draws match the game's. */
export const mountDrawPos = (_dv: Derived, m: M): [number, number] => [m.ox, m.oy];

/** Masked traverse fan (boss intel; the refit board draws richer ones itself). Ship space: 0 = bow, up the plan. */
function arcFan(c: CanvasRenderingContext2D, m: M, col: string, hl: boolean) {
  if (m.trav.down) return;
  for (const sec of m.trav.sectors) {
    const R = hl ? 46 : 26, a0 = sec.c - Math.PI / 2;
    c.fillStyle = col; c.globalAlpha = hl ? 0.22 : 0.08; c.beginPath(); c.moveTo(m.ox, m.oy);
    if (sec.h >= Math.PI - 1e-6) c.arc(m.ox, m.oy, R * 0.6, 0, Math.PI * 2); else c.arc(m.ox, m.oy, R, a0 - sec.h, a0 + sec.h);
    c.closePath(); c.fill(); c.globalAlpha = 1;
  }
}

/** An empty socket: a dashed ring, and for a weapon mount a tick toward its facing. */
function emptyMount(c: CanvasRenderingContext2D, dv: Derived, m: M, th: Theme, px: number, hl: boolean) {
  c.strokeStyle = hl ? '#4fd1e8' : th.edge; c.globalAlpha = hl ? 1 : 0.6; c.lineWidth = px; c.setLineDash([2 * px, 2 * px]);
  c.beginPath(); c.arc(m.ox, m.oy, 4.2, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  if (m.kind === 'W' && facingMatters(positionArc(dv.rects[m.si].type, 'W'))) {
    const a = facingAngle(m.facing); c.beginPath(); c.moveTo(m.ox + Math.sin(a) * 4.2, m.oy - Math.cos(a) * 4.2); c.lineTo(m.ox + Math.sin(a) * 9, m.oy - Math.cos(a) * 9); c.stroke();
  }
  c.globalAlpha = 1;
}

/** A weapon mount turned to its facing: barbette or sponson house, gun house, and its cluster of barrels. */
function drawMount(c: CanvasRenderingContext2D, m: M, col: string, th: Theme, px: number, hl: boolean) {
  const p = m.part!, n = gunCount(p.id, p.tier), edge = hl ? '#4fd1e8' : th.edge;
  c.save(); c.translate(m.ox, m.oy); c.lineWidth = px;
  if (p.id === 'bomb') {
    const nb = p.tier >= 3 ? 2 : 1;
    for (let b = 0; b < nb; b++) { const bx = nb > 1 ? (b ? 1 : -1) * 3.4 : 0; c.fillStyle = '#05070a'; c.fillRect(bx - 2.6, -4, 5.2, 8); c.strokeStyle = col; c.strokeRect(bx - 2.6, -4, 5.2, 8); c.beginPath(); c.moveTo(bx, -4); c.lineTo(bx, 4); c.stroke(); }
    c.restore(); return;
  }
  if (p.id === 'artillery') {
    for (let b = 0; b < n; b++) { const bx = n > 1 ? (b ? 1 : -1) * 4 : 0; c.fillStyle = th.panel; c.strokeStyle = edge; c.beginPath(); c.arc(bx, 0, 3.6, 0, Math.PI * 2); c.fill(); c.stroke(); c.fillStyle = col; c.beginPath(); c.arc(bx, 0, 1.6, 0, Math.PI * 2); c.fill(); }
    c.restore(); return;
  }
  if (p.id === 'tesla') {
    c.fillStyle = th.panel; c.strokeStyle = edge; c.beginPath(); c.arc(0, 0, 4.4, 0, Math.PI * 2); c.fill(); c.stroke();
    c.strokeStyle = col; for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * 1.6, Math.sin(a) * 1.6); c.lineTo(Math.cos(a) * 3.6, Math.sin(a) * 3.6); c.stroke(); }
    c.fillStyle = col; c.beginPath(); c.arc(0, 0, 1.3, 0, Math.PI * 2); c.fill(); c.restore(); return;
  }
  if (p.id === 'pd') {
    for (let i = 0; i < n + 1; i++) { const a = (i / (n + 1)) * Math.PI * 2 + 0.4, x = Math.cos(a) * 3.4, y = Math.sin(a) * 3.4; c.fillStyle = th.panel; c.strokeStyle = edge; c.beginPath(); c.arc(x, y, 1.3, 0, Math.PI * 2); c.fill(); c.stroke(); c.strokeStyle = col; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * 2.2, y + Math.sin(a) * 2.2); c.stroke(); }
    c.restore(); return;
  }
  // Facing: rotate so local -y points along it (canvas rotation is clockwise, like the ship's bearings).
  const side = m.arc === 'broadside' && m.ox !== 0, bow = m.arc === 'bow';
  const R = bow ? 5.6 : side ? 5.4 : 7.2;
  c.fillStyle = th.deck; c.strokeStyle = th.edge; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); c.stroke();
  c.rotate(facingAngle(m.facing));
  const hw = R * 0.62, hf = R * 0.55, ha = R * 0.7;
  c.fillStyle = th.panel; c.strokeStyle = edge;
  c.beginPath(); c.moveTo(-hw * 0.7, -hf); c.lineTo(hw * 0.7, -hf); c.lineTo(hw, -hf * 0.4); c.lineTo(hw, ha); c.lineTo(-hw, ha); c.lineTo(-hw, -hf * 0.4); c.closePath(); c.fill(); c.stroke();
  if (p.id === 'missile') {
    c.fillStyle = col; for (let i = 0; i < n; i++) for (const sy of [-0.25, 0.3]) c.fillRect((i - (n - 1) / 2) * hw * 0.62 - 0.6, sy * R - 0.6, 1.2, 1.2);
    c.restore(); return;
  }
  const barrels = p.id === 'flak' ? 4 : p.id === 'spread' ? 3 : p.id === 'rail' ? Math.max(1, n) : Math.max(2, Math.min(3, n));
  const len = p.id === 'rail' ? 16 : p.id === 'flak' ? 4.5 : p.id === 'spread' ? 5.5 : 7;
  c.strokeStyle = col; c.lineWidth = Math.max(px, p.id === 'rail' ? 0.9 : 0.55);
  for (let b = 0; b < barrels; b++) { const o = (b - (barrels - 1) / 2) * hw * (barrels > 2 ? 0.5 : 0.7); c.beginPath(); c.moveTo(o, -hf); c.lineTo(o, -hf - len); c.stroke(); }
  c.restore();
}
