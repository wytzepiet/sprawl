import { ownStill, stalePicture, type Mesh, type SceneContext } from "./gpu";
import { lag } from "./lag";

/**
 * The town is drawn once and kept, and only what moves is drawn every frame.
 *
 * A phone's GPU spent all of every frame drawing a town that had not
 * changed. So the scene's meshes are of two kinds. Still ones (the land,
 * roads, buildings, trees) are drawn into a picture of their own, with how
 * far away each pixel is, and only when something still has changed: the
 * view moved, something was built. Live ones (the vehicles, the goods, the
 * water) are drawn every frame over that picture, hidden behind buildings
 * by its depth. The renderer keeps the picture (`render/frame.ts`); this
 * says which mesh is which.
 */

/** The picture's margin past each edge of the screen, as a share of it. */
export const MARGIN = 0.12;

/** Meshes drawn every frame, over the picture and never into it. */
const lives = new WeakSet<Mesh>();

/** A mesh drawn every frame, over the still picture and never into it:
 *  said before it is added to the scene. */
export function live(mesh: Mesh): Mesh {
  lives.add(mesh);
  return mesh;
}

/** Whether a mesh stands still: drawn into the picture, and its shadow
 *  into the sun's map's still layer. */
export const isStill = (mesh: Mesh) => !lives.has(mesh);

/** How many times the picture has been drawn: what stood still before
 *  the last is in it (`InstancePool`'s hand-off). */
export let redraws = 0;

/** Something still has changed that its meshes do not show: the picture is drawn again soon, whole. */
export const stale = stalePicture;

/** Set up before the scene is registered. `frame` draws one: `always`, the
 *  picture with it, to see what it costs. */
export function createStill(scene: SceneContext) {
  return ownStill(scene, isStill, (why: string) => void (redraws++, lag(`shown ${why}`, true)));
}
export type Still = ReturnType<typeof createStill>;
