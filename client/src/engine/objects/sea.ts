import { boxGeometry as box } from "./buildings";
import type { MeshGeometry, P } from "../geometry";
import { drawnPath } from "./drawnPath";
import { TRAILER } from "./roadGeometry";
import { rgb, type Rgb } from "../rgb";
import type { Car, Good, Shunt, Trailer } from "../../generated";
import type { Pose } from "../../generated/Pose";

/**
 * What the harbour moves, shaped: the boxes, the tug that shunts them and
 * the ferry that carries them, and how the ferry and the tug go, by the
 * server's clock (`world/sea.rs`). Shapes alone; `CarObject.tsx` and
 * `BuildingObject.tsx` place them.
 */

type Shape = MeshGeometry & { colors: number[] };
type Shade = [number, number, number];

/** Parts as one shape, each a geometry moved to `at` and painted a shade
 *  of what the bucket's colour is multiplied by. */
function shape(parts: [MeshGeometry, [number, number, number], Shade][]): Shape {
  const out: Shape = { positions: [], normals: [], indices: [], colors: [] };
  for (const [g, [x, y, z], [r, gr, b]] of parts) {
    const base = out.positions.length / 3;
    for (let i = 0; i < g.positions.length; i += 3) out.positions.push(g.positions[i] + x, g.positions[i + 1] + y, g.positions[i + 2] + z), out.colors.push(r, gr, b, 1);
    out.normals.push(...g.normals);
    out.indices.push(...g.indices.map((k) => k + base));
  }
  return out;
}
/** An outline round the origin, convex and anticlockwise, extruded `h` up
 *  from z = 0: its top fanned from the middle, and its sides; every
 *  triangle its own three vertices, as the bevel wants (`slab`). */
function prism(ring: P[], h: number): MeshGeometry {
  const positions: number[] = [], normals: number[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0];
    for (const p of [[0, 0, h], [b[0], b[1], h], [a[0], a[1], h]]) positions.push(...p), normals.push(0, 0, 1);
    for (const p of [[a[0], a[1], 0], [b[0], b[1], h], [b[0], b[1], 0], [a[0], a[1], 0], [a[0], a[1], h], [b[0], b[1], h]]) positions.push(...p), normals.push(...n);
  });
  return { positions, normals, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}
/** A round section `r` across (an octagon), `l` long along y, lying on its
 *  side: two halves from the middle, each capped at its end. */
function barrel(r: number, l: number): MeshGeometry {
  const ring: P[] = Array.from({ length: 8 }, (_, k) => [r * Math.cos((k + 0.5) * Math.PI / 4), r * Math.sin((k + 0.5) * Math.PI / 4)]);
  const half = prism(ring, l / 2);
  const turn = (g: MeshGeometry, s: number): MeshGeometry => {
    const p = g.positions, n = g.normals;
    const map = (a: number[], i: number) => [a[i], s * a[i + 2], -s * a[i + 1]];
    return { positions: p.flatMap((_, i) => (i % 3 ? [] : map(p as number[], i))), normals: n.flatMap((_, i) => (i % 3 ? [] : map(n as number[], i))), indices: g.indices };
  };
  const [a, b] = [turn(half, 1), turn(half, -1)];
  return { positions: [...a.positions, ...b.positions], normals: [...a.normals, ...b.normals], indices: [...a.indices, ...b.indices.map((k) => k + a.positions.length / 3)] };
}

const WHITE: Shade = [1, 1, 1];
const CHASSIS: Shade = [0.28, 0.29, 0.31];

/**
 * A box: a semi-trailer as the ferry carries them, TRAILER long and wide,
 * on a dark chassis, its shape and colour what is in it, so a park reads
 * at a glance. Crates in a closed box in a clear red, the colour of food
 * on a map; timber stacked warm brown on a flatbed; fuel in a silver
 * tank; an empty, pale and open, its floor seen down in it.
 */
