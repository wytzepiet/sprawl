import type { MeshGeometry } from "../Mesh";

/** A box in x and y: x0, y0, x1, y1. */
export type Box = [number, number, number, number];

/**
 * A mesh cut to a box in x and y: every triangle kept as it lies within it,
 * cut where it crosses, each piece's corners blended along the cut — where,
 * which way it faces and its colour — and wound as the triangle was.
 */
export function clipTo(g: MeshGeometry & { colors?: number[] }, [x0, y0, x1, y1]: Box, triangles?: number[]): MeshGeometry & { colors?: number[] } {
  const out: MeshGeometry & { colors?: number[] } = { positions: [], normals: [], indices: [], colors: g.colors ? [] : undefined };
  type Pt = { p: number[]; n: number[]; c: number[] };
  const P = g.positions, N = g.normals, C = g.colors;
  const sides: [0 | 1, number, number][] = [[0, 1, x0], [0, -1, x1], [1, 1, y0], [1, -1, y1]];
  const at = (i: number): Pt => ({ p: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], n: [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]], c: C ? C.slice(i * 4, i * 4 + 4) : [] });
  for (const t of triangles ?? Array.from({ length: g.indices.length / 3 }, (_, i) => i * 3)) {
    let poly = [at(g.indices[t]), at(g.indices[t + 1]), at(g.indices[t + 2])];
    const xs = poly.map((q) => q.p[0]), ys = poly.map((q) => q.p[1]);
    if (Math.max(...xs) <= x0 || Math.min(...xs) >= x1 || Math.max(...ys) <= y0 || Math.min(...ys) >= y1) continue;
    for (const [axis, sign, edge] of sides) {
      const inside = (q: Pt) => sign * (q.p[axis] - edge) >= 0;
      const next: Pt[] = [];
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        if (inside(a)) next.push(a);
        if (inside(a) !== inside(b)) {
          const s = (edge - a.p[axis]) / (b.p[axis] - a.p[axis]);
          const lerp = (u: number[], v: number[]) => u.map((x, k) => x + (v[k] - x) * s);
          const n = lerp(a.n, b.n);
          const len = Math.hypot(n[0], n[1], n[2]) || 1;
          next.push({ p: lerp(a.p, b.p), n: n.map((x) => x / len), c: lerp(a.c, b.c) });
        }
      });
      poly = next;
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;
    const base = out.positions.length / 3;
    for (const q of poly) {
      out.positions.push(...q.p);
      out.normals.push(...q.n);
      if (out.colors) out.colors.push(...q.c);
    }
    for (let i = 1; i + 1 < poly.length; i++) out.indices.push(base, base + i, base + i + 1);
  }
  return out;
}

/** A mesh's triangles filed by the cells of a grid they reach into: each
 *  triangle's first index, under every cell its box, `pad` wider, touches. */
export function fileBy(g: MeshGeometry, cell: (x: number, y: number) => [number, number], key: (cx: number, cy: number) => string, pad = 0): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const P = g.positions;
  for (let t = 0; t < g.indices.length; t += 3) {
    const xs = [0, 1, 2].map((k) => P[g.indices[t + k] * 3]), ys = [0, 1, 2].map((k) => P[g.indices[t + k] * 3 + 1]);
    const [lo, hi] = [cell(Math.min(...xs) - pad, Math.min(...ys) - pad), cell(Math.max(...xs) + pad, Math.max(...ys) + pad)];
    for (let cy = Math.min(lo[1], hi[1]); cy <= Math.max(lo[1], hi[1]); cy++)
      for (let cx = Math.min(lo[0], hi[0]); cx <= Math.max(lo[0], hi[0]); cx++) {
        const k = key(cx, cy);
        (out.get(k) ?? out.set(k, []).get(k)!).push(t);
      }
  }
  return out;
}
