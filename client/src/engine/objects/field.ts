import { addToScene, createTexture2DFromPixels, markMaterialUboDirty, setMeshAttribute, updateMeshPositions, updateTexture2DFromPixels, type EngineContext as Engine, type MaterialPlugin, type Mesh, type Texture2D } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import type { Casters } from "../DayNightCycle";
import { drop, meshOf } from "../geometry";
import { grain } from "../ground";
import { townMaterial, type TownMaterial } from "../material";
import { LAYER_ORDER } from "../town/draw";
import type { Rgb } from "../rgb";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { GridCoord, Job, Run, Tile } from "../../generated";
import { drawnPath, type DrawnPath } from "./drawnPath";
import { bakedTexture } from "../bakeCache";
import { WHEAT_MARGIN, WHEAT_STAGES, WHEAT_STRIDE, WHEAT_TEXELS } from "../wheat";
import recipe from "../wheat.ts?raw";

/** A point on the field. */
type P = { x: number; y: number };

/**
 * A farm's field, as it is seen from the air: the strips its tractor laid,
 * a pass a tile wide along the path it drove, curves and all, as it drives
 * it (`running` in `motion.ts`), each later pass over the earlier where
 * they meet. Laid only where the job was done, as the server does it: a
 * tile on the visit it is worked, the lands on the first pass over them,
 * the headland on its own pass round, after the lands when ploughing or
 * sowing, before them when harvesting (`fields.rs`); never on a turn or
 * the way home.
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
 * the look it left. On a run (`running`), the strips are the run's, in
 * the look before it and, as far along them as the tractor has got, the
 * look it leaves: the line between the two is where the tractor is, on
 * whatever line it drives. The rows and the headland are the same
 * whatever the job, so the field looks the same on the run's strips as on
 * the last. A crop stands on its own mesh over the earth, at its height,
 * casting its shadow.
 */

/** What a field shows: a stage of the cycle, and how far grown. */
export type Look = { stage: "Grass" | "Ploughed" | "Sown" | "Cut"; growth: number };

/** The field lies a little over the land, the crop up to this high. */
export const FIELD_Z = 0.008;
const CROP_H = 0.08;
/** How long a sown crop takes to ripen, as the server has it. */
export const RIPEN = 1_800_000;

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
 *  but for the headland when ploughing or sowing, worked on the pass
 *  round after the last land tile is first reached. */
function workedAt(path: GridCoord[], land: Set<string>, head: (t: GridCoord) => boolean, job: Job): Map<string, number> {
  const firsts = new Map<string, number>();
  path.forEach((t, k) => { if (land.has(key(t)) && !firsts.has(key(t))) firsts.set(key(t), k); });
  const ring = job !== "Harvest" ? Math.max(0, ...path.flatMap((t, k) => (firsts.get(key(t)) === k && !head(t) ? [k] : []))) : 0;
  const worked = new Map<string, number>();
  path.forEach((t, k) => { if (land.has(key(t)) && !worked.has(key(t)) && !(head(t) && k < ring)) worked.set(key(t), k); });
  return worked;
}

/** What a strip's material reads: the looks before a run and after it,
 *  and how far along the path the tractor has got: before it, the first,
 *  behind it, the second. */
type Paint = { looks: number[][]; reach: number };

/**
 * A run's strips: a tile wide along the drawn path, a piece for each step
 * that works its tile, from halfway back to the step before to halfway on
 * to the next, following the tractor wherever it drove, round turns and
 * off rows onto the headland alike: what it worked and nothing it did
 * not. Each vertex knows where across the strip it is, how far along,
 * which way across is, and where along the piece's own tile begins and
 * ends.
 */
class Strips {
  /** The earth, and over it each look's crop, at its height, casting its
   *  shadow on the earth between the plants: meshes of the one strip. */
  readonly mesh: Mesh;
  readonly crops: Mesh[];
  readonly drawn: DrawnPath;
  readonly paint: Paint;
  /** Where each piece works: its own row, and past the land's edge its
   *  spill, not where it spills over ground another piece works. Its two
   *  edges point by point along, how far along there, and between which
   *  distances along it works. */
  readonly pieces: { lo: number; hi: number; rows: { l: P; r: P; d: number }[] }[] = [];
  private positions: Float32Array;
  private raised: Float32Array[];
  /** Each vertex out past its piece's tile, a little lower, so that where a
   *  piece's spill lies over a tile another piece works, that piece shows. */
  private sunk: Float32Array;
  private z = -1;
  private hs: number[] = [];

