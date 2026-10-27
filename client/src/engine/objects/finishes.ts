import { markMaterialUboDirty, type EngineContext, type MaterialPlugin, type PbrMaterialProps } from "@babylonjs/lite";
import barkRecipe from "../bark.ts?raw";
import { BARK_LONG, BARK_ROUND } from "../bark";
import { bakedTexture } from "../bakeCache";
import { BUMP, CLOVER, CREASE, grain, lawn } from "../ground";
import { LAWN_TILES } from "../lawn";
import { night } from "../lights";
import { pavingPlugin } from "../paving";
import { slate } from "../peaks";
import { SPAN as SLATE_SPAN } from "../slate";
import { WINDOW_GLOW } from "../TownLayer";
import { FLAT, SPILL, type Built, type Finish } from "./kit";
import type { Shape } from "./sea";

/**
 * How a model's finishes look (`kit.ts` builds the shapes), each a coat
 * on the town's material, made once an engine.
 *
 * - matte: timber, brick and paint.
 * - zinc: golfplaat, its waves in the light alone, shading their troughs.
 * - tiles: courses up a roof, each lapped over the one below.
 * - glass: dark and glossy by day, lit warm from inside at night.
 * - bark, baked (`bark.ts`).
 * - leaves: a hedge's or a shrub's, lumpy and dark between the lumps.
 * - rock: the mountains' own slate (`slate.ts`), read three ways round so
 *   a face that stands up is as fine as one that lies.
 * - gravel and chips, heaped (`kit.ts`'s `heap`), their foot frayed.
 * - On the ground, frayed at their edge as the land's are: the town's
 *   grass (`lawn.ts`), blade by blade, clover in it; its paving
 *   (`paving.ts`); earth and dust, their grain in the light.
 *
 * A map's slopes are turned along the surface by the map's own run over
 * it, read off the pixels beside (a cotangent frame).
 */

/** A finish: a coat on the town's material, made once an engine. */
export type Coat = (engine: EngineContext) => MaterialPlugin;
type Texture = Parameters<NonNullable<MaterialPlugin["bindTextures"]>>[0][number]["texture"];
export const f = (x: number) => x.toFixed(4);
const frame = (p: string) => `let ${p}Dp1 = dpdx(input.worldPos);
let ${p}Dp2 = dpdy(input.worldPos);
let ${p}Du1 = dpdx(input.uv);
let ${p}Du2 = dpdy(input.uv);
let ${p}T = cross(${p}Dp2, N) * ${p}Du1.x + cross(N, ${p}Dp1) * ${p}Du2.x;
let ${p}B = cross(${p}Dp2, N) * ${p}Du1.y + cross(N, ${p}Dp1) * ${p}Du2.y;
let ${p}Inv = inverseSqrt(max(max(dot(${p}T, ${p}T), dot(${p}B, ${p}B)), 1e-14));`;
function coat(name: string, code: string, textures: (engine: EngineContext) => Record<string, Texture> = () => ({}), definitions = ""): Coat {
  const made = new WeakMap<EngineContext, MaterialPlugin>();
  return (engine) => {
    let plugin = made.get(engine);
    if (plugin) return plugin;
    const bound = Object.entries(textures(engine));
    plugin = {
      name,
      priority: 900,
      ...(bound.length ? { getSamplers: () => bound.map(([t]) => ({ texture: t, sampler: `${t}Sampler` })), bindTextures: (out) => out.push(...bound.map(([, texture]) => ({ texture }))) } : {}),
      getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_DEFINITIONS: definitions, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: code } : null),
    };
    made.set(engine, plugin);
    return plugin;
  };
}

/** How far zinc's waves turn the light, how dark their troughs, how rough
 *  the metal. */
const [ZINC_TILT, ZINC_TROUGH, ZINC_ROUGH] = [0.55, 0.12, 0.35];
const MATTE = coat("ModelMatte", "roughness = 0.8;");
const ZINC = coat("ModelZinc", `${frame("zinc")}
let zincWave = 6.2832 * input.uv.x;
let zincFine = 1. - smoothstep(0.25, 0.5, fwidth(input.uv.x));
N = normalize(N + zincT * zincInv * sin(zincWave) * ${f(ZINC_TILT)} * zincFine);
baseColor = baseColor * (1. - ${f(ZINC_TROUGH)} * (0.5 - 0.5 * cos(zincWave)) * zincFine);
metallic = 1.;
roughness = ${f(ZINC_ROUGH)};`);
const BARK = coat("ModelBark", `${frame("bark")}
let barkMap = textureSample(modelBark, modelBarkSampler, input.uv);
let barkTilt = barkMap.rg * 2. - 1.;
N = normalize(N + (barkT * barkTilt.x + barkB * barkTilt.y) * barkInv);
baseColor = baseColor * barkMap.b;
roughness = 0.95;`, (engine) => ({ modelBark: bark(engine) }));

