import { createFilledTexture, drawnOnce, fillTexture, RANDOM, stampTexture, type EngineContext, type Texture2D } from "./gpu";
import { retire } from "./geometry";

/**
 * The grass (`ground.ts` reads it): a square of lawn this many
 * texels a side, wrapping, laid over this many tiles. Blades in tufts,
 * fanned, long enough to see at the usual zoom, leaning up the map give or
 * take a little, so from above mostly their tips show, each side of a blade
 * taking the sun its own way, and the gaps between them in shade: a pile
 * without a second colour; and here and there a clover flower or three. Drawn
 * on the GPU as the game starts, a blade a stamp (`stampTexture`): half a
 * million of them in less time than reading a kept copy took, so nothing
 * of it is kept.
 */
export const LAWN_SIDE = 2048;
export const LAWN_TILES = 8;

/** How far a blade leans, base to tip as seen from above, and half its
 *  width at the base, in texels, four texels to a pixel at the usual zoom:
 *  a stroke a few pixels long there, sharp zoomed in; and how many times
 *  over they cover the lawn. */
const LEAN = [24, 52];
const HALF_WIDTH = 4.5;
/** They lean up the map, away from the camera, as blades standing seen
 *  from it would, give or take this much, in radians. */
const SWAY = 0.4;
const COVER = 4;
/** They grow in tufts of this many, from within this many texels of the
 *  tuft's heart; and the tufts in clumps, about this many texels across,
 *  the lowest this much shorter than the tallest. */
const TUFT = 7;
const TUFT_SPREAD = 10;
const CLUMP = 128;
const CLUMPED = 0.5;
/** Clover: this many heads to a tile, of one to three flowers each from
 *  this many texels across to this many, this far apart. */
const CLOVER = 0.6;
const FLOWER = [5, 13];
const SPREAD = 24;


const f = (x: number) => x.toFixed(4);
const n = LAWN_SIDE;
const mean = (LEAN[0] + LEAN[1]) / 2;
const BLADES = Math.round((n * n * COVER) / (mean * HALF_WIDTH * 1.4));
const HEADS = Math.round(CLOVER * LAWN_TILES * LAWN_TILES);
/** Everything a little in from the square's corner, so no stamp's box
 *  starts before it. */
const IN = 32;

/** Noise wrapping a square `cells` cells of `cell` texels a side: a
 *  random height, the `k`th, a cell's corner, smoothed between. */
const NOISE = `fn corner(c: vec2f, cells: u32, k: u32) -> f32 { let w = vec2u((vec2i(c) % i32(cells) + i32(cells)) % i32(cells)); return rnd(w.x + w.y * cells, k); }
fn noise(p: vec2f, cell: f32, cells: u32, k: u32) -> f32 {
  let c = floor(p / cell);
  let t = smoothstep(vec2f(0.), vec2f(1.), p / cell - c);
  return mix(mix(corner(c, cells, k), corner(c + vec2f(1., 0.), cells, k), t.x), mix(corner(c + vec2f(0., 1.), cells, k), corner(c + vec2f(1., 1.), cells, k), t.x), t.y);
}`;

/** A blade: its base, near its tuft's, which way it leans and how far, and
 *  how tall it stands, of the tallest, shorter in the lower clumps. */
const BLADE = `${RANDOM}
${NOISE}
struct Blade { base: vec2f, way: vec2f, lean: f32, top: f32 }
fn blade(i: u32) -> Blade {
  let tuft = i / ${TUFT}u;
  let r = ${f(TUFT_SPREAD)} * sqrt(rnd(i, 0u));
  let a = rnd(i, 1u) * 6.2831853;
  let base = vec2f(rnd(tuft, 5u), rnd(tuft, 6u)) * ${n}. + ${IN}. + r * vec2f(cos(a), sin(a));
  let angle = ${f(Math.PI / 2)} + (rnd(i, 2u) - 0.5) * ${f(2 * SWAY)};
  return Blade(base, vec2f(cos(angle), sin(angle)), ${f(LEAN[0])} + rnd(i, 3u) * ${f(LEAN[1] - LEAN[0])}, (0.5 + 0.5 * rnd(i, 4u)) * (1. - ${f(CLUMPED)} * noise(base, ${CLUMP}., ${n / CLUMP}u, 9u)));
}
// Only the box round it, base to tip.
fn box(i: u32) -> vec4f {
  let b = blade(i);
  let tip = b.base + b.way * b.lean;
  return vec4f(floor(min(b.base, tip) - ${f(HALF_WIDTH)}), ceil(max(b.base, tip) + ${f(HALF_WIDTH)}));
}
// Up the blade, from its base to its tip; across, from its spine,
// narrowing to the tip. Its height, in red.
fn stamp(i: u32, at: vec2f) -> vec4f {
  let b = blade(i);
  let o = at - b.base;
  let up = dot(o, b.way) / b.lean;
  let across = abs(o.y * b.way.x - o.x * b.way.y) / (${f(HALF_WIDTH)} * (1. - 0.7 * up));
  if (up < 0. || up >= 1. || across >= 1.) { return vec4f(0.); }
  return vec4f(b.top * (0.2 + 0.8 * up) * (1. - across * across), 0., 0., 0.);
}`;

