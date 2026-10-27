import type { Manifold, Vec3 } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import type { RGB } from "../rgb";
import type { PropKind } from "../town/roof";
import { mesh, Solid, solids } from "../solid";
import { shape, type Shape } from "./sea";

/**
 * What a building modelled whole is built of: the parts every model has,
 * each a function of where and how big, so a model reads as a list of
 * what stands on its plot. Geometry alone, and no engine: how each finish
 * looks is `finishes.ts`'s, so a model can be drawn as well by a script
 * (`bun run model`) as by the game.
 *
 * A model's frame: its plot's middle at the origin, the street at +y, its
 * ground at z = 0; one unit a tile. Every triangle wound clockwise seen
 * from outside, as the town's are (`solid.ts`'s `mesh`).
 *
 * - Bodies: a box, a barn (walls and gable ends), a barrel shed.
 * - Roofs over them: pitched (tiles, zinc, or boards ribbed), hipped, a
 *   lean-to off a wall, all `over` past the walls.
 * - On a wall: windows, doors, roller shutters, an awning, a sign.
 * - Round the plot: fences and their gates, hedges, flowers, lamps that
 *   light at night and smoke from chimneys (the town's props, `props.ts`),
 *   trees (the town's, `trees.ts`), and the ground itself in the town's
 *   own finishes: its grass, its paving, earth, dust, the rock of the
 *   mountains.
 */

export type V = Vec3;
export type P = [number, number];
export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];

/** What a model's parts are made in; each finish a bucket of its own,
 *  drawn in its own coat (`finishes.ts`). Ground finishes lie flat, mapped
 *  by how far inside their outline (`ground`). */
export const FINISHES = ["matte", "zinc", "tiles", "glass", "bark", "leaves", "rock", "gravel", "chips", "lawn", "paving", "earth", "dust"] as const;
export type Finish = (typeof FINISHES)[number];
export const FLAT: ReadonlySet<Finish> = new Set(["lawn", "paving", "earth", "dust"]);

/** One of the town's props a model puts up (`props.ts`), in its frame. */
export interface ModelProp {
  kind: PropKind;
  at: V;
  size: number;
  high: number;
  /** Where a lamp's head hangs, a dish faces. */
  to?: P;
}

/** A model being built: its parts by finish, its props, its trees. */
export interface Model {
  parts: Partial<Record<Finish, [MeshGeometry, [number, number, number], RGB][]>>;
  props: ModelProp[];
  /** `[x, y, scale]`, the town's own trees. */
  trees: [number, number, number][];
}
/** A model built: a shape a finish. */
export interface Built {
  finishes: Partial<Record<Finish, Shape>>;
  props: ModelProp[];
  trees: [number, number, number][];
}

/** A model, built by `build` and every solid it made let go. */
export const model = (build: (m: Model) => void): Built =>
  solids(() => {
    const m: Model = { parts: {}, props: [], trees: [] };
    build(m);
    return {
      finishes: Object.fromEntries(Object.entries(m.parts).map(([k, parts]) => [k, shape(parts)])),
      props: m.props,
      trees: m.trees,
    };
  });

/** Something in a finish and a colour: a solid, faced flat; or a mesh as
 *  it is. Glass is its own finish whatever it is put in. */
export function put(m: Model, finish: Finish, it: Manifold | MeshGeometry, rgb: RGB) {
  (m.parts[finish] ??= []).push(["positions" in it ? it : mesh(it), [0, 0, 0], rgb]);
}

// --- Solids ---------------------------------------------------------------

/** A box from corner to corner. */
export const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  Solid.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
/** The solid round some points. */
export const hull = (points: V[]) => Solid.hull(points);
/** A sheet `t` thick on the parallelogram from `o` along `u` and `v`,
 *  up, or out the way `out` is. */
export const sheet = (o: V, u: V, v: V, t: number, out: V = [0, 0, 1]) => {
  const up = scale(out, t);
  return hull([o, add(o, u), add(o, v), add(add(o, u), v)].flatMap((p) => [p, add(p, up)]));
};
/** A rod from `a` to `b`, `w` square. */
export const rod = (a: V, b: V, w: number) => hull([a, b].flatMap(([x, y, z]): V[] => [[x - w / 2, y - w / 2, z - w / 2], [x + w / 2, y + w / 2, z + w / 2], [x - w / 2, y + w / 2, z], [x + w / 2, y - w / 2, z]]));
/** A cylinder standing at (x, y) from `z`, `h` high, `r` round. */
export const post = (x: number, y: number, z: number, h: number, r: number, sides = 12) => Solid.cylinder(h, r, r, sides).translate([x, y, z]);
/** A cylinder lying along x or y, its middle at `at`. */
export const lying = (at: V, r: number, l: number, along: "x" | "y", sides = 14) =>
  Solid.cylinder(l, r, r, sides).translate([0, 0, -l / 2]).rotate(along === "x" ? [0, 90, 0] : [90, 0, 0]).translate(at);

/** A body under a pitched roof: walls up to `eave`, gable ends up to
 *  `ridge`, its ridge along x or y at `ridgeAt` across (the middle, unless
 *  one slope is longer). */
