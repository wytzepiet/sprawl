import { createTexture2DFromPixels, markMaterialUboDirty, type EngineContext, type MaterialPlugin, type Texture2D } from "@babylonjs/lite";
import { retire } from "./geometry";
import { townMaterial } from "./material";
import { rgb as colour, type Rgb } from "./rgb";
import { lacquer } from "./bevel";
import { CHUNK_SIZE, CLIFF_REACH, CLIFF_RUN, EDGE, FOOT_Z, JAG_FOOT, LAYER, LEAN, STEEPEST, WANDER, WANDERS, PEAK_APRON, PEAK_SAMPLES, PEAK_SIDE, SHORE_DENSITY, SHORE_REACH, WATER_Z, CLIFF_Z, LEDGE, LEDGE_Z } from "./objects/terrainGeometry";
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
 * slope, turned by the slate, so a notch's sides face across it; past its
 * edge, as far as the wall leans out, the cliff, steeper: the old painted
 * cliffs, laid over the walls from above, so top and wall read as one
 * stone.
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
/** On the flats and the walls the slate's hollows, between its plates, are
 *  darker than its highest plates by this much, and shine this much less;
 *  never on a lip, which keeps the stone's own colour and shine. */
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
/** Below a layer's edge, out as far as its wall leans, the rock is lit as
 *  a cliff facing down the slope this steeply, turned by the slate as a
 *  lip is: the old painted cliff, laid over the wall from above. */
const CLIFF_TILT = 1.8;
/** Steepening from the lip's roll at the edge to that over this far out,
 *  in tiles, so lip and cliff meet facing the same way. */
const STEEPEN = 0.1;
/** Its plates are read from above, stretched down a wall as the old
 *  painted cliffs were; its grain over them is read as if the wall were
 *  laid back on the ground in front of it, so it is as fine up the wall
 *  as across: a tile down the wall this much further out than it leans. */
const UNROLL = Math.hypot(1, LEAN) - LEAN;

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

/** A pixel of the rock lit by where it is on the map, seen from above,
 *  whether the mesh there is a top or a wall: the rock's height there with
 *  the slate's added, scaled by how steep the rock is (as `layPeaks` adds
 *  it, but at every pixel, not every eighth of a tile), says which layer
 *  it is in and how near that layer's edge, and how near the edge of the
 *  layer above, whose wall leans out over it. So the edge breaks along
 *  the slate's plates finer than the mesh does, a plate standing proud
 *  lit as top over the wall and a missing one as wall over the top. */
const PEAK_LOOK = (() => {
  const at = "input.vPeakAt";
  return `let peakCorner = material.peakCorner.xy - ${f(PEAK_APRON)};
let peakRock = peakHeightAt(${at}.xy, peakCorner);
let peakOwn = peakRock.x;
let peakFall = -peakRock.zw;
let peakSteep = max(length(peakFall), 0.05);
let peakSlate = slateRead(${at}.xy);
let peakS = peakOwn + clamp(${f(WANDER)} * min(peakSteep, ${f(STEEPEST)}) * peakSlate.z * 0.5 * min(1., peakOwn / ${f(JAG_FOOT)}), ${f(-WANDERS)}, ${f(WANDERS)});
let peakLayer = max(floor((peakS - ${f(EDGE)}) / ${f(LAYER)}) + 1., 0.);
let peakIn = (peakS - (${f(EDGE)} + (peakLayer - 1.) * ${f(LAYER)})) / peakSteep;
let peakBelow = (${f(EDGE)} + peakLayer * ${f(LAYER)} - peakS) / peakSteep;
let peakRun = min(${f(LEAN * LAYER)}, ${f(0.5 * LAYER)} / peakSteep);
let peakDown = normalize(peakFall / peakSteep + peakSlate.xy * ${f(TURN)});
let peakLip = select(0., 1. - smoothstep(0., ${f(LIP)}, peakIn), peakLayer > 0.5);
let peakCliff = 1. - smoothstep(peakRun * 0.8, peakRun, peakBelow);
let peakHollow = (0.5 - 0.5 * peakSlate.z) * (1. - max(peakLip, peakCliff));
let peakDepth = select(0., ceil((${at}.z - ${f(FOOT_Z)}) / ${f(LAYER)} - 0.001) * ${f(LAYER)} + ${f(FOOT_Z)} - ${at}.z, abs(input.worldNormal.z) < 0.5);
let peakGrain = slateRead(${at}.xy + peakFall / peakSteep * peakDepth * peakCliff * ${f(UNROLL)});
baseColor = vec3f(${rgb(STONE)}) * (1. - ${f(HOLLOW)} * peakHollow);
townShine = ${f(ROCK_SHINE)} * (1. - ${f(DULL)} * peakHollow);
N = normalize(vec3f(peakDown * max(peakLip * ${f(ROLL)}, peakCliff * mix(${f(ROLL)}, ${f(CLIFF_TILT)}, smoothstep(0., ${f(STEEPEN)}, peakBelow))) + peakGrain.xy * ${f(RELIEF)}, 1.));`;
})();

