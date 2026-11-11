import type { Engine } from "./engine";
import type { OwnPbrMaterial } from "./material";
import { dirtyMaterials } from "./pass";
import type { Scene } from "./scene";

const VERTEX = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;

/** What a mesh holds on the GPU: its buffers by the name the shaders know
 *  them by ("position", "normal", "uv", "color", "instances",
 *  "instanceColors", and the plugins' own), and its world. */
export interface MeshGpu {
  indexCount: number;
  vertexCount: number;
  index: GPUBuffer;
  buffers: Map<string, GPUBuffer>;
  /** Its world, and whether it is shaded. */
  world: GPUBuffer;
  group: GPUBindGroup | null;
  /** Its vertices are another mesh's (`meshLike`), which outlives it. */
  lent?: true;
}

export interface ThinInstances {
  matrices: Float32Array | Float64Array;
  count: number;
  colors: Float32Array | null;
}

/** A mesh as the client knows Lite's: what it is drawn with, where, in which
 *  order, and whether; its changes told to the scenes it is in. */
export class Mesh {
  /** Read when its world is written, as it is made: set before it is first drawn. */
  receiveShadows = false;
  renderOrder = 100;
  visible = true;
  thinInstances?: ThinInstances;
  /** The scenes it is in, told when it changes. */
  _scenes = new Set<Scene>();
  /** Bumped when what it is drawn with is new (`_remade`): its buffers, its material's bindings. */
  _version = 0;
  /** Bumped when what it shows may have changed: the still picture looks at it again (`frame.ts`). */
  _touched = 0;
  /** What the GPU must be given before the next frame. */
  _dirty = { world: true, instances: false, colors: false };
  /** Its vertices' box, x0 y0 z0 x1 y1 z1, before its world or instances
   *  move it; grown with any written over it. Bumped `_reshaped` as it is. */
  _local = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  _reshaped = 0;
  /** The plugins' attributes as last given, by name: an instance's share of
   *  each says what it shows, besides its matrix (the still picture's diff). */
  _attributes = new Map<string, Float32Array>();
  /** Bumped as an attribute is written. */
  _written = 0;
  readonly position: { x: number; y: number; z: number };
  private _material: unknown = null;

  constructor(
    readonly engine: Engine,
    readonly name: string,
    readonly _gpu: MeshGpu,
  ) {
    const p = { x: 0, y: 0, z: 0 };
    const moved = () => this._changed(false, true);
    this.position = {
      get x() { return p.x; },
      set x(v) { p.x = v; moved(); },
      get y() { return p.y; },
      set y(v) { p.y = v; moved(); },
      get z() { return p.z; },
      set z(v) { p.z = v; moved(); },
    };
    engine._dirtyMeshes.add(this);
  }

  get material(): unknown {
    return this._material;
  }
  set material(m: unknown) {
    if (m === this._material) return;
    this._material = m;
    this._remade();
  }

  /** Something about it changed: whether it is drawn (`drawn`), or only
   *  what it shows (`moved`, its world written before the next frame). */
  _changed(drawn: boolean, moved = false) {
    this._touched++;
    if (moved) (this._dirty.world = true), this.engine._dirtyMeshes.add(this);
    for (const s of this._scenes) s._meshChanged(this, drawn);
  }

  /** What it is drawn with is new: its draws are encoded again. */
  _remade() {
    this._version++;
    this._changed(true);
  }

  /** Written to the GPU as the frame begins. */
  _flush() {
    const { _device: device } = this.engine;
    const gpu = this._gpu;
    if (this._dirty.world) {
      const p = this.position;
      device.queue.writeBuffer(gpu.world, 0, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.x, p.y, p.z, 1, this.receiveShadows ? 1 : 0, 0, 0, 0]));
      this._dirty.world = false;
    }
    const ti = this.thinInstances;
    if (ti && this._dirty.instances) {
      const floats = ti.count * 16;
      if (grow(this, "instances", floats * 4)) this._remade();
      const data = ti.matrices instanceof Float32Array ? ti.matrices : Float32Array.from(ti.matrices);
      if (floats) device.queue.writeBuffer(gpu.buffers.get("instances")!, 0, data.buffer, data.byteOffset, Math.min(floats, data.length) * 4);
      this._dirty.instances = false;
    }
    if (ti?.colors && this._dirty.colors) {
      if (grow(this, "instanceColors", ti.colors.byteLength)) this._remade();
      device.queue.writeBuffer(gpu.buffers.get("instanceColors")!, 0, ti.colors.buffer, ti.colors.byteOffset, ti.colors.byteLength);
      this._dirty.colors = false;
    }
  }
}

function buffer(engine: Engine, data: ArrayBufferView, usage = VERTEX, size = data.byteLength): GPUBuffer {
  const b = engine._device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  b.unmap();
  return b;
}

/** The named buffer made at least this big, by doubling; whether it was made anew. */
function grow(mesh: Mesh, name: string, bytes: number): boolean {
  const old = mesh._gpu.buffers.get(name);
  if (old && old.size >= bytes) return false;
  const size = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(bytes, 1))));
  old?.destroy();
  mesh._gpu.buffers.set(name, mesh.engine._device.createBuffer({ size, usage: VERTEX }));
  return true;
}