export function barn(along: "x" | "y", x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, ridgeAt?: number) {
  if (along === "x") {
    const r = ridgeAt ?? (y0 + y1) / 2;
    return hull([x0, x1].flatMap((x): V[] => [[x, y0, 0], [x, y1, 0], [x, y0, eave], [x, y1, eave], [x, r, ridge]]));
  }
  const r = ridgeAt ?? (x0 + x1) / 2;
  return hull([y0, y1].flatMap((y): V[] => [[x0, y, 0], [x1, y, 0], [x0, y, eave], [x1, y, eave], [r, y, ridge]]));
}

// --- Roofs ----------------------------------------------------------------

/** A tiled roof's courses: how tall one is up the roof (`finishes.ts`). */
export const COURSE = 0.022;
/** Corrugated sheet's waves, a wave this far across. */
export const PITCH = 0.05;

/** How a roof is covered: tiles; zinc golfplaat; or boards, a sheet with
 *  ribs down it in a second colour, `ribs` to a unit across. */
export type Cover = { finish: "tiles"; rgb: RGB } | { finish: "zinc"; rgb: RGB } | { finish: "matte"; rgb: RGB; ribs: number; rib: RGB };

/** A sheet of roof from `o` along `u` (across the slope) and `v` (down
 *  it), covered as `cover` says. */
export function slope(m: Model, o: V, u: V, v: V, cover: Cover, t = 0.016) {
  if (cover.finish === "tiles") return put(m, "tiles", mesh(sheet(o, u, v, t), (p) => [p[2] / COURSE, (p[0] + p[1]) / (COURSE * 1.4)]), cover.rgb);
  if (cover.finish === "zinc") return put(m, "zinc", golf(o, u, v, t), cover.rgb);
  put(m, "matte", sheet(o, u, v, t), cover.rgb);
  const across = Math.hypot(...u), n = Math.max(1, Math.round(across * cover.ribs));
  const half = scale(u, 0.006 / across);
  put(m, "matte", Solid.union(Array.from({ length: n }, (_, k) => sheet(add(add(o, scale(u, (k + 0.5) / n)), add(scale(half, -1), [0, 0, t])), scale(half, 2), v, 0.008))), cover.rib);
}

/** A pitched roof over a barn's walls (`barn`), its two slopes `over`
 *  past them at the eaves and the gable ends; and a ridge cap. */
export function pitched(m: Model, along: "x" | "y", x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, cover: Cover, { over = 0.04, ridgeAt }: { over?: number; ridgeAt?: number } = {}) {
  const lift = (run: number) => (ridge - eave) * (1 + over / run);
  if (along === "x") {
    const r = ridgeAt ?? (y0 + y1) / 2;
    for (const run of [y1 - r, y0 - r]) slope(m, [x0 - over, r, ridge], [x1 - x0 + 2 * over, 0, 0], [0, run + Math.sign(run) * over, -lift(Math.abs(run))], cover);
  } else {
    const r = ridgeAt ?? (x0 + x1) / 2;
    for (const run of [x1 - r, x0 - r]) slope(m, [r, y0 - over, ridge], [0, y1 - y0 + 2 * over, 0], [run + Math.sign(run) * over, 0, -lift(Math.abs(run))], cover);
  }
}

/** A hipped roof over a box's walls, `over` past them: four slopes up to
 *  a ridge along its longer side, as deep in as the shorter is half. */
export function hipped(m: Model, x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, cover: Cover, over = 0.04) {
  const [a0, a1, b0, b1] = [x0 - over, x1 + over, y0 - over, y1 + over];
  const drop = over * ((ridge - eave) / (Math.min(x1 - x0, y1 - y0) / 2));
  const run = Math.min(a1 - a0, b1 - b0) / 2;
  const [rx0, rx1, ry0, ry1] = a1 - a0 >= b1 - b0 ? [a0 + run, a1 - run, (b0 + b1) / 2, (b0 + b1) / 2] : [(a0 + a1) / 2, (a0 + a1) / 2, b0 + run, b1 - run];
  const z = eave - drop;
  const solid = hull([[a0, b0, z], [a1, b0, z], [a0, b1, z], [a1, b1, z], ...([[a0, b0], [a1, b0], [a0, b1], [a1, b1]] as P[]).map(([x, y]): V => [x, y, z + 0.018]), [rx0, ry0, ridge], [rx1, ry1, ridge]]);
  put(m, cover.finish === "tiles" ? "tiles" : "matte", cover.finish === "tiles" ? mesh(solid, (p) => [p[2] / COURSE, (p[0] + p[1]) / (COURSE * 1.4)]) : solid, cover.rgb);
}

/** A zinc sheet `t` thick on the parallelogram from `o` along `u` and
 *  `v`, up or out the way `out` is, its waves running down `v`: mapped by
 *  how many waves across `u`. */
export const golf = (o: V, u: V, v: V, t: number, out: V = [0, 0, 1]) => {
  const across = Math.hypot(...u);
  return mesh(sheet(o, u, v, t, out), (p) => [((p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2]) / across / PITCH, 0]);
};

/** Round a barrel roof: this many strips over it. */
const STAVES = 12;
/**
 * A shed with a barrel roof, its ridge along `along`, from `a0` to `a1`
 * along it and `b0` to `b1` across: its walls, `eave` high, their ends
 * arched up to `eave + rise`; and its roof, zinc, the arch over them, `over`
 * past the ends, its waves running over it, smooth.
 */
