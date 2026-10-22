import './styles.css';
import { Engine, webglAvailable } from './render/engine';
import { TerrainLayer } from './render/world/terrain';
import { ShipLayer } from './render/ship/shipLayer';
import { UnitLayer } from './render/units/unitLayer';
import { FxLayer } from './render/fx/fxLayer';
import { preloadKits } from './render/assets';
import { V } from './game/vfx';
import { drawHud } from './render/hud';
import { screenToField } from './render/view';
import { FLIR, stepFlir } from './render/flir';
import { drawBlueprint } from './render/shipPreview';
import { S, W, H, keys, startCombat, updateCombat, updateBg, endCombat, seedDecor, setScrapHandler, damagePlayer, damageTarget, triggerOverdrive, aim, gunnery, selectGroup, cycleGroup, spawnGroup, spawnElite } from './game/combat';
import { initAudio, sfx, audio, setMuted, music, updateAudio, setVolume } from './audio';
import { settings as uiSettings, onSettings } from './ui/settings';
import { wireAudioSettings } from './ui/sound';
import {
  newRun, loadRun, saveRun, clearSave, maxHp, dv, mods, level, bossLevel, heal, healAmount, repairQuote, buyRepair, partChoices, relicChoices, addRelic, addSection,
  nextSectionCost, enterNextSector, deathGhost, changeBuild, runRng, floorOf, takeOd, type RunState,
} from './game/run';
import { odTreeView } from './ui/screens/odTree';
import { OD_NODE, openOdNodes } from './data/overdriveTree';
import { NODE_INFO, reachable, type NodeType } from './game/map';
import { fetchGhosts, submitGhost, chooseGhost, aiGhost, registryOnline, sanitizeName, type Ghost } from './game/ghosts';
import { FIGHTS, ELITES, BOSS_ENCOUNTER, type Encounter, type EnemyType } from './data/enemies';
import { EVENTS, pickEvent, type Outcome } from './data/events';
import { RELICS, hasFlag, relicCost } from './data/relics';
import { SECTIONS, partName, partCost, allParts, ghostToBuild, derive, mkPart, type Part, type SectionType } from './data/parts';
import { el, show } from './ui/dom';
import { mapView } from './ui/mapView';
import { titleView } from './ui/screens/title';
import { mapScreenView, plotReadout, dossier, dossierPending } from './ui/screens/map';
import { rewardView, bossSalvageView, trophyView } from './ui/screens/reward';
import { merchantView } from './ui/screens/merchant';
import { signalView, outcomeView } from './ui/screens/signal';
import { drydockView, upgradeView, derelictView, derelictOpenedView } from './ui/screens/orders';
import { wreckReport } from './ui/screens/report';
import { pauseView, runMenuView, holdView } from './ui/screens/pause';
import { refitView } from './ui/screens/refit';
import { pick, rint, clamp } from './util/rng';
import { loadProfile, perksFor, dailySeed, utcDateKey, type Profile, type Settlement } from './game/meta';
import { filingFor, submitDaily, fetchDailyBoard, flushPendingDaily } from './game/daily';
import { roster, localRow, dailyBriefing } from './ui/screens/roster';
import { launchPanel, admiraltyScreen, settle, victoryScreen, portScreen } from './game/metaScreens';
import { HULLS, OVERDRIVES } from './data/hulls';
import { heatFx } from './data/heat';
import { CAMPAIGN_SECTORS } from './game/run';

// The pause/title settings sliders are the source of truth for volume.
wireAudioSettings(setVolume, () => uiSettings, (fn) => { onSettings(fn); });

/* ---------------- canvas + renderer ---------------- */
const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const hctx = hudCanvas.getContext('2d')!;
const stageEl = document.getElementById('stage')!;
let renderer: Engine | null = null;
let SCALE = 1, DPR = 1;
function resize() {
  SCALE = Math.min(window.innerWidth / W, window.innerHeight / H);
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.floor(W * SCALE), ch = Math.floor(H * SCALE);
  hudCanvas.style.width = cw + 'px'; hudCanvas.style.height = ch + 'px';
  hudCanvas.width = Math.round(cw * DPR); hudCanvas.height = Math.round(ch * DPR);
  renderer?.resize(cw, ch);
}
if (webglAvailable()) {
  try {
    const eng = new Engine(glCanvas);
    eng.add(new TerrainLayer(eng)); eng.add(new UnitLayer(eng)); eng.add(new ShipLayer(eng)); eng.add(new FxLayer(eng));
    renderer = eng;
    // Graphics quality and screen shake from the settings panel, live.
    V.shakeScale = uiSettings.shake;
    let quality = uiSettings.quality;
    onSettings((st) => { V.shakeScale = st.shake; if (st.quality !== quality) { quality = st.quality; eng.setQuality(st.quality); } });
  } catch (e) { console.error(e); renderer = null; }
}
// Kitbash pieces for the ship hulls (the ship layer rebuilds once they arrive).
if (renderer) preloadKits(['scifi']).catch((e) => console.error('kit load failed', e));
window.addEventListener('resize', resize);
resize();
seedDecor();

