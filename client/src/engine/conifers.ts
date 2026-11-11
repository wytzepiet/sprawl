import { createFilledTexture, fillTexture, type EngineContext, type Texture2D } from "./gpu";
import { CROWN_REACH, CROWN_TEXELS, LIT } from "./crowns";

/**
 * The conifers' crowns, drawn on the GPU (`trees.ts` wears them): a texel
 * is worked out from where it is alone, so every texel at once, where
 * pixels are made, in the frame the first conifer is planted.
 */

/** Conifers, as a spruce is from the air: tiers of arms, this many from
 *  its tip down, each tier's arms from this many to this many, turned its
 *  own way, reaching further the lower it is, each arm of its tier's reach
 *  give or take this much, and turned off its place by up to this much of
 *  the way to the next; an arm this wide at its foot, of the crown's
 *  radius, rounding off to this toward its tip, and to a point at it. The topmost arm over a point is
 *  what is seen there: round across, its sides rolling over this steeply,
 *  drooping this much more toward its tip, in needles, facets this wide
 *  tilted up to this far; and a tier lies darker under those above it, by
 *  this much at the lowest. */
export const CONIFERS = 4;
const TIERS = 12;
/** A conifer is drawn in this many layers, a band of its tiers each, the
 *  top first (`trees.ts` stacks them), so its upper arms stand over its
 *  lower and shade them; the bands the thinner the higher, to this power,
 *  where a tree is narrow and its stack shows most. */
export const CONIFER_LAYERS = 8;
const BANDING = 1.6;
const bound = (layer: number) => Math.max(layer, Math.round(TIERS * (layer / CONIFER_LAYERS) ** BANDING));
const BOUNDS = Array.from({ length: CONIFER_LAYERS + 1 }, (_, layer) => bound(layer));
const ARMS = [12, 18];
const ARM_REACH = 0.3;
const ARM_TURN = 0.35;
const ARM_FOOT = 0.2;
const ARM_TIP = 0.05;
const RIDGE = 0.6;
const DROOP = 0.5;
const NEEDLE = 1 / 45;
const NEEDLE_TILT = 0.4;
const UNDER = 0.15;
/** And an arm is no blade but a twig, this wide, with needles off each
 *  side, swept toward its tip this much, a row of them this far apart
 *  along it, this much of it needle and the rest a gap, each row reaching
 *  out from this much of the arm's width to all of it; through the gaps
 *  the tiers below show, and the ground. Needles face out to their side
 *  this much. */
const TWIG = 0.012;
const SWEEP = 1.2;
const ROW = 0.03;
const NEEDLED = 0.75;
const ROW_REACH = 0.7;
const SPLAY = 0.5;

/** How far out each layer's arms reach at most, of the crown's radius. */
export const LAYER_REACH = BOUNDS.slice(1).map((last) => Math.min(1, (last / TIERS) * (1 + ARM_REACH)));

const f = (x: number) => x.toFixed(5);

/** A texel of the conifers' texture: a conifer a column, a layer a row,
 *  each a crown from above as the broadleaves' are (`crowns.ts`): how far
 *  out (red, halved; 1 where nothing is), its tilt, and its light or twig. */
