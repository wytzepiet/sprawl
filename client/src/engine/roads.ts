import { Constants, MaterialDefines, MaterialPluginBase, Mesh, RawTexture, VertexData, type Material, type Scene, type StandardMaterial } from "@babylonjs/core";
import { bevelled, giveBevel } from "./bevel";
import { kerbDistances, kerbsOf, toHalf } from "./kerbs";
import { flatPolygons, PAVED_Z, pastSeam, RIM } from "./town/draw";
import { roadShape } from "./town/dressing";
import { ROAD_Z } from "./objects/roadGeometry";

/**
 * Road tiles, every one the same square, the road drawn on it. Each shape
 * a tile's arms make is baked once into a slot of one shared texture: in
 * its first channel how far each point lies inside the road's outline,
 * negative beyond it, so a pixel off the road is dropped; in its second,
 * how far inside its kerbs, so the road rolls over them as the paving
 * does (`kerbs.ts`), but not where it runs on into the next tile. A tile
 * says which slot is its shape, so all the streets are one draw, and all
 * the through roads another, over them.
 */

/** A slot's side in texels, over `SPAN` tiles from `ORIGIN` in a tile's
 *  road frame (x and y the other way, its middle at -0.5, -0.5): room for
 *  the widest shape, a diagonal run on past its seam, and its kerbs. */
const SLOT = 48;
const ORIGIN = -1.25;
const SPAN = 1.5;
/** How far a kerb running on into the next tile is carried past its end. */
const RUN_ON = 0.5;
/** Slots to a row of the texture; it gains rows as shapes come. */
const COLS = 16;

type Ways = [number, number, boolean][];

/** Every shape met, each in its slot. */
class Atlas {
  private slots = new Map<string, number>();
  private rows = 0;
  private data = new Uint16Array(0);
  private stale = false;
  texture: RawTexture | null = null;

  constructor(private scene: Scene) {}

  get grid(): [number, number] {
    return [COLS, this.rows];
  }

  /** The slot of the shape these arms make, baked if it is new. */
  slotOf(ways: Ways): number {
    const key = ways.map(([dc, dr, on]) => `${dc}${dr}${on ? "+" : ""}`).sort().join(",");
    const known = this.slots.get(key);
    if (known !== undefined) return known;
    const slot = this.slots.size;
    if (slot >= this.rows * COLS) this.grow();
    this.bake(ways, slot);
    this.slots.set(key, slot);
    return slot;
  }

  /** The texture, with every shape baked so far. */
  upload(): RawTexture | null {
    if (!this.stale) return this.texture;
    this.stale = false;
    const [w, h] = [COLS * SLOT, this.rows * SLOT];
    if (this.texture && this.texture.getSize().height === h) this.texture.update(this.data);
    else {
      this.texture?.dispose();
      this.texture = new RawTexture(this.data, w, h, Constants.TEXTUREFORMAT_RG, this.scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
      this.texture.wrapU = this.texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    }
    return this.texture;
  }

  private grow() {
    this.rows = Math.max(4, this.rows * 2);
    const data = new Uint16Array(COLS * SLOT * this.rows * SLOT * 2);
    data.set(this.data);
    this.data = data;
  }

  private bake(ways: Ways, slot: number) {
    const flat = flatPolygons(roadShape(ways), 0);
    const density = SLOT / SPAN;
    // Which texels the road covers, triangle by triangle; how far from its
    // outline, near it, and so which side of it each is.
    const covered = new Uint8Array(SLOT * SLOT);
    const p = flat.positions;
    for (let t = 0; t < flat.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [p[flat.indices[t + k] * 3], p[flat.indices[t + k] * 3 + 1]]);
      const side = (u: number[], v: number[], x: number, y: number) => (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
      const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - ORIGIN) * density));
      const i1 = Math.min(SLOT - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - ORIGIN) * density));
      const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - ORIGIN) * density));
      const j1 = Math.min(SLOT - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - ORIGIN) * density));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const [x, y] = [ORIGIN + (i + 0.5) / density, ORIGIN + (j + 0.5) / density];
          const [s1, s2, s3] = [side(a, b, x, y), side(b, c, x, y), side(c, a, x, y)];
          if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) covered[j * SLOT + i] = 1;
        }
      }
    }
    const outline = kerbDistances(kerbsOf(flat), ORIGIN, ORIGIN, density, SLOT, SLOT);
    // Its kerbs where it ends, not where it runs on into the next tile;
    // and one running on into it runs on past the road's end, so it rounds
    // over straight across the seam, as the next tile's own kerb does there,
    // not round its end.
    const past = pastSeam(ways);
    const kerbs = kerbsOf(flat, (a, b) => !past(a, b)).map(({ a, b, inward }) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const on = (p: number[], sign: number) => (past(p, p) ? [p[0] + sign * ux * RUN_ON, p[1] + sign * uy * RUN_ON] : p);
      return { a: on(a, -1), b: on(b, 1), inward };
    });
    const kerbed = kerbDistances(kerbs, ORIGIN, ORIGIN, density, SLOT, SLOT);
    const [col, row] = [slot % COLS, Math.floor(slot / COLS)];
    const stride = COLS * SLOT;
    for (let j = 0; j < SLOT; j++) {
      for (let i = 0; i < SLOT; i++) {
        const k = j * SLOT + i;
        const at = ((row * SLOT + j) * stride + col * SLOT + i) * 2;
        const d = Math.abs(outline[k]);
        this.data[at] = toHalf(covered[k] ? d : -d);
        this.data[at + 1] = toHalf(kerbed[k]);
      }
    }
    this.stale = true;
  }
}

