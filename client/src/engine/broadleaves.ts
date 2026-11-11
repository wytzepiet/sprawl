import { RANDOM, SHAPE_READ, createFilledTexture, fillTexture, layTexture, releaseTexture, shapesTexture, type EngineContext, type Texture2D } from "./gpu";
import { BROAD_LAYERS, CROWNS, CROWN_REACH, CROWN_TEXELS, LEAF_TILT, LIT, ROWS } from "./crowns";
import { bake } from "./bakeCache";
import { stale } from "./still";

/**
 * The broadleaves' crowns, drawn on the GPU (`trees.ts` wears them) from
 * the trees a worker grows (`crowns.ts`): a tree a column of one texture,
 * its layers down it, top first, then its side. Growing is a tree's worth
 * of thought and stays where thought is done; laying fourteen thousand
 * leaves down a texel at a time is drawing, and is done where drawing is.
 */

/** The light reaches down less: at the crown's foot this much of what its
 *  top gets; and under the crown's skin, a dome over its highest leaves
 *  this many texels round, it is darker: all of it this deep, of the
 *  crown's height, by this much. */
const FOOT_LIGHT = 0.5;
const SKIN = 10;
const DEEP = 0.25;
const DARKEST = 0.75;
/** Under all, between its clumps, leaves in shade: wherever this much of
 *  what is within this many texels each way is leaves. */
const DENSE_OF = 0.45;
const DENSE = 9;

const f = (x: number) => x.toFixed(5);
const T = CROWN_TEXELS;
const [WIDE, HIGH] = [CROWNS * T, ROWS * T];

/** A shape laid (`crowns.ts`' `SHAPE`): a leaf, pointed, along its
 *  stalk's way, tilted; or a limb, round across. How high it stands, its
 *  lean, and whether it is wood. */
const SHAPES = `${SHAPE_READ}
struct Shape { foot: vec2f, high: f32, tip: vec2f, other: f32, long: f32, limb: bool, tilt: vec2f, lift: f32 }
fn shape(i: u32) -> Shape {
  let n = shapeRead(i);
  return Shape(n[0].xy, n[0].z, vec2f(n[0].w, n[1].x), n[1].y, n[1].z, n[1].w > 0.5, n[2].xy, n[2].z);
}
fn box(i: u32) -> vec4f {
  let s = shape(i);
  if (s.limb) { return vec4f(floor(min(s.foot, s.tip) - s.long), ceil(max(s.foot, s.tip) + s.long)); }
  let r = max(s.long, s.other);
  return vec4f(floor(s.foot - r), ceil(s.foot + r));
}
fn stamp(i: u32, at: vec2f) -> vec4f {
  let s = shape(i);
  let d = at - s.foot;
  if (s.limb) {
    let e = s.tip - s.foot;
    let t = clamp(dot(d, e) / max(dot(e, e), 1e-6), 0., 1.);
    let q = d - e * t;
    if (dot(q, q) > s.long * s.long) { return vec4f(-2.); }
    return vec4f(mix(s.high, s.other, t), q / s.long * 0.6, 1.);
  }
  let a = dot(d, s.tip) / s.long;
  let b = (d.y * s.tip.x - d.x * s.tip.y) / s.other;
  if (a * a + b * b > 1. - abs(a) * 0.5) { return vec4f(-2.); }
  return vec4f(s.high - dot(s.tilt, d) * s.lift, s.tilt, 0.);
}`;

/** A tree's highest leaf over a texel of its column, from its layers; and
 *  of a row of them: the crown's skin, its highest leaf near each texel,
 *  falling away from it; and how much of what is near is covered. */
