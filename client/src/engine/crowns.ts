/**
 * The trees' crowns, baked (`trees.ts` draws them): a few, each a tree's
 * crown seen from above, in texels. On its own, for a worker to bake
 * (`bakeWorker.ts`): two million texels take a second and more.
 */

/** A broadleaf is a tree grown, as one is: from its trunk's top this many
 *  limbs, give or take one, rising this steeply (from level, in turns), as
 *  long as this of its height; each forking into this many, give or take
 *  one, from this far along it, turned off it up to this far (in turns),
 *  bending up toward the light this much, each this much as long as the
 *  one it grows from and as thick; so many times, and the last carry the
 *  leaves, in clumps this big, of the crown's height, this many along each,
 *  scattered this far off it. So a crown is clumps of clumps of clumps,
 *  as its limbs fork, and between them it is dark, or open to the branches. */
const LIMBS = 6;
const RISE = [0.08, 0.2];
const LIMB = 0.42;
const FORKS = 2.3;
const FORK_FROM = 0.55;
const FORK_TURN = 0.11;
const TOWARD_LIGHT = 0.35;
const SHORTER = 0.72;
const THINNER = 0.62;
const FORKINGS = 4;
const LIMB_THICK = 0.035;
const CLUMP = [0.07, 0.11];
const CLUMPS = 3;
const SCATTER = 0.07;
/** And it grows only so far out, this far of a limb's length, give or
 *  take this much, no leaves past that, nor limbs: a crown is round,
 *  its limbs crowding each other in. */
const SPREAD = 1.4;
const SPREAD_GIVE = 0.2;
/** Its leaves fray a clump's outline this much, in leaves this wide, of the
 *  crown's radius, and catch the light each its own way: flat facets this
 *  wide, and shards this wide on them, each tilted at random up to this
 *  far, so the light breaks from leaf to leaf. A clump rolls over this
 *  steeply at its edge. */
const FRAY = 0.35;
const LEAF = 1 / 40;
const FACET = 1 / 40;
const SHARD = 1 / 80;
const FACET_TILT = 0.4;
const SHARD_TILT = 0.24;
const CLUMP_TILT = 1.3;
/** The light reaches down less: at the crown's foot this much of what its
 *  top gets, and less again this much under each layer over it. */
const FOOT_LIGHT = 0.45;
const SHADED = 0.12;

/** Crowns are baked, not worked out pixel by pixel: this many broadleaves,
 *  then the
 *  conifers' (`CONIFERS`), a layer of each at a time, each this
 *  many texels across, over this far out of its radius (past 1, so a
 *  crown's edge never reaches its neighbour's), so many to a row of one
 *  texture. Every tree wears one, turned its own way, by where it stands. */
export const CROWNS = 8;
export const CROWN_TEXELS = 384;
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
let n0 = 0;
/** Smooth noise, in n0. */
function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = (x - ix) * (x - ix) * (3 - 2 * (x - ix)), ty = (y - iy) * (y - iy) * (3 - 2 * (y - iy));
  hash(ix, iy, 0);
  const a = h0;
  hash(ix + 1, iy, 0);
  const b = a + (h0 - a) * tx;
  hash(ix, iy + 1, 0);
  const c = h0;
  hash(ix + 1, iy + 1, 0);
  n0 = b + (c + (h0 - c) * tx - b) * ty;
}

const byte = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
/** The most light a leaf's alpha says; above it, a texel is twig. */
export const LIT = 0.8;

/** A broadleaf is drawn in layers, as a conifer is (`trees.ts` stacks
 *  them): its clumps shared among them by height, the highest in the top. */
export const BROAD_LAYERS = 4;

/** Broadleaf v grown: its clumps, (x, y, z, radius) each, and its limbs,
 *  (from x, y, z, to x, y, z, thickness) each, its trunk's top at 0. */