/* ---------------- state ---------------- */
let run: RunState | null = null;
/** The persistent pilot profile (fleet loop). Settled once per run: death, retiring after victory, or abandoning. */
const profile: Profile = loadProfile();
let mode: 'title' | 'menu' | 'combat' = 'title';
let paused = false;
let onCombatDone: ((o: 'win' | 'dead') => void) | null = null;
let sectorGhosts: Ghost[] = [];
let mapToast = '', mapToastOd = '';
const debug = { timeScale: 1 };

/* ---------------- input ---------------- */
const KEYMAP: Record<string, string> = { ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd' };
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; if (mode === 'combat') e.preventDefault(); }
  if (e.code === 'Space' && mode === 'combat') { e.preventDefault(); if (!e.repeat && !paused) keys.od = true; }
  if ((e.code === 'KeyP' || e.code === 'Escape') && mode === 'combat') setPaused(!paused);
  if (e.code === 'KeyM') setMuted(audio.on);
  // FLIR thermal view: hold Shift, or T to latch it (src/render/flir.ts)
  if (mode === 'combat' && !paused && !e.repeat) {
    if (e.key === 'Shift') flirHeld = true;
    if (e.code === 'KeyT') flirLatched = !flirLatched;
  }
});
window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; if (e.key === 'Shift') flirHeld = false; });
let flirHeld = false, flirLatched = false;
const releaseTriggers = () => { aim.fire = aim.salvo = false; };
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; flirHeld = false; releaseTriggers(); if (mode === 'combat') setPaused(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'combat') setPaused(true); });

/* Gunnery. With a mouse the heavy weapon groups are fired by hand: the mouse moves the reticle, left button fires the
   selected group, right button salvoes every heavy group; 1-9 (or Q / E, or the wheel) pick the group. AUTO guns fire on
   their own either way. On a touch screen dragging steers and heavy groups aim themselves (gunnery.manual off). */
gunnery.manual = matchMedia('(pointer: fine)').matches;
const pickGroup = (ok: boolean) => { if (mode === 'combat' && !paused) sfx(ok ? 'uiSwitch' : 'uiError', { vol: ok ? 0.8 : 0.5 }); };
window.addEventListener('keydown', (e) => {
  if (mode !== 'combat' || paused || e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) { e.preventDefault(); pickGroup(selectGroup(Number(m[1]) - 1)); }
  else if (e.code === 'KeyQ') pickGroup(cycleGroup(-1));
  else if (e.code === 'KeyE') pickGroup(cycleGroup(1));
});
let wheelAt = 0;
hudCanvas.addEventListener('wheel', (e) => {
  if (mode !== 'combat' || paused) return;
  e.preventDefault();
  const now = performance.now(); if (now - wheelAt < 110 || Math.abs(e.deltaY) < 1) return;
  wheelAt = now; pickGroup(cycleGroup(e.deltaY > 0 ? 1 : -1));
}, { passive: false });
hudCanvas.addEventListener('contextmenu', (e) => { if (mode === 'combat') e.preventDefault(); });

let drag: { px: number; py: number; sx: number; sy: number; id: number } | null = null;
const toLocal = (e: PointerEvent) => { const r = hudCanvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / SCALE, y: (e.clientY - r.top) / SCALE }; };
// The reticle aims at the field point under the cursor: the camera's tilt makes the field a trapezoid on screen (view.ts).
const aimAt = (e: PointerEvent) => { const l = toLocal(e), p = screenToField(l.x, l.y); aim.x = clamp(p.x, 0, W); aim.y = clamp(p.y, 0, H); };
hudCanvas.addEventListener('pointerdown', (e) => {
  initAudio();
  if (mode !== 'combat' || !S.P) return;
  const p = toLocal(e);
  if (p.x > W - 46 && p.y < 46) { setPaused(true); return; }
  if (e.pointerType === 'mouse') {
    gunnery.manual = true; aimAt(e);
    if (e.button === 0) aim.fire = true; else if (e.button === 2) aim.salvo = true;
    try { hudCanvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    return;
  }
  gunnery.manual = false; releaseTriggers();
  drag = { px: p.x, py: p.y, sx: S.P.x, sy: S.P.y, id: e.pointerId };
  try { hudCanvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
hudCanvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') { aimAt(e); return; }
  if (!drag || !S.P || e.pointerId !== drag.id) return;
  const p = toLocal(e); S.P.tx = drag.sx + (p.x - drag.px) * 1.25; S.P.ty = drag.sy + (p.y - drag.py) * 1.25;
});
hudCanvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') { if (e.button === 0) aim.fire = false; else if (e.button === 2) aim.salvo = false; if (!e.buttons) releaseTriggers(); }
  if (drag && e.pointerId === drag.id) drag = null;
});
hudCanvas.addEventListener('pointercancel', (e) => { releaseTriggers(); if (drag && e.pointerId === drag.id) drag = null; });
hudCanvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !e.buttons) releaseTriggers(); });

