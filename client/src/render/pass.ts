import { perfCount } from "../engine/PerfReport";
import { bindGroupLayouts, compose, type Composed, type Pass, type VertexLayout } from "./compose";
import type { Engine } from "./engine";
import { materialTextures, writeMaterialUbo, type OwnPbrMaterial } from "./material";
import type { Mesh } from "./mesh";
import { isShaderMaterial, shaderDraw } from "./shader";

/**
 * A pass's draws, recorded into it each frame, direct (no render bundles,
 * indirect draws or culling: Safari stalled on them, ~2 s a frame on an
 * iPhone, and a frame here is a score of draws): a mesh's draw made again only when
 * what it is drawn with changed (its version bumped: a buffer or material
 * new; the pass's shared groups new; a pipeline it waited on ready), and
 * the list of them gathered again only when what is drawn changed (a mesh
 * in or out, shown or hidden, emptied or filled). An empty pool draws nothing.
 */

/** What a pass draws into, part of every pipeline's key. */
export interface Targets {
  colors: GPUColorTargetState[];
  depth: GPUTextureFormat;
  depthWrite: boolean;
  depthCompare: GPUCompareFunction;
}

/** One draw: its pipeline and what is bound for it. */
export interface Draw {
  pipeline: GPURenderPipeline;
  groups: GPUBindGroup[];
  buffers: GPUBuffer[];
  mesh: Mesh;
}

/** A mesh's draw in a list, and what it was made with. */
interface Encoded {
  draw: Draw;
  version: number;
  material: unknown;
  shared: (GPUBindGroup | null)[];
  /** The epoch it was encoded at: a shader material's textures change without its mesh knowing. */
  epoch: number;
}

export class DrawList {
  private encoded = new WeakMap<Mesh, Encoded>();
  /** What it draws changed since it was gathered. */
  dirty = true;
  /** The epoch it was gathered at, if a draw in it was left out for a pipeline or binds a shader material's textures. */
  private waiting = -1;
  /** The meshes it drew, at their last gathering, and in their order. */
  drawn = new Set<Mesh>();
  private order: Mesh[] = [];

  constructor(
    private engine: Engine,
    readonly pass: Pass,
    readonly targets: Targets,
    /** The meshes it draws, in order, and with which material (an override, as the outline's mask). */
    private meshes: () => Iterable<[Mesh, unknown]>,
    /** Groups 0 and 3: the pass's scene, and its resources. */
    private shared: () => (GPUBindGroup | null)[],
  ) {}

  /** Gathered again if what it draws changed. */
  private fresh() {
    if (this.waiting >= 0 && this.waiting !== epoch) this.dirty = true;
    if (this.dirty) this.gather();
  }

  /** Replay it into a pass, gathering it again first if it changed. */
  draw(pass: GPURenderPassEncoder) {
    this.fresh();
    this.drawSome(pass, this.order);
  }

  /** Of the meshes not yet `done`, in order, a share of their weight as if
   *  the rest were spread over `frames` frames, marked done; and how many
   *  are left after them. A mesh weighs its triangles drawn (its
   *  instances' too: the town's houses are most of a picture) and a
   *  screenful's worth of pixels it may cover. */
  share(done: Set<Mesh>, frames: number): { some: Mesh[]; left: number } {
    this.fresh();
    const todo = this.order.filter((m) => !done.has(m));
    const weight = (m: Mesh) => m._gpu.indexCount * (m.thinInstances?.count ?? 1) + 30_000;
    const share = todo.reduce((t, m) => t + weight(m), 0) / Math.max(1, frames);
    let [n, sum] = [0, 0];
    while (n < todo.length && (frames <= 1 || sum < share)) sum += weight(todo[n++]!);
    const some = todo.slice(0, n);
    for (const m of some) done.add(m);
    return { some, left: todo.length - n };
  }

  /** These meshes of it into a pass: each binds only what the one before
   *  it did not, so buckets of one shape and material (`meshLike`) cost
   *  their world, their instances and the draw. */
  drawSome(pass: GPURenderPassEncoder, some: Mesh[]) {
    let was: Encoded | undefined;
    for (const m of some) {
      const e = this.encoded.get(m)!;
      const [d, w] = [e.draw, was?.draw];
      e.shared.forEach((g, i) => g && g !== was?.shared[i] && pass.setBindGroup(i === 0 ? 0 : 3, g));
      if (d.pipeline !== w?.pipeline) pass.setPipeline(d.pipeline);
      d.groups.forEach((g, i) => g !== w?.groups[i] && pass.setBindGroup(i + 1, g));
      d.buffers.forEach((b, i) => b !== w?.buffers[i] && pass.setVertexBuffer(i, b));
      if (m._gpu.index !== w?.mesh._gpu.index) pass.setIndexBuffer(m._gpu.index, "uint32");
      pass.drawIndexed(m._gpu.indexCount, m.thinInstances?.count ?? 1);
      was = e;
    }
    this.engine.drawCallCount += some.length;
  }

