import { createTexture2DFromPixels, markMaterialUboDirty, markMeshRenderableDirty, setMeshAttribute, setThinInstances, type EngineContext, type MaterialPlugin, type Mesh, type SceneContext, type Texture2D } from "@babylonjs/lite";
import { townMaterial, type TownMaterial } from "./material";
import { drop, meshOf, show } from "./geometry";
import { WHITE, type Rgb } from "./rgb";
import { Atlas } from "./atlas";
import { FAR, kerbDistances } from "./kerbLines";
import { CALM, slate } from "./peaks";
import { ripples, SWASH, WAVE_LEAD, wavePhase, wavePiece } from "./water";
import { SPAN as SLATE_SPAN } from "./slate";
import { CHUNK_SIZE, LAYERS, nearLines, outlineOf, parseShape, shapeGeometry, type LayerTiles } from "./objects/terrainGeometry";
import { fillTriangles } from "./raster";

/**
 * The land, layer on layer (`LAYERS`): the beaches, the rock the land
 * stands on, the grass on it, the wood floor. Every tile of a layer is the same square, its share of
 * the layer drawn on it, as road tiles are (`roads.ts`): each shape a
 * tile's share can take is baked once into a slot of one shared texture,
 * in its first channel how far each point lies inside the share's
 * outline, negative beyond it, so a pixel off it is dropped; in its
 * second, how far inside the edges where the layer rounds over onto ground
 * lying lower, so it turns its facing out as it nears them. Each chunk's
 * land is one draw.
 *
 * And a fine grain, so the land reads as a surface rather than one sheet
 * of plastic: one tiling texture of noise, read by where on the map a pixel
 * lies, its slope tilting the land's facing a little, as if it were bumps
 * that take the light.
 */

/** The grain's side, in texels, how many tiles it spans, and how far its
 *  slope tilts the land's facing. A texel is about a pixel at the usual
 *  zoom; further out the mipmaps smooth it away. */
const SIDE = 256;
const SPAN = 4;
const BUMP = 0.25;
/** The bumps are finer than the glints: the grain over this many tiles. */
const BUMP_SPAN = 6;
/** Grass is mottled, as a field is from the air: its colour lighter and a
 *  touch yellower in places, darker and a touch bluer in others, in broad
 *  patches this many tiles across and small ones this many, by up to this
 *  much. The rest of the land is its colour alone. */
const PATCHES = 3;
const SPECKS = 0.5;
const MOTTLE = 0.12;
/** Grass frays where it meets lower ground: within this far of its edge,
 *  in tiles, a pixel is dropped where the grain, specks and tufts, beats
 *  how far in it is, so it thins to its edge instead of stopping clean. */
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
/** The fray's specks, the grain over this many tiles, and how many times
 *  coarser its tufts are. */
const FRAY_SPAN = 2;
const TUFT = 8;
/** Sand glints instead: of its grains, this share each tilted its own way
 *  as far as this, and polished (`townShine`), so as the sun moves one and
 *  then another catches it; and a tile's own shine counts this many times
 *  toward its polish. */
const GLINTS = 0.25;
const GLINT_TILT = 0.35;
const GLINT = 4;

/** How far in from its edge ground rounds over it, in tiles: 45 degrees at
 *  the edge itself, level by here. */
const BEVEL = 0.1;
/** The rock the land stands on takes the slate's grain, as the cliff's
 *  face does (`peaks.ts`), this much. */
const SLATE_GRAIN = 0.5;
/** Each layer's shine, of the toy's lacquer: sand and rock keep a little,
 *  grass a little, its bumps catching it, and wood is matte. And how far it
 *  rounds over its edges: the wood floor lies on the grass, and only its
 *  edges onto lower ground round over, which the grass under it does. */
const LOOKS = [
  // Sand glints, where the rest is bumped; and goes flat into the water.
  { shine: 0.12, bevel: 0, bump: 0, glint: 1, fray: 0, mottle: 0, slate: 0 },
  // The rock the land stands on: its edge is the cliff's top, of slate,
  // rounding over a little further than the grass does.
  { shine: 0.06, bevel: BEVEL * 1.5, bump: 0, glint: 0, fray: 0, mottle: 0, slate: SLATE_GRAIN },
  // Grass rounds over onto the rock more tightly, half as far, and stops
  // short of the cliff, as the wood floor does.
  { shine: 0, bevel: BEVEL / 2, bump: 1, glint: 0, fray: 1, mottle: 1, slate: 0 },
  // The wood floor frays into the grass, thinning plate by plate.
  { shine: 0, bevel: 0, bump: 1, glint: 0, fray: 1, mottle: 0, slate: 0 },
];

