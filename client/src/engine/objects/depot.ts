import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { add, barrel, box, door, fence, halfRound, hull, model, oculus, on, plate, put, scale, sheet, shutter, window, PANE, type Model, type V, type Wall } from "./kit";

/**
 * A depot, whole (`refresh/refs/depot-gpt.png`): its sheds round its
 * bays and its yard, one model on its plot. Its plot three tiles across
 * (x, -1.5 to 1.5) and four deep (y), the street at +y; its ground on
 * z = 0. Its bays are the server's (`pads.ts`), on the open ground in the
 * middle of its back half, its docks the yard's in front (`lots.rs`).
 *
 * - A U of brick sheds round the bays under barrel roofs of slate-blue
 *   metal, each end's arch picked out in cream: along the back the tall
 *   one, three arched loading doors in it, a lamp over each, vents on its
 *   roof; a wing down either side, roof lights along its outer slope, its
 *   end to the yard a round window over a door between two arched ones.
 * - Over the bays the gantry crane, yellow, its trolley on its beam.
 * - Round the yard a green rail fence, open at the gate.
 */

const BRICK: RGB = [0.6, 0.32, 0.24];
const TRIM: RGB = [0.93, 0.88, 0.76];
const ROOF: RGB = [0.42, 0.46, 0.55];
const SHUTTER: RGB = [0.36, 0.47, 0.64];
const CRANE: RGB = [0.92, 0.72, 0.24];
const CABLE: RGB = [0.22, 0.22, 0.24];
const FENCE: RGB = [0.31, 0.48, 0.36];
const DOOR: RGB = [0.28, 0.4, 0.6];
const LAMP: RGB = [0.95, 0.85, 0.6];

/** The back shed's walls and its rise; the wings', their inner walls and
 *  outer, from its front to theirs. */
const [BACK, BACK_EAVE, BACK_RISE] = [-1.66, 0.28, 0.12];
const [WING_EAVE, WING_RISE, INNER, OUTER, FRONT] = [0.22, 0.2, 0.74, 1.37, -0.06];

/** Round a barrel: this many strips; a point on its arch `k` of them
 *  round, across from `b0` to `b1` and `out` past it. */
const STAVES = 12;
const arch = (b0: number, b1: number, eave: number, rise: number, k: number, out = 0) => {
  const t = Math.PI * (k / STAVES);
  return [(b0 + b1) / 2 - Math.cos(t) * ((b1 - b0) / 2 + out), eave + Math.sin(t) * (rise + out)];
};
/** The cream band round a barrel's end, on the wall `end` facing out. */
function arched(m: Model, end: Wall, b0: number, b1: number, eave: number, rise: number) {
  const pieces = Array.from({ length: STAVES }, (_, k) =>
    hull([k, k + 1].flatMap((j) => [0, 0.03].flatMap((out) => {
      const [b, z] = arch(b0, b1, eave, rise, j, out - 0.008);
      return [0, 0.014].map((o) => on(end, b, z, o));
    }))));
  put(m, "matte", Solid.union([...pieces, plate(end, b0 - 0.015, b0 + 0.02, 0, eave, 0, 0.012), plate(end, b1 - 0.02, b1 + 0.015, 0, eave, 0, 0.012)]), TRIM);
}

/** A roof light lying on a wing's outer slope, `y` along it. */
function rooflight(m: Model, s: number, y: number) {
  const [b0, b1] = s > 0 ? [INNER, OUTER] : [-OUTER, -INNER];
  const k = s > 0 ? 8.6 : STAVES - 8.6;
  const [b, z] = arch(b0, b1, WING_EAVE, WING_RISE, k, 0.006);
  const t = Math.PI * (k / STAVES);
  // Across the slope, up it, and out of it.
  const half = (b1 - b0) / 2;
  const n = [-Math.cos(t) / half, Math.sin(t) / WING_RISE];
  const l = Math.hypot(...n);
  const out: V = [n[0] / l, 0, n[1] / l];
  const up: V = [-out[2], 0, out[0]];
  const [w, h] = [0.07, 0.09];
  const o = add([b, y - w / 2, z], scale(up, -h / 2));
  put(m, "matte", sheet(o, [0, w, 0], scale(up, h), 0.008, out), TRIM);
  put(m, "glass", sheet(add(add(o, [0, 0.01, 0]), add(scale(up, 0.01), scale(out, 0.008))), [0, w - 0.02, 0], scale(up, h - 0.02), 0.003, out), PANE);
}

