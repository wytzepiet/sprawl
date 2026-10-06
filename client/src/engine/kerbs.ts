import { Constants, MaterialDefines, MaterialPluginBase, RawTexture, type Material, type Scene } from "@babylonjs/core";
import type { MeshGeometry } from "./Mesh";
import { RIM } from "./town/draw";

/**
 * Kerbs rounded from a texture rather than a rim of triangles. A flat sheet
 * (paving, a road) gets a texture over its own extent holding, at every
 * texel, how far it lies inside the sheet's kerbs: positive within,
 * negative beyond. Distance to a straight edge changes evenly and the
 * texture is read between texels evenly, so a kerb comes out exact even
 * where texels are coarser than the round. Drawing the sheet, a pixel
 * within reach of a kerb turns its facing outward as a rim's would: halfway
 * out at the edge, up again at the round's inner side. However the sheet is
 * cut into triangles, and however many kerbs come near one.
 *
 * In the sheet's own frame, so a road tile's shape, placed many times, is
 * one texture: a sheet is moved, never turned.
 */

/** Texels to a tile, at most; a big sheet takes fewer. */
const DENSITY = 32;
/** The longest side a kerb texture may have, in texels. */
const MOST = 2048;
/** Beyond reach of every kerb. */
const FAR = 1;

export interface KerbField {
  texture: RawTexture;
  /** The texture's low corner in the sheet's frame, and its extent. */
  origin: [number, number];
  size: [number, number];
  texels: [number, number];
}

/** Which of a sheet's own edges are kerbs: all, or those this says. */
export type KerbRule = (a: number[], b: number[], out: number[]) => boolean;

/** A box in a sheet's frame: x0, y0, x1, y1. */
export type Extent = [number, number, number, number];

/** A kerb: an edge of a sheet, and the way into the sheet. */
export type Kerb = { a: number[]; b: number[]; inward: number[] };

/** A sheet's kerbs: each edge only one of its triangles has, where `kerb`
 *  says it is one, with the way into the sheet. */
