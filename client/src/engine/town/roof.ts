import earcut from "earcut";
import type { MeshGeometry, P } from "../geometry";
import type { Tile, Town } from "./grid";
import { AWNING, OPENING, PARAPET_H, PARAPET_W, SPAN, TOOTH, eaves, formOf, planted, sawtooth, slope } from "./mass";
import type { RGB } from "../rgb";
import { facts, type Facts } from "./facts";
import { convex, footprints, intersect, shrink, subtract, unite, type Half, type Polygon } from "./footprint";

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
/** A sawtooth shed's stack, in tiles: how far in from the back corner it
 *  stands, which is its breadth, and how high; and how broad its puffs of
 *  smoke grow. */
const MILL = { stack: 0.09, stackHigh: 0.62, puff: 0.15 } as const;
const PLANT = { margin: 0.05, room: [0.26, 0.2, 0.1], ac: 0.12, acHigh: 0.05, vent: 0.045, ventHigh: 0.05 } as const;

/** Every building's plan as it stands: its masses, a polygon at a time. */
export function* plans({ town }: Facts) {
  for (const mass of footprints(town)) {
    for (const polygon of mass.polygons) yield { mass, polygon, outline: [polygon] };
  }
}

/** How a building's surface is painted, given its tile and the shade it
 *  takes of the building's colour: that colour × a + b, a channel at a
 *  time. The game paints the shade and which building, and finds the
 *  colour as it draws, so a building's colour changes without its mesh
 *  (`tints.ts`). */
