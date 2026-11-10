import { work } from "./budget";
import { perfCount, run } from "./PerfReport";
import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  Show,
  type ParentProps,
} from "solid-js";
import {
  createEngine,
  createSceneContext,
  disposeEngine,
  enableMaterialPlugins,
  enablePbrMaterialPluginVertexData,
  enablePixelTextureMipmaps,
  enableSurfaceResizeObserver,
  isGpuTimingSupported,
  registerSceneWithShadowSupport,
  renderFrame,
  resizeEngine,
  setGpuTimingEnabled,
  type EngineContext as Engine,
  type SceneContext,
} from "./gpu";
import { theme } from "./theme";
import { Culler } from "./cull";
import { createOutline, type Outline } from "./outline";
import { createStill, type Still } from "./still";
import { createStudio } from "./studio";

export type EngineContext = {
  engine: Engine;
  scene: SceneContext;
  canvas: HTMLCanvasElement;
  /** Run before every frame is drawn, after the one before; returns how to stop. */
  beforeRender(fn: () => void): () => void;
  /** Run after every frame is drawn; returns how to stop. */
  afterRender(fn: () => void): () => void;
  /** What of the world is drawn: what lies in view (`cull.ts`). */
  cull: Culler;
  /** The outline round what is picked and under the pointer (`outline.ts`). */
  outline: Outline;
  /** The still town, drawn once and kept, and what moves drawn over it (`still.ts`). */
  still: Still;
  /** Work the scene waits for before it is registered. */
  prepare(work: Promise<unknown>): void;
  /** Whether the scene is registered: what is drawn is added from then on,
   *  the light, its shadows and the sky before (`Scene.tsx`). */
  registered: () => boolean;
};

const BabylonContext = createContext<EngineContext>();

/** What is drawn, once the scene is registered (`registered`). */
export function Registered(props: ParentProps) {
  const { registered } = useEngine();
  return <Show when={registered()}>{props.children}</Show>;
}

export function useEngine() {
  const ctx = useContext(BabylonContext);
  if (!ctx) throw new Error("useEngine must be used within <Canvas>");
  return ctx;
}

/**
 * Device pixel ratio the map is rendered at, at most. Flat colour and a
 * two-pixel grid gain nothing past 2, and a phone at 3 shades over twice the
 * pixels for it — on every pass, the shadow-receiving ground included.
 */
const MAX_DEVICE_RATIO = 2;
/** A phone's, a touch screen's: a third of the pixels again, the town a
 *  little softer, the phone cooler for it; the menus are HTML, as sharp. */
const PHONE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const DEVICE_RATIO = PHONE ? 1.3 : MAX_DEVICE_RATIO;
/** And in this many pixels at most, whatever the ratio: what a frame costs
 *  the GPU is mostly its pixels, and a laptop's retina screen at 2 is near
 *  six million of them, four times a phone's, and runs hot for it. Here it
 *  is drawn at about 1.4 instead, the flat colours no worse for it. */
const MAX_PIXELS = 3e6;
/** And less again while the GPU cannot keep up, judged as the view moves
 *  over the middle of the last `JUDGED` frames, to a pixel to the CSS pixel
 *  at the least. Where the GPU's own time can be read, a step down when it
 *  is over `GPU_MS` and up when a step up would still be under it, a ratio's
 *  pixels being its square. Where not, by the gaps between frames: down
 *  when they come later than `LATE_MS`, those after a long task left out,
 *  which is the main thread's and no fault of the GPU; up after keeping
 *  time `RETRY_MS`, but never back to a ratio it was late at. A slow phone
 *  draws softer and keeps its frames and its battery; a fast GPU never
 *  knows. A step up must still be well under (`UP_SHARE` of `GPU_MS`), so
 *  it does not step back down a moment later.
 *
 *  A new ratio resizes the canvas, which clears it, black until the GPU
 *  has drawn the next frame: while it is behind, a second or more. So a
 *  ratio judged is drawn at only once the view has stood still `REST_MS`,
 *  the GPU no longer behind, and `SWITCH_MS` after the last. */
const JUDGED = 120;
const GPU_MS = 12;
const UP_SHARE = 0.75;
const REST_MS = 500;
const SWITCH_MS = 30_000;
const LATE_MS = 22;
const STEP = 0.8;
const RETRY_MS = 10_000;

/** Frames a second while the view moves: a 120Hz display shows the town no
 *  better than a 60Hz one, for twice the shading. A phone too: a moving
 *  frame slides the still picture (`still.ts`) and draws the cars over it. */
