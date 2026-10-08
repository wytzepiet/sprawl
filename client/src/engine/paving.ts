import { MaterialDefines, MaterialPluginBase, type Material, type PBRMaterial, type RawTexture } from "@babylonjs/core";
import { grain } from "./ground";

/**
 * Paving laid, as the light finds it: slabs in courses, each course half a
 * slab on from the last, each slab's edges rounding down into its joint
 * and each slab sitting a hair askew, and a shade of its own, lighter or
 * darker, warmer or cooler, as laid stone is; and a faint grain over all.
 * Further out than a slab is a few pixels it fades, so it does not
 * shimmer.
 */

/** A slab's side, in tiles; how far in from its edge it rounds down into
 *  the joint; how steeply; how far askew a slab sits; and the grain over
 *  this many tiles, tilting this far. */
const SLAB = 0.12;
const JOINT = 0.014;
const DEPTH = 0.8;
const ASKEW = 0.075;
const GRAIN_SPAN = 2;
const BUMP = 0.1;
/** How much a slab's shade varies, either way, and how much of that is
 *  warmth: lighter slabs a touch browner, darker a touch greyer. */
const SHADE = 0.03;
const WARM = [1.1, 1, 0.8];
/** How rough the paving is: worn stone, smoothed underfoot, with a sheen. */
const ROUGHNESS = 0.6;

const n = (x: number) => x.toFixed(4);

class PavingDefines extends MaterialDefines {
  PAVING = false;
}

const GLSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `uniform sampler2D pavingGrain;`,
  CUSTOM_FRAGMENT_MAIN_BEGIN: `vec2 pavingGrainUv = vPositionW.xy / ${n(GRAIN_SPAN)};
vec2 pavingBump = vec2(texture2D(pavingGrain, pavingGrainUv + vec2(${n(1 / 256)}, 0.)).r - texture2D(pavingGrain, pavingGrainUv - vec2(${n(1 / 256)}, 0.)).r, texture2D(pavingGrain, pavingGrainUv + vec2(0., ${n(1 / 256)})).r - texture2D(pavingGrain, pavingGrainUv - vec2(0., ${n(1 / 256)})).r);
vec2 pavingAt = vPositionW.xy / ${n(SLAB)};
pavingAt.x += 0.5 * mod(floor(pavingAt.y), 2.);
vec2 pavingSlab = floor(pavingAt);
float pavingNear = 1. - smoothstep(0.15, 0.3, max(fwidth(pavingAt.x), fwidth(pavingAt.y)));`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
vec2 pavingIn = pavingAt - pavingSlab;
vec2 pavingEdge = min(pavingIn, 1. - pavingIn) * ${n(SLAB)};
vec2 pavingTilt = sign(pavingIn - 0.5) * max(vec2(0.), 1. - pavingEdge / ${n(JOINT)}) * ${n(DEPTH)};
pavingTilt += (vec2(texture2D(pavingGrain, (mod(pavingSlab, 256.) + 0.5) / 256.).r, texture2D(pavingGrain, (mod(pavingSlab + 97., 256.) + 0.5) / 256.).r) - 0.5) * ${n(ASKEW * 2)};
#ifdef KERB
// No slabs in the kerb's row of stones.
pavingNear *= 1. - kerbBand;
#endif
float pavingShade = (texture2D(pavingGrain, (mod(pavingSlab + 41., 256.) + 0.5) / 256.).r - 0.5) * 2. * ${n(SHADE)} * pavingNear;
baseColor.rgb *= 1. + pavingShade * vec3(${WARM.map(n).join(", ")});
normalW = normalize(normalW + vec3(pavingTilt * pavingNear - pavingBump * ${n(BUMP)}, 0.));`,
};

const WGSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `var pavingGrainSampler: sampler; var pavingGrain: texture_2d<f32>;`,
  CUSTOM_FRAGMENT_MAIN_BEGIN: `let pavingGrainUv = fragmentInputs.vPositionW.xy / ${n(GRAIN_SPAN)};
let pavingBump = vec2f(textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv + vec2f(${n(1 / 256)}, 0.)).r - textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv - vec2f(${n(1 / 256)}, 0.)).r, textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv + vec2f(0., ${n(1 / 256)})).r - textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv - vec2f(0., ${n(1 / 256)})).r);
var pavingAt = fragmentInputs.vPositionW.xy / ${n(SLAB)};
pavingAt.x += 0.5 * (floor(pavingAt.y) - 2. * floor(floor(pavingAt.y) / 2.));
let pavingSlab = floor(pavingAt);
let pavingNear = 1. - smoothstep(0.15, 0.3, max(fwidth(pavingAt.x), fwidth(pavingAt.y)));`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let pavingIn = pavingAt - pavingSlab;
let pavingEdge = min(pavingIn, 1. - pavingIn) * ${n(SLAB)};
var pavingTilt = sign(pavingIn - 0.5) * max(vec2f(0.), 1. - pavingEdge / ${n(JOINT)}) * ${n(DEPTH)};
let pavingSlabUv = (pavingSlab - 256. * floor(pavingSlab / 256.) + 0.5) / 256.;
let pavingSlabUv2 = (pavingSlab + 97. - 256. * floor((pavingSlab + 97.) / 256.) + 0.5) / 256.;
pavingTilt += (vec2f(textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv, 0.).r, textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv2, 0.).r) - 0.5) * ${n(ASKEW * 2)};
var pavingSlabs = pavingNear;
#ifdef KERB
// No slabs in the kerb's row of stones.
pavingSlabs *= 1. - kerbBand;
#endif
let pavingSlabUv3 = (pavingSlab + 41. - 256. * floor((pavingSlab + 41.) / 256.) + 0.5) / 256.;
let pavingShade = (textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv3, 0.).r - 0.5) * 2. * ${n(SHADE)} * pavingSlabs;
baseColor = vec4f(baseColor.rgb * (1. + pavingShade * vec3f(${WARM.map(n).join(", ")})), baseColor.a);
normalW = normalize(normalW + vec3f(pavingTilt * pavingSlabs - pavingBump * ${n(BUMP)}, 0.));`,
};

/** A paving material's slabs and grain. */
class PavingPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "Paving", 220, new PavingDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: PavingDefines) {
    defines.PAVING = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("pavingGrain");
  }

  bindForSubMesh(ubo: { setTexture(n: string, t: RawTexture): void }) {
    ubo.setTexture("pavingGrain", grain(this._material.getScene()));
  }

  getClassName() {
    return "PavingPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    if (shaderType === "vertex") return null;
    return shaderLanguage === 1 ? WGSL : GLSL;
  }
}

/** A material laid as paving, once. */
export function pave(material: Material) {
  if (material.pluginManager?.getPlugin("Paving")) return;
  new PavingPlugin(material);
  (material as PBRMaterial).roughness = ROUGHNESS;
}
