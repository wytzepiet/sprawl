import { onCleanup, createEffect, on, untrack } from "solid-js";
import {
  Mesh as BabylonMesh,
  VertexData,
  Color3,
  StandardMaterial,
} from "@babylonjs/core";
import { townMaterial } from "./material";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";

/** Deferred effect — tracks a reactive expression, only runs the apply fn on changes (skips initial). */
function createDeferredEffect<T>(track: () => T, apply: (value: T) => void) {
  createEffect(on(track, apply, { defer: true }));
}

export interface MeshGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  uvs?: number[];
}

interface MeshProps {
  name: string;
  geometry: MeshGeometry;
  position?: [number, number, number];
  rotation?: [number, number, number];
  color: Color3;
  castShadow?: boolean;
  receiveShadow?: boolean;
  enabled?: boolean;
  meshRef?: (mesh: BabylonMesh) => void;
}

function tint(color: Color3, amb: Color3): Color3 {
  return new Color3(color.r * amb.r, color.g * amb.g, color.b * amb.b);
}

export default function Mesh(props: MeshProps) {
  const { scene } = useEngine();
  const dayNight = useDayNight();
  const ambientColor = dayNight.ambientColor;
  const shadowGenerator = dayNight.shadowGenerator()!;

  const mesh = new BabylonMesh(props.name, scene);
  // Lit, it is the town's material; unlit, a flat colour tinted by the hour.
  const material = props.receiveShadow ? townMaterial(`${props.name}_mat`, scene) : new StandardMaterial(`${props.name}_mat`, scene);
  if (material instanceof StandardMaterial) {
    material.disableLighting = true;
    material.emissiveColor = tint(props.color, untrack(ambientColor));
  } else {
    material.albedoColor = props.color;
    mesh.receiveShadows = true;
  }

  mesh.material = material;

  // Apply initial state synchronously
  const applyGeometry = (g: MeshGeometry) => {
    const vd = new VertexData();
    vd.positions = g.positions;
    vd.indices = g.indices;
    vd.normals = g.normals;
    vd.applyToMesh(mesh, true);
  };
  applyGeometry(props.geometry);
  // A mesh can be asked to become a different shape — the placement ghost turns
  // into whatever kind is being placed.
  createDeferredEffect(() => props.geometry, applyGeometry);

  if (props.position) {
    mesh.position.x = props.position[0];
    mesh.position.y = props.position[1];
    mesh.position.z = props.position[2];
  }

  if (props.rotation) {
    mesh.rotation.x = props.rotation[0];
    mesh.rotation.y = props.rotation[1];
    mesh.rotation.z = props.rotation[2];
  }

  mesh.setEnabled(props.enabled ?? true);

  if (props.meshRef) {
    props.meshRef(mesh);
  }

  if (props.castShadow) {
    shadowGenerator.addShadowCaster(mesh);
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
    () => props.rotation?.[0],
    (x) => {
      if (x != null) mesh.rotation.x = x;
    },
  );
  createDeferredEffect(
    () => props.rotation?.[1],
    (y) => {
      if (y != null) mesh.rotation.y = y;
    },
  );
  createDeferredEffect(
    () => props.rotation?.[2],
    (z) => {
      if (z != null) mesh.rotation.z = z;
    },
  );
  createDeferredEffect(
    () => [props.color, ambientColor()] as const,
    ([color, amb]) => {
      if (material instanceof StandardMaterial) material.emissiveColor = tint(color, amb);
      else material.albedoColor = color;
    },
  );
  createDeferredEffect(
    () => props.enabled,
    (enabled) => mesh.setEnabled(enabled ?? true),
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