function grow(v: number) {
  let n = 0;
  const rnd = () => (hash(v, n++, 11), h0);
  const clumps: number[] = [], limbs: number[] = [0, 0, -0.5, 0, 0, 0, LIMB_THICK * 1.3];
  const branch = (x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, thick: number, forkings: number) => {
    limbs.push(x, y, z, x + dx * len, y + dy * len, z + dz * len, thick);
    if (forkings <= 1) {
      for (let c = 0; c < CLUMPS; c++) {
        const t = 0.3 + 0.7 * rnd();
        clumps.push(x + dx * len * t + (rnd() * 2 - 1) * SCATTER, y + dy * len * t + (rnd() * 2 - 1) * SCATTER, z + dz * len * t + (rnd() * 2 - 1) * SCATTER, CLUMP[0] + (CLUMP[1] - CLUMP[0]) * rnd());
      }
      if (forkings === 0) return;
    }
    // Two ways across it, to turn its forks off it.
    const [ux, uy, uz] = Math.abs(dz) < 0.9 ? [-dy, dx, 0] : [1, 0, 0];
    const ul = Math.hypot(ux, uy, uz);
    const [px, py, pz] = [ux / ul, uy / ul, uz / ul];
    const [wx, wy, wz] = [dy * pz - dz * py, dz * px - dx * pz, dx * py - dy * px];
    const forks = Math.floor(FORKS + rnd());
    for (let f = 0; f < forks; f++) {
      const along = f === 0 ? 1 : FORK_FROM + (1 - FORK_FROM) * rnd();
      const a = rnd() * 2 * Math.PI, t = FORK_TURN * 2 * Math.PI * (0.5 + 0.5 * rnd());
      const [cx, cy, cz] = [Math.cos(a) * px + Math.sin(a) * wx, Math.cos(a) * py + Math.sin(a) * wy, Math.cos(a) * pz + Math.sin(a) * wz];
      let [ex, ey, ez] = [dx * Math.cos(t) + cx * Math.sin(t), dy * Math.cos(t) + cy * Math.sin(t), dz * Math.cos(t) + cz * Math.sin(t) + TOWARD_LIGHT];
      const el = Math.hypot(ex, ey, ez);
      [ex, ey, ez] = [ex / el, ey / el, ez / el];
      branch(x + dx * len * along, y + dy * len * along, z + dz * len * along, ex, ey, ez, len * SHORTER, thick * THINNER, forkings - 1);
    }
  };
  // And its leader, up the middle.
  branch(0, 0, 0, 0.1 * (rnd() - 0.5), 0.1 * (rnd() - 0.5), 1, LIMB * 0.6, LIMB_THICK, FORKINGS);
  const count = LIMBS - 1 + Math.floor(rnd() * 3);
  for (let l = 0; l < count; l++) {
    const az = (2 * Math.PI * (l + 0.6 * (rnd() - 0.5))) / count;
    const rise = 2 * Math.PI * (RISE[0] + (RISE[1] - RISE[0]) * rnd());
    branch(0, 0, -0.1 * rnd(), Math.cos(rise) * Math.cos(az), Math.cos(rise) * Math.sin(az), Math.sin(rise), LIMB * (0.8 + 0.4 * rnd()), LIMB_THICK, FORKINGS);
  }
  // Pruned round: past its reach no leaves, nor limbs.
  const kept = clumps.filter((_, i) => {
    const c = i - (i % 4);
    if (i % 4 === 0) hash(v, c, 12);
    return Math.hypot(clumps[c], clumps[c + 1]) + clumps[c + 3] < LIMB * SPREAD * (1 + SPREAD_GIVE * (h0 - 0.5));
  });
  const end = LIMB * SPREAD * 0.9;
  const inside = limbs.filter((_, i) => {
    const b = i - (i % 7);
    return Math.hypot(limbs[b], limbs[b + 1]) < end && Math.hypot(limbs[b + 3], limbs[b + 4]) < end;
  });
  return { clumps: kept, limbs: inside };
}

/** What every broadleaf's leaves share, a texel each: how far a leaf frays
 *  its clump's outline there, and which way it tilts. */
function leaves(at: (x: number, y: number) => void) {
  const fray = new Float32Array(CROWN_TEXELS * CROWN_TEXELS), tilt = new Float32Array(CROWN_TEXELS * CROWN_TEXELS * 2);
  for (let j = 0, k = 0; j < CROWN_TEXELS; j++) {
    for (let i = 0; i < CROWN_TEXELS; i++, k++) {
      at(i, j);
      const [x, y] = [ax, ay];
      noise(x / LEAF, y / LEAF);
      fray[k] = n0;
      facet(x / FACET, y / FACET);
      const [l0, l1] = [f0, f1];
      facet(x / SHARD + 53, y / SHARD + 53);
      tilt[2 * k] = l0 * FACET_TILT + f0 * SHARD_TILT;
      tilt[2 * k + 1] = l1 * FACET_TILT + f1 * SHARD_TILT;
    }
  }
  return { fray, tilt };
}
let ax = 0, ay = 0;

