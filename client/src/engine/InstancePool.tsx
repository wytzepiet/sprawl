import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  type ParentProps,
} from "solid-js";
import {
  Mesh,
  VertexData,
  StandardMaterial,
  Color3,
  Matrix,
  Quaternion,
  Vector3,
} from "@babylonjs/core";
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
  instances: Map<number, Float32Array>;
  baseColor: Color3;
  castShadow: boolean;
  receiveShadow: boolean;
  dirty: boolean;
}

let nextInstanceId = 0;

class InstancePool {
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
  ): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) return bucket;

    const mat = new StandardMaterial(`inst_${key}_mat`, this.scene);
    mat.backFaceCulling = false;
    mat.specularColor = Color3.Black();

    if (receiveShadow) {
      mat.diffuseColor = color;
      mat.emissiveColor = color.scale(0.15);
    } else {
      mat.disableLighting = true;
      mat.emissiveColor = color.clone();
    }

    const mesh = new Mesh(`inst_${key}`, this.scene);
    const vd = new VertexData();
    vd.positions = geometry.positions;
    vd.indices = geometry.indices;
    vd.normals = geometry.normals;
    vd.applyToMesh(mesh);
    mesh.material = mat;
    mesh.isPickable = false;

    if (receiveShadow) {
      mesh.receiveShadows = true;
    }
    if (castShadow) {
      this.shadowGenerator.addShadowCaster(mesh);
    }

    bucket = {
      mesh,
      material: mat,
      instances: new Map(),
      baseColor: color,
      castShadow,
      receiveShadow,
      dirty: true,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  addInstance(key: string, matrix: Float32Array): number {
    const bucket = this.buckets.get(key)!;
    const id = nextInstanceId++;
    bucket.instances.set(id, matrix);
    bucket.dirty = true;
    return id;
  }

  updateInstance(key: string, id: number, matrix: Float32Array): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.instances.set(id, matrix);
    bucket.dirty = true;
  }

  removeInstance(key: string, id: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.instances.delete(id);
    bucket.dirty = true;

    if (bucket.instances.size === 0) {
      if (bucket.castShadow) {
        this.shadowGenerator.removeShadowCaster(bucket.mesh);
      }
      bucket.mesh.dispose();
      bucket.material.dispose();
      this.buckets.delete(key);
    }
  }

  flush(ambientColor: Color3): void {
    for (const bucket of this.buckets.values()) {
      // Update materials for day/night
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

      // Rebuild buffers for dirty buckets
      if (!bucket.dirty) continue;
      bucket.dirty = false;

      const count = bucket.instances.size;
      if (count === 0) {
        bucket.mesh.thinInstanceCount = 0;
        continue;
      }

      const buf = new Float32Array(count * 16);
      let i = 0;
      for (const matrix of bucket.instances.values()) {
        buf.set(matrix, i * 16);
        i++;
      }
      bucket.mesh.thinInstanceSetBuffer("matrix", buf, 16);
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.castShadow) {
        this.shadowGenerator.removeShadowCaster(bucket.mesh);
      }
      bucket.mesh.dispose();
      bucket.material.dispose();
    }
    this.buckets.clear();
  }
}

// --- Context ---

const InstancePoolCtx = createContext<InstancePool>();

function useInstancePool(): InstancePool {
  const ctx = useContext(InstancePoolCtx);
  if (!ctx) throw new Error("useInstancePool must be used within <InstancePoolProvider>");
  return ctx;
}

export function InstancePoolProvider(props: ParentProps) {
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();

  const pool = new InstancePool(scene, shadowGenerator);

  const obs = scene.onBeforeRenderObservable.add(() => {
    pool.flush(ambientColor());
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    pool.dispose();
  });

  return <InstancePoolCtx value={pool}>{props.children}</InstancePoolCtx>;
}

// --- InstancedMesh component ---

const tmpQuat = new Quaternion();

function buildMatrix(
  pos?: [number, number, number],
  rot?: [number, number, number],
): Float32Array {
  const px = pos?.[0] ?? 0;
  const py = pos?.[1] ?? 0;
  const pz = pos?.[2] ?? 0;
  const rx = rot?.[0] ?? 0;
  const ry = rot?.[1] ?? 0;
  const rz = rot?.[2] ?? 0;

  Quaternion.FromEulerAnglesToRef(rx, ry, rz, tmpQuat);
  const m = Matrix.Compose(
    Vector3.One(),
    tmpQuat,
    new Vector3(px, py, pz),
  );
  return m.toArray() as unknown as Float32Array;
}

interface InstancedMeshProps {
  poolKey: string;
  geometry: MeshGeometry;
  position?: [number, number, number];
  rotation?: [number, number, number];
  color: Color3;
  castShadow?: boolean;
  receiveShadow?: boolean;
  ref?: (handle: InstanceHandle) => void;
}

export default function InstancedMesh(props: InstancedMeshProps) {
  const pool = useInstancePool();

  let currentKey = props.poolKey;
  pool.ensureBucket(
    currentKey,
    props.geometry,
    props.color,
    props.castShadow ?? false,
    props.receiveShadow ?? false,
  );

  const matrix = buildMatrix(props.position, props.rotation);
  let id = pool.addInstance(currentKey, matrix);

  if (props.ref) {
    props.ref({
      setMatrix(pos, rot) {
        const m = buildMatrix(pos, rot);
        pool.updateInstance(currentKey, id, m);
      },
    });
  }

  // React to poolKey/geometry changes — move instance to new bucket
  createEffect(
    () => ({ poolKey: props.poolKey, geometry: props.geometry }),
    ({ poolKey, geometry }) => {
      pool.removeInstance(currentKey, id);
      pool.ensureBucket(
        poolKey,
        geometry,
        props.color,
        props.castShadow ?? false,
        props.receiveShadow ?? false,
      );
      const m = buildMatrix(props.position, props.rotation);
      id = pool.addInstance(poolKey, m);
      currentKey = poolKey;
    },
    undefined,
    { defer: true },
  );

  // React to position/rotation changes
  createEffect(
    () => [props.position, props.rotation] as const,
    ([pos, rot]) => {
      const m = buildMatrix(pos, rot);
      pool.updateInstance(currentKey, id, m);
    },
    undefined,
    { defer: true },
  );

  onCleanup(() => {
    pool.removeInstance(currentKey, id);
  });

  return <></>;
}
