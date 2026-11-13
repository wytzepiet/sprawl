import type { MaterialPlugin } from "./material";
import { TONE } from "../engine/toneMap";
import { enabledPlugins, type OwnPbrMaterial } from "./material";

/**
 * The shader composer: a material's plugins pasted into one of three
 * templates, one WGSL module each (entry points `vs` and `fs`), as Lite's PBR
 * template places them (docs/archive/renderer-contract.md §5.3) and lights them
 * (pbr-template.ts, multilight-wgsl.ts, clustered-light-wgsl.ts,
 * ibl-fragment.ts, csm-shadow-fragment-core.ts). Pure: no GPU here.
 *
 * Every hook sits at the top of one `main`, in priority order, nothing
 * branching above it; the names a hook may read are Lite's, and every name
 * of ours that a hook may not read starts `_r_`.
 *
 * Bindings:
 * - group 0: `scene` (SCENE_WGSL).
 * - group 1: binding 0 `material`, then each plugin texture and its sampler,
 *   in `materialTextures` order. Every group 1 binding is seen by both stages.
 * - group 2: binding 0 `mesh`: `world`, and `receiveShadows` (0 or 1).
 * - group 3, forward only: 0 `shadowStatic`, 1 `shadowLive`
 *   (texture_depth_2d_array, one layer), 2 `shadowSampler` (comparison,
 *   "less"), 3 `lights` (storage), 4 `sky` (texture_cube, mipmapped,
 *   prefiltered), 5 `skySampler`, 6 `brdfLUT` (Lite's `generateBrdfLut`),
 *   7 `brdfSampler` (bilinear, clamped), 8 `bins`: the lights by screen
 *   tile (`BIN_WGSL`).
 */
export type Pass = "gbuffer" | "shadow" | "forward";

/** What the mesh has. Positions and normals always; plugin buffers are the
 *  material's (`getAttributes`). */
export interface VertexLayout {
  uv: boolean;
  colors: boolean;
  /** Thin instances: a mat4 at four vec4 locations, a buffer of its own. */
  instances: boolean;
  instanceColors: boolean;
}

export interface Composed {
  pass: Pass;
  /** The same key, the same shader and vertex layout. */
  key: string;
  code: string;
  /** position, normal, [uv], [color], [instances], [instanceColors], then
   *  plugin buffers in order of first declaration. */
  vertexBuffers: GPUVertexBufferLayout[];
  /** The name of each of `vertexBuffers`, as `setMeshAttribute` names a plugin's. */
  bufferOrder: string[];
  /** Bytes: roughnessFactor, metallicFactor, reflectance, materialAlpha, then
   *  the plugins' fields, at WGSL's uniform alignment (`writeMaterialUbo`). */
  materialUbo: { size: number; offsets: Map<string, number> };
  materialTextures: { texture: string; sampler: string; kind: "float" | "depth"; samplerType: "filtering" | "non-filtering" }[];
  doubleSided: boolean;
}

type Field = { name: string; type: string };

const ALIGN: Record<string, [align: number, size: number]> = {
  f32: [4, 4],
  u32: [4, 4],
  i32: [4, 4],
  "vec2<f32>": [8, 8],
  vec2f: [8, 8],
  "vec3<f32>": [16, 12],
  vec3f: [16, 12],
  "vec4<f32>": [16, 16],
  vec4f: [16, 16],
  "mat4x4<f32>": [16, 64],
  mat4x4f: [16, 64],
};

/** A uniform struct's body and byte offsets, by WGSL's layout rules. */
function struct(fields: Field[]) {
  const offsets = new Map<string, number>();
  let at = 0;
  for (const { name, type } of fields) {
    const array = /^array<(\w+(?:<f32>)?),\s*(\d+)>$/.exec(type);
    const [align, size] = array ? [16, Math.ceil(ALIGN[array[1]!]![1] / 16) * 16 * Number(array[2])] : ALIGN[type] ?? [0, 0];
    if (!align) throw new Error(`compose: no uniform layout for ${name}: ${type}`);
    at = Math.ceil(at / align) * align;
    offsets.set(name, at);
    at += size;
  }
  return { body: fields.map((f) => `${f.name}: ${f.type},`).join("\n"), offsets, size: Math.ceil(at / 16) * 16 };
}

