/** @jsxImportSource ~ui */
import { createMemo, createRoot, Index, Show } from "solid-js";
import { eachEntity } from "../state/gameObjects";
import { now, sea } from "../state/sea";
import { GOOD_ORDER } from "../state/deals";
import { GOODS } from "../blueprints";
import { Shelf } from "./Depot";
import type { Building, Good } from "../generated";

/** Every standing depot's shelves added up, a good at a time, with what
 *  is on its way in. */
const totals = createRoot(() => createMemo(() => {
  now();
  const sum = new Map<Good, { level: number; cap: number }>();
  eachEntity((e) => {
    if (e.object.kind !== "Building") return;
    const b = e.object.data as Building;
    if (b.kind !== "Depot" || b.site) return;
    for (const g of GOOD_ORDER) {
      const s = b.stocks[g];
      if (!s) continue;
      const t = sum.get(g) ?? { level: 0, cap: 0 };
      sum.set(g, { level: t.level + s.level, cap: t.cap + s.cap });
    }
  });
  return GOOD_ORDER.filter((g) => sum.has(g)).map((good) => ({
    good,
    ...sum.get(good)!,
    incoming: sea.shipments.filter((s) => s.good === good && !s.outbound).reduce((a, s) => a + s.units, 0),
  }));
}));

/** The stock tab's head: each good the town keeps, and how much of it. */
export function StockHead() {
  return (
    <Show
      when={totals().length}
      fallback={
        <box pad={{ x: 16, top: 14, bottom: 14 }}>
          <text size={14} weight={600} soft>Goods are kept in a depot</text>
        </box>
      }
    >
      <box dir="row" align="center" justify="between" pad={{ x: 16, top: 14, bottom: 12 }}>
        <Index each={totals()}>
          {(t) => (
            <box dir="row" align="center" gap={5}>
              <box w={28} h={28} round={9} fill={GOODS[t().good].color} align="center" justify="center">
                <icon d={GOODS[t().good].glyph} size={16} ink="white" />
              </box>
              <text serif size={18}>{Math.floor(t().level)}</text>
            </box>
          )}
        </Index>
      </box>
    </Show>
  );
}

/** Drawn up: each good's shelves, all depots' as one, and what is coming. */
export function StockBody() {
  return (
    <box pad={{ x: 16, bottom: 12 }}>
      <Index each={totals()}>{(t) => <Shelf good={t().good} level={t().level} cap={t().cap} incoming={t().incoming} />}</Index>
    </box>
  );
}
