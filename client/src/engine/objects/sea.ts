import { boxGeometry as box } from "./buildings";
import type { MeshGeometry, P } from "../geometry";
import { CAB, TRAILER } from "./roadGeometry";
import { drawnPath } from "./drawnPath";
import { ahead, drive, paced, type Rig } from "./driver";
import { hex, rgb, type RGB, type Rgb } from "../rgb";
import { GOODS } from "../../blueprints";
import type { Good, Sail, Shunt, Trailer, Pose } from "../../generated";

/**
 * What the harbour moves, shaped: the boxes, the tug that shunts them and
 * the ferry that carries them, and how the ferry and the tug go, by the
 * server's clock (`world/sea.rs`). Shapes alone; `CarObject.tsx` and
 * `BuildingObject.tsx` place them.
 */

type Shape = MeshGeometry & { colors: number[] };
type Part = [MeshGeometry, [number, number, number], RGB];

/** Parts as one shape, each a geometry moved to `at` and painted a shade
 *  of what the bucket's colour is multiplied by. */
function shape(parts: Part[]): Shape {
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

const WHITE: RGB = [1, 1, 1];
const CHASSIS: RGB = [0.28, 0.29, 0.31];

/** A shape of flat faces, each a convex outline anticlockwise from
 *  outside, fanned from its middle as `boxGeometry` fans a box's. */
function faces(outlines: [number, number, number][][]): MeshGeometry {
  const out: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const f of outlines) {
    const [a, b, c] = f;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    const mid = [0, 1, 2].map((k) => f.reduce((s, p) => s + p[k], 0) / f.length);
    const base = out.positions.length / 3;
    for (const p of [mid, ...f]) out.positions.push(...p), out.normals.push(n[0] / len, n[1] / len, n[2] / len);
    f.forEach((_, i) => out.indices.push(base, base + 1 + ((i + 1) % f.length), base + 1 + i));
  }
  return out;
}

/**
 * A box: a semi-trailer as the ferry carries them, TRAILER long and wide,
 * on a dark chassis, built for the kind of thing in it and painted in the
 * good's own colour (`GOODS`), so a park reads at a glance from above.
 * Crates ride in a dry van, ribbed across its roof, its doors at the back
 * pale; fuel in a silver tank in a frame of its colour; timber loose in an
 * open tipper, logs in it as far along as it is full, and stone heaped in
 * one, a ridge along it. A box is only ever full, so its look never
 * changes. A shape's colours are its own: its bucket is white.
 */
const { w: W, l: L, h: H } = TRAILER;
const BED = 0.045;
const shade = (c: Rgb, s = 1): RGB => [c.r * s, c.g * s, c.b * s];
const chassis = (w = W): Part => [box(w, L, BED), [0, 0, BED / 2], CHASSIS];

/** A dry van: a closed body, ribs across its roof, its doors a pale band
 *  round the back. */
function dry(c: Rgb): Shape {
  const body = H - BED;
  return shape([
    chassis(),
    [box(W, L - 0.01, body), [0, 0, BED + body / 2], shade(c)],
    ...Array.from({ length: 7 }, (_, k): Part => [box(W - 0.02, 0.02, 0.008), [0, -0.15 + k * 0.05, H], shade(c, 0.82)]),
    [box(W + 0.004, 0.035, body + 0.004), [0, -(L - 0.01) / 2 + 0.0175, BED + body / 2], [0.9, 0.89, 0.86]],
  ]);
}

/** A tank box: a silver tank lying in two end frames of its colour, a
 *  walkway along its top. */
function tank(c: Rgb): Shape {
  const r = (W - 0.02) / 2, end = 0.035, frame = H - BED;
  const long = L - 2 * end - 0.01;
  return shape([
    chassis(W - 0.03),
    [barrel(r / Math.cos(Math.PI / 8), long), [0, 0, BED + r], [0.84, 0.85, 0.87]],
    [box(0.035, long - 0.06, 0.01), [0, 0, BED + 2 * r + 0.004], CHASSIS],
    ...[-1, 1].flatMap((s): Part[] => [
      ...[-1, 1].map((x): Part => [box(end, end, frame), [(x * (W - end)) / 2, (s * (L - end)) / 2, BED + frame / 2], shade(c)]),
      [box(W, end, end), [0, (s * (L - end)) / 2, H - end / 2], shade(c)],
      [box(W, end, end), [0, (s * (L - end)) / 2, BED + end / 2], shade(c)],
    ]),
  ]);
}

