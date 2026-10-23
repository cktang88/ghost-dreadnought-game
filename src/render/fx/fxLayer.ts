// FX layer: projectiles, beams, pickups, particles, scorch decals, smoke ribbons, screen distortion
// and the explosion/muzzle light pool. Draw calls: ground batch (depth tested, under the ship), ribbons,
// air batch (over everything on the flight plane), hostile batch (enemy fire, always on top so threats
// stay readable), plus one distortion batch rendered by the post chain.
import * as THREE from 'three';
import type { Engine, FrameCtx, Layer } from '../engine';
import { FIELD_H } from '../engine';
import * as vfx from '../../game/vfx';
import { V, railFx, addFx, broadsideFx, pulseCA, addTrauma, type Fx } from '../../game/vfx';
import { OVERDRIVES } from '../../data/hulls';
import { rgb } from './quads';
import { PAL } from '../palette';
import { FxBatch, FxShape } from './fxBatch';
import { Ribbons, RibbonStyle } from './ribbons';
import { DistShape } from './distort';
import { bakePuffAtlas } from './atlas';
import { clamp, rnd } from '../../util/rng';
import type { Ent, Beam } from '../../game/combat';

/** Flight-plane effects float this high above the plane (clear of hull tops). */
const AIR = 30;
const TAU = Math.PI * 2;
const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
// Enemy fire is the THREAT family (docs/ART.md "Readability"): hot magenta-pink with white-hot centres and
// dark rims. Nothing else on screen uses it, so "pink = it can hit you" reads at a glance against the amber
// city, the red-marked enemy units, our cyan fire and gold scrap.
const WHITE = rgb('#ffffff'), HOSTILE = rgb(PAL.threat), HOSTILE_HOT = rgb(PAL.threatHot), EMBER = rgb('#ff8a3d');
const MISSILE_BODY = rgb('#ffe9f6'), MISSILE_SHADE = rgb('#1a0610');
const SPARK_HOT = rgb('#fff1c8'), SPARK_MID = rgb('#ffc35a'), SPARK_COOL = rgb('#ff6a3d');
const N_LIGHTS = 6;
/** Extra bloom requested this frame (the Lance), eased into the post chain's bloom intensity. */
let lanceBloom = 0, bloomBase = -1, bloomBoost = 0;

/** Jagged polyline for a quick zap (kept for callers that want a plain zig). */
export function zigPts(x1: number, y1: number, x2: number, y2: number) {
  const n = Math.max(4, Math.round(Math.hypot(x2 - x1, y2 - y1) / 18)), pts = [x1, y1], nx = -(y2 - y1), ny = x2 - x1, l = Math.hypot(nx, ny) || 1;
  for (let i = 1; i < n; i++) { const k = i / n, o = rnd(-9, 9); pts.push(x1 + (x2 - x1) * k + (nx / l) * o, y1 + (y2 - y1) * k + (ny / l) * o); }
  pts.push(x2, y2); return pts;
}

