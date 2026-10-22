// Tactical symbology: the fire-control computer's picture of every hostile, drawn on the HUD canvas at a fixed
// screen size over true-scale units (docs/ART.md "Readability"). A 10 m tank is ~6 pixels from up here; its
// marker is not.
//
//   Layers (marks.ts) must read at a glance, since our guns are layer-restricted:
//     AIR in hostile red: an open tent frame (NATO hostile air, the diamond's upper half) riding at flight altitude
//     with a slight bob, and a faint dashed drop line down to a pip on the aircraft's shadow on the city.
//     GROUND in burnt amber: a closed, filled diamond (NATO hostile ground) and a faint ring decal flat on the
//     ground round the unit's footprint.
//     SALVAGE in scrap gold, a neutral square, smaller and dimmer (it never shoots); it keeps its layer's drop line
//     or ring. Symbol size says threat: drones and infantry small, SAM / flak / gunship / bomber large, elites larger.
//   Inside the frame, a class glyph: armour (track oval), infantry (cross),
//   AA guns (dome), SAM (dome + missile), flak tower (dome on a keep), rotary (bow tie), fixed wing (swept wing),
//   UAV (V), bomber (double wing), carrier (deck), crate, pod, wreck.
//   Units large on screen (batteries, towers, bombers, elites, wrecks) get thin corner brackets round their real
//   footprint plus a small tagged symbol instead: their size already says how dangerous they are.
//   Threat: units that can reach the hull are drawn at full strength, the rest at half. A unit winding up a shot
//   turns hot (pale) and a ring closes on it. Ground units under our hull fade to a ghost.
//   Clusters: small contacts of one class within GROUP_R merge into one marker with a count and member ticks.
//   Reticle: the target under it gets white lock brackets; a damaged unit shows a health tick.
//   FLIR (src/render/flir.ts): a camera frame, a fire-control readout and a zoomed thermal inset on the target.
//
// One canvas pass per frame, no per-frame allocation (contacts live in preallocated arrays).
import { S, aim, hullDist, type Enemy } from '../../game/combat';
import { EN, type EnemyType } from '../../data/enemies';
import { fieldToScreen, screenScale } from '../view';
import { visualHalf, TRUE_M, altShift, SHADOW_DX, SHADOW_DY, SHADOW_ALT } from './scale';
import { MARK, Tier, bob, type MarkStyle } from './marks';
import { FLIR } from '../flir';

const W = 1600, H = 900;
const enum Cls { Armour, Infantry, AAA, SAM, Fort, Rotary, Fixed, UAV, Bomber, Carrier, Crate, Pod, Wreck }
const CLS: Record<EnemyType, Cls> = {
  tank: Cls.Armour, crawler: Cls.Armour, infantry: Cls.Infantry, turret: Cls.AAA, sam: Cls.SAM, bunker: Cls.Fort,
  heli: Cls.Rotary, gunship: Cls.Rotary, ace: Cls.Rotary, jet: Cls.Fixed, drone: Cls.UAV, bomber: Cls.Bomber, carrier: Cls.Carrier,
  cache: Cls.Crate, canister: Cls.Pod, wreck: Cls.Wreck,
};
/** Designators for tagged (large) contacts and the FLIR readout. */
const TAG: Record<EnemyType, string> = {
  tank: 'ARMOR', crawler: 'CRAWLER', infantry: 'INF', turret: 'AAA', sam: 'SAM', bunker: 'FLAK', heli: 'HELO', gunship: 'GUNSHIP', ace: 'ACE',
  jet: 'FTR', drone: 'UAV', bomber: 'BOMBER', carrier: 'CARRIER', cache: 'CACHE', canister: 'POD', wreck: 'WRECK',
};
const COL = { dark: 'rgba(6,8,11,0.78)', lock: '#f2f6fa', flir: '#e8eef2' };
const DASH = [3, 3], SOLID: number[] = [];
const MONO = '"Share Tech Mono", ui-monospace, monospace';
/** Merge radius for clusters (screen units). A contact whose real half-footprint is wider than BIG gets a designator. */
const GROUP_R = 30, BIG = 10;

