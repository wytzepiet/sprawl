import { addToScene, changedWithin, createTexture2DFromPixels, markMaterialUboDirty, updateTexture2DFromPixels, type EngineContext, type MaterialPlugin, type Mesh, type SceneContext, type Texture2D } from "./gpu";
import { townMaterial, type TownMaterial } from "./material";
import { drop, meshOf, retire } from "./geometry";
import type { Culler } from "./cull";
import { CALM, slate } from "./peaks";
import { ripples, SWASH, swashFn } from "./water";
import { SPAN as SLATE_SPAN } from "./slate";
import { RIPPLE_TILES, sandRipples } from "./sand";
import { lawn, LAWN_TILES } from "./lawn";
import { LAYER_ORDER } from "./town/draw";
import { BEACH_Z, CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, LAND, TYPE_BY_BYTE, type Ground } from "./objects/terrainGeometry";
import { live } from "./still";
import { theme } from "./theme";
import type { Rgb } from "./rgb";

/**
 * The land, layer on layer: the beaches, the rock the land stands on, the
 * grass on it, clay through the turf, the wood floor. None of it is
 * shaped on the CPU: a chunk's ground is a sheet, and a small texture
 * saying what kind each of its tiles is. A pixel reads the nine tiles
 * round it and blends them, a layer at a time, into how far in the layer
 * it is (`field`): half at the layer's edge, which so runs straight along
 * the tiles' sides, rounds every corner and cuts a stair to a slant; and
 * from that, how far inside the edge it lies, by which the layer frays,
 * rounds over and is wet. Something built in a wood is one texel written.
 *
 * And the grass a lawn (`lawn.ts`), rather than one sheet of felt: one
 * tiling texture of short blades, read by where on the map a pixel lies,
 * its slope tilting the land's facing, each blade taking the light, its
 * creases a little darker, in their own shade; and the grass alone has
 * the clover flowers in it.
 */

/** The grain's side, in texels, and how many tiles it spans. */
const SIDE = 256;
const SPAN = 4;
/** How far the blades' slope tilts the land's facing, how much darker
 *  their deepest creases are, and the clover's colour. */
export const BUMP = 0.45;
export const CREASE = 0.3;
export const CLOVER = [1, 0.97, 0.86];
/** Grass is mottled, as a field is from the air: its colour lighter and a
 *  touch yellower in places, darker and a touch bluer in others, in broad
 *  patches this many tiles across and small ones this many, by up to this
 *  much. The rest of the land is its colour alone. */
const PATCHES = 3;
const SPECKS = 0.5;
const MOTTLE = 0.06;
/** Grass frays where it meets lower ground: within this far of its edge,
 *  in tiles, a pixel is dropped where the lawn's gaps and shorter blades
 *  beat how far in it is, so it thins to its edge instead of stopping
 *  clean; the wood floor the same way, further, and wandering. */
const FRAY = 0.3;
/** And near its edge the rock under it breaks through in patches, the
 *  slate's plates (`slate.ts`) standing out of it: within this far of the
 *  edge, in tiles, where a plate is higher than this at the edge, rising to
 *  past the highest at this far in, so the grass thins to the edge. */
const PATCHES_IN = 0.6;
const PATCHED = 0.35;
/** The slate read for them this many times smaller than it lies on the
 *  rock, sharp: patches the size of the photos' outcrops. */
const PATCH_SCALE = 0.4;
/** How far the swash reaches up a beach is ragged by the grain's specks,
 *  over this many tiles, and its tufts, this many times coarser; the
 *  tufts wander the wood floor's edge too. */
const FRAY_SPAN = 2;
const TUFT = 8;
/** Sand glints instead: of its grains, this share each tilted its own way
 *  as far as this, and polished (`townShine`), so as the sun moves one and
 *  then another catches it; and a tile's own shine counts this many times
 *  toward its polish. */
const GLINTS = 0.25;
const GLINT_TILT = 0.35;
const GLINT = 4;
/** And it lies in ripples, as the wind leaves them (`sand.ts`, baked),
 *  tilting the sand this much; flat where the waves wet it, which wash them
 *  out, back as the sand dries (its darkening's own band). */
const RIPPLE_TILT = 0.35;
/** And not everywhere alike: their strength comes and goes over this many
 *  tiles, smooth sand between. */
const RIPPLE_PATCH = 2.5;