  constructor(private ctx: EngineContext, private casters: Casters, name: string, nodes: P[], drawn: DrawnPath, works: (k: number) => boolean, land: Set<string>, under: GridCoord[], material: (paint: Paint, which: number) => TownMaterial, looks: Look[]) {
    this.drawn = drawn;
    this.paint = { looks: looks.map(vec), reach: -1e9 };
    const { points, distances, atNode } = drawn;
    const last = nodes.length - 1;
    const bound = (k: number) => (atNode[k - 1] + atNode[k]) / 2;
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
    // The drawn path between two distances along it, ends included.
    const along = (d0: number, d1: number, back: number, on: number): { p: P; d: number }[] => {
      const at = (d: number) => {
        const [x, y] = drawn.at(d);
        return { p: { x, y }, d };
      };
      const run = [at(d0)];
      for (let i = past(d0); i < distances.length && distances[i] < d1; i++) if (distances[i] > d0) run.push({ p: { x: points[i][0], y: points[i][1] }, d: distances[i] });
      run.push(at(d1));
      // On past each end, straight, this far.
      const beyond = (a: { p: P; d: number }, b: { p: P; d: number }, far: number) => {
        const l = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) || 1;
        return { p: { x: b.p.x + ((b.p.x - a.p.x) / l) * far, y: b.p.y + ((b.p.y - a.p.y) / l) * far }, d: b.d + Math.sign(b.d - a.d) * far };
      };
      return [beyond(run[1], run[0], back), ...run, beyond(run[run.length - 2], run[run.length - 1], on)];
    };
    const off = (x: number, y: number) => !land.has(`${Math.floor(x)},${Math.floor(y)}`);
    // Where the earth spills past a piece's tile: onto any tile this run
    // has not already worked by then. Over one it has, it would never show.
    const first = new Map<string, number>();
    nodes.forEach(({ x, y }, k) => { if (works(k) && !first.has(`${Math.floor(x)},${Math.floor(y)}`)) first.set(`${Math.floor(x)},${Math.floor(y)}`, k); });
    const spills = (k: number, x: number, y: number) => (first.get(`${Math.floor(x)},${Math.floor(y)}`) ?? Infinity) >= k;
    const pieces: { k: number; lo: number; hi: number; from: number; to: number; samples: { p: P; d: number }[] }[] = [];
    for (let k = 0; k <= last; k++) {
      if (!works(k)) continue;
      const [d0, d1] = [k > 0 ? bound(k) : atNode[0] - 0.5, k < last ? bound(k + 1) : atNode[last] + 0.5];
      // Each end on past where the work stops, far where it spills, a
      // hair where it meets the piece before or after.
      const behind = k > 0 ? nodes[k - 1] : { x: 2 * nodes[0].x - nodes[1].x, y: 2 * nodes[0].y - nodes[1].y };
      const ahead = k < last ? nodes[k + 1] : { x: 2 * nodes[last].x - nodes[last - 1].x, y: 2 * nodes[last].y - nodes[last - 1].y };
      const [back, on] = [spills(k, behind.x, behind.y), spills(k, ahead.x, ahead.y)];
      const [lo, hi] = [back && !off(behind.x, behind.y) ? d0 : -1e9, on && !off(ahead.x, ahead.y) ? d1 : 1e9];
      pieces.push({ k, lo, hi, from: back ? d0 : -1e9, to: on ? d1 : 1e9, samples: along(d0, d1, back ? SPILL : HAIR, on ? SPILL : HAIR) });
    }
    // Under the passes, bare earth on each quarter of a tile but those at
    // an outside corner of the land, where the field rounds off: what
    // shows where a turn cut a tile's corner.
    const quarters = under.flatMap((t) =>
      [0, 1].flatMap((qx) => [0, 1].filter((qy) => land.has(`${t.x + qx * 2 - 1},${t.y}`) || land.has(`${t.x},${t.y + qy * 2 - 1}`)).map((qy) => ({ x: t.x + qx * 0.5, y: t.y + qy * 0.5 }))),
    );
    // How much further each edge of the pass, half a tile out, goes than
    // its middle, here: on a turn the outer edge more, the inner less.
    const stretch = [-0.5, 0.5].map((out) => (d: number) => {
      const i = Math.min(Math.max(1, past(d)), distances.length - 1);
      const [ex, ey] = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]];
      const l = Math.hypot(ex, ey) || 1;
      const [ha, hb] = [drawn.heading(distances[i - 1]), drawn.heading(distances[i])];
      const [x, y] = [ex - (Math.sin(hb) - Math.sin(ha)) * out, ey + (Math.cos(hb) - Math.cos(ha)) * out];
      return l < 1e-3 ? 1 : Math.min(3, Math.max(0, (x * ex + y * ey) / (l * l)));
    });
    const count = pieces.reduce((n, piece) => n + piece.samples.length, 0) + quarters.length * 2;
    this.positions = new Float32Array(count * 6);
    this.sunk = new Float32Array(count * 2);
    const data = new Float32Array(count * 16);
    const tex = new Float32Array(count * 2);
    const indices: number[] = [];
    let v = 0;
    for (const q of quarters) {
      [q.y, q.y + 0.5].forEach((y, i) => {
        [0, 0.5].forEach((across, s) => {
          const out = across - (q.x % 1 === 0 ? 0.5 : 0);
          this.positions.set([q.x + 0.5 - across, y, 0], (v + s) * 3);
          this.sunk[v + s] = 2 * SUNK;
          data.set([out, y, -1, 0, -1e9, 1e9, BARE, BARE], (v + s) * 8);
          tex[v + s] = 1;
        });
        if (i > 0) indices.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
        v += 2;
      });
    }
    for (const { k, lo, hi, from, to, samples } of pieces) {
      const at = nodes[k];
      const rows: { l: P; r: P; d: number }[] = [];
      this.pieces.push({ lo, hi, rows });
      samples.forEach(({ p, d }, i) => {
        const [a, b] = [samples[Math.max(0, i - 1)].p, samples[Math.min(samples.length - 1, i + 1)].p];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
        const sides = [-1, 1].map((side) => (spills(k, at.x + n.x * side, at.y + n.y * side) ? (off(at.x + n.x * side, at.y + n.y * side) ? 2 : 1) : 0));
        // On the inside of a turn tighter than the pass is wide, the edge
        // stops short of the turn's middle, or it would fold back on itself.
        const bend = (2 * ((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x))) / (Math.hypot(p.x - a.x, p.y - a.y) * Math.hypot(b.x - p.x, b.y - p.y) * l || 1);
        const across = sides.map((spill, s) => {
          const wide = 0.5 + (spill ? SPILL : HAIR);
          return (s ? 1 : -1) * ((s ? 1 : -1) * bend > 0 ? Math.min(wide, 0.9 / Math.abs(bend)) : wide);
        });
        const works = across.map((out, s) => (sides[s] === 2 ? out : Math.sign(out) * Math.min(0.5 + OVERLAP, Math.abs(out))));
        rows.push({ l: { x: p.x + n.x * works[0], y: p.y + n.y * works[0] }, r: { x: p.x + n.x * works[1], y: p.y + n.y * works[1] }, d });
        sides.forEach((spill, s) => {
          const out = across[s];
          this.positions.set([p.x + n.x * out, p.y + n.y * out, 0], (v + s) * 3);
          this.sunk[v + s] = spill || d < from || d > to ? SUNK : 0;
          data.set([out, d, n.x, n.y, from, to, sides[0], sides[1]], (v + s) * 8);
          tex[v + s] = 1 + (stretch[s](d) - 1) * 2 * Math.abs(out);
        });
        if (i > 0) indices.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
        v += 2;
      });
    }
    this.raised = looks.map(() => this.positions.slice());
    const normals = Array.from({ length: count * 2 }, () => [0, 0, 1]).flat();
    [this.mesh, ...this.crops] = [this.positions, ...this.raised].map((positions, which) => {
      const mesh = meshOf(ctx.engine, `${name}${which ? `_crop${which}` : ""}`, { positions, normals, indices });
      mesh.material = material(this.paint, which);
      mesh.receiveShadows = true;
      mesh.renderOrder = LAYER_ORDER.field;
      setMeshAttribute(ctx.engine, mesh, "strip", data);
      setMeshAttribute(ctx.engine, mesh, "stripTex", tex);
      addToScene(ctx.scene, mesh);
      return mesh;
    });
    for (const crop of this.crops) casters.add(crop);
  }

  /** The earth at this height, each look's crop this far over it. */
  lift(z: number, hs: number[]) {
    if (Math.abs(z - this.z) < 0.0005 && hs.every((h, i) => Math.abs(h - this.hs[i]) < 0.002)) return;
    [this.z, this.hs] = [z, hs];
    for (let i = 0; i < this.sunk.length; i++) {
      this.positions[i * 3 + 2] = z - this.sunk[i];
      this.raised.forEach((raised, c) => (raised[i * 3 + 2] = z - this.sunk[i] + 0.001 + hs[c]));
    }
    updateMeshPositions(this.ctx.engine, this.mesh, this.positions);
    this.crops.forEach((crop, c) => updateMeshPositions(this.ctx.engine, crop, this.raised[c]));
  }

  /** The crop cut as the tractor goes: its shadow drawn again every frame,
   *  as a car's is, by moving it, by nothing, every frame. */
  stir() {
    for (const crop of this.crops) crop.position.z = crop.position.z ? 0 : 1e-6;
  }

  /** Paint changed: every mesh reads it again. */
  repaint() {
    for (const mesh of [this.mesh, ...this.crops]) markMaterialUboDirty(mesh.material as TownMaterial);
  }

  drop() {
    for (const crop of this.crops) this.casters.remove(crop);
    for (const mesh of [this.mesh, ...this.crops]) drop(this.ctx.scene, mesh);
  }
}

