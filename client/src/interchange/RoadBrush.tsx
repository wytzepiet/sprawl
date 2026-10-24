import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { Dots } from "../engine/dots";
import { screenToWorld, viewArea } from "../engine/view";
import { builtVersion, listenHints, roadsAt, useGame } from "../state/gameObjects";
import { priority, setTool, tool } from "../ui/buildMode";
import type { Tool } from "../generated";
import { Pen } from "../engine/pen";

/** How high the hand draws road, in levels: 0 the ground, up to 3. The
 *  decks above it are seen through (`decks.ts`). */
const [pen, setPen] = createSignal(0);
export { pen, setPen };

/** The hand's height changed a level up or down (↑ ↓), or null where it
 *  may not be: the road brush sets these, turning the end of the road it
 *  last laid into the slope to the new level. With no brush, the pen
 *  alone. */
const free = (by: number) => () => setPen(Math.max(0, Math.min(3, pen() + by)));
const [climb, setClimb] = createSignal<{ up: (() => void) | null; down: (() => void) | null }>({ up: free(1), down: free(-1) });
export { climb };

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
  /** Shift: the eraser, for as long as it is held. */
  let erasing = false;
  const using = (): Tool | null => (erasing ? "Demolish" : tool());

  const hold = new Pen({ roads: roadsAt, tool: using, want: () => pen() * 2, priority, send, lift: setPen });
  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);

  /** The drag on toward the pointer, as far as the pen may go now. */
  const advance = () => {
    for (const t of hold.onward()) dots.step(t);
    draw();
  };
  const stopHints = listenHints((h) => {
    if (!hold.hear(h)) return;
    if (h.type === "Reach") advance();
    else draw();
  });

  createEffect(on(builtVersion, () => ask(true)));
  createEffect(on([tool, pen, priority], () => ask(), { defer: true }));

  /** Where a drag may start, asked of the game for the view. */
  const ask = (afresh = false) => {
    hold.view(viewArea(scene, canvas), afresh);
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
    const starts: [number, number][] = using() === null ? [] : hold.starts.map((t) => [t.x, t.y]);
    const a = viewArea(scene, canvas);
    dots.aim(starts, hold.nexts(), current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || using() === null) return;
    const w = pick(e);
    const at = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    hold.press(at, w.wx, w.wy);
    dots.grab(at, { x: w.wx, y: w.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!hold.current) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    const went = hold.drag(w.wx, w.wy);
    for (const t of went) dots.step(t);
    if (went.length) draw();
  };

  const onPointerUp = () => {
    if (hold.current) dots.release();
    hold.release();
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
