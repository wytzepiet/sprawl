import type { Engine } from "./engine";

/** A texture and how it is read: the sampler travels with it, as Lite's does. */
export interface Texture2D {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  width: number;
  height: number;
}

export interface PixelsOptions {
  format?: GPUTextureFormat;
  mipmaps?: boolean;
  minFilter?: GPUFilterMode;
  magFilter?: GPUFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
}

const BYTES: Partial<Record<GPUTextureFormat, number>> = { r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, r16float: 2, rg16float: 4, rgba16float: 8, r32float: 4, rgba32float: 16 };

export function createTexture2DFromPixels(engine: Engine, data: Uint8Array | Uint16Array | Float32Array, width: number, height: number, o: PixelsOptions = {}): Texture2D {
  const format = o.format ?? "rgba8unorm";
  const levels = o.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  const texture = engine._device.createTexture({
    size: { width, height },
    format,
    mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (levels > 1 ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
  });
  const sampler = engine._device.createSampler({
    addressModeU: o.addressModeU ?? "clamp-to-edge",
    addressModeV: o.addressModeV ?? "clamp-to-edge",
    minFilter: o.minFilter ?? "nearest",
    magFilter: o.magFilter ?? "nearest",
    mipmapFilter: levels > 1 ? "linear" : "nearest",
  });
  const tex = { texture, view: texture.createView(), sampler, width, height };
  updateTexture2DFromPixels(engine, tex, data);
  return tex;
}

/** Part of a texture written again; its mips made again from it. */
export function updateTexture2DFromPixels(engine: Engine, tex: Texture2D, data: Uint8Array | Uint16Array | Float32Array, x = 0, y = 0, w = tex.width, h = tex.height): void {
  const bytes = BYTES[tex.texture.format] ?? 4;
  engine._device.queue.writeTexture({ texture: tex.texture, origin: { x, y } }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: w * bytes, rowsPerImage: h }, { width: w, height: h });
  if (tex.texture.mipLevelCount > 1) mipmaps(engine, tex.texture);
}

export function releaseTexture(tex: Texture2D): boolean {
  tex.texture.destroy();
  return true;
}

/** Mipmaps are always on here. */
export const enablePixelTextureMipmaps = async (): Promise<void> => {};

const MIP = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(uv * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), uv);
}
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(src, smp, v.uv, 0.); }`;

const mipPipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, GPURenderPipeline>>();

/** Each level a box filter of the one above, of one layer. */
export function mipmaps(engine: Engine, texture: GPUTexture, layer = 0) {
  const device = engine._device;
  const byFormat = mipPipelines.get(device) ?? new Map();
  mipPipelines.set(device, byFormat);
  let pipeline = byFormat.get(texture.format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: MIP });
    pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: texture.format }] } });
    byFormat.set(texture.format, pipeline);
  }
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const encoder = device.createCommandEncoder();
  for (let level = 1; level < texture.mipLevelCount; level++) {
    const view = (baseMipLevel: number) => texture.createView({ dimension: "2d", baseMipLevel, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
    const [src, dst] = [view(level - 1), view(level)];
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }, { binding: 1, resource: sampler }] }));
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
