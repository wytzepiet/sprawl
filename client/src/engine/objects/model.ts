import type { EngineContext, MaterialPlugin } from "@babylonjs/lite";
import type { Manifold, Vec3 } from "manifold-3d";
import { BARK_LONG, BARK_ROUND } from "../bark";
import barkRecipe from "../bark.ts?raw";
import { bakedTexture } from "../bakeCache";
import type { MeshGeometry } from "../geometry";
import { grain } from "../ground";
import { mesh, Solid } from "../solid";
import type { Shape } from "./sea";

/**
 * What a building modelled whole is made of (`sawmill.ts`, `depot.ts`):
 * its shapes, a box, a barn, a sheet of zinc, a barrel roof; and its
 * finishes, a bucket each, the material a coat on the town's.
 *
 * - Timber, brick and paint, matte.
 * - Zinc golfplaat: corrugated metal, its waves in the light alone,
 *   shading their troughs, let go where finer than the pixels.
 * - Bark, baked (`bark.ts`): its map's slopes turning the light, its
 *   furrows dark.
 * - Loose on the ground, sawdust or chips (`loose`): lumpy by the land's
 *   grain, its edge frayed by it as the grass's is (`ground.ts`).
 *
 * A map's slopes are turned along the surface by the map's own run over
 * it, read off the pixels beside (a cotangent frame).
 */

export type V = Vec3;
export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];

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
/** A roof's sheet with ribs down it, `n` of them along `u`. */
export const ribbed = (o: V, u: V, v: V, t: number, n: number, rib = 0.012): [Manifold, Manifold] => {
  const ribs = Array.from({ length: n }, (_, k) => {
    const at = add(o, scale(u, (k + 0.5) / n));
    const half = scale(u, rib / 2 / Math.hypot(...u));
    return sheet(add(add(at, scale(half, -1)), [0, 0, t]), scale(half, 2), v, 0.008);
  });
  return [sheet(o, u, v, t), Solid.union(ribs)];
};
/** A body whose ridge runs along x at y = `ridgeY`, walls to `eave`,
 *  gable ends to `ridge`. */
export const barnX = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, ridgeY = (y0 + y1) / 2) =>
  hull([x0, x1].flatMap((x): V[] => [[x, y0, 0], [x, y1, 0], [x, y0, eave], [x, y1, eave], [x, ridgeY, ridge]]));
export const barnY = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number) =>
  hull([y0, y1].flatMap((y): V[] => [[x0, y, 0], [x1, y, 0], [x0, y, eave], [x1, y, eave], [(x0 + x1) / 2, y, ridge]]));

