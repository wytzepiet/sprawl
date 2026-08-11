import type { Scene } from "@babylonjs/core";

/**
 * Where a pointer event lands on the ground plane.
 *
 * The camera is orthographic and looks straight down, so this is a lerp across
 * its frustum rather than a ray cast — no scene traversal, and it answers for
 * tiles that carry no geometry at all.
 */
export function pickWorld(
  scene: Scene,
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number },
): { wx: number; wy: number } {
  const rect = canvas.getBoundingClientRect();
  const cam = scene.activeCamera!;
  const nx = -(((e.clientX - rect.left) / rect.width) * 2 - 1);
  const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  return {
    wx: cam.position.x + (nx * (cam.orthoRight! - cam.orthoLeft!)) / 2,
    wy: cam.position.y + (ny * (cam.orthoTop! - cam.orthoBottom!)) / 2,
  };
}
