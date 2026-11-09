import type { Engine } from "./engine";
import type { Scene } from "./scene";
import { mipmaps } from "./texture";

/**
 * The sky's light, as Lite's `createCubeEnvironment` makes it: six float
 * faces in Babylon's cube order, a half-float cube of box-filtered mips for
 * the shine, and their irradiance as nine pre-scaled spherical harmonics
 * for the rest, in Lite's numbers (cube-environment.ts, load-env.ts).
 */
export interface CubeEnvironment {
  scene: Scene;
  size: number;
  texture: GPUTexture;
  view: GPUTextureView;
  /** 9 vec4s: L00, L1_1, L10, L11, L2_2, L2_1, L20, L21, L22. */
  sh: Float32Array;
  /** Bumped when redrawn: the relight is due. */
  version: number;
}

export function createCubeEnvironment(scene: Scene, faces: readonly Float32Array[], options: { size: number }): CubeEnvironment {
  const size = options.size;
  const texture = scene.engine._device.createTexture({
    size: [size, size, 6],
    mipLevelCount: Math.floor(Math.log2(size)) + 1,
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const env: CubeEnvironment = { scene, size, texture, view: texture.createView({ dimension: "cube" }), sh: new Float32Array(36), version: 0 };
  scene._env = env;
  updateCubeEnvironment(env, faces);
  return env;
}

export function updateCubeEnvironment(env: CubeEnvironment, faces: readonly Float32Array[]): void {
  const engine = env.scene.engine;
  const size = env.size;
  const half = new Uint16Array(size * size * 4);
  for (let face = 0; face < 6; face++) {
    const texels = faces[face]!;
    for (let i = 0; i < half.length; i++) half[i] = toHalf(texels[i]!);
    engine._device.queue.writeTexture({ texture: env.texture, origin: [0, 0, face] }, half, { bytesPerRow: size * 8 }, [size, size, 1]);
    mipmaps(engine, env.texture, face);
  }
  env.sh.set(harmonics(faces, size));
  env.version++;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 112;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7bff;
  return sign | (exponent << 10) | (((bits & 0x7fffff) + 0x1000) >>> 13);
}

// Babylon's `_FileFaces`: the outward normal, then the axes a face's rows and columns run along.
const FACES = [
  [1, 0, 0, 0, 0, -1, 0, -1, 0],
  [-1, 0, 0, 0, 0, 1, 0, -1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, 1],
  [0, -1, 0, 1, 0, 0, 0, 0, -1],
  [0, 0, 1, 1, 0, 0, 0, -1, 0],
  [0, 0, -1, -1, 0, 0, 0, -1, 0],
];
const PI = Math.PI;
const BASIS = [1 / (4 * PI), 3 / (4 * PI), 3 / (4 * PI), 3 / (4 * PI), 15 / (4 * PI), 15 / (4 * PI), 5 / (16 * PI), 15 / (4 * PI), 15 / (16 * PI)].map(Math.sqrt);
const KERNEL = [PI, (2 * PI) / 3, (2 * PI) / 3, (2 * PI) / 3, PI / 4, PI / 4, PI / 4, PI / 4, PI / 4];
const area = (x: number, y: number) => Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));

/** The faces' irradiance, as Lite's scene UBO carries it: Babylon's
 *  harmonics through its polynomial and back, pre-scaled for rendering. */
