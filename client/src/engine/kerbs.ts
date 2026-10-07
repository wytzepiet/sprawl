import { Color3, Constants, MaterialDefines, MaterialPluginBase, RawTexture, type Material, type Scene, type PBRMaterial } from "@babylonjs/core";
import { RIM } from "./town/draw";
import type { KerbTexels } from "./kerbLines";

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
 * Of a sheet whose every edge is a kerb, as the paving's, the texture can
 * hold the sheet itself too, how far inside it each point is, and the
 * sheet is then drawn as a square over its box, cut to it (as road tiles
 * are, `roads.ts`). In the sheet's own frame: a sheet is moved, never
 * turned. The texels are worked out apart, with no Babylon, so the town's
 * are worked out off the main thread (`kerbLines.ts`).
 */

/** A sheet's kerb texture, made of its texels (`kerbTexels`). */
export function kerbField(scene: Scene, { half, origin, size, texels }: KerbTexels): KerbField {
  const texture = new RawTexture(half, texels[0], texels[1], Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return { texture, origin, size, texels };
}

export interface KerbField {
  texture: RawTexture;
  /** The texture's low corner in the sheet's frame, and its extent. */
  origin: [number, number];
  size: [number, number];
  texels: [number, number];
}

/** Where roads are cut into a sheet (`kerbTexels`' roads): the sheet
 *  reaches this far over a road's edge, in tiles, over the crumbled fringe
 *  of its asphalt (`roads.ts`), and its kerb stone rounds down to the road
 *  over this far. */
const CUT = 0.04;
const STONE = 0.035;
/** A sheet's kerb stones, along every edge of it, onto the roads cut into
 *  it and onto what lies round it: a row this wide, this much lighter than
 *  the sheet, set off from it by a joint the stone and the sheet each round
 *  down into, over this far either side, this steeply, as the slabs' do
 *  (`paving.ts`). */
const BAND = 0.04;
const BAND_LIGHT = 1.07;
const JOINT = 0.008;
const JOINT_DEPTH = 0.6;
const n = (x: number) => x.toFixed(4);

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
vec4 kerbAt = texture2D(kerbField, kerbUv);
if (kerbAt.g < 0.) discard;
if (kerbAt.a > ${n(CUT)}) discard;
if (abs(kerbAt.b) < 1.) baseColor.rgb *= kerbLine;
float kerbD = kerbAt.r;
float kerbEdge = min(kerbD >= 0. ? kerbD : 9., ${n(CUT)} - kerbAt.a);
float kerbBand = 1. - step(${n(BAND)}, kerbEdge);
baseColor.rgb *= mix(1., ${n(BAND_LIGHT)}, kerbBand);
float kerbDx = texture2D(kerbField, kerbUv + vec2(kerbTexel.x, 0.)).r - texture2D(kerbField, kerbUv - vec2(kerbTexel.x, 0.)).r;
float kerbDy = texture2D(kerbField, kerbUv + vec2(0., kerbTexel.y)).r - texture2D(kerbField, kerbUv - vec2(0., kerbTexel.y)).r;
if (kerbD >= 0. && kerbD < kerbWidth && kerbDx * kerbDx + kerbDy * kerbDy > 0.) {
  vec3 kerbOut = normalize(vec3(-kerbDx, -kerbDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + kerbOut), 1. - kerbD / kerbWidth));
}
float kerbStone = (${n(CUT)} - kerbAt.a) / ${n(STONE)};
vec2 kerbToRoad = vec2(texture2D(kerbField, kerbUv + vec2(kerbTexel.x, 0.)).a - texture2D(kerbField, kerbUv - vec2(kerbTexel.x, 0.)).a, texture2D(kerbField, kerbUv + vec2(0., kerbTexel.y)).a - texture2D(kerbField, kerbUv - vec2(0., kerbTexel.y)).a);
if (kerbStone < 1. && dot(kerbToRoad, kerbToRoad) > 0.) {
  normalW = normalize(mix(normalW, normalize(normalW + vec3(normalize(kerbToRoad), 0.)), 1. - kerbStone));
}
// The joint behind the kerb stones: in from whichever edge is nearer, the
// stone on its one side and the sheet on the other rounding down into it.
vec2 kerbIn = ${n(CUT)} - kerbAt.a < (kerbD >= 0. ? kerbD : 9.) ? -kerbToRoad : vec2(kerbDx, kerbDy);
float kerbJoint = kerbEdge - ${n(BAND)};
if (abs(kerbJoint) < ${n(JOINT)} && dot(kerbIn, kerbIn) > 0.) {
  normalW = normalize(normalW - vec3(normalize(kerbIn) * sign(kerbJoint) * (1. - abs(kerbJoint) / ${n(JOINT)}) * ${n(JOINT_DEPTH)}, 0.));
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
let kerbAt = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv, 0.);
if (kerbAt.g < 0.) { discard; }
if (kerbAt.a > ${n(CUT)}) { discard; }
if (abs(kerbAt.b) < 1.) { baseColor = vec4f(baseColor.rgb * uniforms.kerbLine, baseColor.a); }
let kerbD = kerbAt.r;
let kerbEdge = min(select(9., kerbD, kerbD >= 0.), ${n(CUT)} - kerbAt.a);
let kerbBand = 1. - step(${n(BAND)}, kerbEdge);
baseColor = vec4f(baseColor.rgb * mix(1., ${n(BAND_LIGHT)}, kerbBand), baseColor.a);
let kerbDx = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTx, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTx, 0.).r;
let kerbDy = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTy, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTy, 0.).r;
if (kerbD >= 0. && kerbD < uniforms.kerbWidth && kerbDx * kerbDx + kerbDy * kerbDy > 0.) {
  let kerbOut = normalize(vec3f(-kerbDx, -kerbDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + kerbOut), 1. - kerbD / uniforms.kerbWidth));
}
let kerbStone = (${n(CUT)} - kerbAt.a) / ${n(STONE)};
let kerbToRoad = vec2f(textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTx, 0.).a - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTx, 0.).a, textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTy, 0.).a - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTy, 0.).a);
if (kerbStone < 1. && dot(kerbToRoad, kerbToRoad) > 0.) {
  normalW = normalize(mix(normalW, normalize(normalW + vec3f(normalize(kerbToRoad), 0.)), 1. - kerbStone));
}
// The joint behind the kerb stones: in from whichever edge is nearer, the
// stone on its one side and the sheet on the other rounding down into it.
let kerbIn = select(vec2f(kerbDx, kerbDy), -kerbToRoad, ${n(CUT)} - kerbAt.a < select(9., kerbD, kerbD >= 0.));
let kerbJoint = kerbEdge - ${n(BAND)};
if (abs(kerbJoint) < ${n(JOINT)} && dot(kerbIn, kerbIn) > 0.) {
  normalW = normalize(normalW - vec3f(normalize(kerbIn) * sign(kerbJoint) * (1. - abs(kerbJoint) / ${n(JOINT)}) * ${n(JOINT_DEPTH)}, 0.));
}
#endif`,
};