/* ---------------- main loop ---------------- */
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.033, (now - last) / 1000); last = now;
  if (mode === 'combat' && !paused) {
    for (let i = 0; i < debug.timeScale; i++) updateCombat(dt);
    if (S.outcome && onCombatDone) { const cb = onCombatDone; onCombatDone = null; cb(S.outcome); }
  } else if (mode === 'title') updateBg(dt);
  updateAudio(dt, mode === 'combat' ? S : null, paused);
  // the reticle replaces the system cursor while a mouse is flying the guns
  const cur = mode === 'combat' && !paused && gunnery.manual ? 'none' : '';
  if (hudCanvas.style.cursor !== cur) hudCanvas.style.cursor = cur;
  const hideStage = mode === 'menu';
  if (stageEl.hidden !== hideStage) stageEl.hidden = hideStage;
  if (mode === 'combat' || mode === 'title') {
    FLIR.on = mode === 'combat' && !paused && (flirHeld || flirLatched) && S.mode !== 'done';
    stepFlir(dt);
    renderer?.render({ dt, t: S.t, S, V, showPlayer: mode === 'combat' && S.mode !== 'dying' && S.mode !== 'done' });
    if (mode === 'combat') drawHud(hctx, SCALE, DPR, run?.scrap ?? 0); else { hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height); }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const soundSwitch = { get on() { return audio.on; }, set: (on: boolean) => setMuted(!on) };
function setPaused(v: boolean) {
  paused = v; releaseTriggers();
  if (!v) { show(); return; }
  show(pauseView({ onResume: () => setPaused(false), onAbandon: () => { paused = false; abandonRun(); }, sound: soundSwitch }));
}

/* ---------------- title ---------------- */
function titleScreen() {
  mode = 'title'; paused = false; S.P = null; S.enemies = []; S.eb = []; S.pb = []; S.pickups = []; S.boss = null; S.theme = 0;
  music.setScene('title');
  renderer?.clearLayers();
  const saved = loadRun();
  let stored = ''; try { stored = localStorage.getItem('gd.callsign') || ''; } catch { /* ignore */ }
  const launch = (raw: string, daily: boolean) => {
    initAudio(); sfx('ui');
    const cs = sanitizeName(raw) || 'PILOT'; try { localStorage.setItem('gd.callsign', cs); } catch { /* ignore */ }
    if (saved) settle(profile, saved, saved.won ? 'victory' : 'abandoned'); // a run left unfinished is banked at half pay
    const key = utcDateKey();
    run = daily ? newRun(cs, dailySeed(key), { daily: key }) : newRun(cs, undefined, { hull: profile.hull, heat: profile.heat, perks: perksFor(profile.xp) });
    mapToast = daily ? `Daily strike ${key}: the same route for every pilot today.` : 'Choose your first node. Everything on floor one is a fight. In combat your light guns fire on their own; the mouse aims the heavy guns: hold the left button to fire, right button for a full salvo.';
    mapScreen();
  };
  const callsign = () => (document.getElementById('callsign') as HTMLInputElement | null)?.value ?? '';
  // Daily Strike opens the briefing: today's (or yesterday's) duty roster, then the launch switch.
  const openDaily = () => {
    const host = document.querySelector('[data-screen="title"]');
    if (!host || host.querySelector('.daily-modal')) return;
    initAudio(); sfx('ui');
    const now = Date.now(), cs = () => sanitizeName(callsign()) || 'PILOT';
    const close = () => { m.remove(); document.getElementById('btn-daily')?.focus(); };
    const m = dailyBriefing({
      today: utcDateKey(new Date(now)), yesterday: utcDateKey(new Date(now - 86_400_000)), callsign: cs,
      load: async (date) => {
        await flushPendingDaily();
        const board = await fetchDailyBoard(date, cs());
        const d = profile.daily && profile.daily.date === date ? profile.daily : null;
        return { board, local: d ? localRow({ callsign: cs(), date, score: d.score, sector: d.sector, floor: d.floor, kills: d.kills, hull: 'vanguard', won: d.won }) : null };
      },
      onLaunch: () => { m.remove(); launch(callsign(), true); },
      onClose: close,
    });
    host.append(m);
  };
  show(titleView({
    callsign: stored || `PILOT-${rint(100, 999)}`,
    saved: saved ? { sector: saved.sector, floor: saved.at ? saved.map.nodes[saved.at].floor : -1, callsign: saved.callsign, hp: saved.hp, maxHp: maxHp(saved) } : null,
    noGl: !renderer,
    registry: registryOnline(),
    sound: soundSwitch,
    launchPanel: launchPanel(profile, openDaily, () => admiraltyScreen(profile, titleScreen)),
    onStart: (raw) => launch(raw, false),
    onContinue: () => { initAudio(); run = saved; if (saved!.phase === 'victory') { showVictory(); return; } mapToast = 'Run restored.'; mapScreen(); },
  }));
}

