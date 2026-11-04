import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
  type ParentProps,
} from "solid-js";
import { addToScene, composeMat4IntoBuffer, setThinInstanceCount, setThinInstances, type EngineContext, type MaterialPlugin, type Mesh, type SceneContext, type Texture2D } from "@babylonjs/lite";
import type { Culler } from "./cull";
import { CHUNK_SIZE } from "./objects/terrainGeometry";
import { FLAT, setTint, townMaterial, type TownMaterial } from "./material";
import { useEngine } from "./Canvas";
import { useDayNight, type Casters } from "./DayNightCycle";
import { bevelPlugin, bevelled, giveBevel, type Bevel } from "./bevel";
import { drop, meshOf, type MeshGeometry } from "./geometry";
import { BLACK, mul, WHITE, type Rgb } from "./rgb";

/**
 * One draw call per bucket, however many instances it holds. Thin instances
 * carry no scene node, so a moving instance costs a matrix write rather than a
 * world-matrix recompute, a bounding sync, a frustum test and a slot in the
 * active-mesh walk.
 *
 * A kind's instances are kept in a bucket for each chunk of the map they
 * stand in, all of one material, and each chunk's shown only while the view
 * meets it (`cull.ts`): one bucket for the whole map drew every house and
 * pallet in town however far in the view was. An instance that moves
 * goes over to the next chunk's bucket as it leaves its own. A bucket left
 * empty stays, hidden, for the next to come: a mesh dropped and made again
 * is a new renderable and a new caster, a stalled frame.
 */
interface Kind {
  /** The town's material where it is lit; flat colour, tinted by the
   *  hour, where it is not (a chevron, a marker). One for all its chunks. */
  material: TownMaterial;
  /** Its creases' roundness, which a lacquer may change. */
  bevel: Bevel;
  baseColor: Rgb;
  castShadow: boolean;
  receiveShadow: boolean;
  geometry: ReturnType<typeof bevelled>;
  key: string;
  chunks: Map<string, Bucket>;
}

