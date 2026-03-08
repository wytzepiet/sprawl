import { createContext, useContext, createSignal, onCleanup, Show, type ParentProps } from "solid-js";
import { Engine, Scene } from "@babylonjs/core";

type ViewRegistration = {
  canvas: HTMLCanvasElement;
  scene: Scene;
  view: ReturnType<Engine["registerView"]>;
};

type MultiCanvasContextType = {
  engine: Engine;
  canvasSize: { width: number; height: number };
  registerView: (canvas: HTMLCanvasElement, scene: Scene) => void;
  unregisterView: (canvas: HTMLCanvasElement) => void;
};

const MultiCanvasContext = createContext<MultiCanvasContextType>();

export function useMultiCanvas() {
  const ctx = useContext(MultiCanvasContext);
  if (!ctx) throw new Error("useMultiCanvas must be used within <MultiCanvasProvider>");
  return ctx;
}

type Props = ParentProps<{
  canvasSize: { width: number; height: number };
}>;

export default function MultiCanvasProvider(props: Props) {
  const views = new Map<HTMLCanvasElement, ViewRegistration>();
  const [ctx, setCtx] = createSignal<MultiCanvasContextType>();

  const initMaster = (el: HTMLCanvasElement) => {
    const engine = new Engine(el, true, { adaptToDeviceRatio: true }, true);

    engine.runRenderLoop(() => {
      for (const reg of views.values()) {
        if (engine.activeView?.target === reg.canvas) {
          reg.scene.render();
        }
      }
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    setCtx({
      engine,
      get canvasSize() {
        return props.canvasSize;
      },
      registerView(canvas: HTMLCanvasElement, scene: Scene) {
        const view = engine.registerView(canvas, scene.activeCamera ?? undefined);
        views.set(canvas, { canvas, scene, view });
      },
      unregisterView(canvas: HTMLCanvasElement) {
        const reg = views.get(canvas);
        if (reg) {
          engine.unRegisterView(reg.canvas);
          views.delete(canvas);
        }
      },
    });

    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
    });
  };

  return (
    <>
      <canvas
        ref={initMaster}
        style={{
          position: "absolute",
          opacity: 0,
          "pointer-events": "none",
          "z-index": "-1",
          width: `${props.canvasSize.width}px`,
          height: `${props.canvasSize.height}px`,
        }}
        width={props.canvasSize.width}
        height={props.canvasSize.height}
      />
      <Show when={ctx()}>
        {(c) => (
          <MultiCanvasContext value={c()}>
            {props.children}
          </MultiCanvasContext>
        )}
      </Show>
    </>
  );
}