/* ---------------- map ---------------- */
/** One registry lookup per sector at a time: the map's dossier and the boss node share it, so the ghost you were
 *  shown is the ghost you fight (two racing lookups could each pick a different one). */
let intelPending: { run: RunState; sector: number; p: Promise<void> } | null = null;
function ensureIntel(): Promise<void> {
  if (!run || run.bossGhost) return Promise.resolve();
  const r = run, sector = r.sector;
  if (intelPending && intelPending.run === r && intelPending.sector === sector) return intelPending.p;
  const p = (async () => {
    const { ghosts, count } = await fetchGhosts(sector);
    if (run !== r || r.sector !== sector || r.bossGhost) return;
    sectorGhosts = ghosts;
    r.bossGhost = chooseGhost(ghosts, sector, r.pilot);
    r.bossGhostCount = count;
    saveRun(r);
  })().finally(() => { if (intelPending?.p === p) intelPending = null; });
  intelPending = { run: r, sector, p };
  return p;
}
function intelCard(): HTMLElement {
  if (!run!.bossGhost) {
    const card = dossierPending();
    ensureIntel().then(() => { const cur = document.querySelector('#ui .card.intel'); if (mode === 'menu' && cur) cur.replaceWith(intelCard()); });
    return card;
  }
  const g = run!.bossGhost, b = ghostToBuild(g.sections), d = derive(b);
  const cv = el('canvas', { width: 400, height: 500 }); drawBlueprint(cv, d, true);
  return dossier(g, run!.bossGhostCount, cv, allParts(b));
}
function mapScreen() {
  if (!run) return titleScreen();
  mode = 'menu'; renderer?.clearLayers(); music.setScene('map');
  run.stats.maxScrapHeld = Math.max(run.stats.maxScrapHeld, run.scrap); saveRun(run);
  const r = run;
  const readout = plotReadout();
  const setInfo = (id: string | null) => {
    if (!id) { readout.set(null, ''); return; }
    const n = r.map.nodes[id]; const ni = NODE_INFO[n.type];
    const enc = n.enc ? [...FIGHTS, ...ELITES].find((e) => e.id === n.enc) : null;
    readout.set(n.type, `${ni.label}${enc ? `: ${enc.name}` : ''}. ${ni.desc}`);
  };
  const chart = mapView(r.map, r.at, r.visited, travel, setInfo, r.callsign);
  const toast = mapToast; mapToast = '';
  show(mapScreenView({ run: r, chart, toast, readout: readout.el, intel: intelCard(), onRefit: refitScreen, onMenu: abandonPrompt, onTree: () => odTreeScreen('chart room', null, mapScreen) }));
  const cur = chart.querySelector('.node.reach') as SVGGElement | null;
  if (cur && chart.classList.contains('wide') === false) requestAnimationFrame(() => cur.scrollIntoView({ block: 'center' }));
}
function abandonPrompt() {
  show(runMenuView({ run: run!, onBack: mapScreen, onQuit: titleScreen, onAbandon: abandonRun }));
}
function abandonRun() { if (run) settle(profile, run, 'abandoned'); clearSave(); run = null; endCombat(); mode = 'title'; titleScreen(); }
/**
 * The Overdrive refit tree. `priceMul` null: only banked commissions can be spent (from the map); otherwise scrap
 * buys refits at that markup. `once`: leave after one refit (the drydock's single job).
 */
function odTreeScreen(where: string, priceMul: number | null, back: () => void, opts: { once?: (msg: string) => void; backLabel?: string } = {}) {
  const r = run!;
  const render = (fresh?: string) => show(odTreeView({
    run: r, priceMul, where, fresh, backLabel: opts.backLabel ?? 'Done', onBack: back,
    onTake: (id) => {
      const got = takeOd(r, id, priceMul ?? 1); if (!got) { sfx('uiError'); return; }
      sfx('buy'); saveRun(r);
      const msg = `${OD_NODE[id].name} fitted to the ${OVERDRIVES[HULLS[r.hull].overdrive].name}${got.credit ? ' on commission' : ` for ${got.cost} scrap`}.`;
      if (opts.once) { opts.once(msg); return; }
      render(id);
    },
  }));
  render();
}
function refitScreen() {
  const r = run!;
  show(refitView({ run: r, back: { label: 'Done', id: 'btn-done', act: mapScreen }, onChange: () => saveRun(r) }));
}