interface Bucket {
  kind: Kind;
  mesh: Mesh;
  /** The chunk it draws, in chunks. */
  cx: number;
  cy: number;
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

/** How far past its chunk a bucket is kept in view, in tiles: what stands
 *  near the edge reaches over it (a building's model, a car's length), and
 *  a moving instance goes over to the next chunk only this far past it. */
const REACH = 4;

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
  private kinds = new Map<string, Kind>();
  /** Each instance's bucket. */
  private homes = new Map<number, Bucket>();
  /** The ambient light in force, so a bucket made mid-day is painted for it. */
  private ambient: Rgb = WHITE;

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    readonly casters: Casters,
    private cull: Culler,
  ) {}

  ensureBucket(
    key: string,
    geometry: MeshGeometry & { colors?: number[] },
    color: Rgb,
    castShadow: boolean,
    receiveShadow: boolean,
    texture?: Texture2D,
    plugins: MaterialPlugin[] = [],
  ): Kind {
    let kind = this.kinds.get(key);
    if (kind) return kind;

    // Every shape held here has its creases rounded (`bevel.ts`): a car's
    // box, a building's; a road's flat rim has none to round. A texture's
    // colours are as an eye sees them: the town's material makes them
    // linear itself (`material.ts`).
    const bevel: Bevel = { width: 0.05, soft: null };
    const material = townMaterial(receiveShadow ? [bevelPlugin(bevel), ...plugins] : [bevelPlugin(bevel), FLAT, ...plugins], 0.9, texture);
    kind = { material, bevel, baseColor: color, castShadow, receiveShadow, geometry: bevelled(geometry), key, chunks: new Map() };
    // Painted with the ambient in force now, not the noon default: a bucket
    // born at dusk beside buckets already tinted for dusk would otherwise be
    // a shade off until the next colour step, which reads as a flicker under
    // the pointer while a road is drawn.
    this.paint(kind);
    this.kinds.set(key, kind);
    return kind;
  }

  /** A kind's bucket for the chunk at (x, y), made the first time. */
  private bucketAt(kind: Kind, x: number, y: number): Bucket {
    const [cx, cy] = [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
    const at = `${cx},${cy}`;
    let bucket = kind.chunks.get(at);
    if (bucket) return bucket;
    // A shape's own colours scale its bucket's: a car's glass darker.
    const mesh = meshOf(this.engine, `inst_${kind.key}#${at}`, kind.geometry);
    giveBevel(this.engine, mesh, kind.geometry);
    mesh.material = kind.material;
    mesh.receiveShadows = kind.receiveShadow;
    // Room for some from the start: a buffer of none is no buffer at all.
    const matrices = new Float32Array(64 * 16);
    setThinInstances(mesh, matrices, 64);
    setThinInstanceCount(mesh, 0);
    addToScene(this.scene, mesh);
    if (kind.castShadow) this.casters.add(mesh);
    this.cull.keep(mesh, [cx * CHUNK_SIZE - REACH, cy * CHUNK_SIZE - REACH, (cx + 1) * CHUNK_SIZE + REACH, (cy + 1) * CHUNK_SIZE + REACH]);
    bucket = { kind, mesh, cx, cy, matrices, transforms: new Float32Array(64 * STRIDE), count: 0, idToIndex: new Map(), indexToId: [], dirty: false, resized: false };
    kind.chunks.set(at, bucket);
    return bucket;
  }

  /** One instance's world matrix, as last composed; null once it is gone. */
  matrixOf(_key: string, id: number, out: Float32Array): Float32Array | null {
    const bucket = this.homes.get(id);
    const index = bucket?.idToIndex.get(id);
    if (!bucket || index === undefined) return null;
    out.set(bucket.matrices.subarray(index * 16, index * 16 + 16));
    return out;
  }

  geometryOf(key: string): MeshGeometry | null {
    return this.kinds.get(key)?.geometry ?? null;
  }

  addInstance(
    key: string,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: number | [number, number, number],
  ): number {
    const s3 = scale == null ? [1, 1, 1] : typeof scale === "number" ? [scale, scale, scale] : scale;
    const t = [pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0, rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, s3[0], s3[1], s3[2]];
    const id = nextId++;
    this.place(this.bucketAt(this.kinds.get(key)!, t[0], t[1]), id, t);
    return id;
  }

  /** An instance, by its transform, into a bucket. */
  private place(bucket: Bucket, id: number, t: ArrayLike<number>) {
    if ((bucket.count + 1) * 16 > bucket.matrices.length) grow(bucket);
    const index = bucket.count++;
    bucket.transforms.set(t, index * STRIDE);
    bucket.idToIndex.set(id, index);
    bucket.indexToId[index] = id;
    this.homes.set(id, bucket);
    composeMatrix(bucket, index);
  }

  updateInstance(
    _key: string,
    id: number,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: [number, number, number],
  ): void {
    const bucket = this.homes.get(id);
    const index = bucket?.idToIndex.get(id);
    if (!bucket || index === undefined) return;
    const t = index * STRIDE;
    const tr = bucket.transforms;
    if (pos) { tr[t] = pos[0]; tr[t + 1] = pos[1]; tr[t + 2] = pos[2]; }
    if (rot) { tr[t + 3] = rot[0]; tr[t + 4] = rot[1]; tr[t + 5] = rot[2]; }
    if (scale) { tr[t + 6] = scale[0]; tr[t + 7] = scale[1]; tr[t + 8] = scale[2]; }
    const [x0, y0] = [bucket.cx * CHUNK_SIZE - REACH, bucket.cy * CHUNK_SIZE - REACH];
    const out = pos && (pos[0] < x0 || pos[1] < y0 || pos[0] > x0 + CHUNK_SIZE + 2 * REACH || pos[1] > y0 + CHUNK_SIZE + 2 * REACH);
    if (!out) return composeMatrix(bucket, index);
    // Gone past its chunk's reach: over to the bucket of the chunk it is in.
    const moved = tr.slice(t, t + STRIDE);
    this.take(bucket, id);
    this.place(this.bucketAt(bucket.kind, moved[0], moved[1]), id, moved);
  }

  removeInstance(_key: string, id: number): void {
    const bucket = this.homes.get(id);
    if (bucket) this.take(bucket, id);
  }

  /** An instance out of its bucket. */
  private take(bucket: Bucket, id: number) {
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
    this.homes.delete(id);
    bucket.dirty = true;
  }

  /**
   * Upload whatever changed, once per bucket per frame. Instances write into
   * the buffer freely during the frame; nothing reaches the GPU until here.
   */
  flush(): void {
    for (const kind of this.kinds.values()) {
      for (const bucket of kind.chunks.values()) {
        if (!bucket.dirty) continue;
        // A new buffer at its whole capacity, then the count: what is drawn,
        // and uploaded, is the instances there are.
        if (bucket.resized) {
          setThinInstances(bucket.mesh, bucket.matrices, bucket.matrices.length / 16);
          bucket.resized = false;
        }
        setThinInstanceCount(bucket.mesh, bucket.count);
        this.cull.want(bucket.mesh, bucket.count > 0);
        bucket.dirty = false;
      }
    }
  }

  /** A kind's material and bevel, as a lacquer takes them. */
  finish(key: string): { material: TownMaterial; bevel: Bevel } | undefined {
    return this.kinds.get(key);
  }

  updateMaterials(ambientColor: Rgb): void {
    this.ambient = ambientColor;
    for (const kind of this.kinds.values()) this.paint(kind);
  }

  private paint(kind: Kind): void {
    setTint(kind.material, kind.receiveShadow ? kind.baseColor : mul(kind.baseColor, this.ambient));
  }

  dispose(): void {
    for (const kind of this.kinds.values()) {
      for (const bucket of kind.chunks.values()) {
        if (kind.castShadow) this.casters.remove(bucket.mesh);
        this.cull.forget(bucket.mesh);
        drop(this.scene, bucket.mesh);
      }
    }
    this.kinds.clear();
    this.homes.clear();
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
  const { engine, scene, beforeRender, cull } = useEngine();
  const { ambientColor, casters } = useDayNight();

  const pool = new InstancePool(engine, scene, casters()!, cull);

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

