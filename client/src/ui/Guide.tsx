/** @jsxImportSource ~ui */
import { createMemo, createSignal, Show } from "solid-js";
import { eachEntity } from "../state/gameObjects";
import { missions } from "../state/missions";
import { mayorsLorry, standing } from "../state/haul";
import { goodsOf, positionOf, selected } from "../state/selection";
import { BLUEPRINTS } from "../blueprints";
import { inHand } from "./buildMode";
import { onMap } from "./kit";
import type { Building, GridCoord } from "../generated";

/** The guide's face: a robot's, anonymous; named people are trade
 *  partners, and only them. */
export const GUIDE = "M11 1h2v3h-2zM5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7.5 9h3v3h-3zM13.5 9h3v3h-3zM8 14.5h8V16H8zM1 10h1.5v4H1zM21.5 10H23v4h-1.5z";

const middle = (tiles: GridCoord[]): [number, number] => {
  const xs = tiles.map((t) => t.x),
    ys = tiles.map((t) => t.y);
  return [(Math.min(...xs) + Math.max(...xs) + 1) / 2, (Math.min(...ys) + Math.max(...ys) + 1) / 2];
};

/** What the guide says now, and over what: the one thing to do next in
 *  the opening, where it is done. */
export function hint(): { at: [number, number]; say: string } | null {
  const step = missions().find((m) => m.key === "Opening" && m.finished === null)?.steps.find((s) => !s.done);
  if (!step) return null;
  const g = step.ghost;
  if (g && g.road.length) {
    const t = g.road[Math.floor(g.road.length / 2)];
    return { at: [t.x + 0.5, t.y + 0.5], say: "Draw a street along the dashes" };
  }
  if (g) return { at: middle(g.tiles), say: `Tap to place the ${BLUEPRINTS[g.kind].label.toLowerCase()}` };
  const lorry = mayorsLorry();
  const there = (id: number | null, say: string) => {
    const at = id === null ? null : positionOf(id);
    return at && { at, say };
  };
  if (lorry?.car.errand) return there(lorry.id, "Your lorry is on it");
  const pile = goodsOf(selected());
  if (step.goal.kind === "Sold") return pile ? there(step.at, "Now tap the harbour") : there(standing("Sawmill"), "Tap a bundle of timber");
  let site: number | null = null;
  let quay: number | null = null;
  eachEntity((e) => {
    if (e.object.kind !== "Building") return;
    const b = e.object.data as Building;
    if (b.site && site === null && b.site.Timber && b.site.Timber.level < b.site.Timber.cap) site = e.id;
    if (b.kind === "Harbour" && b.pad.some((p) => p.good === "Timber" && !p.outbound)) quay = e.id;
  });
  if (site === null) return null;
  if (pile) return there(site, "Now tap the site");
  return there(quay ?? standing("Sawmill"), "Tap the timber");
}

/**
 * The guide, speaking where you are looking: one short line in a bubble
 * over the thing it means, and nothing while something is in hand.
 */
export default function Guide() {
  const now = createMemo(() => (inHand() ? null : hint()), null, { equals: (a, b) => a?.say === b?.say && a?.at[0] === b?.at[0] && a?.at[1] === b?.at[1] });
  const at = onMap(() => {
    const h = now();
    return h && [h.at[0], h.at[1], 0.6];
  });
  const [size, setSize] = createSignal([0, 0]);
  return (
    <Show when={now() && at()}>
      <glass layer="toast" at={{ left: 0, top: 0 }} x={at()!.sx - size()[0] / 2} y={at()!.sy - size()[1] - 18} round={18} pad={{ x: 12, y: 8 }} dir="row" align="center" gap={8} onSize={(w, h) => setSize([w, h])}>
        <icon d={GUIDE} size={16} />
        <text size={13.5} weight={600}>{now()!.say}</text>
      </glass>
    </Show>
  );
}
