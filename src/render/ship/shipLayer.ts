// Ship layer: the player's dreadnought and ghost-dreadnought bosses.
// Builds (and caches by build signature) a procedural carrier-scale warship per hull, then drives it
// every frame: mass-y banking and settling, turret slew and recoil, engine plumes, steam, battle damage.
// See hull.ts for the construction and materials.ts for the livery.
import * as THREE from 'three';
import type { Engine, FrameCtx, Layer } from '../engine';
import { FIELD_W, FIELD_H } from '../engine';
import { buildToGhost, derive, starterBuild, type Derived } from '../../data/parts';
import { rgb, Shape, DarkShape } from '../fx/quads';
const DRONE_HULL = rgb('#2a3038');
import { clamp } from '../../util/rng';
import { dronePos, fireLog, manualAimFor, type Ent } from '../../game/combat';
import { addFx, FIRE } from '../../game/vfx';
import { kitLoaded } from '../assets';
import { livery } from './materials';
import { buildShip, disposeShip, DECK, type ShipModel } from './hull';
import { lightUniforms } from './lights';
import type { Gun, Turret } from './turrets';
import type { V3 } from './mesh';
import { aimYaw, restYaw, holdYaw, slewDelta, bearingIn, type Traverse } from './arcs';

/** Flight-plane altitude of the ship origin: keeps the deck just under the bullet/muzzle layer. */
const P_ALT = -10;
const v = new THREE.Vector3(), w = new THREE.Vector3(), d = new THREE.Vector3();
/** Is a field offset (dx, dy) from the mount inside its traverse? */
const inArc = (tv: Traverse, dx: number, dy: number) => tv.half >= Math.PI || bearingIn(tv, Math.atan2(dy, dx));
/** World point (centred field) to field coordinates, in place. */
const toField = (p: THREE.Vector3) => { p.x += FIELD_W / 2; p.z += FIELD_H / 2; return p; };

interface Rig {
  model: ShipModel; sig: string;
  px: number; py: number; vx: number; vy: number;
  roll: number; rollV: number; pitch: number; pitchV: number; yaw: number;
  seen: Map<number, number>; retarget: Map<number, number>; aims: Map<number, number>;
  fireAcc: number; sparkAcc: number; smokeAcc: number;
  /** Ghosts: escalation 0..2 eased toward phase - 1, the phase last seen, seconds left of a phase-change blackout. */
  esc: number; lastPh: number; outage: number;
}

export class ShipLayer implements Layer {
  name = 'ship';
  private cache = new Map<string, ShipModel>();
  private player: Rig | null = null;
  private boss: Rig | null = null;
  private bossRef: unknown = null;
  constructor(private engine: Engine) {}

  /** Cached ship model for a hull (built on first use). */
  private model(dv: Derived, hostile: boolean, sigBase: string, callsign = '') {
    const sig = `${hostile ? 'G' : 'P'}|${kitLoaded('scifi') ? 1 : 0}|${callsign}|${sigBase}`;
    let m = this.cache.get(sig);
    if (!m) {
      const t0 = performance.now(), L = livery(hostile, this.engine.renderer), t1 = performance.now();
      m = buildShip(dv, L, sigBase, callsign);
      if (import.meta.env.DEV) console.info(`[ship] livery ${(t1 - t0).toFixed(0)} ms; built ${hostile ? 'ghost' : 'player'} hull in ${(performance.now() - t1).toFixed(0)} ms, ${Math.round(m.tris / 1000)}k tris, ${m.lights.geometry.getAttribute('position').count} lights`);
      this.cache.set(sig, m);
      // Keep a handful of hulls (refits flip back and forth); dispose the oldest beyond that.
      while (this.cache.size > 5) {
        const [k, old] = this.cache.entries().next().value as [string, ShipModel];
        if (old === this.player?.model || old === this.boss?.model) { this.cache.delete(k); this.cache.set(k, old); break; }
        this.cache.delete(k); old.root.removeFromParent(); disposeShip(old);
      }
    }
    return { m, sig };
  }

