import { createRoot, createSignal, on, createEffect } from "solid-js";
import { held, hold, tool } from "./buildMode";
import { select, selected } from "../state/selection";
import { view, wide } from "./kit";
import type { Good } from "../generated";

/**
 * The dock's tabs, and the sheet over them, as the Find My app has it:
 * each tab has a sheet, peeking over the bar as its head alone, drawn up
 * to show the rest. What a tab is for is what it holds: the bare hand
 * a card of what it tapped, the build menu its roads and buildings,
 * the market its goods, the stock what the town holds.
 */
export const TABS = ["select", "build", "market", "stock"] as const;
export type Tab = (typeof TABS)[number];

const [tab, setTab] = createSignal<Tab>("select");
const [open, setOpen] = createSignal(false);
/** The market's good whose page is shown; none, the list of them. */
const [good, setGood] = createSignal<Good | null>(null);
export { tab, open, setOpen, good, setGood };

/** The sheet to a tab, drawn up or at its peek. Each tab owns what is
 *  in hand while it is shown: leaving the build menu puts the road or
 *  the building down, leaving the bare hand its card. */
export function show(t: Tab, opened: boolean) {
  if (t !== "build" && (tool() || held())) hold(null);
  if (t !== "select" && selected() !== null) select(null);
  setTab(t);
  setOpen(opened);
}

/** The market, open on a good's page or the list: a mission's step. */
export const toMarket = (g: Good | null) => (setGood(g), show("market", true));

/** The sheet's width: on a phone the screen's, less a margin each side. */
export const sheetWidth = () => (wide() ? 440 : view().w - 24);

// Whatever comes into the hand shows its tab: a thing tapped, its card,
// open; a road tool or a building out of the menu, the build tab at
// its peek.
createRoot(() => {
  createEffect(on(selected, (id) => id !== null && show("select", true), { defer: true }));
  createEffect(on([tool, held], ([t, h]) => (t !== null || h !== null) && show("build", false), { defer: true }));
});