/** Glass's materials, each told as the night comes and goes (`glow`). */
const GLASSES = new WeakMap<EngineContext, MaterialPlugin>();
export const GLASS: Coat = (engine) => {
  const made = GLASSES.get(engine);
  if (made) return made;
  const plugin: MaterialPlugin = {
    name: "ModelGlass",
    priority: 900,
    getUniforms: () => ({ ubo: [{ name: "modelGlow", type: "f32" }] }),
    writeUbo: (data, offsets) => void (data[offsets.get("modelGlow")! / 4] = night.on),
    getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "roughness = 0.15;", CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `color += vec3f(${WINDOW_GLOW.join(", ")}) * material.modelGlow;` } : null),
  };
  GLASSES.set(engine, plugin);
  return plugin;
};
const lit = new Set<PbrMaterialProps>();
let shown = -1;
export const glowing = (material: PbrMaterialProps) => void (lit.add(material), (shown = -1));
/** Each frame: glass told the night, if it has changed. */
export function glow() {
  if (night.on === shown) return;
  shown = night.on;
  for (const m of lit) markMaterialUboDirty(m);
}

/** How far each course tips the light down its slope and shades its foot. */
const [COURSE_TIP, COURSE_SHADE] = [0.35, 0.18];
const TILES = coat("ModelTiles", `${frame("tiles")}
let tilesUp = fract(input.uv.x);
let tilesAlong = fract(input.uv.y + 0.5 * floor(input.uv.x));
let tilesFine = 1. - smoothstep(0.25, 0.5, fwidth(input.uv.x));
N = normalize(N + tilesT * tilesInv * (tilesUp - 0.5) * ${f(COURSE_TIP)} * tilesFine);
baseColor = baseColor * (1. - ${f(COURSE_SHADE)} * (1. - smoothstep(0., 0.3, tilesUp)) * tilesFine) * (1. - 0.1 * step(0.92, tilesAlong) * tilesFine);
roughness = 0.85;`);

/** How big the lumps of something loose are and their flecks, as the
 *  land's grain is read over them (`ground.ts`, 256 texels). */
const [LUMPS, FLECKS] = [3.5, 1.6];
/** Something loose, lumpy by the land's grain, gone where `gone` says,
 *  and as `look` has it; `looseSlope` the grain's slope read at a size,
 *  `looseCell` three numbers the same for the same cell. */
function loose(name: string, gone: string, look: string): Coat {
  const read = (at: string, span: string) => `textureSample(looseGrain, looseGrainSampler, (${at}) / ${span})`;
  return coat(name, `let looseAt = input.worldPos.xy;
let looseLump = 0.6 * ${read("looseAt", f(LUMPS))}.r + 0.4 * ${read("looseAt", f(FLECKS))}.r;
if (${gone}) { discard; }${look}`, (engine) => ({ looseGrain: grain(engine) }), `fn looseCell(c: vec2f) -> vec3f {
  let k = bitcast<vec2u>(vec2i(c));
  var x = k.x * 1664525u + k.y * 1013904223u;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return vec3f(f32(x & 1023u), f32((x >> 10u) & 1023u), f32((x >> 20u) & 1023u)) / 1023.;
}
fn looseSlope(at: vec2f, span: f32) -> vec2f {
  return vec2f(${read("at + vec2f(0.004, 0.)", "span")}.r - ${read("at - vec2f(0.004, 0.)", "span")}.r,
    ${read("at + vec2f(0., 0.004)", "span")}.r - ${read("at - vec2f(0., 0.004)", "span")}.r);
}`);
}

/** How far in from its edge a patch of ground frays, and how far further
 *  its edge wanders, over bends this big. */
const [FRAY, WANDER, BENDS] = [0.04, 0.05, 6];
const frayed = `input.uv.x < ${f(FRAY)} * looseLump * looseLump * 2. + ${f(WANDER)} * textureSample(looseGrain, looseGrainSampler, looseAt / ${f(BENDS)}).r`;
/** Earth, or dust: even, its grain in the light. */
const EARTH = loose("ModelEarth", frayed, `
N = normalize(N - vec3f((looseSlope(looseAt, ${f(FLECKS)}) + 0.6 * looseSlope(looseAt, ${f(LUMPS)})) * 1.1, 0.));
baseColor = baseColor * (0.95 + 0.1 * looseLump);
roughness = 1.;`);

