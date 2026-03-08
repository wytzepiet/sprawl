import { onCleanup, createEffect } from "solid-js";
import {
  Mesh as BabylonMesh,
  VertexData,
  StandardMaterial,
  Color3,
} from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";

/** Deferred effect — tracks a reactive expression, only runs the apply fn on changes (skips initial). */
function createDeferredEffect<T>(track: () => T, apply: (value: T) => void) {
  createEffect(track, apply, undefined, { defer: true });
}

export interface MeshGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
}

interface MeshProps {
  name: string;
  geometry: MeshGeometry;
  position?: [number, number, number];
  color: Color3;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export default function Mesh(props: MeshProps) {
  const { scene } = useEngine();
  const { shadowGenerator } = useDayNight();

  const mesh = new BabylonMesh(props.name, scene);
  const material = new StandardMaterial(`${props.name}_mat`, scene);
  material.specularColor = Color3.Black();
  mesh.material = material;

  // Apply initial state synchronously — one VertexData call, not three separate ones
  const vd = new VertexData();
  vd.positions = props.geometry.positions;
  vd.indices = props.geometry.indices;
  vd.normals = props.geometry.normals;
  vd.applyToMesh(mesh, true);

  if (props.position) {
    mesh.position.x = props.position[0];
    mesh.position.y = props.position[1];
    mesh.position.z = props.position[2];
  }

  material.diffuseColor = props.color;

  if (props.castShadow) {
    shadowGenerator.addShadowCaster(mesh);
  }
  if (props.receiveShadow) {
    mesh.receiveShadows = true;
  }

  // Reactive updates for subsequent changes only
  createDeferredEffect(
    () => props.geometry.positions,
    (v) => {
      mesh.setVerticesData("position", v, true);
    },
  );
  createDeferredEffect(
    () => props.geometry.indices,
    (v) => {
      mesh.setIndices(v);
    },
  );
  createDeferredEffect(
    () => props.geometry.normals,
    (v) => {
      mesh.setVerticesData("normal", v, true);
    },
  );
  createDeferredEffect(
    () => props.position?.[0],
    (x) => {
      if (x != null) mesh.position.x = x;
    },
  );
  createDeferredEffect(
    () => props.position?.[1],
    (y) => {
      if (y != null) mesh.position.y = y;
    },
  );
  createDeferredEffect(
    () => props.position?.[2],
    (z) => {
      if (z != null) mesh.position.z = z;
    },
  );
  createDeferredEffect(
    () => props.color,
    (color) => {
      material.diffuseColor = color;
    },
  );

  onCleanup(() => {
    if (props.castShadow) {
      shadowGenerator.removeShadowCaster(mesh);
    }
    mesh.dispose();
    material.dispose();
  });

  return <></>;
}
