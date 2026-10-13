import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { Dots } from "../engine/dots";
import { screenToWorld, viewExtent, rectOf } from "../engine/view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { free, pen, priority, setClimb, setPen, setTool, tool } from "../ui/buildMode";
import { hand, snap, STEPS, type Hand } from "../engine/may";
import type { GridCoord, TerrainType, Tool } from "../generated";
import type { Bounds } from "../engine/OrthoCamera";
import { Pen } from "./pen";

/**
 * The road brush, made for drawing roads and nothing else: the pointer
 * and the dots over the pen (`pen.ts`), which decides each step. A drag
 * lays the road in hand a step at a time, straight or diagonal toward the
 * pointer; with Shift held, the eraser. Each step waits for the world to
 * come back with the last, so the pen decides on the roads as they are,
 * as its tests do (`pen.test.ts`); a step refused, which changes nothing,
 * waits no longer than `WAIT`.
 *
 * The dots show where a drag may start and, while dragging, the steps the
 * tile underfoot allows (`dots.ts`), as the town's brush does.
 */
export function RoadBrush(props: { ground: (x: number, y: number) => TerrainType | undefined; bounds: () => Bounds | null }) {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  if (tool() === null) setTool("Street");
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;
  /** Shift: the eraser, for as long as it is held. */
  let erasing = false;
  const using = (): Tool | null => (erasing ? "Demolish" : tool());

  let world: Hand | null = null;
  const inside = (t: GridCoord) => {
    const b = props.bounds();
    return !!b && t.x >= b.x0 && t.x <= b.x1 && t.y >= b.y0 && t.y <= b.y1;
  };
  const hold = new Pen({
    world: () => world,
    tool: using,
    want: () => pen() * 2,
    priority,
    inside,
    ground: props.ground,
    send: (data) => send({ type: "Build", data }),
    lift: setPen,
  });

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const tileOf = (e: { clientX: number; clientY: number }) => {
    const w = pick(e);
    return { x: Math.floor(w.wx), y: Math.floor(w.wy) };
  };

  createEffect(on(builtVersion, () => {
    world = hand(eachEntity, props.ground);
    heard();
    draw();
  }));
  createEffect(on([tool, pen, priority], () => draw(), { defer: true }));

  const viewBox = () => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  let drawnOver = "";
  let frames = 0;
  const stopWatch = afterRender(() => {
    if (using() === null || hold.current || ++frames % 15) return;
    if (viewBox().join() !== drawnOver) draw();
  });

  function draw() {
    // What ↑ and ↓ do now: make the end of the road last laid the slope,
    // where it may be one; else move the pen.
    const [up, down] = [hold.climb(1), hold.climb(-1)];
    setClimb({ up: pen() < 3 ? up ?? free(1) : null, down: pen() > 0 ? down ?? free(-1) : null });
    const starts: [number, number][] = [];
    const nexts: [number, number][] = [];
    const [x0, y0, x1, y1] = viewBox();
    const current = hold.current;
    if (world && using() !== null) {
      if (current) for (const [i, [dx, dy]] of STEPS.entries()) if (hold.allowed(i)) nexts.push([current.x + dx, current.y + dy]);
      drawnOver = [x0, y0, x1, y1].join();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (hold.mayStartHere({ x, y })) starts.push([x, y]);
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || using() === null) return;
    if (letGo) release();
    const at = tileOf(e);
    prevWorld = pick(e);
    hold.press(at, prevWorld.wx, prevWorld.wy);
    lead = at;
    trail = [];
    accDx = 0;
    accDy = 0;
    dots.grab(at, { x: prevWorld.wx, y: prevWorld.wy });
    draw();
  };

  /** The tiles the pointer has led the drag through, the pen not yet
   *  there, and the last of them; whether a step is out, not yet heard
   *  back; and whether the drag is let go of, to be finished first. */
  let trail: GridCoord[] = [];
  let lead: GridCoord | null = null;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let letGo = false;
  const heard = () => {
    if (waiting) clearTimeout(waiting);
    waiting = null;
    advance();
  };
  /** The pen's next step along the trail, if none is out; then wait. A
   *  step refused, the rest of the trail is dropped, and the pointer leads
   *  on from where the pen stands. Nothing left, and let go: done. */
  const advance = () => {
    if (waiting || !hold.current) return;
    const next = trail.shift();
    if (next && hold.step(next)) {
      dots.step(next);
      draw();
      waiting = setTimeout(heard, WAIT);
    } else if (next) {
      trail = [];
      lead = hold.current;
    } else if (letGo) release();
  };
  const release = () => {
    if (hold.current) dots.release();
    hold.release();
    prevWorld = lead = null;
    trail = [];
    letGo = false;
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!hold.current || !prevWorld || letGo) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;
    // The trail led on toward the pointer, the way it moves, straight or
    // diagonal.
    const [sx, sy] = STEPS[snap(accDx, accDy)];
    for (let i = 0; i < 50 && lead; i++) {
      const dist = Math.max(Math.abs(w.wx - (lead.x + 0.5)), Math.abs(w.wy - (lead.y + 0.5)));
      const next: GridCoord = { x: lead.x + sx, y: lead.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (dist < 0.6 || newDist >= dist) break;
      trail.push(next);
      lead = next;
    }
    accDx = 0;
    accDy = 0;
    advance();
  };

  const onPointerUp = () => {
    letGo = true;
    advance();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift" && erasing !== (e.type === "keydown")) {
      erasing = e.type === "keydown";
      draw();
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
    stopWatch();
    stopTick();
    if (waiting) clearTimeout(waiting);
    setTool(null);
    setClimb({ up: free(1), down: free(-1) });
  });

  return dots.el;
}

/** How long a step waits to be heard back before the next goes anyway: a
 *  step refused changes nothing, and nothing comes back. */
const WAIT = 150;