const { w: W, l: L, h: H } = TRAILER;
const BED = 0.045;
const SHAPES = {
  Crates: shape([[box(W, L, BED), [0, 0, BED / 2], CHASSIS], [box(W, L - 0.01, H - BED), [0, 0, BED + (H - BED) / 2], WHITE]]),
  Timber: shape([
    [box(W, L, BED), [0, 0, BED / 2], CHASSIS],
    // Two stacks of sawn timber, end on, with a gap between.
    [box(W - 0.02, L / 2 - 0.03, 0.12), [0, -L / 4, BED + 0.06], WHITE],
    [box(W - 0.02, L / 2 - 0.03, 0.12), [0, L / 4, BED + 0.06], [0.88, 0.86, 0.84]],
  ]),
  Fuel: shape([
    [box(W - 0.03, L, BED), [0, 0, BED / 2], CHASSIS],
    [barrel(W / 2 / Math.cos(Math.PI / 8), L - 0.02), [0, 0, BED + W / 2 - 0.01], WHITE],
  ]),
  Empty: shape([
    [box(W, L, BED), [0, 0, BED / 2], CHASSIS],
    // The floor, low and in shade, and four thin walls round it.
    [box(W - 0.03, L - 0.03, 0.01), [0, 0, BED + 0.005], [0.62, 0.62, 0.6]],
    [box(0.015, L, H - BED), [(W - 0.015) / 2, 0, BED + (H - BED) / 2], WHITE],
    [box(0.015, L, H - BED), [-(W - 0.015) / 2, 0, BED + (H - BED) / 2], WHITE],
    [box(W - 0.03, 0.015, H - BED), [0, (L - 0.015) / 2, BED + (H - BED) / 2], WHITE],
    [box(W - 0.03, 0.015, H - BED), [0, -(L - 0.015) / 2, BED + (H - BED) / 2], WHITE],
  ]),
};
const COLOURS: Record<keyof typeof SHAPES, Rgb> = {
  Crates: rgb(0.83, 0.29, 0.24),
  Timber: rgb(0.62, 0.42, 0.25),
  Fuel: rgb(0.8, 0.82, 0.85),
  Empty: rgb(0.9, 0.9, 0.87),
};

/** A box's shape and colour, by what is in it; its base on z = 0. */
export function boxShape(t: Trailer): { key: string; geo: Shape; colour: Rgb } {
  const kind: keyof typeof SHAPES = t.good && t.units > 0 ? (t.good as Good) : "Empty";
  return { key: `box_${kind}`, geo: SHAPES[kind], colour: COLOURS[kind] };
}

/** The tug: a tugmaster, low and short, its one-seat cab off to one side
 *  at the front, the fifth wheel behind it that lifts a box's nose. Its
 *  middle on the origin, ahead +y, its base on z = 0. */
export const TUG = rgb(0.98, 0.66, 0.12);
export const TUG_SHAPE = shape([
  [box(0.16, 0.25, 0.05), [0, 0, 0.045], WHITE],
  [box(0.15, 0.24, 0.02), [0, 0, 0.01], CHASSIS],
  [box(0.075, 0.1, 0.075), [-0.035, 0.065, 0.105], WHITE],
  [box(0.07, 0.095, 0.035), [-0.035, 0.065, 0.16], [0.22, 0.25, 0.3]],
  [box(0.075, 0.1, 0.012), [-0.035, 0.065, 0.183], WHITE],
  [box(0.1, 0.08, 0.012), [0, -0.07, 0.076], CHASSIS],
]);
/** A box's middle behind the tug's (`TUG_BOX` in `world/sea.rs`), and how
 *  long the tug stands hitching or dropping at the end of a move. */
const TUG_BOX = 0.32;
const HITCH_MS = 2500;

/**
 * The ferry: a double-ended car ferry, as small islands' are, the same
 * at both ends, so it never turns. A white hull, dark at the waterline,
 * long and broad, bigger than true to the map (`FERRY_LENGTH` in
 * `world/sea.rs`); an open deck the boxes and the settlers' cars stand
 * on, between low bulwarks; and amidships its bridge on two towers,
 * high over the deck, its roof in the harbours' blue. Its middle on the
 * origin, ahead +y; the deck at z = 0.
 */