export type Paint = (t: Tile, a: number, b: number) => RGB;

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
export const PROP_KINDS = ["ac", "vent", "duct", "stack", "dish", "rooflight", "lamp", "smoke"] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export function townMesh(painted: Town, paint: Paint, only?: Set<string>, known = facts(painted)): MeshGeometry & { colors: number[]; props: Prop[] } {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  const props: Prop[] = [];
  /** A prop at a point of the plan, in the world's frame as the triangles are. */
  const prop = (kind: PropKind, [x, y]: P, z: number, size: number, high: number, [tx, ty]: P = [x, y]) => props.push({ kind, x: -x, y: -y, z, size, high, tx: -tx, ty: -ty });
  /** A triangle in the fixture's frame, turned into the world's (+x to the
   *  screen's left, +y up) and wound to face along `n`. */
  /** A triangle in the fixture's frame, `lit` 0 if it is glass, which
   *  glows at night (`TownLayer`'s masses). */
  const tri = (p: V, q: V, s: V, n: V, rgb: RGB, lit = 1) => {
    const world = (v: V): V => [-v[0], -v[1], v[2]];
    let [a, b, e] = [world(p), world(q), world(s)];
    const wn = world(n);
    const g = [(b[1] - a[1]) * (e[2] - a[2]) - (b[2] - a[2]) * (e[1] - a[1]), (b[2] - a[2]) * (e[0] - a[0]) - (b[0] - a[0]) * (e[2] - a[2]), (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0])];
    if (g[0] * wn[0] + g[1] * wn[1] + g[2] * wn[2] > 0) [b, e] = [e, b];
    const base = positions.length / 3;
    for (const v of [a, b, e]) positions.push(...v), normals.push(...wn), colors.push(...rgb, lit);
    indices.push(base, base + 1, base + 2);
  };
  /** A flat polygon, triangulated, each point lifted by `z`. */
  const fill = (polygon: Polygon, z: (p: P) => number, rgb: RGB) => {
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

  /** The way from a building to the street its door opens onto, by its id. */
  let doors: Map<number, P> | undefined;
  const doorOf = (t: Tile) => {
    if (!doors) {
      doors = new Map();
      for (let r = 0; r < painted.h; r++)
        for (let c = 0; c < painted.w; c++) {
          const d = painted.door?.(c, r), id = painted.tile(c, r).id;
          if (d && id !== undefined) doors.set(id, [d[0] / Math.hypot(...d), d[1] / Math.hypot(...d)]);
        }
    }
    return t.id === undefined ? undefined : doors.get(t.id);
  };
  for (const plan of plans(known)) {
    const { mass } = plan;
    const f = doorOf(mass.tile);
    // A sawmill is an L: one of its front corners left open for its plank
    // shed, the other side by its id (`BuildingObject.tsx`).
    const polygon = mass.tile.kind === "Sawmill" && f ? opened(plan.polygon, f, mass.tile.id! % 2 ? 1 : -1) : plan.polygon;
    const outline = [polygon];
    if (only && !mass.parts.some((part) => part.polygons.flat(2).some(([x, y]) => only.has(`${Math.floor(x)},${Math.floor(y)}`)))) continue;
    const top = eaves(mass.tile);
    const { pitch, height } = slope(mass.tile);
    const reach = height / pitch;
    /** A part's colour: below `dim` one a shade darker, above it a shade
     *  toward white. */
    const tint = (part: (typeof mass.parts)[number], dim = 1): RGB =>
      dim < 1 ? paint(part.tile, dim, 0) : paint(part.tile, 2 - dim, dim - 1);
    /** A region, coloured by the parts it lies in. */
    const cover = (region: Polygon[], z: (p: P) => number, dim = 1) => {
      for (const part of mass.parts) {
        const rgb = tint(part, dim);
        for (const piece of mass.parts.length === 1 ? region : intersect(region, part.polygons)) fill(piece, z, rgb);
      }
    };
    const partAt = (p: P) => mass.parts.find((part) => part.polygons.some((poly) => inPolygon(p, poly))) ?? mass.parts[0];
    const colourAt = (p: P): RGB => tint(partAt(p));
    /** Walls round a region from z0 up to its top at z1, coloured as the
     *  building is, and the top, a shade darker or lighter by `dim`. */
    const sides = (region: Polygon[], z0: number, z1: (p: P) => number) => {
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
    const prism = (region: Polygon[], z0: number, z1: (p: P) => number, dim = 1) => {
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
      const at = (a: number, b: number): P => {
        const along = flip ? length - a : a;
        return long ? [x0 + along, y0 + b] : [x0 + b, y0 + along];
      };
      const box = ([cx, cy]: P, a: number, b: number): Polygon[] => {
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
      const corner = (k: number, size: number): P => {
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
    /** A sawtooth roof over the flat: strips across the way to the door,
     *  each a slope from its back up TOOTH to its front, where a glazed
     *  face stands, a pale shade, toward the door; the walls under each
     *  slope's sides rise with it. */
    const teeth = (region: Polygon[], z: number, [fx, fy]: P) => {
      const all = region.flat(2);
      const s = ([x, y]: P) => x * fx + y * fy;
      const back = Math.min(...all.map(s)), deep = Math.max(...all.map(s)) - back;
      // An even count, so a ridge stands across the middle, where an L's
      // open corner begins (`opened`).
      const n = 2 * Math.max(1, Math.round(deep / (2 * SPAN))), span = deep / n;
      const box: [number, number, number, number] = [Math.min(...all.map((p) => p[0])) - 1, Math.min(...all.map((p) => p[1])) - 1, Math.max(...all.map((p) => p[0])) + 1, Math.max(...all.map((p) => p[1])) + 1];
      for (let k = 0; k < n; k++) {
        const [s0, s1] = [back + k * span, back + (k + 1) * span];
        const strip = intersect(region, [[convex([[-fx, -fy, -s0], [fx, fy, s1]], box)]]);
        const at = (p: P) => z + (TOOTH * (s(p) - s0)) / span;
        cover(strip, at, 0.92);
        for (const ring of strip.flat()) {
          ring.forEach((p, i) => {
            const q = ring[(i + 1) % ring.length];
            if (at(p) - z < 1e-6 && at(q) - z < 1e-6) return;
            const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
            const len = Math.hypot(dx, dy);
            let nrm: V = [dy / len, -dx / len, 0];
            const mid: P = [(p[0] + q[0]) / 2 + nrm[0] * 1e-3, (p[1] + q[1]) / 2 + nrm[1] * 1e-3];
            if (strip.some((poly) => inPolygon(mid, poly))) nrm = [-nrm[0], -nrm[1], 0];
            const front = Math.abs(s(p) - s1) < 1e-6 && Math.abs(s(q) - s1) < 1e-6;
            const c = front ? paint(mass.tile, 0.25, 0.55) : colourAt(mid);
            tri([p[0], p[1], z], [q[0], q[1], z], [q[0], q[1], at(q)], nrm, c, front ? 0 : 1);
            tri([p[0], p[1], z], [q[0], q[1], at(q)], [p[0], p[1], at(p)], nrm, c, front ? 0 : 1);
          });
        }
      }
      // At the back, its stack in a corner.
      const u = ([x, y]: P) => -x * fy + y * fx;
      const u1 = Math.max(...all.map(u));
      const on = (a: number, b: number): P => [a * fx - b * fy, a * fy + b * fx];
      prop("stack", on(back + MILL.stack, u1 - MILL.stack), z, MILL.stack, MILL.stackHigh);
      prop("smoke", on(back + MILL.stack, u1 - MILL.stack), z + MILL.stackHigh, MILL.puff, 0);
    };
    /** Windows and doors on every wall, by rule: a row of windows to a
     *  storey, evenly along the wall within its ends, each glass in a
     *  chunky cream frame, the glass lit at night. On the wall toward the
     *  door, the ground floor has a door every third window (a shop's
     *  windows between them wide, its shop front), or a shed's one big
     *  door in the middle. */
    const openings = (region: Polygon[], top: number) => {
      for (const ring of region.flat()) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(dx, dy);
          if (len < OPENING.pitch + 2 * OPENING.end) return;
          const n: P = [dy / len, -dx / len], t: P = [dx / len, dy / len];
          const part = partAt([(p[0] + q[0]) / 2 - n[0] * 1e-3, (p[1] + q[1]) / 2 - n[1] * 1e-3]);
          const tile = part.tile, f = doorOf(tile);
          const front = !!f && n[0] * f[0] + n[1] * f[1] > 0.9;
          const shed = formOf(tile).family !== "street";
          /** A quad on the wall, `a` along it, from z0 to z1, `w` wide, `off` out. */
          const pane = (a: number, w: number, z0: number, z1: number, off: number, rgb: RGB, lit = 1) => {
            const at = (b: number, z: number): V => [p[0] + t[0] * b + n[0] * off, p[1] + t[1] * b + n[1] * off, z];
            const nrm: V = [n[0], n[1], 0];
            tri(at(a - w / 2, z0), at(a + w / 2, z0), at(a + w / 2, z1), nrm, rgb, lit);
            tri(at(a - w / 2, z0), at(a + w / 2, z1), at(a - w / 2, z1), nrm, rgb, lit);
          };
          const cream = paint(tile, 0.08, 0.84), glass = paint(tile, 0, 0.26), door = paint(tile, 0.55, 0);
          const window = (a: number, w: number, z0: number, z1: number) => {
            pane(a, w + 2 * OPENING.frame, z0 - OPENING.frame, z1 + OPENING.frame, 0.003, cream);
            pane(a, w, z0, z1, 0.005, glass, 0);
          };
          const big = shed && front ? OPENING.shedDoor : 0;
          const cols = Math.floor((len - 2 * OPENING.end) / OPENING.pitch) + 1;
          const first = (len - (cols - 1) * OPENING.pitch) / 2;
          if (big) {
            pane(len / 2, big + 2 * OPENING.frame, 0, OPENING.shedHigh + OPENING.frame, 0.003, cream);
            pane(len / 2, big, 0, OPENING.shedHigh, 0.005, door);
          }
          for (let k = 0; ; k++) {
            // The ground floor stands 0.1 higher than the others, its windows higher in it.
            const z0 = k === 0 ? 0.07 : 0.13 + 0.12 * k, z1 = z0 + OPENING.high;
            if (z1 > top - 0.02) break;
            for (let j = 0; j < cols; j++) {
              const a = first + j * OPENING.pitch;
              if (big && Math.abs(a - len / 2) < big / 2 + OPENING.wide / 2) continue;
              if (k === 0 && front && !shed && j % 3 === 1) {
                pane(a, OPENING.door + 2 * OPENING.frame, 0, OPENING.doorHigh + OPENING.frame, 0.003, cream);
                pane(a, OPENING.door, 0, OPENING.doorHigh, 0.005, door);
              } else window(a, k === 0 && front && tile.kind === "Shop" ? OPENING.pitch - 2.5 * OPENING.frame : OPENING.wide, z0, z1);
            }
          }
        });
      }
    };
    /** A shop's awning: over the middle of its front, the wall toward its
     *  door, from AWNING.at of the way up the wall out and down, in
     *  stripes of its colour and cream, a valance at its hem. */
    const awning = (polygons: Polygon[], tile: Tile) => {
      const f = doorOf(tile);
      if (!f) return;
      let front: [P, P] | undefined, best = 0;
      for (const ring of polygons.flatMap((poly) => poly.slice(0, 1))) {
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length];
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const facing = ((q[1] - p[1]) * f[0] - (q[0] - p[0]) * f[1]) / len;
          if (facing > 0.9 && len > best) [front, best] = [[p, q], len];
        });
      }
      if (!front) return;
      const [p, q] = front;
      const t: P = [(q[0] - p[0]) / best, (q[1] - p[1]) / best];
      const w = best * AWNING.span, n = Math.max(3, Math.round(w / AWNING.stripe) | 1);
      const mid: P = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const z0 = top * AWNING.at, z1 = z0 - AWNING.drop;
      const at = (a: number, out: number, z: number): V => [mid[0] + t[0] * a + f[0] * out, mid[1] + t[1] * a + f[1] * out, z];
      const up: V = [f[0] * AWNING.drop, f[1] * AWNING.drop, AWNING.out];
      const l = Math.hypot(...up);
      const nUp = up.map((v) => v / l) as V, nDown = nUp.map((v) => -v) as V, nOut: V = [f[0], f[1], 0];
      for (let k = 0; k < n; k++) {
        const [a0, a1] = [-w / 2 + (k * w) / n, -w / 2 + ((k + 1) * w) / n];
        const rgb = k % 2 ? paint(tile, 1, 0) : paint(tile, 0.08, 0.84);
        const [b0, b1, c0, c1] = [at(a0, 0.002, z0), at(a1, 0.002, z0), at(a0, AWNING.out, z1), at(a1, AWNING.out, z1)];
        for (const nrm of [nUp, nDown]) tri(b0, b1, c1, nrm, rgb), tri(b0, c1, c0, nrm, rgb);
        const [d0, d1] = [at(a0, AWNING.out, z1 - 0.02), at(a1, AWNING.out, z1 - 0.02)];
        tri(c0, c1, d1, nOut, rgb), tri(c0, d1, d0, nOut, rgb);
      }
    };
    /** A flat roof's parapet: a low wall round its edge, its coping a shade
     *  lighter, so the roof reads as a roof and not a box's lid. */
    const parapet = (region: Polygon[], z: number) => prism(subtract(region, shrink(region, PARAPET_W)), z, () => z + PARAPET_H, 1.08);

    // The roof over a point of the plan: as high as it is far in from
    // the nearest wall, to its reach.
    const walls = polygon.flatMap((ring) => ring.map((p, i): [P, P] => [p, ring[(i + 1) % ring.length]]));
    const roofAt = (p: P) => top + pitch * Math.min(reach, ...walls.map(([a, b]) => toSegment(p, a, b)));
    // Walls: every edge of every ring, from the ground to the roof; the
    // roof's faces and its flat are what cover them.
    sides(outline, 0, roofAt);
    openings(outline, top);
    const faces = reach > 0 ? roofFaces(polygon, reach) : [];
    for (const { line, region } of faces) {
      cover(intersect(region, outline), ([x, y]) => top + pitch * Math.min(reach, Math.max(0, line[0] * x + line[1] * y + line[2])));
    }
    const flat = subtract(outline, unite(faces.flatMap((f) => f.region)));
    if (sawtooth(mass.tile) && f) teeth(flat, top, f);
    else cover(flat, () => top + height);
    if (height === 0 && !sawtooth(mass.tile)) parapet(outline, top);
    if (mass.tile.kind === "Shop") {
      kit(shrink(flat, PARAPET_W), top, mass.tile);
      for (const part of mass.parts) awning(part.polygons, part.tile);
    }
    if (planted(mass.tile)) plant(polygon, top, mass.tile);
  }
  return { positions, normals, colors, indices, props };
}