  private rig(prev: Rig | null, dv: Derived, hostile: boolean, sigBase: string, x: number, y: number, callsign = ''): Rig {
    const { m, sig } = this.model(dv, hostile, sigBase, callsign);
    if (prev && prev.sig === sig) return prev;
    if (prev) prev.model.root.removeFromParent();
    this.engine.scene.add(m.root);
    const seen = new Map<number, number>();
    for (const t of m.turrets) seen.set(t.uid, fireLog.get(t.uid) ?? -1);
    return {
      model: m, sig, px: x, py: y, vx: 0, vy: 0, roll: 0, rollV: 0, pitch: 0, pitchV: 0, yaw: 0,
      seen, retarget: new Map(), aims: new Map(), fireAcc: 0, sparkAcc: 0, smokeAcc: 0, esc: 0, lastPh: 0, outage: 0,
    };
  }

  private cs: string | null = null;
  /** The commander's callsign, stencilled on the deck (read once from the saved profile). */
  private callsign() {
    if (this.cs === null) { try { this.cs = localStorage.getItem('gd.callsign') || ''; } catch { this.cs = ''; } }
    return this.cs;
  }

  clear() {
    if (this.boss) { this.boss.model.root.removeFromParent(); this.boss = null; this.bossRef = null; }
  }

  private warmed = false;
  /**
   * Once the kit is loaded and no fight is running, prepare both liveries (env probe, maps) and
   * compile their shaders on a starter hull, so the first fight starts without a hitch.
   */
  private warm(S: FrameCtx['S']) {
    if (this.warmed || !kitLoaded('scifi') || S.active) return;
    this.warmed = true;
    const e = this.engine, scene = new THREE.Scene();
    for (const hostile of [false, true]) scene.add(this.model(derive(starterBuild()), hostile, JSON.stringify(buildToGhost(starterBuild()))).m.root);
    void e.renderer.compileAsync(scene, e.camera, e.scene).catch(() => undefined);
    scene.clear();
  }