/** An open tipper: a floor and four walls, the front one higher. */
const WALL = 0.02;
const RIM = 0.12;
const INSIDE = { w: W - 2 * WALL, l: L - 2 * WALL };
function tipper(walls: RGB, floor: RGB): Shape {
  const wall = (w: number, l: number, x: number, y: number, h = RIM): Part => [box(w, l, h), [x, y, BED + h / 2], walls];
  return shape([
    chassis(),
    [box(INSIDE.w, INSIDE.l, 0.01), [0, 0, BED + 0.005], floor],
    wall(WALL, L, (W - WALL) / 2, 0),
    wall(WALL, L, -(W - WALL) / 2, 0),
    wall(INSIDE.w, WALL, 0, -(L - WALL) / 2),
    wall(INSIDE.w, WALL, 0, (L - WALL) / 2, RIM + 0.04),
  ]);
}

/** Logs in a tipper, three, two and three, the length of it, each a shade
 *  of bark; scaled along, the box as far as it is full. */
function logs(c: Rgb): Shape {
  const r = INSIDE.w / 6;
  const rows = [[-2, 0, 2], [-1, 1], [-2, 0, 2]];
  return shape(rows.flatMap((row, j) => row.map((k, i): Part => [barrel(r / Math.cos(Math.PI / 8), INSIDE.l - 0.01), [k * r, 0, BED + 0.01 + r + j * r * Math.sqrt(3)], shade(c, [1, 0.82, 0.92][(i + j) % 3])])));
}

/** A heap in a tipper, of stone or gravel: from the floor's edges up to
 *  a ridge along its middle, lit one side and shaded the other; scaled
 *  along, the box as far as it is full. */
export function heap(c: Rgb): Shape {
  const [a, b, z, top] = [INSIDE.w / 2, INSIDE.l / 2, BED + 0.01, BED + 0.16];
  const p = (x: number, y: number): [number, number, number] => [x * a, y * b, z];
  const r = (y: number): [number, number, number] => [0, y * (b - a), top];
  return shape([[faces([[p(1, -1), p(1, 1), r(1), r(-1)], [p(-1, 1), p(-1, -1), r(-1), r(1)], [p(1, 1), p(-1, 1), r(1)], [p(-1, -1), p(1, -1), r(-1)]]), [0, 0, 0], shade(c)]]);
}

/** A dropside flatbed: a deck, sides and a tail a hand high, and a
 *  headboard behind the cab; what it carries is open to the sky. */
function flatbed(sides: RGB, deck: RGB): Shape {
  const side = (w: number, l: number, x: number, y: number, h: number): Part => [box(w, l, h), [x, y, BED + h / 2], sides];
  return shape([
    chassis(),
    [box(W, L, 0.012), [0, 0, BED + 0.006], deck],
    side(WALL, L, (W - WALL) / 2, 0, 0.035),
    side(WALL, L, -(W - WALL) / 2, 0, 0.035),
    side(INSIDE.w, WALL, 0, -(L - WALL) / 2, 0.035),
    side(INSIDE.w, WALL, 0, (L - WALL) / 2, RIM + 0.04),
  ]);
}

type Drawn = { key: string; geo: Shape };
const TIPPER: Drawn = { key: "box_tipper", geo: tipper([0.36, 0.38, 0.42], [0.52, 0.53, 0.55]) };
const FLATBED: Drawn = { key: "rigid_flatbed", geo: flatbed([0.36, 0.38, 0.42], [0.5, 0.51, 0.52]) };
const colour = (g: Good) => hex(GOODS[g].color);
/** Each good's box, and a loose good's load in it. */
const BOXES: Record<Good, { body: Drawn; load?: Drawn }> = {
  Crates: { body: { key: "box_Crates", geo: dry(colour("Crates")) } },
  Fuel: { body: { key: "box_Fuel", geo: tank(colour("Fuel")) } },
  Timber: { body: TIPPER, load: { key: "load_Timber", geo: logs(colour("Timber")) } },
  Stone: { body: TIPPER, load: { key: "load_Stone", geo: heap(colour("Stone")) } },
};

export type BoxPart = Drawn & { scale: [number, number, number] };

/** A box's parts, each with its scale: the body whole, a load as far
 *  along as the box is full. Their base on z = 0. */
export function boxShape(t: Pick<Trailer, "good" | "units">): BoxPart[] {
  const { body, load } = BOXES[t.good];
  return [{ ...body, scale: [1, 1, 1] }, ...(load ? [loaded(load, t, 1)] : [])];
}