const MAX = 200;
const cx = new Float32Array(MAX), cy = new Float32Array(MAX), cr = new Float32Array(MAX), ca = new Float32Array(MAX), ctele = new Float32Array(MAX), chp = new Float32Array(MAX);
const ccls = new Uint8Array(MAX), cflag = new Uint8Array(MAX), cgrp = new Int16Array(MAX);
const cen: (Enemy | null)[] = new Array(MAX).fill(null);
/** Air contacts: screen position of their shadow on the city, and how strongly it shows (0 = none); bob phase. */
const cshx = new Float32Array(MAX), cshy = new Float32Array(MAX), csha = new Float32Array(MAX), cph = new Float32Array(MAX);
const F_AIR = 1, F_SALV = 2, F_BIG = 4, F_HOVER = 8, F_ELITE = 16;
// groups
const gx0 = new Float32Array(MAX), gy0 = new Float32Array(MAX), gx1 = new Float32Array(MAX), gy1 = new Float32Array(MAX), ga = new Float32Array(MAX), gtele = new Float32Array(MAX), ghp = new Float32Array(MAX);
const gn = new Uint16Array(MAX), gcls = new Uint8Array(MAX), gflag = new Uint8Array(MAX);
const gshx = new Float32Array(MAX), gshy = new Float32Array(MAX), gsha = new Float32Array(MAX);
const gst: (MarkStyle | null)[] = new Array(MAX).fill(null);
const COUNT = Array.from({ length: 100 }, (_, i) => String(i));

/** Per-enemy memory: when its marker appeared (fade in) and where it was (death splash). Pooled. */
interface Mem { born: number; x: number; y: number; cls: Cls; st: MarkStyle; seen: number }
const mem = new Map<Enemy, Mem>(), memFree: Mem[] = [];
/** Death splashes: a frame that opens and fades where a unit died. */
const SPL = 24, sx = new Float32Array(SPL), sy = new Float32Array(SPL), st0 = new Float32Array(SPL).fill(-9);
const sst: (MarkStyle | null)[] = new Array(SPL).fill(null);
let splHead = 0, frameNo = 0;

