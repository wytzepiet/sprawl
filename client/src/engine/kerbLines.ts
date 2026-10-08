import type { MeshGeometry } from "./geometry";
import { fillTriangles } from "./raster";
import { RIM, runsOn } from "./town/draw";

/**
 * A sheet's kerbs and the lines painted on it, and how far each point of a
 * grid over it lies from them, as numbers alone: what the kerb textures
 * are made of (`kerbs.ts`) and the tile shapes are baked from (`atlas.ts`),
 * here apart from Babylon so they can be worked out on a worker
 * (`townWorker.ts`).
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

/** Texels to a tile, at most; a big sheet takes fewer. */
const DENSITY = 32;
/** The longest side a kerb texture may have, in texels. */
const MOST = 2048;
/** Beyond reach of every kerb. */
export const FAR = 1;

/** A box in a sheet's frame: x0, y0, x1, y1. */
export type Extent = [number, number, number, number];

/** The box a sheet covers. */
export function extentOf(g: MeshGeometry): Extent {
  const p = g.positions;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) [x0, y0, x1, y1] = [Math.min(x0, p[i]), Math.min(y0, p[i + 1]), Math.max(x1, p[i]), Math.max(y1, p[i + 1])];
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

/**
 * A sheet's kerb distances over a box of it: at
 * each texel within reach of a kerb, the signed distance to the nearest,
 * inside or out read off that kerb.
 */
export function kerbData(kerbs: Kerb[], extent: Extent) {
  let [x0, y0, x1, y1] = extent;
  const density = Math.min(DENSITY, MOST / Math.max(x1 - x0 + 0.5, y1 - y0 + 0.5));
  const reach = RIM + 2 / density;
  [x0, y0] = [x0 - reach, y0 - reach];
  const [w, h] = [Math.max(2, Math.ceil((x1 + reach - x0) * density)), Math.max(2, Math.ceil((y1 + reach - y0) * density))];
  const data = kerbDistances(kerbs, x0, y0, density, w, h);
  return { data, density, origin: [x0, y0] as [number, number], size: [w / density, h / density] as [number, number], texels: [w, h] as [number, number] };
}

/**
 * Signed distances to kerbs over a grid of `w` by `h` texels, `density`
 * to a tile, from (x0, y0): at each texel within reach of a kerb, the
 * distance to the nearest, inside or out read off that kerb; beyond reach
 * of all (the town's rim, unless said), FAR. Each kerb visits only the
 * band of texels within reach of it, a row's stretch at a time.
 */
export function kerbDistances(kerbs: Kerb[], x0: number, y0: number, density: number, w: number, h: number, reach = RIM + 2 / density): Float32Array {
  const [x1, y1] = [x0 + w / density, y0 + h / density];
  const data = new Float32Array(w * h).fill(FAR);
  const best = new Float32Array(w * h).fill(Infinity);
  for (const { a, b, inward } of kerbs) {
    if (Math.max(a[0], b[0]) < x0 - reach || Math.min(a[0], b[0]) > x1 + reach || Math.max(a[1], b[1]) < y0 - reach || Math.min(a[1], b[1]) > y1 + reach) continue;
    const [ax, ay, ex, ey] = [a[0], a[1], b[0] - a[0], b[1] - a[1]];
    const len2 = ex * ex + ey * ey || 1;
    const [nx, ny] = inward;
    const [bx0, bx1] = [Math.min(a[0], b[0]) - reach, Math.max(a[0], b[0]) + reach];
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach - y0) * density));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(a[1], b[1]) + reach - y0) * density));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) / density;
      // The row's stretch within reach of the kerb's line, in its box.
      let [lo, hi] = [bx0, bx1];
      if (Math.abs(nx) > 1e-6) {
        const [u, v] = [ax + (-reach - ny * (py - ay)) / nx, ax + (reach - ny * (py - ay)) / nx];
        [lo, hi] = [Math.max(lo, Math.min(u, v)), Math.min(hi, Math.max(u, v))];
      } else if (Math.abs(ny * (py - ay)) > reach) continue;
      const i0 = Math.max(0, Math.floor((lo - x0) * density));
      const i1 = Math.min(w - 1, Math.ceil((hi - x0) * density));
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) / density;
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
        const [dx, dy] = [px - ax - ex * t, py - ay - ey * t];
        const d = Math.sqrt(dx * dx + dy * dy);
        const k = j * w + i;
        if (d >= best[k]) continue;
        best[k] = d;
        data[k] = dx * nx + dy * ny >= 0 ? d : -d;
      }
    }
  }
  return data;
}

