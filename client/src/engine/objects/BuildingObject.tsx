import { Color3 } from "@babylonjs/core";
import InstancedMesh from "../InstancePool";
import type { KindEntry } from "../GameObject";
import { buildingCubeGeometry, BUILDINGS } from "./buildings";
import type { BuildingType } from "../../generated";

const cube = buildingCubeGeometry();

function getBuildingColor(buildingType: BuildingType): Color3 {
  const def = BUILDINGS.find((b) => b.id === buildingType);
  return def ? Color3.FromHexString(def.color) : new Color3(0.5, 0.5, 0.5);
}

export default function BuildingObject(props: { entry: KindEntry<"Building"> }) {
  const pos = props.entry.position;

  return (
    <InstancedMesh
      poolKey={`building_${props.entry.object.data.building_type}`}
      geometry={cube}
      position={pos ? [pos.x + 0.5, pos.y + 0.5, 0] : undefined}
      color={getBuildingColor(props.entry.object.data.building_type)}
      castShadow
    />
  );
}
