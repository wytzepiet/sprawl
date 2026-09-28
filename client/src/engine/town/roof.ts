import earcut from "earcut";
import type { MeshGeometry } from "../Mesh";
import type { BuildingKind } from "../../generated";
import type { Town } from "./grid";
import { eaves, slope, type RGB } from "./mass";
import { facts } from "./facts";
import { convex, footprints, intersect, subtract, unite, type Half, type Polygon, type Pt } from "./footprint";

/**
 * The buildings of a town as one mesh: every plan (`footprint.ts`) walled
 * up to its eaves and roofed.
 *
 * Every wall raises a roof face that climbs in from it at one pitch, and
 * the roof over any point is the lowest face there: the face of the
 * nearest wall. So two walls facing each other meet in a ridge, two meeting
 * at an outside corner in a hip, at an inside corner in a valley, wherever
 * the plan puts them and whatever its shape. A face reaches only so far in
 * (a house's to its ridge height, a shed's to a low rim), and beyond every
 * face the roof is flat.
 *
 * A wall's face is the band within that reach of it, cut at its two ends
 * where it meets its neighbours' faces, on the line halfway between the
 * two walls; then less wherever another wall's face is lower. All of it
 * is straight lines, cut exactly (`footprint.ts`), so nothing is sampled
 * and nothing can fail to meet.
 */

type V = [number, number, number];
/** A wall's line: how far in from it a point is, a·x + b·y + c. */
type Line = [number, number, number];

export function townMesh(painted: Town, colour: (k: BuildingKind) => RGB, only?: Set<string>): MeshGeometry & { colors: number[] } {
  const { town, head } = facts(painted);
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  /** A triangle in the fixture's frame, turned into the world's (+x to the
   *  screen's left, +y up) and wound to face along `n`. */
  const tri = (p: V, q: V, s: V, n: V, rgb: RGB) => {
    const world = (v: V): V => [-v[0], -v[1], v[2]];
    let [a, b, e] = [world(p), world(q), world(s)];
    const wn = world(n);
    const g = [(b[1] - a[1]) * (e[2] - a[2]) - (b[2] - a[2]) * (e[1] - a[1]), (b[2] - a[2]) * (e[0] - a[0]) - (b[0] - a[0]) * (e[2] - a[2]), (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0])];
    if (g[0] * wn[0] + g[1] * wn[1] + g[2] * wn[2] > 0) [b, e] = [e, b];
    const base = positions.length / 3;
    for (const v of [a, b, e]) positions.push(...v), normals.push(...wn), colors.push(...rgb, 1);
    indices.push(base, base + 1, base + 2);
  };
  /** A flat polygon, triangulated, each point lifted by `z`. */
  const fill = (polygon: Polygon, z: (p: Pt) => number, rgb: RGB) => {
    const flat = polygon.flat();
    const holes: number[] = [];
    let at = 0;
    for (const ring of polygon.slice(0, -1)) holes.push((at += ring.length));
    const ids = earcut(flat.flat(), holes);
    for (let i = 0; i < ids.length; i += 3) {
      const [p, q, s] = [ids[i], ids[i + 1], ids[i + 2]].map((k): V => [flat[k][0], flat[k][1], z(flat[k])]);
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
      let n: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n);
      if (len < 1e-12) continue;
      n = n.map((x) => x / len) as V;
      if (n[2] < 0) n = n.map((x) => -x) as V;
      tri(p, q, s, n, rgb);
    }
  };

  for (const mass of footprints(town, head)) {
    if (only && !mass.parts.some((part) => part.polygons.flat(2).some(([x, y]) => only.has(`${Math.floor(x)},${Math.floor(y)}`)))) continue;
    const top = eaves(mass.tile);
    const { pitch, height } = slope(mass.tile);
    const reach = height / pitch;
    const tint = (part: (typeof mass.parts)[number]): RGB =>
      colour(part.tile.kind as BuildingKind).map((v) => (part.head ? v + (1 - v) * 0.45 : v)) as RGB;
    /** A region, coloured by the parts it lies in. */
    const paint = (region: Polygon[], z: (p: Pt) => number) => {
      for (const part of mass.parts) {
        for (const piece of mass.parts.length === 1 ? region : intersect(region, part.polygons)) fill(piece, z, tint(part));
      }
    };
    const colourAt = (p: Pt): RGB => tint(mass.parts.find((part) => part.polygons.some((poly) => inPolygon(p, poly))) ?? mass.parts[0]);

    for (const polygon of mass.polygons) {
      // Walls: every edge of every ring, from the ground to the eaves. The
      // building is on each ring's left.
      for (const ring of polygon) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          const n: V = [dy / len, -dx / len, 0];
          const rgb = colourAt([(p[0] + q[0]) / 2 - n[0] * 1e-3, (p[1] + q[1]) / 2 - n[1] * 1e-3]);
          tri([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], top], n, rgb);
          tri([p[0], p[1], 0], [q[0], q[1], top], [p[0], p[1], top], n, rgb);
        });
      }
      const faces = roofFaces(polygon, reach);
      for (const { line, region } of faces) {
        paint(region, ([x, y]) => top + pitch * Math.min(reach, Math.max(0, line[0] * x + line[1] * y + line[2])));
      }
      paint(subtract([polygon], unite(faces.flatMap((f) => f.region))), () => top + height);
    }
  }
  return { positions, normals, colors, indices };
}

