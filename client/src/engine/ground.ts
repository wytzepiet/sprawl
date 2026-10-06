import { Color3, Constants, MaterialDefines, MaterialPluginBase, Mesh, RawTexture, StandardMaterial, VertexData, type Material, type Scene } from "@babylonjs/core";
import { Atlas } from "./atlas";
import { FAR, kerbDistances } from "./kerbs";
import { LAYERS, nearLines, outlineOf, parseShape, shapeGeometry, type LayerTiles } from "./objects/terrainGeometry";
import { fillTriangles } from "./raster";

/**
 * The land, layer on layer (`LAYERS`): the sand, the grass on it, the wood
 * floor, the rock. Every tile of a layer is the same square, its share of
 * the layer drawn on it, as road tiles are (`roads.ts`): each shape a
 * tile's share can take is baked once into a slot of one shared texture,
 * in its first channel how far each point lies inside the share's
 * outline, negative beyond it, so a pixel off it is dropped; in its
 * second, how far inside the edges where the layer rounds over onto ground
 * lying lower, so it turns its facing out as it nears them. Each layer is
 * one draw for the whole world.
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
 *  grass and wood are matte, the grain their texture. And whether it
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
    CUSTOM_VERTEX_DEFINITIONS: `attribute float groundSlot; varying vec2 vGroundAt; varying float vGroundSlot; varying vec2 vGroundX; varying vec2 vGroundY;`,
    CUSTOM_VERTEX_MAIN_END: `vGroundAt = positionUpdated.xy; vGroundSlot = groundSlot; vGroundX = (finalWorld * vec4(1., 0., 0., 0.)).xy; vGroundY = (finalWorld * vec4(0., 1., 0., 0.)).xy;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vGroundAt; varying float vGroundSlot; varying vec2 vGroundX; varying vec2 vGroundY; uniform sampler2D groundGrain; uniform sampler2D groundAtlas;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `float groundGrainAt = texture2D(groundGrain, vPositionW.xy / ${span}).r;
float groundSlotN = floor(vGroundSlot + 0.5);
vec2 groundCell = vec2(mod(groundSlotN, groundGrid.x), floor(groundSlotN / groundGrid.x));
vec2 groundUv = (groundCell + (vGroundAt - ${origin}) / ${slotSpan}) / groundGrid;
vec2 groundTexel = 1. / (groundGrid * ${n(SLOT)});
vec2 groundD = texture2D(groundAtlas, groundUv).rg;
if (texture2D(groundAtlas, (groundCell + (clamp(vGroundAt, ${inner0}, ${inner1}) - ${origin}) / ${slotSpan}) / groundGrid).r < 0.) discard;`,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `baseColor.rgb *= 1. + (groundGrainAt - 0.5) * ${strength};
float groundDx = texture2D(groundAtlas, groundUv + vec2(groundTexel.x, 0.)).g - texture2D(groundAtlas, groundUv - vec2(groundTexel.x, 0.)).g;
float groundDy = texture2D(groundAtlas, groundUv + vec2(0., groundTexel.y)).g - texture2D(groundAtlas, groundUv - vec2(0., groundTexel.y)).g;
if (groundD.g >= 0. && groundD.g < groundBevel && groundDx * groundDx + groundDy * groundDy > 0.) {
  vec3 groundOut = normalize(vec3(-(groundDx * vGroundX + groundDy * vGroundY), 0.));
  normalW = normalize(mix(normalW, normalize(normalW + groundOut), 1. - groundD.g / groundBevel));
}`,
  },
};
const WGSL = {
  vertex: {
    CUSTOM_VERTEX_DEFINITIONS: `attribute groundSlot: f32; varying vGroundAt: vec2f; varying vGroundSlot: f32; varying vGroundX: vec2f; varying vGroundY: vec2f;`,
    CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vGroundAt = positionUpdated.xy; vertexOutputs.vGroundSlot = vertexInputs.groundSlot; vertexOutputs.vGroundX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; vertexOutputs.vGroundY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vGroundAt: vec2f; varying vGroundSlot: f32; varying vGroundX: vec2f; varying vGroundY: vec2f; var groundGrainSampler: sampler; var groundGrain: texture_2d<f32>; var groundAtlasSampler: sampler; var groundAtlas: texture_2d<f32>;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `let groundGrainAt = textureSample(groundGrain, groundGrainSampler, fragmentInputs.vPositionW.xy / ${span}).r;
let groundSlotN = floor(fragmentInputs.vGroundSlot + 0.5);
let groundCell = vec2f(groundSlotN - uniforms.groundGrid.x * floor(groundSlotN / uniforms.groundGrid.x), floor(groundSlotN / uniforms.groundGrid.x));
let groundUv = (groundCell + (fragmentInputs.vGroundAt - ${origin}) / ${slotSpan}) / uniforms.groundGrid;
let groundTexel = 1. / (uniforms.groundGrid * ${n(SLOT)});
let groundD = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv, 0.).rg;
if (textureSampleLevel(groundAtlas, groundAtlasSampler, (groundCell + (clamp(fragmentInputs.vGroundAt, vec2f(${inner0}), vec2f(${inner1})) - ${origin}) / ${slotSpan}) / uniforms.groundGrid, 0.).r < 0.) { discard; }`,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `baseColor = vec4f(baseColor.rgb * (1. + (groundGrainAt - 0.5) * ${strength}), baseColor.a);
let groundTx = vec2f(groundTexel.x, 0.);
let groundTy = vec2f(0., groundTexel.y);
let groundDx = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTx, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTx, 0.).g;
let groundDy = textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv + groundTy, 0.).g - textureSampleLevel(groundAtlas, groundAtlasSampler, groundUv - groundTy, 0.).g;
if (groundD.g >= 0. && groundD.g < uniforms.groundBevel && groundDx * groundDx + groundDy * groundDy > 0.) {
  let groundOut = normalize(vec3f(-(groundDx * fragmentInputs.vGroundX + groundDy * fragmentInputs.vGroundY), 0.));
  normalW = normalize(mix(normalW, normalize(normalW + groundOut), 1. - groundD.g / uniforms.groundBevel));
}`,
  },
};

class GroundPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private atlas: Atlas,
    private bevel: number,
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
    attributes.push("groundSlot");
  }

  getSamplers(samplers: string[]) {
    samplers.push("groundGrain", "groundAtlas");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "groundGrid", size: 2, type: "vec2" },
        { name: "groundBevel", size: 1, type: "float" },
      ],
      fragment: shaderLanguage === 1 ? "uniform groundGrid: vec2f; uniform groundBevel: f32;" : "uniform vec2 groundGrid; uniform float groundBevel;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; updateFloat(n: string, v: number): void; setTexture(n: string, t: RawTexture): void }) {
    const texture = this.atlas.upload();
    if (!texture) return;
    ubo.updateFloat2("groundGrid", ...this.atlas.grid);
    ubo.updateFloat("groundBevel", this.bevel);
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

/** One chunk's tiles of each layer: where, and in which slot. */
interface Chunk {
  origin: [number, number];
  layers: { at: Float32Array; slots: Float32Array }[];
}

