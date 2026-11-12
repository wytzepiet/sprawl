import type { Engine } from "./engine";
import { createTexture2DFromPixels, mipmaps, type Texture2D } from "./texture";
import { perfMark, run } from "../engine/PerfReport";

/** What `draw` makes for an engine, made once, the first time it is asked
 *  for; and, in a bench, when it was asked for and when the GPU had drawn
 *  it (`PerfReport.tsx`). */
export function drawnOnce<T>(name: string, draw: (engine: Engine) => T): (engine: Engine) => T {
  const made = new WeakMap<Engine, T>();
  return (engine) => {
    if (!made.has(engine)) {
      const began = performance.now();
      made.set(engine, draw(engine));
      whenDrawn(engine, name, began);
    }
    return made.get(engine)!;
  };
}
/** A bench's marks of something drawn: when it began, and when the GPU
 *  had done all it was given by now. */
export function whenDrawn(engine: Engine, name: string, began: number) {
  if (!run) return;
  perfMark(`draw ${name}`, began);
  void engine._device.queue.onSubmittedWorkDone().then(() => perfMark(`drawn ${name}`));
}

/** A texture a shader can fill (`fillTexture`), read smoothly; `tiling`,
 *  one that repeats and is read from far off too, its smaller copies made
 *  as it is filled. */
export function createFilledTexture(engine: Engine, width: number, height: number, format: GPUTextureFormat = "r8unorm", tiling = false): Texture2D {
  const texture = engine._device.createTexture({
    size: { width, height },
    format,
    mipLevelCount: tiling ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const mode = tiling ? "repeat" : "clamp-to-edge";
  const sampler = engine._device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: tiling ? "linear" : "nearest", addressModeU: mode, addressModeV: mode });
  return { texture, view: texture.createView(), sampler, width, height };
}

/** A texture's own texels, as a pass draws on them. */
const top = (t: Texture2D) => t.texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });

const pipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

/** Every texel of `target` worked out on the GPU, once: `code` is WGSL with
 *  `fn fill(at: vec2f) -> vec4f`, `at` the texel's middle in texels, reading
 *  `sources` as `src0`, `src1`… by `textureLoad`. A map that is a value a
 *  pixel, made where pixels are made instead of texel by texel in a worker.
 *  Or only the texels `within` (x, y, wide, high), the rest left as they are. */
export function fillTexture(engine: Engine, target: Texture2D, code: string, sources: Texture2D[], within?: [number, number, number, number]) {
  const device = engine._device;
  const byCode = pipelines.get(device) ?? new Map<string, GPURenderPipeline>();
  pipelines.set(device, byCode);
  const key = `${target.texture.format}|${code}`;
  let pipeline = byCode.get(key);
  if (!pipeline) {
    const module = device.createShaderModule({
      code: `${sources.map((_, k) => `@group(0) @binding(${k}) var src${k}: texture_2d<f32>;`).join("\n")}
${code}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2. - 1., 0., 1.); }
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return fill(p.xy); }`,
    });
    pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: target.texture.format }] } });
    byCode.set(key, pipeline);
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: top(target), loadOp: within ? "load" : "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline);
  if (within) pass.setScissorRect(...within);
  if (sources.length) pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: sources.map((s, k) => ({ binding: k, resource: s.view })) }));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  if (target.texture.mipLevelCount > 1) mipmaps(engine, target.texture);
}

/** A number from 0 to 1, the `k`th of thing `i`, for a stamp's code: the
 *  same every time. */
export const RANDOM = `fn rnd(i: u32, k: u32) -> f32 {
  var h = i * 747796405u + k * 2891336453u + 1u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32(((h >> 22u) ^ h) >> 8u) / 16777216.;
}`;

/** Shapes stamped onto a square `target` that wraps, `count` of them, each
 *  texel keeping the most any gives it, or `add`, their sum: `code` is WGSL with `fn box(i: u32)
 *  -> vec4f`, the texels shape `i` may touch (x0 y0 x1 y1, within the
 *  square or up to its side past it, where it comes round), and `fn
 *  stamp(i: u32, at: vec2f) -> vec4f`, what it gives the texel whose
 *  middle is `at`. Onto what is there, or `first` onto nothing. What a
 *  bake did a shape at a time in a worker, drawn. */
export function stampTexture(engine: Engine, target: Texture2D, code: string, count: number, first: boolean, operation: "max" | "add" = "max") {
  const device = engine._device;
  const byCode = pipelines.get(device) ?? new Map<string, GPURenderPipeline>();
  pipelines.set(device, byCode);
  const key = `${operation}|${target.texture.format}|${target.width}|${code}`;
  let pipeline = byCode.get(key);
  if (!pipeline) {
    const module = device.createShaderModule({
      code: `${code}
struct V { @builtin(position) p: vec4f, @location(0) @interpolate(flat) i: u32, @location(1) @interpolate(flat) round: vec2f }
// Each shape four times: as it lies, and come round each side.
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) n: u32) -> V {
  let b = box(n >> 2u);
  let round = vec2f(f32(n & 1u), f32((n >> 1u) & 1u)) * ${target.width}.;
  let at = mix(b.xy, b.zw, vec2f(f32(v & 1u), f32(v >> 1u))) - round;
  return V(vec4f(at / ${target.width}. * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), n >> 2u, round);
}
@fragment fn fs(v: V) -> @location(0) vec4f { return stamp(v.i, v.p.xy + v.round); }`,
    });
    const blend: GPUBlendComponent = { operation, srcFactor: "one", dstFactor: "one" };
    pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: target.texture.format, blend: { color: blend, alpha: blend } }] },
      primitive: { topology: "triangle-strip" },
    });
    byCode.set(key, pipeline);
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: top(target), loadOp: first ? "clear" : "load", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline);
  pass.draw(4, count * 4);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

