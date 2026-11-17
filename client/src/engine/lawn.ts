import { createFilledTexture, drawnOnce, fillTexture, RANDOM, stampTexture, type EngineContext, type Texture2D } from "./gpu";
import { retire } from "./geometry";

/**
 * The grass (`ground.ts` reads it): a square of lawn this many
 * texels a side, wrapping, laid over this many tiles. Blades in tufts,
 * fanned, long enough to see at the usual zoom, leaning up the map give or
 * take a little, so from above mostly their tips show, each blade one flat
 * face taking the sun its own way, and the gaps between them in shade: a pile
 * without a second colour. Only their height is kept, a half float a texel
 * (a byte stepped the light along a blade), and their slope found where it
 * is read (`lawnRead`), at the pixel, so a blade stays crisp zoomed in. Drawn on the GPU as the game starts, a blade a
 * stamp (`stampTexture`), so nothing of it is kept.
 */
export const LAWN_SIDE = 4096;
export const LAWN_TILES = 8;

/** How far a blade leans, base to tip as seen from above, and half its
 *  width at the base, in texels, eight texels to a pixel at the usual zoom:
 *  a stroke a few pixels long there, sharp zoomed in; and how many times
 *  over they cover the lawn. */
const LEAN = [28, 60];
const HALF_WIDTH = 4;
/** How far a blade's face turns, across it, at most: from its far edge
 *  this much lower than its middle to as much higher. */
const FACE = 0.6;
/** They lean up the map, away from the camera, as blades standing seen
 *  from it would, give or take this much, in radians. */
const SWAY = 0.4;
const COVER = 9;
/** They grow in tufts of this many, from within this many texels of the
 *  tuft's heart; and in clumps, about this many texels across, the
 *  shortest blades' this much shorter than the longest's, and as many
 *  more of them as close the ground as well: the lawn's grass long here and
 *  short there, never thin. */
const TUFT = 7;
/** Of each tuft's blades, this many grow loose instead, anywhere, so no
 *  ground goes bare between the tufts. */
const LOOSE = 3;
const TUFT_SPREAD = 14;
const CLUMP = 256;
const CLUMPED = 0.55;
/** Clover: this many heads to a tile, of one to three flowers each from
 *  this far across to this far, this far apart at most, in tiles. */
const CLOVER = 0.6;
const FLOWER = [0.02, 0.05];
const SPREAD = 0.1;
/** The lawn read a mip finer than the pixel asks: the camera looks
 *  down at a slant, and the coarser mip it asks for blurs the blades
 *  (`?sharpen=-2` finer still, `0` as asked). */
const SHARPEN = Number(new URLSearchParams(globalThis.location?.search ?? "").get("sharpen") ?? -1);


const f = (x: number) => x.toFixed(4);
const n = LAWN_SIDE;
const mean = (LEAN[0] + LEAN[1]) / 2;
const BLADES = Math.round((n * n * COVER) / (mean * HALF_WIDTH * 1.4) / (1 - CLUMPED));
/** Everything a little in from the square's corner, so no stamp's box
 *  starts before it. */
const IN = 64;

/**
 * And the lawn is not flat: all of it rolls, in hummocks of longer grass
 * and hollows between, noise this many cells to a side of its square and of
 * cells half that; no floor for them to sit on. A pixel's facing tilted by
 * their slope, this much for a rise of a hummock's whole height over a
 * tile. A point is in cells.
 */
