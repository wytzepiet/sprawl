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

/** Frames a second, at most: a 120Hz display shows the town no better
 *  than a 60Hz one, for twice the shading. */
const FPS = 60;

async function createEngine(el: HTMLCanvasElement): Promise<AbstractEngine> {
  const antialias = devicePixelRatio < 2;
  const options = { adaptToDeviceRatio: true, limitDeviceRatio: MAX_DEVICE_RATIO, antialias };
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
  return new Engine(el, antialias, options, true);
}

export default function Canvas(props: ParentProps) {
  const theme = useTheme();
  const [ctx, setCtx] = createSignal<EngineContext>();

  const initCanvas = (el: HTMLCanvasElement) => {
    createEngine(el).then((engine) => {
      const scene = new Scene(engine);
      scene.clearColor = theme().land.clone();

      requestAnimationFrame(() => engine.resize());

      // Ticks that come much sooner than a frame are skipped. Ticks jitter,
      // a fraction early or late: one counts if three quarters of a frame
      // has passed, so a 60Hz display renders every one of them, a 120Hz
      // one every other, and none is dropped for landing a hair early.
      let lastFrame = 0;
      engine.runRenderLoop(() => {
        const now = performance.now();
        if (now - lastFrame < (1000 / FPS) * 0.75) return;
        lastFrame = now;
        scene.render();
      });

      const onResize = () => engine.resize();
      window.addEventListener("resize", onResize);

      setCtx({ engine, scene, canvas: el });

      onCleanup(() => {
        window.removeEventListener("resize", onResize);
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
