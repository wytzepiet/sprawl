import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { Dots } from "../engine/dots";
import { screenToWorld, viewExtent, rectOf } from "../engine/view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { setTool, tool } from "../ui/buildMode";
import { hand, may, mayStart, snap, STEPS, type Hand } from "../engine/may";
import type { GridCoord, TerrainType, Tool } from "../generated";
import type { Bounds } from "../engine/OrthoCamera";

/**
 * The road brush, made for drawing roads and nothing else. A drag lays
 * the road in hand a step at a time, straight or diagonal toward the
 * pointer, a one-way running the way the drag goes; with Shift held, or
 * the eraser in hand, it pulls up what it crosses, and a tap takes the
 * tile. Only on the level's map, and never its own roads: the gates.
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
  let current: GridCoord | null = null;
  let pressed: GridCoord | null = null;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;
  /** Shift: the eraser, for as long as it is held. */
  let erasing = false;
  const using = (): Tool | null => (erasing ? "Demolish" : tool());

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const tileOf = (e: { clientX: number; clientY: number }) => {
    const w = pick(e);
    return { x: Math.floor(w.wx), y: Math.floor(w.wy) };
  };
  const step = (from: GridCoord, to: GridCoord) => {
    const t = using();
    if (t !== null) send({ type: "Build", data: { tool: t, from, to } });
  };

  let world: Hand | null = null;
  createEffect(on(builtVersion, () => {
    world = hand(eachEntity, props.ground);
    draw();
  }));
  createEffect(on(tool, () => draw(), { defer: true }));

  const inside = (t: GridCoord) => {
    const b = props.bounds();
    return !!b && t.x >= b.x0 && t.x <= b.x1 && t.y >= b.y0 && t.y <= b.y1;
  };
  /** One of the level's own roads: a gate's. */
  const fixed = (t: GridCoord) => world?.roads.get(`${t.x},${t.y}`)?.node.laid === false;
  /** The level's rule over the world's: the server's (`Level::allows`). */
  const allowedStep = (t: Tool, from: GridCoord, to: GridCoord) => {
    if (!world) return false;
    if (t === "Demolish") return (from.x === to.x && from.y === to.y ? !fixed(to) : !(fixed(from) && fixed(to))) && may(world, t, from, to);
    return inside(from) && inside(to) && may(world, t, from, to);
  };
  const allowed = (at: GridCoord, i: number) => {
    const t = using();
    return t !== null && allowedStep(t, at, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] });
  };
  const mayStartHere = (t: Tool, at: GridCoord) =>
    !!world && mayStart(world, t, at) && (t === "Demolish" ? !fixed(at) || STEPS.some(([dx, dy]) => allowedStep(t, at, { x: at.x + dx, y: at.y + dy })) : inside(at));

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
    if (using() === null || current || ++frames % 15) return;
    if (viewBox().join() !== drawnOver) draw();
  });

  function draw() {
    const t = using();
    const starts: [number, number][] = [];
    const nexts: [number, number][] = [];
    const [x0, y0, x1, y1] = viewBox();
    if (world && t !== null) {
      if (current) for (const [i, [dx, dy]] of STEPS.entries()) if (allowed(current, i)) nexts.push([current.x + dx, current.y + dy]);
      drawnOver = [x0, y0, x1, y1].join();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mayStartHere(t, { x, y })) starts.push([x, y]);
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || using() === null) return;
    current = tileOf(e);
    prevWorld = pick(e);
    accDx = 0;
    accDy = 0;
    pressed = current;
    dots.grab(current, { x: prevWorld.wx, y: prevWorld.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;

    const sector = snap(accDx, accDy);
    const [sx, sy] = STEPS[sector];
    let cur = current!;
    for (let i = 0; i < 50; i++) {
      const dist = Math.max(Math.abs(w.wx - (cur.x + 0.5)), Math.abs(w.wy - (cur.y + 0.5)));
      if (dist < 0.6) break;
      const next: GridCoord = { x: cur.x + sx, y: cur.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (newDist >= dist) break;
      if (!allowed(cur, sector)) break;
      step(cur, next);
      dots.step(next);
      cur = next;
    }
    if (cur !== current) {
      current = cur;
      draw();
    }
    accDx = 0;
    accDy = 0;
  };

  const onPointerUp = () => {
    if (pressed && current === pressed && using() === "Demolish" && !fixed(pressed)) step(pressed, pressed);
    pressed = null;
    if (current) dots.release();
    current = null;
    prevWorld = null;
    draw();
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
    setTool(null);
  });

  return dots.el;
}
