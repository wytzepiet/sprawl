import { markMaterialUboDirty, setMeshAttribute, setThinInstances, updateMeshPositions, type DirectionalLight, type EngineContext as Engine, type MaterialPlugin, type Mesh, type SceneContext } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import type { Casters } from "../DayNightCycle";
import { drop, meshOf, show } from "../geometry";
import { grain } from "../ground";
import { CAST_ONLY, townMaterial, type TownMaterial } from "../material";
import type { Rgb } from "../rgb";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { GridCoord } from "../../generated/GridCoord";
import type { Job } from "../../generated/Job";
import type { Run } from "../../generated/Run";
import type { Tile } from "../../generated/Tile";
import { drawnPath, type DrawnPath, type P } from "./drawnPath";

/**
 * A farm's field, as it is seen from the air: the strips its tractor laid,
 * a pass a tile wide along the path it drove, curves and all, as it drives
 * it (`running` in `motion.ts`), each later pass over the earlier where
 * they meet. Laid only where the job was done, as the server does it: a
 * tile on the visit it is worked, the lands on the first pass over them,
 * the headland on its own pass round, after the lands when ploughing,
 * before them otherwise (`fields.rs`); never on a turn or the way home.
 * So the headland ring runs on unbroken round its corners on the
 * tractor's own arc, and the lands' passes stop where they turned.
 *
 * Across each strip a height (`fieldHeight`), by stage: furrow slices
 * turned up in ridges; a drill's rows, the wheat coming up along them a
 * tuft of thin blades at a time and closing over the rows, green, then
 * gold, its wheel tracks left open; the stubble after the combine, bare ground
 * again with a stalk where most plants stood. Each stage one clean
 * colour on a dark grey earth, as the town's are: its texture is all
 * light, the ridges and plants tilting its facing and casting their
 * shade into the furrows and tracks beside them, as a low sun shows a
 * field from the air. The strip's edge on the field's border is ragged,
 * a margin of grass between field and hedge.
 *
 * Between runs the field is the last run's strips (the farm's `ruts`) in
 * the look it left. On a run (`running`), the run's strips are laid over
 * them in the look the job leaves, as far as the tractor has got. A
 * standing crop stands: a sheet of the land's tiles at its height, cast
 * and never seen, throws its shadow onto the grass beside it and onto the
 * stubble behind the harvest; the strips lie at the top of it.
 */

/** What a field shows: a stage of the cycle, and how far grown. */
export type Look = { stage: "Grass" | "Ploughed" | "Sown" | "Cut"; growth: number };

/** The field lies a little over the land, the crop up to this high. */
export const FIELD_Z = 0.008;
const CROP_H = 0.08;
/** How long a sown crop takes to ripen, as the server has it. */
export const RIPEN = 600_000;

/** The runs out now, by farm: the tractor's (`CarObject`), for its
 *  farm's field to lay. */
export const running = new Map<number, Run>();

/** What the field shows between runs: the stage the last run left it in,
 *  which is the stage of the tiles longest unchanged; a sown field grows
 *  as one, from the last tile sown, ripe when the server counts it ripe. */
export function lookOf(land: Tile[]): Look {
  const oldest = land.reduce<Tile | null>((a, t) => (a === null || t.since < a.since ? t : a), null);
  const stage = oldest?.stage ?? "Grass";
  if (stage !== "Sown") return { stage, growth: 0 };
  const since = Math.max(...land.filter((t) => t.stage === "Sown").map((t) => t.since));
  return { stage, growth: Math.min(1, Math.max(0, (simNow() - since) / RIPEN)) };
}

/** What a job leaves behind the tractor, and what job left a look. */
const leaves = (job: Job, before: Look): Look =>
  job === "Plough" ? { stage: "Ploughed", growth: 0 } : job === "Seed" ? { stage: "Sown", growth: 0 } : job === "Harvest" ? { stage: "Cut", growth: 0 } : before;
const JOB_OF: Record<Look["stage"], Job | null> = { Grass: null, Ploughed: "Plough", Sown: "Seed", Cut: "Harvest" };

const STAGES = ["Grass", "Ploughed", "Sown", "Cut"];
const heightOf = (l: Look) => (l.stage === "Sown" ? CROP_H * Math.min(1, Math.max(0, (l.growth - 0.1) / 0.6)) : 0);
const vec = (l: Look) => [STAGES.indexOf(l.stage), l.growth, 0, 0];
const key = (t: GridCoord) => `${t.x},${t.y}`;

