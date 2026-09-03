import { Matrix, Vector3, Viewport } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";

/**
 * Everything that needs to know how the world lands on the screen.
 *
 * The projection used to be assumed rather than asked about: half a dozen
 * places reached into the camera's orthographic extents and did their own
 * arithmetic on them, which meant the projection was not really the camera's
 * to choose. Nothing here knows which projection is in use — a ray is cast to
 * go from pixels to ground, the scene's own matrix goes the other way, and the
 * size of the view is measured by asking where two pixels land.
 */

const _origin = new Vector3();
const _dir = new Vector3();
const _point = new Vector3();
const _out = new Vector3();
const _identity = Matrix.Identity();
const _viewport = new Viewport(0, 0, 0, 0);

/** Where a ray through this canvas pixel meets the ground plane, z = 0. */
function groundAt(scene: Scene, x: number, y: number): { wx: number; wy: number } {
  const ray = scene.createPickingRay(x, y, _identity, scene.activeCamera);
  _origin.copyFrom(ray.origin);
  _dir.copyFrom(ray.direction);
  // Looking down at a flat world, so the ground is always ahead and this never
  // divides by zero — but a camera turned to the horizon would, so say so.
  if (Math.abs(_dir.z) < 1e-6) {
    return { wx: _origin.x, wy: _origin.y };
  }
  const t = -_origin.z / _dir.z;
  return { wx: _origin.x + _dir.x * t, wy: _origin.y + _dir.y * t };
}

/** Where a pointer event lands on the ground. */
export function screenToWorld(
  scene: Scene,
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number },
): { wx: number; wy: number } {
  const rect = canvas.getBoundingClientRect();
  return groundAt(scene, e.clientX - rect.left, e.clientY - rect.top);
}

/**
 * Half the ground the view covers, vertically and horizontally, in tiles.
 *
 * Measured rather than derived: where the middle of the screen lands, against
 * where its edges land. Under perspective those distances depend on how high
 * the camera is and how wide its lens; measuring gets the answer either way.
 */
export function viewExtent(scene: Scene, canvas: HTMLCanvasElement): { halfW: number; halfH: number } {
  const rect = canvas.getBoundingClientRect();
  const mid = groundAt(scene, rect.width / 2, rect.height / 2);
  const top = groundAt(scene, rect.width / 2, 0);
  const side = groundAt(scene, 0, rect.height / 2);
  return {
    halfW: Math.hypot(side.wx - mid.wx, side.wy - mid.wy),
    halfH: Math.hypot(top.wx - mid.wx, top.wy - mid.wy),
  };
}

/**
 * A projector for one frame: build it once, then use it for every point.
 *
 * Kept as a closure over the frame's transform so a few hundred pins cost a few
 * hundred matrix multiplies and no allocation at all.
 */
export function projector(scene: Scene, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const transform = scene.getTransformMatrix();
  _viewport.width = rect.width;
  _viewport.height = rect.height;
  return {
    rect,
    /** Where a world point lands, in client coordinates. */
    at(wx: number, wy: number, wz = 0): { sx: number; sy: number } {
      _point.set(wx, wy, wz);
      Vector3.ProjectToRef(_point, _identity, transform, _viewport, _out);
      return { sx: rect.left + _out.x, sy: rect.top + _out.y };
    },
  };
}