/** How far past its tile a piece goes where it spills, for its ragged
 *  edge and the crumbs of earth beyond it; and where it meets another
 *  piece, a hair over, so the two meet with no seam between. */
const SPILL = 0.16;
const SUNK = 0.0015;
const HAIR = 0.03;
/** A side flag past spilling onto land (1) or off it (2): bare all over. */
const BARE = 3;
/** How far a pass takes the crop past its own row, into the next. */
const OVERLAP = 0.05;
/** Texels of \`Field.cuts\` to a tile's side. */
const CUT_RES = 16;

class Field {
  /** The strips on show: the last run's, or the one out now's, and the
   *  path they lie along. */
  private strips: Strips | null = null;
  private path: GridCoord[];
  /** The run out now, or the last one, just over, and the look it leaves. */
  private out: { run: Run | null; after: Look } | null = null;
  private look: Look;
  private colours: Rgb[];
  private land: Set<string>;
  private head: (t: GridCoord) => boolean;
  /** When the run out now reaches each point of the land's bounds and a
   *  tile round, from \`corner\`, \`CUT_RES\` texels to a tile: how far
   *  along its path the first of its strips over the texel lies, in 256ths
   *  of a tile in three bytes (all ones, none). Behind the tractor is
   *  wherever it has got further than that, so where passes overlap, the
   *  ground goes over with the first of them. */
  private cuts: Texture2D;
  private corner: GridCoord;
  private span: GridCoord;
  private stop: () => void;

