import { onCleanup } from "solid-js";
import { attachFreeControl, createFreeCamera, disableOrthographicCamera, enableOrthographicCamera } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { useGame } from "../state/gameObjects";
import { tool } from "../ui/buildMode";
import { CHUNK_SIZE } from "./TerrainChunks";
import { viewExtent, rectOf } from "./view";
import { following, setFollowing, positionOf } from "../state/selection";


/**
 * How wide the lens is, in radians. Small enough that the view still reads as a
 * map rather than a photograph — wider and buildings near the edges start
 * hiding what is behind them; narrower and the depth stops being visible at
 * all. This one number is the whole look.
 */
const FOV = (20 * Math.PI) / 180;

/**
 * How far the perspective view leans back from straight down, in radians. For
 * the look only: it is put on just before a frame is drawn and taken off right
 * after, so panning, picking and the chunk subscription all still see the
 * camera straight above the middle of the view.
 */
const TILT = (25 * Math.PI) / 180;

/** Which projection the map opens in. F8 swaps it, to see the two side by side. */
const OPENS_IN_PERSPECTIVE = false;
/** Fraction of the remaining distance covered each frame: a zoom is a direct
 *  response to the wheel and wants to arrive under the cursor at once. */
const ZOOM_LERP_SPEED = 0.35;

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
  const { scene, canvas, beforeRender, afterRender } = useEngine();
  const { send, revealedBounds } = useGame();

  const camera = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
  camera.nearPlane = 1;
  camera.farPlane = 4000;
  scene.camera = camera;
  /** Point the camera straight down at the ground under (x, y). */
  const aim = (x: number, y: number) => camera.target.set(x, y, 0);
  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  let perspective = OPENS_IN_PERSPECTIVE;

  // Zoom is measured in tiles of ground, not in camera height, so it means the
  // same thing whichever projection is in use — and everything downstream keeps
  // asking the view how much world it covers rather than the camera how far up
  // it is.
  let viewHalf = 15;
  let targetViewHalf = viewHalf;
  let targetCamX = camera.position.x;
  let targetCamY = camera.position.y;
  let debugMode = false;
  let lastMinCx = NaN, lastMinCy = NaN, lastMaxCx = NaN, lastMaxCy = NaN;

  /**
   * Hold the camera at the height that puts `viewHalf` tiles between the middle
   * of the screen and its top edge. A narrow lens far away looks very nearly
   * like a flat projection — but only very nearly, and the difference is the
   * point: a tall building leans away from the middle of the view and shows a
   * little of its side, which is what makes its height readable.
   */
  /**
   * How much ground one pixel covers.
   *
   * The camera looks straight down at a flat world, so every point of the
   * ground is the same distance away and the ground maps to the screen at one
   * even scale — it is only things standing *above* it that lean. That is what
   * lets a drag move the map by a fixed amount per pixel under a perspective
   * camera just as it did under a flat one.
   */
  function groundScale(rect: DOMRect) {
    const { halfW, halfH } = viewExtent(scene, canvas);
    return { worldPerPxX: (halfW * 2) / rect.width, worldPerPxY: (halfH * 2) / rect.height };
  }

  /**
   * Put `viewHalf` tiles between the middle of the screen and its top edge.
   *
   * Flat, that is the frustum's own half-height. In perspective it is a matter
   * of how high the camera flies: a narrow lens far away looks very nearly like
   * a flat projection, and the difference is the point — a tall building leans
   * away from the middle of the view and shows a little of its side, which is
   * what makes its height readable.
   *
   * Zoom means tiles of ground either way, so nothing downstream is aware there
   * is a choice here at all.
   */
  function updateProjection() {
    if (perspective) {
      if (camera.ortho) disableOrthographicCamera(camera);
      camera.fov = FOV;
      camera.nearPlane = 1;
      camera.position.z = viewHalf / Math.tan(FOV / 2);
      return;
    }
    // Low over the land, as the eye the light's shine is seen from (the sun
    // slides over the water as the view pans); but clipping nothing however
    // high a mountain stands: a flat view may see behind itself.
    camera.position.z = 10;
    camera.nearPlane = -1000;
    // Its sides follow the canvas's shape on their own.
    (camera.ortho ?? enableOrthographicCamera(camera)).halfHeight = viewHalf;
  }

  updateProjection();

  /**
   * Hold the view inside the surveyed world plus a chunk of margin. Panning off
   * into unsurveyed ground would only ever show empty grid, and the fog mask is
   * finite — this is what keeps the camera inside it.
   */
  function clampToSurveyed() {
    const b = revealedBounds();
    if (b.max_cx < b.min_cx) return; // nothing surveyed yet

    const m = PAN_MARGIN_CHUNKS;
    const minX = (b.min_cx - m) * CHUNK_SIZE;
    const maxX = (b.max_cx + 1 + m) * CHUNK_SIZE;
    const minY = (b.min_cy - m) * CHUNK_SIZE;
    const maxY = (b.max_cy + 1 + m) * CHUNK_SIZE;

    targetCamX = clampAxis(targetCamX, minX, maxX, targetViewHalf * aspect());
    targetCamY = clampAxis(targetCamY, minY, maxY, targetViewHalf);
    const x = clampAxis(camera.position.x, minX, maxX, viewHalf * aspect());
    const y = clampAxis(camera.position.y, minY, maxY, viewHalf);
    if (x !== camera.position.x || y !== camera.position.y) {
      camera.position.x = x;
      camera.position.y = y;
      aim(x, y);
    }
  }

  /**
   * Zoom to `size` while keeping whatever sits under (clientX, clientY) pinned
   * there. Only the targets move, so the same lerp that carries a wheel zoom
   * carries this one.
   */
  function zoomToward(size: number, clientX: number, clientY: number) {
    const rect = rectOf(canvas);
    const nx = -((clientX - rect.left) / rect.width * 2 - 1);
    const ny = 1 - (clientY - rect.top) / rect.height * 2;
    const worldX = targetCamX + nx * targetViewHalf * aspect();
    const worldY = targetCamY + ny * targetViewHalf;

    const newSize = Math.max(2, Math.min(100, size));
    targetCamX = worldX - nx * newSize * aspect();
    targetCamY = worldY - ny * newSize;
    targetViewHalf = newSize;
  }

  // The fixture shots point the camera from outside: straight to a place and
  // a zoom, no travel. Dev only.
  if (import.meta.env.DEV) {
    (window as unknown as { sprawlCamera: unknown }).sprawlCamera = {
      look(x: number, y: number, half: number) {
        targetCamX = camera.position.x = x;
        targetCamY = camera.position.y = y;
        targetViewHalf = viewHalf = half;
        aim(x, y);
        updateProjection();
      },
    };
  }

  // Subscription is chunk-granular, so panning within a chunk sends nothing.
  function sendViewportIfChanged() {
    const chunk = (v: number) => Math.floor(v / CHUNK_SIZE);

    // A margin beyond the viewport: the fog fade is derived from which chunks
    // exist, so without it the client cannot tell "unrevealed" from "not asked
    // for yet" and paints a frontier along the edge of the screen.
    const PAD = 2;
    const minCx = chunk(camera.position.x - viewHalf * aspect()) - PAD;
    const maxCx = chunk(camera.position.x + viewHalf * aspect()) + PAD;
    const minCy = chunk(camera.position.y - viewHalf) - PAD;
    const maxCy = chunk(camera.position.y + viewHalf) + PAD;

    if (minCx === lastMinCx && minCy === lastMinCy && maxCx === lastMaxCx && maxCy === lastMaxCy) return;

    // Only remember bounds the server actually heard. The socket is still
    // opening on the first frames, and caching a dropped send would leave the
    // client subscribed to nothing until it happened to pan across a chunk.
    if (!send({ type: "SetChunks", data: { min_cx: minCx, min_cy: minCy, max_cx: maxCx, max_cy: maxCy } })) return;
    lastMinCx = minCx; lastMinCy = minCy; lastMaxCx = maxCx; lastMaxCy = maxCy;
  }

  // Smooth zoom animation
  const stopBefore = beforeRender(() => {
    if (debugMode) return;
    const f = following();
    if (f !== null) {
      const at = positionOf(f);
      if (at) {
        targetCamX = at[0];
        targetCamY = at[1];
      }
    }
    const dSize = targetViewHalf - viewHalf;
    const dX = targetCamX - camera.position.x;
    const dY = targetCamY - camera.position.y;
    if (Math.abs(dSize) > 0.01 || Math.abs(dX) > 0.001 || Math.abs(dY) > 0.001) {
      viewHalf += dSize * ZOOM_LERP_SPEED;
      camera.position.x += dX * ZOOM_LERP_SPEED;
      camera.position.y += dY * ZOOM_LERP_SPEED;
      aim(camera.position.x, camera.position.y);
      updateProjection();
    }
    clampToSurveyed();
    sendViewportIfChanged();
    if (perspective && !debugMode) lean(1);
  });
  const stopAfter = afterRender(() => {
    if (perspective && !debugMode) lean(-1);
  });

  /** Swing the camera back along the ground, still aimed where it was. */
  function lean(dir: 1 | -1) {
    const x = camera.position.x;
    const y = camera.position.y + (dir === -1 ? camera.position.z * Math.tan(TILT) : 0);
    camera.position.y = y - (dir === 1 ? camera.position.z * Math.tan(TILT) : 0);
    aim(x, y);
  }

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
    // A tool has the left button, so the right one always pans. Without it a
    // build mode is one you cannot move around in.
    if (tool() !== null && e.button !== 2) return;
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
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && !debugMode) {
      const dist = pinchDistance();
      const center = pinchCenter();
      const rect = rectOf(canvas);

      // Pan by pinch center movement
      const { worldPerPxX, worldPerPxY } = groundScale(rect);
      const panX = (center.x - lastPinchCenterX) * worldPerPxX;
      const panY = (center.y - lastPinchCenterY) * worldPerPxY;
      setFollowing(null);
      camera.position.x += panX;
      camera.position.y += panY;
      targetCamX += panX;
      targetCamY += panY;
      aim(camera.position.x, camera.position.y);
      lastPinchCenterX = center.x;
      lastPinchCenterY = center.y;

      // Zoom toward pinch center
      zoomToward(targetViewHalf * (lastPinchDist / Math.max(dist, 1)), center.x, center.y);
      lastPinchDist = dist;
      return;
    }

    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (debugMode) return;

    const rect = rectOf(canvas);
    const { worldPerPxX: worldPerPixelX, worldPerPxY: worldPerPixelY } = groundScale(rect);
    const moveX = dx * worldPerPixelX;
    const moveY = dy * worldPerPixelY;
    if (dx !== 0 || dy !== 0) setFollowing(null);
    camera.position.x += moveX;
    camera.position.y += moveY;
    targetCamX += moveX;
    targetCamY += moveY;
    aim(camera.position.x, camera.position.y);
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

  // Right-drag is a pan, so the menu it would otherwise raise is in the way.
  const preventContextMenu = (e: Event) => e.preventDefault();

  const onWheel = (e: WheelEvent) => {
    if (debugMode) return;
    e.preventDefault();

    zoomToward(targetViewHalf * (1 + e.deltaY * 0.001), e.clientX, e.clientY);
  };

  let detachFlying = () => {};
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F8") {
      perspective = !perspective;
      updateProjection();
      return;
    }
    if (e.key !== "F9") return;
    debugMode = !debugMode;
    // Flying is a wide lens and the controls handed over, whichever projection
    // the map itself is using.
    if (debugMode) {
      if (camera.ortho) disableOrthographicCamera(camera);
      camera.fov = 0.8;
      camera.position.set(targetCamX, targetCamY - 10, 8);
      aim(targetCamX, targetCamY);
      detachFlying = attachFreeControl(camera, canvas, scene);
    } else {
      detachFlying();
      camera.position.set(targetCamX, targetCamY, 10);
      aim(targetCamX, targetCamY);
      updateProjection();
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", preventContextMenu);
  window.addEventListener("keydown", onKeyDown);

  onCleanup(() => {
    stopBefore();
    stopAfter();
    detachFlying();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", preventContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    if (scene.camera === camera) scene.camera = null;
  });

  return <></>;
}
