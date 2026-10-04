import { createEffect, createMemo, on, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import { Dots } from "./dots";
import { screenToWorld, viewExtent } from "./view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { tree, unlocked } from "../state/tree";
import { isRoad, tool } from "../ui/buildMode";
import { affords, hand, may, mayStart, snap, STEPS, type Hand } from "./may";
import { useTheme } from "./theme";
import type { GridCoord, TerrainType } from "../generated";

/** The dots' ink in the dark. */
const NIGHT_INK = new Color3(0.9, 0.92, 0.95);

/**
 * The mayor's hand on the map: whatever is held is laid as the drag goes,
 * a step from one tile to the next, each sent as it is taken
 * (`Build { tool, from, to }`), straight or diagonal toward the pointer.
 * A tap, or the first tile of a drag, paints or clears that tile alone;
 * a road needs two.
 *
 * And where it may go, worked out here (`may.ts`) and shown by the dots
 * (`dots.ts`): one on every tile in view a drag may start from while
 * nothing is pressed, and while dragging the steps the tile it is on
 * allows. A step refused is not taken: the drag waits there, straining.
 */
export function Brush(props: { ground: (x: number, y: number) => TerrainType | undefined }) {
  const { scene, canvas } = useEngine();
  const theme = useTheme();
  // The dots lie over the scene, not in its light: their ink pales as the
  // ground darkens, from the theme's by day to the night's by dusk.
  const { ambientColor } = useDayNight();
  const ink = () => Color3.Lerp(theme().hand, NIGHT_INK, Math.min(1, Math.max(0, (0.7 - ambientColor().g) / 0.25)));
  const dots = new Dots(scene, canvas, ink);
  const tick = scene.onAfterRenderObservable.add(() => dots.frame());
  const { send, growth } = useGame();
  let current: GridCoord | null = null;
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
    world = hand(eachEntity, props.ground, growth(), (want) => unlocked(tree(), growth().taken, want));
    draw();
  }));
  // And drawn again when what the build allows changes: what is taken,
  // road left to lay, a tile of the held kind come within the purse.
  const gate = createMemo(() => {
    const [g, held] = [growth(), tool()];
    const purse = held !== null && typeof held !== "string" && affords(g, held.Building);
    return `${g.road_tiles_left},${g.taken.length},${tree() ? 1 : 0},${purse}`;
  });
  createEffect(on([gate, tool], () => draw(), { defer: true }));
  const allowed = (at: GridCoord, i: number) => {
    const held = tool();
    return !!world && held !== null && may(world, held, at, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] });
  };

  /** The tiles the view covers. */
  const viewBox = () => {
    const rect = canvas.getBoundingClientRect();
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  // Drawn again when the view moves on a tile.
  let drawnOver = "";
  let frames = 0;
  const watch = scene.onAfterRenderObservable.add(() => {
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
      world.growth = growth();
      if (current) {
        for (const [i, [dx, dy]] of STEPS.entries()) if (allowed(current, i)) nexts.push([current.x + dx, current.y + dy]);
      } else {
        drawnOver = [x0, y0, x1, y1].join();
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mayStart(world, held, { x, y })) starts.push([x, y]);
      }
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || tool() === null) return;
    const w = pick(e);
    current = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    prevWorld = w;
    accDx = 0;
    accDy = 0;
    if (!isRoad(tool())) step(current, current);
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
    if (current) dots.release();
    current = null;
    prevWorld = null;
    draw();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    scene.onAfterRenderObservable.remove(watch);
    scene.onAfterRenderObservable.remove(tick);
  });

  return dots.el;
}