  constructor(private ctx: EngineContext, private casters: Casters, farm: number, private tiles: Tile[], ruts: GridCoord[], theme: Theme) {
    this.colours = [theme.earth, theme.growing, theme.ripe, theme.stubble];
    this.land = new Set(tiles.map((t) => key(t.at)));
    this.head = (t) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !this.land.has(`${t.x + dx},${t.y + dy}`));
    this.look = lookOf(tiles);
    const [xs, ys] = [tiles.map((t) => t.at.x), tiles.map((t) => t.at.y)];
    this.corner = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 };
    this.span = { x: Math.max(...xs) - this.corner.x + 2, y: Math.max(...ys) - this.corner.y + 2 };
    this.cuts = createTexture2DFromPixels(ctx.engine, new Uint8Array(this.span.x * this.span.y * CUT_RES * CUT_RES * 4).fill(255), this.span.x * CUT_RES, this.span.y * CUT_RES);
    this.path = ruts;
    this.strips = this.lay(ruts, JOB_OF[this.look.stage], [this.look]);

    // Each frame: a run begun or ended, how far it has got; and while the
    // crop grows, how far, now and then.
    let looked = performance.now();
    this.stop = ctx.beforeRender(() => {
      const run = running.get(farm) ?? null;
      if (run !== (this.out?.run ?? null)) this.follow(run);
      if (!this.out && this.look.stage === "Sown" && this.look.growth < 1 && performance.now() - looked > 500) {
        looked = performance.now();
        this.look = lookOf(tiles);
        if (this.strips) this.strips.paint.looks[0] = vec(this.look);
      }
      this.raise();
    });
  }

  /** A path's strips in these looks, worked as the job works it, over
   *  bare earth on the land; none for a path too short to draw, or grass. */
  private lay(path: GridCoord[], job: Job | null, looks: Look[]): Strips | null {
    const nodes = path.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 }));
    const drawn = path.length > 1 && job ? drawnPath(nodes.map(({ x, y }) => [x, y]), 0, 0, 0) : null;
    if (!drawn || !job) return null;
    const worked = workedAt(path, this.land, this.head, job);
    const under = this.tiles.map((t) => t.at);
    return new Strips(this.ctx, this.casters, "field", nodes, drawn, (k) => worked.get(key(path[k])) === k, this.land, under, (paint, which) => this.material(paint, which), looks);
  }

  /** A run out over the field, or none: the field laid again along the
   *  run, before and after it. A run just over leaves what it did until
   *  the farm's new record comes to say so, and the field is made again
   *  from it, the same. */
  private follow(run: Run | null) {
    if (!run) {
      if (this.out) this.out.run = null;
      if (this.strips && this.out) this.strips.paint.reach = 1e9;
      if (this.out && lookOf(this.tiles).stage === this.out.after.stage) this.settle();
      return;
    }
    const after = leaves(run.job, this.look);
    this.out = { run, after };
    this.path = run.path;
    this.strips?.drop();
    this.strips = this.lay(run.path, run.job, [this.look, after]);
    updateTexture2DFromPixels(this.ctx.engine, this.cuts, this.reached(this.strips));
  }

  /** \`cuts\` for these strips: where each piece works, drawn as the GPU
   *  draws it, its distance along read off where each texel's middle
   *  falls, the least where pieces overlap. */
  private reached(strips: Strips | null): Uint8Array {
    const [w, h] = [this.span.x * CUT_RES, this.span.y * CUT_RES];
    const at = new Float32Array(w * h).fill(Infinity);
    const texel = (p: P) => ({ x: (p.x - this.corner.x) * CUT_RES - 0.5, y: (p.y - this.corner.y) * CUT_RES - 0.5 });
    const triangle = (a: P, b: P, c: P, da: number, db: number, dc: number, lo: number, hi: number) => {
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) return;
      const [x0, x1] = [Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x))), Math.min(w - 1, Math.floor(Math.max(a.x, b.x, c.x)))];
      const [y0, y1] = [Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y))), Math.min(h - 1, Math.floor(Math.max(a.y, b.y, c.y)))];
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const u = ((b.x - x) * (c.y - y) - (b.y - y) * (c.x - x)) / area;
          const v = ((c.x - x) * (a.y - y) - (c.y - y) * (a.x - x)) / area;
          if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
          const d = u * da + v * db + (1 - u - v) * dc;
          if (d >= lo && d <= hi) at[y * w + x] = Math.min(at[y * w + x], d);
        }
    };
    for (const { lo, hi, rows } of strips?.pieces ?? [])
      for (let i = 1; i < rows.length; i++) {
        const [a, b] = [rows[i - 1], rows[i]];
        const [al, ar, bl, br] = [texel(a.l), texel(a.r), texel(b.l), texel(b.r)];
        triangle(al, ar, br, a.d, a.d, b.d, lo, hi);
        triangle(al, br, bl, a.d, b.d, b.d, lo, hi);
      }
    const bytes = new Uint8Array(w * h * 4).fill(255);
    at.forEach((d, i) => {
      if (d === Infinity) return;
      const q = Math.min(0xfffffe, Math.max(0, Math.round(d * 256)));
      bytes.set([q >> 16, (q >> 8) & 255, q & 255], i * 4);
    });
    return bytes;
  }

  /** The strips' looks changed as far as the tractor, each crop at the
   *  height it stands. */
  private raise() {
    const { strips, out } = this;
    if (!strips) return;
    if (out?.run) {
      strips.paint.reach = strips.drawn.passing((simNow() - out.run.started) / out.run.pace);
      strips.stir();
    }
    strips.lift(FIELD_Z, out ? [this.look, out.after].map(heightOf) : [heightOf(this.look)]);
    strips.repaint();
  }

  private material(paint: Paint, which: number): TownMaterial {
    return townMaterial([plugin(this.ctx.engine, paint, this.colours, which, this.cuts, this.corner)], 0.95);
  }

  /** The farm's record again, its tiles' stages perhaps moved on: taken
   *  up as the field's look once no run is out, a run's own drawing
   *  standing until then. */
  retile(tiles: Tile[]) {
    this.tiles = tiles;
    if (!this.out?.run && (this.out || lookOf(tiles).stage !== this.look.stage)) this.settle();
  }

  /** The look the tiles are at, over the last run's path. */
  private settle() {
    this.out = null;
    this.look = lookOf(this.tiles);
    this.strips?.drop();
    this.strips = this.lay(this.path, JOB_OF[this.look.stage], [this.look]);
    updateTexture2DFromPixels(this.ctx.engine, this.cuts, new Uint8Array(this.span.x * this.span.y * CUT_RES * CUT_RES * 4).fill(255));
  }

  dispose(): void {
    this.stop();
    this.strips?.drop();
  }
}

