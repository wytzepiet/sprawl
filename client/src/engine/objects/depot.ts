import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barrel, box, golf, hull, placing, WOOD, ZINC, ZINC_COLOUR } from "./model";

/**
 * A depot, whole: its sheds round its bays and its yard, one model on its
 * plot, as `docs/style.md`'s board drew it. Its plot three tiles across
 * (x, -1.5 to 1.5) and four deep (y), the street at +y; its ground on
 * z = 0. Its bays are the server's (`pads.ts`), on the open ground in the
 * middle of its back half, its docks the yard's in front (`lots.rs`).
 *
 * - A U of sheds round the bays, barrel roofed in zinc: one along the
 *   back, a wing down either side, their doors to the bays.
 * - Over the bays a gantry crane, yellow, its trolley on its beam.
 * - Round the yard a low fence, open at the gate.
 */

const WALL: RGB = [0.62, 0.4, 0.3];
const TRIM: RGB = [0.9, 0.87, 0.8];
const SHUTTER: RGB = [0.56, 0.6, 0.66];
const PANE: RGB = [0.24, 0.29, 0.36];
const CRANE: RGB = [0.9, 0.7, 0.26];
const CABLE: RGB = [0.22, 0.22, 0.24];
const FENCE: RGB = [0.31, 0.48, 0.36];

/** The sheds' walls, how high, and their roofs' rise; the back shed's
 *  front, and the wings' inner walls and fronts. */
const EAVE = 0.2;
const [BACK, INNER, OUTER, FRONT] = [-1.66, 0.74, 1.37, -0.06];

const DEPOT = solids(() => {
  const wood: Part[] = [], zinc: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => wood.push([mesh(solid), [0, 0, 0], rgb]);
  const zinced = (geo: MeshGeometry, rgb = ZINC_COLOUR) => zinc.push([geo, [0, 0, 0], rgb]);
  const shed = (s: ReturnType<typeof barrel>) => (put(s.walls, WALL), zinced(s.roof));
  /** A roller shutter `w` wide and `h` high on the wall at `wall`, facing
   *  as it says, its middle `at` along the wall; its slats across. */
  const shutter = (wall: number, at: number, w: number, h: number, facing: "+x" | "-x" | "+y" | "-y") => {
    const s = facing[0] === "+" ? 1 : -1, out = wall + s * 0.004;
    if (facing[1] === "y") {
      zinced(golf([at - w / 2, out, 0], [0, 0, h], [w, 0, 0], 0.006, [0, s, 0]), SHUTTER);
      put(box(at - w / 2 - 0.015, at + w / 2 + 0.015, out - 0.006, out + 0.006, h, h + 0.02), TRIM);
    } else {
      zinced(golf([out, at - w / 2, 0], [0, 0, h], [0, w, 0], 0.006, [s, 0, 0]), SHUTTER);
      put(box(out - 0.006, out + 0.006, at - w / 2 - 0.015, at + w / 2 + 0.015, h, h + 0.02), TRIM);
    }
  };

  // The back shed, along the back, and a wing down either side.
  shed(barrel("x", -OUTER, OUTER, -1.97, BACK, EAVE + 0.08, 0.1));
  for (const s of [-1, 1]) {
    const [b0, b1] = s > 0 ? [INNER, OUTER] : [-OUTER, -INNER];
    shed(barrel("y", BACK - 0.02, FRONT, b0, b1, EAVE, 0.18));
    // Its doors to the bays, and a big one to the yard, beside its office's window.
    for (const y of [-1.25, -0.62]) shutter(s * INNER, y, 0.22, 0.15, s > 0 ? "-x" : "+x");
    shutter(FRONT, s * (INNER + 0.2), 0.22, 0.16, "+y");
    put(box(s * (OUTER - 0.12) - 0.07, s * (OUTER - 0.12) + 0.07, FRONT - 0.002, FRONT + 0.008, 0.07, 0.15), TRIM);
    put(box(s * (OUTER - 0.12) - 0.055, s * (OUTER - 0.12) + 0.055, FRONT, FRONT + 0.012, 0.085, 0.135), PANE);
  }
  for (const x of [-0.5, 0, 0.5]) shutter(BACK, x, 0.24, 0.17, "+y");

  // The gantry over the bays: a leg either side, splayed, a beam across,
  // its trolley and the hook hanging from it.
  const [gy, top, leg] = [-1.0, 0.46, 0.7];
  put(Solid.union([
    ...[-1, 1].map((s) => hull([[s * leg - 0.015, gy - 0.16, 0], [s * leg + 0.015, gy - 0.16, 0], [s * leg - 0.015, gy + 0.16, 0], [s * leg + 0.015, gy + 0.16, 0], [s * leg - 0.015, gy - 0.02, top], [s * leg + 0.015, gy - 0.02, top], [s * leg - 0.015, gy + 0.02, top], [s * leg + 0.015, gy + 0.02, top]])
      .subtract(hull([[s * leg - 0.03, gy - 0.12, -0.01], [s * leg + 0.03, gy - 0.12, -0.01], [s * leg - 0.03, gy + 0.12, -0.01], [s * leg + 0.03, gy + 0.12, -0.01], [s * leg - 0.03, gy, top - 0.08], [s * leg + 0.03, gy, top - 0.08]]))),
    box(-leg - 0.03, leg + 0.03, gy - 0.025, gy + 0.025, top, top + 0.045),
    box(0.12, 0.24, gy - 0.04, gy + 0.04, top + 0.045, top + 0.085),
    box(0.15, 0.21, gy - 0.035, gy + 0.035, top - 0.03, top),
  ]), CRANE);
  put(box(0.177, 0.183, gy - 0.003, gy + 0.003, 0.3, top - 0.03), CABLE);
  put(box(0.14, 0.22, gy - 0.05, gy + 0.05, 0.285, 0.3), CRANE);

  // The yard's fence, down its sides and along its front, open at the gate.
  const [fx, fy, gate] = [1.37, 1.87, 0.5];
  const rail = (x0: number, x1: number, y0: number, y1: number) => [box(x0, x1, y0, y1, 0.07, 0.085), box(x0, x1, y0, y1, 0.03, 0.045)];
  const posts = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.25));
    return Array.from({ length: n + 1 }, (_, k) => {
      const [x, y] = [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n];
      return box(x - 0.014, x + 0.014, y - 0.014, y + 0.014, 0, 0.1);
    });
  };
  put(Solid.union([
    ...[-1, 1].flatMap((s) => [...rail(s * fx - 0.008, s * fx + 0.008, FRONT, fy), ...posts(s * fx, FRONT + 0.05, s * fx, fy)]),
    ...[-1, 1].flatMap((s) => [...rail(Math.min(s * gate, s * fx), Math.max(s * gate, s * fx), fy - 0.008, fy + 0.008), ...posts(s * gate, fy, s * fx, fy)]),
  ]), FENCE);

  return { wood: { shape: shape(wood), coat: WOOD }, zinc: { shape: shape(zinc), coat: ZINC } };
});

/** The depot, as an engine draws it. */
export const depot = placing("depot", DEPOT);
