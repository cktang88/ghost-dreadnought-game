// Combat HUD: a 2D canvas over the WebGL view, drawn in field units (1600x900). Same instrument language as
// the menus: riveted plates, stencil legends, segmented bars with a damage trail, a split-flap scrap counter with a
// pickup streak, the weapon panel (numbered HEAVY groups with reload pips and target-layer tags, AUTO lamps), the mouse
// reticle (impact ring, rail lines, missile lock brackets, reload ring, why a group cannot bear), the Overdrive gauge (with a SPACE prompt that cannot be missed),
// the carnage ladder, a boss/elite nameplate, a stamped banner, a slow-mo letterbox and off-screen threat chevrons
// (ported from Dead Air's threat-indicators.js). Reads S.overdrive, S.carnage, S.events, S.pickStreak, S.slowFx.
import { S, W, H, BOSS_PHASES, AFT, aim, gunnery, firingGroups } from '../game/combat';
import { V } from '../game/vfx';
import { clamp } from '../util/rng';
import { EN } from '../data/enemies';
import { wCd, autoMounts, LAYERS_TAG, shipToField, type Part, type Mount, type Sector } from '../data/parts';
import { OVERDRIVES, type OverdriveKind } from '../data/hulls';
import { drawIcon } from '../ui/icons';
import { fieldToScreen, screenScale } from './view';
import { drawSymbology } from './units/symbology';

const F_MONO = '"Share Tech Mono", ui-monospace, monospace';
const F_STEN = '"Saira Stencil One", "Chakra Petch", sans-serif';
const C = { void: '#0a0e13', fg: '#dbe4ec', dim: '#8597a8', faint: '#5d6e7e', hazard: '#f2a541', plasma: '#4fd1e8', hostile: '#ff5a4e', good: '#8fe39a', scrap: '#e0c35c', violet: '#c9a6ff', crt: '#ffb347' };
const CODE: Record<string, string> = { pulse: 'PLS', spread: 'SCT', flak: 'FLK', missile: 'MSL', bomb: 'BMB', artillery: 'MRT', rail: 'RAIL', tesla: 'ARC', pd: 'PD' };

let VIG: HTMLCanvasElement | null = null, HURT: HTMLCanvasElement | null = null;
function mkV(inner: string, outer: string) {
  const s = document.createElement('canvas'); s.width = W; s.height = H; const g = s.getContext('2d')!;
  const gr = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.72); gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, W, H); return s;
}

/* ---------------- persistent animation state ---------------- */
const st = {
  t: 0, last: 0, enc: null as unknown,
  hpLag: 1, shLag: 1, bossLag: 1, eliteLag: 1,
  scrapShown: 0, digits: [] as { ch: string; flip: number }[], gains: [] as { v: number; t: number }[], lastScrap: -1,
  fired: new Map<number, number>(), lastCd: new Map<number, number>(),
  bannerKey: '', odNeedle: 0, tierAt: -9, lastEvent: 0,
  /** The pilot has fired a heavy group (hides the HOLD LMB prompt). */ everFired: false,
};

/* ---------------- primitives ---------------- */
function plate(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, opts: { stripe?: string; alpha?: number } = {}) {
  c.save();
  c.globalAlpha = opts.alpha ?? 0.9;
  const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, '#19222b'); g.addColorStop(1, '#0e1419');
  c.fillStyle = g; c.fillRect(x, y, w, h);
  c.globalAlpha = 1;
  c.strokeStyle = '#000'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(x + 1, y + 1, w - 2, 1);
  if (opts.stripe) stripe(c, x, y, w, 4, opts.stripe);
  for (const [rx, ry] of [[x + 6, y + (opts.stripe ? 10 : 6)], [x + w - 6, y + (opts.stripe ? 10 : 6)], [x + 6, y + h - 6], [x + w - 6, y + h - 6]]) rivet(c, rx, ry);
  c.restore();
}
function rivet(c: CanvasRenderingContext2D, x: number, y: number) {
  c.fillStyle = '#05080b'; c.beginPath(); c.arc(x, y, 2.4, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#4b5a68'; c.beginPath(); c.arc(x - 0.4, y - 0.5, 1.3, 0, Math.PI * 2); c.fill();
}
function stripe(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = '#120e08'; c.fillRect(x, y, w, h);
  c.fillStyle = col;
  for (let i = -h; i < w + h; i += 14) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i + 7, y + h); c.lineTo(x + i + 7 + h, y); c.lineTo(x + i + h, y); c.fill(); }
  c.restore();
}
function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, col = C.faint, size = 11, align: CanvasTextAlign = 'left') {
  c.font = `${size}px ${F_MONO}`; c.fillStyle = col; c.textAlign = align; c.textBaseline = 'alphabetic';
  // letter-spacing by hand keeps it portable
  if (align === 'left') { let cx = x; for (const ch of text) { c.fillText(ch, cx, y); cx += c.measureText(ch).width + size * 0.14; } }
  else c.fillText(text, x, y);
}
function lampDot(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, k: number) {
  c.fillStyle = '#05080b'; c.beginPath(); c.arc(x, y, r + 1.2, 0, Math.PI * 2); c.fill();
  if (k > 0.05) { c.save(); c.globalAlpha = 0.35 * k; c.fillStyle = col; c.beginPath(); c.arc(x, y, r * 2.4, 0, Math.PI * 2); c.fill(); c.restore(); }
  const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x, y, r);
  if (k > 0.05) { g.addColorStop(0, k > 0.99 ? '#ffffff' : col); g.addColorStop(0.25, col); g.addColorStop(1, shade(col, 0.35)); c.globalAlpha = 0.35 + 0.65 * k; }
  else { g.addColorStop(0, '#4b5763'); g.addColorStop(1, '#161c22'); }
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
}
function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

/** Segmented bar with a white damage trail between the current value and the lagging one. */
function segs(c: CanvasRenderingContext2D, x: number, y: number, n: number, sw: number, sh: number, gap: number, k: number, lag: number, col: string, blinkLow = false) {
  c.fillStyle = '#05080b'; c.fillRect(x - 3, y - 3, n * (sw + gap) - gap + 6, sh + 6);
  c.strokeStyle = '#000'; c.strokeRect(x - 2.5, y - 2.5, n * (sw + gap) - gap + 5, sh + 5);
  const lit = k * n, trail = lag * n;
  const blinkOff = blinkLow && Math.floor(st.t * 3) % 2 === 1;
  for (let i = 0; i < n; i++) {
    const sx = x + i * (sw + gap);
    if (i < Math.floor(lit) || (i < lit && lit - i > 0.5)) {
      if (blinkOff) { c.fillStyle = shade(col, 0.45); c.fillRect(sx, y, sw, sh); continue; }
      const g = c.createLinearGradient(0, y, 0, y + sh); g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, col); g.addColorStop(1, shade(col, 0.6));
      c.fillStyle = g; c.fillRect(sx, y, sw, sh);
    } else if (i < trail) { c.fillStyle = 'rgba(255,240,220,.85)'; c.fillRect(sx, y, sw, sh); }
    else { c.fillStyle = '#18212a'; c.fillRect(sx, y, sw, sh); }
  }
}

