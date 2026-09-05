import { onCleanup } from "solid-js";
import {
  FreeCamera,
  Vector3,
  Camera,
  Mesh,
  VertexData,
  StandardMaterial,
  Color3,
  HemisphericLight,
} from "@babylonjs/core";
import { useEngine } from "../Canvas";
import { shapeFor, BUILDING_COLOR } from "./buildings";
import type { BuildingKind } from "../../generated";

/**
 * A kind of building as it stands on the map: the same solid the map builds
 * for it, seen from a little south of straight above, the way the map is.
 */
export default function BuildingPreview(props: { kind: BuildingKind }) {
  const { scene } = useEngine();

  const cam = new FreeCamera("preview_cam", new Vector3(0, -1.2, 2.8), scene);
  cam.upVector = new Vector3(0, 0, 1);
  cam.setTarget(new Vector3(0, 0, 0.15));
  cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
  const s = 0.62;
  cam.orthoLeft = -s;
  cam.orthoRight = s;
  cam.orthoTop = s;
  cam.orthoBottom = -s;

  // Lit from above with plenty of fill, the way the map's soft shadows read:
  // a side is a shade darker than the roof, not a different colour.
  const light = new HemisphericLight("preview_light", new Vector3(-0.3, -0.5, 1), scene);
  light.intensity = 1.0;
  light.groundColor = new Color3(0.72, 0.72, 0.72);

  const mesh = new Mesh("preview_building", scene);
  const geo = shapeFor(props.kind, 1, 1, 0);
  const vd = new VertexData();
  vd.positions = geo.positions;
  vd.indices = geo.indices;
  vd.normals = geo.normals;
  vd.applyToMesh(mesh);

  const mat = new StandardMaterial("preview_mat", scene);
  mat.diffuseColor = Color3.FromHexString(BUILDING_COLOR);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  mesh.material = mat;

  onCleanup(() => {
    mesh.dispose();
    mat.dispose();
    light.dispose();
    cam.dispose();
  });

  return <></>;
}