export function barrel(m: Model, along: "x" | "y", a0: number, a1: number, b0: number, b1: number, eave: number, rise: number, wall: RGB, zinc: RGB, over = 0.03) {
  const at = (a: number, b: number, z: number): V => (along === "x" ? [a, b, z] : [b, a, z]);
  const arch = (k: number, out: number) => {
    const t = Math.PI * (k / STAVES);
    const [half, mid] = [(b1 - b0) / 2 + out, (b0 + b1) / 2];
    return [mid - Math.cos(t) * half, eave + Math.sin(t) * (rise + out)];
  };
  put(m, "matte", hull([a0, a1].flatMap((a) => [at(a, b0, 0), at(a, b1, 0), ...Array.from({ length: STAVES + 1 }, (_, k) => at(a, ...(arch(k, 0) as [number, number])))])), wall);
  const roof: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const half = (b1 - b0) / 2;
  for (let k = 0; k <= STAVES; k++)
    for (const a of [a0 - over, a1 + over]) {
      const [b, z] = arch(k, 0.008);
      const t = Math.PI * (k / STAVES);
      // The ellipse's facing, across and up.
      const [nb, nz] = [-Math.cos(t) / half, Math.sin(t) / rise];
      const l = Math.hypot(nb, nz);
      roof.positions.push(...at(a, b, z));
      roof.normals.push(...at(0, nb / l, nz / l));
      roof.uvs!.push((a - a0) / PITCH, 0);
    }
  // Clockwise from outside, whichever way it runs: y along is x along seen
  // in a mirror.
  for (let k = 0; k < STAVES; k++) {
    const [p, q, r, s] = [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3];
    roof.indices.push(...(along === "x" ? [p, r, q, q, r, s] : [p, q, r, q, s, r]));
  }
  put(m, "zinc", roof, zinc);
}

// --- On a wall ------------------------------------------------------------

/** A wall: the way it faces, and where its face is, across that way. */
export type Wall = { face: "+x" | "-x" | "+y" | "-y"; at: number };
/** A point on a wall: `along` it (x for a wall facing ±y, y for ±x), `up`,
 *  and `out` from its face. */
export const on = ({ face, at }: Wall, along: number, up: number, out = 0): V => {
  const o = at + (face[0] === "+" ? out : -out);
  return face[1] === "y" ? [along, o, up] : [o, along, up];
};
/** A plate on a wall from `a0` to `a1` along it, `z0` to `z1` up, `o0`
 *  to `o1` out from its face (into it, below 0). */
export const plate = (w: Wall, a0: number, a1: number, z0: number, z1: number, o0: number, o1: number) => {
  const [p, q] = [on(w, a0, z0, o0), on(w, a1, z1, o1)];
  return box(Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1]), z0, z1);
};

/** A half disc on a wall, round (`at`, `z`), `r` out, up (or down) from
 *  there, `o0` to `o1` out from its face: an arch's top, a scallop. */
export const halfRound = (w: Wall, at: number, z: number, r: number, o0: number, o1: number, down = false, n = 10) =>
  hull([o0, o1].flatMap((o) => Array.from({ length: n + 1 }, (_, k) => on(w, at + r * Math.cos((Math.PI * k) / n), z + (down ? -1 : 1) * r * Math.sin((Math.PI * k) / n), o))));

/** Glass, dark by day and lit from inside at night, whatever the model. */
export const PANE: RGB = [0.24, 0.29, 0.36];

/** A window on a wall, its middle `at` along it, its sill at `z`, `w`
 *  across and `h` high: its frame, its pane set back, its glazing bars
 *  (`bars` across, one up the middle if it is wide); a sill under it;
 *  and, if given, shutters either side and a box of flowers on its sill. */
export function window(m: Model, wall: Wall, at: number, z: number, { w = 0.06, h = 0.07, frame = [0.95, 0.92, 0.86] as RGB, bars = 1, shutters, box: flowers, arch = false }: { w?: number; h?: number; frame?: RGB; bars?: number; shutters?: RGB; box?: RGB; arch?: boolean } = {}) {
  const f = 0.01;
  const outer = plate(wall, at - w / 2 - f, at + w / 2 + f, z - f, z + h + (arch ? 0 : f), -0.004, 0.006);
  const inner = plate(wall, at - w / 2, at + w / 2, z, z + h + (arch ? 0.001 : 0), -0.002, 0.01);
  put(m, "matte", (arch ? outer.add(halfRound(wall, at, z + h, w / 2 + f, -0.004, 0.006)) : outer).subtract(arch ? inner.add(halfRound(wall, at, z + h, w / 2, -0.002, 0.01)) : inner), frame);
  put(m, "glass", arch ? plate(wall, at - w / 2, at + w / 2, z, z + h, -0.004, 0.002).add(halfRound(wall, at, z + h, w / 2, -0.004, 0.002)) : plate(wall, at - w / 2, at + w / 2, z, z + h, -0.004, 0.002), PANE);
  const glazing = [...Array.from({ length: bars }, (_, k) => plate(wall, at - w / 2, at + w / 2, z + (h * (k + 1)) / (bars + 1) - 0.002, z + (h * (k + 1)) / (bars + 1) + 0.002, -0.002, 0.004))];
  if (w > 0.045) glazing.push(plate(wall, at - 0.002, at + 0.002, z, z + h, -0.002, 0.004));
  if (glazing.length) put(m, "matte", Solid.union(glazing), frame);
  put(m, "matte", plate(wall, at - w / 2 - f - 0.004, at + w / 2 + f + 0.004, z - f - 0.006, z - f, -0.004, 0.016), frame);
  if (shutters) for (const s of [-1, 1]) put(m, "matte", plate(wall, at + s * (w / 2 + f + 0.002), at + s * (w / 2 + f + 0.002 + w * 0.42), z - 0.004, z + h + 0.004, 0, 0.006), shutters);
  if (flowers) {
    put(m, "matte", plate(wall, at - w / 2, at + w / 2, z - f - 0.02, z - f + 0.004, 0.004, 0.03), flowers);
    blooms(m, Array.from({ length: 5 }, (_, k): V => on(wall, at - w / 2 + 0.008 + ((w - 0.016) * k) / 4, z - f + 0.012, 0.017)), 0.011);
  }
}