const SCENE_FIELDS: Field[] = [
  { name: "viewProjection", type: "mat4x4f" },
  { name: "view", type: "mat4x4f" },
  { name: "vEyePosition", type: "vec4f" },
  /** exposure, contrast, the sky cube's lodGenerationScale (Lite's 0.8), how much the open sky's share is felt (0 with no picture). */
  { name: "vImageInfos", type: "vec4f" },
  /** Toward the sun: Lite's light direction, negated. */
  { name: "sunDir", type: "vec4f" },
  /** Linear rgb times intensity: Lite's vLightDiffuse. */
  { name: "sunColor", type: "vec4f" },
  /** Irradiance SH as Lite's scene: L00, L1_1, L10, L11, L2_2, L2_1, L20, L21, L22. */
  { name: "sh", type: "array<vec4f, 9>" },
  { name: "time", type: "vec4f" },
  { name: "screen", type: "vec4f" },
  /** The sun's: Lite's cascade 0 matrix (`data[0..16)` of the receiver UBO). */
  { name: "shadowMatrix", type: "mat4x4f" },
  /** darkness, mapSize, 1 / mapSize, frustumEdgeFalloff (Lite's shadowsInfo; darkness 1 while shadows are off). */
  { name: "shadowInfo", type: "vec4f" },
  /** The still picture's eye: where a point is in it, for its open sky. */
  { name: "stillView", type: "mat4x4f" },
];
const SCENE = struct(SCENE_FIELDS);

/** The scene UBO, group 0 binding 0, read as `scene.*`; in the shadow pass
 *  `viewProjection` is the sun's (orthographic, so `[2][3] == 0`). */
export const SCENE_WGSL = `struct Scene {\n${SCENE.body}\n}\n@group(0) @binding(0) var<uniform> scene: Scene;`;
export const SCENE_BYTES = SCENE.size;
/** Byte offsets of the scene's fields. */
export const SCENE_OFFSETS: ReadonlyMap<string, number> = SCENE.offsets;

/** A light in `lights`: 48 bytes. position.xyz, range; colour.rgb,
 *  intensity; direction.xyz, cos(angle / 2), or w < 0 for a point light.
 *  Only lights with intensity and range above 0. */
const LIGHT_WGSL = `struct _r_Light { position: vec4f, color: vec4f, direction: vec4f }`;

/** The lights are binned by the tile of the screen they may reach, this
 *  many pixels square (`frame.ts`): a pixel shades only its tile's. */
export const TILE = 64;
/** `bins` at a group and binding: a tile's header, four words, row by
 *  row (its first index in `bins`, its lamps, its headlights, 0); then the
 *  indices into `lights`, a tile's lamps before its headlights. And
 *  `_r_binAt`, a pixel's header on a target this wide. */
export const binsAt = (group: number, binding: number) => `@group(${group}) @binding(${binding}) var<storage, read> bins: array<u32>;
fn _r_binAt(p: vec2f, width: f32) -> vec3u {
let t = vec2u(p) / ${TILE}u;
let at = (t.y * u32(ceil(width / ${TILE}.)) + t.x) * 4u;
return vec3u(bins[at], bins[at + 1u], bins[at + 2u]);
}`;

/** Lite's BRDF (pbr-template.ts), every pass, as Lite has it in every pass. */
const BRDF = `const PI: f32 = 3.14159265358979323846;
fn distributionGGX(NdotH: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
return a2 / (PI * d * d);
}
fn geometrySmithGGX(NdotL: f32, NdotV: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let gl = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
let gv = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
return 0.5 / (gl + gv);
}
fn fresnelSchlick(cosTheta: f32, F0: vec3f, F90: vec3f) -> vec3f {
let t = 1.0 - cosTheta;
let t2 = t * t;
return F0 + (F90 - F0) * (t2 * t2 * t);
}`;

/** The pass's resources and Lite's CSM receiver for one cascade
 *  (`csmSample`, 4 bilinear compares, darkness and the frustum edge's
 *  falloff), read from either map. */