/** How far in from its edge ground rounds over it, in tiles: 45 degrees at
 *  the edge itself, level by here. */
const BEVEL = 0.1;
/** The rock the land stands on takes the slate's grain, as the cliff's
 *  face does (`peaks.ts`), this much. */
const SLATE_GRAIN = 0.5;
/** The land's layers, bottom up, each the kinds of ground it lies on, and
 *  its colour. And each layer's shine, of the toy's lacquer: sand and rock keep a little,
 *  grass a little, its bumps catching it, and wood is matte. And how far it
 *  rounds over its edges: the wood floor lies on the grass, and only its
 *  edges onto lower ground round over, which the grass under it does. */
const LOOKS: { of: Ground[]; colour: Rgb; shine: number; bevel: number; bump: number; glint: number; fray: number; mottle: number; slate: number; matte: number }[] = [
  // Sand glints, where the rest is bumped; and goes flat into the water.
  // It runs on under the land beside it (`UNDER`), so it shows only where
  // the land stops short of the water: one shore, not a blob.
  { of: ["Beach"], colour: theme.beach, shine: 0.12, bevel: 0, bump: 0, glint: 1, fray: 0, mottle: 0, slate: 0, matte: 0 },
  // The rock the land stands on: its edge is the cliff's top, of slate,
  // rounding over a little further than the grass does.
  { of: LAND, colour: theme.rock, shine: 0.06, bevel: BEVEL * 1.5, bump: 0, glint: 0, fray: 0, mottle: 0, slate: SLATE_GRAIN, matte: 0 },
  // Grass rounds over onto the rock more tightly, half as far, and stops
  // short of the cliff, as the wood floor does.
  { of: ["Grass", "Forest", "Clay"], colour: theme.land, shine: 0, bevel: BEVEL / 2, bump: 1, glint: 0, fray: 1, mottle: 1, slate: 0, matte: 0 },
  // Clay through the turf: bare earth, frayed into the grass round it,
  // unmottled, which would warm it to brick.
  { of: ["Clay"], colour: theme.clay, shine: 0, bevel: BEVEL / 2, bump: 1, glint: 0, fray: 1, mottle: 0, slate: 0, matte: 0 },
  // The wood floor frays into the grass, thinning blade by blade, and
  // further in than the grass does: it lies under the trees, not past them.
  // Needle litter in shade: fully matte.
  { of: ["Forest"], colour: theme.forest, shine: 0, bevel: 0, bump: 1, glint: 0, fray: 1.6, mottle: 0, slate: 0, matte: 1 },
];

/** A random byte a texel, in red; and its slope across and up, from the
 *  texels either side, in green and blue (0.5 level, a byte's whole rise
 *  either way at 0 and 1): a bump read once, where four reads found it. */
function grainData(): Uint8Array {
  let seed = 11;
  const r = Uint8Array.from({ length: SIDE * SIDE }, () => (seed = (seed * 16807) % 2147483647) % 256);
  const at = (x: number, y: number) => r[((y + SIDE) % SIDE) * SIDE + ((x + SIDE) % SIDE)];
  const out = new Uint8Array(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) {
      const k = y * SIDE + x;
      out.set([r[k], Math.round((at(x + 1, y) - at(x - 1, y) + 255) / 2), Math.round((at(x, y + 1) - at(x, y - 1) + 255) / 2), 255], k * 4);
    }
  return out;
}
/** The grain's bump at a point: its slope across and up, as the texels
 *  either side of it differ, from green and blue. */
export const grainSlope = (texel: string) => `((${texel}).gb * 2. - 1.)`;

/** The land's grain, a texture an engine: random bytes, tiling. Roads read
 *  it too (`roads.ts`). */
