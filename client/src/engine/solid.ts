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

/** A solid as the town draws it: every triangle its own three vertices,
 *  faced flat, as the bevel wants (`slab`), wound the town's way round,
 *  clockwise seen from outside. The solid is let go. */
export function mesh(solid: Manifold): MeshGeometry {
  const { vertProperties: v, triVerts, numProp } = solid.getMesh();
  solid.delete();
  const positions: number[] = [], normals: number[] = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => v[triVerts[i + k] * numProp + j]));
    const [u, w] = [b.map((x, j) => x - a[j]), c.map((x, j) => x - a[j])];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [a, c, b]) positions.push(...p), normals.push(n[0] / len, n[1] / len, n[2] / len);
  }
  return { positions, normals, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}
