import { Color3 } from "@babylonjs/core";
import Mesh from "../Mesh";
import { buildingCubeGeometry, BUILDING_HEIGHT, BUILDINGS } from "./buildings";
import type { GameObjectEntry } from "../../generated";

const cube = buildingCubeGeometry();

function getBuildingColor(buildingType: string): Color3 {
  const def = BUILDINGS.find((b) => b.id === buildingType);
  return def ? Color3.FromHexString(def.color) : new Color3(0.5, 0.5, 0.5);
}

export default function BuildingObject(props: { entry: GameObjectEntry }) {
  const pos = (): [number, number, number] | undefined =>
    props.entry.position
      ? [props.entry.position.x + 0.5, props.entry.position.y + 0.5, BUILDING_HEIGHT / 2]
      : undefined;

  const color = () => {
    if (props.entry.object.kind !== "Building") return new Color3(0.5, 0.5, 0.5);
    return getBuildingColor(props.entry.object.data.building_type);
  };

  return (
    <Mesh
      name={`building_${props.entry.id}`}
      geometry={cube}
      position={pos()}
      color={color()}
      castShadow
    />
  );
}
