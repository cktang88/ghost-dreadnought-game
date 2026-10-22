// Overdrive refit: the hull's Overdrive upgrade tree as an engineering schematic. One column per path (tier 1 picks
// the path and locks the others); tier 2 offers two refits on the path, tier 3 its capstone. A readout previews what
// a node would change. Data and rules: src/data/overdriveTree.ts. Taking a node goes through run.ts takeOd.
import type { RunState } from '../../game/run';
import { odPrice } from '../../game/run';
import { HULLS, OVERDRIVES } from '../../data/hulls';
import { odNodesFor, odState, odSummary, type OdNode, type OdState } from '../../data/overdriveTree';
import { el } from '../h';
import { icon, OVERDRIVE_ICON } from '../icons';
import { flap, lamp, legend, plateK, stamp } from '../kit';
import { frame, foot } from './frame';

export interface OdTreeOpts {
  run: RunState;
  /** Price multiplier on scrap (merchant markup), or null when refits cannot be bought here (banked commissions still can). */
  priceMul: number | null;
  /** Where the refit was opened from, for the eyebrow. */ where: string;
  onTake: (id: string) => void; onBack: () => void; backLabel?: string;
  /** Last pick, so its stamp lands fresh. */ fresh?: string;
}
const STATE_WORD: Record<OdState, string> = { taken: 'Fitted', open: '', locked: 'Locked', later: '' };

function nodeCard(o: OdTreeOpts, x: OdNode, show: (x: OdNode) => void) {
  const r = o.run, st = odState(x.id, r.od), price = odPrice(r, x.id, o.priceMul ?? 1);
  const buyable = st === 'open' && (r.odCredits > 0 || (o.priceMul !== null && r.scrap >= price));
  const b = el('button', {
    class: `od-node od-${st}${buyable ? ' od-buy' : ''}`, 'data-od': x.id, disabled: !buyable,
    'aria-label': `${x.name}: ${x.desc}`, style: `--od:${OVERDRIVES[x.kind].col}`,
  },
  el('span', 'od-tier', `Tier ${x.tier}`),
  el('span', 'od-name', x.name),
  el('span', 'od-desc', x.desc),
  el('span', 'od-cost', st === 'taken' ? 'Fitted' : st === 'locked' ? 'Path closed' : st === 'later' ? `Needs a tier ${x.tier - 1} refit` :
    r.odCredits > 0 ? 'Commission (free)' : o.priceMul === null ? `${x.cost} scrap at a drydock` : el('span', 'price', icon('metal-bar'), `${price} scrap`)));
  if (st === 'taken' || st === 'locked') b.append(stamp(STATE_WORD[st], st === 'taken' ? 'ok' : 'void', st === 'taken' && o.fresh === x.id));
  b.addEventListener('mouseenter', () => show(x)); b.addEventListener('focus', () => show(x));
  b.addEventListener('click', () => o.onTake(x.id));
  return b;
}

export function odTreeView(o: OdTreeOpts) {
  const r = o.run, kind = HULLS[r.hull].overdrive, def = OVERDRIVES[kind], nodes = odNodesFor(kind);
  const paths = nodes.filter((x) => x.tier === 1);
  // preview readout: what the hovered node does on top of the current fit
  const now = odSummary(kind, r.od);
  const pv = el('p', 'od-preview-text');
  const show = (x: OdNode | null) => {
    if (!x) { pv.textContent = now.length ? `Fitted: ${now.join(' · ')}.` : 'Stock Overdrive. Hover a refit to preview it.'; return; }
    const next = odSummary(kind, [...r.od.filter((id) => id !== x.id), x.id]);
    pv.textContent = `${x.name}: ${x.desc}${next.length ? ` With it: ${next.join(' · ')}.` : ''}`;
  };
  show(null);
  const cols = paths.map((p) => {
    const t2 = nodes.filter((x) => x.tier === 2 && x.requires === p.id), t3 = nodes.filter((x) => x.tier === 3 && x.requires === p.id);
    const st = odState(p.id, r.od);
    return el('div', `od-path od-path-${st}`,
      nodeCard(o, p, show),
      el('i', 'od-link', ''),
      el('div', 'od-pair', ...t2.map((x) => nodeCard(o, x, show))),
      el('i', 'od-link', ''),
      ...t3.map((x) => nodeCard(o, x, show)));
  });
  const credits = el('div', 'od-ledger',
    el('div', 'od-cell', plateK('Commissions'), el('span', 'od-lamps', ...[0, 1, 2].map((i) => lamp(i < r.odCredits ? 'on' : 'off')), el('b', 'mono', String(r.odCredits)))),
    el('div', 'od-cell', plateK('Scrap'), flap(r.scrap, 4, `scrap-${r.seed}`)),
    el('div', 'od-cell', plateK('Refits fitted'), el('b', 'mono', `${r.od.length} / 3`)));
  return frame(r, { screen: 'od-tree', kind: 'console', eyebrow: `Overdrive refit · ${o.where}`, title: def.name, glyph: OVERDRIVE_ICON[kind], wide: true, cls: 'odtree' },
    el('p', 'note', `${def.desc} Pick a path at tier 1; it closes the others. Each tier offers one refit.`),
    credits,
    legend('Refit paths', o.priceMul === null ? 'bought at a drydock or merchant; a commission fits here' : 'sector bosses award a free commission'),
    el('div', { class: 'od-tree', style: `--od:${def.col}` }, ...cols),
    el('section', 'od-preview crt', el('div', 'crt-k', 'Preview'), pv),
    foot(el('button', { class: 'btn primary', id: 'btn-od-back', onclick: o.onBack }, o.backLabel ?? 'Done')),
  );
}