/**
 * Distances to a sheet's outline over a grid (`kerbDistances` to its
 * every edge), signed by which side of it each texel is, read off the
 * sheet's own triangles, near the outline or far from it: positive on the
 * sheet, negative off it.
 */
export function coverage(g: MeshGeometry, outline: Float32Array, x0: number, y0: number, density: number, w: number, h: number): Float32Array {
  const covered = fillTriangles(g.positions, g.indices, x0, y0, density, w, h, new Uint8Array(w * h));
  return outline.map((d, k) => (covered[k] ? Math.abs(d) : -Math.abs(d)));
}

/** Off every line: beyond reach of all. */
const OFF_LINE = 64;

/**
 * Where each texel of a grid lies across the nearest line it is beside,
 * from one edge (-1) to the other (1); OFF_LINE beside none. Across a
 * line that changes evenly, and the texture is read between texels
 * evenly, so a line however much thinner than a texel comes out whole and
 * sharp, as a distance to its middle, which dips between texels, would not.
 */
function lineDistances(lines: Line[], x0: number, y0: number, density: number, w: number, h: number): Float32Array {
  const data = new Float32Array(w * h).fill(OFF_LINE);
  const best = new Float32Array(w * h).fill(Infinity);
  for (const { a, b, half } of lines) {
    const reach = half + 2 / density;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach - x0) * density));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(a[0], b[0]) + reach - x0) * density));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach - y0) * density));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(a[1], b[1]) + reach - y0) * density));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [dx, dy] = [x0 + (i + 0.5) / density - a[0], y0 + (j + 0.5) / density - a[1]];
        const along = dx * ux + dy * uy;
        const across = dx * -uy + dy * ux;
        const k = j * w + i;
        if (along < 0 || along > len || Math.abs(across) > reach || Math.abs(across) >= best[k]) continue;
        best[k] = Math.abs(across);
        data[k] = across / half;
      }
    }
  }
  return data;
}

/** A sheet's kerb texture over a box of it, as the texels it holds, half
 *  floats, read smoothly: how far inside its kerbs; of a sheet `cover`
 *  whose every edge is a kerb, how far inside the sheet, so a square drawn
 *  over the box is cut to it; where across the `lines` painted on it; and
 *  how far inside the `roads` cut into it. Numbers alone, worked out where
 *  the town is drawn (`townWorker.ts`). */
export interface KerbTexels {
  half: Uint16Array;
  /** The texture's low corner in the sheet's frame, and its extent. */
  origin: [number, number];
  size: [number, number];
  texels: [number, number];
}

export function kerbTexels(kerbs: Kerb[], extent: Extent, { cover, lines = [], roads }: { cover?: MeshGeometry; lines?: Line[]; roads?: Roads } = {}): KerbTexels {
  const { data, origin, size, texels, density } = kerbData(kerbs, extent);
  const on = cover ? coverage(cover, data, origin[0], origin[1], density, texels[0], texels[1]) : null;
  // How far inside the roads, negative off them, for a sheet the roads are
  // cut into, as far as its kerbs along them reach (`kerbs.ts`).
  const road = roads ? coverage(roads.sheet, kerbDistances(roads.edges, origin[0], origin[1], density, texels[0], texels[1], ROAD_REACH), origin[0], origin[1], density, texels[0], texels[1]) : null;
  const painted = lineDistances(lines, origin[0], origin[1], density, texels[0], texels[1]);
  const half = new Uint16Array(data.length * 4);
  for (let i = 0; i < data.length; i++) {
    half[i * 4] = toHalf(data[i]);
    half[i * 4 + 1] = toHalf(on ? on[i] : FAR);
    half[i * 4 + 2] = toHalf(painted[i]);
    half[i * 4 + 3] = toHalf(road ? road[i] : -FAR);
  }
  return { half, origin, size, texels };
}

/** How far either side of a road's edge its distance is told: past the
 *  pavement's cut and its kerb along it. */
const ROAD_REACH = 0.15;

/** Roads cut into a sheet: their triangles near it, and their edges, those
 *  with no road past them, not where one tile's runs on over the next's;
 *  found once for every sheet the roads are cut into (`roadsOf`). */
export interface Roads {
  sheet: MeshGeometry;
  edges: Kerb[];
}

export function roadsOf(sheet: MeshGeometry): Roads {
  const on = runsOn(sheet);
  return { sheet, edges: kerbsOf(sheet, (a, b, out) => !on(a, b, out)) };
}

/** A float as a half float's bits, through one shared word. */
const word = new Float32Array(1);
const bits = new Uint32Array(word.buffer);
export function toHalf(v: number): number {
  word[0] = v;
  const x = bits[0];
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const man = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (man >> 13);
}
