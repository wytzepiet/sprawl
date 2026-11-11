/**
 * The broadleaves' crowns, grown (`trees.ts` draws them): a few, each a
 * tree grown limb by limb and leaf by leaf, handed on as shapes for the
 * GPU to lay down (`broadleaves.ts`). On its own, for a worker to grow
 * (`bakeWorker.ts`).
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
const LEAN_TRUNK = 0.35;
const FORK_TOP = -0.45;
const SCAFFOLD = [4, 6];
const FORK_LOW = 0.6;
const SCAFFOLD_OUT = [0.4, 0.65];
const CROOK = 0.3;
const SUB_CROWN = [0.38, 0.52];
const SUB_RISE = [-0.2, 0.15];
const SUB_TALL = 0.8;
/** And each tree its own habit: its limbs reaching out up to this much
 *  further or nearer, and rising as much less or more. */
const HABIT = 0.3;
const ROOM = 1800;
const STEP = 0.045;
const SEES = 0.4;
const SKYWARD = 0.15;
const TAKEN = 0.09;
const FORKS = 3;
/** A branch is as thick as those it carries together (Leonardo's rule, by
 *  this power): a twig this thick, of the crown's radius. */
const LEONARDO = 2.2;
const TWIG_THICK = 0.004;
/** Leaves grow on the youngest wood only, on twigs no thicker than this
 *  many twigs make, and only out in the crown's shell, past this far of the
 *  way to its edge: inside, it is too dark for them. So many leaves that
 *  they cover the ground under it this many times over; each this long, of
 *  the crown's radius, and so wide, up to this far off its twig. */
const LEAF_WOOD = 4;
const SHELL = 0.4;
const COVER = 5;
const LEAF = 0.025;
const LEAF_WIDE = 0.6;
const STALK = 0.045;
/** A leaf lies tilted at random up to this much (1 at 45°). */
export const LEAF_TILT = 0.9;
/** Seen from the side, its crown's foot this high, of its height. */
const SIDE_FOOT = 0.45;

/** This many broadleaves, each this many texels across in the crowns'
 *  texture, over this far out of its radius (past 1, so a crown's edge
 *  never reaches its neighbour's). Every tree wears one, turned its own
 *  way, by where it stands. */
export const CROWNS = 8;
export const CROWN_TEXELS = 384;
export const CROWN_REACH = 1.1;

