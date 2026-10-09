/**
 * The trees' crowns, baked (`trees.ts` draws them): a few, each a tree's
 * crown seen from above, in texels. On its own, for a worker to bake
 * (`crownWorker.ts`): two million texels take a second and more.
 */

/** A crown is clumps of leaves, as a tree is from the air: cells this
 *  wide, of its radius, each with a clump somewhere in it. Between clumps
 *  its outline is pulled in this far, so it is lumpy, not round, and frayed
 *  by its leaves, this small; each clump rolls over as a dome of its own,
 *  this much. Down between clumps the light reaches less: this dark at the
 *  deepest, from this far out of a clump's middle, as the leaves let it. */
const CLUMP = 0.55;
const LUMP = 0.4;
const FRINGE = 0.12;
const LEAF = 1 / 20;
const CLUMP_TILT = 2.2;
const HOLLOW_FROM = 0.2;
/** And no two clumps alike: each from this much to this much the size of
 *  the rest, the larger crowding out the smaller; anywhere in this much of
 *  its cell; and the cells bent a little, by a slow noise this many of the
 *  crown's radius across, this far, so they are not quite cells. */
const CLUMP_SIZES = [0.7, 1.3];
const JITTER = 0.9;
const WARP_SPAN = 0.4;
const WARP = 0.28;
/** Which clump a leaf belongs to is the leaf's, not the point's: each leaf
 *  looks for its clump from this far off, its own way, so where two clumps
 *  meet is ragged with leaves, not a line. */
const RAGGED = 0.16;
/** And its leaves catch the light each its own way: flat facets this wide,
 *  of its radius, and shards this wide on them, each tilted at random up
 *  to this far, so the light breaks from leaf to leaf as off broken rock. */
const FACET = 1 / 28;
const SHARD = 1 / 55;
const FACET_TILT = 0.42;
const SHARD_TILT = 0.24;

/** Crowns are baked, not worked out pixel by pixel: this many broadleaves,
 *  then the
 *  conifers' (`CONIFERS`), a layer of each at a time, each this
 *  many texels across, over this far out of its radius (past 1, so a
 *  crown's edge never reaches its neighbour's), so many to a row of one
 *  texture. Every tree wears one, turned its own way, by where it stands. */
export const CROWNS = 8;
export const CROWN_TEXELS = 512;
export const CROWN_REACH = 1.1;
export const COLUMNS = 8;

// The bake reads two million texels, a few hundred hashes each: so its
// helpers write their pairs here rather than make an array a call.
let h0 = 0, h1 = 0;
/** Two numbers from 0 to 1 for a cell, and for each use of it its own: in h0, h1. */
function hash(x: number, y: number, use: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(use, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  const g = Math.imul(h ^ (h >>> 11), 0x2c1b3c6d);
  h0 = (h >>> 0) / 4294967296;
  h1 = ((g ^ (g >>> 15)) >>> 0) / 4294967296;
}
let f0 = 0, f1 = 0;
/** The tilt of the flat facet a point lies on, cells of side 1, in f0, f1:
 *  each cell's facet from a point somewhere in it, nearest wins, tilted its
 *  own way. */
function facet(x: number, y: number) {
  let near = 9, fx = 0, fy = 0;
  const [x0, y0] = [Math.floor(x), Math.floor(y)];
  for (let cy = y0 - 1; cy <= y0 + 1; cy++) {
    for (let cx = x0 - 1; cx <= x0 + 1; cx++) {
      hash(cx, cy, 1);
      const dx = x - cx - h0, dy = y - cy - h1;
      const d = dx * dx + dy * dy;
      if (d < near) (near = d), hash(cx, cy, 2), (fx = h0), (fy = h1);
    }
  }
  f0 = fx * 2 - 1;
  f1 = fy * 2 - 1;
}
let n0 = 0, n1 = 0;
/** Smooth noise, two of it, in n0, n1. */
function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = (x - ix) * (x - ix) * (3 - 2 * (x - ix)), ty = (y - iy) * (y - iy) * (3 - 2 * (y - iy));
  hash(ix, iy, 0);
  const [a0, a1] = [h0, h1];
  hash(ix + 1, iy, 0);
  const [b0, b1] = [a0 + (h0 - a0) * tx, a1 + (h1 - a1) * tx];
  hash(ix, iy + 1, 0);
  const [c0, c1] = [h0, h1];
  hash(ix + 1, iy + 1, 0);
  n0 = b0 + (c0 + (h0 - c0) * tx - b0) * ty;
  n1 = b1 + (c1 + (h1 - c1) * tx - b1) * ty;
}