/** The land's layers, chunk by chunk, each layer one draw. */
export class GroundTiles {
  private atlas: Atlas;
  private chunks = new Map<string, Chunk>();
  private dirty = false;
  private materials: StandardMaterial[];
  readonly meshes: Mesh[];

  constructor(scene: Scene) {
    this.atlas = new Atlas(scene, SLOT);
    this.materials = LOOKS.map(({ shine, bevel }, l) => {
      const mat = new StandardMaterial(`ground_${l}`, scene);
      mat.specularColor = new Color3(0.45, 0.45, 0.45).scale(shine);
      mat.specularPower = 64;
      // Which way the square is wound matters not, flat on the ground.
      mat.backFaceCulling = false;
      new GroundPlugin(mat, this.atlas, bevel);
      return mat;
    });
    this.meshes = LAYERS.map(({ z }, l) => {
      const mesh = new Mesh(`ground_${l}`, scene);
      const square = new VertexData();
      Object.assign(square, { positions: [0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
      square.applyToMesh(mesh);
      mesh.material = this.materials[l];
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      // The land runs over the whole world: culled square by square it
      // cannot be, and testing its bounds would walk every tile.
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(false);
      return mesh;
    });
  }

  /** A chunk's tiles, from its low corner, in place of whatever it had. */
  set(key: string, origin: [number, number], layers: LayerTiles[]) {
    const slotOf = (shape: string) => this.atlas.slotOf(shape, () => bake(shape));
    this.chunks.set(key, { origin, layers: layers.map(({ at, shapes }) => ({ at, slots: Float32Array.from(shapes, slotOf) })) });
    this.dirty = true;
  }

  delete(key: string) {
    if (this.chunks.delete(key)) this.dirty = true;
  }

  /** Every tile drawn as it now is. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const chunks = [...this.chunks.values()];
    this.meshes.forEach((mesh, l) => {
      const count = chunks.reduce((sum, c) => sum + c.layers[l].slots.length, 0);
      // An empty draw is one WebGPU rejects, frame and all.
      mesh.setEnabled(count > 0);
      if (!count) return;
      const [matrices, slots] = [new Float32Array(count * 16), new Float32Array(count)];
      let at = 0;
      for (const { origin, layers } of chunks) {
        const layer = layers[l];
        for (let i = 0; i < layer.slots.length; i++, at++) {
          matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0] + layer.at[i * 2], origin[1] + layer.at[i * 2 + 1], 0, 1], at * 16);
          slots[at] = layer.slots[i];
        }
      }
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
      mesh.thinInstanceSetBuffer("groundSlot", slots, 1, true);
    });
  }

  /** Each layer's colour, bottom up. */
  paint(colours: Color3[]) {
    this.materials.forEach((mat, l) => (mat.diffuseColor = colours[l]));
  }

  /** The light's colour, as the rest of the ground glows with it. */
  light(ambient: Color3) {
    for (const mat of this.materials) mat.emissiveColor = ambient.scale(0.15);
  }

  dispose() {
    for (const mesh of this.meshes) mesh.dispose();
    for (const mat of this.materials) mat.dispose();
    this.atlas.dispose();
    this.chunks.clear();
  }
}
