import { onCleanup } from "solid-js";
import { render, type UiNode } from "./ui/node";
import { root } from "./ui/paint";
import Feed from "../ui/gpu/Feed";

/** The UI the GPU draws (`ui/gpu/`), mounted on its tree here, inside the
 *  page's, so it reads the game and the engine as the page's UI does. */
export default function Hud() {
  onCleanup(render(() => Feed() as unknown as UiNode, root));
  return null;
}
