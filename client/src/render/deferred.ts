import { TONE } from "../engine/toneMap";

/**
 * The still picture's shaders: the relight (the G-buffer lit into the lit
 * picture, linear) and the composite (that picture where the view now is,
 * with what moves laid over it, tone mapped once, into the screen). Both
 * light as the forward template does (`compose.ts`, Lite's numbers).
 */

/** The frame's own uniforms, `F` in WGSL (`frame.ts` writes it). */
export const FRAME_FIELDS = [
  ["seen", 16],
  ["seenInverse", 16],
  ["stillView", 16],
  ["stillInverse", 16],
  ["shadowMatrix", 16],
  /** The picture's eye. */
  ["eye", 4],
  /** Toward the sun; its light, linear. */
  ["sunDir", 4],
  ["sunColor", 4],
  /** darkness (1 with shadows off), mapSize, 1 / mapSize, frustum edge falloff. */
  ["shadowInfo", 4],
  /** exposure, contrast, the sky's lod scale, 0. */
  ["image", 4],
  /** The screen's width and height. */
  ["screen", 4],
  /** What shows where nothing was drawn. */
  ["clear", 4],
  /** The lamps' count, the headlights' first and count, in the light list (as floats). */
  ["counts", 4],
  ["sh", 36],
] as const;
export const FRAME_OFFSETS = new Map<string, number>();
let at = 0;
for (const [name, floats] of FRAME_FIELDS) FRAME_OFFSETS.set(name, at), (at += floats);
export const FRAME_FLOATS = at;

const COMMON = /* wgsl */ `
struct F {
  seen: mat4x4f, seenInverse: mat4x4f, stillView: mat4x4f, stillInverse: mat4x4f, shadowMatrix: mat4x4f,
  eye: vec4f, sunDir: vec4f, sunColor: vec4f, shadowInfo: vec4f, image: vec4f, screen: vec4f, clear: vec4f, counts: vec4f,
  sh: array<vec4f, 9>,
}
struct Light { position: vec4f, color: vec4f, direction: vec4f }
@group(0) @binding(0) var<uniform> f: F;
@group(0) @binding(1) var gAlbedo: texture_2d<f32>;
@group(0) @binding(2) var gNormal: texture_2d<f32>;
@group(0) @binding(3) var gExtra: texture_2d<f32>;
@group(0) @binding(4) var gDepth: texture_depth_2d;
@group(0) @binding(5) var shadowStatic: texture_depth_2d_array;
@group(0) @binding(6) var shadowLive: texture_depth_2d_array;
@group(0) @binding(7) var shadowSampler: sampler_comparison;
@group(0) @binding(8) var<storage, read> lights: array<Light>;
@group(0) @binding(9) var sky: texture_cube<f32>;
@group(0) @binding(10) var skySampler: sampler;
@group(0) @binding(11) var brdfLUT: texture_2d<f32>;
@group(0) @binding(12) var brdfSampler: sampler;
const PI: f32 = 3.14159265358979323846;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
fn unproject(m: mat4x4f, ndc: vec3f) -> vec3f { let p = m * vec4f(ndc, 1.); return p.xyz / p.w; }
fn distributionGGX(NdotH: f32, alphaG: f32) -> f32 { let a2 = alphaG * alphaG; let d = NdotH * NdotH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
fn geometrySmithGGX(NdotL: f32, NdotV: f32, alphaG: f32) -> f32 {
  let a2 = alphaG * alphaG;
  return 0.5 / (NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2) + NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2));
}
fn fresnelSchlick(c: f32, F0: vec3f) -> vec3f { let t = 1.0 - c; let t2 = t * t; return F0 + (1.0 - F0) * (t2 * t2 * t); }

// A pixel of the picture, as its G-buffer has it.
struct Surface { base: vec3f, lit: f32, N: vec3f, roughness: f32, metallic: f32, glow: vec3f, F0: vec3f, albedo: vec3f, at: vec3f };
fn surfaceAt(texel: vec2i, at: vec3f) -> Surface {
  var s: Surface;
  let a = textureLoad(gAlbedo, texel, 0);
  let n = textureLoad(gNormal, texel, 0);
  let x = textureLoad(gExtra, texel, 0);
  s.base = a.rgb;
  s.lit = a.a;
  s.N = normalize(n.xyz * 2. - 1.);
  s.roughness = n.a;
  s.metallic = x.a;
  s.glow = x.rgb / max(1. - x.rgb, vec3f(1e-4));
  s.F0 = mix(vec3f(0.04), s.base, s.metallic);
  s.albedo = s.base * (1. - 0.04) * (1. - s.metallic);
  s.at = at;
  return s;
}

// Lite's CSM receiver for one cascade (csm-shadow-fragment-core.ts).
fn shadowOf(map: texture_depth_2d_array, worldPos: vec3f) -> f32 {
  let posFromLight = f.shadowMatrix * vec4f(worldPos, 1.0);
  let clipSpace = posFromLight.xyz / posFromLight.w;
  let uv = vec2f(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
  let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);
  let mapSz = f.shadowInfo.y;
  let invMapSz = f.shadowInfo.z;
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
  sh = mix(f.shadowInfo.x, 1.0, sh);
  let mask = smoothstep(1.0 - f.shadowInfo.w, 1.00000012, clamp(dot(clipSpace.xy, clipSpace.xy), 0.0, 1.0));
  return mix(sh, 1.0, mask);
}

// A light from L, of this radiance, on a surface seen from V: diffuse and
// specular, as the forward template sums them.
fn direct(s: Surface, L: vec3f, V: vec3f, radiance: vec3f) -> vec3f {
  let NdotL = max(dot(s.N, L), 0.0);
  var c = s.albedo * (1.0 / PI) * NdotL * radiance;
  if (NdotL > 0.0) {
    let alphaG = s.roughness * s.roughness + 0.0005;
    let NdotV = abs(dot(s.N, V)) + 0.0000001;
    let H = normalize(V + L);
    let D = distributionGGX(clamp(dot(s.N, H), 0.0000001, 1.0), alphaG);
    let G = geometrySmithGGX(NdotL, NdotV, alphaG);
    c += fresnelSchlick(saturate(dot(V, H)), s.F0) * D * G * NdotL * radiance * energy(s, V);
  }
  return c;
}
fn brdfOf(s: Surface, V: vec3f) -> vec3f { return textureSampleLevel(brdfLUT, brdfSampler, vec2f(abs(dot(s.N, V)) + 0.0000001, s.roughness), 0.).rgb; }
fn energy(s: Surface, V: vec3f) -> vec3f { return 1.0 + s.F0 * (1.0 / max(brdfOf(s, V).y, 0.001) - 1.0); }

// A lamp or a headlight: Lite's clustered falloff (contract §7).
fn lamp(s: Surface, l: Light, V: vec3f) -> vec3f {
  let toLight = l.position.xyz - s.at;
  let d2 = dot(toLight, toLight);
  let range = max(l.position.w, 0.0001);
  if (d2 >= range * range) { return vec3f(0.); }
  let dist = sqrt(d2);
  let L = toLight / max(dist, 0.0001);
  let falloff = d2 / max(range * range, 0.0000001);
  var att = saturate(1.0 - falloff * falloff);
  att = att * att / max(d2, 0.0000001);
  if (l.direction.w >= 0.0) {
    let cone = saturate((dot(-l.direction.xyz, L) - l.direction.w) / max(1.0 - l.direction.w, 0.001));
    att *= cone * cone;
  }
  return direct(s, L, V, l.color.rgb * l.color.a * att);
}
`;

