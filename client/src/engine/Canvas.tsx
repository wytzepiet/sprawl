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
 * Frames per second, at most. Cars move at the server's pace and the map pans
 * at the pointer's, neither of which a 120Hz display can show more of than a
 * 60Hz one; it only shades every pixel twice as often.
 */
const MAX_FPS = 60;
const FRAME_MS = 1000 / MAX_FPS;

async function createEngine(el: HTMLCanvasElement): Promise<AbstractEngine> {
  const options = { adaptToDeviceRatio: true, limitDeviceRatio: MAX_DEVICE_RATIO };
  if (navigator.gpu) {
    // Not CreateAsync: it wraps this in a promise that never settles when no
    // adapter is granted, so a browser that has WebGPU but withholds the GPU
    // — Chrome on a blocklisted phone — would hang here with no engine at all.
    // An engine that failed to init holds no device, and disposing one throws
    // inside Babylon; the canvas is simply handed to WebGL instead.
    const engine = new WebGPUEngine(el, options);
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
      engine.runRenderLoop(() => {
        const now = performance.now();
        const elapsed = now - lastFrame;
        if (elapsed < FRAME_MS) return;
        lastFrame = now - (elapsed % FRAME_MS);
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
