import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { buildingCubeGeometry, BUILDING_COLOR, PLOT_MARGIN, BUILDING_SIZE } from "./buildings";
import type { Look } from "./draftLook";
import type { Building, GameObjectEntry } from "../../generated";

const cube = buildingCubeGeometry();

export function mountBuilding(
  entry: GameObjectEntry,
  pool: InstancePool,
  look: Look,
): () => void {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const color = look.tint(Color3.FromHexString(BUILDING_COLOR));
  const poolKey = `building_${data.kind}${look.key}`;
  const [w, h] = data.size;

  // The cube is one tile inset by PLOT_MARGIN, so a wider plot stretches it to
  // its own extent less the same margin — the tint border stays one width
  // instead of growing with the building.
  const span = (n: number) => (n - 2 * PLOT_MARGIN) / BUILDING_SIZE;

  pool.ensureBucket(poolKey, cube, color, look.castShadow, false, undefined, look.alpha);
  const id = pool.addInstance(
    poolKey,
    pos ? [pos.x + w / 2, pos.y + h / 2, 0] : undefined,
    undefined,
    [span(w), span(h), 1],
  );

  return () => pool.removeInstance(poolKey, id);
}
