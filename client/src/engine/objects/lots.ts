import type { MeshGeometry } from "../Mesh";
import { slabGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, inLot, plot } from "../../blueprints";
import { buildingAt, getObjectsAt } from "../../state/gameObjects";
import type { Building, GameObjectEntry } from "../../generated";

/**
 * A ring lot, drawn: the slab is the lot, white like a street, and what is
 * painted on it is the dividers between the spots in the island. Mirrors the server's `lots.rs` so a
 * car sits between its dividers: the numbers here are the numbers there.
 *
 * Built in the lot's own frame, u along the frontage and v in from the
 * street, and turned into place per facing. That frame is chosen so the
 * turn is a rotation, never a mirror: a mirrored instance is inside out.
 */
const PITCH = 0.2;
const ISLAND_END = 0.3;
const CAR: [number, number] = [0.35, 0.18];
/** Painted above the road surface, so a driveway's arm cannot cover it. */
const MARK_Z = 0.022;
const MARK = 0.035;

/** Where the spots' centres lie along a lot w wide. */
export function spotsAcross(w: number): number[] {
  const n = Math.max(0, Math.floor((w - 2 * ISLAND_END) / PITCH + 1e-9));
  const start = ISLAND_END + ((w - 2 * ISLAND_END) - n * PITCH) / 2 + PITCH / 2;
  return Array.from({ length: n }, (_, i) => start + i * PITCH);
}

/** Whether a tile is land, from the terrain the client holds. */
let landAt: (x: number, y: number) => boolean = () => false;
export function setLandLookup(f: (x: number, y: number) => boolean) {
  landAt = f;
}

function roadAt(x: number, y: number): { road: boolean } | undefined {
  const e = getObjectsAt(x, y).find((o) => o.object.kind === "RoadNode");
  return e ? (e.object.data as { road: boolean }) : undefined;
}

/** Free land on a frontage: buildable, with the street it would front
 *  right in front of it and room for a building behind it. Mirrors
 *  `is_open_frontage` in `lots.rs`. */
function openFrontage(x: number, y: number, facing: number): boolean {
  const [dx, dy] = FACINGS[facing % 4];
  const buildable = (tx: number, ty: number) => !buildingAt(tx, ty) && !roadAt(tx, ty) && landAt(tx, ty);
  const front = roadAt(x + dx, y + dy);
  return buildable(x, y) && buildable(x - dx, y - dy) && !!front && !front.road && !buildingAt(x + dx, y + dy);
}

/** A lot as a run of lot tiles along one frontage: the members' tiles,
 *  the gaps of one free tile between them, and one free tile past each
 *  end where the land allows. The rectangle of lot tiles on the grid, the
 *  run's width, how deep its plots are, who is on it, where the free
 *  tiles are, and where this building's own tiles lie. Mirrors `run_of`
 *  and `frontage` in `lots.rs`. */
export interface Run {
  rect: { x: number; y: number; w: number; h: number };
  w: number;
  depth: number;
  members: number[];
  /** u of every free tile on the run: spill at the ends, gaps between. */
  empties: number[];
  u0: number;
  u1: number;
  first: boolean;
  /** A depot's yard: docks against the wall instead of spots across an
   *  island, the wall this many tiles in from the street. */
  yard: number | null;
}

