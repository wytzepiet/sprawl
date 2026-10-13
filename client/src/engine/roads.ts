import { markMeshRenderableDirty, setMeshAttribute, setThinInstanceCount, setThinInstances, type EngineContext, type MaterialPlugin, type Mesh, type SceneContext } from "@babylonjs/lite";
import { setTint, townMaterial, type TownMaterial } from "./material";
import { drop, meshOf, show } from "./geometry";
import type { Rgb } from "./rgb";
import { Atlas } from "./atlas";
import { grain } from "./ground";
import { bevelled, bevelPlugin, giveBevel } from "./bevel";
import { coverage, kerbDistances, kerbsOf } from "./kerbLines";
import { flatPolygons, PAVED_Z, RIM } from "./town/draw";
import { keyOf, paintOf, runsOn, shapeOf, type Surface } from "./town/surface";
import { ROAD_Z } from "./objects/roadGeometry";

/**
 * Asphalt tiles, every one the same square, its asphalt drawn on it: a
 * road's, a drive's, a yard's (`town/surface.ts`). Each shape a tile's
 * asphalt takes is baked once into a slot of one shared texture: in
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
const SLOT = 64;
const ORIGIN = -1.25;
const SPAN = 1.5;
/** How far a kerb running on into the next tile is carried past its end. */
const RUN_ON = 0.5;

/** A road shape's channels: how far inside its outline, its kerbs, and
 *  its paint (`paintOf`). */
function bake(surface: Surface): Float32Array[] {
  const flat = flatPolygons(shapeOf(surface), 0);
  const density = SLOT / SPAN;
  // How far inside the road's outline, and its kerbs.
  const outline = coverage(flat, kerbDistances(kerbsOf(flat), ORIGIN, ORIGIN, density, SLOT, SLOT), ORIGIN, ORIGIN, density, SLOT, SLOT);
  // Its kerbs where it ends, not where it runs on into the next tile;
  // and one running on into it runs on past the road's end, so it rounds
  // over straight across the seam, as the next tile's own kerb does there,
  // not round its end.
  const past = runsOn(surface);
  const kerbs = kerbsOf(flat, (a, b) => !past(a, b)).map(({ a, b, inward }) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const on = (p: number[], sign: number) => (past(p, p) ? [p[0] + sign * ux * RUN_ON, p[1] + sign * uy * RUN_ON] : p);
    return { a: on(a, -1), b: on(b, 1), inward };
  });
  // As far in as the kerb rounds over or the edge crumbles.
  const kerbed = kerbDistances(kerbs, ORIGIN, ORIGIN, density, SLOT, SLOT, Math.max(RIM, CRUMBLE) + 2 / density);
  // The paint, in the road frame: the tile's own, turned half round.
  const paint = paintOf(surface);
  const painted = new Float32Array(SLOT * SLOT);
  for (let j = 0; j < SLOT; j++) for (let i = 0; i < SLOT; i++) painted[j * SLOT + i] = paint(-(ORIGIN + (i + 0.5) / density), -(ORIGIN + (j + 0.5) / density));
  return [outline, kerbed, painted];
}

/** Asphalt: its grain over this many tiles, tilting its facing this far;
 *  and of its stones, this share each tilted its own way as far as this
 *  and polished (`townShine`), glinting as the sun moves. */
const GRAIN_SPAN = 2.5;
const BUMP = 0.15;
const GLINTS = 0.08;
const GLINT_TILT = 0.4;
/** Its edges crumble: within this far of them, in tiles, a pixel is
 *  dropped where the grain, specks and chips this many times bigger,
 *  beats how far in it is, so the edge breaks up as asphalt's does. */
const CRUMBLE = 0.035;
const CHIPS = 4;
/** Road paint's colour, before the light, and how soft its edge is, in
 *  tiles. */
const PAINT = "0.97, 0.96, 0.92";
const PAINT_SOFT = 0.005;
/** Two more random bytes of the same texel, a whole number of texels on. */
const [other1, other2] = ["0.3789, 0.1602", "0.0898, 0.5898"];