const HUMMOCK_CELLS = 10;
const HUMMOCK_TILT = 0.2;
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
  let loose = i % ${TUFT}u < ${LOOSE}u;
  let base = select(vec2f(rnd(tuft, 5u), rnd(tuft, 6u)) * ${n}. + r * vec2f(cos(a), sin(a)), vec2f(rnd(i, 5u), rnd(i, 6u)) * ${n}., loose) + ${IN}.;
  let angle = ${f(Math.PI / 2)} + (rnd(i, 2u) - 0.5) * ${f(2 * SWAY)};
  let under = hummock(base);
  let down = 1. - 2. * under.rg;
  let steep = saturate(length(down) * ${f(SLOPED / STEEP)});
  let way = normalize(vec2f(cos(angle), sin(angle)) + down / max(length(down), 1e-4) * steep * ${f(SPLAY)});
  let short = 1. - ${f(CLUMPED)} * noise(base, ${CLUMP}., ${n / CLUMP}u, 9u);
  let lean = (${f(LEAN[0])} + rnd(i, 3u) * ${f(LEAN[1] - LEAN[0])}) * mix(${f(UPRIGHT)}, 1., steep) * short;
  // Of the blades, as many grow where they are short as cover the ground
  // as the long ones do; the rest, none.
  let grows = rnd(i, 8u) * short < ${f(1 - CLUMPED)};
  let top = select(0., (0.5 + 0.5 * rnd(i, 4u)) * (0.6 + 0.4 * under.b), grows);
  return Blade(base, way, lean, top);
}
// Only the box round it, base to tip.
fn box(i: u32) -> vec4f {
  let b = blade(i);
  let tip = b.base + b.way * b.lean;
  return vec4f(floor(min(b.base, tip) - ${f(HALF_WIDTH)}), ceil(max(b.base, tip) + ${f(HALF_WIDTH)}));
}
// Up the blade, from its base to its tip; across, from its spine,
// narrowing to the tip, from one edge to the other. Its height, in red:
// one flat face, turned its own way, so it takes the sun as no blade
// beside it does; rising from the ground at its base, as dark there.
fn stamp(i: u32, at: vec2f) -> vec4f {
  let b = blade(i);
  let o = at - b.base;
  let up = dot(o, b.way) / b.lean;
  let across = (o.y * b.way.x - o.x * b.way.y) / (${f(HALF_WIDTH)} * (1. - 0.7 * up));
  if (up < 0. || up >= 1. || abs(across) >= 1.) { return vec4f(0.); }
  return vec4f(min(1., b.top * up * (1. + ${f(FACE)} * (rnd(i, 7u) * 2. - 1.) * across)), 0., 0., 0.);
}`;

/** The blades' heights, kept a half float a texel. */
const KEPT = `fn fill(at: vec2f) -> vec4f { return textureLoad(src0, vec2i(at), 0); }`;

/** Where a clover flower is, at a point of the map in tiles, from 0 to 1:
 *  a tile's head, if it has one, of up to three. WGSL, for a lawn's reader. */
const CLOVER_AT = `fn lawnRnd(i: u32, k: u32) -> f32 {
  var h = i * 747796405u + k * 2891336453u + 1u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32(((h >> 22u) ^ h) >> 8u) / 16777216.;
}
fn lawnClover(p: vec2f) -> f32 {
  let c = vec2i(floor(p));
  let head = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u);
  if (lawnRnd(head, 0u) >= ${f(CLOVER)}) { return 0.; }
  let at = vec2f(c) + 0.15 + 0.7 * vec2f(lawnRnd(head, 1u), lawnRnd(head, 2u));
  var most = 0.;
  for (var k = 0u; k < 1u + u32(lawnRnd(head, 3u) * 3.); k++) {
    let o = at + (vec2f(lawnRnd(head, 10u + k), lawnRnd(head, 20u + k)) - 0.5) * ${f(SPREAD)};
    let r = (${f(FLOWER[0])} + lawnRnd(head, 30u + k) * ${f(FLOWER[1] - FLOWER[0])}) / 2.;
    most = max(most, min(1., 1.5 * (1. - dot(p - o, p - o) / (r * r))));
  }
  return most;
}`;
export const LAWN_DEFINITIONS = CLOVER_AT;

/** The lawn read at a point of the map, in tiles, from `texture`: `name`,
 *  its slope across and up (red, green, -1 to 1), its height (blue, 0 deep
 *  between the blades) and whether a flower is there (alpha). Its slope
 *  from the heights half a texel either side, of the mip read, so it runs
 *  on smoothly from texel to texel instead of standing still in each, as a
 *  blade as tall as it is wide would have; its height their mean.
 *  (`?lawnzoom=8` draws it eight times larger, to see it.) */
const ZOOM = Number(new URLSearchParams(globalThis.location?.search ?? "").get("lawnzoom") ?? 1);
export const lawnRead = (texture: string, at: string, name: string) => {
  const read = (o: string) => `textureSampleBias(${texture}, ${texture}Sampler, ${name}Uv + ${o}, ${f(SHARPEN)}).r`;
  return `let ${name}Uv = (${at}) / ${f(LAWN_TILES * ZOOM)};
let ${name}E = max(${(0.5 / n).toExponential(4)}, 0.5 * max(fwidth(${name}Uv).x, fwidth(${name}Uv).y) * ${f(2 ** SHARPEN)});
let ${name}Xp = ${read(`vec2f(${name}E, 0.)`)};
let ${name}Xm = ${read(`vec2f(-${name}E, 0.)`)};
let ${name}Yp = ${read(`vec2f(0., ${name}E)`)};
let ${name}Ym = ${read(`vec2f(0., -${name}E)`)};
let ${name} = vec4f(clamp(vec2f(${name}Xp - ${name}Xm, ${name}Yp - ${name}Ym) / (2. * ${name}E * ${n}.) * ${f(1.5 * HALF_WIDTH)}, vec2f(-1.), vec2f(1.)), 0.25 * (${name}Xp + ${name}Xm + ${name}Yp + ${name}Ym), lawnClover(${at}));`;
};

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
  const texture = createFilledTexture(engine, n, n, "r16float", true);
  const heights = createFilledTexture(engine, n, n, "r16float");
  stampTexture(engine, heights, BLADE, BLADES, true, "max", [hummocks(engine)]);
  fillTexture(engine, texture, KEPT, [heights]);
  retire(heights);
  return texture;
});