/** A slot's side in texels, the texels to a tile, and its low corner in
 *  the tile's square: the tile and a margin round it, for reading the
 *  slot across the tile's edge. */
const SLOT = 32;
const DENSITY = 28;
const ORIGIN = -2 / DENSITY;
/** How far an edge running on into the next tile is carried past it, so
 *  it rounds over straight across the seam, as the next tile's does. */
const RUN_ON = 0.25;

/** A random byte a texel. */
function grainData(): Uint8Array {
  let seed = 11;
  return Uint8Array.from({ length: SIDE * SIDE }, () => (seed = (seed * 16807) % 2147483647) % 256);
}

/** The land's grain, a texture an engine: random bytes, tiling. Roads read
 *  it too (`roads.ts`). */
const GRAINS = new WeakMap<EngineContext, Texture2D>();
export function grain(engine: EngineContext): Texture2D {
  let texture = GRAINS.get(engine);
  if (!texture) {
    texture = createTexture2DFromPixels(engine, grainData(), SIDE, SIDE, {
      format: "r8unorm",
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

/** A tile's share of a layer (`TileShape`'s key), baked: how far inside
 *  its outline, and how far inside its edges onto lower ground. */
function bake(key: string): [Float32Array, Float32Array] {
  const shape = parseShape(key);
  const flat = shapeGeometry(shape);
  const outline = outlineOf(key);
  // An end of the outline on the tile's edge that no other line of it
  // meets is where it runs on into the next tile.
  const spot = (p: number[]) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const ends = new Map<string, number>();
  for (const { a, b } of outline) for (const p of [a, b]) ends.set(spot(p), (ends.get(spot(p)) ?? 0) + 1);
  const runsOn = (p: number[]) => (p[0] < 1e-4 || p[0] > 1 - 1e-4 || p[1] < 1e-4 || p[1] > 1 - 1e-4) && ends.get(spot(p)) === 1;
  const edges = outline.map(({ a, b, inward, lies }) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const on = (p: number[], sign: number) => (runsOn(p) ? [p[0] + sign * ux * RUN_ON, p[1] + sign * uy * RUN_ON] : p);
    return { a: on(a, -1), b: on(b, 1), inward, lies };
  });
  // The curves across the edges that come near.
  edges.push(...nearLines(shape));
  // As far in as a layer rounds over, frays or stops short of a cliff.
  const reach = Math.max(BEVEL * 1.5, FRAY, PATCHES_IN) + 2 / DENSITY;
  const inside = kerbDistances(edges, ORIGIN, ORIGIN, DENSITY, SLOT, SLOT, reach);
  const rounded = kerbDistances(
    edges.filter((e) => e.lies === "-"),
    ORIGIN,
    ORIGIN,
    DENSITY,
    SLOT,
    SLOT,
    reach,
  );
  // Which side of the outline a texel is on, read off the share itself;
  // the margin's are never read for it, only for the round's slope.
  const covered = fillTriangles(flat.positions, flat.indices, ORIGIN, ORIGIN, DENSITY, SLOT, SLOT, new Uint8Array(SLOT * SLOT));
  for (let j = 0; j < SLOT; j++) {
    for (let i = 0; i < SLOT; i++) {
      const k = j * SLOT + i;
      const [x, y] = [ORIGIN + (i + 0.5) / DENSITY, ORIGIN + (j + 0.5) / DENSITY];
      if (x < 0 || y < 0 || x > 1 || y > 1) continue;
      inside[k] = covered[k] ? Math.abs(inside[k]) : -Math.abs(inside[k]);
    }
  }
  return [inside, rounded.map((d) => Math.min(d, FAR))];
}

const n = (x: number) => x.toFixed(4);
// A mottle's texel this many tiles across, either scale; lighter patches
// warmer: more red and green, less blue, darker ones the other way.
const [patches, specks, mottleWarm] = [n(PATCHES * SIDE), n(SPECKS * SIDE), [1.15, 1, 0.6].map((k) => n(k * MOTTLE * 2)).join(", ")];
const [fray, fraySpan, tuftSpan] = [n(FRAY), n(FRAY_SPAN), n(FRAY_SPAN * TUFT)];
const [slateSpan, calm, patchesIn, patched, patchSpan] = [n(SLATE_SPAN), n(CALM), n(PATCHES_IN), n(PATCHED), n(SLATE_SPAN * PATCH_SCALE)];
// How far up a beach the water is, of `SWASH`, this far through a wave,
// from when its crest reaches the foam: running up for this share of it,
// back down for the rest; and wet sand, this much darker.
const [swash, wet, rise] = [n(SWASH), n(0.18), n(0.3)];
const washFn = (R: (uv: string) => string, v2: string, head: string) =>
  `${head} { let_ w = ${wavePhase(R, "p", "t", n(WAVE_LEAD))}; let_ s = fract(w); return min(smoothstep(0., ${rise}, s), 1. - smoothstep(${rise}, 1., s)) * mix(0.25, 1., ${wavePiece(R, "p", "w", v2)}); }`;
const [span, origin, slotSpan, bump, bumpSpan, step] = [n(SPAN), n(ORIGIN), n(SLOT / DENSITY), n(BUMP), n(BUMP_SPAN), n(BUMP_SPAN / SIDE)];
// Two more random bytes of the same texel, a whole number of texels on.
const [glints, glintTilt, glint, other1, other2] = [n(1 - GLINTS), n(GLINT_TILT), n(GLINT), `${n(97 / SIDE)}, ${n(41 / SIDE)}`, `${n(23 / SIDE)}, ${n(151 / SIDE)}`];
// Half a texel in from the tile's edge: whether a pixel is on the share is
// read off the tile's own texels alone, never blended with the margin's.
const [inner0, inner1] = [n(0.5 / DENSITY), n(1 - 0.5 / DENSITY)];

// Where on its square a pixel is, its square's slot, and which ways the
// square's own x and y run in the world, however the sheet is placed.
// Then the grain, before anything is dropped (its mipmaps need every
// pixel); whether the pixel is on the share; and how near its edges.
/** The land's tiles: each told its slot, round, bump and glint, its colour
 *  and shine, its fray, mottle and slate (`GroundTiles`), one buffer a
 *  chunk; the grain, the atlas, the slate and the ripples, read. */
function groundPlugin(engine: EngineContext, atlas: Atlas): MaterialPlugin {
  return {
    name: "Ground",
    priority: 210,
    getAttributes: () => [
      { name: "groundSlot", type: "vec4<f32>", perInstance: true, buffer: "ground" },
      { name: "groundLook", type: "vec4<f32>", perInstance: true, buffer: "ground" },
      { name: "groundGrass", type: "vec3<f32>", perInstance: true, buffer: "ground" },
    ],
    getVaryings: () => [
      { name: "vGroundGrass", type: "vec3f" },
      { name: "vGroundAt", type: "vec2f" },
      { name: "vGroundSlot", type: "vec4f" },
      { name: "vGroundLook", type: "vec4f" },
      { name: "vGroundX", type: "vec2f" },
      { name: "vGroundY", type: "vec2f" },
    ],
    getSamplers: () => ["groundGrain", "groundAtlas", "groundSlate", "groundRipple"].map((name) => ({ texture: name, sampler: `${name}Sampler` })),
    bindTextures: (out) => out.push({ texture: grain(engine) }, { texture: atlas.upload() }, { texture: slate(engine) }, { texture: ripples(engine) }),
    getUniforms: () => ({
      ubo: [
        { name: "groundGrid", type: "vec2<f32>" },
        { name: "groundTime", type: "f32" },
      ],
    }),
    writeUbo: (data, offsets) => {
      data.set(atlas.grid, offsets.get("groundGrid")! / 4);
      // The water's clock (`water.ts`), so the beach's swash keeps its waves.
      data[offsets.get("groundTime")! / 4] = (performance.now() / 1000) % 3600;
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: `out.vGroundGrass = groundGrass; out.vGroundAt = position.xy; out.vGroundSlot = groundSlot; out.vGroundLook = groundLook; out.vGroundX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; out.vGroundY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;` }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `${washFn((uv) => `textureSampleLevel(groundRipple, groundRippleSampler, ${uv}, 0.).b`, "vec2f", "fn groundWash(t: f32, p: vec2f) -> f32").replaceAll("let_", "let")}`,
            CUSTOM_FRAGMENT_MAIN_BEGIN: `let groundBump = vec2f(textureSample(groundGrain, groundGrainSampler, (input.worldPos.xy + vec2f(${step}, 0.)) / ${bumpSpan}).r - textureSample(groundGrain, groundGrainSampler, (input.worldPos.xy - vec2f(${step}, 0.)) / ${bumpSpan}).r,
  textureSample(groundGrain, groundGrainSampler, (input.worldPos.xy + vec2f(0., ${step})) / ${bumpSpan}).r - textureSample(groundGrain, groundGrainSampler, (input.worldPos.xy - vec2f(0., ${step})) / ${bumpSpan}).r);
let groundGrainUv = input.worldPos.xy / ${span};
let groundGlint = vec3f(textureSample(groundGrain, groundGrainSampler, groundGrainUv).r, textureSample(groundGrain, groundGrainSampler, groundGrainUv + vec2f(${other1})).r, textureSample(groundGrain, groundGrainSampler, groundGrainUv + vec2f(${other2})).r);
let groundGlinting = input.vGroundSlot.w * step(${glints}, groundGlint.x);
let groundMottle = 0.6 * textureSample(groundGrain, groundGrainSampler, input.worldPos.xy / ${patches}).r + 0.4 * textureSample(groundGrain, groundGrainSampler, input.worldPos.xy / ${specks}).r - 0.5;
let groundFrayBy = 0.5 * textureSample(groundGrain, groundGrainSampler, input.worldPos.xy / ${fraySpan}).r + 0.5 * textureSample(groundGrain, groundGrainSampler, input.worldPos.xy / ${tuftSpan}).r;
let groundSlotN = floor(input.vGroundSlot.x + 0.5);
let groundBevel = input.vGroundSlot.y;
let groundCell = vec2f(groundSlotN - material.groundGrid.x * floor(groundSlotN / material.groundGrid.x), floor(groundSlotN / material.groundGrid.x));
let groundUv = (groundCell + (input.vGroundAt - ${origin}) / ${slotSpan}) / material.groundGrid;
let groundTexel = 1. / (material.groundGrid * ${n(SLOT)});
let groundD = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv, 0.).rg;
if (textureSampleLevel(groundAtlas, groundAtlasSampler, (groundCell + (clamp(input.vGroundAt, vec2f(${inner0}), vec2f(${inner1})) - ${origin}) / ${slotSpan}) / material.groundGrid, 0.).r < 0.) { discard; }
// The slate's tilt, and the beach's swash, read only where they show:
// the rock, and the sand. Its slopes are taken outside the branch, which
// WGSL wants, and widened as the bias would.
let groundSlateUv = input.worldPos.xy / ${slateSpan};
let groundSlateDx = dpdx(groundSlateUv) * ${n(2 ** CALM)};
let groundSlateDy = dpdy(groundSlateUv) * ${n(2 ** CALM)};
var groundSlateTilt = vec2f(0.);
if (input.vGroundGrass.z > 0.) { groundSlateTilt = textureSampleGrad(groundSlate, groundSlateSampler, groundSlateUv, groundSlateDx, groundSlateDy).rg * 2. - 1.; }
// The rock breaking through the grass near its edge, plate by plate.
if (input.vGroundGrass.x > 0. && groundD.g >= 0. && groundD.g < ${patchesIn} && textureSampleLevel(groundSlate, groundSlateSampler, input.worldPos.xy / ${patchSpan}, 0.).b > mix(${patched}, 1.05, groundD.g / ${patchesIn})) { discard; }
// A beach draws back from each wave as it breaks, and is wet where they reach.
var groundSwash = 0.;
if (input.vGroundSlot.w > 0.) { groundSwash = input.vGroundSlot.w * ${swash} * groundWash(material.groundTime, input.worldPos.xy) * (0.6 + 0.8 * groundFrayBy); }
if (groundD.g >= 0. && groundD.g < max(groundSwash, groundFrayBy * input.vGroundGrass.x * ${fray})) { discard; }`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `townShine = min(1., input.vGroundLook.a * ${glint} + groundGlinting);
baseColor = baseColor * input.vGroundLook.rgb * (1. + input.vGroundGrass.y * groundMottle * vec3f(${mottleWarm})) * (1. - ${wet} * input.vGroundSlot.w * (1. - smoothstep(${swash}, ${swash} * 1.6, groundD.g)) * step(0., groundD.g));
N = normalize(N - vec3f(groundBump * ${bump} * input.vGroundSlot.z, 0.) + vec3f((groundGlint.yz - 0.5) * 2. * ${glintTilt} * groundGlinting, 0.) + vec3f(groundSlateTilt * input.vGroundGrass.z, 0.));
// Its slope read only near an edge, where it rounds over.
if (groundD.g >= 0. && groundD.g < groundBevel) {
  let groundTx = vec2f(groundTexel.x, 0.);
  let groundTy = vec2f(0., groundTexel.y);
  let groundDx = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTx, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTx, 0.).g;
  let groundDy = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTy, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTy, 0.).g;
  if (groundDx * groundDx + groundDy * groundDy > 0.) {
    let groundOut = normalize(vec3f(-(groundDx * input.vGroundX + groundDy * input.vGroundY), 0.));
    N = normalize(mix(N, normalize(N + groundOut), 1. - groundD.g / groundBevel));
  }
}`,
          },
  };
}

/** The land's layers, chunk by chunk: each chunk's tiles one draw, each
 *  tile told its layer's height, colour, shine and round, the top layer's
 *  drawn first, so what lies under it is not shaded. A chunk drawn anew
 *  touches its own tiles alone, and a chunk out of view is not drawn. */
export class GroundTiles {
  private atlas: Atlas;
  private chunks = new Map<string, Mesh>();
  private material: TownMaterial;
  private colours: Rgb[] = LAYERS.map(() => WHITE);
  private stopClock: () => void;

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    beforeRender: (fn: () => void) => () => void,
  ) {
    // Its chunks bound to the atlas's texture anew whenever that grows.
    this.atlas = new Atlas(engine, SLOT, () => {
      for (const mesh of this.chunks.values()) markMeshRenderableDirty(mesh);
    });
    this.material = townMaterial([groundPlugin(engine, this.atlas)]);
    // The swash's clock, a frame at a time; and the atlas, as shapes come.
    this.stopClock = beforeRender(() => {
      this.atlas.upload();
      markMaterialUboDirty(this.material);
    });
  }

  /** A chunk's tiles, from its low corner, in place of whatever it had. */
  set(key: string, [ox, oy]: [number, number], layers: LayerTiles[]) {
    this.delete(key);
    const count = layers.reduce((sum, l) => sum + l.shapes.length, 0);
    if (!count) return;
    const matrices = new Float32Array(count * 16);
    // A tile's slot, round, bump and glint; colour and shine; fray, mottle and slate.
    const data = new Float32Array(count * 11);
    let n = 0;
    for (let l = layers.length - 1; l >= 0; l--) {
      const { at, shapes } = layers[l];
      const [{ z }, { shine, bevel, bump, glint, fray, mottle, slate: grain }, colour] = [LAYERS[l], LOOKS[l], this.colours[l]];
      for (let i = 0; i < shapes.length; i++, n++) {
        const m = n * 16;
        [matrices[m], matrices[m + 5], matrices[m + 10], matrices[m + 15]] = [1, 1, 1, 1];
        [matrices[m + 12], matrices[m + 13], matrices[m + 14]] = [ox + at[i * 2], oy + at[i * 2 + 1], z];
        data.set([this.atlas.slotOf(shapes[i], () => bake(shapes[i])), bevel, bump, glint, colour.r, colour.g, colour.b, shine, fray, mottle, grain], n * 11);
      }
    }
    const mesh = meshOf(this.engine, `ground_${key}`, { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
    mesh.material = this.material;
    mesh.receiveShadows = true;
    setThinInstances(mesh, matrices, count);
    setMeshAttribute(this.engine, mesh, "ground", data);
    // Baked before it is shown, so the atlas holds its shapes when it is bound.
    this.atlas.upload();
    show(this.scene, mesh);
    this.chunks.set(key, mesh);
  }

  delete(key: string) {
    const mesh = this.chunks.get(key);
    if (mesh) drop(this.scene, mesh);
    this.chunks.delete(key);
  }

  /** Each layer's colour, bottom up, for the chunks drawn from now on. */
  paint(colours: Rgb[]) {
    this.colours = colours;
  }

  dispose() {
    for (const key of [...this.chunks.keys()]) this.delete(key);
    this.stopClock();
    this.atlas.dispose();
  }
}
