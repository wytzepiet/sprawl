/**
 * The grass, baked (`ground.ts` reads it): a square of lawn this many
 * texels a side, wrapping, laid over this many tiles. Short blades lying
 * every way, scattered at random and piled, each a ridge that takes the sun
 * on one side, so the lawn has a pile without a second colour; and here and
 * there a clover flower or three. On its own, for a worker to bake
 * (`bakeWorker.ts`).
 */
export const LAWN_SIDE = 1024;
export const LAWN_TILES = 16;

/** A blade's length and half its width, in texels, a texel about a pixel
 *  at the usual zoom; and how many times over they cover the lawn. */
const BLADE = [4, 8];
const HALF_WIDTH = 1.2;
const COVER = 2.5;
/** Clover: this many heads to a tile, of one to three flowers each this
 *  many texels across, this far apart. */
const CLOVER = 0.6;
const FLOWER = 3.6;
const SPREAD = 7;

/** Every texel's slope, across and up the square (red, green, from -1 to
 *  1 as 0 to 1), its height (blue, 0 in the deepest crease), and whether a
 *  flower is there (alpha). */
export function bakeLawn(): Uint8Array {
  const n = LAWN_SIDE;
  const height = new Float32Array(n * n);
  const flower = new Float32Array(n * n);
  let seed = 5;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const wrap = (x: number, y: number) => (((y % n) + n) % n) * n + (((x % n) + n) % n);
  const mean = (BLADE[0] + BLADE[1]) / 2;
  const blades = Math.round((n * n * COVER) / (mean * HALF_WIDTH * 2));
  for (let b = 0; b < blades; b++) {
    const [cx, cy] = [random() * n, random() * n];
    const angle = random() * Math.PI;
    const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
    const half = (BLADE[0] + random() * (BLADE[1] - BLADE[0])) / 2;
    const top = 0.6 + 0.4 * random();
    const reach = Math.ceil(half + HALF_WIDTH);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const [x, y] = [Math.floor(cx) + dx, Math.floor(cy) + dy];
        const [ox, oy] = [x + 0.5 - cx, y + 0.5 - cy];
        // Along the blade, from its middle; across, from its spine.
        const [along, across] = [Math.abs(ox * ux + oy * uy) / half, Math.abs(-ox * uy + oy * ux) / HALF_WIDTH];
        if (along >= 1 || across >= 1) continue;
        const k = wrap(x, y);
        height[k] = Math.max(height[k], top * (1 - across * across) * (1 - along * along));
      }
    }
  }
  const heads = Math.round(CLOVER * LAWN_TILES * LAWN_TILES);
  for (let h = 0; h < heads; h++) {
    const [hx, hy] = [random() * n, random() * n];
    const flowers = 1 + Math.floor(random() * 3);
    for (let f = 0; f < flowers; f++) {
      const [cx, cy] = [hx + (random() - 0.5) * SPREAD, hy + (random() - 0.5) * SPREAD];
      const r = FLOWER / 2;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const [x, y] = [Math.floor(cx) + dx, Math.floor(cy) + dy];
          const d2 = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const k = wrap(x, y);
          // A flower stands on the blades, round.
          height[k] = Math.max(height[k], 1 + Math.sqrt(1 - d2));
          flower[k] = Math.max(flower[k], Math.min(1, 2 * (1 - d2)));
        }
      }
    }
  }
  const at = (x: number, y: number) => height[wrap(x, y)];
  const out = new Uint8Array(n * n * 4);
  const byte = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      out[k * 4] = byte(0.5 + (at(x + 1, y) - at(x - 1, y)) / 4);
      out[k * 4 + 1] = byte(0.5 + (at(x, y + 1) - at(x, y - 1)) / 4);
      out[k * 4 + 2] = byte(height[k]);
      out[k * 4 + 3] = byte(flower[k]);
    }
  }
  return out;
}