/** Leaves: lumps the size of a hand of leaves, each turning the light,
 *  dark down between them. */
const LEAVES = loose("ModelLeaves", "false", `
let leafAt = looseAt + vec2f(input.worldPos.z * 2.3, input.worldPos.z * 1.3);
let leafLump = textureSample(looseGrain, looseGrainSampler, leafAt / 0.7).r;
N = normalize(N + vec3f(looseSlope(leafAt, 0.7) * 2.2, 0.));
baseColor = baseColor * (0.72 + 0.5 * leafLump);
roughness = 0.9;`);

/** A stone of the gravel, how big; how far each is rounded and how far
 *  their shades differ. */
const STONE = 0.018;
const [STONE_ROUND, STONE_SHADES] = [0.8, 0.35];
/** Gravel: stones each round the nearest of a scatter of points, rounded
 *  in the light and each its own shade, the cracks between them dark;
 *  let go where finer than the pixels. Heaped, its foot frayed. */
const GRAVEL = loose("ModelGravel", `input.uv.x > 0.94 + ${f(SPILL - 0.94)} * looseLump * looseLump`, `
let stoneQ = looseAt / ${f(STONE)};
var stoneNear = vec2f(9.);
var stoneSecond = 9.;
var stoneH = vec3f(0.);
for (var j = -1; j <= 1; j++) {
  for (var i = -1; i <= 1; i++) {
    let c = floor(stoneQ) + vec2f(f32(i), f32(j));
    let h = looseCell(c);
    let d = c + 0.15 + 0.7 * h.xy - stoneQ;
    if (dot(d, d) < dot(stoneNear, stoneNear)) { stoneSecond = length(stoneNear); stoneNear = d; stoneH = h; }
    else { stoneSecond = min(stoneSecond, length(d)); }
  }
}
let stoneEdge = stoneSecond - length(stoneNear);
let stoneFine = 1. - smoothstep(0.35, 0.9, max(fwidth(stoneQ.x), fwidth(stoneQ.y)));
N = normalize(N + vec3f(-stoneNear * ${f(2 * STONE_ROUND)} * stoneFine, 0.));
baseColor = baseColor * mix(0.95 + 0.1 * looseLump, (${f(1 - STONE_SHADES / 2)} + ${f(STONE_SHADES)} * stoneH.z) * (0.75 + 0.25 * smoothstep(0., 0.25, stoneEdge)), stoneFine);
roughness = 1.;`);

/** A chip, long and wide; how far each is tipped, and how far their
 *  shades differ. */
const CHIP = [0.02, 0.009];
const [CHIP_TIP, CHIP_SHADES] = [1.4, 0.55];
/** Chips heaped, each its own: cells in rows across a turn, every other
 *  row staggered, each tipped its own way and its own shade. */
const CHIPS = loose("ModelChips", `input.uv.x > 0.94 + ${f(SPILL - 0.94)} * looseLump * looseLump`, `
let chipQ = mat2x2f(0.8, 0.6, -0.6, 0.8) * looseAt / vec2f(${f(CHIP[0])}, ${f(CHIP[1])});
let chipH = looseCell(floor(vec2f(chipQ.x + 0.5 * floor(chipQ.y), chipQ.y)));
let chipFine = 1. - smoothstep(0.35, 0.9, max(fwidth(chipQ.x), fwidth(chipQ.y)));
N = normalize(N + vec3f((chipH.xy - 0.5) * ${f(CHIP_TIP)} * chipFine, 0.));
baseColor = baseColor * mix(0.95 + 0.1 * looseLump, ${f(1 - CHIP_SHADES / 2)} + ${f(CHIP_SHADES)} * chipH.z, chipFine);
roughness = 1.;`);

/** The town's grass on a model's ground: the same lawn, read where it
 *  lies on the map, so it runs on into the land's; frayed blade by blade
 *  at its edge, the gaps going first. */
const LAWN = coat("ModelLawn", `let lawnMap = textureSample(modelLawn, modelLawnSampler, input.worldPos.xy / ${f(LAWN_TILES)});
if (input.uv.x < ${f(FRAY * 1.5)} * (1. - lawnMap.b)) { discard; }
baseColor = baseColor * (1. - ${f(CREASE)} * (1. - lawnMap.b));
baseColor = mix(baseColor, vec3f(${CLOVER.map(f).join(", ")}), lawnMap.a);
N = normalize(N - vec3f((lawnMap.rg * 2. - 1.) * ${f(BUMP)}, 0.));
roughness = 1.;`, (engine) => ({ modelLawn: lawn(engine) }));