const TOP = `fn top(tree: i32, at: vec2i) -> f32 {
  if (at.x < 0 || at.x >= ${T}) { return -1.; }
  var high = -1.;
  for (var l = 0; l < ${BROAD_LAYERS}; l++) { high = max(high, textureLoad(src0, vec2i(tree * ${T} + at.x, l * ${T} + at.y), 0).r); }
  return high;
}
fn fill(at: vec2f) -> vec4f {
  let tree = i32(at.x) / ${T};
  let p = vec2i(i32(at.x) % ${T}, i32(at.y));
  var skin = 0.;
  var covered = 0.;
  for (var d = ${-SKIN}; d <= ${SKIN}; d++) {
    let high = top(tree, p + vec2i(d, 0));
    skin = max(skin, high - f32(d * d) * ${f(DEEP / (SKIN * SKIN))});
    if (abs(d) <= ${DENSE} && high >= 0.) { covered += ${f(1 / (2 * DENSE + 1))}; }
  }
  return vec4f(skin, covered, 0., 0.);
}`;
/** And of a column of those rows: the skin and the cover all round. */
const ROUND = `fn fill(at: vec2f) -> vec4f {
  var skin = 0.;
  var covered = 0.;
  for (var d = ${-SKIN}; d <= ${SKIN}; d++) {
    let y = i32(at.y) + d;
    if (y < 0 || y >= ${T}) { continue; }
    let row = textureLoad(src0, vec2i(i32(at.x), y), 0);
    skin = max(skin, row.r - f32(d * d) * ${f(DEEP / (SKIN * SKIN))});
    if (abs(d) <= ${DENSE}) { covered += row.g * ${f(1 / (2 * DENSE + 1))}; }
  }
  return vec4f(skin, covered, 0., 0.);
}`;

/** Every crown, a texel each: how far out it is, of the radius its outline
 *  stands at (red, halved; 1 where nothing is), which way it tilts (green
 *  and blue, from -1 to 1), and how much light reaches down to it (alpha,
 *  up to `LIT`), or that it is twig, not leaf (alpha past it): the light
 *  less the lower it is, and the deeper under the crown's skin. Where it
 *  is mostly leaves, the lowest layer is leaves deep in shade, as a crown
 *  is between its clumps: only its wider gaps open to the ground. And its
 *  side, what of it covers. */
const CROWN = `${RANDOM}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let layer = p.y / ${T};
  var laid = textureLoad(src0, p, 0);
  if (layer == ${BROAD_LAYERS}) { return vec4f(select(1., 0., laid.r >= 0.), 0., 0., 0.); }
  let near = textureLoad(src1, vec2i(p.x, p.y % ${T}), 0);
  if (layer == ${BROAD_LAYERS - 1} && laid.r < 0. && near.g > ${f(DENSE_OF)}) {
    let k = u32(p.y) * ${WIDE}u + u32(p.x);
    laid = vec4f(0., (vec2f(rnd(k, 0u), rnd(k, 1u)) * 2. - 1.) * ${f(LEAF_TILT)}, 0.);
  }
  if (laid.r < 0.) { return vec4f(1., 0., 0., 0.); }
  let far = (fract(at / ${T}.) * 2. - 1.) * ${f(CROWN_REACH)};
  let under = clamp((near.r - laid.r) / ${f(DEEP)}, 0., 1.);
  let light = (${f(FOOT_LIGHT)} + ${f(1 - FOOT_LIGHT)} * max(0., laid.r)) * (1. - ${f(DARKEST)} * under) * ${f(LIT)};
  return vec4f(length(far) / 2., 0.5 + laid.gb / 2., select(light, 1., laid.a > 0.5));
}`;

const NOTHING = `fn fill(at: vec2f) -> vec4f { return vec4f(1., 0., 0., 0.); }`;

const DRAWN = new WeakMap<EngineContext, { texture: Texture2D; ready: Promise<void> }>();
function crowns(engine: EngineContext) {
  let it = DRAWN.get(engine);
  if (!it) {
    const texture = createFilledTexture(engine, WIDE, HIGH, "rgba8unorm", true);
    fillTexture(engine, texture, NOTHING, []);
    const ready = bake("crowns").then((bytes) => {
      const numbers = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const shapes = shapesTexture(engine, numbers);
      const laid = createFilledTexture(engine, WIDE, HIGH, "rgba16float");
      const [row, round] = [createFilledTexture(engine, WIDE, T, "rg16float"), createFilledTexture(engine, WIDE, T, "rg16float")];
      layTexture(engine, laid, SHAPES, numbers.length / 12, [shapes], [-1, 0, 0, 0]);
      fillTexture(engine, row, TOP, [laid]);
      fillTexture(engine, round, ROUND, [row]);
      fillTexture(engine, texture, CROWN, [laid, round]);
      for (const t of [shapes, laid, row, round]) releaseTexture(t);
      stale();
    });
    it = { texture, ready };
    DRAWN.set(engine, it);
  }
  return it;
}

/** An engine's broadleaves: nothing of any until they are grown and
 *  drawn, so no tree shows before its crown does. */
export const broadleaves = (engine: EngineContext): Texture2D => crowns(engine).texture;
/** When they are. */
export const broadleavesDrawn = (engine: EngineContext): Promise<void> => crowns(engine).ready;
