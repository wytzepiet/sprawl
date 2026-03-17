import {
  createSignal,
  onCleanup,
  Show,
  type ParentProps,
  type JSX,
} from "solid-js";
import { Scene } from "@babylonjs/core";
import { useMultiCanvas } from "./MultiCanvasProvider";
import { BabylonContext, type EngineContext } from "./Canvas";
import { useTheme } from "./theme";

type Props = ParentProps<{
  style?: JSX.CSSProperties;
  class?: string;
}>;

export default function MultiCanvasView(props: Props) {
  const theme = useTheme();

  const { engine, canvasSize, registerView, unregisterView } = useMultiCanvas();
  const [ctx, setCtx] = createSignal<EngineContext>();

  const initCanvas = (el: HTMLCanvasElement) => {
    const scene = new Scene(engine);
    scene.clearColor = theme().land;

    registerView(el, scene);

    requestAnimationFrame(() => engine.resize());

    setCtx({ engine, scene, canvas: el });

    onCleanup(() => {
      unregisterView(el);
      scene.dispose();
    });
  };

  return (
    <>
      <canvas
        ref={initCanvas}
        width={canvasSize.width}
        height={canvasSize.height}
        style={props.style}
        class={props.class}
      />
      <Show when={ctx()}>
        {(c) => <BabylonContext value={c()}>{props.children}</BabylonContext>}
      </Show>
    </>
  );
}
