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
const LEAN = [14, 30];
const HALF_WIDTH = 3;
/** They lean up the map, away from the camera, as blades standing seen
 *  from it would, give or take this much, in radians. */
const SWAY = 0.4;
const COVER = 4;
/** They grow in tufts of this many, from within this many texels of the
 *  tuft's heart; and the tufts in clumps, about this many texels across,
 *  the lowest this much shorter than the tallest. */
const TUFT = 7;
const TUFT_SPREAD = 7;
const CLUMP = 64;
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

/**
 * And the lawn is not flat: all of it rolls, in hummocks of longer grass
 * and hollows between, noise this many cells to a side of its square and of
 * cells half that; no floor for them to sit on. A pixel's facing tilted by
 * their slope, this much for a rise of a hummock's whole height over a
 * tile. A point is in cells.
 */
const HUMMOCK_CELLS = 10;
const HUMMOCK_TILT = 0.12;
/** Drawn this many texels a side, a rise of this much its whole height a
 *  cell as its slope's whole range; a blade leaning out fully on a slope
 *  of this much a cell. */
const HUMMOCK_SIDE = 512;
const SLOPED = 4;
const STEEP = 1.5;
/** How far the slope read tilts a pixel's facing. */
export const HUMMOCK_BEND = SLOPED * (HUMMOCK_CELLS / LAWN_TILES) * HUMMOCK_TILT;
const NOISE = `fn corner(c: vec2f, cells: u32, k: u32) -> f32 { let w = vec2u((vec2i(c) % i32(cells) + i32(cells)) % i32(cells)); return rnd(w.x + w.y * cells, k); }
fn noise(p: vec2f, cell: f32, cells: u32, k: u32) -> f32 {
  let c = floor(p / cell);
  let t = smoothstep(vec2f(0.), vec2f(1.), p / cell - c);
  return mix(mix(corner(c, cells, k), corner(c + vec2f(1., 0.), cells, k), t.x), mix(corner(c + vec2f(0., 1.), cells, k), corner(c + vec2f(1., 1.), cells, k), t.x), t.y);
}`;
const HUMMOCK = `fn rise(p: vec2f) -> f32 {
  return 0.65 * noise(p, 1., ${HUMMOCK_CELLS}u, 1u) + 0.35 * noise(p, 0.5, ${HUMMOCK_CELLS * 2}u, 2u);
}
// Its rise a cell across, up and across the square.
fn hummockSlope(p: vec2f) -> vec2f {
  let e = 0.02;
  return vec2f(rise(p + vec2f(e, 0.)) - rise(p - vec2f(e, 0.)), rise(p + vec2f(0., e)) - rise(p - vec2f(0., e))) / (2. * e);
}`;

/** A blade: its base, near its tuft's, which way it leans and how far, and
 *  how tall it stands, of the tallest, shorter in the lower clumps and
 *  a little shorter between the hummocks. On a hummock's flank it leans out
 *  down its slope, this much more than up the map at most, and at its top
 *  stands straight, so seen from above it is shorter there, by this much. */
const SPLAY = 0.45;
const UPRIGHT = 0.75;
const BLADE = `${RANDOM}
${NOISE}
// The hummocks' texel under a point.
fn hummock(at: vec2f) -> vec4f { return textureLoad(src0, (vec2i(at * ${f(HUMMOCK_SIDE / n)}) % ${HUMMOCK_SIDE} + ${HUMMOCK_SIDE}) % ${HUMMOCK_SIDE}, 0); }
struct Blade { base: vec2f, way: vec2f, lean: f32, top: f32 }
fn blade(i: u32) -> Blade {
  let tuft = i / ${TUFT}u;
  let r = ${f(TUFT_SPREAD)} * sqrt(rnd(i, 0u));
  let a = rnd(i, 1u) * 6.2831853;
  let base = vec2f(rnd(tuft, 5u), rnd(tuft, 6u)) * ${n}. + ${IN}. + r * vec2f(cos(a), sin(a));
  let angle = ${f(Math.PI / 2)} + (rnd(i, 2u) - 0.5) * ${f(2 * SWAY)};
  let under = hummock(base);
  let down = 1. - 2. * under.rg;
  let steep = saturate(length(down) * ${f(SLOPED / STEEP)});
  let way = normalize(vec2f(cos(angle), sin(angle)) + down / max(length(down), 1e-4) * steep * ${f(SPLAY)});
  let lean = (${f(LEAN[0])} + rnd(i, 3u) * ${f(LEAN[1] - LEAN[0])}) * mix(${f(UPRIGHT)}, 1., steep);
  let top = (0.5 + 0.5 * rnd(i, 4u)) * (1. - ${f(CLUMPED)} * noise(base, ${CLUMP}., ${n / CLUMP}u, 9u)) * (0.6 + 0.4 * under.b);
  return Blade(base, way, lean, top);
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

/** The hummocks' slope (red, green, from -1 to 1 as 0 to 1) and height
 *  (blue), over the lawn's square: a pixel's facing tilted by it
 *  (`ground.ts`), a blade's lean steered. */
const HUMMOCKS = `${RANDOM}
${NOISE}
${HUMMOCK}
fn fill(at: vec2f) -> vec4f {
  let p = at * ${f(HUMMOCK_CELLS / HUMMOCK_SIDE)};
  return vec4f(clamp(0.5 + 0.5 * hummockSlope(p) * ${f(1 / SLOPED)}, vec2f(0.), vec2f(1.)), rise(p), 1.);
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
  stampTexture(engine, heights, BLADE, BLADES, true, "max", [hummocks(engine)]);
  stampTexture(engine, heights, FLOWERS, HEADS * 3, false);
  fillTexture(engine, texture, SLOPES, [heights]);
  retire(heights);
  return texture;
});
