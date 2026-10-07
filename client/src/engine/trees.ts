import { MaterialDefines, MaterialPluginBase, Mesh, ShadowDepthWrapper, VertexData, type Material, type PBRMaterial, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { townMaterial } from "./material";
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
/** A layer no camera draws, only the shadow map. */
export const SHADOW_ONLY = 0x10000000;

/** The top: a square of radius 1 at height 1, facing up. */
const CROWN_TOP = {
  positions: [-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 2, 1, 0, 3, 2],
};
/** The body's card: x across it, -1 to 1, and z its foot (0) or head (1),
 *  which the shader turns to the sun and cuts to a trunk. y spreads it over the trunk's box,
 *  so its bounds hold wherever it turns. */
const BODY = {
  positions: [-1, -1, 0, 1, 1, 0, 1, 1, 1, -1, -1, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
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
const CROWN = {
  glsl: {
    vertex: {
      CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vCrown; varying vec2 vTreeAt;`,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `vec3 treeNormal = vec3(0., 0., 1.);`,
      CUSTOM_VERTEX_MAIN_END: `vCrown = (finalWorld * vec4(positionUpdated.xy, 0., 0.)).xy / length(finalWorld[0].xyz); vTreeAt = finalWorld[3].xy;`,
    },
    fragment: {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vCrown; varying vec2 vTreeAt;
vec2 treeHash(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec2 treeNoise(vec2 p) { vec2 i = floor(p); vec2 t = smoothstep(0., 1., fract(p)); return mix(mix(treeHash(i), treeHash(i + vec2(1., 0.)), t.x), mix(treeHash(i + vec2(0., 1.)), treeHash(i + vec2(1., 1.)), t.x), t.y); }`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `vec2 treeSeed = treeHash(floor(vTreeAt * 13.));
vec2 clumpAt = vCrown / ${f(CLUMP)} + treeSeed * 17.;
float clumpD = 9.;
vec2 clumpTo = vec2(0.);
for (int j = -1; j <= 1; j++) {
  for (int i = -1; i <= 1; i++) {
    vec2 c = floor(clumpAt) + vec2(float(i), float(j));
    vec2 d = clumpAt - (c + 0.15 + 0.7 * treeHash(c));
    if (length(d) < clumpD) { clumpD = length(d); clumpTo = d; }
  }
}
vec2 crownLeaf = treeNoise(vCrown / ${f(LEAF)} + treeSeed * 31.);
float crownR = length(vCrown) + ${f(LUMP)} * (clumpD - 0.25) + (crownLeaf.x - 0.5) * ${f(FRINGE)};
if (crownR > 1.) discard;
float crownT = clamp((crownR - ${f(1 - CROWN_ROUND)}) / ${f(CROWN_ROUND)}, 0., 1.);
vec2 crownOut = vCrown / max(length(vCrown), 1e-4);
normalW = normalize(mix(vec3(0., 0., 1.), vec3(crownOut, 1.) * 0.70710678, crownT) + vec3(clumpTo * ${f(CLUMP_TILT)} + (crownLeaf - 0.5) * ${f(LEAF_TILT)}, 0.));`,
    },
  },
  wgsl: {
    vertex: {
      CUSTOM_VERTEX_DEFINITIONS: `varying vCrown: vec2f; varying vTreeAt: vec2f;`,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `let treeNormal = vec3f(0., 0., 1.);`,
      CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vCrown = (finalWorld * vec4f(positionUpdated.xy, 0., 0.)).xy / length(finalWorld[0].xyz); vertexOutputs.vTreeAt = finalWorld[3].xy;`,
    },
    fragment: {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vCrown: vec2f; varying vTreeAt: vec2f;
fn treeHash(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
fn treeNoise(p: vec2f) -> vec2f { let i = floor(p); let t = smoothstep(vec2f(0.), vec2f(1.), fract(p)); return mix(mix(treeHash(i), treeHash(i + vec2f(1., 0.)), t.x), mix(treeHash(i + vec2f(0., 1.)), treeHash(i + vec2f(1., 1.)), t.x), t.y); }`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let treeSeed = treeHash(floor(fragmentInputs.vTreeAt * 13.));
let clumpAt = fragmentInputs.vCrown / ${f(CLUMP)} + treeSeed * 17.;
var clumpD = 9.;
var clumpTo = vec2f(0.);
for (var j = -1; j <= 1; j++) {
  for (var i = -1; i <= 1; i++) {
    let c = floor(clumpAt) + vec2f(f32(i), f32(j));
    let d = clumpAt - (c + 0.15 + 0.7 * treeHash(c));
    if (length(d) < clumpD) { clumpD = length(d); clumpTo = d; }
  }
}
let crownLeaf = treeNoise(fragmentInputs.vCrown / ${f(LEAF)} + treeSeed * 31.);
let crownR = length(fragmentInputs.vCrown) + ${f(LUMP)} * (clumpD - 0.25) + (crownLeaf.x - 0.5) * ${f(FRINGE)};
if (crownR > 1.) { discard; }
let crownT = clamp((crownR - ${f(1 - CROWN_ROUND)}) / ${f(CROWN_ROUND)}, 0., 1.);
let crownOut = fragmentInputs.vCrown / max(length(fragmentInputs.vCrown), 1e-4);
normalW = normalize(mix(vec3f(0., 0., 1.), vec3f(crownOut, 1.) * 0.70710678, crownT) + vec3f(clumpTo * ${f(CLUMP_TILT)} + (crownLeaf - 0.5) * ${f(LEAF_TILT)}, 0.));`,
    },
  },
};

/** The body's card, turned square to the way the sun's light runs over the
 *  ground (straight down, any way will do); facing the sun, for the bias. */
const CARD = {
  glsl: {
    vertex: {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `vec3 cardD = normalize(treeSun);
vec2 cardA = length(cardD.xy) > 1e-4 ? normalize(cardD.xy) : vec2(1., 0.);
worldPos = vec4(finalWorld[3].xyz + positionUpdated.x * length(finalWorld[0].xyz) * vec3(-cardA.y, cardA.x, 0.) + vec3(0., 0., positionUpdated.z * ${f(CARD_HEIGHT)} * length(finalWorld[2].xyz)), 1.);
vec3 treeNormal = -cardD;
vCard = positionUpdated.xz;`,
      CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vCard;`,
    },
    fragment: {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vCard;`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `float cardFlare = clamp((vCard.y - ${f(FLARE)}) / ${f(1 - FLARE)}, 0., 1.);
if (abs(vCard.x) > mix(${f(TRUNK)}, 1., smoothstep(0., 1., cardFlare))) discard;`,
    },
  },
  wgsl: {
    vertex: {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `let cardD = normalize(uniforms.treeSun);
let cardA = select(vec2f(1., 0.), normalize(cardD.xy), length(cardD.xy) > 1e-4);
worldPos = vec4f(finalWorld[3].xyz + positionUpdated.x * length(finalWorld[0].xyz) * vec3f(-cardA.y, cardA.x, 0.) + vec3f(0., 0., positionUpdated.z * ${f(CARD_HEIGHT)} * length(finalWorld[2].xyz)), 1.);
let treeNormal = -cardD;
vertexOutputs.vCard = positionUpdated.xz;`,
      CUSTOM_VERTEX_DEFINITIONS: `varying vCard: vec2f;`,
    },
    fragment: {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vCard: vec2f;`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `let cardFlare = clamp((fragmentInputs.vCard.y - ${f(FLARE)}) / ${f(1 - FLARE)}, 0., 1.);
if (abs(fragmentInputs.vCard.x) > mix(${f(TRUNK)}, 1., smoothstep(0., 1., cardFlare))) { discard; }`,
    },
  },
};

/** Each part's code, by its plugin's name: Babylon asks for it while the
 *  plugin is still being made. */
const CODE: Record<string, { glsl: Code; wgsl: Code }> = { Crown: CROWN, Card: CARD };
type Code = { vertex: Record<string, string>; fragment: Record<string, string> };

class TreeDefines extends MaterialDefines {
  TREE = false;
}

/** A tree part's shape, drawn on its square. The card needs the sun: the
 *  light that casts the scene's shadows. */
class TreePlugin extends MaterialPluginBase {
  constructor(material: Material, name: keyof typeof CODE) {
    super(material, name, 200, new TreeDefines());
    this._enable(true);
  }

  /** Whether this part stands by the sun. */
  private get sun() {
    return this.name === "Card";
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: TreeDefines) {
    defines.TREE = true;
  }

  getUniforms(shaderLanguage = 0) {
    if (!this.sun) return {};
    return {
      ubo: [{ name: "treeSun", size: 3, type: "vec3" }],
      vertex: shaderLanguage === 1 ? "uniform treeSun: vec3f;" : "uniform vec3 treeSun;",
    };
  }

  bindForSubMesh(ubo: { updateVector3(name: string, v: { x: number; y: number; z: number }): void }) {
    if (!this.sun) return;
    const light = this._material.getScene().lights.find((l) => l.getShadowGenerator());
    const dir = (light as { direction?: { x: number; y: number; z: number } } | undefined)?.direction;
    ubo.updateVector3("treeSun", dir ?? { x: 0, y: 0, z: -1 });
  }

  getClassName() {
    return `${this.name}Plugin`;
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    const part = CODE[this.name as keyof typeof CODE];
    const code = shaderLanguage === 1 ? part.wgsl : part.glsl;
    return shaderType === "vertex" ? code.vertex : code.fragment;
  }
}

/** The scene's two tree materials, bodies' and tops', made once. */
const MATERIALS = new WeakMap<Scene, { body: PBRMaterial; top: PBRMaterial }>();
function treeMaterials(scene: Scene) {
  let m = MATERIALS.get(scene);
  if (!m) {
    const body = townMaterial("tree_bodies", scene);
    body.backFaceCulling = false;
    new TreePlugin(body, "Card");
    const top = lacquer(townMaterial("tree_tops", scene), "tree");
    new TreePlugin(top, "Crown");
    // Drawn into the shadow map by their own shaders, so the card stands
    // and the crown is cut round there too; each says which way it faces.
    const remappedVariables = ["worldPos", "worldPos", "vNormalW", "treeNormal"];
    body.shadowDepthWrapper = new ShadowDepthWrapper(body, scene, { standalone: true, remappedVariables });
    top.shadowDepthWrapper = new ShadowDepthWrapper(top, scene, { remappedVariables });
    m = { body, top };
    MATERIALS.set(scene, m);
    for (const mat of [body, top]) scene.onDisposeObservable.addOnce(() => mat.dispose());
  }
  return m;
}

export interface Grove {
  bodies: Mesh;
  tops: Mesh;
}

/** A set of trees, none planted yet: both parts cast shadows, its tops take them. */
export function grove(scene: Scene, name: string, shadows: ShadowGenerator | undefined): Grove {
  const { body, top } = treeMaterials(scene);
  const [bodies, tops] = ([[BODY, body], [CROWN_TOP, top]] as const).map(([geo, material], i) => {
    const mesh = new Mesh(`${name}_tree_${i ? "tops" : "bodies"}`, scene);
    const data = new VertexData();
    Object.assign(data, { positions: geo.positions, indices: geo.indices, normals: geo.normals });
    data.applyToMesh(mesh);
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  });
  bodies.layerMask = SHADOW_ONLY;
  tops.receiveShadows = true;
  shadows?.addShadowCaster(bodies);
  shadows?.addShadowCaster(tops);
  return { bodies, tops };
}

/** Trees planted, 16 floats of matrix and 4 of colour each, in place of
 *  any before. False when there are none. */
export function plant(g: Grove, matrices: Float32Array, colors: Float32Array): boolean {
  for (const mesh of [g.bodies, g.tops]) {
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    mesh.thinInstanceSetBuffer("color", colors, 4, true);
    // Without this the mesh keeps the lone base tree's bounds, and every
    // tree in it is culled as soon as that one leaves view.
    mesh.thinInstanceRefreshBoundingInfo(true);
  }
  return matrices.length > 0;
}

export function uproot(g: Grove, shadows: ShadowGenerator | undefined) {
  shadows?.removeShadowCaster(g.bodies);
  shadows?.removeShadowCaster(g.tops);
  g.bodies.dispose();
  g.tops.dispose();
}