const GRAINS = new WeakMap<EngineContext, Texture2D>();
export function grain(engine: EngineContext): Texture2D {
  let texture = GRAINS.get(engine);
  if (!texture) {
    texture = createTexture2DFromPixels(engine, grainData(), SIDE, SIDE, {
      format: "rgba8unorm",
      mipmaps: true,
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    GRAINS.set(engine, texture);
  }
  return texture;
}


const n = (x: number) => x.toFixed(4);
const v3 = (c: number[]) => `vec3f(${c.map(n).join(", ")})`;

/** A tile of land with a beach beside it, as the texture says it: its
 *  kind and this, the beach running on under it. */
const UNDER = 8;
/** The texture's bytes that are of these kinds, a bit each; and those
 *  the beach lies on or under. */
const bits = (of: Ground[]) => of.reduce((m, g) => m | (0x101 << TYPE_BY_BYTE.indexOf(g)), 0);
const SAND = (1 << TYPE_BY_BYTE.indexOf("Beach")) | (0xff << UNDER);
const DRY = bits(TYPE_BY_BYTE.filter((g) => g !== "Sea" && g !== "Water"));

/** How far in a layer a pixel is, from the nine tiles round it: each
 *  tile's weight a hump over three tiles (a quadratic B-spline), so a
 *  straight edge is at a half exactly on the tiles' sides; with it, its
 *  slope across and up. `terrainGeometry`'s `blend` is the same, for the
 *  shore and the cliff. */
const TAPS = [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => [i, j]));
const field = (name: string, mask: number) =>
  `let ${name} = ${TAPS.map(([i, j]) => `groundW${i}${j} * f32((groundB${i}${j} & ${mask}u) != 0u)`).join(" + ")};`;
/** The nine tiles round `at`, a point of a chunk in tiles from its low
 *  corner, read from its kinds `texture`: each one's weight and its kind's bit. */
const nine = (at: string, texture: string) => `let groundCell = floor(${at});
let groundU = ${at} - groundCell - 0.5;
let groundWx = array<vec2f, 3>(0.5 * (0.5 - groundU) * (0.5 - groundU), 0.75 - groundU * groundU, 0.5 * (0.5 + groundU) * (0.5 + groundU));
let groundGx = array<vec2f, 3>(groundU - 0.5, -2. * groundU, groundU + 0.5);
${TAPS.map(
  ([i, j]) => `let groundW${i}${j} = vec3f(groundWx[${i}].x * groundWx[${j}].y, groundGx[${i}].x * groundWx[${j}].y, groundWx[${i}].x * groundGx[${j}].y);
let groundB${i}${j} = 1u << u32(textureLoad(${texture}, clamp(vec2i(groundCell) + vec2i(${i + CHUNK_SKIRT - 1}, ${j + CHUNK_SKIRT - 1}), vec2i(0), vec2i(${CHUNK_STRIDE - 1})), 0).r * 255. + 0.5);`,
).join("\n")}`;
const NINE = nine("input.vGroundAt", "groundKinds");
/** Whether a point of a chunk is on dry ground, as the ground is drawn:
 *  `dry`, 1 or 0, for the shore to be measured from (`shore.ts`). */
export const dryAt = (at: string, texture: string) => `${nine(at, texture)}
${field("groundDry", DRY)}
let dry = step(0.5, groundDry.x);`;
/** How far inside a layer's edge, in tiles, a pixel that far in the layer
 *  is (`field`), as it is along a straight edge: out to a tile and a
 *  half either way, negative beyond the edge. */
const INSIDE = `fn groundIn(f: f32) -> f32 {
  let g = abs(f - 0.5);
  if (g > 1. / 3.) { return sign(f - 0.5) * (1.5 - pow(max(3. - 6. * g, 0.), 1. / 3.)); }
  return sign(f - 0.5) * 1.7320508 * cos(acos(-2.3094011 * g) / 3. - 2.0943951);
}`;

// A mottle's texel this many tiles across, either scale; lighter patches
// warmer: more red and green, less blue, darker ones the other way.
const [patches, specks, mottleWarm] = [n(PATCHES * SIDE), n(SPECKS * SIDE), [1.15, 1, 0.6].map((k) => n(k * MOTTLE * 2)).join(", ")];
const [fraySpan, tuftSpan] = [n(FRAY_SPAN), n(FRAY_SPAN * TUFT)];
const [slateSpan, patchesIn, patched, patchSpan] = [n(SLATE_SPAN), n(PATCHES_IN), n(PATCHED), n(SLATE_SPAN * PATCH_SCALE)];
// How far up a beach the water runs, at most (`swashFn`); and wet sand,
// this much darker.
const [swash, wet] = [n(SWASH), n(0.18)];
// Two more random bytes of the same texel, a whole number of texels on.
const [other1, other2] = [`${n(97 / SIDE)}, ${n(41 / SIDE)}`, `${n(23 / SIDE)}, ${n(151 / SIDE)}`];

/** The sheets a chunk's land is drawn as, top down: the wood floor, the
 *  clay and the grass as one, the topmost a pixel is on; the rock under
 *  them, the land's cliff painted between (`CLIFF_Z`); and the beach, down
 *  the cliff. The land stands still but for the beach's swash, so the
 *  beach is drawn twice (`still.ts`): all but the band the swash runs
 *  over, still; and the sand of that band alone, as the waves leave it,
 *  live (`wash`). */
const SHEETS = {
  turf: { layers: [4, 3, 2], z: 0.002, order: 0 },
  rock: { layers: [1], z: 0, order: 1 },
  beach: { layers: [0], z: BEACH_Z, order: 2 },
  wash: { layers: [0], z: BEACH_Z, order: 2 },
};
type Sheet = keyof typeof SHEETS;

/** A sheet's material, for a chunk's kinds. */
function groundPlugin(engine: EngineContext, kinds: Texture2D, sheet: Sheet): MaterialPlugin {
  const layers = SHEETS[sheet].layers.map((l) => ({ l, ...LOOKS[l] }));
  const sand = layers[0].glint > 0;
  const any = (k: "bump" | "fray" | "mottle" | "slate" | "bevel") => layers.some((look) => look[k] > 0);
  // A look of the layer a pixel is on: each layer's, by whether it is that one.
  const look = (k: "shine" | "bevel" | "bump" | "mottle" | "slate" | "matte") => `(${layers.map((y) => `groundIs${y.l} * ${n(y[k])}`).join(" + ")})`;
  const textures: [string, Texture2D][] = [["groundKinds", kinds]];
  if (sand || any("fray")) textures.push(["groundGrain", grain(engine)]);
  if (any("bump")) textures.push(["groundLawn", lawn(engine)]);
  if (any("slate") || any("fray")) textures.push(["groundSlate", slate(engine)]);
  if (sand) textures.push(["sandRipples", sandRipples(engine)]);
  if (sheet === "wash") textures.push(["groundRipple", ripples(engine)]);
  const grainAt = (uv: string) => `textureSample(groundGrain, groundGrainSampler, ${uv}).r`;
  const begin = sand
    ? `let groundGrainUv = input.worldPos.xy / ${n(SPAN)};
let groundGlint = vec3f(${grainAt("groundGrainUv")}, ${grainAt(`groundGrainUv + vec2f(${other1})`)}, ${grainAt(`groundGrainUv + vec2f(${other2})`)});
let groundGlinting = step(${n(1 - GLINTS)}, groundGlint.x);
// The sand's ripples (sand.ts), their slope read at the size they are drawn.
let groundRippled = (textureSample(sandRipples, sandRipplesSampler, input.worldPos.xy / ${n(RIPPLE_TILES)}).rg * 2. - 1.) * ${n(RIPPLE_TILT)}
  * smoothstep(0.15, 0.35, ${grainAt(`input.worldPos.xy / ${n(RIPPLE_PATCH * SIDE)} + vec2f(0.37, 0.71)`)});
// How far up the beach the water runs is ragged by the grain.
let groundBand = ${swash} * (0.6 + 0.8 * (0.5 * ${grainAt(`input.worldPos.xy / ${fraySpan}`)} + 0.5 * ${grainAt(`input.worldPos.xy / ${tuftSpan}`)}));
${NINE}
${field("groundOn", SAND)}
${field("groundF", DRY)}
if (groundOn.x < 0.5) { discard; }
let groundIs0 = 1.;
// How far from the water: a beach draws back from each wave as it breaks,
// and is wet where they reach.
let groundD = groundIn(groundF.x);
${sheet === "wash" ? `if (groundD >= groundBand) { discard; }
let groundSwash = groundBand * groundWash(material.groundTime, input.worldPos.xy);` : "let groundSwash = groundBand;"}
if (groundD < groundSwash) { discard; }`
    : `${any("bump") ? `let groundLawn = textureSample(groundLawn, groundLawnSampler, input.worldPos.xy / ${n(LAWN_TILES)});` : ""}
${any("mottle") ? `let groundMottle = 0.6 * ${grainAt(`input.worldPos.xy / ${patches}`)} + 0.4 * ${grainAt(`input.worldPos.xy / ${specks}`)} - 0.5;` : ""}
${any("slate") ? `let groundSlateTilt = textureSampleBias(groundSlate, groundSlateSampler, input.worldPos.xy / ${slateSpan}, ${n(CALM)}).rg * 2. - 1.;` : ""}
${
  any("fray")
    ? `let groundTufts = ${grainAt(`input.worldPos.xy / ${tuftSpan}`)};
// The rock breaking through near an edge, plate by plate, read at the size it is drawn.
let groundPatch = textureSample(groundSlate, groundSlateSampler, input.worldPos.xy / ${patchSpan}).b;`
    : ""
}
${NINE}
${layers
  .map(
    (y) => `${field(`groundF${y.l}`, bits(y.of))}
let groundD${y.l} = groundIn(groundF${y.l}.x);
${
  y.fray > 0
    ? // Grass frays blade by blade, the gaps going first, then the shorter
      // blades; the wood floor by them and by the grain's tufts, so its edge
      // wanders off its tiles' outline even where the blades are too fine to see.
      `let groundOn${y.l} = groundD${y.l} >= ${y.mottle ? "(1. - groundLawn.b)" : "(0.5 * (1. - groundLawn.b) + 0.5 * groundTufts)"} * ${n(y.fray * FRAY)}
  && !(groundD${y.l} < ${patchesIn} && groundPatch > mix(${patched}, 1.05, groundD${y.l} / ${patchesIn}));`
    : `let groundOn${y.l} = groundD${y.l} >= 0.;`
}
let groundIs${y.l} = f32(groundOn${y.l}${layers
      .slice(0, layers.indexOf(y))
      .map((over) => ` && !groundOn${over.l}`)
      .join("")});`,
  )
  .join("\n")}
let groundF = ${layers.map((y) => `groundIs${y.l} * groundF${y.l}`).join(" + ")};
let groundD = ${layers.map((y) => `groundIs${y.l} * groundD${y.l}`).join(" + ")};
if (${layers.map((y) => `groundIs${y.l}`).join(" + ")} < 0.5) { discard; }`;
  const tilt = [
    any("bump") ? `- vec3f((groundLawn.rg * 2. - 1.) * ${n(BUMP)} * ${look("bump")}, 0.)` : "",
    any("slate") ? `+ vec3f(groundSlateTilt * ${look("slate")}, 0.)` : "",
    sand ? `+ vec3f((groundGlint.yz - 0.5) * 2. * ${n(GLINT_TILT)} * groundGlinting, 0.) - vec3f(groundRippled * smoothstep(${swash}, ${swash} * 1.6, groundD), 0.)` : "",
  ].join(" ");
  return {
    name: `Ground ${sheet}`,
    priority: 210,
    getVaryings: () => [{ name: "vGroundAt", type: "vec2f" }],
    getSamplers: () => textures.map(([name]) => ({ texture: name, sampler: `${name}Sampler` })),
    bindTextures: (out) => out.push(...textures.map(([, texture]) => ({ texture }))),
    ...(sheet === "wash"
      ? {
          getUniforms: () => ({ ubo: [{ name: "groundTime", type: "f32" }] }),
          // The water's clock (`water.ts`), so the beach's swash keeps its waves.
          writeUbo: (data, offsets) => void (data[offsets.get("groundTime")! / 4] = (performance.now() / 1000) % 3600),
        }
      : {}),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vGroundAt = position.xy;" }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: INSIDE + (sheet === "wash" ? swashFn((uv) => `textureSampleLevel(groundRipple, groundRippleSampler, ${uv}, 0.).b`, "groundWash") : ""),
            CUSTOM_FRAGMENT_MAIN_BEGIN: begin,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `townShine = min(1., ${look("shine")} * ${n(GLINT)}${sand ? " + groundGlinting" : ""});
baseColor = baseColor * (${layers.map((y) => `groundIs${y.l} * ${v3([y.colour.r, y.colour.g, y.colour.b])}`).join(" + ")})${any("bump") ? ` * (1. - ${n(CREASE)} * ${look("bump")} * (1. - groundLawn.b))` : ""}${
              any("mottle") ? ` * (1. + ${look("mottle")} * groundMottle * vec3f(${mottleWarm}))` : ""
            }${sand ? ` * (1. - ${wet} * (1. - smoothstep(${swash}, ${swash} * 1.6, groundD)))` : ""};
${any("mottle") ? `baseColor = mix(baseColor, ${v3(CLOVER)}, groundLawn.a * ${look("mottle")});` : ""}
roughness = mix(roughness, 1., ${look("matte")});
N = normalize(N ${tilt});
${
  any("bevel")
    ? // It rounds over only near an edge, its facing turned out down the field's slope.
      `let groundBevel = ${look("bevel")};
if (groundD < groundBevel && dot(groundF.yz, groundF.yz) > 0.) {
  N = normalize(mix(N, normalize(N + normalize(vec3f(-groundF.yz, 0.))), 1. - groundD / groundBevel));
}`
    : ""
}`,
          },
  };
}