/** The town's paving, stopped clean at its edge. */
const PAVINGS = new WeakMap<EngineContext, MaterialPlugin>();
const PAVING: Coat = (engine) => {
  let plugin = PAVINGS.get(engine);
  if (plugin) return plugin;
  const town = pavingPlugin(engine, false);
  plugin = {
    ...town,
    name: "ModelPaving",
    getCustomCode: (stage) => {
      const code = town.getCustomCode!(stage);
      return code && { ...code, CUSTOM_FRAGMENT_MAIN_BEGIN: `if (input.uv.x < 0.) { discard; }\n${code.CUSTOM_FRAGMENT_MAIN_BEGIN}` };
    },
  };
  PAVINGS.set(engine, plugin);
  return plugin;
};

/** How far the slate tilts a rock's facing, and how much darker its
 *  hollows are than its plates. */
const [ROCK_TILT, ROCK_HOLLOW] = [0.9, 0.22];
/** Rock, the mountains' slate: read on the three planes it could lie in,
 *  each as much as the face lies in it, its plates tilting the light, its
 *  hollows dark. */
const ROCK = coat("ModelRock", `let rockW = pow(abs(N), vec3f(4.));
let rockWs = rockW / (rockW.x + rockW.y + rockW.z);
let rockP = input.worldPos / ${f(SLATE_SPAN * 0.4)};
let rockXY = textureSample(modelSlate, modelSlateSampler, rockP.xy);
let rockXZ = textureSample(modelSlate, modelSlateSampler, rockP.xz + vec2f(0.31, 0.17));
let rockYZ = textureSample(modelSlate, modelSlateSampler, rockP.yz + vec2f(0.61, 0.43));
let rockT = (vec3f((rockXY.rg * 2. - 1.), 0.) * rockWs.z + vec3f(rockXZ.r * 2. - 1., 0., rockXZ.g * 2. - 1.) * rockWs.y + vec3f(0., rockYZ.r * 2. - 1., rockYZ.g * 2. - 1.) * rockWs.x);
N = normalize(N + rockT * ${f(ROCK_TILT)});
let rockH = rockXY.b * rockWs.z + rockXZ.b * rockWs.y + rockYZ.b * rockWs.x;
baseColor = baseColor * (1. - ${f(ROCK_HOLLOW)} * (1. - rockH));
roughness = 0.9;`, (engine) => ({ modelSlate: slate(engine) }));

/** Bark (`bark.ts`), an engine's: smooth until the worker has baked it. */
const bark = (engine: EngineContext) =>
  bakedTexture(engine, "bark", barkRecipe, [BARK_ROUND, BARK_LONG, () => new Uint8Array(BARK_ROUND * BARK_LONG * 4).map((_, k) => (k % 4 === 2 ? 220 : k % 4 === 3 ? 255 : 128))], {
    format: "rgba8unorm",
    mipmaps: true,
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

/** Each finish's coat. */
export const COATS: Record<Finish, Coat> = { matte: MATTE, zinc: ZINC, tiles: TILES, glass: GLASS, bark: BARK, leaves: LEAVES, rock: ROCK, gravel: GRAVEL, chips: CHIPS, lawn: LAWN, paving: PAVING, earth: EARTH, dust: EARTH };

/** A shape seen in a mirror across x = 0, wound round again. */
export function mirror(s: Shape): Shape {
  const flip = (a: number[]) => a.map((v, i) => (i % 3 === 0 ? -v : v));
  return { ...s, positions: flip(s.positions), normals: flip(s.normals), indices: s.indices.map((_, i) => s.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
}

/** A model and its mirror across x = 0, finish by finish as an engine
 *  draws them, a bucket each under `key`; a flat finish casts no shadow. */
export function placing(key: string, built: Built) {
  const finishes = Object.entries(built.finishes) as [Finish, Shape][];
  const left = finishes.map(([k, s]): [Finish, Shape] => [k, mirror(s)]);
  return (engine: EngineContext, side: 1 | -1) =>
    (side > 0 ? finishes : left).map(([k, shape]) => ({ key: `${key}_${k}${side > 0 ? "" : "_left"}`, geo: shape, coat: COATS[k](engine), cast: !FLAT.has(k), glass: k === "glass" }));
}
