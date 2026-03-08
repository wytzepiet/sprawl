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
import { boxGeometry } from "./buildings";

interface BuildingPreviewProps {
  color: Color3;
}

export default function BuildingPreview(props: BuildingPreviewProps) {
  const { scene } = useEngine();

  const cam = new FreeCamera("preview_cam", new Vector3(1.2, -1.2, 1.2), scene);
  cam.setTarget(Vector3.Zero());
  cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
  const s = 0.55;
  cam.orthoLeft = -s;
  cam.orthoRight = s;
  cam.orthoTop = s;
  cam.orthoBottom = -s;

  const light = new HemisphericLight("preview_light", new Vector3(0.5, 1, 0.8), scene);
  light.intensity = 1;

  const mesh = new Mesh("preview_building", scene);
  const geo = boxGeometry(0.6, 0.6, 0.6);
  const vd = new VertexData();
  vd.positions = geo.positions;
  vd.indices = geo.indices;
  vd.normals = geo.normals;
  vd.applyToMesh(mesh);

  const mat = new StandardMaterial("preview_mat", scene);
  mat.diffuseColor = props.color;
  mat.specularColor = new Color3(0.1, 0.1, 0.1);
  mesh.material = mat;

  onCleanup(() => {
    mesh.dispose();
    mat.dispose();
    light.dispose();
    cam.dispose();
  });

  return <></>;
}
