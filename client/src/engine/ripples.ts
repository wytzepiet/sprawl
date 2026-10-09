/**
 * The ripples the wind leaves in dry sand, baked (`ground.ts` reads them):
 * a square of sand this many texels a side, wrapping, laid over this many
 * tiles. Gabor noise: wave packets, a short wave under a soft round fall-
 * off, scattered at random and summed, each facing about the wind's way.
 * Where they overlap they make ridges that wind, fork, end and meet, as
 * ripples grow, rather than lines bent after. On its own, for a worker to
 * bake (`rippleWorker.ts`).
 */
export const RIPPLE_SIDE = 512;
export const RIPPLE_TILES = 4;

/** Ridges this far apart, in tiles; facing this way give or take this
 *  much, in radians; packets reaching this many ridges along a ridge and
 *  this many across, so ridges run long; this many packets to the area a
 *  long packet covers. */
const WAVELENGTH = 0.08;
const WIND = Math.atan2(0.39, 0.92);
const SPREAD = 0.2;
/** How hard each ridge is pressed to one height, so all run about as wide,
 *  and how many texels its crest is rounded over after. */
const EVEN = 2.5;
const ROUND = 1;
const ALONG = 6;
const ACROSS = 1.8;
const DENSITY = 1.5;

/** Every texel's slope, across and up the square (red, green, from -1 to
 *  1 as 0 to 1), and its height (blue). */
export function bakeRipples(): Uint8Array {
  const n = RIPPLE_SIDE;
  const wave = (WAVELENGTH / RIPPLE_TILES) * n;
  const [along, across] = [ALONG * wave, ACROSS * wave];
  const reach = along;
  const height = new Float32Array(n * n);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const packets = Math.round(((n * n) / (along * across)) * DENSITY);
  for (let p = 0; p < packets; p++) {
    const [cx, cy] = [random() * n, random() * n];
    const angle = WIND + (random() - 0.5) * 2 * SPREAD;
    const [fx, fy] = [Math.cos(angle) / wave, Math.sin(angle) / wave];
    const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
    const phase = random() * 2 * Math.PI;
    for (let dy = -Math.ceil(reach); dy <= reach; dy++) {
      for (let dx = -Math.ceil(reach); dx <= reach; dx++) {
        const [x, y] = [Math.floor(cx) + dx, Math.floor(cy) + dy];
        const [ox, oy] = [x - cx, y - cy];
        // Across the ridges (along the wave) short, along them long.
        const [u, v] = [ox * ux + oy * uy, -ox * uy + oy * ux];
        const r2 = (u * u) / (across * across) + (v * v) / (along * along);
        if (r2 > 1) continue;
        const k = ((y % n) + n) % n * n + (((x % n) + n) % n);
        height[k] += Math.exp(-4 * r2) * Math.cos(2 * Math.PI * (ox * fx + oy * fy) + phase);
      }
    }
  }
  // Scaled by its typical height, then pressed: every ridge to about the
  // same height, its width where the pattern crosses zero, half a ridge
  // apart, wherever packets crowd or thin; then its crest rounded.
  let typical = 1e-6;
  for (const h of height) typical += h * h;
  typical = Math.sqrt(typical / (n * n));
  for (let k = 0; k < n * n; k++) height[k] = Math.tanh((EVEN * height[k]) / typical);
  for (let pass = 0; pass < ROUND; pass++) {
    const was = height.slice();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += was[((y + dy + n) % n) * n + ((x + dx + n) % n)];
        height[y * n + x] = sum / 9;
      }
    }
  }
  const peak = 1;
  const at = (x: number, y: number) => height[((y + n) % n) * n + ((x + n) % n)] / peak;
  const slopes = new Float32Array(n * n * 2);
  let steepest = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [gx, gy] = [(at(x + 1, y) - at(x - 1, y)) / 2, (at(x, y + 1) - at(x, y - 1)) / 2];
      slopes.set([gx, gy], (y * n + x) * 2);
      steepest += gx * gx + gy * gy;
    }
  }
  steepest = 2 * Math.sqrt(steepest / (n * n));
  const out = new Uint8Array(n * n * 4);
  const byte = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
  for (let k = 0; k < n * n; k++) {
    out[k * 4] = byte(0.5 + slopes[k * 2] / steepest / 2);
    out[k * 4 + 1] = byte(0.5 + slopes[k * 2 + 1] / steepest / 2);
    out[k * 4 + 2] = byte(0.5 + height[k] / peak / 2);
    out[k * 4 + 3] = 255;
  }
  return out;
}