/** A plan less its front corner on one side (`side` along the front, its
 *  left looking out of the door `f`, or its right): the quarter in front
 *  of its middle that way. */
function opened(polygon: Polygon, [fx, fy]: P, side: number): Polygon {
  const ring = polygon[0];
  const along = ([x, y]: P) => x * fx + y * fy, across = ([x, y]: P) => -x * fy + y * fx;
  const mid = (g: (p: P) => number) => (Math.min(...ring.map(g)) + Math.max(...ring.map(g))) / 2;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const corner = convex([[-fx, -fy, -mid(along)], [side * fy, -side * fx, -side * mid(across)]], [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1]);
  return subtract([polygon], [[corner]])[0] ?? polygon;
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
  interface Wall { line: Line; dir: P }
  const walls: { wall: Wall; prev: Wall; next: Wall }[] = [];
  for (const ring of polygon) {
    const ws: Wall[] = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const dir: P = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      // The building is on the left.
      const [a, b] = [-dir[1], dir[0]];
      return { line: [a, b, -(a * p[0] + b * p[1])], dir };
    });
    ws.forEach((wall, i) => walls.push({ wall, prev: ws[(i + ws.length - 1) % ws.length], next: ws[(i + 1) % ws.length] }));
  }
  /** Where `e` is no further in than `g`. */
  const nearer = (e: Line, g: Line): Half => [e[0] - g[0], e[1] - g[1], g[2] - e[2]];
  const turn = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
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
function toSegment([x, y]: P, [ax, ay]: P, [bx, by]: P) {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function inPolygon(p: P, polygon: Polygon) {
  const inRing = ([x, y]: P, ring: P[]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  return inRing(p, polygon[0]) && !polygon.slice(1).some((h) => inRing(p, h));
}
