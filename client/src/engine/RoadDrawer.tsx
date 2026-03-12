import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { useGame } from "../state/gameObjects";
import { buildMode, roadOneWay } from "../ui/buildMode";
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

export function RoadDrawer() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();
  let current: GridCoord | null = null;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;

  function pickWorld(e: PointerEvent): { wx: number; wy: number } {
    const rect = canvas.getBoundingClientRect();
    const cam = scene.activeCamera!;
    const nx = -(((e.clientX - rect.left) / rect.width) * 2 - 1);
    const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const wx = cam.position.x + (nx * (cam.orthoRight! - cam.orthoLeft!)) / 2;
    const wy = cam.position.y + (ny * (cam.orthoTop! - cam.orthoBottom!)) / 2;
    return { wx, wy };
  }

  function demolishAt(pos: GridCoord) {
    send({ type: "DemolishRoad", data: { pos } });
  }

  const onPointerDown = (e: PointerEvent) => {
    const mode = buildMode();
    if (mode !== "road" && mode !== "demolish") return;
    const w = pickWorld(e);
    current = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
    prevWorld = w;
    accDx = 0;
    accDy = 0;

    if (mode === "demolish") {
      demolishAt(current);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) return;
    const mode = buildMode();
    const w = pickWorld(e);

    if (mode === "demolish") {
      const cell = { x: Math.floor(w.wx), y: Math.floor(w.wy) };
      if (cell.x !== current.x || cell.y !== current.y) {
        current = cell;
        demolishAt(current);
      }
      prevWorld = w;
      return;
    }

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

      send({ type: "PlaceRoad", data: { from: cur, to: next, one_way: roadOneWay() } });
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
