import earcut from "earcut";
import type { MeshGeometry } from "../geometry";
import { rgb, type Rgb } from "../rgb";
import type { Theme } from "../theme";
import { ROAD_Z } from "../objects/roadGeometry";
import { dress, HEDGE_THICK, type Dressing, type Hedge } from "./dressing";
import { pavement } from "./surface";
import { facts } from "./facts";
import { area, type Polygon } from "./footprint";
import type { Town } from "./grid";
import { BLUEPRINTS } from "../../blueprints";
import type { BuildingKind } from "../../generated";
import { townMesh, type Paint, type Prop } from "./roof";

/** A piece of the town to draw: one mesh, one material. */
export interface Piece {
  name: string;
  geo: MeshGeometry & { colors?: number[] };
  /** The material's colour; white where the vertices carry theirs. */
  colour: Rgb | null;
}

/** A quay's wall, stone a shade under the paving, and its capping, a
 *  shade over it. */
const QUAY = rgb(0.6, 0.58, 0.54);
const CAP = rgb(0.88, 0.86, 0.81);
/** How far down a quay's wall stands, past the water's surface; and how
 *  broad its capping is, along the edge. */
const QUAY_FOOT = -0.78;
const CAP_W = 0.07;

/** How far over the grass the roads lie. */
export const PAVED_Z = 0.02;
/** The paving's height: over the roads, which are cut into it, a kerb's
 *  step down to them (`kerbs.ts`). */
export const KERB_Z = ROAD_Z + PAVED_Z + 0.012;
/** The order the ground's layers are drawn in (a mesh's `renderOrder`;
 *  anything else is drawn at 100): from the top down, so a pixel covered by
 *  a roof, the paving, a road or a field is thrown out by the depth test before the
 *  layers under it are shaded, as they would be if drawn first. Saves a
 *  frame a tenth or more over a town (`bun run cost`), more at night, when
 *  each shaded pixel pays for the lamps over it. */
export const LAYER_ORDER = { mass: 80, pavement: 85, road: 90, field: 95, ground: 120 };
/** The lines painted on a yard's asphalt, just over it: a worn white. */
const LINE_Z = ROAD_Z + PAVED_Z + 0.002;
const LINE = rgb(0.82, 0.81, 0.77);

/**
 * The town grid's town, drawn: the pavement, the
 * buildings; the roads are the game's
 * (`roads.ts`).
 * Geometry alone, in the same frame, and the lines painted on the yards'
 * asphalt. The trees the dressing plants are the caller's to plant
 * (`treeInstances`), and what stands on its roofs and its street lamps the
 * props' (`props.ts`); what moves on it the game draws itself.
 */
export function drawTown(town: Town, theme: Theme, paint: Paint, known = facts(town)): { pieces: Piece[]; dressing: Dressing; props: Prop[] } {
  const pieces: Piece[] = [];
  const add = (name: string, geo: Piece["geo"], c: Rgb | null) => {
    if (geo.indices.length) pieces.push({ name, geo, colour: c });
  };
  const paved = pavement(town);
  add("pavement", flatPolygons(paved, KERB_Z), theme.paved);
  const { wall, cap } = quay(town, paved);
  add("quay", wall, QUAY);
  add("quayCap", cap, CAP);
  const dressing = dress(town, known);
  const mass = townMesh(town, paint, undefined, known);
  add("mass", mass, null);
  // Each wound as the sheets' outlines are.
  add("lines", flatPolygons(dressing.yardLines.map((q) => [area(q) < 0 ? [...q].reverse() : q]), LINE_Z), LINE);
  add("hedges", hedgeMesh(dressing.hedges), HEDGE);
  // A street lamp stands on the pavement, a prop like what stands on a roof.
  const lamps = dressing.lamps.map((l): Prop => ({ kind: "lamp", x: -l.x, y: -l.y, z: KERB_Z, size: 0, high: 0, tx: -l.hx, ty: -l.hy }));
  return { pieces, dressing, props: [...mass.props, ...lamps] };
}

