import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
  type ParentProps,
} from "solid-js";
import {
  Mesh,
  VertexData,
  StandardMaterial,
  Color3,
  type InstancedMesh as BabylonInstancedMesh,
} from "@babylonjs/core";
import type { BaseTexture } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import type { MeshGeometry } from "./Mesh";

export interface InstanceHandle {
  setMatrix(pos: [number, number, number], rot: [number, number, number]): void;
}

function tint(color: Color3, amb: Color3): Color3 {
  return new Color3(color.r * amb.r, color.g * amb.g, color.b * amb.b);
}

interface Bucket {
  mesh: Mesh;
  material: StandardMaterial;
  instances: Map<number, BabylonInstancedMesh>;
  free: BabylonInstancedMesh[];
  baseColor: Color3;
  castShadow: boolean;
  receiveShadow: boolean;
}

let nextId = 0;

function applyTransform(
  inst: BabylonInstancedMesh,
  pos?: [number, number, number],
  rot?: [number, number, number],
  scale?: number | [number, number, number],
): void {
  if (pos) {
    inst.position.x = pos[0];
    inst.position.y = pos[1];
    inst.position.z = pos[2];
  }
  if (rot) {
    inst.rotation.x = rot[0];
    inst.rotation.y = rot[1];
    inst.rotation.z = rot[2];
  }
  if (scale != null) {
    if (typeof scale === "number") {
      inst.scaling.x = scale;
      inst.scaling.y = scale;
      inst.scaling.z = scale;
    } else {
      inst.scaling.x = scale[0];
      inst.scaling.y = scale[1];
      inst.scaling.z = scale[2];
    }
  }
}

export class InstancePool {
  private buckets = new Map<string, Bucket>();
  private scene: any;
  private shadowGenerator: any;

  constructor(scene: any, shadowGenerator: any) {
    this.scene = scene;
    this.shadowGenerator = shadowGenerator;
  }

  ensureBucket(
    key: string,
    geometry: MeshGeometry,
    color: Color3,
    castShadow: boolean,
    receiveShadow: boolean,
    texture?: BaseTexture,
  ): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) return bucket;

    const mat = new StandardMaterial(`mat_${key}`, this.scene);
    mat.backFaceCulling = false;
    mat.specularColor = Color3.Black();

    if (receiveShadow) {
      mat.diffuseColor = color;
      mat.emissiveColor = color.scale(0.15);
    } else {
      mat.disableLighting = true;
      mat.emissiveColor = color.clone();
    }

    if (texture) {
      mat.diffuseTexture = texture;
    }

    const mesh = new Mesh(`inst_${key}`, this.scene);
    const vd = new VertexData();
    vd.positions = geometry.positions;
    vd.indices = geometry.indices;
    vd.normals = geometry.normals;
    if (geometry.uvs) vd.uvs = geometry.uvs;
    vd.applyToMesh(mesh);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.isVisible = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;

    if (receiveShadow) {
      mesh.receiveShadows = true;
    }
    if (castShadow) {
      this.shadowGenerator.addShadowCaster(mesh, true);
    }

    bucket = {
      mesh,
      material: mat,
      instances: new Map(),
      free: [],
      baseColor: color,
      castShadow,
      receiveShadow,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  addInstance(
    key: string,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: number | [number, number, number],
    dynamic?: boolean,
  ): number {
    const bucket = this.buckets.get(key)!;
    const id = nextId++;
    let inst: BabylonInstancedMesh;
    if (bucket.free.length > 0) {
      inst = bucket.free.pop()!;
      inst.setEnabled(true);
      inst.doNotSyncBoundingInfo = false;
    } else {
      inst = bucket.mesh.createInstance(`${key}_${id}`);
      inst.isPickable = false;
      if (bucket.receiveShadow) inst.receiveShadows = true;
      if (bucket.castShadow) this.shadowGenerator.addShadowCaster(inst);
    }
    applyTransform(inst, pos, rot, scale);
    if (!dynamic) {
      inst.freezeWorldMatrix();
      inst.doNotSyncBoundingInfo = true;
    }
    bucket.instances.set(id, inst);
    return id;
  }

  updateInstance(
    key: string,
    id: number,
    pos?: [number, number, number],
    rot?: [number, number, number],
  ): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const inst = bucket.instances.get(id);
    if (!inst) return;
    applyTransform(inst, pos, rot);
  }

  removeInstance(key: string, id: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const inst = bucket.instances.get(id);
    if (!inst) return;
    bucket.instances.delete(id);

    inst.setEnabled(false);
    inst.unfreezeWorldMatrix();
    bucket.free.push(inst);

    if (bucket.instances.size === 0 && bucket.free.length === 0) {
      if (bucket.castShadow) {
        this.shadowGenerator.removeShadowCaster(bucket.mesh);
      }
      bucket.mesh.dispose();
      bucket.material.dispose();
      this.buckets.delete(key);
    }
  }

  updateMaterials(ambientColor: Color3): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.receiveShadow) {
        bucket.material.diffuseColor = bucket.baseColor;
        bucket.material.emissiveColor = new Color3(
          bucket.baseColor.r * ambientColor.r * 0.15,
          bucket.baseColor.g * ambientColor.g * 0.15,
          bucket.baseColor.b * ambientColor.b * 0.15,
        );
      } else {
        bucket.material.emissiveColor = tint(bucket.baseColor, ambientColor);
      }
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.castShadow) {
        this.shadowGenerator.removeShadowCaster(bucket.mesh);
      }
      for (const inst of bucket.free) inst.dispose();
      for (const inst of bucket.instances.values()) inst.dispose();
      bucket.mesh.dispose();
      bucket.material.dispose();
    }
    this.buckets.clear();
  }
}

