import { boxGeometry as box } from "./buildings";
import type { MeshGeometry, P } from "../geometry";
import { CAB, TRAILER } from "./roadGeometry";
import type { RGB } from "../rgb";
import type { Sail, Pose } from "../../generated";

/**
 * What the harbour moves, shaped: the lorries' and vans' flatbeds, the
 * ferry, and how the ferry goes, by the server's clock (`map/sea.rs`).
 * Shapes alone; `CarObject.tsx` places them.
 */

export type Shape = MeshGeometry & { colors: number[] };
export type Part = [MeshGeometry, [number, number, number], RGB];

/** Parts as one shape, each a geometry moved to `at` and painted a shade
 *  of what the bucket's colour is multiplied by, mapped as it was. */
export function shape(parts: Part[]): Shape {
  const out: Shape = { positions: [], normals: [], indices: [], colors: [], uvs: [] };
  for (const [g, [x, y, z], [r, gr, b]] of parts) {
    const base = out.positions.length / 3;
    for (let i = 0; i < g.positions.length; i += 3) out.positions.push(g.positions[i] + x, g.positions[i + 1] + y, g.positions[i + 2] + z), out.colors.push(r, gr, b, 1);
    out.uvs!.push(...(g.uvs ?? Array<number>((g.positions.length / 3) * 2).fill(0)));
    out.normals.push(...g.normals);
    out.indices.push(...g.indices.map((k) => k + base));
  }
  return out;
}
/** An outline round the origin, convex and anticlockwise, extruded `h` up
 *  from z = 0: its top fanned from the middle, and its sides; every
 *  triangle its own three vertices, as the bevel wants (`slab`). */
export function prism(ring: P[], h: number): MeshGeometry {
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
export function barrel(r: number, l: number): MeshGeometry {
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
export const CHASSIS: RGB = [0.28, 0.29, 0.31];

/**
 * A flatbed: what a lorry's cab pulls, TRAILER long and wide, and a
 * van's body behind its cab, shorter: a deck on a dark chassis, low
 * dropsides and a headboard behind the cab; the packages on it open to
 * the sky (`goods.ts`). Its colours its own: its bucket is white. Its
 * middle on the origin, ahead +y, its base on z = 0.
 */
const { w: W, l: L } = TRAILER;
const BED = 0.045;
const WALL = 0.02;
/** The deck's top, where what it carries stands. */
export const BED_TOP = BED + 0.012;
function flatbed(l: number): Shape {
  const side = (w: number, ll: number, x: number, y: number, h: number): Part => [box(w, ll, h), [x, y, BED + h / 2], [0.36, 0.38, 0.42]];
  return shape([
    [box(W, l, BED), [0, 0, BED / 2], CHASSIS],
    [box(W, l, 0.012), [0, 0, BED + 0.006], [0.5, 0.51, 0.52]],
    side(WALL, l, (W - WALL) / 2, 0, 0.025),
    side(WALL, l, -(W - WALL) / 2, 0, 0.025),
    side(W - 2 * WALL, WALL, 0, -(l - WALL) / 2, 0.025),
    side(W - 2 * WALL, WALL, 0, (l - WALL) / 2, 0.16),
  ]);
}
/** The lorry's flatbed, and the van's, `VAN_BED` long (`motion.ts`). */
export const LORRY_BED = { key: "bed_lorry", geo: flatbed(L) };
export const vanBed = (l: number) => ({ key: "bed_van", geo: flatbed(l) });

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

/**
 * The ferry: a double-ended car ferry, as small islands' are, the same
 * at both ends, so it never turns. A white hull, dark at the waterline,
 * long and broad, bigger than true to the map (`FERRY_LENGTH` in
 * `map/sea.rs`); an open deck the pallets and the settlers' cars stand
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

/** A deck bay's middle on a ferry standing at `p`: three lanes across,
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
