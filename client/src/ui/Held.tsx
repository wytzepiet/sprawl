import { Ink, Text } from "~ui";
import { createSignal, Show } from "solid-js";
import { aim } from "./buildMode";
import { BLUEPRINTS } from "../blueprints";
import { BAD, GOOD, onMap, ROUND } from "./kit";

/** The building in hand's tag, over the far edge of its plot: its name,
 *  and whether it may be let go here, or why not. */
export default function Held() {
  const at = onMap(() => {
    const p = aim();
    if (!p) return null;
    const xs = p.tiles.map((t) => t.x),
      ys = p.tiles.map((t) => t.y);
    return [(Math.min(...xs) + Math.max(...xs) + 1) / 2, Math.max(...ys) + 1.2, 0.6];
  });
  const [size, setSize] = createSignal([0, 0]);
  return (
    <Show when={aim() && at()}>
      <Ink layer="toast" at={{ left: 0, top: 0 }} x={at()!.sx - size()[0] / 2} y={at()!.sy - size()[1]} round={ROUND} pad={{ x: 14, y: 8 }} gap={2} onSize={(w, h) => setSize([w, h])}>
        <Text size={13} weight={600}>{BLUEPRINTS[aim()!.kind].label}</Text>
        <Text size={12} ink={aim()!.why ? BAD : GOOD}>{aim()!.why ?? "Let go to build"}</Text>
      </Ink>
    </Show>
  );
}