// --- Context ---

const InstancePoolCtx = createContext<InstancePool>();

export function useInstancePool(): InstancePool {
  const ctx = useContext(InstancePoolCtx);
  if (!ctx)
    throw new Error(
      "useInstancePool must be used within <InstancePoolProvider>",
    );
  return ctx;
}

export function InstancePoolProvider(props: ParentProps) {
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();

  const pool = new InstancePool(scene, shadowGenerator);

  createEffect(on(ambientColor, (amb) => {
    pool.updateMaterials(amb);
  }));

  onCleanup(() => {
    pool.dispose();
  });

  return <InstancePoolCtx.Provider value={pool}>{props.children}</InstancePoolCtx.Provider>;
}

// --- InstancedMesh component ---

interface InstancedMeshProps {
  poolKey: string;
  geometry: MeshGeometry;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  color: Color3;
  castShadow?: boolean;
  receiveShadow?: boolean;
  texture?: BaseTexture;
  enabled?: boolean;

  ref?: (handle: InstanceHandle) => void;
}

export default function InstancedMesh(props: InstancedMeshProps) {
  const pool = useInstancePool();

  let currentKey: string | undefined;
  let id: number;

  createEffect(on(
    () => ({
      key: props.poolKey,
      geo: props.geometry,
      color: props.color,
      cast: props.castShadow ?? false,
      recv: props.receiveShadow ?? false,
      tex: props.texture,
      pos: props.position,
      rot: props.rotation,
      scale: props.scale,
      enabled: props.enabled ?? true,
      ref: props.ref,
    }),
    ({ key, geo, color, cast, recv, tex, pos, rot, scale, enabled, ref }) => {
      if (currentKey !== undefined) {
        pool.removeInstance(currentKey, id);
        currentKey = undefined;
      }
      if (!enabled) return;
      pool.ensureBucket(key, geo, color, cast, recv, tex);
      id = pool.addInstance(key, pos, rot, scale);
      currentKey = key;

      ref?.({
        setMatrix(p, r) {
          pool.updateInstance(currentKey!, id, p, r);
        },
      });
    },
  ));

  createEffect(on(
    () => ({ pos: props.position, rot: props.rotation, scale: props.scale }),
    ({ pos, rot, scale }) => {
      if (currentKey === undefined) return;
      pool.removeInstance(currentKey, id);
      id = pool.addInstance(currentKey, pos, rot, scale);
    },
    { defer: true },
  ));

  onCleanup(() => {
    if (currentKey !== undefined) pool.removeInstance(currentKey, id);
  });

  return <></>;
}