/** Broadleaf v's layers, seen from above: grown, its clumps and limbs laid
 *  down a texel at a time, in each layer the highest there showing; the
 *  light less the lower it is and the more layers over it. Into stamp(layer). */
function broad(out: Uint8Array, stamp: (layer: number, i: number, j: number) => number, v: number, shared: ReturnType<typeof leaves>) {
  const { clumps, limbs } = grow(v);
  let reach = 0, low = 9, high = -9;
  for (let c = 0; c < clumps.length; c += 4) {
    reach = Math.max(reach, Math.hypot(clumps[c], clumps[c + 1]) + clumps[c + 3]);
    (low = Math.min(low, clumps[c + 2] - clumps[c + 3])), (high = Math.max(high, clumps[c + 2] + clumps[c + 3]));
  }
  // Of the crown: across, its radius 1 a little in from its outline; up, its foot 0 and its top 1.
  const s = 0.95 / reach;
  const up = (z: number) => (z - low) / (high - low);
  const texel = (u: number) => ((u * s + CROWN_REACH) / (2 * CROWN_REACH)) * CROWN_TEXELS;
  const N = CROWN_TEXELS * CROWN_TEXELS;
  const height = new Float32Array(BROAD_LAYERS * N).fill(-1), lean = new Float32Array(BROAD_LAYERS * N * 2), bark = new Uint8Array(BROAD_LAYERS * N);
  // A clump's layer by how high it is among the rest, so each has its share.
  const order = Array.from({ length: clumps.length / 4 }, (_, c) => c).sort((a, b) => clumps[b * 4 + 2] - clumps[a * 4 + 2]);
  const layerOf = new Uint8Array(order.length);
  order.forEach((c, rank) => (layerOf[c] = Math.floor((rank / order.length) * BROAD_LAYERS)));
  for (let c = 0; c < order.length; c++) {
    const [cx, cy, cz, r] = [texel(clumps[c * 4]), texel(clumps[c * 4 + 1]), clumps[c * 4 + 2], clumps[c * 4 + 3]];
    const rt = texel(r) - texel(0), base = layerOf[c] * N;
    for (let j = Math.max(0, Math.floor(cy - rt)); j < Math.min(CROWN_TEXELS, Math.ceil(cy + rt)); j++) {
      for (let i = Math.max(0, Math.floor(cx - rt)); i < Math.min(CROWN_TEXELS, Math.ceil(cx + rt)); i++) {
        const k = j * CROWN_TEXELS + i;
        const [dx, dy] = [(i + 0.5 - cx) / rt, (j + 0.5 - cy) / rt];
        const d2 = dx * dx + dy * dy;
        if (d2 > 1 - FRAY * shared.fray[k]) continue;
        const h = up(cz + r * Math.sqrt(1 - d2));
        if (h <= height[base + k]) continue;
        height[base + k] = h;
        lean[2 * (base + k)] = dx * CLUMP_TILT + shared.tilt[2 * k];
        lean[2 * (base + k) + 1] = dy * CLUMP_TILT + shared.tilt[2 * k + 1];
        bark[base + k] = 0;
      }
    }
  }
  for (let b = 0; b < limbs.length; b += 7) {
    const [x0, y0, z0, x1, y1, z1] = [texel(limbs[b]), texel(limbs[b + 1]), limbs[b + 2], texel(limbs[b + 3]), texel(limbs[b + 4]), limbs[b + 5]];
    const rt = texel(limbs[b + 6]) - texel(0);
    const base = Math.min(BROAD_LAYERS - 1, Math.max(0, Math.floor((1 - up((z0 + z1) / 2)) * BROAD_LAYERS))) * N;
    const [ex, ey] = [x1 - x0, y1 - y0];
    const e2 = Math.max(ex * ex + ey * ey, 1e-6);
    for (let j = Math.max(0, Math.floor(Math.min(y0, y1) - rt)); j < Math.min(CROWN_TEXELS, Math.ceil(Math.max(y0, y1) + rt)); j++) {
      for (let i = Math.max(0, Math.floor(Math.min(x0, x1) - rt)); i < Math.min(CROWN_TEXELS, Math.ceil(Math.max(x0, x1) + rt)); i++) {
        const t = Math.min(1, Math.max(0, ((i + 0.5 - x0) * ex + (j + 0.5 - y0) * ey) / e2));
        const [qx, qy] = [i + 0.5 - x0 - ex * t, j + 0.5 - y0 - ey * t];
        if (qx * qx + qy * qy > rt * rt) continue;
        const k = j * CROWN_TEXELS + i, h = up(z0 + (z1 - z0) * t);
        if (h <= height[base + k]) continue;
        height[base + k] = h;
        lean[2 * (base + k)] = (qx / rt) * 0.6;
        lean[2 * (base + k) + 1] = (qy / rt) * 0.6;
        bark[base + k] = 1;
      }
    }
  }
  for (let layer = 0; layer < BROAD_LAYERS; layer++) {
    for (let j = 0, k = 0; j < CROWN_TEXELS; j++) {
      for (let i = 0; i < CROWN_TEXELS; i++, k++) {
        const o = stamp(layer, i, j), h = height[layer * N + k];
        if (h < 0) {
          out[o] = 255;
          continue;
        }
        let over = 0;
        for (let l = 0; l < layer; l++) over += height[l * N + k] >= 0 ? 1 : 0;
        const [x, y] = [((i + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, ((j + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH];
        out[o] = byte(Math.hypot(x, y) / 2);
        out[o + 1] = byte(0.5 + lean[2 * (layer * N + k)] / 2);
        out[o + 2] = byte(0.5 + lean[2 * (layer * N + k) + 1] / 2);
        out[o + 3] = bark[layer * N + k] ? 255 : byte((FOOT_LIGHT + (1 - FOOT_LIGHT) * Math.max(0, h)) * (1 - SHADED * over) * LIT);
      }
    }
  }
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
const TIERS = 12;
/** A conifer is drawn in this many layers, a band of its tiers each, the
 *  top first (`trees.ts` stacks them), so its upper arms stand over its
 *  lower and shade them; the bands the thinner the higher, to this power,
 *  where a tree is narrow and its stack shows most. */
export const CONIFER_LAYERS = 8;
const BANDING = 1.6;
const bound = (layer: number) => Math.max(layer, Math.round(TIERS * (layer / CONIFER_LAYERS) ** BANDING));
const bandOf = (layer: number) => [bound(layer), bound(layer + 1)];
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
export const STAMPS = CROWNS * BROAD_LAYERS + CONIFERS * CONIFER_LAYERS;
export const ROWS = Math.ceil(STAMPS / COLUMNS);
export function bakeCrowns(): Uint8Array {
  const out = new Uint8Array(COLUMNS * ROWS * CROWN_TEXELS * CROWN_TEXELS * 4);
  const wide = COLUMNS * CROWN_TEXELS;
  // A stamp's texel: stamps run broadleaves' layers, then conifers', top down.
  const at = (stamp: number, i: number, j: number) => ((Math.floor(stamp / COLUMNS) * CROWN_TEXELS + j) * wide + (stamp % COLUMNS) * CROWN_TEXELS + i) * 4;
  const each = (texel: (x: number, y: number, i: number, j: number) => void) => {
    for (let j = 0; j < CROWN_TEXELS; j++) {
      for (let i = 0; i < CROWN_TEXELS; i++) {
        texel(((i + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, ((j + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, i, j);
      }
    }
  };
  const shared = leaves((i, j) => ((ax = ((i + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH), (ay = ((j + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH)));
  for (let v = 0; v < CROWNS; v++) broad(out, (layer, i, j) => at(layer * CROWNS + v, i, j), v, shared);
  for (let layer = 0; layer < CONIFER_LAYERS; layer++) {
    for (let v = 0; v < CONIFERS; v++) each((x, y, i, j) => conifer(out, at(CROWNS * BROAD_LAYERS + layer * CONIFERS + v, i, j), x, y, v, layer));
  }
  return out;
}
