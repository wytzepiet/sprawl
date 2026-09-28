/**
 * How far every cell of a grid is from the nearest cell outside a shape, in
 * cells: the exact Euclidean distance transform, Felzenszwalb and
 * Huttenlocher's, in two passes of lower envelopes of parabolas, one down
 * the columns and one along the rows. Linear in the cells, so a whole town
 * at a metre a sample costs a few milliseconds.
 */
export function distances(inside: Uint8Array, w: number, h: number): Float32Array {
  const FAR = 1e20;
  const sq = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) sq[i] = inside[i] ? FAR : 0;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len: number, get: (i: number) => number, put: (i: number, x: number) => void) => {
    for (let i = 0; i < len; i++) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let i = 0; i < len; i++) put(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => sq[y * w + x], (y, s) => (sq[y * w + x] = s));
  for (let y = 0; y < h; y++) pass(w, (x) => sq[y * w + x], (x, s) => (sq[y * w + x] = s));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(sq[i]);
  return out;
}