const FORWARD_BINDINGS = `${LIGHT_WGSL}
@group(3) @binding(0) var shadowStatic: texture_depth_2d_array;
@group(3) @binding(1) var shadowLive: texture_depth_2d_array;
@group(3) @binding(2) var shadowSampler: sampler_comparison;
@group(3) @binding(3) var<storage, read> lights: array<_r_Light>;
@group(3) @binding(4) var sky: texture_cube<f32>;
@group(3) @binding(5) var skySampler: sampler;
@group(3) @binding(6) var brdfLUT: texture_2d<f32>;
@group(3) @binding(7) var brdfSampler: sampler;
${binsAt(3, 8)}
@group(3) @binding(9) var openSky: texture_2d<f32>;
// The open sky the still picture has where this point is (OPEN in deferred.ts),
// smoothed: what moves in a nook, or washes into one, dims with it.
fn _r_openAt(worldPos: vec3f) -> f32 {
let c = scene.stillView * vec4f(worldPos, 1.0);
let uv = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5);
let texel = 1.5 / vec2f(textureDimensions(openSky));
var sum = 0.0;
for (var i = 0; i < 4; i++) { sum += textureSampleLevel(openSky, brdfSampler, uv + texel * vec2f(f32(i & 1) * 2.0 - 1.0, f32(i >> 1) * 2.0 - 1.0), 0.0).r; }
return max(1.0 - (1.0 - sum / 4.0) * abs(scene.vImageInfos.w), 0.0);
}
fn _r_shadowOf(map: texture_depth_2d_array, worldPos: vec3f) -> f32 {
let posFromLight = scene.shadowMatrix * vec4f(worldPos, 1.0);
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2f(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);
let mapSz = scene.shadowInfo.y;
let invMapSz = scene.shadowInfo.z;
let tc = uv * mapSz + 0.5;
let st = fract(tc);
let base = (floor(tc) - 0.5) * invMapSz;
let uvw0 = 3.0 - 2.0 * st;
let uvw1 = 1.0 + 2.0 * st;
let u = vec2f((2.0 - st.x) / uvw0.x - 1.0, st.x / uvw1.x + 1.0) * invMapSz;
let v = vec2f((2.0 - st.y) / uvw0.y - 1.0, st.y / uvw1.y + 1.0) * invMapSz;
var sh = 0.0;
sh += uvw0.x * uvw0.y * textureSampleCompareLevel(map, shadowSampler, base + vec2f(u.x, v.x), 0, depthRef);
sh += uvw1.x * uvw0.y * textureSampleCompareLevel(map, shadowSampler, base + vec2f(u.y, v.x), 0, depthRef);
sh += uvw0.x * uvw1.y * textureSampleCompareLevel(map, shadowSampler, base + vec2f(u.x, v.y), 0, depthRef);
sh += uvw1.x * uvw1.y * textureSampleCompareLevel(map, shadowSampler, base + vec2f(u.y, v.y), 0, depthRef);
sh /= 16.0;
sh = mix(scene.shadowInfo.x, 1.0, sh);
let mask = smoothstep(1.0 - scene.shadowInfo.w, 1.00000012, clamp(dot(clipSpace.xy, clipSpace.xy), 0.0, 1.0));
return mix(sh, 1.0, mask);
}`;

/** After the hooks up to MF: Lite's lighting (the multi-light loop with the
 *  sun as its one light, the clustered block's falloff without its
 *  clusters, the IBL fragment), in Lite's order of sums. */
