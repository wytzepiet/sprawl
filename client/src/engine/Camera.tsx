import { onCleanup } from "solid-js";
import { attachFreeControl, createFreeCamera } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { useGame } from "../state/gameObjects";
import { held, inHand } from "../ui/buildMode";
import { CHUNK_SIZE } from "./TerrainChunks";
import { groundCover, screenToWorld } from "./view";
import { following, setFollowing, positionOf } from "../state/selection";

/**
 * How wide the lens is, in radians. Small enough that the view still reads as a
 * map rather than a photograph — wider and buildings near the edges start
 * hiding what is behind them; narrower and the depth stops being visible at
 * all.
 */
const FOV = (20 * Math.PI) / 180;

/**
 * How far the view leans back from straight down, in radians, looking north.
 * It never turns, so a thing is only ever seen from the south, east and west:
 * it shows height, which shadows alone did not.
 */
export const TILT = (25 * Math.PI) / 180;

/** How far the camera stands from the ground it looks at, for `half` tiles
 *  of ground between the screen's middle and either edge, top and bottom, on
 *  the whole: the near half is a little less, the far a little more. */
const DISTANCE = 2 / (Math.tan(TILT + FOV / 2) - Math.tan(TILT - FOV / 2)) / Math.cos(TILT);

/** Fraction of the remaining distance covered each frame: a zoom is a direct
 *  response to the wheel and wants to arrive under the cursor at once. */
const ZOOM_LERP_SPEED = 0.35;

/** Chunks of unsurveyed ground the camera is allowed to see past the frontier. */
const PAN_MARGIN_CHUNKS = 1;
/** Tiles past a level's edge the camera may see: a glimpse of its
 *  neighbours. */
const LEVEL_MARGIN = 5;
/** Chunks loaded past the ground in view, so it is there before it is seen. */
const PAD = 2;

/** Where the island's camera was when the page was left: each world is
 *  served from its own origin, so the browser keeps one per world. */
const KEPT = "sprawl.camera";

/**
 * Keep `v` inside [lo, hi] allowing for a viewport of half-width `half`. When
 * the surveyed world is narrower than the viewport there is nothing to pan
 * along, so it centres instead.
 */
function clampAxis(v: number, lo: number, hi: number, half: number): number {
  if (hi - lo <= half * 2) return (lo + hi) / 2;
  return Math.min(Math.max(v, lo + half), hi - half);
}

/** Where the camera looks; and a way to send it somewhere, for the feed's
 *  news. How much of the screen's foot the dock's sheet covers, in CSS
 *  pixels: what the camera follows sits in the middle of the rest. */
export const eye = { x: 0, y: 0, below: 0, go(_x: number, _y: number) {} };

/** Ground the camera keeps over, in tiles, corners inclusive. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The camera over the map, leaning back from the south. Over the island, it
 * keeps to its chunks; given `bounds` (a level), it keeps to those, opens
 * over their middle with all of them in view, and zooms no further out than
 * a margin past them.
 *
 * Its place is the ground at the screen's middle (`at`) and how much ground
 * is in view (`half`, in tiles); the camera stands back from that along its
 * lean. Pixels meet the ground by a ray, so a drag keeps the ground under
 * the pointer under it, near or far.
 */