/** The G-buffer lit: sun in the still map's shade, sky, lamps; linear, glow added. */
export const RELIGHT = /* wgsl */ `${COMMON}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let texel = vec2i(p.xy);
  let depth = textureLoad(gDepth, texel, 0);
  let size = vec2f(textureDimensions(gDepth));
  let t = p.xy / size;
  let at = unproject(f.stillInverse, vec3f(t.x * 2. - 1., 1. - t.y * 2., depth));
  let s = surfaceAt(texel, at);
  let V = normalize(f.eye.xyz - at);
  let NdotVU = dot(s.N, V);
  let NdotV = abs(NdotVU) + 0.0000001;
  let alphaG = s.roughness * s.roughness + 0.0005;
  // Uniform control flow for the samples: the sky and the table first.
  let brdf = textureSampleLevel(brdfLUT, brdfSampler, vec2f(NdotV, s.roughness), 0.).rgb;
  let lod = log2(f32(textureDimensions(sky).x) * alphaG) * f.image.z;
  var env = textureSampleLevel(sky, skySampler, reflect(-V, s.N), clamp(lod, 0.0, f32(textureNumLevels(sky) - 1))).rgb;
  let shade = shadowOf(shadowStatic, at);
  if (depth <= 0.) { return vec4f(0.); }
  let N = s.N;
  let irradiance = f.sh[0].rgb + f.sh[1].rgb * N.y + f.sh[2].rgb * N.z + f.sh[3].rgb * N.x
    + f.sh[4].rgb * (N.y * N.x) + f.sh[5].rgb * (N.y * N.z)
    + f.sh[6].rgb * (3.0 * N.z * N.z - 1.0) + f.sh[7].rgb * (N.z * N.x)
    + f.sh[8].rgb * (N.x * N.x - N.y * N.y);
  env = mix(env, irradiance, alphaG);
  let envReflectance = ((1.0 - s.F0) * brdf.x + s.F0 * brdf.y) * clamp((NdotVU + 1.) * (NdotVU + 1.) - 1.0 + 1., 0.0, 1.0);
  let energy = 1.0 + s.F0 * (1.0 / max(brdf.y, 0.001) - 1.0);
  var color = irradiance * s.albedo + env * envReflectance * energy + direct(s, f.sunDir.xyz, V, f.sunColor.rgb * shade);
  for (var i = 0u; i < u32(f.counts.x); i++) { color += lamp(s, lights[i], V); }
  return vec4f(s.lit * color + s.glow, 1.);
}`;

