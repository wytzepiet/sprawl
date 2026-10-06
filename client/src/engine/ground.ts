import { BoundingInfo, Color3, Constants, MaterialDefines, MaterialPluginBase, Mesh, RawTexture, StandardMaterial, TransformNode, Vector3, VertexData, type Material, type Scene } from "@babylonjs/core";
import { Atlas } from "./atlas";
import { FAR, kerbDistances } from "./kerbLines";
import { CHUNK_SIZE, LAYERS, nearLines, outlineOf, parseShape, shapeGeometry, type LayerTiles } from "./objects/terrainGeometry";
import { fillTriangles } from "./raster";

/**
 * The land, layer on layer (`LAYERS`): the sand, the grass on it, the wood
 * floor, the rock. Every tile of a layer is the same square, its share of
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
 * lies, lightens and darkens the colour a little.
 */

/** The grain's side, in texels, how many tiles it spans, and how much it
 *  lightens and darkens. A texel is about a pixel at the usual zoom;
 *  further out the mipmaps smooth it away. */
const SIDE = 256;
const SPAN = 4;
const GRAIN = 0.06;

/** How far in from its edge ground rounds over it, in tiles: 45 degrees at
 *  the edge itself, level by here. */
const BEVEL = 0.1;
/** Each layer's shine, of the toy's lacquer: sand and rock keep a little,
 *  grass and wood are matte, the grain their texture. And how far it
 *  rounds over its edges: the wood floor lies on the grass, and only its
 *  edges onto the sand round over, which the grass under it does. */