/** A wall is drawn into the sun's shadow map set back into the rock this
 *  far, in tiles, so it cannot shadow its own face where the sun skims
 *  along it, in dashes the map is too coarse to keep apart; its shadow on
 *  the land the less by as much. The shadow map is the one view drawn
 *  square on, its projection's w never the depth. */
const SET_BACK = 0.06;
const SET_BACK_WGSL = `if (abs(normal.z) < 0.5 && scene.viewProjection[2][3] == 0.) { finalWorld[3] = finalWorld[3] - vec4f((finalWorld * vec4f(normal, 0.)).xy * ${f(SET_BACK)}, 0., 0.); }`;

/** The rock's material, painted by `plugin`. */
function rock(plugin: MaterialPlugin) {
  const material = lacquer(townMaterial([plugin]), "rock");
  material.doubleSided = true;
  return material;
}

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
export function peakMaterial(engine: EngineContext, heights: Uint16Array, corner: [number, number]) {
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
    // The chunk's corner, not found from where a pixel is: a wall leans out
    // over the next chunk's ground.
    getUniforms: () => ({ ubo: [{ name: "peakCorner", type: "vec4<f32>" }] }),
    writeUbo: (data, offsets) => data.set([corner[0], corner[1], 0, 0], offsets.get("peakCorner")! / 4),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_UPDATE_WORLDPOS: SET_BACK_WGSL, CUSTOM_VERTEX_MAIN_END: "out.vPeakAt = position;" }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `${SLATE_READ}
${HEIGHT_AT}`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: PEAK_LOOK,
          },
  };
  const material = rock(plugin);
  return { material, dispose: () => retire(texture) };
}

/** How far in from the land's lip its plane is drawn, in tiles: under
 *  where the grass stops (`ground.ts`). */
const CLIFF_INNER = 0.9;

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
 *  from the lip down into the water, lit by where it is on the map, as a
 *  mountain's wall is, out to where its foot leans. How far out a pixel lies from the lip, `cliffFar`, cuts the
 *  plane, in the shadow map too. Only the facing: the colour is the
 *  stone's own. */
const FIELD = (uv: string) => `((textureSampleLevel(cliffField, cliffFieldSampler, ${uv}, 0.).r - 0.5) * ${f(2 * CLIFF_REACH)})`;
const CLIFF_CUT = `let cliffUv = input.vCliffAt.xy / ${f(CHUNK_SIZE)};
let cliffFar = ${FIELD("cliffUv")};
let cliffLedge = input.worldPos.z < ${f(LEDGE_Z / 2)} && abs(input.worldNormal.z) > 0.5;
let cliffWall = input.worldPos.z < ${f(CLIFF_Z / 2)} && !cliffLedge;
let cliffBreak = ${f(CLIFF_RUN)} + ${f(LEDGE)} * saturate(0.5 + 0.5 * slateRead(input.worldPos.xy).z + 0.4 * slateRead(input.worldPos.xy * 3.1).z);
if ((!cliffWall && !cliffLedge && (cliffFar > 0. || cliffFar < ${f(-CLIFF_INNER)})) || (cliffLedge && cliffFar > cliffBreak)) { discard; }`;
const LAND_CLIFF = (() => {
  const e = f(1 / (CHUNK_SIZE * SHORE_DENSITY));
  return `let cliffGrad = vec2f(${FIELD(`cliffUv + vec2f(${e}, 0.)`)} - ${FIELD(`cliffUv - vec2f(${e}, 0.)`)}, ${FIELD(`cliffUv + vec2f(0., ${e})`)} - ${FIELD(`cliffUv - vec2f(0., ${e})`)});
let cliffFace = normalize(cliffGrad.x * input.vCliffX + cliffGrad.y * input.vCliffY + 1e-6);
let cliffSlate = slateRead(input.worldPos.xy);
let cliffGrain = slateRead(input.worldPos.xy + cliffFace * select(0., ${f(CLIFF_Z)} - input.worldPos.z, cliffWall) * ${f(UNROLL)});
let cliffOut = normalize(cliffFace + cliffSlate.xy * ${f(TURN)});
let cliffTilt = select((1. - smoothstep(0., ${f(LIP)}, -cliffFar)) * ${f(ROLL)}, mix(${f(ROLL)}, ${f(CLIFF_TILT)}, smoothstep(0., ${f(STEEPEN)}, cliffFar)), cliffFar > 0.);
baseColor = vec3f(${rgb(STONE)});
N = normalize(vec3f(cliffOut * cliffTilt + cliffGrain.xy * ${f(RELIEF)}, 1.));`;
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
        ? { CUSTOM_VERTEX_UPDATE_WORLDPOS: SET_BACK_WGSL, CUSTOM_VERTEX_MAIN_END: `out.vCliffAt = position.xy; out.vCliffX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; out.vCliffY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;` }
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
  const material = rock(plugin);
  return { material, tick: () => markMaterialUboDirty(material), dispose: () => (retire(texture), retire(shores)) };
}
