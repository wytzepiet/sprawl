import { isBuilt, type Town } from "./grid";
import { defaultJoins, type Polygon, type Pt } from "./footprint";
import { facts as factsOf } from "./facts";
import { asphalt, hash } from "./dressing";
import { formOf } from "./mass";
import { CAB, CAR, TRAILER } from "../objects/roadGeometry";

/**
 * A spike: the town on a subgrid. Every tile is N by N subcells, every
 * subcell four triangles (toward north, east, south and west), and every
 * triangle has one owner: the road, a building, a drive, a parked car, a
 * lorry. A whole subcell is four triangles; half of one, cut on its
 * diagonal, two; so a forty-five degree edge is as exact as a square one.
 *
 * Things are stamped in a fixed order, each taking only what is still
 * free: the road, then loading bays (cut from the building that comes
 * later), drives, car parks, buildings, and last the cars along the kerb.
 * Nothing can stand on anything else: a claim that would overlap fails.
 */

/** Subcells to a tile, each way: a subcell is a quarter tile, three metres. */
export const N = 4;
const Q = 1 / N;

export type Use = "road" | "building" | "drive" | "aisle" | "spot" | "car" | "lorry";
export interface Pose {
  x: number;
  y: number;
  angle: number;
  colour: number;
}
export interface Piece {
  use: Use;
  /** A building's kind. */
  kind?: string;
  /** What stands on it: cars, or a lorry by its tail. */
  poses: Pose[];
}

export class Sub {
  readonly w: number;
  readonly h: number;
  /** Each triangle's piece, by index; -1 free. */
  readonly owner: Int32Array;
  readonly pieces: Piece[] = [];
  constructor(tw: number, th: number) {
    this.w = tw * N;
    this.h = th * N;
    this.owner = new Int32Array(this.w * this.h * 4).fill(-1);
  }
  /** Triangle t (0 north, 1 east, 2 south, 3 west) of subcell (i, j). */
  tri(i: number, j: number, t: number) {
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : (j * this.w + i) * 4 + t;
  }
  /** The triangle a point (in tiles) is in. */
  find(x: number, y: number) {
    const [sx, sy] = [x * N, y * N];
    const [i, j] = [Math.floor(sx), Math.floor(sy)];
    const [dx, dy] = [sx - i - 0.5, sy - j - 0.5];
    return this.tri(i, j, Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 0 : 2) : dx > 0 ? 1 : 3);
  }
  /** Who holds a point. */
  at(x: number, y: number): Piece | undefined {
    const k = this.find(x, y);
    return k < 0 || this.owner[k] < 0 ? undefined : this.pieces[this.owner[k]];
  }
  /** A new piece on these triangles, if every one is free. */
  claim(tris: number[], piece: Piece): boolean {
    if (!tris.length || tris.some((k) => k < 0 || this.owner[k] >= 0)) return false;
    const id = this.pieces.push(piece) - 1;
    for (const k of tris) this.owner[k] = id;
    return true;
  }
  /** A triangle's corners, in tiles. */
  corners(k: number): Pt[] {
    const t = k & 3, cell = k >> 2;
    const [i, j] = [cell % this.w, Math.floor(cell / this.w)];
    const c: Pt[] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    return [c[t], c[(t + 1) % 4], [i + 0.5, j + 0.5]].map(([x, y]): Pt => [x * Q, y * Q]);
  }
  /** Each piece's ground, as polygons. */
  region(id: number): Polygon[] {
    const out: Polygon[] = [];
    for (let k = 0; k < this.owner.length; k++) if (this.owner[k] === id) out.push([this.corners(k)]);
    return out;
  }
}

/** Every triangle of a block of whole subcells. */
const block = (sub: Sub, i: number, j: number, w: number, h: number) => {
  const out: number[] = [];
  for (let b = j; b < j + h; b++) for (let a = i; a < i + w; a++) for (let t = 0; t < 4; t++) out.push(sub.tri(a, b, t));
  return out;
};

/** A subcell of tile (c, r), `kd` in from its edge toward `d` and `ks` in
 *  from its edge toward `s` (d and s square to each other). */
function cell(c: number, r: number, d: number[], kd: number, s: number[], ks: number): [number, number] {
  const k = (e: number[], n: number, axis: 0 | 1) => (e[axis] > 0 ? N - 1 - n : e[axis] < 0 ? n : -1);
  const i = d[0] ? k(d, kd, 0) : k(s, ks, 0);
  const j = d[1] ? k(d, kd, 1) : k(s, ks, 1);
  return [c * N + i, r * N + j];
}