/* ---------------- shapes (paths only; the caller strokes) ---------------- */
function frame(c: CanvasRenderingContext2D, x: number, y: number, s: number, air: boolean, salv: boolean) {
  if (salv) { c.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6); return; }
  if (air) { c.moveTo(x - s, y + s * 0.6); c.lineTo(x - s, y); c.lineTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x + s, y + s * 0.6); return; }
  c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath();
}
/** Fill the current path with a translucent wash of col over a dark ground (the ground diamond is a solid chip). */
function wash(c: CanvasRenderingContext2D, col: string, a: number) {
  c.globalAlpha = a * 0.55; c.fillStyle = COL.dark; c.fill();
  c.globalAlpha = a * 0.3; c.fillStyle = col; c.fill();
}
function glyph(c: CanvasRenderingContext2D, cls: Cls, x: number, y: number, s: number) {
  const g = s * 0.46;
  switch (cls) {
    case Cls.Armour: c.moveTo(x + g, y); c.ellipse(x, y, g, g * 0.5, 0, 0, Math.PI * 2); break;
    case Cls.Infantry: c.moveTo(x - g * 0.7, y - g * 0.7); c.lineTo(x + g * 0.7, y + g * 0.7); c.moveTo(x + g * 0.7, y - g * 0.7); c.lineTo(x - g * 0.7, y + g * 0.7); break;
    case Cls.AAA: c.moveTo(x - g, y + g * 0.55); c.arc(x, y + g * 0.55, g, Math.PI, 0); break;
    case Cls.SAM: c.moveTo(x - g, y + g * 0.7); c.arc(x, y + g * 0.7, g, Math.PI, 0); c.moveTo(x, y + g * 0.3); c.lineTo(x, y - g); c.moveTo(x - g * 0.35, y - g * 0.55); c.lineTo(x, y - g); c.lineTo(x + g * 0.35, y - g * 0.55); break;
    case Cls.Fort: c.moveTo(x - g, y + g * 0.6); c.lineTo(x + g, y + g * 0.6); c.moveTo(x - g * 0.8, y + g * 0.6); c.arc(x, y + g * 0.6, g * 0.8, Math.PI, 0); c.moveTo(x, y - g * 0.2); c.lineTo(x, y - g); break;
    case Cls.Rotary: c.moveTo(x - g, y - g * 0.5); c.lineTo(x + g, y + g * 0.5); c.lineTo(x + g, y - g * 0.5); c.lineTo(x - g, y + g * 0.5); c.closePath(); break;
    case Cls.Fixed: c.moveTo(x - g, y + g * 0.35); c.lineTo(x, y - g * 0.35); c.lineTo(x + g, y + g * 0.35); c.moveTo(x, y - g * 0.8); c.lineTo(x, y + g * 0.7); break;
    case Cls.UAV: c.moveTo(x - g, y - g * 0.45); c.lineTo(x, y + g * 0.45); c.lineTo(x + g, y - g * 0.45); break;
    case Cls.Bomber: c.moveTo(x - g, y + g * 0.1); c.lineTo(x, y - g * 0.5); c.lineTo(x + g, y + g * 0.1); c.moveTo(x - g, y + g * 0.6); c.lineTo(x, y); c.lineTo(x + g, y + g * 0.6); break;
    case Cls.Carrier: c.rect(x - g, y - g * 0.4, g * 2, g * 0.8); c.moveTo(x - g * 0.4, y - g * 0.4); c.lineTo(x - g * 0.4, y + g * 0.4); break;
    case Cls.Crate: c.rect(x - g * 0.55, y - g * 0.55, g * 1.1, g * 1.1); break;
    case Cls.Pod: c.moveTo(x + g * 0.55, y); c.arc(x, y, g * 0.55, 0, Math.PI * 2); break;
    case Cls.Wreck: c.moveTo(x - g * 0.6, y - g * 0.6); c.lineTo(x + g * 0.6, y + g * 0.6); c.moveTo(x + g * 0.6, y - g * 0.6); c.lineTo(x - g * 0.6, y + g * 0.6); break;
  }
}
function corners(c: CanvasRenderingContext2D, x: number, y: number, hw: number, hh: number, len: number) {
  for (let i = 0; i < 4; i++) {
    const ix = i & 1 ? 1 : -1, iy = i & 2 ? 1 : -1, px = x + ix * hw, py = y + iy * hh;
    c.moveTo(px - ix * len, py); c.lineTo(px, py); c.lineTo(px, py - iy * len);
  }
}
/** Stroke the current path twice: a dark keyline for contrast over city light, then the colour. */
function ink(c: CanvasRenderingContext2D, col: string, a: number, w = 1.3) {
  c.globalAlpha = a * 0.8; c.strokeStyle = COL.dark; c.lineWidth = w + 2; c.stroke();
  c.globalAlpha = a; c.strokeStyle = col; c.lineWidth = w; c.stroke();
}
function hpTick(c: CanvasRenderingContext2D, x: number, y: number, w: number, k: number, a: number, col: string) {
  c.globalAlpha = a * 0.85; c.fillStyle = COL.dark; c.fillRect(x - w / 2 - 1, y - 1, w + 2, 3.2);
  c.globalAlpha = a; c.fillStyle = col; c.fillRect(x - w / 2, y, w * Math.max(0, k), 1.2);
}
/** An aircraft's link to the ground: a faint dashed drop line from under its box to a pip on its shadow. */
function dropLine(c: CanvasRenderingContext2D, x: number, y: number, shx: number, shy: number, col: string, a: number) {
  c.beginPath(); c.moveTo(x, y); c.lineTo(shx, shy);
  c.setLineDash(DASH); ink(c, col, a * 0.6, 1); c.setLineDash(SOLID);
}
function pip(c: CanvasRenderingContext2D, x: number, y: number, col: string, a: number) {
  c.beginPath(); c.moveTo(x + 3.2, y); c.ellipse(x, y, 3.2, 2.3, 0, 0, Math.PI * 2);
  c.globalAlpha = a * 0.6; c.fillStyle = COL.dark; c.fill(); ink(c, col, a * 0.85, 1.1);
}

