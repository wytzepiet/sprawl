import { SCENE_WGSL } from "./compose";
import type { Engine } from "./engine";
import type { Mesh } from "./mesh";
import { bump, DrawList, layoutOf, pipelineOf, type Draw, type Targets } from "./pass";
import type { Scene } from "./scene";
import type { Texture2D } from "./texture";

/**
 * A material written whole in WGSL (the outline's quad): Lite's prelude
 * (`scene`, `shaderUniforms` in declared order, each sampler `x` as `x` and
 * `xSampler`), entry points `mainVertex` and `mainFragment`. And the render
 * task and target the outline draws its mask with.
 */
export interface ShaderMaterial {
  _shader: true;
  name: string;
  code: string;
  uniforms: { name: string; type: string }[];
  samplers: string[];
  backFaceCulling: boolean;
  depthWrite: boolean;
  depthCompare: GPUCompareFunction;
  blend: GPUBlendState | undefined;
  data: Float32Array<ArrayBuffer>;
  offsets: Map<string, number>;
  textures: Map<string, Texture2D>;
  ubo: GPUBuffer | null;
  group: GPUBindGroup | null;
  dirty: boolean;
}

export const isShaderMaterial = (m: unknown): m is ShaderMaterial => !!(m as ShaderMaterial | null)?._shader;

const SIZE: Record<string, [number, number]> = { f32: [1, 1], vec2: [2, 2], "vec2<f32>": [2, 2], vec4: [4, 4], "vec4<f32>": [4, 4], mat4: [4, 16], "mat4x4<f32>": [4, 16] };
const WGSL: Record<string, string> = { f32: "f32", vec2: "vec2<f32>", vec4: "vec4<f32>", mat4: "mat4x4<f32>" };

export function createShaderMaterial(o: {
  name: string;
  vertexSource: string;
  fragmentSource: string;
  uniforms?: { name: string; type: string }[];
  samplers?: (string | { name: string })[];
  backFaceCulling?: boolean;
  depthWrite?: boolean;
  depthCompare?: GPUCompareFunction;
  needAlphaBlending?: boolean;
  blendMode?: string;
}): ShaderMaterial {
  const uniforms = o.uniforms ?? [];
  const offsets = new Map<string, number>();
  let at = 0;
  for (const u of uniforms) {
    const [align, size] = SIZE[u.type]!;
    at = Math.ceil(at / align) * align;
    offsets.set(u.name, at);
    at += size;
  }
  const samplers = (o.samplers ?? []).map((s) => (typeof s === "string" ? s : s.name));
  const code = `${SCENE_WGSL}
struct VertexInput { @location(0) position: vec3f, }
struct ShaderUniforms { ${uniforms.map((u) => `${u.name}: ${WGSL[u.type] ?? u.type},`).join(" ")} _pad: vec4f, }
@group(1) @binding(0) var<uniform> shaderUniforms: ShaderUniforms;
${samplers.map((s, i) => `@group(1) @binding(${1 + 2 * i}) var ${s}: texture_2d<f32>;\n@group(1) @binding(${2 + 2 * i}) var ${s}Sampler: sampler;`).join("\n")}
${o.vertexSource}
${o.fragmentSource}`;
  const additive = o.blendMode === "additive";
  return {
    _shader: true,
    name: o.name,
    code,
    uniforms,
    samplers,
    backFaceCulling: o.backFaceCulling ?? true,
    depthWrite: o.depthWrite ?? true,
    depthCompare: o.depthCompare ?? "greater-equal",
    blend: o.needAlphaBlending
      ? { color: { srcFactor: "src-alpha", dstFactor: additive ? "one" : "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: additive ? "one" : "one-minus-src-alpha" } }
      : undefined,
    data: new Float32Array(Math.ceil((at + 4) / 4) * 4),
    offsets,
    textures: new Map(),
    ubo: null,
    group: null,
    dirty: true,
  };
}

export function setShaderUniform(m: ShaderMaterial, name: string, value: number | ArrayLike<number>): void {
  const at = m.offsets.get(name);
  if (at === undefined) return;
  if (typeof value === "number") m.data[at] = value;
  else m.data.set(value, at);
  m.dirty = true;
}

export function setShaderTexture(m: ShaderMaterial, name: string, tex: Texture2D | null): void {
  if (!tex) return;
  m.textures.set(name, tex);
  m.group = null;
  bump();
}

/** The draw of a mesh with a shader material, in a forward pass. */
export function shaderDraw(engine: Engine, targets: Targets, mesh: Mesh, m: ShaderMaterial): Draw | null | undefined {
  const device = engine._device;
  if (m.samplers.some((s) => !m.textures.has(s))) return null;
  const layout = layoutOf(device, {
    entries: [
      { binding: 0, visibility: 3, buffer: { type: "uniform" } },
      ...m.samplers.flatMap((_, i): GPUBindGroupLayoutEntry[] => [
        { binding: 1 + 2 * i, visibility: 3, texture: {} },
        { binding: 2 + 2 * i, visibility: 3, sampler: {} },
      ]),
    ],
  });
  const scene = layoutOf(device, { entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }] });
  const pipeline = pipelineOf(engine, `shader:${m.name}|${JSON.stringify(targets)}`, () => {
    const module = device.createShaderModule({ code: m.code, label: m.name });
    return {
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, layout] }),
      vertex: { module, entryPoint: "mainVertex", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module, entryPoint: "mainFragment", targets: targets.colors.map((c) => ({ format: c.format, blend: m.blend })) },
      primitive: { topology: "triangle-list", cullMode: m.backFaceCulling ? "back" : "none" },
      depthStencil: { format: targets.depth, depthWriteEnabled: m.depthWrite, depthCompare: m.depthCompare },
    };
  });
  if (!pipeline) return pipeline;
  m.ubo ??= device.createBuffer({ size: m.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  if (m.dirty) device.queue.writeBuffer(m.ubo, 0, m.data), (m.dirty = false);
  shaders.add(m);
  m.group ??= device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: m.ubo } },
      ...m.samplers.flatMap((s, i) => [
        { binding: 1 + 2 * i, resource: m.textures.get(s)!.view },
        { binding: 2 + 2 * i, resource: m.textures.get(s)!.sampler },
      ]),
    ],
  });
  return { pipeline, groups: [m.group], buffers: [mesh._gpu.buffers.get("position")!], layouts: [], mesh };
}

