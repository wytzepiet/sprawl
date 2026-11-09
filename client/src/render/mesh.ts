import type { Engine } from "./engine";
import type { Scene } from "./scene";

const VERTEX = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;

/** What a mesh holds on the GPU: its buffers by the name the shaders know
 *  them by ("position", "normal", "uv", "color", "instances",
 *  "instanceColors", and the plugins' own), its world and its draw's args. */
export interface MeshGpu {
  indexCount: number;
  vertexCount: number;
  index: GPUBuffer;
  buffers: Map<string, GPUBuffer>;
  /** `drawIndexedIndirect`'s five words: the instance count changes without re-encoding. */
  args: GPUBuffer;
  world: GPUBuffer;
  group: GPUBindGroup | null;
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
  /** Bumped when what it is drawn with is new: its buffers, its material's bindings. */
  _version = 0;
  /** What the GPU must be given before the next frame. */
  _dirty = { world: true, instances: false, colors: false };
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
    this._changed(true);
  }

  /** Something about it changed: what it is drawn with (`drawn`), or only
   *  what it shows (`moved`, its world written before the next frame). */
  _changed(drawn: boolean, moved = false) {
    if (moved) (this._dirty.world = true), this.engine._dirtyMeshes.add(this);
    if (drawn) this._version++;
    for (const s of this._scenes) s._meshChanged(this, drawn);
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
      if (grow(this, "instances", floats * 4)) this._changed(true);
      const data = ti.matrices instanceof Float32Array ? ti.matrices : Float32Array.from(ti.matrices);
      if (floats) device.queue.writeBuffer(gpu.buffers.get("instances")!, 0, data.buffer, data.byteOffset, Math.min(floats, data.length) * 4);
      device.queue.writeBuffer(gpu.args, 4, new Uint32Array([ti.count]));
      this._dirty.instances = false;
    }
    if (ti?.colors && this._dirty.colors) {
      if (grow(this, "instanceColors", ti.colors.byteLength)) this._changed(true);
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
    args: buffer(engine, new Uint32Array([indices.length, 1, 0, 0, 0]), GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST),
    world: engine._device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    group: null,
  };
  return new Mesh(engine, name, gpu);
}

/** Positions written over in place, from `vertexOffset`. */
export function updateMeshPositions(engine: Engine, mesh: Mesh, positions: Float32Array, vertexOffset = 0, count?: number, sourceOffset = 0): void {
  const n = count ?? positions.length / 3 - sourceOffset;
  engine._device.queue.writeBuffer(mesh._gpu.buffers.get("position")!, vertexOffset * 12, positions.buffer, positions.byteOffset + sourceOffset * 12, n * 12);
  mesh._changed(false);
}

/** A plugin's attribute buffer, grown when it must be. */
export function setMeshAttribute(engine: Engine, mesh: Mesh, name: string, data: Float32Array): void {
  if (grow(mesh, name, data.byteLength)) mesh._changed(true);
  engine._device.queue.writeBuffer(mesh._gpu.buffers.get(name)!, 0, data.buffer, data.byteOffset, data.byteLength);
  mesh._changed(false);
}

export function setMeshVisible(mesh: Mesh, visible: boolean): void {
  if (mesh.visible === visible) return;
  mesh.visible = visible;
  mesh._changed(true);
}

export function disposeMeshGpu(mesh: Mesh): void {
  const gpu = mesh._gpu;
  for (const b of gpu.buffers.values()) b.destroy();
  gpu.index.destroy();
  gpu.args.destroy();
  gpu.world.destroy();
}

/** Its bindings made again: a texture of its material's was replaced. */
export function markMeshRenderableDirty(mesh: Mesh): void {
  mesh._changed(true);
}

/** The matrices it is drawn at, kept as the CPU's copy, `count` of them. */
export function setThinInstances(mesh: Mesh, matrices: Float32Array | Float64Array, count: number): void {
  const had = !!mesh.thinInstances;
  mesh.thinInstances = { matrices, count, colors: mesh.thinInstances?.colors ?? null };
  mesh._dirty.instances = true;
  mesh.engine._dirtyMeshes.add(mesh);
  mesh._changed(!had);
}

/** The first `count` matrices drawn, written again from the same array. */
export function setThinInstanceCount(mesh: Mesh, count: number): void {
  const ti = mesh.thinInstances;
  if (!ti) return;
  ti.count = count;
  mesh._dirty.instances = true;
  mesh.engine._dirtyMeshes.add(mesh);
  mesh._changed(false);
}

export function setThinInstanceColors(mesh: Mesh, colors: Float32Array): void {
  const ti = mesh.thinInstances;
  if (!ti) return;
  const had = !!ti.colors;
  ti.colors = colors;
  mesh._dirty.colors = true;
  mesh.engine._dirtyMeshes.add(mesh);
  if (!had) mesh._changed(true);
}

export function flushThinInstances(mesh: Mesh): void {
  mesh._dirty.instances = true;
  mesh._flush();
}
