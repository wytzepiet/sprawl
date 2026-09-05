import { createSignal, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor } from "./objects/buildings";
import { BLUEPRINTS } from "../blueprints";
import { screenToWorld } from "./view";
import { createSpring2D } from "./spring";
import type { GridCoord } from "../generated";

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);

export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [ghostPos, setGhostPos] = createSignal<GridCoord | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });

  const size = () => BLUEPRINTS[placingBuilding() ?? "House"].size;

  /**
   * Every tile of the footprint free, or holding only a driveway stub, and
   * a street beside it to take the driveway from — a road takes no frontage,
   * and neither does another building's driveway. The server has the last
   * word; this is so the ghost only shows where it would say yes.
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
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        if (dx >= 0 && dx < w && dy >= 0 && dy < h) continue;
        const here = getObjectsAt(pos.x + dx, pos.y + dy);
        const street = here.some((e) => e.object.kind === "RoadNode" && !e.object.data.road);
        const driveway = here.some((e) => e.object.kind === "Building");
        if (street && !driveway) return true;
      }
    }
    return false;
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
      geometry={shapeFor(placingBuilding() ?? "House", size()[0], size()[1])}
      position={[spring.pos()[0], spring.pos()[1], 0]}
      color={GHOST_COLOR}
      enabled={!!(placingBuilding() && ghostPos())}
    />
  );
}