const MOVING_FPS = 60;
/** Frames a second while it stands still. Cars and water move a few pixels a
 *  frame, smooth enough at 30; a pan moves every pixel, and wants 60.
 *  `?stillfps=<n>`. */
const STILL_FPS = Number(new URLSearchParams(location.search).get("stillfps")) || (PHONE ? 20 : 30);
/** How long the view counts as moving after it last moved. A drag's pointer
 *  events do not land before every tick: one that finds the camera where the
 *  last frame left it would fall back to the still rate mid-pan, and the pan
 *  stutters between 60 and 30. */
const MOVING_LINGER_MS = 100;
/** The bench's power run holds the frame rate here, whatever moves: 0 draws nothing. */
export const forced: { fps: number | null } = { fps: null };
/** A frame drawn now, not at the next tick, as the frame rate allows: a
 *  drag calls it on each pointer move, so the map is drawn where the
 *  pointer just went, and the tick after finds the frame done. */
export const drawNow = { run: () => {} };
/** Work that can wait (`budget.ts`) runs in each tick until this long after
 *  the tick began, leaving a 60 Hz frame room to spare. */
const WORK_MS = 10;
/** And at least this share of the time the last frame took. */
const WORK_SHARE = 0.25;

/** A list of callbacks run in order, each able to take itself off. */
function hooks() {
  const fns = new Set<() => void>();
  return {
    add(fn: () => void) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    run() {
      for (const fn of fns) fn();
    },
  };
}