const byte = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
/** The most light a leaf's alpha says; above it, a texel is twig. */
export const LIT = 0.8;

/** A broadleaf's texel at (x, y), of its radius, into out at k: the clump
 *  nearest, the outline pulled in away from clumps and frayed by the
 *  leaves, and the light less, the further out of the clump's middle. */
function broad(out: Uint8Array, k: number, x: number, y: number, s0: number, s1: number) {
  noise(x / WARP_SPAN + s1 * 23, y / WARP_SPAN + s0 * 23);
  const [w0, w1] = [n0, n1];
  facet(x / FACET + s0 * 41, y / FACET + s1 * 41);
  const [l0, l1] = [f0, f1];
  const ax = x / CLUMP + s0 * 17 + (w0 - 0.5) * 2 * WARP + l0 * RAGGED;
  const ay = y / CLUMP + s1 * 17 + (w1 - 0.5) * 2 * WARP + l1 * RAGGED;
  let near = 9, tx = 0, ty = 0;
  const [ax0, ay0] = [Math.floor(ax), Math.floor(ay)];
  for (let cy = ay0 - 1; cy <= ay0 + 1; cy++) {
    for (let cx = ax0 - 1; cx <= ax0 + 1; cx++) {
      hash(cx, cy, 5);
      const size = CLUMP_SIZES[0] + (CLUMP_SIZES[1] - CLUMP_SIZES[0]) * h0;
      hash(cx, cy, 4);
      const dx = (ax - cx - (1 - JITTER) / 2 - JITTER * h0) / size;
      const dy = (ay - cy - (1 - JITTER) / 2 - JITTER * h1) / size;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < near) (near = d), (tx = dx), (ty = dy);
    }
  }
  noise(x / LEAF + s0 * 31, y / LEAF + s1 * 31);
  const r = Math.sqrt(x * x + y * y) + LUMP * (near - 0.25) + (n0 - 0.5) * FRINGE;
  const deep = Math.min(1, Math.max(0, (near - HOLLOW_FROM) / (0.75 - HOLLOW_FROM) + (n1 - 0.5) * 0.4));
  facet(x / SHARD + s1 * 53, y / SHARD + s0 * 53);
  out[k] = byte(r / 2);
  out[k + 1] = byte(0.5 + (tx * CLUMP_TILT + l0 * FACET_TILT + f0 * SHARD_TILT) / 2);
  out[k + 2] = byte(0.5 + (ty * CLUMP_TILT + l1 * FACET_TILT + f1 * SHARD_TILT) / 2);
  out[k + 3] = byte((1 - deep * deep * (3 - 2 * deep)) * LIT);
}

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
const TIERS = 8;
/** A conifer is drawn in this many layers, a band of its tiers each, the
 *  top first (`trees.ts` stacks them), so its upper arms stand over its
 *  lower and shade them. */
export const CONIFER_LAYERS = 3;
const bandOf = (layer: number) => [Math.floor((layer * TIERS) / CONIFER_LAYERS), Math.floor(((layer + 1) * TIERS) / CONIFER_LAYERS)];
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
export const LAYER_REACH = Array.from({ length: CONIFER_LAYERS }, (_, layer) => Math.min(1, (bandOf(layer)[1] / TIERS) * (1 + ARM_REACH)));

