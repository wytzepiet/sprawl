import { createRoot, createSignal, on, createEffect } from "solid-js";
import { held, hold, setTool, tool } from "./buildMode";
import { select, selected } from "../state/selection";
import { view, wide } from "./kit";

/**
 * The dock's tabs, and the sheet over them, as the Find My app has it:
 * each tab has a sheet, peeking over the bar as its head alone, drawn up
 * to show the rest. What a tab is for is what it holds: the bare hand
 * a card of what it tapped, the roads their tools, the build menu its
 * buildings, the ferry new deals, the stock the town's shelves.
 */
export const TABS = ["select", "roads", "build", "trade", "stock"] as const;
export type Tab = (typeof TABS)[number];

const [tab, setTab] = createSignal<Tab>("select");
const [open, setOpen] = createSignal(false);
/** The trade tab's way: buying (false) or selling (true). */
const [selling, setSelling] = createSignal(false);
export { tab, open, setOpen, selling, setSelling };

/** The sheet to a tab, drawn up or at its peek. Each tab owns what is
 *  in hand while it is shown: leaving the roads puts the tool down,
 *  leaving the build menu the building, leaving the bare hand its card. */
export function show(t: Tab, opened: boolean) {
  if (t !== "roads" && tool()) setTool(null);
  if (t !== "build" && held()) hold(null);
  if (t !== "select" && selected() !== null) select(null);
  setTab(t);
  setOpen(opened);
}

/** The trade tab, open, buying or selling: the dock's ferry, a mission's step. */
export const trade = (out: boolean) => (setSelling(out), show("trade", true));

/** The sheet's width: on a phone the screen's, less a margin each side. */
export const sheetWidth = () => (wide() ? 440 : view().w - 24);

// Whatever comes into the hand shows its tab: a thing tapped, its card,
// open; a road tool, the road tools; a building out of the menu, the
// build tab at its peek, to let it go on and put it back.
createRoot(() => {
  createEffect(on(selected, (id) => id !== null && show("select", true), { defer: true }));
  createEffect(on(tool, (t) => t !== null && tab() !== "roads" && show("roads", false), { defer: true }));
  createEffect(on(held, (h) => h !== null && show("build", false), { defer: true }));
});