function harmonics(faces: readonly Float32Array[], size: number): Float32Array {
  const du = 2 / size;
  const h = du / 2;
  const sh = new Float64Array(27);
  let total = 0;
  for (let face = 0; face < 6; face++) {
    const texels = faces[face]!;
    const [nx, ny, nz, xx, xy, xz, yx, yy, yz] = FACES[face]!;
    for (let row = 0; row < size; row++) {
      const v = h - 1 + row * du;
      for (let col = 0; col < size; col++) {
        const u = h - 1 + col * du;
        const dx = xx * u + yx * v + nx;
        const dy = xy * u + yy * v + ny;
        const dz = xz * u + yz * v + nz;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        const [x, y, z] = [dx * inv, dy * inv, dz * inv];
        const solid = area(u - h, v - h) - area(u - h, v + h) - area(u + h, v - h) + area(u + h, v + h);
        const terms = [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y];
        const i = (row * size + col) * 4;
        for (let k = 0; k < 9; k++) {
          const w = solid * BASIS[k]! * terms[k]!;
          sh[k] += texels[i]! * w;
          sh[9 + k] += texels[i + 1]! * w;
          sh[18 + k] += texels[i + 2]! * w;
        }
        total += solid;
      }
    }
  }
  for (let k = 0; k < 27; k++) sh[k] = (sh[k]! * ((4 * PI) / total) * KERNEL[k % 9]!) / PI;
  const out = new Float32Array(36);
  for (let ch = 0; ch < 3; ch++) {
    const [L00, L1_1, L10, L11, L2_2, L2_1, L20, L21, L22] = sh.subarray(ch * 9, ch * 9 + 9);
    // Babylon's polynomial (`shToPolynomial`)…
    const x = (L11! * 1.02333) / PI;
    const y = (L1_1! * 1.02333) / PI;
    const z = (L10! * 1.02333) / PI;
    const pxx = (L00! * 0.886227 - L20! * 0.247708 + L22! * 0.429043) / PI;
    const pyy = (L00! * 0.886227 - L20! * 0.247708 - L22! * 0.429043) / PI;
    const pzz = (L00! * 0.886227 + L20! * 0.495417) / PI;
    const pyz = (L2_1! * 0.858086) / PI;
    const pzx = (L21! * 0.858086) / PI;
    const pxy = (L2_2! * 0.858086) / PI;
    // …and back, pre-scaled (`polynomialToPreScaledHarmonics`).
    out[ch] = (pxx + pyy) * 0.3333338747897695 + pzz * 0.33333298856284405;
    out[4 + ch] = y * 1.4999984284682104;
    out[8 + ch] = z * 1.4999984284682104;
    out[12 + ch] = x * 1.4999984284682104;
    out[16 + ch] = pxy * 3.999982863580422;
    out[20 + ch] = pyz * 3.999982863580422;
    out[24 + ch] = pzz * 1.3333326611423701 - (pxx + pyy) * 0.6666653397393608;
    out[28 + ch] = pzx * 3.999982863580422;
    out[32 + ch] = (pxx - pyy) * 1.999991431790211;
  }
  return out;
}

/** Lite's split-sum table (hdr-brdf-lut.compute.wgsl), 256 square, made once an engine. */
const BRDF = /* wgsl */ `@group(0) @binding(0) var outputTex: texture_storage_2d<rgba16float, write>;
fn radicalInverseVdC(inputBits: u32) -> f32 {
  var bits = inputBits;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}
fn importanceSampleGGX(xi0: f32, xi1: f32, a2: f32) -> vec3f {
  let phi = 2.0 * 3.14159265359 * xi0;
  let cosTheta = sqrt((1.0 - xi1) / (1.0 + (a2 - 1.0) * xi1));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  return vec3f(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}
fn integrateBRDF(NdotV: f32, roughness: f32) -> vec2f {
  let V = vec3f(sqrt(1.0 - NdotV * NdotV), 0.0, NdotV);
  let a = roughness * roughness;
  let a2 = a * a;
  var A = 0.0; var B = 0.0;
  let sampleCount = 1024u;
  for (var i = 0u; i < sampleCount; i++) {
    let H = importanceSampleGGX(f32(i) / f32(sampleCount), radicalInverseVdC(i), a2);
    let VdotH = max(dot(V, H), 0.0);
    let L = 2.0 * VdotH * H - V;
    let NdotL = max(L.z, 0.0); let NdotH = max(H.z, 0.0);
    if (NdotL > 0.0 && NdotH > 0.0) {
      let GGXV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
      let GGXL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
      let V_Vis = (0.5 / max(GGXV + GGXL, 1e-6)) * NdotL * (4.0 * VdotH / NdotH);
      let Fc = pow(1.0 - VdotH, 5.0);
      A += (1.0 - Fc) * V_Vis; B += Fc * V_Vis;
    }
  }
  return vec2f(A / f32(sampleCount), B / f32(sampleCount));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= 256u || gid.y >= 256u) { return; }
  let r = integrateBRDF(max((f32(gid.x) + 0.5) / 256.0, 0.001), max((f32(gid.y) + 0.5) / 256.0, 0.04));
  textureStore(outputTex, vec2u(gid.x, gid.y), vec4f(r.y, r.x + r.y, 0.0, 1.0));
}`;

const luts = new WeakMap<Engine, GPUTextureView>();
export function brdfLut(engine: Engine): GPUTextureView {
  let view = luts.get(engine);
  if (view) return view;
  const device = engine._device;
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: BRDF }), entryPoint: "main" } });
  const texture = device.createTexture({ size: [256, 256], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
  pass.dispatchWorkgroups(32, 32);
  pass.end();
  device.queue.submit([encoder.finish()]);
  luts.set(engine, (view = texture.createView()));
  return view;
}