export default function Canvas(props: ParentProps) {
  const [ctx, setCtx] = createSignal<EngineContext>();
  const [registered, setRegistered] = createSignal(false);
  // Set once the engine is up; the canvas's owner is gone by then, so it is taken down from here.
  let stop = () => {};
  onCleanup(() => stop());

  const initCanvas = async (el: HTMLCanvasElement) => {
    // Multisampled only where pixels are big enough to show their edges.
    const engine = await createEngine(el, { maxDevicePixelRatio: MAX_DEVICE_RATIO, msaaSamples: devicePixelRatio < 2 ? 4 : 1 });
    const stopResizing = enableSurfaceResizeObserver(engine.surfaces[0]);
    const scene = createSceneContext(engine);
    const land = theme.land;
    scene.clearColor = { r: land.r, g: land.g, b: land.b, a: 1 };
    // Every material of the town's is made of plugins, some reading data of their own off the vertices.
    enableMaterialPlugins(scene);
    enablePbrMaterialPluginVertexData();
    await enablePixelTextureMipmaps();

    const before = hooks();
    const after = hooks();
    const cull = new Culler(scene, el);

    // The children set the scene up — the camera, the sun and its shadows,
    // the sky — before it is registered: Lite builds its shaders for what
    // the scene holds then. What is drawn is added once it is, and built as
    // it comes: added while it is being registered, it would be built for
    // what the scene held before.
    const still = createStill(engine, scene);
    const outline = createOutline(engine, scene);
    const preparing: Promise<unknown>[] = [];
    setCtx({ engine, scene, canvas: el, beforeRender: before.add, afterRender: after.add, cull, outline, still, registered, prepare: (work) => preparing.push(work) });
    await Promise.all(preparing);
    await registerSceneWithShadowSupport(scene);
    setRegistered(true);
    // The build menu's pictures, taken off the page once the town is in.
    const stopStudio = createStudio(engine);
    // The page's canvas alone: the studio's is drawn when it takes a picture.
    const page = [engine.surfaces[0]] as const;

    // Ticks that come much sooner than a frame are skipped. Ticks jitter,
    // a fraction early or late: one counts if three quarters of a frame
    // has passed, so a 60Hz display renders every one of them, a 120Hz
    // one every other, and none is dropped for landing a hair early.
    // The view is moving if the camera stands elsewhere than after the last
    // frame (a drag moves it between frames), or that frame moved it (a
    // zoom glides on inside them), and for a moment after (`MOVING_LINGER_MS`).
    let lastFrame = 0;
    let seen = "";
    let lastMoved = -Infinity;
    // Held while something outside draws the frames itself (`cost.ts`).
    let held = false;
    let running = true;
    // The ratio drawn at, as the frames have kept time at it (`JUDGED`).
    let [ratio, ceiling, keptSince, longEnded] = [Infinity, Infinity, 0, 0];
    // And the ratio the canvas is at, and when it last changed.
    let [shown, switched] = [Infinity, -Infinity];
    const timed = isGpuTimingSupported(engine);
    if (timed) setGpuTimingEnabled(engine, true);
    else if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      new PerformanceObserver((list) => list.getEntries().forEach((e) => (longEnded = Math.max(longEnded, e.startTime + e.duration)))).observe({ type: "longtask" });
    }
    const samples: number[] = [];
    const judge = (now: number, delta: number, cap: number) => {
      // Nothing judged while a ratio waits to be drawn at: it is not what the frames are drawn at.
      if (ratio !== shown) return void (samples.length = 0);
      const drawn = Math.min(cap, ratio);
      if (!timed && now - longEnded < 2 * delta) return;
      samples.push(timed ? engine.gpuFrameTimeMs : delta);
      if (samples.length < JUDGED) return;
      const middle = [...samples].sort((a, b) => a - b)[JUDGED / 2];
      samples.length = 0;
      const up = Math.min(cap, drawn / STEP);
      if (middle > (timed ? GPU_MS : LATE_MS)) {
        if (drawn > 1) [ceiling, ratio] = [drawn, Math.max(1, drawn * STEP)];
        keptSince = now;
      } else if (drawn < cap && (timed ? middle * (up / drawn) ** 2 < GPU_MS * UP_SHARE : now - keptSince > RETRY_MS && up < ceiling)) [ratio, keptSince] = [up, now];
    };
    const where = () => {
      const c = scene.camera;
      return c ? `${c.worldMatrixVersion},${c.fov}` : "";
    };
    const draw = (now: number) => {
      if (held) return;
      if (where() !== seen) lastMoved = now;
      const moving = now - lastMoved < MOVING_LINGER_MS;
      const fps = forced.fps ?? (moving ? MOVING_FPS : STILL_FPS);
      if (fps === 0 || now - lastFrame < (1000 / fps) * 0.75) return work(now + WORK_MS);
      const delta = now - lastFrame;
      lastFrame = now;
      const began = performance.now();
      const was = where();
      // Our own loop, not Lite's: the canvas follows the window only if asked to.
      const cap = Math.min(DEVICE_RATIO, devicePixelRatio, Math.sqrt(MAX_PIXELS / Math.max(1, el.clientWidth * el.clientHeight)));
      if (moving) judge(now, delta, cap);
      const caught = timed ? engine.gpuFrameTimeMs < GPU_MS : delta < LATE_MS * 2;
      if (ratio !== shown && now - lastMoved > REST_MS && now - switched > SWITCH_MS && caught) [shown, switched] = [ratio, now];
      engine.surfaces[0].maxDevicePixelRatio = Math.min(cap, shown);
      resizeEngine(engine);
      // A frame's own work, then its drawings: the still picture's, when one
      // is due, and the live things'.
      before.run();
      cull.update();
      still.frame(now, () => renderFrame(engine, delta, page));
      after.run();
      seen = where();
      if (seen !== was) lastMoved = now;
      perfCount("frame.jsMs", performance.now() - began);
      perfCount("frame.count");
      // A share of the clock, not of the frame: on a slow device a frame
      // takes long, and work given a frame's fixed slice falls behind for
      // good, the town and every update waiting on it.
      work(performance.now() + Math.max(WORK_MS, delta * WORK_SHARE));
    };
    const frame = (now: number) => {
      if (!running) return;
      requestAnimationFrame(frame);
      draw(now);
    };
    requestAnimationFrame(frame);
    drawNow.run = () => running && draw(performance.now());

    if (import.meta.env.DEV) {
      (window as unknown as { sprawlLite: unknown }).sprawlLite = { engine, scene, cull, hideUi: () => (document.querySelectorAll<HTMLElement>(".ink").forEach((e) => (e.style.display = "none")), true) };
    }
    // The bench ends on it (`PerfReport.tsx`).
    if (import.meta.env.DEV || run) {
      void import("./cost").then(({ costMeter }) => {
        (window as unknown as { sprawlCost: unknown }).sprawlCost = costMeter(
          engine,
          scene,
          () => {
            before.run();
            cull.update();
            still.frame(performance.now(), () => renderFrame(engine, 16, page), true);
            after.run();
          },
          (h) => (held = h),
        );
      });
    }

    stop = () => {
      running = false;
      stopStudio();
      stopResizing();
      disposeEngine(engine);
    };
  };

  return (
    <>
      <canvas
        ref={(el) => void initCanvas(el)}
        style={{ width: "100vw", height: "100vh", display: "block", "touch-action": "none" }}
      />
      <Show when={ctx()}>
        {(c) => <BabylonContext.Provider value={c()}>{props.children}</BabylonContext.Provider>}
      </Show>
    </>
  );
}
