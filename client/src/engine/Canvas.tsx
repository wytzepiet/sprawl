import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  Show,
  type ParentProps,
} from "solid-js";
import { Engine, Scene, WebGPUEngine, type AbstractEngine } from "@babylonjs/core";
import { useTheme } from "./theme";

export type EngineContext = {
  engine: AbstractEngine;
  scene: Scene;
  canvas: HTMLCanvasElement;
};

export const BabylonContext = createContext<EngineContext>();

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

/**
 * Frames per second, at most, while the mayor's hand is on the map: it pans
 * at the pointer's pace, which a 120Hz display can show no more of than a
 * 60Hz one. Left alone, the town moves at its own pace, cars and the light,
 * which half that shows as well, for half the shading: a fanless laptop
 * runs cool on it.
 */
const HANDLED_FPS = 60;
const ALONE_FPS = 30;
/** How long after the last touch the map stays at the faster rate: long
 *  enough for the camera to glide to rest. */
const HANDLED_FOR_MS = 1200;

async function createEngine(el: HTMLCanvasElement): Promise<AbstractEngine> {
  const options = { adaptToDeviceRatio: true, limitDeviceRatio: MAX_DEVICE_RATIO };
  if (navigator.gpu) {
    // Not CreateAsync: it wraps this in a promise that never settles when no
    // adapter is granted, so a browser that has WebGPU but withholds the GPU
    // — Chrome on a blocklisted phone — would hang here with no engine at all.
    // An engine that failed to init holds no device, and disposing one throws
    // inside Babylon; the canvas is simply handed to WebGL instead.
    // Every feature the adapter has, rather than none: the pen reads steps
    // off a depth map it mips, which wants full floats that can be filtered.
    const engine = new WebGPUEngine(el, { ...options, enableAllFeatures: true });
    try {
      await engine.initAsync();
      return engine;
    } catch (_) {
      // fall through to WebGL
    }
  }
  return new Engine(el, true, options, true);
}

export default function Canvas(props: ParentProps) {
  const theme = useTheme();
  const [ctx, setCtx] = createSignal<EngineContext>();

  const initCanvas = (el: HTMLCanvasElement) => {
    createEngine(el).then((engine) => {
      const scene = new Scene(engine);
      scene.clearColor = theme().land.clone();

      requestAnimationFrame(() => engine.resize());

      // Ticks that come sooner than a frame are skipped. The remainder is
      // carried, so a 60Hz display whose ticks land a fraction early settles
      // on rendering every one of them rather than every other.
      let lastFrame = 0;
      let handledUntil = 0;
      const handled = () => (handledUntil = performance.now() + HANDLED_FOR_MS);
      for (const kind of ["pointerdown", "pointermove", "wheel"] as const) el.addEventListener(kind, handled, { passive: true });
      window.addEventListener("keydown", handled);
      engine.runRenderLoop(() => {
        const now = performance.now();
        const frameMs = 1000 / (now < handledUntil ? HANDLED_FPS : ALONE_FPS);
        const elapsed = now - lastFrame;
        if (elapsed < frameMs) return;
        lastFrame = now - (elapsed % frameMs);
        scene.render();
      });

      const onResize = () => engine.resize();
      window.addEventListener("resize", onResize);

      setCtx({ engine, scene, canvas: el });

      onCleanup(() => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("keydown", handled);
        engine.dispose();
      });
    });
  };

  return (
    <>
      <canvas
        ref={initCanvas}
        style={{ width: "100vw", height: "100vh", display: "block", "touch-action": "none" }}
      />
      <Show when={ctx()}>
        {(c) => <BabylonContext.Provider value={c()}>{props.children}</BabylonContext.Provider>}
      </Show>
    </>
  );
}