/** A clover head's flowers, three to a head at most: each stands on the
 *  blades, round; how much of a flower a texel is, in green. */
const FLOWERS = `${RANDOM}
fn flower(i: u32) -> vec3f {
  let head = i / 3u + 7000000u;
  if (f32(i % 3u) >= 1. + floor(rnd(head, 2u) * 3.)) { return vec3f(0.); }
  let at = vec2f(rnd(head, 0u), rnd(head, 1u)) * ${n}. + ${IN}. + (vec2f(rnd(i, 10u), rnd(i, 11u)) - 0.5) * ${SPREAD}.;
  return vec3f(at, (${f(FLOWER[0])} + rnd(i, 12u) * ${f(FLOWER[1] - FLOWER[0])}) / 2.);
}
fn box(i: u32) -> vec4f { let c = flower(i); return vec4f(floor(c.xy - c.z), ceil(c.xy + c.z)); }
fn stamp(i: u32, at: vec2f) -> vec4f {
  let c = flower(i);
  let d = dot(at - c.xy, at - c.xy) / max(c.z * c.z, 1e-6);
  if (d >= 1.) { return vec4f(0.); }
  return vec4f(1. + sqrt(1. - d), min(1., 1.5 * (1. - d)), 0., 0.);
}`;

/** Every texel's slope, across and up the square (red, green, from -1 to
 *  1 as 0 to 1), its height (blue, 0 deep between the blades), and whether
 *  a flower is there (alpha): a blade as tall as it is wide, whatever the
 *  texels. */
const SLOPES = `fn high(p: vec2i) -> vec4f { return textureLoad(src0, (p % ${n} + ${n}) % ${n}, 0); }
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let here = high(p);
  let slope = vec2f(high(p + vec2i(1, 0)).r - high(p - vec2i(1, 0)).r, high(p + vec2i(0, 1)).r - high(p - vec2i(0, 1)).r) * ${f((HALF_WIDTH * 1.5) / 4)};
  return vec4f(0.5 + slope, here.r, here.g);
}`;

/**
 * And the lawn is not flat: it rises in hummocks, blobs of longer grass
 * a tile or so across, lying over this many tiles, this many texels a
 * side; a pixel's facing tilted by their slope (red, green, from -1 to 1
 * as 0 to 1), this much for a rise of a hummock's whole height over a
 * tile, and how high it is there (blue).
 */
export const HUMMOCK_TILES = 32;
const HUMMOCK_SIDE = 512;
const HUMMOCK_TILT = 0.14;
/** Where the noise, from 0 to 1, starts to rise into a hummock, and how
 *  much more of it to its top. */
const HUMMOCK_FOOT = 0.35;
const HUMMOCK_RISE = 0.4;
const TEXELS = HUMMOCK_SIDE / HUMMOCK_TILES;
const HUMMOCKS = `${RANDOM}
${NOISE}
fn rise(p: vec2f) -> f32 {
  let v = 0.65 * noise(p, ${TEXELS}., ${HUMMOCK_TILES}u, 1u) + 0.35 * noise(p, ${TEXELS / 2}., ${HUMMOCK_TILES * 2}u, 2u);
  return smoothstep(${f(HUMMOCK_FOOT)}, ${f(HUMMOCK_FOOT + HUMMOCK_RISE)}, v);
}
fn fill(at: vec2f) -> vec4f {
  let slope = vec2f(rise(at + vec2f(1., 0.)) - rise(at - vec2f(1., 0.)), rise(at + vec2f(0., 1.)) - rise(at - vec2f(0., 1.))) * ${f((TEXELS / 2) * HUMMOCK_TILT)};
  return vec4f(clamp(0.5 + 0.5 * slope, vec2f(0.), vec2f(1.)), rise(at), 1.);
}`;
export const hummocks = drawnOnce("hummocks", (engine: EngineContext): Texture2D => {
  const texture = createFilledTexture(engine, HUMMOCK_SIDE, HUMMOCK_SIDE, "rgba8unorm", true);
  fillTexture(engine, texture, HUMMOCKS, []);
  return texture;
});

/** The lawn, an engine's, drawn once. */
export const lawn = drawnOnce("lawn", (engine: EngineContext): Texture2D => {
  const texture = createFilledTexture(engine, n, n, "rgba8unorm", true);
  const heights = createFilledTexture(engine, n, n, "rg16float");
  stampTexture(engine, heights, BLADE, BLADES, true);
  stampTexture(engine, heights, FLOWERS, HEADS * 3, false);
  fillTexture(engine, texture, SLOPES, [heights]);
  retire(heights);
  return texture;
});