/* ---------------- gather ---------------- */
let forgetNow = 0;
const AS = { x: 0, y: 0 };
function forget(m: Mem, e: Enemy) {
  if (m.seen === frameNo) return;
  if (e.hp <= 0 && m.x > 0 && m.x < W && m.y > 0 && m.y < H) { const i = splHead++ % SPL; sx[i] = m.x; sy[i] = m.y; st0[i] = forgetNow; sst[i] = m.st; }
  mem.delete(e); memFree.push(m);
}
function gather(now: number): number {
  frameNo++;
  const P = S.P; let n = 0;
  for (const e of S.enemies as Enemy[]) {
    if (e.dead || e.hp <= 0 || n >= MAX) continue;
    const d = EN[e.type]; if (!d) continue;
    const alt = (e as { visAlt?: number }).visAlt ?? 0;
    const p = alt > 1 ? fieldToScreen(altShift(e.x, e.y, alt, AS).x, AS.y) : fieldToScreen(e.x, e.y), px = p.x, py = p.y;
    if (px < -12 || px > W + 12 || py < -12 || py > H + 12) continue;
    let m = mem.get(e);
    const st = MARK[e.type];
    if (!m) { m = memFree.pop() ?? { born: 0, x: 0, y: 0, cls: Cls.Armour, st, seen: 0 }; m.born = now; mem.set(e, m); }
    const air = st.air, cls = CLS[e.type];
    m.x = px; m.y = py; m.cls = cls; m.st = st; m.seen = frameNo;
    const zs = screenScale(e.x, e.y), r = e.type === 'infantry' ? 4 / 1.65 * zs : visualHalf(e.type, air) * zs;
    let a = Math.min(1, (now - m.born) / 0.4);
    let flag = (air ? F_AIR : 0) | (d.salvage ? F_SALV : 0) | (d.elite ? F_ELITE : 0) | (aim.hover === e || aim.lock === e ? F_HOVER : 0);
    if (r > BIG || d.elite) flag |= F_BIG;
    if (P && !d.salvage) {
      const hd = hullDist(e.x, e.y);
      if (hd > (d.range ?? 9999)) a *= 0.6;          // cannot reach us: quieter
      if (!air && hd <= 0) a *= 0.3;                 // under our hull: a ghost
    }
    a *= st.alpha;
    // where its shadow lands on the city (the unit layer draws it at the same offset)
    const sh = air ? 1 - alt / SHADOW_ALT : 0;
    if (sh > 0) { const q = fieldToScreen(e.x + SHADOW_DX, e.y + SHADOW_DY); cshx[n] = q.x; cshy[n] = q.y; csha[n] = Math.min(1, sh); } else csha[n] = 0;
    cph[n] = m.born;
    cx[n] = px; cy[n] = py; cr[n] = r; ca[n] = a; ctele[n] = e.tele ?? 0; chp[n] = e.maxHp > 0 ? e.hp / e.maxHp : 1;
    ccls[n] = cls; cflag[n] = flag; cen[n] = e; cgrp[n] = -1;
    n++;
  }
  // forget the dead; a unit that died on screen leaves a splash
  forgetNow = now; mem.forEach(forget);
  return n;
}

/** Single-link clustering of small, armed contacts of one class (a chain of drones is one group). Returns the
 *  group count; each group carries its members' screen bounding box. */
