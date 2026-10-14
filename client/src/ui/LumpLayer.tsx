import { For, Show, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { getEntity, recentLumps } from "../state/gameObjects";
import { GoodIcon, GOODS, middle } from "../blueprints";
import type { Building, Lump } from "../generated";

/**
 * What lands on the map: coins as goods cross the border, a box landing
 * from the world or one going out on the ferry; GDP as value is added,
 * a meal served, a crop cut, a shift at a desk; and goods, a box unloaded
 * onto a depot's shelf, or stone off it for a road laid. Each lump floats up over its building for a
 * moment and fades — the event the meter sums, seen where it happened.
 * Green is coins arriving, red coins leaving, violet GDP, the level's
 * colour; goods pop up bigger, in their own colour, with their glyph.
 * docs/trade.md.
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
      <For each={recentLumps().filter(seen)}>
        {(lump) => (
          <div
            ref={(el) => {
              els.set(lump.key, el);
              // Where it lands at once, not on the next frame: a slow frame
              // would show it in the corner first.
              queueMicrotask(place);
              onCleanup(() => els.delete(lump.key));
            }}
            class="lump absolute left-0 top-0"
            classList={{ goods: goods(lump) }}
          >
            <span
              class="flex -translate-x-1/2 -translate-y-12 items-center gap-1 whitespace-nowrap rounded-full font-bold tabular-nums text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
              classList={{ "px-1.5 py-0.5 text-[11px]": !goods(lump), "pl-1.5 pr-2.5 py-1 text-[15px]": goods(lump) }}
              style={{ "background-color": goods(lump) ? GOODS[lump.good!].color : lump.gdp > 0 ? "#7B77E0" : lump.coins < 0 ? "#D9483B" : "#57A773" }}
            >
              <Show when={lump.good}>{(g) => <GoodIcon good={g()} width={goods(lump) ? 18 : 11} height={goods(lump) ? 18 : 11} />}</Show>
              {lump.coins < 0 || lump.units < 0 ? "−" : "+"}
              {amount(Math.abs(lump.units || lump.gdp || lump.coins))}
              <Show when={goods(lump)}>
                <span class="font-semibold opacity-90">{GOODS[lump.good!].label}</span>
              </Show>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Worth a lump: a tank topped up from a depot's shelf moves a coin's hundredths. */
const seen = (l: Lump) => l.units !== 0 || Math.abs(l.coins) >= 0.05 || l.gdp >= 0.05;

/** Goods unloaded at a depot, or taken off its shelf, not coins or GDP. */
const goods = (l: Lump) => l.units !== 0 && l.good !== null;

/** To a tenth under ten, whole over it. */
const amount = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString());