const LOOKS = [
  { shine: 0.12, bevel: BEVEL },
  // Grass rounds over onto the sand more tightly, half as far.
  { shine: 0, bevel: BEVEL / 2 },
  { shine: 0, bevel: 0 },
  { shine: 0.15, bevel: BEVEL },
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

const GRAINS = new WeakMap<Scene, RawTexture>();
function grain(scene: Scene): RawTexture {
  let texture = GRAINS.get(scene);
  if (!texture) {
    texture = new RawTexture(grainData(), SIDE, SIDE, Constants.TEXTUREFORMAT_R, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    texture.wrapU = texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    GRAINS.set(scene, texture);
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
  const reach = BEVEL + 2 / DENSITY;
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

class GroundDefines extends MaterialDefines {
  GROUND = false;
}

const n = (x: number) => x.toFixed(4);
const [span, strength, origin, slotSpan] = [n(SPAN), n(GRAIN * 2), n(ORIGIN), n(SLOT / DENSITY)];
// Half a texel in from the tile's edge: whether a pixel is on the share is
// read off the tile's own texels alone, never blended with the margin's.
const [inner0, inner1] = [n(0.5 / DENSITY), n(1 - 0.5 / DENSITY)];

// Where on its square a pixel is, its square's slot, and which ways the
// square's own x and y run in the world, however the sheet is placed.
// Then the grain, before anything is dropped (its mipmaps need every
// pixel); whether the pixel is on the share; and how near its edges.
const GLSL = {
  vertex: {
    CUSTOM_VERTEX_DEFINITIONS: `attribute vec2 groundSlot; attribute vec4 groundLook; varying vec2 vGroundAt; varying vec2 vGroundSlot; varying vec4 vGroundLook; varying vec2 vGroundX; varying vec2 vGroundY;`,
    CUSTOM_VERTEX_MAIN_END: `vGroundAt = positionUpdated.xy; vGroundSlot = groundSlot; vGroundLook = groundLook; vGroundX = (finalWorld * vec4(1., 0., 0., 0.)).xy; vGroundY = (finalWorld * vec4(0., 1., 0., 0.)).xy;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vGroundAt; varying vec2 vGroundSlot; varying vec4 vGroundLook; varying vec2 vGroundX; varying vec2 vGroundY; uniform sampler2D groundGrain; uniform sampler2D groundAtlas;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `float groundGrainAt = texture2D(groundGrain, vPositionW.xy / ${span}).r;
float groundSlotN = floor(vGroundSlot.x + 0.5);
float groundBevel = vGroundSlot.y;
vec2 groundCell = vec2(mod(groundSlotN, groundGrid.x), floor(groundSlotN / groundGrid.x));
vec2 groundUv = (groundCell + (vGroundAt - ${origin}) / ${slotSpan}) / groundGrid;
vec2 groundTexel = 1. / (groundGrid * ${n(SLOT)});
vec2 groundD = texture2D(groundAtlas, groundUv).rg;
if (texture2D(groundAtlas, (groundCell + (clamp(vGroundAt, ${inner0}, ${inner1}) - ${origin}) / ${slotSpan}) / groundGrid).r < 0.) discard;`,
    "!vec3 finalSpecular=specularBase\\*specularColor;": "vec3 finalSpecular=specularBase*specularColor*vGroundLook.a;",
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `baseColor.rgb *= vGroundLook.rgb * (1. + (groundGrainAt - 0.5) * ${strength});
// Its slope read only near an edge, where it rounds over.
if (groundD.g >= 0. && groundD.g < groundBevel) {
  float groundDx = texture2D(groundAtlas, groundUv + vec2(groundTexel.x, 0.)).g - texture2D(groundAtlas, groundUv - vec2(groundTexel.x, 0.)).g;
  float groundDy = texture2D(groundAtlas, groundUv + vec2(0., groundTexel.y)).g - texture2D(groundAtlas, groundUv - vec2(0., groundTexel.y)).g;
  if (groundDx * groundDx + groundDy * groundDy > 0.) {
    vec3 groundOut = normalize(vec3(-(groundDx * vGroundX + groundDy * vGroundY), 0.));
    normalW = normalize(mix(normalW, normalize(normalW + groundOut), 1. - groundD.g / groundBevel));
  }
}`,
  },
};
const WGSL = {
  vertex: {
    CUSTOM_VERTEX_DEFINITIONS: `attribute groundSlot: vec2f; attribute groundLook: vec4f; varying vGroundAt: vec2f; varying vGroundSlot: vec2f; varying vGroundLook: vec4f; varying vGroundX: vec2f; varying vGroundY: vec2f;`,
    CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vGroundAt = positionUpdated.xy; vertexOutputs.vGroundSlot = vertexInputs.groundSlot; vertexOutputs.vGroundLook = vertexInputs.groundLook; vertexOutputs.vGroundX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; vertexOutputs.vGroundY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vGroundAt: vec2f; varying vGroundSlot: vec2f; varying vGroundLook: vec4f; varying vGroundX: vec2f; varying vGroundY: vec2f; var groundGrainSampler: sampler; var groundGrain: texture_2d<f32>; var groundAtlasSampler: sampler; var groundAtlas: texture_2d<f32>;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `let groundGrainAt = textureSample(groundGrain, groundGrainSampler, fragmentInputs.vPositionW.xy / ${span}).r;
let groundSlotN = floor(fragmentInputs.vGroundSlot.x + 0.5);
let groundBevel = fragmentInputs.vGroundSlot.y;
let groundCell = vec2f(groundSlotN - uniforms.groundGrid.x * floor(groundSlotN / uniforms.groundGrid.x), floor(groundSlotN / uniforms.groundGrid.x));
let groundUv = (groundCell + (fragmentInputs.vGroundAt - ${origin}) / ${slotSpan}) / uniforms.groundGrid;
let groundTexel = 1. / (uniforms.groundGrid * ${n(SLOT)});
let groundD = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv, 0.).rg;
if (textureSampleLevel(groundAtlas, groundAtlasSampler, (groundCell + (clamp(fragmentInputs.vGroundAt, vec2f(${inner0}), vec2f(${inner1})) - ${origin}) / ${slotSpan}) / uniforms.groundGrid, 0.).r < 0.) { discard; }`,
    "!var finalSpecular: vec3f=specularBase\\*specularColor;": "var finalSpecular: vec3f=specularBase*specularColor*fragmentInputs.vGroundLook.a;",
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `baseColor = vec4f(baseColor.rgb * fragmentInputs.vGroundLook.rgb * (1. + (groundGrainAt - 0.5) * ${strength}), baseColor.a);
// Its slope read only near an edge, where it rounds over.
if (groundD.g >= 0. && groundD.g < groundBevel) {
  let groundTx = vec2f(groundTexel.x, 0.);
  let groundTy = vec2f(0., groundTexel.y);
  let groundDx = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTx, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTx, 0.).g;
  let groundDy = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTy, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTy, 0.).g;
  if (groundDx * groundDx + groundDy * groundDy > 0.) {
    let groundOut = normalize(vec3f(-(groundDx * fragmentInputs.vGroundX + groundDy * fragmentInputs.vGroundY), 0.));
    normalW = normalize(mix(normalW, normalize(normalW + groundOut), 1. - groundD.g / groundBevel));
  }
}`,
  },
};

class GroundPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private atlas: Atlas,
  ) {
    super(material, "Ground", 210, new GroundDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: GroundDefines) {
    defines.GROUND = true;
  }

  getAttributes(attributes: string[]) {
    attributes.push("groundSlot", "groundLook");
  }

  getSamplers(samplers: string[]) {
    samplers.push("groundGrain", "groundAtlas");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [{ name: "groundGrid", size: 2, type: "vec2" }],
      fragment: shaderLanguage === 1 ? "uniform groundGrid: vec2f;" : "uniform vec2 groundGrid;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; setTexture(n: string, t: RawTexture): void }) {
    const texture = this.atlas.upload();
    if (!texture) return;
    ubo.updateFloat2("groundGrid", ...this.atlas.grid);
    ubo.setTexture("groundGrain", grain(this._material.getScene()));
    ubo.setTexture("groundAtlas", texture);
  }

  getClassName() {
    return "GroundPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    const code = shaderLanguage === 1 ? WGSL : GLSL;
    return shaderType === "vertex" ? code.vertex : code.fragment;
  }
}

/** The land's layers, chunk by chunk: each chunk's tiles one draw, each
 *  tile told its layer's height, colour, shine and round, the top layer's
 *  drawn first, so what lies under it is not shaded. A chunk drawn anew
 *  touches its own tiles alone, and a chunk out of view is not drawn. */
export class GroundTiles {
  private atlas: Atlas;
  private chunks = new Map<string, Mesh>();
  private material: StandardMaterial;
  private colours: Color3[] = LAYERS.map(() => Color3.White());
  /** How the land is placed in the world, every chunk's tiles with it: a
   *  turn given to it is given to all. */
  readonly frame: TransformNode;

  constructor(scene: Scene) {
    this.atlas = new Atlas(scene, SLOT);
    this.material = new StandardMaterial("ground", scene);
    this.material.specularColor = new Color3(0.45, 0.45, 0.45);
    this.material.specularPower = 64;
    // Which way the square is wound matters not, flat on the ground.
    this.material.backFaceCulling = false;
    new GroundPlugin(this.material, this.atlas);
    this.frame = new TransformNode("ground", scene);
  }

  /** A chunk's tiles, from its low corner, in place of whatever it had. */
  set(key: string, [ox, oy]: [number, number], layers: LayerTiles[]) {
    this.delete(key);
    const count = layers.reduce((sum, l) => sum + l.shapes.length, 0);
    // An empty draw is one WebGPU rejects, frame and all.
    if (!count) return;
    const [matrices, slots, looks] = [new Float32Array(count * 16), new Float32Array(count * 2), new Float32Array(count * 4)];
    let n = 0;
    for (let l = layers.length - 1; l >= 0; l--) {
      const { at, shapes } = layers[l];
      const [{ z }, { shine, bevel }, colour] = [LAYERS[l], LOOKS[l], this.colours[l]];
      for (let i = 0; i < shapes.length; i++, n++) {
        const m = n * 16;
        [matrices[m], matrices[m + 5], matrices[m + 10], matrices[m + 15]] = [1, 1, 1, 1];
        [matrices[m + 12], matrices[m + 13], matrices[m + 14]] = [ox + at[i * 2], oy + at[i * 2 + 1], z];
        [slots[n * 2], slots[n * 2 + 1]] = [this.atlas.slotOf(shapes[i], () => bake(shapes[i])), bevel];
        looks.set([colour.r, colour.g, colour.b, shine], n * 4);
      }
    }
    // A square of its own: a mesh's tiles are kept on its geometry, which
    // a clone would share.
    const mesh = new Mesh(`ground_${key}`, this.material.getScene());
    const square = new VertexData();
    Object.assign(square, { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
    square.applyToMesh(mesh);
    Object.assign(mesh, { material: this.material, parent: this.frame, isPickable: false, receiveShadows: true });
    // Its bounds the chunk's, known: worked out, they would walk every tile.
    mesh.doNotSyncBoundingInfo = true;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    mesh.thinInstanceSetBuffer("groundSlot", slots, 2, true);
    mesh.thinInstanceSetBuffer("groundLook", looks, 4, true);
    const top = Math.max(...LAYERS.map((l) => l.z));
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(ox, oy, -0.01), new Vector3(ox + CHUNK_SIZE, oy + CHUNK_SIZE, top + 0.01)));
    this.chunks.set(key, mesh);
  }

  delete(key: string) {
    this.chunks.get(key)?.dispose();
    this.chunks.delete(key);
  }

  /** Each layer's colour, bottom up, for the chunks drawn from now on. */
  paint(colours: Color3[]) {
    this.colours = colours;
  }

  /** The light's colour, as the rest of the ground glows with it. */
  light(ambient: Color3) {
    this.material.emissiveColor = ambient.scale(0.15);
  }

  dispose() {
    for (const key of [...this.chunks.keys()]) this.delete(key);
    this.frame.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}
