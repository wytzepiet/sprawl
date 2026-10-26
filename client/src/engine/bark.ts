/**
 * Bark, as a log's is (`objects/sawmill.ts` reads it): a strip this many
 * texels round the log and this many along it, wrapping both ways, once
 * round a log and `BARK_ALONG` tiles along it. Furrows running along the
 * log, broken and wandering, the ridges between them plated: its height
 * value noise stretched along, its slope in red and green (how far the
 * light is turned, round and along), how light it is in blue, the furrows
 * dark. On its own, for the bake worker (`bakeWorker.ts`).
 */
export const BARK_ROUND = 64;
export const BARK_LONG = 256;
export const BARK_ALONG = 0.3;

/** The noise's cells, round and along, and how much of the height each
 *  makes: long furrows, then plates on the ridges, then grain. */
const OCTAVES: [number, number, number][] = [
  [9, 3, 1],
  [17, 9, 0.45],
  [31, 40, 0.2],
];
/** How hard the slopes turn the light, and how dark a furrow's floor. */
const STEEP = 5;
/** A log's girth, about, in tiles: a texel along is this much shorter
 *  than one round, so its slope that much steeper. */
const GIRTH = 0.22;
const DEEP = 0.55;

const [w, h] = [BARK_ROUND, BARK_LONG];

/** Value noise of `cx` by `cy` cells over the strip, wrapping round it. */
function noise(u: number, v: number, cx: number, cy: number, salt: number): number {
  const [fx, fy] = [u * cx, v * cy];
  const [ix, iy] = [Math.floor(fx), Math.floor(fy)];
  const [tx, ty] = [fx - ix, fy - iy];
  const at = (x: number, y: number) => {
    let k = Math.imul(((x % cx) + cx) % cx, 0x27d4eb2d) ^ Math.imul(((y % cy) + cy) % cy, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
    k = Math.imul(k ^ (k >>> 15), 0x85ebca6b);
    k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
    return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
  };
  const [sx, sy] = [tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)];
  return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
}

/** Every texel's slope and light, rgba. */
export function bakeBark(): Uint8Array {
  const height = new Float32Array(w * h);
  const total = OCTAVES.reduce((s, o) => s + o[2], 0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Each furrow wanders round the log a little as it runs along it.
      const u = x / w + 0.04 * (noise(0, y / h, 1, 5, 7) - 0.5), v = y / h;
      const sum = OCTAVES.reduce((s, [cx, cy, k], i) => s + k * noise(u, v, cx, cy, i + 1), 0) / total;
      // Ridged: the furrows narrow and sharp, the ridges broad.
      height[y * w + x] = 1 - Math.abs(2 * sum - 1) ** 0.7;
    }
  const at = (x: number, y: number) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  const out = new Uint8Array(w * h * 4);
  const byte = (s: number) => Math.round(Math.max(-1, Math.min(1, s)) * 127.5 + 127.5);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      out[k] = byte(-STEEP * (at(x + 1, y) - at(x - 1, y)));
      out[k + 1] = byte(-STEEP * (at(x, y + 1) - at(x, y - 1)) * (GIRTH / w) / (BARK_ALONG / h));
      out[k + 2] = Math.round(255 * (1 - DEEP * (1 - at(x, y)) ** 1.5));
      out[k + 3] = 255;
    }
  return out;
}
