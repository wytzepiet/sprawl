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

async function createEngine(el: HTMLCanvasElement): Promise<AbstractEngine> {
  if (navigator.gpu) {
    try {
      return await WebGPUEngine.CreateAsync(el, { adaptToDeviceRatio: true });
    } catch (_) {
      // fall through to WebGL
    }
  }
  return new Engine(el, true, { adaptToDeviceRatio: true }, true);
}

export default function Canvas(props: ParentProps) {
  const theme = useTheme();
  const [ctx, setCtx] = createSignal<EngineContext>();

  const initCanvas = (el: HTMLCanvasElement) => {
    createEngine(el).then((engine) => {
      const scene = new Scene(engine);
      scene.clearColor = theme().land.clone();

      requestAnimationFrame(() => engine.resize());

      engine.runRenderLoop(() => scene.render());

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
        style={{ width: "100vw", height: "100vh", display: "block" }}
      />
      <Show when={ctx()}>
        {(c) => <BabylonContext.Provider value={c()}>{props.children}</BabylonContext.Provider>}
      </Show>
    </>
  );
}
