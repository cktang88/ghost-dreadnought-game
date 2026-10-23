// The refit board: the ship's plan on a blueprint sheet with every mount called out to a socket tile around it,
// like an engineering callout drawing. The guns are tiny at true warship scale, so the tiles are the hand-sized,
// not-to-scale handles: drag parts from the cargo hold (or the quartermaster's counter) onto a socket, between
// sockets to swap, back to the hold to unmount. Click-to-pick then click-to-place and the keyboard do the same.
// Rules and layout math live in refitLogic.ts; every change goes through changeBuild() as before.
import { el, svg } from './h';
import { rankPips } from './cards';
import { icon } from './icons';
import { gauge, legend, segBar } from './kit';
import { guardedSwitch } from './screens/pause';
import {
  SECTIONS, ARC_INFO, FACING_NAMES, FACING_SHORT, LAYERS_TAG, MAX_SECTIONS, RING_MAX, RING_NAMES, TIER, facingAngle, facingMatters, mountArc, mountFacing,
  mountRing, traverseIn, canPlace, partDef, partDesc, partName, partSlot, placementNote, weaponControl, derive, isWeapon,
  type Derived, type Part, type SectionType, type Build, type TargetLayers,
} from '../data/parts';
import { changeBuild, dv, mods, type RunState } from '../game/run';
import { drawBlueprint, planExtent } from '../render/shipPreview';
import { uiSound } from './sound';
import { draggable, dragging, cancelDrag } from './drag';
import {
  layoutBoard, checkMove, applyMove, previewMove, partAt, sameLoc, shipStats, statDeltas, firepower,
  canCutSection, cutSection, previewCut, rotateMount, previewRotate, rotateWhy, ringUpgradeCost, upgradeRing, previewRing,
  arcView, sweep, coverage, quarters, weakestQuarter, FACING_ARROW, BLOCK_NAME, QUARTERS, anchorsFor, planOffset, spotAt, spotBox,
  placeSpots, dropSpot, previewPlacing, placeModule, nudgeSpot, mountCard, shipCard, gapRank,
  type Src, type Dst, type Board, type Check, type ArcView, type Coverage, type Gap, type Placing, type Drop, type MountCard,
} from './refitLogic';

/** A part on the quartermaster's counter (refit opened from the merchant): bought on drop. `buy` puts it in the hold. */
export interface MarketPart { part: Part; price: number; afford: boolean; sold: boolean; buy: () => boolean }
/** A hull module on a work slip: dragged onto a spot on the plan, bought and welded there on drop (a click welds it astern). */
export interface MarketSection { type: SectionType; cost: number; afford: boolean; sold: boolean; buy: () => boolean }
/**
 * Getters, read on every render: a purchase on the board changes what is sold and what the scrap affords. `rings`: turret
 * ring refits may be bought here (default: when a counter came along, i.e. at a merchant's yard).
 */
export interface RefitExtras { market?: () => MarketPart[]; sections?: () => MarketSection[]; rings?: boolean }

/** Where a mount sits, in words: "Bow", "Port battery", "Top deck · stbd", "Engine bay". */
function mountName(type: SectionType, i: number) {
  const n = SECTIONS[type].slots.length;
  if (type === 'bridge') return 'Bow mount';
  if (type === 'battery') return ['Port battery', 'Battery centre', 'Starboard battery'][i];
  if (type === 'gundeck') return `Top deck · ${i ? 'aft' : 'fwd'}`;
  const short = { armor: 'Armor', spine: 'Spine', engine: 'Engine' }[type as 'armor'] ?? SECTIONS[type].name;
  return n > 1 ? `${short} bay · ${i ? 'stbd' : 'port'}` : `${short} bay`;
}
const key = (d: Dst | Src) => (d.k === 'slot' ? `slot:${d.si}:${d.i}` : d.k === 'inv' ? `inv:${d.i}` : d.k === 'market' ? `mkt:${d.i}` : 'hold');
const parseDrop = (s: string | undefined): Dst | null => {
  if (!s) return null;
  if (s === 'hold') return { k: 'hold' };
  const m = /^slot:(\d+):(\d+)$/.exec(s);
  return m ? { k: 'slot', si: +m[1], i: +m[2] } : null;
};
const layoutFor = (w: number, h: number, d: Derived) => layoutBoard({ w, h, len: d.len, width: d.width, anchors: anchorsFor(d), ...planExtent(d) });
const ROMAN = ['', 'I', 'II', 'III'];
const LAYER_WORD: Record<TargetLayers, string> = { air: 'Air', ground: 'Ground', both: 'Air + gnd', shots: 'Enemy fire', none: '—' };
const deg = (a: number) => Math.round((a * 180) / Math.PI);
/** "FS ↗": a mount's facing as the tile reads it. */
const faceText = (f: number) => `${FACING_SHORT[f]}${FACING_ARROW[f]}`;
const blockNames = (av: ArcView) => [...new Set(av.blocked.map((b) => BLOCK_NAME[b.by] ?? b.by.toUpperCase()))];

