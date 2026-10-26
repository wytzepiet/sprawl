import type { Hit } from "./paint";
import type { UiNode } from "./node";

/** How far a finger moves before a press is a drag, in CSS pixels. */
const SLOP = 6;

const inside = (x: number, y: number, h: { x: number; y: number; w: number; h: number; r: number }) => {
  const [qx, qy] = [Math.abs(x - h.x - h.w / 2) - h.w / 2 + h.r, Math.abs(y - h.y - h.h / 2) - h.h / 2 + h.r];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - h.r <= 0;
};
const up = (n: UiNode | null, prop: string): UiNode | null => (!n || n.props[prop] ? n : up(n.parent, prop));

/**
 * The hand on the UI the GPU draws: a press on it is the UI's and never
 * reaches the town under it. Found front to back (`hits`, painted last
 * first); a tap goes to the nearest node that takes one, a drag or the
 * wheel to the nearest that scrolls. A press that starts on the town is
 * the town's to the end, and one dragged off a node that lets go of it
 * (`onDrag`: a building out of the build menu) is the town's from there;
 * either, let go over a node that takes a drop, is that node's.
 */
export function createHand(canvas: HTMLCanvasElement, hits: () => Hit[]) {
  const at = (x: number, y: number) => {
    const all = hits();
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i];
      const [x0, y0, x1, y1] = h.clip;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && inside(x, y, h)) return h.node;
    }
    return null;
  };
  let press: { id: number; node: UiNode; x: number; y: number; last: number; dragged: boolean } | null = null;
  let town = false;
  let over: UiNode | null = null;
  const hover = (n: UiNode | null) => {
    if (n === over) return;
    over?.props.onHover?.(false);
    (over = n)?.props.onHover?.(true);
  };

  const down = (e: PointerEvent) => {
    if (e.target !== canvas) return;
    const n = at(e.clientX, e.clientY);
    if (!n) return void (town = true);
    e.stopPropagation();
    press = { id: e.pointerId, node: n, x: e.clientX, y: e.clientY, last: e.clientY, dragged: false };
    up(n, "onPress")?.props.onPress(true);
  };
  const move = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) {
      e.stopPropagation();
      if (!press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) {
        press.dragged = true;
        const out = up(press.node, "onDrag");
        if (out) {
          up(press.node, "onPress")?.props.onPress(false);
          press = null;
          town = true;
          return out.props.onDrag();
        }
      }
      const s = up(press.node, "onScroll");
      if (press.dragged && s) s.props.onScroll(press.last - e.clientY, true);
      press.last = e.clientY;
      return;
    }
    if (town) return void hover(up(at(e.clientX, e.clientY), "onDrop"));
    if (e.target !== canvas) return void hover(null);
    const n = at(e.clientX, e.clientY);
    canvas.style.cursor = up(n, "onTap") ? "pointer" : "";
    if (e.pointerType === "mouse") hover(up(n, "onHover"));
    if (n) e.stopPropagation();
  };
  const lift = (e: PointerEvent) => {
    if (town) {
      town = false;
      const drop = up(at(e.clientX, e.clientY), "onDrop");
      hover(null);
      if (drop && e.type === "pointerup") e.stopPropagation(), drop.props.onDrop();
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    e.stopPropagation();
    const p = press;
    press = null;
    up(p.node, "onPress")?.props.onPress(false);
    if (p.dragged) return void up(p.node, "onScroll")?.props.onScroll(0, false);
    if (e.type === "pointercancel") return;
    const tap = up(p.node, "onTap");
    if (tap && up(at(e.clientX, e.clientY), "onTap") === tap) tap.props.onTap();
  };
  const wheel = (e: WheelEvent) => {
    if (e.target !== canvas) return;
    const n = at(e.clientX, e.clientY);
    if (!n) return;
    e.stopPropagation();
    e.preventDefault();
    up(n, "onScroll")?.props.onScroll(e.deltaY);
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
