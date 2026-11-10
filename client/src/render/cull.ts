import type { Mesh } from "./mesh";
import { count, layoutOf } from "./pass";

/**
 * Thin instances culled to a view on the GPU, for the lists drawn once a
 * picture (the G-buffer, the still map): each instance's sphere tested
 * against the view's sides, and those in it packed, with what each carries
 * (its colour, a plugin's own), into buffers of the draw's own, and counted
 * into its draw's args. The town's houses are a few buckets of instances
 * town-wide, and a picture sees a fifth of them.
 */

/** How far past its geometry's sphere an instance may be drawn, in tiles:
 *  what the plugins move in the vertex shader (a deck's lift, a tree's
 *  card turned to the sun) stays inside it. */
const MARGIN = 2;
const GROUP = 64;

const CULL = /* wgsl */ `
struct View { planes: array<vec4f, 4> }
struct Mesh { world: mat4x4f, flags: vec4f, sphere: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<uniform> mesh: Mesh;
@group(1) @binding(1) var<storage, read> counts: array<u32>;
@group(1) @binding(2) var<storage, read> src: array<mat4x4f>;
@group(1) @binding(3) var<storage, read_write> args: array<atomic<u32>>;
@group(1) @binding(4) var<storage, read_write> dst: array<mat4x4f>;
@group(1) @binding(5) var<storage, read_write> slots: array<u32>;
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= counts[1]) { return; }
  let m = mesh.world * src[i];
  let c = (m * vec4f(mesh.sphere.xyz, 1.)).xyz;
  let r = mesh.sphere.w * max(length(m[0].xyz), max(length(m[1].xyz), length(m[2].xyz))) + ${MARGIN}.;
  for (var k = 0u; k < 4u; k++) {
    if (dot(view.planes[k].xyz, c) + view.planes[k].w < -r) { slots[i] = 0xffffffffu; return; }
  }
  let at = atomicAdd(&args[1], 1u);
  dst[at] = src[i];
  slots[i] = at;
}`;

/** What else an instance carries, moved with it: `stride` words a slot. */
const COPY = /* wgsl */ `
@group(0) @binding(0) var<uniform> stride: vec4u;
@group(1) @binding(0) var<storage, read> counts: array<u32>;
@group(1) @binding(1) var<storage, read> slots: array<u32>;
@group(1) @binding(2) var<storage, read> src: array<u32>;
@group(1) @binding(3) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= counts[1]) { return; }
  let at = slots[i];
  if (at == 0xffffffffu) { return; }
  let n = stride.x;
  for (var w = 0u; w < n; w++) { dst[at * n + w] = src[i * n + w]; }
}`;

/** A mesh's draw as culled: its args, the buffers it reads in place of its
 *  own per-instance ones, and the groups that fill them. */
interface Culled {
  args: GPUBuffer;
  made: GPUBuffer[];
  cull: GPUBindGroup;
  copies: [GPUBindGroup, GPUBindGroup][];
  workgroups: number;
}

const storage = (type: GPUBufferBindingType) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });

export class InstanceCuller {
  private view: GPUBuffer;
  private viewGroup: GPUBindGroup;
  private culled = new WeakMap<Mesh, Culled>();
  private strides = new Map<number, GPUBindGroup>();
  private pipelines: { cull: GPUComputePipeline; copy: GPUComputePipeline };
  private layouts: { view: GPUBindGroupLayout; cull: GPUBindGroupLayout; copy: GPUBindGroupLayout };

