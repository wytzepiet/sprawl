import { createTexture2DFromPixels, markMaterialUboDirty, type EngineContext, type MaterialPlugin, type Texture2D } from "@babylonjs/lite";
import { retire } from "./geometry";
import { townMaterial } from "./material";
import { rgb as colour, type Rgb } from "./rgb";
import { lacquer } from "./bevel";
import { CHUNK_SIZE, CLIFF_REACH, CLIFF_RUN, EDGE, FOOT_Z, LAYER, PEAK_APRON, PEAK_SAMPLES, PEAK_SIDE, SHORE_DENSITY, SHORE_REACH, WATER_Z, CLIFF_Z } from "./objects/terrainGeometry";
import { SECOND, SIDE as SLATE_SIDE, SPAN } from "./slate";
import recipe from "./slate.ts?raw";
import { bakedTexture } from "./bakeCache";
import { ripples, swashFn } from "./water";

/**
 * The mountains as dark slate: terraces, each layer a flat top on a wall
 * (`layPeaks`), the look worked out at every pixel.
 *
 * The rock's height comes with its chunk, a texture (the heights the
 * server sends), and where its layers break, found by where the pixel is
 * on the map. Near its edge a layer's lip rolls over, facing down the
 * slope, turned by the slate, so a notch's sides face across it; and on
 * down its wall, lit as a steep slope of the same slate, as the old
 * painted cliffs were, so top and wall read as one stone.
 *
 * Over it all the slate's own grain, read twice, at two sizes and turned,
 * so its repeat does not show, tilting the light; and on the flats its
 * hollows a little darker than its plates and shining much less. A lip
 * or wall is the stone's own colour: its shape is only the facing's.
 */

/** The stone's colour; how far the slate tilts the facing; and how many mipmap levels coarser the slate is read,
 *  its plates kept and its grit gone, so the cliffs' shapes show. */
const STONE = colour(0.66, 0.61, 0.54);
const RELIEF = 0.5;
export const CALM = 2;
/** On the flats the slate's hollows, between its plates, are darker than
 *  its highest plates by this much, and shine this much less; never on a
 *  lip or wall, which keep the stone's own colour and shine. */
const HOLLOW = 0.12;
const DULL = 0.85;
/** How far the slate's faces are glossed from the rock's roughness, where
 *  the hollows leave them: worn smooth, as a crag catches the sun. */
const ROCK_SHINE = 0.4;
/** A lip rolls over this far in from its edge, in tiles, tilting this far
 *  at the edge. */
const LIP = 0.08;
const ROLL = 1.2;
/** A lip faces down the rock's smooth slope, turned by the slate's own
 *  facing this much, so a notch's sides face across it: read from the
 *  slate's smooth facing, not from how the broken edge changes from one
 *  pixel to the next, which is grainy. */
const TURN = 1.5;
/** A wall faces down its slope as steeply as this, from the lip's roll at
 *  its top to this far down it, in tiles; its slate read as if the wall
 *  were laid back on the ground in front of it, this many tiles out for a
 *  tile down, so its plates are as broad up it as they look across it. */
const WALL_TILT = 1.8;
const WALL_ROLL = 0.15;
const UNROLL = 0.45;

const f = (x: number) => x.toFixed(4);
const rgb = (c: Rgb) => `${f(c.r)}, ${f(c.g)}, ${f(c.b)}`;
const [c2, s2] = [Math.cos(SECOND[1]), Math.sin(SECOND[1])];

/** `slateRead(p)`: the slate at a point of the map, both sizes of it: its
 *  facing's x and y in `xy`, the turned one's turned back, and its height
 *  in `z`, -1 to 1. */
