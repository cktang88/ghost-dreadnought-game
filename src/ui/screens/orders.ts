// Drydock and derelict as work orders: a paper form clipped to the console, one job line per option.
import type { RunState } from '../../game/run';
import type { Part } from '../../data/parts';
import { el, hash, pad } from '../h';
import { partCard } from '../cards';
import { icon } from '../icons';
import { flap, stamp } from '../kit';
import { frame, foot } from './frame';
import { relicAward } from './reward';

function orderHead(kind: string, run: RunState, seed: string) {
  const no = pad(Math.floor(hash(seed + run.seed) * 9000) + 1000, 4);
  return el('div', 'order-head',
    el('span', null, el('small', null, 'Form'), kind),
    el('span', null, el('small', null, 'Order no.'), no),
    el('span', null, el('small', null, 'Vessel'), run.callsign),
    el('span', null, el('small', null, 'Sector'), String(run.sector)));
}

/** One job line on a work order: tick box, job, detail, crew hours. Keeps .choice. */
function job(o: { id?: string; title: string; detail: string; hours: string; disabled?: boolean; icon: string; act: () => void }) {
  const b = el('button', { class: 'choice job', id: o.id, disabled: o.disabled },
    el('span', 'tick', icon('wrench')),
    el('span', 'job-ico', icon(o.icon)),
    el('span', 'choice-txt', el('b', null, o.title), el('span', null, o.detail)),
    el('span', 'hours', o.hours));
  b.addEventListener('click', () => { b.classList.add('checked'); b.append(stamp('Done', 'ok', true)); o.act(); });
  return b;
}

export interface DrydockOpts {
  run: RunState; healAmt: number; canRepair: boolean; onRepair: () => void; onUpgrade: () => void;
  welds: { name: string; type: string; detail: string; disabled: boolean; act: () => void }[];
  /** The Overdrive refit job (one tree node, for scrap or a commission). */
  overdrive?: { name: string; detail: string; disabled: boolean; act: () => void };
}
export function drydockView(o: DrydockOpts) {
  return frame(o.run, { screen: 'drydock', kind: 'order', eyebrow: 'Safe harbor', title: 'Drydock', glyph: 'auto-repair', cls: 'orders' },
    el('div', 'paper',
      orderHead('DD-3 Work order', o.run, 'dock'),
      el('p', 'order-note', 'The yard crews can do one job before you launch. Tick it and sign.'),
      el('div', 'jobs',
        job({ id: 'dock-repair', title: 'Repair', detail: o.canRepair ? `Restore ${o.healAmt} hull.` : 'Hull is at full strength.', hours: '40 h', disabled: !o.canRepair, icon: 'auto-repair', act: o.onRepair }),
        job({ id: 'dock-upgrade', title: 'Upgrade', detail: 'Raise one part by a tier.', hours: '26 h', icon: 'anvil-impact', act: o.onUpgrade }),
        o.overdrive ? job({ id: 'dock-overdrive', title: `Overdrive refit: ${o.overdrive.name}`, detail: o.overdrive.detail, hours: '48 h', disabled: o.overdrive.disabled, icon: 'power-lightning', act: o.overdrive.act }) : null,
        ...o.welds.map((w) => job({ title: `Weld on a ${w.name}`, detail: w.detail, hours: '60 h', disabled: w.disabled, icon: w.type, act: w.act })),
      ),
      el('div', 'sign', el('span', null, 'Yard master'), el('i'), el('span', null, 'Commanding officer'), el('i')),
    ),
  );
}

export interface UpgradeOpts { run: RunState; parts: { part: Part; from: number; act: () => void }[]; onBack: () => void }
export function upgradeView(o: UpgradeOpts) {
  return frame(o.run, { screen: 'drydock-upgrade', kind: 'order', eyebrow: 'Drydock', title: 'Upgrade a part', glyph: 'anvil-impact', wide: true, cls: 'orders' },
    el('p', 'note', 'The part gains one tier: more damage, faster fire, or a stronger effect. Slips show the part after the work.'),
    el('div', 'slips', ...o.parts.map((p) => partCard(p.part, { label: `From Mk ${['', 'I', 'II', 'III', 'IV', 'V'][p.from]}`, stampWord: 'Upgraded', onClick: p.act }))),
    foot(el('button', { class: 'btn', onclick: o.onBack }, 'Back')),
  );
}

export function derelictView(o: { run: RunState; onOpen: () => void }) {
  const lever = el('button', { class: 'switch primary lever', id: 'btn-open', onclick: o.onOpen },
    el('span', 'switch-face', el('i', 'lamp warn'), el('span', 'switch-text', el('b', null, 'Cut it open'), el('small', null, 'Thermal lance · strongroom door'))));
  return frame(o.run, { screen: 'derelict', kind: 'order', eyebrow: 'Derelict', title: 'Abandoned hulk', glyph: 'sinking-ship', cls: 'orders' },
    el('div', 'paper',
      orderHead('SV-9 Salvage order', o.run, 'derelict'),
      el('p', 'order-note', 'A gutted warship drifts in a slow spin. Its strongroom is still sealed. Hull number burned off; no transponder.'),
      el('div', 'hulk', icon('sinking-ship'), el('span', null, 'Strongroom', el('b', null, 'Sealed'))),
    ),
    foot(lever),
  );
}

export function derelictOpenedView(o: { run: RunState; scrap: number; relic: string | null; onContinue: () => void }) {
  return frame(o.run, { screen: 'derelict-open', kind: 'order', eyebrow: 'Derelict', title: 'Strongroom opened', glyph: 'open-treasure-chest', cls: 'orders' },
    el('div', 'paper',
      orderHead('SV-9 Salvage order', o.run, 'derelict'),
      el('div', 'recovered', el('span', null, 'Loose scrap swept up'), el('span', 'rec-v', icon('metal-bar'), flap(o.scrap, 3))),
      o.relic ? relicAward(o.relic) : el('p', 'order-note', 'The strongroom is empty.'),
      stamp('Recovered', 'ok order-stamp', true),
    ),
    foot(el('button', { class: 'btn primary', id: 'btn-continue', onclick: o.onContinue }, 'Continue')),
  );
}
