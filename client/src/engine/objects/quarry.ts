import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { box, f, FLECKS, golf, heap, hull, loose, LUMPS, placing, SPILL, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A quarry, whole, the sawmill's twin at the mountain's foot: one model
 * on its plot, two tiles across (x, -1 to 1) and four deep (y), the
 * street at +y; its ground on z = 0. Its yard, the front half, is its
 * lorries' as the sawmill's is (`lots.rs`): the lane up the gate's side
 * (+x), the stone on its pad beside it (`pads.ts`), the docks across.
 *
 * - At the back, the rock: a low crag cut into in benches, a step each,
 *   down to the pit's floor, open to the yard.
 * - On the floor, a yellow digger at the face, boulders it broke.
 * - At the pit's mouth, the crusher: its hopper on legs, its belt up to
 *   a heap of gravel; on the gate's side the site hut, zinc.
 *
 * Its finishes (`model.ts`): paint, zinc, the rock, faceted, the gravel
 * heaped, and the dust on the floor.
 */

const ROCK: RGB = [0.66, 0.6, 0.53];
const STONES: RGB = [0.66, 0.64, 0.6];
const YELLOW: RGB = [0.92, 0.72, 0.24];
const TRACK: RGB = [0.24, 0.24, 0.26];
const CAB: RGB = [0.27, 0.32, 0.38];
const STEEL: RGB = [0.46, 0.48, 0.52];
const BELT: RGB = [0.27, 0.27, 0.28];
const DOOR: RGB = [0.32, 0.45, 0.38];
const TRIM: RGB = [0.9, 0.87, 0.8];

/** A number in [-1, 1] the same for the same `k`. */
const jitter = (k: number) => Math.sin(k * 12.9898 + 4.1) * 43758.5453 % 1;

/** The pit: its middle, and its benches, from the floor up, each this
 *  far across and deep and this high; its floor out to the yard's back. */
const PIT: [number, number] = [0, -1.05];
const BENCHES = [0, 1, 2, 3].map((k) => ({ rx: 0.4 + 0.13 * k, ry: 0.32 + 0.12 * k, z: 0.1 * k }));

/** The rock: faceted, its grain turning the light, a shade lighter
 *  where it is freshly broken. */
const ROCKY = loose("QuarryRock", "false", `
let rockBump = looseSlope(looseAt + vec2f(input.worldPos.z * 3.), ${f(FLECKS)}) + 0.5 * looseSlope(looseAt, ${f(LUMPS)});
N = normalize(N + vec3f(rockBump * 0.9, 0.));
baseColor = baseColor * (0.92 + 0.16 * looseLump);`);

/** A stone of the gravel, how big; how far each is rounded and how far
 *  their shades differ. */
const STONE = 0.018;
const [STONE_ROUND, STONE_SHADES] = [0.8, 0.35];
/** Gravel: stones each round the nearest of a scatter of points, rounded
 *  in the light and each its own shade, the cracks between them dark;
 *  let go where finer than the pixels. Heaped, its foot frayed as the
 *  sawmill's chips. */
const GRAVEL = loose("QuarryGravel", `input.uv.x > 0.94 + ${f(SPILL - 0.94)} * looseLump * looseLump`, `
let stoneQ = looseAt / ${f(STONE)};
var stoneNear = vec2f(9.);
var stoneSecond = 9.;
var stoneH = vec3f(0.);
for (var j = -1; j <= 1; j++) {
  for (var i = -1; i <= 1; i++) {
    let c = floor(stoneQ) + vec2f(f32(i), f32(j));
    let h = looseCell(c);
    let d = c + 0.15 + 0.7 * h.xy - stoneQ;
    if (dot(d, d) < dot(stoneNear, stoneNear)) { stoneSecond = length(stoneNear); stoneNear = d; stoneH = h; }
    else { stoneSecond = min(stoneSecond, length(d)); }
  }
}
let stoneEdge = stoneSecond - length(stoneNear);
let stoneFine = 1. - smoothstep(0.35, 0.9, max(fwidth(stoneQ.x), fwidth(stoneQ.y)));
N = normalize(N + vec3f(-stoneNear * ${f(2 * STONE_ROUND)} * stoneFine, 0.));
baseColor = baseColor * mix(0.95 + 0.1 * looseLump, (${f(1 - STONE_SHADES / 2)} + ${f(STONE_SHADES)} * stoneH.z) * (0.75 + 0.25 * smoothstep(0., 0.25, stoneEdge)), stoneFine);`);

/** The pit's floor: rock dust, even, its grain in the light. */
const DUST = loose("QuarryDust", "false", `
N = normalize(N - vec3f((looseSlope(looseAt, ${f(FLECKS)}) + 0.6 * looseSlope(looseAt, ${f(LUMPS)})) * 1.1, 0.));
baseColor = baseColor * (0.96 + 0.08 * looseLump);`);

const QUARRY = solids(() => {
  const paint: Part[] = [], zinc: Part[] = [], rock: Part[] = [], gravel: Part[] = [], floor: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => paint.push([mesh(solid), [0, 0, 0], rgb]);
  const zinced = (geo: MeshGeometry) => zinc.push([geo, [0, 0, 0], ZINC_COLOUR]);

  // The floor, gravel, under the crag and out to the yard.
  floor.push([mesh(box(-0.98, 0.98, -1.98, -0.02, 0, 0.018), () => [0, 0]), [0, 0, 0], STONES]);

  // The crag: a low mound over the back, highest at the back, its corners
  // knocked about; each bench cut out of it, an arch open to the yard.
  const crag: V[] = [];
  let k = 0;
  for (const [x, y, z] of [[-0.97, -1.97, 0], [0.97, -1.97, 0], [-0.97, -0.62, 0], [0.97, -0.62, 0], [-0.7, -0.45, 0], [0.7, -0.45, 0],
    [-0.8, -1.8, 0.46], [-0.5, -1.8, 0.56], [-0.1, -1.84, 0.5], [0.3, -1.76, 0.6], [0.7, -1.8, 0.5], [0.82, -1.55, 0.42], [-0.82, -1.3, 0.42], [-0.8, -0.85, 0.3], [0.82, -1.1, 0.36], [0.8, -0.78, 0.26], [-0.62, -0.52, 0.1], [0.6, -0.52, 0.12]] as V[])
    crag.push([x + 0.03 * jitter(k++), y + 0.03 * jitter(k++), z && z + 0.04 * jitter(k++)]);
  const SIDES = 9;
  const cut = Solid.union(BENCHES.map(({ rx, ry, z }, b) => {
    const ring: V[] = [];
    for (let s = 0; s <= SIDES; s++) {
      const t = Math.PI + (Math.PI * s) / SIDES, wob = 1 + 0.08 * jitter(b * 31 + s);
      ring.push([PIT[0] + Math.cos(t) * rx * wob, PIT[1] + Math.sin(t) * ry * wob, 0]);
    }
    ring.push([PIT[0] + rx * 1.05, 0.5, 0], [PIT[0] - rx * 1.05, 0.5, 0]);
    return hull(ring.flatMap(([x, y]): V[] => [[x, y, z + 0.004], [x, y, 1]]));
  }));
  rock.push([mesh(hull(crag).subtract(cut)), [0, 0, 0], ROCK]);
  // Boulders on the floor, broken off the face.
  const boulder = (x: number, y: number, r: number, seed: number) =>
    hull(Array.from({ length: 10 }, (_, j): V => [x + r * jitter(seed * 7 + j), y + r * jitter(seed * 11 + j), 0.008 + r * 1.2 * Math.abs(jitter(seed * 13 + j))]));
  for (const [x, y, r, s] of [[-0.28, -0.72, 0.05, 1], [-0.2, -0.64, 0.03, 2], [0.32, -0.9, 0.045, 3], [-0.38, -1.15, 0.035, 4]]) rock.push([mesh(boulder(x, y, r, s)), [0, 0, 0], ROCK]);

  // The digger at the face: its tracks, its body turned on them, its
  // cab, its boom up and its arm down to the bucket at the bench.
  const [ex, ey] = [0.06, -1.0];
  put(Solid.union([-1, 1].map((s) => hull([[ex + s * 0.07 - 0.025, ey - 0.1, 0.012], [ex + s * 0.07 + 0.025, ey - 0.1, 0.012], [ex + s * 0.07 - 0.025, ey + 0.1, 0.012], [ex + s * 0.07 + 0.025, ey + 0.1, 0.012],
    [ex + s * 0.07 - 0.025, ey - 0.085, 0.05], [ex + s * 0.07 + 0.025, ey - 0.085, 0.05], [ex + s * 0.07 - 0.025, ey + 0.085, 0.05], [ex + s * 0.07 + 0.025, ey + 0.085, 0.05]]))), TRACK);
  put(box(ex - 0.085, ex + 0.085, ey - 0.06, ey + 0.11, 0.05, 0.1).add(box(ex - 0.075, ex + 0.075, ey + 0.07, ey + 0.12, 0.05, 0.12)), YELLOW);
  put(box(ex - 0.08, ex - 0.01, ey - 0.06, ey + 0.02, 0.1, 0.18), YELLOW);
  put(box(ex - 0.075, ex - 0.015, ey - 0.064, ey + 0.016, 0.115, 0.17), CAB);
  const [b0, b1, b2]: V[] = [[ex + 0.03, ey - 0.03, 0.11], [ex + 0.03, ey - 0.2, 0.27], [ex + 0.03, ey - 0.3, 0.13]];
  const limb = (a: V, b: V, w: number) => hull([a, b].flatMap(([x, y, z]): V[] => [[x - w, y, z - w], [x + w, y, z - w], [x - w, y, z + w], [x + w, y, z + w]]));
  put(limb(b0, b1, 0.018).add(limb(b1, b2, 0.014)), YELLOW);
  put(hull([[b2[0] - 0.03, b2[1] + 0.01, b2[2]], [b2[0] + 0.03, b2[1] + 0.01, b2[2]], [b2[0] - 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] + 0.03, b2[1] - 0.04, b2[2] - 0.02], [b2[0] - 0.03, b2[1] - 0.01, b2[2] - 0.06], [b2[0] + 0.03, b2[1] - 0.01, b2[2] - 0.06]]), STEEL);

  // The crusher at the pit's mouth: its hopper on four legs, its belt up
  // to the heap of gravel it throws.
  const [cx, cy] = [-0.08, -0.32];
  put(Solid.union([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => box(cx + sx * 0.06 - 0.008, cx + sx * 0.06 + 0.008, cy + sy * 0.06 - 0.008, cy + sy * 0.06 + 0.008, 0, 0.12)))
    .add(box(cx - 0.075, cx + 0.075, cy - 0.075, cy + 0.075, 0.1, 0.13)), STEEL);
  put(hull([[cx - 0.07, cy - 0.07, 0.13], [cx + 0.07, cy - 0.07, 0.13], [cx - 0.07, cy + 0.07, 0.13], [cx + 0.07, cy + 0.07, 0.13], [cx - 0.1, cy - 0.1, 0.22], [cx + 0.1, cy - 0.1, 0.22], [cx - 0.1, cy + 0.1, 0.22], [cx + 0.1, cy + 0.1, 0.22]])
    .subtract(hull([[cx - 0.055, cy - 0.055, 0.15], [cx + 0.055, cy - 0.055, 0.15], [cx - 0.055, cy + 0.055, 0.15], [cx + 0.055, cy + 0.055, 0.15], [cx - 0.085, cy - 0.085, 0.24], [cx + 0.085, cy - 0.085, 0.24], [cx - 0.085, cy + 0.085, 0.24], [cx + 0.085, cy + 0.085, 0.24]])), YELLOW);
  const [hx, hy, hr, hh] = [-0.6, -0.2, 0.22, 0.17];
  const belt = (z0: number, z1: number, half: number) => hull([[cx - 0.05, cy - half, 0.06 + z0], [cx - 0.05, cy + half, 0.06 + z0], [cx - 0.05, cy - half, 0.06 + z1], [cx - 0.05, cy + half, 0.06 + z1],
    [hx + 0.05, hy - half, hh + 0.05 + z0], [hx + 0.05, hy + half, hh + 0.05 + z0], [hx + 0.05, hy - half, hh + 0.05 + z1], [hx + 0.05, hy + half, hh + 0.05 + z1]]);
  put(belt(0, 0.02, 0.035).add(box(hx + 0.2, hx + 0.215, hy - 0.035, hy + 0.035, 0, 0.13)).add(box(hx + 0.2, hx + 0.215, hy - 0.005, hy + 0.005, 0, 0.13)), STEEL);
  put(belt(0.02, 0.03, 0.028), BELT);
  gravel.push([heap(hx, hy, hr, hh, 0.018, 3), [0, 0, 0], STONES]);
  gravel.push([heap(cx + 0.02, cy + 0.1, 0.07, 0.025, 0.018, 5), [0, 0, 0], STONES]);

  // The site hut on the gate's side: zinc, its door and window to the yard.
  const [ux0, ux1, uy0, uy1, uh] = [0.62, 0.92, -0.48, -0.16, 0.14];
  put(box(ux0, ux1, uy0, uy1, 0, uh), TRIM);
  for (const [o, u, v, out] of [[[ux0, uy1 + 0.004, 0], [ux1 - ux0, 0, 0], [0, 0, uh], [0, 1, 0]], [[ux0 - 0.004, uy0, 0], [0, uy1 - uy0, 0], [0, 0, uh], [-1, 0, 0]]] as V[][])
    zinced(golf(o, u, v, 0.004, out));
  zinced(golf([ux0 - 0.03, uy1 + 0.04, uh + 0.03], [ux1 - ux0 + 0.06, 0, 0], [0, uy0 - uy1 - 0.08, -0.025], 0.008));
  put(box(ux0 + 0.18, ux0 + 0.25, uy1, uy1 + 0.012, 0, 0.11), DOOR);
  put(box(ux0 + 0.04, ux0 + 0.13, uy1, uy1 + 0.012, 0.06, 0.11), CAB);

  return {
    paint: { shape: shape(paint), coat: WOOD },
    zinc: { shape: shape(zinc), coat: ZINC },
    rock: { shape: shape(rock), coat: ROCKY },
    gravel: { shape: shape(gravel), coat: GRAVEL },
    floor: { shape: shape(floor), coat: DUST, flat: true },
  };
});

/** The quarry, or its mirror: its hut on the side of the gate. */
export const quarry = placing("quarry", QUARRY);
