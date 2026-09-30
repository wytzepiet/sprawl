import earcut from "earcut";
import type { MeshGeometry } from "../Mesh";
import type { BuildingKind } from "../../generated";
import type { Town } from "./grid";
import { eaves, roofOf, slope, type RGB } from "./mass";
import { hash } from "./dressing";
import { facts } from "./facts";
import { blunt, convex, footprints, intersect, shrink, subtract, unite, type Half, type Polygon, type Pt } from "./footprint";

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
 *
 * Then the outside corners are rounded off from above, roof and all, as a
 * cutter would: the roof keeps its sharp ridges and hips, and a rounded
 * wall rises to wherever the roof is over it.
 *
 * Flats, offices and big boxes are capped instead: a flat roof, and on it
 * a second slab drawn in from the edge. And now and then a roof has a
 * quirk, a thing a model town's maker would stick on: a plant room on a
 * cap, a chimney on a house, rooflights across a shed. Each is a plain
 * box, and where it goes comes from the tile it stands on alone.
 */

/** A cap's slab: how far in from the edge, and how high. */
const CAP_IN = 0.1, CAP_H = 0.035;
const PLANT: RGB = [0.8, 0.8, 0.83];
const GLASS: RGB = [0.9, 0.94, 0.97];

/** How round a building's outside corners are, from above. */
const CORNER = 0.06;

type V = [number, number, number];
/** A wall's line: how far in from it a point is, a·x + b·y + c. */
type Line = [number, number, number];

export function townMesh(painted: Town, colour: (k: BuildingKind) => RGB, only?: Set<string>): MeshGeometry & { colors: number[] } {
  const { town, head, services } = facts(painted);
  // A service lane is cut from its building, and its bump added.
  const cuts = services.map((s): Polygon => [s.cut]);
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
    const paint = (region: Polygon[], z: (p: Pt) => number, dim = 1) => {
      for (const part of mass.parts) {
        // Below one a shade darker, above it a shade toward white.
        const rgb = tint(part).map((v) => (dim < 1 ? v * dim : v + (1 - v) * (dim - 1))) as RGB;
        for (const piece of mass.parts.length === 1 ? region : intersect(region, part.polygons)) fill(piece, z, rgb);
      }
    };
    const colourAt = (p: Pt): RGB => tint(mass.parts.find((part) => part.polygons.some((poly) => inPolygon(p, poly))) ?? mass.parts[0]);
    /** Walls round a region from z0 up to its top at z1, coloured as the
     *  building is, or in `rgb`, and the top. */
    const prism = (region: Polygon[], z0: number, z1: (p: Pt) => number, rgb?: RGB, dim = 1) => {
      for (const ring of region.flat()) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          const n: V = [dy / len, -dx / len, 0];
          const c = rgb ?? colourAt([(p[0] + q[0]) / 2 - n[0] * 1e-3, (p[1] + q[1]) / 2 - n[1] * 1e-3]);
          tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1(q)], n, c);
          tri([p[0], p[1], z0], [q[0], q[1], z1(q)], [p[0], p[1], z1(p)], n, c);
        });
      }
      if (rgb) for (const poly of region) fill(poly, z1, rgb);
      else paint(region, z1, dim);
    };
    /** A box on the roof, `w` by `d` round (x, y), from z0 up to z1. */
    const block = ([x, y]: Pt, w: number, d: number, z0: number, z1: number, rgb: RGB) =>
      prism([[[[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]]]], z0, () => z1, rgb);
    /** The middles of the tiles a region covers, well inside it. */
    const middles = (region: Polygon[]) => {
      const all = region.flat(2);
      const out: [number, number][] = [];
      for (let r = Math.floor(Math.min(...all.map((p) => p[1]))); r < Math.max(...all.map((p) => p[1])); r++) {
        for (let c = Math.floor(Math.min(...all.map((p) => p[0]))); c < Math.max(...all.map((p) => p[0])); c++) {
          if (region.some((poly) => inPolygon([c + 0.5, r + 0.5], poly))) out.push([c, r]);
        }
      }
      return out;
    };
    const kind = roofOf(mass.tile);

    const bumps = services.map((s): Polygon => [s.bump]).filter((b) => intersect([b], mass.polygons).length);
    for (const polygon of unite([...subtract(mass.polygons, cuts), ...bumps])) {
      const outline = blunt([polygon], CORNER);
      // The roof over a point of the plan: as high as it is far in from
      // the nearest wall, to its reach.
      const walls = polygon.flatMap((ring) => ring.map((p, i): [Pt, Pt] => [p, ring[(i + 1) % ring.length]]));
      const roofAt = (p: Pt) => top + pitch * Math.min(reach, ...walls.map(([a, b]) => toSegment(p, a, b)));
      if (kind === "cap") {
        // Walls to the eaves, a flat roof a shade darker, and on it the
        // slab a shade lighter; now and then a plant room on the slab.
        prism(outline, 0, () => top, undefined, 0.82);
        const slab = shrink(outline, CAP_IN);
        prism(slab, top, () => top + CAP_H, undefined, 1.15);
        const room = shrink(slab, 0.12);
        for (const [c, r] of middles(room)) {
          if (hash(c, r, 31) > 0.3) continue;
          const p: Pt = [c + 0.3 + 0.4 * hash(c, r, 32), r + 0.3 + 0.4 * hash(c, r, 33)];
          if (room.some((poly) => inPolygon(p, poly))) block(p, 0.2, 0.14, top + CAP_H, top + CAP_H + 0.06, PLANT);
        }
        continue;
      }
      // Walls: every edge of every ring, from the ground to the roof.
      prism(outline, 0, roofAt);
      const faces = roofFaces(polygon, reach);
      for (const { line, region } of faces) {
        paint(intersect(region, outline), ([x, y]) => top + pitch * Math.min(reach, Math.max(0, line[0] * x + line[1] * y + line[2])));
      }
      const flat = subtract(outline, unite(faces.flatMap((f) => f.region)));
      paint(flat, () => top + height);
      if (kind === "shed" && !mass.parts.some((part) => part.head)) {
        // Rooflights: pale strips across the hall's flat top, its short
        // way, two to a tile; none on an office end.
        const all = flat.flat(2);
        if (!all.length) continue;
        const [x0, y0, x1, y1] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
        const across = x1 - x0 < y1 - y0;
        const strips: Polygon[] = [];
        for (let t = (across ? y0 : x0) + 0.2; t < (across ? y1 : x1) - 0.15; t += 0.5) {
          strips.push(across ? [[[x0, t], [x1, t], [x1, t + 0.1], [x0, t + 0.1]]] : [[[t, y0], [t + 0.1, y0], [t + 0.1, y1], [t, y1]]]);
        }
        for (const poly of intersect(strips, shrink(flat, 0.05))) fill(poly, () => top + height + 0.004, GLASS);
      } else {
        // Now and then a chimney, on the ridge over a tile's middle.
        for (const [c, r] of middles(shrink(outline, 0.12))) {
          if (hash(c, r, 41) > 0.25) continue;
          const p: Pt = [c + 0.5 + 0.15 * (hash(c, r, 42) - 0.5), r + 0.5];
          block(p, 0.08, 0.08, roofAt(p) - 0.03, roofAt(p) + 0.07, tint(mass.parts[0]).map((v) => v * 0.7) as RGB);
        }
      }
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

/** How far a point is from a segment. */
function toSegment([x, y]: Pt, [ax, ay]: Pt, [bx, by]: Pt) {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
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
