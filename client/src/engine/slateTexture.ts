import { createFilledTexture, fillTexture, mostOf, readTexture, releaseTexture, type EngineContext, type Texture2D } from "./gpu";
import { EDGE_LEVEL, SIDE } from "./slate";

/**
 * Slate, drawn on the GPU: a tiling surface of stone plates lying on one
 * another, as cleaved slate does, worked out once and read as a texture
 * (`peaks.ts`), and its smaller copy read back for the edges the rock
 * breaks along (`slate.ts`).
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
/** A plate's edge chips: the plates are softened over this many texels
 *  each way, twice, and this much of the softened kept. */
const CHIP = 3;
const CHIPPED = 0.5;
/** How steep a slope of the height is drawn, in the facing, a texel
 *  across. */
const RELIEF = 15;

const f = (x: number) => x.toFixed(5);
const n = SIDE;

/** A hash of up to four integers, 0 to 1; smooth value noise of it,
 *  wrapping every `per` cells, at a point in cells; and two octaves of
 *  that, -1 to 1, at (u, v) of the texture. */
const NOISE = `fn mixed(h: u32, k: i32) -> u32 {
  var g = (h ^ bitcast<u32>(k)) * 0x01000193u;
  g ^= g >> 15u;
  g *= 0x2c1b3c6du;
  return g ^ (g >> 12u);
}
fn hash(a: i32, b: i32, c: i32, d: i32) -> f32 { return f32(mixed(mixed(mixed(mixed(0x811c9dc5u, a), b), c), d)) / 4294967296.; }
fn wrapped(i: vec2i, per: vec2i) -> vec2i { return ((i % per) + per) % per; }
fn noise(p: vec2f, per: vec2i, salt: i32) -> f32 {
  let i = vec2i(floor(p));
  let t = p - floor(p);
  let u = t * t * t * (t * (t * 6. - 15.) + 10.);
  let c00 = wrapped(i, per);
  let c11 = wrapped(i + 1, per);
  let a = mix(hash(c00.x, c00.y, salt, 0), hash(c11.x, c00.y, salt, 0), u.x);
  let b = mix(hash(c00.x, c11.y, salt, 0), hash(c11.x, c11.y, salt, 0), u.x);
  return mix(a, b, u.y);
}
fn fbm(uv: vec2f, cells: i32, salt: i32) -> f32 {
  return (noise(uv * f32(cells), vec2i(cells), salt) + 0.5 * noise(uv * f32(cells * 2), vec2i(cells * 2), salt + 1)) / 1.5 * 2. - 1.;
}
fn load(p: vec2i) -> f32 { return textureLoad(src0, wrapped(p, vec2i(${n})), 0).r; }`;

/** The highest plate over each texel, looked up through the warp. */
const PLATES = `${NOISE.replace(/fn load.*$/, "")}
// Each layer's cells across the grain, and along it: fewer, each plate longer that way.
const ACROSS = array<i32, ${LAYERS.length}>(${LAYERS.join(", ")});
const ALONG = array<i32, ${LAYERS.length}>(${LAYERS.map((across) => Math.max(1, Math.round(across / STRETCH))).join(", ")});
fn plates(uv: vec2f) -> f32 {
  var top = -9.;
  for (var l = 0; l < ${LAYERS.length}; l++) {
    let per = vec2i(ALONG[l], ACROSS[l]);
    let p = uv * vec2f(per);
    let c = vec2i(floor(p));
    var best = 1e9;
    var point = vec2f(0.);
    var won = vec2i(0);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cell = c + vec2i(dx, dy);
        let w = wrapped(cell, per);
        let q = vec2f(cell) + vec2f(hash(w.x, w.y, l, 1), hash(w.x, w.y, l, 2));
        // Distance in the plate's own measure: stretched cells, round plates.
        let d = dot(p - q, p - q);
        if (d < best) { best = d; point = q; won = w; }
      }
    }
    let base = f32(l) * ${f(RISE)} + (hash(won.x, won.y, l, 3) - 0.5) * ${f(SPREAD)};
    let tilt = (vec2f(hash(won.x, won.y, l, 4), hash(won.x, won.y, l, 5)) - 0.5) * ${f(TILT)};
    top = max(top, base + dot(tilt, (p - point) / vec2f(per)) * 4.);
  }
  return top;
}
fn fill(at: vec2f) -> vec4f {
  let uv = floor(at) / ${n}.;
  let a = ${f(WARP)} * vec2f(fbm(uv, ${WARP_CELLS}, 11), fbm(uv, ${WARP_CELLS}, 13));
  let b = ${f(WARP * WARP_FINE[1])} * vec2f(fbm(uv, ${WARP_CELLS * WARP_FINE[0]}, 31), fbm(uv, ${WARP_CELLS * WARP_FINE[0]}, 33));
  return vec4f(plates(uv + a + b));
}`;