function inside([x, y]: Pt, polygon: Polygon) {
  let hit = false;
  for (const ring of polygon) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a], [xb, yb] = ring[b];
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) hit = !hit;
    }
  }
  return hit;
}

/** Every free triangle whose middle is inside `region`, for one piece. */
function raster(sub: Sub, region: Polygon[], piece: Piece) {
  const id = sub.pieces.push(piece) - 1;
  for (const poly of region) {
    const xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
    const [i0, i1] = [Math.max(0, Math.floor(Math.min(...xs) * N)), Math.min(sub.w - 1, Math.floor(Math.max(...xs) * N))];
    const [j0, j1] = [Math.max(0, Math.floor(Math.min(...ys) * N)), Math.min(sub.h - 1, Math.floor(Math.max(...ys) * N))];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (let t = 0; t < 4; t++) {
          const k = sub.tri(i, j, t);
          if (sub.owner[k] >= 0) continue;
          const c = sub.corners(k);
          if (inside([(c[0][0] + c[1][0] + c[2][0]) / 3, (c[0][1] + c[1][1] + c[2][1]) / 3], poly)) sub.owner[k] = id;
        }
      }
    }
  }
}

/** Whichever of these triangles are free, for one piece. */
function fill(sub: Sub, tris: number[], piece: Piece) {
  const id = sub.pieces.push(piece) - 1;
  for (const k of tris) if (k >= 0 && sub.owner[k] < 0) sub.owner[k] = id;
}

const colour = (x: number, y: number, salt: number) => Math.floor(hash(Math.round(x * 100), Math.round(y * 100), salt) * 8);
const SIDES = [[0, 1], [0, -1], [1, 0], [-1, 0]];