/* ---------------- travel + nodes ---------------- */
function travel(id: string) {
  const r = run!;
  if (!reachable(r.map, r.at).includes(id)) return;
  sfx('ui');
  r.at = id; r.visited.push(id); r.stats.nodes++;
  saveRun(r);
  const n = r.map.nodes[id];
  switch (n.type) {
    case 'fight': return fight(FIGHTS.find((f) => f.id === n.enc) ?? FIGHTS[0], () => rewardScreen('fight'));
    case 'elite': return fight(ELITES.find((f) => f.id === n.enc) ?? ELITES[0], () => { r.stats.elites++; rewardScreen('elite'); });
    case 'boss': return bossNode();
    case 'merchant': return merchantScreen();
    case 'event': return eventScreen();
    case 'drydock': return drydockScreen();
    case 'derelict': return derelictScreen();
  }
}
function fight(enc: Encounter, after: () => void, ghost?: Ghost) {
  const r = run!;
  show(); mode = 'combat'; paused = false;
  music.setScene(enc.kind === 'boss' ? 'boss' : enc.kind === 'elite' ? 'elite' : 'combat');
  setScrapHandler((v) => { r.scrap += v; r.stats.scrapEarned += v; });
  startCombat({
    enc, level: enc.kind === 'boss' ? bossLevel(r) : level(r, enc.kind === 'elite'), sector: r.sector, build: r.build, hp: r.hp, relics: r.relics, mods: mods(r), ghost, cheatDeathAvailable: !r.jumpUsed,
    overdrive: HULLS[r.hull].overdrive, heat: heatFx(r.heat), odCharge: r.odStart, odTree: r.od,
    floor: enc.kind === 'boss' ? 10 : floorOf(r), seed: r.seed,
  });
  onCombatDone = (o) => {
    const fs = S.stats, rs = r.stats;
    rs.kills += S.kills; rs.score += S.score; rs.fights++;
    rs.structures += fs.structures; rs.broadsides += fs.broadsides; rs.maxVolley = Math.max(rs.maxVolley, fs.maxVolley); rs.overdrives += fs.overdrives;
    rs.lanceStructures += fs.lanceStructures; rs.peakCarnage = Math.max(rs.peakCarnage, fs.peakCarnage); rs.dmgTaken += fs.dmgTaken; rs.dmgDealt += fs.dmgDealt;
    if (o === 'win' && fs.dmgTaken < S.P!.dv.maxHp * 0.05) rs.flawless++;
    for (const [k, n] of Object.entries(S.seen)) r.seen.enemies[k] = (r.seen.enemies[k] || 0) + (n || 0);
    if (ghost) r.seen.ghosts.push({ id: ghost.id, name: ghost.name, sector: ghost.sector, ai: !!ghost.ai, outcome: o === 'win' ? 'killed' : 'lost' });
    if (S.cheatDeathUsed) r.jumpUsed = true;
    endCombat(); mode = 'menu'; renderer?.clearLayers();
    if (o === 'dead') { onDeath(); return; }
    music.setScene(enc.kind === 'boss' ? 'victory' : 'map');
    r.hp = clamp(S.P!.hp, 1, maxHp(r));
    if (hasFlag(r.relics, 'heal_after_fight')) heal(r, 0.1);
    rs.maxScrapHeld = Math.max(rs.maxScrapHeld, r.scrap);
    saveRun(r); after();
  };
}
function rewardScreen(kind: 'fight' | 'elite' | 'event', offered?: Part[]) {
  const r = run!;
  const gained = Math.floor(S.scrap);
  const parts = offered && offered.length ? offered : partChoices(r, 3, kind === 'elite' ? 1 : 0);
  let relic: string | null = null, bounty: string | null = null;
  if (kind === 'elite') {
    const [rel] = relicChoices(r, 1, ['common', 'rare']);
    if (rel) { addRelic(r, rel); relic = rel; }
    if (hasFlag(r.relics, 'bounty_ledger')) { const p = partChoices(r, 1, 1)[0]; r.inv.push(p); r.scrap += 60; bounty = `Bounty Ledger pays out: 60 scrap and a ${partName(p)}.`; }
  }
  saveRun(r);
  const take = (p: Part) => { r.inv.push(p); sfx('buy'); mapToast = `${partName(p)} is in your cargo hold. Open Refit ship to mount it.`; mapScreen(); };
  show(rewardView({
    run: r, kind, gained, relic, bounty, parts, onTake: take, skipLabel: 'Skip · +20 scrap',
    onSkip: () => { r.scrap += 20; mapToast = 'Stripped the parts for 20 scrap.'; mapScreen(); },
  }));
}

