// Dev tool: the ship layer on its own, through the real engine (lighting, bloom, tone map) with a
// zoomable camera. /tools/ship.html?build=starter|big|mid|hammer|outrig|max&zoom=0.35&ghost=0|1&hp=1&phase=1..3&fire=1&t=4
import { Engine } from '../engine';
import { ShipLayer } from './shipLayer';
import { preloadKits } from '../assets';
import { S, fireLog } from '../../game/combat';
import { V } from '../../game/vfx';
import { derive, ghostToBuild, WEAPONS, type Build } from '../../data/parts';
import type { Ghost } from '../../game/ghosts';
import * as THREE from 'three';

const q = new URLSearchParams(location.search);
// Sections are [type, slots, facings?, at?, rings?]; `mid` puts the bridge amidships, `hammer` and `outrig` lay modules
// side by side on the grid (Section.at, design units: [centre x, forward y]).
type Spec = [string, (string | null)[], (number[] | null)?, [number, number]?, number[]?];
const BUILDS: Record<string, Spec[]> = {
  starter: [['bridge', ['pulse']], ['gundeck', ['pulse', 'bomb']], ['engine', [null]]],
  big: [['bridge', ['pulse']], ['gundeck', ['flak', 'missile']], ['battery', ['spread', 'rail', 'tesla']], ['armor', ['plate']], ['spine', ['shield', 'drones']], ['engine', ['thruster']]],
  mid: [['gundeck', ['pulse', 'flak'], [0, 0]], ['battery', ['spread', 'pulse', 'missile']], ['bridge', ['rail']], ['gundeck', ['flak', 'pulse'], [4, 4]], ['engine', ['thruster']]],
  hammer: [['gundeck', ['pulse', 'flak'], [0, 0], [0, 0], [3, 2]], ['battery', ['spread', 'pulse', null], [7, 6, 2], [-26, 0]], ['battery', [null, 'flak', 'spread'], [6, 2, 1], [26, 0], [1, 2, 3]],
    ['bridge', ['rail'], null, [0, 26]], ['spine', ['shield', 'drones'], null, [0, 56]], ['engine', ['thruster'], null, [0, 74]]],
  outrig: [['bridge', ['pulse'], null, [0, 0]], ['gundeck', ['flak', 'missile'], [0, 4], [0, 30], [2, 1]], ['battery', ['pulse', 'rail', null], [6, 6, 2], [-26, 30], [2, 1, 1]],
    ['battery', [null, 'rail', 'pulse'], [6, 2, 2], [26, 30], [1, 1, 3]], ['armor', ['plate'], null, [0, 56]], ['engine', ['repair'], null, [0, 74]]],
  max: [['bridge', ['rail']], ['gundeck', ['pulse', 'flak']], ['battery', ['spread', 'artillery', 'missile']], ['battery', ['tesla', 'pd', 'bomb']], ['armor', ['reactor']], ['spine', ['shield', 'magnet']], ['gundeck', ['pulse', 'artillery']], ['engine', ['repair']]],
};
const spec = BUILDS[q.get('build') || 'starter'] ?? JSON.parse(q.get('build')!);
const build: Build = ghostToBuild(spec.map(([type, slots, face, at, ring]) => ({ type, face: face ?? undefined, at, ring, slots: slots.map((id) => (id ? [id, Number(q.get('tier') || 3)] : null)) })));
const ghost = q.get('ghost') === '1', zoom = Number(q.get('zoom') || 0.4), hp = Number(q.get('hp') || 1), fire = q.get('fire') !== '0';
const canvas = document.createElement('canvas'); document.body.append(canvas);
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
const eng = new Engine(canvas);
eng.resize(innerWidth, innerHeight);
const layer = eng.add(new ShipLayer(eng));
// A dark ground plane so shadows and fog read as they do in game.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#1d2124', roughness: 1 }));
ground.receiveShadow = true; eng.scene.add(ground);

