import { createPickingRay, getCameraPosition, getViewProjectionMatrix, type SceneContext } from "@babylonjs/lite";
import type { Area } from "../generated";

/**
 * Everything that needs to know how the world lands on the screen. Pixels go
 * to ground by a ray, and ground to pixels by the camera's own matrix. How
 * much ground is in view is arithmetic on the flat camera's frustum, which
 * looks straight down; only while it leans or flies (F8, F9) is it measured,
 * by asking where pixels land.
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
 * The ground the view covers: where the middle of the screen lands, half the
 * ground either way to the screen's edges (`halfW`, `halfH`), and as a circle
 * round the middle, out to the farthest corner. Looking straight down that
 * is half the diagonal; leaning back, the far corners run away and the
 * circle grows toward them.
 */
export function groundCover(scene: SceneContext, canvas: HTMLCanvasElement): { cx: number; cy: number; halfW: number; halfH: number; radius: number } {
  const camera = scene.camera!;
  const { width, height } = rectOf(canvas);
  if (camera.ortho) {
    const { x, y } = getCameraPosition(camera);
    const halfH = camera.ortho.halfHeight;
    const halfW = (halfH * width) / height;
    return { cx: x, cy: y, halfW, halfH, radius: Math.hypot(halfW, halfH) };
  }
  const mid = groundAt(scene, width, height, width / 2, height / 2);
  const from = (x: number, y: number) => {
    const c = groundAt(scene, width, height, x, y);
    return Math.hypot(c.wx - mid.wx, c.wy - mid.wy);
  };
  const radius = Math.max(from(0, 0), from(width, 0), from(0, height), from(width, height));
  return { cx: mid.wx, cy: mid.wy, halfW: from(0, height / 2), halfH: from(width / 2, 0), radius };
}

/** The tiles the view covers, a square round its middle. */
export function viewArea(scene: SceneContext, canvas: HTMLCanvasElement): Area {
  const { cx, cy, halfW, halfH } = groundCover(scene, canvas);
  const half = Math.max(halfW, halfH);
  return { x0: Math.floor(cx - half), y0: Math.floor(cy - half), x1: Math.ceil(cx + half), y1: Math.ceil(cy + half) };
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
