import { onCleanup, createEffect, untrack } from "solid-js";
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

function tint(color: Color3, amb: Color3): Color3 {
  return new Color3(color.r * amb.r, color.g * amb.g, color.b * amb.b);
}

export default function Mesh(props: MeshProps) {
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();

  const mesh = new BabylonMesh(props.name, scene);
  const material = new StandardMaterial(`${props.name}_mat`, scene);
  material.backFaceCulling = false;
  material.specularColor = Color3.Black();

  if (props.receiveShadow) {
    // Lit material: uses diffuse so shadows from the light pipeline are visible.
    // Emissive adds a baseline so the mesh is never fully dark.
    material.diffuseColor = props.color;
    material.emissiveColor = tint(props.color, new Color3(0.15, 0.15, 0.15));
    mesh.receiveShadows = true;
  } else {
    // Unlit material: emissive with ambient tinting (reliable, no lighting issues)
    material.disableLighting = true;
    material.emissiveColor = tint(props.color, untrack(ambientColor));
  }

  mesh.material = material;

  // Apply initial state synchronously
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
    () => [props.color, ambientColor()] as const,
    ([color, amb]) => {
      if (props.receiveShadow) {
        material.diffuseColor = color;
      } else {
        material.emissiveColor = tint(color, amb);
      }
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
