import { createTexture2DFromPixels, markMaterialUboDirty, setMeshAttribute, setThinInstances, updateMeshPositions, updateTexture2DFromPixels, type EngineContext as Engine, type MaterialPlugin, type Mesh, type Texture2D } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import type { Casters } from "../DayNightCycle";
import { drop, meshOf, show } from "../geometry";
import { grain } from "../ground";
import { CAST_ONLY, townMaterial, type TownMaterial } from "../material";
import { LAYER_ORDER } from "../town/draw";
import type { Rgb } from "../rgb";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { GridCoord } from "../../generated/GridCoord";
import type { Job } from "../../generated/Job";
import type { Run } from "../../generated/Run";
import type { Tile } from "../../generated/Tile";
import { drawnPath, type DrawnPath, type P } from "./drawnPath";
import { baked } from "../bakeCache";
import { WHEAT_MARGIN, WHEAT_STAGES, WHEAT_STRIDE, WHEAT_TEXELS } from "../wheat";
import recipe from "../wheat.ts?raw";

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
 * Along each strip, a stage of the wheat, baked once (`wheat.ts`) and
 * read as a texture: furrow slices; a drill's rows; the wheat coming up
 * along them, closing over them, in ear, ripe, its wheel tracks left
 * open; the stubble after the combine. Each stage one clean colour on a
 * dark grey earth, as the town's are: its texture is all light, baked
 * into how light each texel is and which way it faces. Each piece
 * covers its tile and spills a little past it all round, raggedly, with
 * crumbs of its earth beyond, onto the grass or the field beside, and
 * ahead of the tractor as it goes.
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
 * which way across is, and where along the piece's own tile begins and
 * ends.
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
    // The first point at or past a distance, found by halves.
    const past = (d: number) => {
      let [lo, hi] = [0, distances.length];
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (distances[m] < d) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    const along = (d0: number, d1: number): { p: P; d: number }[] => {
      const at = (d: number) => {
        const i = Math.min(Math.max(0, past(d) - 1), distances.length - 2);
        const t = (d - distances[i]) / (distances[i + 1] - distances[i] || 1);
        return { p: { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }, d };
      };
      const run = [at(d0)];
      for (let i = past(d0); i < distances.length && distances[i] < d1; i++) if (distances[i] > d0) run.push({ p: points[i], d: distances[i] });
      run.push(at(d1));
      // A hair on past each end, to meet the piece beside it.
      const on = (a: { p: P; d: number }, b: { p: P; d: number }) => {
        const l = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) || 1;
        return { p: { x: b.p.x + ((b.p.x - a.p.x) / l) * HAIR, y: b.p.y + ((b.p.y - a.p.y) / l) * HAIR }, d: b.d + Math.sign(b.d - a.d) * HAIR };
      };
      return [on(run[1], run[0]), ...run, on(run[run.length - 2], run[run.length - 1])];
    };
    const off = (x: number, y: number) => !land.has(`${Math.floor(x)},${Math.floor(y)}`);
    // Where the earth spills past a piece's tile: onto any tile this run
    // has not already worked by then. Over one it has, it would never show.
    const first = new Map<string, number>();
    nodes.forEach(({ x, y }, k) => { if (works(k) && !first.has(`${Math.floor(x)},${Math.floor(y)}`)) first.set(`${Math.floor(x)},${Math.floor(y)}`, k); });
    const spills = (k: number, x: number, y: number) => (first.get(`${Math.floor(x)},${Math.floor(y)}`) ?? Infinity) >= k;
    const pieces: { k: number; from: number; to: number; samples: { p: P; d: number }[] }[] = [];
    for (let k = 0; k <= last; k++) {
      if (!works(k)) continue;
      const [before, after] = [k > 0 && works(k - 1), k < last && works(k + 1)];
      // A tile across the way from a to b, and on past either end, far
      // where it spills, a hair where it meets a piece.
      const straight = (a: P, b: P, spill = true) => {
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        const [ux, uy, c] = [(b.x - a.x) / l, (b.y - a.y) / l, nodes[k]];
        const [back, on] = [spill && spills(k, c.x - ux, c.y - uy) ? SPILL : HAIR, spill && spills(k, c.x + ux, c.y + uy) ? SPILL : HAIR];
        pieces.push({
          k,
          from: back === SPILL ? atNode[k] - 0.5 : -1e9,
          to: on === SPILL ? atNode[k] + 0.5 : 1e9,
          samples: [{ p: { x: c.x - ux * (0.5 + back), y: c.y - uy * (0.5 + back) }, d: atNode[k] - 0.5 - back }, { p: { x: c.x + ux * (0.5 + on), y: c.y + uy * (0.5 + on) }, d: atNode[k] + 0.5 + on }],
        });
      };
      if (before && after) {
        // A turn with field on its outside, as round the farmstead, is
        // worked square underneath, so its corner is not left bare.
        const [a, c, b] = [nodes[k - 1], nodes[k], nodes[k + 1]];
        const ahead = { x: 2 * c.x - a.x, y: 2 * c.y - a.y };
        const behind = { x: 2 * c.x - b.x, y: 2 * c.y - b.y };
        if ((c.x - a.x) * (b.y - c.y) - (c.y - a.y) * (b.x - c.x) !== 0 && !off(ahead.x, ahead.y) && !off(behind.x, behind.y)) straight(a, c, false);
        pieces.push({ k, from: -1e9, to: 1e9, samples: along(bound(k), bound(k + 1)) });
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
    for (const { k, from, to, samples } of pieces) {
      const at = nodes[k];
      samples.forEach(({ p, d }, i) => {
        const [a, b] = [samples[Math.max(0, i - 1)].p, samples[Math.min(samples.length - 1, i + 1)].p];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
        const sides = [-1, 1].map((side) => (spills(k, at.x + n.x * side, at.y + n.y * side) ? 1 : 0));
        sides.forEach((spill, s) => {
          const out = (s ? 1 : -1) * (0.5 + (spill ? SPILL : HAIR));
          this.positions.set([p.x + n.x * out, p.y + n.y * out, 0], (v + s) * 3);
          data.set([out, d, n.x, n.y, from, to, sides[0], sides[1]], (v + s) * 8);
        });
        if (i > 0) indices.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
        v += 2;
      });
    }
    this.mesh = meshOf(ctx.engine, name, { positions: this.positions, normals: Array.from({ length: count * 2 }, () => [0, 0, 1]).flat(), indices });
    this.mesh.material = material(this.paint);
    this.mesh.receiveShadows = true;
    this.mesh.renderOrder = LAYER_ORDER.field;
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

/** How far past its tile a piece goes where it spills, for its ragged
 *  edge and the crumbs of earth beyond it; and where it meets another
 *  piece, a hair over, so the two meet with no seam between. */
const SPILL = 0.16;
const HAIR = 0.03;

class Field {
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
    return townMaterial([plugin(this.ctx.engine, paint, this.colours)], 0.95);
  }

  dispose(): void {
    this.stop();
    for (const s of [this.ruts, this.out?.strips]) if (s) drop(this.ctx.scene, s.mesh);
    this.casters.remove(this.sheet);
    drop(this.ctx.scene, this.sheet);
  }
}

/**
 * Each farm's field, kept while its land and ruts are as they were: the
 * farm's record comes again with every crate and every worker, and a field
 * made again for each would stall the frame. Let go, it is dropped once the
 * batch that let it go has passed without taking it up again.
 */
const FIELDS = new Map<number, { field: Field; was: string; theme: Theme; held: boolean }>();
export function keepField(ctx: EngineContext, casters: Casters, farm: number, tiles: Tile[], ruts: GridCoord[], theme: Theme): () => void {
  const was = JSON.stringify([tiles, ruts]);
  let kept = FIELDS.get(farm);
  if (!kept || kept.was !== was || kept.theme !== theme) {
    kept?.field.dispose();
    kept = { field: new Field(ctx, casters, farm, tiles, ruts, theme), was, theme, held: true };
    FIELDS.set(farm, kept);
  }
  const mine = kept;
  mine.held = true;
  return () => {
    mine.held = false;
    queueMicrotask(() => {
      if (mine.held || FIELDS.get(farm) !== mine) return;
      mine.field.dispose();
      FIELDS.delete(farm);
    });
  };
}

/** The wheat's stages, an engine's: bare earth until the worker has
 *  baked them, or read back from the last bake (`bakeCache.ts`). */
const WHEATS = new WeakMap<Engine, Texture2D>();
function wheat(engine: Engine): Texture2D {
  let texture = WHEATS.get(engine);
  if (!texture) {
    const bare = new Uint8Array(WHEAT_TEXELS * WHEAT_STRIDE * WHEAT_STAGES * 4);
    for (let k = 0; k < bare.length; k += 4) bare.set([128, 128, 200, 0], k);
    const made = createTexture2DFromPixels(engine, bare, WHEAT_TEXELS, WHEAT_STRIDE * WHEAT_STAGES, {
      mipmaps: true,
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
    });
    WHEATS.set(engine, (texture = made));
    void baked("wheat", recipe, () => new Worker(new URL("../wheatWorker.ts", import.meta.url), { type: "module" })).then((data) => updateTexture2DFromPixels(engine, made, data));
  }
  return texture;
}

/** The field's paint (see the top), where across and along its strip a
 *  vertex is, which way across is, and where its piece's tile begins and
 *  ends along it. */
function plugin(engine: Engine, paint: Paint, colours: Rgb[]): MaterialPlugin {
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
    getSamplers: () => [
      { texture: "fieldGrain", sampler: "fieldGrainSampler" },
      { texture: "fieldWheat", sampler: "fieldWheatSampler" },
    ],
    bindTextures: (out) => out.push({ texture: grain(engine) }, { texture: wheat(engine) }),
    getUniforms: () => ({
      ubo: [
        { name: "fieldLook", type: "vec4<f32>" },
        { name: "fieldEarth", type: "vec4<f32>" },
        { name: "fieldGrowing", type: "vec4<f32>" },
        { name: "fieldRipe", type: "vec4<f32>" },
        { name: "fieldStubble", type: "vec4<f32>" },
      ],
    }),
    writeUbo: (data, offsets) => {
      const put = (name: string, v: number[]) => data.set(v, offsets.get(name)! / 4);
      put("fieldLook", [paint.look[0], paint.look[1], paint.reach, 0]);
      ["fieldEarth", "fieldGrowing", "fieldRipe", "fieldStubble"].forEach((name, i) => put(name, [colours[i].r, colours[i].g, colours[i].b, 1]));
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vStripA = stripA; out.vStripB = stripB;" }
        : { CUSTOM_FRAGMENT_DEFINITIONS: DEFINITIONS, CUSTOM_FRAGMENT_MAIN_BEGIN: BEGIN, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: DIFFUSE },
  };
}

/** The grain, as value noise: `p` in its texels, 256 to its side. And a
 *  stage of the wheat (`wheat.ts`) at a point of a pass, `u` across it 0
 *  to 1, `v` along it in tiles, read as from a texture of its own, with
 *  how fast `u` and `v` change across the screen, so far off it is read
 *  from a smaller copy, as what it adds up to. */
const DEFINITIONS = `fn fieldNoise(p: vec2f) -> f32 { return textureSample(fieldGrain, fieldGrainSampler, p / 256.).r; }
fn fieldWheatAt(stage: f32, u: f32, v: f32, du: vec2f, dv: vec2f) -> vec4f {
  let tall = ${WHEAT_STRIDE * WHEAT_STAGES}.;
  let y = (stage * ${WHEAT_STRIDE}. + ${WHEAT_MARGIN}. + fract(v) * ${WHEAT_TEXELS}.) / tall;
  return textureSampleGrad(fieldWheat, fieldWheatSampler, vec2f(u, y), vec2f(du.x, dv.x * ${WHEAT_TEXELS}. / tall), vec2f(du.y, dv.y * ${WHEAT_TEXELS}. / tall));
}`;

/**
 * Where on its strip a pixel is: `fieldU` across the pass, 0 to 1, and
 * the way that runs (`fieldAcross`); `fieldV` along it, and how fast both
 * change across the screen. Every texture read and every rate of change
 * here, before anything branches, as WGSL wants. Then not drawn: grass,
 * and past the piece's tile, all but a ragged edge and crumbs.
 */
const BEGIN = `let fieldU = input.vStripA.x + 0.5;
let fieldV = input.vStripA.y;
let fieldAcross = normalize(input.vStripA.zw);
let fieldDu = vec2f(dpdx(fieldU), dpdy(fieldU));
let fieldDv = vec2f(dpdx(fieldV), dpdy(fieldV));
let fieldW = input.worldPos.xy;
let fieldLook = material.fieldLook;
// Broad, soft patches: wetter earth, a crop a little ahead or behind.
let fieldMottle = 0.6 * fieldNoise(fieldW * 2. + vec2f(61., 7.)) + 0.4 * fieldNoise(fieldW * 6. + vec2f(13., 89.));
let fieldEdge = 0.5 * fieldNoise(fieldW * 24. + vec2f(31., 5.)) + 0.5 * fieldNoise(fieldW * 6. + vec2f(3., 201.));
let fieldStage = u32(fieldLook.x + 0.5);
// How far past its own tile the pixel is, across, past either end, or
// ahead of the tractor: out to here the earth reaches, raggedly, and past
// that only crumbs of it, fewer further out, over what lies beside.
let fieldOut = max(max(select(-1., -fieldU, input.vStripB.z > 0.5), select(-1., fieldU - 1., input.vStripB.w > 0.5)), max(fieldV - fieldLook.z, max(input.vStripB.x - fieldV, fieldV - input.vStripB.y)));
let fieldCrumb = 0.6 * fieldNoise(fieldW * 40. + vec2f(171., 23.)) + 0.4 * fieldNoise(fieldW * 90. + vec2f(7., 51.));
let fieldRag = 0.07 * fieldEdge;
if (fieldStage == 0u || (fieldOut > fieldRag && fieldCrumb < 0.56 + 3. * (fieldOut - fieldRag))) { discard; }`;

/**
 * The paint: the stage of the wheat the field is at (ploughed; sown, by
 * how far grown, drilled, seedlings, grown, in ear, ripe; stubble), and
 * between two, the next showing through in patches as it comes, so a
 * field ripens in waves, not all at once. Each texel its earth's colour
 * or the crop's, as light as it was baked, its facing turned as baked.
 */
const DIFFUSE = `let fieldDirt = material.fieldEarth.rgb;
// The earth: a dark grey-brown, the field's earth greyed and darkened.
let fieldSoil = mix(fieldDirt, vec3f(dot(fieldDirt, vec3f(0.3, 0.55, 0.15))), 0.45) * 0.55;
let fieldLeaf = material.fieldGrowing.rgb;
let fieldGreen = mix(fieldLeaf, vec3f(dot(fieldLeaf, vec3f(0.3, 0.55, 0.15))), 0.3) * vec3f(0.56, 0.62, 0.52);
let fieldGold = material.fieldRipe.rgb * vec3f(0.86, 0.8, 0.66);
let fieldStraw = mix(material.fieldStubble.rgb, material.fieldRipe.rgb, 0.4) * 0.85;
var fieldAt = 0.;
if (fieldStage == 2u) { fieldAt = 1. + 4. * clamp(fieldLook.y, 0., 1.); }
if (fieldStage == 3u) { fieldAt = 6.; }
let fieldFrom = floor(fieldAt);
let fieldTo = min(fieldFrom + 1., 6.);
let fieldPatch = 0.2 + 0.6 * fieldMottle;
let fieldAhead = smoothstep(fieldPatch - 0.2, fieldPatch + 0.2, fieldAt - fieldFrom);
var fieldColour = vec3f(0.);
var fieldFacing = vec3f(0.);
for (var i = 0; i < 2; i++) {
  let st = select(fieldFrom, fieldTo, i == 1);
  let t = fieldWheatAt(st, fieldU, fieldV, fieldDu, fieldDv);
  let soil = fieldSoil * select(select(1., 0.8, st > 5.5), 0.9, st < 0.5);
  var crop = fieldGreen;
  if (st > 3.5) { crop = mix(fieldGreen, fieldGold, 0.25); }
  if (st > 4.5) { crop = fieldGold; }
  if (st > 5.5) { crop = fieldStraw; }
  let c = mix(soil, crop, t.a) * t.b * 1.25;
  let w = select(1. - fieldAhead, fieldAhead, i == 1);
  fieldColour += c * w;
  fieldFacing += vec3f(t.rg * 2. - 1., 0.) * w;
}
let fieldN = vec3f(fieldFacing.xy, sqrt(max(0.05, 1. - dot(fieldFacing.xy, fieldFacing.xy))));
// A gentle tint, a few in a hundred either way, and no more.
baseColor = fieldColour * (0.94 + 0.12 * fieldMottle);
N = normalize(vec3f(fieldAcross * fieldN.x + vec2f(fieldAcross.y, -fieldAcross.x) * fieldN.y, fieldN.z));`;
