import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { barn, box, door, ground, heap, hull, jitter, lamp, leanTo, model, pitched, put, rod, window, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A quarry, whole, the sawmill's twin at the mountain's foot
 * (`refresh/refs/quarry-gpt.png`): one model on its plot, two tiles
 * across (x, -1 to 1) and four deep (y), the street at +y; its ground on
 * z = 0. Its yard, the front half, is its lorries' as the sawmill's is
 * (`lots.rs`): the lane up the gate's side (+x), the stone on its pad
 * beside it (`pads.ts`), the docks across. Everything here is the back
 * half's.
 *
 * - At the back, the rock: a pale crag cut into in benches, a step each,
 *   down to the pit's floor, open to the yard; boulders on its rim.
 * - On the floor, a yellow digger at the face, boulders it broke.
 * - At the pit's mouth, the crusher: a steel frame on legs under a little
 *   roof, its yellow hopper on top, a skip under its chute; its belt out
 *   to a heap of gravel.
 * - On the gate's side the site hut: cream, a slate roof, a green door, a
 *   window over a box of flowers, a lean-to; a pallet of cut blocks by it,
 *   its lamp.
 */

const ROCK: RGB = [0.8, 0.74, 0.64];
const DUST: RGB = [0.84, 0.79, 0.7];
const STONES: RGB = [0.8, 0.78, 0.74];
const BLOCKS: RGB = [0.86, 0.84, 0.8];
const YELLOW: RGB = [0.94, 0.74, 0.22];
const TRACK: RGB = [0.24, 0.24, 0.26];
const CAB: RGB = [0.24, 0.29, 0.36];
const FRAME: RGB = [0.33, 0.42, 0.6];
const STEEL: RGB = [0.5, 0.52, 0.56];
const BELT: RGB = [0.25, 0.25, 0.27];
const WALL: RGB = [0.92, 0.87, 0.76];
const SLATE: Cover = { finish: "tiles", rgb: [0.36, 0.44, 0.62] };
const DOOR: RGB = [0.28, 0.5, 0.36];
const WOOD: RGB = [0.55, 0.38, 0.25];

/** The pit: its middle, and its benches, from the floor up, each this
 *  far across and deep and this high. */
const PIT: [number, number] = [0, -1.05];
const BENCHES = [0, 1, 2, 3].map((k) => ({ rx: 0.4 + 0.13 * k, ry: 0.32 + 0.12 * k, z: 0.1 * k }));

/** A boulder at (x, y), `r` round, standing on `z`. */
const boulder = (m: Model, x: number, y: number, r: number, seed: number, z = 0.008) =>
  put(m, "rock", hull(Array.from({ length: 10 }, (_, j): V => [x + r * jitter(seed * 7 + j), y + r * jitter(seed * 11 + j), z + r * 1.2 * Math.abs(jitter(seed * 13 + j))])), ROCK);

/** The crag, a mound over the back, cut into in benches. */
function crag(m: Model) {
  const points: V[] = [];
  let k = 0;
  for (const [x, y, z] of [[-0.97, -1.97, 0], [0.97, -1.97, 0], [-0.97, -0.62, 0], [0.97, -0.62, 0], [-0.7, -0.45, 0], [0.7, -0.45, 0],
    [-0.8, -1.8, 0.46], [-0.5, -1.8, 0.56], [-0.1, -1.84, 0.5], [0.3, -1.76, 0.6], [0.7, -1.8, 0.5], [0.82, -1.55, 0.42], [-0.82, -1.3, 0.42], [-0.8, -0.85, 0.3], [0.82, -1.1, 0.36], [0.8, -0.78, 0.26], [-0.62, -0.52, 0.1], [0.6, -0.52, 0.12]] as V[])
    points.push([x + 0.03 * jitter(k++), y + 0.03 * jitter(k++), z && z + 0.04 * jitter(k++)]);
  const SIDES = 11;
  const cut = Solid.union(BENCHES.map(({ rx, ry, z }, b) => {
    const ring: V[] = [];
    for (let s = 0; s <= SIDES; s++) {
      const t = Math.PI + (Math.PI * s) / SIDES, wob = 1 + 0.07 * jitter(b * 31 + s);
      ring.push([PIT[0] + Math.cos(t) * rx * wob, PIT[1] + Math.sin(t) * ry * wob, 0]);
    }
    ring.push([PIT[0] + rx * 1.05, 0.5, 0], [PIT[0] - rx * 1.05, 0.5, 0]);
    return hull(ring.flatMap(([x, y]): V[] => [[x, y, z + 0.004], [x, y, 1]]));
  }));
  put(m, "rock", hull(points).subtract(cut), ROCK);
  // Boulders on the rim and the benches, and on the floor, broken off the face.
  for (const [x, y, r, s, z] of [[-0.78, -1.62, 0.05, 6, 0.38], [0.66, -1.7, 0.045, 7, 0.4], [0.78, -0.92, 0.04, 8, 0.24], [-0.74, -0.7, 0.035, 9, 0.12], [0.55, -0.62, 0.045, 10, 0.1],
    [-0.28, -0.72, 0.05, 1, 0], [-0.2, -0.64, 0.03, 2, 0], [0.32, -0.9, 0.045, 3, 0], [-0.38, -1.15, 0.035, 4, 0], [0.42, -0.5, 0.03, 5, 0]])
    boulder(m, x, y, r, s, z + 0.008);
}

/** The digger at the face: its tracks, its body on them, its cab with its
 *  window, its counterweight, its boom up and its arm down to the bucket. */
function digger(m: Model, ex: number, ey: number) {
  put(m, "matte", Solid.union([-1, 1].map((s) => hull([-1, 1].flatMap((e) => [0.012, 0.05].flatMap((z): V[] => {
    const y = ey + e * (z > 0.02 ? 0.085 : 0.1);
    return [[ex + s * 0.07 - 0.025, y, z], [ex + s * 0.07 + 0.025, y, z]];
  }))))), TRACK);
  put(m, "matte", box(ex - 0.085, ex + 0.085, ey - 0.06, ey + 0.11, 0.05, 0.1).add(box(ex - 0.08, ex - 0.01, ey - 0.06, ey + 0.02, 0.1, 0.18)), YELLOW);
  put(m, "matte", box(ex - 0.08, ex + 0.08, ey + 0.08, ey + 0.13, 0.05, 0.125), STEEL);
  put(m, "glass", box(ex - 0.077, ex - 0.013, ey - 0.064, ey + 0.016, 0.115, 0.17), CAB);
  const [b0, b1, b2]: V[] = [[ex + 0.03, ey - 0.03, 0.11], [ex + 0.03, ey - 0.2, 0.27], [ex + 0.03, ey - 0.3, 0.13]];
  put(m, "matte", rod(b0, b1, 0.034).add(rod(b1, b2, 0.026)), YELLOW);
  put(m, "matte", hull([[b2[0] - 0.03, b2[1] + 0.01, b2[2]], [b2[0] + 0.03, b2[1] + 0.01, b2[2]], [b2[0] - 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] + 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] - 0.03, b2[1] - 0.01, b2[2] - 0.06], [b2[0] + 0.03, b2[1] - 0.01, b2[2] - 0.06]]), STEEL);
}