const n = (x: number) => x.toFixed(4);

// A pixel's place on its tile's road frame, and its tile's slot; then, in
// the slot, whether it is on the road and how far inside the kerbs.
function roadPlugin(engine: EngineContext, atlas: Atlas): MaterialPlugin {
  return {
    name: "Road",
    priority: 210,
    getAttributes: () => [{ name: "roadSlot", type: "f32", perInstance: true }],
    getVaryings: () => [
      { name: "vRoad", type: "vec2f" },
      { name: "vRoadSlot", type: "f32" },
    ],
    getSamplers: () => [
      { texture: "roadAtlas", sampler: "roadAtlasSampler" },
      { texture: "roadGrain", sampler: "roadGrainSampler" },
    ],
    bindTextures: (out) => out.push({ texture: atlas.upload() }, { texture: grain(engine) }),
    getUniforms: () => ({ ubo: [{ name: "roadGrid", type: "vec2<f32>" }] }),
    writeUbo: (data, offsets) => data.set(atlas.grid, offsets.get("roadGrid")! / 4),
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: `out.vRoad = position.xy; out.vRoadSlot = roadSlot;` }
        : {
            CUSTOM_FRAGMENT_MAIN_BEGIN: `let roadGrainUv = input.worldPos.xy / ${n(GRAIN_SPAN)};
let roadGrainAt = textureSample(roadGrain, roadGrainSampler, roadGrainUv).r;
let roadBump = vec2f(textureSample(roadGrain, roadGrainSampler, roadGrainUv + vec2f(${n(1 / 256)}, 0.)).r - textureSample(roadGrain, roadGrainSampler, roadGrainUv - vec2f(${n(1 / 256)}, 0.)).r, textureSample(roadGrain, roadGrainSampler, roadGrainUv + vec2f(0., ${n(1 / 256)})).r - textureSample(roadGrain, roadGrainSampler, roadGrainUv - vec2f(0., ${n(1 / 256)})).r);
let roadGlintWay = vec2f(textureSample(roadGrain, roadGrainSampler, roadGrainUv + vec2f(${other1})).r, textureSample(roadGrain, roadGrainSampler, roadGrainUv + vec2f(${other2})).r);
let roadGlinting = step(${n(1 - GLINTS)}, roadGrainAt);
let roadCrumbleBy = 0.5 * roadGrainAt + 0.5 * textureSample(roadGrain, roadGrainSampler, roadGrainUv / ${n(CHIPS)}).r;
let roadSlotN = floor(input.vRoadSlot + 0.5);
let roadUv = (vec2f(roadSlotN - material.roadGrid.x * floor(roadSlotN / material.roadGrid.x), floor(roadSlotN / material.roadGrid.x)) + (input.vRoad - ${n(ORIGIN)}) / ${n(SPAN)}) / material.roadGrid;
let roadTexel = 1. / (material.roadGrid * ${n(SLOT)});
let roadAt = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv, 0.);
let roadD = roadAt.rg;
if (roadD.r < 0.) { discard; }
if (roadD.g >= 0. && roadD.g < roadCrumbleBy * ${n(CRUMBLE)}) { discard; }`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `townShine = roadGlinting;
// The paint: white, worn a little by the grain, laid over before the tint
// is, so it is undone here.
let roadPaint = smoothstep(-${n(PAINT_SOFT)}, ${n(PAINT_SOFT)}, roadAt.b) * (0.8 + 0.2 * roadGrainAt);
baseColor = mix(baseColor, vec3f(${PAINT}) / max(material.townTint.rgb, vec3f(0.05)), roadPaint);
N = normalize(N - vec3f(roadBump * ${n(BUMP)}, 0.) + vec3f((roadGlintWay - 0.5) * 2. * ${n(GLINT_TILT)} * roadGlinting, 0.));
let roadTx = vec2f(roadTexel.x, 0.);
let roadTy = vec2f(0., roadTexel.y);
let roadDx = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv + roadTx, 0.).g - textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv - roadTx, 0.).g;
let roadDy = textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv + roadTy, 0.).g - textureSampleLevel(roadAtlas, roadAtlasSampler, roadUv - roadTy, 0.).g;
if (roadD.g >= 0. && roadD.g < ${n(RIM)} && roadDx * roadDx + roadDy * roadDy > 0.) {
  let roadOut = normalize(vec3f(-roadDx, -roadDy, 0.));
  N = normalize(mix(N, normalize(N + roadOut), 1. - roadD.g / ${n(RIM)}));
}`,
          },
  };
}

