/**
 * Triangles filled into a grid of `w` by `h` cells, `density` to a unit,
 * from (x0, y0): each cell whose middle a triangle covers set to 1. A row
 * of cells at a time, across the row's middle from where it enters the
 * triangle to where it leaves. No runtime imports: the terrain worker
 * uses it too.
 */
export function fillTriangles(positions: ArrayLike<number>, indices: ArrayLike<number>, x0: number, y0: number, density: number, w: number, h: number, out: Uint8Array): Uint8Array {
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => [positions[indices[t + k] * 3], positions[indices[t + k] * 3 + 1]]);
    const j0 = Math.max(0, Math.ceil((Math.min(v[0][1], v[1][1], v[2][1]) - y0) * density - 0.5));
    const j1 = Math.min(h - 1, Math.floor((Math.max(v[0][1], v[1][1], v[2][1]) - y0) * density - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) / density;
      let [lo, hi] = [Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const [a, b] = [v[k], v[(k + 1) % 3]];
        if ((a[1] > y) === (b[1] > y)) continue;
        const x = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        [lo, hi] = [Math.min(lo, x), Math.max(hi, x)];
      }
      const i0 = Math.max(0, Math.ceil((lo - x0) * density - 0.5));
      const i1 = Math.min(w - 1, Math.floor((hi - x0) * density - 0.5));
      if (i0 <= i1) out.fill(1, j * w + i0, j * w + i1 + 1);
    }
  }
  return out;
}
