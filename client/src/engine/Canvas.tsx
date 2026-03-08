import { createContext, useContext, createSignal, onCleanup, Show, type ParentProps } from "solid-js";
import { Engine, Scene } from "@babylonjs/core";
import { useTheme } from "./theme";

export type EngineContext = { engine: Engine; scene: Scene; canvas: HTMLCanvasElement };

export const BabylonContext = createContext<EngineContext>();

export function useEngine() {
  const ctx = useContext(BabylonContext);
  if (!ctx) throw new Error("useEngine must be used within <Canvas>");
  return ctx;
}

export default function Canvas(props: ParentProps) {
  const [ctx, setCtx] = createSignal<EngineContext>();

  const initCanvas = (el: HTMLCanvasElement) => {
    const engine = new Engine(el, true, { adaptToDeviceRatio: true }, true);
    const scene = new Scene(engine);
    const theme = useTheme();
    scene.clearColor = theme.land;

    // Resize after first frame so canvas has layout dimensions
    requestAnimationFrame(() => engine.resize());

    engine.runRenderLoop(() => scene.render());

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    setCtx({ engine, scene, canvas: el });

    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
    });
  };

  return (
    <>
      <canvas
        ref={initCanvas}
        style={{ width: "100vw", height: "100vh", display: "block" }}
      />
      <Show when={ctx()}>
        {(c) => (
          <BabylonContext value={c()}>
            {props.children}
          </BabylonContext>
        )}
      </Show>
    </>
  );
}
