import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import type { GridCoord } from "../../generated";
import type { Look } from "./look";

/**
 * Tyre marks and the ploughed strip, as segments between tile centres.
 * A segment is a unit shape along x, scaled to the segment's length and
 * turned to its heading, so a path is one instance a step: two faint
 * stripes a wheel apart with nothing between them, so where two paths
 * cross all four stripes show; and, under the plough, a strip a tile wide
 * in the field's colour, which is the ground turned brown behind the
 * tractor before the terrain catches up.
 */
export const RUT = Color3.FromHexString("#B49E5C");
export const FIELD = Color3.FromHexString("#C9B26A");
/** Half the track: how far each wheel runs from the path's centre. */
const TRACK = 0.13;
const STRIPE = 0.045;
const RUT_Z = 0.014;
const STRIP_Z = 0.011;

type Geo = { positions: number[]; normals: number[]; indices: number[] };

function quads(rects: [number, number, number, number][], z: number): Geo {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (const [x0, y0, x1, y1] of rects) {
    const base = positions.length / 3;
    // Wound as the lots' slabs are, so the face is up.
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) { positions.push(x, y, z); normals.push(0, 0, 1); }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, normals, indices };
}

/** A unit step of tyre marks: two stripes from x = 0 to 1, a track apart. */
export const RUT_STEP = quads([[0, TRACK - STRIPE / 2, 1, TRACK + STRIPE / 2], [0, -TRACK - STRIPE / 2, 1, -TRACK + STRIPE / 2]], RUT_Z);
/** A unit step of ploughed ground: a tile wide, from x = 0 to 1, a little
 *  over at each end so consecutive steps and corners leave no gap. */
export const STRIP_STEP = quads([[-0.08, -0.5, 1.08, 0.5]], STRIP_Z);

/** A segment's place: from one tile's centre, turned toward the next, and
 *  how long it is. */
export function segment(a: GridCoord, b: GridCoord): { pos: [number, number, number]; rot: [number, number, number]; len: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { pos: [a.x + 0.5, a.y + 0.5, 0], rot: [0, 0, Math.atan2(dy, dx)], len: Math.hypot(dx, dy) };
}

export type Laid = { key: string; id: number };

/** Lay one step of marks, and the strip under it if asked, scaled to `part`
 *  of the segment. */
export function layStep(pool: InstancePool, look: Look, a: GridCoord, b: GridCoord, part: number, strip: boolean): Laid[] {
  const { pos, rot, len } = segment(a, b);
  const out: Laid[] = [];
  const scale: [number, number, number] = [len * part, 1, 1];
  if (strip) {
    const key = `strip_step${look.key}`;
    pool.ensureBucket(key, STRIP_STEP, look.tint(FIELD), false, true);
    out.push({ key, id: pool.addInstance(key, pos, rot, scale) });
  }
  const key = `rut_step${look.key}`;
  pool.ensureBucket(key, RUT_STEP, look.tint(RUT), false, true);
  out.push({ key, id: pool.addInstance(key, pos, rot, scale) });
  return out;
}

/** Rescale a laid step to a new part of its segment. */
export function stretch(pool: InstancePool, laid: Laid[], a: GridCoord, b: GridCoord, part: number): void {
  const { pos, rot, len } = segment(a, b);
  for (const { key, id } of laid) pool.updateInstance(key, id, pos, rot, [len * part, 1, 1]);
}