/** Kerbs rounded from a sheet's kerb texture, on its material; how far in
 *  the round reaches is the material's. */
export class KerbPlugin extends MaterialPluginBase {
  width = RIM;
  /** The colour lines are painted in. */
  line = new Color3(0, 0, 0);

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
        { name: "kerbLine", size: 3, type: "vec3" },
      ],
      fragment: shaderLanguage === 1
        ? "uniform kerbOrigin: vec2f; uniform kerbSize: vec2f; uniform kerbTexel: vec2f; uniform kerbWidth: f32; uniform kerbLine: vec3f;"
        : "uniform vec2 kerbOrigin; uniform vec2 kerbSize; uniform vec2 kerbTexel; uniform float kerbWidth; uniform vec3 kerbLine;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; updateFloat(n: string, v: number): void; updateFloat3(n: string, x: number, y: number, z: number): void; setTexture(n: string, t: RawTexture): void }) {
    const f = this.field;
    // The line's colour over the sheet's, so the sheet's light and glow
    // come out the line's own.
    const [line, sheet] = [this.line, (this._material as PBRMaterial).albedoColor];
    ubo.updateFloat3("kerbLine", line.r / Math.max(sheet.r, 1e-3), line.g / Math.max(sheet.g, 1e-3), line.b / Math.max(sheet.b, 1e-3));
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

/** A sheet's material rounded at its kerbs from this kerb texture, its
 *  lines painted in `line`: the texture swapped in, if it already is, and
 *  the old one let go. */
export function kerbed(material: Material, field: KerbField, line = new Color3(0, 0, 0)) {
  let plugin = material.pluginManager?.getPlugin<KerbPlugin>("Kerb");
  if (!plugin) plugin = new KerbPlugin(material, field);
  else if (plugin.field.texture !== field.texture) plugin.field.texture.dispose();
  plugin.field = field;
  plugin.line = line;
  return plugin;
}
