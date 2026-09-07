import type { MeshGeometry } from "../Mesh";
import { SLAB } from "./buildings";

/**
 * A ring lot, drawn: the slab is the lot, white like a street, and what is
 * painted on it is the dividers between the spots in the island and the
 * driveway's stub to the front edge. Mirrors the server's `lots.rs` so a
 * car sits between its dividers: the numbers here are the numbers there.
 *
 * Built in the lot's own frame, u along the frontage and v in from the
 * street, and turned into place per facing. That frame is chosen so the
 * turn is a rotation, never a mirror: a mirrored instance is inside out.
 */
const RING = 0.2;
const LANE = 0.2;
const PITCH = 0.2;
const ISLAND_END = 0.3;
const CAR: [number, number] = [0.35, 0.18];
export const LOT_Z = SLAB.z + 0.004;
const MARK_Z = LOT_Z + 0.002;
const MARK = 0.035;

/** Where the spots' centres lie along a lot w wide. */
export function spotsAcross(w: number): number[] {
  const n = Math.max(0, Math.floor((w - 2 * ISLAND_END) / PITCH + 1e-9));
  const start = ISLAND_END + ((w - 2 * ISLAND_END) - n * PITCH) / 2 + PITCH / 2;
  return Array.from({ length: n }, (_, i) => start + i * PITCH);
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

/** A tile's position in the frame: (u, v) of its centre. */
export function inFrame(facing: number, lot: { x: number; y: number; w: number; h: number }, x: number, y: number): [number, number] {
  const cx = x + 0.5, cy = y + 0.5;
  const { origin } = frameOf(facing, lot);
  const [dx, dy] = [cx - origin[0], cy - origin[1]];
  switch (facing % 4) {
    case 0: return [dx, dy];
    case 1: return [dy, -dx];
    case 2: return [-dx, -dy];
    default: return [-dy, dx];
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

/** The driveway's stub, from the lot's front edge in to the front lane, so
 *  the street's arm and the slab meet across the strip of land between. */
export function stubGeometry(du: number): MeshGeometry {
  const g = flat();
  g.rect(du - LANE, -0.02, du + LANE, RING, LOT_Z);
  return g.done();
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