/** Each wall's face of a roof that climbs `reach` in from its walls: its
 *  wall's line, and where on the plan it is the lowest face. */
function roofFaces(polygon: Polygon, reach: number): { line: Line; region: Polygon[] }[] {
  const all = polygon.flat();
  const box: [number, number, number, number] = [
    Math.min(...all.map((p) => p[0])) - 1, Math.min(...all.map((p) => p[1])) - 1,
    Math.max(...all.map((p) => p[0])) + 1, Math.max(...all.map((p) => p[1])) + 1,
  ];
  // Every wall: its line, and the walls before and after it.
  interface Wall { line: Line; dir: Pt }
  const walls: { wall: Wall; prev: Wall; next: Wall }[] = [];
  for (const ring of polygon) {
    const ws: Wall[] = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const dir: Pt = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      // The building is on the left.
      const [a, b] = [-dir[1], dir[0]];
      return { line: [a, b, -(a * p[0] + b * p[1])], dir };
    });
    ws.forEach((wall, i) => walls.push({ wall, prev: ws[(i + ws.length - 1) % ws.length], next: ws[(i + 1) % ws.length] }));
  }
  /** Where `e` is no further in than `g`. */
  const nearer = (e: Line, g: Line): Half => [e[0] - g[0], e[1] - g[1], g[2] - e[2]];
  const turn = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
  // Where each wall's face could be: within reach, on the building's side,
  // and on its side of the line halfway to each neighbour. At an outside
  // corner that side is the one nearer this wall; at an inside corner, the
  // one nearer the other.
  const bands = walls.map(({ wall, prev, next }) => {
    const [e, g, h] = [wall.line, prev.line, next.line];
    const halves: Half[] = [
      [-e[0], -e[1], e[2]],
      [e[0], e[1], reach - e[2]],
      turn(prev.dir, wall.dir) > 0 ? nearer(e, g) : nearer(g, e),
      turn(wall.dir, next.dir) > 0 ? nearer(e, h) : nearer(h, e),
    ];
    const ring = convex(halves, box);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    return { halves, ring, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  const overlap = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const same = (e: Line, f: Line) => Math.abs(e[0] - f[0]) + Math.abs(e[1] - f[1]) + Math.abs(e[2] - f[2]) < 1e-9;

  return walls.map(({ wall }, i) => {
    const mine = bands[i];
    if (mine.ring.length < 3) return { line: wall.line, region: [] };
    // Less wherever another wall's face is lower; of two walls on one
    // line, the first keeps what they share.
    const lower: Polygon[] = [];
    bands.forEach((other, j) => {
      if (j === i || other.ring.length < 3 || !overlap(mine.bounds, other.bounds)) return;
      const f = walls[j].wall.line;
      if (same(wall.line, f) && j > i) return;
      const ring = convex([...other.halves, nearer(f, wall.line)], box);
      if (ring.length >= 3) lower.push([ring]);
    });
    const region = intersect([[mine.ring]], [polygon]);
    return { line: wall.line, region: lower.length ? subtract(region, lower) : region };
  });
}

function inPolygon(p: Pt, polygon: Polygon) {
  const inRing = ([x, y]: Pt, ring: Pt[]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  return inRing(p, polygon[0]) && !polygon.slice(1).some((h) => inRing(p, h));
}