export function createMeshFromData(
  engine: Engine,
  name: string,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  uvs?: Float32Array,
  _uvs2?: Float32Array,
  _tangents?: Float32Array,
  colors?: Float32Array,
): Mesh {
  const buffers = new Map<string, GPUBuffer>([
    ["position", buffer(engine, positions)],
    ["normal", buffer(engine, normals)],
    ["uv", buffer(engine, uvs ?? new Float32Array((positions.length / 3) * 2))],
  ]);
  if (colors) buffers.set("color", buffer(engine, colors));
  const gpu: MeshGpu = {
    indexCount: indices.length,
    vertexCount: positions.length / 3,
    index: buffer(engine, indices, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST),
    buffers,
    world: engine._device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    group: null,
  };
  const mesh = new Mesh(engine, name, gpu);
  enclose(mesh._local, positions, 0, positions.length / 3);
  return mesh;
}

/** The box grown round `n` positions from vertex `from`. */
function enclose(box: number[], positions: Float32Array, from: number, n: number) {
  for (let i = from; i < from + n; i++)
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k]!;
      if (v < box[k]!) box[k] = v;
      if (v > box[k + 3]!) box[k + 3] = v;
    }
}

/** Positions written over in place, from `vertexOffset`. */
export function updateMeshPositions(engine: Engine, mesh: Mesh, positions: Float32Array, vertexOffset = 0, count?: number, sourceOffset = 0): void {
  const n = count ?? positions.length / 3 - sourceOffset;
  engine._device.queue.writeBuffer(mesh._gpu.buffers.get("position")!, vertexOffset * 12, positions.buffer, positions.byteOffset + sourceOffset * 12, n * 12);
  enclose(mesh._local, positions, sourceOffset, n);
  mesh._reshaped++;
  mesh._changed(false);
}

/** A plugin's attribute buffer, grown when it must be. */
export function setMeshAttribute(engine: Engine, mesh: Mesh, name: string, data: Float32Array): void {
  if (grow(mesh, name, data.byteLength)) mesh._remade();
  engine._device.queue.writeBuffer(mesh._gpu.buffers.get(name)!, 0, data.buffer, data.byteOffset, data.byteLength);
  mesh._attributes.set(name, data);
  mesh._written++;
  mesh._changed(false);
}

export function setMeshVisible(mesh: Mesh, visible: boolean): void {
  if (mesh.visible === visible) return;
  mesh.visible = visible;
  // Shown or hidden, it shows what it did: the lists alone are told.
  for (const s of mesh._scenes) s._meshChanged(mesh, true);
}

export function disposeMeshGpu(mesh: Mesh): void {
  const gpu = mesh._gpu;
  for (const [name, b] of gpu.buffers) if (!gpu.lent || INSTANCED.includes(name)) b.destroy();
  if (!gpu.lent) gpu.index.destroy();
  gpu.world.destroy();
}

const INSTANCED = ["instances", "instanceColors"];
/** A mesh of another's shape, drawn with that mesh's own vertex buffers:
 *  its world and its instances are its own. Drawn one after the other,
 *  only those are bound again (`DrawList.drawSome`). */
export function meshLike(of: Mesh, name: string): Mesh {
  const g = of._gpu;
  const buffers = new Map([...g.buffers].filter(([n]) => !INSTANCED.includes(n)));
  const world = of.engine._device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const mesh = new Mesh(of.engine, name, { ...g, buffers, world, group: null, lent: true });
  mesh._local = [...of._local];
  for (const [k, v] of of._attributes) mesh._attributes.set(k, v);
  return mesh;
}

/** Its bindings made again, and its material's UBO written again, as Lite
 *  writes it with them: a texture of its material's was replaced (the atlas
 *  grown, and its grid with it). */
export function markMeshRenderableDirty(mesh: Mesh): void {
  if ((mesh.material as { plugins?: unknown } | null)?.plugins) dirtyMaterials.add(mesh.material as OwnPbrMaterial);
  mesh._remade();
}

/** The matrices it is drawn at, kept as the CPU's copy, `count` of them. */
export function setThinInstances(mesh: Mesh, matrices: Float32Array | Float64Array, count: number): void {
  const had = mesh.thinInstances;
  mesh.thinInstances = { matrices, count, colors: had?.colors ?? null };
  mesh._dirty.instances = true;
  mesh.engine._dirtyMeshes.add(mesh);
  had ? mesh._changed(!had.count !== !count) : mesh._remade();
}

/** The first `count` matrices drawn, written again from the same array. */
export function setThinInstanceCount(mesh: Mesh, count: number): void {
  const ti = mesh.thinInstances;
  if (!ti) return;
  // An empty mesh is not drawn at all: emptied or filled, the lists gather again.
  const drawn = !ti.count !== !count;
  ti.count = count;
  mesh._dirty.instances = true;
  mesh.engine._dirtyMeshes.add(mesh);
  mesh._changed(drawn);
}

export function setThinInstanceColors(mesh: Mesh, colors: Float32Array): void {
  const ti = mesh.thinInstances;
  if (!ti) return;
  const had = !!ti.colors;
  ti.colors = colors;
  mesh._dirty.colors = true;
  mesh.engine._dirtyMeshes.add(mesh);
  if (!had) mesh._remade();
}

export function flushThinInstances(mesh: Mesh): void {
  mesh._dirty.instances = true;
  mesh._touched++;
  mesh._flush();
}