/** A texel of a layer of conifer v at (x, y), of its radius, into out at k. */
function conifer(out: Uint8Array, k: number, x: number, y: number, v: number, layer: number) {
  const rho = Math.sqrt(x * x + y * y);
  const theta = Math.atan2(y, x);
  const [first, last] = bandOf(layer);
  for (let t = first; t < last; t++) {
    hash(v, t, 7);
    const arms = Math.round(ARMS[0] + (ARMS[1] - ARMS[0]) * h0);
    const u = (theta / (2 * Math.PI)) * arms + h1;
    const arm = Math.floor(u + 0.5);
    hash(((arm % arms) + arms) % arms, t * 31 + v, 8);
    const turned = ((u - arm - (h1 - 0.5) * ARM_TURN) * 2 * Math.PI) / arms;
    const reach = ((t + 1) / TIERS) * (1 - ARM_REACH + 2 * ARM_REACH * h0);
    const along = rho * Math.cos(turned), across = rho * Math.sin(turned);
    const width = (ARM_FOOT * Math.sqrt(Math.max(0, 1 - along / reach)) + ARM_TIP) * Math.min(1, (1 - along / reach) * 4);
    if (along < 0 || along > reach || Math.abs(across) > width) continue;
    // On the twig, or on a needle off it; else a gap, and what is under it shows.
    const out_ = Math.abs(across);
    const row = (along - out_ * SWEEP) / ROW;
    hash(Math.floor(row), (across > 0 ? 1 : 2) + t * 7 + v * 131, 9);
    const needle = out_ > TWIG;
    if (needle && (row - Math.floor(row) > NEEDLED || out_ > width * (ROW_REACH + (1 - ROW_REACH) * h0))) continue;
    hash(((arm % arms) + arms) % arms, t * 31 + v, 8);
    // Its arm, seen: which way the arm runs and its side, and how far out on it.
    const [ax, ay] = [Math.cos(theta - turned), Math.sin(theta - turned)];
    // Round, as a log is across: flat along its top, rolling over at its sides.
    const s = across / width;
    const side = needle ? Math.sign(across) * SPLAY : (s / Math.sqrt(Math.max(1 - s * s, 0.08))) * RIDGE;
    const down = DROOP * (along / reach);
    facet(x / NEEDLE + h0 * 41, y / NEEDLE + h1 * 41);
    out[k] = byte(rho / 2);
    out[k + 1] = byte(0.5 + (ax * down - ay * side + f0 * NEEDLE_TILT) / 2);
    out[k + 2] = byte(0.5 + (ay * down + ax * side + f1 * NEEDLE_TILT) / 2);
    out[k + 3] = needle ? byte((1 - (UNDER * t) / (TIERS - 1)) * LIT) : 255;
    return;
  }
  out[k] = 255;
}

/** Every crown, a texel each: how far out it is, of the radius its outline
 *  stands at (red, halved), which way it tilts (green and blue, from -1
 *  to 1), and how much light reaches down to it (alpha, up to `LIT`), or
 *  that it is twig, not leaf (alpha past it). */
export const STAMPS = CROWNS + CONIFERS * CONIFER_LAYERS;
export const ROWS = Math.ceil(STAMPS / COLUMNS);
export function bakeCrowns(): Uint8Array {
  const out = new Uint8Array(COLUMNS * ROWS * CROWN_TEXELS * CROWN_TEXELS * 4);
  const wide = COLUMNS * CROWN_TEXELS;
  // A stamp's texel: stamps run broadleaves, then conifers' layers top down.
  const at = (stamp: number, i: number, j: number) => ((Math.floor(stamp / COLUMNS) * CROWN_TEXELS + j) * wide + (stamp % COLUMNS) * CROWN_TEXELS + i) * 4;
  const each = (texel: (x: number, y: number, i: number, j: number) => void) => {
    for (let j = 0; j < CROWN_TEXELS; j++) {
      for (let i = 0; i < CROWN_TEXELS; i++) {
        texel(((i + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, ((j + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, i, j);
      }
    }
  };
  for (let v = 0; v < CROWNS; v++) {
    hash(v, 0, 3);
    const s0 = h0, s1 = h1;
    each((x, y, i, j) => broad(out, at(v, i, j), x, y, s0, s1));
  }
  for (let layer = 0; layer < CONIFER_LAYERS; layer++) {
    for (let v = 0; v < CONIFERS; v++) each((x, y, i, j) => conifer(out, at(CROWNS + layer * CONIFERS + v, i, j), x, y, v, layer));
  }
  return out;
}