/** The crusher at the pit's mouth, its belt out to the heap at (hx, hy). */
function crusher(m: Model, cx: number, cy: number, hx: number, hy: number, hh: number) {
  // Its frame: four legs, a deck, a little roof over the works.
  put(m, "matte", Solid.union([
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => box(cx + sx * 0.07 - 0.01, cx + sx * 0.07 + 0.01, cy + sy * 0.07 - 0.01, cy + sy * 0.07 + 0.01, 0, 0.26)),
    box(cx - 0.085, cx + 0.085, cy - 0.085, cy + 0.085, 0.1, 0.125),
    ...[-1, 1].map((s) => rod([cx + s * 0.07, cy + 0.07, 0.01], [cx - s * 0.07, cy + 0.07, 0.1], 0.012)),
  ]), FRAME);
  pitched(m, "y", cx - 0.085, cx + 0.085, cy - 0.085, cy + 0.085, 0.26, 0.32, SLATE, { over: 0.015 });
  put(m, "matte", barn("y", cx - 0.085, cx + 0.085, cy - 0.085, cy - 0.07, 0.26, 0.32), FRAME);
  // The hopper on the deck, open at the top; the chute under it to the skip.
  const funnel = (lo: number, hi: number, a: number, b: number) => hull([[a, lo], [b, hi]].flatMap(([r, z]) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]): V => [cx + sx * r, cy + sy * r, z])));
  put(m, "matte", funnel(0.125, 0.22, 0.05, 0.08).subtract(funnel(0.14, 0.24, 0.035, 0.065)), YELLOW);
  put(m, "gravel", box(cx - 0.06, cx + 0.06, cy - 0.06, cy + 0.06, 0.18, 0.195), STONES);
  put(m, "matte", box(cx - 0.03, cx + 0.03, cy + 0.04, cy + 0.11, 0.06, 0.1), STEEL);
  put(m, "matte", hull([[-0.05, 0], [0.06, 0.06]].flatMap(([o, z]) => [-1, 1].flatMap((sx) => [-1, 1].map((sy): V => [cx + sx * (0.05 + o / 3), cy + 0.16 + sy * (0.045 + o / 3), z])))).subtract(box(cx - 0.04, cx + 0.04, cy + 0.125, cy + 0.195, 0.012, 0.1)), YELLOW);
  heap(m, "gravel", cx, cy + 0.16, 0.035, 0.012, 0.045, 5, STONES);
  // The belt, up to the top of the heap, on a trestle.
  const belt = (z0: number, z1: number, half: number) => hull([[cx - 0.06, 0.07], [hx + 0.06, hh + 0.05]].flatMap(([x, z]) => [-half, half].flatMap((d) => [z0, z1].map((t): V => [x, cy + ((hy - cy) * (x - cx)) / (hx - cx) + d, z + t]))));
  put(m, "matte", belt(0, 0.02, 0.035), STEEL);
  put(m, "matte", belt(0.02, 0.028, 0.028), BELT);
  const tx = hx + 0.22, ty = cy + ((hy - cy) * (tx - cx)) / (hx - cx);
  for (const d of [-0.03, 0.03]) put(m, "matte", box(tx - 0.008, tx + 0.008, ty + d - 0.006, ty + d + 0.006, 0, 0.14), STEEL);
  heap(m, "gravel", hx, hy, 0.22, hh, 0.02, 3, STONES);
}

