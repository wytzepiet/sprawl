import type { MeshGeometry } from "./Mesh";

/**
 * A sheet's kerbs and the lines painted on it, as geometry alone: what the
 * kerb textures are made from (`kerbs.ts`), here apart from them so the
 * town can be drawn where there is no Babylon (`townWorker.ts`).
 */

/** Which of a sheet's own edges are kerbs: all, or those this says. */
export type KerbRule = (a: number[], b: number[], out: number[]) => boolean;

/** A kerb: an edge of a sheet, and the way into the sheet. */
export type Kerb = { a: number[]; b: number[]; inward: number[] };

/** A sheet's kerbs: each edge only one of its triangles has, where `kerb`
 *  says it is one, with the way into the sheet. */
export function kerbsOf(g: MeshGeometry, kerb: KerbRule = () => true): Kerb[] {
  const p = g.positions;
  const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const key = (v: number[]) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < g.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [ka, kb] = [key(at(g.indices[t + k])), key(at(g.indices[t + ((k + 1) % 3)]))];
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  const out: Kerb[] = [];
  for (let t = 0; t < g.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => at(g.indices[t + k]));
    const c = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [v[k], v[(k + 1) % 3]];
      const [ka, kb] = [key(a), key(b)];
      if (count.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`) !== 1) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let o = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      if ((a[0] - c[0]) * o[0] + (a[1] - c[1]) * o[1] < 0) o = [-o[0], -o[1]];
      if (!kerb(a, b, o)) continue;
      out.push({ a, b, inward: [-o[0], -o[1]] });
    }
  }
  return out;
}

/** A line painted on a sheet: from a to b, half as wide as it is. */
export type Line = { a: number[]; b: number[]; half: number };

/** Lines given as thin rectangles, four corners each in the town's frame,
 *  as each runs down its middle, in a sheet's (x and y the other way). */
export function stripLines(strips: number[][][]): Line[] {
  return strips.map(([p0, p1, p2, p3]) => {
    const mid = (u: number[], v: number[]) => [-(u[0] + v[0]) / 2, -(u[1] + v[1]) / 2];
    const [across, along] = [Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p3[0] - p0[0], p3[1] - p0[1])];
    return along >= across ? { a: mid(p0, p1), b: mid(p3, p2), half: across / 2 } : { a: mid(p0, p3), b: mid(p1, p2), half: along / 2 };
  });
}
