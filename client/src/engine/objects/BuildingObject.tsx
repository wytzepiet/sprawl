import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { buildingCubeGeometry, BUILDINGS } from "./buildings";
import type { BuildingType, GameObjectEntry } from "../../generated";

const cube = buildingCubeGeometry();

function getBuildingColor(buildingType: BuildingType): Color3 {
  const def = BUILDINGS.find((b) => b.id === buildingType);
  return def ? Color3.FromHexString(def.color) : new Color3(0.5, 0.5, 0.5);
}

export function mountBuilding(entry: GameObjectEntry, pool: InstancePool): () => void {
  const data = entry.object.data as { building_type: BuildingType };
  const pos = entry.position;
  const color = getBuildingColor(data.building_type);
  const poolKey = `building_${data.building_type}`;

  pool.ensureBucket(poolKey, cube, color, true, false);
  const id = pool.addInstance(poolKey,
    pos ? [pos.x + 0.5, pos.y + 0.5, 0] : undefined,
  );

  return () => pool.removeInstance(poolKey, id);
}