const dv = derive(build);
const x = Number(q.get('x') || 800), y = Number(q.get('y') || 520);
if (ghost) {
  const s = Math.min(1.9, 560 / dv.len, 760 / dv.width);
  S.boss = { ghost: { name: 'viewer' } as Ghost, build, dv, s, x, y, homeY: y, halfW: (dv.width * s) / 2, r: (dv.width * s) / 2, layer: 'both', isBoss: true, alive: true, dead: false,
    hp: hp * 1000, maxHp: 1000, shield: 0, shieldMax: 0, shieldHitT: 9, regen: 0, tractor: 0, droneEvery: 0, droneT: 9, speedMul: 1, fireMul: 1, cdMul: 1, t: 0, phase: Number(q.get('phase')) || (hp > 0.66 ? 1 : hp > 0.33 ? 2 : 3), flash: 0, entered: true,
    weps: [] } as unknown as typeof S.boss;
  // A target for the ghost's guns (px/py, field units); not drawn.
  const tx = q.get('px'), ty = q.get('py');
  S.P = tx ? { x: Number(tx), y: Number(ty || y), build, dv, hp: 1, shield: 0, cds: {}, lastHit: 9, flash: 0, tx: null, ty: null, droneCd: [], vx: 0, vy: 0, bank: 0 } as unknown as typeof S.P : null;
} else {
  S.P = { x, y, build, dv, hp: dv.maxHp * hp, shield: 0, cds: {}, lastHit: 9, flash: 0, tx: null, ty: null, droneCd: [], vx: 0, vy: 0, bank: 0 };
}
S.mode = 'play'; S.enemies = []; S.eb = [];
if (q.get('enemies') === '1') S.enemies = [
  { x: x + 260, y: y - 260, layer: 'air', dead: false }, { x: x - 300, y: y - 60, layer: 'ground', dead: false },
] as unknown as typeof S.enemies;
// Zoom: pull the camera toward the ship.
const look = new THREE.Vector3(); eng.toFlight(x + Number(q.get("lx") || 0), y + Number(q.get("ly") || 0), 0, look);
const off = eng.camPos.clone().sub(eng.camLook);
eng.camLook.copy(look); eng.camPos.copy(look).addScaledVector(off, zoom);
const yaw = Number(q.get('orbit') || 0); if (yaw) eng.camPos.sub(look).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(look);
const tilt = Number(q.get('tilt') || 0); if (tilt) { const o = eng.camPos.clone().sub(look); const ax = new THREE.Vector3().crossVectors(o, new THREE.Vector3(0, 1, 0)).normalize(); eng.camPos.copy(look).add(o.applyAxisAngle(ax, -tilt)); }

await preloadKits(['scifi']);
let t = 0, frames = 0;
// Perf readout for screenshots: draw calls and triangles for a whole frame (all post passes included),
// and the ship meshes alone.
eng.renderer.info.autoReset = false;
let last = { calls: 0, triangles: 0 };
(window as unknown as { __shipInfo: () => unknown }).__shipInfo = () => {
  let shipCalls = 0, shipTris = 0, lights = 0;
  eng.scene.traverse((o) => {
    if (!o.visible) return;
    let p: THREE.Object3D | null = o; let inShip = false; while (p) { if (p.name === 'dreadnought' || p.name === 'ghost-dreadnought') { inShip = p.visible; break; } p = p.parent; }
    if (!inShip) return;
    const m = o as THREE.Mesh; if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
    shipCalls++;
    const g = m.geometry; if ((o as THREE.Points).isPoints) lights += g.getAttribute('position').count; else shipTris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { frame: last, shipCalls, shipTris: Math.round(shipTris), lights };
};
const tEnd = Number(q.get('t') || 3);
function frame() {
  const dt = 1 / 30; t += dt; S.t = t;
  if (fire) for (const sct of build.sections) for (const p of sct.slots) if (p && WEAPONS[p.id] && Math.random() < dt * 1.2) fireLog.set(p.uid, t);
  if (q.get('sway') === '1' && S.P) S.P.x = x + Math.sin(t * 0.8) * 120;
  eng.renderer.info.reset();
  eng.render({ dt, t, S, V, showPlayer: !ghost });
  last = { calls: eng.renderer.info.render.calls, triangles: eng.renderer.info.render.triangles };
  frames++;
  if (t >= tEnd && document.title !== 'ready') document.title = 'ready';
  requestAnimationFrame(frame);
}
(window as unknown as { __shipLayer: unknown }).__shipLayer = layer;
frame();
