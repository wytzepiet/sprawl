import Module, { type Manifold } from "manifold-3d";
import type { MeshGeometry } from "./geometry";

/**
 * Solids, built as a sentence is: a box, a cylinder, an outline pulled up,
 * one added to another or cut out of it (Manifold, `manifoldcad.org`).
 * What it builds is shaped once, at load, a part of a shape as a box is
 * (`sea.ts`); the wasm is ready before anything asks.
 */
const lib = await Module();
lib.setup();
export const { Manifold: Solid, CrossSection: Outline } = lib;

/** Every solid and outline made, kept to be let go: they live in the
 *  wasm's memory, which no collector sees. Each call that makes one,
 *  on the class or on a solid, notes what it made. */
const made: { delete(): void }[] = [];
for (const C of [Solid, Outline])
  for (const o of [C, C.prototype] as unknown as Record<string, unknown>[])
    for (const name of Object.getOwnPropertyNames(o)) {
      const f = o[name];
      if (typeof f !== "function" || name === "delete" || name === "constructor" || name === "prototype") continue;
      o[name] = function (this: unknown, ...args: unknown[]) {
        const out = f.apply(this, args);
        if (out instanceof Solid || out instanceof Outline) made.push(out);
        return out;
      };
    }

/** What `build` makes of solids, every solid it made along the way let go. */
export function solids<T>(build: () => T): T {
  try {
    return build();
  } finally {
    for (const s of made.splice(0)) s.delete();
  }
}

/** A solid as the town draws it: every triangle its own three vertices,
 *  faced flat, as the bevel wants (`slab`), wound the town's way round,
 *  clockwise seen from outside; mapped by `uv`, if given. */
export function mesh(solid: Manifold, uv?: (p: number[]) => number[]): MeshGeometry {
  const { vertProperties: v, triVerts, numProp } = solid.getMesh();
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => v[triVerts[i + k] * numProp + j]));
    const [u, w] = [b.map((x, j) => x - a[j]), c.map((x, j) => x - a[j])];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [a, c, b]) positions.push(...p), normals.push(n[0] / len, n[1] / len, n[2] / len), uv && uvs.push(...uv(p));
  }
  return { positions, normals, ...(uv ? { uvs } : {}), indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}