const CONIFER = /* wgsl */ `
const BOUNDS = array<i32, ${BOUNDS.length}>(${BOUNDS.join(", ")});
// Two numbers from 0 to 1 for a cell, and for each use of it its own.
fn hash(x: i32, y: i32, salt: i32) -> vec2f {
  var h = (bitcast<u32>(x) * 0x27d4eb2du) ^ (bitcast<u32>(y) * 0x165667b1u) ^ (bitcast<u32>(salt) * 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h ^= h >> 16u;
  let g = (h ^ (h >> 11u)) * 0x2c1b3c6du;
  return vec2f(f32(h), f32(g ^ (g >> 15u))) / 4294967296.;
}
// The tilt of the flat facet a point lies on, cells of side 1: each cell's
// facet from a point somewhere in it, nearest wins, tilted its own way.
fn facet(p: vec2f) -> vec2f {
  var best = 9.;
  var tilt = vec2f(0.);
  let c0 = vec2i(floor(p));
  for (var cy = c0.y - 1; cy <= c0.y + 1; cy++) {
    for (var cx = c0.x - 1; cx <= c0.x + 1; cx++) {
      let d = p - vec2f(f32(cx), f32(cy)) - hash(cx, cy, 1);
      if (dot(d, d) < best) { best = dot(d, d); tilt = hash(cx, cy, 2); }
    }
  }
  return tilt * 2. - 1.;
}
fn fill(at: vec2f) -> vec4f {
  let cell = floor(at / ${CROWN_TEXELS}.);
  let p = ((at - cell * ${CROWN_TEXELS}.) / ${CROWN_TEXELS}. * 2. - 1.) * ${f(CROWN_REACH)};
  let v = i32(cell.x);
  let layer = i32(cell.y);
  let rho = length(p);
  let theta = atan2(p.y, p.x);
  for (var t = BOUNDS[layer]; t < BOUNDS[layer + 1]; t++) {
    let tier = hash(v, t, 7);
    let arms = i32(round(${f(ARMS[0])} + ${f(ARMS[1] - ARMS[0])} * tier.x));
    let u = theta / 6.2831853 * f32(arms) + tier.y;
    let arm = i32(floor(u + 0.5));
    let own = hash(((arm % arms) + arms) % arms, t * 31 + v, 8);
    let turned = (u - f32(arm) - (own.y - 0.5) * ${f(ARM_TURN)}) * 6.2831853 / f32(arms);
    let reach = f32(t + 1) / ${TIERS}. * (${f(1 - ARM_REACH)} + ${f(2 * ARM_REACH)} * own.x);
    let along = rho * cos(turned);
    let across = rho * sin(turned);
    let width = (${f(ARM_FOOT)} * sqrt(max(0., 1. - along / reach)) + ${f(ARM_TIP)}) * min(1., (1. - along / reach) * 4.);
    if (along < 0. || along > reach || abs(across) > width) { continue; }
    // On the twig, or on a needle off it; else a gap, and what is under it shows.
    let off = abs(across);
    let row = (along - off * ${f(SWEEP)}) / ${f(ROW)};
    let rowLong = hash(i32(floor(row)), select(2, 1, across > 0.) + t * 7 + v * 131, 9).x;
    let needle = off > ${f(TWIG)};
    if (needle && (fract(row) > ${f(NEEDLED)} || off > width * (${f(ROW_REACH)} + ${f(1 - ROW_REACH)} * rowLong))) { continue; }
    // Its arm, seen: which way the arm runs and its side, and how far out on it.
    let a = vec2f(cos(theta - turned), sin(theta - turned));
    // Round, as a log is across: flat along its top, rolling over at its sides.
    let s = across / width;
    let side = select(s / sqrt(max(1. - s * s, 0.08)) * ${f(RIDGE)}, sign(across) * ${f(SPLAY)}, needle);
    let down = ${f(DROOP)} * (along / reach);
    let tilt = facet(p / ${f(NEEDLE)} + own * 41.) * ${f(NEEDLE_TILT)};
    return vec4f(rho / 2., 0.5 + (a.x * down - a.y * side + tilt.x) / 2., 0.5 + (a.y * down + a.x * side + tilt.y) / 2., select(1., (1. - ${f(UNDER)} * f32(t) / ${TIERS - 1}.) * ${f(LIT)}, needle));
  }
  return vec4f(1., 0., 0., 0.);
}`;

const DRAWN = new WeakMap<EngineContext, Texture2D>();
/** An engine's conifers, drawn once. */
export function conifers(engine: EngineContext): Texture2D {
  let texture = DRAWN.get(engine);
  if (!texture) {
    texture = createFilledTexture(engine, CONIFERS * CROWN_TEXELS, CONIFER_LAYERS * CROWN_TEXELS, "rgba8unorm", true);
    fillTexture(engine, texture, CONIFER, []);
    DRAWN.set(engine, texture);
  }
  return texture;
}
