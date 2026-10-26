/**
 * The grass, baked (`ground.ts` reads it): a square of lawn this many
 * texels a side, wrapping, laid over this many tiles. Blades standing
 * packed close, each leaning a little its own way, so from above mostly
 * their tips show, lit, and the gaps between them in shade: a pile without
 * a second colour; and here and there a clover flower or three. On its
 * own, for a worker to bake (`bakeWorker.ts`).
 */
export const LAWN_SIDE = 2048;
export const LAWN_TILES = 8;

/** How far a blade leans, base to tip as seen from above, and half its
 *  width at the base, in texels, four texels to a pixel at the usual zoom,
 *  so the blades stay sharp zoomed in; and how many times over they cover
 *  the lawn. */
const LEAN = [5, 11];
const HALF_WIDTH = 2.2;
const COVER = 3;
/** Clover: this many heads to a tile, of one to three flowers each from
 *  this many texels across to this many, this far apart. */
const CLOVER = 0.6;
const FLOWER = [5, 13];
const SPREAD = 24;

/** Every texel's slope, across and up the square (red, green, from -1 to
 *  1 as 0 to 1), its height (blue, 0 deep between the blades), and whether
 *  a flower is there (alpha). */
export function bakeLawn(): Uint8Array {
  const n = LAWN_SIDE;
  const height = new Float32Array(n * n);
  const flower = new Float32Array(n * n);
  let seed = 5;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const wrap = (x: number, y: number) => (((y % n) + n) % n) * n + (((x % n) + n) % n);
  const mean = (LEAN[0] + LEAN[1]) / 2;
  const blades = Math.round((n * n * COVER) / (mean * HALF_WIDTH * 1.4));
  for (let b = 0; b < blades; b++) {
    const [bx, by] = [random() * n, random() * n];
    const angle = random() * 2 * Math.PI;
    const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
    const lean = LEAN[0] + random() * (LEAN[1] - LEAN[0]);
    const top = 0.5 + 0.5 * random();
    const reach = Math.ceil(lean + HALF_WIDTH);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const [x, y] = [Math.floor(bx) + dx, Math.floor(by) + dy];
        const [ox, oy] = [x + 0.5 - bx, y + 0.5 - by];
        // Up the blade, from its base to its tip; across, from its spine,
        // narrowing to the tip.
        const up = (ox * ux + oy * uy) / lean;
        if (up < 0 || up >= 1) continue;
        const across = Math.abs(-ox * uy + oy * ux) / (HALF_WIDTH * (1 - 0.7 * up));
        if (across >= 1) continue;
        const k = wrap(x, y);
        height[k] = Math.max(height[k], top * (0.2 + 0.8 * up) * (1 - across * across));
      }
    }
  }
  const heads = Math.round(CLOVER * LAWN_TILES * LAWN_TILES);
  for (let h = 0; h < heads; h++) {
    const [hx, hy] = [random() * n, random() * n];
    const flowers = 1 + Math.floor(random() * 3);
    for (let f = 0; f < flowers; f++) {
      const [cx, cy] = [hx + (random() - 0.5) * SPREAD, hy + (random() - 0.5) * SPREAD];
      const r = (FLOWER[0] + random() * (FLOWER[1] - FLOWER[0])) / 2;
      for (let dy = -Math.ceil(r); dy <= r; dy++) {
        for (let dx = -Math.ceil(r); dx <= r; dx++) {
          const [x, y] = [Math.floor(cx) + dx, Math.floor(cy) + dy];
          const d2 = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const k = wrap(x, y);
          // A flower stands on the blades, round.
          height[k] = Math.max(height[k], 1 + Math.sqrt(1 - d2));
          flower[k] = Math.max(flower[k], Math.min(1, 1.5 * (1 - d2)));
        }
      }
    }
  }
  // A blade as tall as it is wide, whatever the texels.
  const at = (x: number, y: number) => height[wrap(x, y)] * HALF_WIDTH * 1.5;
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
