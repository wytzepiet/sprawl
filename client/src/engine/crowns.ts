/**
 * The trees' crowns, baked (`trees.ts` draws them): a few, each a tree's
 * crown seen from above, in texels. On its own, for a worker to bake
 * (`bakeWorker.ts`): two million texels take a second and more.
 */

/** A broadleaf is grown as an oak grows: a trunk this long (from its
 *  crown's middle down), leaning up to this far, forking from this high,
 *  into this many great limbs, give or take, the lowest off it this far up
 *  its forking stretch; each limb out this far, crooked by up to this much,
 *  to a crown of its own, this big, its middle this high, as tall as this
 *  of its width; the last limb is the leader, up the middle. Then the rest
 *  by space colonisation: its buds reach for the light, and light is room,
 *  this many points of it scattered through those crowns; each step every
 *  bud grows this far, toward the room it is the nearest bud to within
 *  this far, tipped up toward the sky this much; room a bud comes this
 *  near is taken, and a bud forks at most this many ways. So each limb
 *  fills its own crown, a tree on the tree, and they crowd each other. */
const TRUNK_FOOT = 1.1;
const LEAN_TRUNK = 0.25;
const FORK_TOP = -0.45;
const SCAFFOLD = [4, 6];
const FORK_LOW = 0.6;
const SCAFFOLD_OUT = [0.4, 0.65];
const CROOK = 0.3;
const SUB_CROWN = [0.38, 0.52];
const SUB_RISE = [-0.2, 0.15];
const SUB_TALL = 0.8;
const ROOM = 1800;
const STEP = 0.045;
const SEES = 0.4;
const SKYWARD = 0.15;
const TAKEN = 0.09;
const FORKS = 3;
/** A branch is as thick as those it carries together (Leonardo's rule, by
 *  this power): a twig this thick, of the crown's radius. */
const LEONARDO = 2.5;
const TWIG_THICK = 0.004;
/** Leaves grow on the youngest wood only, on twigs no thicker than this
 *  many twigs make, and only out in the crown's shell, past this far of the
 *  way to its edge: inside, it is too dark for them. So many leaves that
 *  they cover the ground under it this many times over; each this long, of
 *  the crown's radius, and so wide, up to this far off its twig. */
const LEAF_WOOD = 4;
const SHELL = 0.4;
const COVER = 5;
const LEAF = 0.035;
const LEAF_WIDE = 0.6;
const STALK = 0.05;
/** A leaf lies tilted at random up to this much (1 at 45°). The light
 *  reaches down less: at the crown's foot this much of what its top gets;
 *  and under the crown's skin, a dome over its highest leaves this many
 *  texels round, it is dark, all of it this deep, of the crown's height. */
const LEAF_TILT = 0.9;
const FOOT_LIGHT = 0.5;
const SKIN = 10;
const DEEP = 0.25;
/** Seen from the side, its crown's foot this high, of its height. */
const SIDE_FOOT = 0.45;

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
const byte = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
/** The most light a leaf's alpha says; above it, a texel is twig. */
export const LIT = 0.8;

/** A broadleaf is drawn in layers, as a conifer is (`trees.ts` stacks
 *  them): its leaves shared among them by height, the highest in the top. */
export const BROAD_LAYERS = 4;

/** Broadleaf v grown: its leaves, (x, y, z, along x, along y, tilt x,
 *  tilt y) each, and its limbs, (from x, y, z, to x, y, z, thickness)
 *  each; its crown's middle at 0, 1 to its edge. */