/** A round window on a wall, its middle `at` along it and `z` up, `r`
 *  round: a ring of frame, its pane, a bar across. */
export function oculus(m: Model, wall: Wall, at: number, z: number, r: number, frame: RGB = [0.95, 0.92, 0.86]) {
  const disc = (rr: number, o0: number, o1: number) => halfRound(wall, at, z, rr, o0, o1, false, 12).add(halfRound(wall, at, z, rr, o0, o1, true, 12));
  put(m, "matte", disc(r + 0.01, -0.004, 0.007).subtract(disc(r, -0.002, 0.01)), frame);
  put(m, "glass", disc(r, -0.004, 0.002), PANE);
  put(m, "matte", plate(wall, at - r, at + r, z - 0.002, z + 0.002, -0.002, 0.004), frame);
}

/** A door on a wall, its middle `at` along it: its frame, its leaf (`w`
 *  across, `h` high), its handle; a step out front; and, if given, a
 *  little roof over it on brackets. */
export function door(m: Model, wall: Wall, at: number, rgb: RGB, { w = 0.07, h = 0.15, frame = [0.95, 0.92, 0.86] as RGB, z = 0, hood, step = true, arch = false }: { w?: number; h?: number; frame?: RGB; z?: number; hood?: Cover; step?: boolean; arch?: boolean } = {}) {
  // An arched door's leaf rises to `h`, its fanlight over it in the arch.
  const top = arch ? h - w / 2 : h;
  const outer = plate(wall, at - w / 2 - 0.01, at + w / 2 + 0.01, z, z + top + (arch ? 0 : 0.01), -0.004, 0.006);
  const inner = plate(wall, at - w / 2, at + w / 2, z - 0.01, z + top + 0.001, -0.002, 0.01);
  put(m, "matte", (arch ? outer.add(halfRound(wall, at, z + top, w / 2 + 0.01, -0.004, 0.006)) : outer).subtract(arch ? inner.add(halfRound(wall, at, z + top, w / 2, -0.002, 0.01)) : inner), frame);
  put(m, "matte", plate(wall, at - w / 2, at + w / 2, z, z + top, -0.004, 0.003), rgb);
  if (arch) put(m, "glass", halfRound(wall, at, z + top, w / 2, -0.004, 0.002), PANE);
  else put(m, "glass", plate(wall, at - w * 0.3, at + w * 0.3, z + h * 0.62, z + h * 0.9, 0, 0.0035), PANE);
  put(m, "matte", plate(wall, at + w * 0.3, at + w * 0.38, z + h * 0.45, z + h * 0.5, 0, 0.008), [0.85, 0.72, 0.38]);
  if (step && z === 0) put(m, "matte", plate(wall, at - w / 2 - 0.015, at + w / 2 + 0.015, 0, 0.012, 0, 0.035), [0.78, 0.75, 0.7]);
  if (hood) leanTo(m, wall, at - w / 2 - 0.03, at + w / 2 + 0.03, z + h + 0.035, 0.07, 0.025, hood);
}

/** A roller shutter on a wall, its middle `at` along it, `w` across and
 *  `h` high: zinc slats across it, a box over it. */
export function shutter(m: Model, wall: Wall, at: number, w: number, h: number, rgb: RGB, trim: RGB) {
  const s = wall.face[0] === "+" ? 1 : -1;
  const [a, b] = [on(wall, at - w / 2, 0, 0.004), on(wall, at + w / 2, 0, 0.004)];
  const out: V = wall.face[1] === "y" ? [0, s, 0] : [s, 0, 0];
  put(m, "zinc", golf(a, [0, 0, h], [b[0] - a[0], b[1] - a[1], 0], 0.006, out), rgb);
  put(m, "matte", plate(wall, at - w / 2 - 0.015, at + w / 2 + 0.015, h, h + 0.025, -0.002, 0.016), trim);
}

