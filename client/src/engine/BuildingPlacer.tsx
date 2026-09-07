import { createSignal, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor } from "./objects/buildings";
import { plot } from "../blueprints";
import { screenToWorld } from "./view";
import { createSpring2D } from "./spring";
import type { GridCoord } from "../generated";

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);

export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [ghostPos, setGhostPos] = createSignal<GridCoord | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });

  const size = () => plot(placingBuilding() ?? "House", 2).size;

  /**
   * Every tile of the footprint free, or holding only a driveway stub. A
   * street beside it is not required: a plot with none stands red until
   * the mayor draws one to it.
   */
  function canPlace(pos: GridCoord): boolean {
    const [w, h] = size();
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        for (const entry of getObjectsAt(pos.x + dx, pos.y + dy)) {
          if (entry.object.kind === "Building") return false;
          if (entry.object.kind === "RoadNode") {
            const { outgoing, incoming } = entry.object.data;
            const unique = new Set([...outgoing, ...incoming]);
            if (unique.size !== 1) return false;
          }
        }
      }
    }
    return true;
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!placingBuilding()) return;
    // The pointer holds the middle of the footprint; the cell is its corner.
    const [w, h] = size();
    const { wx, wy } = screenToWorld(scene, canvas, e);
    const cell = { x: Math.floor(wx - w / 2 + 0.5), y: Math.floor(wy - h / 2 + 0.5) };
    if (!canPlace(cell)) return;
    if (!ghostPos()) {
      spring.snap(cell.x + w / 2, cell.y + h / 2);
    } else {
      spring.setTarget(cell.x + w / 2, cell.y + h / 2);
    }
    setGhostPos(cell);
  };

  const onPointerUp = () => {
    const buildingId = placingBuilding();
    if (!buildingId) return;
    const pos = ghostPos();
    if (pos) {
      send({ type: "PlaceBuilding", data: { pos, kind: buildingId } });
    }
    setPlacingBuilding(null);
    setGhostPos(null);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  });

  return (
    <Mesh
      name="building_ghost"
      geometry={shapeFor(placingBuilding() ?? "House", ...plot(placingBuilding() ?? "House", 2).building[1])}
      position={[spring.pos()[0], spring.pos()[1] - (size()[1] - plot(placingBuilding() ?? "House", 2).building[1][1]) / 2, 0]}
      color={GHOST_COLOR}
      enabled={!!(placingBuilding() && ghostPos())}
    />
  );
}
