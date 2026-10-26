import type { Manifold } from "manifold-3d";
import { BARK_ALONG } from "../bark";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { add, BARK, barnX, barnY, box, f, FLECKS, golf, heap, hull, loose, LUMPS, placing, ribbed, scale, SPILL, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A sawmill, whole: the hall, its wing, its yard and all that stands in
 * it, one model on its plot, as `docs/style.md`'s board drew it. Its plot
 * two tiles across (x, -1 to 1) and four deep (y), the street at +y, the
 * woods behind at -y; its ground on z = 0.
 *
 * - At the back, the long hall: a pitched roof, its ridge along the
 *   street, four small gables along its back, clad in planks; a zinc
 *   lean-to on its left, and a zinc canopy along its front where the
 *   logs go in.
 * - Down the right, the wing: a barn, its gable end and its big door to
 *   the yard, a zinc lean-to down its side, the brick chimney behind.
 * - The yard's left half is wood chips: the water tower on its legs at
 *   the back, the conveyor up into the hall, sawdust heaped round its
 *   foot, three stacks of logs; a fence along the side.
 * - Its right half the lorries': the lane up to the wing's door, the
 *   bundles on their pad beside it (`pads.ts`), and across it the one
 *   dock (`Blueprint::docks`).
 *
 * Its finishes (`model.ts`): timber and brick, zinc, the logs' bark, the
 * chips heaped and the dust under them.
 */

const ROOF: RGB = [0.5, 0.35, 0.25];
const RIB: RGB = [0.42, 0.29, 0.21];
const WALL: RGB = [0.52, 0.34, 0.22];
const TRIM: RGB = [0.42, 0.27, 0.18];
const DOOR: RGB = [0.2, 0.24, 0.32];
const BRICK: RGB = [0.62, 0.3, 0.22];
const CHIPS: RGB = [0.84, 0.65, 0.42];
const SAWDUST: RGB = [0.68, 0.52, 0.34];
const BARKED: RGB = [0.56, 0.39, 0.24];
const END: RGB = [0.89, 0.76, 0.56];
const STEEL: RGB = [0.46, 0.48, 0.52];
const BELT: RGB = [0.27, 0.27, 0.28];
const TANK: RGB = [0.58, 0.42, 0.28];
const HOOP: RGB = [0.32, 0.33, 0.36];

/** Round a log: this many sides, smooth, its bark's map once round. */
const SIDES = 12;
let logs = 0;
/** A log `r` round and `l` long, its middle at `at`, lying along x or y:
 *  its bark, closed at its ends, and its ends' pale wood. */
const log = (at: V, r: number, l: number, along: "x" | "y"): { bark: MeshGeometry; ends: MeshGeometry } => {
  // Along, and the two ways round it, right-handed.
  const [a, s, z]: V[] = along === "x" ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[0, 1, 0], [-1, 0, 0], [0, 0, 1]];
  const round = (k: number): V => add(scale(s, Math.cos((2 * Math.PI * k) / SIDES)), scale(z, Math.sin((2 * Math.PI * k) / SIDES)));
  const from = (logs++ * 0.37) % 1;
  const bark: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let k = 0; k <= SIDES; k++)
    for (const e of [-1, 1]) {
      bark.positions.push(...add(add(at, scale(a, (e * l) / 2)), scale(round(k), r)));
      bark.normals.push(...round(k));
      bark.uvs!.push(k / SIDES, from + ((e + 1) * l) / 2 / BARK_ALONG);
    }
  for (let k = 0; k < SIDES; k++) bark.indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  const ends: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const cap = (into: MeshGeometry, e: number, rr: number, out: number) => {
    const base = into.positions.length / 3;
    const mid = add(at, scale(a, e * (l / 2 + out)));
    for (const p of [mid, ...Array.from({ length: SIDES }, (_, k) => add(mid, scale(round(k), rr)))]) into.positions.push(...p), into.normals.push(...scale(a, e)), into.uvs!.push(0, 0);
    for (let k = 0; k < SIDES; k++) {
      const [p, q] = [base + 1 + k, base + 1 + ((k + 1) % SIDES)];
      into.indices.push(...(e > 0 ? [base, q, p] : [base, p, q]));
    }
  };
  for (const e of [-1, 1]) cap(bark, e, r, 0), cap(ends, e, r * 0.84, 0.002);
  return { bark, ends };
};
/** A stack of logs, layers of them each one fewer, along x or y, its
 *  middle at (x, y), `n` across at the bottom. */
