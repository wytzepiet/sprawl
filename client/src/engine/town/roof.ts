import earcut from "earcut";
import type { MeshGeometry } from "../geometry";
import type { Tile, Town } from "./grid";
import { BAND, PARAPET_H, PARAPET_W, RECESS, eaves, mansard, planted, slope, type RGB } from "./mass";
import { facts, type Facts } from "./facts";
import { convex, footprints, intersect, shrink, subtract, unite, type Half, type Polygon, type Pt } from "./footprint";

/**
 * The buildings of a town as one mesh: every plan (`footprint.ts`) walled
 * up to its eaves and roofed.
 *
 * Every wall raises a roof face that climbs in from it at one pitch, and
 * the roof over any point is the lowest face there: the face of the
 * nearest wall. So two walls facing each other meet in a ridge, two meeting
 * at an outside corner in a hip, at an inside corner in a valley, wherever
 * the plan puts them and whatever its shape. A face reaches only so far in
 * (a house's to its ridge height; a shed's and a big box's nowhere, as
 * they are flat), and beyond every face the roof is flat.
 *
 * A wall's face is the band within that reach of it, cut at its two ends
 * where it meets its neighbours' faces, on the line halfway between the
 * two walls; then less wherever another wall's face is lower. All of it
 * is straight lines, cut exactly (`footprint.ts`), so nothing is sampled
 * and nothing can fail to meet.
 *
 * Every flat roof has a parapet round its edge, and an office tower's
 * carries its plant: a lift room, AC units, vents.
 */


type V = [number, number, number];
/** A wall's line: how far in from it a point is, a·x + b·y + c. */
type Line = [number, number, number];

/** An office roof's plant, in tiles: how far in from the parapet; the lift
 *  room's length, breadth and height; an AC unit's side and height; a
 *  vent's cap across and height. */
/** A flat roof's bitumen: charcoal, whatever the building's colour (as
 *  a shade of it: the colour × a + b). */
const BITUMEN = [0.05, 0.3] as const;
/** What stands on a high-street place's flat (`kit`), in tiles: how far in
 *  from the flat's edge; an AC unit's side and height; a duct's breadth
 *  and height; an extract stack's breadth (its cowl's) and height; a
 *  dish's breadth and how high it stands; a rooflight's and its dome's. */
const KIT = {
  margin: 0.02,
  ac: 0.085, acHigh: 0.055,
  duct: 0.03, ductHigh: 0.03,
  stack: 0.06, stackHigh: 0.1,
  dish: 0.07, dishHigh: 0.04,
  rooflight: 0.075, rooflightHigh: 0.025,
} as const;
const PLANT = { margin: 0.05, room: [0.26, 0.2, 0.1], ac: 0.12, acHigh: 0.05, vent: 0.045, ventHigh: 0.05 } as const;

/** Every building's plan as it stands: its masses, and the loading bay cut
 *  from each, its corners square. */
export function* plans({ town, head, services }: Facts) {
  const cuts = services.map((s): Polygon => [s.cut]);
  for (const mass of footprints(town, head)) {
    for (const polygon of subtract(mass.polygons, cuts)) yield { mass, polygon, outline: [polygon] };
  }
}

/** How a building's surface is painted, given its tile and the shade it
 *  takes of the building's colour: that colour × a + b, a channel at a
 *  time. The sandbox paints the colour itself (`shaded`); the game paints
 *  the shade and which building, and finds the colour as it draws, so a
 *  building's colour changes without its mesh (`tints.ts`). */
export type Paint = (t: Tile, a: number, b: number) => RGB;

/** Each tile its colour, shaded. */
export const shaded = (colour: (t: Tile) => RGB): Paint => (t, a, b) => colour(t).map((v) => v * a + b) as RGB;

/** What stands on a roof and is drawn as a prop of its own (`props.ts`),
 *  not as the building: an AC unit, a vent; where in the world's frame,
 *  standing on the roof at `z`, how broad and how high. */
export interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  size: number;
  high: number;
  /** A second point: where a duct runs to; where a dish faces. */
  tx: number;
  ty: number;
}
/** The props there are, in the order their codes cross from the worker. */
export const PROP_KINDS = ["ac", "vent", "duct", "stack", "dish", "rooflight"] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export function townMesh(painted: Town, paint: Paint, only?: Set<string>, known = facts(painted)): MeshGeometry & { colors: number[]; props: Prop[] } {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  const props: Prop[] = [];
  /** A prop at a point of the plan, in the world's frame as the triangles are. */
  const prop = (kind: PropKind, [x, y]: Pt, z: number, size: number, high: number, [tx, ty]: Pt = [x, y]) => props.push({ kind, x: -x, y: -y, z, size, high, tx: -tx, ty: -ty });
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

  for (const { mass, polygon, outline } of plans(known)) {
    if (only && !mass.parts.some((part) => part.polygons.flat(2).some(([x, y]) => only.has(`${Math.floor(x)},${Math.floor(y)}`)))) continue;
    const top = eaves(mass.tile);
    const { pitch, height } = slope(mass.tile);
    const reach = height / pitch;
    /** A part's colour, a shade toward white at a row's head, and below
     *  `dim` one a shade darker, above it a shade toward white. */
    const tint = (part: (typeof mass.parts)[number], dim = 1): RGB => {
      let [a, b] = part.head ? [0.55, 0.45] : [1, 0];
      if (dim < 1) [a, b] = [a * dim, b * dim];
      else [a, b] = [a * (2 - dim), b * (2 - dim) + dim - 1];
      return paint(part.tile, a, b);
    };
    /** A region, coloured by the parts it lies in. */
    const cover = (region: Polygon[], z: (p: Pt) => number, dim = 1) => {
      for (const part of mass.parts) {
        const rgb = tint(part, dim);
        for (const piece of mass.parts.length === 1 ? region : intersect(region, part.polygons)) fill(piece, z, rgb);
      }
    };
    const colourAt = (p: Pt): RGB => tint(mass.parts.find((part) => part.polygons.some((poly) => inPolygon(p, poly))) ?? mass.parts[0]);
    /** Walls round a region from z0 up to its top at z1, coloured as the
     *  building is, and the top, a shade darker or lighter by `dim`. */
    const sides = (region: Polygon[], z0: number, z1: (p: Pt) => number) => {
      for (const ring of region.flat()) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          const n: V = [dy / len, -dx / len, 0];
          const c = colourAt([(p[0] + q[0]) / 2 - n[0] * 1e-3, (p[1] + q[1]) / 2 - n[1] * 1e-3]);
          tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1(q)], n, c);
          tri([p[0], p[1], z0], [q[0], q[1], z1(q)], [p[0], p[1], z1(p)], n, c);
        });
      }
    };
    const prism = (region: Polygon[], z0: number, z1: (p: Pt) => number, dim = 1) => {
      sides(region, z0, z1);
      cover(region, z1, dim);
    };
    /** A solid standing on the plan from z0 to z1, walls and top one colour. */
    const solid = (region: Polygon[], z0: number, z1: number, rgb: RGB) => {
      for (const ring of region.flat()) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          const n: V = [dy / len, -dx / len, 0];
          tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], n, rgb);
          tri([p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], n, rgb);
        });
      }
      for (const piece of region) fill(piece, () => z1, rgb);
    };
    /** A flat roof's plant, as an office's has: a lift room at one end of
     *  its length, two AC units at the other and vents along a side, both
     *  props (`props.ts`); clear of the middle, where its sign is painted.
     *  Which end is which goes by where it stands, so it never changes. */
    const plant = (polygon: Polygon, top: number, tile: Tile) => {
      const ring = polygon[0];
      const [x0, y0] = [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))];
      const [x1, y1] = [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
      const long = x1 - x0 >= y1 - y0;
      const [length, width] = long ? [x1 - x0, y1 - y0] : [y1 - y0, x1 - x0];
      const flip = Math.abs(Math.sin(x0 * 12.9898 + y0 * 78.233) * 43758.5453) % 1 > 0.5;
      /** A point `a` along the roof's length from one end, `b` across. */
      const at = (a: number, b: number): Pt => {
        const along = flip ? length - a : a;
        return long ? [x0 + along, y0 + b] : [x0 + b, y0 + along];
      };
      const box = ([cx, cy]: Pt, a: number, b: number): Polygon[] => {
        const [w, h] = long ? [a, b] : [b, a];
        return [[[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]]];
      };
      const m = PARAPET_W + PLANT.margin;
      const [lw, lh] = [Math.min(PLANT.room[0], length * 0.25), Math.min(PLANT.room[1], width - 2 * m)];
      solid(box(at(m + lw / 2, m + lh / 2), lw, lh), top, top + PLANT.room[2], paint(tile, 0.9, 0.2));
      for (let k = 0; k < 2; k++) prop("ac", at(length - m - PLANT.ac / 2, m + PLANT.ac / 2 + k * (PLANT.ac + 0.03)), top, PLANT.ac, PLANT.acHigh);
      for (let k = 0; k < 3; k++) prop("vent", at(m + lw + 0.1 + k * 0.1, width - m - 0.025), top, PLANT.vent, PLANT.ventHigh);
    };
    /** One AC unit in a corner of a small flat roof, which corner by where
     *  the building stands, clear of the sign in its middle. */
    /** What stands on a high-street place's flat, by its corners, which
     *  corner first by where it stands: an AC unit in one; and by its kind,
     *  in the one across from it, a restaurant's extract stack with its
     *  duct run along an edge to it, a bar's satellite dish, a shop's
     *  rooflight with a second unit beside the first for its fridges. */
    const kit = (flat: Polygon[], z: number, tile: Tile) => {
      const all = flat.flat(2);
      if (!all.length) return;
      const [x0, y0] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
      const [x1, y1] = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
      const first = Math.floor((Math.abs(Math.sin(x0 * 12.9898 + y0 * 78.233) * 43758.5453) % 1) * 4);
      /** Corner k (bit 1 the far x, bit 2 the far y), a thing this broad tucked into it. */
      const corner = (k: number, size: number): Pt => {
        const reach = KIT.margin + size / 2;
        return [k & 1 ? x1 - reach : x0 + reach, k & 2 ? y1 - reach : y0 + reach];
      };
      const [across, beside] = [first ^ 3, first ^ 1];
      prop("ac", corner(first, KIT.ac), z, KIT.ac, KIT.acHigh);
      if (tile.kind === "Shop") {
        prop("rooflight", corner(across, KIT.rooflight), z, KIT.rooflight, KIT.rooflightHigh);
        prop("ac", corner(beside, KIT.ac), z, KIT.ac, KIT.acHigh);
      }
    };
    /** A flat roof's parapet: a low wall round its edge, its coping a shade
     *  lighter, so the roof reads as a roof and not a box's lid. */
    const parapet = (region: Polygon[], z: number) => prism(subtract(region, shrink(region, PARAPET_W)), z, () => z + PARAPET_H, 1.08);

    // The roof over a point of the plan: as high as it is far in from
    // the nearest wall, to its reach.
    const walls = polygon.flatMap((ring) => ring.map((p, i): [Pt, Pt] => [p, ring[(i + 1) % ring.length]]));
    const roofAt = (p: Pt) => top + pitch * Math.min(reach, ...walls.map(([a, b]) => toSegment(p, a, b)));
    // Walls: every edge of every ring, from the ground to the roof; the
    // roof's faces and its flat are what cover them.
    sides(outline, 0, roofAt);
    const faces = reach > 0 ? roofFaces(polygon, reach) : [];
    for (const { line, region } of faces) {
      cover(intersect(region, outline), ([x, y]) => top + pitch * Math.min(reach, Math.max(0, line[0] * x + line[1] * y + line[2])));
    }
    const flat = subtract(outline, unite(faces.flatMap((f) => f.region)));
    if (mansard(mass.tile)) {
      // A mansard's flat behind its slope: at the slope's top a flat band
      // round a hole, capped along the slope's edge; and in the hole,
      // sunk below it, the flat, bitumen, an AC unit in a corner.
      const [rim, sunk] = [top + height, top + height - RECESS];
      const hole = shrink(flat, BAND);
      cover(subtract(flat, hole), () => rim);
      // The step down to it walled, facing in: never seen from above, but
      // the sun would slip through the gap and draw the hole on the ground.
      for (const ring of hole.flat()) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          const inward: V = [-dy / len, dx / len, 0];
          const c = colourAt(p);
          tri([p[0], p[1], sunk], [q[0], q[1], sunk], [q[0], q[1], rim], inward, c);
          tri([p[0], p[1], sunk], [q[0], q[1], rim], [p[0], p[1], rim], inward, c);
        });
      }
      for (const piece of hole) fill(piece, () => sunk, paint(mass.tile, ...BITUMEN));
      kit(hole, sunk, mass.tile);
    } else cover(flat, () => top + height);
    if (height === 0) parapet(outline, top);
    if (planted(mass.tile)) plant(polygon, top, mass.tile);
  }
  return { positions, normals, colors, indices, props };
}

/** Each wall's face of a roof that climbs `reach` in from its walls: its
 *  wall's line, and where on the plan it is the lowest face. */
export function roofFaces(polygon: Polygon, reach: number): { line: Line; region: Polygon[] }[] {
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
