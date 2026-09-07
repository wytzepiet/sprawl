import type { MeshGeometry } from "../Mesh";
import { SLAB } from "./buildings";
import { FACINGS, inLot, plot } from "../../blueprints";
import { buildingAt } from "../../state/gameObjects";
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

/** A lot as a run of touching lot tiles along one frontage: the rectangle
 *  of lot tiles on the grid, the run's width along the frontage, and where
 *  this building's own tiles lie in it. Mirrors `run_of` in `lots.rs`. */
export interface Run {
  rect: { x: number; y: number; w: number; h: number };
  w: number;
  u0: number;
  u1: number;
  first: boolean;
  last: boolean;
}

export function runOf(entry: GameObjectEntry): Run | null {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const lot = plot(data.kind, data.facing).lot;
  if (!pos || !lot) return null;
  const [[lx, ly], [lw]] = lot;
  const alongX = FACINGS[data.facing % 4][0] === 0;
  const [line, a0, a1] = alongX ? [pos.y + ly, pos.x + lx, pos.x + lx + lw] : [pos.x + lx, pos.y + ly, pos.y + ly + lw];
  // A neighbour's lot tile at along-coordinate a on this row, same facing.
  const lotTile = (a: number): [number, number] | null => {
    const [x, y] = alongX ? [a, line] : [line, a];
    const b = buildingAt(x, y);
    if (!b?.position) return null;
    const bd = b.object.data as Building;
    if (bd.facing !== data.facing || !inLot(bd.kind, bd.facing, b.position, x, y)) return null;
    const [[ox, oy], [w]] = plot(bd.kind, bd.facing).lot!;
    const s = alongX ? b.position.x + ox : b.position.y + oy;
    return [s, s + w];
  };
  let start = a0, end = a1;
  for (let n = lotTile(start - 1); n; n = lotTile(start - 1)) start = n[0];
  for (let n = lotTile(end); n; n = lotTile(end)) end = n[1];
  const w = end - start;
  const rect = alongX ? { x: start, y: line, w, h: 1 } : { x: line, y: start, w: 1, h: w };
  return { rect, w, u0: a0 - start, u1: a1 - start, first: start === a0, last: end === a1 };
}

/** The strip that joins two neighbours' slabs across the land between
 *  them, at u = seam, over a depth of d tiles from the front: as wide as
 *  the two inset corners it covers, so the run reads as one slab. */
export function bridgeGeometry(seam: number, d: number, kerb: boolean): MeshGeometry {
  const g = flat();
  const grow = kerb ? SLAB.kerb : 0;
  const reach = SLAB.inset + SLAB.radius;
  g.rect(seam - reach, SLAB.inset - grow, seam + reach, d - SLAB.inset + grow, 0);
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
