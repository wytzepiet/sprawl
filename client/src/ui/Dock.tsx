/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { follow } from "../engine/spring";
import { useEngine } from "../engine/Canvas";
import { eye } from "../engine/Camera";
import { held, setTool, tool } from "./buildMode";
import { BLUEPRINTS } from "../blueprints";
import { select, selected } from "../state/selection";
import { InspectBody, InspectHead } from "./Card";
import { setBoardOpen } from "./Board";
import { inHand as roadInHand, lastRoad, road, ROAD_KINDS, take } from "./Roads";
import { BuildBody, BuildHead } from "./Build";
import { FROSTED, MarketBody, MarketHead, setView } from "./Market";
import { open, setOpen, sheetWidth, show, tab, TABS, type Tab } from "./sheet";
import { Fade, Press, view, wide } from "./kit";
import { behind, clear, front, pages, Pages, pop } from "./pages";
import type { JSX } from "~ui/jsx-runtime";

const SELECT = "M4 2.5l16 8-7 2-2.6 7.5z";
/** A hammer. */
const BUILD = "M13.8 1.7L22.3 10.2L18.4 14.1L9.9 5.6ZM13.2 9L15 10.8L6.2 19.6L4.4 17.8Z";
/** A price's line, rising. */
const MARKET = "M3 20.5h18v-2H3zM3 15.5l5-5 4 3.5 6.5-7.5L21 9V3.5h-5.5l2 2-5 5.8-4-3.5L3 13z";

/** The dock's measure: a tab every 52px, the bar 60 tall. */
const SLOT = 52;
const BAR = 60;
const WIDTH = SLOT * TABS.length + 8;
const cx = (j: number) => 30 + SLOT * j;
const barBottom = () => (wide() ? 28 : 20);

/** Each tab's sheet: its head, peeking over the bar, and what is drawn up under it. */
const SHEETS: Record<Tab, { head: () => JSX.Element; body: () => JSX.Element }> = {
  select: { head: InspectHead, body: InspectBody },
  build: { head: BuildHead, body: BuildBody },
  market: { head: MarketHead, body: MarketBody },
};

/**
 * The dock: one sheet, the tabs fixed along its foot, the shown tab's
 * content grown up out of the bar over them, as the Find My app has it
 * (`sheet.ts`): its head peeking, drawn up by a finger or a tap, the
 * rest under it as tall as it is up to its room, and taller scrolls;
 * dragged down from its top, it sinks again. The bare hand, whose
 * sheet is the card of what it tapped; the build menu, roads and the
 * demolisher first; the market, the town's stock and its orders.
 *
 * What is in hand, in its colour, rides under its tab as dyed glass.
 */