/** Shader materials drawn: their uniforms written as the frame begins. */
const shaders = new Set<ShaderMaterial>();
export function writeShaderUniforms(engine: Engine) {
  for (const m of shaders) if (m.dirty && m.ubo) engine._device.queue.writeBuffer(m.ubo, 0, m.data), (m.dirty = false);
}

/** A target the size of a surface; made again with it, and those who bound it told. */
export interface RenderTargetTexture {
  rt: { surface: { canvas: { width: number; height: number } }; scale: number; format: GPUTextureFormat };
  texture: Texture2D;
  _resized: (() => void)[];
}

export function createSurfaceRenderTargetTexture(engine: Engine, d: { format: GPUTextureFormat; size: unknown }): RenderTargetTexture {
  const s = d.size as { surface?: unknown; scale?: number };
  const surface = (s.surface ?? s) as RenderTargetTexture["rt"]["surface"];
  const sampler = engine._device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const blank = engine._device.createTexture({ size: [1, 1], format: d.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const rtt: RenderTargetTexture = { rt: { surface, scale: s.scale ?? 1, format: d.format }, texture: { texture: blank, view: blank.createView(), sampler, width: 1, height: 1 }, _resized: [] };
  rtts.set(rtt.rt, rtt);
  return rtt;
}

export function onRenderTargetTextureResize(rtt: RenderTargetTexture, cb: () => void): () => void {
  rtt._resized.push(cb);
  return () => void rtt._resized.splice(rtt._resized.indexOf(cb), 1);
}

export interface RenderTask {
  name: string;
  enabled: boolean;
  executionEnabled: boolean;
  _config: { rt?: RenderTargetTexture["rt"]; clrColor?: { r: number; g: number; b: number; a: number } };
  _meshes: Map<Mesh, unknown>;
  _rtt: RenderTargetTexture | null;
  _list: DrawList | null;
  _depth: GPUTexture | null;
}

const rtts = new WeakMap<object, RenderTargetTexture>();
const tasksOf = new WeakMap<Scene, RenderTask[]>();

export function createRenderTask(config: RenderTask["_config"], _engine: Engine, _scene: Scene): RenderTask {
  return { name: (config as { name?: string }).name ?? "task", enabled: true, executionEnabled: true, _config: config, _meshes: new Map(), _rtt: null, _list: null, _depth: null };
}
export function addTaskAtStart(scene: Scene, task: RenderTask): void {
  const list = tasksOf.get(scene) ?? tasksOf.set(scene, []).get(scene)!;
  list.push(task);
}
export function addMeshToTask(task: RenderTask, mesh: Mesh, opts: { material?: unknown } = {}): void {
  task._meshes.set(mesh, opts.material ?? mesh.material);
}
export function removeMeshFromTask(task: RenderTask, mesh: Mesh): void {
  task._meshes.delete(mesh);
}

/** The scene's tasks that are on, each into its target with its own meshes, before the frame. */
export function runTasks(scene: Scene, encoder: GPUCommandEncoder, sceneGroup: GPUBindGroup, resources: () => GPUBindGroup, w: number, h: number) {
  for (const task of tasksOf.get(scene) ?? []) {
    if (!task.enabled || !task.executionEnabled || !task._config.rt) continue;
    const rtt = rtts.get(task._config.rt);
    if (!rtt) continue;
    const engine = scene.engine;
    const [tw, th] = [Math.round(w * rtt.rt.scale), Math.round(h * rtt.rt.scale)];
    if (rtt.texture.width !== tw || rtt.texture.height !== th) {
      rtt.texture.texture.destroy();
      task._depth?.destroy();
      const t = engine._device.createTexture({ size: [tw, th], format: rtt.rt.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      Object.assign(rtt.texture, { texture: t, view: t.createView(), width: tw, height: th });
      task._depth = engine._device.createTexture({ size: [tw, th], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
      for (const cb of rtt._resized) cb();
    }
    task._list ??= new DrawList(engine, "forward", { colors: [{ format: rtt.rt.format }], depth: "depth32float", depthWrite: true, depthCompare: "greater-equal" }, () => task._meshes, () => [sceneGroup, resources()]);
    // Few meshes, and ghosts out of any scene that tells it of their changes: encoded each time.
    task._list.dirty = true;
    const c = task._config.clrColor ?? { r: 0, g: 0, b: 0, a: 0 };
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: rtt.texture.view, loadOp: "clear", storeOp: "store", clearValue: c }],
      depthStencilAttachment: { view: task._depth!.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    task._list.draw(pass);
    pass.end();
  }
}
