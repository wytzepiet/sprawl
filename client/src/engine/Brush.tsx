import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { Dots } from "./dots";
import { underGlass } from "./glass";
import { projector, screenToWorld, viewExtent, rectOf } from "./view";
import { builtVersion, getObjectsAt, listenHints, roadsAt, useGame } from "../state/gameObjects";
import { aim, held, hold, priority, setAim, setPlaced, setPriority, setTool, tool, turn } from "../ui/buildMode";
import { snap, STEPS } from "./tiles";
import { Pen } from "./pen";
import type { Area, Building, GridCoord, Tool } from "../generated";

/**
 * The mayor's hand on the map. A road, the demolisher or lights go by the
 * pen (`pen.ts`): a drag of road laid as it goes, straight or diagonal
 * toward the pointer; the demolisher's tap takes everything at its tile,
 * a building whole, and its drag cuts only the road it crosses.
 *
 * A building in hand, dragged from the build menu, is placed whole where
 * it is let go (`Place`): shown where it would stand as the town would be
 * drawn with it (`TownLayer.hold`), turned to the nearest street or, a
 * harbour, the sea, unless the hand turns it (R, the wheel, two fingers);
 * beside it (`ui/gpu/Held.tsx`), what it is built of against what the
 * town has, or why it may not go there.
 *
 * Where the hand may go is the game's to say (`server/src/hint.rs`), and
 * the dots show it (`dots.ts`): one on every tile in view a drag may start
 * from, or a building may stand round, and while dragging the steps the
 * tile it is on allows. A step not allowed, or not yet answered, is not
 * taken: the drag waits there, straining.
 *
 * Alt with the bare hand is the eyedropper: it picks up the road it
 * presses on, and a drag from there lays more of it.
 */