/** A chunk's ground: its kinds, and the sheets it has ground for. */
interface Chunk {
  kinds: Texture2D;
  sheets: Map<Sheet, { mesh: Mesh; material: TownMaterial }>;
}

/** The land, chunk by chunk: each a texture of its tiles' kinds, skirt
 *  and all, and a sheet for each of `SHEETS` it has ground for. */
export class GroundTiles {
  private chunks = new Map<string, Chunk>();
  private stopClock: () => void;

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    beforeRender: (fn: () => void) => () => void,
    private cull: Culler,
  ) {
    // The swash's clock, a frame at a time.
    this.stopClock = beforeRender(() => {
      for (const { sheets } of this.chunks.values()) if (sheets.has("wash")) markMaterialUboDirty(sheets.get("wash")!.material);
    });
  }

  /** A chunk's kinds, for what else reads them (`shore.ts`). */
  kinds(key: string): Texture2D | undefined {
    return this.chunks.get(key)?.kinds;
  }

  /** A chunk's tiles as they are now (`CHUNK_STRIDE` a side, its skirt
   *  round it), from its low corner; different from the last, if it had
   *  any, only `within` x0 y0 x1 y1 of the world. */
  set(key: string, [ox, oy]: [number, number], tiles: Uint8Array, within?: number[]) {
    const beach = TYPE_BY_BYTE.indexOf("Beach");
    const land = LAND.map((g) => TYPE_BY_BYTE.indexOf(g));
    const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < CHUNK_STRIDE && j < CHUNK_STRIDE ? tiles[j * CHUNK_STRIDE + i] : -1);
    const bytes = tiles.map((b, k) => {
      const [i, j] = [k % CHUNK_STRIDE, Math.floor(k / CHUNK_STRIDE)];
      return land.includes(b) && [-1, 0, 1].some((dj) => [-1, 0, 1].some((di) => at(i + di, j + dj) === beach)) ? b | UNDER : b;
    });
    const has = (mask: number) => bytes.some((b) => mask & (1 << b));
    const wanted = (Object.keys(SHEETS) as Sheet[]).filter((s) => has(s === "beach" || s === "wash" ? SAND : SHEETS[s].layers.reduce((m, l) => m | bits(LOOKS[l].of), 0)));
    const chunk = this.chunks.get(key) ?? { kinds: createTexture2DFromPixels(this.engine, bytes, CHUNK_STRIDE, CHUNK_STRIDE, { format: "r8unorm" }), sheets: new Map() };
    if (this.chunks.has(key)) updateTexture2DFromPixels(this.engine, chunk.kinds, bytes);
    this.chunks.set(key, chunk);
    for (const [sheet, { mesh }] of chunk.sheets) {
      if (!wanted.includes(sheet)) this.cull.forget(mesh), drop(this.scene, mesh), chunk.sheets.delete(sheet);
      else if (within) changedWithin(mesh, within);
    }
    for (const sheet of wanted) {
      if (chunk.sheets.has(sheet)) continue;
      const { z, order } = SHEETS[sheet];
      const S = CHUNK_SIZE;
      const mesh = meshOf(this.engine, `ground_${key}_${sheet}`, { positions: [0, 0, 0, S, 0, 0, S, S, 0, 0, S, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
      const material = townMaterial([groundPlugin(this.engine, chunk.kinds, sheet)]);
      mesh.material = material;
      mesh.renderOrder = LAYER_ORDER.ground + order;
      mesh.receiveShadows = true;
      [mesh.position.x, mesh.position.y, mesh.position.z] = [ox, oy, z];
      this.cull.keep(mesh, [ox, oy, ox + S, oy + S]);
      if (sheet === "wash") live(mesh);
      addToScene(this.scene, mesh);
      chunk.sheets.set(sheet, { mesh, material });
    }
  }

  delete(key: string) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    for (const { mesh } of chunk.sheets.values()) this.cull.forget(mesh), drop(this.scene, mesh);
    retire(chunk.kinds);
    this.chunks.delete(key);
  }

  dispose() {
    for (const key of [...this.chunks.keys()]) this.delete(key);
    this.stopClock();
  }
}
