/**
 * A wheat field's stages, baked (`objects/field.ts` reads them): a square
 * a stage, a pass wide (across, x) and a tile long (along, y), wrapping
 * both ways, stacked one under the next with a margin of each wrapped
 * round it, so a stage read at its edge, or far off from a smaller copy,
 * reads none of the next. Each the earth, then the plants painted onto it
 * a stroke at a time, as wheat is from the air: no leaves to see, but a
 * fine grain running with the rows. On its own, for a worker to bake
 * (`wheatWorker.ts`).
 *
 * The stages, in order: ploughed; drilled, ten rows a pass, ridged, and
 * the tramlines, the wheel tracks, pressed in either side of the middle
 * row; seedlings, a blade or two along the row; the crop grown, tufts of
 * blades leaning out of the rows and over them; in ear, the ears standing
 * up out of the leaves; ripe, the same, the ears heavier; and stubble, a
 * short stalk or two where each plant stood.
 */
export const WHEAT_TEXELS = 512;
export const WHEAT_MARGIN = 16;
export const WHEAT_STAGES = 7;
export const WHEAT_STRIDE = WHEAT_TEXELS + 2 * WHEAT_MARGIN;

/** Ten rows to a pass, a plant every fortieth of a tile along each; the
 *  tramlines a hair either side of these, across the pass; how deep the
 *  shade gets down among the plants, and how hard the slopes turn the
 *  light. */
const ROWS = 10;
const PLANTS = 48;
const TRAMS = [0.4, 0.6];
const TRAM_WIDE = 0.012;
const SHADE = 18;
const SLOPE = 3;

const n = WHEAT_TEXELS;

let seed = 1;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Value noise of a cell `size` texels wide, wrapping round the square. */
function noise(x: number, y: number, size: number): number {
  const cells = Math.max(1, Math.round(n / size));
  const [fx, fy] = [x / size, y / size];
  const [ix, iy] = [Math.floor(fx), Math.floor(fy)];
  const [tx, ty] = [fx - ix, fy - iy];
  const at = (cx: number, cy: number) => {
    let h = Math.imul(((cx % cells) + cells) % cells, 0x27d4eb2d) ^ Math.imul(((cy % cells) + cells) % cells, 0x165667b1) ^ Math.imul(size | 0, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const [sx, sy] = [tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)];
  return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
}

/** A stage being painted: each texel's height (in tiles), whether it is
 *  crop or earth, and how light it is of itself. */
type Stage = { height: Float32Array; crop: Float32Array; tone: Float32Array };

const wrap = (i: number) => ((i % n) + n) % n;
const tram = (x: number) => TRAMS.some((t) => Math.abs(x / n - t) < TRAM_WIDE);

/** The earth: ridged along the rows (by `ridge`, in tiles), the tramlines
 *  pressed in, crumbled all over. */
function earth(ridge: number): Stage {
  const s: Stage = { height: new Float32Array(n * n), crop: new Float32Array(n * n), tone: new Float32Array(n * n) };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const row = 1 - Math.abs(((x / n) * ROWS) % 1 - 0.5) * 2;
      const k = y * n + x;
      s.height[k] = ridge * row - (tram(x) ? 0.005 : 0) + 0.003 * noise(x, y, 8) + 0.0015 * noise(x, y, 3);
      s.tone[k] = 0.9 + 0.1 * noise(x, y, 5);
    }
  }
  return s;
}

/** A stroke of a plant: from (x, y), `long` texels its way, `wide` at its
 *  foot, narrowing to its tip, `round` if an ear; from height h0 at its
 *  foot to h1 at its tip, this light. Laid over what is under it, where
 *  it stands higher; never in a tramline. */
function stroke(s: Stage, x: number, y: number, angle: number, long: number, wide: number, h0: number, h1: number, tone: number, round = false) {
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  const reach = Math.ceil(long + wide + 1);
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      const [px, py] = [Math.floor(x) + ox, Math.floor(y) + oy];
      const [rx, ry] = [px + 0.5 - x, py + 0.5 - y];
      const t = (rx * dx + ry * dy) / long;
      if (t < 0 || t > 1) continue;
      const side = Math.abs(-rx * dy + ry * dx);
      const w = round ? wide * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) : wide * (1 - 0.7 * t);
      if (side >= w) continue;
      const [cx, cy] = [wrap(px), wrap(py)];
      if (tram(cx)) continue;
      const k = cy * n + cx;
      const across = side / w;
      const h = h0 + (h1 - h0) * t + (round ? 0.006 : 0.002) * (1 - across * across);
      if (h <= s.height[k]) continue;
      s.height[k] = h;
      s.crop[k] = 1;
      s.tone[k] = tone * (0.88 + 0.12 * (1 - across));
    }
  }
}

/** Where each plant stands, the same in every stage: a row, and a spot
 *  along it, a little off its line. */
const plants = (() => {
  seed = 11;
  const out: { x: number; y: number; r: number[] }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let p = 0; p < PLANTS; p++) {
      const r = Array.from({ length: 96 }, random);
      out.push({ x: ((row + 0.5) / ROWS) * n + (r[0] - 0.5) * 6, y: ((p + 0.5) / PLANTS) * n + (r[1] - 0.5) * 6, r });
    }
  }
  return out;
})();

const ALONG = Math.PI / 2;
const either = (r: number) => (r < 0.5 ? 0 : Math.PI);

/** A tuft: this many blades, this long, leaning out from along the row as
 *  far as this, from this high at the foot to that at the tips. */
