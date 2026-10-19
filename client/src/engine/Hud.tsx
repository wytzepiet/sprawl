import { onCleanup } from "solid-js";
import { render, type UiNode } from "~ui";
import { root } from "~ui/paint";
import Gpu from "../ui/Hud";

/** The UI the GPU draws (`ui/`), mounted on its tree here, inside the
 *  page's, so it reads the game and the engine as the page's UI does. */
export default function Hud() {
  onCleanup(render(() => Gpu() as unknown as UiNode, root));
  return null;
}