/** A roof sloping out from a wall, from `a0` to `a1` along it, hung at
 *  `z`, `depth` out and dropping `drop` to its edge: a porch's, a
 *  canopy's, a shed's lean-to. */
export const leanTo = (m: Model, wall: Wall, a0: number, a1: number, z: number, depth: number, drop: number, cover: Cover) => {
  const o = on(wall, a0, z, 0);
  const u = add(on(wall, a1, z, 0), scale(o, -1));
  const v = add(on(wall, a0, z - drop, depth), scale(o, -1));
  slope(m, o, u, v, cover, 0.012);
};

/** A little gabled roof out from a wall, over a door or a dormer's
 *  window: its ridge straight out from the wall, `rise` over its eaves
 *  at `z`, `w` across and `depth` out, `over` past them; and the gable's
 *  triangle filled in, if a colour is given, at its open end. */
export function gablet(m: Model, wall: Wall, at: number, z: number, w: number, depth: number, rise: number, cover: Cover, infill?: RGB, over = 0.015) {
  const top = on(wall, at, z + rise, -0.005);
  const out = add(on(wall, at, z + rise, depth + over), scale(top, -1));
  for (const s of [-1, 1]) slope(m, top, out, add(on(wall, at + s * (w / 2 + over), z - (over * rise) / (w / 2), -0.005), scale(top, -1)), cover, 0.012);
  if (infill) put(m, "matte", hull([0, depth].flatMap((o) => [on(wall, at - w / 2, z, o), on(wall, at + w / 2, z, o), on(wall, at, z + rise, o)])), infill);
}

/** A dormer in a roof, its face on `wall`, its middle `at` along it: a
 *  box back into the roof `back` deep, a gablet over it, and its window,
 *  its sill at `sill`, `w` across and `h` high. */
export function dormer(m: Model, wall: Wall, at: number, sill: number, rgb: RGB, cover: Cover, { w = 0.06, h = 0.06, back = 0.14, frame = [0.95, 0.92, 0.86] as RGB, box: flowers }: { w?: number; h?: number; back?: number; frame?: RGB; box?: RGB } = {}) {
  const [half, top] = [w / 2 + 0.025, sill + h + 0.02];
  put(m, "matte", plate(wall, at - half, at + half, sill - 0.04, top, -back, 0), rgb);
  const behind: Wall = { face: wall.face, at: wall.at + (wall.face[0] === "+" ? -back : back) };
  gablet(m, behind, at, top, 2 * half, back + 0.01, half * 0.9, cover, rgb);
  window(m, wall, at, sill, { w, h, frame, box: flowers });
}

/** An awning over a wall from `a0` to `a1` along it, hung at `z`, out
 *  `depth` and dropping `drop`: canvas in stripes of `colours` by turns,
 *  its front edge a valance. */
export function awning(m: Model, wall: Wall, a0: number, a1: number, z: number, colours: RGB[], { depth = 0.1, drop = 0.045, stripes = 7, scallops = false } = {}) {
  for (let k = 0; k < stripes; k++) {
    const [s0, s1] = [a0 + ((a1 - a0) * k) / stripes, a0 + ((a1 - a0) * (k + 1)) / stripes];
    const o = on(wall, s0, z, 0);
    const rgb = colours[k % colours.length];
    put(m, "matte", sheet(o, add(on(wall, s1, z, 0), scale(o, -1)), add(on(wall, s0, z - drop, depth), scale(o, -1)), 0.006), rgb);
    const valance = plate(wall, s0, s1, z - drop - 0.018, z - drop, depth - 0.004, depth);
    // Its valance's foot rounded off, a scallop a stripe.
    put(m, "matte", scallops ? valance.add(halfRound(wall, (s0 + s1) / 2, z - drop - 0.018, (s1 - s0) / 2, depth - 0.004, depth, true, 8)) : valance, rgb);
  }
}

/** A sign on a wall, its middle `at` along it, `w` across and `h` high
 *  from `z`: a board in a frame. */
export const sign = (m: Model, wall: Wall, at: number, z: number, w: number, h: number, board: RGB, frame: RGB) => {
  put(m, "matte", plate(wall, at - w / 2 - 0.006, at + w / 2 + 0.006, z - 0.006, z + h + 0.006, 0, 0.008), frame);
  put(m, "matte", plate(wall, at - w / 2, at + w / 2, z, z + h, 0.004, 0.011), board);
};

// --- Up from the roof -----------------------------------------------------

/** A chimney stack from the ground at (x, y), `w` square, up to `top`, a
 *  cap round its top; smoking, if the hearth is lit. */
export function chimney(m: Model, x: number, y: number, top: number, rgb: RGB, { w = 0.06, smoke = 0 } = {}) {
  put(m, "matte", box(x - w / 2, x + w / 2, y - w / 2, y + w / 2, 0, top).add(box(x - w / 2 - 0.008, x + w / 2 + 0.008, y - w / 2 - 0.008, y + w / 2 + 0.008, top - 0.025, top)), rgb);
  put(m, "matte", post(x, y, top, 0.022, w * 0.26, 10).subtract(post(x, y, top + 0.006, 0.03, w * 0.17, 10)), [0.32, 0.3, 0.3]);
  if (smoke) m.props.push({ kind: "smoke", at: [x, y, top], size: smoke, high: 0 });
}