export function kerbsOf(g: MeshGeometry, kerb: KerbRule = () => true): Kerb[] {
  const p = g.positions;
  const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const key = (v: number[]) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < g.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [ka, kb] = [key(at(g.indices[t + k])), key(at(g.indices[t + ((k + 1) % 3)]))];
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  const out: Kerb[] = [];
  for (let t = 0; t < g.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => at(g.indices[t + k]));
    const c = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [v[k], v[(k + 1) % 3]];
      const [ka, kb] = [key(a), key(b)];
      if (count.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`) !== 1) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let o = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      if ((a[0] - c[0]) * o[0] + (a[1] - c[1]) * o[1] < 0) o = [-o[0], -o[1]];
      if (!kerb(a, b, o)) continue;
      out.push({ a, b, inward: [-o[0], -o[1]] });
    }
  }
  return out;
}

/** The box a sheet covers. */
export function extentOf(g: MeshGeometry): Extent {
  const p = g.positions;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) [x0, y0, x1, y1] = [Math.min(x0, p[i]), Math.min(y0, p[i + 1]), Math.max(x1, p[i]), Math.max(y1, p[i + 1])];
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

/**
 * A sheet's kerb distances over a box of it: at
 * each texel within reach of a kerb, the signed distance to the nearest,
 * inside or out read off that kerb.
 */
export function kerbData(kerbs: Kerb[], extent: Extent) {
  let [x0, y0, x1, y1] = extent;
  const density = Math.min(DENSITY, MOST / Math.max(x1 - x0 + 0.5, y1 - y0 + 0.5));
  const reach = RIM + 2 / density;
  [x0, y0] = [x0 - reach, y0 - reach];
  const [w, h] = [Math.max(2, Math.ceil((x1 + reach - x0) * density)), Math.max(2, Math.ceil((y1 + reach - y0) * density))];
  const data = kerbDistances(kerbs, x0, y0, density, w, h);
  return { data, origin: [x0, y0] as [number, number], size: [w / density, h / density] as [number, number], texels: [w, h] as [number, number] };
}

/**
 * Signed distances to kerbs over a grid of `w` by `h` texels, `density`
 * to a tile, from (x0, y0): at each texel within reach of a kerb, the
 * distance to the nearest, inside or out read off that kerb; beyond reach
 * of all, FAR. Each kerb visits only the band of texels within reach of
 * it, a row's stretch at a time.
 */
export function kerbDistances(kerbs: Kerb[], x0: number, y0: number, density: number, w: number, h: number): Float32Array {
  const reach = RIM + 2 / density;
  const [x1, y1] = [x0 + w / density, y0 + h / density];
  const data = new Float32Array(w * h).fill(FAR);
  const best = new Float32Array(w * h).fill(Infinity);
  for (const { a, b, inward } of kerbs) {
    if (Math.max(a[0], b[0]) < x0 - reach || Math.min(a[0], b[0]) > x1 + reach || Math.max(a[1], b[1]) < y0 - reach || Math.min(a[1], b[1]) > y1 + reach) continue;
    const [ax, ay, ex, ey] = [a[0], a[1], b[0] - a[0], b[1] - a[1]];
    const len2 = ex * ex + ey * ey || 1;
    const [nx, ny] = inward;
    const [bx0, bx1] = [Math.min(a[0], b[0]) - reach, Math.max(a[0], b[0]) + reach];
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach - y0) * density));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(a[1], b[1]) + reach - y0) * density));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) / density;
      // The row's stretch within reach of the kerb's line, in its box.
      let [lo, hi] = [bx0, bx1];
      if (Math.abs(nx) > 1e-6) {
        const [u, v] = [ax + (-reach - ny * (py - ay)) / nx, ax + (reach - ny * (py - ay)) / nx];
        [lo, hi] = [Math.max(lo, Math.min(u, v)), Math.min(hi, Math.max(u, v))];
      } else if (Math.abs(ny * (py - ay)) > reach) continue;
      const i0 = Math.max(0, Math.floor((lo - x0) * density));
      const i1 = Math.min(w - 1, Math.ceil((hi - x0) * density));
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) / density;
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
        const [dx, dy] = [px - ax - ex * t, py - ay - ey * t];
        const d = Math.sqrt(dx * dx + dy * dy);
        const k = j * w + i;
        if (d >= best[k]) continue;
        best[k] = d;
        data[k] = dx * nx + dy * ny >= 0 ? d : -d;
      }
    }
  }
  return data;
}

/** A sheet's kerb texture over a box of it, from its kerbs: one channel of
 *  half floats, read smoothly. */
export function kerbField(scene: Scene, kerbs: Kerb[], extent: Extent): KerbField {
  const { data, origin, size, texels } = kerbData(kerbs, extent);
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
  const texture = new RawTexture(half, texels[0], texels[1], Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return { texture, origin, size, texels };
}

/** A float as a half float's bits, through one shared word. */
const word = new Float32Array(1);
const bits = new Uint32Array(word.buffer);
export function toHalf(v: number): number {
  word[0] = v;
  const x = bits[0];
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const man = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (man >> 13);
}

class KerbDefines extends MaterialDefines {
  KERB = false;
}

// The sheet's own frame, carried to every pixel: a sheet is moved, never
// turned, so its ways are the world's.
const VERTEX_GLSL = {
  CUSTOM_VERTEX_DEFINITIONS: `#ifdef KERB
varying vec2 vKerbAt;
#endif`,
  CUSTOM_VERTEX_MAIN_END: `#ifdef KERB
vKerbAt = positionUpdated.xy;
#endif`,
};
const FRAGMENT_GLSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef KERB
varying vec2 vKerbAt;
uniform sampler2D kerbField;
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef KERB
vec2 kerbUv = (vKerbAt - kerbOrigin) / kerbSize;
float kerbD = texture2D(kerbField, kerbUv).r;
float kerbDx = texture2D(kerbField, kerbUv + vec2(kerbTexel.x, 0.)).r - texture2D(kerbField, kerbUv - vec2(kerbTexel.x, 0.)).r;
float kerbDy = texture2D(kerbField, kerbUv + vec2(0., kerbTexel.y)).r - texture2D(kerbField, kerbUv - vec2(0., kerbTexel.y)).r;
if (kerbD >= 0. && kerbD < kerbWidth && kerbDx * kerbDx + kerbDy * kerbDy > 0.) {
  vec3 kerbOut = normalize(vec3(-kerbDx, -kerbDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + kerbOut), 1. - kerbD / kerbWidth));
}
#endif`,
};
const VERTEX_WGSL = {
  CUSTOM_VERTEX_DEFINITIONS: `#ifdef KERB
varying vKerbAt: vec2f;
#endif`,
  CUSTOM_VERTEX_MAIN_END: `#ifdef KERB
vertexOutputs.vKerbAt = positionUpdated.xy;
#endif`,
};
const FRAGMENT_WGSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef KERB
varying vKerbAt: vec2f;
var kerbFieldSampler: sampler;
var kerbField: texture_2d<f32>;
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef KERB
let kerbUv = (fragmentInputs.vKerbAt - uniforms.kerbOrigin) / uniforms.kerbSize;
let kerbTx = vec2f(uniforms.kerbTexel.x, 0.);
let kerbTy = vec2f(0., uniforms.kerbTexel.y);
let kerbD = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv, 0.).r;
let kerbDx = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTx, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTx, 0.).r;
let kerbDy = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTy, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTy, 0.).r;
if (kerbD >= 0. && kerbD < uniforms.kerbWidth && kerbDx * kerbDx + kerbDy * kerbDy > 0.) {
  let kerbOut = normalize(vec3f(-kerbDx, -kerbDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + kerbOut), 1. - kerbD / uniforms.kerbWidth));
}
#endif`,
};