/** A field softened along one way, wrapping: a box twice, a tent. */
const soften = (way: string) => `var soft = 0.;
  for (var d = ${-2 * CHIP}; d <= ${2 * CHIP}; d++) { soft += load(vec2i(at) + d * ${way}) * f32(${2 * CHIP + 1} - abs(d)); }
  soft /= ${(2 * CHIP + 1) ** 2}.;`;
const SOFT = `${NOISE}
fn fill(at: vec2f) -> vec4f {
  ${soften("vec2i(1, 0)")}
  return vec4f(soft, load(vec2i(at)), 0., 0.);
}`;
/** The plates' edges chipped: softened, a share of it kept; and the
 *  relief, the streaks, the detail and the grit over them. */
const HEIGHT = `${NOISE}
fn fill(at: vec2f) -> vec4f {
  ${soften("vec2i(0, 1)")}
  let p = vec2i(at);
  let uv = floor(at) / ${n}.;
  let sharp = textureLoad(src0, p, 0).g;
  let streak = noise(uv * vec2f(${STREAK_CELLS.join("., ")}.), vec2i(${STREAK_CELLS.join(", ")}), 23);
  return vec4f(mix(sharp, soft, ${f(CHIPPED)}) + ${f(BROAD)} * fbm(uv, ${RELIEF_CELLS}, 29) + ${f(STREAK)} * streak + ${f(DETAIL)} * fbm(uv, ${DETAIL_CELLS}, 17) + ${f(GRIT)} * (hash(p.x, p.y, 19, 0) - 0.5));
}`;

/** Its facing's x and y, half-way at level, and its height, 0 to 1 from
 *  its lowest to its highest (`mostOf`, of it upside down and as it is). */
const SLATE = `${NOISE}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let most = textureLoad(src1, vec2i(0), 0).rg * vec2f(-1., 1.);
  let slope = vec2f(load(p + vec2i(1, 0)) - load(p - vec2i(1, 0)), load(p + vec2i(0, 1)) - load(p - vec2i(0, 1))) * ${f(RELIEF)};
  return vec4f(0.5 - slope / length(vec3f(slope, 1.)) * 0.5, (load(p) - most.x) / (most.y - most.x), 1.);
}`;

const DRAWN = new WeakMap<EngineContext, { texture: Texture2D; read: Promise<Uint8Array> }>();
function drawn(engine: EngineContext) {
  let it = DRAWN.get(engine);
  if (!it) {
    const texture = createFilledTexture(engine, n, n, "rgba8unorm", true);
    const [plates, soft, height] = [createFilledTexture(engine, n, n, "r32float"), createFilledTexture(engine, n, n, "rg32float"), createFilledTexture(engine, n, n, "r32float")];
    fillTexture(engine, plates, PLATES, []);
    fillTexture(engine, soft, SOFT, [plates]);
    fillTexture(engine, height, HEIGHT, [soft]);
    const most = mostOf(engine, height, "vec4f(-h.r, h.r, 0., 0.)");
    fillTexture(engine, texture, SLATE, [height, most]);
    for (const t of [plates, soft, height, most]) releaseTexture(t);
    it = { texture, read: readTexture(engine, texture, EDGE_LEVEL) };
    DRAWN.set(engine, it);
  }
  return it;
}

/** An engine's slate, drawn once. The cliffs the land stands on break
 *  along it too (`ground.ts`). */
export const slate = (engine: EngineContext): Texture2D => drawn(engine).texture;
/** And its smaller copy, read back (`slate.ts`' `setSlate`). */
export const slateRead = (engine: EngineContext): Promise<Uint8Array> => drawn(engine).read;
