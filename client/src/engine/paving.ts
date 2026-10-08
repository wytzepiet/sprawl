import type { EngineContext, MaterialPlugin } from "@babylonjs/lite";
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
export const ROUGHNESS = 0.6;

const n = (x: number) => x.toFixed(4);

/** A paving material's slabs and grain; on a kerbed sheet, none in the
 *  kerb's row of stones (`kerbs.ts`, before it). Paving is worn stone, its
 *  roughness `ROUGHNESS`. */
export function pavingPlugin(engine: EngineContext, kerbed: boolean): MaterialPlugin {
  return {
    name: kerbed ? "PavingKerbed" : "Paving",
    priority: 220,
    getSamplers: () => [{ texture: "pavingGrain", sampler: "pavingGrainSampler" }],
    bindTextures: (out) => out.push({ texture: grain(engine) }),
    getCustomCode: (stage) =>
      stage === "fragment"
        ? {
            CUSTOM_FRAGMENT_MAIN_BEGIN: `let pavingGrainUv = input.worldPos.xy / ${n(GRAIN_SPAN)};
let pavingBump = vec2f(textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv + vec2f(${n(1 / 256)}, 0.)).r - textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv - vec2f(${n(1 / 256)}, 0.)).r, textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv + vec2f(0., ${n(1 / 256)})).r - textureSample(pavingGrain, pavingGrainSampler, pavingGrainUv - vec2f(0., ${n(1 / 256)})).r);
var pavingAt = input.worldPos.xy / ${n(SLAB)};
pavingAt.x += 0.5 * (floor(pavingAt.y) - 2. * floor(floor(pavingAt.y) / 2.));
let pavingSlab = floor(pavingAt);
let pavingNear = 1. - smoothstep(0.15, 0.3, max(fwidth(pavingAt.x), fwidth(pavingAt.y)));`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let pavingIn = pavingAt - pavingSlab;
let pavingEdge = min(pavingIn, 1. - pavingIn) * ${n(SLAB)};
var pavingTilt = sign(pavingIn - 0.5) * max(vec2f(0.), 1. - pavingEdge / ${n(JOINT)}) * ${n(DEPTH)};
let pavingSlabUv = (pavingSlab - 256. * floor(pavingSlab / 256.) + 0.5) / 256.;
let pavingSlabUv2 = (pavingSlab + 97. - 256. * floor((pavingSlab + 97.) / 256.) + 0.5) / 256.;
pavingTilt += (vec2f(textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv, 0.).r, textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv2, 0.).r) - 0.5) * ${n(ASKEW * 2)};
var pavingSlabs = pavingNear;
${kerbed ? "// No slabs in the kerb's row of stones.\npavingSlabs *= 1. - kerbBand;" : ""}
let pavingSlabUv3 = (pavingSlab + 41. - 256. * floor((pavingSlab + 41.) / 256.) + 0.5) / 256.;
let pavingShade = (textureSampleLevel(pavingGrain, pavingGrainSampler, pavingSlabUv3, 0.).r - 0.5) * 2. * ${n(SHADE)} * pavingSlabs;
baseColor *= 1. + pavingShade * vec3f(${WARM.map(n).join(", ")});
N = normalize(N + vec3f(pavingTilt * pavingSlabs - pavingBump * ${n(BUMP)}, 0.));`,
          }
        : null,
  };
}
