/**
 * The slate as the land's edges read it: where it lies on the map, and its
 * height at a point of it, here on the CPU, from what the GPU drew
 * (`slateTexture.ts`). On its own, for the terrain's worker.
 */

/** How the slate lies on the map: over this many tiles; and again, this
 *  many times bigger, turned this far, this much of it, so its repeat does
 *  not show. The shader reads it so (`peaks.ts`). */
export const SPAN = 3;
export const SECOND = [2.7, 1.1, 0.35];

/** The slate's texture's side, in texels. */
export const SIDE = 512;

/** Its smaller copy the edges of the rock break along, this many levels
 *  down: its plates, not its grit; as the GPU drew it and it was read
 *  back (`slateTexture.ts`), four bytes a texel, the height the third. */
export const EDGE_LEVEL = 2;
const EDGE_SIDE = SIDE >> EDGE_LEVEL;
let small: Uint8Array = new Uint8Array(EDGE_SIDE * EDGE_SIDE * 4);
export const setSlate = (texels: Uint8Array) => void (small = texels);
const [TURN_C, TURN_S] = [Math.cos(SECOND[1]), Math.sin(SECOND[1])];

/** The small slate at (u, v) of its texture, blended as a sampler does,
 *  wrapping; -1 to 1. */
function smallAt(u: number, v: number): number {
  const [tx, ty] = [u * EDGE_SIDE - 0.5, v * EDGE_SIDE - 0.5];
  const [fi, fj] = [Math.floor(tx), Math.floor(ty)];
  const [fx, fy] = [tx - fi, ty - fj];
  const i = ((fi % EDGE_SIDE) + EDGE_SIDE) % EDGE_SIDE, j = ((fj % EDGE_SIDE) + EDGE_SIDE) % EDGE_SIDE;
  const i1 = (i + 1) % EDGE_SIDE, j1 = (j + 1) % EDGE_SIDE;
  const h = (i: number, j: number) => small[(j * EDGE_SIDE + i) * 4 + 2] / 255;
  const top = h(i, j) + (h(i1, j) - h(i, j)) * fx;
  const bottom = h(i, j1) + (h(i1, j1) - h(i, j1)) * fx;
  return (top + (bottom - top) * fy) * 2 - 1;
}

/** The slate's height at a point of the map, -1 to 1, as the edges of the
 *  rock break along it (`terrainGeometry.ts`): read where the shader reads
 *  its texture (`peaks.ts`), and, `turned`, mixed with the bigger, turned
 *  read as the mountains' is. */
export function slateHeight(x: number, y: number, turned = false): number {
  const a = smallAt(x / SPAN, y / SPAN);
  if (!turned) return a;
  const b = smallAt((x * TURN_C - y * TURN_S) / (SPAN * SECOND[0]), (x * TURN_S + y * TURN_C) / (SPAN * SECOND[0]));
  return a + (b - a) * SECOND[2];
}