export function runOf(entry: GameObjectEntry): Run | null {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const own = plot(data.kind, data.facing);
  if (!pos || !own.lot) return null;
  // The lot's extent along the frontage is its grid width or its grid
  // height, by which way it faces.
  const alongX = FACINGS[data.facing % 4][0] === 0;
  const [[lx, ly], [gw, gh]] = own.lot;
  const lw = alongX ? gw : gh;
  const [line, a0, a1] = alongX ? [pos.y + ly, pos.x + lx, pos.x + lx + lw] : [pos.x + lx, pos.y + ly, pos.y + ly + lw];
  if (BLUEPRINTS[data.kind].yard) {
    const rect = { x: pos.x + lx, y: pos.y + ly, w: gw, h: gh };
    return { rect, w: lw, depth: alongX ? own.size[1] : own.size[0], members: [entry.id], empties: [], u0: 0, u1: lw, first: true, yard: alongX ? gh : gw };
  }
  const tile = (a: number): [number, number] => (alongX ? [a, line] : [line, a]);
  // A neighbour's lot tile at along-coordinate a on this row, same facing:
  // the building, its tile range and its plot's depth.
  const lotTile = (a: number): { id: number; s: number; e: number; depth: number } | null => {
    const [x, y] = tile(a);
    const b = buildingAt(x, y);
    if (!b?.position) return null;
    const bd = b.object.data as Building;
    if (bd.facing !== data.facing || BLUEPRINTS[bd.kind].yard || !inLot(bd.kind, bd.facing, b.position, x, y)) return null;
    const p = plot(bd.kind, bd.facing);
    const [[ox, oy], [w, h]] = p.lot!;
    const s = alongX ? b.position.x + ox : b.position.y + oy;
    return { id: b.id, s, e: s + (alongX ? w : h), depth: alongX ? p.size[1] : p.size[0] };
  };
  const free = (a: number) => openFrontage(...tile(a), data.facing);
  const chain = [{ id: entry.id, s: a0, e: a1, depth: alongX ? own.size[1] : own.size[0] }];
  for (;;) {
    const n = lotTile(chain[0].s - 1) ?? (free(chain[0].s - 1) ? lotTile(chain[0].s - 2) : null);
    if (!n) break;
    chain.unshift(n);
  }
  for (;;) {
    const last = chain[chain.length - 1];
    const n = lotTile(last.e) ?? (free(last.e) ? lotTile(last.e + 1) : null);
    if (!n) break;
    chain.push(n);
  }
  let start = chain[0].s, end = chain[chain.length - 1].e;
  if (free(start - 1)) start -= 1;
  if (free(end)) end += 1;
  const w = end - start;
  const empties: number[] = [];
  for (let a = start; a < end; a++) if (!chain.some((c) => a >= c.s && a < c.e)) empties.push(a - start);
  const rect = alongX ? { x: start, y: line, w, h: 1 } : { x: line, y: start, w: 1, h: w };
  return {
    rect,
    w,
    depth: Math.max(...chain.map((c) => c.depth)),
    members: chain.map((c) => c.id),
    empties,
    u0: a0 - start,
    u1: a1 - start,
    first: chain[0].id === entry.id,
    yard: null,
  };
}

/** Docks against the wall of a depot w wide, the wall d tiles in from the
 *  street: 0.3 wide with a margin of 0.4 at either end, a lorry long, a
 *  divider between each, and the bay's number painted where the lorry
 *  stands, seven-segment style. Mirrors `build_yard` in `lots.rs`. */
export function yardGeometry(w: number, d: number): MeshGeometry {
  const g = flat();
  const BAY_W = 0.3, MARGIN = 0.4, WALL = 0.14, LORRY = 0.8;
  const n = Math.floor((w - 2 * MARGIN) / BAY_W + 1e-9);
  const wall = d + WALL;
  const line = 0.035;
  for (let i = 0; i <= n; i++) {
    const u = MARGIN + i * BAY_W;
    g.rect(u - line / 2, wall - LORRY - 0.05, u + line / 2, wall, MARK_Z);
  }
  for (let i = 0; i < n; i++) {
    digit(g, i + 1, MARGIN + BAY_W / 2 + i * BAY_W, wall - LORRY + 0.22);
  }
  return g.done();
}

/** A seven-segment digit, 0.1 wide and 0.16 tall, centred at (u, v),
 *  upright for someone standing on the street looking at the building. */
