/**
 * The lace foam leaves as a broken wave runs back (`water.ts` reads it):
 * strands of foam round clear holes, a square this many texels a side,
 * wrapping, laid over this many tiles. Cells' borders, of two sizes of
 * cell, thickest along a border's middle and thinning to nothing: so as
 * the water reads it against a rising line, the holes open first, then
 * the strands thin and part, then the last of it is islands, and gone. On
 * its own, for a worker to bake (`laceWorker.ts`).
 */
export const LACE_SIDE = 256;
export const LACE_TILES = 1.4;

/** Cells across the square, of each size; each size's strands, how wide
 *  as a share of a cell, and how much of the foam they make. */
const SIZES: [number, number, number][] = [
  [9, 0.22, 1],
  [23, 0.2, 0.6],
];

/** How far a strand wanders off its cell's border, of the square, and how
 *  much grain frays its edges. */
const WAVER = 0.025;
const FRAY = 0.45;

/** Every texel's foam, 0 clear to 1 the thick of a strand. */
export function bakeLace(): Uint8Array {
  const n = LACE_SIDE;
  const lace = new Float32Array(n * n);
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Each texel read a little off where it lies, so strands waver.
  const [warpX, warpY] = [smooth(n, 29, random), smooth(n, 29, random)];
  for (const [cells, wide, share] of SIZES) {
    const points = Array.from({ length: cells * cells }, () => [random(), random()]);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [u, v] = [(i + 0.5) / n + (warpX[j * n + i] - 0.5) * WAVER, (j + 0.5) / n + (warpY[j * n + i] - 0.5) * WAVER];
        const [x, y] = [u * cells, v * cells];
        let [near, next] = [9, 9];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [cx, cy] = [Math.floor(x) + dx, Math.floor(y) + dy];
            const p = points[((cy % cells) + cells) % cells * cells + (((cx % cells) + cells) % cells)];
            const d = Math.hypot(x - cx - p[0], y - cy - p[1]);
            if (d < near) [near, next] = [d, near];
            else if (d < next) next = d;
          }
        }
        // Along a border the two nearest are as near: the strand's middle.
        const t = Math.min(1, (next - near) / wide);
        const strand = 1 - t * t * (3 - 2 * t);
        lace[j * n + i] = Math.max(lace[j * n + i], strand * share);
      }
    }
  }
  // Thick in some places and thin in others, so strands part unevenly and
  // what is left last is clumps, not the whole net gone faint at once.
  const clump = smooth(n, 5, random);
  const fine = smooth(n, 13, random);
  // And frayed: grain in the foam, so its edges are rough, not cut.
  const [grain, grit] = [smooth(n, 61, random), smooth(n, 127, random)];
  for (let k = 0; k < n * n; k++) lace[k] = Math.max(0, lace[k] * (0.15 + 0.9 * clump[k] + 0.35 * fine[k]) + (0.6 * grain[k] + 0.4 * grit[k] - 0.5) * FRAY);
  return Uint8Array.from(lace, (v) => Math.round(Math.min(1, v) * 255));
}

/** Smooth noise over a wrapping square, 0 to 1, of this many lumps a side. */
function smooth(n: number, lumps: number, random: () => number) {
  const at = Array.from({ length: lumps * lumps }, random);
  const out = new Float32Array(n * n);
  const ease = (t: number) => t * t * (3 - 2 * t);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = [(i / n) * lumps, (j / n) * lumps];
      const [x0, y0] = [Math.floor(x), Math.floor(y)];
      const [u, v] = [ease(x - x0), ease(y - y0)];
      const g = (a: number, b: number) => at[(b % lumps) * lumps + (a % lumps)];
      const [a, b] = [g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * u, g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * u];
      out[j * n + i] = a + (b - a) * v;
    }
  }
  return out;
}
