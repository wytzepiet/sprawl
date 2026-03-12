import { Color3 } from "@babylonjs/core";
import InstancedMesh from "../InstancePool";
import type { KindEntry } from "../GameObject";
import { useTheme } from "../theme";
import type { TerrainType } from "../../generated";
import type { MeshGeometry } from "../Mesh";

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
};

export function terrainColor(type: TerrainType, theme: ReturnType<typeof useTheme>): Color3 {
  switch (type) {
    case "Water": return theme.water;
    case "Grass": return new Color3(theme.land.r, theme.land.g, theme.land.b);
    case "Forest": return theme.forest;
    case "Mountain": return theme.mountain;
  }
}

export default function TerrainTile(props: { entry: KindEntry<"Terrain"> }) {
  const theme = useTheme();
  const pos = props.entry.position!;
  const type = props.entry.object.data.terrain_type;

  return (
    <InstancedMesh
      poolKey={`terrain_${type}`}
      geometry={FULL_SQUARE}
      position={[pos.x, pos.y, 0]}
      color={terrainColor(type, theme)}
      receiveShadow
    />
  );
}