const SLATE_READ = (() => {
  const T = (uv: string) => `textureSampleBias(slate, slateSampler, ${uv}, ${f(CALM)})`;
  return `fn slateRead(p: vec2f) -> vec3f {
  let a = ${T(`p / ${f(SPAN)}`)};
  let b = ${T(`vec2f(p.x * ${f(c2)} - p.y * ${f(s2)}, p.x * ${f(s2)} + p.y * ${f(c2)}) / ${f(SPAN * SECOND[0])}`)};
  let bf = b.rg * 2. - 1.;
  return mix(a.rgb * 2. - 1., vec3f(bf.x * ${f(c2)} + bf.y * ${f(s2)}, bf.y * ${f(c2)} - bf.x * ${f(s2)}, b.b * 2. - 1.), ${f(SECOND[2])});
}`;
})();

/** `peakHeightAt(p, corner)`: the rock's height at a point of the map, and
 *  where its layers break, from the texture of the chunk whose heights
 *  start at `corner`, and the height's slope: the four texels round it
 *  blended here, not by the sampler, whose blend steps in 256ths of a
 *  texel and makes the slope shimmer from one pixel to the next. */
const HEIGHT_AT = (() => {
  const L = (c: string) => `textureLoad(peakHeights, ${c}, 0).rg`;
  return `fn peakHeightAt(p: vec2f, corner: vec2f) -> vec4f {
  let t = (p - corner) * ${f(PEAK_SAMPLES)};
  let i = clamp(floor(t), vec2f(0.), vec2f(${f(PEAK_SIDE - 2)}));
  let u = t - i;
  let a = ${L("vec2i(i)")};
  let b = ${L("vec2i(i) + vec2i(1, 0)")};
  let c = ${L("vec2i(i) + vec2i(0, 1)")};
  let d = ${L("vec2i(i) + vec2i(1, 1)")};
  return vec4f(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), vec2f(mix(b.x - a.x, d.x - c.x, u.y), mix(c.x - a.x, d.x - b.x, u.x)) * ${f(PEAK_SAMPLES)});
}`;
})();

/** A pixel of the rock lit, at its place on the map (the mesh is laid
 *  there): a top, its lip rolling over near its edge, or a wall. */
const PEAK_LOOK = (() => {
  const at = "input.vPeakAt";
  return `let peakCorner = floor(${at}.xy / ${f(CHUNK_SIZE)}) * ${f(CHUNK_SIZE)} - ${f(PEAK_APRON)};
let peakRock = peakHeightAt(${at}.xy, peakCorner);
let peakFall = -peakRock.zw;
let peakSteep = max(length(peakFall), 0.05);
let peakWall = abs(input.worldNormal.z) < 0.5;
let peakOut = peakFall / peakSteep;
let peakDepth = select(0., ceil((${at}.z - ${f(FOOT_Z)}) / ${f(LAYER)} - 0.001) * ${f(LAYER)} + ${f(FOOT_Z)} - ${at}.z, peakWall);
let peakSlate = slateRead(${at}.xy + peakOut * peakDepth * ${f(UNROLL)});
let peakLayer = floor(${at}.z / ${f(LAYER)} + 0.5);
let peakIn = (peakRock.y - (${f(EDGE)} + (peakLayer - 1.) * ${f(LAYER)})) / peakSteep;
let peakDown = normalize(peakOut + peakSlate.xy * ${f(TURN)});
let peakLip = select(0., 1. - smoothstep(0., ${f(LIP)}, peakIn), peakLayer > 0.5 && !peakWall);
let peakTilt = select(peakLip * ${f(ROLL)}, mix(${f(ROLL)}, ${f(WALL_TILT)}, smoothstep(0., ${f(WALL_ROLL)}, peakDepth)), peakWall);
let peakHollow = select((0.5 - 0.5 * peakSlate.z) * (1. - peakLip), 0., peakWall);
baseColor = vec3f(${rgb(STONE)}) * (1. - ${f(HOLLOW)} * peakHollow);
townShine = ${f(ROCK_SHINE)} * (1. - ${f(DULL)} * peakHollow);
N = normalize(vec3f(peakDown * peakTilt + peakSlate.xy * ${f(RELIEF)}, 1.));`;
})();

/** Each engine's slate: flat until the worker has baked it. The cliffs the
 *  land stands on break along it too (`ground.ts`). */