function grow(v: number) {
  let n = 0;
  const rnd = () => (hash(v, n++, 11), h0);
  // Buds: where each is, and the bud it grew from; a run of them from a
  // bud to a point, crooked on the way.
  const at: number[] = [], from: number[] = [];
  const bud = (x: number, y: number, z: number, parent: number) => (at.push(x, y, z), from.push(parent), from.length - 1);
  const run = (b: number, x: number, y: number, z: number) => {
    const [x0, y0, z0] = at.slice(b * 3, b * 3 + 3);
    const [kx, ky, kz] = [(rnd() - 0.5) * CROOK, (rnd() - 0.5) * CROOK, (rnd() - 0.5) * CROOK * 0.5];
    const steps = Math.max(1, Math.round(Math.hypot(x - x0, y - y0, z - z0) / STEP));
    for (let s = 1; s <= steps; s++) {
      const [t, bend] = [s / steps, Math.sin((Math.PI * s) / steps)];
      b = bud(x0 + (x - x0) * t + kx * bend, y0 + (y - y0) * t + ky * bend, z0 + (z - z0) * t + kz * bend, b);
    }
    return b;
  };
  // The trunk, leaning a little, and its limbs off it at heights up its
  // top, each out to the middle of a crown of its own; the topmost the
  // leader, up the middle.
  const lean = [(rnd() - 0.5) * LEAN_TRUNK, (rnd() - 0.5) * LEAN_TRUNK];
  const trunk: number[] = [bud(0, 0, -TRUNK_FOOT, -1)];
  while (at[trunk[trunk.length - 1] * 3 + 2] < FORK_TOP) {
    const b = trunk[trunk.length - 1], t = (at[b * 3 + 2] + TRUNK_FOOT) / (FORK_TOP + TRUNK_FOOT);
    trunk.push(bud(lean[0] * t * t, lean[1] * t * t, at[b * 3 + 2] + STEP, b));
  }
  const count = SCAFFOLD[0] + Math.floor(rnd() * (SCAFFOLD[1] - SCAFFOLD[0] + 1));
  const domes: number[] = [];
  const turn = rnd() * 2 * Math.PI;
  for (let l = 0; l < count; l++) {
    const top = l === count - 1;
    const foot = trunk[Math.floor(trunk.length * (top ? 1 : FORK_LOW + (1 - FORK_LOW) * rnd())) - (top ? 1 : 0)];
    const az = turn + (2 * Math.PI * (l + 0.5 * (rnd() - 0.5))) / (count - 1);
    const out = top ? 0.1 * rnd() : SCAFFOLD_OUT[0] + (SCAFFOLD_OUT[1] - SCAFFOLD_OUT[0]) * rnd();
    const r = SUB_CROWN[0] + (SUB_CROWN[1] - SUB_CROWN[0]) * rnd();
    const [x, y, z] = [Math.cos(az) * out, Math.sin(az) * out, (top ? SUB_RISE[1] : SUB_RISE[0] + (SUB_RISE[1] - SUB_RISE[0]) * rnd()) - r * 0.3];
    run(foot, x, y, z);
    domes.push(x, y, z + r * 0.3, r);
  }
  // Room, through each limb's crown, as much as it is big.
  const room: number[] = [];
  const big = domes.reduce((sum, d, i) => sum + (i % 4 === 3 ? d ** 3 : 0), 0);
  for (let d = 0; d < domes.length; d += 4) {
    const [cx, cy, cz, r] = domes.slice(d, d + 4);
    for (let p = 0; p < Math.round((ROOM * r ** 3) / big); ) {
      const [x, y, z] = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
      if (x * x + y * y + z * z > 1 || z < -0.6) continue;
      room.push(cx + x * r, cy + y * r, cz + z * r * (z > 0 ? SUB_TALL : 0.6));
      p++;
    }
  }
  const points = room.length / 3;
  /** How far out in its own crown a point is, 1 at its edge. */
  const shell = (x: number, y: number, z: number) => {
    let out = 9;
    for (let d = 0; d < domes.length; d += 4) {
      const dz = z - domes[d + 2];
      out = Math.min(out, Math.hypot(x - domes[d], y - domes[d + 1], dz / (dz > 0 ? SUB_TALL : 0.6)) / domes[d + 3]);
    }
    return out;
  };
  const forks = new Uint8Array(points * 12);
  // Each point of room's nearest bud, and how near.
  const nearest = new Int32Array(points).fill(-1), near = new Float32Array(points).fill(SEES);
  const free = new Uint8Array(points).fill(1);
  const see = (first: number) => {
    for (let p = 0; p < points; p++) {
      if (!free[p]) continue;
      for (let b = first; b < from.length; b++) {
        const d = Math.hypot(room[p * 3] - at[b * 3], room[p * 3 + 1] - at[b * 3 + 1], room[p * 3 + 2] - at[b * 3 + 2]);
        if (d < TAKEN) free[p] = 0;
        else if (d < near[p]) (near[p] = d), (nearest[p] = b);
      }
    }
  };
  see(0);
  for (let grown = 1; grown > 0 && from.length < points * 12; ) {
    const pull = new Map<number, number[]>();
    for (let p = 0; p < points; p++) {
      const b = nearest[p];
      if (!free[p] || b < 0) continue;
      const d = near[p];
      const w = pull.get(b) ?? [0, 0, 0];
      (w[0] += (room[p * 3] - at[b * 3]) / d), (w[1] += (room[p * 3 + 1] - at[b * 3 + 1]) / d), (w[2] += (room[p * 3 + 2] - at[b * 3 + 2]) / d);
      pull.set(b, w);
    }
    const first = from.length;
    for (const [b, [x, y, z]] of pull) {
      // Pulled two ways evenly, a bud would grow a twig back into itself
      // forever: a bud forks at most this many ways.
      if (forks[b]++ >= FORKS) continue;
      const l = Math.hypot(x, y, z + SKYWARD) || 1;
      const [dx, dy, dz] = [x / l, y / l, (z + SKYWARD) / l];
      bud(at[b * 3] + dx * STEP, at[b * 3 + 1] + dy * STEP, at[b * 3 + 2] + dz * STEP, b);
    }
    grown = from.length - first;
    see(first);
  }
  // Thickness, from the twigs in: each bud as thick as all it carries.
  const carries = new Float32Array(from.length);
  for (let b = from.length - 1; b > 0; b--) {
    carries[b] += carries[b] === 0 ? TWIG_THICK ** LEONARDO : 0;
    carries[from[b]] += carries[b];
  }
  const limbs: number[] = [], leaves: number[] = [];
  const leafy: number[] = [];
  for (let b = 1; b < from.length; b++) {
    const p = from[b];
    limbs.push(at[p * 3], at[p * 3 + 1], at[p * 3 + 2], at[b * 3], at[b * 3 + 1], at[b * 3 + 2], carries[b] ** (1 / LEONARDO));
    if (carries[b] <= LEAF_WOOD * TWIG_THICK ** LEONARDO && shell(at[b * 3], at[b * 3 + 1], at[b * 3 + 2]) > SHELL) leafy.push(b);
  }
  // Enough leaves to cover the ground under the crown COVER times over.
  const each = Math.ceil((COVER * Math.PI) / (Math.PI * LEAF * LEAF * LEAF_WIDE) / Math.max(1, leafy.length));
  for (const b of leafy) {
    for (let l = 0; l < each; l++) {
      const a = rnd() * 2 * Math.PI, stalk = STALK * Math.sqrt(rnd());
      const [ox, oy] = [Math.cos(a), Math.sin(a)];
      leaves.push(at[b * 3] + ox * stalk, at[b * 3 + 1] + oy * stalk, at[b * 3 + 2] + STALK * (rnd() - 0.4), ox, oy, (rnd() * 2 - 1) * LEAF_TILT, (rnd() * 2 - 1) * LEAF_TILT);
    }
  }
  return { leaves, limbs };
}