/** Corrugated sheet's waves, a wave this far across. */
export const PITCH = 0.05;
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
export function barrel(along: "x" | "y", a0: number, a1: number, b0: number, b1: number, eave: number, rise: number, over = 0.03) {
  const at = (a: number, b: number, z: number): V => (along === "x" ? [a, b, z] : [b, a, z]);
  const arch = (k: number, out: number) => {
    const t = Math.PI * (k / STAVES);
    const [half, mid] = [(b1 - b0) / 2 + out, (b0 + b1) / 2];
    return [mid - Math.cos(t) * half, eave + Math.sin(t) * (rise + out)];
  };
  const walls = hull([a0, a1].flatMap((a) => [at(a, b0, 0), at(a, b1, 0), ...Array.from({ length: STAVES + 1 }, (_, k) => at(a, ...(arch(k, 0) as [number, number])))]));
  const roof: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  // Its top, a strip a stave, faced as the arch is.
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
  return { walls, roof };
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

/** A shape seen in a mirror across x = 0, wound round again. */
export function mirror(s: Shape): Shape {
  const flip = (a: number[]) => a.map((v, i) => (i % 3 === 0 ? -v : v));
  return { ...s, positions: flip(s.positions), normals: flip(s.normals), indices: s.indices.map((_, i) => s.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
}

/** A finish: a coat on the town's material, made once an engine. */
export type Coat = (engine: EngineContext) => MaterialPlugin;
type Texture = Parameters<NonNullable<MaterialPlugin["bindTextures"]>>[0][number]["texture"];
export const f = (x: number) => x.toFixed(4);
export const frame = (p: string) => `let ${p}Dp1 = dpdx(input.worldPos);
let ${p}Dp2 = dpdy(input.worldPos);
let ${p}Du1 = dpdx(input.uv);
let ${p}Du2 = dpdy(input.uv);
let ${p}T = cross(${p}Dp2, N) * ${p}Du1.x + cross(N, ${p}Dp1) * ${p}Du2.x;
let ${p}B = cross(${p}Dp2, N) * ${p}Du1.y + cross(N, ${p}Dp1) * ${p}Du2.y;
let ${p}Inv = inverseSqrt(max(max(dot(${p}T, ${p}T), dot(${p}B, ${p}B)), 1e-14));`;
export function coat(name: string, code: string, textures: (engine: EngineContext) => Record<string, Texture> = () => ({}), definitions = ""): Coat {
  const made = new WeakMap<EngineContext, MaterialPlugin>();
  return (engine) => {
    let plugin = made.get(engine);
    if (plugin) return plugin;
    const bound = Object.entries(textures(engine));
    plugin = {
      name,
      priority: 900,
      ...(bound.length ? { getSamplers: () => bound.map(([t]) => ({ texture: t, sampler: `${t}Sampler` })), bindTextures: (out) => out.push(...bound.map(([, texture]) => ({ texture }))) } : {}),
      getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_DEFINITIONS: definitions, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: code } : null),
    };
    made.set(engine, plugin);
    return plugin;
  };
}

/** How far zinc's waves turn the light, how dark their troughs, how rough
 *  the metal. */
const [ZINC_TILT, ZINC_TROUGH, ZINC_ROUGH] = [0.55, 0.12, 0.35];
export const ZINC_COLOUR: [number, number, number] = [0.72, 0.74, 0.77];

export const WOOD = coat("ModelWood", "roughness = 0.8;");
export const ZINC = coat("ModelZinc", `${frame("zinc")}
let zincWave = 6.2832 * input.uv.x;
let zincFine = 1. - smoothstep(0.25, 0.5, fwidth(input.uv.x));
N = normalize(N + zincT * zincInv * sin(zincWave) * ${f(ZINC_TILT)} * zincFine);
baseColor = baseColor * (1. - ${f(ZINC_TROUGH)} * (0.5 - 0.5 * cos(zincWave)) * zincFine);
metallic = 1.;
roughness = ${f(ZINC_ROUGH)};`);
export const BARK = coat("ModelBark", `${frame("bark")}
let barkMap = textureSample(modelBark, modelBarkSampler, input.uv);
let barkTilt = barkMap.rg * 2. - 1.;
N = normalize(N + (barkT * barkTilt.x + barkB * barkTilt.y) * barkInv);
baseColor = baseColor * barkMap.b;
roughness = 0.95;`, (engine) => ({ modelBark: bark(engine) }));

/** A tiled roof's courses: how tall one is, up the roof, and how far
 *  each tips the light down its slope and shades its foot. */
export const COURSE = 0.022;
const [COURSE_TIP, COURSE_SHADE] = [0.35, 0.18];
/** Tiles: courses up a roof, each a step its foot lapped over the one
 *  below, mapped by how many courses up it is (`tiled`); and the tiles
 *  along a course, every other course staggered. */
export const TILES = coat("ModelTiles", `${frame("tiles")}
let tilesUp = fract(input.uv.x);
let tilesAlong = fract(input.uv.y + 0.5 * floor(input.uv.x));
let tilesFine = 1. - smoothstep(0.25, 0.5, fwidth(input.uv.x));
N = normalize(N + tilesT * tilesInv * (tilesUp - 0.5) * ${f(COURSE_TIP)} * tilesFine);
baseColor = baseColor * (1. - ${f(COURSE_SHADE)} * (1. - smoothstep(0., 0.3, tilesUp)) * tilesFine) * (1. - 0.1 * step(0.92, tilesAlong) * tilesFine);
roughness = 0.85;`);
/** A roof's solid tiled: mapped by its courses up from the ground, and
 *  its tiles along x and y. */
export const tiled = (solid: Manifold) => mesh(solid, (p) => [p[2] / COURSE, (p[0] + p[1]) / (COURSE * 1.4)]);

/** How big the lumps of something loose are and their flecks, as the
 *  land's grain is read over them (`ground.ts`, 256 texels). */
export const [LUMPS, FLECKS] = [3.5, 1.6];
/** Something loose on the ground, sawdust or chips: lumpy by the land's
 *  grain, gone where `gone` says, its edge frayed by the same grain, and
 *  as `look` has it; `looseSlope` the grain's slope read at a size. */
export function loose(name: string, gone: string, look: string): Coat {
  const read = (at: string, span: string) => `textureSample(looseGrain, looseGrainSampler, (${at}) / ${span})`;
  return coat(name, `let looseAt = input.worldPos.xy;
let looseLump = 0.6 * ${read("looseAt", f(LUMPS))}.r + 0.4 * ${read("looseAt", f(FLECKS))}.r;
if (${gone}) { discard; }${look}
roughness = 1.;`, (engine) => ({ looseGrain: grain(engine) }), `fn looseSlope(at: vec2f, span: f32) -> vec2f {
  return vec2f(${read("at + vec2f(0.004, 0.)", "span")}.r - ${read("at - vec2f(0.004, 0.)", "span")}.r,
    ${read("at + vec2f(0., 0.004)", "span")}.r - ${read("at - vec2f(0., 0.004)", "span")}.r);
}`);
}

/** Bark (`bark.ts`), an engine's: smooth until the worker has baked it,
 *  or read back from the last bake (`bakeCache.ts`). */
const bark = (engine: EngineContext) =>
  bakedTexture(engine, "bark", barkRecipe, [BARK_ROUND, BARK_LONG, () => new Uint8Array(BARK_ROUND * BARK_LONG * 4).map((_, k) => (k % 4 === 2 ? 220 : k % 4 === 3 ? 255 : 128))], {
    format: "rgba8unorm",
    mipmaps: true,
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

/** A model: its finishes, each a shape in its coat, and whether it lies
 *  too flat to cast a shadow. */
export type Model = Record<string, { shape: Shape; coat: Coat; flat?: boolean }>;

/** A model and its mirror across x = 0, finish by finish as an engine
 *  draws them, a bucket each under `key`. */
export function placing(key: string, model: Model) {
  const left: Model = Object.fromEntries(Object.entries(model).map(([k, m]) => [k, { ...m, shape: mirror(m.shape) }]));
  return (engine: EngineContext, side: 1 | -1) =>
    Object.entries(side > 0 ? model : left).map(([k, { shape, coat, flat }]) => ({ key: `${key}_${k}${side > 0 ? "" : "_left"}`, geo: shape, coat: coat(engine), cast: !flat }));
}
