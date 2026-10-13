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
import type { Lift } from "./decks";
import type { MeshGeometry } from "./geometry";

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
// the slot, whether it is on the road and how far inside the kerbs. A deck's
// tile is lifted (`decks.ts`'s `Lift`): up to its height, and a slope's
// eased up across it, its facing tilted with it.
function roadPlugin(engine: EngineContext, atlas: Atlas, lifted: boolean): MaterialPlugin {
  return {
    name: "Road",
    priority: 210,
    getAttributes: () => [
      { name: "roadSlot", type: "f32", perInstance: true },
      ...(lifted
        ? [
            { name: "roadLift", type: "vec4<f32>" as const, perInstance: true, buffer: "roadLifts" },
            { name: "roadClimb", type: "vec2<f32>" as const, perInstance: true, buffer: "roadLifts" },
          ]
        : []),
    ],
    getVaryings: () => [
      { name: "vRoad", type: "vec2f" },
      { name: "vRoadSlot", type: "f32" },
      { name: "vRoadTilt", type: "vec2f" },
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
        ? {
            // Lifted after the world is placed, where the thin instance's
            // own matrix has been applied.
            CUSTOM_VERTEX_MAIN_END: `out.vRoad = position.xy; out.vRoadSlot = roadSlot;${
              lifted
                ? `
let roadU = clamp(dot(position.xy + vec2f(0.5), roadClimb) + 0.5, 0., 1.);
out.worldPos.z = out.worldPos.z + roadLift.x + roadU * (roadLift.y + roadU * (roadLift.z + roadU * roadLift.w));
out.clipPos = scene.viewProjection * vec4f(out.worldPos, 1.);
out.vRoadTilt = roadClimb * (roadLift.y + roadU * (2. * roadLift.z + 3. * roadU * roadLift.w));`
                : " out.vRoadTilt = vec2f(0.);"
            }`,
          }
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
N = normalize(N - vec3f(roadBump * ${n(BUMP)} + input.vRoadTilt, 0.) + vec3f((roadGlintWay - 0.5) * 2. * ${n(GLINT_TILT)} * roadGlinting, 0.));
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

/** One kind of road's tiles: a square each, where and in which slot, and
 *  a deck's how it is lifted. */
interface Kind {
  mesh: Mesh;
  material: TownMaterial;
  matrices: Float32Array;
  slots: Float32Array;
  lifts: Float32Array | null;
  keys: string[];
  dirty: boolean;
}

/** A square over a slot's span, at a height, cut `n` by `n`: a deck's
 *  bends with its slope. */
function square(z: number, n: number): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  const at = (k: number) => ORIGIN + (SPAN * k) / n;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) g.positions.push(at(i), at(j), z), g.normals.push(0, 0, 1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = [j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i];
      g.indices.push(a, c, b, a, d, c);
    }
  }
  return g;
}
/** A deck's lift, in floats a tile (`decks.ts`'s `Lift`). */
const LIFT = 6;
/** How finely a deck's square is cut. */
const DECK_CUTS = 12;

/** The road tiles, by tile: a street or a through road, on the ground or
 *  lifted onto a deck. */
export class RoadTiles {
  private atlas: Atlas;
  private kinds: Kind[];
  private at = new Map<string, { kind: number; index: number }>();

  /** `colour` paints a street's road, or a through road's. */
  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private colour: (through: boolean) => Rgb,
  ) {
    this.atlas = new Atlas(engine, SLOT, () => this.kinds.forEach((kind) => markMeshRenderableDirty(kind.mesh)), 4);
    // Street, through, deck street, deck through (`kindOf`).
    this.kinds = [0, 1, 2, 3].map((k): Kind => {
      const [through, deck] = [k % 2 === 1, k >= 2];
      // The square over the slot's span, at the road's height: through
      // roads over the streets that meet them, a street's end running on
      // under one. With the bevel's data, as every town material rounds
      // creases; a square has none.
      const z = ROAD_Z + PAVED_Z + (through ? 0.001 : 0);
      const geo = bevelled(square(z, deck ? DECK_CUTS : 1));
      const mesh = meshOf(engine, `roads_${deck ? "deck_" : ""}${through ? "through" : "street"}`, geo);
      giveBevel(engine, mesh, geo);
      // Worn to a sheen by traffic, and the stones in it glint (`townShine`).
      const material = townMaterial([bevelPlugin(), roadPlugin(engine, this.atlas, deck)], 0.7);
      mesh.material = material;
      mesh.receiveShadows = true;
      const [matrices, slots, lifts] = [new Float32Array(64 * 16), new Float32Array(64), deck ? new Float32Array(64 * LIFT) : null];
      setThinInstances(mesh, matrices, 64);
      setMeshAttribute(engine, mesh, "roadSlot", slots);
      if (lifts) setMeshAttribute(engine, mesh, "roadLifts", lifts);
      setThinInstanceCount(mesh, 0);
      return { mesh, material, matrices, slots, lifts, keys: [], dirty: false };
    });
    this.atlas.upload();
    for (const kind of this.kinds) show(scene, kind.mesh);
  }

  /** The tile at (x, y) asphalt of this shape, in place of whatever was;
   *  a deck's lifted so (`decks.ts`). */
  set(key: string, x: number, y: number, surface: Surface, lift?: Lift) {
    this.delete(key);
    const k = +surface.through + (lift ? 2 : 0);
    const kind = this.kinds[k];
    const index = kind.keys.length;
    if ((index + 1) * 16 > kind.matrices.length) {
      const capacity = Math.max(64, (index + 1) * 2);
      const [m, s] = [new Float32Array(capacity * 16), new Float32Array(capacity)];
      m.set(kind.matrices);
      s.set(kind.slots);
      [kind.matrices, kind.slots] = [m, s];
      if (kind.lifts) {
        const l = new Float32Array(capacity * LIFT);
        l.set(kind.lifts);
        kind.lifts = l;
      }
      setThinInstances(kind.mesh, kind.matrices, capacity);
    }
    kind.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + 1, y + 1, 0, 1], index * 16);
    kind.slots[index] = this.atlas.slotOf(keyOf(surface), () => bake(surface));
    if (kind.lifts && lift) kind.lifts.set(lift, index * LIFT);
    kind.keys.push(key);
    kind.dirty = true;
    this.at.set(key, { kind: k, index });
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
    const kind = this.kinds[was.kind];
    const last = kind.keys.length - 1;
    if (was.index !== last) {
      kind.matrices.copyWithin(was.index * 16, last * 16, last * 16 + 16);
      kind.slots[was.index] = kind.slots[last];
      kind.lifts?.copyWithin(was.index * LIFT, last * LIFT, last * LIFT + LIFT);
      kind.keys[was.index] = kind.keys[last];
      this.at.get(kind.keys[last])!.index = was.index;
    }
    kind.keys.pop();
    kind.dirty = true;
  }

  /** Every tile drawn as it now is, in the colours of now. */
  flush() {
    this.atlas.upload();
    this.kinds.forEach((kind, k) => {
      if (!kind.dirty) return;
      kind.dirty = false;
      setTint(kind.material, this.colour(k % 2 === 1));
      setMeshAttribute(this.engine, kind.mesh, "roadSlot", kind.slots);
      if (kind.lifts) setMeshAttribute(this.engine, kind.mesh, "roadLifts", kind.lifts);
      setThinInstanceCount(kind.mesh, kind.keys.length);
    });
  }

  dispose() {
    for (const kind of this.kinds) drop(this.scene, kind.mesh);
    this.atlas.dispose();
    this.at.clear();
  }
}
