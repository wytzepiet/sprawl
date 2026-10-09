import { createTexture2DFromPixels, markMaterialUboDirty, updateTexture2DFromPixels, setThinInstanceColors, setThinInstances, type DirectionalLight, type EngineContext as LiteEngine, type MaterialPlugin, type Mesh, type Texture2D } from "@babylonjs/lite";
import { CAST_ONLY, townMaterial, type TownMaterial } from "./material";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { drop, meshOf, show } from "./geometry";
import type { Area } from "./cull";
import { lacquer } from "./bevel";
import { COLUMNS, CONIFERS, CROWNS, CROWN_REACH, CROWN_TEXELS, LAYER_REACH, LIT, ROWS } from "./crowns";
import recipe from "./crowns.ts?raw";
import { baked } from "./bakeCache";

/**
 * Trees, forest and street alike: a crown on a trunk, a broadleaf's round
 * or a conifer's a star. Each set of
 * trees is two meshes of instances, one per part, each a square with its
 * shape drawn on it, so tens of thousands of trees in view cost four
 * corners each.
 *
 * The top is a square, the dome drawn on it: a pixel outside its circle is
 * dropped, and one in the circle's outer `CROWN_ROUND` turns its facing out
 * toward 45° at the edge, so the light rolls over it as over a dome. It
 * takes the shadows falling on it, and casts the far end of its own.
 *
 * The body is drawn only into the shadow map: a card nearly as tall as the
 * crown and as wide, turned square to the sun and cut to a trunk that
 * flares out into it, so a tree's shadow is a tree's. As it stands no higher than the crown, a
 * ray from the crown to the sun passes over it, so a tree never shades its
 * own top.
 */

/** How far in a crown's top rolls over, of its radius: wide, so it reads as
 *  a dome, not a disc's lip. */
const CROWN_ROUND = 0.45;
/** And the whole crown leans away from its middle, this much at its edge,
 *  steeply near the top and less further out: a peak, not a cushion. */
const CROWN_PEAK = 0.5;
/** A broadleaf's shadow is its side (`broadSolid`): a trunk this wide, of
 *  the card's height, flaring this much more at its foot and ending inside
 *  the crown; a canopy of this many clumps, one in the middle of an oval
 *  and the rest round its top and sides, branches from the trunk up into
 *  this many of them; the leaves ragging every clump's edge. */
const BARK_WIDE = 0.035;
const BARK_FOOT = 0.05;
const CLUMPS = 7;
/** The canopy's oval: its middle this high, of the card's height, and
 *  this high above and below it: shallow, hanging from the crown, which
 *  casts too. */
const CANOPY_MID = 0.78;
const CANOPY_HIGH = 0.18;
const BRANCHES = 4;
/** How tall the body's card stands, of the crown's height: as tall as
 *  the crown, its canopy's top level with the crown's top layer. */
const CARD_HEIGHT = 1;

/** A top in layers: a square each, at these heights of the crown's and
 *  this wide, each known to the shader by its facing's x, which nothing
 *  else reads (the crown's facing is the shader's own). A broadleaf's is
 *  one, at the crown's height. */
const layered = (heights: number[], reach: number[]) => ({
  positions: reach.flatMap((w, l) => [-w, -w, heights[l], w, -w, heights[l], w, w, heights[l], -w, w, heights[l]]),
  normals: reach.flatMap((_, l) => [l, 0, 1, l, 0, 1, l, 0, 1, l, 0, 1]),
  indices: reach.flatMap((_, l) => [0, 2, 1, 0, 3, 2].map((i) => i + l * 4)),
});
const BROAD_TOP = layered([1], [1]);
/** A conifer's top: a square a layer, at these heights, of the crown's,
 *  the topmost under the tip of its shadow's card (`SIDE_HIGH`), and as wide
 *  as its arms reach. They cast no shadow (the card does), so they may
 *  stand where they read best. */
const LAYER_HEIGHTS = [1.15, 0.82, 0.48];
const CONIFER_TOP = layered(LAYER_HEIGHTS, LAYER_REACH);
/** The body's card: x across it, -1 to 1, and z its foot (0) or head (1),
 *  which the shader turns to the sun and cuts to a trunk, facing along y,
 *  which the shader turns toward the sun. */