export const DEPOT = model((m) => {
  const shed = (along: "x" | "y", a0: number, a1: number, b0: number, b1: number, eave: number, rise: number) => barrel(m, along, a0, a1, b0, b1, eave, rise, BRICK, ROOF);

  // The back shed, tall, along the back: its three loading doors, each
  // under an arched hood breaking its eaves, a lamp in each arch.
  shed("x", -OUTER, OUTER, -1.97, BACK, BACK_EAVE, BACK_RISE);
  const back: Wall = { face: "+y", at: BACK };
  for (const x of [-0.5, 0, 0.5]) {
    shutter(m, back, x, 0.26, 0.18, SHUTTER, TRIM);
    put(m, "matte", plate(back, x - 0.15, x - 0.13, 0, 0.2, 0, 0.03).add(plate(back, x + 0.13, x + 0.15, 0, 0.2, 0, 0.03)), TRIM);
    put(m, "zinc", halfRound(back, x, 0.2, 0.15, 0, 0.06, false, 10).subtract(halfRound(back, x, 0.2, 0.13, -0.01, 0.07, false, 10)).add(halfRound(back, x, 0.2, 0.13, 0, 0.004, false, 10)), BRICK);
    put(m, "matte", halfRound(back, x, 0.2, 0.17, 0.0, 0.065, false, 10).subtract(halfRound(back, x, 0.2, 0.15, -0.01, 0.08, false, 10)).subtract(plate(back, x - 0.3, x + 0.3, 0, 0.2, -0.1, 0.1)), TRIM);
    put(m, "glass", plate(back, x - 0.012, x + 0.012, 0.27, 0.295, 0, 0.02), LAMP);
    put(m, "matte", box(x - 0.035, x + 0.035, -1.88, -1.81, BACK_EAVE + BACK_RISE - 0.03, BACK_EAVE + BACK_RISE + 0.035), TRIM);
  }
  for (const end of [{ face: "-x", at: -OUTER }, { face: "+x", at: OUTER }] as Wall[]) arched(m, end, -1.97, BACK, BACK_EAVE, BACK_RISE);

  // A wing down either side: its doors to the bays; at its end to the
  // yard, a round window over two arched ones, the arch in cream.
  for (const s of [-1, 1]) {
    const [b0, b1] = s > 0 ? [INNER, OUTER] : [-OUTER, -INNER];
    shed("y", BACK - 0.02, FRONT, b0, b1, WING_EAVE, WING_RISE);
    for (const y of [-1.25, -0.62]) shutter(m, { face: s > 0 ? "-x" : "+x", at: s * INNER }, y, 0.22, 0.15, SHUTTER, TRIM);
    const end: Wall = { face: "+y", at: FRONT };
    arched(m, end, b0, b1, WING_EAVE, WING_RISE);
    const mid = (b0 + b1) / 2;
    oculus(m, end, mid, WING_EAVE + 0.06, 0.04, TRIM);
    for (const d of [-1, 1]) window(m, end, mid + d * 0.13, 0.06, { w: 0.07, h: 0.07, arch: true, frame: TRIM });
    door(m, end, mid, DOOR, { w: 0.07, h: 0.15, frame: TRIM });
    put(m, "matte", plate(end, b0, b1, 0, 0.025, 0, 0.012), TRIM);
    for (const y of [-1.45, -1.05, -0.65, -0.25]) rooflight(m, s, y);
  }

  // The gantry over the bays: a leg either side, splayed, a beam across,
  // its trolley and the hook hanging from it.
  const [gy, top, leg] = [-1.0, 0.46, 0.7];
  put(m, "matte", Solid.union([
    ...[-1, 1].map((s) => hull([[s * leg - 0.015, gy - 0.16, 0], [s * leg + 0.015, gy - 0.16, 0], [s * leg - 0.015, gy + 0.16, 0], [s * leg + 0.015, gy + 0.16, 0], [s * leg - 0.015, gy - 0.02, top], [s * leg + 0.015, gy - 0.02, top], [s * leg - 0.015, gy + 0.02, top], [s * leg + 0.015, gy + 0.02, top]])
      .subtract(hull([[s * leg - 0.03, gy - 0.12, -0.01], [s * leg + 0.03, gy - 0.12, -0.01], [s * leg - 0.03, gy + 0.12, -0.01], [s * leg + 0.03, gy + 0.12, -0.01], [s * leg - 0.03, gy, top - 0.08], [s * leg + 0.03, gy, top - 0.08]]))),
    box(-leg - 0.03, leg + 0.03, gy - 0.025, gy + 0.025, top, top + 0.045),
    box(0.12, 0.24, gy - 0.04, gy + 0.04, top + 0.045, top + 0.085),
    box(0.15, 0.21, gy - 0.035, gy + 0.035, top - 0.03, top),
  ]), CRANE);
  put(m, "matte", box(0.177, 0.183, gy - 0.003, gy + 0.003, 0.3, top - 0.03), CABLE);
  put(m, "matte", box(0.14, 0.22, gy - 0.05, gy + 0.05, 0.285, 0.3), CRANE);

  // The yard's fence, down its sides and along its front, open at the gate.
  const [fx, fy, gate] = [1.45, 1.87, 0.5];
  for (const s of [-1, 1]) fence(m, [[s * fx, FRONT + 0.05], [s * fx, fy], [s * gate, fy]], FENCE);
});
