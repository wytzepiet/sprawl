/**
 * Slate, baked: a tiling surface of stone plates lying on one another, as
 * cleaved slate does, worked out once and read as a texture (`peaks.ts`).
 *
 * Plates: a few layers of cells (Worley), each layer's cells a size of
 * their own and stretched along the grain, which runs along x; each cell a
 * plate, a plane at its own height, tilted its own way; the surface the
 * highest plate over each point, so plates of one layer overlap another's
 * and break off where they end. The points are looked up through a warp
 * (the domain bent by a noise), so a plate's edge is ragged, not a line.
 * Then fine detail over it, and its facing worked out from its slope.
 *
 * Everything wraps at the texture's edge, so it tiles.
 */

export type Slate = {
  size: number;
  /** Height, 0 to 1, a row of x at a time. */
  height: Float32Array;
  /** Its facing's x and y, half-way at level, and its height: RGBA bytes. */
  texels: Uint8Array;
};

/** The plate layers: cells to the texture's side, across the grain. */
const LAYERS = [2, 3, 5, 9, 14];
/** How many times longer a plate is along the grain than across it. */
const STRETCH = 2.2;
/** How much higher each finer layer lies, how far its plates tilt, and how
 *  far a plate can stand above or below its layer. */
const RISE = 0.07;
const TILT = 0.8;
const SPREAD = 0.45;
/** The warp: its noise's cells to the side, and how far it bends, of the
 *  texture's side. */
const WARP_CELLS = 5;
const WARP = 0.06;
/** And finer, this many times, this share as far. */
const WARP_FINE = [4, 0.3];
/** The rock's broad relief under the plates: its noise's cells to the
 *  side, and how high. */
const RELIEF_CELLS = 2;
const BROAD = 0.25;
/** Streaks along the grain: cells along it and across, and how deep. */
const STREAK_CELLS = [6, 96];
const STREAK = 0.025;
/** Fine detail: its noise's cells to the side, and how much. */
const DETAIL_CELLS = 48;
const DETAIL = 0.03;
const GRIT = 0.03;
/** A plate's edge chips: the plates are softened over this many texels and
 *  this much of the softened kept. */
const CHIP = 3;
const CHIPPED = 0.5;
/** How steep a slope of the height is drawn, in the facing, a texel
 *  across. */
const RELIEF = 15;

/** A hash of up to four integers, 0 to 1. */
function hash(a: number, b: number, c: number, d = 0): number {
  return (mix(mix(mix(mix(0x811c9dc5, a), b), c), d) >>> 0) / 4294967296;
}
function mix(h: number, n: number): number {
  h = Math.imul(h ^ (n | 0), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return h ^ (h >>> 12);
}

/** Smooth value noise, wrapping every `px` cells along x and `py` along
 *  y; at (x, y) in cells. */
function noise(x: number, y: number, px: number, py: number, salt: number): number {
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [tx, ty] = [x - ix, y - iy];
  const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const [ux, uy] = [ease(tx), ease(ty)];
  const v = (i: number, j: number) => hash(((i % px) + px) % px, ((j % py) + py) % py, salt);
  const a = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * ux;
  const b = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

/** Two octaves of it, -1 to 1, at (u, v) of the texture. */
function fbm(u: number, v: number, cells: number, salt: number): number {
  return (noise(u * cells, v * cells, cells, cells, salt) + 0.5 * noise(u * cells * 2, v * cells * 2, cells * 2, cells * 2, salt + 1)) / 1.5 * 2 - 1;
}

/** The highest plate over (u, v) of the texture. */
function plates(u: number, v: number): number {
  let top = -Infinity;
  for (let l = 0; l < LAYERS.length; l++) {
    const across = LAYERS[l];
    // Fewer cells along the grain: each plate longer that way.
    const along = Math.max(1, Math.round(across / STRETCH));
    const x = u * along, y = v * across;
    const cx = Math.floor(x), cy = Math.floor(y);
    let best = Infinity, px = 0, py = 0, wi = 0, wj = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = cx + dx, j = cy + dy;
        const ci = ((i % along) + along) % along, cj = ((j % across) + across) % across;
        const qx = i + hash(ci, cj, l, 1), qy = j + hash(ci, cj, l, 2);
        // Distance in the plate's own measure: stretched cells, round plates.
        const d = (x - qx) ** 2 + (y - qy) ** 2;
        if (d < best) (best = d), (px = qx), (py = qy), (wi = ci), (wj = cj);
      }
    }
    const base = l * RISE + (hash(wi, wj, l, 3) - 0.5) * SPREAD;
    const [gx, gy] = [(hash(wi, wj, l, 4) - 0.5) * TILT, (hash(wi, wj, l, 5) - 0.5) * TILT];
    top = Math.max(top, base + gx * (x - px) / along * 4 + gy * (y - py) / across * 4);
  }
  return top;
}