export function subdivide(town: Town): Sub {
  const f = factsOf(town);
  const sub = new Sub(town.w, town.h);
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";

  // The road, as the asphalt lays it.
  const { street, through } = asphalt(town, []);
  raster(sub, [...street, ...through], { use: "road", poses: [] });
  const isRoad = (x: number, y: number) => sub.at(x, y)?.use === "road";

  // Loading bays: three subcells along the wall, one in from it, the
  // corner's margin and two cut from the shop; the lorry's tail at the
  // inner end.
  for (const { corner: [c, r], d, s } of f.services) {
    const cells = [0, 1, 2].map((ks) => cell(c, r, d, 1, s, ks));
    const tris = cells.flatMap(([i, j]) => block(sub, i, j, 1, 1));
    const [ti, tj] = cells[2];
    // The inner end of the last subcell, toward -s.
    const [x, y] = [(ti + 0.5 - s[0] * 0.5) * Q + s[0] * 0.04, (tj + 0.5 - s[1] * 0.5) * Q + s[1] * 0.04];
    sub.claim(tris, { use: "lorry", poses: [{ x, y, angle: Math.atan2(s[1], s[0]), colour: 0 }] });
  }

  // Drives: a house with a street straight past its front, down a side it
  // is joined to nothing on with open ground there; the margin on that
  // side, front to back wall, and the verge across the road's edge.
  const joined = town.joins ?? defaultJoins(town);
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (town.tile(c, r).kind !== "House") continue;
      const front = SIDES.find(([fx, fy]) => {
        const [x, y] = [c + fx, r + fy];
        return road(x, y) && (town.linked(x, y, x - fy, y + fx) || town.linked(x, y, x + fy, y - fx));
      });
      if (!front) continue;
      const side = [[-front[1], front[0]], [front[1], -front[0]]].find(([sx, sy]) => {
        const t = town.tile(c + sx, r + sy);
        return !isBuilt(t) && t.kind !== "road" && t.kind !== "water" && !joined(c, r, c + sx, r + sy);
      });
      if (!side) continue;
      const cells = [0, 1, 2].map((kf) => cell(c, r, front, kf, side, 0));
      cells.push(cell(c + front[0], r + front[1], [-front[0], -front[1]], 0, side, 0));
      // Its mouth on the road: past the verge, the asphalt.
      const [mi, mj] = cells[3];
      if (!isRoad((mi + 0.5 + front[0]) * Q, (mj + 0.5 + front[1]) * Q)) continue;
      // One car, or two nose to tail, nose to the house.
      const n = hash(c, r, 41) < 0.5 ? 1 : 2;
      const [i, j] = cells[2];
      const nose: Pt = [(i + 0.5 - front[0] * 0.5) * Q + front[0] * 0.02, (j + 0.5 - front[1] * 0.5) * Q + front[1] * 0.02];
      const poses = Array.from({ length: n }, (_, k): Pose => {
        const back = CAR.l / 2 + k * (CAR.l + 0.04);
        return { x: nose[0] + front[0] * back, y: nose[1] + front[1] * back, angle: Math.atan2(-front[1], -front[0]), colour: Math.floor(hash(c, r, 43 + k) * 8) };
      });
      sub.claim(cells.flatMap(([a, b]) => block(sub, a, b, 1, 1)), { use: "drive", poses });
    }
  }

  // Car parks: on a tile beside its street, an aisle along the street two
  // subcells deep, and against the far side four bays nose in, a subcell
  // wide and two deep; the verge before it its mouth.
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (f.yard(c, r) !== "cars") continue;
      const g = SIDES.find(([dc, dr]) => road(c + dc, r + dr));
      if (!g) continue;
      const along = [-g[1], g[0]];
      const aisle = [0, 1, 2, 3].flatMap((ks) => [0, 1].map((kg) => cell(c, r, g, kg, along, ks)));
      aisle.push(...[0, 1, 2, 3].map((ks) => cell(c + g[0], r + g[1], [-g[0], -g[1]], 0, along, ks)));
      sub.claim(aisle.flatMap(([a, b]) => block(sub, a, b, 1, 1)), { use: "aisle", poses: [] });
      for (let ks = 0; ks < N; ks++) {
        const bay = [2, 3].map((kg) => cell(c, r, g, kg, along, ks));
        const [x, y] = [((bay[0][0] + bay[1][0]) / 2 + 0.5) * Q, ((bay[0][1] + bay[1][1]) / 2 + 0.5) * Q];
        const taken = hash(Math.round(x * 100), Math.round(y * 100), 19) > 0.25;
        sub.claim(bay.flatMap(([a, b]) => block(sub, a, b, 1, 1)), { use: "spot", poses: taken ? [{ x, y, angle: Math.atan2(-g[1], -g[0]), colour: colour(x, y, 23) }] : [] });
      }
    }
  }

  // The buildings, drawn as the plans are (`footprint.ts`): a core of two
  // by two subcells in each tile, a subcell in from its edges, unless it
  // is joined only on the diagonal; a straight join fills the margin
  // between two cores; four tiles all joined round a corner fill it; a
  // diagonal join is a band of half-subcells from one middle to the
  // other, as wide as a core is and squared off past each.
  const built = (c: number, r: number) => isBuilt(f.town.tile(c, r));
  const tied = (c: number, r: number, x: number, y: number) => built(c, r) && built(x, y) && (joined(c, r, x, y) || joined(x, y, c, r));
  const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!built(c, r)) continue;
      const straight = SIDES.filter(([dc, dr]) => tied(c, r, c + dc, r + dr));
      const diagonal = DIAGONALS.filter(([dc, dr]) => tied(c, r, c + dc, r + dr));
      const tris = straight.length || !diagonal.length ? block(sub, c * N + 1, r * N + 1, 2, 2) : [];
      for (const [dc, dr] of straight) tris.push(...block(sub, c * N + (dc > 0 ? 3 : dc < 0 ? 0 : 1), r * N + (dr > 0 ? 3 : dr < 0 ? 0 : 1), dc ? 1 : 2, dr ? 1 : 2));
      for (const [dc, dr] of DIAGONALS) {
        if (tied(c, r, c + dc, r) && tied(c, r, c, r + dr) && tied(c + dc, r, c + dc, r + dr) && tied(c, r + dr, c + dc, r + dr)) {
          tris.push(...block(sub, c * N + (dc > 0 ? 3 : 0), r * N + (dr > 0 ? 3 : 0), 1, 1));
        }
      }
      for (const [dc, dr] of diagonal) {
        // Across the band and along it, in half-subcell diagonals from
        // this tile's middle: the band is the core's width, two each way.
        for (let j = (r - 1) * N; j < (r + 2) * N; j++) {
          for (let i = (c - 1) * N; i < (c + 2) * N; i++) {
            for (let t = 0; t < 4; t++) {
              const k = sub.tri(i, j, t);
              if (k < 0) continue;
              const [cx, cy] = sub.corners(k).reduce(([x, y], p) => [x + p[0] / 3, y + p[1] / 3], [0, 0]);
              const [dx, dy] = [(cx - c - 0.5) * N, (cy - r - 0.5) * N];
              const [across, along] = [dx * dr - dy * dc, dx * dc + dy * dr];
              if (Math.abs(across) < 2 && along > -2 && along < 2 * N + 2) tris.push(k);
            }
          }
        }
      }
      fill(sub, tris, { use: "building", kind: f.town.tile(c, r).kind, poses: [] });
    }
  }

  // Cars along the kerb: two subcells end to end, or four half-subcells
  // on the diagonal, the road all along one long side, none at either end,
  // before homes and shops.
  type Slot = { tris: number[]; x: number; y: number; u: Pt; half: [number, number] };
  const slots = (i: number, j: number): Slot[] => {
    const D = Math.SQRT1_2;
    return [
      { tris: block(sub, i, j, 2, 1), x: (i + 1) * Q, y: (j + 0.5) * Q, u: [1, 0], half: [Q, Q / 2] },
      { tris: block(sub, i, j, 1, 2), x: (i + 0.5) * Q, y: (j + 1) * Q, u: [0, 1], half: [Q, Q / 2] },
      // On the diagonal, four half-subcells in a band: a parallelogram
      // with forty-five degree ends, a car's length at its full width.
      { tris: [sub.tri(i, j, 0), sub.tri(i, j, 1), sub.tri(i + 1, j, 2), sub.tri(i + 1, j, 3), sub.tri(i + 1, j + 1, 0), sub.tri(i + 1, j + 1, 1), sub.tri(i + 2, j + 1, 2), sub.tri(i + 2, j + 1, 3)], x: (i + 1.5) * Q, y: (j + 1) * Q, u: [D, D], half: [2 * Q * D, (Q * D) / 2] },
      { tris: [sub.tri(i, j, 1), sub.tri(i, j, 2), sub.tri(i + 1, j, 0), sub.tri(i + 1, j, 3), sub.tri(i + 1, j - 1, 1), sub.tri(i + 1, j - 1, 2), sub.tri(i + 2, j - 1, 0), sub.tri(i + 2, j - 1, 3)], x: (i + 1.5) * Q, y: j * Q, u: [D, -D], half: [2 * Q * D, (Q * D) / 2] },
    ];
  };
  for (let j = 0; j < sub.h; j++) {
    for (let i = 0; i < sub.w; i++) {
      for (const { tris, x, y, u, half: [l, w] } of slots(i, j)) {
        if (tris.some((k) => k < 0 || sub.owner[k] >= 0)) continue;
        const n: Pt = [-u[1], u[0]];
        const side = (sign: number, a: number) => [-0.6, 0.6].every((t) => isRoad(x + u[0] * l * t + n[0] * sign * a, y + u[1] * l * t + n[1] * sign * a));
        const sign = side(1, w + 0.1) ? 1 : side(-1, w + 0.1) ? -1 : 0;
        if (!sign || [-0.6, 0.6].some((t) => isRoad(x + u[0] * l * t - n[0] * sign * (w + 0.1), y + u[1] * l * t - n[1] * sign * (w + 0.1)))) continue;
        // None at either end: the kerb runs on past it.
        if ([-1, 1].some((e) => isRoad(x + u[0] * e * (l + 0.03), y + u[1] * e * (l + 0.03)))) continue;
        if (town.through(Math.floor(x + n[0] * sign * (w + 0.1)), Math.floor(y + n[1] * sign * (w + 0.1)))) continue;
        const [fc, fr] = [Math.floor(x - n[0] * sign * 0.45), Math.floor(y - n[1] * sign * 0.45)];
        const before = town.tile(fc, fr);
        if (!isBuilt(before) || f.yard(fc, fr) || (formOf(before).family !== "street" && before.kind !== "Supermarket")) continue;
        if (hash(i, j, 11) < 0.3) continue;
        // Its wheels to the kerb.
        const a = w - CAR.w / 2 - 0.01;
        sub.claim(tris, { use: "car", poses: [{ x: x + n[0] * sign * a, y: y + n[1] * sign * a, angle: Math.atan2(u[1], u[0]), colour: colour(x, y, 13) }] });
      }
    }
  }
  return sub;
}

/** A vehicle's body as it stands on its piece: a car, or a lorry's trailer
 *  and cab from its tail. */
export function bodies(piece: Piece): (Pose & { l: number; w: number; cab?: boolean })[] {
  return piece.poses.flatMap((p) => {
    if (piece.use !== "lorry") return [{ ...p, l: CAR.l, w: CAR.w }];
    const [ux, uy] = [Math.cos(p.angle), Math.sin(p.angle)];
    const [t, c] = [TRAILER.l / 2, TRAILER.l + 0.02 + CAB.l / 2];
    return [
      { ...p, x: p.x + ux * t, y: p.y + uy * t, l: TRAILER.l, w: TRAILER.w },
      { ...p, x: p.x + ux * c, y: p.y + uy * c, l: CAB.l, w: CAB.w, cab: true },
    ];
  });
}
