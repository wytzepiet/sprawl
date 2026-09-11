import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import type { GridCoord } from "../../generated";
import type { Look } from "./look";
import { buildKerbGeometry, buildRoadGeometry, type ArmInfo } from "./roadGeometry";

/**
 * Tyre marks and the ploughed strip, drawn as a road is: a shape per tile
 * of the path from the arms to the tiles before and after it, so corners
 * and ends join as a road's do. The marks are the road's kerbs without the
 * road — two faint stripes a wheel apart with nothing between, so where
 * two paths cross all four show — and under the plough a strip a tile wide
 * in the field's colour, which is the ground turned brown behind the
 * tractor before the terrain catches up. The tile the tractor is on is a
 * straight piece stretched to where it is, until it reaches the next.
 */
export const RUT = Color3.FromHexString("#B49E5C");
export const FIELD = Color3.FromHexString("#C9B26A");
/** Half the track: how far each wheel runs from the path's centre. */
const TRACK = 0.13;
const STRIPE = 0.045;
const RUT_Z = 0.014;
const STRIP_Z = 0.011;

export type Laid = { key: string; id: number };

/** The arms of a tile of the path: toward the tile before and the tile after. */
function armsAt(path: GridCoord[], k: number): ArmInfo[] {
  const arms: ArmInfo[] = [];
  for (const j of [k - 1, k + 1]) {
    if (j < 0 || j >= path.length) continue;
    const dx = path[j].x - path[k].x, dy = path[j].y - path[k].y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    arms.push({ angle: angle < 0 ? angle + 2 * Math.PI : angle, flow: "twoway" });
  }
  return arms;
}

/** Lay the marks on one tile of the path, and the strip under it if asked. */
export function layTile(pool: InstancePool, look: Look, path: GridCoord[], k: number, strip: boolean): Laid[] {
  const arms = armsAt(path, k);
  if (arms.length === 0) return [];
  const key = arms.map((a) => a.angle.toFixed(3)).sort().join("_");
  const at: [number, number, number] = [path[k].x + 0.5, path[k].y + 0.5, 0];
  const out: Laid[] = [];
  if (strip) {
    const bk = `strip_${key}${look.key}`;
    const geo = buildRoadGeometry(arms, 0.5, STRIP_Z);
    if (geo) {
      pool.ensureBucket(bk, geo, look.tint(FIELD), false, true);
      out.push({ key: bk, id: pool.addInstance(bk, at) });
    }
  }
  const bk = `rut_${key}${look.key}`;
  const geo = buildKerbGeometry(arms, TRACK + STRIPE / 2, TRACK - STRIPE / 2, RUT_Z);
  if (geo) {
    pool.ensureBucket(bk, geo, look.tint(RUT), false, true);
    out.push({ key: bk, id: pool.addInstance(bk, at) });
  }
  return out;
}

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

/** A straight unit step of marks, from x = 0 to 1: the tile being driven. */
const RUT_STEP = quads([[0, TRACK - STRIPE / 2, 1, TRACK + STRIPE / 2], [0, -TRACK - STRIPE / 2, 1, -TRACK + STRIPE / 2]], RUT_Z);
const STRIP_STEP = quads([[0, -0.5, 1, 0.5]], STRIP_Z);

function segment(a: GridCoord, b: GridCoord): { pos: [number, number, number]; rot: [number, number, number]; len: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { pos: [a.x + 0.5, a.y + 0.5, 0], rot: [0, 0, Math.atan2(dy, dx)], len: Math.hypot(dx, dy) };
}

/** Lay the straight piece from one tile's centre toward the next, `part`
 *  of the way. */
export function layHead(pool: InstancePool, look: Look, a: GridCoord, b: GridCoord, part: number, strip: boolean): Laid[] {
  const { pos, rot, len } = segment(a, b);
  const scale: [number, number, number] = [len * part, 1, 1];
  const out: Laid[] = [];
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

/** Stretch the head to a new part of its segment. */
export function stretch(pool: InstancePool, laid: Laid[], a: GridCoord, b: GridCoord, part: number): void {
  const { pos, rot, len } = segment(a, b);
  for (const { key, id } of laid) pool.updateInstance(key, id, pos, rot, [len * part, 1, 1]);
}