/* ---------------- clusters ---------------- */
function hullCluster(c: CanvasRenderingContext2D) {
  const P = S.P!, k = clamp(P.hp / P.dv.maxHp, 0, 1);
  const sk = P.dv.shieldMax ? clamp(P.shield / P.dv.shieldMax, 0, 1) : 0;
  const x = 14, y = 12, w = 404, h = P.dv.shieldMax ? 76 : 58;
  plate(c, x, y, w, h);
  const col = k < 0.3 ? C.hostile : k < 0.55 ? C.hazard : C.good;
  c.font = `14px ${F_STEN}`; c.fillStyle = '#9fb0c0'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText('HULL', x + 16, y + 30);
  segs(c, x + 66, y + 16, 24, 8, 16, 2, k, st.hpLag, col, k < 0.3);
  c.font = `20px ${F_MONO}`; c.fillStyle = k < 0.3 ? C.hostile : C.fg; c.textAlign = 'right';
  c.fillText(String(Math.ceil(Math.max(0, P.hp))), x + w - 50, y + 32);
  c.font = `13px ${F_MONO}`; c.fillStyle = C.faint; c.textAlign = 'left'; c.fillText(`/${Math.round(P.dv.maxHp)}`, x + w - 48, y + 32);
  if (k < 0.3) { label(c, 'HULL CRITICAL', x + 70, y + 49, Math.floor(st.t * 3) % 2 ? C.hostile : shade(C.hostile, 0.6), 10); }
  if (P.dv.shieldMax) {
    c.font = `14px ${F_STEN}`; c.fillStyle = '#9fb0c0'; c.textAlign = 'left'; c.fillText('SHLD', x + 16, y + 62);
    segs(c, x + 66, y + 53, 24, 8, 8, 2, sk, st.shLag, C.plasma);
    c.font = `13px ${F_MONO}`; c.fillStyle = C.plasma; c.textAlign = 'right'; c.fillText(String(Math.ceil(P.shield)), x + w - 50, y + 63);
  }
}

function scrapCluster(c: CanvasRenderingContext2D, total: number) {
  const x = W - 60 - 236, y = 12, w = 236, h = 58;
  plate(c, x, y, w, h);
  drawIcon(c, 'metal-bar', x + 24, y + 30, 26, C.scrap);
  label(c, 'SCRAP', x + 44, y + 22, C.faint, 10);
  const v = Math.max(0, Math.floor(total));
  if (st.lastScrap >= 0 && v > st.lastScrap) st.gains.push({ v: v - st.lastScrap, t: st.t });
  st.lastScrap = v;
  st.scrapShown += (v - st.scrapShown) * 0.18; if (Math.abs(v - st.scrapShown) < 0.6) st.scrapShown = v;
  const s = String(Math.round(st.scrapShown)).padStart(5, '0');
  for (let i = 0; i < s.length; i++) {
    const d = st.digits[i] ??= { ch: s[i], flip: -1 };
    if (d.ch !== s[i]) { d.ch = s[i]; d.flip = st.t; }
    const dx = x + 44 + i * 19, dy = y + 27, dw = 17, dh = 24, p = d.flip < 0 ? 1 : clamp((st.t - d.flip) / 0.12, 0, 1);
    c.fillStyle = '#20252b'; c.fillRect(dx, dy, dw, dh / 2); c.fillStyle = '#15191d'; c.fillRect(dx, dy + dh / 2, dw, dh / 2);
    c.save(); c.beginPath(); c.rect(dx, dy, dw, dh); c.clip();
    c.font = `20px ${F_MONO}`; c.fillStyle = '#f3ede0'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.translate(dx + dw / 2, dy + dh / 2); c.scale(1, 0.25 + 0.75 * p); c.fillText(d.ch, 0, 1);
    c.restore();
    c.fillStyle = '#000'; c.fillRect(dx, dy + dh / 2 - 0.5, dw, 1);
    if (p < 1) { c.fillStyle = `rgba(255,255,255,${0.25 * (1 - p)})`; c.fillRect(dx, dy, dw, dh / 2); }
  }
  // this-fight tally and floating gains
  c.font = `12px ${F_MONO}`; c.fillStyle = C.good; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
  c.fillText(`+${Math.floor(S.scrap)}`, x + w - 12, y + 22);
  const streak = S.pickStreak?.n ?? 0;
  if (streak >= 3) { const pk = clamp(1 - (S.pickStreak.t / 0.5), 0, 1); c.save(); c.globalAlpha = 0.5 + 0.5 * pk; label(c, `STREAK ×${streak}`, x + w - 12, y + 50, C.scrap, 10 + Math.min(4, streak / 6), 'right'); c.restore(); }
  st.gains = st.gains.filter((g) => st.t - g.t < 0.9);
  for (const g of st.gains) { const a = st.t - g.t; c.globalAlpha = 1 - a / 0.9; c.fillText(`+${g.v}`, x + w - 12, y + 70 + a * 18); c.globalAlpha = 1; }
}

function pauseKey(c: CanvasRenderingContext2D) {
  const x = W - 50, y = 12, s = 38;
  const g = c.createLinearGradient(0, y, 0, y + s); g.addColorStop(0, '#26313c'); g.addColorStop(1, '#171e26');
  c.fillStyle = '#05080b'; c.fillRect(x, y + 3, s, s);
  c.fillStyle = g; c.fillRect(x, y, s, s);
  c.strokeStyle = '#000'; c.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(x + 1, y + 1, s - 2, 1);
  c.fillStyle = C.fg; c.fillRect(x + 13, y + 11, 4, 16); c.fillRect(x + 21, y + 11, 4, 16);
  label(c, 'ESC', x + s / 2, y + s + 15, C.faint, 9, 'center');
}

