import { onCleanup, createEffect, on } from "solid-js";
import { FreeCamera, Vector3, Camera } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useGame } from "../state/gameObjects";
import { buildMode, placingBuilding } from "../ui/buildMode";

const BUILD_ZOOM = 8;
const ZOOM_LERP_SPEED = 0.08;
const VIEWPORT_THROTTLE_MS = 200;

export function OrthoCamera() {
  const { engine, scene, canvas } = useEngine();
  const { send } = useGame();

  const camera = new FreeCamera("ortho", new Vector3(0, 0, 10), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;

  let orthoSize = 15;
  let targetOrthoSize = orthoSize;
  let targetCamX = camera.position.x;
  let targetCamY = camera.position.y;
  let locked = false;
  let debugMode = false;
  let lastVpMinX = 0, lastVpMinY = 0, lastVpMaxX = 0, lastVpMaxY = 0;
  let lastVpSend = 0;

  function updateOrtho() {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    camera.orthoLeft = -orthoSize * aspect;
    camera.orthoRight = orthoSize * aspect;
    camera.orthoTop = orthoSize;
    camera.orthoBottom = -orthoSize;
  }

  updateOrtho();
  const resizeObs = engine.onResizeObservable.add(updateOrtho);

  const VIEWPORT_MARGIN = 8; // extra tiles beyond visible edge

  function sendViewportIfChanged() {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const minX = Math.floor(camera.position.x - orthoSize * aspect) - VIEWPORT_MARGIN;
    const maxX = Math.ceil(camera.position.x + orthoSize * aspect) + VIEWPORT_MARGIN;
    const minY = Math.floor(camera.position.y - orthoSize) - VIEWPORT_MARGIN;
    const maxY = Math.ceil(camera.position.y + orthoSize) + VIEWPORT_MARGIN;

    const now = performance.now();
    if (minX === lastVpMinX && minY === lastVpMinY && maxX === lastVpMaxX && maxY === lastVpMaxY) return;
    if (now - lastVpSend < VIEWPORT_THROTTLE_MS) return;

    lastVpMinX = minX; lastVpMinY = minY; lastVpMaxX = maxX; lastVpMaxY = maxY;
    lastVpSend = now;
    send({ type: "SetViewport", data: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY } });
  }

  // Send initial viewport once ortho is set up
  sendViewportIfChanged();

  // Smooth zoom animation
  const renderObs = scene.onBeforeRenderObservable.add(() => {
    if (debugMode) return;
    const dSize = targetOrthoSize - orthoSize;
    const dX = targetCamX - camera.position.x;
    const dY = targetCamY - camera.position.y;
    if (Math.abs(dSize) > 0.01 || Math.abs(dX) > 0.001 || Math.abs(dY) > 0.001) {
      orthoSize += dSize * ZOOM_LERP_SPEED;
      camera.position.x += dX * ZOOM_LERP_SPEED;
      camera.position.y += dY * ZOOM_LERP_SPEED;
      camera.setTarget(new Vector3(camera.position.x, camera.position.y, 0));
      updateOrtho();
    }
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
        targetOrthoSize = BUILD_ZOOM;
      }
    },
  ));

  // Panning & pinch-to-zoom
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let lastPinchDist = 0;

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
    } else if (pointers.size === 1) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && !debugMode && !locked) {
      const dist = pinchDistance();
      const center = pinchCenter();
      const rect = canvas.getBoundingClientRect();
      const nx = -((center.x - rect.left) / rect.width * 2 - 1);
      const ny = 1 - (center.y - rect.top) / rect.height * 2;
      const aspect = engine.getRenderWidth() / engine.getRenderHeight();
      const worldX = targetCamX + nx * targetOrthoSize * aspect;
      const worldY = targetCamY + ny * targetOrthoSize;

      const scale = lastPinchDist / Math.max(dist, 1);
      const newSize = Math.max(2, Math.min(100, targetOrthoSize * scale));

      targetCamX = worldX - nx * newSize * aspect;
      targetCamY = worldY - ny * newSize;
      targetOrthoSize = newSize;
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

    // World position under cursor before zoom
    const rect = canvas.getBoundingClientRect();
    const nx = -((e.clientX - rect.left) / rect.width * 2 - 1);
    const ny = 1 - (e.clientY - rect.top) / rect.height * 2;
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const worldX = targetCamX + nx * targetOrthoSize * aspect;
    const worldY = targetCamY + ny * targetOrthoSize;

    const zoomFactor = 1 + e.deltaY * 0.001;
    const newSize = Math.max(2, Math.min(100, targetOrthoSize * zoomFactor));

    // Adjust camera so cursor world position stays fixed
    targetCamX = worldX - nx * newSize * aspect;
    targetCamY = worldY - ny * newSize;
    targetOrthoSize = newSize;
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
