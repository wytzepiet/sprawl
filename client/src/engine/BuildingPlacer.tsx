import { createSignal, onCleanup, Show } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { buildingCubeGeometry, BUILDING_HEIGHT } from "./objects/buildings";
import { createSpring2D } from "./spring";
import type { GridCoord } from "../generated";

const cube = buildingCubeGeometry();

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);

export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [ghostPos, setGhostPos] = createSignal<GridCoord | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });

  function screenToGrid(e: PointerEvent): GridCoord {
    const rect = canvas.getBoundingClientRect();
    const cam = scene.activeCamera!;
    const nx = -((e.clientX - rect.left) / rect.width * 2 - 1);
    const ny = 1 - (e.clientY - rect.top) / rect.height * 2;
    const wx = cam.position.x + nx * (cam.orthoRight! - cam.orthoLeft!) / 2;
    const wy = cam.position.y + ny * (cam.orthoTop! - cam.orthoBottom!) / 2;
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  function canPlace(pos: GridCoord): boolean {
    for (const entry of getObjectsAt(pos.x, pos.y)) {
      if (entry.object.kind === "Building") return false;
      if (entry.object.kind === "RoadNode") {
        const { neighbors, incoming } = entry.object.data;
        const unique = new Set([...neighbors, ...incoming]);
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
      send({ type: "PlaceBuilding", data: { pos, building_type: buildingId } });
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
    <Show when={placingBuilding() && ghostPos()}>
      {(pos) => (
        <Mesh
          name="building_ghost"
          geometry={cube}
          position={[spring.pos()[0], spring.pos()[1], 0]}
          color={GHOST_COLOR}
        />
      )}
    </Show>
  );
}