function encounterPlate(c: CanvasRenderingContext2D) {
  const enc = S.enc; if (!enc) return;
  const B = S.boss, E = S.elite && !S.elite.dead ? S.elite : null;
  if ((B && B.alive) || E) return nameplate(c, B && B.alive ? B : null, E);
  const w = 420, x = W / 2 - w / 2, y = 12, h = 46;
  plate(c, x, y, w, h);
  c.font = `15px ${F_STEN}`; c.fillStyle = '#c9d3dc'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText(`SECTOR ${S.sector}  ·  ${enc.name.toUpperCase()}`, W / 2, y + 22);
  if (enc.kind === 'fight') {
    const tx = x + 26, tw = w - 52, ty = y + 31, k = clamp(S.time / enc.duration, 0, 1);
    c.fillStyle = '#05080b'; c.fillRect(tx, ty, tw, 6);
    c.fillStyle = S.mode === 'play' ? C.hazard : C.good; c.fillRect(tx, ty, tw * k, 6);
    c.fillStyle = 'rgba(0,0,0,.6)'; for (let i = 1; i < 10; i++) c.fillRect(tx + (tw * i) / 10, ty, 1, 6);
    c.fillStyle = C.fg; c.fillRect(tx + tw * k - 1, ty - 3, 2, 12);
  }
}

function nameplate(c: CanvasRenderingContext2D, B: NonNullable<typeof S.boss> | null, E: NonNullable<typeof S.elite> | null) {
  const w = 760, x = W / 2 - w / 2, y = 12, h = 66;
  plate(c, x, y, w, h, { stripe: C.hostile });
  const k = B ? clamp(B.hp / B.maxHp, 0, 1) : clamp(E!.hp / E!.maxHp, 0, 1);
  const lag = B ? st.bossLag : st.eliteLag;
  const name = B ? (B.ghost.ai ? `${B.ghost.name}` : `GHOST OF ${B.ghost.name}`) : `${(EN[E!.type].name || 'ELITE').toUpperCase()}`;
  const tag = B ? (B.ghost.ai ? 'DEFENSE CORE' : 'GHOST DREADNOUGHT') : 'ELITE CONTACT';
  drawIcon(c, B ? 'spectre' : 'crowned-skull', x + 30, y + 37, 30, C.hostile);
  c.font = `20px ${F_STEN}`; c.fillStyle = C.hostile; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(name.toUpperCase(), x + 56, y + 32);
  label(c, tag, x + w - 16, y + 30, C.dim, 11, 'right');
  const bx = x + 56, bw = w - 72, by = y + 42, bh = 12;
  c.fillStyle = '#05080b'; c.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
  c.fillStyle = 'rgba(255,240,220,.85)'; c.fillRect(bx, by, bw * lag, bh);
  const g = c.createLinearGradient(0, by, 0, by + bh); g.addColorStop(0, '#ffb3a8'); g.addColorStop(0.35, C.hostile); g.addColorStop(1, '#8c241c');
  c.fillStyle = g; c.fillRect(bx, by, bw * k, bh);
  c.fillStyle = 'rgba(0,0,0,.55)'; for (let i = 1; i < 20; i++) c.fillRect(bx + (bw * i) / 20, by, 1, bh);
  // phase notches: a ghost escalates at each (BOSS_PHASES); elites enrage at half hull
  c.fillStyle = C.fg; for (const f of B ? BOSS_PHASES : [0.5]) c.fillRect(bx + bw * f - 1, by - 5, 2, bh + 10);
  if (B && B.shieldMax) { c.fillStyle = C.plasma; c.fillRect(bx, by - 1, (bw * B.shield) / B.shieldMax, 3); }
  if (B && !B.ghost.ai) label(c, `FELL ON FLOOR ${B.ghost.floor + 1}`, x + w - 16, y + 62, C.faint, 9, 'right');
}

