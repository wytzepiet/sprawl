import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { Dots } from "../engine/dots";
import { screenToWorld, viewExtent, rectOf } from "../engine/view";
import { builtVersion, listenHints, roadsAt, useGame } from "../state/gameObjects";
import { free, pen, priority, setClimb, setPen, setTool, tool } from "../ui/buildMode";
import { snap, STEPS } from "../engine/tiles";
import type { Area, Tool } from "../generated";
import { Pen } from "../engine/pen";

/**
 * The road brush, made for drawing roads and nothing else: the pointer
 * and the dots over the pen (`pen.ts`), which the game tells where it may
 * go. A drag lays the road in hand a step at a time, straight or diagonal
 * toward the pointer; with Shift held, the eraser.
 *
 * The dots show where a drag may start and, while dragging, the steps the
 * tile underfoot allows (`dots.ts`), as the town's brush does.
 */
export function RoadBrush() {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  if (tool() === null) setTool("Street");
  /** Where the pointer is while dragging, and the way it last went. */
  let pointer: { wx: number; wy: number } | null = null;
  let heading = 0;
  let accDx = 0;
  let accDy = 0;
  /** Shift: the eraser, for as long as it is held. */
  let erasing = false;
  const using = (): Tool | null => (erasing ? "Demolish" : tool());

  const hold = new Pen({ roads: roadsAt, tool: using, want: () => pen() * 2, priority, send, lift: setPen });
  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);

  /** The drag on toward the pointer, as far as the pen may go now. */
  const advance = () => {
    if (!pointer) return;
    const went = hold.pull(pointer.wx, pointer.wy, heading);
    for (const t of went) dots.step(t);
    draw();
  };
  const stopHints = listenHints((h) => {
    if (!hold.hear(h)) return;
    if (h.type === "Reach") advance();
    else draw();
  });

  createEffect(on(builtVersion, () => ask(true)));
  createEffect(on([tool, pen, priority], () => ask(), { defer: true }));

  const viewBox = (): Area => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return { x0: Math.floor(mid.wx - half), y0: Math.floor(mid.wy - half), x1: Math.ceil(mid.wx + half), y1: Math.ceil(mid.wy + half) };
  };
  /** Where a drag may start, asked of the game for the view. */
  const ask = (afresh = false) => {
    hold.view(viewBox(), afresh);
    draw();
  };
  let frames = 0;
  const stopWatch = afterRender(() => {
    if (using() !== null && !hold.current && ++frames % 15 === 0) ask();
  });

  function draw() {
    // What ↑ and ↓ do now (`Pen::climb`).
    setClimb({ up: hold.climb(1), down: hold.climb(-1) });
    const current = hold.current;
    const nexts: [number, number][] = current ? STEPS.flatMap(([dx, dy], i) => (hold.allowed(i) ? [[current.x + dx, current.y + dy] as [number, number]] : [])) : [];
    const starts: [number, number][] = using() === null ? [] : hold.starts.map((t) => [t.x, t.y]);
    const a = viewBox();
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || using() === null) return;
    pointer = pick(e);
    const at = { x: Math.floor(pointer.wx), y: Math.floor(pointer.wy) };
    hold.press(at, pointer.wx, pointer.wy);
    accDx = 0;
    accDy = 0;
    dots.grab(at, { x: pointer.wx, y: pointer.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!hold.current || !pointer) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - pointer.wx;
    accDy += w.wy - pointer.wy;
    pointer = w;
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;
    // On toward the pointer, the way it moves, straight or diagonal.
    heading = snap(accDx, accDy);
    accDx = 0;
    accDy = 0;
    advance();
  };

  const onPointerUp = () => {
    if (hold.current) dots.release();
    hold.release();
    pointer = null;
    draw();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift" && erasing !== (e.type === "keydown")) {
      erasing = e.type === "keydown";
      ask();
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    stopHints();
    stopWatch();
    stopTick();
    setTool(null);
    setClimb({ up: free(1), down: free(-1) });
  });

  return dots.el;
}