  constructor(private device: GPUDevice) {
    const uniform = { visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } };
    const view = layoutOf(device, { entries: [{ binding: 0, ...uniform }] });
    const cull = layoutOf(device, { entries: [{ binding: 0, ...uniform }, { binding: 1, ...storage("read-only-storage") }, { binding: 2, ...storage("read-only-storage") }, { binding: 3, ...storage("storage") }, { binding: 4, ...storage("storage") }, { binding: 5, ...storage("storage") }] });
    const copy = layoutOf(device, { entries: [0, 1, 2].map((binding) => ({ binding, ...storage("read-only-storage") })).concat([{ binding: 3, ...storage("storage") }]) });
    this.layouts = { view, cull, copy };
    const pipeline = (code: string, group: GPUBindGroupLayout) => {
      count("pipelines", 1);
      return device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [view, group] }), compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    };
    this.pipelines = { cull: pipeline(CULL, cull), copy: pipeline(COPY, copy) };
    this.view = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewGroup = device.createBindGroup({ layout: view, entries: [{ binding: 0, resource: { buffer: this.view } }] });
  }

  /** The buffers and args a mesh's draw reads, culled, in place of `buffers`
   *  (laid out as `layouts`): made anew, as its draw is encoded anew. */
  make(mesh: Mesh, layouts: GPUVertexBufferLayout[], buffers: GPUBuffer[]): { buffers: GPUBuffer[]; args: GPUBuffer } {
    const device = this.device;
    const old = this.culled.get(mesh);
    if (old) for (const b of [old.args, ...old.made]) b.destroy();
    const gpu = mesh._gpu;
    const src = gpu.buffers.get("instances")!;
    const capacity = Math.floor(src.size / 64);
    const args = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint32Array(args.getMappedRange()).set([gpu.indexCount, 0, 0, 0, 0]);
    args.unmap();
    const made: GPUBuffer[] = [];
    const out = buffers.map((b, i) => {
      if (layouts[i]!.stepMode !== "instance") return b;
      const m = device.createBuffer({ size: b.size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE });
      made.push(m);
      return m;
    });
    const slots = device.createBuffer({ size: capacity * 4, usage: GPUBufferUsage.STORAGE });
    made.push(slots);
    const dst = out[buffers.indexOf(src)]!;
    const bind = (layout: GPUBindGroupLayout, list: GPUBuffer[]) => device.createBindGroup({ layout, entries: list.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const cull = bind(this.layouts.cull, [gpu.world, gpu.args, src, args, dst, slots]);
    const copies = buffers.flatMap((b, i): [GPUBindGroup, GPUBindGroup][] => (b === src || layouts[i]!.stepMode !== "instance" ? [] : [[this.stride(layouts[i]!.arrayStride / 4), bind(this.layouts.copy, [gpu.args, slots, b, out[i]!])]]));
    this.culled.set(mesh, { args, made, cull, copies, workgroups: Math.ceil(capacity / GROUP) });
    return { buffers: out, args };
  }

  /** The meshes' instances culled to the sides of `vp`'s view. */
  run(encoder: GPUCommandEncoder, vp: ArrayLike<number>, meshes: Iterable<Mesh>) {
    const all = [...meshes].flatMap((m) => this.culled.get(m) ?? []);
    if (!all.length) return;
    this.device.queue.writeBuffer(this.view, 0, planes(vp));
    for (const c of all) encoder.clearBuffer(c.args, 4, 4);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipelines.cull);
    pass.setBindGroup(0, this.viewGroup);
    for (const c of all) pass.setBindGroup(1, c.cull), pass.dispatchWorkgroups(c.workgroups);
    pass.setPipeline(this.pipelines.copy);
    for (const c of all) for (const [stride, group] of c.copies) pass.setBindGroup(0, stride), pass.setBindGroup(1, group), pass.dispatchWorkgroups(c.workgroups);
    pass.end();
  }

  private stride(words: number): GPUBindGroup {
    let g = this.strides.get(words);
    if (!g) {
      const buffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(buffer.getMappedRange()).set([words, 0, 0, 0]);
      buffer.unmap();
      this.strides.set(words, (g = this.device.createBindGroup({ layout: this.layouts.view, entries: [{ binding: 0, resource: { buffer } }] })));
    }
    return g;
  }
}

/** How many of a mesh's thin instances stand in a view (`planes`), as the
 *  GPU culls them but for their scale: what its draw will cost. */
export function seen(mesh: Mesh, sides: Float32Array): number {
  const ti = mesh.thinInstances;
  if (!ti) return 1;
  const [sx, sy, sz, sr] = mesh._gpu.sphere;
  const p = mesh.position;
  const r = sr + MARGIN;
  const m = ti.matrices;
  let n = 0;
  next: for (let i = 0; i < ti.count; i++) {
    const o = i * 16;
    const x = m[o]! * sx + m[o + 4]! * sy + m[o + 8]! * sz + m[o + 12]! + p.x;
    const y = m[o + 1]! * sx + m[o + 5]! * sy + m[o + 9]! * sz + m[o + 13]! + p.y;
    const z = m[o + 2]! * sx + m[o + 6]! * sy + m[o + 10]! * sz + m[o + 14]! + p.z;
    for (let k = 0; k < 16; k += 4) if (sides[k]! * x + sides[k + 1]! * y + sides[k + 2]! * z + sides[k + 3]! < -r) continue next;
    n++;
  }
  return n;
}

/** A view's four sides, from its matrix (column major), each normalised:
 *  a point is inside where every `n · p + d` is at least 0. Near and far
 *  are left open: what is behind the eye is cut by the sides of a
 *  perspective, and what casts from above the sun's box still falls in it. */
export function planes(vp: ArrayLike<number>): Float32Array<ArrayBuffer> {
  const row = (i: number) => [vp[i]!, vp[4 + i]!, vp[8 + i]!, vp[12 + i]!];
  const [x, y, w] = [row(0), row(1), row(3)];
  const out = new Float32Array(16);
  [w.map((v, k) => v + x[k]!), w.map((v, k) => v - x[k]!), w.map((v, k) => v + y[k]!), w.map((v, k) => v - y[k]!)].forEach((p, i) => {
    const len = Math.hypot(p[0]!, p[1]!, p[2]!) || 1;
    out.set(p.map((v) => v / len), i * 4);
  });
  return out;
}
