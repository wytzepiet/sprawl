import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
  type ParentProps,
} from "solid-js";
import { composeMat4IntoBuffer, setThinInstanceCount, setThinInstances, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "@babylonjs/lite";
import { FLAT, setTint, townMaterial, type TownMaterial } from "./material";
import { useEngine } from "./Canvas";
import { useDayNight, type Casters } from "./DayNightCycle";
import { bevelPlugin, bevelled, giveBevel, type Bevel } from "./bevel";
import { drop, meshOf, show, type MeshGeometry } from "./geometry";
import { BLACK, mul, WHITE, type Rgb } from "./rgb";

export interface InstanceHandle {
  setMatrix(pos: [number, number, number], rot: [number, number, number]): void;
}


/**
 * One draw call per bucket, however many instances it holds. Thin instances
 * carry no scene node, so a moving instance costs a matrix write rather than a
 * world-matrix recompute, a bounding sync, a frustum test and a slot in the
 * active-mesh walk.
 */
interface Bucket {
  mesh: Mesh;
  /** The town's material where it is lit; flat colour, tinted by the
   *  hour, where it is not (a chevron, a marker). */
  material: TownMaterial;
  /** Its creases' roundness, which a lacquer may change. */
  bevel: Bevel;
  /** 16 floats per instance. Capacity may exceed count. */
  matrices: Float32Array;
  /** pos(3) + rot(3) + scale(3), so a partial update can recompose. */
  transforms: Float32Array;
  count: number;
  idToIndex: Map<number, number>;
  indexToId: number[];
  /** Contents changed; re-upload before the next render. */
  dirty: boolean;
  /** Buffer was reallocated, so Lite needs the new reference. */
  resized: boolean;
  baseColor: Rgb;
  castShadow: boolean;
  receiveShadow: boolean;
  geometry: MeshGeometry;
}

const STRIDE = 9;
/** A rotation by Euler angles, as Babylon's `FromEulerAngles` turns them
 *  (yaw y, pitch x, roll z), into a matrix slot with a position and scale. */
function compose(out: Float32Array, at: number, tr: Float32Array, t: number) {
  const [cx, sx] = [Math.cos(tr[t + 3] / 2), Math.sin(tr[t + 3] / 2)];
  const [cy, sy] = [Math.cos(tr[t + 4] / 2), Math.sin(tr[t + 4] / 2)];
  const [cz, sz] = [Math.cos(tr[t + 5] / 2), Math.sin(tr[t + 5] / 2)];
  composeMat4IntoBuffer(
    out,
    at,
    tr[t],
    tr[t + 1],
    tr[t + 2],
    cz * sx * cy + sz * cx * sy,
    cz * cx * sy - sz * sx * cy,
    sz * cx * cy - cz * sx * sy,
    cz * cx * cy + sz * sx * sy,
    tr[t + 6],
    tr[t + 7],
    tr[t + 8],
  );
}

/** Compose one instance's stored transform into its slot in the matrix buffer. */
function composeMatrix(bucket: Bucket, index: number): void {
  compose(bucket.matrices, index * 16, bucket.transforms, index * STRIDE);
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
  /** The ambient light in force, so a bucket made mid-day is painted for it. */
  private ambient: Rgb = WHITE;

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private casters: Casters,
  ) {}

  ensureBucket(
    key: string,
    geometry: MeshGeometry & { colors?: number[] },
    color: Rgb,
    castShadow: boolean,
    receiveShadow: boolean,
    texture?: Texture2D,
  ): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) return bucket;

    // Every shape held here has its creases rounded (`bevel.ts`): a car's
    // box, a building's; a road's flat rim has none to round. A texture's
    // colours are as an eye sees them: the town's material makes them
    // linear itself (`material.ts`).
    const bevel: Bevel = { width: 0.05, soft: null };
    const mat = townMaterial(receiveShadow ? [bevelPlugin(bevel)] : [bevelPlugin(bevel), FLAT], 0.9, texture);
    const shape = bevelled(geometry);

    // A shape's own colours scale its bucket's: a car's glass darker.
    const mesh = meshOf(this.engine, `inst_${key}`, shape);
    giveBevel(this.engine, mesh, shape);
    mesh.material = mat;
    mesh.receiveShadows = receiveShadow;
    // Room for some from the start: a buffer of none is no buffer at all.
    const matrices = new Float32Array(64 * 16);
    setThinInstances(mesh, matrices, 64);
    setThinInstanceCount(mesh, 0);
    show(this.scene, mesh);
    if (castShadow) this.casters.add(mesh);

    bucket = {
      mesh,
      material: mat,
      bevel,
      matrices,
      transforms: new Float32Array(64 * STRIDE),
      count: 0,
      idToIndex: new Map(),
      indexToId: [],
      dirty: false,
      resized: false,
      baseColor: color,
      castShadow,
      receiveShadow,
      geometry: shape,
    };
    // Painted with the ambient in force now, not the noon default: a bucket
    // born at dusk beside buckets already tinted for dusk would otherwise be
    // a shade off until the next colour step, which reads as a flicker under
    // the pointer while a road is drawn.
    this.paint(bucket);
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** One instance's world matrix, as last composed; null once it is gone. */
  matrixOf(key: string, id: number, out: Float32Array): Float32Array | null {
    const bucket = this.buckets.get(key);
    const index = bucket?.idToIndex.get(id);
    if (!bucket || index === undefined) return null;
    out.set(bucket.matrices.subarray(index * 16, index * 16 + 16));
    return out;
  }

  geometryOf(key: string): MeshGeometry | null {
    return this.buckets.get(key)?.geometry ?? null;
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
    scale?: [number, number, number],
  ): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const index = bucket.idToIndex.get(id);
    if (index === undefined) return;
    const t = index * STRIDE;
    const tr = bucket.transforms;
    if (pos) { tr[t] = pos[0]; tr[t + 1] = pos[1]; tr[t + 2] = pos[2]; }
    if (rot) { tr[t + 3] = rot[0]; tr[t + 4] = rot[1]; tr[t + 5] = rot[2]; }
    if (scale) { tr[t + 6] = scale[0]; tr[t + 7] = scale[1]; tr[t + 8] = scale[2]; }
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
      if (bucket.castShadow) this.casters.remove(bucket.mesh);
      drop(this.scene, bucket.mesh);
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
      // A new buffer at its whole capacity, then the count: what is drawn,
      // and uploaded, is the instances there are.
      if (bucket.resized) {
        setThinInstances(bucket.mesh, bucket.matrices, bucket.matrices.length / 16);
        bucket.resized = false;
      }
      setThinInstanceCount(bucket.mesh, bucket.count);
      bucket.dirty = false;
    }
  }

  /** A bucket's material and bevel, as a lacquer takes them. */
  finish(key: string): { material: TownMaterial; bevel: Bevel } | undefined {
    return this.buckets.get(key);
  }

  updateMaterials(ambientColor: Rgb): void {
    this.ambient = ambientColor;
    for (const bucket of this.buckets.values()) {
      this.paint(bucket);
    }
  }

  private paint(bucket: Bucket): void {
    setTint(bucket.material, bucket.receiveShadow ? bucket.baseColor : mul(bucket.baseColor, this.ambient));
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.castShadow) this.casters.remove(bucket.mesh);
      drop(this.scene, bucket.mesh);
    }
    this.buckets.clear();
  }
}