/* ---------------- weapons: numbered HEAVY groups and the AUTO lamp bank ---------------- */
const LAYER_TAG_COL: Record<string, string> = { AIR: C.plasma, GND: C.hazard, ALL: C.violet, PD: '#b8f2c8' };
/** Reload fraction 0..1 of a mounted weapon (1 = loaded), and whether it just fired (HUD flash). */
function reload(p: Part, cd: number): { ready: number; flash: number } {
  const P = S.P!;
  const full = (wCd(p) * (p.id === 'rail' ? P.dv.mods.railCdMul : 1)) / Math.max(0.2, P.dv.fireMult);
  const prev = st.lastCd.get(p.uid) ?? cd;
  if ((Number.isFinite(cd) && Number.isFinite(prev) && cd > prev + 0.02) || (!Number.isFinite(prev) && Number.isFinite(cd))) st.fired.set(p.uid, st.t);
  st.lastCd.set(p.uid, cd);
  const ready = !Number.isFinite(cd) ? 1 : clamp(1 - cd / Math.max(0.05, full), 0, 1);
  return { ready, flash: clamp(1 - (st.t - (st.fired.get(p.uid) ?? -9)) / 0.16, 0, 1) };
}
/** A pie lamp: the reload sweeps round, it rings white when the gun fires. */
function reloadPip(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, ready: number, flash: number, dead = false) {
  c.fillStyle = '#05080b'; c.beginPath(); c.arc(x, y, r + 1.5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#18212a'; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  if (!dead) {
    c.fillStyle = ready >= 1 ? col : shade(col, 0.55);
    c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ready); c.closePath(); c.fill();
  }
  if (flash > 0) { c.save(); c.globalAlpha = flash; c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 2 + (1 - flash) * 4, 0, Math.PI * 2); c.stroke(); c.restore(); }
}
function keycap(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, lit: boolean, col: string) {
  c.fillStyle = '#05080b'; c.fillRect(x, y + 2, w, h);
  c.fillStyle = lit ? col : '#26313c'; c.fillRect(x, y + (lit ? 1 : 0), w, h);
  c.strokeStyle = '#000'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5 + (lit ? 1 : 0), w - 1, h - 1);
  c.font = `13px ${F_MONO}`; c.fillStyle = lit ? '#120c04' : C.fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, x + w / 2, y + h / 2 + (lit ? 2 : 1)); c.textBaseline = 'alphabetic';
}
/** Layers a group or a mount engages, as one tag: every mount in a group shares it unless placement differs (MIX). */
function groupTag(ms: Mount[]) {
  const tags = new Set(ms.map((m) => LAYERS_TAG[m.trav.layers]));
  return tags.size === 1 ? [...tags][0] : 'MIX';
}
const SLOT_W = 138, SLOT_H = 66;
function weapons(c: CanvasRenderingContext2D) {
  const P = S.P!, groups = S.groups ?? [], autos = autoMounts(P.dv.mounts);
  if (!groups.length && !autos.length) return;
  const manual = gunnery.manual, autoW = autos.length ? Math.max(92, 18 + autos.length * 30) : 0;
  const w = 24 + groups.length * (SLOT_W + 8) + (autos.length ? autoW + 8 : 0) - 8, h = manual && groups.length ? 112 : 96;
  const x = 14, y = H - 14 - h;
  plate(c, x, y, w, h);
  label(c, groups.length ? (manual ? 'HEAVY · AIMED' : 'HEAVY · AUTO-AIM') : 'NO HEAVY ORDNANCE', x + 12, y + 18, C.faint, 10);
  const firing = manual ? firingGroups() : [];
  groups.forEach((g, gi) => {
    const sx = x + 12 + gi * (SLOT_W + 8), sy = y + 24, act = manual && gi === aim.group, hot = firing.includes(g);
    // slot well
    c.fillStyle = act ? 'rgba(242,165,65,.10)' : '#0b1015'; c.fillRect(sx, sy, SLOT_W, SLOT_H);
    c.strokeStyle = act ? C.hazard : '#000'; c.lineWidth = act ? 2 : 1; c.strokeRect(sx + (act ? 1 : 0.5), sy + (act ? 1 : 0.5), SLOT_W - (act ? 2 : 1), SLOT_H - (act ? 2 : 1));
    if (hot) { c.save(); c.globalAlpha = 0.25 + 0.2 * Math.sin(st.t * 30); c.fillStyle = g.def.col; c.fillRect(sx, sy, SLOT_W, 3); c.restore(); }
    keycap(c, sx + 6, sy + 6, 20, 20, String(g.key), act, C.hazard);
    drawIcon(c, g.def.icon, sx + 42, sy + 16, 20, act ? g.def.col : shade(g.def.col, 0.7));
    c.font = `12px ${F_STEN}`; c.fillStyle = act ? C.fg : C.dim; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillText(g.def.slot, sx + 56, sy + 21);
    // target-layer tag and bearing state
    const tag = groupTag(g.mounts);
    label(c, tag, sx + 8, sy + 44, LAYER_TAG_COL[tag] ?? C.dim, 9);
    // one reload pip per mount, dimmed when it cannot bear on the reticle
    g.mounts.forEach((m, mi) => {
      const p = m.part!, r = reload(p, P.cds[p.uid] ?? 0), bears = !manual || aim.bears[p.uid] !== false;
      reloadPip(c, sx + 40 + mi * 18, sy + 40, 6, bears ? g.def.col : '#5d6e7e', r.ready, r.flash);
    });
    const nb = g.mounts.filter((m) => aim.bears[m.part!.uid] !== false).length;
    // NO BEARING, or BLOCKED when the ship's own hull masks the bearing for every mount in the group
    const blocked = g.mounts.every((m) => aim.why[m.part!.uid] === 'blocked');
    const state = !manual ? 'AUTO' : nb === g.mounts.length ? 'READY' : nb ? `${nb}/${g.mounts.length} BEAR` : blocked ? 'BLOCKED' : 'NO BEARING';
    label(c, `×${g.mounts.length}`, sx + SLOT_W - 8, sy + 44, C.dim, 10, 'right');
    label(c, state, sx + 8, sy + SLOT_H - 7, state === 'NO BEARING' || state === 'BLOCKED' ? C.hazard : act ? C.dim : C.faint, 9);
  });
  if (autos.length) {
    const ax = x + 12 + groups.length * (SLOT_W + 8), ay = y + 24;
    c.fillStyle = '#0b1015'; c.fillRect(ax, ay, autoW, SLOT_H); c.strokeStyle = '#000'; c.lineWidth = 1; c.strokeRect(ax + 0.5, ay + 0.5, autoW - 1, SLOT_H - 1);
    const anyLit = autos.some((m) => (st.fired.get(m.part!.uid) ?? -9) > st.t - 0.3);
    lampDot(c, ax + 12, ay + 13, 4, C.good, anyLit ? 1 : 0.5);
    label(c, 'AUTO', ax + 22, ay + 17, C.good, 10);
    autos.forEach((m, i) => {
      const p = m.part!, r = reload(p, P.cds[p.uid] ?? 0), cx = ax + 18 + i * 30, cy = ay + 36;
      const col = LAYER_TAG_COL[LAYERS_TAG[m.trav.layers]] ?? C.fg;
      lampDot(c, cx, cy, 5, r.flash > 0 ? '#ffffff' : col, r.flash > 0 ? 1 : 0.25 + 0.65 * r.ready * r.ready);
      label(c, CODE[p.id] ?? p.id.slice(0, 3).toUpperCase(), cx, cy + 17, C.faint, 8, 'center');
      label(c, LAYERS_TAG[m.trav.layers], cx, cy + 26, shade(col, 0.8), 7, 'center');
    });
  }
  if (manual && groups.length) {
    const keys = groups.length > 1 ? `1-${groups.length} / Q E / WHEEL SELECT` : '';
    label(c, `LMB FIRE GROUP · RMB SALVO ALL${keys ? ' · ' + keys : ''} · SHIFT/T FLIR`, x + 12, y + h - 8, C.faint, 9);
  }
}

/* ---------------- the reticle: where the heavy groups will land ---------------- */
const WHY_TEXT: Record<string, string> = { arc: 'OUT OF ARC', blocked: 'BLOCKED', range: 'OUT OF REACH', air: 'AIR ONLY', ground: 'GROUND ONLY' };
/** A traverse sector (ship space) as a wedge from field point (x, y) out to radius R, through the camera (so a masked
 *  arc in two pieces draws as two wedges, and the hull's shadow between them as its own). */