const stack = (x: number, y: number, along: "x" | "y", l: number, n: number, r = 0.035) => {
  const out: ReturnType<typeof log>[] = [];
  for (let layer = 0; layer < n - 1; layer++)
    for (let k = 0; k < n - layer; k++) {
      const off = (k - (n - layer - 1) / 2) * 2 * r;
      const z = r + layer * r * 1.73;
      out.push(log(along === "x" ? [x, y + off, z] : [x + off, y, z], r, l, along));
    }
  return out;
};

/** The dust over the yard's left half, x and y from and to; its edge to
 *  the lane wandering, and bitten back from the dock's mouth (`lots.rs`)
 *  to the fence, whose side the dock's flatbed lies over. Mapped by
 *  where it is, so the coat knows how far in from its edge (`loose`). */
const DUST_YARD = [-0.97, 0.15, -1.0, 1.92];
const LANE_EDGE = (y: string) => `${f(DUST_YARD[1])} - 0.05 * (1. + sin(${y} * 7. + 1.)) - 0.6 * (smoothstep(0.1, 0.42, ${y}) - smoothstep(0.7, 1.02, ${y}))`;

/** How far in from its edge the yard's dust frays, how far further in
 *  its edge wanders, over bends how big, and how hard its grain turns the
 *  light. */
const [DUST_FRAY, DUST_WANDER, DUST_BENDS, DUST_TILT] = [0.05, 0.12, 14, 1.1];
/** The yard's dust: its edge how far in from the yard's, wandering in
 *  and out, its grain in the light, its colour even. */
const DUST = loose("MillDust", `min(min(input.uv.x - ${f(DUST_YARD[0])}, ${LANE_EDGE("input.uv.y")} - input.uv.x), min(input.uv.y - ${f(DUST_YARD[2])}, ${f(DUST_YARD[3])} - input.uv.y))
  < ${f(DUST_FRAY)} * looseLump * looseLump * 2. + ${f(DUST_WANDER)} * textureSample(looseGrain, looseGrainSampler, looseAt / ${f(DUST_BENDS)}).r`, `
let dustBump = looseSlope(looseAt, ${f(FLECKS)}) + 0.6 * looseSlope(looseAt, ${f(LUMPS)});
N = normalize(N - vec3f(dustBump * ${f(DUST_TILT)}, 0.));
baseColor = baseColor * (0.95 + 0.1 * looseLump);`);

/** A chip, long and wide; how far each is tipped, and how far their
 *  shades differ. */
const CHIP = [0.02, 0.009];
const [CHIP_TIP, CHIP_SHADES] = [1.4, 0.55];
/** Chips heaped, each its own: cells in rows across a turn, every other
 *  row staggered, each tipped its own way and its own shade; let go where
 *  finer than the pixels. */
const CHIPPED = loose("MillChips", `input.uv.x > 0.94 + ${f(SPILL - 0.94)} * looseLump * looseLump`, `
let chipQ = mat2x2f(0.8, 0.6, -0.6, 0.8) * looseAt / vec2f(${f(CHIP[0])}, ${f(CHIP[1])});
let chipH = looseCell(floor(vec2f(chipQ.x + 0.5 * floor(chipQ.y), chipQ.y)));
let chipFine = 1. - smoothstep(0.35, 0.9, max(fwidth(chipQ.x), fwidth(chipQ.y)));
N = normalize(N + vec3f((chipH.xy - 0.5) * ${f(CHIP_TIP)} * chipFine, 0.));
baseColor = baseColor * mix(0.95 + 0.1 * looseLump, ${f(1 - CHIP_SHADES / 2)} + ${f(CHIP_SHADES)} * chipH.z, chipFine);`);

