import type { Common } from "./index";

/** How far a finger moves before a press is a drag, in CSS pixels. */
const SLOP = 6;

/** What each element of the UI does under the hand: its props, read when the hand comes. */
const nodes = new WeakMap<Element, Common>();
export const handle = (el: Element, props: Common) => void nodes.set(el, props);

type Handler = "onTap" | "onScroll" | "onPress" | "onHover" | "onDrag" | "onDrop" | "onSlide";
/** The nearest element, from this one up, that takes it. */
function up(el: Element | null, prop: Handler): Common | null {
  for (; el; el = el.parentElement) {
    const p = nodes.get(el);
    if (p?.[prop]) return p;
  }
  return null;
}

/**
 * The hand on the UI: a press on it is the UI's and never reaches the
 * town under it, which the page sees to (what the UI does not take, it
 * lets through: `pointer-events`). A tap goes to the nearest element that
 * takes one, a drag or the wheel to the nearest that scrolls. A press
 * dragged off an element that lets go of it (`onDrag`: a building out of
 * the build menu) is the town's from there; a press on the town, let go
 * over an element that takes a drop, is that element's.
 */
export function hand(root: HTMLElement) {
  const mine = (t: EventTarget | null): t is Element => t instanceof Element && root.contains(t);
  /** What takes a drop under a town's press: the pointer's target, which
   *  is the canvas while the town holds the pointer and what lies under
   *  it once a drag out of the UI has let go of it. */
  const dropOn = (e: PointerEvent) => (mine(e.target) ? up(e.target, "onDrop") : null);
  let press: { id: number; el: Element; x: number; y: number; last: number; dragged: boolean; sliding: boolean } | null = null;
  /** The pointer the town has, if it has one. */
  let town: number | null = null;
  let over: Common | null = null;
  const hover = (p: Common | null) => {
    if (p === over) return;
    over?.onHover?.(false);
    (over = p)?.onHover?.(true);
  };

  const down = (e: PointerEvent) => {
    if (!mine(e.target)) return void (town = e.pointerId);
    const el = e.target;
    // Held by what it began on, as a finger is: what it does is the UI's
    // until it is let go, wherever it goes.
    el.setPointerCapture(e.pointerId);
    press = { id: e.pointerId, el, x: e.clientX, y: e.clientY, last: e.clientY, dragged: false, sliding: false };
    up(el, "onPress")?.onPress!(true);
  };
  /** A slide's place along what takes it. */
  const slid = (e: PointerEvent, held: boolean) => {
    const s = press && up(press.el, "onSlide");
    if (!s || !press) return false;
    let el: Element | null = press.el;
    while (el && nodes.get(el) !== s) el = el.parentElement;
    const r = el!.getBoundingClientRect();
    s.onSlide!(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))), held);
    return true;
  };
  const move = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) {
      if (press.sliding) return void slid(e, true);
      if (!press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) {
        press.dragged = true;
        // Across, it slides; up or down, the sheet scrolls under it.
        if (Math.abs(e.clientX - press.x) > Math.abs(e.clientY - press.y) && slid(e, true)) return void (press.sliding = true);
        const out = up(press.el, "onDrag");
        if (out) {
          up(press.el, "onPress")?.onPress!(false);
          // Let go, the town has it.
          press.el.releasePointerCapture(e.pointerId);
          press = null;
          town = e.pointerId;
          return out.onDrag!();
        }
      }
      const s = up(press.el, "onScroll");
      if (press.dragged && s) s.onScroll!(press.last - e.clientY, true);
      press.last = e.clientY;
      return;
    }
    if (e.pointerId === town) return void hover(dropOn(e));
    if (e.pointerType === "mouse") hover(mine(e.target) ? up(e.target, "onHover") : null);
  };
  const lift = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) {
      if (press.sliding && slid(e, false)) return void (up(press.el, "onPress")?.onPress!(false), (press = null));
      const p = press;
      press = null;
      up(p.el, "onPress")?.onPress!(false);
      if (p.dragged) return void up(p.el, "onScroll")?.onScroll!(0, false);
      if (e.type === "pointercancel") return;
      const tap = up(p.el, "onTap");
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (tap && mine(under) && up(under, "onTap") === tap) tap.onTap!();
      return;
    }
    if (e.pointerId !== town) return;
    town = null;
    const drop = dropOn(e);
    hover(null);
    if (drop && e.type === "pointerup") e.stopPropagation(), drop.onDrop!();
  };
  const wheel = (e: WheelEvent) => {
    if (!mine(e.target)) return;
    e.preventDefault();
    up(e.target, "onScroll")?.onScroll!(e.deltaY);
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  window.addEventListener("wheel", wheel, { capture: true, passive: false });
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
    window.removeEventListener("wheel", wheel, true);
  };
}