/** One kind of road's tiles: a square each, where and in which slot. */
interface Kind {
  mesh: Mesh;
  material: TownMaterial;
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

  /** `colour` paints a street's road, or a through road's. */
  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private colour: (through: boolean) => Rgb,
  ) {
    this.atlas = new Atlas(engine, SLOT, () => this.kinds.forEach((kind) => markMeshRenderableDirty(kind.mesh)), 4);
    this.kinds = [false, true].map((through): Kind => {
      // The square over the slot's span, at the road's height: through
      // roads over the streets that meet them, a street's end running on
      // under one.
      const z = ROAD_Z + PAVED_Z + (through ? 0.001 : 0);
      const [a, b] = [ORIGIN, ORIGIN + SPAN];
      // With the bevel's data, as every town material rounds creases; a
      // square has none.
      const square = bevelled({ positions: [a, a, z, b, a, z, b, b, z, a, b, z], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
      const mesh = meshOf(engine, `roads_${through ? "through" : "street"}`, square);
      giveBevel(engine, mesh, square);
      // Worn to a sheen by traffic, and the stones in it glint (`townShine`).
      const material = townMaterial([bevelPlugin(), roadPlugin(engine, this.atlas)], 0.7);
      mesh.material = material;
      mesh.receiveShadows = true;
      const [matrices, slots] = [new Float32Array(64 * 16), new Float32Array(64)];
      setThinInstances(mesh, matrices, 64);
      setMeshAttribute(engine, mesh, "roadSlot", slots);
      setThinInstanceCount(mesh, 0);
      return { mesh, material, matrices, slots, keys: [], dirty: false };
    }) as [Kind, Kind];
    this.atlas.upload();
    for (const kind of this.kinds) show(scene, kind.mesh);
  }

  /** The tile at (x, y) asphalt of this shape, in place of whatever was. */
  set(key: string, x: number, y: number, surface: Surface) {
    this.delete(key);
    const through = surface.through;
    const kind = this.kinds[+through];
    const index = kind.keys.length;
    if ((index + 1) * 16 > kind.matrices.length) {
      const capacity = Math.max(64, (index + 1) * 2);
      const [m, s] = [new Float32Array(capacity * 16), new Float32Array(capacity)];
      m.set(kind.matrices);
      s.set(kind.slots);
      [kind.matrices, kind.slots] = [m, s];
      setThinInstances(kind.mesh, kind.matrices, capacity);
    }
    kind.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + 1, y + 1, 0, 1], index * 16);
    kind.slots[index] = this.atlas.slotOf(keyOf(surface), () => bake(surface));
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

  /** Every tile drawn as it now is, in the colours of now. */
  flush() {
    this.atlas.upload();
    this.kinds.forEach((kind, through) => {
      if (!kind.dirty) return;
      kind.dirty = false;
      setTint(kind.material, this.colour(!!through));
      setMeshAttribute(this.engine, kind.mesh, "roadSlot", kind.slots);
      setThinInstanceCount(kind.mesh, kind.keys.length);
    });
  }

  dispose() {
    for (const kind of this.kinds) drop(this.scene, kind.mesh);
    this.atlas.dispose();
    this.at.clear();
  }
}
