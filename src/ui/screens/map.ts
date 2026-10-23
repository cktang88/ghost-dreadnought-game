// Sector map: the plotting table, a plot readout, and the ghost's dossier pinned beside it.
import type { RunState } from '../../game/run';
import type { Ghost } from '../../game/ghosts';
import type { NodeType } from '../../game/map';
import { NODE_INFO } from '../../game/map';
import { partDef, TIER, type Part } from '../../data/parts';
import { el, svg } from '../h';
import { topBar } from '../cards';
import { icon } from '../icons';
import { glyph } from '../mapView';
import { stamp, teletype } from '../kit';

const DEFAULT_READOUT = 'Hover a node to plot it. Glowing nodes are in range.';

/** CRT strip that describes the hovered node. Keeps data-testid="node-info". */
export function plotReadout() {
  const p = el('p', { 'data-testid': 'node-info', class: 'readout-text' }, DEFAULT_READOUT);
  const sock = el('span', 'readout-sym');
  const box = el('section', 'readout crt', el('div', 'crt-k', 'Plot readout'), el('div', 'readout-row', sock, p));
  const set = (type: NodeType | null, text: string) => {
    sock.replaceChildren();
    if (!type) { p.textContent = DEFAULT_READOUT; return; }
    const s = svg('svg', { viewBox: '-20 -20 40 40', 'aria-hidden': 'true' }); s.append(glyph(type, 22)); sock.append(s);
    p.textContent = text;
  };
  return { el: box, set };
}

/** The ghost dossier: a pinned paper file with the wreck's blueprint photo. Keeps .card.intel. */
export function dossier(g: Ghost, count: number, blueprint: HTMLCanvasElement, parts: Part[]) {
  const arms = el('ul', 'arms');
  const seen = new Map<string, number>();
  for (const p of parts) { const k = `${p.id}|${p.tier}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  for (const [k, n] of seen) { const [id, t] = k.split('|'); arms.append(el('li', null, icon(id), el('span', null, `${partDef(id).name} Mk ${TIER[Number(t)]}`), n > 1 ? el('b', null, `×${n}`) : null)); }
  if (!parts.length) arms.append(el('li', null, el('span', null, 'Unarmed')));
  return el('section', 'card intel dossier',
    el('i', 'clip', ''),
    el('div', 'doc-head', el('span', null, 'Ghost dossier'), el('span', 'mono', `S-${String(g.sector).padStart(2, '0')}/${(g.id || 'core').slice(-4).toUpperCase()}`)),
    el('div', 'photo', blueprint, el('span', 'photo-cap', g.ai ? 'Automated core' : 'Last known configuration')),
    el('h3', 'subject', g.ai ? `${g.name} (defense core)` : `Ghost of ${g.name}`),
    el('p', 'doc-text', g.ai ? 'No pilot has died in this sector yet, so an automated core holds it.' : `Went down on floor ${g.floor + 1} of sector ${g.sector}. ${count === 1 ? 'One ghost haunts' : `${count} ghosts haunt`} this sector.`),
    el('div', 'doc-k', 'Armament on record'),
    arms,
    stamp(g.ai ? 'Automated' : 'Hostile', 'void doc-stamp'),
  );
}
export function dossierPending() {
  const t = el('strong', 'doc-text');
  teletype(t, 'Scanning wrecks…', { cps: 40 });
  return el('section', 'card intel dossier pending', el('i', 'clip', ''), el('div', 'doc-head', el('span', null, 'Ghost dossier'), el('span', 'mono', 'PENDING')), t);
}

export function mapLegend() {
  const types: NodeType[] = ['fight', 'elite', 'event', 'merchant', 'derelict', 'drydock', 'boss'];
  return el('section', 'chart-key', el('div', 'crt-k', 'Key'), el('div', 'key-grid', ...types.map((t) => {
    const s = svg('svg', { viewBox: '-20 -20 40 40', 'aria-hidden': 'true' }); s.append(glyph(t, 22));
    return el('span', 'key-item', s, el('span', null, NODE_INFO[t].label));
  })));
}

export interface MapScreenOpts {
  run: RunState; chart: SVGSVGElement; toast: string; readout: HTMLElement; intel: HTMLElement;
  onRefit: () => void; onMenu: () => void;
  /** Open the Overdrive refit tree (a banked commission can be spent from the map). */ onTree?: () => void;
}
export function mapScreenView(o: MapScreenOpts) {
  const r = o.run;
  const toast = o.toast ? el('div', { class: 'toast chart-toast', role: 'status' }) : null;
  if (toast) teletype(toast, o.toast, { cps: 140, delay: 250 });
  const floorNow = r.at ? r.map.nodes[r.at].floor + 1 : 0;
  return el('div', { class: 'page map-page', 'data-screen': 'map' },
    topBar(r,
      el('button', { class: 'btn', id: 'btn-refit', onclick: o.onRefit }, icon('auto-repair'), 'Refit ship'),
      o.onTree ? el('button', { class: 'btn' + (r.odCredits > 0 ? ' od-due' : ''), id: 'btn-od-tree', onclick: o.onTree }, icon('power-lightning'), 'Overdrive', r.odCredits > 0 ? el('b', 'od-badge', String(r.odCredits)) : null) : null,
      el('button', { class: 'btn ghost', onclick: o.onMenu }, 'Menu')),
    el('div', 'chartroom',
      el('div', 'table',
        el('div', 'table-head',
          el('span', 'plate', `Sector ${r.sector} · route plot`),
          el('span', 'mono dim', floorNow ? `Floor ${floorNow} of ${r.map.floors}` : 'Awaiting launch'),
          el('span', 'spacer'),
          toast),
        el('div', 'chart', o.chart)),
      el('aside', 'side', o.readout, o.intel, mapLegend())),
  );
}