/** Which step of a path works each tile of the land: the first over it,
 *  but for the headland when ploughing, worked on the pass round after
 *  the last land tile is first reached. */
function workedAt(path: GridCoord[], land: Set<string>, head: (t: GridCoord) => boolean, job: Job): Map<string, number> {
  const firsts = new Map<string, number>();
  path.forEach((t, k) => { if (land.has(key(t)) && !firsts.has(key(t))) firsts.set(key(t), k); });
  const ring = job === "Plough" ? Math.max(0, ...path.flatMap((t, k) => (firsts.get(key(t)) === k && !head(t) ? [k] : []))) : 0;
  const worked = new Map<string, number>();
  path.forEach((t, k) => { if (land.has(key(t)) && !worked.has(key(t)) && !(head(t) && k < ring)) worked.set(key(t), k); });
  return worked;
}

/** What a strip's material reads: the look it is in, and how far along
 *  the path it is laid. */
type Paint = { look: number[]; reach: number };

/**
 * A run's strips: a tile wide along the drawn path, a piece for each step
 * that works its tile, from halfway back to the step before to halfway on
 * to the next. Where the work goes on through a turn the piece follows
 * the tractor round it; where the implement comes up or goes down — into
 * a row off the headland, out of one onto it — the piece runs straight
 * across the tile, the way the work went, and does not curl after the
 * tractor. Each vertex knows where across the strip it is, how far along,
 * which way across is, and whether either edge is the field's border.
 */
class Strips {
  readonly mesh: Mesh;
  readonly drawn: DrawnPath;
  readonly paint: Paint;
  private positions: Float32Array;
  private z = -1;

  constructor(ctx: EngineContext, name: string, nodes: P[], drawn: DrawnPath, works: (k: number) => boolean, land: Set<string>, material: (paint: Paint) => TownMaterial, look: Look) {
    this.drawn = drawn;
    this.paint = { look: vec(look), reach: 1e9 };
    const { points, distances, atNode } = drawn;
    const last = nodes.length - 1;
    const bound = (k: number) => (atNode[k - 1] + atNode[k]) / 2;
    // The drawn path between two distances along it, ends included.
    const along = (d0: number, d1: number): { p: P; d: number }[] => {
      const at = (d: number) => {
        const i = Math.max(0, distances.findIndex((x) => x >= d) - 1);
        const t = (d - distances[i]) / (distances[i + 1] - distances[i] || 1);
        return { p: { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }, d };
      };
      const run = [at(d0), ...points.flatMap((p, i) => (distances[i] > d0 && distances[i] < d1 ? [{ p, d: distances[i] }] : [])), at(d1)];
      // A hair over at each end, to meet the piece beside it.
      const on = (a: { p: P; d: number }, b: { p: P; d: number }) => {
        const l = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) || 1;
        return { p: { x: b.p.x + ((b.p.x - a.p.x) / l) * 0.03, y: b.p.y + ((b.p.y - a.p.y) / l) * 0.03 }, d: b.d + Math.sign(b.d - a.d) * 0.03 };
      };
      return [on(run[1], run[0]), ...run, on(run[run.length - 2], run[run.length - 1])];
    };
    const off = (x: number, y: number) => !land.has(`${Math.floor(x)},${Math.floor(y)}`);
    const pieces: { at: P; samples: { p: P; d: number }[] }[] = [];
    for (let k = 0; k <= last; k++) {
      if (!works(k)) continue;
      const [before, after] = [k > 0 && works(k - 1), k < last && works(k + 1)];
      // A tile across the way from a to b, and a hair over, to meet the
      // piece beside it.
      const straight = (a: P, b: P) => {
        const stretch = 0.5 + 0.03 / Math.hypot(b.x - a.x, b.y - a.y);
        const [hx, hy] = [(b.x - a.x) * stretch, (b.y - a.y) * stretch];
        const [c, half] = [nodes[k], Math.hypot(hx, hy)];
        pieces.push({ at: c, samples: [{ p: { x: c.x - hx, y: c.y - hy }, d: atNode[k] - half }, { p: { x: c.x + hx, y: c.y + hy }, d: atNode[k] + half }] });
      };
      if (before && after) {
        // A turn with field on its outside, as round the farmstead, is
        // worked square underneath, so its corner is not left bare.
        const [a, c, b] = [nodes[k - 1], nodes[k], nodes[k + 1]];
        const ahead = { x: 2 * c.x - a.x, y: 2 * c.y - a.y };
        const behind = { x: 2 * c.x - b.x, y: 2 * c.y - b.y };
        if ((c.x - a.x) * (b.y - c.y) - (c.y - a.y) * (b.x - c.x) !== 0 && !off(ahead.x, ahead.y) && !off(behind.x, behind.y)) straight(a, c);
        pieces.push({ at: nodes[k], samples: along(bound(k), bound(k + 1)) });
        continue;
      }
      if (after || k === 0) straight(nodes[k], nodes[k + 1]);
      else straight(nodes[k - 1], nodes[k]);
    }
    const count = pieces.reduce((n, piece) => n + piece.samples.length, 0);
    this.positions = new Float32Array(count * 6);
    const data = new Float32Array(count * 16);
    const indices: number[] = [];
    let v = 0;
    for (const { at, samples } of pieces) {
      samples.forEach(({ p, d }, i) => {
        const [a, b] = [samples[Math.max(0, i - 1)].p, samples[Math.min(samples.length - 1, i + 1)].p];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
        // Which side is the border: the tile beside the piece's own, that way.
        const edges = [off(at.x - n.x, at.y - n.y) ? 1 : 0, off(at.x + n.x, at.y + n.y) ? 1 : 0];
        [-0.5, 0.5].forEach((a, s) => {
          this.positions.set([p.x + n.x * a * WIDE, p.y + n.y * a * WIDE, 0], (v + s) * 3);
          data.set([a, d, n.x, n.y, edges[0], edges[1], 0, 0], (v + s) * 8);
        });
        if (i > 0) indices.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
        v += 2;
      });
    }
    this.mesh = meshOf(ctx.engine, name, { positions: this.positions, normals: Array.from({ length: count * 2 }, () => [0, 0, 1]).flat(), indices });
    this.mesh.material = material(this.paint);
    this.mesh.receiveShadows = true;
    setMeshAttribute(ctx.engine, this.mesh, "strip", data);
    show(ctx.scene, this.mesh);
  }

  /** The strips at this height. */
  lift(engine: Engine, z: number) {
    if (Math.abs(z - this.z) < 0.001) return;
    this.z = z;
    for (let i = 2; i < this.positions.length; i += 3) this.positions[i] = z;
    updateMeshPositions(engine, this.mesh, this.positions);
  }
}

