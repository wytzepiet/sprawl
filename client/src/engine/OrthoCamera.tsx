import { onCleanup, createEffect, on } from "solid-js";
import { FreeCamera, Vector3, Camera } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useGame } from "../state/gameObjects";
import { buildMode, placingBuilding } from "../ui/buildMode";
import { CHUNK_SIZE } from "./TerrainChunks";

const BUILD_ZOOM = 8;
/**
 * Fraction of the remaining distance covered each frame. Zooming is a direct
 * response to the wheel and wants to arrive under the cursor at once; dropping
 * into build mode is a move the camera makes on its own, and reads better with
 * some travel to it.
 */
const ZOOM_LERP_SPEED = 0.35;
const BUILD_LERP_SPEED = 0.15;

/** Chunks of unsurveyed ground the camera is allowed to see past the frontier. */
const PAN_MARGIN_CHUNKS = 1;

/**
 * Keep `v` inside [lo, hi] allowing for a viewport of half-width `half`. When
 * the surveyed world is narrower than the viewport there is nothing to pan
 * along, so it centres instead.
 */
function clampAxis(v: number, lo: number, hi: number, half: number): number {
  if (hi - lo <= half * 2) return (lo + hi) / 2;
  return Math.min(Math.max(v, lo + half), hi - half);
}