// --- Round the plot -------------------------------------------------------

/** How tall a fence stands, and how far apart its posts are, by kind. */
const FENCES = { rail: { h: 0.09, every: 0.2, rails: [0.03, 0.065] }, picket: { h: 0.07, every: 0.035, rails: [0.03] }, mesh: { h: 0.11, every: 0.25, rails: [0.03, 0.1] } } as const;
/** A fence along a path: posts and rails, or white pickets close set, or
 *  a yard's, tall and thin. */
export function fence(m: Model, path: P[], rgb: RGB, kind: keyof typeof FENCES = "rail") {
  const { h, every, rails } = FENCES[kind];
  const t = kind === "picket" ? 0.008 : 0.009;
  const solids: Manifold[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [[x0, y0], [x1, y1]] = [path[i], path[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / every));
    for (const z of rails) solids.push(rod([x0, y0, z + 0.006], [x1, y1, z + 0.006], 0.011));
    for (let k = i ? 1 : 0; k <= n; k++) {
      const [x, y] = [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n];
      solids.push(kind === "picket" ? hull([[x - t, y - t, 0], [x + t, y + t, 0], [x - t, y + t, h - 0.012], [x + t, y - t, h - 0.012], [x, y, h]]) : box(x - t, x + t, y - t, y + t, 0, h));
    }
  }
  put(m, "matte", Solid.union(solids), rgb);
}

/** A gate's leaf `w` long, hung at (x, y), swung `a` degrees from +x: its
 *  frame and its brace. */
export const gate = (m: Model, x: number, y: number, w: number, a: number, rgb: RGB) =>
  put(m, "matte", Solid.union([
    box(0, w, -0.006, 0.006, 0.02, 0.032), box(0, w, -0.006, 0.006, 0.075, 0.087),
    box(0, 0.014, -0.006, 0.006, 0.02, 0.087), box(w - 0.014, w, -0.006, 0.006, 0.02, 0.087),
    rod([0.012, 0, 0.032], [w - 0.012, 0, 0.078], 0.01),
  ]).rotate([0, 0, a]).translate([x, y, 0]), rgb);

/** A hedge's green, as the town's round its gardens (`town/draw.ts`). */
export const HEDGE: RGB = [0.29, 0.43, 0.24];
/** A hedge along a path, `h` high and `t` thick: a long block, its top's
 *  edges rounded off, its leaves in the light (`leaves`). */
export function hedge(m: Model, path: P[], { h = 0.1, t = 0.08, rgb = HEDGE }: { h?: number; t?: number; rgb?: RGB } = {}) {
  const r = Math.min(0.025, t / 3);
  for (let i = 0; i + 1 < path.length; i++) {
    const [[x0, y0], [x1, y1]] = [path[i], path[i + 1]];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const [ex, ey] = [(x1 - x0) / len, (y1 - y0) / len];
    // Its section across, out each side from its line and up, carried
    // past its ends half its thickness so corners close.
    const ring: P[] = [[-t / 2, 0], [-t / 2, h - r], [-t / 2 + r, h], [t / 2 - r, h], [t / 2, h - r], [t / 2, 0]];
    const ends: P[] = [[x0 - (ex * t) / 2, y0 - (ey * t) / 2], [x1 + (ex * t) / 2, y1 + (ey * t) / 2]];
    put(m, "leaves", hull(ends.flatMap(([x, y]) => ring.map(([o, z]): V => [x - ey * o, y + ex * o, z]))), rgb);
  }
}

/** A shrub at (x, y), `r` round: a few leafy lumps. */
export const shrub = (m: Model, x: number, y: number, r: number, rgb: RGB = HEDGE, seed = 1) =>
  put(m, "leaves", Solid.union([0, 1, 2].map((k) => {
    const t = seed * 2.1 + k * 2.09, d = k ? r * 0.45 : 0;
    return Solid.sphere(r * (k ? 0.75 : 1), 12).scale([1, 1, 0.85]).translate([x + Math.cos(t) * d, y + Math.sin(t) * d, r * 0.8]);
  })), rgb);
/** A tree in a tub at (x, y): a terracotta pot, its stem, a clipped ball
 *  of leaves `r` round. */
export function topiary(m: Model, x: number, y: number, r: number, pot: RGB = [0.66, 0.4, 0.28]) {
  put(m, "matte", Solid.cylinder(r * 0.8, r * 0.5, r * 0.68, 14).translate([x, y, 0]).add(post(x, y, r * 0.72, r * 0.12, r * 0.72, 14)), pot);
  put(m, "matte", post(x, y, r * 0.8, r * 0.7, r * 0.08, 6), [0.4, 0.3, 0.22]);
  put(m, "leaves", Solid.sphere(r, 16).translate([x, y, r * 1.35 + r]), HEDGE);
}
/** A little conifer at (x, y), `r` round at its foot and `h` high. */
export const cone = (m: Model, x: number, y: number, r: number, h: number, rgb: RGB = [0.22, 0.38, 0.27]) => put(m, "leaves", Solid.cylinder(h, r, 0.004, 12).translate([x, y, 0]), rgb);

