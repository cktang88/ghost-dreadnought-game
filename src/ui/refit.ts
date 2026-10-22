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
  SECTIONS, ARC_INFO, LAYERS_TAG, MAX_SECTIONS, TIER, mountArc, traverseIn, partDef, partDesc, partName, partSlot, placementNote, weaponControl,
  derive, isWeapon, type Derived, type Part, type SectionType, type Traverse, type Build,
} from '../data/parts';
import { changeBuild, dv, mods, type RunState } from '../game/run';
import { drawBlueprint, mountDrawPos } from '../render/shipPreview';
import { uiSound } from './sound';
import { draggable, dragging, cancelDrag } from './drag';
import {
  layoutBoard, checkMove, applyMove, previewMove, partAt, sameLoc, shipStats, statDeltas, firepower,
  canMoveSection, moveSection, previewSectionMove, canCutSection, cutSection, previewCut,
  type Src, type Dst, type Board, type Check,
} from './refitLogic';

/** A part on the quartermaster's counter (refit opened from the merchant): bought on drop. `buy` puts it in the hold. */
export interface MarketPart { part: Part; price: number; afford: boolean; sold: boolean; buy: () => boolean }
/** A hull section on a work slip: bought and welded to the stern on drop (or click). */
export interface MarketSection { type: SectionType; cost: number; afford: boolean; sold: boolean; buy: () => boolean }
/** Getters, read on every render: a purchase on the board changes what is sold and what the scrap affords. */
export interface RefitExtras { market?: () => MarketPart[]; sections?: () => MarketSection[] }