export const slate = (engine: EngineContext): Texture2D =>
  bakedTexture(engine, "slate", recipe, [SLATE_SIDE, SLATE_SIDE, () => new Uint8Array(SLATE_SIDE * SLATE_SIDE * 4).map((_, k) => (k % 4 < 2 ? 128 : 255))], {
    mipmaps: true,
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

/** A chunk's mountains' material, with the chunk's heights (half floats in
 *  pairs, `PEAK_SIDE` to a side): their surface is laid where it is on the
 *  map, so the slate and the heights are read by where a pixel is. Its
 *  texture is let go with `dispose`. */
export function peakMaterial(engine: EngineContext, heights: Uint16Array) {
  const texture = createTexture2DFromPixels(engine, heights, PEAK_SIDE, PEAK_SIDE, { format: "rg16float" });
  const plugin: MaterialPlugin = {
    name: "Basalt",
    priority: 200,
    getVaryings: () => [{ name: "vPeakAt", type: "vec3f" }],
    getSamplers: () => [
      { texture: "slate", sampler: "slateSampler" },
      { texture: "peakHeights", sampler: "peakHeightsSampler" },
    ],
    bindTextures: (out) => out.push({ texture: slate(engine) }, { texture }),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vPeakAt = position;" }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `${SLATE_READ}
${HEIGHT_AT}`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: PEAK_LOOK,
          },
  };
  const material = lacquer(townMaterial([plugin]), "rock");
  material.doubleSided = true;
  return { material, dispose: () => retire(texture) };
}

/** How far in from the land's lip its plane is drawn, in tiles: under
 *  where the grass stops (`ground.ts`); and how far past it, in tiles, so
 *  the lip overhangs its wall by a hair and nothing shows between. */
const CLIFF_INNER = 0.9;
const OVERHANG = 0.02;

/** How far up the cliff's face a wave washes, at most, in tiles of it,
 *  the rock showing wet behind, this much darker, this far again. */
const ROCK_SWASH = 0.07;
const ROCK_WET = 0.2;
const ROCK_WET_REACH = 0.6;
/** Only where the sea reaches it, the less the wider the beach between:
 *  as much of this far out to sea from its foot as is water, in tiles
 *  (`shore`, 0 on a beach). */
const ROCK_REACHED = 0.5;

/** The land's cliff (`cliffField`): its lip, painted on the plane under
 *  the land's edge, rolling over as a mountain layer's does; and its wall,
 *  from the lip down into the water, rolling on down it as a mountain
 *  layer's wall does. How far out a pixel lies from the lip, `cliffFar`, cuts the
 *  plane, in the shadow map too. Only the facing: the colour is the
 *  stone's own. */
const FIELD = (uv: string) => `((textureSampleLevel(cliffField, cliffFieldSampler, ${uv}, 0.).r - 0.5) * ${f(2 * CLIFF_REACH)})`;
const CLIFF_CUT = `let cliffUv = input.vCliffAt.xy / ${f(CHUNK_SIZE)};
let cliffFar = ${FIELD("cliffUv")};
let cliffWall = input.worldPos.z < ${f(CLIFF_Z / 2)};
if (!cliffWall && (cliffFar > ${f(OVERHANG)} || cliffFar < ${f(-CLIFF_INNER)})) { discard; }`;
const LAND_CLIFF = (() => {
  const e = f(1 / (CHUNK_SIZE * SHORE_DENSITY));
  return `let cliffGrad = vec2f(${FIELD(`cliffUv + vec2f(${e}, 0.)`)} - ${FIELD(`cliffUv - vec2f(${e}, 0.)`)}, ${FIELD(`cliffUv + vec2f(0., ${e})`)} - ${FIELD(`cliffUv - vec2f(0., ${e})`)});
let cliffFace = normalize(cliffGrad.x * input.vCliffX + cliffGrad.y * input.vCliffY + 1e-6);
let cliffDepth = select(0., ${f(CLIFF_Z)} - input.worldPos.z, cliffWall);
let cliffSlate = slateRead(input.worldPos.xy + cliffFace * cliffDepth * ${f(UNROLL)});
let cliffOut = normalize(cliffFace + cliffSlate.xy * ${f(TURN)});
let cliffTilt = select((1. - smoothstep(0., ${f(LIP)}, -cliffFar)) * ${f(ROLL)}, mix(${f(ROLL)}, ${f(WALL_TILT)}, smoothstep(0., ${f(WALL_ROLL)}, cliffDepth)), cliffWall);
baseColor = vec3f(${rgb(STONE)});
N = normalize(vec3f(cliffOut * cliffTilt + cliffSlate.xy * ${f(RELIEF)}, 1.));`;
})();

/** A chunk's land's cliff's material, with its field (`cliffField`), the
 *  waves washing up its wall's foot where it stands in the sea, not on a
 *  beach (the water's `shore`, if the chunk has water); its clock ticks
 *  before each frame (`tick`); its textures let go with `dispose`. */
export function cliffMaterial(engine: EngineContext, field: Uint8Array, shore: Uint8Array | null) {
  const side = CHUNK_SIZE * SHORE_DENSITY;
  const texture = createTexture2DFromPixels(engine, field, side, side, { format: "r8unorm", minFilter: "linear", magFilter: "linear" });
  const shores = createTexture2DFromPixels(engine, shore ?? new Uint8Array([0]), shore ? side : 1, shore ? side : 1, { format: "r8unorm", minFilter: "linear", magFilter: "linear" });
  const plugin: MaterialPlugin = {
    name: "LandCliff",
    priority: 200,
    getVaryings: () => [
      { name: "vCliffAt", type: "vec2f" },
      { name: "vCliffX", type: "vec2f" },
      { name: "vCliffY", type: "vec2f" },
    ],
    getSamplers: () => ["slate", "cliffField", "cliffRipple", "cliffShore"].map((name) => ({ texture: name, sampler: `${name}Sampler` })),
    bindTextures: (out) => out.push({ texture: slate(engine) }, { texture }, { texture: ripples(engine) }, { texture: shores }),
    getUniforms: () => ({ ubo: [{ name: "cliffTime", type: "f32" }] }),
    // The water's clock (`water.ts`), so the waves at the foot keep time.
    writeUbo: (data, offsets) => void (data[offsets.get("cliffTime")! / 4] = (performance.now() / 1000) % 3600),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: `out.vCliffAt = position.xy; out.vCliffX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; out.vCliffY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;` }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `${SLATE_READ}
${swashFn((uv) => `textureSampleLevel(cliffRipple, cliffRippleSampler, ${uv}, 0.).b`, "cliffWash")}`,
            CUSTOM_FRAGMENT_UPDATE_ALPHA: CLIFF_CUT,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `${LAND_CLIFF}
// The sea washing up its wall's foot and back, the rock wet behind it.
let cliffSea = select(${f(CLIFF_RUN)}, (input.worldPos.z - ${f(WATER_Z)}) / ${f(-WATER_Z)} * ${f(CLIFF_RUN)}, cliffWall);
let cliffSeaward = cliffUv + normalize(cliffGrad + 1e-6) * (max(${f(CLIFF_RUN)} - cliffFar, 0.) + ${f(ROCK_REACHED)}) / ${f(CHUNK_SIZE)};
let cliffAfloat = min(textureSampleLevel(cliffShore, cliffShoreSampler, cliffSeaward, 0.).r * ${f(SHORE_REACH / ROCK_REACHED)}, 1.);
if (cliffSea < ${f(ROCK_SWASH)} * cliffWash(material.cliffTime, input.worldPos.xy) * cliffAfloat) { discard; }
baseColor = baseColor * (1. - ${f(ROCK_WET)} * cliffAfloat * (1. - smoothstep(${f(ROCK_SWASH)}, ${f(ROCK_SWASH + ROCK_WET_REACH * ROCK_SWASH)}, cliffSea)));`,
          },
  };
  const material = lacquer(townMaterial([plugin]), "rock");
  material.doubleSided = true;
  return { material, tick: () => markMaterialUboDirty(material), dispose: () => (retire(texture), retire(shores)) };
}