function merchantScreen() {
  const r = run!;
  const m = () => mods(r).priceMul;
  const rng = runRng(r);
  const stock = [...partChoices(r, 3), ...partChoices(r, 2, 1)];
  const sold = new Set<number>();
  const secTypes = (Object.keys(SECTIONS) as SectionType[]).filter((k) => k !== 'bridge');
  const secs = [pick(secTypes, rng)]; while (secs.length < 2) { const k = pick(secTypes, rng); if (!secs.includes(k)) secs.push(k); }
  const secSold = new Set<string>();
  const [rel] = relicChoices(r, 1, ['common', 'rare']); let relSold = false;
  let toast = 'The quartermaster nods at your scrap counter.';
  let first = true;
  const price = (p: Part) => Math.round(partCost(p) * m());
  // Purchases, shared by the counter and the refit board (dragging a slip onto a socket buys it into the hold first).
  const buyPart = (i: number) => {
    const p = stock[i];
    if (sold.has(i) || r.scrap < price(p)) return false;
    r.scrap -= price(p); sold.add(i); r.inv.push(p); sfx('buy'); toast = `${partName(p)} is in your hold.`; saveRun(r);
    return true;
  };
  const buySection = (k: SectionType) => {
    const cost = nextSectionCost(r, k);
    if (secSold.has(k) || r.scrap < cost || r.build.sections.length >= 8) return false;
    r.scrap -= cost; addSection(r, k); secSold.add(k); sfx('buy'); toast = `${SECTIONS[k].name} welded on.`; saveRun(r);
    return true;
  };
  const render = () => {
    const repair = repairQuote(r, m());
    const curses = r.relics.filter((id) => RELICS[id].rarity === 'curse');
    const relPrice = rel ? Math.round(relicCost(rel) * m()) : 0;
    show(merchantView({
      run: r, toast,
      stock: stock.map((p, i) => ({ part: p, price: price(p), sold: sold.has(i), afford: r.scrap >= price(p), buy: () => { buyPart(i); render(); } })),
      sections: secs.map((k) => {
        const d = SECTIONS[k], cost = nextSectionCost(r, k), full = r.build.sections.length >= 8;
        return {
          type: k, name: d.name, cost, sold: secSold.has(k), full, afford: r.scrap >= cost,
          desc: `+${d.hp} hull · ${d.slots.length} ${d.slots[0] === 'W' ? 'weapon mount' : 'utility bay'}${d.slots.length > 1 ? 's' : ''} · mass ${d.mass}${d.thrust ? ` · thrust +${d.thrust}` : ''}`,
          buy: () => { buySection(k); render(); },
        };
      }),
      relic: rel ? { id: rel, price: relPrice, sold: relSold, afford: r.scrap >= relPrice, buy: () => { r.scrap -= relPrice; addRelic(r, rel); relSold = true; sfx('buy'); toast = `${RELICS[rel].name} installed.`; saveRun(r); render(); } } : null,
      services: [
        { icon: 'auto-repair', label: repair.missing < 1 ? 'Hull at full strength' : `Repair ${Math.ceil(repair.missing)} hull · ${repair.cost} scrap${r.heat >= 8 ? ' (No Quarter)' : ''}`, disabled: repair.missing < 1 || r.scrap < 1,
          act: () => { const { fix, cost } = buyRepair(r, m()); sfx('buy'); toast = `Repaired ${Math.round(fix)} hull for ${cost} scrap.`; saveRun(r); render(); } },
        ...(curses.length ? [{ icon: 'radioactive', label: `Purge ${RELICS[curses[0]].name} · 75 scrap`, disabled: r.scrap < 75,
          act: () => { r.scrap -= 75; changeBuild(r, () => r.relics.splice(r.relics.indexOf(curses[0]), 1)); toast = `${RELICS[curses[0]].name} purged.`; saveRun(r); render(); } }] : []),
        { icon: 'wrench', label: 'Refit ship', disabled: false, act: () => refitFromMerchant() },
        { icon: 'power-lightning', label: `Overdrive refit${r.odCredits ? ` · ${r.odCredits} commission${r.odCredits > 1 ? 's' : ''}` : ''}`, disabled: !openOdNodes(HULLS[r.hull].overdrive, r.od).length,
          act: () => odTreeScreen('quartermaster', m(), () => { toast = 'The quartermaster files the refit papers.'; render(); }) },
      ],
      sell: r.inv.map((p, i) => ({ part: p, value: Math.floor(partCost(p) * 0.4), act: () => { const v = Math.floor(partCost(p) * 0.4); r.scrap += v; r.inv.splice(i, 1); sfx('buy'); toast = `Sold ${partName(p)} for ${v} scrap.`; saveRun(r); render(); } })),
      onLeave: () => { saveRun(r); mapScreen(); },
    }, first));
    first = false;
  };
  const refitFromMerchant = () => {
    // The counter comes along: slips can be dragged straight onto a socket (bought, then mounted) or a section welded on.
    const market = () => stock.map((p, i) => ({ part: p, price: price(p), sold: sold.has(i), afford: r.scrap >= price(p), buy: () => buyPart(i) }));
    const sections = () => secs.map((k) => ({ type: k, cost: nextSectionCost(r, k), sold: secSold.has(k), afford: r.scrap >= nextSectionCost(r, k), buy: () => buySection(k) }));
    const view = () => refitView({ run: r, screen: 'merchant-refit', back: { label: 'Back to merchant', act: render }, onChange: () => { saveRun(r); }, market, sections });
    show(view());
  };
  render();
}