/* ---------------- branching lightning ---------------- */
const MAIN_PTS = 33;
const mainBuf = new Float32Array(MAIN_PTS * 2), branchBuf = new Float32Array(MAIN_PTS * 2), tmp = new Float32Array(MAIN_PTS * 4);
function displace(out: Float32Array, x1: number, y1: number, x2: number, y2: number, levels: number, rough: number) {
  out[0] = x1; out[1] = y1; out[2] = x2; out[3] = y2; let n = 2;
  let amp = Math.hypot(x2 - x1, y2 - y1) * rough;
  for (let l = 0; l < levels; l++) {
    for (let i = 0; i < n; i++) { tmp[i * 4] = out[i * 2]; tmp[i * 4 + 1] = out[i * 2 + 1]; }
    for (let i = 0; i < n - 1; i++) {
      const ax = tmp[i * 4], ay = tmp[i * 4 + 1], bx = tmp[(i + 1) * 4], by = tmp[(i + 1) * 4 + 1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, o = rnd(-amp, amp);
      tmp[i * 4 + 2] = (ax + bx) / 2 - (dy / L) * o; tmp[i * 4 + 3] = (ay + by) / 2 + (dx / L) * o;
    }
    n = n * 2 - 1;
    for (let i = 0; i < n * 2; i++) out[i] = tmp[i];
    amp *= 0.5;
  }
  return n;
}
interface Bolt { segs: Float32Array; n: number; t: number }
/** Segments (x1, y1, x2, y2, width) of a forked bolt between two points. */
function genBolt(bolt: Bolt, x1: number, y1: number, x2: number, y2: number) {
  const s = bolt.segs; let k = 0;
  const n = displace(mainBuf, x1, y1, x2, y2, 5, 0.16);
  const push = (ax: number, ay: number, bx: number, by: number, w: number) => { if (k + 5 > s.length) return; s[k++] = ax; s[k++] = ay; s[k++] = bx; s[k++] = by; s[k++] = w; };
  for (let i = 0; i < n - 1; i++) push(mainBuf[i * 2], mainBuf[i * 2 + 1], mainBuf[i * 2 + 2], mainBuf[i * 2 + 3], 1);
  const nb = 2 + Math.floor(Math.random() * 2), len = Math.hypot(x2 - x1, y2 - y1);
  for (let j = 0; j < nb; j++) {
    const i = 4 + Math.floor(Math.random() * (n - 10));
    const sx = mainBuf[i * 2], sy = mainBuf[i * 2 + 1];
    const ang = Math.atan2(y2 - y1, x2 - x1) + (Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 1.0), bl = len * rnd(0.18, 0.4);
    const ex = sx + Math.cos(ang) * bl, ey = sy + Math.sin(ang) * bl;
    const m = displace(branchBuf, sx, sy, ex, ey, 3, 0.2);
    for (let q = 0; q < m - 1; q++) push(branchBuf[q * 2], branchBuf[q * 2 + 1], branchBuf[q * 2 + 2], branchBuf[q * 2 + 3], 0.55 * (1 - q / m));
  }
  bolt.n = k / 5;
}

export class FxLayer implements Layer {
  name = 'fx';
  ground: FxBatch; air: FxBatch; hostile: FxBatch;
  ribbons: Ribbons;
  lights: THREE.PointLight[] = [];
  muzzleLight: THREE.PointLight;
  private ribbonOf = new WeakMap<object, number>();
  private seen = new WeakSet<object>();
  private bolts = new WeakMap<object, Bolt>();
  private lastT = 0;
  private cand: Fx[] = []; private score: number[] = [];
  constructor(private e: Engine) {
    const atlas = bakePuffAtlas(e.renderer, e.post.quality === 'high' ? 1024 : 512);
    this.ground = new FxBatch(5000, atlas, 4, true);
    this.ribbons = new Ribbons(e, 5);
    this.air = new FxBatch(6000, atlas, 6, false);
    this.hostile = new FxBatch(1600, atlas, 8, false);
    e.scene.add(this.ground.mesh, this.ribbons.mesh, this.air.mesh, this.hostile.mesh);
    for (let i = 0; i < N_LIGHTS; i++) { const l = new THREE.PointLight(0xff8a3d, 0, 600, 1.4); e.scene.add(l); this.lights.push(l); }
    this.muzzleLight = new THREE.PointLight(0xffd27a, 0, 420, 1.3); e.scene.add(this.muzzleLight);
    for (let i = 0; i < 64; i++) { this.cand.push(null as unknown as Fx); this.score.push(0); }
    // Debug/test hook: the VFX API and the post chain, for Playwright and the console.
    (window as unknown as { __gdfx: unknown }).__gdfx = { ...vfx, layer: this, post: e.post, engine: e };
  }

  /* ---------------- placement helpers ---------------- */
  /** World position of a particle-like thing (see vfx.ts header for h). */
  private at(x: number, y: number, h: number, ground: boolean, out: THREE.Vector3) {
    if (ground) { this.e.toGround(x, y, out); out.y = h * this.e.groundScale + 1.5; }
    else this.e.toFlight(x, y, AIR + h, out);
    return out;
  }
  /** Lerp between the ground (h=0) and the flight plane (h=1) for things falling through altitude. */
  private between(x: number, y: number, h: number, out: THREE.Vector3) { this.e.toFlight(x, y, 0, a); this.e.toGround(x, y, b); return out.lerpVectors(b, a, h); }
  /** A flat streak on the ground plane between two field points (the furrow). */
  private groundStreak(x1: number, y1: number, x2: number, y2: number, wid: number, c: readonly number[], I: number, op: number) {
    const e = this.e; e.toGround(x1, y1, a); e.toGround(x2, y2, b);
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz); if (L < 0.01) return;
    this.ground.add((a.x + b.x) / 2, 2.5, (a.z + b.z) / 2, Math.atan2(dz, dx), L + wid, wid, c, I, FxShape.Beam, op);
  }
  private streak(B: FxBatch, x1: number, y1: number, x2: number, y2: number, alt: number, wid: number, c: readonly number[], I: number, op: number, shape = FxShape.Streak) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy); if (L < 0.01) return;
    this.e.toFlight((x1 + x2) / 2, (y1 + y2) / 2, alt, v); B.add(v.x, v.y, v.z, Math.atan2(dy, dx), L + wid, wid, c, I, shape, op);
  }

  clear() {
    for (const l of this.lights) l.intensity = 0;
    this.muzzleLight.intensity = 0;
    this.ribbons.clear();
  }

  update({ S, V: Vs, t, dt }: FrameCtx) {
    const e = this.e, k = e.groundScale;
    const G = this.ground, A = this.air, H = this.hostile, D = e.post.distort;
    G.begin(t); A.begin(t); H.begin(t);
    // Game-time step for trails (follows slow-mo and hitstop, freezes on pause).
    let gdt = S.t - this.lastT; this.lastT = S.t; if (gdt < 0 || gdt > 0.25) gdt = 0;
    e.post.setTheme(S.theme);
    e.post.slowHint = S.slowFx * 0.75; e.post.cinema = S.slowFx;
    this.events(S);

    /* ---- scorch decals (first, under everything on the ground) ---- */
    for (const dc of Vs.decals) {
      e.toGround(dc.x, dc.y, v);
      const fade = Math.min(1, dc.life / 4);
      G.add(v.x, 0.9, v.z, dc.seed * TAU, dc.r * 2.8 * k, dc.r * 2.6 * k, WHITE, 1, FxShape.Scorch, fade, dc.hot * dc.hot, dc.seed);
    }

    /* ---- particles ---- */
    this.particles(Vs.fx, t);

    /* ---- overdrive, wind-up glints ---- */
    this.overdrive(S, t);
    this.glints(S, t);

    /* ---- player projectiles ---- */
    this.ribbons.beginFrame();
    for (const p of S.pb) this.playerShot(p, t);
    /* ---- enemy fire ---- */
    for (const bl of S.eb) this.enemyShot(bl, t);
    /* ---- beams ---- */
    for (const bm of S.beams) this.beam(bm, t);
    this.ribbons.update(gdt, S.scroll, t);

    /* ---- rail charge-up on the player's spine guns ---- */
    const P = S.P;
    if (P && S.mode === 'play') {
      for (const m of P.dv.mounts) {
        if (!m.part || m.part.id !== 'rail') continue;
        const cd = P.cds[m.part.uid]; if (cd === undefined || cd > 0.5) continue;
        const q = clamp(1 - cd / 0.5, 0, 1), x = P.x + m.ox, y = P.y + m.oy - 12, c = rgb('#c9a6ff');
        e.toFlight(x, y, AIR + 4, v);
        A.add(v.x, v.y, v.z, 0, 14 + 40 * q * q, 14 + 40 * q * q, c, 1.2 + 2.5 * q, FxShape.Hot, 0.4 + 0.6 * q);
        A.add(v.x, v.y, v.z, t * 3, 90 * (1 - q) + 16, 90 * (1 - q) + 16, c, 1.5, FxShape.Ring, q * 0.8, 0.06);
        for (let i = 0; i < 6; i++) {
          const ang = i * (TAU / 6) + t * 5, R = (1 - q) * 70 + 6;
          e.toFlight(x + Math.cos(ang) * R, y + Math.sin(ang) * R, AIR + 4, a);
          A.add(a.x, a.y, a.z, ang + Math.PI / 2, 10, 3, c, 2.5, FxShape.Streak, q);
        }
        if (q > 0.7) D.add(v.x, v.y, v.z, 0, 120, 120, DistShape.Haze, (q - 0.7) * 3, 0, 0.3);
      }
      // Engine heat haze behind the hull.
      for (const r of P.dv.rects) if (r.type === 'engine') { e.toFlight(P.x, P.y + r.y + r.h + 40, 0, v); D.add(v.x, v.y, v.z, 0, r.w * 0.9, 110, DistShape.Haze, 0.8, 0, 0.1); }
    }
    const B = S.boss;
    if (B && B.alive && B.entered) for (const r of B.dv.rects) if (r.type === 'engine') { e.toFlight(B.x, B.y - (r.y + r.h) * B.s - 50, 40, v); D.add(v.x, v.y, v.z, 0, r.w * B.s * 0.9, 120, DistShape.Haze, 0.7, 0, 0.6); }

    /* ---- pickups ---- */
    for (const p of S.pickups) {
      e.toFlight(p.x, p.y, AIR - 10, v);
      if (p.kind === 'repair') { A.add(v.x, v.y, v.z, t * 2, 26, 26, rgb('#8fe39a'), 2, FxShape.Diamond, 0.9); A.add(v.x, v.y, v.z, 0, 50, 50, rgb('#8fe39a'), 0.6, FxShape.Soft, 0.5 + 0.3 * Math.sin(p.t * 8)); }
      else { const s = 13 + 2 * Math.sin(p.t * 9 + p.x); A.add(v.x, v.y, v.z, p.t * 4 + p.x, s, s * 1.3, rgb('#e0c35c'), 2.2, FxShape.Diamond, 0.95); A.add(v.x, v.y, v.z, 0, 30, 30, rgb('#e0c35c'), 0.5, FxShape.Soft, 0.5); }
    }

    // Bloom boost (Lance): eased so it swells and fades instead of popping.
    if (bloomBase < 0) bloomBase = e.post.bloom.intensity;
    bloomBoost += (lanceBloom - bloomBoost) * Math.min(1, dt * 6); lanceBloom = 0;
    e.post.bloom.intensity = bloomBase * (1 + bloomBoost);

    G.flush(); A.flush(); H.flush();
    this.updateLights(Vs.fx, dt);
  }

  /* ---------------- sim events ---------------- */
  private lastEvent = 0;
  private events(S: FrameCtx['S']) {
    if (S.eventId < this.lastEvent) this.lastEvent = 0;
    const P = S.P;
    for (const ev of S.events) {
      if (ev.id <= this.lastEvent) continue;
      switch (ev.type) {
        case 'broadside': broadsideFx(ev.x, ev.y, ev.side ?? 1, ev.n ?? 1, P ? P.dv.len : 200); break;
        case 'playerHit': pulseCA(Math.min(0.6, 0.12 + (ev.n || 0) / 40)); break;
        case 'carnageTier':
          if (P) {
            addFx({ type: 'ring', x: P.x, y: P.y, life: 0.55, max: 0.55, size: Math.max(P.dv.width, P.dv.len) * 1.3, col: '#f2a541', h: 20, a: 0.9 });
            addFx({ type: 'flare', x: P.x, y: P.y, life: 0.3, max: 0.3, size: 700, col: '#f2a541', h: 20 });
          }
          pulseCA(0.3); break;
        case 'overdriveReady':
          if (P) for (let i = 0; i < 2; i++) addFx({ type: 'ring', x: P.x, y: P.y, life: 0.6 + i * 0.25, max: 0.6 + i * 0.25, size: Math.max(P.dv.width, P.dv.len) * (0.9 + i * 0.4), col: OVERDRIVES[ev.kind as keyof typeof OVERDRIVES]?.col ?? '#ffb347', h: 20, a: 0.9 });
          break;
        case 'overdrive': {
          const col = OVERDRIVES[ev.kind as keyof typeof OVERDRIVES]?.col ?? '#ffb347';
          addFx({ type: 'flash', x: ev.x, y: ev.y, life: 0.2, max: 0.2, size: 180, col, h: 20 });
          addFx({ type: 'flare', x: ev.x, y: ev.y, life: 0.35, max: 0.35, size: 900, col, h: 20 });
          addFx({ type: 'ring', x: ev.x, y: ev.y, life: 0.6, max: 0.6, size: 520, col, h: 20, a: 1 });
          addFx({ type: 'shock', x: ev.x, y: ev.y, life: 0.6, max: 0.6, size: 900, str: 1 });
          pulseCA(1); addTrauma(0.35);
          break;
        }
        case 'eliteKill': case 'bossDown': pulseCA(0.9); addTrauma(0.3); break;
      }
    }
    this.lastEvent = S.eventId;
  }

  /* ---------------- overdrive ---------------- */
  private overdrive(S: FrameCtx['S'], t: number) {
    const e = this.e, k = e.groundScale, G = this.ground, A = this.air, D = e.post.distort, o = S.overdrive, P = S.P;
    // The Lance's burning furrow: scorched ground, flames and heat, fading as it scrolls away.
    for (let i = 0; i < o.trail.length; i++) {
      const p = o.trail[i], q = p.life / p.max, fl = 0.7 + 0.3 * Math.sin(t * 19 + i * 2.3);
      // molten cut: a white-hot line joining the burn points, cooling to orange as it scrolls out from under the hull
      const n = o.trail[i + 1];
      if (n && Math.hypot(n.x - p.x, n.y - p.y) < 90) {
        const hot = q * q;
        this.groundStreak(p.x, p.y, n.x, n.y, 30 * k, EMBER, 2.2, q * 0.8 * fl);
        this.groundStreak(p.x, p.y, n.x, n.y, 10 * k, rgb('#ffd27a'), 3 + 4 * hot, (0.3 + 0.7 * hot) * fl);
      }
      e.toGround(p.x, p.y, v);
      if (i % 2 === 0) G.add(v.x, 1.0, v.z, i * 1.7, 44 * k, 38 * k, WHITE, 1, FxShape.Scorch, Math.min(1, q * 3), q * q, (i * 0.137) % 1);
      G.add(v.x, 2, v.z, 0, 70 * k * (0.5 + 0.5 * q), 70 * k * (0.5 + 0.5 * q), EMBER, 1.2, FxShape.Soft, q * 0.6 * fl);
      if (q > 0.5) G.add(v.x, 3, v.z, i, 26 * k, 26 * k, rgb('#ffb347'), 2.4, FxShape.Hot, (q - 0.5) * 2 * fl);
      if (i % 4 === 0 && q > 0.3) { this.at(p.x, p.y, 30, true, a); D.add(a.x, a.y, a.z, 0, 80 * k, 110 * k, DistShape.Haze, q, 0, i * 0.31); }
    }
    if (!o.active || !P) return;
    const b = o.beam;
    if (o.kind === 'lance' && b) {
      // Seen from the top-down camera the beam is end-on: it runs from the keel straight away from the lens and the
      // ground point under the ship lies behind the hull. So the Lance reads by what spills past the silhouette:
      // a glare disc on the city that backlights the hull, impact rings racing out past its edges, the molten
      // furrow (below) emerging from under the stern, a halo rim around the hull and a screen-wide anamorphic flare.
      const c = rgb(b.col), fl = 0.85 + 0.15 * Math.sin(t * 45), w = b.w, R = Math.max(P.dv.width, P.dv.len) / 2;
      const left = clamp(o.t / 0.25, 0, 1) * clamp((o.dur - o.t) / 0.2, 0, 1); // ramp in and out
      const I = fl * (0.35 + 0.65 * left);
      e.toGround(b.x2, b.y2, v);
      // glare: a broad warm wash, then a hotter core; the hull occludes the middle so its outline glows
      G.add(v.x, 4, v.z, 0, R * 5.2 * k, R * 5.2 * k, c, 1.2, FxShape.Soft, 0.55 * I);
      G.add(v.x, 4.5, v.z, 0, R * 2.8 * k, R * 2.8 * k, c, 2.6, FxShape.Soft, 0.8 * I);
      G.add(v.x, 5, v.z, 0, R * 1.3 * k, R * 1.3 * k, WHITE, 3, FxShape.Hot, 0.8 * I);
      G.add(v.x, 5, v.z, t * 6, R * 3.2 * k, R * 3.2 * k, c, 3, FxShape.Star, I, 0, (t * 3) % 1);
      // impact rings: three staggered fronts expanding from under the keel to well past the hull
      for (let i = 0; i < 3; i++) {
        const rr = (t * 1.6 + i / 3) % 1, rad = (R * 0.8 + R * 2.2 * rr) * 2 * k;
        G.add(v.x, 3, v.z, 0, rad, rad, c, 3.2, FxShape.Ring, (1 - rr) * I, 0.035);
      }
      this.at(b.x2, b.y2, 40, true, a); D.add(a.x, a.y, a.z, 0, R * 3 * k, R * 3.4 * k, DistShape.Haze, 2, 0, 0.7);
      // on the flight plane: a thin keel spark, a halo rim just outside the hull and the lens flare over everything
      e.toFlight(b.x1, b.y1, 0, a); A.add(a.x, a.y, a.z, 0, w * 1.4, w * 1.4, c, 2.5, FxShape.Hot, 0.5 * I);
      e.toFlight(P.x, P.y, AIR - 10, a);
      A.add(a.x, a.y, a.z, 0, R * 3, R * 3, c, 2.2, FxShape.Ring, 0.35 * I, 0.1);
      e.toFlight(P.x, P.y, AIR + 40, a);
      A.add(a.x, a.y, a.z, 0, 1500 * (0.8 + 0.2 * fl), 40, c, 2.2, FxShape.Flare, 0.45 * I);
      A.add(a.x, a.y, a.z, Math.PI / 2, 360 * fl, 18, c, 1.6, FxShape.Flare, 0.3 * I);
      addFx({ type: 'light', x: b.x2, y: b.y2, life: 0.05, max: 0.05, size: 720, str: 60, col: b.col, ground: true });
      // upgrade beams (Twin Lances): their own glare, core and keel spark, smaller
      for (const x of o.extra ?? []) {
        e.toGround(x.x2, x.y2, v);
        G.add(v.x, 4, v.z, 0, x.w * 4 * k, x.w * 4 * k, c, 1.4, FxShape.Soft, 0.6 * I);
        G.add(v.x, 5, v.z, 0, x.w * 2.4 * k, x.w * 2.4 * k, WHITE, 3, FxShape.Hot, 0.9 * I);
        const rr = (t * 2.1) % 1; G.add(v.x, 3, v.z, 0, x.w * (2 + 5 * rr) * k, x.w * (2 + 5 * rr) * k, c, 3, FxShape.Ring, (1 - rr) * I, 0.05);
        G.add(v.x, 5, v.z, t * 6, x.w * 3 * k, x.w * 3 * k, c, 3, FxShape.Star, I, 0, (t * 3 + 0.5) % 1);
        e.toFlight(x.x1, x.y1, 0, a); A.add(a.x, a.y, a.z, 0, x.w * 1.4, x.w * 1.4, c, 2.5, FxShape.Hot, 0.5 * I);
      }
      // a little more bloom while the beam burns
      lanceBloom = Math.max(lanceBloom, 0.25 * left);
    } else if (o.kind === 'spear' && b) {
      const c = rgb(b.col), fl = 0.85 + 0.15 * Math.sin(t * 50), w = b.w;
      // the bow beam and any fan spears (upgrades) share the look
      for (const x of [b, ...(o.extra ?? [])]) {
        this.streak(A, x.x1, x.y1, x.x2, x.y2, AIR + 3, x.w * 3.2, c, 1.8, 0.6 * fl, FxShape.Beam);
        this.streak(A, x.x1, x.y1, x.x2, x.y2, AIR + 4, x.w * 1.1, c, 4.5, fl, FxShape.Beam);
        this.streak(A, x.x1, x.y1, x.x2, x.y2, AIR + 5, x.w * 0.4, WHITE, 8, fl, FxShape.Beam);
      }
      e.toFlight(b.x1, b.y1, AIR + 6, v);
      A.add(v.x, v.y, v.z, t * 5, w * 4, w * 4, c, 3, FxShape.Star, fl, 0, (t * 4) % 1);
      A.add(v.x, v.y, v.z, 0, w * 2.4, w * 2.4, WHITE, 4, FxShape.Hot, fl);
      e.toFlight(b.x1, (b.y1 + b.y2) / 2, AIR, a);
      D.add(a.x, a.y, a.z, Math.PI / 2, Math.abs(b.y1 - b.y2), w * 3, DistShape.Line, 1.2, 0, 0.4);
      if (Math.random() < 0.6) { const y = rnd(Math.min(b.y1, b.y2), Math.max(b.y1, b.y2)); addFx({ type: 'spark', x: b.x1 + rnd(-w / 2, w / 2), y, vx: rnd(-260, 260), vy: rnd(-80, 80), life: 0.3, max: 0.3, size: 1.6, drag: 3, tint: b.col, h: 4 }); }
      addFx({ type: 'light', x: b.x1, y: b.y1 - 200, life: 0.05, max: 0.05, size: 600, str: 40, col: b.col });
    } else if (o.kind === 'wing') {
      const c = rgb('#7fb6ff'), body = rgb('#1c2128');
      for (const al of o.allies) {
        const ux = Math.cos(al.hdg), uy = Math.sin(al.hdg);
        this.streak(A, al.x - ux * 10, al.y - uy * 10, al.x - ux * 70, al.y - uy * 70, AIR + 8, 6, c, 1.6, 0.45);
        e.toFlight(al.x, al.y, AIR + 10, v);
        A.add(v.x, v.y, v.z, al.hdg, 30, 9, body, 1, FxShape.Dark, 1);
        A.add(v.x, v.y, v.z, al.hdg + Math.PI / 2, 24, 6, body, 1, FxShape.Dark, 1);
        e.toFlight(al.x - ux * 13, al.y - uy * 13, AIR + 11, a);
        A.add(a.x, a.y, a.z, al.hdg + Math.PI, 22, 9, c, 3, FxShape.Bolt, 1);
        if (Math.sin(t * 12 + al.cd * 40) > 0.6) A.add(v.x, v.y + 1, v.z, 0, 8, 8, WHITE, 3, FxShape.Hot, 1);
      }
    } else if (o.kind === 'bulwark' && o.radius > 0) {
      const c = rgb('#4fd1e8'), R = o.radius * 2, pul = 0.5 + 0.5 * Math.sin(t * 6);
      e.toFlight(P.x, P.y, AIR + 4, v);
      A.add(v.x, v.y, v.z, 0, R, R, c, 2.2, FxShape.Ring, 0.55 + 0.3 * pul, 0.03);
      A.add(v.x, v.y, v.z, t, R * 0.96, R * 0.96, c, 1.4, FxShape.Reticle, 0.35, 0);
      A.add(v.x, v.y, v.z, 0, R * 1.05, R * 1.05, c, 0.35, FxShape.Soft, 0.25 + 0.1 * pul);
      D.add(v.x, v.y, v.z, 0, R * 1.1, R * 1.1, DistShape.Shock, 0.25, 0.86, 0.2);
    }
  }

  /** Enemy wind-up: a hostile glint that swells and a ring that closes as the shot comes. */
  private glints(S: FrameCtx['S'], t: number) {
    const e = this.e, H = this.hostile, k = e.groundScale;
    for (const en of S.enemies) {
      const tl = en.tele; if (!(tl > 0) || en.dead) continue;
      const gp = en.layer === 'ground', sk = gp ? k : 1;
      if (gp) { e.toGround(en.x, en.y, v); v.y = 14 * k; } else e.toFlight(en.x, en.y, AIR + 6, v);
      const s = (16 + 46 * tl * tl) * sk * (0.9 + 0.1 * Math.sin(t * 40));
      H.add(v.x, v.y, v.z, t * 2.5, s, s, HOSTILE_HOT, 2 + 3 * tl, FxShape.Star, 0.35 + 0.65 * tl, 0, 0.6);
      H.add(v.x, v.y, v.z, 0, s * 0.35, s * 0.35, WHITE, 3, FxShape.Hot, tl);
      const R = (24 + 90 * (1 - tl)) * sk;
      H.add(v.x, v.y, v.z, 0, R, R, HOSTILE, 1.6, FxShape.Ring, tl * 0.8, 0.06);
    }
    // Ghost broadside wind-up: every gun on the flank glows, and its lane (or the arc it will rake) is marked out.
    const B = S.boss;
    if (B && B.alive && B.glints) for (const g of B.glints) {
      const tl = g.tele, fl = 0.75 + 0.25 * Math.sin(t * 34 + g.y);
      e.toFlight(g.x, g.y, AIR + 6, v);
      const s = (18 + 50 * tl * tl) * fl;
      H.add(v.x, v.y, v.z, t * 2.5, s, s, HOSTILE_HOT, 2 + 3 * tl, FxShape.Star, 0.35 + 0.65 * tl, 0, 0.6);
      H.add(v.x, v.y, v.z, 0, s * 0.4, s * 0.4, WHITE, 3, FxShape.Hot, tl);
      const lanes = g.spread > 0 ? [g.ang - g.spread, g.ang, g.ang + g.spread] : [g.ang];
      for (let i = 0; i < lanes.length; i++) {
        const an = lanes[i], main = lanes.length === 1 || i === 1, L = g.len * (main ? 1 : 0.75);
        this.streak(H, g.x, g.y, g.x + Math.cos(an) * L, g.y + Math.sin(an) * L, AIR + 1, main ? 2 + 4 * tl : 1.5 + 2 * tl, HOSTILE, 1.3, (main ? 0.2 + 0.45 * tl : 0.12 + 0.25 * tl) * fl, FxShape.Beam);
      }
    }
  }

  /* ---------------- particles ---------------- */
  private particles(list: Fx[], t: number) {
    const e = this.e, k = e.groundScale, D = e.post.distort;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.delay > 0) continue;
      const q = f.life / f.max, age = f.max - f.life, gp = f.ground, B = gp ? this.ground : this.air, sk = gp ? k : 1;
      this.at(f.x, f.y, f.h, gp, v);
      switch (f.type) {
        case 'fire': {
          const s = f.size * (0.55 + (1 - q) * f.grow) * 2 * sk;
          const heat = f.heat * (0.1 + 0.9 * Math.pow(q, 0.8));
          const op = Math.min(1, age / 0.035) * Math.min(1, q / 0.18);
          B.add(v.x, v.y, v.z, f.rot, s, s, WHITE, 1, FxShape.Fire, op, f.seed * 16 + (1 - q) * 9, heat);
          break;
        }
        case 'smoke': case 'puff': case 'dust': {
          const s = f.size * (1 + (1 - q) * f.grow) * 2 * sk;
          const fin = Math.min(1, age / (f.type === 'puff' ? 0.05 : 0.18));
          const glow = f.type === 'puff' ? f.heat * Math.max(0, (q - 0.7) / 0.3) : f.heat * Math.max(0, (q - 0.45) / 0.55);
          const col = rgb(f.col || (f.type === 'puff' ? '#16161a' : '#38383d'));
          B.add(v.x, v.y, v.z, f.rot, s, s, col, 1, FxShape.Smoke, (f.a || 0.5) * fin * Math.pow(q, f.type === 'dust' ? 1.2 : 0.75), f.seed * 16 + (1 - q) * 5, glow);
          break;
        }
        case 'spark': {
          const sp = Math.hypot(f.vx, f.vy) || 1, L = (Math.min(22, sp * 0.055) + 2) * sk;
          const c = f.tint ? rgb(f.tint) : q > 0.6 ? SPARK_HOT : q > 0.3 ? SPARK_MID : SPARK_COOL;
          const ux = f.vx / sp, uy = f.vy / sp;
          B.add(v.x - ux * L * 0.5, v.y, v.z - uy * L * 0.5, Math.atan2(uy, ux), L, f.size * 2.4 * sk, c, 2.6, FxShape.Streak, Math.min(1, q * 1.8));
          break;
        }
        case 'ember': {
          const fl = 0.55 + 0.45 * Math.sin(t * 23 + f.seed * 60);
          const c = f.tint ? rgb(f.tint) : EMBER;
          B.add(v.x, v.y, v.z, 0, f.size * 3.4 * sk, f.size * 3.4 * sk, c, 2.4, FxShape.Hot, Math.min(1, q * 2) * fl);
          break;
        }
        case 'flash': B.add(v.x, v.y, v.z, 0, f.size * (0.7 + 0.5 * (1 - q)) * sk, f.size * (0.7 + 0.5 * (1 - q)) * sk, rgb(f.col || '#fff3d6'), 3, FxShape.Hot, q); break;
        case 'muzzle': B.add(v.x, v.y, v.z, 0, f.size * 2.6 * sk, f.size * 2.6 * sk, rgb(f.col || '#ffd27a'), 3.2, FxShape.Hot, Math.min(1, q * 1.3)); break;
        case 'star': B.add(v.x, v.y, v.z, f.rot, f.size * sk, f.size * sk, rgb(f.col || '#ffe6a8'), 3, FxShape.Star, q, 0, f.seed); break;
        case 'flare': B.add(v.x, v.y, v.z, 0, f.size * sk * (0.6 + 0.4 * q), f.size * 0.03 * sk, rgb(f.col || '#ffc070'), 2.2, FxShape.Flare, q); break;
        case 'glow': B.add(v.x, v.y, v.z, 0, f.size * sk, f.size * sk, rgb(f.col || '#ff8a3d'), 1, FxShape.Soft, q * (f.a || 0.6)); break;
        case 'light': if (gp) B.add(v.x, 2, v.z, 0, f.size * 0.8 * k, f.size * 0.8 * k, rgb(f.col || '#ff8a3d'), 0.8, FxShape.Soft, q * q * 0.35); break;
        case 'ring': {
          const kk = 1 - q, R = f.size * (1 - Math.pow(1 - kk, 3)) * sk;
          B.add(v.x, v.y, v.z, 0, R, R, rgb(f.col || '#ffe2b0'), 2, FxShape.Ring, q * (f.a || 0.85), 0.03 + 0.1 * q);
          break;
        }
        case 'shock': { const R = f.size * sk; D.add(v.x, v.y, v.z, 0, R, R, DistShape.Shock, f.str, 1 - q, f.seed); break; }
        case 'haze': D.add(v.x, v.y, v.z, 0, f.size * sk, f.size * sk * 1.4, DistShape.Haze, f.str * q, 0, f.seed); break;
        case 'debris': {
          const s = f.size * 2.6 * sk;
          B.add(v.x, v.y, v.z, f.rot, s, s * 0.8, rgb(f.col || '#3b4148'), 1, FxShape.Shard, Math.min(1, q * 3), f.heat * q * q * 2, f.seed);
          break;
        }
        case 'ion': this.ion(f, q, t); break;
        case 'emit':
          if (f.emit === 'burn') {
            const fl = 0.75 + 0.25 * Math.sin(t * 17 + f.seed * 30) * Math.sin(t * 7.3);
            this.at(f.x, f.y, 0, true, v);
            this.ground.add(v.x, 2, v.z, 0, f.size * 5 * k, f.size * 5 * k, EMBER, 0.7, FxShape.Soft, q * 0.55 * fl);
            this.at(f.x, f.y, 30, true, v);
            D.add(v.x, v.y, v.z, 0, f.size * 4 * k, f.size * 5 * k, DistShape.Haze, 1.2 * q, 0, f.seed);
          }
          break;
      }
    }
  }

  /** The rail's ionised channel: a wavering violet thread that crackles and fades. */
  private ion(f: Fx, q: number, t: number) {
    const A = this.air, c = rgb(f.col || '#c9a6ff'), n = 18;
    const dx = f.x2 - f.x, dy = f.y2 - f.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    let px = f.x, py = f.y;
    for (let i = 1; i <= n; i++) {
      const u = i / n, w = Math.sin(u * 9 + t * 3 + f.seed * 20) * (1 - q) * 12 + Math.sin(u * 23 - t * 7) * (1 - q) * 4;
      const x = f.x + dx * u + nx * w, y = f.y + dy * u + ny * w;
      const fl = 0.6 + 0.4 * Math.sin(t * 50 + i * 1.7 + f.seed * 9);
      this.streak(A, px, py, x, y, AIR + 2, f.size * (1.2 + 1.6 * q), c, 2.4, q * q * fl * 0.8, FxShape.Beam);
      this.streak(A, px, py, x, y, AIR + 3, 2.5, WHITE, 3, q * q * q * fl, FxShape.Beam);
      px = x; py = y;
    }
    this.e.toFlight((f.x + f.x2) / 2, (f.y + f.y2) / 2, AIR, v);
    this.e.post.distort.add(v.x, v.y, v.z, Math.atan2(dy, dx), L, 40, DistShape.Line, q * 0.8, 0, f.seed);
  }

  /* ---------------- player projectiles ---------------- */
  private playerShot(p: Ent, t: number) {
    const e = this.e, A = this.air, G = this.ground, k = e.groundScale, c = rgb(p.col);
    switch (p.kind) {
      case 'bomb': {
        const q = p.life / p.max, h = Math.pow(q, 1.4);
        // Falling heat trail.
        for (let j = 1; j <= 5; j++) {
          const qq = Math.min(1, q + j * 0.045), hh = Math.pow(qq, 1.4);
          this.between(p.x - p.vx * j * 0.02, p.y - p.vy * j * 0.02, hh, a);
          A.add(a.x, a.y, a.z, 0, 9 - j, 9 - j, rgb('#ff9a3c'), 1.6, FxShape.Soft, 0.5 * (1 - j / 6));
        }
        this.between(p.x, p.y, h, v);
        A.add(v.x, v.y, v.z, Math.atan2(p.vy, p.vx), 12, 7, rgb('#14161a'), 1, FxShape.Dark, 1);
        A.add(v.x, v.y + 1, v.z, 0, 9, 9, c, 2.5, FxShape.Hot, 0.55 + 0.45 * Math.sin(t * 40));
        // Impact marker on the ground: a ring closing in as the bomb arrives.
        e.toGround(p.x, p.y, a);
        G.add(a.x, 1.2, a.z, 0, p.aoe * 2 * k * (0.6 + 0.6 * q), p.aoe * 2 * k * (0.6 + 0.6 * q), c, 1.2, FxShape.Ring, (1 - q) * 0.55, 0.05);
        return;
      }
      case 'shell': {
        const q = 1 - p.life / p.max;
        const alt = (qq: number) => 1 - qq + Math.sin(qq * Math.PI) * 0.55;
        let lx = 0, lz = 0, ly = 0;
        for (let j = 0; j < 12; j++) {
          const qq = q - j * 0.022; if (qq < 0) break;
          this.between(p.sx + (p.tx - p.sx) * qq, p.sy + (p.ty - p.sy) * qq, alt(qq), v);
          if (j > 0) {
            const dx = lx - v.x, dz = lz - v.z, L = Math.hypot(dx, dz);
            if (L > 0.01) A.add((lx + v.x) / 2, (ly + v.y) / 2, (lz + v.z) / 2, Math.atan2(dz, dx), L + 6, 7 * (1 - j / 12) + 2, c, 1.8, FxShape.Streak, 0.8 * (1 - j / 12));
          } else {
            A.add(v.x, v.y, v.z, 0, 18, 18, c, 3, FxShape.Hot, 1);
            A.add(v.x, v.y, v.z, 0, 46, 46, c, 0.6, FxShape.Soft, 0.6);
          }
          lx = v.x; ly = v.y; lz = v.z;
        }
        e.toGround(p.tx, p.ty, a);
        G.add(a.x, 1.2, a.z, -t * 2, p.aoe * 2.2 * k, p.aoe * 2.2 * k, c, 1, FxShape.Reticle, 0.45 + 0.3 * q, q);
        return;
      }
      case 'missile': {
        let id = this.ribbonOf.get(p);
        if (id === undefined) { id = this.ribbons.open(RibbonStyle.Player, p.x, p.y); this.ribbonOf.set(p, id); }
        if (id >= 0) this.ribbons.feed(id, p.x, p.y);
        const sp = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / sp, uy = p.vy / sp, ang = Math.atan2(uy, ux);
        e.toFlight(p.x, p.y, AIR + 2, v);
        A.add(v.x, v.y, v.z, ang, 12, 5, rgb('#2a2d33'), 1, FxShape.Dark, 0.95);
        e.toFlight(p.x - ux * 7, p.y - uy * 7, AIR + 3, a);
        const fl = 0.8 + 0.2 * Math.sin(t * 60 + p.x);
        A.add(a.x, a.y, a.z, ang, 26 * fl, 11, rgb('#ffb347'), 3, FxShape.Bolt, 1);
        A.add(a.x, a.y, a.z, 0, 34, 34, rgb('#ff8a3d'), 0.8, FxShape.Soft, 0.7);
        return;
      }
      case 'flak': {
        const sp = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / sp, uy = p.vy / sp;
        this.streak(A, p.x, p.y, p.x - ux * 40, p.y - uy * 40, AIR, 5, c, 1.8, 0.7);
        e.toFlight(p.x, p.y, AIR + 1, v);
        A.add(v.x, v.y, v.z, 0, 16, 16, rgb('#fff1c8'), 3, FxShape.Hot, 1);
        A.add(v.x, v.y, v.z, 0, 30 + 8 * Math.sin(t * 50), 30, c, 0.8, FxShape.Soft, 0.6);
        return;
      }
    }
    // Bolts: pulse cannon, scatter laser, drones.
    const sp = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / sp, uy = p.vy / sp, ang = Math.atan2(uy, ux);
    const L = p.r >= 3 ? 40 : p.r >= 2.5 ? 30 : 24, W = p.r * 3.4;
    e.toFlight(p.x - ux * L * 0.35, p.y - uy * L * 0.35, AIR, v);
    A.add(v.x, v.y, v.z, ang, L, W, c, 2.6, FxShape.Bolt, 1);
    this.streak(A, p.x - ux * L * 0.4, p.y - uy * L * 0.4, p.x - ux * L * 2.2, p.y - uy * L * 2.2, AIR - 1, W * 0.7, c, 1.2, 0.35);
    e.toFlight(p.x, p.y, AIR, v);
    A.add(v.x, v.y, v.z, 0, W * 5, W * 5, c, 0.6, FxShape.Soft, 0.45);
  }

  /* ---------------- enemy fire: threat magenta, dark rims, always readable ---------------- */
  private enemyShot(bl: Ent, t: number) {
    const e = this.e, H = this.hostile, D = e.post.distort;
    if (bl.kind === 'strike') {
      const q = clamp(bl.t / bl.delay, 0, 1);
      e.toFlight(bl.x, bl.y, AIR - 6, v);
      const R = bl.rad * 2.2;
      H.add(v.x, v.y, v.z, t * 0.8, R, R, HOSTILE, 1.6 + 1.2 * Math.abs(Math.sin(bl.t * 14)), FxShape.Reticle, 0.9, q);
      // The shell climbing out of the city toward you.
      const h = q * q;
      for (let j = 0; j < 6; j++) {
        const hh = h - j * 0.03; if (hh < 0) break;
        this.between(bl.x, bl.y, hh, a);
        H.add(a.x, a.y, a.z, 0, (j ? 12 - j : 16), (j ? 12 - j : 16), j ? HOSTILE : HOSTILE_HOT, j ? 1.5 : 3, j ? FxShape.Soft : FxShape.Hostile, j ? 0.6 * (1 - j / 6) : 1);
      }
      return;
    }
    if (bl.kind === 'beam') {
      // Vertical beams run down the screen from (x, y); ghost broadside rails carry their own end point.
      const x2 = bl.x2 ?? bl.x, y2 = bl.y2 ?? FIELD_H + 80;
      if (bl.t < bl.warn) {
        const q = bl.t / bl.warn, fl = 0.4 + 0.6 * Math.abs(Math.sin(bl.t * 26));
        this.streak(H, bl.x, bl.y, x2, y2, AIR, 3 + 5 * q, HOSTILE, 1.4, (0.25 + 0.5 * q) * fl, FxShape.Beam);
        e.toFlight(bl.x, bl.y, AIR + 4, v);
        H.add(v.x, v.y, v.z, 0, 24 + 80 * q, 24 + 80 * q, HOSTILE, 1.5 + 2 * q, FxShape.Hot, 0.9);
        H.add(v.x, v.y, v.z, t * 4, 140 * (1 - q) + 30, 140 * (1 - q) + 30, HOSTILE, 1.4, FxShape.Ring, q, 0.05);
      } else {
        if (!this.seen.has(bl)) { this.seen.add(bl); railFx(bl.x, bl.y, x2, y2, PAL.threat, true); }
        const q = clamp(1 - (bl.t - bl.warn) / bl.dur, 0, 1);
        this.streak(H, bl.x, bl.y, x2, y2, AIR, bl.w * 4.2, HOSTILE, 1.3, 0.55 * q, FxShape.Beam);
        this.streak(H, bl.x, bl.y, x2, y2, AIR + 1, bl.w * 1.4, HOSTILE_HOT, 2.6, q, FxShape.Beam);
        this.streak(H, bl.x, bl.y, x2, y2, AIR + 2, bl.w * 0.5, WHITE, 3, q, FxShape.Beam);
        e.toFlight((bl.x + x2) / 2, (bl.y + y2) / 2, AIR, v);
        D.add(v.x, v.y, v.z, Math.atan2(y2 - bl.y, x2 - bl.x), Math.hypot(x2 - bl.x, y2 - bl.y), bl.w * 6, DistShape.Line, q, 0, 0.2);
      }
      return;
    }
    const sp = Math.hypot(bl.vx, bl.vy) || 1, ux = bl.vx / sp, uy = bl.vy / sp;
    if (bl.kind === 'missile') {
      let id = this.ribbonOf.get(bl);
      if (id === undefined) { id = this.ribbons.open(RibbonStyle.Hostile, bl.x, bl.y); this.ribbonOf.set(bl, id); }
      if (id >= 0) this.ribbons.feed(id, bl.x, bl.y);
      // Missiles: a long pale dart (not a round) with a magenta exhaust and a blinking seeker ring.
      const ang = Math.atan2(uy, ux);
      e.toFlight(bl.x - ux * 14, bl.y - uy * 14, AIR + 1, a);
      H.add(a.x, a.y, a.z, ang, 30, 9, HOSTILE, 2.4, FxShape.Bolt, 0.95);
      e.toFlight(bl.x - ux * 3, bl.y - uy * 3, AIR + 2, a);
      H.add(a.x, a.y, a.z, ang, 18, 5, MISSILE_SHADE, 1, FxShape.Dark, 0.9);
      H.add(a.x, a.y, a.z, ang, 16, 3.6, MISSILE_BODY, 2.2, FxShape.Bolt, 1);
      e.toFlight(bl.x, bl.y, AIR + 3, v);
      H.add(v.x, v.y, v.z, t * 3, 26, 26, HOSTILE, 1.6, FxShape.Ring, Math.sin(t * 30) > 0 ? 0.9 : 0.35, 0.12);
      return;
    }
    e.toFlight(bl.x, bl.y, AIR + 3, v);
    if (bl.kind === 'mine' || bl.kind === 'orb') {
      const pulse = 0.5 + 0.5 * Math.sin(bl.t * (bl.life < 0.5 ? 40 : 14));
      const s = bl.r * 4.6 * (1 + 0.15 * pulse);
      H.add(v.x, v.y, v.z, 0, s, s, bl.kind === 'orb' ? HOSTILE_HOT : HOSTILE, 2.2, FxShape.Hostile, 1, pulse);
      const R = s * (1.6 + 1.2 * clamp(1 - bl.life, 0, 1));
      H.add(v.x, v.y, v.z, t, R, R, HOSTILE, 1.4, FxShape.Ring, 0.35 + 0.4 * pulse, 0.06);
      return;
    }
    // Bullets: dark-rimmed magenta cores with white centres and a short motion smear (no wide haze).
    const s = bl.r * 5.2;
    H.add(v.x, v.y, v.z, 0, s * 2, s * 2, HOSTILE, 0.45, FxShape.Soft, 0.6);
    if (sp > 20) this.streak(H, bl.x, bl.y, bl.x - ux * bl.r * 7, bl.y - uy * bl.r * 7, AIR + 2, bl.r * 2.4, HOSTILE, 1.8, 0.65);
    H.add(v.x, v.y, v.z, 0, s, s, HOSTILE, 2.8, FxShape.Hostile, 1);
  }

  /* ---------------- beams ---------------- */
  private beam(bm: Beam, t: number) {
    const e = this.e, A = this.air, D = e.post.distort, q = bm.life / bm.max, c = rgb(bm.col);
    const hostile = bm.col === '#ff9f9f';
    if (bm.zig) {
      let bo = this.bolts.get(bm);
      if (!bo) { bo = { segs: new Float32Array(5 * 80), n: 0, t: -1 }; this.bolts.set(bm, bo); }
      if (t - bo.t > 0.045 || bo.t < 0) { genBolt(bo, bm.x1, bm.y1, bm.x2, bm.y2); bo.t = t; }
      const s = bo.segs;
      for (let i = 0; i < bo.n; i++) {
        const o = i * 5, w = s[o + 4];
        this.streak(A, s[o], s[o + 1], s[o + 2], s[o + 3], AIR + 6, 20 * w, c, 2.4, 0.6 * q, FxShape.Beam);
        this.streak(A, s[o], s[o + 1], s[o + 2], s[o + 3], AIR + 7, 3 * w + 0.8, WHITE, 5, q, FxShape.Beam);
      }
      e.toFlight(bm.x2, bm.y2, AIR + 6, v);
      A.add(v.x, v.y, v.z, t * 9, 40, 40, c, 2.4, FxShape.Star, q, 0, (t * 7) % 1);
      A.add(v.x, v.y, v.z, 0, 70, 70, c, 0.8, FxShape.Soft, q * 0.8);
      if (!this.seen.has(bm)) { this.seen.add(bm); addFx({ type: 'light', x: bm.x2, y: bm.y2, life: 0.18, max: 0.18, size: 160, str: 14, col: bm.col }); }
      return;
    }
    if (bm.w >= 3) { // rail
      if (!this.seen.has(bm)) { this.seen.add(bm); railFx(bm.x1, bm.y1, bm.x2, bm.y2, bm.col); }
      const qq = Math.pow(q, 0.6), sw = 1 + 0.5 * (1 - q);
      this.streak(A, bm.x1, bm.y1, bm.x2, bm.y2, AIR + 3, bm.w * 16 * sw, c, 2.2, 0.7 * qq, FxShape.Beam);
      this.streak(A, bm.x1, bm.y1, bm.x2, bm.y2, AIR + 4, bm.w * 4.5, c, 5, qq, FxShape.Beam);
      this.streak(A, bm.x1, bm.y1, bm.x2, bm.y2, AIR + 5, bm.w * 1.6, WHITE, 8, qq, FxShape.Beam);
      e.toFlight(bm.x1, bm.y1, AIR + 6, v);
      A.add(v.x, v.y, v.z, 0, 90 * qq, 90 * qq, c, 4, FxShape.Hot, qq);
      e.toFlight((bm.x1 + bm.x2) / 2, (bm.y1 + bm.y2) / 2, AIR, v);
      D.add(v.x, v.y, v.z, Math.atan2(bm.y2 - bm.y1, bm.x2 - bm.x1), Math.hypot(bm.x2 - bm.x1, bm.y2 - bm.y1), bm.w * 10, DistShape.Line, q * 1.2, 0, 0.5);
      return;
    }
    // Point defence: a stream of tracers racing to the intercept.
    const B = hostile ? this.hostile : A;
    const dx = bm.x2 - bm.x1, dy = bm.y2 - bm.y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, u0 = 1 - q;
    for (let i = 0; i < 4; i++) {
      const u = (u0 * 1.6 + i * 0.22) % 1, x = bm.x1 + dx * u, y = bm.y1 + dy * u;
      this.streak(B, x - ux * 9, y - uy * 9, x + ux * 9, y + uy * 9, AIR + 4, 3, c, 2.8, 0.9 * q);
    }
    this.streak(B, bm.x1, bm.y1, bm.x2, bm.y2, AIR + 3, 1.6, c, 1.2, 0.35 * q);
    e.toFlight(bm.x1, bm.y1, AIR + 5, v);
    B.add(v.x, v.y, v.z, Math.atan2(dy, dx), 16, 16, c, 2.5, FxShape.Star, q, 0, 0.3);
  }

  /* ---------------- lights ---------------- */
  private updateLights(list: Fx[], dt: number) {
    const e = this.e, k = e.groundScale, C = this.cand, Sc = this.score;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i]; if (f.delay > 0) continue;
      let s = 0;
      if (f.type === 'light') s = (f.str || f.size / 4) * (f.life / f.max);
      else if (f.type === 'emit' && f.emit === 'burn') s = f.size * 0.25 * (f.life / f.max);
      if (s <= 0) continue;
      // Keep the top N_LIGHTS by insertion (small fixed arrays, no allocation).
      if (n < N_LIGHTS) { C[n] = f; Sc[n] = s; n++; }
      else { let lo = 0; for (let j = 1; j < N_LIGHTS; j++) if (Sc[j] < Sc[lo]) lo = j; if (s > Sc[lo]) { C[lo] = f; Sc[lo] = s; } }
    }
    for (let i = 0; i < N_LIGHTS; i++) {
      const l = this.lights[i];
      if (i >= n) { l.intensity = 0; continue; }
      const f = C[i], q = f.life / f.max;
      if (f.type === 'emit') {
        e.toGround(f.x, f.y, v); v.y = 30 * k;
        l.color.set('#ff7a2a'); l.position.copy(v);
        l.distance = f.size * 10 * k; l.intensity = 3500 * q * (0.8 + 0.2 * Math.sin(performance.now() * 0.02 + f.seed * 40));
        continue;
      }
      if (f.ground) { e.toGround(f.x, f.y, v); v.y = 45 * k; } else e.toFlight(f.x, f.y, 90, v);
      // Colour cools from white-hot through amber as the blast fades.
      l.color.set(f.col || '#ff8a3d').lerp(_white, q * q * 0.6);
      l.position.copy(v);
      l.distance = f.size * 2.2 * (f.ground ? k : 1);
      l.intensity = (2500 + 420 * (f.str || 10)) * q * q;
    }
    // Muzzle light rides just above the hull and pulses with every shot.
    const ml = this.muzzleLight;
    V.muzzleE *= Math.exp(-dt * 16);
    if (V.muzzleE > 0.02) { e.toFlight(V.muzzleX, V.muzzleY, 70, v); ml.position.copy(v); ml.color.set(V.muzzleCol); ml.intensity = 1600 * Math.min(2, V.muzzleE); }
    else ml.intensity = 0;
  }
}
const _white = new THREE.Color(1, 1, 1);