function digit(g: ReturnType<typeof flat>, n: number, u: number, v: number) {
  const W = 0.1, H = 0.16, t = 0.022;
  //      a
  //    f   b
  //      g
  //    e   c
  //      d
  const on: Record<number, string> = { 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg", 0: "abcdef" };
  const seg = on[n % 10] ?? "";
  const x0 = u - W / 2, x1 = u + W / 2, y0 = v - H / 2, y1 = v + H / 2, ym = v;
  // v runs into the plot, away from the street: the top of the digit is the
  // side nearer the street, so segment a sits at the low v.
  const h = (y: number, xa: number, xb: number) => g.rect(xa, y - t / 2, xb, y + t / 2, MARK_Z);
  const vert = (x: number, ya: number, yb: number) => g.rect(x - t / 2, ya, x + t / 2, yb, MARK_Z);
  if (seg.includes("a")) h(y0, x0, x1);
  if (seg.includes("g")) h(ym, x0, x1);
  if (seg.includes("d")) h(y1, x0, x1);
  if (seg.includes("f")) vert(x0, y0, ym);
  if (seg.includes("b")) vert(x1, y0, ym);
  if (seg.includes("e")) vert(x0, ym, y1);
  if (seg.includes("c")) vert(x1, ym, y1);
}

/** The run's one slab, kerb and all, in the run's frame: from the street
 *  side to the back of its plots. */
export function runSlabGeometry(w: number, depth: number, kerb: boolean): MeshGeometry {
  const g = slabGeometry(w, depth, kerb);
  for (let i = 0; i < g.positions.length; i += 3) {
    g.positions[i] += w / 2;
    g.positions[i + 1] += depth / 2;
  }
  return g;
}

/** A dashed footprint on an empty plot of the run: where the next
 *  building can land, drawn at u = 0 of the tile, behind the lot row. */
export function emptyPlotGeometry(depth: number): MeshGeometry {
  const g = flat();
  const m = 0.16, dash = 0.1, gap = 0.07, line = 0.03;
  const [u0, v0, u1, v1] = [m, 1 + m, 1 - m, depth - m];
  const along = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const [dx, dy] = [(x1 - x0) / len, (y1 - y0) / len];
    for (let t = 0; t < len; t += dash + gap) {
      const l = Math.min(dash, len - t);
      const [ax, ay, bx, by] = [x0 + dx * t, y0 + dy * t, x0 + dx * (t + l), y0 + dy * (t + l)];
      g.rect(Math.min(ax, bx) - (dx ? 0 : line / 2), Math.min(ay, by) - (dy ? 0 : line / 2), Math.max(ax, bx) + (dx ? 0 : line / 2), Math.max(ay, by) + (dy ? 0 : line / 2), MARK_Z);
    }
  };
  along(u0, v0, u1, v0);
  along(u1, v0, u1, v1);
  along(u0, v1, u1, v1);
  along(u0, v0, u0, v1);
  return g.done();
}

/** The rotation that lays the frame onto the map for a facing, and where
 *  the frame's origin sits on the lot rectangle's tiles. */
export function frameOf(facing: number, lot: { x: number; y: number; w: number; h: number }) {
  switch (facing % 4) {
    case 0: return { rot: 0, origin: [lot.x, lot.y] as const };
    case 1: return { rot: Math.PI / 2, origin: [lot.x + lot.w, lot.y] as const };
    case 2: return { rot: Math.PI, origin: [lot.x + lot.w, lot.y + lot.h] as const };
    default: return { rot: -Math.PI / 2, origin: [lot.x, lot.y + lot.h] as const };
  }
}

function flat() {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const quad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number], z: number) => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) { positions.push(p[0], p[1], z); normals.push(0, 0, 1); }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  return {
    /** An axis-aligned strip between two corners. */
    rect(x0: number, y0: number, x1: number, y1: number, z: number) {
      quad([x0, y0], [x1, y0], [x1, y1], [x0, y1], z);
    },
    disc(cx: number, cy: number, r: number, z: number, sides = 10) {
      const base = positions.length / 3;
      positions.push(cx, cy, z); normals.push(0, 0, 1);
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        positions.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z); normals.push(0, 0, 1);
      }
      for (let i = 0; i < sides; i++) indices.push(base, base + 1 + ((i + 1) % sides), base + 1 + i);
    },
    done: (): MeshGeometry => ({ positions, indices, normals }),
  };
}

/** The dividers between neighbouring spots in a lot w wide. */
export function markingGeometry(w: number): MeshGeometry {
  const g = flat();
  const cl = CAR[0] / 2 + 0.03;
  const us = spotsAcross(w);
  for (let i = 0; i + 1 < us.length; i++) {
    const u = (us[i] + us[i + 1]) / 2;
    g.rect(u - MARK / 2, 0.5 - cl, u + MARK / 2, 0.5 + cl, MARK_Z);
  }
  return g.done();
}
