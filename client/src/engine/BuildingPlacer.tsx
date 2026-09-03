import { createSignal, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor } from "./objects/buildings";
import { screenToWorld } from "./view";
import { createSpring2D } from "./spring";
import type { GridCoord } from "../generated";

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);

export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [ghostPos, setGhostPos] = createSignal<GridCoord | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });

  function screenToGrid(e: PointerEvent): GridCoord {
    const { wx, wy } = screenToWorld(scene, canvas, e);
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  function canPlace(pos: GridCoord): boolean {
    for (const entry of getObjectsAt(pos.x, pos.y)) {
      if (entry.object.kind === "Building") return false;
      if (entry.object.kind === "RoadNode") {
        const { outgoing, incoming } = entry.object.data;
        const unique = new Set([...outgoing, ...incoming]);
        if (unique.size !== 1) return false;
      }
    }
    return true;
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!placingBuilding()) return;
    const cell = screenToGrid(e);
    if (!canPlace(cell)) return;
    if (!ghostPos()) {
      spring.snap(cell.x + 0.5, cell.y + 0.5);
    } else {
      spring.setTarget(cell.x + 0.5, cell.y + 0.5);
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
      geometry={shapeFor(placingBuilding() ?? "House", 1, 1)}
      position={[spring.pos()[0], spring.pos()[1], 0]}
      color={GHOST_COLOR}
      enabled={!!(placingBuilding() && ghostPos())}
    />
  );
}
