/**
 * The water's ripple, baked (`water.ts` reads it, as do the beach's and
 * the cliff's swash): a tiling field of the surface's slope, two
 * channels, and its height, a third, from waves of whole numbers of crests
 * across it, so it meets itself at its edges: longer waves stronger, as on
 * open water, and all leaning one way, as wind lays them. On its own, for
 * the bake worker (`bakeWorker.ts`).
 */
export const WAVES_SIDE = 256;
const WAVES = 48;

/** Every texel's slope, across and up (red, green), and its height
 *  (blue), each -1 to 1, as half floats' bytes. */
export function bakeWaves(): Uint8Array {
  const n = WAVES_SIDE;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const waves: [number, number, number, number][] = [];
  while (waves.length < WAVES) {
    const [kx, ky] = [Math.round((random() * 2 - 1) * 14), Math.round((random() * 2 - 1) * 14)];
    const k = Math.hypot(kx, ky);
    if (k < 2) continue;
    // Toward the wind, (1, 0.4), the stronger.
    const lean = 0.35 + 0.65 * Math.max(0, (kx + 0.4 * ky) / (k * 1.077));
    waves.push([kx, ky, lean / k ** 1.5, random() * Math.PI * 2]);
  }
  // A wave's angle at a texel is its column's part plus its row's, so its
  // sine and cosine come from a table of each by angle addition.
  const [sinU, cosU, sinV, cosV] = [0, 0, 0, 0].map(() => new Float64Array(n * WAVES));
  for (let w = 0; w < WAVES; w++) {
    const [kx, ky, , phase] = waves[w];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      [sinU[i * WAVES + w], cosU[i * WAVES + w]] = [Math.sin(kx * t), Math.cos(kx * t)];
      [sinV[i * WAVES + w], cosV[i * WAVES + w]] = [Math.sin(ky * t + phase), Math.cos(ky * t + phase)];
    }
  }
  const [kxs, kys, as] = [0, 1, 2].map((c) => Float64Array.from(waves, (w) => w[c]));
  const data = new Float32Array(n * n * 4);
  let [most, highest] = [0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, height = 0;
      for (let w = 0, u = i * WAVES, v = j * WAVES; w < WAVES; w++, u++, v++) {
        const d = -as[w] * (sinU[u] * cosV[v] + cosU[u] * sinV[v]);
        sx += d * kxs[w];
        sy += d * kys[w];
        height += as[w] * (cosU[u] * cosV[v] - sinU[u] * sinV[v]);
      }
      const at = (j * n + i) * 4;
      data[at] = sx;
      data[at + 1] = sy;
      data[at + 2] = height;
      data[at + 3] = 1;
      most = Math.max(most, Math.abs(sx), Math.abs(sy));
      highest = Math.max(highest, Math.abs(height));
    }
  }
  for (let k = 0; k < data.length; k += 4) {
    data[k] /= most;
    data[k + 1] /= most;
    data[k + 2] /= highest;
  }
  return new Uint8Array(new Float16Array(data).buffer);
}