/** Flowers: a few soft colours, never loud. */
export const BLOOMS: RGB[] = [[0.9, 0.5, 0.52], [0.95, 0.85, 0.5], [0.92, 0.9, 0.88], [0.7, 0.55, 0.8]];
/** Flower heads at points, `r` round, the colours taken in turn. */
export function blooms(m: Model, at: V[], r = 0.012) {
  for (const [k, rgb] of BLOOMS.entries()) {
    const mine = at.filter((_, j) => (j * 7 + 3) % BLOOMS.length === k);
    if (mine.length) put(m, "matte", Solid.union(mine.map((p) => Solid.sphere(r, 6).translate(p))), rgb);
  }
}
/** A bed of flowers round (x, y), `spread` out: leaves under small heads. */
export function flowers(m: Model, x: number, y: number, n: number, spread: number) {
  put(m, "leaves", Solid.sphere(spread, 12).scale([1, 0.8, 0.25]).translate([x, y, 0.004]), [0.36, 0.52, 0.3]);
  blooms(m, Array.from({ length: n * 4 }, (_, j): V => {
    const t = j * 2.39996, d = spread * 0.9 * Math.sqrt((j + 0.5) / (n * 4));
    return [x + Math.cos(t) * d, y + Math.sin(t) * d * 0.8, 0.022 + 0.008 * ((j * 5) % 3)];
  }));
}

/** A street lamp at (x, y), its head out over `to`: the town's, lit at
 *  night (`props.ts`). */
export const lamp = (m: Model, x: number, y: number, to: P, z = 0) => m.props.push({ kind: "lamp", at: [x, y, z], size: 0, high: 0, to });
/** One of the town's trees at (x, y), `scale` of a forest tree's. */
export const tree = (m: Model, x: number, y: number, scale: number) => m.trees.push([x, y, scale]);

/** A bench at (x, y), along x or y: its seat, back and legs. */
export function bench(m: Model, x: number, y: number, along: "x" | "y", rgb: RGB, iron: RGB = [0.22, 0.22, 0.24]) {
  const [l, d] = along === "x" ? [0.075, 0.025] : [0.025, 0.075];
  put(m, "matte", Solid.union([box(x - l, x + l, y - d, y + d, 0.035, 0.044), along === "x" ? box(x - l, x + l, y - d, y - d + 0.008, 0.044, 0.085) : box(x - d, x - d + 0.008, y - l, y + l, 0.044, 0.085)]), rgb);
  put(m, "matte", Solid.union([-1, 1].map((s) => (along === "x" ? box(x + s * (l - 0.012) - 0.004, x + s * (l - 0.012) + 0.004, y - d, y + d, 0, 0.035) : box(x - d, x + d, y + s * (l - 0.012) - 0.004, y + s * (l - 0.012) + 0.004, 0, 0.035)))), iron);
}

/** A crate `s` across at (x, y, z), open, `fill`ed with what it holds. */
export function crate(m: Model, x: number, y: number, z: number, s: number, wood: RGB, fill?: RGB) {
  put(m, "matte", box(x - s / 2, x + s / 2, y - s / 2, y + s / 2, z, z + s * 0.7).subtract(box(x - s / 2 + 0.008, x + s / 2 - 0.008, y - s / 2 + 0.008, y + s / 2 - 0.008, z + 0.015, z + s)), wood);
  if (fill) put(m, "matte", Solid.union([0, 1, 2, 3].map((k) => Solid.sphere(s * 0.24, 8).translate([x + (k % 2 ? 0.2 : -0.2) * s, y + (k < 2 ? 0.2 : -0.2) * s, z + s * 0.55]))), fill);
}

/** A barrel standing at (x, y): staves, two hoops. */
export function cask(m: Model, x: number, y: number, r: number, h: number, wood: RGB, hoop: RGB = [0.32, 0.33, 0.36]) {
  put(m, "matte", Solid.cylinder(h / 2, r * 0.88, r, 14).translate([x, y, 0]).add(Solid.cylinder(h / 2, r, r * 0.88, 14).translate([x, y, h / 2])), wood);
  put(m, "matte", Solid.union([0.2, 0.8].map((k) => post(x, y, h * k - 0.004, 0.008, r * (k === 0.5 ? 1 : 0.97) + 0.003, 14))), hoop);
}

// --- The ground ------------------------------------------------------------

/** A rectangle on the ground, `[x0, x1, y0, y1]`. */
export type Rect = [number, number, number, number];
/** How fine a patch of ground is cut, so how far in each point is reads
 *  true between its corners. */
const CELL = 0.05;
/**
 * A patch of ground in one of the town's finishes, its grass, its
 * paving, earth or dust, lying `z` up: the rectangles `rects` together,
 * their corners rounded `round`. Cut in cells, each corner mapped by how
 * far in from the patch's edge it is, so the finish can fray its edge as
 * the land's does (`finishes.ts`); a little past the edge, so there is
 * edge to fray.
 */
