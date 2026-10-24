import { onCleanup, type JSX } from "solid-js";
import { render, type UiNode } from "~ui";
import { root } from "~ui/paint";

/** The UI the GPU draws (`ui/`), mounted on its tree here, inside the
 *  page's, so it reads the game and the engine as the page's UI does. */
export default function Hud(props: { ui: () => JSX.Element }) {
  onCleanup(render(() => props.ui() as unknown as UiNode, root));
  return null;
}
