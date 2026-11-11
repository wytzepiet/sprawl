import type { Engine } from "./engine";
import type { Texture2D } from "./texture";

/** A texture a shader can fill (`fillTexture`), read smoothly. */
export function createFilledTexture(engine: Engine, width: number, height: number, format: GPUTextureFormat = "r8unorm"): Texture2D {
  const texture = engine._device.createTexture({ size: { width, height }, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  return { texture, view: texture.createView(), sampler: engine._device.createSampler({ minFilter: "linear", magFilter: "linear" }), width, height };
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

/** Every texel of `target` worked out on the GPU, once: `code` is WGSL with
 *  `fn fill(at: vec2f) -> vec4f`, `at` the texel's middle in texels, reading
 *  `sources` as `src0`, `src1`… by `textureLoad`. A map that is a value a
 *  pixel, made where pixels are made instead of texel by texel in a worker. */
export function fillTexture(engine: Engine, target: Texture2D, code: string, sources: Texture2D[]) {
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
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: sources.map((s, k) => ({ binding: k, resource: s.view })) }));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