/** A strip as wide as a pass, a hair over, so passes side by side meet
 *  with no seam between. */
const WIDE = 1.02;

export class Field {
  private ruts: Strips | null = null;
  /** The run out now, or the last one, just over: the look it leaves,
   *  its strips, which step works each tile. */
  private out: { run: Run | null; after: Look; strips: Strips | null; worked: Map<string, number> } | null = null;
  private look: Look;
  private colours: Rgb[];
  private land: Set<string>;
  private head: (t: GridCoord) => boolean;
  /** The land's tiles, cast at the height of what stands on each. */
  private sheet: Mesh;
  private heights: number[];
  private stop: () => void;

  constructor(private ctx: EngineContext, private casters: Casters, farm: number, private tiles: Tile[], ruts: GridCoord[], theme: Theme) {
    this.colours = [theme.earth, theme.growing, theme.ripe, theme.stubble];
    this.land = new Set(tiles.map((t) => key(t.at)));
    this.head = (t) => [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => !this.land.has(`${t.x + dx},${t.y + dy}`)));
    this.look = lookOf(tiles);
    this.ruts = this.strips("ruts", ruts, this.look, JOB_OF[this.look.stage]);
    this.sheet = meshOf(ctx.engine, `field_${farm}`, { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
    this.sheet.material = townMaterial([CAST_ONLY]);
    this.heights = tiles.map(() => -1);
    show(ctx.scene, this.sheet);
    casters.add(this.sheet);

    // Each frame: a run begun or ended, how far it has got; and while the
    // crop grows, how far, now and then.
    let looked = performance.now();
    this.stop = ctx.beforeRender(() => {
      const run = running.get(farm) ?? null;
      if (run !== (this.out?.run ?? null)) this.follow(run);
      if (!run && this.look.stage === "Sown" && this.look.growth < 1 && performance.now() - looked > 500) {
        looked = performance.now();
        this.look = lookOf(tiles);
        if (this.ruts) this.ruts.paint.look = vec(this.look);
      }
      this.raise();
    });
  }

  /** A path's strips in a look, worked as the job works it; none for a
   *  path too short to draw, or grass. */
  private strips(name: string, path: GridCoord[], look: Look, job: Job | null): Strips | null {
    const nodes = path.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 }));
    const drawn = path.length > 1 && job ? drawnPath(nodes, 0, 0, 0) : null;
    if (!drawn || !job) return null;
    const worked = workedAt(path, this.land, this.head, job);
    return new Strips(this.ctx, `field_${name}`, nodes, drawn, (k) => worked.get(key(path[k])) === k, this.land, (paint) => this.material(paint), look);
  }

  /** A run out over the field, or none: its strips laid over the last
   *  run's. A run just over leaves what it did until the farm's new
   *  record comes to say so, and the field is made again from it. */
  private follow(run: Run | null) {
    if (!run) {
      if (this.out) this.out.run = null;
      if (this.out?.strips) this.out.strips.paint.reach = 1e9;
      return;
    }
    if (this.out?.strips) drop(this.ctx.scene, this.out.strips.mesh);
    const after = leaves(run.job, this.look);
    this.out = { run, after, strips: this.strips("run", run.path, after, run.job), worked: workedAt(run.path, this.land, this.head, run.job) };
  }

  /** The tractor's progress, in steps of its path, now. */
  private progress(): number {
    const run = this.out?.run;
    return run ? (simNow() - run.started) / run.pace : 1e9;
  }

  /** The strips laid as far as the tractor, at the top of what stands;
   *  each tile of the sheet at the height of what stands on it: the
   *  crop, until the tractor is past its middle. */
  private raise() {
    const progress = this.progress();
    const after = this.out?.after ?? this.look;
    const [hb, ha] = [heightOf(this.look), heightOf(after)];
    const top = FIELD_Z + Math.max(hb, ha);
    this.ruts?.lift(this.ctx.engine, top);
    const strips = this.out?.strips;
    if (strips) {
      const { atNode } = strips.drawn;
      const k = Math.min(Math.max(0, Math.floor(progress)), atNode.length - 2);
      if (this.out?.run) strips.paint.reach = atNode[k] + (atNode[k + 1] - atNode[k]) * Math.min(1, Math.max(0, progress - k));
      strips.lift(this.ctx.engine, top + 0.002);
    }
    for (const s of [this.ruts, strips]) if (s) markMaterialUboDirty(s.mesh.material as TownMaterial);
    let changed = false;
    const heights = this.tiles.map((t, i) => {
      const k = this.out?.worked.get(key(t.at));
      const h = k !== undefined && k + 0.5 < progress ? ha : hb;
      if (Math.abs(h - this.heights[i]) > 0.002) changed = true;
      return h;
    });
    if (!changed) return;
    this.heights = heights;
    const matrices = new Float32Array(this.tiles.length * 16);
    this.tiles.forEach(({ at }, i) => {
      const m = i * 16;
      [matrices[m], matrices[m + 5], matrices[m + 10], matrices[m + 15]] = [1, 1, 1, 1];
      [matrices[m + 12], matrices[m + 13], matrices[m + 14]] = [at.x, at.y, FIELD_Z + heights[i]];
    });
    setThinInstances(this.sheet, matrices, this.tiles.length);
  }

  private material(paint: Paint): TownMaterial {
    return townMaterial([plugin(this.ctx.engine, this.ctx.scene, paint, this.colours)], 0.95);
  }

  dispose(): void {
    this.stop();
    for (const s of [this.ruts, this.out?.strips]) if (s) drop(this.ctx.scene, s.mesh);
    this.casters.remove(this.sheet);
    drop(this.ctx.scene, this.sheet);
  }
}