  update({ S, dt, t, showPlayer }: FrameCtx) {
    const e = this.engine, rdt = Math.max(1 / 240, Math.min(0.1, dt));
    this.warm(S);
    lightUniforms.uTime.value = t;
    lightUniforms.uPx.value = e.renderer.domElement.height * e.camera.projectionMatrix.elements[5] * 0.5;
    const P = S.P;
    if (P && showPlayer) {
      this.player = this.rig(this.player, P.dv, false, JSON.stringify(buildToGhost(P.build)), P.x, P.y, this.callsign());
      const r = this.player, m = r.model;
      m.root.visible = true;
      this.motion(r, P.x, P.y, rdt, t, 1, false);
      e.toFlight(P.x, P.y, P_ALT + this.bob(t, 1), m.root.position);
      m.root.rotation.set(r.pitch, r.yaw, r.roll, 'YXZ');
      m.root.scale.set(1, 1, 1);
      m.root.updateMatrixWorld(true);
      this.turrets(r, S, rdt, t, false, P.x, P.y, 1, P.cds);
      this.animate(r, rdt, 1);
      this.plumes(r, t, 1, false, clamp(0.55 + Math.max(0, -r.vy) / 260, 0.4, 1.3));
      this.steam(r, t, 1);
      this.damage(r, P.hp / P.dv.maxHp, rdt, t, 1, false);
      if (P.flash > 0) { e.toFlight(P.x, P.y, 30, v); e.glow.add(v.x, v.y, v.z, 0, P.dv.width * 1.5, P.dv.len * 1.2, rgb('#ffffff'), P.flash * 0.3, Shape.Soft); }
      if (P.shield > 0) { e.toFlight(P.x, P.y, 8, v); e.glow.add(v.x, v.y, v.z, 0, P.dv.width + 40, P.dv.len + 40, rgb('#4fd1e8'), (0.3 + 0.4 * (P.shield / P.dv.shieldMax)) * (P.lastHit < 0.2 ? 1.8 : 1), Shape.Ring); }
      // Escort drones at warship scale: a small dark airframe, a pinpoint engine and a blinking strobe (no glow balls).
      for (let i = 0; i < P.dv.drones; i++) {
        const p = dronePos(i, P.dv.drones); e.toFlight(p.x, p.y, 10, v);
        e.dark.add(v.x, v.y, v.z, i, 6, 6, DRONE_HULL, 0.85, DarkShape.Rect);
        e.glow.add(v.x, v.y, v.z, 0, 4, 4, rgb('#7fb6ff'), 0.7, Shape.Hot);
        if (((t * 1.6 + i * 0.37) % 1) < 0.12) e.glow.add(v.x, v.y, v.z, 0, 3, 3, rgb('#ffffff'), 0.9, Shape.Hot);
      }
    } else if (this.player) this.player.model.root.visible = false;

    const Bo = S.boss;
    if (Bo && (Bo.alive || S.mode === 'bossdown')) {
      if (this.bossRef !== Bo) { this.clear(); this.bossRef = Bo; }
      this.boss = this.rig(this.boss, Bo.dv, true, JSON.stringify(buildToGhost(Bo.build)), Bo.x, Bo.y, Bo.ghost?.name ?? '');
      const r = this.boss, m = r.model, s = Bo.s, L = livery(true, e.renderer);
      m.root.visible = true;
      const sink = S.mode === 'bossdown' ? clamp((2.6 - S.endT) / 2.6, 0, 1) : 0;
      this.motion(r, Bo.x, Bo.y, rdt, t, s, true);
      e.toFlight(Bo.x, Bo.y, -(DECK + 2) * m.k * s - sink * 300 + this.bob(t + 2, s), m.root.position); m.root.position.z += sink * 60;
      m.root.rotation.set(r.pitch + sink * 0.5, r.yaw, r.roll + sink * 0.7, 'YXZ');
      m.root.scale.set(s, s, -s);
      m.root.updateMatrixWorld(true);
      // The ghost's signature (docs/ART.md "Ghost bosses"): failing power. A slow brownout breath with
      // stutters that grow as it escalates, and a blackout on each phase change (66%, 33%) before the
      // emergency lighting comes back with more of the ship dark.
      if (Bo.phase !== r.lastPh) { if (r.lastPh) r.outage = 1.1; r.lastPh = Bo.phase; }
      r.esc += (Bo.phase - 1 - r.esc) * (1 - Math.exp(-rdt * 1.2));
      r.outage = Math.max(0, r.outage - rdt);
      const esc = r.esc;
      let fl = 0.84 + 0.08 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 7.9) - (Math.sin(t * 5.7) * Math.sin(t * 3.1) > 0.9 - 0.06 * esc ? 0.4 : 0) - (Math.random() < 0.025 * esc ? 0.35 : 0);
      if (r.outage > 0) fl *= r.outage > 0.45 ? (Math.random() < 0.12 ? 0.6 : 0.06) : 1 - r.outage;
      const pulse = 0.75 + 0.25 * Math.sin(t * 1.7);
      // The point lights carry the corpse-light signature at game zoom: they run a little hotter than the hull's emissives.
      L.u.flicker.value = fl; lightUniforms.uFlick.value = fl * 1.6; L.u.time.value = t;
      L.u.pulse.value = pulse; L.u.dead.value = 0.5 + 0.15 * esc; L.u.ember.value = 0.35 + 0.3 * esc + 0.1 * Math.sin(t * 2.1);
      (m.lights.material as THREE.ShaderMaterial).uniforms.uAlarm.value = r.outage > 0.45 ? 0 : 0.3 + esc * 0.35;
      if (m.edges) (m.edges.material as THREE.LineBasicMaterial).opacity = 0.55 * pulse * (0.7 + 0.3 * fl);
      this.turrets(r, S, rdt, t, true, Bo.x, Bo.y, s, null);
      this.animate(r, rdt, s);
      this.plumes(r, t, s, true, 0.75 - 0.1 * esc, esc);
      this.steam(r, t, s);
      this.damage(r, Bo.hp / Bo.maxHp, rdt, t, s, true, esc);
      // A faint cold-red breath under the hull: menace without a glow sign.
      e.toFlight(Bo.x, Bo.y, -40, v); e.glow.add(v.x, v.y, v.z, 0, Bo.halfW * 2.6, Bo.dv.len * s * 1.2, rgb('#ff3a2e'), 0.04 * pulse, Shape.Soft);
      // Hit flash: a faint pulse only. Under sustained fire it is on almost every frame, and a strong one washes the dark hull out.
      if (Bo.flash > 0) { e.toFlight(Bo.x, Bo.y, 20, v); e.glow.add(v.x, v.y, v.z, 0, Bo.halfW * 2, Bo.dv.len * s, rgb('#ffd0c0'), 0.07, Shape.Soft); }
      if (Bo.shield > 0) { e.toFlight(Bo.x, Bo.y, 14, v); e.glow.add(v.x, v.y, v.z, 0, Bo.halfW * 2 + 50, Bo.dv.len * s + 50, rgb('#ff6a52'), (0.22 + 0.4 * Bo.shield / Bo.shieldMax) * (Bo.shieldHitT < 0.15 ? 1.8 : 1), Shape.Ring); }
    } else this.clear();
  }

  /** Mass-y motion: a damped spring on roll and pitch driven by smoothed velocity. */
  private motion(r: Rig, x: number, y: number, dt: number, t: number, s: number, mirrored: boolean) {
    const ivx = (x - r.px) / dt, ivy = (y - r.py) / dt; r.px = x; r.py = y;
    const k = 1 - Math.exp(-dt * 5); r.vx += (clamp(ivx, -900, 900) - r.vx) * k; r.vy += (clamp(ivy, -900, 900) - r.vy) * k;
    const sgn = mirrored ? -1 : 1;
    const rollT = clamp(-r.vx / 900, -0.26, 0.26) * (mirrored ? 0.7 : 1) + Math.sin(t * 0.37 + s) * 0.012;
    const pitchT = clamp(r.vy / 2400, -0.07, 0.07) * sgn;
    const w0 = 2.4, z = 0.55;
    r.rollV += ((rollT - r.roll) * w0 * w0 - 2 * z * w0 * r.rollV) * dt; r.roll += r.rollV * dt;
    r.pitchV += ((pitchT - r.pitch) * w0 * w0 - 2 * z * w0 * r.pitchV) * dt; r.pitch += r.pitchV * dt;
    r.yaw += (clamp(-r.vx / 5000, -0.05, 0.05) * sgn - r.yaw) * (1 - Math.exp(-dt * 2));
  }
  private bob(t: number, s: number) { return (Math.sin(t * 0.7) * 1.1 + Math.sin(t * 1.27 + 1) * 0.45) * s; }

  /**
   * Turret training. Each mount trains inside its own traverse (arcs.ts): dorsal mounts all round and
   * anti-air only, bow casemates in a forward cone, flank sponsons across their own beam; with nothing in
   * the arc a gun goes back to rest. Ghosts are mirrored (bow down the screen) and train on the player
   * only when the player is inside the mount's arc, so their broadside guns stay on the broadside.
   */
  private turrets(r: Rig, S: FrameCtx['S'], dt: number, t: number, hostile: boolean, sx: number, sy: number, s: number, cds: Record<number, number> | null) {
    const P = S.P, Bo = S.boss, m = r.model, k = m.k;
    for (let i = 0; i < m.turrets.length; i++) {
      const tr = m.turrets[i], tv = tr.trav;
      const fx = sx + tr.x * k * s, fy = hostile ? sy - tr.z * k * s : sy + tr.z * k * s;
      if (tr.aim === 'spin') tr.cur += tr.rate * dt;
      else if (tr.aim === 'fixed') tr.cur = tv.center;
      else {
        let rt = (r.retarget.get(tr.uid) ?? 0) - dt;
        if (rt <= 0) {
          rt = 0.15 + Math.random() * 0.1;
          let want = restYaw(tv, tr.cur);
          if (hostile) { if (P) want = aimYaw(tv, Math.atan2(P.y - fy, P.x - fx), true, tr.cur); }
          else {
            // Heavy guns flown by the mouse train on the reticle (or the missile lock), still inside their arc.
            const tg = manualAimFor(tr.uid) ?? this.target(tr, S.enemies, S.eb, Bo && Bo.alive ? Bo : null, fx, fy);
            if (tg) want = aimYaw(tv, Math.atan2(tg.y - fy, tg.x - fx), false, tr.cur);
          }
          r.aims.set(tr.uid, want);
        }
        r.retarget.set(tr.uid, rt);
        const want = r.aims.get(tr.uid) ?? tv.center, dd = slewDelta(tv, tr.cur, want), mx = tr.rate * dt;
        // Ease in the last few degrees so heavy guns settle instead of snapping.
        tr.cur += clamp(dd * Math.min(1, dt * 6), -mx, mx);
        tr.cur = holdYaw(tv, tr.cur);
      }
      const lf = fireLog.get(tr.uid);
      if (lf !== undefined && lf !== r.seen.get(tr.uid)) {
        r.seen.set(tr.uid, lf);
        // The cluster fires as a short ripple, gun by gun.
        for (let g = 0; g < tr.guns.length; g++) tr.guns[g].delay = 1e-4 + g * 0.045;
        if (tr.id === 'bomb') tr.door = 1;
      }
      // Rail charge glow follows the cooldown.
      if (tr.charge) {
        const cd = cds ? cds[tr.uid] ?? 0 : 0.5, q = hostile ? 0.5 + 0.5 * Math.sin(t * 3) : clamp(1 - cd / 1.7, 0, 1);
        if (q > 0.05) for (const g of tr.guns) this.chargeGlow(m, g, tr.cur, tr.charge, q * q, s);
      }
    }
  }
  private chargeGlow(m: ShipModel, g: Gun, yaw: number, ch: [V3, V3], q: number, s: number) {
    const e = this.engine;
    this.gunPoint(m, g, yaw, ch[0], v); this.gunPoint(m, g, yaw, ch[1], w);
    const len = Math.hypot(w.x - v.x, w.z - v.z);
    e.glow.add((v.x + w.x) / 2, (v.y + w.y) / 2 + 0.5, (v.z + w.z) / 2, Math.atan2(w.z - v.z, w.x - v.x), len, 1.4 * m.k * s, rgb(m.hostile ? '#ff7a6b' : '#c9a6ff'), 0.25 + 0.6 * q, Shape.Streak);
  }
  /** World position of a point in a gun's local space (yaw 0 toward the bow). */
  private gunPoint(m: ShipModel, g: Gun, yaw: number, p: V3, out: THREE.Vector3) {
    const c = Math.cos(yaw), sn = Math.sin(yaw), x = p[0] * g.gs, y = p[1] * g.gs, z = p[2] * g.gs;
    out.set(c * x + sn * z + g.px, y + g.py, -sn * x + c * z + g.pz);
    return m.body.localToWorld(out);
  }
  private target(tr: Turret, enemies: FrameCtx['S']['enemies'], eb: Ent[], boss: Ent | null, x: number, y: number): Ent | null {
    const tv = tr.trav;
    let best: Ent | null = null, bd = tr.layer === 'none' ? 260 * 260 : 760 * 760;
    if (tr.layer === 'none') {
      for (const b of eb) { if (b.dead || b.kind === 'beam' || b.kind === 'strike') continue; const dd = (b.x - x) ** 2 + (b.y - y) ** 2; if (dd < bd) { bd = dd; best = b; } }
      return best;
    }
    for (const en of enemies) {
      if (en.dead) continue;
      if (tr.layer === 'air' ? en.layer === 'ground' : tr.layer === 'ground' ? en.layer !== 'ground' : false) continue;
      const dd = (en.x - x) ** 2 + (en.y - y) ** 2; if (dd < bd && inArc(tv, en.x - x, en.y - y)) { bd = dd; best = en; }
    }
    if (boss && inArc(tv, boss.x - x, boss.y - y)) { const dd = (boss.x - x) ** 2 + (boss.y - y) ** 2 * 0.5; if (dd < bd || (!best && tr.layer === 'ground')) best = boss; }
    return best;
  }
  /** Recoil ripples, bay doors, the gun uniforms; spinning radars. */
  private animate(r: Rig, dt: number, s: number) {
    const m = r.model, A = m.rig.u.uGunA.value, Bv = m.rig.u.uGunB.value, e = this.engine;
    for (let i = 0; i < m.turrets.length; i++) {
      const tr = m.turrets[i], decay = tr.id === 'artillery' || tr.id === 'rail' ? 3.5 : 8;
      if (tr.door > 0) tr.door = Math.max(0, tr.door - dt * 0.9);
      for (const g of tr.guns) {
        if (g.delay > 0) {
          g.delay -= dt;
          if (g.delay <= 0) {
            g.delay = 0; g.kick = 1;
            // Barrel-tip flash at the real muzzle (combat's own muzzle fx marks the mount).
            for (const mz of g.muzzles) { this.gunPoint(m, g, tr.cur, mz, v); e.glow.add(v.x, v.y + 1, v.z, 0, 4.5 * m.k * s, 4.5 * m.k * s, rgb(m.hostile ? '#ff7a5c' : '#fff1c1'), 0.9, Shape.Hot); }
          }
        } else if (g.kick > 0.001) g.kick *= Math.exp(-dt * decay); else g.kick = 0;
        A[g.idx * 4 + 3] = tr.cur;
        Bv[g.idx * 4] = tr.recoil * (1 - Math.pow(1 - g.kick, 3));
        Bv[g.idx * 4 + 1] = Math.min(1, tr.door * 3) * 2.1;
      }
    }
    for (const sp of m.spinners) sp.obj.rotation.y += sp.speed * dt;
  }

  /** Engine plumes: hot core, long streak and soft bloom per nozzle, flickering with thrust. */
  /** `esc` (ghosts): past phase 2 the drives sputter, one nozzle at a time cutting out. */
  private plumes(r: Rig, t: number, s: number, hostile: boolean, thrust: number, esc = 0) {
    const e = this.engine, m = r.model, L = livery(hostile, e.renderer).light;
    d.set(0, 0, 1).transformDirection(m.root.matrixWorld);
    const rot = Math.atan2(d.z, d.x);
    for (let i = 0; i < m.nozzles.length; i++) {
      const n = m.nozzles[i];
      v.set(n.x, n.y, n.z).applyMatrix4(m.root.matrixWorld);
      let fl = 0.85 + 0.15 * Math.sin(t * 31 + i * 2.1) + 0.08 * Math.sin(t * 13.3 + i);
      if (hostile) fl *= 0.8 + 0.2 * Math.sin(t * 4.3 + i * 1.7) - (esc > 0.8 && ((t * 0.6 + i * 0.41) % 1) < 0.08 * esc ? 0.6 : 0);
      if (n.main) {
        const rr = n.r * s, len = rr * (4.5 + 3.5 * thrust) * fl;
        e.glow.add(v.x, v.y, v.z, 0, rr * 2.6, rr * 2.6, rgb(L.engineHot), 0.9, Shape.Hot);
        e.glow.add(v.x + d.x * len * 0.5, v.y, v.z + d.z * len * 0.5, rot, len, rr * 1.7, rgb(L.engine), 0.75 * fl, Shape.Streak);
        e.glow.add(v.x + d.x * len * 0.25, v.y, v.z + d.z * len * 0.25, rot, len * 0.55, rr * 0.8, rgb(L.engineHot), 0.8 * fl, Shape.Streak);
        e.glow.add(v.x + d.x * rr, v.y - 4, v.z + d.z * rr, 0, rr * 6, rr * 6, rgb(L.engine), 0.22 * thrust, Shape.Soft);
      } else {
        // Manoeuvring jets fire against lateral motion.
        const aft = n.aft ?? n.r > 2, side = Math.sign(n.x) * (hostile ? -1 : 1), q = aft ? 0.6 : clamp((side < 0 ? r.vx : -r.vx) / 260, 0, 1);
        if (q > 0.05) {
          const ox = aft ? d.x : Math.sign(n.x) * (hostile ? -1 : 1), oz = aft ? d.z : 0, rr = n.r * s;
          e.glow.add(v.x + ox * rr * 2, v.y, v.z + oz * rr * 2, Math.atan2(oz, ox), rr * 5 * q * fl, rr * 1.2, rgb(L.engine), 0.7 * q, Shape.Streak);
        }
      }
    }
  }

  /** Steam and exhaust haze from vents and stacks: stateless puffs that drift aft. */
  private steam(r: Rig, t: number, s: number) {
    const e = this.engine, m = r.model;
    d.set(0, 0, 1).transformDirection(m.root.matrixWorld);
    for (let i = 0; i < m.vents.length; i++) {
      const vp = m.vents[i];
      v.set(vp[0], vp[1], vp[2]).applyMatrix4(m.root.matrixWorld);
      for (let k = 0; k < 3; k++) {
        const q = (t * 0.45 + k / 3 + i * 0.37) % 1, sz = (1.5 + q * 6) * s * m.k;
        e.dark.add(v.x + d.x * q * 10 * s * m.k + Math.sin(i + q * 3) * s, v.y + 2 + q * 4, v.z + d.z * q * 10 * s * m.k, q * 2, sz, sz, rgb('#a9b2bb'), (1 - q) * q * 0.5, DarkShape.Soft);
      }
    }
  }

  /**
   * Battle damage. Player: scorch from 75%, sparks under 60%; fires, smoke and venting under 30%.
   * Ghosts (`esc` 0..2, eased phase): the wreck is scarred from the start (scorch with smouldering embers,
   * smoke trails streaming aft from its old wounds); phase 2 lights fires and venting, phase 3 sets the
   * whole hull burning, and the last third of its hull adds more on top.
   */
  private damage(r: Rig, frac: number, dt: number, t: number, s0: number, hostile: boolean, esc = 0) {
    const e = this.engine, m = r.model, pts = m.dmgPts, n = pts.length, s = s0 * m.k;
    const sc = hostile ? Math.max(0.3 + 0.25 * esc, clamp((0.75 - frac) / 0.6, 0, 1)) : clamp((0.75 - frac) / 0.6, 0, 1), nScorch = Math.floor(n * sc);
    m.scorch.geometry.setDrawRange(0, nScorch * 6);
    // Burnt-out sections: steady lights start to fail below 70% hull, most are dark near the end. A
    // ghost's crew is dead: half its lights are out before the fight starts and more fail each phase.
    (m.lights.material as THREE.ShaderMaterial).uniforms.uDmg.value = hostile ? clamp(0.38 + 0.2 * esc + Math.max(0, 0.33 - frac) * 0.3, 0, 0.94) : clamp((0.7 - frac) / 0.7, 0, 0.8);
    if (frac <= 0) return;
    d.set(0, 0, 1).transformDirection(m.root.matrixWorld);
    if (hostile) {
      // Old wounds: a smoulder and a long, thin smoke trail streaming aft from each.
      const nw = Math.min(n, 3 + Math.round(esc * 2.5));
      for (let i = 0; i < nw; i++) {
        const p = pts[i];
        v.set(p[0], p[1], p[2]).applyMatrix4(m.root.matrixWorld);
        const fl = 0.7 + 0.3 * Math.sin(t * (5 + i) + i * 3);
        e.glow.add(v.x, v.y + 1, v.z, 0, 3.2 * s * fl, 3.2 * s * fl, rgb(FIRE[2]), 0.35 * fl, Shape.Soft);
        for (let k = 0; k < 5; k++) {
          const q = (t * 0.32 + k / 5 + i * 0.23) % 1, sz = (2.5 + q * 13) * s;
          e.dark.add(v.x + d.x * q * 70 * s + Math.sin(i * 2.1 + q * 5) * 3 * s, v.y + 3 + q * 12, v.z + d.z * q * 70 * s, q * 2 + i, sz, sz * 0.8, rgb('#3a3838'), (1 - q) * Math.min(1, q * 6) * 0.5, DarkShape.Soft);
        }
      }
      r.smokeAcc += dt * nw * (0.5 + 0.5 * esc);
      while (r.smokeAcc > 1) {
        r.smokeAcc -= 1;
        const p = pts[Math.floor(Math.random() * nw)];
        toField(w.set(p[0], p[1], p[2]).applyMatrix4(m.root.matrixWorld));
        addFx({ type: 'smoke', x: w.x, y: w.z, vx: (Math.random() - 0.5) * 12, vy: d.z * 50 + Math.random() * 20, life: 1.6, max: 1.6, size: 2 * s, grow: 2.8, a: 0.4 });
      }
    }
    const sparkRate = hostile ? 1.5 + 3.5 * esc + Math.max(0, 0.33 - frac) * 20 : (0.6 - frac) * 14;
    if (sparkRate > 0) {
      r.sparkAcc += dt * sparkRate;
      while (r.sparkAcc > 1) {
        r.sparkAcc -= 1;
        const p = pts[Math.floor(Math.random() * Math.max(1, nScorch))];
        toField(w.set(p[0], p[1], p[2]).applyMatrix4(m.root.matrixWorld));
        for (let k = 0; k < 4; k++) { const a = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 90; addFx({ type: 'spark', x: w.x, y: w.z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25 + Math.random() * 0.2, max: 0.45, size: 0.8, drag: 3, tint: '#ffd27a' }); }
      }
    }
    const nf = hostile
      ? Math.min(n, Math.floor(Math.max(0, esc - 0.4) * 7 + Math.max(0, 0.33 - frac) / 0.33 * 8))
      : frac < 0.3 ? Math.min(n, 4 + Math.floor(((0.3 - frac) / 0.3) * 16)) : 0;
    if (nf <= 0) return;
    for (let i = 0; i < nf; i++) {
      const p = pts[i];
      v.set(p[0], p[1], p[2]).applyMatrix4(m.root.matrixWorld);
      const fl = 0.7 + 0.3 * Math.sin(t * (11 + i) + i * 7), fl2 = 0.8 + 0.2 * Math.sin(t * 23 + i * 3);
      // Smoke column first (alpha-blended), then the fire on top (additive).
      for (let k = 0; k < 3; k++) {
        const q = (t * 0.55 + k / 3 + i * 0.29) % 1, sz = (3 + q * 12) * s;
        e.dark.add(v.x + d.x * q * 26 * s + Math.sin(i * 1.7 + q * 4) * 2 * s, v.y + 4 + q * 10, v.z + d.z * q * 26 * s, q * 3 + i, sz, sz, rgb('#26262a'), (1 - q) * Math.min(1, q * 4) * 0.6, DarkShape.Soft);
      }
      // Small, many fires: a deck fire is a few metres of a 300 m ship.
      e.glow.add(v.x, v.y + 2, v.z, 0, 12 * s * fl2, 12 * s * fl2, rgb(FIRE[3]), 0.2 * fl, Shape.Soft);
      e.glow.add(v.x, v.y + 2.5, v.z, i, (5 + 2.5 * fl) * s, (4 + 2 * fl) * s, rgb(FIRE[2]), 0.75 * fl, Shape.Soft);
      e.glow.add(v.x, v.y + 3, v.z, 0, 2.2 * s * fl2, 2.2 * s * fl2, rgb(FIRE[1]), 0.9 * fl, Shape.Hot);
      // Venting: pale jets (atmosphere and coolant) from the hull side nearest the fire.
      if (i % 3 === 1 || (hostile && esc > 1.3 && i % 3 === 2)) {
        w.set(Math.sign(p[0] || 1) * 1, 0, 0).transformDirection(m.root.matrixWorld);
        const vl = (8 + 4 * Math.sin(t * 9 + i)) * s;
        e.glow.add(v.x + w.x * vl * 0.6, v.y + 2, v.z + w.z * vl * 0.6, Math.atan2(w.z, w.x), vl, 1.6 * s, rgb(hostile ? '#b9cfca' : '#cfe3f0'), 0.3 * fl2, Shape.Streak);
      }
    }
    r.fireAcc += dt * nf * 3;
    while (r.fireAcc > 1) {
      r.fireAcc -= 1;
      const p = pts[Math.floor(Math.random() * nf)];
      toField(w.set(p[0], p[1], p[2]).applyMatrix4(m.root.matrixWorld));
      addFx({ type: 'smoke', x: w.x, y: w.z, vx: (Math.random() - 0.5) * 16, vy: 60 + Math.random() * 40, life: 1.3, max: 1.3, size: 2.2 * s, grow: 2.6, a: 0.5 });
      if (Math.random() < 0.4) addFx({ type: 'fire', x: w.x, y: w.z, vx: 0, vy: 50, life: 0.3, max: 0.3, size: 2.2 * s, grow: 0.6 });
    }
  }
}