// --- Context ---

const InstancePoolCtx = createContext<InstancePool>();

const WARM_TRIANGLE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};

export function useInstancePool(): InstancePool {
  const ctx = useContext(InstancePoolCtx);
  if (!ctx)
    throw new Error(
      "useInstancePool must be used within <InstancePoolProvider>",
    );
  return ctx;
}

export function InstancePoolProvider(props: ParentProps) {
  const { engine, scene, beforeRender } = useEngine();
  const { ambientColor, casters } = useDayNight();

  const pool = new InstancePool(engine, scene, casters()!);

  // WebGPU compiles a shader variant the first time something is drawn with
  // it: a few hundred milliseconds with no frames at all. There are two —
  // lit and unlit — so each is drawn once now, off the map in the loading
  // frames, rather than the first time a one-way road puts a chevron under
  // the pointer. Kept a second: Lite builds what is added as it comes.
  const warm: { key: string; id: number }[] = [];
  for (const lit of [true, false]) {
    const key = `warm_${lit}`;
    pool.ensureBucket(key, WARM_TRIANGLE, BLACK, false, lit);
    warm.push({ key, id: pool.addInstance(key, [0, 0, -100]) });
  }
  const cool = setTimeout(() => {
    for (const { key, id } of warm) pool.removeInstance(key, id);
  }, 1000);
  onCleanup(() => clearTimeout(cool));

  // Instances are written during the frame; this pushes them to the GPU once.
  onCleanup(beforeRender(() => pool.flush()));

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
  color: Rgb;
  castShadow?: boolean;
  receiveShadow?: boolean;
  texture?: Texture2D;
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