/** The site hut, its door to the yard, its lean-to to the pit. */
function hut(m: Model, x0: number, x1: number, y0: number, y1: number) {
  put(m, "matte", barn("x", x0, x1, y0, y1, 0.13, 0.22), WALL);
  put(m, "matte", box(x0 - 0.006, x1 + 0.006, y0 - 0.006, y1 + 0.006, 0, 0.018), STONES);
  pitched(m, "x", x0, x1, y0, y1, 0.13, 0.22, SLATE, { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  door(m, front, x0 + 0.08, DOOR, { w: 0.06, h: 0.11 });
  window(m, front, x1 - 0.09, 0.05, { w: 0.07, h: 0.05, box: [0.42, 0.3, 0.22] });
  window(m, { face: "-x", at: x0 }, (y0 + y1) / 2, 0.05, { w: 0.06, h: 0.05 });
  put(m, "matte", box(x0 + 0.01, x1 - 0.01, y0 - 0.1, y0, 0, 0.1).subtract(box(x0 + 0.03, x1 - 0.03, y0 - 0.12, y0 - 0.01, -0.01, 0.09)), WOOD);
  leanTo(m, { face: "-y", at: y0 }, x0 - 0.01, x1 + 0.01, 0.12, 0.11, 0.025, SLATE);
  lamp(m, x0 - 0.03, y1 + 0.04, [x0 + 0.04, y1 + 0.08]);
}

/** A pallet of cut blocks, three by two, stacked. */
function pallet(m: Model, x: number, y: number) {
  put(m, "matte", box(x - 0.07, x + 0.07, y - 0.05, y + 0.05, 0, 0.014), WOOD);
  const s = 0.044;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < (i + j < 3 ? 2 : 1); k++)
    put(m, "matte", box(x - 0.068 + i * (s + 0.002), x - 0.068 + i * (s + 0.002) + s, y - 0.046 + j * (s + 0.002), y - 0.046 + j * (s + 0.002) + s, 0.014 + k * (s + 0.002), 0.014 + k * (s + 0.002) + s), BLOCKS);
}

export const QUARRY = model((m) => {
  ground(m, "dust", [[-0.96, 0.96, -1.96, -0.04]], DUST, { z: 0.018, round: 0.03 });
  crag(m);
  digger(m, 0.06, -1.0);
  crusher(m, -0.1, -0.34, -0.6, -0.2, 0.17);
  hut(m, 0.6, 0.92, -0.42, -0.16);
  pallet(m, 0.5, -0.08);
  for (const [x, y, r, s] of [[0.42, -0.2, 0.03, 11], [0.47, -0.25, 0.022, 12]]) boulder(m, x, y, r, s);
});