  private gather() {
    this.dirty = false;
    this.waiting = -1;
    const shared = this.shared();
    this.drawn.clear();
    this.order.length = 0;
    for (const [mesh, material] of this.meshes()) {
      if (mesh.thinInstances?.count === 0) continue;
      const shader = isShaderMaterial(material);
      let e = this.encoded.get(mesh);
      if (!e || e.version !== mesh._version || e.material !== material || e.shared.some((g, i) => g !== shared[i]) || (shader && e.epoch !== epoch)) {
        e = this.encode(mesh, material, shared);
        if (!e) continue;
      }
      if (shader) this.waiting = epoch;
      this.drawn.add(mesh);
      this.order.push(mesh);
    }
  }

  private encode(mesh: Mesh, material: unknown, shared: (GPUBindGroup | null)[]): Encoded | undefined {
    const began = performance.now();
    this.encoded.delete(mesh);
    const d = drawOf(this.engine, this, mesh, material);
    if (!d) {
      if (d === undefined) this.waiting = epoch;
      return undefined;
    }
    const e: Encoded = { draw: d, version: mesh._version, material, shared, epoch };
    this.encoded.set(mesh, e);
    count("encodes", 1);
    count("encodeMs", performance.now() - began);
    return e;
  }
}

/** What the renderer did, summed since it began (`engine.stats`), and told to the bench as `own.*`. */
export const stats: Record<string, number> = {};
export function count(name: string, by = 1) {
  stats[name] = (stats[name] ?? 0) + by;
  perfCount(`own.${name}`, by);
}

/** Bumped whenever a pipeline is ready or a shader material's textures change: lists waiting on it encode again. */
let epoch = 0;
export const bump = () => void epoch++;

const layouts = new WeakMap<GPUDevice, Map<string, GPUBindGroupLayout>>();
export function layoutOf(device: GPUDevice, desc: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
  const byKey = layouts.get(device) ?? layouts.set(device, new Map()).get(device)!;
  const key = JSON.stringify(desc);
  return byKey.get(key) ?? byKey.set(key, device.createBindGroupLayout(desc)).get(key)!;
}

/** A pipeline by key, built once for the engine, off the frame: `undefined`
 *  while it builds, `null` if it never will. */
export function pipelineOf(engine: Engine, key: string, make: () => GPURenderPipelineDescriptor): GPURenderPipeline | null | undefined {
  if (engine._pipelines.has(key)) return engine._pipelines.get(key);
  if (building.has(key)) return undefined;
  const desc = make();
  engine._building++;
  count("pipelines", 1);
  const pending = engine._device.createRenderPipelineAsync(desc).then(
    (p) => p,
    async (e) => {
      const info = await (desc.vertex.module as GPUShaderModule).getCompilationInfo?.();
      console.error(`[renderer] pipeline ${key}:`, e?.message ?? e, info?.messages.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"));
      return null;
    },
  );
  building.set(key, pending);
  void pending.then((p) => {
    engine._pipelines.set(key, p);
    building.delete(key);
    engine._building--;
    epoch++;
  });
  return undefined;
}
const building = new Map<string, Promise<GPURenderPipeline | null>>();

const composedOf = new WeakMap<OwnPbrMaterial, Map<string, Composed>>();
function composedFor(material: OwnPbrMaterial, pass: Pass, layout: VertexLayout): Composed {
  const byKey = composedOf.get(material) ?? composedOf.set(material, new Map()).get(material)!;
  const key = `${pass}${+layout.uv}${+layout.colors}${+layout.instances}${+layout.instanceColors}`;
  return byKey.get(key) ?? byKey.set(key, compose(material, pass, layout)).get(key)!;
}

/** A material's UBO and its bindings, made once, its UBO written again when marked. */
interface MaterialGpu {
  ubo: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  offsets: ReadonlyMap<string, number>;
  version: number;
  groups: Map<string, { group: GPUBindGroup; textures: unknown[] }>;
}
const materialsOf = new WeakMap<object, MaterialGpu>();
/** Materials marked since the last frame (`markMaterialUboDirty`). */
export const dirtyMaterials = new Set<OwnPbrMaterial>();

export function writeDirtyMaterials(engine: Engine) {
  for (const m of dirtyMaterials) {
    const g = materialsOf.get(m);
    if (g) writeUbo(engine, m, g);
  }
  dirtyMaterials.clear();
}
function writeUbo(engine: Engine, m: OwnPbrMaterial, g: MaterialGpu) {
  writeMaterialUbo(m, g.offsets, g.data);
  engine._device.queue.writeBuffer(g.ubo, 0, g.data);
  g.version = m._uboVersion;
}

/** The material's group 1 for a composed shader, made again when its textures are new. */
function materialGroup(engine: Engine, material: OwnPbrMaterial, c: Composed, layout: GPUBindGroupLayout): GPUBindGroup {
  let g = materialsOf.get(material);
  if (!g) {
    const data = new Float32Array(c.materialUbo.size / 4);
    g = { ubo: engine._device.createBuffer({ size: Math.max(16, c.materialUbo.size), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), data, offsets: c.materialUbo.offsets, version: -1, groups: new Map() };
    materialsOf.set(material, g);
    writeUbo(engine, material, g);
  }
  const textures = materialTextures(material);
  const key = JSON.stringify(c.materialTextures);
  const had = g.groups.get(key);
  if (had && had.textures.length === textures.length && had.textures.every((t, i) => t === textures[i])) return had.group;
  const group = engine._device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: g.ubo } },
      ...textures.flatMap((t, i) => [
        { binding: 1 + 2 * i, resource: t.view },
        { binding: 2 + 2 * i, resource: t.sampler },
      ]),
    ],
  });
  g.groups.set(key, { group, textures });
  return group;
}

