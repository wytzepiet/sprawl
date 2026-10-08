import { markMaterialUboDirty, setThinInstanceColors, setThinInstances, type DirectionalLight, type EngineContext as LiteEngine, type MaterialPlugin, type Mesh } from "@babylonjs/lite";
import { CAST_ONLY, townMaterial, type TownMaterial } from "./material";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { drop, meshOf, show } from "./geometry";
import { lacquer } from "./bevel";

/**
 * Trees, forest and street alike: a round crown on a trunk. Each set of
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
/** How wide the trunk is, of the crown's radius, and how far up it starts
 *  to ease out into the crown, of the card's height: a tree's shadow. */
const TRUNK = 0.25;
const FLARE = 0.45;
/** How tall the body's card stands, of the crown's height: a hair under
 *  it, or the shadow map can't tell the card's head from the crown and
 *  draws a line of shadow across it. */
const CARD_HEIGHT = 0.95;

/** The top: a square of radius 1 at height 1, facing up. */
const CROWN_TOP = {
  positions: [-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 2, 1, 0, 3, 2],
};
/** The body's card: x across it, -1 to 1, and z its foot (0) or head (1),
 *  which the shader turns to the sun and cuts to a trunk, facing along y,
 *  which the shader turns toward the sun. */
const BODY = {
  positions: [-1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
};

const f = (x: number) => x.toFixed(4);

/** A crown is clumps of leaves: cells this wide, of its radius, each with
 *  a clump somewhere in it. Between clumps its outline is pulled in this
 *  far, so it is lumpy, not round, and frayed by its leaves; each clump
 *  rolls over as a dome of its own, this much; and the leaves on it face
 *  every way, this much, a leaf this small, each turning smoothly into the
 *  next. Only its facing, never its colour: the light makes the leaves.
 *  Every tree's clumps are its own, by where it stands. */
const CLUMP = 0.85;
const LUMP = 0.15;
const FRINGE = 0.12;
const CLUMP_TILT = 0.35;
const LEAF = 1 / 20;
const LEAF_TILT = 0.5;

/** Where the pixel is on its crown, in the world's turn, a radius out at 1,
 *  and where the tree stands; facing up, for the shadow map's bias. Then
 *  the crown: the clump nearest the pixel, the outline pulled in away from
 *  clumps and frayed by the leaves, and the facing rolled over the dome,
 *  over the clump, and turned by the leaf. */
const CROWN_PLUGIN: MaterialPlugin = {
  name: "Crown",
  priority: 200,
  getVaryings: () => [
    { name: "vCrown", type: "vec2f" },
    { name: "vTreeAt", type: "vec2f" },
  ],
  getCustomCode: (stage) =>
    stage === "vertex"
      ? { CUSTOM_VERTEX_MAIN_END: "out.vCrown = (finalWorld * vec4f(position.xy, 0., 0.)).xy / length(finalWorld[0].xyz); out.vTreeAt = finalWorld[3].xy;" }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: `fn treeHash(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
fn treeNoise(p: vec2f) -> vec2f { let i = floor(p); let t = smoothstep(vec2f(0.), vec2f(1.), fract(p)); return mix(mix(treeHash(i), treeHash(i + vec2f(1., 0.)), t.x), mix(treeHash(i + vec2f(0., 1.)), treeHash(i + vec2f(1., 1.)), t.x), t.y); }`,
          // Cut round where its shadow is drawn too; shaped where it is seen.
          CUSTOM_FRAGMENT_UPDATE_ALPHA: `let treeSeed = treeHash(floor(input.vTreeAt * 13.));
let clumpAt = input.vCrown / ${f(CLUMP)} + treeSeed * 17.;
var clumpD = 9.;
var clumpTo = vec2f(0.);
for (var j = -1; j <= 1; j++) {
  for (var i = -1; i <= 1; i++) {
    let c = floor(clumpAt) + vec2f(f32(i), f32(j));
    let d = clumpAt - (c + 0.15 + 0.7 * treeHash(c));
    if (length(d) < clumpD) { clumpD = length(d); clumpTo = d; }
  }
}
let crownLeaf = treeNoise(input.vCrown / ${f(LEAF)} + treeSeed * 31.);
let crownR = length(input.vCrown) + ${f(LUMP)} * (clumpD - 0.25) + (crownLeaf.x - 0.5) * ${f(FRINGE)};
if (crownR > 1.) { discard; }`,
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let crownT = clamp((crownR - ${f(1 - CROWN_ROUND)}) / ${f(CROWN_ROUND)}, 0., 1.);
let crownOut = input.vCrown / max(length(input.vCrown), 1e-4);
N = normalize(mix(vec3f(0., 0., 1.), vec3f(crownOut, 1.) * 0.70710678, crownT) + vec3f(clumpTo * ${f(CLUMP_TILT)} + (crownLeaf - 0.5) * ${f(LEAF_TILT)}, 0.));`,
        },
};

/** The body's card, turned square to the way the sun's light runs over the
 *  ground (straight down, any way will do): its world turned so its x runs
 *  across the light, its z up the trunk, and its y — the card's facing, which
 *  its vertices never leave — toward the sun, for the bias. Cast, never seen. */
function cardPlugin(sun: () => { x: number; y: number; z: number }): MaterialPlugin {
  return {
    name: "Card",
    priority: 200,
    getVaryings: () => [{ name: "vCard", type: "vec2f" }],
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
finalWorld = mat4x4f(vec4f(length(finalWorld[0].xyz) * vec3f(-cardA.y, cardA.x, 0.), 0.), vec4f(-cardD, 0.), vec4f(0., 0., ${f(CARD_HEIGHT)} * length(finalWorld[2].xyz), 0.), finalWorld[3]);`,
            CUSTOM_VERTEX_MAIN_END: "out.vCard = position.xz;",
          }
        : {
            CUSTOM_FRAGMENT_UPDATE_ALPHA: `let cardFlare = clamp((input.vCard.y - ${f(FLARE)}) / ${f(1 - FLARE)}, 0., 1.);
if (abs(input.vCard.x) > mix(${f(TRUNK)}, 1., smoothstep(0., 1., cardFlare))) { discard; }`,
          },
  };
}