/** A rigid lorry's body behind its cab, `k` of a box long and holding
 *  `k` as much (`VAN_BOX` in `motion.ts`): a builder's load, timber or
 *  stone, stacked or heaped on a dropside flatbed, there to be seen; a
 *  shop's in the closed box, or the tank, a box of it is. */
export function rigidShape(t: Pick<Trailer, "good" | "units">, k: number): BoxPart[] {
  const { body, load } = BOXES[t.good];
  return [{ ...(load ? FLATBED : body), scale: [1, k, 1] }, ...(load ? [loaded(load, t, k)] : [])];
}

const loaded = (load: Drawn, t: Pick<Trailer, "good" | "units">, k: number): BoxPart => ({ ...load, scale: [1, k * Math.min(1, t.units / (GOODS[t.good].box * k)), 1] });

/** A lorry's tractor, CAB long: the cab-over cab at the front, `CAB_BLOCK`
 *  of it, its windows a dark band under the roof; behind it the chassis
 *  bare, the rear wheels either side and the fifth wheel on it where the
 *  hitch is (`LORRY_RIG`), under a box's nose. Its middle on the origin,
 *  ahead +y, its base on z = 0; the bucket's colour is the cab's. */
export const CAB_BLOCK = 0.095;
const TYRE: RGB = [0.12, 0.12, 0.13];
const [CAB_FRONT, HITCH] = [CAB.l / 2, -CAB.l / 3];
export const LORRY_SHAPE = shape([
  [box(CAB.w - 0.05, CAB.l, 0.03), [0, 0, 0.03], CHASSIS],
  [box(CAB.w, 0.055, 0.05), [0, HITCH, 0.025], TYRE],
  [box(CAB.w - 0.06, 0.07, 0.012), [0, HITCH, 0.05], [0.2, 0.2, 0.22]],
  [box(CAB.w, CAB_BLOCK, CAB.h - 0.07), [0, CAB_FRONT - CAB_BLOCK / 2, 0.02 + (CAB.h - 0.07) / 2], WHITE],
  [box(CAB.w - 0.006, CAB_BLOCK - 0.006, 0.04), [0, CAB_FRONT - CAB_BLOCK / 2, CAB.h - 0.03], [0.22, 0.25, 0.3]],
  [box(CAB.w, CAB_BLOCK, 0.012), [0, CAB_FRONT - CAB_BLOCK / 2, CAB.h - 0.006], WHITE],
]);

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
 *  long the tug stands coupling or dropping at the end of a move
 *  (`COUPLE_MS` in `haul.rs`). */
const TUG_BOX = 0.32;
const HITCH_MS = 400;

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
export const hull = (inset: number): P[] => {
  const [x, y] = [FERRY.w / 2 - inset, FERRY.l / 2 - inset];
  return [[x, -y + 0.35], [x, y - 0.35], [x - 0.12, y - 0.1], [x - 0.27, y], [-x + 0.27, y], [-x + 0.12, y - 0.1], [-x, y - 0.35], [-x, -y + 0.35], [-x + 0.12, -y + 0.1], [-x + 0.27, -y], [x - 0.27, -y], [x - 0.12, -y + 0.1]];
};
const NAVY: RGB = [0.2, 0.24, 0.32];
const BLUE: RGB = [0.24, 0.45, 0.66];
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

/** How a ship moves along a leg, as `shipping/mod.rs` has it: full speed
 *  a tile every `SEA_PACE` ms, gathering way from rest at an even push
 *  over `GATHER` ms at an end that is a berth, and losing it the same
 *  way coming in. */
const SEA_PACE = 200;
const GATHER = 30_000;
/** How far along a leg `len` tiles long, `t` ms of `whole` in (`covered`). */
function covered(len: number, ease: [boolean, boolean], t: number, whole: number): number {
  const v = 1 / SEA_PACE;
  const out = (t: number) => (t < GATHER ? (v * t * t) / (2 * GATHER) : v * (t - GATHER / 2));
  t = Math.min(Math.max(0, t), whole);
  if (ease[0] && ease[1]) return t < whole / 2 ? out(t) : len - out(whole - t);
  if (ease[0]) return out(t);
  if (ease[1]) return len - out(whole - t);
  return v * t;
}

