import { createEffect, on, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { screenToWorld, viewExtent } from "./view";
import { builtVersion, useGame } from "../state/gameObjects";
import { isRoad, tool } from "../ui/buildMode";
import type { MeshGeometry } from "./Mesh";
import type { GridCoord, Tool } from "../generated";

// 8-directional step offsets, indexed by sector (0 = right, going counter-clockwise)
// — the server's order too (`STEPS` in `game_loop`), as the map numbers them.
const STEP_DIRS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Snap an angle to one of 8 directions, returning the sector index. */
function snapDirection(dx: number, dy: number): number {
  const angle = Math.atan2(dy, dx);
  return ((Math.round(angle * 4 / Math.PI) % 8) + 8) % 8;
}

/** Where the hand may go with what it holds, over a box of tiles, a number
 *  a tile (`/may`): bit i a step to the i-th neighbour, bit 8 a start. */
interface May {
  x0: number;
  y0: number;
  w: number;
  cells: number[];
}
const START = 1 << 8;
/** Ground round the view the map is asked for, so a pan does not ask again
 *  at once. */
const AHEAD = 8;
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
 * And where it may go, asked of the server for the view (`/may`): a dot on
 * every tile a drag may start from while nothing is pressed, and while
 * dragging the steps the tile it is on allows, lit. A step the map
 * refuses is not taken: the drag waits there.
 */
export function Brush() {
  const { scene, canvas } = useEngine();
  const pool = useInstancePool();
  const { send } = useGame();
  let current: GridCoord | null = null;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const step = (from: GridCoord, to: GridCoord) => {
    const held = tool();
    if (held !== null) send({ type: "Build", data: { tool: held, from, to } });
  };

  // The map, the box it covers, and which ask is the latest.
  let map: May | null = null;
  let asked = 0;
  const cell = (x: number, y: number) => {
    if (!map) return null;
    const [c, r] = [x - map.x0, y - map.y0];
    return c >= 0 && c < map.w && r >= 0 && c + r * map.w < map.cells.length ? map.cells[c + r * map.w] : 0;
  };
  /** May the hand step from here to the neighbour this way? Yes, until
   *  the map has come. */
  const allowed = (at: GridCoord, i: number) => {
    const bits = cell(at.x, at.y);
    return bits === null || (bits & (1 << i)) !== 0;
  };

  /** The tiles the view covers, and the ground round it. */
  const viewBox = () => {
    const rect = canvas.getBoundingClientRect();
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  const name = (held: Tool) => (typeof held === "string" ? held : held.Building);
  async function ask() {
    const held = tool();
    const n = ++asked;
    if (held === null) {
      map = null;
      draw();
      return;
    }
    const [x0, y0, x1, y1] = viewBox();
    const r = await fetch(`/may?tool=${name(held)}&x0=${x0 - AHEAD}&y0=${y0 - AHEAD}&x1=${x1 + AHEAD}&y1=${y1 + AHEAD}`).catch(() => null);
    const answer = r?.ok ? ((await r.json()) as May) : null;
    if (n !== asked || !answer?.cells) return;
    map = answer;
    draw();
  }
  createEffect(on([tool, builtVersion], () => void ask()));
  // Asked again when the view leaves what was asked for.
  let frames = 0;
  const watch = scene.onAfterRenderObservable.add(() => {
    if (!map || ++frames % 15) return;
    const [x0, y0, x1, y1] = viewBox();
    const h = map.cells.length / map.w;
    if (x0 < map.x0 || y0 < map.y0 || x1 >= map.x0 + map.w || y1 >= map.y0 + h) void ask();
  });

  // The dots: a small one on every start, a bigger one on every step the
  // tile being dragged from allows.
  const dots: { key: string; id: number }[] = [];
  function draw() {
    for (const { key, id } of dots.splice(0)) pool.removeInstance(key, id);
    if (!map || tool() === null) return;
    if (current) {
      pool.ensureBucket("may_next", disc(0.14), Color3.White(), false, false);
      for (const [i, [dx, dy]] of STEP_DIRS.entries()) {
        if (!allowed(current, i)) continue;
        dots.push({ key: "may_next", id: pool.addInstance("may_next", [current.x + dx + 0.5, current.y + dy + 0.5, DOT_Z]) });
      }
      return;
    }
    pool.ensureBucket("may_start", disc(0.07), new Color3(0.25, 0.27, 0.32), false, false);
    const h = map.cells.length / map.w;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < map.w; c++) {
        if (map.cells[c + r * map.w] & START) dots.push({ key: "may_start", id: pool.addInstance("may_start", [map.x0 + c + 0.5, map.y0 + r + 0.5, DOT_Z]) });
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
    const [sx, sy] = STEP_DIRS[sector];
    let cur = current!;

    for (let i = 0; i < 50; i++) {
      const cx = cur.x + 0.5;
      const cy = cur.y + 0.5;
      const dist = Math.max(Math.abs(w.wx - cx), Math.abs(w.wy - cy));
      if (dist < 0.6) break;

      const next: GridCoord = { x: cur.x + sx, y: cur.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (newDist >= dist) break; // would move away from pointer
      if (!allowed(cur, sector)) break; // the map says no: wait here

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