function cluster(n: number): number {
  let g = 0;
  const R2 = GROUP_R * GROUP_R;
  for (let i = 0; i < n; i++) {
    if (cflag[i] & (F_BIG | F_SALV)) continue;
    let gi = -1;
    for (let j = 0; j < i; j++) {
      const gj = cgrp[j]; if (gj < 0 || gj === gi || ccls[j] !== ccls[i]) continue;
      const dx = cx[j] - cx[i], dy = cy[j] - cy[i];
      if (dx * dx + dy * dy > R2) continue;
      if (gi < 0) gi = gj;
      else { for (let k = 0; k < i; k++) if (cgrp[k] === gj) cgrp[k] = gi; gn[gi] += gn[gj]; gn[gj] = 0; } // bridge two groups
    }
    if (gi < 0) { gi = g++; gn[gi] = 0; gcls[gi] = ccls[i]; }
    cgrp[i] = gi; gn[gi]++;
  }
  // bounds, strongest alpha, hottest wind-up
  for (let j = 0; j < g; j++) { gx0[j] = 1e9; gy0[j] = 1e9; gx1[j] = -1e9; gy1[j] = -1e9; ga[j] = 0; gtele[j] = 0; gflag[j] = 0; ghp[j] = 0; gshx[j] = 0; gshy[j] = 0; gsha[j] = 0; }
  for (let i = 0; i < n; i++) {
    const j = cgrp[i]; if (j < 0) continue;
    const r = cr[i];
    gx0[j] = Math.min(gx0[j], cx[i] - r); gy0[j] = Math.min(gy0[j], cy[i] - r); gx1[j] = Math.max(gx1[j], cx[i] + r); gy1[j] = Math.max(gy1[j], cy[i] + r);
    ga[j] = Math.max(ga[j], ca[i]); gtele[j] = Math.max(gtele[j], ctele[i]); gflag[j] |= cflag[i] & (F_HOVER | F_AIR); ghp[j] += chp[i];
    gst[j] = MARK[cen[i]!.type]; gshx[j] += cshx[i] * csha[i]; gshy[j] += cshy[i] * csha[i]; gsha[j] += csha[i];
  }
  // the group's drop line ends on the middle of its members' shadows
  for (let j = 0; j < g; j++) if (gsha[j] > 0) { gshx[j] /= gsha[j]; gshy[j] /= gsha[j]; gsha[j] /= gn[j]; }
  return g;
}

/* ---------------- draw ---------------- */
/**
 * Every contact is a TRACKER BOX (four corner ticks round the unit's real footprint, never covering the unit, so its
 * lights and heat stay visible inside) and a SYMBOL above it: the frame + class glyph, a count for groups, a
 * designator for big contacts. Its layer shows in colour, frame and anchoring: an aircraft's box hangs a dashed
 * drop line to its shadow and its symbol bobs; a ground unit's box sits in a ring decal and its diamond is filled.
 */
function contact(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, cls: Cls, st: MarkStyle,
  a: number, hot: number, hover: boolean, elite: boolean, label: string, hp: number, pulse: number, dy: number, shx: number, shy: number, sha: number) {
  const x = (x0 + x1) / 2, y = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2, air = st.air;
  const col = hover ? COL.lock : hot > 0.05 ? st.hot : st.col;
  const big = Math.max(hw, hh) > BIG;
  // layer anchor first, under the box: air hangs a drop line to its shadow, ground sits in a ring on the city
  if (air) { if (sha > 0.05) dropLine(c, x, y1 + 1.5, shx, shy, st.col, a * sha); }
  else { c.beginPath(); const rr = Math.max(hw, hh) * 1.25 + 3; c.moveTo(x + rr, y); c.ellipse(x, y, rr, rr * 0.9, 0, 0, Math.PI * 2); ink(c, st.col, a * (big ? 0.4 : 0.55), 1.1); }
  // tracker box
  c.beginPath(); corners(c, x, y, hw, hh, big ? Math.min(10, Math.min(hw, hh) * 0.4) : Math.max(2.5, Math.min(hw, hh) * 0.55));
  if (elite) corners(c, x, y, hw + 4, hh + 4, 5);
  ink(c, col, hover ? 1 : a * (big ? 0.9 : 0.75), hover ? 1.5 : 1.1);
  // symbol above the box (left-aligned on big ones, centred on small); aircraft bob gently
  const ss = st.size * (1 + hot * 0.15 * pulse), sx0 = big ? x0 + ss : x, sy0 = y0 - ss - 4 + dy;
  c.beginPath(); frame(c, sx0, sy0, ss, air, st.salvage);
  if (!air && !st.salvage) wash(c, col, a);
  glyph(c, cls, sx0, sy0, ss); ink(c, col, a, st.tier >= Tier.Heavy ? 1.4 : 1.15);
  if (label) {
    c.globalAlpha = a * 0.85; c.fillStyle = COL.dark; c.fillText(label, sx0 + ss + 3.5, sy0 + 1);
    c.globalAlpha = a; c.fillStyle = col; c.fillText(label, sx0 + ss + 3, sy0 + 0.5);
  }
  if (!st.salvage && hp < 0.999) hpTick(c, x, y1 + 4, Math.max(10, Math.min(2 * hw, 40)), hp, a, st.col);
  // wind-up: a ring closes on the box
  if (hot > 0.02) { c.beginPath(); const rr = Math.max(hw, hh) * 1.15 + 3 + (1 - hot) * 12; c.arc(x, y, rr, 0, Math.PI * 2); ink(c, st.hot, hot * (0.45 + 0.55 * pulse) * a, 1); }
}

