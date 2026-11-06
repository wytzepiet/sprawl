import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { barn, box, door, ground, heap, hull, jitter, lamp, leanTo, model, pitched, put, rod, window, PANE, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A pit, whole, on the back row of its plot (x -1 to 1, the street at
 * +y, its loading bay cut at x = 0.5): the bank it is dug into, clay or
 * sand by the kind.
 *
 * - On the left the bank, a mound cut into in benches, a step each, down
 *   to the pit's floor, open to the yard; boulders on its rim.
 * - On the floor, a yellow digger at the face.
 * - On the right the site hut: cream, a slate roof, a green door, a
 *   window over a box of flowers, a lean-to; heaps of what was dug
 *   before it.
 */

const DUST: RGB = [0.84, 0.79, 0.7];
const STONES: RGB = [0.8, 0.78, 0.74];
const YELLOW: RGB = [0.94, 0.74, 0.22];
const TRACK: RGB = [0.24, 0.24, 0.26];
const STEEL: RGB = [0.5, 0.52, 0.56];
const WALL: RGB = [0.92, 0.87, 0.76];
const SLATE: Cover = { finish: "tiles", rgb: [0.36, 0.44, 0.62] };
const DOOR: RGB = [0.28, 0.5, 0.36];
const WOOD: RGB = [0.55, 0.38, 0.25];

/** The pit: its middle, and its benches, from the floor up, each this
 *  far across and deep and this high. */
const PIT: [number, number] = [0, -1.05];
const BENCHES = [0, 1, 2, 3].map((k) => ({ rx: 0.4 + 0.13 * k, ry: 0.32 + 0.12 * k, z: 0.1 * k }));

/** The bank drawn in a frame two tiles across and one and a half deep,
 *  laid onto the back row: squeezed to the left tile and front to back. */
const [BX, BSX, BS, BY] = [-0.4, 0.6, 0.62, -0.5];
const onRow = (x: number, y: number): [number, number] => [BX + x * BSX, BY + (y + 0.45) * BS];

/** A boulder at (x, y) in the bank's frame, `r` round, standing on `z`. */
const boulder = (m: Model, x: number, y: number, r: number, seed: number, z: number, rock: RGB) => {
  const [bx, by] = onRow(x, y);
  put(m, "rock", hull(Array.from({ length: 10 }, (_, j): V => [bx + r * jitter(seed * 7 + j), by + r * jitter(seed * 11 + j), z + r * 1.2 * Math.abs(jitter(seed * 13 + j))])), rock);
};

/** The crag, a mound over the back, cut into in benches. */
function crag(m: Model, rock: RGB) {
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
  put(m, "rock", hull(points).subtract(cut).scale([BSX, BS, 1]).translate([BX, BY + 0.45 * BS, 0]), rock);
  // Boulders on the rim and the benches, and on the floor, broken off the face.
  for (const [x, y, r, s, z] of [[-0.78, -1.62, 0.09, 6, 0.36], [0.66, -1.7, 0.08, 7, 0.38], [0.78, -0.92, 0.075, 8, 0.22], [-0.74, -0.7, 0.07, 9, 0.1], [0.55, -0.62, 0.08, 10, 0.08], [-0.2, -1.72, 0.07, 13, 0.42],
    [-0.28, -0.72, 0.07, 1, 0], [-0.2, -0.64, 0.045, 2, 0], [0.32, -0.9, 0.065, 3, 0], [-0.38, -1.15, 0.05, 4, 0], [0.42, -0.5, 0.045, 5, 0]])
    boulder(m, x, y, r, s, z + 0.008, rock);
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
  put(m, "matte", box(ex - 0.077, ex - 0.013, ey - 0.064, ey + 0.016, 0.115, 0.17), PANE);
  const [b0, b1, b2]: V[] = [[ex + 0.03, ey - 0.03, 0.11], [ex + 0.03, ey - 0.2, 0.27], [ex + 0.03, ey - 0.3, 0.13]];
  put(m, "matte", rod(b0, b1, 0.034).add(rod(b1, b2, 0.026)), YELLOW);
  put(m, "matte", hull([[b2[0] - 0.03, b2[1] + 0.01, b2[2]], [b2[0] + 0.03, b2[1] + 0.01, b2[2]], [b2[0] - 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] + 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] - 0.03, b2[1] - 0.01, b2[2] - 0.06], [b2[0] + 0.03, b2[1] - 0.01, b2[2] - 0.06]]), STEEL);
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

/** A pit dug into ground this colour, its heaps of it. */
const pit = (rock: RGB) => model((m) => {
  ground(m, "dust", [[-0.99, 0.99, -1.49, -0.5]], DUST, { z: 0.018, round: 0.03 });
  crag(m, rock);
  digger(m, BX + 0.04, -0.66);
  hut(m, 0.5, 0.88, -1.36, -1.08);
  heap(m, "gravel", 0.84, -0.74, 0.12, 0.1, 0.02, 3, rock);
  heap(m, "gravel", 0.25, -0.7, 0.08, 0.06, 0.02, 4, rock);
});

export const CLAY_PIT = pit([0.74, 0.5, 0.38]);
export const SAND_PIT = pit([0.9, 0.82, 0.62]);