/** A field softened over `r` texels each way, wrapping: a box blur, twice. */
function blur(field: Float32Array, size: number, r: number): Float32Array {
  let a = field.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (const horizontal of [true, false]) {
      const b = new Float32Array(a.length);
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          let sum = 0;
          for (let d = -r; d <= r; d++) {
            const [x, y] = horizontal ? [(i + d + size) % size, j] : [i, (j + d + size) % size];
            sum += a[y * size + x];
          }
          b[j * size + i] = sum / (2 * r + 1);
        }
      }
      a = b;
    }
  }
  return a;
}

/** How the slate lies on the map: over this many tiles; and again, this
 *  many times bigger, turned this far, this much of it, so its repeat does
 *  not show. The shader reads it so (`peaks.ts`). */
export const SPAN = 3;
export const SECOND = [2.7, 1.1, 0.35];

export function bakeSlate(size = 512): Slate {
  const height = new Float32Array(size * size);
  let [lo, hi] = [Infinity, -Infinity];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [u, v] = [i / size, j / size];
      const bend = (cells: number, far: number, salt: number) => [far * fbm(u, v, cells, salt), far * fbm(u, v, cells, salt + 2)];
      const [a, b] = [bend(WARP_CELLS, WARP, 11), bend(WARP_CELLS * WARP_FINE[0], WARP * WARP_FINE[1], 31)];
      const [wu, wv] = [u + a[0] + b[0], v + a[1] + b[1]];
      height[j * size + i] = plates(wu, wv);
    }
  }
  // The plates' edges chipped: softened, a share of it kept.
  const soft = blur(height, size, CHIP);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [u, v] = [i / size, j / size];
      const k = j * size + i;
      const streak = noise(u * STREAK_CELLS[0], v * STREAK_CELLS[1], STREAK_CELLS[0], STREAK_CELLS[1], 23);
      const h = height[k] + (soft[k] - height[k]) * CHIPPED + BROAD * fbm(u, v, RELIEF_CELLS, 29) + STREAK * streak + DETAIL * fbm(u, v, DETAIL_CELLS, 17) + GRIT * (hash(i, j, 19) - 0.5);
      height[k] = h;
      [lo, hi] = [Math.min(lo, h), Math.max(hi, h)];
    }
  }

  const texels = new Uint8Array(size * size * 4);
  const at = (i: number, j: number) => height[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [sx, sy] = [(at(i + 1, j) - at(i - 1, j)) * RELIEF, (at(i, j + 1) - at(i, j - 1)) * RELIEF];
      const len = Math.hypot(sx, sy, 1);
      const k = (j * size + i) * 4;
      texels[k] = Math.round((-sx / len * 0.5 + 0.5) * 255);
      texels[k + 1] = Math.round((-sy / len * 0.5 + 0.5) * 255);
      texels[k + 2] = Math.round((height[j * size + i] - lo) / (hi - lo) * 255);
      texels[k + 3] = 255;
    }
  }
  for (let k = 0; k < height.length; k++) height[k] = (height[k] - lo) / (hi - lo);
  return { size, height, texels };
}