const SIDE_NAME = ['port', 'centre', 'starboard'];
/** Where a mount sits, in words: "Bow", "Port battery", "Top deck · stbd", "Engine bay". */
function mountName(type: SectionType, i: number) {
  const n = SECTIONS[type].slots.length;
  if (type === 'bridge') return 'Bow mount';
  if (type === 'battery') return ['Port battery', 'Battery centre', 'Starboard battery'][i];
  if (type === 'gundeck') return `Top deck · ${i ? 'stbd' : 'port'}`;
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
/** The flank a mount would fire to with a broadside gun in it, from where it sits (derive() gives 0 when the part in it is, say, a bomb). */

/** Board anchors: where each mount is drawn on the plan (the bridge's mount is called out above the ship). */
const anchorsOf = (d: Derived) => d.mounts.map((m) => {
  const [ox, oy] = mountDrawPos(d, m);
  return { id: `${m.si}-${m.i}`, ox, oy, si: m.si, i: m.i, bow: d.rects[m.si].type === 'bridge' };
});

/** Wedge path for a traverse sector at (x, y): ship angle 0 = bow (up the screen), +PI/2 = starboard (right). */
function wedge(x: number, y: number, r: number, c: number, h: number) {
  if (h >= Math.PI - 1e-6) return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  const p = (a: number) => `${(x + Math.sin(a) * r).toFixed(1)} ${(y - Math.cos(a) * r).toFixed(1)}`;
  return `M${x} ${y}L${p(c - h)}A${r} ${r} 0 ${h * 2 > Math.PI ? 1 : 0} 1 ${p(c + h)}Z`;
}

/** Ship refit board: sockets called out around the ship's plan, a cargo hold, hull sections and the ship's particulars. */
export function refitPanel(run: RunState, onChange: () => void, extras: RefitExtras = {}) {
  /** Picked part (click, keyboard or drag) and the target it is over. */
  let pick: Src | null = null, over: Dst | null = null, dragKind: 'part' | 'sec' | null = null;
  let secDrag: number | null = null, secOver: number | null = null, secHl: number | null = null, cutArm: number | null = null;
  let hl: { si: number; i: number } | null = null, toast = '', fresh: string | null = null, focusKey: string | null = null;
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
  const strip = el('div', 'board-strip', el('span', null, 'Plan view · bow up ▲'), el('span', 'bs-mid', 'Callouts not to scale'), el('span', 'bs-len'));
  const statsEl = el('div', 'rf-stats');
  const readEl = el('div', { class: 'rf-read crt', 'aria-live': 'polite' });
  const toastEl = el('div', { class: 'toast rf-toast', role: 'status' });
  const left = el('aside', 'rf-col rf-left');
  const right = el('aside', 'rf-col rf-right', legend('Ship’s particulars', 'live'), statsEl, readEl, toastEl);
  root.append(left, el('div', 'rf-board-wrap', strip, boardEl), right);

  const picked = () => (pick ? partAt(run.build, run.inv, pick) : null);
  const check = (d: Dst): Check | null => (pick ? checkMove(run.build, run.inv, pick, d) : null);
  const preview = (): Build | null => {
    if (dragKind === 'sec' && secDrag != null) {
      if (cutArm != null || secOver === -1) return previewCut(run.build, secDrag);
      return secOver != null ? previewSectionMove(run.build, secDrag, secOver) : null;
    }
    if (cutArm != null) return previewCut(run.build, cutArm);
    return pick && over ? previewMove(run.build, run.inv, pick, over) : null;
  };

  /* ---------------- the board ---------------- */
  const tileFor = (si: number, i: number, d: Derived) => {
    const s = run.build.sections[si], type = s.type, kind = SECTIONS[type].slots[i], p = s.slots[i];
    const dst: Dst = { k: 'slot', si, i }, k = key(dst);
    const arc = kind === 'U' ? 'internal' : mountArc(type, kind, p?.id);
    const t = el('button', {
      class: `mtile ${kind === 'W' ? 'w' : 'u'} ${p ? 'full' : 'empty'}`, 'data-drop': k, 'data-key': k, 'data-slot': `${si}-${i}`,
      style: `--arc:${ARC_INFO[arc].col}`, 'aria-label': `${mountName(type, i)}: ${p ? partName(p) : 'empty'}`,
    });
    const reach = kind === 'W' ? (p ? traverseIn(d, si, i, p.id) : traverseIn(d, si, i, 'pulse')) : null;
    t.append(
      el('span', 'mt-n', String(L?.tiles.find((x) => x.id === `${si}-${i}`)?.n ?? '').padStart(2, '0')),
      el('span', 'mt-well', p ? icon(p.id) : el('i', null, kind)),
      el('span', 'mt-txt',
        el('b', 'mt-nm', p ? partDef(p.id).name : kind === 'W' ? 'Weapon mount' : 'Utility bay'),
        el('span', 'mt-sub', el('span', 'mt-pos', mountName(type, i)), p ? rankPips(p.tier) : null),
        el('span', 'mt-say')),
      el('span', 'mt-tags', el('em', 'arc-tag', ARC_INFO[arc].short), reach ? el('em', `reach-tag ${reach.layers}`, LAYERS_TAG[reach.layers]) : null),
    );
    t.addEventListener('click', () => clickSlot(si, i));
    t.addEventListener('keydown', (e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && p) { e.preventDefault(); move({ k: 'slot', si, i }, { k: 'hold' }); } });
    const enter = () => { hl = { si, i }; if (pick) over = dst; paintLive(); };
    const leave = () => { if (hl && hl.si === si && hl.i === i) hl = null; if (over && sameLoc(over, dst)) over = null; paintLive(); };
    t.addEventListener('pointerenter', () => { if (!dragging()) enter(); });
    t.addEventListener('pointerleave', () => { if (!dragging()) leave(); });
    t.addEventListener('focus', enter); t.addEventListener('blur', leave);
    if (p) draggable(t, () => partDrag({ k: 'slot', si, i }));
    return t;
  };

  const paintBoard = () => {
    const w = boardEl.clientWidth; if (!w) return;
    const d = dv(run);
    const anchors = anchorsOf(d);
    const stacked = w < 640;
    if (!stacked) boardEl.style.height = '';
    const h = boardEl.clientHeight;
    L = layoutBoard({ w, h, len: d.len, width: d.width, anchors });
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
      if (fresh === t.dataset.key) t.classList.add('clunk');
      return t;
    }));
    paintLive();
    if (fresh) { const f = fresh; setTimeout(() => { if (fresh === f) fresh = null; }, 700); }
    if (focusKey) { (tilesEl.querySelector(`[data-key="${focusKey}"]`) as HTMLElement | null)?.focus({ preventScroll: true }); focusKey = null; }
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
      const say = t.querySelector('.mt-say')!, tags = t.querySelector('.mt-tags')!;
      t.querySelectorAll('.cand-tag').forEach((x) => x.remove());
      if (c && p && dst.k === 'slot') {
        if (c.ok) {
          const sec = run.build.sections[dst.si], tr = traverseIn(d, dst.si, dst.i, p.id);
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

    // Leader lines, mount rings, and the firing arc of the hovered or targeted mount.
    const show = nd ?? d;
    const kids: SVGElement[] = [];
    const tgt = over?.k === 'slot' ? `${over.si}-${over.i}` : hl ? `${hl.si}-${hl.i}` : null;
    const arcFor = (si: number, i: number, cand: boolean, hot: boolean) => {
      const m = show.mounts.find((x) => x.si === si && x.i === i); if (!m) return;
      let tr: Traverse = m.trav;
      if (cand && p) { const sec = run.build.sections[si]; tr = traverseIn(show, si, i, p.id); }
      if (!tr.sectors.length) return;
      const [x, y] = L!.anchors[`${si}-${i}`], col = ARC_INFO[tr.arc].col, big = Math.max(64, Math.min(120, L!.ship.s * 48)), r = hot ? big : big * 0.46;
      const g = svg('g', { class: `arc-w${hot ? ' hot' : ''}${tr.down ? ' down' : ''}`, style: `--arc:${col}` });
      if (tr.down) for (const rr of [0.35, 0.6, 0.85]) g.append(svg('circle', { cx: x, cy: y, r: r * rr }));
      else for (const s of tr.sectors) g.append(svg('path', { d: wedge(x, y, r, s.c, s.h) }));
      if (hot) { const tx = svg('text', { x, y: Math.min(L!.h - 4, y + r + 14), 'text-anchor': 'middle', class: 'arc-lbl' }); tx.textContent = `${ARC_INFO[tr.arc].label.toUpperCase()} · ${LAYERS_TAG[tr.layers] || 'BAY'}`; g.append(tx); }
      kids.push(g);
    };
    if (p && dragKind !== 'sec') for (const t of L.tiles) { const [si, i] = t.id.split('-').map(Number); if (check({ k: 'slot', si, i })?.ok && t.id !== tgt) arcFor(si, i, true, false); }
    if (tgt) { const [si, i] = tgt.split('-').map(Number); const ok = !p || check({ k: 'slot', si, i })?.ok; if (ok) arcFor(si, i, !!p, true); }
    for (const l of L.leaders) {
      const on = l.id === tgt, [si, i] = l.id.split('-').map(Number);
      const c = p && dragKind !== 'sec' ? check({ k: 'slot', si, i }) : null;
      kids.push(svg('polyline', { class: `lead${on ? ' on' : ''}${c?.ok ? ' cand' : c && c.why !== 'same' ? ' nope' : ''}${fresh === `slot:${si}:${i}` ? ' clunk' : ''}`, points: l.pts.map((q) => q.join(',')).join(' ') }));
    }
    for (const t of L.tiles) {
      const [x, y] = L.anchors[t.id], on = t.id === tgt;
      kids.push(svg('circle', { class: `ring${on ? ' on' : ''}${fresh === `slot:${t.id.replace('-', ':')}` ? ' clunk' : ''}`, cx: x, cy: y, r: on ? 6 : 3.5 }));
      if (L.mode === 'stacked') kids.push(svg('g', { class: 'balloon' + (on ? ' on' : '') }, svg('circle', { cx: x + 10, cy: y - 10, r: 8 }), svg('text', { x: x + 10, y: y - 6.5, 'text-anchor': 'middle' })));
    }
    lines.replaceChildren(...kids);
    if (L.mode === 'stacked') lines.querySelectorAll('.balloon text').forEach((tx, k) => { tx.textContent = String(L!.tiles[k].n); });
    // The plan itself redraws with the previewed fit (same hull, so the callouts stay put).
    const k = canvas.width / Math.max(1, L.w), sameHull = !nb || nb.sections.length === run.build.sections.length && nb.sections.every((s, si) => s.type === run.build.sections[si].type);
    boardEl.classList.toggle('reshaping', !sameHull);
    if (sameHull) drawBlueprint(canvas, show, false, tgt ? { si: +tgt.split('-')[0], i: +tgt.split('-')[1] } : null, { fit: { ...L.ship, k }, section: secHl });
    else {
      // A reordered or cut hull: draw the new plan at its own fit, and fade the callouts until it is committed.
      const nL = layoutBoard({ w: L.w, h: L.h, len: nd!.len, width: nd!.width, anchors: anchorsOf(nd!) });
      const moved = secDrag != null && secOver != null && secOver >= 0 ? secOver : null;
      drawBlueprint(canvas, nd!, false, null, { fit: { ...nL.ship, k }, section: moved });
      lines.replaceChildren();
    }
    paintStats(d, nd);
    paintRead(d);
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
      el('div', 'rf-rows', ...['mass', 'thrust', 'pd', 'regen', 'drones'].map(row)),
    ];
    if (warn) kids.push(el('p', 'fatal hazard-plate', warn));
    // Gauges are rebuilt only when the committed fit changes, so the needles swing once per refit, not per hover.
    const sig = st.map((s) => s.v).join(',') + `|${Math.ceil(run.hp)}`;
    if (statsEl.dataset.sig !== sig) { statsEl.dataset.sig = sig; statsEl.replaceChildren(...kids); }
    else { kids[0] = statsEl.querySelector('.gauges') ?? kids[0]; statsEl.replaceChildren(...kids); }
  };
  const paintRead = (d: Derived) => {
    const p = picked();
    const head = (q: Part) => el('div', 'rd-head', icon(q.id), el('b', null, partName(q)), rankPips(q.tier));
    let body: (Node | null)[];
    if (dragKind === 'sec' && secDrag != null) {
      const s = run.build.sections[secDrag];
      body = [el('div', 'rd-head', icon(s.type), el('b', null, SECTIONS[s.type].name)),
        el('p', null, secOver === -1 || cutArm != null ? 'Cut loose: the section is lost, its parts go to the hold.' : secOver != null ? `Moves to frame ${String(secOver + 1).padStart(2, '0')}. The hull rebalances; mounts keep their parts.` : 'Drop between frames to reorder. The bridge stays at the bow.')];
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
      const s = run.build.sections[hl.si], q = s?.slots[hl.i];
      body = q ? [head(q), el('p', null, partDesc(q)), el('p', 'rd-dim', `${mountName(s.type, hl.i)}. Drag to another socket to swap, or to the hold.`)]
        : s ? [el('div', 'rd-head', el('b', null, mountName(s.type, hl.i))), el('p', 'rd-dim', SECTIONS[s.type].slots[hl.i] === 'W' ? ARC_INFO[mountArc(s.type, 'W', null)].desc : 'Utility bay inside the hull: armor, shields, engines, drones.')] : [];
    } else body = [el('p', 'rd-dim', 'Drag a part from the hold onto a socket. Drag between sockets to swap, back to the hold to unmount.'), el('p', 'rd-dim', 'Or click a part, then a socket. Esc lets go; Delete unmounts the focused socket.')];
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
    kids.push(legend('Hull sections', 'bow to stern'), secsEl);
    left.replaceChildren(...kids);
    paintSecs();
  };
  const paintSecs = () => {
    const ol = el('ol', 'secs');
    run.build.sections.forEach((s, si) => {
      const sd = SECTIONS[s.type], fixed = s.type === 'bridge';
      const li = el('li', { class: `sec${fixed ? ' fixed' : ''}${secDrag === si ? ' lifted' : ''}${secOver === si && secDrag != null && secDrag !== si ? (secDrag < si ? ' ins-after' : ' ins-before') : ''}`, 'data-drop': `sec:${si}`, 'data-sec': si });
      const grip = el('span', { class: 'sec-grip', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
      const pips = el('span', 'sec-pips', ...s.slots.map((p, i) => el('i', { class: `${sd.slots[i] === 'W' ? 'w' : 'u'}${p ? ' on' : ''}`, title: p ? partName(p) : 'empty' })));
      const ctl = fixed ? el('span', 'sec-lock', 'Bow') : el('span', 'sec-ctl',
        el('button', { class: 'btn small', 'aria-label': `Move ${sd.name} toward bow`, title: 'Toward bow', disabled: !canMoveSection(run.build, si, si - 1), onclick: () => moveSec(si, si - 1) }, '▲'),
        el('button', { class: 'btn small', 'aria-label': `Move ${sd.name} toward stern`, title: 'Toward stern', disabled: !canMoveSection(run.build, si, si + 1), onclick: () => moveSec(si, si + 1) }, '▼'),
        (() => { const g = guardedSwitch('Cut', 'Confirm', () => cut(si)); g.classList.add('small'); g.setAttribute('aria-label', `Cut ${sd.name} loose`); return g; })());
      li.append(grip, el('span', 'sec-no', String(si + 1).padStart(2, '0')), icon(s.type),
        el('span', 'sec-nm', el('b', null, sd.name), el('small', null, `+${sd.hp} hull · mass ${sd.mass}${sd.thrust ? ` · thr ${sd.thrust}` : ''}`)), pips, ctl);
      li.addEventListener('pointerenter', () => { if (!dragging()) { secHl = si; paintLive(); } });
      li.addEventListener('pointerleave', () => { if (!dragging() && secHl === si) { secHl = null; paintLive(); } });
      if (!fixed) draggable(li, () => secDragHooks(si, li));
      ol.append(li);
    });
    const bin = el('div', { class: 'cut-bin', 'data-drop': 'cut' }, icon('hazard-sign'), el('span', null, 'Drop a section here to cut it loose'));
    const confirm = cutArm != null && run.build.sections[cutArm] ? el('div', 'cut-confirm', el('span', null, `Cut the ${SECTIONS[run.build.sections[cutArm].type].name} loose? Its parts go to the hold.`),
      el('button', { class: 'btn small danger', id: 'btn-cut-confirm', onclick: () => { const s = cutArm!; cutArm = null; cut(s); } }, 'Confirm cut'),
      el('button', { class: 'btn small', onclick: () => { cutArm = null; render(); } }, 'Keep')) : null;
    const welds = extras.sections?.().filter((m) => !m.sold).map((m) => {
      const full = run.build.sections.length >= MAX_SECTIONS;
      const b = el('button', { class: `wslip${!m.afford || full ? ' short' : ''}`, disabled: !m.afford || full, 'data-weld': m.type, onclick: () => weld(m) },
        icon(m.type), el('span', null, el('b', null, SECTIONS[m.type].name), el('small', null, full ? 'No berth' : `${m.cost} scrap · weld to stern`)));
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
  const secDragHooks = (si: number, li: HTMLElement) => ({
    ghost: () => li.cloneNode(true) as HTMLElement,
    start: () => { secDrag = si; secOver = null; dragKind = 'sec' as const; pick = null; secHl = si; cutArm = null; uiSound('press'); paintSecsLive(); paintLive(); },
    over: (t: HTMLElement | null) => {
      const v = t?.dataset.drop;
      secOver = v === 'cut' ? -1 : v?.startsWith('sec:') ? +v.slice(4) : null;
      if (secOver != null && secOver >= 0 && !canMoveSection(run.build, si, secOver)) secOver = null;
      paintSecsLive(); paintLive();
    },
    drop: (t: HTMLElement | null) => {
      const v = t?.dataset.drop;
      if (v === 'cut' && canCutSection(run.build, si)) return () => { cutArm = si; uiSound('deny'); };
      const to = v?.startsWith('sec:') ? +v.slice(4) : -1;
      if (to >= 0 && canMoveSection(run.build, si, to)) return () => moveSec(si, to);
      return null;
    },
    end: () => { dragKind = null; secDrag = null; secOver = null; secHl = null; render(); },
  });
  const paintSecsLive = () => {
    secsEl.querySelectorAll<HTMLElement>('li.sec').forEach((li) => {
      const s = +li.dataset.sec!;
      li.classList.toggle('lifted', secDrag === s);
      li.classList.toggle('ins-before', secOver === s && secDrag != null && secDrag > s);
      li.classList.toggle('ins-after', secOver === s && secDrag != null && secDrag < s);
    });
    secsEl.querySelector('.cut-bin')?.classList.toggle('over', secOver === -1);
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
  function moveSec(from: number, to: number) {
    if (!canMoveSection(run.build, from, to)) return;
    const name = SECTIONS[run.build.sections[from].type].name;
    changeBuild(run, () => { moveSection(run.build, from, to); });
    toast = `${name} moved to frame ${String(to + 1).padStart(2, '0')}.`; uiSound('stamp'); onChange(); render();
  }
  function cut(si: number) {
    const s = run.build.sections[si]; if (!s || !canCutSection(run.build, si)) return;
    changeBuild(run, () => { cutSection(run.build, run.inv, si); });
    toast = `${SECTIONS[s.type].name} cut loose. Its parts went to the hold.`; uiSound('stamp'); onChange(); render();
  }
  function weld(m: MarketSection) {
    if (!m.buy()) { uiSound('deny'); return; }
    toast = `${SECTIONS[m.type].name} welded to the stern.`; uiSound('buy'); onChange(); render();
  }

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
