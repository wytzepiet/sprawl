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
  onBeforeRender,
  registerSceneWithShadowSupport,
  renderFrame,
  type EngineContext as Engine,
  type SceneContext,
} from "@babylonjs/lite";
import { useTheme } from "./theme";
import { Culler } from "./cull";
import { createOutline, type Outline } from "./outline";

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
  /** Whether the scene is registered: what is drawn is added from then on,
   *  the light, its shadows and the sky before (`Scene.tsx`). */
  registered: () => boolean;
};

export const BabylonContext = createContext<EngineContext>();

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

/** Frames a second while the view moves: a 120Hz display shows the town no
 *  better than a 60Hz one, for twice the shading. */
const MOVING_FPS = 60;
/** Frames a second while it stands still. Cars and water move a few pixels a
 *  frame, smooth enough at 30; a pan moves every pixel, and wants 60. */
const STILL_FPS = 30;

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
  const theme = useTheme();
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
    const land = theme().land;
    scene.clearColor = { r: land.r, g: land.g, b: land.b, a: 1 };
    // Every material of the town's is made of plugins, some reading data of their own off the vertices.
    enableMaterialPlugins(scene);
    enablePbrMaterialPluginVertexData();
    await enablePixelTextureMipmaps();

    const before = hooks();
    const after = hooks();
    const cull = new Culler(scene, el);
    onBeforeRender(scene, () => {
      before.run();
      cull.update();
    });

    // The children set the scene up — the camera, the sun and its shadows,
    // the sky — before it is registered: Lite builds its shaders for what
    // the scene holds then. What is drawn is added once it is, and built as
    // it comes: added while it is being registered, it would be built for
    // what the scene held before.
    const outline = createOutline(engine, scene);
    setCtx({ engine, scene, canvas: el, beforeRender: before.add, afterRender: after.add, cull, outline, registered });
    await registerSceneWithShadowSupport(scene);
    setRegistered(true);

    // Ticks that come much sooner than a frame are skipped. Ticks jitter,
    // a fraction early or late: one counts if three quarters of a frame
    // has passed, so a 60Hz display renders every one of them, a 120Hz
    // one every other, and none is dropped for landing a hair early.
    // The view is moving if the camera stands elsewhere than after the last
    // frame (a drag moves it between frames), or that frame moved it (a
    // zoom glides on inside them).
    let lastFrame = 0;
    let seen = "";
    let moved = false;
    // Held while something outside draws the frames itself (`cost.ts`).
    let held = false;
    let running = true;
    const where = () => {
      const c = scene.camera;
      return c ? `${c.worldMatrixVersion},${c.ortho?.halfHeight}` : "";
    };
    const frame = (now: number) => {
      if (!running) return;
      requestAnimationFrame(frame);
      if (held) return;
      const fps = moved || where() !== seen ? MOVING_FPS : STILL_FPS;
      if (now - lastFrame < (1000 / fps) * 0.75) return;
      const delta = now - lastFrame;
      lastFrame = now;
      const was = where();
      renderFrame(engine, delta);
      after.run();
      seen = where();
      moved = seen !== was;
    };
    requestAnimationFrame(frame);

    if (import.meta.env.DEV) {
      (window as unknown as { sprawlLite: unknown }).sprawlLite = { engine, scene, cull };
      void import("./cost").then(({ costMeter }) => {
        (window as unknown as { sprawlCost: unknown }).sprawlCost = costMeter(engine, scene, after.run, (h) => (held = h));
      });
    }

    stop = () => {
      running = false;
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