/** A pixel of the screen, found in the picture (still.ts's FIND): the ray
 *  through it meets the ground, that point looked up in the picture, the
 *  height there where the ray is met again, twice more. */
const FIND = /* wgsl */ `
struct Found { texel: vec2i, depth: f32, at: vec3f, eye: vec3f, };
fn pictureAt(texel: vec2i, size: vec2f) -> vec3f {
  let t = (vec2f(texel) + 0.5) / size;
  return unproject(f.stillInverse, vec3f(t.x * 2. - 1., 1. - t.y * 2., textureLoad(gDepth, texel, 0)));
}
fn find(pixel: vec2f) -> Found {
  let size = vec2f(textureDimensions(gDepth));
  let ndc = vec2f(pixel.x / f.screen.x * 2. - 1., 1. - pixel.y / f.screen.y * 2.);
  let a = unproject(f.seenInverse, vec3f(ndc, 1.));
  let b = unproject(f.seenInverse, vec3f(ndc, 0.5));
  var r: Found;
  r.eye = a;
  var h = 0.;
  for (var i = 0; i < 3; i++) {
    let p = a + (b - a) * ((h - a.z) / (b.z - a.z));
    let c = f.stillView * vec4f(p, 1.);
    let s = c.xy / c.w;
    let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
    r.texel = clamp(vec2i(floor(uv * size + 0.001)), vec2i(0), vec2i(size) - 1);
    r.depth = textureLoad(gDepth, r.texel, 0);
    if (r.depth <= 0.) { break; }
    r.at = pictureAt(r.texel, size);
    h = r.at.z;
  }
  return r;
}`;

/** The lit picture where the view now is: the sun taken where something
 *  moving shades it, the headlights added, tone mapped once, its depth as
 *  the view sees it. */
export const COMPOSITE = /* wgsl */ `${COMMON}
@group(0) @binding(13) var lit: texture_2d<f32>;
${FIND}
${TONE.helpersWGSL}
struct Out { @location(0) color: vec4f, @builtin(frag_depth) depth: f32, };
@fragment fn fs(@builtin(position) p: vec4f) -> Out {
  let found = find(p.xy);
  let at = found.at;
  var out: Out;
  if (found.depth <= 0.) {
    out.color = f.clear;
    out.depth = 0.;
    return out;
  }
  var color = textureLoad(lit, found.texel, 0).rgb;
  // Only where something moving shades it, the still map read, and only
  // there or under a headlight, the surface.
  let moving = shadowOf(shadowLive, at);
  var lost = 0.;
  if (moving < 1.) { lost = max(shadowOf(shadowStatic, at) - moving, 0.); }
  let beams = u32(f.counts.z);
  if (lost > 0. || beams > 0u) {
    let s = surfaceAt(found.texel, at);
    let V = normalize(found.eye - at);
    if (lost > 0.) { color = max(color - s.lit * direct(s, f.sunDir.xyz, V, f.sunColor.rgb * lost), vec3f(0.)); }
    let first = u32(f.counts.y);
    for (var i = first; i < first + beams; i++) { color += s.lit * lamp(s, lights[i], V); }
  }
  color = toneMap(color * f.image.x);
  color = clamp(pow(color, vec3f(1.0 / 2.2)), vec3f(0.0), vec3f(1.0));
  let hc = color * color * (3.0 - 2.0 * color);
  if (f.image.y < 1.0) { color = mix(vec3f(0.5), color, f.image.y); } else { color = mix(color, hc, f.image.y - 1.0); }
  out.color = vec4f(max(color, vec3f(0.)), 1.);
  let c = f.seen * vec4f(at, 1.);
  out.depth = clamp(c.z / c.w, 0., 1.);
  return out;
}`;
