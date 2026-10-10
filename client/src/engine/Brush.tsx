import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { Dots } from "./dots";
import { screenToWorld, viewExtent, rectOf } from "./view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { isRoad, setTool, tool } from "../ui/buildMode";
import { hand, may, mayStart, snap, STEPS, type Hand } from "./may";
import type { GridCoord, TerrainType, Tool } from "../generated";

/**
 * The mayor's hand on the map: whatever is held is laid as the drag goes,
 * a step from one tile to the next, each sent as it is taken
 * (`Build { tool, from, to }`), straight or diagonal toward the pointer.
 * A tap, or the first tile of a drag, paints that tile alone, and a road
 * needs two; the demolisher's tap clears everything at its tile, and its
 * drag cuts only what joins the tiles it crosses.
 *
 * And where it may go, worked out here (`may.ts`) and shown by the dots
 * (`dots.ts`): one on every tile in view a drag may start from, and
 * while dragging the steps the tile it is on allows. A step refused is not taken: the drag waits there, straining.
 *
 * Alt with the bare hand is the eyedropper: it picks up what stands
 * where it presses, and a drag from there lays more of it.
 */
export function Brush(props: { ground: (x: number, y: number) => TerrainType | undefined }) {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  let current: GridCoord | null = null;
  /** The tile pressed on, while the hand is down. */
  let pressed: GridCoord | null = null;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const step = (from: GridCoord, to: GridCoord) => {
    const held = tool();
    if (held !== null) send({ type: "Build", data: { tool: held, from, to } });
  };

  // The world as the hand sees it, read again when something is built.
  let world: Hand | null = null;
  createEffect(on(builtVersion, () => {
    world = hand(eachEntity, props.ground);
    draw();
  }));
  // And drawn again when another tool is taken up.
  createEffect(on(tool, () => draw(), { defer: true }));
  const allowed = (at: GridCoord, i: number) => {
    const held = tool();
    return !!world && held !== null && may(world, held, at, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] });
  };

  /** The tiles the view covers. */
  const viewBox = () => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  // Drawn again when the view moves on a tile.
  let drawnOver = "";
  let frames = 0;
  const stopWatch = afterRender(() => {
    if (tool() === null || current || ++frames % 15) return;
    if (viewBox().join() !== drawnOver) draw();
  });

  /** Tell the dots what to show: the starts in view while nothing is
   *  pressed, the steps out of the tile underfoot while dragging. */
  function draw() {
    const held = tool();
    const starts: [number, number][] = [];
    const nexts: [number, number][] = [];
    const [x0, y0, x1, y1] = viewBox();
    if (world && held !== null) {
      if (current) for (const [i, [dx, dy]] of STEPS.entries()) if (allowed(current, i)) nexts.push([current.x + dx, current.y + dy]);
      drawnOver = [x0, y0, x1, y1].join();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mayStart(world, held, { x, y })) starts.push([x, y]);
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  /** What stands at a tile, as the tool that lays it. */
  const toolAt = (at: GridCoord): Tool | null => {
    const k = `${at.x},${at.y}`;
    const b = world?.occupied.get(k);
    if (b) return { Building: b.kind };
    const n = world?.roads.get(k)?.node;
    if (!n) return null;
    if (n.road) return "Road";
    const oneWay = n.outgoing.some((o) => !n.incoming.includes(o)) || n.incoming.some((i) => !n.outgoing.includes(i));
    return oneWay ? "OneWay" : "Street";
  };
  // The eyedropper: with the bare hand, Alt on a thing picks up what laid
  // it, before the camera or the picker see the press, so the same drag
  // carries it on.
  const onEyedrop = (e: PointerEvent) => {
    if (e.button !== 0 || !e.altKey || tool() !== null) return;
    const w = pick(e);
    const t = toolAt({ x: Math.floor(w.wx), y: Math.floor(w.wy) });
    if (t) setTool(t);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || tool() === null) return;
    const w = pick(e);
    current = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    prevWorld = w;
    accDx = 0;
    accDy = 0;
    // A tap paints or clears its tile at once, but the demolisher's waits
    // for the hand to come up where it went down: a drag cuts only what
    // it crosses, not the point it starts from.
    pressed = current;
    if (!isRoad(tool()) && tool() !== "Demolish") step(current, current);
    dots.grab(current, { x: w.wx, y: w.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;

    // Need enough accumulated movement to determine direction
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;

    const sector = snap(accDx, accDy);
    const [sx, sy] = STEPS[sector];
    let cur = current!;

    for (let i = 0; i < 50; i++) {
      const cx = cur.x + 0.5;
      const cy = cur.y + 0.5;
      const dist = Math.max(Math.abs(w.wx - cx), Math.abs(w.wy - cy));
      if (dist < 0.6) break;

      const next: GridCoord = { x: cur.x + sx, y: cur.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (newDist >= dist) break; // would move away from pointer
      if (!allowed(cur, sector)) break; // refused: wait here

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
    if (pressed && current === pressed && tool() === "Demolish") step(pressed, pressed);
    pressed = null;
    if (current) dots.release();
    current = null;
    prevWorld = null;
    draw();
  };

  canvas.addEventListener("pointerdown", onEyedrop, { capture: true });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onEyedrop, { capture: true });
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    stopWatch();
    stopTick();
  });

  return dots.el;
}