const LIGHTING = `var _r_alphaG = roughness * roughness + 0.0005;
let _r_directRoughness = max(roughness, 0.0);
let _r_directAlphaG = _r_directRoughness * _r_directRoughness + 0.0005;
let _r_brdf = textureSample(brdfLUT, brdfSampler, vec2f(NdotV, roughness)).rgb;
var _r_diffuse = vec3f(0.0);
var _r_specular = vec3f(0.0);
let _r_open = _r_openAt(input.worldPos);
occlusion *= _r_open;
let _r_sf = select(1.0, min(_r_shadowOf(shadowStatic, input.worldPos), _r_shadowOf(shadowLive, input.worldPos)), mesh.receiveShadows > 0.5) * mix(1.0, _r_open, 0.8);
let _r_L = normalize(scene.sunDir.xyz);
let _r_NdotL = max(dot(N, _r_L), 0.0);
_r_diffuse += surfaceAlbedo * (1.0 / PI) * _r_NdotL * scene.sunColor.rgb * _r_sf;
if (_r_NdotL > 0.0) {
let _r_H = normalize(V + _r_L);
let _r_D = distributionGGX(clamp(dot(N, _r_H), 0.0000001, 1.0), _r_directAlphaG);
let _r_G = geometrySmithGGX(_r_NdotL, NdotV, _r_directAlphaG);
_r_specular += fresnelSchlick(saturate(dot(V, _r_H)), colorF0, colorF90) * _r_D * _r_G * _r_NdotL * scene.sunColor.rgb * _r_sf;
}
let _r_bin = _r_binAt(input.clipPos.xy, scene.screen.x);
for (var _r_i = _r_bin.x; _r_i < _r_bin.x + _r_bin.y + _r_bin.z; _r_i++) {
let _r_light = lights[bins[_r_i]];
let _r_toLight = _r_light.position.xyz - input.worldPos;
let _r_d2 = dot(_r_toLight, _r_toLight);
let _r_dist = sqrt(_r_d2);
let _r_range = max(_r_light.position.w, 0.0001);
if (_r_dist < _r_range) {
let _r_Lc = _r_toLight / max(_r_dist, 0.0001);
let _r_NdotLc = max(dot(N, _r_Lc), 0.0);
let _r_falloff = _r_d2 / max(_r_range * _r_range, 0.0000001);
var _r_rangeAtt = 1.0 / max(_r_d2, 0.0000001);
var _r_smooth = saturate(1.0 - _r_falloff * _r_falloff);
_r_smooth *= _r_smooth;
_r_rangeAtt *= _r_smooth;
if (_r_light.direction.w >= 0.0) {
let _r_cone = saturate((dot(-_r_light.direction.xyz, _r_Lc) - _r_light.direction.w) / max(1.0 - _r_light.direction.w, 0.001));
_r_rangeAtt *= _r_cone * _r_cone;
}
let _r_radiance = _r_light.color.rgb * _r_light.color.a * _r_rangeAtt;
_r_diffuse += surfaceAlbedo * (1.0 / PI) * _r_NdotLc * _r_radiance;
if (_r_NdotLc > 0.0) {
let _r_Hc = normalize(V + _r_Lc);
let _r_Dc = distributionGGX(clamp(dot(N, _r_Hc), 0.0000001, 1.0), _r_directAlphaG);
let _r_Gc = geometrySmithGGX(_r_NdotLc, NdotV, _r_directAlphaG);
_r_specular += fresnelSchlick(saturate(dot(V, _r_Hc)), colorF0, colorF90) * _r_Dc * _r_Gc * _r_NdotLc * _r_radiance;
}
}
}
let _r_envReflectance = ((colorF90 - colorF0) * _r_brdf.x + colorF0 * _r_brdf.y) * clamp((_r_NdotV + occlusion) * (_r_NdotV + occlusion) - 1.0 + occlusion, 0.0, 1.0);
let _r_energy = 1.0 + colorF0 * (1.0 / max(_r_brdf.y, 0.001) - 1.0);
let _r_irradiance = scene.sh[0].rgb + scene.sh[1].rgb * N.y + scene.sh[2].rgb * N.z + scene.sh[3].rgb * N.x
  + scene.sh[4].rgb * (N.y * N.x) + scene.sh[5].rgb * (N.y * N.z)
  + scene.sh[6].rgb * (3.0 * N.z * N.z - 1.0) + scene.sh[7].rgb * (N.z * N.x)
  + scene.sh[8].rgb * (N.x * N.x - N.y * N.y);
let _r_lod = log2(f32(textureDimensions(sky).x) * _r_alphaG) * scene.vImageInfos.z;
var _r_radianceEnv = textureSampleLevel(sky, skySampler, reflect(-V, N), clamp(_r_lod, 0.0, f32(textureNumLevels(sky) - 1))).rgb;
_r_radianceEnv = mix(_r_radianceEnv, _r_irradiance, _r_alphaG);
var color = _r_irradiance * surfaceAlbedo * occlusion + _r_radianceEnv * _r_envReflectance * _r_energy + _r_specular * _r_energy + _r_diffuse + emissive;`;