export const FERRY = { l: 3.2, w: 0.85 };
const FREEBOARD = 0.7;
const hull = (inset: number): P[] => {
  const [x, y] = [FERRY.w / 2 - inset, FERRY.l / 2 - inset];
  return [[x, -y + 0.35], [x, y - 0.35], [x - 0.12, y - 0.1], [x - 0.27, y], [-x + 0.27, y], [-x + 0.12, y - 0.1], [-x, y - 0.35], [-x, -y + 0.35], [-x + 0.12, -y + 0.1], [-x + 0.27, -y], [x - 0.27, -y], [x - 0.12, -y + 0.1]];
};
const NAVY: Shade = [0.2, 0.24, 0.32];
const BLUE: Shade = [0.24, 0.45, 0.66];
export const FERRY_SHAPE = shape([
  [prism(hull(0), 0.14), [0, 0, -FREEBOARD - 0.1], NAVY],
  [prism(hull(0), FREEBOARD - 0.046), [0, 0, -FREEBOARD + 0.04], WHITE],
  [prism(hull(0.06), 0.006), [0, 0, -0.006], [0.72, 0.73, 0.74]],
  [box(0.035, FERRY.l - 0.75, 0.07), [FERRY.w / 2 - 0.0175, 0, 0.035], WHITE],
  [box(0.035, FERRY.l - 0.75, 0.07), [-FERRY.w / 2 + 0.0175, 0, 0.035], WHITE],
  [box(0.05, 0.2, 0.36), [FERRY.w / 2 - 0.025, 0, 0.18], WHITE],
  [box(0.05, 0.2, 0.36), [-FERRY.w / 2 + 0.025, 0, 0.18], WHITE],
  [box(FERRY.w, 0.2, 0.06), [0, 0, 0.39], WHITE],
  [box(FERRY.w - 0.02, 0.19, 0.035), [0, 0, 0.4375], [0.22, 0.25, 0.3]],
  [box(FERRY.w, 0.21, 0.025), [0, 0, 0.4675], BLUE],
]);
/** The sea's surface, 0.7 under the land (`WATER_Z` in `terrainGeometry.ts`),
 *  and the deck over it, level with the quay. */
export const DECK_Z = -0.7 + FREEBOARD;

/** A deck slot's place on a ferry standing at `p`: three lanes across,
 *  five rows from the end its heading points to (`deck_pose`). */
export function deckPose(p: Pose, k: number): Pose {
  const [lane, row] = [k % 3, Math.floor(k / 3)];
  const along = FERRY.l / 2 - (0.45 + row * 0.6), across = (lane - 1) * 0.27;
  const h = p.heading;
  return { at: [p.at[0] + Math.cos(h) * along - Math.sin(h) * across, p.at[1] + Math.sin(h) * along + Math.cos(h) * across], heading: h };
}

/** A ferry on its voyage: where it is now and which way its land end
 *  points. In from the horizon, its land end leading, it slows from a
 *  steady pace into the berth, and is there as the server moors it; out,
 *  it backs away from the berth and gathers way, the sea end leading. The
 *  berth is on from the run's end, the way it came: the moored ferry's
 *  middle FERRY_LENGTH/2 off the quay edge, 2.5 tiles from the berth's
 *  third tile of sea (`Berth::moored`). */
export function sailing(car: Car, inbound: boolean): (now: number) => Pose {
  const run = car.run!;
  const tiles = run.path.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 }));
  if (inbound) tiles.reverse();
  // From the berth outward, whichever way it sails.
  const [a, b] = [tiles[0], tiles[1] ?? tiles[0]];
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const berth = { x: a.x - ((b.x - a.x) / d) * 0.9, y: a.y - ((b.y - a.y) / d) * 0.9 };
  const drawn = drawnPath([berth, ...tiles], 0, 0, 0)!;
  const span = (run.path.length - 1) * run.pace;
  const EASE = 5 * run.pace;
  // A steady pace, and the last stretch slowing to rest (or, out, the
  // first gathering way), the whole covered in the run's time.
  const pace = drawn.length / (span - EASE / 2);
  return (now) => {
    const t = Math.min(Math.max(0, now - run.started), span);
    // How far from the berth, by the time left to it (in) or since it (out).
    const from = inbound ? span - t : t;
    const s = from >= EASE ? pace * (from - EASE / 2) : (pace * (from - (EASE / Math.PI) * Math.sin((Math.PI * from) / EASE))) / 2;
    const fix = drawn.at(s, 0);
    // The way the path runs, outward: the land end points back along it.
    return { at: [fix.pos[0], fix.pos[1]], heading: fix.rot[2] + Math.PI / 2 + Math.PI };
  };
}