/** A ferry on a leg (`Sail`): where it is at a moment and which way its
 *  land end points, off the server's way and clock. The way's corners are
 *  rounded already; its facing is read over a short reach either side,
 *  so it swings through them. Coming in to a berth its land end leads;
 *  going out (`astern`) it backs away, the sea end leading, as it never
 *  turns. A leg comes in pieces where it stops at a junction's mouth; a
 *  ship stands where its piece ends. */
export function sailing(s: Sail): (now: number) => Pose {
  const at = [0];
  for (let i = 1; i < s.path.length; i++) at.push(at[i - 1] + Math.hypot(s.path[i][0] - s.path[i - 1][0], s.path[i][1] - s.path[i - 1][1]));
  const len = at[at.length - 1];
  const point = (d: number): [number, number] => {
    d = Math.min(Math.max(0, d), len);
    let i = 0;
    while (i < at.length - 2 && at[i + 1] < d) i++;
    const k = at[i + 1] > at[i] ? (d - at[i]) / (at[i + 1] - at[i]) : 0;
    return [s.path[i][0] + (s.path[i + 1][0] - s.path[i][0]) * k, s.path[i][1] + (s.path[i + 1][1] - s.path[i][1]) * k];
  };
  return (now) => {
    const d = Math.min(covered(len, s.ease, now - s.started, s.ends - s.started), len);
    const [a, b] = [point(d - REACH), point(d + REACH)];
    return { at: point(d), heading: Math.atan2(b[1] - a[1], b[0] - a[0]) + (s.astern ? Math.PI : 0) };
  };
}
const REACH = 0.4;

/** The tug as it steers: its rear axle a little behind its middle, the
 *  fifth wheel on it, and a box's axle and middle behind that, the box's
 *  middle `TUG_BOX` behind the tug's. */
const TUG_RIG: Rig = { axle: 0.06, trailer: { axle: 0.3, middle: TUG_BOX - 0.06 } };
/** How it goes (`TUG_FORWARD`, `TUG_BACKING`, `TUG_PUSH` in
 *  `world/sea.rs`): tiles a second forward and backing, tiles a second
 *  gained or lost each second, and a moment standing where it changes
 *  gear (`CUSP_MS`). */
const [FORWARD, BACKING, PUSH, CUSP_S] = [1.0, 0.4, 0.6, 0.5];

const moves = new WeakMap<Shunt, (now: number) => { tug: Pose; box: Pose }>();
/**
 * A tug on a move (`Shunt`), from where it stood: its path in runs, one
 * at each change of gear, each rounded through its corners and driven as
 * any vehicle steers (`driver.ts`), the box on its hitch, if any, a
 * trailer behind it or led backing; ending where the server has it
 * stand. Each run gathers way and loses it, stopping where it changes
 * gear, and the whole is fitted to the move's time less the coupling at
 * its end.
 */
export function shunting(s: Shunt, from: Pose, hitched: boolean): (now: number) => { tug: Pose; box: Pose } {
  const known = moves.get(s);
  if (known) return known;
  const n = s.path.length;
  const cuts = [...new Set([0, Math.min(Math.max(s.backs_from, 0), n - 1), n - 1])].sort((a, b) => a - b);
  const runs: { points: P[]; length: number; backing: boolean }[] = [];
  for (let c = 1; c < cuts.length; c++) {
    const d = drawnPath(s.path.slice(cuts[c - 1], cuts[c] + 1), 0, 0, 0);
    if (d) runs.push({ points: d.points, length: d.length, backing: cuts[c - 1] >= s.backs_from });
  }
  if (!runs.length) {
    const still = () => ({ tug: s.stands, box: behind(s.stands) });
    moves.set(s, still);
    return still;
  }
  const bounds = runs.reduce((b, r) => [...b, b[b.length - 1] + r.length], [0]);
  const drv = drive(runs.map((r, k) => ({ ...r, from: bounds[k], to: bounds[k + 1] })), hitched ? TUG_RIG : { axle: TUG_RIG.axle }, from, s.stands);
  const pace = paced(runs.map((r) => ({ length: r.length, top: r.backing ? BACKING : FORWARD })), PUSH, CUSP_S);
  const window = Math.max(0.001, (s.ends - s.started - HITCH_MS) / 1000);
  const move = (now: number) => {
    const t = (Math.min(Math.max(0, (now - s.started) / 1000), window) / window) * pace.secs;
    const { body, trailer } = drv.at(pace.at(t));
    return { tug: body, box: trailer ?? behind(body) };
  };
  moves.set(s, move);
  return move;
}

/** A box's place behind a tug standing still. */
export const behind = (p: Pose): Pose => ahead(p, -TUG_BOX);