export function ground(m: Model, finish: "lawn" | "paving" | "earth" | "dust", rects: Rect[], rgb: RGB, { z = 0.02, round = 0 }: { z?: number; round?: number } = {}) {
  /** How far in from the edge of the rectangles together: the most inside any. */
  const inside = (x: number, y: number) =>
    Math.max(...rects.map(([x0, x1, y0, y1]) => {
      const [dx, dy] = [Math.max(x0 + round - x, x - x1 + round, 0), Math.max(y0 + round - y, y - y1 + round, 0)];
      return dx || dy ? round - Math.hypot(dx, dy) : round + Math.min(x - x0 - round, x1 - round - x, y - y0 - round, y1 - round - y);
    }));
  const [x0, x1, y0, y1] = [Math.min(...rects.map((r) => r[0])), Math.max(...rects.map((r) => r[1])), Math.min(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
  const [nx, ny] = [Math.ceil((x1 - x0) / CELL), Math.ceil((y1 - y0) / CELL)];
  const g: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const ids = new Map<number, number>();
  const at = (i: number, j: number) => {
    const key = i * (ny + 1) + j;
    let k = ids.get(key);
    if (k === undefined) {
      const [x, y] = [x0 + ((x1 - x0) * i) / nx, y0 + ((y1 - y0) * j) / ny];
      ids.set(key, (k = g.positions.length / 3));
      g.positions.push(x, y, z), g.normals.push(0, 0, 1), g.uvs!.push(inside(x, y), 0);
    }
    return k;
  };
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const [x, y] = [x0 + ((x1 - x0) * (i + 0.5)) / nx, y0 + ((y1 - y0) * (j + 0.5)) / ny];
      if (inside(x, y) < -CELL) continue;
      const [a, b, c, d] = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
      g.indices.push(a, b, d, b, c, d);
    }
  put(m, finish, g, rgb);
}

/** How far out a heap's spill reaches, of its foot's reach. */
export const SPILL = 1.45;
const RINGS = [0.2, 0.4, 0.58, 0.72, 0.84, 0.93, 1, 1.12, 1.28, SPILL];
/** A heap of something loose, gravel or chips, at (x, y), its foot `r`
 *  out and its top `h` up, on ground `z` up: lobed, lumpy, a thin spill
 *  of it round its foot out to `SPILL` of its reach, mapped by how far out
 *  it is, its edge at 1. */
export function heap(m: Model, finish: "gravel" | "chips", x: number, y: number, r: number, h: number, z: number, seed: number, rgb: RGB) {
  const segs = 28;
  const [p1, p2, p3] = [seed * 1.7, seed * 2.9, seed * 4.3];
  const reach = (t: number) => r * (1 + 0.16 * Math.sin(2 * t + p1) + 0.09 * Math.sin(3 * t + p2) + 0.05 * Math.sin(5 * t + p3));
  const rise = (f: number, t: number) => (f < 1 ? h * (1 - f * f) ** 1.4 * (1 + 0.18 * Math.sin(4 * t + p2) * f) : 0) + 0.0015;
  const out: MeshGeometry = { positions: [x, y, z + rise(0, 0)], normals: [], uvs: [0, 0], indices: [] };
  for (const f of RINGS)
    for (let k = 0; k < segs; k++) {
      const t = (2 * Math.PI * k) / segs;
      out.positions.push(x + Math.cos(t) * reach(t) * f, y + Math.sin(t) * reach(t) * f, z + rise(f, t));
      out.uvs!.push(f, 0);
    }
  const ring = (n: number, k: number) => 1 + n * segs + (k % segs);
  for (let k = 0; k < segs; k++) {
    out.indices.push(0, ring(0, k + 1), ring(0, k));
    for (let n = 0; n + 1 < RINGS.length; n++) out.indices.push(ring(n, k), ring(n, k + 1), ring(n + 1, k + 1), ring(n, k), ring(n + 1, k + 1), ring(n + 1, k));
  }
  put(m, finish, smooth(out), rgb);
}

/** A mesh's facing at each vertex, the faces' round it, by their size. */
export function smooth(g: MeshGeometry): MeshGeometry {
  const n = new Array<number>(g.positions.length).fill(0);
  const p = (i: number): V => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
    const [u, w] = [add(p(b), scale(p(a), -1)), add(p(c), scale(p(a), -1))];
    // Wound clockwise from outside: c - a across b - a faces out.
    const f: V = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    for (const i of [a, b, c]) for (let j = 0; j < 3; j++) n[i * 3 + j] += f[j];
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len, n[i + 1] /= len, n[i + 2] /= len;
  }
  return { ...g, normals: n };
}

/** A round thing standing at (x, y), `r` round and `h` high, smooth
 *  round, mapped by `waves` round it: a silo, a tank. Open at the top. */
export function drum(x: number, y: number, r: number, h: number, waves = Math.round((2 * Math.PI * r) / PITCH), z = 0): MeshGeometry {
  const sides = 28;
  const g: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let k = 0; k <= sides; k++) {
    const t = (2 * Math.PI * k) / sides;
    for (const up of [z, z + h]) g.positions.push(x + Math.cos(t) * r, y + Math.sin(t) * r, up), g.normals.push(Math.cos(t), Math.sin(t), 0), g.uvs!.push((k / sides) * waves, 0);
  }
  for (let k = 0; k < sides; k++) g.indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  return g;
}

/** A number in [-1, 1] the same for the same `k`. */
export const jitter = (k: number) => (Math.sin(k * 12.9898 + 4.1) * 43758.5453) % 1;