/** A hedge's green, how high it stands, and how far in its top's edges
 *  are rounded off. */
const HEDGE = rgb(0.29, 0.43, 0.24);
const HEDGE_HIGH = 0.1;
const HEDGE_ROUND = 0.025;

/** Each hedge a long block on the pavement, its top's edges bevelled,
 *  for the light to round. */
function hedgeMesh(hedges: Hedge[]): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  const face = (pts: number[][], n: number[]) => {
    const base = g.positions.length / 3;
    for (const [x, y, z] of pts) g.positions.push(-x, -y, z), g.normals.push(-n[0], -n[1], n[2]);
    const [a, b, c] = pts;
    const cross = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    // Wound as the masses are, clockwise seen from outside.
    const flip = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0;
    for (let i = 1; i + 1 < pts.length; i++) g.indices.push(base, base + (flip ? i + 1 : i), base + (flip ? i : i + 1));
  };
  const [lo, hi, r, w] = [KERB_Z, KERB_Z + HEDGE_HIGH, HEDGE_ROUND, HEDGE_THICK / 2];
  // Its cross-section, out from its line and up: foot, shoulder, top.
  const ring = [[-w, lo], [-w, hi - r], [-w + r, hi], [w - r, hi], [w, hi - r], [w, lo]];
  for (const [[x0, y0], [x1, y1]] of hedges) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const [ux, uy] = [(x1 - x0) / len, (y1 - y0) / len];
    const [vx, vy] = [-uy, ux];
    const at = ([x, y]: number[], [o, z]: number[]) => [x + vx * o, y + vy * o, z];
    for (let i = 0; i + 1 < ring.length; i++) {
      const [a, b] = [ring[i], ring[i + 1]];
      // Out of the section, a quarter turn from the way round it.
      const [no, nz] = [a[1] - b[1], b[0] - a[0]];
      const l = Math.hypot(no, nz);
      face([at([x0, y0], a), at([x1, y1], a), at([x1, y1], b), at([x0, y0], b)], [(vx * no) / l, (vy * no) / l, nz / l]);
    }
    for (const [[x, y], s] of [[[x0, y0], -1], [[x1, y1], 1]] as [number[], number][]) face(ring.map((p) => at([x, y], p)), [ux * s, uy * s, 0]);
  }
  return g;
}

/**
 * A quay: wherever a harbour's paving meets the water, its edge is a wall
 * straight down into it, and along the top a capping of lighter stone.
 * The terrain's coast steps back under it (`TerrainChunks`), so no beach,
 * cliff or foam is left at its foot; anything else paved by the water
 * keeps its shore. Along each edge of the paving, a wall where the tile
 * on one side of it is water and the other a harbour's, facing the water.
 */
function quay(town: Town, paved: Polygon[]): { wall: MeshGeometry; cap: MeshGeometry } {
  const wall: MeshGeometry = { positions: [], normals: [], indices: [] };
  const cap: MeshGeometry = { positions: [], normals: [], indices: [] };
  const kind = ([x, y]: number[]) => town.tile(Math.floor(x), Math.floor(y)).kind;
  const quayed = (k: string) => !!BLUEPRINTS[k as BuildingKind]?.quay;
  for (const ring of paved.flat()) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) return;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      const at = (s: number) => [m[0] + n[0] * s, m[1] + n[1] * s];
      if (kind(at(-0.08)) === "water" && quayed(kind(at(0.08)))) n = [-n[0], -n[1]];
      else if (kind(at(0.08)) !== "water" || !quayed(kind(at(-0.08)))) return;
      // The map's frame is the plan's turned half round.
      const p = (q: number[], o: number, z: number): number[] => [-(q[0] - n[0] * o), -(q[1] - n[1] * o), z];
      face(wall, [p(a, 0, KERB_Z), p(b, 0, KERB_Z), p(b, 0, QUAY_FOOT), p(a, 0, QUAY_FOOT)], [-n[0], -n[1], 0]);
      face(cap, [p(a, 0, KERB_Z + 0.004), p(b, 0, KERB_Z + 0.004), p(b, CAP_W, KERB_Z + 0.004), p(a, CAP_W, KERB_Z + 0.004)], [0, 0, 1]);
    });
  }
  return { wall, cap };
}

