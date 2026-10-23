// Pointer drag and drop for the refit board: one implementation for mouse, pen and touch (no HTML5 drag images).
// A mouse or pen drag starts after the pointer travels a few pixels; a finger has to press and hold first, so the
// page still scrolls under a quick swipe. Drop targets are any element with [data-drop]; the carried tile is a
// clone that follows the pointer and either snaps into the target or springs back to where it came from.
import { prefersReducedMotion } from './h';

export interface DragHooks {
  /** Build the carried tile (defaults to a clone of the source). */
  ghost?: () => HTMLElement;
  start: () => void;
  /** The drop target under the pointer changed (null: none). */
  over: (target: HTMLElement | null) => void;
  /**
   * Released over `target`. Return a function to commit the drop (the tile snaps into the target first, then it runs),
   * or null to refuse it (the tile springs back).
   */
  drop: (target: HTMLElement | null) => (() => void) | null;
  /** Always called last: dropped, refused or cancelled. */
  end: () => void;
  /** Every pointer move while carrying (client coordinates): for drops that land on a spot, not an element. */
  move?: (x: number, y: number) => void;
  /** Where a committed drop snaps to (client rect); defaults to the target element. */
  snapTo?: () => DOMRect | null;
}

let active: { cancel: () => void } | null = null;
/** Is a drag in progress? (Screens hold off re-rendering while one is.) */
export const dragging = () => !!active;
/** Cancel the drag in progress, if any (Escape, screen change). */
export const cancelDrag = () => active?.cancel();

const HOLD_MS = 260, SLOP = 6, CARRY = 0.82;

/** Make `src` draggable. `hooks()` is asked at drag start and may return null to refuse (nothing to carry). */
export function draggable(src: HTMLElement, hooks: () => DragHooks | null) {
  src.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || active) return;
    const touch = e.pointerType === 'touch', x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
    let started = false, h: DragHooks | null = null, ghost: HTMLElement | null = null, target: HTMLElement | null = null;
    let gx = 0, gy = 0, timer = 0, lx = x0, ly = y0;
    const begin = () => {
      h = hooks(); if (!h) { off(); return; }
      started = true;
      const r = src.getBoundingClientRect();
      ghost = h.ghost ? h.ghost() : (src.cloneNode(true) as HTMLElement);
      ghost.classList.add('dnd-ghost'); ghost.removeAttribute('id'); ghost.setAttribute('aria-hidden', 'true');
      // A ghost marked data-own-size keeps its own size (a label carried off a big source, like a module off the plan).
      const own = ghost.hasAttribute('data-own-size');
      Object.assign(ghost.style, { position: 'fixed', left: '0', top: '0', transformOrigin: '0 0', ...(own ? {} : { width: `${r.width}px`, height: `${r.height}px` }), margin: '0', pointerEvents: 'none', zIndex: '1000' });
      document.body.append(ghost);
      src.classList.add('dnd-src'); document.body.classList.add('dnd-on');
      active = { cancel: () => finish(null, true) };
      h.start();
      place(lx, ly);
      for (let n = src.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) { scroller = n; break; } }
      raf = requestAnimationFrame(edgeScroll);
      if (touch && navigator.vibrate) try { navigator.vibrate(12); } catch { /* not allowed */ }
    };
    const place = (x: number, y: number) => {
      // Carried a little smaller, hanging below-right of the pointer, so the socket under it stays readable.
      gx = x + 14; gy = y + 16;
      if (ghost) ghost.style.transform = `translate(${gx}px, ${gy}px) scale(${CARRY}) rotate(-1.5deg)`;
      const under = document.elementFromPoint(x, y) as HTMLElement | null;
      const t = (under?.closest('[data-drop]') as HTMLElement | null) ?? null;
      if (t !== target) { target = t; h?.over(t); }
      h?.move?.(x, y);
    };
    // Near the top or bottom edge of the scroller the page scrolls under the carried tile (phones: hold below the board).
    let scroller: HTMLElement | null = null, raf = 0;
    const edgeScroll = () => {
      raf = 0;
      if (!started || !scroller) return;
      const r = scroller.getBoundingClientRect(), zone = 56;
      const v = ly < r.top + zone ? -(r.top + zone - ly) : ly > r.bottom - zone ? ly - (r.bottom - zone) : 0;
      if (v) { const before = scroller.scrollTop; scroller.scrollTop += Math.sign(v) * Math.min(22, Math.abs(v) * 0.35); if (scroller.scrollTop !== before) place(lx, ly); }
      raf = requestAnimationFrame(edgeScroll);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      lx = ev.clientX; ly = ev.clientY;
      if (!started) {
        if (Math.hypot(lx - x0, ly - y0) > SLOP) { if (touch) off(); else begin(); }
        return;
      }
      ev.preventDefault(); place(lx, ly);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!started) { off(); return; }
      finish(target, false);
    };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === id) { if (started) finish(null, true); else off(); } };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && started) { ev.preventDefault(); finish(null, true); } };
    const noTouchScroll = (ev: TouchEvent) => { if (started) ev.preventDefault(); };
    const swallowClick = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
    function off() {
      clearTimeout(timer); cancelAnimationFrame(raf); raf = 0;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true); window.removeEventListener('touchmove', noTouchScroll);
    }
    function finish(t: HTMLElement | null, cancelled: boolean) {
      off();
      const hk = h!, g = ghost!;
      active = null;
      // The click that follows pointerup on the source must not also select it.
      window.addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0);
      const commit = cancelled ? null : hk.drop(t);
      const still = prefersReducedMotion();
      const to = commit && hk.snapTo ? hk.snapTo() : commit && t ? t.getBoundingClientRect() : src.isConnected ? src.getBoundingClientRect() : null;
      const done = () => { g.remove(); src.classList.remove('dnd-src'); document.body.classList.remove('dnd-on'); if (commit) commit(); hk.end(); };
      if (!to || still) { done(); return; }
      // Snap: the tile drops square into the socket (fast, slight overshoot), or springs home when refused.
      const gw = g.offsetWidth, gh = g.offsetHeight;
      const tx = to.left + (to.width - gw) / 2, ty = to.top + (to.height - gh) / 2;
      g.classList.add(commit ? 'dnd-snap' : 'dnd-return');
      g.style.transform = `translate(${tx}px, ${ty}px)`;
      setTimeout(done, commit ? 150 : 220);
    }
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true); window.addEventListener('touchmove', noTouchScroll, { passive: false });
    if (touch) timer = window.setTimeout(begin, HOLD_MS);
  });
  // A held finger would otherwise open the context menu or start a text selection.
  src.addEventListener('contextmenu', (e) => { if (active) e.preventDefault(); });
}