function tuft(s: Stage, p: (typeof plants)[number], blades: number, long: [number, number], wide: number, lean: number, h0: number, h1: number, tone: number) {
  for (let b = 0; b < blades; b++) {
    const r = p.r.slice(2 + b * 3, 5 + b * 3).concat(p.r[90 - b]);
    const angle = ALONG + either(r[0]) + (r[1] - 0.5) * 2 * lean;
    stroke(s, p.x, p.y, angle, long[0] + (long[1] - long[0]) * r[2], wide, h0, h1, tone * (0.85 + 0.25 * r[3]));
  }
}

/** Its ears: this many, standing near its heart, each this long. */
function ears(s: Stage, p: (typeof plants)[number], count: number, long: number, wide: number, h: number, tone: number) {
  for (let e = 0; e < count; e++) {
    const r = p.r.slice(36 + e * 4, 40 + e * 4);
    const [angle, l] = [ALONG + (r[2] - 0.5) * 0.9, long * (0.85 + 0.3 * r[3])];
    const [ex, ey] = [p.x + (r[0] - 0.5) * 44 - Math.cos(angle) * l * 0.5, p.y + (r[1] - 0.5) * 18 - Math.sin(angle) * l * 0.5];
    stroke(s, ex, ey, angle, l, wide, h, h, tone, true);
  }
}

function stage(i: number): Stage {
  switch (i) {
    case 0: {
      // Ploughed: four furrow slices a pass, each rising across it and
      // falling steep to the next, clods all over.
      const s = earth(0);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const q = ((x / n) * 4) % 1;
          const k = y * n + x;
          s.height[k] = 0.03 * Math.pow(q, 0.6) * (1 - Math.min(1, Math.max(0, (q - 0.78) / 0.22)) ** 2) + 0.008 * noise(x, y, 10) + 0.004 * noise(x, y, 4);
        }
      }
      return s;
    }
    case 1:
      return earth(0.006);
    case 2: {
      const s = earth(0.006);
      for (const p of plants) tuft(s, p, 2 + Math.round(p.r[63]), [12, 20], 3.2, 0.5, 0.008, 0.006, 1.15);
      return s;
    }
    case 3: {
      const s = earth(0.006);
      for (const p of plants) tuft(s, p, 9, [24, 44], 3, 1.3, 0.04, 0.02, 0.9);
      return s;
    }
    case 4:
    case 5: {
      const ripe = i === 5;
      const s = earth(0.006);
      for (const p of plants) tuft(s, p, 9, [24, 44], 3, 1.3, 0.05, 0.03, ripe ? 0.55 : 0.8);
      for (const p of plants) ears(s, p, ripe ? 8 : 6, ripe ? 15 : 13, ripe ? 4.5 : 3.8, 0.075, ripe ? 1.15 : 1.05);
      return s;
    }
    default: {
      // Stubble: the harrowed ground, a short stalk or two where each
      // plant stood, cut off square.
      const s = earth(0.004);
      for (const p of plants) {
        const stalks = 2 + Math.floor(p.r[62] * 3);
        for (let b = 0; b < stalks; b++) {
          const r = p.r.slice(20 + b * 4, 24 + b * 4);
          stroke(s, p.x + (r[0] - 0.5) * 10, p.y + (r[1] - 0.5) * 10, r[2] * Math.PI * 2, 4 + 4 * r[3], 2.6, 0.012, 0.008, 1);
        }
      }
      return s;
    }
  }
}

/** Every stage, stacked: each texel's facing across and along (red,
 *  green, -1 to 1 as 0 to 1), how light (blue: its own tone, darker down
 *  among the plants), and whether crop or earth (alpha). */
export function bakeWheat(): Uint8Array {
  const out = new Uint8Array(n * WHEAT_STRIDE * WHEAT_STAGES * 4);
  for (let i = 0; i < WHEAT_STAGES; i++) {
    const s = stage(i);
    const h = s.height;
    // What is round about each texel, on the whole: a box this wide each
    // way, across then along. Below it, in shade.
    const box = (from: Float32Array, step: number) => {
      const to = new Float32Array(n * n);
      const r = 6;
      for (let a = 0; a < n; a++) {
        let sum = 0;
        for (let b = -r; b <= r; b++) sum += from[step === 1 ? a * n + wrap(b) : wrap(b) * n + a];
        for (let b = 0; b < n; b++) {
          to[step === 1 ? a * n + b : b * n + a] = sum / (2 * r + 1);
          sum += from[step === 1 ? a * n + wrap(b + r + 1) : wrap(b + r + 1) * n + a] - from[step === 1 ? a * n + wrap(b - r) : wrap(b - r) * n + a];
        }
      }
      return to;
    };
    const around = box(box(h, 1), n);
    const at = (x: number, y: number) => h[wrap(y) * n + wrap(x)];
    for (let y = -WHEAT_MARGIN; y < n + WHEAT_MARGIN; y++) {
      for (let x = 0; x < n; x++) {
        const k = wrap(y) * n + x;
        const [sx, sy] = [(at(x + 1, y) - at(x - 1, y)) * n * 0.5 * SLOPE, (at(x, y + 1) - at(x, y - 1)) * n * 0.5 * SLOPE];
        const l = Math.hypot(sx, sy, 1);
        const shade = Math.min(1, Math.max(0.35, 1 - (around[k] - h[k]) * SHADE));
        const o = ((i * WHEAT_STRIDE + y + WHEAT_MARGIN) * n + x) * 4;
        out[o] = Math.round(((-sx / l) * 0.5 + 0.5) * 255);
        out[o + 1] = Math.round(((-sy / l) * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round(Math.min(1, (s.tone[k] * shade) / 1.25) * 255);
        out[o + 3] = Math.round(s.crop[k] * 255);
      }
    }
  }
  return out;
}