export function Brush() {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  const pen = new Pen({ roads: roadsAt, tool, want: () => 0, priority, send, lift: () => {} });
  /** Where the pointer is while dragging, and the way it last went. */
  let pointer: { wx: number; wy: number } | null = null;
  let heading = 0;
  let accDx = 0;
  let accDy = 0;

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const tileOf = (e: { clientX: number; clientY: number }) => {
    const w = pick(e);
    return { x: Math.floor(w.wx), y: Math.floor(w.wy) };
  };

  /** The tile under the pointer, while it is over the map. */
  let hover: GridCoord | null = null;
  /** Where the building in hand would stand there, asked of the game. */
  const aimAt = () => {
    const h = held();
    if (!hover || !h) return setAim(null);
    send({ type: "Ask", data: { type: "Placing", data: { kind: h.kind, at: hover, facing: h.facing } } });
  };
  /** The tiles in view the building in hand may stand round, as the game
   *  last said, and what they were asked of. */
  let fits: GridCoord[] = [];
  let fitsAsked = "";
  const fitsKey = (kind: string, facing: number | null, a: Area) => [kind, facing, a.x0, a.y0, a.x1, a.y1].join();

  /** The drag on toward the pointer, as far as the pen may go now. */
  const advance = () => {
    if (!pointer) return;
    for (const t of pen.pull(pointer.wx, pointer.wy, heading)) dots.step(t);
    draw();
  };
  const stopHints = listenHints((h) => {
    const p = held();
    if (h.type === "Placing") {
      if (p && hover && h.data.kind === p.kind) setAim(h.data);
    } else if (h.type === "Starts" && h.data.hand.type === "Building") {
      if (fitsKey(h.data.hand.data.kind, h.data.hand.data.facing, h.data.area) === fitsAsked) (fits = h.data.tiles), draw();
    } else if (pen.hear(h)) {
      if (h.type === "Reach") advance();
      else draw();
    }
  });

  /** The tiles the view covers. */
  const viewBox = (): Area => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return { x0: Math.floor(mid.wx - half), y0: Math.floor(mid.wy - half), x1: Math.ceil(mid.wx + half), y1: Math.ceil(mid.wy + half) };
  };
  /** Where the hand may start, asked of the game for the view; `afresh`,
   *  again, something having been built. */
  const ask = (afresh = false) => {
    const [a, h] = [viewBox(), held()];
    if (h) {
      const key = fitsKey(h.kind, h.facing, a);
      if (key !== fitsAsked || afresh) send({ type: "Ask", data: { type: "Starts", data: { hand: { type: "Building", data: { kind: h.kind, facing: h.facing } }, area: a } } });
      fitsAsked = key;
    } else pen.view(a, afresh);
    draw();
  };
  createEffect(on(builtVersion, () => (ask(true), aimAt())));
  // And again when another tool or building is taken up, or turned.
  createEffect(on([tool, held, priority], () => (ask(), aimAt()), { defer: true }));
  let frames = 0;
  const stopWatch = afterRender(() => {
    if ((tool() !== null || held() !== null) && !pen.current && ++frames % 15 === 0) ask();
  });

  /** Tell the dots what to show: the starts in view while nothing is
   *  pressed, the steps out of the tile underfoot while dragging; with a
   *  building in hand, every tile it may stand round. */
  function draw() {
    const current = pen.current;
    const starts = held() ? fits : tool() !== null ? pen.starts : [];
    const nexts: [number, number][] = current ? STEPS.flatMap(([dx, dy], i) => (pen.allowed(i) ? [[current.x + dx, current.y + dy] as [number, number]] : [])) : [];
    const a = viewBox();
    dots.aim(starts.map((t) => [t.x, t.y]), nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 });
  }

  /** What road stands at a tile, as the tool that lays it, and whether
   *  it has priority. */
  const toolAt = (at: GridCoord): [Tool, boolean] | null => {
    const e = getObjectsAt(at.x, at.y).find((e) => e.object.kind === "RoadNode");
    if (e?.object.kind !== "RoadNode") return null;
    const n = e.object.data;
    const oneWay = n.outgoing.some((o) => !n.incoming.includes(o)) || n.incoming.some((i) => !n.outgoing.includes(i));
    return [oneWay ? "OneWay" : "Street", n.road.length > 0];
  };
  // The eyedropper: with the bare hand, Alt on a road picks up what laid
  // it, before the camera or the picker see the press, so the same drag
  // carries it on.
  const onEyedrop = (e: PointerEvent) => {
    if (e.button !== 0 || !e.altKey || tool() !== null || held() !== null) return;
    const t = toolAt(tileOf(e));
    if (t) (setPriority(t[1]), setTool(t[0]));
  };

  /** Let go with a building in hand: placed, if it may stand there, and
   *  the hand empty, unless Shift keeps it for another. */
  const place = (shift: boolean) => {
    const p = aim();
    if (!p || p.why) return;
    send({ type: "Place", data: { kind: p.kind, at: p.at, facing: p.facing } });
    setPlaced(p);
    if (!shift) hold(null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || held() !== null || tool() === null) return;
    pointer = pick(e);
    const at = { x: Math.floor(pointer.wx), y: Math.floor(pointer.wy) };
    pen.press(at, pointer.wx, pointer.wy);
    accDx = 0;
    accDy = 0;
    dots.grab(at, { x: pointer.wx, y: pointer.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pen.current || !pointer) {
      const at = tileOf(e);
      if (at.x !== hover?.x || at.y !== hover?.y) (hover = at), aimAt();
      return;
    }
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - pointer.wx;
    accDy += w.wy - pointer.wy;
    pointer = w;
    // Need enough accumulated movement to determine direction
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;
    heading = snap(accDx, accDy);
    accDx = 0;
    accDy = 0;
    advance();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (held() !== null && e.button === 0 && touches.size < 2) return place(e.shiftKey);
    if (pen.current) dots.release();
    pen.release();
    pointer = null;
    draw();
  };

  // Turning a building in hand: R, the wheel, or two fingers twisting.
  const onKey = (e: KeyboardEvent) => {
    if (held() === null || e.ctrlKey || e.metaKey) return;
    if (e.key === "r" || e.key === "R") turn(e.shiftKey ? -1 : 1);
    else if (e.key === "Escape") hold(null);
    else return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  let wheeled = 0;
  const onWheel = (e: WheelEvent) => {
    if (held() === null) return;
    e.preventDefault();
    // A notch a quarter turn, however fine the wheel.
    const now = performance.now();
    if (now - wheeled > 120) turn(e.deltaY > 0 ? 1 : -1), (wheeled = now);
  };
  const touches = new Map<number, { x: number; y: number }>();
  let twist: number | null = null;
  const angle = () => {
    const [a, b] = [...touches.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    twist = touches.size === 2 ? angle() : null;
  };
  const onTouchMove = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (twist === null || held() === null || touches.size !== 2) return;
    // A quarter turn for every sixty degrees the fingers twist.
    let d = angle() - twist;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > Math.PI / 3) turn(d > 0 ? 1 : -1), (twist = angle());
  };
  const onTouchUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    twist = null;
  };

  canvas.addEventListener("pointerdown", onEyedrop, { capture: true });
  canvas.addEventListener("pointerdown", onTouchDown, { capture: true });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onTouchMove);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerup", onTouchUp);
  canvas.addEventListener("pointercancel", onTouchUp);
  canvas.addEventListener("wheel", onWheel, { passive: false, capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
  const onLeave = () => ((hover = null), aimAt());
  canvas.addEventListener("pointerleave", onLeave);

  // In development, the hand put in a pose a photograph cannot drag it
  // into (`bun run look --hold`): a building held over a tile.
  if (import.meta.env.DEV)
    Object.assign(window, {
      sprawlHold: (kind: Building["kind"] | null, x: number, y: number, facing: number | null = null) => {
        if (held()?.kind !== kind || held()?.facing !== facing) hold(kind, facing);
        hover = { x, y };
        aimAt();
      },
    });

  // The plot of the building in hand, flat on the ground; its tiles in
  // red where it may not stand. Its label is the UI's (`ui/gpu/Held.tsx`).
  const plot = document.createElement("canvas");
  plot.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none";
  const stopLabel = afterRender(() => {
    const p = aim();
    const g = plot.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    if (plot.width !== w || plot.height !== h) [plot.width, plot.height] = [w, h];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!p) return;
    const project = projector(scene, canvas);
    g.fillStyle = p.why ? "rgba(216,67,47,0.42)" : "rgba(47,123,240,0.22)";
    g.strokeStyle = p.why ? "rgba(216,67,47,0.9)" : "rgba(47,123,240,0.85)";
    g.lineWidth = 2;
    g.beginPath();
    for (const t of p.tiles) {
      const corners = [[t.x, t.y], [t.x + 1, t.y], [t.x + 1, t.y + 1], [t.x, t.y + 1]].map(([x, y]) => project.at(x, y, 0.05));
      g.moveTo(corners[0].sx, corners[0].sy);
      for (const c of corners.slice(1)) g.lineTo(c.sx, c.sy);
      g.closePath();
    }
    if (p.why) g.fill();
    g.stroke();
    underGlass(g);
  });
  document.body.appendChild(plot);

  onCleanup(() => {
    stopLabel();
    plot.remove();
    canvas.removeEventListener("pointerleave", onLeave);
    setAim(null);
    canvas.removeEventListener("pointerdown", onEyedrop, { capture: true });
    canvas.removeEventListener("pointerdown", onTouchDown, { capture: true });
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onTouchMove);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointerup", onTouchUp);
    canvas.removeEventListener("pointercancel", onTouchUp);
    canvas.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("keydown", onKey, { capture: true });
    stopHints();
    stopWatch();
    stopTick();
  });

  return dots.el;
}
