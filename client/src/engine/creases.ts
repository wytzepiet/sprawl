import type { MeshGeometry } from "./geometry";

type Numbers = ArrayLike<number>;
/** A shape with its creases found (`bevelled`), as it is handed to a mesh
 *  (`bevel.ts`): in lists, or in arrays come from a worker. */
export interface Bevelled { positions: Numbers; normals: Numbers; indices: Numbers; uvs?: Numbers; colors?: Numbers; across: Numbers[]; reach: Numbers; at: Numbers }

/** Faces meeting at less than this many degrees make no crease. */
const MIN_ANGLE = 12;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * `geo`, every triangle its own three vertices in order, with what the
 * bevel needs: up to three creases it lies by, each the facing across it
 * and each corner's distance from its line. A crease is an edge of its own,
 * or one of a triangle of the same face that touches one of its corners: a
 * face cut into long thin triangles still knows the crease along its edge
 * all the way up to it, not only in the triangles whose edge it is.
 */
export function bevelled(geo: MeshGeometry & { colors?: number[] }): MeshGeometry & { colors?: number[]; across: number[][]; reach: number[]; at: number[] } & Bevelled {
  const p = geo.positions;
  const at = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  // Each vertex's place, numbered: vertices at one place share a number.
  const count = p.length / 3;
  const places = new Map<string, number>();
  const place = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
    place[i] = places.get(k) ?? (places.set(k, places.size), places.size - 1);
  }
  const tris: { v: V3[]; n: V3; c: V3; src: number[] }[] = [];
  const edges = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (place[a] < place[b] ? place[a] * count + place[b] : place[b] * count + place[a]);
  const file = <T>(into: Map<number, T[]>, k: number, tri: T) => {
    const list = into.get(k);
    if (list) list.push(tri);
    else into.set(k, [tri]);
  };
  for (let t = 0; t < geo.indices.length; t += 3) {
    const src = [geo.indices[t], geo.indices[t + 1], geo.indices[t + 2]];
    const v = src.map(at);
    let n = unit(cross(sub(v[1], v[0]), sub(v[2], v[0])));
    if (geo.normals.length && dot(n, [geo.normals[src[0] * 3], geo.normals[src[0] * 3 + 1], geo.normals[src[0] * 3 + 2]]) < 0) n = [-n[0], -n[1], -n[2]];
    const c: V3 = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3, (v[0][2] + v[1][2] + v[2][2]) / 3];
    const ti = tris.push({ v, n, c, src }) - 1;
    for (let k = 0; k < 3; k++) file(edges, edgeKey(src[(k + 1) % 3], src[(k + 2) % 3]), ti);
  }

  // Every triangle's own creases, and each filed by its two ends.
  interface Crease { a: V3; b: V3; across: V3; line: number; tri: number }
  const cosMin = Math.cos((MIN_ANGLE * Math.PI) / 180);
  const byCorner = new Map<number, Crease[]>();
  const own = tris.map((tri, ti): Crease[] => {
    const found: Crease[] = [];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [tri.v[(k + 1) % 3], tri.v[(k + 2) % 3]];
      // Across the edge: the one other face, not counting one that faces
      // down — an eave also closes a roof from beneath, and that face is
      // never seen.
      const line = edgeKey(tri.src[(k + 1) % 3], tri.src[(k + 2) % 3]);
      const other = edges.get(line)!.filter((x) => x !== ti && (tri.n[2] < -0.5 || tris[x].n[2] > -0.5));
      if (other.length !== 1) continue;
      const o = tris[other[0]];
      if (dot(tri.n, o.n) > cosMin) continue;
      // Over, not in: the other face lies below this one's plane.
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (dot(sub(o.c, mid), tri.n) > -1e-5) continue;
      const crease = { a, b, across: o.n, line, tri: ti };
      found.push(crease);
      file(byCorner, place[tri.src[(k + 1) % 3]], crease);
      file(byCorner, place[tri.src[(k + 2) % 3]], crease);
    }
    return found;
  });
  /** A point's distance from the line through a and b. */
  const fromLine = (v: V3, a: V3, b: V3) => {
    const e = sub(b, a);
    return Math.hypot(...cross(e, sub(v, a))) / Math.hypot(...e);
  };

  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[], colors: geo.colors ? ([] as number[]) : undefined, uvs: geo.uvs ? ([] as number[]) : undefined, across: [[], [], []] as number[][], reach: [] as number[], at: [] as number[] };
  tris.forEach((tri, ti) => {
    // Its own creases first, then its face's that touch its corners.
    const mine: Crease[] = [...own[ti]];
    const plane = dot(tri.n, tri.v[0]);
    for (const corner of tri.src) {
      for (const crease of byCorner.get(place[corner]) ?? []) {
        if (mine.length === 3) break;
        const o = tris[crease.tri];
        if (dot(o.n, tri.n) < 0.9999 || Math.abs(dot(tri.n, o.v[0]) - plane) > 1e-5) continue;
        if (!mine.some((m) => m.line === crease.line)) mine.push(crease);
      }
    }
    const across: V3[] = [0, 1, 2].map((j) => mine[j]?.across ?? tri.n);
    const reach: V3 = [0, 1, 2].map((j) => (mine[j] ? 1 : 0)) as V3;
    for (let k = 0; k < 3; k++) {
      const s = tri.src[k];
      out.positions.push(...tri.v[k]);
      // The mesh's own facing, which a rim already turns.
      out.normals.push(...(geo.normals.length ? [geo.normals[s * 3], geo.normals[s * 3 + 1], geo.normals[s * 3 + 2]] : tri.n));
      if (out.uvs) out.uvs.push(geo.uvs![s * 2], geo.uvs![s * 2 + 1]);
      if (out.colors) out.colors.push(geo.colors![s * 4], geo.colors![s * 4 + 1], geo.colors![s * 4 + 2], geo.colors![s * 4 + 3]);
      out.indices.push(ti * 3 + k);
      for (let j = 0; j < 3; j++) out.across[j].push(...across[j]);
      out.reach.push(...reach);
      // Its distance from each crease's line: the shader's `at * reach`.
      for (let j = 0; j < 3; j++) out.at.push(mine[j] ? fromLine(tri.v[k], mine[j].a, mine[j].b) : 0);
    }
  });
  return out;
}
