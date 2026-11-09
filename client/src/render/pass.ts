import { perfCount } from "../engine/PerfReport";
import { bindGroupLayouts, compose, type Composed, type Pass, type VertexLayout } from "./compose";
import type { Engine } from "./engine";
import { materialTextures, writeMaterialUbo, type OwnPbrMaterial } from "./material";
import type { Mesh } from "./mesh";
import { isShaderMaterial, shaderDraw } from "./shader";

/**
 * A pass's draws, kept as one render bundle: re-encoded only when what it
 * draws changed (a mesh in or out, shown or hidden, a buffer or material
 * new, a pipeline ready), and replayed every time it is drawn.
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

export class DrawList {
  private bundle: GPURenderBundle | null = null;
  private count = 0;
  /** What it draws changed since it was encoded. */
  dirty = true;
  /** The epoch it was encoded at, if a draw in it was left out for a pipeline or binds a shader material's textures. */
  private waiting = -1;
  /** The meshes it drew, at their last encoding. */
  drawn = new Set<Mesh>();

  constructor(
    private engine: Engine,
    readonly pass: Pass,
    readonly targets: Targets,
    /** The meshes it draws, in order, and with which material (an override, as the outline's mask). */
    private meshes: () => Iterable<[Mesh, unknown]>,
    /** Groups 0 and 3: the pass's scene, and its resources. */
    private shared: () => (GPUBindGroup | null)[],
  ) {}

  /** Replay it into a pass, encoding it again first if it changed. */
  draw(pass: GPURenderPassEncoder) {
    if (this.waiting >= 0 && this.waiting !== epoch) this.dirty = true;
    if (this.dirty) this.encode();
    if (!this.bundle) return;
    pass.executeBundles([this.bundle]);
    this.engine.drawCallCount += this.count;
  }

  private encode() {
    const began = performance.now();
    this.dirty = false;
    this.waiting = -1;
    const device = this.engine._device;
    const encoder = device.createRenderBundleEncoder({ colorFormats: this.targets.colors.map((c) => c.format), depthStencilFormat: this.targets.depth });
    const shared = this.shared();
    shared.forEach((g, i) => g && encoder.setBindGroup(i === 0 ? 0 : 3, g));
    let last: GPURenderPipeline | null = null;
    this.count = 0;
    this.drawn.clear();
    for (const [mesh, material] of this.meshes()) {
      const d = drawOf(this.engine, this, mesh, material);
      if (!d) {
        if (d === undefined) this.waiting = epoch;
        continue;
      }
      if (isShaderMaterial(material)) this.waiting = epoch;
      if (d.pipeline !== last) encoder.setPipeline((last = d.pipeline));
      d.groups.forEach((g, i) => encoder.setBindGroup(i + 1, g));
      d.buffers.forEach((b, i) => encoder.setVertexBuffer(i, b));
      encoder.setIndexBuffer(mesh._gpu.index, "uint32");
      encoder.drawIndexedIndirect(mesh._gpu.args, 0);
      this.count++;
      this.drawn.add(mesh);
    }
    this.bundle = encoder.finish();
    count("bundles", 1);
    count("bundleMs", performance.now() - began);
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
  const key = `${c.key}|${JSON.stringify(t)}`;
  const pipeline = pipelineOf(engine, key, () => {
    const module = device.createShaderModule({ code: c.code, label: c.key });
    return {
      layout: device.createPipelineLayout({ bindGroupLayouts: groupLayouts }),
      vertex: { module, entryPoint: "vs", buffers: c.vertexBuffers },
      fragment: { module, entryPoint: "fs", targets: t.colors },
      primitive: { topology: "triangle-list", cullMode: c.doubleSided ? "none" : "back", frontFace: "ccw" },
      depthStencil: { format: t.depth, depthWriteEnabled: t.depthWrite, depthCompare: t.depthCompare },
    };
  });
  if (!pipeline) return pipeline;
  return { pipeline, groups: [materialGroup(engine, m, c, groupLayouts[1]!), meshGroup(engine, mesh)], buffers: buffers as GPUBuffer[], mesh };
}