/**
 * A tug on a move (`Shunt`): along its path at a steady pace over the
 * move's time less the hitching at its end, each run one way, forwards or
 * backing, eased in and out so it stops where it turns back. It faces the
 * way it goes, or backing the other way, the facing turned smoothly
 * through each corner; and the box on its hitch, if any, trails it on the
 * path it took (leads it, backing), its hitch on the tug, so it swings
 * behind it as a trailer does.
 */
export function shunting(s: Shunt): (now: number) => { tug: Pose; box: Pose } {
  // Its segments, each from a point, the way it runs and whether backing;
  // a point twice is no segment.
  const segs = s.path.slice(1).flatMap((q, i) => {
    const p = s.path[i];
    return Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6 ? [{ p, way: Math.atan2(q[1] - p[1], q[0] - p[0]), len: Math.hypot(q[0] - p[0], q[1] - p[1]), back: i >= s.backs_from }] : [];
  });
  if (!segs.length) segs.push({ p: s.path[0], way: 0, len: 0, back: false });
  const n = segs.length;
  const pts = segs.map((g) => g.p);
  const at = [0];
  for (const g of segs) at.push(at[at.length - 1] + g.len);
  const total = at[n];
  const backs = (i: number) => segs[i].back;
  const way = (i: number) => segs[i].way;
  const seg = (d: number) => {
    let i = 0;
    while (i < n - 1 && at[i + 1] <= d) i++;
    return i;
  };
  // The runs one way: [from, to] along the path.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (i && backs(i) === backs(i - 1)) runs[runs.length - 1][1] = at[i + 1];
    else runs.push([at[i], at[i + 1]]);
  }
  /** A point along the path, straight on past either end. */
  const point = (d: number): [number, number] => {
    const i = seg(Math.min(Math.max(d, 0), total));
    const t = d - at[i];
    return [pts[i][0] + Math.cos(way(i)) * t, pts[i][1] + Math.sin(way(i)) * t];
  };
  /** The facing at a distance: the segments' facings over a short reach
   *  round it, averaged, so a corner is turned through, not snapped. */
  const facing = (d: number) => {
    const [lo, hi] = [d - TURN, d + TURN];
    let [x, y] = [0, 0];
    for (let i = 0; i < n; i++) {
      const w = Math.max(0, Math.min(hi, i === n - 1 ? Infinity : at[i + 1]) - Math.max(lo, i === 0 ? -Infinity : at[i]));
      const f = way(i) + (backs(i) ? Math.PI : 0);
      x += w * Math.cos(f), y += w * Math.sin(f);
    }
    return Math.atan2(y, x);
  };
  const moving = Math.max(1, s.ends - s.started - HITCH_MS);
  return (now) => {
    let d = (Math.min(Math.max(0, now - s.started), moving) / moving) * total;
    const [a, b] = runs.find(([, b]) => d <= b) ?? runs[runs.length - 1];
    if (b > a) {
      // Eased: a steady pace in the middle of the run, slowing to a stop
      // over its first and last RAMP.
      const r = Math.min(0.5, RAMP / (b - a));
      const u = (d - a) / (b - a);
      const v = 1 / (1 - r);
      const e = u < r ? (v * u * u) / (2 * r) : u > 1 - r ? 1 - (v * (1 - u) * (1 - u)) / (2 * r) : v * (u - r / 2);
      d = a + (b - a) * e;
    }
    const tug = point(d), heading = facing(d);
    // Behind the tug on its path: the way it came, or backing, where it goes.
    // Off the end of this run, straight behind it.
    const k = d + (backs(seg(d)) ? TUG_BOX : -TUG_BOX);
    const box = k >= a && k <= b ? point(k) : behind({ at: tug, heading }).at;
    return { tug: { at: tug, heading }, box: { at: box, heading: Math.atan2(tug[1] - box[1], tug[0] - box[0]) } };
  };
}
const TURN = 0.12;
const RAMP = 0.3;

/** A box's place behind a tug standing still. */
export const behind = (p: Pose, d = TUG_BOX): Pose => ({ at: [p.at[0] - Math.cos(p.heading) * d, p.at[1] - Math.sin(p.heading) * d], heading: p.heading });
