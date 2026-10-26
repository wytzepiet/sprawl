import { createRoot, createSignal, on, createEffect } from "solid-js";
import { held, hold, tool } from "./buildMode";
import { select, selected } from "../state/selection";
import { BEZEL, view, wide } from "./kit";
import { clear } from "./pages";

/**
 * The dock's tabs, and the sheet over them, as the Find My app has it:
 * each tab has a sheet, peeking over the bar as its head alone, drawn up
 * to show the rest. What a tab is for is what it holds: the bare hand
 * a card of what it tapped, the roads their tools, the build menu its buildings,
 * the market its goods, what the town holds and its orders.
 */
export const TABS = ["select", "roads", "build", "market"] as const;
export type Tab = (typeof TABS)[number];

const [tab, setTab] = createSignal<Tab>("select");
const [open, setOpen] = createSignal(false);
export { tab, open, setOpen };

/** The sheet to a tab, drawn up or at its peek. Each tab owns what is
 *  in hand while it is shown: leaving the roads puts the road tool down,
 *  the build menu the building, the bare hand its card. */
export function show(t: Tab, opened: boolean) {
  if ((t !== "roads" && tool()) || (t !== "build" && held())) hold(null);
  if (t !== "select" && selected() !== null) select(null);
  clear();
  setTab(t);
  setOpen(opened);
}

/** The sheet's width: on a phone the screen's within the bezel, so the
 *  sheet rises as a chin of it. */
export const sheetWidth = () => (wide() ? 440 : view().w - 2 * BEZEL);

// Whatever comes into the hand shows its tab: a thing tapped, its card,
// open; a road tool, the roads; a building out of the menu, the build
// tab at its peek.
createRoot(() => {
  createEffect(on(selected, (id) => id !== null && show("select", true), { defer: true }));
  createEffect(on(tool, (t) => t !== null && show("roads", false), { defer: true }));
  createEffect(on(held, (h) => h !== null && show("build", false), { defer: true }));
});