/** The engine's two tree materials, bodies' and tops', made once; the
 *  card's sun kept up a frame at a time. */
const MATERIALS = new WeakMap<LiteEngine, { body: TownMaterial; top: TownMaterial }>();
function treeMaterials({ engine, scene, beforeRender }: EngineContext) {
  let m = MATERIALS.get(engine);
  if (!m) {
    const sun = () => (scene.lights.find((l) => l.shadowGenerator) as DirectionalLight | undefined)?.direction ?? { x: 0, y: 0, z: -1 };
    const body = townMaterial([cardPlugin(sun), CAST_ONLY]);
    body.doubleSided = true;
    const top = lacquer(townMaterial([CROWN_PLUGIN]), "tree");
    beforeRender(() => markMaterialUboDirty(body));
    m = { body, top };
    MATERIALS.set(engine, m);
  }
  return m;
}

export interface Grove {
  bodies: Mesh;
  tops: Mesh;
  planted: boolean;
}

/** A set of trees, none planted yet: both parts will cast shadows, its tops take them. */
export function grove(ctx: EngineContext, name: string): Grove {
  const { body, top } = treeMaterials(ctx);
  const [bodies, tops] = ([[BODY, body], [CROWN_TOP, top]] as const).map(([geo, material], i) => {
    const mesh = meshOf(ctx.engine, `${name}_tree_${i ? "tops" : "bodies"}`, geo);
    mesh.material = material;
    return mesh;
  });
  tops.receiveShadows = true;
  return { bodies, tops, planted: false };
}

/** Trees planted, 16 floats of matrix and 4 of colour each, in place of
 *  any before: shown, and casting. False when there are none. */
export function plant({ scene }: EngineContext, g: Grove, matrices: Float32Array, colors: Float32Array, casters: Casters | undefined): boolean {
  const count = matrices.length / 16;
  if (!count) return false;
  for (const mesh of [g.bodies, g.tops]) {
    setThinInstances(mesh, matrices, count);
    setThinInstanceColors(mesh, colors);
    if (g.planted) continue;
    show(scene, mesh);
    casters?.add(mesh);
  }
  g.planted = true;
  return true;
}

export function uproot({ scene }: EngineContext, g: Grove, casters: Casters | undefined) {
  if (!g.planted) return;
  for (const mesh of [g.bodies, g.tops]) {
    casters?.remove(mesh);
    drop(scene, mesh);
  }
}
