import { Color3 } from "@babylonjs/core";
import earcut from "earcut";
import type { MeshGeometry } from "../Mesh";
import type { Theme } from "../theme";
import { ROAD_Z } from "../objects/roadGeometry";
import { TREE_BODY, TREE_TOP } from "../objects/terrainGeometry";
import { asphalt, dress, pavement, type Dressing } from "./dressing";
import { soften } from "./footprint";
import { facts } from "./facts";
import type { Polygon } from "./footprint";
import type { Tile, Town } from "./grid";
import type { RGB } from "./mass";
import { townMesh } from "./roof";

/** A piece of the town to draw: one mesh, one material. */
export interface Piece {
  name: string;
  geo: MeshGeometry & { colors?: number[] };
  /** The material's colour; white where the vertices carry theirs. */
  colour: Color3 | null;
}

/** A dock's door: dark, in any light. */
const DOOR = new Color3(0.22, 0.24, 0.3);

/** How round a port lane's corners are, as the asphalt's. */
const LANE_ROUND = 0.05;

/** A kerb's height over the grass, under the roads. */
export const PAVED_Z = 0.02;

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
 * The town grid's town, drawn: the pavement, a port's lanes, the
 * buildings, the yards' lines, the lawns and their trees, and a door
 * behind every dock; the roads are `drawRoads`. Geometry alone, in the
 * same frame. What stands on it that moves, the cars, lorries and ferries
 * the dressing would put there, is the caller's: the game draws its own,
 * the sandbox the dressing's.
 */
export function drawTown(town: Town, theme: Theme, colour: (t: Tile) => RGB): { pieces: Piece[]; dressing: Dressing } {
  const pieces: Piece[] = [];
  const add = (name: string, geo: Piece["geo"], c: Color3 | null) => {
    if (geo.indices.length) pieces.push({ name, geo, colour: c });
  };
  add("pavement", flatPolygons(pavement(town), PAVED_Z), theme.paved);
  const known = facts(town);
  const dressing = dress(town, known);
  add("lanes", flatPolygons(soften(dressing.lanes.map((l): Polygon => [l]), LANE_ROUND), ROAD_Z + PAVED_Z), theme.road);
  add("mass", townMesh(town, colour, undefined, known), null);
  add("yard_lines", flat(dressing.yardLines, 0.025), theme.road);
  // Lawns over the pavement: a house stands in its own.
  add("garden", quadsAt(dressing.gardens, PAVED_Z + 0.003), theme.garden);
  // Trees as the forest draws them: a smooth top over a coarse body.
  for (const [name, geo] of [["tree_tops", TREE_TOP], ["tree_bodies", TREE_BODY]] as const) {
    const out: MeshGeometry & { colors: number[] } = { positions: [], normals: [], indices: [], colors: [] };
    for (const t of dressing.trees) {
      const base = out.positions.length / 3;
      const w = 0.35 * t.scale;
      const rgb = theme.crowns[t.shade];
      for (let i = 0; i < geo.positions.length; i += 3) {
        out.positions.push(-(t.x + geo.positions[i] * w), -(t.y + geo.positions[i + 1] * w), geo.positions[i + 2] * w);
        out.normals.push(-geo.normals[i], -geo.normals[i + 1], geo.normals[i + 2]);
        out.colors.push(rgb.r, rgb.g, rgb.b, 1);
      }
      for (const k of geo.indices) out.indices.push(base + k);
    }
    add(name, out, null);
  }
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
  return { pieces, dressing };
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

/** Convex strips laid flat at a height, seen from both sides. */
function flat(polys: [number, number][][], z: number): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const poly of polys) {
    const b0 = g.positions.length / 3;
    for (const [x, y] of poly) g.positions.push(-x, -y, z), g.normals.push(0, 0, 1);
    for (let i = 1; i + 1 < poly.length; i++) g.indices.push(b0, b0 + i + 1, b0 + i, b0, b0 + i, b0 + i + 1);
  }
  return g;
}

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