const BODY = {
  positions: [-1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
};

const f = (x: number) => x.toFixed(4);

/** The bark of a conifer's twigs, under its needles: this colour, this
 *  much of it through them. */
const BARK = [0.36, 0.47, 0.35];
const BARK_SHOWS = 0.5;
/** A conifer's shadow is its side, as its top is from above: branches
 *  down to the ground, this many rows of them up its height, drooping away
 *  from the trunk this much on the whole, each row its own way; each as
 *  long as the spire lets it, down to this much of that; twigs sticking
 *  out past it, this far, here and there; this much of a row branch and
 *  the rest a gap, the gap open in this many places of its length, but
 *  for the trunk, this wide. Wildest at its foot and clean at its tip. Its
 *  card this much wider than its crown. */
const SIDE_ROWS = 18;
const SIDE_DROOP = 0.5;
const SIDE_SHORT = 0.3;
const SIDE_TIPS = 0.15;
const SIDE_FILL = 0.85;
const SIDE_GAPS = 0.6;
const SIDE_TRUNK = 0.06;
const SIDE_WIDE = 1.2;
/** And taller than its crown: its layers at its quarters, its top quarter
 *  bare, a spire over them. */
const SIDE_HIGH = 4 / 3;
/** How it narrows up its height: 1 a cone; under it, wide further up. */
const SIDE_TAPER = 0.75;

export type Kind = "broad" | "conifer";
/** Each kind's crowns (`crowns.ts`), the first and how many; how far in its
 *  top rolls over, and leans from its middle; how dark between its clumps
 *  or branches; and its shadow's card, how wide, and what of it is cut
 *  away (`cardOut`). */
const LOOKS: Record<Kind, { first: number; count: number; round: number; peak: number; hollow: number; wide: number; high: number; cut: string }> = {
  broad: {
    first: 0,
    count: CROWNS,
    round: CROWN_ROUND,
    peak: CROWN_PEAK,
    hollow: 0.92,
    wide: 1,
    high: CARD_HEIGHT,
    cut: `let cardOut = !broadSolid(input.vCard.x * input.vCardAspect, input.vCard.y, input.vCardAspect, input.vCardSeed);`,
  },
  conifer: {
    first: CROWNS,
    count: CONIFERS,
    round: 0,
    peak: 0.8,
    hollow: 0.85,
    wide: SIDE_WIDE,
    high: SIDE_HIGH,
    cut: `let cardX = abs(input.vCard.x);
let cardWild = 1. - input.vCard.y;
let cardSide = sign(input.vCard.x);
let cardDroop = ${f(SIDE_DROOP)} * (0.4 + 1.2 * cardHash(vec2f(floor((input.vCard.y + cardX * ${f(SIDE_DROOP)}) * ${f(SIDE_ROWS)}), cardSide)).y);
let cardRow = (input.vCard.y + cardX * cardDroop) * ${f(SIDE_ROWS)};
let cardLong = cardHash(vec2f(floor(cardRow), cardSide + 3.));
let cardTwig = cardHash(vec2f(floor(cardX * 40.), floor(cardRow) + cardSide * 57.));
let cardReach = pow(1. - input.vCard.y, ${f(SIDE_TAPER)}) * mix(1., ${f(SIDE_SHORT)} + ${f(1 - SIDE_SHORT)} * cardLong.x, cardWild) + ${f(SIDE_TIPS)} * cardWild * cardTwig.x * step(0.7, cardTwig.y);
let cardGap = fract(cardRow) > ${f(SIDE_FILL)} && cardHash(vec2f(floor(cardX * 12.), floor(cardRow) - 11.)).x < ${f(SIDE_GAPS)} * cardWild && cardX > ${f(SIDE_TRUNK)};
let cardOut = cardX > cardReach || cardGap;`,
  },
};

const SHAPES = new WeakMap<LiteEngine, Texture2D>();
const BAKED = new WeakMap<LiteEngine, Promise<void>>();
/** When an engine's crowns are baked: at once if it has none. */
export function crownsBaked(engine: LiteEngine): Promise<void> {
  return BAKED.get(engine) ?? Promise.resolve();
}
function crownShapes(engine: LiteEngine): Texture2D {
  let texture = SHAPES.get(engine);
  if (!texture) {
    // Every texel past its crown's outline until the worker has baked them:
    // no tree shows before its crown does.
    const none = new Uint8Array(COLUMNS * ROWS * CROWN_TEXELS * CROWN_TEXELS * 4).fill(255);
    const made = createTexture2DFromPixels(engine, none, COLUMNS * CROWN_TEXELS, ROWS * CROWN_TEXELS, {
      format: "rgba8unorm",
      mipmaps: true,
      minFilter: "linear",
      magFilter: "linear",
    });
    SHAPES.set(engine, (texture = made));
    const asked = performance.now();
    BAKED.set(
      engine,
      baked("crowns", recipe, () => new Worker(new URL("./crownWorker.ts", import.meta.url), { type: "module" })).then((data) => {
        updateTexture2DFromPixels(engine, made, data);
        if (import.meta.env.DEV) console.info(`[crowns] ready ${(performance.now() - asked).toFixed(0)} ms after asked`);
      }),
    );
  }
  return texture;
}

/** Where the pixel is on its crown, in the world's turn, a radius out at 1,
 *  and, by where the tree stands, which crown it wears and how it is turned,
 *  once a corner. Then its crown, turned the tree's way, read:
 *  cut to its outline, and its facing rolled over the dome, over the clump,
 *  and turned by the leaf. */
function crownPlugin(engine: LiteEngine, { first, count, round, peak, hollow }: (typeof LOOKS)[Kind]): MaterialPlugin {
  const rolled = round > 0 ? `mix(vec3f(0., 0., 1.), vec3f(crownOut, 1.) * 0.70710678, clamp((crownR - ${f(1 - round)}) / ${f(round)}, 0., 1.))` : "vec3f(0., 0., 1.)";
  return {
    name: "Crown",
    priority: 200,
    getVaryings: () => [
      { name: "vCrown", type: "vec2f" },
      { name: "vCrownTurn", type: "vec2f" },
      { name: "vCrownCell", type: "vec2f" },
    ],
    getSamplers: () => [{ texture: "crownShape", sampler: "crownShapeSampler" }],
    bindTextures: (out) => out.push({ texture: crownShapes(engine) }),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? {
            CUSTOM_VERTEX_MAIN_END: `out.vCrown = (finalWorld * vec4f(position.xy, 0., 0.)).xy / length(finalWorld[0].xyz);
let treeCell = floor(finalWorld[3].xy * 13.);
let treeSeed = fract(sin(vec2f(dot(treeCell, vec2f(127.1, 311.7)), dot(treeCell, vec2f(269.5, 183.3)))) * 43758.5453);
out.vCrownTurn = vec2f(cos(treeSeed.y * 6.2831853), sin(treeSeed.y * 6.2831853));
let crownWorn = ${first}. + round(normal.x) * ${count}. + floor(treeSeed.x * ${count}.);
out.vCrownCell = vec2f(crownWorn - ${COLUMNS}. * floor(crownWorn / ${COLUMNS}.), floor(crownWorn / ${COLUMNS}.));`,
          }
        : {
            // Cut round where its shadow is drawn too; shaped where it is seen.
            CUSTOM_FRAGMENT_UPDATE_ALPHA: `let crownTurn = input.vCrownTurn;
let crownUv = vec2f(crownTurn.x * input.vCrown.x + crownTurn.y * input.vCrown.y, crownTurn.x * input.vCrown.y - crownTurn.y * input.vCrown.x);
let crownTex = textureSample(crownShape, crownShapeSampler, (input.vCrownCell + crownUv / ${f(2 * CROWN_REACH)} + 0.5) / vec2f(${COLUMNS}., ${ROWS}.));
let crownR = crownTex.r * 2.;
// Turned, its square's corners reach past what is baked, into the next crown's.
if (crownR > 1. || dot(input.vCrown, input.vCrown) > 1.) { discard; }`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let crownOut = input.vCrown / max(length(input.vCrown), 1e-4);
let crownLean = crownTex.gb * 2. - 1.;
let crownTilt = vec2f(crownTurn.x * crownLean.x - crownTurn.y * crownLean.y, crownTurn.y * crownLean.x + crownTurn.x * crownLean.y);
N = normalize(${rolled} + vec3f(crownTilt + crownOut * sqrt(length(input.vCrown)) * ${f(peak)}, 0.));
baseColor = mix(baseColor * mix(${f(hollow)}, 1., min(crownTex.a / ${f(LIT)}, 1.)), vec3f(${BARK.map(f).join(", ")}), smoothstep(${f(LIT)}, 1., crownTex.a) * ${f(BARK_SHOWS)});`,
          },
  };
}

/** The body's card, turned square to the way the sun's light runs over the
 *  ground (straight down, any way will do): its world turned so its x runs
 *  across the light, its z up the trunk, and its y — the card's facing, which
 *  its vertices never leave — toward the sun, for the bias. Cast, never seen. */
function cardPlugin(sun: () => { x: number; y: number; z: number }, cut: string, wide: number, high: number): MaterialPlugin {
  return {
    name: "Card",
    priority: 200,
    getVaryings: () => [
      { name: "vCard", type: "vec2f" },
      { name: "vCardAspect", type: "f32" },
      { name: "vCardSeed", type: "f32" },
    ],
    getUniforms: () => ({ ubo: [{ name: "treeSun", type: "vec4<f32>", visibility: "vertex" }] }),
    writeUbo: (data, offsets) => {
      const d = sun();
      data.set([d.x, d.y, d.z, 0], offsets.get("treeSun")! / 4);
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? {
            CUSTOM_VERTEX_UPDATE_WORLDPOS: `let cardD = normalize(material.treeSun.xyz);
let cardA = select(vec2f(1., 0.), normalize(cardD.xy), length(cardD.xy) > 1e-4);
finalWorld = mat4x4f(vec4f(length(finalWorld[0].xyz) * ${f(wide)} * vec3f(-cardA.y, cardA.x, 0.), 0.), vec4f(-cardD, 0.), vec4f(0., 0., ${f(high)} * length(finalWorld[2].xyz), 0.), finalWorld[3]);`,
            CUSTOM_VERTEX_MAIN_END: `out.vCard = position.xz;
out.vCardAspect = length(finalWorld[0].xyz) / max(length(finalWorld[2].xyz), 1e-4);
out.vCardSeed = fract(sin(dot(floor(finalWorld[3].xy * 13.), vec2f(12.9898, 78.233))) * 43758.5453) * 97.;`,
          }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `fn cardHash(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
fn cardNoise(p: vec2f) -> f32 {
  let i = floor(p); let t = smoothstep(vec2f(0.), vec2f(1.), fract(p));
  return mix(mix(cardHash(i).x, cardHash(i + vec2f(1., 0.)).x, t.x), mix(cardHash(i + vec2f(0., 1.)).x, cardHash(i + vec2f(1., 1.)).x, t.x), t.y);
}
// A broadleaf's clump i of seed s, in the card's height: its middle and radius.
fn broadClump(i: i32, s: f32, a: f32) -> vec3f {
  let h = cardHash(vec2f(s + f32(i), 3.));
  let mid = ${f(CANOPY_MID)}; let ox = min(0.42, a * 0.6); let oy = ${f(CANOPY_HIGH)};
  if (i == 0) { let r0 = 0.24 + 0.03 * h.y; return vec3f((h.x - 0.5) * 0.06, min(mid, 1. - r0 * 1.05), r0); }
  let t = 3.14159265 * (-0.12 + 1.24 * f32(i - 1) / ${CLUMPS - 2}.) + (h.x - 0.5) * 0.25;
  let r = 0.15 + 0.05 * cardHash(vec2f(s + f32(i), 5.)).x;
  return vec3f(cos(t) * ox * (0.85 + 0.25 * h.y), min(mid + sin(t) * oy * (0.85 + 0.25 * h.y), 1. - r * 1.05), r);
}
// Whether a broadleaf's side covers (x, y): its trunk, a clump, or a branch.
fn broadSolid(x: f32, y: f32, a: f32, s: f32) -> bool {
  if (y < 0.6 && abs(x) < ${f(BARK_WIDE)} * (1. - 0.4 * y) + ${f(BARK_FOOT)} * pow(max(0., 1. - y / 0.12), 2.)) { return true; }
  let leaf = cardNoise(vec2f(x * 28. + s, y * 28.));
  let edge = 1. + (leaf - 0.5) * 0.35;
  for (var i = 0; i < ${CLUMPS}; i++) {
    let c = broadClump(i, s, a);
    let d = length(vec2f(x, y) - c.xy) / c.z;
    if (d < edge && !(d > 0.72 * edge && leaf > 0.78)) { return true; }
  }
  for (var i = 0; i < ${BRANCHES}; i++) {
    let c = broadClump(i % ${CLUMPS}, s, a);
    let foot = vec2f(0., min(0.22 + 0.25 * cardHash(vec2f(s + f32(i), 7.)).x, c.y - 0.05));
    let v = c.xy - foot; let w = vec2f(x, y) - foot;
    let t = clamp(dot(w, v) / dot(v, v), 0., 1.);
    if (length(w - v * t) < 0.022 * (1. - 0.7 * t)) { return true; }
  }
  return false;
}`,
            CUSTOM_FRAGMENT_UPDATE_ALPHA: `${cut}
if (cardOut) { discard; }`,
          },
  };
}

/** The engine's tree materials, bodies' and tops' of each kind, made once;
 *  the cards' sun kept up a frame at a time. */
const MATERIALS = new WeakMap<LiteEngine, Record<Kind, { body: TownMaterial; top: TownMaterial }>>();
function treeMaterials({ engine, scene, beforeRender }: EngineContext, kind: Kind) {
  let m = MATERIALS.get(engine);
  if (!m) {
    const sun = () => (scene.lights.find((l) => l.shadowGenerator) as DirectionalLight | undefined)?.direction ?? { x: 0, y: 0, z: -1 };
    const made = (look: (typeof LOOKS)[Kind]) => {
      const body = townMaterial([cardPlugin(sun, look.cut, look.wide, look.high), CAST_ONLY]);
      body.doubleSided = true;
      beforeRender(() => markMaterialUboDirty(body));
      return { body, top: lacquer(townMaterial([crownPlugin(engine, look)]), "tree") };
    };
    m = { broad: made(LOOKS.broad), conifer: made(LOOKS.conifer) };
    MATERIALS.set(engine, m);
  }
  return m[kind];
}

export interface Grove {
  bodies: Mesh;
  tops: Mesh;
  /** What of it casts: a broadleaf its card and its crown, which costs no
   *  frame (it stands still, and the shadows' cache keeps it); a conifer
   *  its card alone, as its layered top is not one surface. */
  casting: Mesh[];
  planted: boolean;
}

/** A set of trees of a kind, none planted yet: its tops take shadows. */
export function grove(ctx: EngineContext, name: string, kind: Kind = "broad"): Grove {
  const { body, top } = treeMaterials(ctx, kind);
  const [bodies, tops] = ([[BODY, body], [kind === "conifer" ? CONIFER_TOP : BROAD_TOP, top]] as const).map(([geo, material], i) => {
    const mesh = meshOf(ctx.engine, `${name}_${kind === "broad" ? "tree" : "conifer"}_${i ? "tops" : "bodies"}`, geo);
    mesh.material = material;
    return mesh;
  });
  tops.receiveShadows = true;
  return { bodies, tops, casting: kind === "conifer" ? [bodies] : [bodies, tops], planted: false };
}

/** Trees planted, 16 floats of matrix and 4 of colour each, in place of
 *  any before, over an area of the map: shown while it is in view, and
 *  casting. False when there are none. */
export function plant({ scene, cull }: EngineContext, g: Grove, matrices: Float32Array, colors: Float32Array, casters: Casters | undefined, area: Area): boolean {
  const count = matrices.length / 16;
  if (!count) return false;
  for (const mesh of [g.bodies, g.tops]) {
    setThinInstances(mesh, matrices, count);
    setThinInstanceColors(mesh, colors);
    if (g.planted) continue;
    cull.keep(mesh, area);
    show(scene, mesh);
    if (g.casting.includes(mesh)) casters?.add(mesh);
  }
  g.planted = true;
  return true;
}

export function uproot({ scene, cull }: EngineContext, g: Grove, casters: Casters | undefined) {
  if (!g.planted) return;
  for (const mesh of [g.bodies, g.tops]) {
    casters?.remove(mesh);
    cull.forget(mesh);
    drop(scene, mesh);
  }
}
