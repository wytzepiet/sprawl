import type { MeshGeometry } from "../Mesh";
import { slabGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, plot } from "../../blueprints";
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

/** A building's lot, as drawn: the rectangle of lot tiles on the grid, its
 *  width along the frontage, how deep the plot is, and whether it is a
 *  depot's yard of docks rather than a ring. Mirrors `run_of` in `lots.rs`. */
export interface Run {
  rect: { x: number; y: number; w: number; h: number };
  w: number;
  depth: number;
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
  const rect = { x: pos.x + lx, y: pos.y + ly, w: gw, h: gh };
  const w = alongX ? gw : gh;
  const depth = alongX ? own.size[1] : own.size[0];
  return { rect, w, depth, yard: BLUEPRINTS[data.kind].yard ? (alongX ? gh : gw) : null };
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
