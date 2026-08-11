import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { buildingCubeGeometry, BUILDING_COLOR } from "./buildings";
import type { BuildingKind, GameObjectEntry } from "../../generated";

const cube = buildingCubeGeometry();

export function mountBuilding(entry: GameObjectEntry, pool: InstancePool): () => void {
  const data = entry.object.data as { kind: BuildingKind };
  const pos = entry.position;
  const color = Color3.FromHexString(BUILDING_COLOR);
  const poolKey = `building_${data.kind}`;

  pool.ensureBucket(poolKey, cube, color, true, false);
  const id = pool.addInstance(poolKey,
    pos ? [pos.x + 0.5, pos.y + 0.5, 0] : undefined,
  );

  return () => pool.removeInstance(poolKey, id);
}