function eventScreen() {
  const r = run!;
  const ghost = sectorGhosts.find((g) => !g.ai && g.id !== r.bossGhost?.id) ?? (r.bossGhost && !r.bossGhost.ai ? r.bossGhost : null);
  const ev = pickEvent(r, !!ghost);
  const ctx = { run: r, ghost };
  const choices = ev.choices(ctx);
  show(signalView({ run: r, id: ev.id, title: ev.title, text: ev.text(ctx), choices: choices.map((c) => ({ label: c.label, detail: c.detail, disabled: c.disabled, act: () => resolve(c.run()) })) }));
  function resolve(o: Outcome) {
    sfx('ui'); saveRun(r);
    show(outcomeView({ run: r, id: ev.id, title: ev.title, text: o.text, fight: !!o.fight, onEngage: () => fight(o.fight!, () => rewardScreen('event', o.partChoice)), onContinue: mapScreen }));
  }
}

function drydockScreen() {
  const r = run!;
  const rng = runRng(r);
  const secTypes = (Object.keys(SECTIONS) as SectionType[]).filter((k) => k !== 'bridge');
  const offer: SectionType[] = [pick(secTypes, rng)]; while (offer.length < 2) { const k = pick(secTypes, rng); if (!offer.includes(k)) offer.push(k); }
  const healAmt = Math.round(healAmount(r, 0.35));
  const done = (msg: string) => { sfx('buy'); mapToast = msg; saveRun(r); mapScreen(); };
  const upgradeList = () => {
    const parts = [...allParts(r.build), ...r.inv].filter((p) => p.tier < 5);
    show(upgradeView({ run: r, onBack: drydockScreen, parts: parts.map((p) => ({ part: { ...p, tier: p.tier + 1 }, from: p.tier, act: () => { changeBuild(r, () => { p.tier++; }); done(`${partName(p)} upgraded.`); } })) }));
  };
  const odOpen = openOdNodes(HULLS[r.hull].overdrive, r.od);
  show(drydockView({
    run: r, healAmt, canRepair: r.hp < maxHp(r),
    overdrive: { name: OVERDRIVES[HULLS[r.hull].overdrive].name, disabled: !odOpen.length,
      detail: odOpen.length ? `Fit one refit from the upgrade tree${r.odCredits ? ' (a commission is banked)' : `, from ${Math.min(...odOpen.map((x) => x.cost))} scrap`}.` : 'Every tier is fitted.',
      act: () => odTreeScreen('drydock', 1, drydockScreen, { once: done, backLabel: 'Back to the work order' }) },
    onRepair: () => { const a = heal(r, 0.35); done(`Repaired ${Math.round(a)} hull${r.heat >= 8 ? ' (No Quarter)' : ''}.`); },
    onUpgrade: upgradeList,
    welds: offer.map((k) => ({ name: SECTIONS[k].name, type: k, disabled: r.build.sections.length >= 8,
      detail: `Free. +${SECTIONS[k].hp} hull, ${SECTIONS[k].slots.length} ${SECTIONS[k].slots[0] === 'W' ? 'weapon mount' : 'utility bay'}${SECTIONS[k].slots.length > 1 ? 's' : ''}.`,
      act: () => { addSection(r, k); done(`${SECTIONS[k].name} welded to the stern for free.`); } })),
  }));
}

function derelictScreen() {
  const r = run!;
  const rng = runRng(r);
  const [rel] = relicChoices(r, 1, rng() < 0.7 ? ['common'] : ['rare']);
  const scrap = rint(25, 55, rng);
  show(derelictView({ run: r, onOpen: () => {
    if (rel) addRelic(r, rel); r.scrap += scrap; sfx('buy'); saveRun(r);
    show(derelictOpenedView({ run: r, scrap, relic: rel ?? null, onContinue: mapScreen }));
  } }));
}