/** Broadleaf v's layers, seen from above: grown, its leaves and limbs laid
 *  down a texel at a time, in each layer the highest there showing; the
 *  light less the lower it is, and the deeper under the crown's skin.
 *  Into stamp(layer), and its side into stamp(BROAD_LAYERS). */
function broad(out: Uint8Array, stamp: (layer: number, i: number, j: number) => number, v: number) {
  const { leaves, limbs } = grow(v);
  let reach = 0, low = 9, high = -9;
  for (let l = 0; l < leaves.length; l += 7) {
    reach = Math.max(reach, Math.hypot(leaves[l], leaves[l + 1]) + LEAF);
    (low = Math.min(low, leaves[l + 2])), (high = Math.max(high, leaves[l + 2]));
  }
  // Of the crown: across, its radius 1 a little in from its outline; up, its foot 0 and its top 1.
  const s = 0.95 / reach;
  const up = (z: number) => (z - low) / (high - low);
  const texel = (u: number) => ((u * s + CROWN_REACH) / (2 * CROWN_REACH)) * CROWN_TEXELS;
  const T = CROWN_TEXELS, N = T * T;
  const height = new Float32Array(BROAD_LAYERS * N).fill(-1), lean = new Float32Array(BROAD_LAYERS * N * 2), bark = new Uint8Array(BROAD_LAYERS * N);
  // A leaf's layer by how high it is among the rest, so each has its share.
  const count = leaves.length / 7;
  const order = Array.from({ length: count }, (_, l) => l).sort((a, b) => leaves[b * 7 + 2] - leaves[a * 7 + 2]);
  const layerOf = new Uint8Array(count);
  order.forEach((l, rank) => (layerOf[l] = Math.floor((rank / count) * BROAD_LAYERS)));
  const lt = texel(LEAF) - texel(0), rise = (high - low) * s;
  for (let l = 0; l < count; l++) {
    const [cx, cy, cz, ox, oy, tx, ty] = [texel(leaves[l * 7]), texel(leaves[l * 7 + 1]), up(leaves[l * 7 + 2]), leaves[l * 7 + 3], leaves[l * 7 + 4], leaves[l * 7 + 5], leaves[l * 7 + 6]];
    const base = layerOf[l] * N;
    for (let j = Math.max(0, Math.floor(cy - lt)); j < Math.min(T, Math.ceil(cy + lt)); j++) {
      for (let i = Math.max(0, Math.floor(cx - lt)); i < Math.min(T, Math.ceil(cx + lt)); i++) {
        const [dx, dy] = [i + 0.5 - cx, j + 0.5 - cy];
        // A leaf: pointed, along its stalk's way.
        const [a, b] = [(dx * ox + dy * oy) / lt, (dy * ox - dx * oy) / (lt * LEAF_WIDE)];
        if (a * a + b * b > 1 - Math.abs(a) * 0.5) continue;
        const k = base + j * T + i;
        const h = cz - ((tx * dx + ty * dy) * 2 * CROWN_REACH) / T / rise;
        if (h <= height[k]) continue;
        (height[k] = h), (lean[2 * k] = tx), (lean[2 * k + 1] = ty), (bark[k] = 0);
      }
    }
  }
  for (let b = 0; b < limbs.length; b += 7) {
    const [x0, y0, z0, x1, y1, z1] = [texel(limbs[b]), texel(limbs[b + 1]), limbs[b + 2], texel(limbs[b + 3]), texel(limbs[b + 4]), limbs[b + 5]];
    const rt = Math.max(0.6, texel(limbs[b + 6]) - texel(0));
    const base = Math.min(BROAD_LAYERS - 1, Math.max(0, Math.floor((1 - up((z0 + z1) / 2)) * BROAD_LAYERS))) * N;
    const [ex, ey] = [x1 - x0, y1 - y0];
    const e2 = Math.max(ex * ex + ey * ey, 1e-6);
    for (let j = Math.max(0, Math.floor(Math.min(y0, y1) - rt)); j < Math.min(T, Math.ceil(Math.max(y0, y1) + rt)); j++) {
      for (let i = Math.max(0, Math.floor(Math.min(x0, x1) - rt)); i < Math.min(T, Math.ceil(Math.max(x0, x1) + rt)); i++) {
        const t = Math.min(1, Math.max(0, ((i + 0.5 - x0) * ex + (j + 0.5 - y0) * ey) / e2));
        const [qx, qy] = [i + 0.5 - x0 - ex * t, j + 0.5 - y0 - ey * t];
        if (qx * qx + qy * qy > rt * rt) continue;
        const k = base + j * T + i, h = up(z0 + (z1 - z0) * t);
        if (h <= height[k]) continue;
        (height[k] = h), (lean[2 * k] = (qx / rt) * 0.6), (lean[2 * k + 1] = (qy / rt) * 0.6), (bark[k] = 1);
      }
    }
  }
  // The crown's skin: its highest leaf near each texel, smoothed.
  const top = new Float32Array(N).fill(0);
  for (let k = 0; k < N; k++) for (let l = 0; l < BROAD_LAYERS; l++) top[k] = Math.max(top[k], height[l * N + k]);
  const skin = new Float32Array(N), pass = new Float32Array(N);
  for (let j = 0; j < T; j++) {
    for (let i = 0; i < T; i++) {
      let m = 0;
      for (let d = Math.max(0, i - SKIN); d <= Math.min(T - 1, i + SKIN); d++) m = Math.max(m, top[j * T + d] - ((d - i) / SKIN) ** 2 * DEEP);
      pass[j * T + i] = m;
    }
  }
  for (let j = 0; j < T; j++) {
    for (let i = 0; i < T; i++) {
      let m = 0;
      for (let d = Math.max(0, j - SKIN); d <= Math.min(T - 1, j + SKIN); d++) m = Math.max(m, pass[d * T + i] - ((d - j) / SKIN) ** 2 * DEEP);
      skin[j * T + i] = m;
    }
  }
  for (let layer = 0; layer < BROAD_LAYERS; layer++) {
    for (let j = 0, k = 0; j < T; j++) {
      for (let i = 0; i < T; i++, k++) {
        const o = stamp(layer, i, j), h = height[layer * N + k];
        if (h < 0) {
          out[o] = 255;
          continue;
        }
        const [x, y] = [((i + 0.5) / T) * 2 * CROWN_REACH - CROWN_REACH, ((j + 0.5) / T) * 2 * CROWN_REACH - CROWN_REACH];
        const under = Math.min(1, Math.max(0, (skin[k] - h) / DEEP));
        out[o] = byte(Math.hypot(x, y) / 2);
        out[o + 1] = byte(0.5 + lean[2 * (layer * N + k)] / 2);
        out[o + 2] = byte(0.5 + lean[2 * (layer * N + k) + 1] / 2);
        out[o + 3] = bark[layer * N + k] ? 255 : byte((FOOT_LIGHT + (1 - FOOT_LIGHT) * Math.max(0, h)) * (1 - under) * LIT);
      }
    }
  }
  // And from the side, for its shadow (`trees.ts`' card): what of it covers,
  // across as from above, and up from the ground (0) to its top (1), its
  // crown's foot at SIDE_FOOT.
  const tall = (z: number) => (z < low ? (SIDE_FOOT * (z + TRUNK_FOOT)) / (low + TRUNK_FOOT) : SIDE_FOOT + (1 - SIDE_FOOT) * up(z));
  const row = (z: number) => (1 - tall(z)) * T;
  const side = new Uint8Array(N);
  const lr = (LEAF * (1 - SIDE_FOOT) * T) / (high - low);
  for (let l = 0; l < count; l++) {
    const [cx, cy] = [texel(leaves[l * 7]), row(leaves[l * 7 + 2])];
    for (let j = Math.max(0, Math.floor(cy - lr)); j < Math.min(T, Math.ceil(cy + lr)); j++) {
      for (let i = Math.max(0, Math.floor(cx - lt)); i < Math.min(T, Math.ceil(cx + lt)); i++) {
        if (((i + 0.5 - cx) / lt) ** 2 + ((j + 0.5 - cy) / lr) ** 2 < 1) side[j * T + i] = 1;
      }
    }
  }
  for (let b = 0; b < limbs.length; b += 7) {
    const [x0, y0, x1, y1] = [texel(limbs[b]), row(limbs[b + 2]), texel(limbs[b + 3]), row(limbs[b + 5])];
    const rt = Math.max(0.6, texel(limbs[b + 6]) - texel(0));
    const [ex, ey] = [x1 - x0, y1 - y0];
    const e2 = Math.max(ex * ex + ey * ey, 1e-6);
    for (let j = Math.max(0, Math.floor(Math.min(y0, y1) - rt)); j < Math.min(T, Math.ceil(Math.max(y0, y1) + rt)); j++) {
      for (let i = Math.max(0, Math.floor(Math.min(x0, x1) - rt)); i < Math.min(T, Math.ceil(Math.max(x0, x1) + rt)); i++) {
        const t = Math.min(1, Math.max(0, ((i + 0.5 - x0) * ex + (j + 0.5 - y0) * ey) / e2));
        if ((i + 0.5 - x0 - ex * t) ** 2 + (j + 0.5 - y0 - ey * t) ** 2 < rt * rt) side[j * T + i] = 1;
      }
    }
  }
  for (let j = 0, k = 0; j < T; j++) for (let i = 0; i < T; i++, k++) out[stamp(BROAD_LAYERS, i, j)] = side[k] ? 0 : 255;
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
export const SIDES = CROWNS * BROAD_LAYERS + CONIFERS * CONIFER_LAYERS;
export const STAMPS = SIDES + CROWNS;
export const ROWS = Math.ceil(STAMPS / COLUMNS);
export function bakeCrowns(): Uint8Array {
  const out = new Uint8Array(COLUMNS * ROWS * CROWN_TEXELS * CROWN_TEXELS * 4);
  const wide = COLUMNS * CROWN_TEXELS;
  // A stamp's texel: stamps run broadleaves' layers, then conifers', top
  // down, then broadleaves' sides.
  const at = (stamp: number, i: number, j: number) => ((Math.floor(stamp / COLUMNS) * CROWN_TEXELS + j) * wide + (stamp % COLUMNS) * CROWN_TEXELS + i) * 4;
  const each = (texel: (x: number, y: number, i: number, j: number) => void) => {
    for (let j = 0; j < CROWN_TEXELS; j++) {
      for (let i = 0; i < CROWN_TEXELS; i++) {
        texel(((i + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, ((j + 0.5) / CROWN_TEXELS) * 2 * CROWN_REACH - CROWN_REACH, i, j);
      }
    }
  };
  for (let v = 0; v < CROWNS; v++) broad(out, (layer, i, j) => at(layer < BROAD_LAYERS ? layer * CROWNS + v : SIDES + v, i, j), v);
  for (let layer = 0; layer < CONIFER_LAYERS; layer++) {
    for (let v = 0; v < CONIFERS; v++) each((x, y, i, j) => conifer(out, at(CROWNS * BROAD_LAYERS + layer * CONIFERS + v, i, j), x, y, v, layer));
  }
  return out;
}