/** Shapes as texels, for `layTexture` to read as its first source: twelve
 *  numbers a shape, three texels, so many shapes a row; and WGSL's read of
 *  shape `i` of them. */
const SHAPES_ACROSS = 1024;
export function shapesTexture(engine: Engine, numbers: Float32Array): Texture2D {
  const rows = Math.ceil(numbers.length / 12 / SHAPES_ACROSS);
  const texels = new Float32Array(rows * SHAPES_ACROSS * 12);
  texels.set(numbers);
  return createTexture2DFromPixels(engine, texels, SHAPES_ACROSS * 3, rows, { format: "rgba32float" });
}
export const SHAPE_READ = `fn shapeRead(i: u32) -> array<vec4f, 3> {
  let p = vec2i(i32(i % ${SHAPES_ACROSS}u) * 3, i32(i / ${SHAPES_ACROSS}u));
  return array<vec4f, 3>(textureLoad(src0, p, 0), textureLoad(src0, p + vec2i(1, 0), 0), textureLoad(src0, p + vec2i(2, 0), 0));
}`;

/** Shapes laid onto `target`, `count` of them, the highest at each texel
 *  kept: `code` is WGSL with `fn box(i: u32) -> vec4f`, the texels shape
 *  `i` may touch, and `fn stamp(i: u32, at: vec2f) -> vec4f`, what it is
 *  at the texel whose middle is `at`, its red how high it stands there
 *  (-1 to 2), under -1 where it is not; reading `sources` as `fillTexture`'s
 *  does, the shapes themselves if they come as texels. Where none is,
 *  `clear`. What a bake did a shape at a time, keeping each texel's
 *  height to compare, drawn against a depth. */
export function layTexture(engine: Engine, target: Texture2D, code: string, count: number, sources: Texture2D[], clear: number[]) {
  const device = engine._device;
  const byCode = pipelines.get(device) ?? new Map<string, GPURenderPipeline>();
  pipelines.set(device, byCode);
  const key = `lay|${target.texture.format}|${code}`;
  let pipeline = byCode.get(key);
  if (!pipeline) {
    const module = device.createShaderModule({
      code: `${sources.map((_, k) => `@group(0) @binding(${k}) var src${k}: texture_2d<f32>;`).join("\n")}
${code}
struct V { @builtin(position) p: vec4f, @location(0) @interpolate(flat) i: u32 }
struct F { @location(0) texel: vec4f, @builtin(frag_depth) high: f32 }
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) n: u32) -> V {
  let b = box(n);
  let at = mix(b.xy, b.zw, vec2f(f32(v & 1u), f32(v >> 1u)));
  return V(vec4f(at / vec2f(${target.width}., ${target.height}.) * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), n);
}
@fragment fn fs(v: V) -> F {
  let texel = stamp(v.i, v.p.xy);
  if (texel.r < -1.) { discard; }
  return F(texel, (texel.r + 1.) / 3.);
}`,
    });
    pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: target.texture.format }] },
      primitive: { topology: "triangle-strip" },
      depthStencil: { format: "depth32float", depthCompare: "greater", depthWriteEnabled: true },
    });
    byCode.set(key, pipeline);
  }
  const depth = device.createTexture({ size: { width: target.width, height: target.height }, format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: top(target), loadOp: "clear", storeOp: "store", clearValue: clear }],
    depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 0 },
  });
  pass.setPipeline(pipeline);
  if (sources.length) pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: sources.map((s, k) => ({ binding: k, resource: s.view })) }));
  pass.draw(4, count);
  pass.end();
  device.queue.submit([encoder.finish()]);
  depth.destroy();
}

/** The most of a texture's texels, each channel's, in a texture of one
 *  texel: `of` is WGSL for what of a texel `h` is weighed (`abs(h)`, its
 *  size either way). In two steps, sixteen texels each way at a time and
 *  then the rest, since no pixel can ask after every other. The caller's
 *  to let go. */
export function mostOf(engine: Engine, source: Texture2D, of: string): Texture2D {
  const most = (wide: number, high: number, what: string) => `fn fill(at: vec2f) -> vec4f {
  var most = vec4f(-1e30);
  for (var j = 0; j < ${high}; j++) {
    for (var i = 0; i < ${wide}; i++) {
      let h = textureLoad(src0, vec2i(at) * vec2i(${wide}, ${high}) + vec2i(i, j), 0);
      most = max(most, ${what});
    }
  }
  return most;
}`;
  const some = createFilledTexture(engine, source.width / 16, source.height / 16, "rgba32float");
  const all = createFilledTexture(engine, 1, 1, "rgba32float");
  fillTexture(engine, some, most(16, 16, of), [source]);
  fillTexture(engine, all, most(some.width, some.height, "h"), [some]);
  some.texture.destroy();
  return all;
}

/** A filled texture of bytes, four a texel, read back from the GPU, its
 *  smaller copy `level` down: what was drawn there, for what must be
 *  worked out here. */
export async function readTexture(engine: Engine, texture: Texture2D, level: number): Promise<Uint8Array> {
  const device = engine._device;
  const [width, height] = [texture.width >> level, texture.height >> level];
  // A row of a copy is a multiple of 256 bytes long.
  const row = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: texture.texture, mipLevel: level }, { buffer, bytesPerRow: row }, { width, height });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) out.set(padded.subarray(y * row, y * row + width * 4), y * width * 4);
  buffer.destroy();
  return out;
}