/** Wedge path for a traverse sector at (x, y): ship angle 0 = bow (up the screen), +PI/2 = starboard (right). r0 > 0 makes a ring sector. */
function wedge(x: number, y: number, r: number, c: number, h: number, r0 = 0) {
  if (h >= Math.PI - 1e-6) return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  const p = (a: number, rr: number) => `${(x + Math.sin(a) * rr).toFixed(1)} ${(y - Math.cos(a) * rr).toFixed(1)}`, big = h * 2 > Math.PI ? 1 : 0;
  if (r0 > 0) return `M${p(c - h, r0)}L${p(c - h, r)}A${r} ${r} 0 ${big} 1 ${p(c + h, r)}L${p(c + h, r0)}A${r0} ${r0} 0 ${big} 0 ${p(c - h, r0)}Z`;
  return `M${x} ${y}L${p(c - h, r)}A${r} ${r} 0 ${big} 1 ${p(c + h, r)}Z`;
}
/** Hatching for blocked wedges (the lines svg is rebuilt every paint, so it carries its own defs). */
const hatchDefs = () => svg('defs', {}, svg('pattern', { id: 'rf-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
  svg('rect', { width: 5, height: 5, fill: 'rgba(255,90,70,.10)' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: 'rgba(255,110,90,.75)', 'stroke-width': 1.4 })));

/** Where to rotate a weapon to cover a quarter, in words. */
const QUARTER_HINT: Record<Gap['key'], string> = {
  fore: 'Face a turret forward of the bridge tower, or angle a sponson fore.',
  stbd: 'Turn a sponson or a turret to starboard.',
  aft: 'Angle a sponson aft, or put a turret abaft the funnels facing astern.',
  port: 'Turn a sponson or a turret to port.',
};
/**
 * The coverage rose: rated dmg/s bearing on each bearing around a ship glyph (air in plasma, ground in amber), the
 * weakest quarter hatched. `prev` is a previewed fit, outlined over the current one.
 */
function rose(cov: Coverage, prev: Coverage | null, gap: Gap) {
  const R = 62, r0 = 16, n = cov.n, d = (Math.PI * 2) / n;
  const vmax = Math.max(40, ...cov.air, ...cov.ground, ...(prev ? [...prev.air, ...prev.ground] : []));
  const rad = (v: number) => r0 + (R - r0) * Math.max(0, v) / vmax;
  const pt = (a: number, r: number) => `${(Math.sin(a) * r).toFixed(1)} ${(-Math.cos(a) * r).toFixed(1)}`;
  const petal = (vs: number[]) => { let s = ''; for (let k = 0; k < n; k++) { const a = k * d; s += `${k ? 'L' : 'M'}${pt(a - d / 2, rad(vs[k]))}L${pt(a + d / 2, rad(vs[k]))}`; } return s + 'Z'; };
  const g = svg('svg', { class: 'rose', viewBox: '-74 -74 148 148', role: 'img', 'aria-label': `Coverage rose: ${gap.label.toLowerCase()}` },
    hatchDefs(),
    ...[0.5, 1].map((k) => svg('circle', { class: 'rr', r: r0 + (R - r0) * k })),
    ...[1, 3, 5, 7].map((k) => svg('line', { class: 'rx', x1: Math.sin((k * Math.PI) / 4) * r0, y1: -Math.cos((k * Math.PI) / 4) * r0, x2: Math.sin((k * Math.PI) / 4) * (R + 4), y2: -Math.cos((k * Math.PI) / 4) * (R + 4) })),
    svg('path', { class: 'rp gnd', d: petal(cov.ground) }), svg('path', { class: 'rp air', d: petal(cov.air) }),
    prev ? svg('path', { class: 'rp prev gnd', d: petal(prev.ground) }) : null, prev ? svg('path', { class: 'rp prev air', d: petal(prev.air) }) : null,
    svg('path', { class: `rq ${gap.severity}`, d: wedge(0, 0, R + 4, gap.c, gap.h, r0) }),
    // The ship, bow up: a long pointed hull.
    svg('path', { class: 'rship', d: 'M0 -14L3.4 -7L3.4 10L2 13L-2 13L-3.4 10L-3.4 -7Z' }),
  );
  for (const [t, x, y] of [['F', 0, -R - 5], ['S', R + 6, 3.5], ['A', 0, R + 11], ['P', -R - 6, 3.5]] as const) {
    const tx = svg('text', { x, y, 'text-anchor': 'middle', class: 'rl' }); tx.textContent = t; g.append(tx);
  }
  return g;
}

/** Ship refit board: sockets called out around the ship's plan, a cargo hold, hull sections and the ship's particulars. */
export function refitPanel(run: RunState, onChange: () => void, extras: RefitExtras = {}) {
  /** Picked part (click, keyboard or drag) and the target it is over. */
  let pick: Src | null = null, over: Dst | null = null, dragKind: 'part' | 'sec' | null = null;
  let secOver: number | null = null, secHl: number | null = null, cutArm: number | null = null;
  let hl: { si: number; i: number } | null = null, toast = '', fresh: string | null = null, focusKey: string | null = null;
  /** A rotate button under the pointer: the board previews the turn. `hlBoard`: hl came from the plan, not a tile. */
  let rotHover: { si: number; i: number; dir: 1 | -1 } | null = null, hlBoard = false;
  /** A ring refit button under the pointer (previewed). */
  let ringHover: { si: number; i: number } | null = null;
  /**
   * A module being placed on the plan: which one, where it would land (snapped to a legal spot near the pointer, or
   * refused with the reason), the legal spots, and the plan frame it started in (the plan holds still while it moves).
   */
  let place: { p: Placing; drop: Drop | null; spots: [number, number][]; off: [number, number]; onPlan: boolean; buy?: MarketSection } | null = null;
  /** Part tile under the pointer (hold or counter), for the readout. */
  let hoverPart: Part | null = null;
  let L: Board | null = null;

  const root = el('div', 'refit2');
  const holdEl = el('div', { class: 'rf-hold', 'data-drop': 'hold' });
  const secsEl = el('div', 'rf-secs');
  const boardEl = el('div', { class: 'board', role: 'group', 'aria-label': 'Ship plan with mount sockets' });
  const canvas = el('canvas', { class: 'board-bp', 'aria-hidden': 'true' });
  const lines = svg('svg', { class: 'board-lines', 'aria-hidden': 'true' });
  const tilesEl = el('div', 'board-tiles');
  boardEl.append(canvas, lines, tilesEl);
  const strip = el('div', 'board-strip', el('span', null, 'Plan view · bow up ▲'), el('span', 'bs-mid', 'Callouts not to scale · R / wheel rotates a mount'), el('span', 'bs-len'));
  const statsEl = el('div', 'rf-stats');
  const readEl = el('div', { class: 'rf-read crt', 'aria-live': 'polite' });
  const cmpEl = el('div', { class: 'rf-cmp', 'aria-live': 'polite', hidden: true });
  const toastEl = el('div', { class: 'toast rf-toast', role: 'status' });
  const left = el('aside', 'rf-col rf-left');
  const right = el('aside', 'rf-col rf-right', legend('Ship’s particulars', 'live'), cmpEl, statsEl, readEl, toastEl);
  root.append(left, el('div', 'rf-board-wrap', strip, boardEl), right);

  const picked = () => (pick ? partAt(run.build, run.inv, pick) : null);
  const check = (d: Dst): Check | null => (pick ? checkMove(run.build, run.inv, pick, d) : null);
  const preview = (): Build | null => {
    if (dragKind === 'sec' && place) {
      if (secOver === -1 && place.p.si >= 0) return previewCut(run.build, place.p.si);
      return place.drop?.ok && place.onPlan ? previewPlacing(run.build, place.p, place.drop.at) : null;
    }
    if (cutArm != null) return previewCut(run.build, cutArm);
    if (rotHover && !pick) return previewRotate(run.build, rotHover.si, rotHover.i, rotHover.dir);
    if (ringHover && !pick) return previewRing(run.build, ringHover.si, ringHover.i);
    return pick && over ? previewMove(run.build, run.inv, pick, over) : null;
  };

  /* ---------------- the board ---------------- */
  /** A socket: the tile (drop target, drag handle) and beside it, for weapon mounts, the rotate strip ⟳ facing ⟲. */
  const tileFor = (si: number, i: number, d: Derived) => {
    const s = run.build.sections[si], type = s.type, kind = SECTIONS[type].slots[i], p = s.slots[i];
    const dst: Dst = { k: 'slot', si, i }, k = key(dst);
    const arc = kind === 'U' ? 'internal' : mountArc(type, kind, p?.id);
    const wrap = el('div', { class: `mslot ${kind === 'W' ? 'w' : 'u'}`, 'data-mslot': `${si}-${i}`, 'data-drop': k });
    const t = el('button', {
      class: `mtile ${kind === 'W' ? 'w' : 'u'} ${p ? 'full' : 'empty'}`, 'data-drop': k, 'data-key': k, 'data-slot': `${si}-${i}`,
      style: `--arc:${ARC_INFO[arc].col}`, 'aria-label': `${mountName(type, i)}: ${p ? partName(p) : 'empty'}${kind === 'W' && facingMatters(arc) ? `, facing ${FACING_NAMES[mountFacing(s, i)]}` : ''}`,
    });
    const reach = kind === 'W' ? (p ? traverseIn(d, si, i, p.id) : traverseIn(d, si, i, 'pulse')) : null;
    t.append(
      el('span', 'mt-n', String(L?.tiles.find((x) => x.id === `${si}-${i}`)?.n ?? '').padStart(2, '0')),
      el('span', 'mt-well', p ? icon(p.id) : el('i', null, kind)),
      el('span', 'mt-txt',
        el('b', 'mt-nm', p ? partDef(p.id).name : kind === 'W' ? 'Weapon mount' : 'Utility bay'),
        el('span', 'mt-sub', el('span', 'mt-pos', mountName(type, i)), p ? rankPips(p.tier) : null),
        el('span', 'mt-say')),
      el('span', 'mt-tags', kind === 'W' ? null : el('em', 'arc-tag', ARC_INFO[arc].short), reach ? el('em', `reach-tag ${reach.layers}`, LAYERS_TAG[reach.layers]) : null,
        p && isWeapon(p.id) ? el('em', { class: 'rng-tag', title: 'Reach (field units)' }, `⌖${d.mounts.find((m) => m.si === si && m.i === i)?.range ?? 0}`) : null),
    );
    t.addEventListener('click', () => clickSlot(si, i));
    t.addEventListener('keydown', (e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && p) { e.preventDefault(); move({ k: 'slot', si, i }, { k: 'hold' }); } });
    const enter = () => { hl = { si, i }; hlBoard = false; if (pick) over = dst; paintLive(); };
    const leave = () => { if (hl && hl.si === si && hl.i === i) hl = null; if (over && sameLoc(over, dst)) over = null; rotHover = null; ringHover = null; paintLive(); };
    wrap.addEventListener('pointerenter', () => { if (!dragging()) enter(); });
    wrap.addEventListener('pointerleave', () => { if (!dragging()) leave(); });
    t.addEventListener('focus', enter); t.addEventListener('blur', leave);
    if (p) draggable(t, () => partDrag({ k: 'slot', si, i }));
    wrap.append(t);
    if (kind !== 'W') return wrap;
    // Rotate strip: every weapon mount has one; it is switched off (with the reason) where facing does not matter.
    const why = rotateWhy(run.build, si, i), f = mountFacing(s, i);
    const rb = (dir: 1 | -1) => {
      const b = el('button', {
        class: `rot ${dir > 0 ? 'rot-cw' : 'rot-ccw'}`, 'data-key': `rot:${si}:${i}:${dir}`, 'aria-disabled': why ? 'true' : null,
        'aria-label': `Rotate ${mountName(type, i)} ${dir > 0 ? 'clockwise' : 'anticlockwise'}`, title: why ?? `Rotate ${dir > 0 ? 'clockwise (R)' : 'anticlockwise (Shift+R)'}`,
      }, dir > 0 ? '⟳' : '⟲');
      b.addEventListener('click', (e) => { e.stopPropagation(); rotate(si, i, dir, `rot:${si}:${i}:${dir}`); });
      const on = () => { hl = { si, i }; hlBoard = false; rotHover = why || pick ? null : { si, i, dir }; paintLive(); };
      b.addEventListener('pointerenter', () => { if (!dragging()) on(); });
      b.addEventListener('pointerleave', () => { if (!dragging() && rotHover) { rotHover = null; paintLive(); } });
      b.addEventListener('focus', on); b.addEventListener('blur', () => { rotHover = null; paintLive(); });
      return b;
    };
    wrap.classList.add('has-rot');
    const lv = mountRing(s, i);
    wrap.append(el('span', { class: `mt-rot${why ? ' off' : ''}`, title: why ?? `Facing ${FACING_NAMES[f]} · ${RING_NAMES[lv]}` },
      rb(1), el('b', 'mt-face', why ? (arc === 'ventral' ? '▼' : '◎') : faceText(f), el('span', { class: 'ring-pips', 'aria-label': RING_NAMES[lv] }, ...[1, 2, 3].map((k) => el('i', k <= lv ? 'on' : null)))), rb(-1)));
    // Turret ring refit: shown on the hovered or focused socket; hovering it previews the wider arc and the compare card.
    const cost = ringUpgradeCost(run.build, si, i), shopWhy = ringWhy(cost);
    const chip = el('button', {
      class: `ring-chip${cost == null ? ' max' : ''}${shopWhy ? ' off' : ''}`, 'data-key': `ring:${si}:${i}`, 'aria-disabled': shopWhy ? 'true' : null,
      title: shopWhy ?? `Fit a ${RING_NAMES[lv + 1].toLowerCase()}: wider arc (U)`, 'aria-label': cost == null ? `${RING_NAMES[lv]} fitted` : `Fit turret ring ${ROMAN[lv + 1]} for ${cost} scrap`,
    }, cost == null ? `RING ${ROMAN[lv]} · MAX` : `RING ${ROMAN[lv + 1]} · ${cost}¤`);
    chip.addEventListener('click', (e) => { e.stopPropagation(); buyRing(si, i, `ring:${si}:${i}`); });
    const ron = () => { hl = { si, i }; hlBoard = false; ringHover = cost == null || pick ? null : { si, i }; paintLive(); };
    chip.addEventListener('pointerenter', () => { if (!dragging()) ron(); });
    chip.addEventListener('pointerleave', () => { if (!dragging() && ringHover) { ringHover = null; paintLive(); } });
    chip.addEventListener('focus', ron); chip.addEventListener('blur', () => { ringHover = null; paintLive(); });
    wrap.append(chip);
    return wrap;
  };

  const paintBoard = () => {
    const w = boardEl.clientWidth; if (!w) return;
    const d = dv(run);
    const stacked = w < 640;
    if (!stacked) boardEl.style.height = '';
    const h = boardEl.clientHeight;
    L = layoutFor(w, h, d);
    if (L.mode === 'stacked') boardEl.style.height = `${Math.ceil(L.h)}px`;
    boardEl.classList.toggle('stacked', L.mode === 'stacked');
    boardEl.classList.toggle('compact', L.compact);
    strip.querySelector('.bs-len')!.textContent = `LOA ${Math.round(d.len * 1.6)} m · ${run.build.sections.length} frames`;
    const k = Math.min(2, window.devicePixelRatio || 1), ch = L.mode === 'stacked' ? L.tiles[0] ? L.tiles[0].y - 12 : L.h : L.h;
    canvas.width = Math.round(w * k); canvas.height = Math.round(ch * k);
    canvas.style.width = `${w}px`; canvas.style.height = `${ch}px`;
    lines.setAttribute('viewBox', `0 0 ${w} ${L.h}`); lines.setAttribute('width', String(w)); lines.setAttribute('height', String(L.h));
    tilesEl.replaceChildren(...L.tiles.map((tp) => {
      const [si, i] = tp.id.split('-').map(Number);
      const t = tileFor(si, i, d);
      Object.assign(t.style, { left: `${tp.x}px`, top: `${tp.y}px`, width: `${tp.w}px`, height: `${tp.h}px` });
      t.classList.add(`side-${tp.side}`);
      if (fresh === `slot:${si}:${i}`) t.firstElementChild!.classList.add('clunk');
      return t;
    }));
    paintLive();
    if (fresh) { const f = fresh; setTimeout(() => { if (fresh === f) fresh = null; }, 700); }
    if (focusKey) { (tilesEl.querySelector(`[data-key="${focusKey}"]`) as HTMLElement | null)?.focus({ preventScroll: true }); focusKey = null; }
  };

  /* ---------------- arcs on the plan ---------------- */
  /**
   * Range scale (board px per field unit): true reach would cover the whole sheet, so every fan is drawn to one common
   * scale (the strip shows it), the hovered mount's at full reach, the others at a fraction so they stay by their guns.
   */
  const rangeK = () => (L ? Math.min(L.w, L.h) * 0.36 / 1000 : 0.2);
  const fanR = (range: number, hot: boolean) => Math.max(hot ? 26 : 12, range * rangeK() * (hot ? 1 : 0.42));
  /**
   * One mount's arc on the plan: the open sectors as a translucent fan, the bearings the hull blocks hatched red and,
   * when hot, labelled by what blocks them, a facing pointer and the arc's name. `was`: the arc before a previewed turn.
   */
  const arcSvg = (x: number, y: number, av: ArcView, r: number, hot: boolean, was: ArcView | null = null) => {
    const col = ARC_INFO[av.arc].col, g = svg('g', { class: `arc-w${hot ? ' hot' : ''}${av.down ? ' down' : ''}`, style: `--arc:${col}` });
    if (av.down) { for (const rr of hot ? [0.33, 0.66, 1] : [0.5, 1]) g.append(svg('circle', { cx: x, cy: y, r: r * rr })); }
    else {
      if (was) for (const s of was.open) g.append(svg('path', { class: 'was', d: wedge(x, y, r, s.c, s.h) }));
      for (const s of av.open) g.append(svg('path', { d: wedge(x, y, r, s.c, s.h) }));
      for (const b of av.blocked) g.append(svg('path', { class: 'blk', d: wedge(x, y, r, b.c, b.h) }));
    }
    if (!hot) return g;
    // Reach: a dashed range ring and the number where the ring crosses the facing (ventral: its ground reach, up top).
    // At the clockwise edge of the widest open sector, clear of the facing pointer and the arc's name.
    const wo = av.open.reduce((b, q) => (q.h > b.h ? q : b), { c: 0.7, h: 0 }), ra = facingMatters(av.arc) && wo.h > 0 && wo.h < Math.PI - 0.01 ? wo.c + wo.h - 0.1 : 0.7;
    g.append(svg('circle', { class: 'rng', cx: x, cy: y, r }));
    const rt = svg('text', { class: 'rng-lbl', x: x + Math.sin(ra) * (r + 14), y: y - Math.cos(ra) * (r + 14) + 3, 'text-anchor': 'middle' });
    rt.textContent = `${av.range}`; g.append(rt);
    if (!av.down) for (const b of av.blocked) {
      if (b.h < 0.05) continue;
      const rr = b.h < 0.16 ? r + 12 : r * 0.68, tx = svg('text', { x: x + Math.sin(b.c) * rr, y: y - Math.cos(b.c) * rr + 3, 'text-anchor': 'middle', class: 'blk-lbl' });
      tx.textContent = BLOCK_NAME[b.by] ?? b.by.toUpperCase(); g.append(tx);
    }
    // Name the arc inside the fan: "FS · 214° · AIR" (ventral and all-round arcs below the mount).
    const tx = svg('text', { 'text-anchor': 'middle', class: 'arc-lbl' });
    if (facingMatters(av.arc)) {
      const a = facingAngle(av.facing), ex = x + Math.sin(a) * (r + 6), ey = y - Math.cos(a) * (r + 6);
      g.append(svg('line', { class: 'face-ptr', x1: x, y1: y, x2: ex, y2: ey }), svg('circle', { class: 'face-tip', cx: ex, cy: ey, r: 2.5 }));
      // In the widest open sector (the facing itself may be the blocked part).
      const o = av.open.reduce((b, s) => (s.h > b.h ? s : b), { c: a, h: 0 }), la = o.h > 0.3 ? o.c : a;
      tx.setAttribute('x', String(x + Math.sin(la) * r * 0.6)); tx.setAttribute('y', String(y - Math.cos(la) * r * 0.6 + 3));
      tx.textContent = `${FACING_SHORT[av.facing]} · ${deg(sweep(av.open))}° · ${LAYERS_TAG[av.layers]}`;
    } else {
      tx.setAttribute('x', String(x)); tx.setAttribute('y', String(Math.min(L!.h - 4, y + r * (av.down ? 0.85 : 0.6) + 14)));
      tx.textContent = `${ARC_INFO[av.arc].short} · ${LAYERS_TAG[av.layers] || 'BAY'}`;
    }
    g.append(tx);
    return g;
  };

  /** Everything that follows the pointer without a rebuild: candidate states, leaders, arcs, ship preview, stats, readout. */
  const paintLive = () => {
    if (!L) return;
    const d = dv(run), nb = preview(), nd = nb ? derive(nb, mods(run)) : null;
    const p = picked();
    // Sockets: candidates light up with what the part would do there; the rest dim with the reason.
    for (const t of tilesEl.querySelectorAll<HTMLElement>('.mtile')) {
      const dst = parseDrop(t.dataset.drop)!;
      const c = dragKind === 'sec' ? null : check(dst);
      t.classList.toggle('cand', !!c?.ok); t.classList.toggle('nope', !!c && !c.ok && c.why !== 'same'); t.classList.toggle('self', c?.why === 'same');
      t.classList.toggle('over', !!over && sameLoc(over, dst));
      t.parentElement!.classList.toggle('hot', !!hl && dst.k === 'slot' && hl.si === dst.si && hl.i === dst.i);
      const say = t.querySelector('.mt-say')!, tags = t.querySelector('.mt-tags')!;
      t.querySelectorAll('.cand-tag').forEach((x) => x.remove());
      if (c && p && dst.k === 'slot') {
        if (c.ok) {
          const tr = traverseIn(d, dst.si, dst.i, p.id);
          tags.prepend(el('em', { class: 'cand-tag arc-tag', style: `color:${ARC_INFO[tr.arc].col}` }, ARC_INFO[tr.arc].short));
          if (isWeapon(p.id)) tags.append(el('em', `cand-tag reach-tag ${tr.layers}`, LAYERS_TAG[tr.layers] || '—'));
          const pv = previewMove(run.build, run.inv, pick!, dst), dl = pv ? statDeltas(d, derive(pv, mods(run))) : {};
          const top = Object.entries(dl).filter(([k]) => k !== 'mass').slice(0, 2).map(([k, v]) => `${v.d > 0 ? '+' : '−'}${Math.abs(v.d)} ${({ air: 'AIR', ground: 'GND', hull: 'HULL', speed: 'SPD', fire: 'ROF', shield: 'SHLD', regen: 'RPR', drones: 'DRN', pd: 'PD', thrust: 'THR' } as Record<string, string>)[k] ?? k}`);
          say.textContent = top.join(' ') || (c.out ? 'Swap, no change' : 'Fits');
        } else say.textContent = c.why === 'kind' ? (SECTIONS[run.build.sections[dst.si].type].slots[dst.i] === 'W' ? 'Weapons only' : 'Fittings only') : c.why === 'scrap' ? 'Short of scrap' : c.why === 'same' ? 'Picked up' : '';
        t.title = c.reason ?? '';
      } else { say.textContent = ''; t.title = ''; }
    }
    // The hold takes anything coming off a mount.
    const hc = pick && dragKind !== 'sec' ? checkMove(run.build, run.inv, pick, { k: 'hold' }) : null;
    holdEl.classList.toggle('cand', !!hc?.ok); holdEl.classList.toggle('over', !!over && over.k === 'hold');
    root.classList.toggle('picking', !!pick); root.classList.toggle('sec-drag', dragKind === 'sec');

    // Leader lines, mount rings, and the firing arcs: every gun's faintly, the hovered or targeted one strongly.
    const show = nd ?? d;
    const kids: SVGElement[] = [hatchDefs()];
    const tgt = over?.k === 'slot' ? `${over.si}-${over.i}` : hl ? `${hl.si}-${hl.i}` : null;
    const faint: SVGElement[] = [], strong: SVGElement[] = [];
    const arcFor = (si: number, i: number, cand: boolean, hot: boolean) => {
      const av = arcView(show, si, i, cand && p ? p.id : undefined); if (!av || (!av.open.length && !av.blocked.length)) return;
      const was = hot && rotHover && rotHover.si === si && rotHover.i === i ? arcView(d, si, i) : null;
      const an = L!.anchors[`${si}-${i}`]; if (!an) return; // a cut or reordered preview: drawn below at its own layout
      const [x, y] = an;
      (hot ? strong : faint).push(arcSvg(x, y, av, fanR(av.range, hot), hot, was));
    };
    if (p && dragKind !== 'sec') { for (const t of L.tiles) { const [si, i] = t.id.split('-').map(Number); if (check({ k: 'slot', si, i })?.ok && t.id !== tgt) arcFor(si, i, true, false); } }
    else for (const m of show.mounts) if (m.part && isWeapon(m.part.id) && facingMatters(m.arc) && `${m.si}-${m.i}` !== tgt) arcFor(m.si, m.i, false, false);
    if (tgt) { const [si, i] = tgt.split('-').map(Number); const ok = !p || check({ k: 'slot', si, i })?.ok; if (ok && SECTIONS[run.build.sections[si].type].slots[i] === 'W') arcFor(si, i, !!p, true); }
    kids.push(...faint);
    for (const l of L.leaders) {
      const on = l.id === tgt, [si, i] = l.id.split('-').map(Number);
      const c = p && dragKind !== 'sec' ? check({ k: 'slot', si, i }) : null;
      kids.push(svg('polyline', { class: `lead${on ? ' on' : ''}${c?.ok ? ' cand' : c && c.why !== 'same' ? ' nope' : ''}${fresh === `slot:${si}:${i}` ? ' clunk' : ''}`, points: l.pts.map((q) => q.join(',')).join(' ') }));
    }
    kids.push(...strong);
    for (const t of L.tiles) {
      const [x, y] = L.anchors[t.id], on = t.id === tgt;
      kids.push(svg('circle', { class: `ring${on ? ' on' : ''}${fresh === `slot:${t.id.replace('-', ':')}` ? ' clunk' : ''}`, cx: x, cy: y, r: on ? 6 : 3.5 }));
      if (L.mode === 'stacked') kids.push(svg('g', { class: 'balloon' + (on ? ' on' : '') }, svg('circle', { cx: x + 10, cy: y - 10, r: 8 }), svg('text', { x: x + 10, y: y - 6.5, 'text-anchor': 'middle' })));
    }
    lines.replaceChildren(...kids);
    if (L.mode === 'stacked') lines.querySelectorAll('.balloon text').forEach((tx, k) => { tx.textContent = String(L!.tiles[k].n); });
    // The plan itself redraws with the previewed fit (same hull, so the callouts stay put).
    const k = canvas.width / Math.max(1, L.w), sameHull = !nb || nb.sections.length === run.build.sections.length && nb.sections.every((s, si) => s.type === run.build.sections[si].type);
    boardEl.classList.toggle('reshaping', !sameHull || !!place);
    boardEl.classList.toggle('placing', !!place);
    if (place && secOver !== -1) paintPlacing(show, nb, k);
    else if (sameHull) drawBlueprint(canvas, show, false, tgt ? { si: +tgt.split('-')[0], i: +tgt.split('-')[1] } : null, { fit: { ...L.ship, k }, section: secHl, arcs: false });
    else {
      // A cut hull: draw the new plan at its own fit with every gun's arc as it would be, and fade the callouts.
      const nL = layoutFor(L.w, L.h, nd!), out: SVGElement[] = [hatchDefs()];
      drawBlueprint(canvas, nd!, false, null, { fit: { ...nL.ship, k }, arcs: false });
      for (const m of nd!.mounts) if (m.part && isWeapon(m.part.id) && facingMatters(m.arc)) { const av = arcView(nd!, m.si, m.i)!, [x, y] = nL.anchors[`${m.si}-${m.i}`]; out.push(arcSvg(x, y, av, fanR(av.range, false) * 1.3, false)); }
      lines.replaceChildren(...out);
    }
    paintStats(d, nd);
    paintCompare(d, nd);
    paintRead(d);
  };

  /**
   * Placing a module: the plan holds still in the frame the drag started in (so the pointer and the grid agree), every
   * legal spot shows as a ghost outline, the spot under the pointer is lit (or red, with the reason), and the ship is
   * drawn as it would be with every gun's arc from its new place.
   */
  const paintPlacing = (show: Derived, nb: Build | null, k: number) => {
    const P = place!, Lb = L!, s = Lb.ship.s, offN = planOffset(nb ?? run.build, show);
    const dx = (offN[0] - P.off[0]) * s, dy = (offN[1] - P.off[1]) * s, fit = { cx: Lb.ship.cx + dx, cy: Lb.ship.cy + dy, s, k };
    const moving = P.p.si >= 0 ? P.p.si : nb ? nb.sections.length - 1 : null;
    drawBlueprint(canvas, show, false, null, { fit, section: nb ? moving : P.p.si >= 0 ? P.p.si : null, arcs: false });
    const out: SVGElement[] = [hatchDefs()];
    const bx = (at: [number, number]) => { const b = spotBox(P.p.type, at, P.off); return { x: Lb.ship.cx + b.x * s, y: Lb.ship.cy + b.y * s, w: b.w * s, h: b.h * s }; };
    for (const at of P.spots) { const r = bx(at); out.push(svg('rect', { class: 'spot', x: r.x, y: r.y, width: r.w, height: r.h })); }
    for (const m of show.mounts) if (m.part && isWeapon(m.part.id) && facingMatters(m.arc)) {
      const av = arcView(show, m.si, m.i)!; out.push(arcSvg(fit.cx + m.ox * s, fit.cy + m.oy * s, av, fanR(av.range, false) * 1.3, false));
    }
    if (P.drop && P.onPlan) {
      const r = bx(P.drop.at), g = svg('g', { class: `spot-on${P.drop.ok ? '' : ' bad'}` }, svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h }));
      const tx = svg('text', { x: r.x + r.w / 2, y: r.y - 6, 'text-anchor': 'middle' });
      tx.textContent = P.drop.ok ? `${SECTIONS[P.p.type].name.toUpperCase()} · ${P.drop.at[0]}, ${P.drop.at[1]}` : (P.drop.why ?? '').toUpperCase();
      g.append(tx); out.push(g);
    }
    lines.replaceChildren(...out);
  };

  /* ---------------- particulars ---------------- */
  const paintStats = (d: Derived, nd: Derived | null) => {
    const dl = nd ? statDeltas(d, nd) : {};
    const st = shipStats(d), by = Object.fromEntries(st.map((s) => [s.key, s]));
    const chip = (k: string) => dl[k] ? el('span', `dchip ${dl[k].good ? 'up' : 'down'}`, `${dl[k].d > 0 ? '▲ +' : '▼ −'}${Math.abs(dl[k].d)}`) : null;
    const f = firepower(d), fa = nd ? firepower(nd) : f;
    const row = (k: string) => el('div', 'rf-row' + (dl[k] ? ' moved' : ''), el('span', 'plate-k', by[k].label), el('b', 'mono', by[k].text), chip(k));
    const fire = (k: 'air' | 'ground', label: string) => el('div', 'rf-fire' + (dl[k] ? ' moved' : ''),
      el('span', 'plate-k', label), segBar(Math.min(1, (nd ? fa[k] : f[k]) / 240), 16, k === 'air' ? 'air' : 'gnd'), el('b', 'mono', String(Math.round(f[k]))), chip(k));
    const warn = f.air === 0 ? 'No anti-air weapons mounted. Aircraft will be untouchable.' : f.ground === 0 ? 'Nothing can reach the ground: top-deck turrets only engage aircraft. Mount a gun on the bow or a broadside, or a bomb bay.' : '';
    const kids: Node[] = [
      el('div', 'gauges', gauge(d.maxHp / 450, 'Hull', `${Math.ceil(run.hp)}/${d.maxHp}`, { memo: 'rf-hull' }), gauge((d.speed - 120) / 260, 'Speed', String(Math.round(d.speed)), { memo: 'rf-speed', red: true }),
        gauge((d.fireMult - 0.8) / 1.2, 'Fire rate', `${Math.round(d.fireMult * 100)}%`, { memo: 'rf-fire' }), gauge(d.shieldMax / 200, 'Shield', d.shieldMax ? String(d.shieldMax) : 'none', { memo: 'rf-shield' })),
      el('div', 'rf-deltas', ...['hull', 'speed', 'fire', 'shield'].map((k) => el('span', null, chip(k)))),
      el('div', 'rf-firebank', el('div', 'rf-sub', 'Rated fire · dmg/s by target layer'), fire('air', 'Anti-air'), fire('ground', 'Anti-ground')),
      coverageBank(d, nd),
      el('div', 'rf-rows', ...['mass', 'thrust', 'pd', 'regen', 'drones'].map(row)),
    ];
    if (warn) kids.push(el('p', 'fatal hazard-plate', warn));
    // Gauges are rebuilt only when the committed fit changes, so the needles swing once per refit, not per hover.
    const sig = st.map((s) => s.v).join(',') + `|${Math.ceil(run.hp)}`;
    if (statsEl.dataset.sig !== sig) { statsEl.dataset.sig = sig; statsEl.replaceChildren(...kids); }
    else { kids[0] = statsEl.querySelector('.gauges') ?? kids[0]; statsEl.replaceChildren(...kids); }
  };
  /** Coverage: the rose, the four quarters' mean dmg/s, and the weakest quarter called out (previewed fit if any). */
  const coverageBank = (d: Derived, nd: Derived | null) => {
    const cov = coverage(d), pc = nd ? coverage(nd) : null, show = pc ?? cov, gap = weakestQuarter(show), qs = quarters(show), q0 = quarters(cov);
    const n = (v: number) => String(Math.round(v));
    return el('div', 'rf-rose',
      el('div', 'rf-sub', 'Coverage · dmg/s bearing by quarter'),
      el('div', 'rose-body', rose(cov, pc, gap),
        el('div', 'rose-side',
          el('div', 'rq-rows', el('span', 'rq-h'), el('span', 'rq-h air', 'AIR'), el('span', 'rq-h gnd', 'GND'),
            ...qs.flatMap((q, k) => [el('span', `rq-k${q.key === gap.key ? ` weak ${gap.severity}` : ''}`, q.short),
              el('b', `air${Math.round(q.air) !== Math.round(q0[k].air) ? ' moved' : ''}`, n(q.air)), el('b', `gnd${Math.round(q.ground) !== Math.round(q0[k].ground) ? ' moved' : ''}`, n(q.ground))])),
          el('div', `rose-gap ${gap.severity}`, el('b', null, gap.label),
            el('span', null, gap.severity === 'thin' ? 'Every bearing is covered.' : `${deg(gap.h * 2)}° with ${gap.severity === 'blind' ? 'nothing bearing' : gap.label.startsWith('NO AA') ? 'no anti-air' : 'no ground fire'}. ${QUARTER_HINT[gap.key]}`)))));
  };
  /**
   * The compare card: current vs new, side by side, for whatever is being tried (a part over a socket, a rotation, a
   * ring refit, a module on a new spot): the mount's own numbers, then the ship's totals, each with its change.
   */
  const paintCompare = (d: Derived, nd: Derived | null) => {
    const p = picked();
    const mnt = p && over?.k === 'slot' && check(over)?.ok ? { si: over.si, i: over.i } : rotHover && !pick ? rotHover : ringHover && !pick ? ringHover : null;
    const P = place;
    if (!nd && !(P && P.drop && P.onPlan)) { cmpEl.hidden = true; cmpEl.replaceChildren(); return; }
    const title = P ? `${P.buy ? 'Weld new' : 'Move'} ${SECTIONS[P.p.type].name}` : ringHover && mnt === ringHover ? `Turret ring refit · ${ringUpgradeCost(run.build, mnt.si, mnt.i)} scrap`
      : rotHover && mnt === rotHover ? `Rotate ${mountName(run.build.sections[mnt.si].type, mnt.i)}` : mnt ? `${p ? partName(p) : ''} → ${mountName(run.build.sections[mnt.si].type, mnt.i)}` : 'Change';
    const f1 = (v: number) => (Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, ''));
    const rows: Node[] = [el('div', 'cmp-row cmp-hd', el('span'), el('b', null, 'NOW'), el('b', null, 'NEW'), el('em'))];
    const num = (label: string, a: number | null, b: number | null, up = true, unit = '') => {
      const dv0 = a != null && b != null ? Math.round((b - a) * 100) / 100 : 0, cls = dv0 ? ((dv0 > 0) === up ? ' up' : ' down') : '';
      rows.push(el('div', `cmp-row${cls}`, el('span', 'cmp-k', label), el('b', null, a == null ? '—' : f1(a) + unit), el('b', 'cmp-n', b == null ? '—' : f1(b) + unit),
        el('em', null, dv0 ? `${dv0 > 0 ? '▲' : '▼'}${f1(Math.abs(dv0))}` : '')));
    };
    const txt = (label: string, a: string, b: string, better: boolean | null = null) => rows.push(el('div', `cmp-row${a === b ? '' : better == null ? ' moved' : better ? ' up' : ' down'}`,
      el('span', 'cmp-k', label), el('b', null, a), el('b', 'cmp-n', b), el('em', null, a === b ? '' : better == null ? '•' : better ? '▲' : '▼')));
    if (mnt && nd) {
      const a = mountCard(d, mnt.si, mnt.i)!, b = mountCard(nd, mnt.si, mnt.i)!, arcTxt = (c: MountCard) => (c.arc == null ? ARC_INFO[c.arcKind].short : `${c.arc}°`);
      rows.push(el('div', 'cmp-sec', 'Mount'));
      txt('Part', a.tier ? `${a.name} ${TIER[a.tier]}` : a.name, b.tier ? `${b.name} ${TIER[b.tier]}` : b.name);
      num('Air dmg/s', a.air, b.air); num('Gnd dmg/s', a.ground, b.ground); num('Cooldown', a.cd, b.cd, false, 's'); num('Range', a.range || null, b.range || null);
      txt('Clear arc', arcTxt(a), arcTxt(b), a.arc != null && b.arc != null ? b.arc > a.arc : null);
      txt('Engages', LAYER_WORD[a.layers], LAYER_WORD[b.layers]); txt('Turret ring', ROMAN[a.ring], ROMAN[b.ring], b.ring > a.ring);
    }
    const sa = shipCard(d), sb = nd ? shipCard(nd) : null;
    rows.push(el('div', 'cmp-sec', 'Ship'));
    num('Hull', sa.hull, sb?.hull ?? null); num('Speed', sa.speed, sb?.speed ?? null); num('Anti-air', sa.air, sb?.air ?? null); num('Anti-ground', sa.ground, sb?.ground ?? null);
    if (sb) txt('Worst gap', sa.gap.label, sb.gap.label, gapRank(sb.gap) === gapRank(sa.gap) ? null : gapRank(sb.gap) < gapRank(sa.gap));
    const why = P && P.drop && !P.drop.ok ? el('p', 'cmp-why', `✕ ${P.drop.why}`) : null;
    cmpEl.hidden = false;
    cmpEl.replaceChildren(el('div', 'cmp-title', el('span', null, 'Compare'), el('b', null, title)), ...rows, ...(why ? [why] : []));
  };
  const paintRead = (d: Derived) => {
    const p = picked();
    const head = (q: Part) => el('div', 'rd-head', icon(q.id), el('b', null, partName(q)), rankPips(q.tier));
    let body: (Node | null)[];
    if (dragKind === 'sec' && place) {
      const P = place;
      body = [el('div', 'rd-head', icon(P.p.type), el('b', null, SECTIONS[P.p.type].name)),
        el('p', null, secOver === -1 ? 'Cut loose: the module is lost, its parts go to the hold.' : !P.onPlan ? 'Carry it onto the plan: the outlines are the spots where it joins the hull.' : P.drop?.ok ? `Drop to ${P.buy ? `buy (${P.buy.cost} scrap) and weld it` : 'fit it'} here. The plan shows every gun's arc from the new shape.` : `✕ ${P.drop?.why ?? ''}`),
        el('p', 'rd-dim', 'Shape is strategy: the bridge tower and funnels mask the turrets around them, and every module masks the sponsons beside and ahead of it.')];
    } else if (p) {
      const c = over ? check(over) : null;
      const where = over?.k === 'slot' ? (() => {
        const sec = run.build.sections[over.si], tr = traverseIn(d, over.si, over.i, p.id);
        if (!c?.ok) return el('p', 'rd-no', c?.reason ?? '');
        const out = c.out ? ` ${partName(c.out)} goes to the hold.` : '';
        return el('p', 'rd-go', `→ ${mountName(sec.type, over.i)}: ${isWeapon(p.id) ? `${ARC_INFO[tr.arc].label}, engages ${({ air: 'aircraft only', ground: 'ground targets only', both: 'air and ground', shots: 'enemy fire', none: '—' } as const)[tr.layers]}.` : 'utility bay.'}${out}`);
      })() : over?.k === 'hold' ? el('p', 'rd-go', '→ Cargo hold: unmounted, kept for later.') : null;
      body = [head(p), el('p', null, partDesc(p)),
        isWeapon(p.id) ? el('p', 'rd-dim', `${weaponControl(p.id) === 'heavy' ? 'Heavy: aimed with the mouse.' : 'Auto: fires on its own.'} ${placementNote(p.id)}`) : el('p', 'rd-dim', 'Fits a utility bay.'),
        where ?? el('p', 'rd-dim', pick?.k === 'market' ? `Quartermaster asks ${pick.price} scrap. Drop it on a lit socket to buy and mount it.` : 'Lit sockets take it; the tag on each says what it would engage there.')];
    } else if (hoverPart && !hl) {
      body = [head(hoverPart), el('p', null, partDesc(hoverPart)), el('p', 'rd-dim', isWeapon(hoverPart.id) ? placementNote(hoverPart.id) : 'Fits a utility bay.')];
    } else if (hl) {
      const s = run.build.sections[hl.si], q = s?.slots[hl.i], show = rotHover ? derive(previewRotate(run.build, hl.si, hl.i, rotHover.dir) ?? run.build, mods(run)) : d;
      const av = s && SECTIONS[s.type].slots[hl.i] === 'W' ? arcView(show, hl.si, hl.i) : null;
      // What the mount sees from here: facing, clear arc, and what blocks the rest.
      const aim = av && facingMatters(av.arc) ? el('p', 'rd-go', `${rotHover ? '⟳ Would face' : 'Faces'} ${FACING_NAMES[av.facing]}: ${deg(sweep(av.open))}° clear${av.blocked.length ? `, masked by the ${blockNames(av).map((x) => x.toLowerCase()).join(' and ')}` : ''}. ${rotHover ? '' : 'R / Shift+R or the wheel turns it.'}`)
        : av ? el('p', 'rd-dim', rotateWhy(run.build, hl.si, hl.i) ?? '') : null;
      body = q ? [head(q), el('p', null, partDesc(q)), aim, el('p', 'rd-dim', `${mountName(s.type, hl.i)}. Drag to another socket to swap, or to the hold.`)]
        : s ? [el('div', 'rd-head', el('b', null, mountName(s.type, hl.i))), el('p', 'rd-dim', SECTIONS[s.type].slots[hl.i] === 'W' ? ARC_INFO[mountArc(s.type, 'W', null)].desc : 'Utility bay inside the hull: armor, shields, engines, drones.'), aim] : [];
    } else body = [el('p', 'rd-dim', 'Drag a part from the hold onto a socket. Drag between sockets to swap, back to the hold to unmount.'),
      el('p', 'rd-dim', 'Rotate a mount with ⟳ ⟲ on its tile, R / Shift+R or the wheel over it. Its fan on the plan is where it can fire, drawn to its reach; red hatching is what the bridge tower, funnels or another module block.'),
      el('p', 'rd-dim', 'Drag a module on the plan (or from the list) to reshape the ship; outlines show where it can join. Arrow keys nudge the focused module. A turret ring refit (hover a socket) widens its arc.'),
      el('p', 'rd-dim', 'Or click a part, then a socket. Esc lets go; Delete unmounts the focused socket.')];
    readEl.replaceChildren(...body.filter(Boolean) as Node[]);
    toastEl.textContent = toast;
  };

  /* ---------------- hold, counter and sections ---------------- */
  const partTile = (p: Part, src: Src, extra: { price?: number; afford?: boolean } = {}) => {
    const k = key(src), on = !!pick && sameLoc(pick, src);
    const b = el('button', {
      class: `ptile ${partSlot(p.id) === 'W' ? 'w' : 'u'}${on ? ' sel' : ''}${extra.afford === false ? ' short' : ''}`, 'data-key': k,
      'data-inv': src.k === 'inv' ? src.i : null, 'data-mkt': src.k === 'market' ? src.i : null, 'aria-pressed': String(on),
      'aria-label': `${partName(p)}${extra.price != null ? `, ${extra.price} scrap` : ''}`,
    },
    el('span', 'pt-well', icon(p.id)),
    el('span', 'pt-txt', el('b', null, partDef(p.id).name), el('span', 'pt-sub', `Mk ${TIER[p.tier]}`, rankPips(p.tier))),
    el('em', 'pt-kind', extra.price != null ? `${extra.price}` : partSlot(p.id) === 'W' ? 'W' : 'U'));
    b.addEventListener('click', () => { if (pick && sameLoc(pick, src)) pick = null; else { pick = src; over = null; } focusKey = k; render(); });
    b.addEventListener('pointerenter', () => { if (!dragging()) { hoverPart = p; paintRead(dv(run)); } });
    b.addEventListener('pointerleave', () => { if (!dragging() && hoverPart === p) { hoverPart = null; paintRead(dv(run)); } });
    draggable(b, () => partDrag(src));
    return b;
  };
  const paintSide = () => {
    const holdTiles = run.inv.map((p, i) => partTile(p, { k: 'inv', i }));
    const ret = pick?.k === 'slot' ? el('button', { class: 'btn small hold-ret', onclick: () => move(pick!, { k: 'hold' }) }, icon('cargo-crate'), 'Return to hold') : null;
    holdEl.replaceChildren(...(holdTiles.length ? holdTiles : [el('span', 'dim hold-empty', 'Empty. Unmounted and new parts land here.')]), ...(ret ? [ret] : []));
    const kids: Node[] = [legend('Cargo hold', `${run.inv.length} part${run.inv.length === 1 ? '' : 's'}`), holdEl];
    const market = extras.market?.() ?? [];
    if (market.length) {
      const m = market.flatMap((mp, i) => (mp.sold ? [] : [partTile(mp.part, { k: 'market', i, part: mp.part, price: mp.price, afford: mp.afford }, { price: mp.price, afford: mp.afford })]));
      kids.push(legend('Quartermaster', 'drag to buy and mount'), el('div', 'rf-market', ...(m.length ? m : [el('span', 'dim hold-empty', 'Counter cleared.')])));
    }
    kids.push(legend('Hull modules', 'drag on plan'), secsEl);
    left.replaceChildren(...kids);
    paintSecs();
  };
  const paintSecs = () => {
    const ol = el('ol', 'secs');
    run.build.sections.forEach((s, si) => {
      const sd = SECTIONS[s.type], fixed = s.type === 'bridge';
      const li = el('li', { class: `sec${fixed ? ' fixed' : ''}${place?.p.si === si ? ' lifted' : ''}`, 'data-sec': si, tabindex: 0, 'aria-label': `${sd.name}: drag onto the plan to move it, arrow keys nudge it` });
      const grip = el('span', { class: 'sec-grip', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
      const pips = el('span', 'sec-pips', ...s.slots.map((p, i) => el('i', { class: `${sd.slots[i] === 'W' ? 'w' : 'u'}${p ? ' on' : ''}`, title: p ? partName(p) : 'empty' })));
      // Placement is on the plan: these step the module to the next legal spot that way (like the arrow keys).
      const nb = (dx: number, dy: number, g: string, word: string) => el('button', { class: 'btn small nudge', 'aria-label': `Move ${sd.name} ${word}`, title: `Nudge ${word}`, disabled: !nudgeSpot(run.build, si, dx, dy), onclick: () => nudge(si, dx, dy) }, g);
      const ctl = el('span', 'sec-ctl', nb(-1, 0, '◀', 'to port'), nb(0, -1, '▲', 'forward'), nb(0, 1, '▼', 'aft'), nb(1, 0, '▶', 'to starboard'),
        fixed ? el('span', { class: 'sec-lock', title: 'The bridge commands the ship: it cannot be cut loose.' }, 'Keel') : (() => { const g = guardedSwitch('Cut', 'Confirm', () => cut(si)); g.classList.add('small'); g.setAttribute('aria-label', `Cut ${sd.name} loose`); return g; })());
      li.append(grip, el('span', 'sec-no', String(si + 1).padStart(2, '0')), icon(s.type),
        el('span', 'sec-nm', el('b', null, sd.name), el('small', null, `+${sd.hp} hull · mass ${sd.mass}${sd.thrust ? ` · thr ${sd.thrust}` : ''}`)), pips, ctl);
      li.addEventListener('pointerenter', () => { if (!dragging()) { secHl = si; paintLive(); } });
      li.addEventListener('pointerleave', () => { if (!dragging() && secHl === si) { secHl = null; paintLive(); } });
      li.addEventListener('focus', () => { secHl = si; paintLive(); }); li.addEventListener('blur', () => { if (secHl === si) { secHl = null; paintLive(); } });
      li.addEventListener('keydown', (e) => {
        const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
        if (dir && e.target === li) { e.preventDefault(); nudge(si, dir[0], dir[1], true); }
      });
      draggable(li, () => moduleDrag({ si, type: s.type }, () => li.cloneNode(true) as HTMLElement));
      ol.append(li);
    });
    const bin = el('div', { class: 'cut-bin', 'data-drop': 'cut' }, icon('hazard-sign'), el('span', null, 'Drop a module here to cut it loose'));
    const confirm = cutArm != null && run.build.sections[cutArm] ? el('div', 'cut-confirm', el('span', null, `Cut the ${SECTIONS[run.build.sections[cutArm].type].name} loose? Its parts go to the hold.`),
      el('button', { class: 'btn small danger', id: 'btn-cut-confirm', onclick: () => { const s = cutArm!; cutArm = null; cut(s); } }, 'Confirm cut'),
      el('button', { class: 'btn small', onclick: () => { cutArm = null; render(); } }, 'Keep')) : null;
    const welds = extras.sections?.().filter((m) => !m.sold).map((m) => {
      const full = run.build.sections.length >= MAX_SECTIONS;
      const b = el('button', { class: `wslip${!m.afford || full ? ' short' : ''}`, disabled: !m.afford || full, 'data-weld': m.type, onclick: () => weld(m) },
        icon(m.type), el('span', null, el('b', null, SECTIONS[m.type].name), el('small', null, full ? 'No berth' : `${m.cost} scrap · drag onto the plan`)));
      if (m.afford && !full) draggable(b, () => moduleDrag({ si: -1, type: m.type }, () => b.cloneNode(true) as HTMLElement, m));
      return b;
    }) ?? [];
    secsEl.replaceChildren(ol, ...(welds.length ? [el('div', 'rf-welds', ...welds)] : []), confirm ?? bin);
  };

  /* ---------------- drag hooks ---------------- */
  const partDrag = (src: Src) => {
    if (!partAt(run.build, run.inv, src)) return null;
    return {
      start: () => { pick = src; over = null; dragKind = 'part'; cutArm = null; uiSound('press'); paintLive(); },
      over: (t: HTMLElement | null) => {
        over = parseDrop(t?.dataset.drop);
        if (over && t) { const c = check(over); if (c && !c.ok && c.why !== 'same' && c.why !== 'noop') { t.classList.remove('deny-wobble'); void t.offsetWidth; t.classList.add('deny-wobble'); } }
        paintLive();
      },
      drop: (t: HTMLElement | null) => {
        const d = parseDrop(t?.dataset.drop);
        if (!d) return null;
        const c = check(d);
        if (!c?.ok) { if (c && c.why !== 'same' && c.why !== 'noop') { uiSound('deny'); toast = c.reason ?? ''; } return null; }
        return () => move(src, d, false);
      },
      end: () => { dragKind = null; if (pick && sameLoc(pick, src)) pick = null; over = null; render(); },
    };
  };
  /** Client rect of a grid spot on the board (the frame the drag started in). */
  const spotRect = (P: NonNullable<typeof place>, at: [number, number]) => {
    const b = spotBox(P.p.type, at, P.off), r = boardEl.getBoundingClientRect(), s = L!.ship.s;
    return new DOMRect(r.left + L!.ship.cx + b.x * s, r.top + L!.ship.cy + b.y * s, b.w * s, b.h * s);
  };
  /**
   * Carry a module (from the plan, the list, or a work slip on the counter) to a spot on the plan: the drop snaps to the
   * nearest legal spot, the plan previews the reshaped ship, and the cut bin takes an existing module.
   */
  const moduleDrag = (p: Placing, ghost: () => HTMLElement, buy?: MarketSection) => {
    if (!L || L.mode === 'stacked') return null;
    return {
      ghost,
      start: () => {
        place = { p, drop: null, spots: placeSpots(run.build, p), off: planOffset(run.build, dv(run)), onPlan: false, buy };
        dragKind = 'sec' as const; pick = null; hl = null; secHl = p.si >= 0 ? p.si : null; cutArm = null; secOver = null; uiSound('press'); paintLive();
      },
      over: (t: HTMLElement | null) => { secOver = t?.dataset.drop === 'cut' && p.si >= 0 ? -1 : null; secsEl.querySelector('.cut-bin')?.classList.toggle('over', secOver === -1); paintLive(); },
      move: (x: number, y: number) => {
        const P = place; if (!P || !L) return;
        const r = boardEl.getBoundingClientRect(), on = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        const raw = spotAt(p.type, (x - r.left - L.ship.cx) / L.ship.s, (y - r.top - L.ship.cy) / L.ship.s, P.off);
        const drop = on ? dropSpot(run.build, p, raw, P.spots) : null;
        if (on === P.onPlan && drop?.at[0] === P.drop?.at[0] && drop?.at[1] === P.drop?.at[1] && drop?.ok === P.drop?.ok) return;
        P.onPlan = on; P.drop = drop; paintLive();
      },
      snapTo: () => (place?.drop && place.onPlan ? spotRect(place, place.drop.at) : null),
      drop: (t: HTMLElement | null) => {
        if (t?.dataset.drop === 'cut' && p.si >= 0) return canCutSection(run.build, p.si) ? () => { cutArm = p.si; uiSound('deny'); } : null;
        const P = place; if (!P?.onPlan || !P.drop) return null;
        if (!P.drop.ok) { uiSound('deny'); toast = P.drop.why ?? ''; return null; }
        const at = P.drop.at;
        return () => placeAt(p, at, buy);
      },
      end: () => { dragKind = null; place = null; secOver = null; secHl = null; render(); },
    };
  };

  /* ---------------- actions (all through changeBuild, as before) ---------------- */
  function move(src: Src, dst: Dst, keyFocus = true) {
    const c = checkMove(run.build, run.inv, src, dst);
    if (!c.ok) { uiSound('deny'); toast = c.reason ?? ''; render(); return; }
    let s = src;
    if (src.k === 'market') {
      const m = extras.market!()[src.i];
      if (!m.buy()) { uiSound('deny'); toast = 'The quartermaster will not part with it.'; render(); return; }
      const at = run.inv.indexOf(src.part);
      s = { k: 'inv', i: at < 0 ? run.inv.length - 1 : at };
      if (dst.k === 'hold') { toast = `${partName(src.part)} bought into the hold.`; uiSound('buy'); finish(null, false); return; }
    }
    const p = partAt(run.build, run.inv, s)!;
    changeBuild(run, () => applyMove(run.build, run.inv, s, dst));
    if (dst.k === 'hold') { toast = `${partName(p)} moved to the hold.`; uiSound('press'); finish(null, false); return; }
    const sec = run.build.sections[dst.si];
    toast = `${partName(p)} mounted · ${mountName(sec.type, dst.i)}.${c.out ? ` ${partName(c.out)} ${src.k === 'slot' ? 'swapped across' : 'to the hold'}.` : ''}`;
    uiSound(src.k === 'market' ? 'buy' : 'stamp');
    finish(key(dst), keyFocus);
  }
  function finish(landed: string | null, keyFocus: boolean) { pick = null; over = null; hl = null; fresh = landed; if (landed && keyFocus) focusKey = landed; onChange(); render(); }
  function clickSlot(si: number, i: number) {
    const dst: Dst = { k: 'slot', si, i };
    if (pick) {
      if (pick.k === 'slot' && sameLoc(pick, dst)) { pick = null; toast = ''; focusKey = key(dst); render(); return; }
      focusKey = key(dst); move(pick, dst); return;
    }
    if (run.build.sections[si].slots[i]) { pick = { k: 'slot', si, i }; over = null; toast = 'Picked up. Click another socket to swap, or Return to hold.'; focusKey = key(dst); render(); }
    else { toast = 'Pick a part from the hold first, or drag one here.'; uiSound('deny'); render(); }
  }
  /** Fit module p at grid spot `at` (a new module from the counter is bought and welded first). */
  function placeAt(p: Placing, at: [number, number], buy?: MarketSection) {
    let si = p.si;
    if (buy) {
      const n = run.build.sections.length;
      if (!buy.buy() || run.build.sections.length !== n + 1) { uiSound('deny'); toast = 'The yard cannot weld it on.'; render(); return; }
      si = n;
    }
    const ok = !!run.build.sections[si] && !canPlace(run.build, si, at);
    if (ok) changeBuild(run, () => { placeModule(run.build, si, at); });
    toast = `${SECTIONS[p.type].name} ${buy ? 'welded on' : 'moved'}${ok ? '' : ' astern (that spot closed)'}.`; uiSound(buy ? 'buy' : 'stamp'); onChange(); render();
  }
  /** Step module si to the next legal spot in a direction (keyboard and the list's nudge buttons). */
  function nudge(si: number, dx: number, dy: number, keepFocus = false) {
    const at = nudgeSpot(run.build, si, dx, dy);
    if (!at) { uiSound('deny'); toast = 'No spot that way keeps the hull joined.'; paintLive(); return; }
    changeBuild(run, () => { placeModule(run.build, si, at); });
    toast = `${SECTIONS[run.build.sections[si].type].name} moved.`; uiSound('flap'); onChange(); render();
    if (keepFocus) (secsEl.querySelector(`li.sec[data-sec="${si}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }
  /** Turret rings are bought where the yard is (a merchant's counter came along, or `extras.rings`). */
  const ringWhy = (cost: number | null) => cost == null ? 'Full ring already fitted.' : !(extras.rings ?? !!(extras.market || extras.sections)) ? 'Turret rings are fitted at a merchant’s yard: open the refit from a merchant.'
    : run.scrap < cost ? `Short of scrap: ${cost} needed.` : null;
  function buyRing(si: number, i: number, focus: string | null = null) {
    const cost = ringUpgradeCost(run.build, si, i), why = ringWhy(cost);
    if (why) { uiSound('deny'); toast = why; paintLive(); return; }
    run.scrap -= cost!;
    changeBuild(run, () => { upgradeRing(run.build, si, i); });
    const lv = mountRing(run.build.sections[si], i);
    toast = `${RING_NAMES[lv]} fitted · ${mountName(run.build.sections[si].type, i)}. ${cost} scrap.`; uiSound('buy');
    ringHover = null; hl = { si, i }; focusKey = focus; onChange(); render();
  }
  /** Turn mount (si, i) one allowed step (dir 1 clockwise); refused with the reason where facing does not matter. */
  function rotate(si: number, i: number, dir: 1 | -1, focus: string | null = null) {
    const why = rotateWhy(run.build, si, i);
    if (why) { uiSound('deny'); toast = why; paintLive(); return; }
    const s = run.build.sections[si];
    changeBuild(run, () => { rotateMount(run.build, si, i, dir); });
    const av = arcView(dv(run), si, i)!;
    toast = `${mountName(s.type, i)} turned to ${FACING_NAMES[av.facing]}: ${deg(sweep(av.open))}° clear.`;
    uiSound('flap'); hl = { si, i }; focusKey = focus; onChange(); render();
  }
  /** The weapon mount at a pointer position on the board: its tile, or its ring on the plan (within 16 px). */
  const mountAt = (e: MouseEvent): { si: number; i: number; tile: boolean } | null => {
    const ms = (e.target as HTMLElement | null)?.closest?.('.mslot') as HTMLElement | null;
    if (ms) { const [si, i] = ms.dataset.mslot!.split('-').map(Number); return { si, i, tile: true }; }
    if (!L || L.mode === 'stacked') return null;
    const r = boardEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best: string | null = null, bd = 16 * 16;
    for (const [id, [ax, ay]] of Object.entries(L.anchors)) { const dd = (ax - x) ** 2 + (ay - y) ** 2; if (dd < bd) { bd = dd; best = id; } }
    if (!best) return null;
    const [si, i] = best.split('-').map(Number);
    return { si, i, tile: false };
  };
  const isWMount = (si: number, i: number) => !!run.build.sections[si] && SECTIONS[run.build.sections[si].type].slots[i] === 'W';
  // Wheel over a weapon mount (tile or plan) turns it; one step per notch, so a trackpad fling does not spin it round.
  let wheelAt = 0;
  boardEl.addEventListener('wheel', (e) => {
    if (dragging() || pick) return;
    const m = mountAt(e); if (!m || !isWMount(m.si, m.i)) return;
    e.preventDefault();
    const now = performance.now(); if (now - wheelAt < 140 || Math.abs(e.deltaY) < 1) return;
    wheelAt = now; rotate(m.si, m.i, e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  // Hovering a gun on the plan lights it like hovering its tile; clicking it is clicking the tile.
  boardEl.addEventListener('pointermove', (e) => {
    if (dragging() || e.pointerType === 'touch') return;
    const m = mountAt(e); if (m?.tile) return;
    boardEl.classList.toggle('on-mount', !!m);
    if (m && (!hl || hl.si !== m.si || hl.i !== m.i)) { hl = { si: m.si, i: m.i }; hlBoard = true; if (pick) over = { k: 'slot', si: m.si, i: m.i }; paintLive(); }
    else if (!m && hlBoard) { hl = null; hlBoard = false; if (pick) over = null; paintLive(); }
  });
  boardEl.addEventListener('pointerleave', () => { if (hlBoard && !dragging()) { hl = null; hlBoard = false; paintLive(); } });
  boardEl.addEventListener('click', (e) => { const m = mountAt(e); if (m && !m.tile) clickSlot(m.si, m.i); });
  // R / Shift+R turn the focused or hovered weapon mount (anywhere on the page while the board is up).
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    const ring = e.key === 'u' || e.key === 'U';
    if ((e.key !== 'r' && e.key !== 'R' && !ring) || e.ctrlKey || e.metaKey || e.altKey || dragging()) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
    const ms = (document.activeElement as HTMLElement | null)?.closest?.('.mslot') as HTMLElement | null;
    const at = ms ? ms.dataset.mslot!.split('-').map(Number) : hl ? [hl.si, hl.i] : null;
    if (!at || !isWMount(at[0], at[1])) return;
    e.preventDefault();
    const fk = ms ? (document.activeElement as HTMLElement).dataset.key ?? null : null;
    if (ring) buyRing(at[0], at[1], fk); else rotate(at[0], at[1], e.shiftKey ? -1 : 1, fk);
  };
  document.addEventListener('keydown', onKey);
  function cut(si: number) {
    const s = run.build.sections[si]; if (!s || !canCutSection(run.build, si)) return;
    changeBuild(run, () => { cutSection(run.build, run.inv, si); });
    toast = `${SECTIONS[s.type].name} cut loose. Its parts went to the hold.`; uiSound('stamp'); onChange(); render();
  }
  function weld(m: MarketSection) {
    if (!m.buy()) { uiSound('deny'); return; }
    toast = `${SECTIONS[m.type].name} welded on astern. Drag it on the plan to move it.`; uiSound('buy'); onChange(); render();
  }
  // Grab a module on the plan itself (away from its guns) and carry it to a new spot.
  let downAt: { x: number; y: number; t: EventTarget | null } | null = null;
  boardEl.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: e.target }; }, { capture: true });
  const moduleUnder = (x: number, y: number) => {
    if (!L || L.mode === 'stacked') return -1;
    const r = boardEl.getBoundingClientRect(), fx = (x - r.left - L.ship.cx) / L.ship.s, fy = (y - r.top - L.ship.cy) / L.ship.s;
    return dv(run).rects.findIndex((q) => fx >= q.x && fx <= q.x + q.w && fy >= q.y && fy <= q.y + q.h);
  };
  draggable(boardEl, () => {
    const a = downAt; if (!a || pick || (a.t as HTMLElement | null)?.closest?.('.board-tiles')) return null;
    if (mountAt(new MouseEvent('pointermove', { clientX: a.x, clientY: a.y }))) return null;
    const si = moduleUnder(a.x, a.y); if (si < 0) return null;
    const type = run.build.sections[si].type;
    return moduleDrag({ si, type }, () => el('div', { class: 'mod-ghost', 'data-own-size': '' }, icon(type), el('b', null, SECTIONS[type].name)));
  });
  boardEl.addEventListener('pointermove', (e) => { if (!dragging() && e.pointerType !== 'touch') boardEl.classList.toggle('on-module', !boardEl.classList.contains('on-mount') && !(e.target as HTMLElement).closest?.('.board-tiles') && moduleUnder(e.clientX, e.clientY) >= 0); });

  const render = () => { if (dragging()) return; hoverPart = null; paintSide(); paintBoard(); };
  // Keyboard: Escape lets go of a picked part (a drag in progress handles its own Escape).
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dragging() && (pick || cutArm != null)) { e.preventDefault(); e.stopPropagation(); pick = null; over = null; cutArm = null; toast = ''; render(); } });
  // Lay out once the board has a size, and again whenever it changes (window resize, rotating a phone).
  let lastW = -1, lastH = -1;
  const ro = new ResizeObserver(() => {
    if (!root.isConnected) { ro.disconnect(); cancelDrag(); return; }
    const w = boardEl.clientWidth, h = boardEl.clientHeight;
    if (w === lastW && (h === lastH || boardEl.classList.contains('stacked'))) return;
    lastW = w; lastH = h; if (!dragging()) paintBoard();
  });
  ro.observe(boardEl);
  paintSide();
  return root;
}