/**
 * Each farm's field, kept while its land and ruts are as they were: the
 * farm's record comes again with every crate and every worker, and a field
 * made again for each would stall the frame. Not its tiles' stages: on a
 * run they change tile by tile as the tractor works them, which the run
 * itself draws; made again from them, the field would jump to the look
 * after the run as soon as the last tile was worked, ahead of the
 * tractor. A run's end brings new ruts, and the field is made again then.
 * Let go, it is dropped once the batch that let it go has passed without
 * taking it up again.
 */
const FIELDS = new Map<number, { field: Field; was: string; theme: Theme; held: boolean }>();
export function keepField(ctx: EngineContext, casters: Casters, farm: number, tiles: Tile[], ruts: GridCoord[], theme: Theme): () => void {
  const was = JSON.stringify([tiles.map((t) => t.at), ruts]);
  let kept = FIELDS.get(farm);
  if (kept && kept.was === was && kept.theme === theme) kept.field.retile(tiles);
  else {
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
let bare: Uint8Array | undefined;
function wheat(engine: Engine): Texture2D {
  if (!bare) {
    bare = new Uint8Array(WHEAT_TEXELS * WHEAT_STRIDE * WHEAT_STAGES * 4);
    for (let k = 0; k < bare.length; k += 4) bare.set([128, 128, 200, 0], k);
  }
  return bakedTexture(engine, "wheat", recipe, [WHEAT_TEXELS, WHEAT_STRIDE * WHEAT_STAGES, bare], {
    mipmaps: true,
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "repeat",
  });
}

/** The field's paint (see the top), where across and along its strip a
 *  vertex is, which way across is, and where its piece's tile begins and
 *  ends along it. */
function plugin(engine: Engine, paint: Paint, colours: Rgb[], which: number, cuts: Texture2D, corner: GridCoord): MaterialPlugin {
  return {
    name: "Field",
    priority: 210,
    getAttributes: () => [
      { name: "stripA", type: "vec4<f32>", buffer: "strip" },
      { name: "stripB", type: "vec4<f32>", buffer: "strip" },
      { name: "stripTex", type: "f32" },
    ],
    getVaryings: () => [
      { name: "vStripA", type: "vec4f" },
      { name: "vStripB", type: "vec4f" },
      { name: "vStripTex", type: "f32" },
    ],
    getSamplers: () => [
      { texture: "fieldGrain", sampler: "fieldGrainSampler" },
      { texture: "fieldWheat", sampler: "fieldWheatSampler" },
      { texture: "fieldCuts", sampler: "fieldCutsSampler" },
    ],
    bindTextures: (out) => out.push({ texture: grain(engine) }, { texture: wheat(engine) }, { texture: cuts }),
    getUniforms: () => ({
      ubo: [
        { name: "fieldLook", type: "vec4<f32>" },
        { name: "fieldAfter", type: "vec4<f32>" },
        { name: "fieldEarth", type: "vec4<f32>" },
        { name: "fieldGrowing", type: "vec4<f32>" },
        { name: "fieldRipe", type: "vec4<f32>" },
        { name: "fieldStubble", type: "vec4<f32>" },
      ],
    }),
    writeUbo: (data, offsets) => {
      const put = (name: string, v: number[]) => data.set(v, offsets.get(name)! / 4);
      const [before, after] = [paint.looks[0], paint.looks[1] ?? paint.looks[0]];
      put("fieldLook", [before[0], before[1], paint.reach, which]);
      put("fieldAfter", [after[0], after[1], corner.x, corner.y]);
      ["fieldEarth", "fieldGrowing", "fieldRipe", "fieldStubble"].forEach((name, i) => put(name, [colours[i].r, colours[i].g, colours[i].b, 1]));
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vStripA = stripA; out.vStripB = stripB; out.vStripTex = stripTex;" }
        : { CUSTOM_FRAGMENT_DEFINITIONS: DEFINITIONS, CUSTOM_FRAGMENT_UPDATE_ALPHA: BEGIN, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: DIFFUSE },
  };
}

/** The grain, as value noise: `p` in its texels, 256 to its side. And a
 *  stage of the wheat (`wheat.ts`) at a point of a pass, `u` across it 0
 *  to 1, `v` along it in tiles, read as from a texture of its own, with
 *  how fast `u` and `v` change across the screen, so far off it is read
 *  from a smaller copy, as what it adds up to. */
const DEFINITIONS = `fn fieldNoise(p: vec2f) -> f32 { return textureSample(fieldGrain, fieldGrainSampler, p / 256.).r; }
fn fieldHash(x: f32) -> f32 { return fract(sin(x * 12.9898) * 43758.5453); }
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
let fieldW = input.worldPos.xy;
// Where along the wheat's texture: slid on by a slow swell across the
// land, a few tiles from one to the next, so the same tile of it does not
// come round on a grid; never across, where the rows and tramlines lie.
// Round a turn each part of the pass runs at its own length (\`vStripTex\`,
// how much further than the middle), so the outside is not drawn out
// nor the inside crushed: two copies, each starting over every quarter
// tile and faded out where it does, so neither shears far.
let fieldSwell = 0.7 * fieldNoise(fieldW * 0.3 + vec2f(97., 43.));
let fieldPhase = fieldV * 4.;
// And each tile along, each copy jumps to somewhere else in the wheat
// as it starts over, faded in, so no tile of it repeats the last.
let fieldTexVs = array<f32, 2>(
  (floor(fieldPhase) + fract(fieldPhase) * input.vStripTex) / 4. + fieldSwell + fieldHash(floor(floor(fieldPhase) / 4.)),
  (floor(fieldPhase + 0.5) - 0.5 + fract(fieldPhase + 0.5) * input.vStripTex) / 4. + fieldSwell + fieldHash(floor((floor(fieldPhase + 0.5) - 0.5) / 4.)));
let fieldTexW = 1. - abs(2. * fract(fieldPhase) - 1.);
// Where a tight turn folds the pass on itself, \`fieldV\` leaps across a
// pixel; read no blurrier there than across.
let fieldDvRaw = vec2f(dpdx(fieldV), dpdy(fieldV)) * input.vStripTex;
let fieldDv = fieldDvRaw * min(1., 2. * length(fieldDu) * ${WHEAT_TEXELS}. / max(1e-6, length(fieldDvRaw) * ${WHEAT_TEXELS}.));
let fieldLook = material.fieldLook;
// Broad, soft patches: wetter earth, a crop a little ahead or behind.
let fieldMottle = 0.6 * fieldNoise(fieldW * 2. + vec2f(61., 7.)) + 0.4 * fieldNoise(fieldW * 6. + vec2f(13., 89.));
let fieldEdge = 0.5 * fieldNoise(fieldW * 24. + vec2f(31., 5.)) + 0.5 * fieldNoise(fieldW * 6. + vec2f(3., 201.));
// Behind the tractor the look it leaves, ahead the look before, on a
// ragged line across where it is: when the tractor first reaches the
// pixel (\`Field.cuts\`), read between the four texels round it where they
// are of one pass; across from one pass to another, the nearest; and past
// the strips' edge, the ones in them.
// Read a little off where the pixel is, by a wobble of its own, so every
// edge of the standing crop is ragged, along the passes as across them.
let fieldWobble = vec2f(fieldNoise(fieldW * 45. + vec2f(211., 17.)), fieldNoise(fieldW * 45. + vec2f(59., 233.))) - 0.5;
let fieldCutP = (fieldW + 0.14 * fieldWobble - material.fieldAfter.zw) * ${CUT_RES}. - 0.5;
let fieldCutI = vec2i(floor(fieldCutP));
let fieldCutF = fract(fieldCutP);
let fieldCutMax = vec2i(textureDimensions(fieldCuts)) - 1;
var fieldCutS = vec4f(0.);
for (var i = 0; i < 4; i++) {
  let t = textureLoad(fieldCuts, clamp(fieldCutI + vec2i(i & 1, i >> 1), vec2i(0), fieldCutMax), 0) * 255.;
  fieldCutS[i] = (round(t.r) * 65536. + round(t.g) * 256. + round(t.b)) / 256.;
}
let fieldCutLo = min(min(fieldCutS.x, fieldCutS.y), min(fieldCutS.z, fieldCutS.w));
fieldCutS = select(fieldCutS, vec4f(fieldCutLo), fieldCutS > vec4f(65535.));
let fieldCutNear = fieldCutS[select(0, 1, fieldCutF.x > 0.5) + select(0, 2, fieldCutF.y > 0.5)];
let fieldCutSpread = max(max(fieldCutS.x, fieldCutS.y), max(fieldCutS.z, fieldCutS.w)) - fieldCutLo;
let fieldReached = select(fieldCutNear, mix(mix(fieldCutS.x, fieldCutS.y, fieldCutF.x), mix(fieldCutS.z, fieldCutS.w, fieldCutF.x), fieldCutF.y), fieldCutSpread < 1.);
// The harvest's front ragged: the cut line wanders a tenth of a tile
// either way, and stalks stand a little behind it, clumps go a little
// ahead.
let fieldFront = 0.6 * fieldNoise(fieldW * 40. + vec2f(171., 23.)) + 0.4 * fieldNoise(fieldW * 90. + vec2f(7., 51.));
let fieldLater = fieldReached < 65535. && fieldReached - fieldLook.z < 0.1 * (fieldEdge - 0.5) + 0.14 * (fieldFront - 0.5);
let fieldNow = select(fieldLook.xy, material.fieldAfter.xy, fieldLater);
let fieldStage = u32(fieldNow.x + 0.5);
// How far past its own tile the pixel is, across or past either end: out
// to here the earth reaches, raggedly, and past that only crumbs of it,
// fewer further out, over what lies beside.
let fieldOut = max(max(select(-1., -fieldU, input.vStripB.z > 0.5), select(-1., fieldU - 1., input.vStripB.w > 0.5)), max(input.vStripB.x - fieldV, fieldV - input.vStripB.y));
let fieldCrumb = 0.6 * fieldNoise(fieldW * 40. + vec2f(171., 23.)) + 0.4 * fieldNoise(fieldW * 90. + vec2f(7., 51.));
let fieldRag = 0.09 + 0.06 * fieldEdge;
if (fieldStage == 0u || (fieldOut > fieldRag && fieldCrumb < 0.56 + 3. * (fieldOut - fieldRag))) { discard; }
let fieldDirt = material.fieldEarth.rgb;
// The earth: a dark grey-brown, the field's earth greyed and darkened.
let fieldSoil = mix(fieldDirt, vec3f(dot(fieldDirt, vec3f(0.3, 0.55, 0.15))), 0.45) * 0.55;
let fieldLeaf = material.fieldGrowing.rgb;
let fieldGreen = mix(fieldLeaf, vec3f(dot(fieldLeaf, vec3f(0.3, 0.55, 0.15))), 0.3) * vec3f(0.56, 0.62, 0.52);
// Ripe wheat a pale buff, not a gold: the theme's ripe, mostly greyed.
let fieldRipe = material.fieldRipe.rgb;
let fieldGold = mix(fieldRipe, vec3f(dot(fieldRipe, vec3f(0.3, 0.55, 0.15))), 0.6) * vec3f(0.9, 0.87, 0.78);
// Grain by grain a little paler or duller, a few in a hundred.
let fieldKernel = fieldNoise(fieldW * 140. + vec2f(31., 97.));
let fieldStraw = mix(material.fieldStubble.rgb, material.fieldRipe.rgb, 0.4) * 0.85;
var fieldAt = 0.;
if (fieldStage == 2u) { fieldAt = 1. + 4. * clamp(fieldNow.y, 0., 1.); }
if (fieldStage == 3u) { fieldAt = 6.; }
let fieldFrom = floor(fieldAt);
let fieldTo = min(fieldFrom + 1., 6.);
let fieldPatch = 0.2 + 0.6 * fieldMottle;
let fieldAhead = smoothstep(fieldPatch - 0.2, fieldPatch + 0.2, fieldAt - fieldFrom);
// Out over the land's edge, the crop reaches a little past its tile, on
// a jagged line of its own, short of where the spilled earth ends: bare
// earth between, ploughed as the ploughed field is, nothing growing on it. Over the field's own
// tiles the crop goes on, so no seam of earth shows between passes.
let fieldOff = max(select(-1., -fieldU, input.vStripB.z > 1.5), select(-1., fieldU - 1., input.vStripB.w > 1.5));
let fieldBare = fieldOff > 0.04 + 0.06 * (fieldEdge - 0.5) + 0.04 * (fieldCrumb - 0.5) || input.vStripB.z > 2.5;
var fieldColour = vec3f(0.);
var fieldFacing = vec3f(0.);
var fieldCover = 0.;
for (var i = 0; i < 2; i++) {
  let st = select(select(fieldFrom, fieldTo, i == 1), 0., fieldBare);
  let t = mix(fieldWheatAt(st, fieldU, fieldTexVs[1], fieldDu, fieldDv), fieldWheatAt(st, fieldU, fieldTexVs[0], fieldDu, fieldDv), fieldTexW);
  let soil = fieldSoil * select(select(1., 0.8, st > 5.5), 0.9, st < 0.5);
  var crop = fieldGreen;
  if (st > 3.5) { crop = mix(fieldGreen, fieldGold, 0.25); }
  if (st > 4.5) { crop = fieldGold * mix(vec3f(1.07, 1.05, 0.96), vec3f(0.91, 0.9, 0.88), fieldKernel); }
  if (st > 5.5) { crop = fieldStraw; }
  let c = select(soil, crop, fieldLook.w > 0.5) * t.b * 1.25;
  let w = select(1. - fieldAhead, fieldAhead, i == 1);
  fieldColour += c * w;
  fieldFacing += vec3f(t.rg * 2. - 1., 0.) * w;
  fieldCover += t.a * w;
}
// The crop stands over the earth: on its own mesh, raised, only where a
// plant is, as many as the texel holds, and cast just so; until the
// tractor, cutting, comes. The earth under it is all earth.
let fieldCrop = fieldLook.w > 0.5;
// Each look's crop on a mesh of its own, at its own height: the first
// ahead of the tractor, the second behind.
let fieldMine = select(!fieldLater, fieldLater, fieldLook.w > 1.5);
if (fieldCrop && (fieldBare || !fieldMine || fieldCover < 0.3 + 0.4 * fieldCrumb)) { discard; }`;

/**
 * The paint: the stage of the wheat the field is at (ploughed; sown, by
 * how far grown, drilled, seedlings, grown, in ear, ripe; stubble), and
 * between two, the next showing through in patches as it comes, so a
 * field ripens in waves, not all at once. Each texel its earth's colour
 * or the crop's, as light as it was baked, its facing turned as baked.
 */
const DIFFUSE = `let fieldN = vec3f(fieldFacing.xy, sqrt(max(0.05, 1. - dot(fieldFacing.xy, fieldFacing.xy))));
// A gentle tint, a few in a hundred either way, and no more.
baseColor = fieldColour * (0.94 + 0.12 * fieldMottle);
N = normalize(vec3f(fieldAcross * fieldN.x + vec2f(fieldAcross.y, -fieldAcross.x) * fieldN.y, fieldN.z));`;