/** The field's paint (see the top), where across and along its strip a
 *  vertex is, which way across is, and which edges are the border. */
function plugin(engine: Engine, scene: SceneContext, paint: Paint, colours: Rgb[]): MaterialPlugin {
  return {
    name: "Field",
    priority: 210,
    getAttributes: () => [
      { name: "stripA", type: "vec4<f32>", buffer: "strip" },
      { name: "stripB", type: "vec4<f32>", buffer: "strip" },
    ],
    getVaryings: () => [
      { name: "vStripA", type: "vec4f" },
      { name: "vStripB", type: "vec4f" },
    ],
    getSamplers: () => [{ texture: "fieldGrain", sampler: "fieldGrainSampler" }],
    bindTextures: (out) => out.push({ texture: grain(engine) }),
    getUniforms: () => ({
      ubo: [
        { name: "fieldLook", type: "vec4<f32>" },
        { name: "fieldEarth", type: "vec4<f32>" },
        { name: "fieldGrowing", type: "vec4<f32>" },
        { name: "fieldRipe", type: "vec4<f32>" },
        { name: "fieldStubble", type: "vec4<f32>" },
        { name: "fieldSun", type: "vec4<f32>" },
      ],
    }),
    writeUbo: (data, offsets) => {
      const put = (name: string, v: number[]) => data.set(v, offsets.get(name)! / 4);
      put("fieldLook", [paint.look[0], paint.look[1], paint.reach, 0]);
      ["fieldEarth", "fieldGrowing", "fieldRipe", "fieldStubble"].forEach((name, i) => put(name, [colours[i].r, colours[i].g, colours[i].b, 1]));
      const d = (scene.lights.find((l) => l.shadowGenerator) as DirectionalLight | undefined)?.direction ?? { x: 0, y: 0, z: -1 };
      put("fieldSun", [-d.x, -d.y, -d.z, 0]);
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vStripA = stripA; out.vStripB = stripB;" }
        : { CUSTOM_FRAGMENT_DEFINITIONS: DEFINITIONS, CUSTOM_FRAGMENT_MAIN_BEGIN: BEGIN, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: DIFFUSE },
  };
}

/** The grain, as value noise: `p` in its texels, 256 to its side. And
 *  the field's height at a point of a pass, `u` across it 0 to 1, `v`
 *  along it in tiles, by stage, and of that how much is crop: the furrow
 *  slices, each turned over against the last, rising across it and
 *  falling steep to the next; the drill's ten rows, ridged, and the crop
 *  along them a tuft at a time, a few thin blades, closing over the
 *  rows as they grow; its tramlines, the
 *  wheel tracks, as far apart as the tractor's wheels and as thin as a
 *  lane's line, in the gaps either side of the middle row, left open to
 *  the earth; the stubble, the rows' ridges again with a stalk left
 *  standing where most plants stood. As high as the crop stands (CROP_H)
 *  and as deep as the shadows cast into it. */
const DEFINITIONS = `fn fieldNoise(p: vec2f) -> f32 { return textureSample(fieldGrain, fieldGrainSampler, p / 256.).r; }
fn fieldHash(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
// A tuft of wheat at o from its middle, r its reach, a its turn: its
// height, 0 to 1: five thin blades out from its heart, each its own
// length, tapering to its tip; broader as it grows.
fn fieldPlant(o: vec2f, r: f32, a: f32, grown: f32) -> f32 {
  let d = length(o) / r;
  if (d >= 1.) { return 0.; }
  let turn = (atan2(o.y, o.x) + a) * 0.7957747 + 10.;
  let blade = floor(turn + 0.5);
  let side = d * abs(turn - blade) * 1.2566371;
  let t = d / (0.55 + 0.45 * fieldHash(vec2f(blade, a)).x);
  let w = mix(0.07, 0.13, grown) * (1. - 0.6 * t);
  if (t >= 1. || side >= w) { return 0.; }
  return (1. - 0.6 * t) * (1. - side / w);
}
// The tallest of the tufts near (u, v): of the two rows either side of
// it, ten to a pass, and the four along either side of it, 28 to a tile;
// their reach and how far grown, and how many of them stand (1 all,
// less some gone).
fn fieldPlants(u: f32, v: f32, r: f32, grown: f32, stand: f32) -> f32 {
  let x = u * 10. - 0.5;
  let r0 = clamp(floor(x), 0., 8.);
  var h = 0.;
  for (var i = 0; i < 2; i++) {
    let row = r0 + f32(i);
    let y = v * 28. + fieldHash(vec2f(row, 17.)).x;
    let c0 = floor(y - 0.5) - 1.;
    for (var j = 0; j < 4; j++) {
      let c = c0 + f32(j);
      let seed = fieldHash(vec2f(row * 131. + c, 7.));
      if (seed.y > stand) { continue; }
      let o = vec2f((x - row) / 10., (y - c - 0.5 - (seed.x - 0.5) * 0.5) / 28.);
      h = max(h, fieldPlant(o, r * (0.75 + 0.5 * seed.y / stand), seed.x * 6.2831853, grown));
    }
  }
  return h;
}
fn fieldHeight(u: f32, v: f32, stage: u32, k: f32) -> vec2f {
  let p = fract(u);
  let row = 1. - abs(fract(u * 10.) - 0.5) * 2.;
  let tram = 1. - smoothstep(0.01, 0.02, min(abs(p - 0.4), abs(p - 0.6)));
  let ridge = 0.008 * row * (1. - tram);
  if (stage == 1u) { let q = fract(u * 4.); return vec2f(0.035 * pow(q, 0.6) * (1. - smoothstep(0.78, 1., q)), 0.); }
  if (stage == 2u) {
    let grown = smoothstep(0.03, 0.6, k);
    let tall = smoothstep(0.01, 0.05, k) * (0.15 + 0.85 * grown) * ${CROP_H.toFixed(3)};
    let crop = tall * fieldPlants(u, v, 0.03 + 0.045 * grown, grown, 1.) * (1. - tram);
    return vec2f(max(ridge, crop + ridge * 0.5), step(ridge, crop + ridge * 0.5) * step(0.001, crop));
  }
  if (stage == 3u) {
    let stalk = step(0.2, fieldPlants(u, v, 0.022, 0., 0.6)) * (1. - tram);
    return vec2f(ridge + 0.012 * stalk, stalk);
  }
  return vec2f(0.);
}`;

/**
 * Where on its strip a pixel is: `fieldU` across the pass, 0 to 1, and
 * the way that runs (`fieldAcross`); `fieldV` along it. Every texture
 * read here, before anything branches, as WGSL wants. Then not drawn: a
 * strip not yet laid, grass, and a ragged margin along the border.
 */
const BEGIN = `let fieldU = input.vStripA.x + 0.5;
let fieldV = input.vStripA.y;
let fieldAcross = normalize(input.vStripA.zw);
let fieldW = input.worldPos.xy;
let fieldN1 = fieldNoise(fieldW * 48.);
let fieldN2 = fieldNoise(fieldW * 48. + vec2f(97., 41.));
// How far off the field is: as a pass shrinks to a few pixels, its
// ridges and rows and shade are drawn as what they add up to, or shimmer.
let fieldFar = smoothstep(0.03, 0.1, fwidth(fieldU));
// Broad, soft patches: wetter earth, a crop a little ahead or behind.
let fieldMottle = 0.6 * fieldNoise(fieldW * 2. + vec2f(61., 7.)) + 0.4 * fieldNoise(fieldW * 6. + vec2f(13., 89.));
let fieldEdge = 0.5 * fieldNoise(fieldW * 24. + vec2f(31., 5.)) + 0.5 * fieldNoise(fieldW * 6. + vec2f(3., 201.));
let fieldLook = material.fieldLook;
let fieldStage = u32(fieldLook.x + 0.5);
let fieldBorder = select(input.vStripB.y, input.vStripB.x, fieldU < 0.5) > 0.5;
if (fieldStage == 0u || fieldV > fieldLook.z || (fieldBorder && 0.5 - abs(fieldU - 0.5) < 0.03 + 0.07 * fieldEdge)) { discard; }`;

/**
 * The paint, by stage: a colour, the crop's from the earth's by how much
 * of the height is crop; the height's slope, across and along, tilting
 * the facing, so the ridges, the leaves and the walls of the tramlines
 * take the light; the shade a ridge or a plant casts, found by stepping
 * toward the sun until something stands higher than the ray (fades out
 * where a pass is a few pixels, and at night); the low of the crop and
 * the bottoms of the furrows and tracks a little darker than the tops,
 * as between a tree's clumps. Over it a jumble, the fine grain's, of
 * clods and leaves.
 */
const DIFFUSE = `let fieldGrown = fieldLook.y;
let fieldHC = fieldHeight(fieldU, fieldV, fieldStage, fieldGrown);
let fieldE = 0.003;
let fieldSlope = clamp(vec2f(fieldHeight(fieldU + fieldE, fieldV, fieldStage, fieldGrown).x - fieldHC.x, fieldHeight(fieldU, fieldV + fieldE, fieldStage, fieldGrown).x - fieldHC.x) / fieldE, vec2f(-3.), vec2f(3.));
let fieldAlong = vec2f(fieldAcross.y, -fieldAcross.x);
let fieldSun = material.fieldSun.xyz;
let fieldFlat = vec2f(dot(fieldSun.xy, fieldAcross), dot(fieldSun.xy, fieldAlong));
let fieldStep = fieldFlat / max(length(fieldFlat), 1e-4);
let fieldRise = max(fieldSun.z, 0.05) / max(length(fieldFlat), 0.05);
var fieldOver = 0.;
for (var i = 1; i <= 8; i++) {
  let du = f32(i) * 0.015;
  fieldOver = max(fieldOver, fieldHeight(fieldU + fieldStep.x * du, fieldV + fieldStep.y * du, fieldStage, fieldGrown).x - fieldHC.x - du * fieldRise);
}
let fieldLit = mix(1. - smoothstep(0., 0.006, fieldOver), 0.85, fieldFar) * smoothstep(0., 0.1, fieldSun.z) + 1. - smoothstep(0., 0.1, fieldSun.z);
let fieldBumps = (vec2f(fieldN1, fieldN2) - 0.5) * 2.;
// A gentle tint, a few in a hundred either way, and no more.
let fieldTint = 0.94 + 0.12 * fieldMottle;
// The earth: a dark grey-brown, the field's earth greyed and darkened.
let fieldDirt = material.fieldEarth.rgb;
let fieldSoil = mix(fieldDirt, vec3f(dot(fieldDirt, vec3f(0.3, 0.55, 0.15))), 0.45) * 0.55;
var fieldColour = fieldSoil;
var fieldTop = 1.;
var fieldJumble = 0.;
if (fieldStage == 1u) {
  // Ploughed: turned earth, four furrow slices a pass, clods all over.
  fieldColour = fieldSoil * 0.9;
  fieldTop = fieldHC.x / 0.035;
  fieldJumble = 0.55;
} else if (fieldStage == 2u) {
  // Sown: a soft green, the tree's sort and not the grass's, then gold;
  // each plant's heart and the crop's low darker than its tops.
  let leaf = material.fieldGrowing.rgb;
  let green = mix(leaf, vec3f(dot(leaf, vec3f(0.3, 0.55, 0.15))), 0.3) * vec3f(0.56, 0.62, 0.52);
  let crop = mix(green, material.fieldRipe.rgb * vec3f(0.86, 0.8, 0.66), smoothstep(0.6, 1., fieldGrown));
  // Between the tufts, as it grows, the crop's own shade, too fine to draw.
  let under = mix(fieldSoil, crop * 0.7, smoothstep(0.25, 0.7, fieldGrown) * (1. - smoothstep(0.01, 0.02, min(abs(fract(fieldU) - 0.4), abs(fract(fieldU) - 0.6)))));
  fieldColour = mix(under, crop, mix(fieldHC.y, smoothstep(0.1, 0.5, fieldGrown), fieldFar));
  fieldTop = mix(fieldHC.x / ${CROP_H.toFixed(3)} / max(0.15 + 0.85 * smoothstep(0.03, 0.6, fieldGrown), 0.15), 1., 1. - fieldHC.y);
  fieldJumble = 0.15 + 0.2 * fieldHC.y;
} else if (fieldStage == 3u) {
  // Stubble: the harrowed ground of the sowing, the earth the crop stood
  // in, as its tramlines show it; a pale stalk standing where most plants
  // stood.
  let straw = mix(material.fieldStubble.rgb, material.fieldRipe.rgb, 0.4) * 0.85;
  fieldColour = mix(fieldSoil * 0.8, straw, mix(fieldHC.y, 0.2, fieldFar));
  fieldTop = 0.5 + 0.5 * fieldHC.y;
  fieldJumble = 0.3;
}
fieldColour = fieldColour * fieldTint * mix(0.72, 1.05, mix(clamp(fieldTop, 0., 1.), 0.7, fieldFar)) * mix(0.62, 1., fieldLit);
baseColor = fieldColour;
N = normalize(N - vec3f((fieldAcross * fieldSlope.x + fieldAlong * fieldSlope.y) * (1. - fieldFar), 0.) + vec3f(fieldBumps * fieldJumble, 0.));`;
