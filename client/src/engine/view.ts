import { createPickingRay, getViewProjectionMatrix, type SceneContext } from "@babylonjs/lite";

/**
 * Everything that needs to know how the world lands on the screen.
 *
 * The projection used to be assumed rather than asked about: half a dozen
 * places reached into the camera's orthographic extents and did their own
 * arithmetic on them, which meant the projection was not really the camera's
 * to choose. Nothing here knows which projection is in use — a ray is cast to
 * go from pixels to ground, the camera's own matrix goes the other way, and the
 * size of the view is measured by asking where two pixels land.
 */

/** Where the canvas is on the page, read once and again only when it is
 *  resized: reading it in a frame, after the pins have moved, made the
 *  browser lay the page out anew, every frame, a few times. */
const RECTS = new WeakMap<HTMLCanvasElement, DOMRect>();
export function rectOf(canvas: HTMLCanvasElement): DOMRect {
  let rect = RECTS.get(canvas);
  if (!rect) {
    RECTS.set(canvas, (rect = canvas.getBoundingClientRect()));
    new ResizeObserver(() => RECTS.set(canvas, canvas.getBoundingClientRect())).observe(canvas);
  }
  return rect;
}

/** The camera's view and projection, for a canvas this many CSS pixels across. */
function viewProjection(scene: SceneContext, width: number, height: number) {
  return getViewProjectionMatrix(scene.camera!, width / height);
}

/** Where a ray through this canvas pixel meets the ground plane, z = 0. */
function groundAt(scene: SceneContext, width: number, height: number, x: number, y: number): { wx: number; wy: number } {
  const ray = createPickingRay(x, y, viewProjection(scene, width, height), width, height);
  if (!ray) return { wx: 0, wy: 0 };
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  // Looking down at a flat world, so the ground is always ahead and this never
  // divides by zero — but a camera turned to the horizon would, so say so.
  if (Math.abs(dz) < 1e-6) return { wx: ox, wy: oy };
  const t = -oz / dz;
  return { wx: ox + dx * t, wy: oy + dy * t };
}

/** Where a pointer event lands on the ground. */
export function screenToWorld(
  scene: SceneContext,
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number },
): { wx: number; wy: number } {
  const rect = rectOf(canvas);
  return groundAt(scene, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
}

/**
 * The ground the view covers, as a circle: where the middle of the screen
 * lands, and how far from there the farthest corner does. Looking straight
 * down that is half the diagonal; leaning back, the far corners run away and
 * the circle grows toward them.
 */
export function groundCover(scene: SceneContext, canvas: HTMLCanvasElement): { cx: number; cy: number; radius: number } {
  const { width, height } = rectOf(canvas);
  const mid = groundAt(scene, width, height, width / 2, height / 2);
  let radius = 0;
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const c = groundAt(scene, width, height, x, y);
    radius = Math.max(radius, Math.hypot(c.wx - mid.wx, c.wy - mid.wy));
  }
  return { cx: mid.wx, cy: mid.wy, radius };
}

/**
 * Half the ground the view covers, vertically and horizontally, in tiles.
 *
 * Measured rather than derived: where the middle of the screen lands, against
 * where its edges land. Under perspective those distances depend on how high
 * the camera is and how wide its lens; measuring gets the answer either way.
 */
export function viewExtent(scene: SceneContext, canvas: HTMLCanvasElement): { halfW: number; halfH: number } {
  const { width, height } = rectOf(canvas);
  const mid = groundAt(scene, width, height, width / 2, height / 2);
  const top = groundAt(scene, width, height, width / 2, 0);
  const side = groundAt(scene, width, height, 0, height / 2);
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
export function projector(scene: SceneContext, canvas: HTMLCanvasElement) {
  const rect = rectOf(canvas);
  const m = viewProjection(scene, rect.width, rect.height);
  return {
    rect,
    /** Where a world point lands, in client coordinates. */
    at(wx: number, wy: number, wz = 0): { sx: number; sy: number } {
      const x = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
      const y = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
      const w = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
      return { sx: rect.left + ((x / w + 1) / 2) * rect.width, sy: rect.top + ((1 - y / w) / 2) * rect.height };
    },
  };
}
