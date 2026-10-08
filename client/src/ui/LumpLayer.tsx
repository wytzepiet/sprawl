import { For, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { getEntity, recentLumps } from "../state/gameObjects";
import { middle } from "../blueprints";
import type { Building } from "../generated";

/**
 * Money landing on the map: a visit paid for, a day's takings swept, a
 * delivery bought. Each lump floats up over its building for a moment and
 * fades — the event the meter sums, seen where it happened. Green is money
 * arriving, red is money leaving. docs/economy.md §10.
 */
export default function LumpLayer() {
  const { scene, canvas, afterRender } = useEngine();
  const els = new Map<number, HTMLElement>();

  const place = () => {
    if (!scene.camera) return;
    const project = projector(scene, canvas);
    for (const lump of recentLumps()) {
      const el = els.get(lump.key);
      const e = getEntity(lump.building);
      if (!el || !e?.position || e.object.kind !== "Building") continue;
      const { sx, sy } = project.at(...middle(e.object.data as Building));
      el.style.transform = `translate(${sx}px, ${sy}px)`;
    }
  };
  onCleanup(afterRender(place));

  return (
    <div class="lumps fixed inset-0 pointer-events-none select-none">
      <For each={recentLumps()}>
        {(lump) => (
          <div
            ref={(el) => {
              els.set(lump.key, el);
              onCleanup(() => els.delete(lump.key));
            }}
            class="lump absolute left-0 top-0"
          >
            <span
              class="block -translate-x-1/2 -translate-y-12 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
              style={{ "background-color": lump.amount < 0 ? "#D9483B" : "#57A773" }}
            >
              {lump.amount < 0 ? "−" : "+"}
              {Math.abs(lump.amount) < 10 ? Math.abs(lump.amount).toFixed(1) : Math.round(Math.abs(lump.amount))}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
