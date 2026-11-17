import { createFilledTexture, drawnOnce, fillTexture, RANDOM, stampTexture, type EngineContext, type Texture2D } from "./gpu";
import { retire } from "./geometry";

/**
 * The grass (`ground.ts` reads it): a square of lawn this many
 * texels a side, wrapping, laid over this many tiles. Blades standing
 * packed close, leaning up the map give or take a little, so from above mostly
 * their tips show, lit, and the gaps between them in shade: a pile without
 * a second colour; and here and there a clover flower or three. Drawn
 * on the GPU as the game starts, a blade a stamp (`stampTexture`): half a
 * million of them in less time than reading a kept copy took, so nothing
 * of it is kept.
 */
export const LAWN_SIDE = 2048;
export const LAWN_TILES = 8;

/** How far a blade leans, base to tip as seen from above, and half its
 *  width at the base, in texels, four texels to a pixel at the usual zoom,
 *  so the blades stay sharp zoomed in; and how many times over they cover
 *  the lawn. */
const LEAN = [5, 11];
const HALF_WIDTH = 2.2;
/** They lean up the map, away from the camera, as blades standing seen
 *  from it would, give or take this much, in radians. */
const SWAY = 0.4;
const COVER = 3;
/** And they grow in clumps, about this many texels across, the lowest
 *  this much shorter than the tallest: so the lawn has a grain of its own
 *  at the usual zoom, where the blades are too fine to see. */
const CLUMP = 64;
const CLUMPED = 0.6;
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

/** A blade: its base, which way it leans and how far, and how tall it
 *  stands, of the tallest, shorter in the lower clumps: a random height a
 *  clump's corner, smoothed between, wrapping. */
const BLADE = `${RANDOM}
struct Blade { base: vec2f, way: vec2f, lean: f32, top: f32 }
fn corner(c: vec2f) -> f32 { let w = vec2u(c) % ${n / CLUMP}u; return rnd(w.x + w.y * ${n / CLUMP}u, 9u); }
fn clump(p: vec2f) -> f32 {
  let c = floor(p / ${CLUMP}.);
  let t = smoothstep(vec2f(0.), vec2f(1.), p / ${CLUMP}. - c);
  return mix(mix(corner(c), corner(c + vec2f(1., 0.)), t.x), mix(corner(c + vec2f(0., 1.)), corner(c + vec2f(1., 1.)), t.x), t.y);
}
fn blade(i: u32) -> Blade {
  let base = vec2f(rnd(i, 0u), rnd(i, 1u)) * ${n}. + ${IN}.;
  let angle = ${f(Math.PI / 2)} + (rnd(i, 2u) - 0.5) * ${f(2 * SWAY)};
  return Blade(base, vec2f(cos(angle), sin(angle)), ${f(LEAN[0])} + rnd(i, 3u) * ${f(LEAN[1] - LEAN[0])}, (0.5 + 0.5 * rnd(i, 4u)) * (1. - ${f(CLUMPED)} * clump(base)));
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
