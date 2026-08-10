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
  Matrix,
  Quaternion,
  Vector3,
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

/**
 * One draw call per bucket, however many instances it holds. Thin instances
 * carry no scene node, so a moving instance costs a matrix write rather than a
 * world-matrix recompute, a bounding sync, a frustum test and a slot in the
 * active-mesh walk.
 */
interface Bucket {
  mesh: Mesh;
  material: StandardMaterial;
  /** 16 floats per instance. Capacity may exceed count. */
  matrices: Float32Array;
  /** pos(3) + rot(3) + scale(3), so a partial update can recompose. */
  transforms: Float32Array;
  count: number;
  idToIndex: Map<number, number>;
  indexToId: number[];
  /** Contents changed; re-upload before the next render. */
  dirty: boolean;
  /** Buffer was reallocated, so Babylon needs the new reference. */
  resized: boolean;
  baseColor: Color3;
  castShadow: boolean;
  receiveShadow: boolean;
}

const STRIDE = 9;
const _scale = new Vector3();
const _rot = new Quaternion();
const _pos = new Vector3();
const _mat = new Matrix();

/** Compose one instance's stored transform into its slot in the matrix buffer. */
function composeMatrix(bucket: Bucket, index: number): void {
  const t = index * STRIDE;
  const tr = bucket.transforms;
  _pos.set(tr[t], tr[t + 1], tr[t + 2]);
  Quaternion.FromEulerAnglesToRef(tr[t + 3], tr[t + 4], tr[t + 5], _rot);
  _scale.set(tr[t + 6], tr[t + 7], tr[t + 8]);
  Matrix.ComposeToRef(_scale, _rot, _pos, _mat);
  _mat.copyToArray(bucket.matrices, index * 16);
  bucket.dirty = true;
}

function grow(bucket: Bucket): void {
  const capacity = Math.max(64, (bucket.count + 1) * 2);
  const m = new Float32Array(capacity * 16);
  m.set(bucket.matrices);
  bucket.matrices = m;
  const t = new Float32Array(capacity * STRIDE);
  t.set(bucket.transforms);
  bucket.transforms = t;
  bucket.resized = true;
}

let nextId = 0;



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
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    // Instances span the whole world, so the base mesh's own bounds say
    // nothing useful -- skip the frustum test rather than rebuild bounds each
    // frame, which would walk every instance.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.setEnabled(false);

    if (receiveShadow) {
      mesh.receiveShadows = true;
    }
    if (castShadow) {
      this.shadowGenerator.addShadowCaster(mesh, true);
    }

    bucket = {
      mesh,
      material: mat,
      matrices: new Float32Array(0),
      transforms: new Float32Array(0),
      count: 0,
      idToIndex: new Map(),
      indexToId: [],
      dirty: false,
      resized: true,
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
  ): number {
    const bucket = this.buckets.get(key)!;
    const id = nextId++;
    if ((bucket.count + 1) * 16 > bucket.matrices.length) grow(bucket);

    const index = bucket.count++;
    const t = index * STRIDE;
    const tr = bucket.transforms;
    tr[t] = pos?.[0] ?? 0;
    tr[t + 1] = pos?.[1] ?? 0;
    tr[t + 2] = pos?.[2] ?? 0;
    tr[t + 3] = rot?.[0] ?? 0;
    tr[t + 4] = rot?.[1] ?? 0;
    tr[t + 5] = rot?.[2] ?? 0;
    const s3 = scale == null ? [1, 1, 1] : typeof scale === "number" ? [scale, scale, scale] : scale;
    tr[t + 6] = s3[0];
    tr[t + 7] = s3[1];
    tr[t + 8] = s3[2];

    bucket.idToIndex.set(id, index);
    bucket.indexToId[index] = id;
    composeMatrix(bucket, index);
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
    const index = bucket.idToIndex.get(id);
    if (index === undefined) return;
    const t = index * STRIDE;
    const tr = bucket.transforms;
    if (pos) { tr[t] = pos[0]; tr[t + 1] = pos[1]; tr[t + 2] = pos[2]; }
    if (rot) { tr[t + 3] = rot[0]; tr[t + 4] = rot[1]; tr[t + 5] = rot[2]; }
    composeMatrix(bucket, index);
  }

  removeInstance(key: string, id: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const index = bucket.idToIndex.get(id);
    if (index === undefined) return;

    // Swap-remove: move the last instance into the freed slot so the buffer
    // stays contiguous and only one slot has to be rewritten.
    const last = --bucket.count;
    if (index !== last) {
      bucket.transforms.copyWithin(index * STRIDE, last * STRIDE, (last + 1) * STRIDE);
      const movedId = bucket.indexToId[last];
      bucket.indexToId[index] = movedId;
      bucket.idToIndex.set(movedId, index);
      composeMatrix(bucket, index);
    }
    bucket.idToIndex.delete(id);
    bucket.dirty = true;

    if (bucket.count === 0) {
      if (bucket.castShadow) {
        this.shadowGenerator.removeShadowCaster(bucket.mesh);
      }
      bucket.mesh.dispose();
      bucket.material.dispose();
      this.buckets.delete(key);
    }
  }

  /**
   * Upload whatever changed, once per bucket per frame. Instances write into
   * the buffer freely during the frame; nothing reaches the GPU until here.
   */
  flush(): void {
    for (const bucket of this.buckets.values()) {
      if (!bucket.dirty) continue;
      if (bucket.resized) {
        bucket.mesh.thinInstanceSetBuffer("matrix", bucket.matrices, 16, false);
        bucket.resized = false;
      } else {
        bucket.mesh.thinInstanceBufferUpdated("matrix");
      }
      bucket.mesh.thinInstanceCount = bucket.count;
      // An empty thin-instance buffer leaves a zero-sized draw behind a call
      // that still carries the old count -- WebGPU rejects it and drops the
      // frame. Same reason TerrainChunks disables empty chunk meshes.
      bucket.mesh.setEnabled(bucket.count > 0);
      bucket.dirty = false;
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

  const pool = new InstancePool(scene, shadowGenerator()!);

  // Instances are written during the frame; this pushes them to the GPU once.
  const obs = scene.onBeforeRenderObservable.add(() => pool.flush());
  onCleanup(() => scene.onBeforeRenderObservable.remove(obs));

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