export function Camera(props: { bounds?: () => Bounds | null }) {
  const { scene, canvas, beforeRender } = useEngine();
  const { send, island, welcomed } = useGame();

  const camera = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
  camera.fov = FOV;
  camera.nearPlane = 1;
  camera.farPlane = 4000;
  scene.camera = camera;
  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);

  // Back where the player left it; a stale place is clamped onto the island.
  const kept = (!props.bounds && JSON.parse(localStorage.getItem(KEPT) ?? "null")) || { x: 0, y: 0, half: 15 };
  let half: number = kept.half;
  let at = { x: kept.x as number, y: kept.y as number };
  let target = { half, ...at };
  let flying = false;
  let lastChunks = "";
  let lastWelcome = 0;

  /** Stand the camera back from the ground at the middle of the view. */
  function place() {
    const d = half * DISTANCE;
    camera.position.set(at.x, at.y - d * Math.sin(TILT), d * Math.cos(TILT));
    camera.target.set(at.x, at.y, 0);
  }
  place();

  /** Move the view, the camera with it, and its target as far. */
  function shift(dx: number, dy: number) {
    at = { x: at.x + dx, y: at.y + dy };
    target = { ...target, x: target.x + dx, y: target.y + dy };
    place();
  }

  /**
   * Hold the view over the island's map plus a margin: past it there is
   * nothing to see.
   */
  let framed = false;
  function clampToIsland() {
    let minX: number, maxX: number, minY: number, maxY: number;
    const level = props.bounds?.();
    if (level) {
      const m = LEVEL_MARGIN;
      [minX, maxX, minY, maxY] = [level.x0 - m, level.x1 + 1 + m, level.y0 - m, level.y1 + 1 + m];
      // A level opens with all of it in view, and is never lost from it.
      const fit = Math.max((level.y1 + 1 - level.y0) / 2, (level.x1 + 1 - level.x0) / 2 / aspect()) * 1.25;
      if (!framed) {
        framed = true;
        at = { x: (level.x0 + level.x1 + 1) / 2, y: (level.y0 + level.y1 + 1) / 2 };
        half = fit;
        target = { half, ...at };
        place();
      }
      target.half = Math.min(target.half, fit + LEVEL_MARGIN / 2);
    } else {
      const b = island();
      if (b.max_cx < b.min_cx) return; // not heard yet
      const m = PAN_MARGIN_CHUNKS;
      [minX, maxX, minY, maxY] = [(b.min_cx - m) * CHUNK_SIZE, (b.max_cx + 1 + m) * CHUNK_SIZE, (b.min_cy - m) * CHUNK_SIZE, (b.max_cy + 1 + m) * CHUNK_SIZE];
    }

    target.x = clampAxis(target.x, minX, maxX, target.half * aspect());
    target.y = clampAxis(target.y, minY, maxY, target.half);
    const x = clampAxis(at.x, minX, maxX, half * aspect());
    const y = clampAxis(at.y, minY, maxY, half);
    if (x !== at.x || y !== at.y) {
      at = { x, y };
      place();
    }
  }

  /**
   * Zoom to `size` while keeping whatever sits under (clientX, clientY) pinned
   * there. The ground under a pixel lies off the middle by an amount that
   * grows with the zoom and nothing else, so it is found once by a ray and
   * scaled. Only the target moves, so the same lerp that carries a wheel
   * zoom carries this one.
   */
  function zoomToward(size: number, clientX: number, clientY: number) {
    const { wx, wy } = screenToWorld(scene, canvas, { clientX, clientY });
    const [ux, uy] = [(wx - at.x) / half, (wy - at.y) / half];
    const next = Math.max(2, Math.min(100, size));
    target = { half: next, x: target.x + ux * (target.half - next), y: target.y + uy * (target.half - next) };
  }

  eye.go = (x, y) => {
    setFollowing(null);
    target = { ...target, x, y };
  };

  // The fixture shots point the camera from outside: straight to a place and
  // a zoom, no travel. Dev only.
  if (import.meta.env.DEV) {
    (window as unknown as { sprawlCamera: unknown }).sprawlCamera = {
      look(x: number, y: number, size: number) {
        at = { x, y };
        half = size;
        target = { half, ...at };
        place();
      },
    };
  }

  // Subscription is chunk-granular, so panning within a chunk sends nothing.
  function sendViewportIfChanged() {
    const chunk = (v: number) => Math.floor(v / CHUNK_SIZE);
    const { x0, y0, x1, y1 } = groundCover(scene, canvas);
    const data = { min_cx: chunk(x0) - PAD, min_cy: chunk(y0) - PAD, max_cx: chunk(x1) + PAD, max_cy: chunk(y1) + PAD };
    const key = Object.values(data).join();

    // A server that welcomed us since knows nothing of what we asked for.
    const welcome = welcomed();
    if (welcome === lastWelcome && key === lastChunks) return;

    // Only remember bounds the server actually heard. The socket is still
    // opening on the first frames, and caching a dropped send would leave the
    // client subscribed to nothing until it happened to pan across a chunk.
    if (!send({ type: "SetChunks", data })) return;
    lastChunks = key;
    lastWelcome = welcome;
  }

  // Smooth zoom animation
  const stopBefore = beforeRender(() => {
    if (flying) return;
    const f = following();
    if (f !== null) {
      const p = positionOf(f);
      if (p) target = { ...target, x: p[0], y: p[1] - (eye.below * half) / Math.max(1, canvas.clientHeight) };
    }
    const [dSize, dX, dY] = [target.half - half, target.x - at.x, target.y - at.y];
    if (Math.abs(dSize) > 0.01 || Math.abs(dX) > 0.001 || Math.abs(dY) > 0.001) {
      half += dSize * ZOOM_LERP_SPEED;
      at = { x: at.x + dX * ZOOM_LERP_SPEED, y: at.y + dY * ZOOM_LERP_SPEED };
      place();
    }
    clampToIsland();
    sendViewportIfChanged();
    Object.assign(eye, at);
  });

  // Panning & pinch-to-zoom: the ground under the pointer stays under it.
  const pointers = new Map<number, { clientX: number; clientY: number }>();
  let lastPinchDist = 0;
  let last = { clientX: 0, clientY: 0 };

  /** Where the pointers are, between them all. */
  function centre() {
    const pts = [...pointers.values()];
    return { clientX: pts.reduce((s, p) => s + p.clientX, 0) / pts.length, clientY: pts.reduce((s, p) => s + p.clientY, 0) / pts.length };
  }
  function pinchDistance(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  /** Drag the ground under `from` to under `to`. */
  function drag(from: { clientX: number; clientY: number }, to: { clientX: number; clientY: number }) {
    if (from.clientX === to.clientX && from.clientY === to.clientY) return;
    const a = screenToWorld(scene, canvas, from);
    const b = screenToWorld(scene, canvas, to);
    setFollowing(null);
    shift(a.wx - b.wx, a.wy - b.wy);
  }

  const onPointerDown = (e: PointerEvent) => {
    // A tool has the left button, so the right one always pans. Without it a
    // build mode is one you cannot move around in.
    if (inHand() && e.button !== 2) return;
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    last = centre();
    if (pointers.size === 2) lastPinchDist = pinchDistance();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId) || flying) return;
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    const now = centre();
    drag(last, now);
    last = now;
    if (pointers.size !== 2) return;
    const dist = pinchDistance();
    zoomToward(target.half * (lastPinchDist / Math.max(dist, 1)), now.clientX, now.clientY);
    lastPinchDist = dist;
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);
    if (pointers.size) last = centre();
  };

  // Right-drag is a pan, so the menu it would otherwise raise is in the way.
  const preventContextMenu = (e: Event) => e.preventDefault();

  const onWheel = (e: WheelEvent) => {
    // A building in hand is turned by the wheel (`Brush`).
    if (flying || held()) return;
    e.preventDefault();
    zoomToward(target.half * (1 + e.deltaY * 0.001), e.clientX, e.clientY);
  };

  // F9 flies: a wide lens and the controls handed over.
  let detachFlying = () => {};
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "F9") return;
    flying = !flying;
    if (flying) {
      camera.fov = 0.8;
      camera.position.set(at.x, at.y - 10, 8);
      camera.target.set(at.x, at.y, 0);
      detachFlying = attachFreeControl(camera, canvas, scene);
    } else {
      detachFlying();
      camera.fov = FOV;
      place();
    }
  };

  const keep = () => {
    if (!props.bounds) localStorage.setItem(KEPT, JSON.stringify({ ...at, half }));
  };
  const onHide = () => document.visibilityState === "hidden" && keep();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", preventContextMenu);
  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onHide);

  onCleanup(() => {
    keep();
    stopBefore();
    detachFlying();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", preventContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", onHide);
    if (scene.camera === camera) scene.camera = null;
  });

  return <></>;
}