class RoadDefines extends MaterialDefines {
  ROAD = false;
}

const n = (x: number) => x.toFixed(4);

// A pixel's place on its tile's road frame, and its tile's slot; then, in
// the slot, whether it is on the road and how far inside the kerbs.
const GLSL = {
  vertex: {
    CUSTOM_VERTEX_DEFINITIONS: `attribute float roadSlot; varying vec2 vRoad; varying float vRoadSlot;`,
    CUSTOM_VERTEX_MAIN_END: `vRoad = positionUpdated.xy; vRoadSlot = roadSlot;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vRoad; varying float vRoadSlot; uniform sampler2D roadAtlas;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `float roadSlotN = floor(vRoadSlot + 0.5);
vec2 roadUv = (vec2(mod(roadSlotN, ${n(COLS)}), floor(roadSlotN / ${n(COLS)})) + (vRoad - ${n(ORIGIN)}) / ${n(SPAN)}) / roadGrid;
vec2 roadTexel = 1. / (roadGrid * ${n(SLOT)});
vec2 roadD = texture2D(roadAtlas, roadUv).rg;
if (roadD.r < 0.) discard;`,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `float roadDx = texture2D(roadAtlas, roadUv + vec2(roadTexel.x, 0.)).g - texture2D(roadAtlas, roadUv - vec2(roadTexel.x, 0.)).g;
float roadDy = texture2D(roadAtlas, roadUv + vec2(0., roadTexel.y)).g - texture2D(roadAtlas, roadUv - vec2(0., roadTexel.y)).g;
if (roadD.g >= 0. && roadD.g < ${n(RIM)} && roadDx * roadDx + roadDy * roadDy > 0.) {
  vec3 roadOut = normalize(vec3(-roadDx, -roadDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + roadOut), 1. - roadD.g / ${n(RIM)}));
}`,
  },
};
const WGSL = {
  vertex: {
    CUSTOM_VERTEX_DEFINITIONS: `attribute roadSlot: f32; varying vRoad: vec2f; varying vRoadSlot: f32;`,
    CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vRoad = positionUpdated.xy; vertexOutputs.vRoadSlot = vertexInputs.roadSlot;`,
  },
  fragment: {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vRoad: vec2f; varying vRoadSlot: f32; var roadAtlasSampler: sampler; var roadAtlas: texture_2d<f32>;`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `let roadSlotN = floor(fragmentInputs.vRoadSlot + 0.5);
let roadUv = (vec2f(roadSlotN - ${n(COLS)} * floor(roadSlotN / ${n(COLS)}), floor(roadSlotN / ${n(COLS)})) + (fragmentInputs.vRoad - ${n(ORIGIN)}) / ${n(SPAN)}) / uniforms.roadGrid;
let roadTexel = 1. / (uniforms.roadGrid * ${n(SLOT)});
let roadD = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv, 0.).rg;
if (roadD.r < 0.) { discard; }`,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let roadTx = vec2f(roadTexel.x, 0.);
let roadTy = vec2f(0., roadTexel.y);
let roadDx = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv + roadTx, 0.).g - textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv - roadTx, 0.).g;
let roadDy = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv + roadTy, 0.).g - textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv - roadTy, 0.).g;
if (roadD.g >= 0. && roadD.g < ${n(RIM)} && roadDx * roadDx + roadDy * roadDy > 0.) {
  let roadOut = normalize(vec3f(-roadDx, -roadDy, 0.));
  normalW = normalize(mix(normalW, normalize(normalW + roadOut), 1. - roadD.g / ${n(RIM)}));
}`,
  },
};

class RoadPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private atlas: Atlas,
  ) {
    super(material, "Road", 210, new RoadDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: RoadDefines) {
    defines.ROAD = true;
  }

  getAttributes(attributes: string[]) {
    attributes.push("roadSlot");
  }

  getSamplers(samplers: string[]) {
    samplers.push("roadAtlas");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [{ name: "roadGrid", size: 2, type: "vec2" }],
      fragment: shaderLanguage === 1 ? "uniform roadGrid: vec2f;" : "uniform vec2 roadGrid;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; setTexture(n: string, t: RawTexture): void }) {
    const texture = this.atlas.upload();
    if (!texture) return;
    ubo.updateFloat2("roadGrid", ...this.atlas.grid);
    ubo.setTexture("roadAtlas", texture);
  }

  getClassName() {
    return "RoadPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    const code = shaderLanguage === 1 ? WGSL : GLSL;
    return shaderType === "vertex" ? code.vertex : code.fragment;
  }
}

/** One kind of road's tiles: a square each, where and in which slot. */
interface Kind {
  mesh: Mesh;
  matrices: Float32Array;
  slots: Float32Array;
  keys: string[];
  dirty: boolean;
}

/** The road tiles, by tile, each a street or a through road. */
export class RoadTiles {
  private atlas: Atlas;
  private kinds: [Kind, Kind];
  private at = new Map<string, { through: boolean; index: number }>();

  /** `material` paints a street's road, or a through road's. */
  constructor(
    private scene: Scene,
    private material: (through: boolean) => StandardMaterial,
  ) {
    this.atlas = new Atlas(scene);
    this.kinds = [false, true].map((through): Kind => {
      const mesh = new Mesh(`roads_${through ? "through" : "street"}`, scene);
      // The square over the slot's span, at the road's height: through
      // roads over the streets that meet them, a street's end running on
      // under one.
      const z = ROAD_Z + PAVED_Z + (through ? 0.001 : 0);
      const [a, b] = [ORIGIN, ORIGIN + SPAN];
      // With the bevel's data, as every town material rounds creases; a
      // square has none.
      const square = bevelled({ positions: [a, a, z, b, a, z, b, b, z, a, b, z], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3] });
      const data = new VertexData();
      Object.assign(data, { positions: square.positions, normals: square.normals, indices: square.indices });
      data.applyToMesh(mesh);
      giveBevel(mesh, square);
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      // Roads run over the whole world: culled square by square they
      // cannot be, and testing their bounds would walk every tile.
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(false);
      return { mesh, matrices: new Float32Array(0), slots: new Float32Array(0), keys: [], dirty: false };
    }) as [Kind, Kind];
  }

  /** The tile at (x, y) a road of these arms, in place of whatever was. */
  set(key: string, x: number, y: number, through: boolean, ways: Ways) {
    this.delete(key);
    const kind = this.kinds[+through];
    const index = kind.keys.length;
    if ((index + 1) * 16 > kind.matrices.length) {
      const capacity = Math.max(64, (index + 1) * 2);
      const [m, s] = [new Float32Array(capacity * 16), new Float32Array(capacity)];
      m.set(kind.matrices);
      s.set(kind.slots);
      [kind.matrices, kind.slots] = [m, s];
    }
    kind.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + 1, y + 1, 0, 1], index * 16);
    kind.slots[index] = this.atlas.slotOf(ways);
    kind.keys.push(key);
    kind.dirty = true;
    this.at.set(key, { through, index });
  }

  /** Every tile with a road. */
  tiles() {
    return this.at.keys();
  }

  /** No road at this tile. The last of its kind takes its place. */
  delete(key: string) {
    const was = this.at.get(key);
    if (!was) return;
    this.at.delete(key);
    const kind = this.kinds[+was.through];
    const last = kind.keys.length - 1;
    if (was.index !== last) {
      kind.matrices.copyWithin(was.index * 16, last * 16, last * 16 + 16);
      kind.slots[was.index] = kind.slots[last];
      kind.keys[was.index] = kind.keys[last];
      this.at.get(kind.keys[last])!.index = was.index;
    }
    kind.keys.pop();
    kind.dirty = true;
  }

  /** Every tile drawn as it now is. */
  flush() {
    this.kinds.forEach((kind, through) => {
      if (!kind.dirty) return;
      kind.dirty = false;
      const count = kind.keys.length;
      const material = (kind.mesh.material = this.material(!!through));
      if (!material.pluginManager?.getPlugin("Road")) {
        new RoadPlugin(material, this.atlas);
        // Which way the square is wound matters not, flat on the ground.
        material.backFaceCulling = false;
      }
      // An empty draw is one WebGPU rejects, frame and all.
      kind.mesh.setEnabled(count > 0);
      if (!count) return;
      kind.mesh.thinInstanceSetBuffer("matrix", kind.matrices.slice(0, count * 16), 16, true);
      kind.mesh.thinInstanceSetBuffer("roadSlot", kind.slots.slice(0, count), 1, true);
    });
  }

  dispose() {
    for (const kind of this.kinds) kind.mesh.dispose();
    this.atlas.texture?.dispose();
    this.at.clear();
  }
}
