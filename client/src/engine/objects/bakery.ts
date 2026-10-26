import type { Manifold } from "manifold-3d";
import { mesh, Outline, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnX, barnY, box, GLASS, hull, placing, ribbed, sheet, WOOD, type V } from "./model";

/**
 * A bakery, whole, on its plot, as its reference drew it
 * (`/mnt/project-files/bakery/gemini-1.png`): two tiles square (x and y,
 * -1 to 1), the street at +y, its gate on +x; its ground on z = 0. The
 * building is the back row and a little more, its yard the front one,
 * all lane (`lots.rs`):
 * a lorry comes in at the gate, runs along to the far end and backs into
 * the garage, nose out.
 *
 * - The plot paved in stone slabs, its hedge round it (`dressing.ts`).
 * - The shop on the gate's side: its gable end to the street, a wooden
 *   shopfront, the window and the door, flowers and a bench, a sign with
 *   a pretzel and a loaf over them, the oven's brick chimney up through its roof; slate
 *   blue tiles. A chalkboard out front.
 * - The garage beside it, its ridge along the street, standing seam, a
 *   dormer over its door; open to the far side, where the grain and the
 *   bread stand on the pad (`pads.ts`), so the forklift reaches the lorry.
 */

const WALL: RGB = [0.92, 0.87, 0.78];
const ROOF: RGB = [0.38, 0.46, 0.6];
const COURSE: RGB = [0.31, 0.38, 0.51];
const TUB: RGB = [0.54, 0.42, 0.32];
const LEAVES: RGB = [0.4, 0.58, 0.32];
const TRIM: RGB = [0.97, 0.95, 0.9];
const PANE: RGB = [0.24, 0.29, 0.36];
const FRONT: RGB = [0.58, 0.39, 0.22];
const DOOR: RGB = [0.48, 0.32, 0.18];
const BRICK: RGB = [0.66, 0.38, 0.27];
const GOLD: RGB = [0.86, 0.66, 0.3];
const CRUST: RGB = [0.78, 0.5, 0.25];
const DARK: RGB = [0.2, 0.19, 0.18];
const PAVING: RGB = [0.8, 0.76, 0.7];
const JOINT: RGB = [0.68, 0.64, 0.59];

/** The shop: its walls and roof, from and to. */
const [SX0, SX1, SY0, SY1, SE, SR] = [0.06, 0.9, -0.92, 0.2, 0.27, 0.52];
/** The garage beside it, its ridge along the street; its door. */
const [GX0, GY0, GY1, GE, GR] = [-0.48, -0.94, 0.16, 0.27, 0.46];
const [DX0, DX1, DH] = [-0.4, -0.08, 0.245];

/** The oven's chimney, where it stands and how high its top: the
 *  smoke's, as `roof.ts` has it. */
const CHIMNEY: V = [0.74, -0.6, 0.68];

