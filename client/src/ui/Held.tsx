/** @jsxImportSource ~ui */
import { createSignal, Show } from "solid-js";
import { town } from "../state/town";
import { aim } from "./buildMode";
import { BLUEPRINTS } from "../blueprints";
import { BAD, GOOD, onMap } from "./kit";

/** The building in hand's tag, over the far edge of its plot: its name,
 *  how many of it are in hand, and whether it may be let go here, or why
 *  not. */
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
      <glass layer="toast" at={{ left: 0, top: 0 }} x={at()!.sx - size()[0] / 2} y={at()!.sy - size()[1]} round={16} pad={{ x: 14, y: 8 }} gap={2} onSize={(w, h) => setSize([w, h])}>
        <box dir="row" align="center" gap={10}>
          <text size={13} weight={600}>{BLUEPRINTS[aim()!.kind].label}</text>
          <text size={13} soft>{`${town().tokens[aim()!.kind] ?? 0} in hand`}</text>
        </box>
        <text size={12} ink={aim()!.why ? BAD : GOOD}>{aim()!.why ?? "Let go to build"}</text>
      </glass>
    </Show>
  );
}
