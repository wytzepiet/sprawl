import { RANDOM, createFilledTexture, fillTexture, stampTexture, type EngineContext, type Texture2D } from "./gpu";
import { retire } from "./geometry";

/**
 * The ripples the wind leaves in dry sand (`ground.ts` reads them): a
 * square of sand this many texels a side, wrapping, laid over this many
 * tiles. Gabor noise: wave packets, a short wave under a soft round fall-
 * off, scattered at random and summed, each facing about the wind's way.
 * Where they overlap they make ridges that wind, fork, end and meet, as
 * ripples grow, rather than lines bent after. Drawn on the GPU when the
 * first sand is, a packet a stamp (`stampTexture`), and nothing of it kept.
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
const ALONG = 6;
const ACROSS = 1.8;
const DENSITY = 1.5;
/** How hard each ridge is pressed to one height, so all run about as wide. */
const EVEN = 2.5;

const f = (x: number) => x.toFixed(5);
const n = RIPPLE_SIDE;
const wave = (WAVELENGTH / RIPPLE_TILES) * n;
const [along, across] = [ALONG * wave, ACROSS * wave];
const reach = Math.ceil(along);
const PACKETS = Math.round(((n * n) / (along * across)) * DENSITY);
/** The packets' sum's typical height, its root mean square: so many to an
 *  area, each a wave, half its fall-off squared. */
const TYPICAL = Math.sqrt(((DENSITY * Math.PI) / 16) * (1 - Math.exp(-8)));

/** A packet: where it is, a little in from the square's corner so its box
 *  starts in it, which way it faces, and where in its wave it starts. */
const PACKET = `${RANDOM}
fn middle(i: u32) -> vec2f { return ${reach}. + vec2f(rnd(i, 0u), rnd(i, 1u)) * ${n}.; }
fn box(i: u32) -> vec4f { let c = middle(i); return vec4f(c - ${reach}., c + ${reach}.); }
fn stamp(i: u32, at: vec2f) -> vec4f {
  let o = at - middle(i);
  let angle = ${f(WIND)} + (rnd(i, 2u) - 0.5) * ${f(2 * SPREAD)};
  let way = vec2f(cos(angle), sin(angle));
  // Across the ridges (along the wave) short, along them long.
  let u = dot(o, way) / ${f(across)};
  let v = dot(o, vec2f(-way.y, way.x)) / ${f(along)};
  let r2 = u * u + v * v;
  if (r2 > 1.) { return vec4f(0.); }
  return vec4f(exp(-4. * r2) * cos(6.2831853 * (dot(o, way) / ${f(wave)} + rnd(i, 3u))));
}`;

/** Every texel's slope, across and up the square (red, green, from -1 to
 *  1 as 0 to 1; 1 a ridge's height in an eighth of the way to the next),
 *  and its height (blue). The sum scaled by its typical height, then
 *  pressed: every ridge to about the same height, its width where the
 *  pattern crosses zero, half a ridge apart, wherever packets crowd or
 *  thin; then its crest rounded, over the texels round it. */
const SLOPES = `fn pressed(p: vec2i) -> f32 { return tanh(${f(EVEN / TYPICAL)} * textureLoad(src0, (p % ${n} + ${n}) % ${n}, 0).r); }
fn rounded(p: vec2i) -> f32 {
  var sum = 0.;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { sum += pressed(p + vec2i(dx, dy)); } }
  return sum / 9.;
}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let slope = vec2f(rounded(p + vec2i(1, 0)) - rounded(p - vec2i(1, 0)), rounded(p + vec2i(0, 1)) - rounded(p - vec2i(0, 1))) / 2.;
  return vec4f(0.5 + slope * ${f(wave / 16)}, 0.5 + rounded(p) / 2., 1.);
}`;

const RIPPLES = new WeakMap<EngineContext, Texture2D>();
/** The sand's ripples, an engine's, drawn once. */
export function sandRipples(engine: EngineContext): Texture2D {
  let texture = RIPPLES.get(engine);
  if (!texture) {
    texture = createFilledTexture(engine, n, n, "rgba8unorm", true);
    const heights = createFilledTexture(engine, n, n, "r16float");
    stampTexture(engine, heights, PACKET, PACKETS, true, "add");
    fillTexture(engine, texture, SLOPES, [heights]);
    retire(heights);
    RIPPLES.set(engine, texture);
  }
  return texture;
}
