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
    { name: "street", geo: kerbed(flatPolygons(street, ROAD_Z + PAVED_Z)), colour: theme.road },
    // Over the streets that meet it: a street's end runs on under it.
    { name: "through", geo: kerbed(flatPolygons(through, ROAD_Z + PAVED_Z + 0.001)), colour: theme.highway },
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
  add("pavement", rimmed(flatPolygons(pavement(town), PAVED_Z)), theme.paved);
  const known = facts(town);
  const dressing = dress(town, known);
  add("lanes", flatPolygons(soften(dressing.lanes.map((l): Polygon => [l]), LANE_ROUND), ROAD_Z + PAVED_Z), theme.road);
  add("mass", townMesh(town, colour, undefined, known), null);
  add("yard_lines", flat(dressing.yardLines, 0.025), theme.road);
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

/** How wide a sheet's rounded rim is, in tiles. */
export const RIM = 0.05;

/** An edge the sheet runs on past: a point just outside it is still
 *  covered, as where one tile's road overlaps the next. */
export function runsOn(g: MeshGeometry) {
  const p = g.positions;
  const inside = (x: number, y: number) => {
    for (let t = 0; t < g.indices.length; t += 3) {
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

/** An edge outside a road tile's own square, as drawn for its instance
 *  (x and y the other way, -1 to 0): where it runs on into the next. */
export const pastTile = (a: number[], b: number[]) => {
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return mx <= -1 + 1e-3 || mx >= -1e-3 || my <= -1 + 1e-3 || my >= -1e-3;
};

/** Road, rimmed only where it ends, not where its tiles overlap. */
const kerbed = (g: MeshGeometry) => rimmed(g, RIM, runsOn(g));

/**
 * A flat sheet with its outline rounded down, as a kerb's top is: a strip
 * just inside every edge only one of its triangles has, facing up at its
 * inner side and halfway out at the edge, so the light rolls over it (laid a hair
 * over the sheet). Its corners mitred, so the strip turns them whole; none
 * where `skip` says the sheet runs on into another.
 */
export function rimmed(g: MeshGeometry, width = RIM, skip: (a: number[], b: number[], out: number[]) => boolean = () => false): MeshGeometry {
  const p = g.positions;
  const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const key = (v: number[]) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)}`;
  const count = new Map<string, number>();
  const tris: number[][] = [];
  for (let t = 0; t < g.indices.length; t += 3) {
    const tri = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
    tris.push(tri);
    for (let k = 0; k < 3; k++) {
      const [ka, kb] = [key(at(tri[k])), key(at(tri[(k + 1) % 3]))];
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  // The outline: each edge one triangle has, facing away from it.
  const edges: { a: number[]; b: number[]; out: number[]; z: number }[] = [];
  const outAt = new Map<string, number[]>();
  for (const tri of tris) {
    const v = tri.map(at);
    const c = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [v[k], v[(k + 1) % 3]];
      const [ka, kb] = [key(a), key(b)];
      if (count.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`) !== 1) continue;
      const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(ex, ey) || 1;
      let out = [ey / len, -ex / len];
      if ((a[0] - c[0]) * out[0] + (a[1] - c[1]) * out[1] < 0) out = [-out[0], -out[1]];
      if (skip(a, b, out)) continue;
      edges.push({ a, b, out, z: a[2] });
      for (const [kv] of [[ka], [kb]]) {
        const o = outAt.get(kv) ?? [0, 0];
        outAt.set(kv, [o[0] + out[0], o[1] + out[1]]);
      }
    }
  }
  if (!edges.length) return g;
  const up = Math.sign(cross0(g)) || 1;
  const out = { positions: [...g.positions], normals: [...g.normals], indices: [...g.indices] };
  const LIFT = 0.0005;
  for (const e of edges) {
    // Each end pulled in along its corner's mitre, as far as makes the
    // strip `width` wide along the edge.
    const inner = [e.a, e.b].map((v) => {
      const m = outAt.get(key(v))!;
      const ml = Math.hypot(m[0], m[1]) || 1;
      const mu = [m[0] / ml, m[1] / ml];
      const d = width / Math.max(mu[0] * e.out[0] + mu[1] * e.out[1], 0.35);
      return { pos: [v[0] - mu[0] * d, v[1] - mu[1] * d, e.z + LIFT], out: mu };
    });
    const b0 = out.positions.length / 3;
    out.positions.push(e.a[0], e.a[1], e.z + LIFT, e.b[0], e.b[1], e.z + LIFT, ...inner[0].pos, ...inner[1].pos);
    // At the edge, halfway between up and out, as a bevel turns to the
    // halfway between its two faces: rounded, and still in the light.
    const half = (o: number[]) => [o[0] * Math.SQRT1_2, o[1] * Math.SQRT1_2, Math.SQRT1_2];
    out.normals.push(...half(inner[0].out), ...half(inner[1].out), 0, 0, 1, 0, 0, 1);
    const [i0, i1, i2, i3] = [b0, b0 + 1, b0 + 2, b0 + 3];
    // Wound as the sheet is, so it faces the same way.
    const tri = (a: number, b: number, c: number) => {
      const s = Math.sign(crossZ(out.positions, a, b, c));
      out.indices.push(...(s === up ? [a, b, c] : [a, c, b]));
    };
    tri(i0, i1, i3);
    tri(i0, i3, i2);
  }
  return out;
}

function crossZ(p: number[], a: number, b: number, c: number) {
  return (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]);
}
/** Which way a sheet's triangles wind, seen from above. */
function cross0(g: MeshGeometry) {
  return g.indices.length ? crossZ(g.positions, g.indices[0], g.indices[1], g.indices[2]) : 1;
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