/** A number from 0 to 1 for a cell, and for each use of it its own. */
function hash(x: number, y: number, use: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(use, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
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
  const rnd = () => hash(v, n++, 11);
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
  // Its habit: spreading and low, or narrow and tall.
  const spread = 1 + HABIT * (rnd() * 2 - 1);
  const count = SCAFFOLD[0] + Math.floor(rnd() * (SCAFFOLD[1] - SCAFFOLD[0] + 1));
  const domes: number[] = [];
  const turn = rnd() * 2 * Math.PI;
  for (let l = 0; l < count; l++) {
    const top = l === count - 1;
    const foot = trunk[Math.floor(trunk.length * (top ? 1 : FORK_LOW + (1 - FORK_LOW) * rnd())) - (top ? 1 : 0)];
    const az = turn + (2 * Math.PI * (l + 0.5 * (rnd() - 0.5))) / (count - 1);
    const out = top ? 0.1 * rnd() : (SCAFFOLD_OUT[0] + (SCAFFOLD_OUT[1] - SCAFFOLD_OUT[0]) * rnd()) * spread;
    const r = SUB_CROWN[0] + (SUB_CROWN[1] - SUB_CROWN[0]) * rnd();
    const [x, y, z] = [Math.cos(az) * out, Math.sin(az) * out, (top ? SUB_RISE[1] : SUB_RISE[0] + (SUB_RISE[1] - SUB_RISE[0]) * rnd()) / spread - r * 0.3];
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

/** A shape of a crown, as the GPU lays it (`broadleaves.ts`), in the
 *  texture's texels, twelve numbers: a leaf (where, how high, which way
 *  it points, how wide across and how long, 0, its tilt, and how much
 *  that tilt lifts it a texel) or a limb (from where and how high to
 *  where and how high, how thick, 1). */

/** Broadleaf v's shapes, into out: grown, its leaves and limbs seen from
 *  above, in layers (`trees.ts` stacks them), a leaf's layer by how high
 *  it is among the rest, so each has its share; and from the side, for
 *  its shadow (`trees.ts`' card), under them: across as from above, and
 *  up from the ground (0) to its top (1), its crown's foot at SIDE_FOOT. */
function broad(out: number[], v: number) {
  const { leaves, limbs } = grow(v);
  let reach = 0, low = 9, high = -9;
  for (let l = 0; l < leaves.length; l += 7) {
    reach = Math.max(reach, Math.hypot(leaves[l], leaves[l + 1]) + LEAF);
    (low = Math.min(low, leaves[l + 2])), (high = Math.max(high, leaves[l + 2]));
  }
  // Of the crown: across, its radius 1 a little in from its outline; up, its foot 0 and its top 1.
  const s = 0.95 / reach;
  const up = (z: number) => (z - low) / (high - low);
  const T = CROWN_TEXELS;
  const texel = (u: number) => ((u * s + CROWN_REACH) / (2 * CROWN_REACH)) * T;
  const x = (u: number) => v * T + texel(u);
  const tall = (z: number) => (z < low ? (SIDE_FOOT * (z + TRUNK_FOOT)) / (low + TRUNK_FOOT) : SIDE_FOOT + (1 - SIDE_FOOT) * up(z));
  const row = (z: number) => (BROAD_LAYERS + 1 - tall(z)) * T;
  const count = leaves.length / 7;
  const order = Array.from({ length: count }, (_, l) => l).sort((a, b) => leaves[b * 7 + 2] - leaves[a * 7 + 2]);
  const layerOf = new Uint8Array(count);
  order.forEach((l, rank) => (layerOf[l] = Math.floor((rank / count) * BROAD_LAYERS)));
  const lt = texel(LEAF) - texel(0), lr = (LEAF * (1 - SIDE_FOOT) * T) / (high - low);
  const lift = (2 * CROWN_REACH) / T / ((high - low) * s);
  for (let l = 0; l < count; l++) {
    const [lx, ly, lz, ox, oy, tx, ty] = leaves.slice(l * 7, l * 7 + 7);
    out.push(x(lx), layerOf[l] * T + texel(ly), up(lz), ox, oy, lt * LEAF_WIDE, lt, 0, tx, ty, lift, 0);
    out.push(x(lx), row(lz), 1, 1, 0, lr, lt, 0, 0, 0, 0, 0);
  }
  for (let b = 0; b < limbs.length; b += 7) {
    const [x0, y0, z0, x1, y1, z1, thick] = limbs.slice(b, b + 7);
    const rt = Math.max(0.6, texel(thick) - texel(0));
    const layer = Math.min(BROAD_LAYERS - 1, Math.max(0, Math.floor((1 - up((z0 + z1) / 2)) * BROAD_LAYERS))) * T;
    out.push(x(x0), layer + texel(y0), up(z0), x(x1), layer + texel(y1), up(z1), rt, 1, 0, 0, 0, 0);
    out.push(x(x0), row(z0), 1, x(x1), row(z1), 1, rt, 1, 0, 0, 0, 0);
  }
}

/** Every broadleaf's shapes, as bytes: the crowns'
 *  texture is a tree a column, its layers down it, top first, then its
 *  side. */
export const ROWS = BROAD_LAYERS + 1;
export function bakeCrowns(): Uint8Array {
  const out: number[] = [];
  for (let v = 0; v < CROWNS; v++) broad(out, v);
  return new Uint8Array(new Float32Array(out).buffer);
}