/** A flat quad, its corners in order round it, facing `n`: wound as the
 *  front faces are, every triangle its own three vertices. */
function face(g: MeshGeometry, [p0, p1, p2, p3]: number[][], n: number[]) {
  for (const [a, b, c] of [[p0, p1, p2], [p0, p2, p3]]) {
    const [u, v] = [[b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]];
    const out = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2];
    for (const q of out < 0 ? [a, b, c] : [a, c, b]) g.positions.push(q[0], q[1], q[2]), g.normals.push(n[0], n[1], n[2]);
    g.indices.push(g.indices.length, g.indices.length + 1, g.indices.length + 2);
  }
}

/** Trees as instances of the forest's: a matrix and a colour each, in the
 *  town's frame, x and y the other way. */
export function treeInstances(trees: Dressing["trees"], theme: Theme): { matrices: Float32Array; colors: Float32Array } {
  const matrices = new Float32Array(trees.length * 16);
  const colors = new Float32Array(trees.length * 4);
  trees.forEach((t, i) => {
    const w = 0.35 * t.scale;
    const rgb = theme.crowns[t.shade];
    // Turned about: column-major, translation in the last row.
    matrices.set([-w, 0, 0, 0, 0, -w, 0, 0, 0, 0, w, 0, -t.x, -t.y, 0, 1], i * 16);
    colors.set([rgb.r, rgb.g, rgb.b, 1], i * 4);
  });
  return { matrices, colors };
}

/** Polygons laid flat at a height. */
export function flatPolygons(polys: Polygon[], z: number): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const poly of polys) {
    const flatPts = poly.flat();
    const holes: number[] = [];
    let at = 0;
    for (const ring of poly.slice(0, -1)) holes.push((at += ring.length));
    const ids = earcut(flatPts.flat(), holes);
    const b0 = g.positions.length / 3;
    for (const [x, y] of flatPts) g.positions.push(-x, -y, z), g.normals.push(0, 0, 1);
    for (let i = 0; i < ids.length; i += 3) g.indices.push(b0 + ids[i], b0 + ids[i + 2], b0 + ids[i + 1]);
  }
  return g;
}

/** How wide a sheet's rounded rim is, in tiles. */
export const RIM = 0.03;

/** An edge the sheet runs on past: a point just outside it is still
 *  covered, as where one tile's road overlaps the next. */
export function covers(g: MeshGeometry) {
  const p = g.positions;
  // Triangles filed by the rows of a tenth of a tile they cross: a point
  // asks only those crossing its row, and of those only the ones whose
  // breadth holds it.
  const ROW = 0.1;
  const rows = new Map<number, number[]>();
  const box: number[] = [];
  for (let t = 0; t < g.indices.length; t += 3) {
    const xs = [0, 1, 2].map((k) => p[g.indices[t + k] * 3]), ys = [0, 1, 2].map((k) => p[g.indices[t + k] * 3 + 1]);
    box.push(Math.min(...xs), Math.max(...xs));
    for (let r = Math.floor(Math.min(...ys) / ROW); r <= Math.floor(Math.max(...ys) / ROW); r++) (rows.get(r) ?? rows.set(r, []).get(r)!).push(t);
  }
  const inside = (x: number, y: number) => {
    for (const t of rows.get(Math.floor(y / ROW)) ?? []) {
      if (x < box[(t / 3) * 2] || x > box[(t / 3) * 2 + 1]) continue;
      const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1]]);
      const s1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      const s2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
      const s3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    }
    return false;
  };
  return (a: number[], b: number[], out: number[]) => inside((a[0] + b[0]) / 2 + out[0] * 1e-3, (a[1] + b[1]) / 2 + out[1] * 1e-3);
}