export function drawSymbology(c: CanvasRenderingContext2D, _t: number) {
  const now = performance.now() / 1000;
  if (!S.P || !S.active) { if (mem.size) { for (const m of mem.values()) memFree.push(m); mem.clear(); } return; }
  const n = gather(now), g = cluster(n);
  const pulse = 0.5 + 0.5 * Math.sin(now * 14);
  c.save();
  c.lineJoin = 'miter'; c.lineCap = 'butt';
  c.font = `10px ${MONO}`; c.textBaseline = 'middle'; c.textAlign = 'left';
  // shadow pips of every aircraft (grouped ones too: a squadron's shadows are a scatter of pips on the city)
  for (let i = 0; i < n; i++) if (csha[i] > 0.05) pip(c, cshx[i], cshy[i], MARK[cen[i]!.type].col, ca[i] * csha[i]);
  for (let i = 0; i < n; i++) {
    const j = cgrp[i];
    if (j >= 0 && gn[j] > 1) continue;
    const f = cflag[i], r = Math.max(cr[i] + 2, 4.5), x = cx[i], y = cy[i], air = !!(f & F_AIR), hh = air && f & F_BIG ? r * 0.8 : r;
    const st = MARK[cen[i]!.type];
    contact(c, x - r, y - hh, x + r, y + hh, ccls[i], st, ca[i], ctele[i], !!(f & F_HOVER), !!(f & F_ELITE),
      f & F_BIG ? TAG[cen[i]!.type] : '', chp[i], pulse, air ? bob(now, cph[i]) : 0, cshx[i], cshy[i], csha[i]);
  }
  for (let j = 0; j < g; j++) {
    const m = gn[j]; if (m < 2) continue;
    const st = gst[j]!;
    contact(c, gx0[j] - 2, gy0[j] - 2, gx1[j] + 2, gy1[j] + 2, gcls[j], st, ga[j], gtele[j], !!(gflag[j] & F_HOVER), false,
      m < 100 ? COUNT[m] : '99', 1, pulse, st.air ? bob(now, j) : 0, gshx[j], gshy[j], gsha[j]);
  }
  // ----- death splashes: the box opens and fades
  for (let i = 0; i < SPL; i++) {
    const age = now - st0[i]; if (age < 0 || age > 0.35) continue;
    const k = age / 0.35, r = 6 + k * 8;
    c.beginPath(); corners(c, sx[i], sy[i], r, r, 3); ink(c, sst[i]!.col, (1 - k) * 0.8, 1);
  }
  c.restore();
  if (FLIR.k > 0.02) flirOverlay(c, n, now);
}