function meshGroup(engine: Engine, mesh: Mesh): GPUBindGroup {
  const gpu = mesh._gpu;
  return (gpu.group ??= engine._device.createBindGroup({
    layout: layoutOf(engine._device, { entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }] }),
    entries: [{ binding: 0, resource: { buffer: gpu.world } }],
  }));
}

/** How far in front one thing lying on another is (`Mesh.lies`), in the
 *  least steps of depth the GPU tells apart there. */
const LIE = 64;

/** How a mesh is drawn in a list: `undefined` while its pipeline builds, `null` if it is not drawn there. */
function drawOf(engine: Engine, list: DrawList, mesh: Mesh, material: unknown): Draw | null | undefined {
  if (isShaderMaterial(material)) return list.pass === "forward" ? shaderDraw(engine, list.targets, mesh, material) : null;
  const m = material as OwnPbrMaterial | null;
  if (!m?.plugins) return null;
  const gpu = mesh._gpu;
  const layout: VertexLayout = { uv: gpu.buffers.has("uv"), colors: gpu.buffers.has("color"), instances: !!mesh.thinInstances, instanceColors: !!mesh.thinInstances?.colors };
  const c = composedFor(m, list.pass, layout);
  const buffers = c.bufferOrder.map((n) => gpu.buffers.get(n));
  if (buffers.some((b) => !b)) return null;
  const device = engine._device;
  const groupLayouts = bindGroupLayouts(c).map((d) => layoutOf(device, d));
  const t = list.targets;
  // What lies on another is in its plane, and in front of it by its depth
  // alone, nudged as the GPU nudges it: not in the sun's map, where a
  // sheet casts nothing on the one it lies on either way.
  const lies = t.depthCompare === "greater-equal" ? mesh.lies : 0;
  const key = `${c.key}|${JSON.stringify(t)}|${lies}`;
  const pipeline = pipelineOf(engine, key, () => {
    const module = device.createShaderModule({ code: c.code, label: c.key });
    return {
      layout: device.createPipelineLayout({ bindGroupLayouts: groupLayouts }),
      vertex: { module, entryPoint: "vs", buffers: c.vertexBuffers },
      fragment: { module, entryPoint: "fs", targets: t.colors },
      primitive: { topology: "triangle-list", cullMode: c.doubleSided ? "none" : "back", frontFace: "ccw" },
      depthStencil: { format: t.depth, depthWriteEnabled: t.depthWrite, depthCompare: t.depthCompare, depthBias: lies * LIE, depthBiasSlopeScale: lies },
    };
  });
  if (!pipeline) return pipeline;
  return { pipeline, groups: [materialGroup(engine, m, c, groupLayouts[1]!), meshGroup(engine, mesh)], buffers: buffers as GPUBuffer[], mesh };
}