/** Lite's output after NI (contract §5.6). */
const TONE_OUT = `${TONE.callWGSL}
color = pow(color, vec3f(1.0 / 2.2));
color = clamp(color, vec3f(0.0), vec3f(1.0));
let _r_highContrast = color * color * (3.0 - 2.0 * color);
if (scene.vImageInfos.y < 1.0) { color = mix(vec3f(0.5), color, scene.vImageInfos.y); }
else { color = mix(color, _r_highContrast, scene.vImageInfos.y - 1.0); }
color = max(color, vec3f(0.0));`;

const HOOKS = {
  CUSTOM_FRAGMENT_DEFINITIONS: "HF",
  CUSTOM_FRAGMENT_MAIN_BEGIN: "SV",
  CUSTOM_FRAGMENT_UPDATE_ALPHA: "AT",
  CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "AC",
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: "MF",
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "NI",
  CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "BC",
  CUSTOM_VERTEX_MAIN_BEGIN: "VR",
  CUSTOM_VERTEX_UPDATE_WORLDPOS: "VW",
  CUSTOM_VERTEX_MAIN_END: "VB",
} as const;
type Hook = (typeof HOOKS)[keyof typeof HOOKS];

const FLOATS: Record<string, number> = { f32: 1, "vec2<f32>": 2, "vec3<f32>": 3, "vec4<f32>": 4 };

/** Each hook's code, in priority order; the vertex hooks from the vertex
 *  stage's code, the rest from the fragment's (as Lite's vertex-data bridge). */
function hooksOf(plugins: MaterialPlugin[]) {
  const code = Object.fromEntries(Object.values(HOOKS).map((h) => [h, [] as string[]])) as Record<Hook, string[]>;
  for (const p of plugins)
    for (const stage of ["vertex", "fragment"] as const)
      for (const [point, text] of Object.entries(p.getCustomCode?.(stage) ?? {})) {
        const hook = HOOKS[point as keyof typeof HOOKS];
        if (text && hook && hook.startsWith("V") === (stage === "vertex")) code[hook].push(text);
      }
  return Object.fromEntries(Object.entries(code).map(([h, list]) => [h, list.join("\n")])) as Record<Hook, string>;
}

