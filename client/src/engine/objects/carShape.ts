import type { MeshGeometry } from "../Mesh";

/**
 * A car as a toy: a low body, its corners rounded seen from above as a
 * house's are, its bonnet falling away to the nose; and on it a
 * glasshouse, narrower and shorter, its windscreen raked long from where
 * the bonnet ends and its back window short and steep at the tail, a
 * hatchback's, under a flat roof. The roof is in the car's
 * colour, the glass a darker shade of it: a vertex's colour scales the
 * car's. `w` across, `l` long with the front toward +y, `h` high, its
 * middle at the origin, as `boxGeometry` makes a box. Its slopes are its
 * points' heights alone: no triangle more than a box with rounded
 * corners has.
 */
export function carShape(w: number, l: number, h: number): MeshGeometry & { colors: number[] } {
  const g = { positions: [] as number[], normals: [] as number[], indices: [] as number[], colors: [] as number[] };
  const nose = l * 0.28;
  // The body's top: level back to the windscreen, falling from there to
  // the nose, as a bonnet does.
  const shoulder = (y: number) => -h / 2 + h * (BODY - BONNET * Math.max(0, (y - nose) / (l / 2 - nose)) ** 1.5);
  // Points down the sides where the bonnet begins, so it falls from there.
  const bottom = ring(w / 2, -l / 2, l / 2, w * 0.23, () => -h / 2, nose);
  const body = ring(w / 2, -l / 2, l / 2, w * 0.23, shoulder, nose);
  const base = ring(w / 2 - w * 0.08, -l * 0.44, nose, w * 0.17, shoulder);
  const roof = ring(w / 2 - w * 0.16, -l * 0.36, 0, w * 0.12, () => -h / 2 + h * ROOF);
  band(g, bottom, body, PAINT);
  band(g, base, roof, GLASS);
  // The body's top flat behind the bonnet; the bonnet a fan from the middle
  // of where it begins, each triangle falling evenly to the nose.
  const start = body.findIndex(([, y]) => y === nose && body.some(([, y2]) => y2 > nose));
  const turned = [...body.slice(start), ...body.slice(0, start)];
  const split = turned.findIndex(([, y], i) => i > 0 && y === nose);
  const [bonnet, back] = [[...turned.slice(split), turned[0]], turned.slice(0, split + 1)];
  cap(g, bonnet, [0, nose, shoulder(nose)]);
  cap(g, back, [0, (nose - l / 2) / 2, shoulder(0)]);
  cap(g, roof, [0, -l * 0.18, -h / 2 + h * ROOF]);
  return g;
}

/** How far in a vehicle's edges round over, in tiles (`bevel.ts`):
 *  tighter than a building's, a car being so small. */
export const ROUNDING = 0.02;

/** The body's height at the windscreen, how far the bonnet falls by the
 *  nose, and the roof's height, each of the car's. */
const BODY = 0.66;
const BONNET = 0.06;
const ROOF = 0.88;
const PAINT = [1, 1, 1, 1];
/** Glass: a darker shade of the car's own colour. */
const GLASS = [0.45, 0.45, 0.45, 1];
/** Points to a rounded corner. */
const ROUND = 3;

type P = [number, number, number];

/** A rounded rectangle seen from above, half `hw` wide from y0 to y1, its
 *  corners of radius r, each point at the height `z` gives there, and a
 *  point more down each side at `cut`, if given: its outline,
 *  counter-clockwise. */
function ring(hw: number, y0: number, y1: number, r: number, z: (y: number) => number, cut?: number): P[] {
  const out: P[] = [];
  const corners: [number, number, number][] = [[hw - r, y1 - r, 0], [-hw + r, y1 - r, 90], [-hw + r, y0 + r, 180], [hw - r, y0 + r, 270]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i < ROUND; i++) {
      const a = ((a0 + (90 * i) / (ROUND - 1)) * Math.PI) / 180;
      const y = cy + r * Math.sin(a);
      out.push([cx + r * Math.cos(a), y, z(y)]);
    }
    // Down the side that follows the corner, left going back, right forward.
    if (cut !== undefined && a0 === 90) out.push([-hw, cut, z(cut)]);
    if (cut !== undefined && a0 === 270) out.push([hw, cut, z(cut)]);
  }
  return out;
}

/** The sides from one outline up to another of as many points: each quad
 *  flat, facing out. */
function band(g: ReturnType<typeof carShape>, lo: P[], hi: P[], colour: number[]) {
  for (let i = 0; i < lo.length; i++) {
    const j = (i + 1) % lo.length;
    const [mx, my] = [(lo[i][0] + lo[j][0]) / 2, (lo[i][1] + lo[j][1]) / 2];
    face(g, [lo[i], lo[j], hi[j], hi[i]], [mx, my, 0], colour);
  }
}

/** An outline closed by a fan from `mid`, each triangle flat, facing up;
 *  none where a pair lies in line with it. */
function cap(g: ReturnType<typeof carShape>, outline: P[], mid: P) {
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    let n = cross(sub(a, mid), sub(b, mid));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
    if (n[2] < 0) n = n.map((v) => -v);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / len);
    const at = g.positions.length / 3;
    for (const p of [mid, a, b]) g.positions.push(...p), g.normals.push(...n), g.colors.push(...PAINT);
    tri(g, at, at + 1, at + 2, n);
  }
}

/** A flat quad, facing as far as it can toward `out`, a fan round its
 *  middle so the bevel rounds each edge whole (`boxGeometry`). */
function face(g: ReturnType<typeof carShape>, quad: number[][], out: number[], colour: number[]) {
  const [a, b, c] = quad;
  let n = cross(sub(b, a), sub(c, a));
  if (dot(n, out) < 0) n = n.map((v) => -v);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = n.map((v) => v / len);
  const base = g.positions.length / 3;
  const mid = [0, 1, 2].map((k) => quad.reduce((s, p) => s + p[k], 0) / 4);
  for (const p of [mid, ...quad]) g.positions.push(p[0], p[1], p[2]), g.normals.push(n[0], n[1], n[2]), g.colors.push(...colour);
  for (let i = 0; i < 4; i++) tri(g, base, base + 1 + i, base + 1 + ((i + 1) % 4), n);
}

/** A triangle, wound so that it faces `n`: under Babylon's left-handed
 *  default, as `boxGeometry` winds, (b - a) × (c - a) points in. */
function tri(g: ReturnType<typeof carShape>, a: number, b: number, c: number, n: number[]) {
  const at = (i: number) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  const inward = dot(cross(sub(at(b), at(a)), sub(at(c), at(a))), n) < 0;
  g.indices.push(...(inward ? [a, b, c] : [a, c, b]));
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