export function OrthoCamera() {
  const { engine, scene, canvas } = useEngine();
  const { send, revealedBounds } = useGame();

  const camera = new FreeCamera("ortho", new Vector3(0, 0, 10), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;

  let orthoSize = 15;
  let targetOrthoSize = orthoSize;
  let lerpSpeed = ZOOM_LERP_SPEED;
  let targetCamX = camera.position.x;
  let targetCamY = camera.position.y;
  let locked = false;
  let debugMode = false;
  // Where a zoom with no pointer of its own aims. Build mode is entered from a
  // key or a toolbar button, so it borrows the last place the mouse was over
  // the map; before that has happened, the middle of the view.
  let cursorX = innerWidth / 2;
  let cursorY = innerHeight / 2;
  let lastMinCx = NaN, lastMinCy = NaN, lastMaxCx = NaN, lastMaxCy = NaN;

  function updateOrtho() {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    camera.orthoLeft = -orthoSize * aspect;
    camera.orthoRight = orthoSize * aspect;
    camera.orthoTop = orthoSize;
    camera.orthoBottom = -orthoSize;
  }

  updateOrtho();
  const resizeObs = engine.onResizeObservable.add(updateOrtho);

  /**
   * Hold the view inside the surveyed world plus a chunk of margin. Panning off
   * into unsurveyed ground would only ever show empty grid, and the fog mask is
   * finite — this is what keeps the camera inside it.
   */
  function clampToSurveyed() {
    const b = revealedBounds();
    if (b.max_cx < b.min_cx) return; // nothing surveyed yet

    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const m = PAN_MARGIN_CHUNKS;
    const minX = (b.min_cx - m) * CHUNK_SIZE;
    const maxX = (b.max_cx + 1 + m) * CHUNK_SIZE;
    const minY = (b.min_cy - m) * CHUNK_SIZE;
    const maxY = (b.max_cy + 1 + m) * CHUNK_SIZE;

    targetCamX = clampAxis(targetCamX, minX, maxX, targetOrthoSize * aspect);
    targetCamY = clampAxis(targetCamY, minY, maxY, targetOrthoSize);
    const x = clampAxis(camera.position.x, minX, maxX, orthoSize * aspect);
    const y = clampAxis(camera.position.y, minY, maxY, orthoSize);
    if (x !== camera.position.x || y !== camera.position.y) {
      camera.position.x = x;
      camera.position.y = y;
      camera.setTarget(new Vector3(x, y, 0));
    }
  }

  /**
   * Zoom to `size` while keeping whatever sits under (clientX, clientY) pinned
   * there. Only the targets move, so the same lerp that carries a wheel zoom
   * carries this one.
   */
  function zoomToward(size: number, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const nx = -((clientX - rect.left) / rect.width * 2 - 1);
    const ny = 1 - (clientY - rect.top) / rect.height * 2;
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const worldX = targetCamX + nx * targetOrthoSize * aspect;
    const worldY = targetCamY + ny * targetOrthoSize;

    const newSize = Math.max(2, Math.min(100, size));
    targetCamX = worldX - nx * newSize * aspect;
    targetCamY = worldY - ny * newSize;
    targetOrthoSize = newSize;
  }

  // Subscription is chunk-granular, so panning within a chunk sends nothing.
  function sendViewportIfChanged() {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const chunk = (v: number) => Math.floor(v / CHUNK_SIZE);

    // A margin beyond the viewport: the fog fade is derived from which chunks
    // exist, so without it the client cannot tell "unrevealed" from "not asked
    // for yet" and paints a frontier along the edge of the screen.
    const PAD = 2;
    const minCx = chunk(camera.position.x - orthoSize * aspect) - PAD;
    const maxCx = chunk(camera.position.x + orthoSize * aspect) + PAD;
    const minCy = chunk(camera.position.y - orthoSize) - PAD;
    const maxCy = chunk(camera.position.y + orthoSize) + PAD;

    if (minCx === lastMinCx && minCy === lastMinCy && maxCx === lastMaxCx && maxCy === lastMaxCy) return;

    // Only remember bounds the server actually heard. The socket is still
    // opening on the first frames, and caching a dropped send would leave the
    // client subscribed to nothing until it happened to pan across a chunk.
    if (!send({ type: "SetChunks", data: { min_cx: minCx, min_cy: minCy, max_cx: maxCx, max_cy: maxCy } })) return;
    lastMinCx = minCx; lastMinCy = minCy; lastMaxCx = maxCx; lastMaxCy = maxCy;
  }

  // Smooth zoom animation
  const renderObs = scene.onBeforeRenderObservable.add(() => {
    if (debugMode) return;
    const dSize = targetOrthoSize - orthoSize;
    const dX = targetCamX - camera.position.x;
    const dY = targetCamY - camera.position.y;
    if (Math.abs(dSize) > 0.01 || Math.abs(dX) > 0.001 || Math.abs(dY) > 0.001) {
      orthoSize += dSize * lerpSpeed;
      camera.position.x += dX * lerpSpeed;
      camera.position.y += dY * lerpSpeed;
      camera.setTarget(new Vector3(camera.position.x, camera.position.y, 0));
      updateOrtho();
    }
    clampToSurveyed();
    sendViewportIfChanged();
  });

  // React to build mode changes
  createEffect(on(
    () => ({ mode: buildMode(), placing: placingBuilding() }),
    ({ mode, placing }) => {
      if (mode === "select" && !placing) {
        locked = false;
      } else {
        locked = true;
        zoomToward(BUILD_ZOOM, cursorX, cursorY);
        lerpSpeed = BUILD_LERP_SPEED;
      }
    },
  ));

  // Panning & pinch-to-zoom
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let lastPinchDist = 0;
  let lastPinchCenterX = 0;
  let lastPinchCenterY = 0;

  function pinchDistance(): number {
    const pts = [...pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pinchCenter(): { x: number; y: number } {
    const pts = [...pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  const onPointerDown = (e: PointerEvent) => {
    if (locked) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (pointers.size === 2) {
      panning = false;
      lastPinchDist = pinchDistance();
      const c = pinchCenter();
      lastPinchCenterX = c.x;
      lastPinchCenterY = c.y;
    } else if (pointers.size === 1) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && !debugMode && !locked) {
      const dist = pinchDistance();
      const center = pinchCenter();
      const rect = canvas.getBoundingClientRect();

      // Pan by pinch center movement
      const worldPerPxX = (camera.orthoRight! - camera.orthoLeft!) / rect.width;
      const worldPerPxY = (camera.orthoTop! - camera.orthoBottom!) / rect.height;
      const panX = (center.x - lastPinchCenterX) * worldPerPxX;
      const panY = (center.y - lastPinchCenterY) * worldPerPxY;
      camera.position.x += panX;
      camera.position.y += panY;
      targetCamX += panX;
      targetCamY += panY;
      camera.setTarget(new Vector3(camera.position.x, camera.position.y, 0));
      lastPinchCenterX = center.x;
      lastPinchCenterY = center.y;

      // Zoom toward pinch center
      zoomToward(targetOrthoSize * (lastPinchDist / Math.max(dist, 1)), center.x, center.y);
      lerpSpeed = ZOOM_LERP_SPEED;
      lastPinchDist = dist;
      return;
    }

    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (debugMode) return;

    const rect = canvas.getBoundingClientRect();
    const worldPerPixelX = (camera.orthoRight! - camera.orthoLeft!) / rect.width;
    const worldPerPixelY = (camera.orthoTop! - camera.orthoBottom!) / rect.height;
    const moveX = dx * worldPerPixelX;
    const moveY = dy * worldPerPixelY;
    camera.position.x += moveX;
    camera.position.y += moveY;
    targetCamX += moveX;
    targetCamY += moveY;
    camera.setTarget(new Vector3(camera.position.x, camera.position.y, 0));
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      panning = true;
      lastX = remaining.x;
      lastY = remaining.y;
    } else {
      panning = false;
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (locked || debugMode) return;
    e.preventDefault();

    zoomToward(targetOrthoSize * (1 + e.deltaY * 0.001), e.clientX, e.clientY);
    lerpSpeed = ZOOM_LERP_SPEED;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "F9") return;
    debugMode = !debugMode;
    if (debugMode) {
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      camera.fov = 0.8;
      camera.position = new Vector3(targetCamX, targetCamY - 10, 8);
      camera.setTarget(new Vector3(targetCamX, targetCamY, 0));
      camera.attachControl(canvas, true);
    } else {
      camera.detachControl();
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.position = new Vector3(targetCamX, targetCamY, 10);
      camera.setTarget(new Vector3(targetCamX, targetCamY, 0));
      updateOrtho();
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);

  onCleanup(() => {
    engine.onResizeObservable.remove(resizeObs);
    scene.onBeforeRenderObservable.remove(renderObs);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    camera.dispose();
  });

  return <></>;
}
