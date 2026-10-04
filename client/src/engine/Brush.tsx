import { createEffect, createMemo, on, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { screenToWorld, viewExtent } from "./view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { tree, unlocked } from "../state/tree";
import { isRoad, tool } from "../ui/buildMode";
import { affords, hand, may, mayStart, STEPS, type Hand } from "./may";
import type { MeshGeometry } from "./Mesh";
import type { GridCoord, TerrainType } from "../generated";

/** Snap an angle to one of 8 directions, returning the sector index (`STEPS`). */
function snapDirection(dx: number, dy: number): number {
  const angle = Math.atan2(dy, dx);
  return ((Math.round(angle * 4 / Math.PI) % 8) + 8) % 8;
}

/** Just over the roads and the lawns, under anything standing. */
const DOT_Z = 0.08;

/** A flat disc, `r` across from its middle. */
function disc(r: number): MeshGeometry {
  const g: MeshGeometry = { positions: [0, 0, 0], normals: [0, 0, 1], indices: [] };
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
    g.normals.push(0, 0, 1);
    g.indices.push(0, 1 + ((i + 1) % n), 1 + i);
  }
  return g;
}

/**
 * The mayor's hand on the map: whatever is held is laid as the drag goes,
 * a step from one tile to the next, each sent as it is taken
 * (`Build { tool, from, to }`), straight or diagonal toward the pointer.
 * A tap, or the first tile of a drag, paints or clears that tile alone;
 * a road needs two.
 *
 * And where it may go, worked out here (`may.ts`): a dot on every tile in
 * view a drag may start from while nothing is pressed, and while dragging
 * the steps the tile it is on allows, lit. A step refused is not taken:
 * the drag waits there.
 */
export function Brush(props: { ground: (x: number, y: number) => TerrainType | undefined }) {
  const { scene, canvas } = useEngine();
  const pool = useInstancePool();
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

  // The dots: a small one on every start, a bigger one on every step the
  // tile being dragged from allows.
  const dots: { key: string; id: number }[] = [];
  function draw() {
    for (const { key, id } of dots.splice(0)) pool.removeInstance(key, id);
    const held = tool();
    if (!world || held === null) return;
    world.growth = growth();
    if (current) {
      pool.ensureBucket("may_next", disc(0.14), Color3.White(), false, false);
      for (const [i, [dx, dy]] of STEPS.entries()) {
        if (!allowed(current, i)) continue;
        dots.push({ key: "may_next", id: pool.addInstance("may_next", [current.x + dx + 0.5, current.y + dy + 0.5, DOT_Z]) });
      }
      return;
    }
    pool.ensureBucket("may_start", disc(0.07), new Color3(0.25, 0.27, 0.32), false, false);
    const box = viewBox();
    drawnOver = box.join();
    const [x0, y0, x1, y1] = box;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (mayStart(world, held, { x, y })) dots.push({ key: "may_start", id: pool.addInstance("may_start", [x + 0.5, y + 0.5, DOT_Z]) });
      }
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || tool() === null) return;
    const w = pick(e);
    current = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    prevWorld = w;
    accDx = 0;
    accDy = 0;
    if (!isRoad(tool())) step(current, current);
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) return;
    const w = pick(e);
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;

    // Need enough accumulated movement to determine direction
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;

    const sector = snapDirection(accDx, accDy);
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
    for (const { key, id } of dots.splice(0)) pool.removeInstance(key, id);
  });

  return <></>;
}