/** Kerbs rounded from a sheet's kerb texture, on its material; how far in
 *  the round reaches is the material's. */
export class KerbPlugin extends MaterialPluginBase {
  width = RIM;

  constructor(material: Material, public field: KerbField) {
    super(material, "Kerb", 210, new KerbDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: KerbDefines) {
    defines.KERB = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("kerbField");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "kerbOrigin", size: 2, type: "vec2" },
        { name: "kerbSize", size: 2, type: "vec2" },
        { name: "kerbTexel", size: 2, type: "vec2" },
        { name: "kerbWidth", size: 1, type: "float" },
      ],
      fragment: shaderLanguage === 1
        ? "uniform kerbOrigin: vec2f; uniform kerbSize: vec2f; uniform kerbTexel: vec2f; uniform kerbWidth: f32;"
        : "uniform vec2 kerbOrigin; uniform vec2 kerbSize; uniform vec2 kerbTexel; uniform float kerbWidth;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; updateFloat(n: string, v: number): void; setTexture(n: string, t: RawTexture): void }) {
    const f = this.field;
    ubo.updateFloat2("kerbOrigin", f.origin[0], f.origin[1]);
    ubo.updateFloat2("kerbSize", f.size[0], f.size[1]);
    ubo.updateFloat2("kerbTexel", 1 / f.texels[0], 1 / f.texels[1]);
    ubo.updateFloat("kerbWidth", this.width);
    ubo.setTexture("kerbField", f.texture);
  }

  getClassName() {
    return "KerbPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    const wgsl = shaderLanguage === 1;
    return shaderType === "vertex" ? (wgsl ? VERTEX_WGSL : VERTEX_GLSL) : wgsl ? FRAGMENT_WGSL : FRAGMENT_GLSL;
  }
}

/** A sheet's material rounded at its kerbs from this kerb texture: the
 *  texture swapped in, if it already is, and the old one let go. */
export function kerbed(material: Material, field: KerbField) {
  const plugin = material.pluginManager?.getPlugin<KerbPlugin>("Kerb");
  if (!plugin) return new KerbPlugin(material, field);
  if (plugin.field.texture !== field.texture) plugin.field.texture.dispose();
  plugin.field = field;
  return plugin;
}
