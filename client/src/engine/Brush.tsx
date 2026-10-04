import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { screenToWorld } from "./view";
import { useGame } from "../state/gameObjects";
import { isRoad, tool } from "../ui/buildMode";
import type { GridCoord } from "../generated";

// 8-directional step offsets, indexed by sector (0 = right, going counter-clockwise)
const STEP_DIRS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Snap an angle to one of 8 directions, returning the sector index. */
function snapDirection(dx: number, dy: number): number {
  const angle = Math.atan2(dy, dx);
  return ((Math.round(angle * 4 / Math.PI) % 8) + 8) % 8;
}

/**
 * The mayor's hand on the map: whatever is held is laid as the drag goes,
 * a step from one tile to the next, each sent as it is taken
 * (`Build { tool, from, to }`), straight or diagonal toward the pointer.
 * A tap, or the first tile of a drag, paints or clears that tile alone;
 * a road needs two.
 */
export function Brush() {
  const { scene, canvas } = useEngine();
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

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || tool() === null) return;
    const w = pick(e);
    current = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    prevWorld = w;
    accDx = 0;
    accDy = 0;
    if (!isRoad(tool())) step(current, current);
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

      step(cur, next);
      cur = next;
    }
    current = cur;

    accDx = 0;
    accDy = 0;
  };

  const onPointerUp = () => {
    current = null;
    prevWorld = null;
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
  });

  return <></>;
}