/* ---------------- FLIR: camera frame, readout and a zoomed thermal inset ---------------- */
let glCanvas: HTMLCanvasElement | null | undefined;
function flirOverlay(c: CanvasRenderingContext2D, n: number, now: number) {
  const k = FLIR.k;
  c.save();
  c.globalAlpha = k; c.strokeStyle = COL.flir; c.lineWidth = 1.5; c.lineCap = 'butt';
  // camera crop marks and a boresight
  c.beginPath(); corners(c, W / 2, H / 2 + 10, W / 2 - 300, H / 2 - 150, 26); c.stroke();
  c.font = `11px ${MONO}`; c.fillStyle = COL.flir; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  const P = S.P!;
  const lx = 300, ly = 112;
  c.fillText('FLIR  WHT-HOT  NFOV', lx, ly);
  c.fillText(`ALT ${(2.4 + Math.sin(now * 0.1) * 0.02).toFixed(2)} KM   HDG 000   GS ${Math.round(Math.hypot(P.vx, P.vy) * 3.6)} KMH`, lx, ly + 14);
  c.textAlign = 'right';
  c.fillText(`TRK ${n}  `, W - 300, ly);
  // the target: whatever the reticle is on, else the nearest contact to it
  let best = -1, bd = 1e9;
  for (let i = 0; i < n; i++) {
    const e = cen[i]!; if (EN[e.type].salvage) continue;
    if (aim.hover === e || aim.lock === e) { best = i; break; }
    const p = fieldToScreen(aim.x, aim.y), d = (cx[i] - p.x) ** 2 + (cy[i] - p.y) ** 2; // (shared object, read at once)
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) {
    const e = cen[best]!, d = EN[e.type];
    c.fillText(`TGT ${TAG[e.type]}  ${Math.round(TRUE_M[e.type] * (e.type === 'infantry' ? 4.5 : 1))} M  ${d.layer === 'air' ? 'AIR' : 'GND'}`, W - 300, ly + 14);
    // the sensor's track box on the target, then the zoomed picture
    const r = Math.max(cr[best] + 5, 9);
    c.globalAlpha = k; c.strokeStyle = COL.flir; c.lineWidth = 1.2; c.beginPath(); c.rect(cx[best] - r, cy[best] - r, 2 * r, 2 * r); c.stroke();
    inset(c, cx[best], cy[best], k);
  }
  c.restore();
}
/** A 4x digital zoom of the live frame around (x, y), read straight from the WebGL canvas (same frame). */
function inset(c: CanvasRenderingContext2D, x: number, y: number, k: number) {
  if (glCanvas === undefined) glCanvas = document.getElementById('gl') as HTMLCanvasElement | null;
  if (!glCanvas || !glCanvas.width) return;
  const Z = 4, iw = 176, ih = 120, ox = W - 300 - iw, oy = H - 300;
  const sw = iw / Z, sh = ih / Z, kx = glCanvas.width / W, ky = glCanvas.height / H;
  c.globalAlpha = k;
  c.fillStyle = '#05070a'; c.fillRect(ox - 2, oy - 2, iw + 4, ih + 4);
  try { c.drawImage(glCanvas, (x - sw / 2) * kx, (y - sh / 2) * ky, sw * kx, sh * ky, ox, oy, iw, ih); } catch { /* ignore */ }
  c.strokeStyle = COL.flir; c.lineWidth = 1; c.strokeRect(ox - 0.5, oy - 0.5, iw + 1, ih + 1);
  c.beginPath();
  const mx = ox + iw / 2, my = oy + ih / 2;
  c.moveTo(mx - 30, my); c.lineTo(mx - 8, my); c.moveTo(mx + 8, my); c.lineTo(mx + 30, my);
  c.moveTo(mx, my - 22); c.lineTo(mx, my - 8); c.moveTo(mx, my + 8); c.lineTo(mx, my + 22);
  c.stroke();
  c.font = `10px ${MONO}`; c.textAlign = 'left'; c.fillStyle = COL.flir; c.fillText(`x${Z}`, ox + 5, oy + ih - 6);
}