const BAKERY = solids(() => {
  const wood: Part[] = [], glass: Part[] = [], ground: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => (rgb === PANE ? glass : wood).push([mesh(solid), [0, 0, 0], rgb]);
  const o = 0.04;

  // The paving, slabs a sixth of a tile, up to the pavement's strip
  // before the street.
  const slab = 1 / 6;
  const slabs: Manifold[] = [];
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) {
      const [x0, y0] = [-1 + i * slab, -1 + j * slab];
      const [y1, x1] = [Math.min(0.9, y0 + slab), x0 + slab];
      if (y1 > y0 + 0.02) slabs.push(box(Math.max(-0.97, x0) + 0.004, Math.min(0.97, x1) - 0.004, Math.max(-0.97, y0) + 0.004, y1 - 0.004, 0.006, 0.012));
    }
  ground.push([mesh(Solid.union(slabs)), [0, 0, 0], PAVING], [mesh(box(-0.97, 0.97, -0.97, 0.9, 0, 0.006)), [0, 0, 0], JOINT]);

  /** A pitched roof's slope: from its ridge `top`, down `down` to past its
   *  eave, along `along`; tiled in courses, or in standing seams down it. */
  const slope = (top: V, along: V, down: V, seams = false) => {
    const [s, r] = seams ? ribbed(top, along, down, 0.014, 8, 0.01) : ribbed(top, down, along, 0.014, 9, 0.008);
    put(s, ROOF), put(r, COURSE);
  };

  // The shop, its gable to the street.
  put(barnY(SX0, SX1, SY0, SY1, SE, SR), WALL);
  const half = (SX1 - SX0) / 2, mx = (SX0 + SX1) / 2;
  for (const s of [-1, 1]) slope([mx, SY0 - o, SR], [0, SY1 - SY0 + 2 * o, 0], [s * (half + o), 0, -(SR - SE) * (1 + o / half)]);
  put(box(mx - 0.014, mx + 0.014, SY0 - o, SY1 + o, SR - 0.004, SR + 0.022), COURSE);
  // The shopfront, wood, a little out from the wall: the window wide,
  // loaves on its shelf, the door, a cornice over both.
  const y = SY1;
  put(box(SX0 + 0.06, SX1 - 0.06, y - 0.002, y + 0.022, 0, 0.21).subtract(box(SX0 + 0.1, SX0 + 0.5, y + 0.01, y + 0.03, 0.05, 0.18)).subtract(box(SX0 + 0.56, SX0 + 0.7, y + 0.01, y + 0.03, -0.01, 0.18)), FRONT);
  put(box(SX0 + 0.04, SX1 - 0.04, y - 0.002, y + 0.036, 0.21, 0.228), FRONT);
  put(box(SX0 + 0.1, SX0 + 0.5, y + 0.008, y + 0.014, 0.05, 0.18), PANE);
  put(box(SX0 + 0.1, SX0 + 0.5, y + 0.002, y + 0.03, 0.04, 0.05), TRIM);
  for (let x = SX0 + 0.14; x < SX0 + 0.48; x += 0.065) put(Solid.sphere(0.022, 10).scale([1.3, 0.8, 0.7]).translate([x, y + 0.004, 0.07]), CRUST);
  put(box(SX0 + 0.29, SX0 + 0.31, y + 0.008, y + 0.02, 0.05, 0.18), FRONT);
  put(box(SX0 + 0.56, SX0 + 0.7, y + 0.004, y + 0.012, 0, 0.18), DOOR);
  put(box(SX0 + 0.58, SX0 + 0.68, y + 0.008, y + 0.016, 0.1, 0.165), PANE);
  // Over the shopfront the sign, on brackets, leaning back to be seen: a
  // board, its gold rim, a pretzel and a loaf.
  const ring = (r: number) => Solid.revolve(Outline.circle(0.011, 10).translate([r, 0]), 20).rotate([90, 0, 0]);
  const pretzel = ring(0.026).translate([-0.022, 0, 0.012]).add(ring(0.026).translate([0.022, 0, 0.012])).add(ring(0.03).scale([1.2, 1, 0.75]).translate([0, 0, -0.008]));
  const sign = (solid: Manifold) => solid.rotate([30, 0, 0]).translate([mx, y + 0.08, 0.255]);
  put(sign(box(-0.25, 0.25, -0.015, 0.012, 0, 0.12)), GOLD);
  put(sign(box(-0.23, 0.23, -0.012, 0.016, 0.012, 0.108)), TRIM);
  put(sign(pretzel.translate([-0.1, 0.024, 0.06])), CRUST);
  put(sign(Solid.sphere(0.05, 16).scale([1.35, 0.4, 0.62]).translate([0.1, 0.022, 0.06])), CRUST);
  for (const x of [0.06, 0.1, 0.14]) put(sign(box(x - 0.004, x + 0.004, 0.036, 0.044, 0.045, 0.075)), GOLD);
  for (const x of [mx - 0.18, mx + 0.18]) put(box(x - 0.008, x + 0.008, y, y + 0.08, 0.235, 0.255), DARK);
  // A tub of flowers each side of the door, a bench under the window.
  for (const x of [SX0 + 0.52, SX0 + 0.74]) {
    put(box(x - 0.025, x + 0.025, y + 0.03, y + 0.08, 0, 0.035), TUB);
    put(Solid.sphere(0.03, 10).scale([1, 1, 0.8]).translate([x, y + 0.055, 0.045]), LEAVES);
  }
  put(box(SX0 + 0.16, SX0 + 0.44, y + 0.035, y + 0.08, 0.03, 0.04).add(box(SX0 + 0.17, SX0 + 0.19, y + 0.04, y + 0.075, 0, 0.03)).add(box(SX0 + 0.41, SX0 + 0.43, y + 0.04, y + 0.075, 0, 0.03)), FRONT);
  // A window a storey on its side to the street's way along, and the
  // chalkboard out front.
  for (const [wy, z] of [[-0.05, 0.07], [-0.5, 0.07], [-0.05, 0.2], [-0.5, 0.2]]) {
    put(box(SX1 - 0.002, SX1 + 0.006, wy - 0.05, wy + 0.05, z, z + 0.075), TRIM);
    put(box(SX1, SX1 + 0.01, wy - 0.04, wy + 0.04, z + 0.01, z + 0.065), PANE);
  }
  const [bx, by] = [SX1 - 0.03, SY1 + 0.07];
  put(hull([[bx - 0.035, by - 0.03, 0], [bx + 0.035, by - 0.03, 0], [bx - 0.035, by + 0.03, 0], [bx + 0.035, by + 0.03, 0], [bx - 0.035, by - 0.004, 0.09], [bx + 0.035, by - 0.004, 0.09], [bx - 0.035, by + 0.004, 0.09], [bx + 0.035, by + 0.004, 0.09]]), FRONT);
  put(sheet([bx - 0.026, by + 0.027, 0.015], [0.052, 0, 0], [0, -0.02, 0.065], 0.006, [0, 0.96, 0.29]), DARK);

  // The oven's chimney, brick, up through the roof past the ridge, its
  // cap.
  const [cx, cy, ct] = CHIMNEY;
  put(box(cx - 0.055, cx + 0.055, cy - 0.055, cy + 0.055, 0.25, ct).add(box(cx - 0.068, cx + 0.068, cy - 0.068, cy + 0.068, ct - 0.03, ct)), BRICK);
  put(box(cx - 0.032, cx + 0.032, cy - 0.032, cy + 0.032, ct - 0.02, ct + 0.002), DARK);

  // The garage, its ridge along the street, against the shop; its door to
  // the yard, its far gable open below its eaves, on posts.
  const gm = (GY0 + GY1) / 2, gh = (GY1 - GY0) / 2;
  const shell = barnX(GX0, SX0 + 0.01, GY0, GY1, GE, GR);
  const inside = box(GX0 - 0.1, SX0 - 0.03, GY0 + 0.03, GY1 - 0.03, -0.01, GE - 0.02);
  const door = box(DX0, DX1, GY1 - 0.05, GY1 + 0.01, -0.01, DH);
  const posts = box(GX0, GX0 + 0.035, GY0, GY0 + 0.035, 0, GE).add(box(GX0, GX0 + 0.035, GY1 - 0.035, GY1, 0, GE)).add(box(GX0, GX0 + 0.035, GY0, GY1, GE - 0.03, GE));
  put(shell.subtract(inside).subtract(door).add(posts), WALL);
  put(box(GX0 + 0.035, SX0 - 0.03, GY0 + 0.03, GY0 + 0.035, 0, GE - 0.02), DARK);
  for (const s of [-1, 1]) slope([GX0 - o, gm, GR], [SX0 - GX0 + o, 0, 0], [0, s * (gh + o), -(GR - GE) * (1 + o / gh)], true);
  put(box(GX0 - o, SX0, gm - 0.014, gm + 0.014, GR - 0.004, GR + 0.02), COURSE);
  // Its door's frame, and the dormer over it.
  put(box(DX0 - 0.025, DX0, GY1 - 0.002, GY1 + 0.01, 0, DH + 0.02).add(box(DX1, DX1 + 0.025, GY1 - 0.002, GY1 + 0.01, 0, DH + 0.02)).add(box(DX0 - 0.025, DX1 + 0.025, GY1 - 0.002, GY1 + 0.01, DH, DH + 0.02)), FRONT);
  const [dx, dw, df] = [(DX0 + DX1) / 2, 0.07, 0];
  const rise = (yy: number) => GR - ((yy - gm) / gh) * (GR - GE);
  const z0 = GE - 0.01;
  put(barnY(dx - dw, dx + dw, gm, df, 0.41 - z0, GR - z0).translate([0, 0, z0]), WALL);
  for (const s of [-1, 1]) put(sheet([dx, gm, GR + 0.012], [0, df - gm + 0.03, 0], [s * (dw + 0.025), 0, -0.065], 0.012), ROOF);
  put(box(dx - 0.032, dx + 0.032, df - 0.002, df + 0.008, rise(df) + 0.004, 0.405), TRIM);
  put(box(dx - 0.024, dx + 0.024, df, df + 0.012, rise(df) + 0.01, 0.397), PANE);

  return {
    wood: { shape: shape(wood), coat: WOOD },
    glass: { shape: shape(glass), coat: GLASS },
    ground: { shape: shape(ground), coat: WOOD, flat: true },
  };
});

/** A bakery, or its mirror, its gate on the other side. */
export const bakery = placing("bakery", BAKERY);