async function bossNode() {
  const r = run!;
  if (!r.bossGhost) { show(holdView(r, 'Scanning wrecks…')); await ensureIntel(); }
  const g = r.bossGhost ?? aiGhost(r.sector);
  // every sector boss banks a free Overdrive commission (spent on the tree right after the trophy, or later)
  fight(BOSS_ENCOUNTER, () => { r.stats.bosses++; r.odCredits++; saveRun(r); bossReward(g); }, g);
}
function bossReward(g: Ghost) {
  const r = run!;
  const seen = new Set<string>();
  const salvage = allParts(ghostToBuild(g.sections)).filter((p) => { const k = p.id + p.tier; if (seen.has(k)) return false; seen.add(k); return true; });
  const relics = relicChoices(r, 3, ['boss', 'rare']);
  let step: 'salvage' | 'relic' = 'salvage';
  const render = () => {
    if (step === 'salvage') show(bossSalvageView({
      run: r, ghost: g, parts: salvage, strip: 80 + 30 * r.sector,
      onTake: (p) => { r.inv.push(mkPart(p.id, p.tier)); sfx('buy'); step = 'relic'; render(); },
      onStrip: () => { r.scrap += 80 + 30 * r.sector; step = 'relic'; render(); },
    }));
    else show(trophyView({ run: r, relics, onTake: (id) => next(id), onSkip: () => next(null) }));
  };
  const next = (id: string | null) => {
    if (id) addRelic(r, id);
    // the boss's commission: the Overdrive tree opens before the next sector (Continue banks it if nothing is open)
    if (r.odCredits > 0 && openOdNodes(HULLS[r.hull].overdrive, r.od).length) {
      odTreeScreen('commission', null, () => proceed(), { once: (msg) => { mapToastOd = msg; proceed(); }, backLabel: 'Bank it and continue' });
      return;
    }
    proceed();
  };
  const proceed = () => {
    const patched = heal(r, 0.3);
    if (r.sector >= CAMPAIGN_SECTORS && !r.won) { r.won = true; r.phase = 'victory'; saveRun(r); showVictory(); return; }
    enterNextSector(r); sectorGhosts = [];
    mapToast = (patched >= 1 ? `Sector ${r.sector}. Crews patched ${Math.round(patched)} hull on the way in.` : `Sector ${r.sector}. The hull is whole; the crews rest on the way in.`) + (mapToastOd ? ` ${mapToastOd}` : '');
    mapToastOd = '';
    saveRun(r); mapScreen();
  };
  render();
}

/** Daily runs: file the run with the registry and print the day's duty roster (null for ordinary runs). */
function dailyRoster(r: RunState, st: Settlement): Node | null {
  const f = filingFor(r.callsign, st);
  if (!f) return null;
  const ro = roster({ date: f.date, callsign: f.callsign });
  ro.status('Filing your run with the registry…');
  void (async () => {
    const res = await submitDaily(f);
    ro.filing(res, f);
    const board = await fetchDailyBoard(f.date, f.callsign);
    ro.show(board, board.online ? null : localRow(f));
  })();
  return ro.node;
}

function showVictory() {
  const r = run!;
  mode = 'menu'; sfx('clear'); music.setScene('victory');
  victoryScreen(r,
    () => { const st = settle(profile, r, 'victory'); clearSave(); portScreen(r, st, () => { run = null; titleScreen(); }, dailyRoster(r, st)); },
    () => { r.endless = true; r.phase = 'map'; enterNextSector(r); sectorGhosts = []; mapToast = `Endless: sector ${r.sector}. The map keeps going, and so do they.`; saveRun(r); mapScreen(); });
}

async function onDeath() {
  const r = run!;
  clearSave(); music.setScene('death');
  const st = settle(profile, r, 'dead');
  const g = deathGhost(r);
  const report = wreckReport({ run: r, floor: g.floor, settlement: st, onAgain: () => { run = null; titleScreen(); }, roster: dailyRoster(r, st) });
  show(report.node);
  const res = await submitGhost(g);
  report.setStatus(res === 'shared'
    ? `Your dreadnought now haunts sector ${r.sector}. Pilots who reach its end may face your ghost, armed exactly as you were.`
    : `Your dreadnought now haunts sector ${r.sector} on this device. The ghost registry is offline, so other pilots won't meet it.`);
}

/* ---------------- debug hooks for automated tests ---------------- */
declare global { interface Window { __gd: unknown } }
window.__gd = {
  get run() { return run; }, get profile() { return profile; }, S, debug, EVENTS, aim, gunnery, selectGroup,
  travelTo(type: NodeType) { const r = run!; const id = reachable(r.map, r.at).find((i) => r.map.nodes[i].type === type); if (id) travel(id); return !!id; },
  reachableTypes() { const r = run!; return reachable(r.map, r.at).map((i) => r.map.nodes[i].type); },
  forceNext(type: NodeType) { const r = run!; const id = reachable(r.map, r.at)[0]; r.map.nodes[id].type = type; if (type === 'fight') r.map.nodes[id].enc = 'patrol'; if (type === 'elite') r.map.nodes[id].enc = 'ace'; travel(id); },
  god(on = true) { S.god = on; },
  winNow() { if (S.boss?.alive) damageTarget(S.boss, 1e9); if (S.elite && !S.elite.dead) damageTarget(S.elite, 1e9); S.time = 9999; for (const e of S.enemies) e.hp = 0.5; },
  overdrive() { S.overdrive.charge = 1; return triggerOverdrive(); },
  killPlayer() { S.god = false; S.firstHitUsed = true; S.cheatDeath = false; if (S.P) { S.P.shield = 0; S.P.hp = 1; } damagePlayer(9999); },
  addScrap(n: number) { run!.scrap += n; },
  /** Spawn one director group of an enemy type into the running fight. */
  spawn(type: EnemyType) { if (S.active && S.P) spawnGroup(type); },
  spawnElite(type: EnemyType) { if (S.active && S.P) spawnElite(type); },
};

titleScreen();