const SAWMILL = solids(() => {
  const wood: Part[] = [], zinc: Part[] = [], bark: Part[] = [], dust: Part[] = [], chips: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => wood.push([mesh(solid), [0, 0, 0], rgb]);
  const roof = ([s, r]: [Manifold, Manifold], a: RGB, b: RGB) => (put(s, a), put(r, b));
  const zinced = (geo: MeshGeometry) => zinc.push([geo, [0, 0, 0], ZINC_COLOUR]);
  const logged = (l: ReturnType<typeof log>) => (bark.push([l.bark, [0, 0, 0], BARKED]), wood.push([l.ends, [0, 0, 0], END]));

  // The ground: wood chips over the yard's left half, out to the lorries' lane.
  // Thick enough to show over the hall's paving, which stands a little higher.
  dust.push([mesh(box(DUST_YARD[0], DUST_YARD[1], DUST_YARD[2], DUST_YARD[3], 0, 0.016), (p) => [p[0], p[1]]), [0, 0, 0], SAWDUST]);

  // The hall, at the back.
  const [hx0, hx1, hy0, hy1, he, hr, hRidgeY] = [-0.78, 0.5, -1.86, -1.0, 0.2, 0.42, -1.62];
  put(barnX(hx0, hx1, hy0, hy1, he, hr, hRidgeY), WALL);
  const o = 0.05;
  /** Down a roof from its ridge, `run` out to its wall and `out` past it. */
  const down = (run: number, out: number, rise: number, along: "x" | "y"): V => {
    const d = run + Math.sign(run) * out, z = -(rise * Math.abs(d)) / Math.abs(run);
    return along === "x" ? [d, 0, z] : [0, d, z];
  };
  // Its front slope, long, from the ridge down past the front wall; its
  // back slope, short, and the four gables along it.
  roof(ribbed([hx0 - o, hRidgeY, hr], [hx1 - hx0 + 2 * o, 0, 0], down(hy1 - hRidgeY, o, hr - he, "y"), 0.014, 26), ROOF, RIB);
  roof(ribbed([hx0 - o, hRidgeY, hr], [hx1 - hx0 + 2 * o, 0, 0], down(hy0 - hRidgeY, o, hr - he, "y"), 0.014, 26), ROOF, RIB);
  const gw = (hx1 - hx0) / 4;
  for (let k = 0; k < 4; k++) {
    const [gx0, gx1] = [hx0 + k * gw + 0.02, hx0 + (k + 1) * gw - 0.02];
    const mid = (gx0 + gx1) / 2;
    put(barnY(gx0, gx1, hy0, hRidgeY, he, hr), WALL);
    for (const s of [-1, 1]) roof(ribbed([mid, hy0 - o, hr + 0.004], [0, hRidgeY - hy0 + o, 0], down(s * (gx1 - gx0) / 2, 0.03, hr - he, "x"), 0.012, 6), ROOF, RIB);
  }
  // A zinc lean-to down its left side, and a zinc canopy along its front.
  zinced(golf([hx0 - 0.005, hy0 + 0.08, 0.17], [0, -0.8 - hy0, 0], [-0.21, 0, -0.07], 0.01));
  put(box(-0.98, hx0, hy0 + 0.1, -0.75, 0, 0.1), TRIM);
  zinced(golf([hx0 + 0.07, hy1 - 0.005, 0.19], [0.82, 0, 0], [0, 0.3, -0.05], 0.01));
  for (const x of [hx0 + 0.1, hx0 + 0.47, hx0 + 0.86]) put(box(x - 0.012, x + 0.012, hy1 + 0.27, hy1 + 0.294, 0, 0.145), TRIM);
  put(box(-0.26, -0.02, hy1 - 0.002, hy1 + 0.004, 0, 0.15), DOOR);

  // The wing, down the right: a barn, its gable to the yard.
  const [wx0, wx1, wy0, wy1, we, wr] = [0.22, 0.76, -1.78, -0.02, 0.24, 0.5];
  put(barnY(wx0, wx1, wy0, wy1, we, wr), WALL);
  for (const s of [-1, 1]) roof(ribbed([(wx0 + wx1) / 2, wy0 - 0.05, wr], [0, wy1 - wy0 + 0.1, 0], down(s * (wx1 - wx0) / 2, 0.06, wr - we, "x"), 0.016, 22), ROOF, RIB);
  put(box(0.38, 0.6, wy1 - 0.004, wy1 + 0.006, 0, 0.19), DOOR);
  put(box(0.36, 0.62, wy1 - 0.004, wy1 + 0.012, 0.19, 0.21), TRIM);
  zinced(golf([wx1 + 0.005, -1.25, 0.18], [0, 1.4, 0], [0.22, 0, -0.07], 0.01));
  for (const y of [-1.15, -0.5, 0.1]) put(box(0.95, 0.975, y - 0.012, y + 0.012, 0, 0.11), TRIM);
  // Its chimney, brick, behind the wing.
  put(box(0.78, 0.9, -1.62, -1.5, 0, 0.72).add(box(0.765, 0.915, -1.635, -1.485, 0.68, 0.72)), BRICK);

  // The water tower at the yard's back, on four braced legs.
  const [tx, ty, legs, tr, th] = [-0.8, -0.62, 0.26, 0.15, 0.2];
  const frame = Solid.union([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
    hull([[tx + sx * 0.13, ty + sy * 0.13, 0], [tx + sx * 0.15, ty + sy * 0.15, 0], [tx + sx * 0.1, ty + sy * 0.1, legs], [tx + sx * 0.12, ty + sy * 0.12, legs]])))
    .add(box(tx - 0.13, tx + 0.13, ty - 0.13, ty + 0.13, legs - 0.02, legs));
  const braces = Solid.union([-1, 1].flatMap((s) => [
    hull([[tx - 0.13, ty + s * 0.135, 0.02], [tx - 0.13, ty + s * 0.135, 0.04], [tx + 0.11, ty + s * 0.115, legs - 0.04], [tx + 0.11, ty + s * 0.115, legs - 0.02]]),
    hull([[tx + s * 0.135, ty - 0.13, 0.02], [tx + s * 0.135, ty - 0.13, 0.04], [tx + s * 0.115, ty + 0.11, legs - 0.04], [tx + s * 0.115, ty + 0.11, legs - 0.02]]),
  ]));
  put(frame.add(braces), TRIM);
  put(Solid.cylinder(th, tr, tr, 16).translate([tx, ty, legs]), TANK);
  put(Solid.union([0.04, 0.1, 0.16].map((h) => Solid.cylinder(0.012, tr + 0.006, tr + 0.006, 16).translate([tx, ty, legs + h]))), HOOP);
  put(Solid.cylinder(0.08, tr + 0.02, 0.015, 16).translate([tx, ty, legs + th]), ROOF);

  // The conveyor, from the yard up under the canopy into the hall.
  const [cx, cw, c0, c1, z0, z1] = [-0.14, 0.09, 0.28, -1.0, 0.03, 0.17];
  const slope = (zLo: number, zHi: number, half: number) =>
    hull([[cx - half, c0, zLo], [cx + half, c0, zLo], [cx - half, c0, zHi], [cx + half, c0, zHi], [cx - half, c1, zLo + z1 - z0], [cx + half, c1, zLo + z1 - z0], [cx - half, c1, zHi + z1 - z0], [cx + half, c1, zHi + z1 - z0]]);
  const rise = (y: number) => z0 + ((z1 - z0) * (c0 - y)) / (c0 - c1);
  put(slope(z0, z0 + 0.03, cw / 2).subtract(slope(z0 + 0.016, z0 + 0.05, cw / 2 - 0.01))
    .add(Solid.union([0.2, -0.2, -0.6].flatMap((y) => [-1, 1].map((s) => box(cx + s * (cw / 2 - 0.006) - 0.006, cx + s * (cw / 2 - 0.006) + 0.006, y - 0.006, y + 0.006, 0, rise(y)))))), STEEL);
  put(slope(z0, z0 + 0.017, cw / 2 - 0.01), BELT);
  for (const y of [0.15, -0.2, -0.55]) logged(log([cx, y, rise(y) + 0.036], 0.02, cw - 0.025, "x"));
  // Sawdust heaped about its foot and by the canopy, on the chips.
  [[-0.34, -0.55, 0.15, 0.035], [0.05, -0.62, 0.12, 0.03], [-0.46, 1.06, 0.14, 0.035], [-0.3, 1.32, 0.09, 0.024]].forEach(([x, y, r, h], k) =>
    chips.push([heap(x, y, r, h, 0.016, k + 1), [0, 0, 0], CHIPS]));

  // Three stacks of logs on the chips.
  for (const l of [...stack(-0.47, 0.18, "x", 0.42, 5), ...stack(-0.8, 1.2, "y", 0.5, 4), ...stack(-0.68, 1.6, "x", 0.44, 4)]) logged(l);
  // A fence along the side.
  put(Solid.union([
    box(-0.99, -0.975, -0.72, 1.9, 0.065, 0.08),
    box(-0.99, -0.975, -0.72, 1.9, 0.025, 0.04),
    ...Array.from({ length: 11 }, (_, k) => box(-0.995, -0.97, -0.72 + k * 0.26, -0.7 + k * 0.26, 0, 0.1)),
  ]), TRIM);

  return {
    wood: { shape: shape(wood), coat: WOOD },
    zinc: { shape: shape(zinc), coat: ZINC },
    bark: { shape: shape(bark), coat: BARK },
    dust: { shape: shape(dust), coat: DUST, flat: true },
    chips: { shape: shape(chips), coat: CHIPPED },
  };
});

/** Where its forklift comes out of the wing's door, to the gate's side. */
export const BARN_DOOR: [number, number] = [0.49, 0.1];

/** The sawmill, or its mirror: the wing on the side of the gate, at the
 *  end of the lane its lorries come up; its one dock across from it. */
export const sawmill = placing("sawmill", SAWMILL);
