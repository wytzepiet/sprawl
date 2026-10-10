import earcut from "earcut";
import type { MeshGeometry } from "../geometry";
import type { Theme } from "../theme";
import { ROAD_Z } from "../objects/roadGeometry";
import { asphalt, dress, pavement, type Dressing } from "./dressing";
import { facts } from "./facts";
import type { Polygon } from "./footprint";
import type { Tile, Town } from "./grid";
import type { RGB } from "./mass";
import { townMesh, type Paint, type Prop } from "./roof";

/** A piece of the town to draw: one mesh, one material. */
export interface Piece {
  name: string;
  geo: MeshGeometry & { colors?: number[] };
  /** The material's colour; white where the vertices carry theirs. */
  colour: Colour | null;
}

/** A colour as plain numbers: a theme's, or one of the town's own. */
export type Colour = { r: number; g: number; b: number };

/** A dock's door: dark, in any light. */
const DOOR: Colour = { r: 0.22, g: 0.24, b: 0.3 };

/** How far over the grass the roads lie. */
export const PAVED_Z = 0.02;
/** The paving's height: over the roads, which are cut into it, a kerb's
 *  step down to them (`kerbs.ts`). */
export const KERB_Z = ROAD_Z + PAVED_Z + 0.012;

/**
 * The town grid's roads, drawn: the asphalt of the streets and the drives
 * that lead off them, and the through roads over them. Geometry alone, in
 * the fixture's frame turned into the world's (+x to the screen's left, +y
 * up, as `townMesh` lays it); whoever shows it places it. Each tile's road
 * is its own piece, so this is cheap over a whole map.
 */
export function drawRoads(town: Town, theme: Theme): Piece[] {
  const { street, through } = asphalt(town);
  return [
    { name: "street", geo: flatPolygons(street, ROAD_Z + PAVED_Z), colour: theme.road },
    // Over the streets that meet it: a street's end runs on under it.
    { name: "through", geo: flatPolygons(through, ROAD_Z + PAVED_Z + 0.001), colour: theme.highway },
  ].filter((p) => p.geo.indices.length);
}

/**
 * The town grid's town, drawn: the pavement, the
 * buildings, and a door behind every dock; the roads are `drawRoads`.
 * Geometry alone, in the same frame. The yards' lines are the caller's to
 * paint on the pavement (`stripLines`), and the trees the dressing plants
 * its to plant (`treeInstances`), and what stands on its roofs the props'
 * (`props.ts`), as is what stands on it that moves, the
 * cars, lorries and ferries the dressing would put there: the game draws
 * its own, the sandbox the dressing's.
 */
export function drawTown(town: Town, theme: Theme, paint: Paint, known = facts(town)): { pieces: Piece[]; dressing: Dressing; props: Prop[] } {
  const pieces: Piece[] = [];
  const add = (name: string, geo: Piece["geo"], c: Colour | null) => {
    if (geo.indices.length) pieces.push({ name, geo, colour: c });
  };
  add("pavement", flatPolygons(pavement(town), KERB_Z), theme.paved);
  const dressing = dress(town, known);
  const mass = townMesh(town, paint, undefined, known);
  add("mass", mass, null);
  // A door in the wall behind every dock, just proud of it.
  const doors: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const dock of dressing.docks) {
    const [ux, uy] = [Math.cos(dock.angle), Math.sin(dock.angle)];
    const [dx, dy, half] = [dock.x + ux * 0.004, dock.y + uy * 0.004, 0.11];
    const b0 = doors.positions.length / 3;
    for (const [x, y, z] of [[dx - uy * half, dy + ux * half, 0.03], [dx + uy * half, dy - ux * half, 0.03], [dx + uy * half, dy - ux * half, 0.22], [dx - uy * half, dy + ux * half, 0.22]]) {
      doors.positions.push(-x, -y, z), doors.normals.push(-ux, -uy, 0);
    }
    doors.indices.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2, b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
  }
  add("doors", doors, DOOR);
  return { pieces, dressing, props: mass.props };
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
export function runsOn(g: MeshGeometry) {
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

/** An edge wholly past the seam along one of a road tile's arms that
 *  runs on into the next tile, as drawn for its instance (x and y the
 *  other way, its middle at -0.5, -0.5): the end of the overlap, which the
 *  next tile covers. An edge that only reaches past it keeps its rim, and
 *  the two tiles' rims meet over the seam; where a bend bulges out past
 *  its square, between its arms, it keeps its rim too. */
export const pastSeam = (ways: [number, number, boolean][]) => (a: number[], b: number[]) =>
  ways.some(([dc, dr, on]) => {
    if (!on) return false;
    const len = Math.hypot(dc, dr);
    const along = (p: number[]) => ((p[0] + 0.5) * -dc + (p[1] + 0.5) * -dr) / len;
    return Math.min(along(a), along(b)) > len / 2 - 0.01;
  });


/** Flat squares on some tiles, a little over the ground. */
export function quadsAt(cells: [number, number][], z: number): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const [c, r] of cells) {
    const b = g.positions.length / 3;
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) g.positions.push(-(c + dx), -(r + dy), z), g.normals.push(0, 0, 1);
    g.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return g;
}