/** 53 bits of a string (cyrb53). */
function hash(s: string) {
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

export function compose(material: OwnPbrMaterial, pass: Pass, layout: VertexLayout): Composed {
  const plugins = enabledPlugins(material);
  const h = hooksOf(plugins);
  const doubleSided = material.doubleSided;

  // Vertex inputs and their buffers.
  const inputs: string[] = [];
  const vertexBuffers: GPUVertexBufferLayout[] = [];
  const bufferOrder: string[] = [];
  const buffer = (name: string, stepMode: GPUVertexStepMode, attributes: Field[]) => {
    let offset = 0;
    const attrs: GPUVertexAttribute[] = attributes.map(({ name, type }) => {
      const floats = FLOATS[type];
      if (!floats) throw new Error(`compose: attribute ${name} is ${type}; f32 or vec2/3/4<f32>`);
      inputs.push(`@location(${inputs.length}) ${name}: ${type}`);
      const a: GPUVertexAttribute = { shaderLocation: inputs.length - 1, offset, format: floats === 1 ? "float32" : (`float32x${floats}` as GPUVertexFormat) };
      offset += floats * 4;
      return a;
    });
    vertexBuffers.push({ arrayStride: offset, stepMode, attributes: attrs });
    bufferOrder.push(name);
  };
  buffer("position", "vertex", [{ name: "position", type: "vec3<f32>" }]);
  buffer("normal", "vertex", [{ name: "normal", type: "vec3<f32>" }]);
  if (layout.uv) buffer("uv", "vertex", [{ name: "uv", type: "vec2<f32>" }]);
  if (layout.colors) buffer("color", "vertex", [{ name: "color", type: "vec4<f32>" }]);
  if (layout.instances) buffer("instances", "instance", [0, 1, 2, 3].map((i) => ({ name: `world${i}`, type: "vec4<f32>" })));
  if (layout.instanceColors) buffer("instanceColors", "instance", [{ name: "instanceColor", type: "vec4<f32>" }]);
  const shared = new Map<string, { perInstance: boolean; attributes: Field[] }>();
  for (const p of plugins)
    for (const a of p.getAttributes?.() ?? []) {
      const name = a.buffer ?? a.name;
      const b = shared.get(name) ?? shared.set(name, { perInstance: !!a.perInstance, attributes: [] }).get(name)!;
      if (b.perInstance !== !!a.perInstance) throw new Error(`compose: buffer ${name} mixes per-vertex and per-instance attributes`);
      b.attributes.push(a);
    }
  for (const [name, b] of shared) buffer(name, b.perInstance ? "instance" : "vertex", b.attributes);

  // Varyings, Lite's then the plugins'.
  const varyings: Field[] = [
    { name: "worldPos", type: "vec3f" },
    { name: "worldNormal", type: "vec3f" },
    { name: "uv", type: "vec2f" },
    ...(layout.colors ? [{ name: "vColor", type: "vec4f" }] : []),
    ...plugins.flatMap((p) => p.getVaryings?.() ?? []),
    ...(layout.instanceColors ? [{ name: "vInstanceColor", type: "vec4f" }] : []),
  ].filter((v, i, all) => all.findIndex((w) => w.name === v.name) === i);

  // The material: its UBO, then the plugins' textures.
  const ubo = struct([
    { name: "roughnessFactor", type: "f32" },
    { name: "metallicFactor", type: "f32" },
    { name: "reflectance", type: "f32" },
    { name: "materialAlpha", type: "f32" },
    ...plugins.flatMap((p) => p.getUniforms?.().ubo ?? []),
  ]);
  const materialTextures: Composed["materialTextures"] = plugins.flatMap((p) =>
    (p.getSamplers?.() ?? []).map((s) => ({
      texture: s.texture,
      sampler: s.sampler,
      kind: s.depthTexture ? ("depth" as const) : ("float" as const),
      samplerType: s.samplerType === "sampler_non_filtering" ? ("non-filtering" as const) : ("filtering" as const),
    })),
  );

  const vertex = `@vertex fn vs(
${inputs.join(",\n")}
) -> Varyings {
var out: Varyings;
${layout.uv ? "" : "let uv = vec2f(0.0);"}
${h.VR}
var finalWorld = mesh.world;
${layout.instances ? "finalWorld = mesh.world * mat4x4f(world0, world1, world2, world3);" : ""}
${h.VW}
let _r_worldPos4 = finalWorld * vec4f(position, 1.0);
out.worldPos = _r_worldPos4.xyz;
out.clipPos = scene.viewProjection * _r_worldPos4;
out.worldNormal = (finalWorld * vec4f(normalize(normal), 0.0)).xyz;
out.uv = uv;
${layout.colors ? "out.vColor = color;" : ""}
${layout.instanceColors ? "out.vInstanceColor = instanceColor;" : ""}
${h.VB}
return out;
}`;

  // The fragment: the surface to AT (every pass), to MF (G-buffer and
  // forward), then what the pass writes.
  const toAT = `${h.SV}
var baseColor = vec3f(1.0);
var alpha = 1.0;
${layout.colors ? "baseColor *= input.vColor.rgb;\nalpha *= input.vColor.a;" : ""}
var occlusion = 1.0;
var roughness = clamp(material.roughnessFactor, 0.0, 1.0);
var metallic = material.metallicFactor;
var emissive = vec3f(0.0);
${layout.instanceColors ? "baseColor *= input.vInstanceColor.rgb;\nalpha *= input.vInstanceColor.a;" : ""}
${h.AT}`;
  const toMF = `var N_geom = normalize(input.worldNormal);
var N = N_geom;
${doubleSided ? "N = select(-N, N, frontFacing);\nN_geom = select(-N_geom, N_geom, frontFacing);" : ""}
${h.AC}
let V = normalize(scene.vEyePosition.xyz - input.worldPos);
let _r_NdotV = dot(N, V);
var NdotV = abs(_r_NdotV) + 0.0000001;
var colorF0 = mix(vec3f(material.reflectance), baseColor, metallic);
let colorF90 = vec3f(1.0);
var surfaceAlbedo = baseColor * (1.0 - material.reflectance) * (1.0 - metallic);
${h.MF}`;
  const params = `input: Varyings${doubleSided ? ", @builtin(front_facing) frontFacing: bool" : ""}`;
  const fragment = {
    shadow: `@fragment fn fs(${params}) {
${toAT}
}`,
    // NI is affine in `color`: from 0 it is the emissive, from 1 that plus
    // the light's weight. Emissive kept as e / (1 + e); lit as the mean.
    gbuffer: `struct _r_GBuffer { @location(0) albedo: vec4f, @location(1) normal: vec4f, @location(2) extra: vec4f }
@fragment fn fs(${params}) -> _r_GBuffer {
${toAT}
${toMF}
var _r_c0: vec3f;
var _r_c1: vec3f;
{
var color = emissive;
${h.NI}
_r_c0 = color;
}
{
var color = emissive + vec3f(1.0);
${h.NI}
_r_c1 = color;
}
if (!(alpha > 0.4)) { discard; }
let _r_lit = _r_c1 - _r_c0;
let _r_glow = max(_r_c0, vec3f(0.0));
return _r_GBuffer(vec4f(baseColor, (_r_lit.r + _r_lit.g + _r_lit.b) / 3.0), vec4f(N * 0.5 + 0.5, roughness), vec4f(_r_glow / (1.0 + _r_glow), metallic));
}`,
    forward: `${FORWARD_BINDINGS}
@fragment fn fs(${params}) -> @location(0) vec4f {
${toAT}
${toMF}
${LIGHTING}
${h.NI}
${TONE_OUT}
${h.BC}
return vec4f(color, alpha * material.materialAlpha);
}`,
  }[pass];

  const code = `const PASS_SHADOW = ${pass === "shadow"};
${SCENE_WGSL}
struct Material {
${ubo.body}
}
@group(1) @binding(0) var<uniform> material: Material;
${materialTextures.map((t, i) => `@group(1) @binding(${1 + 2 * i}) var ${t.texture}: ${t.kind === "depth" ? "texture_depth_2d" : "texture_2d<f32>"};\n@group(1) @binding(${2 + 2 * i}) var ${t.sampler}: sampler;`).join("\n")}
struct Mesh { world: mat4x4f, receiveShadows: f32 }
@group(2) @binding(0) var<uniform> mesh: Mesh;
struct Varyings {
@builtin(position) clipPos: vec4f,
${varyings.map((v, i) => `@location(${i}) ${v.name}: ${v.type},`).join("\n")}
}
${BRDF}
${TONE.helpersWGSL}
${h.HF}
${vertex}
${fragment}
`;
  const shape = JSON.stringify([vertexBuffers, materialTextures]);
  return { pass, key: `${pass}:${hash(code + shape)}`, code, vertexBuffers, bufferOrder, materialUbo: { size: ubo.size, offsets: ubo.offsets }, materialTextures, doubleSided };
}

const [VERTEX, FRAGMENT] = [1, 2];

/** The bind group layouts a composed shader is built with: groups 0 to 2,
 *  and 3 in the forward pass. */
export function bindGroupLayouts({ pass, materialTextures }: Composed): GPUBindGroupLayoutDescriptor[] {
  const both = VERTEX | FRAGMENT;
  const uniform = (visibility: number): GPUBindGroupLayoutEntry => ({ binding: 0, visibility, buffer: { type: "uniform" } });
  const groups: GPUBindGroupLayoutDescriptor[] = [
    { entries: [uniform(both)] },
    {
      entries: [
        uniform(both),
        ...materialTextures.flatMap((t, i): GPUBindGroupLayoutEntry[] => [
          { binding: 1 + 2 * i, visibility: both, texture: { sampleType: t.kind } },
          { binding: 2 + 2 * i, visibility: both, sampler: { type: t.samplerType } },
        ]),
      ],
    },
    { entries: [uniform(both)] },
  ];
  if (pass === "forward") groups.push(FORWARD_GROUP);
  return groups;
}

/** The forward pass's group 3 (see the top of this file). */
export const FORWARD_GROUP: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 1, visibility: FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 2, visibility: FRAGMENT, sampler: { type: "comparison" } },
    { binding: 3, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: FRAGMENT, texture: { viewDimension: "cube" } },
    { binding: 5, visibility: FRAGMENT, sampler: {} },
    { binding: 6, visibility: FRAGMENT, texture: {} },
    { binding: 7, visibility: FRAGMENT, sampler: {} },
    { binding: 8, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 9, visibility: FRAGMENT, texture: {} },
  ],
};
