import { createFilledTexture, drawnOnce, fillTexture, releaseTexture, type EngineContext, type Texture2D } from "./gpu";
import { BARK_ALONG } from "./objects/finish";

/**
 * Bark, as a log's is (`objects/sawmill.ts` reads it), drawn on the GPU: a
 * strip this many texels round the log and this many along it, wrapping
 * both ways, once round a log and `BARK_ALONG` tiles along it. Furrows
 * running along the log, broken and wandering, the ridges between them
 * plated: its height value noise stretched along, its slope in red and
 * green (how far the light is turned, round and along), how light it is
 * in blue, the furrows dark.
 */
export const BARK_ROUND = 64;
export const BARK_LONG = 256;

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

const f = (x: number) => x.toFixed(5);
const [w, h] = [BARK_ROUND, BARK_LONG];
const total = OCTAVES.reduce((s, o) => s + o[2], 0);

/** Its height: value noise of so many cells over the strip, wrapping
 *  round it; each furrow wandering round the log a little as it runs
 *  along it; ridged, the furrows narrow and sharp, the ridges broad. */
const HEIGHT = `fn corner(c: vec2i, cells: vec2i, salt: u32) -> f32 {
  let k = vec2u(((c % cells) + cells) % cells);
  var g = (k.x * 0x27d4eb2du) ^ (k.y * 0x165667b1u) ^ (salt * 0x9e3779b9u);
  g = (g ^ (g >> 15u)) * 0x85ebca6bu;
  g = (g ^ (g >> 13u)) * 0xc2b2ae35u;
  return f32(g ^ (g >> 16u)) / 4294967296.;
}
fn noise(uv: vec2f, cells: vec2i, salt: u32) -> f32 {
  let p = uv * vec2f(cells);
  let i = vec2i(floor(p));
  let s = fract(p) * fract(p) * (3. - 2. * fract(p));
  return mix(mix(corner(i, cells, salt), corner(i + vec2i(1, 0), cells, salt), s.x), mix(corner(i + vec2i(0, 1), cells, salt), corner(i + vec2i(1, 1), cells, salt), s.x), s.y);
}
fn fill(at: vec2f) -> vec4f {
  let v = floor(at.y) / ${h}.;
  let uv = vec2f(floor(at.x) / ${w}. + 0.04 * (noise(vec2f(0., v), vec2i(1, 5), 7u) - 0.5), v);
  let sum = (${OCTAVES.map(([cx, cy, k], i) => `${f(k)} * noise(uv, vec2i(${cx}, ${cy}), ${i + 1}u)`).join(" + ")}) / ${f(total)};
  return vec4f(1. - pow(abs(2. * sum - 1.), 0.7));
}`;
/** Every texel's slope and light. */
const BARK = `fn high(p: vec2i) -> f32 { return textureLoad(src0, ((p % vec2i(${w}, ${h})) + vec2i(${w}, ${h})) % vec2i(${w}, ${h}), 0).r; }
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let slope = ${f(-STEEP)} * vec2f(high(p + vec2i(1, 0)) - high(p - vec2i(1, 0)), (high(p + vec2i(0, 1)) - high(p - vec2i(0, 1))) * ${f(GIRTH / w / (BARK_ALONG / h))});
  return vec4f(clamp(slope, vec2f(-1.), vec2f(1.)) * 0.5 + 0.5, 1. - ${f(DEEP)} * pow(1. - high(p), 1.5), 1.);
}`;

/** An engine's bark, drawn once. */
export const bark = drawnOnce("bark", (engine: EngineContext): Texture2D => {
  const texture = createFilledTexture(engine, w, h, "rgba8unorm", true);
  const height = createFilledTexture(engine, w, h, "r32float");
  fillTexture(engine, height, HEIGHT, []);
  fillTexture(engine, texture, BARK, [height]);
  releaseTexture(height);
  return texture;
});