export default function Dock() {
  const { canvas } = useEngine();

  // A press on the town takes the pages away, or sinks the sheet to its head.
  const away = () => (pages().length ? clear() : setOpen(false));
  canvas.addEventListener("pointerdown", away);
  onCleanup(() => canvas.removeEventListener("pointerdown", away));

  /** A tab pressed: shown, or, shown already, drawn up or sunk. The bare
   *  hand puts down what it holds. */
  const press = (t: Tab) => show(t, tab() === t ? !open() : t !== "select");
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toUpperCase();
    if (e.key === "Escape") setBoardOpen(false);
    if (e.key === "Escape" && pages().length) return pop();
    if (e.key === "Escape") return tool() || held() ? setTool(null) : open() && tab() !== "select" ? setOpen(false) : select(null);
    if (key === "V") return show("select", selected() !== null);
    if (key === "X") return take("Demolish");
    if (key === "B") return press("build");
    if (key === "M") return press("market");
    if (key === "S") return setView("stock"), show("market", true);
    if (key !== "R") return;
    // Again: the next road.
    const roads = ROAD_KINDS.filter((r) => r.id !== "Demolish");
    const i = roads.findIndex((r) => r.id === roadInHand());
    take(i < 0 ? (lastRoad() === "Demolish" ? "Street" : lastRoad()) : roads[(i + 1) % roads.length].id);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const bead = () => {
    const h = held(),
      r = roadInHand();
    return h ? BLUEPRINTS[h.kind].color : r ? road(r).color : undefined;
  };
  // The bead slides on a spring, and is drawn out by its own speed: long
  // and thin as it goes, round again as it lands.
  const [beadX, beadV] = follow(() => cx(TABS.indexOf(tab())));
  const [beadSize] = follow(() => (bead() ? 1 : 0.2), { rest: 0.002 });
  const stretch = () => Math.min(0.45, Math.abs(beadV()) / 1400);
  const beadW = () => 40 * beadSize() * (1 + stretch());
  const beadH = () => 40 * beadSize() * (1 - stretch() / 2);

  const glyph = (t: Tab) =>
    t === "select" ? SELECT
    : t === "build" ? (held() ? BLUEPRINTS[held()!.kind].glyph : roadInHand() ? road(roadInHand()!).glyph : BUILD)
    : MARKET;

  // The sheet's content, its height and the room it may take; with
  // nothing to show the dock is the bar alone, as narrow as its tabs.
  const [headH, setHeadH] = createSignal(0);
  const [bodyH, setBodyH] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  /** Where a finger holds the content's height, while it does. */
  const [pull, setPull] = createSignal<number | null>(null);
  const shown = () => tab() !== "select" || selected() !== null;
  const room = () => Math.max(0, (wide() ? Math.min(560, view().h - 240) : view().h * 0.62) - headH());
  const openH = () => headH() + Math.min(bodyH(), room());
  // Under a page it stands out over the page's top, smaller and blank.
  const under = () => (pages().length ? behind(front(), pages().length) : null);
  const [h] = follow(() => (under() ? under()!.h - BAR : shown() ? pull() ?? (open() ? openH() : headH()) : 0), { rest: 0.2 });
  const [w] = follow(() => (shown() || under() ? sheetWidth() : WIDTH), { rest: 0.2 });
  const [sc] = follow(() => under()?.s ?? 1, { rest: 0.001 });
  const [ink] = follow(() => under()?.ink ?? 1, { rest: 0.001 });
  // The market's lines and moves, and the build menu's
  // pictures, want more frosted glass under them.
  const [frost] = follow(() => (tab() === "select" ? 0 : FROSTED), { rest: 0.001 });
  createEffect(() => (eye.below = barBottom() + BAR + h()));

  const roll = (by: number) => setScroll(Math.max(0, Math.min(bodyH() - room(), scroll() + by)));
  /** A finger on the sheet: up draws it up, down sinks it; let go, it
   *  settles whichever way it is nearer. The wheel opens and sinks it. */
  const drag = (by: number, held?: boolean) => {
    if (held === undefined) return setOpen(by > 0);
    const p = pull();
    if (held) return setPull(Math.max(headH() * 0.6, Math.min(openH() + 24, (p ?? h()) + by)));
    if (p !== null) setOpen(p > (headH() + openH()) / 2), setPull(null);
  };
  /** The body scrolls, but a finger dragging it down from its top drags the sheet. */
  const scrolled = (by: number, held?: boolean) => (held !== undefined && (pull() !== null || (by < 0 && scroll() <= 0)) ? drag(by, held) : roll(by));

  return (
    <>
      <box at={{ left: 0, right: 0, bottom: barBottom() }} align="center">
        <box w={w()} h={h() + BAR} scale={sc()} origin={[0.5, 1]}>
          {/* One glass: the shown tab's sheet, grown up out of the bar. */}
          <glass layer="dock" at={{ left: 0, top: 0 }} w={w()} h={h() + BAR} round={30} frost={frost()} clip>
            <Show when={shown()}>
              <box at={{ left: w() / 2 - 18, top: 6 }} w={36} h={5} round={2.5} fill="ink/0.18" opacity={ink()} />
              <box w={sheetWidth()} x={(w() - sheetWidth()) / 2} opacity={ink()} onSize={(_, y) => setHeadH(y)} onTap={() => setOpen(!open())} onScroll={drag}>
                <Show when={tab()} keyed>{(t) => <Fade>{SHEETS[t].head()}</Fade>}</Show>
              </box>
              <box w={sheetWidth()} x={(w() - sheetWidth()) / 2} h={Math.max(0, h() - headH())} opacity={ink()} clip onScroll={scrolled}>
                <box y={-scroll()} onSize={(_, y) => (setBodyH(y), y <= room() && setScroll(0))}>
                  <Show when={tab()} keyed>{(t) => <Fade>{SHEETS[t].body()}</Fade>}</Show>
                </box>
              </box>
              <box at={{ left: 16, right: 16, bottom: BAR }} h={1} fill="ink/0.08" opacity={Math.min(1, h() / 24) * ink()} />
            </Show>
          </glass>
          {/* The tabs, fixed along its foot. */}
          <box at={{ left: (w() - WIDTH) / 2, bottom: 0 }} w={WIDTH} h={BAR} opacity={ink()}>
            <Show when={bead()}>
              {(dye) => <glass layer="beads" dye={dye()} at={{ left: beadX() - beadW() / 2, bottom: 30 - beadH() / 2 }} w={beadW()} h={beadH()} round={beadH() / 2} />}
            </Show>
            <For each={[...TABS]}>
              {(t, j) => {
                const on = () => tab() === t;
                return (
                  <Press at={{ left: cx(j()) - 22, bottom: 8 }} w={44} h={44} round={22} align="center" justify="center" onTap={() => press(t)}>
                    <icon d={glyph(t)} size={21} ink={on() && bead() ? "white" : on() ? "ink" : "ink/0.6"} />
                  </Press>
                );
              }}
            </For>
          </box>
        </box>
      </box>
      <Pages bottom={barBottom()} width={sheetWidth()} room={wide() ? Math.min(640, view().h - 200) : view().h * 0.72} />
    </>
  );
}