function wedge(c: CanvasRenderingContext2D, x: number, y: number, sct: Sector, R: number) {
  const a0 = shipToField(sct.c - sct.h), n = Math.max(3, Math.ceil(sct.h * 10));
  const o = fieldToScreen(x, y); c.beginPath(); c.moveTo(o.x, o.y);
  for (let i = 0; i <= n; i++) { const a = a0 + (2 * sct.h * i) / n, q = fieldToScreen(x + Math.cos(a) * R, y + Math.sin(a) * R); c.lineTo(q.x, q.y); }
  c.closePath();
}
function brackets(c: CanvasRenderingContext2D, x: number, y: number, r: number, len: number) {
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    c.beginPath(); c.moveTo(x + sx * r, y + sy * (r - len)); c.lineTo(x + sx * r, y + sy * r); c.lineTo(x + sx * (r - len), y + sy * r); c.stroke();
  }
}
function reticle(c: CanvasRenderingContext2D) {
  const P = S.P!, groups = S.groups ?? [];
  if (!gunnery.manual || !groups.length || S.mode !== 'play') return;
  const sel = groups[aim.group] ?? groups[0], act = aim.salvo ? groups : [sel];
  const ms = act.flatMap((g) => g.mounts), bearing = ms.filter((m) => aim.bears[m.part!.uid] !== false);
  const can = bearing.length > 0, col = can ? (aim.salvo ? C.hazard : sel.def.col) : '#7d8a96';
  // aim is a field point; draw it where the camera shows it (src/render/view.ts)
  const sp = fieldToScreen(aim.x, aim.y), x = sp.x, y = sp.y, zs = screenScale(aim.x, aim.y);
  const punch = clamp(1 - (S.t - aim.shotAt) / 0.18, 0, 1);
  const pulling = aim.fire || aim.salvo;
  c.save();
  c.lineCap = 'square';
  // ground ordnance: the impact ring on the city, and the reach of each ventral mount when the reticle is beyond it
  if (act.some((g) => g.def.aim === 'ground')) {
    const g = act.find((q) => q.def.aim === 'ground')!, rad = (g.family === 'bomb' ? 50 : 40) * zs;
    c.strokeStyle = can ? g.def.col : '#7d8a96'; c.globalAlpha = 0.85; c.lineWidth = 2;
    c.setLineDash([7, 5]); c.lineDashOffset = -st.t * 30;
    c.beginPath(); c.ellipse(x, y, rad, rad * 0.92, 0, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    c.globalAlpha = 0.18; c.fillStyle = can ? g.def.col : '#7d8a96'; c.beginPath(); c.ellipse(x, y, rad, rad * 0.92, 0, 0, Math.PI * 2); c.fill();
    if (act.some((q) => q.def.aim === 'ground' && q.mounts.some((m) => aim.why[m.part!.uid] === 'range'))) {
      for (const q of act) if (q.def.aim === 'ground') for (const m of q.mounts) {
        c.globalAlpha = 0.35; c.strokeStyle = q.def.col; c.lineWidth = 1.5; c.setLineDash([4, 8]);
        const mp = fieldToScreen(P.x + m.ox, P.y + m.oy);
        c.beginPath(); c.arc(mp.x, mp.y, q.def.reach * zs, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
      }
    }
    c.globalAlpha = 1;
  }
  // rails: a firing line from every gun that bears; the masked traverse of those that do not (every open sector, and the
  // bearings the hull blocks in hostile red)
  for (const g of act) if (g.def.aim === 'line') for (const m of g.mounts) {
    const mx0 = P.x + m.ox, my0 = P.y + m.oy, mp = fieldToScreen(mx0, my0), mx = mp.x, my = mp.y;
    if (aim.bears[m.part!.uid] !== false) {
      c.strokeStyle = g.def.col; c.globalAlpha = pulling ? 0.7 : 0.35; c.lineWidth = 1.2; c.setLineDash([10, 6]); c.lineDashOffset = -st.t * 60;
      c.beginPath(); c.moveTo(mx, my); c.lineTo(x, y); c.stroke(); c.setLineDash([]);
    } else {
      c.fillStyle = g.def.col; c.globalAlpha = 0.12;
      for (const sct of m.trav.sectors) { wedge(c, mx0, my0, sct, 260); c.fill(); }
      c.fillStyle = C.hostile; c.globalAlpha = aim.why[m.part!.uid] === 'blocked' ? 0.22 : 0.1;
      for (const sct of m.trav.blocked) { wedge(c, mx0, my0, sct, 200); c.fill(); }
    }
    c.globalAlpha = 1;
  }
  // missiles: lock brackets close in on the target nearest the reticle
  if (act.some((g) => g.family === 'missile')) {
    const L = aim.lock;
    if (L && !L.dead) {
      // grey when no missile mount can take this lock (a top-deck pod on a ground target)
      const takes = act.some((g) => g.family === 'missile' && g.mounts.some((m) => aim.bears[m.part!.uid] !== false));
      const k = clamp(aim.lockT / 0.25, 0, 1), rr = (L.isBoss ? Math.min(90, L.halfW * 0.5) : L.r + 12) * (2 - k);
      const lp = fieldToScreen(L.x, L.y), lx = lp.x, ly = lp.y;
      c.save(); c.translate(lx, ly); c.rotate((1 - k) * Math.PI / 4);
      c.strokeStyle = takes ? '#ff9f5a' : '#7d8a96'; c.lineWidth = 2.5; brackets(c, 0, 0, rr, rr * 0.45);
      c.restore();
      if (k >= 1 && takes) { label(c, 'LOCK', lx + rr + 6, ly - rr + 4, '#ff9f5a', 11, 'left'); c.strokeStyle = 'rgba(255,159,90,.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(lx, ly); c.stroke(); }
    }
  }
  // the reticle itself
  const s = 1 + punch * 0.35, r = 22 * s;
  c.strokeStyle = 'rgba(5,8,11,.9)'; c.lineWidth = 6; brackets(c, x, y, r, 10);
  c.strokeStyle = col; c.lineWidth = 2.8; brackets(c, x, y, r, 10);
  if (pulling && can) { c.save(); c.globalAlpha = 0.5 + 0.5 * Math.sin(st.t * 40); c.lineWidth = 1.2; brackets(c, x, y, r + 5, 6); c.restore(); }
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    c.strokeStyle = 'rgba(5,8,11,.9)'; c.lineWidth = 4; c.beginPath(); c.moveTo(x + dx * 5, y + dy * 5); c.lineTo(x + dx * 12, y + dy * 12); c.stroke();
    c.strokeStyle = col; c.lineWidth = 1.8; c.beginPath(); c.moveTo(x + dx * 5, y + dy * 5); c.lineTo(x + dx * 12, y + dy * 12); c.stroke();
  }
  c.fillStyle = '#fff'; c.fillRect(x - 1, y - 1, 2, 2);
  if (!can) { c.strokeStyle = '#7d8a96'; c.lineWidth = 2; c.beginPath(); c.moveTo(x - r * 0.8, y + r * 0.8); c.lineTo(x + r * 0.8, y - r * 0.8); c.stroke(); }
  // reload ring: one arc per mount in the active group(s)
  const n = ms.length, gap = n > 1 ? 0.18 : 0, R = r + 9;
  ms.forEach((m, i) => {
    const p = m.part!, cd = S.P!.cds[p.uid] ?? 0, full = (wCd(p) * (p.id === 'rail' ? P.dv.mods.railCdMul : 1)) / Math.max(0.2, P.dv.fireMult);
    const ready = clamp(1 - cd / Math.max(0.05, full), 0, 1), a0 = -Math.PI / 2 + (i / n) * Math.PI * 2 + gap / 2, span = Math.PI * 2 / n - gap;
    const ok = aim.bears[p.uid] !== false;
    c.strokeStyle = 'rgba(5,8,11,.9)'; c.lineWidth = 6; c.beginPath(); c.arc(x, y, R, a0, a0 + span); c.stroke();
    c.strokeStyle = ok ? (ready >= 1 ? col : shade(col, 0.6)) : '#4a5561'; c.lineWidth = 3.5; c.beginPath(); c.arc(x, y, R, a0, a0 + span * ready); c.stroke();
  });
  // tag: group key and name, and why it cannot bear
  const why = can ? '' : WHY_TEXT[aim.why[ms[0].part!.uid] || 'arc'] ?? 'NO BEARING';
  const tx = x + R + 10, ty = y + 4;
  c.font = `12px ${F_STEN}`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  const name = aim.salvo ? 'SALVO · ALL GROUPS' : `${sel.key} · ${sel.def.short}`;
  const tw = Math.max(c.measureText(name).width, why ? 84 : 0) + 12;
  c.fillStyle = 'rgba(8,10,13,.7)'; c.fillRect(tx - 4, ty - 14, tw, why ? 30 : 18);
  c.fillStyle = col; c.fillText(name, tx + 2, ty);
  if (why) label(c, why, tx + 2, ty + 12, C.hazard, 9);
  else if (bearing.length < ms.length) label(c, `${bearing.length}/${ms.length} BEAR`, tx + 2, ty + 12, C.dim, 9);
  // teach the trigger in the first seconds of the first fights
  if (!st.everFired && S.time < 14) {
    const kx = x - 44, ky = y + R + 14, on = Math.floor(st.t * 3) % 2 === 0;
    c.globalAlpha = on ? 1 : 0.6;
    keycap(c, kx, ky, 88, 20, 'HOLD LMB', on, C.hazard);
    c.globalAlpha = 1;
  }
  if (pulling && can) st.everFired = true;
  c.restore();
}

/* ---------------- overdrive: the unmissable gauge ---------------- */
function overdrive(c: CanvasRenderingContext2D) {
  const o = S.overdrive; if (!o) return;
  const def = OVERDRIVES[o.kind as OverdriveKind] ?? OVERDRIVES.lance;
  const ready = o.charge >= 1 && !o.active;
  const k = o.active ? clamp(o.t / Math.max(0.01, o.dur), 0, 1) : clamp(o.charge, 0, 1);
  const w = 236, h = 112, x = W - 14 - w, y = H - 14 - h;
  const pulse = 0.5 + 0.5 * Math.sin(st.t * 9);
  if (ready) { c.save(); c.globalAlpha = 0.35 + 0.35 * pulse; c.fillStyle = def.col; c.fillRect(x - 5, y - 5, w + 10, h + 10); c.restore(); }
  plate(c, x, y, w, h, { stripe: ready || o.active ? def.col : undefined });
  label(c, 'OVERDRIVE', x + 14, y + 24, ready ? def.col : C.faint, 10);
  c.font = `13px ${F_STEN}`; c.fillStyle = o.active || ready ? def.col : C.dim; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(def.name.toUpperCase(), x + 14, y + 42);
  // needle gauge (right side)
  const gx = x + w - 62, gy = y + 80, r = 46;
  c.fillStyle = '#e9e2cf'; c.beginPath(); c.arc(gx, gy, r, Math.PI, 0); c.closePath(); c.fill();
  c.strokeStyle = def.col; c.lineWidth = 5; c.beginPath(); c.arc(gx, gy, r - 7, -Math.PI * 0.12, 0); c.stroke();
  c.strokeStyle = '#2b2a26'; c.lineWidth = 1.4;
  for (let i = 0; i <= 10; i++) { const a = Math.PI + (i / 10) * Math.PI, r0 = i % 5 ? r - 6 : r - 11; c.beginPath(); c.moveTo(gx + Math.cos(a) * r0, gy + Math.sin(a) * r0); c.lineTo(gx + Math.cos(a) * (r - 2), gy + Math.sin(a) * (r - 2)); c.stroke(); }
  st.odNeedle += (k - st.odNeedle) * (o.active ? 0.3 : 0.12);
  const jitter = ready ? Math.sin(st.t * 47) * 0.012 : o.active ? Math.sin(st.t * 63) * 0.02 : 0;
  const a = Math.PI + clamp(st.odNeedle + jitter, 0, 1.03) * Math.PI;
  c.strokeStyle = '#b6271b'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + Math.cos(a) * (r - 6), gy + Math.sin(a) * (r - 6)); c.stroke();
  c.fillStyle = '#20262c'; c.beginPath(); c.arc(gx, gy, 4.5, 0, Math.PI * 2); c.fill();
  // readout and prompt (left side)
  if (o.active) {
    c.font = `26px ${F_MONO}`; c.fillStyle = def.col; c.fillText(`${o.t.toFixed(1)}s`, x + 14, y + 80);
    label(c, 'BATTERIES 1.5×', x + 14, y + 98, C.dim, 9);
  } else if (ready) {
    // the SPACE keycap, punched in and flashing
    const kx = x + 14, ky = y + 56, kw = 84, kh = 32, on = Math.floor(st.t * 4) % 2 === 0;
    c.fillStyle = '#05080b'; c.fillRect(kx, ky + 4, kw, kh);
    c.fillStyle = on ? def.col : shade(def.col, 0.55); c.fillRect(kx, ky + (on ? 2 : 0), kw, kh);
    c.strokeStyle = '#000'; c.strokeRect(kx + 0.5, ky + 0.5 + (on ? 2 : 0), kw - 1, kh - 1);
    c.font = `15px ${F_MONO}`; c.fillStyle = '#120c04'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('SPACE', kx + kw / 2, ky + kh / 2 + (on ? 2 : 0)); c.textBaseline = 'alphabetic';
    label(c, 'READY', x + 14, y + 104, def.col, 10);
  } else {
    c.font = `26px ${F_MONO}`; c.fillStyle = C.fg; c.textAlign = 'left'; c.fillText(`${Math.floor(k * 100)}%`, x + 14, y + 80);
    label(c, 'CHARGE ON KILLS', x + 14, y + 98, C.faint, 9);
  }
  // a prompt near the ship too, so it is never missed in the thick of it
  if (ready && S.P && S.mode === 'play') {
    const px = S.P.x, py = Math.min(H - 40, S.P.y + P_PROMPT_DY);
    c.save(); c.globalAlpha = 0.55 + 0.45 * pulse;
    c.font = `14px ${F_STEN}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const t = `SPACE · ${def.name.toUpperCase()}`, tw = c.measureText(t).width + 26;
    c.fillStyle = 'rgba(8,10,13,.75)'; c.fillRect(px - tw / 2, py - 13, tw, 26);
    c.strokeStyle = def.col; c.lineWidth = 2; c.strokeRect(px - tw / 2, py - 13, tw, 26);
    c.fillStyle = def.col; c.fillText(t, px, py + 1);
    c.restore();
  }
}
const P_PROMPT_DY = 120;

/* ---------------- carnage: VU ladder and multiplier, punches on tier-up ---------------- */
function carnage(c: CanvasRenderingContext2D) {
  const cg = S.carnage; if (!cg) return;
  const w = 120, h = 112, x = W - 14 - 236 - 10 - w, y = H - 14 - h;
  const punch = clamp(1 - (st.t - st.tierAt) / 0.45, 0, 1);
  plate(c, x, y, w, h, { stripe: punch > 0 ? C.hazard : undefined });
  label(c, 'CARNAGE', x + 12, y + 24, cg.mult > 1.05 ? C.hazard : C.faint, 10);
  const n = 12, sx = x + 14, sy = y + 32, fill = clamp((cg.mult - 1) / 2, 0, 1);
  for (let i = 0; i < n; i++) {
    const on = fill * n > i + 0.01, col = i >= 9 ? C.hostile : i >= 5 ? C.hazard : C.good;
    c.fillStyle = on ? col : '#18212a'; c.fillRect(sx, sy + (n - 1 - i) * 6, 20, 4);
  }
  const s = 1 + punch * 0.5;
  c.save(); c.translate(x + 76, y + 70); c.scale(s, s);
  c.font = `26px ${F_MONO}`; c.fillStyle = punch > 0 ? '#fff1d6' : cg.mult >= 2.5 ? C.hostile : cg.mult > 1.05 ? C.crt : C.dim;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(`×${cg.mult.toFixed(1)}`, 0, 0);
  c.restore();
  label(c, 'SCRAP', x + 76, y + 98, C.faint, 9, 'center');
}

/** Fold sim events into HUD state: carnage tier-ups. */
function consumeEvents() {
  const ev = (S as unknown as { events?: { id: number; type: string; n?: number }[] }).events;
  if (!ev) return;
  for (const e of ev) {
    if (e.id <= st.lastEvent) continue;
    st.lastEvent = e.id;
    if (e.type === 'carnageTier') st.tierAt = st.t;
  }
}

/* ---------------- slow-mo letterbox ---------------- */
function letterbox(c: CanvasRenderingContext2D) {
  const k = (S as unknown as { slowFx?: number }).slowFx ?? 0;
  if (k <= 0.01) return;
  const bh = 64 * k;
  c.fillStyle = '#000'; c.fillRect(0, 0, W, bh); c.fillRect(0, H - bh, W, bh);
}

/* ---------------- off-screen threats ---------------- */
function edgeAnchor(ang: number, l: number, t: number, r: number, b: number) {
  const cx = (l + r) / 2, cy = (t + b) / 2, hx = (r - l) / 2, hy = (b - t) / 2;
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const k = Math.min(Math.abs(cs) < 1e-6 ? Infinity : hx / Math.abs(cs), Math.abs(sn) < 1e-6 ? Infinity : hy / Math.abs(sn));
  return { x: cx + cs * k, y: cy + sn * k };
}
/** Rear entries holding off the bottom edge (e.warnT): a pulsing double chevron where they will break in, marked ASTERN,
 *  with a bar that fills as they come. One marker per group. */
function asternWarnings(c: CanvasRenderingContext2D) {
  const marks: { x: number; k: number }[] = [];
  for (const e of S.enemies) {
    if (e.dead || !(e.warnT > 0)) continue;
    const x = clamp(fieldToScreen(clamp(e.x, 30, W - 30), H).x, 46, W - 46), k = 1 - e.warnT / AFT.warn;
    const m = marks.find((q) => Math.abs(q.x - x) < 90);
    if (m) m.k = Math.max(m.k, k); else marks.push({ x, k });
  }
  if (!marks.length) return;
  const pulse = 0.5 + 0.5 * Math.sin(st.t * 16);
  c.save();
  for (const m of marks) {
    const y = H - 46;
    c.save(); c.translate(m.x, y); c.globalAlpha = 0.6 + 0.4 * pulse;
    c.fillStyle = C.hostile; c.strokeStyle = 'rgba(10,14,19,.9)'; c.lineWidth = 2; c.lineJoin = 'round';
    for (const dy of [0, 11]) { c.beginPath(); c.moveTo(0, -12 + dy - pulse * 3); c.lineTo(13, 2 + dy); c.lineTo(6, 2 + dy); c.lineTo(0, -4 + dy); c.lineTo(-6, 2 + dy); c.lineTo(-13, 2 + dy); c.closePath(); c.stroke(); c.fill(); }
    c.restore();
    label(c, 'ASTERN', m.x, y - 22, C.hostile, 11, 'center');
    c.fillStyle = 'rgba(8,10,13,.7)'; c.fillRect(m.x - 24, y + 18, 48, 4);
    c.fillStyle = C.hostile; c.fillRect(m.x - 24, y + 18, 48 * m.k, 4);
  }
  c.restore();
}
function threats(c: CanvasRenderingContext2D) {
  asternWarnings(c);
  const list: { x: number; y: number; big: boolean }[] = [];
  for (const e of S.enemies) {
    if (e.dead || e.hp <= 0 || EN[e.type]?.salvage || e.warnT > 0) continue;
    if (e.x > -8 && e.x < W + 8 && e.y > -8 && e.y < H + 8) continue;
    if (e.x < -320 || e.x > W + 320 || e.y < -320 || e.y > H + 320) continue;
    list.push({ x: e.x, y: e.y, big: !!EN[e.type]?.elite });
  }
  const B = S.boss;
  if (B && B.alive && (B.y < -20 || B.y > H + 20)) list.push({ x: B.x, y: B.y, big: true });
  if (!list.length) return;
  const cx = W / 2, cy = H / 2;
  c.save();
  for (const t of list.slice(0, 14)) {
    const ang = Math.atan2(t.y - cy, t.x - cx), a = edgeAnchor(ang, 26, 104, W - 26, H - 26);
    const dist = Math.max(0, Math.max(-t.x, t.x - W, -t.y, t.y - H));
    const near = 1 - clamp(dist / 320, 0, 1), pulse = 0.5 + 0.5 * Math.sin(st.t * (t.big ? 14 : 8));
    const s = t.big ? 1.5 : 1;
    c.save(); c.translate(a.x, a.y); c.globalAlpha = 0.45 + 0.55 * near;
    if (t.big) { c.strokeStyle = C.hostile; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 17 + pulse * 3, 0, Math.PI * 2); c.stroke(); }
    c.rotate(ang); c.scale(s, s);
    c.fillStyle = C.hostile; c.strokeStyle = 'rgba(10,14,19,.9)'; c.lineWidth = 2; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(10 + pulse * 2, 0); c.lineTo(-5, -8); c.lineTo(-1, 0); c.lineTo(-5, 8); c.closePath(); c.stroke(); c.fill();
    c.restore();
  }
  c.restore();
}

/* ---------------- banner: a stencil stamp ---------------- */
function banner(c: CanvasRenderingContext2D) {
  const b = S.banner; if (!b) { st.bannerKey = ''; return; }
  const key = b.text + b.max;
  if (key !== st.bannerKey) st.bannerKey = key;
  const age = b.max - b.t, out = b.t;
  const slam = clamp(age / 0.16, 0, 1), fade = clamp(out / 0.35, 0, 1);
  const scale = slam < 1 ? 1.6 - 0.6 * (1 - (1 - slam) ** 3) : 1 + (1 - fade) * 0.04;
  const alpha = Math.min(slam * 1.4, fade);
  if (alpha <= 0) return;
  const cy = H * 0.34;
  c.save();
  c.translate(W / 2, cy); c.rotate(-0.035); c.scale(scale, scale); c.globalAlpha = alpha;
  c.font = `52px ${F_STEN}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  const tw = c.measureText(b.text).width, bw = tw + 84, bh = 84;
  c.fillStyle = 'rgba(8,10,13,.55)'; c.fillRect(-bw / 2, -bh / 2, bw, bh);
  c.strokeStyle = b.col; c.lineWidth = 4; c.strokeRect(-bw / 2, -bh / 2, bw, bh);
  c.lineWidth = 1.5; c.strokeRect(-bw / 2 + 8, -bh / 2 + 8, bw - 16, bh - 16);
  c.fillStyle = b.col; c.fillText(b.text, 0, 3);
  // ink voids: a few knocked-out flecks so it reads as a stamp, stable per banner
  c.globalCompositeOperation = 'destination-out';
  let seed = 0; for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 0; i < 26; i++) { seed = (seed * 1103515245 + 12345) >>> 0; const fx = ((seed % 1000) / 1000 - 0.5) * bw; seed = (seed * 1103515245 + 12345) >>> 0; const fy = ((seed % 1000) / 1000 - 0.5) * bh; c.fillRect(fx, fy, 2 + (seed % 5), 1 + (seed % 2)); }
  c.globalCompositeOperation = 'source-over';
  if (b.sub) {
    c.font = `15px ${F_MONO}`;
    const sw = c.measureText(b.sub).width + 28;
    c.rotate(0.05);
    c.fillStyle = '#1b1c20'; c.fillRect(-sw / 2, bh / 2 + 12, sw, 26);
    c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(-sw / 2, bh / 2 + 12, sw, 1);
    c.fillStyle = '#f4efe2'; c.fillText(b.sub.toUpperCase(), 0, bh / 2 + 26);
  }
  c.restore();
}

/* ---------------- entry ---------------- */
export function drawHud(c: CanvasRenderingContext2D, scale: number, dpr: number, totalScrap: number) {
  const now = performance.now() / 1000;
  const dt = st.last ? Math.min(0.1, now - st.last) : 0; st.last = now; st.t += dt;
  c.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  VIG ||= mkV('rgba(0,0,0,0)', 'rgba(0,0,0,.5)'); HURT ||= mkV('rgba(255,40,30,0)', 'rgba(255,40,30,.75)');
  c.drawImage(VIG, -10, -10, W + 20, H + 20);
  if (V.hurt > 0) { c.globalAlpha = Math.min(1, V.hurt * 0.75); c.drawImage(HURT, -10, -10, W + 20, H + 20); c.globalAlpha = 1; }
  if (V.flashA > 0) { c.globalCompositeOperation = 'lighter'; c.globalAlpha = V.flashA; c.fillStyle = '#fff1d6'; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; }
  const P = S.P; if (!P) return;
  // new encounter: snap the lagging bars instead of draining from the last fight
  if (st.enc !== S.enc) { st.enc = S.enc; st.hpLag = P.hp / P.dv.maxHp; st.shLag = 1; st.bossLag = 1; st.eliteLag = 1; st.lastScrap = -1; st.gains = []; st.scrapShown = totalScrap; st.fired.clear(); st.lastCd.clear(); st.odNeedle = S.overdrive?.charge ?? 0; st.lastEvent = (S as unknown as { eventId?: number }).eventId ?? 0; }
  const ease = (lag: number, v: number) => (v >= lag ? v : Math.max(v, lag - dt * 0.35 * (lag - v < 0.02 ? 4 : 1)));
  st.hpLag = ease(st.hpLag, clamp(P.hp / P.dv.maxHp, 0, 1));
  st.shLag = ease(st.shLag, P.dv.shieldMax ? clamp(P.shield / P.dv.shieldMax, 0, 1) : 0);
  if (S.boss) st.bossLag = ease(st.bossLag, clamp(S.boss.hp / S.boss.maxHp, 0, 1));
  if (S.elite) st.eliteLag = ease(st.eliteLag, clamp(S.elite.hp / S.elite.maxHp, 0, 1));
  consumeEvents();
  drawSymbology(c, st.t);
  letterbox(c);
  threats(c);
  hullCluster(c);
  encounterPlate(c);
  scrapCluster(c, totalScrap);
  pauseKey(c);
  weapons(c);
  carnage(c);
  overdrive(c);
  banner(c);
  reticle(c);
}
