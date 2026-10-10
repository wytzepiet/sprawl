import { createEffect, createSignal, For, indexArray, on, Show } from "solid-js";
import { follow, LOOSE } from "../engine/spring";
import { held, hold, setTool, tool } from "./buildMode";
import { BLUEPRINTS, GoodIcon } from "../blueprints";
import { useGame } from "../state/gameObjects";
import type { Tool } from "../generated";
import { BuildMenu, menuOpen, setMenuOpen } from "./BuildMenu";

/** What the road shelf holds. */
const ROAD_KINDS = [
  { id: "Street", label: "Street", color: "#8FA39A", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z" },
  { id: "OneWay", label: "One-way", color: "#7A8F86", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM12 3l5.5 6.5h-4V21h-3V9.5h-4z" },
  { id: "Road", label: "Road", color: "#E0B443", glyph: "M2 2h2v20H2zM20 2h2v20h-2zM7.5 2h2.2v4.5H7.5zM7.5 9.75h2.2v4.5H7.5zM7.5 17.5h2.2V22H7.5zM14.3 2h2.2v4.5h-2.2zM14.3 9.75h2.2v4.5h-2.2zM14.3 17.5h2.2V22h-2.2z" },
] as const;
const SELECT = "M4 2.5l16 8-7 2-2.6 7.5z";
const BUILD = "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z";
const DEMOLISH = "M9 2h6l1 2h4v2.5H4V4h4zM5.5 8h13l-1.2 14H6.7zM9 11v8h2v-8zm4 0v8h2v-8z";
const UNDO = "M9.5 4 3 10l6.5 6v-4h5a4.5 4.5 0 0 1 0 9H11v3h3.5a7.5 7.5 0 0 0 0-15h-5z";
const DEMOLISH_COLOR = "#D9483B";

/** The dock's measure: a slot every 52px, the bar 60 tall; the road
 *  shelf's rows rise every 56px above it. */
const SLOT = 52;
const BAR = 60;
const ROW = 56;
const FIRST_ROW = 86;
const cx = (j: number) => 30 + SLOT * j;
/** The slots: the bare hand, the roads, the build menu, the demolisher,
 *  undo. */
const SLOTS = ["select", "roads", "build", "demolish", "undo"] as const;
const at = (s: (typeof SLOTS)[number]) => SLOTS.indexOf(s);

const road = (t: Tool) => ROAD_KINDS.find((r) => r.id === t)!;
/** What a road takes, said under its "i". */
const ROAD_ABOUT = "Laid at once, on a stone a tile from the nearest depot; with none in stock, the world sends it express, at twice the ferry's price.";

function Glyph(props: { d: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor" fill-rule="evenodd" aria-hidden="true">
      <path d={props.d} />
    </svg>
  );
}

/**
 * The tools, as a drawing program groups them: the bare hand, the roads
 * (the last one taken shows, its key again takes the next, the bump over
 * it opens them all), the build menu, the demolisher, and undo.
 *
 * Drawn as glass that runs together like the hand's dots: the bar, its
 * bump and the road shelf's rows in one goo, under one opacity so it
 * stays glassy; what is built, in its colour, in another at full strength.
 */
export default function BuildModeToolbar() {
  const { send } = useGame();
  const [lastRoad, setLastRoad] = createSignal<Tool>("Street");
  createEffect(() => { const t = tool(); if (t !== null && t !== "Demolish") setLastRoad(t); });
  const roadInHand = () => tool() !== null && tool() !== "Demolish";

  // The road shelf, open or not, and the road whose card is.
  const [shelf, setShelf] = createSignal(false);
  const [about, setAbout] = createSignal<Tool | null>(null);
  const open = (o: boolean) => { setAbout(null); setShelf(o); };
  // Whatever takes up another tool puts the shelf and the menu away, and
  // a press anywhere else.
  createEffect(on(tool, (t) => (open(false), t !== null && setMenuOpen(false)), { defer: true }));
  createEffect(on(held, (h) => h && setMenuOpen(false), { defer: true }));
  let dock!: HTMLDivElement;
  window.addEventListener("pointerdown", (e) => {
    if (dock.contains(e.target as Node)) return;
    open(false);
    if (!(e.target as HTMLElement).closest?.("[data-menu]")) setMenuOpen(false);
  }, { capture: true });

  const undo = () => send({ type: "Undo" });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") return e.preventDefault(), undo();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toUpperCase();
    if (e.key === "Escape") return open(false), setMenuOpen(false), setTool(null);
    if (key === "V") return setTool(null);
    if (key === "X") return setTool("Demolish");
    if (key === "B") return hold(null), setMenuOpen(!menuOpen());
    if (key !== "R") return;
    if (!roadInHand()) return setTool(lastRoad());
    // Again: the next road.
    const i = ROAD_KINDS.findIndex((r) => r.id === tool());
    setTool(ROAD_KINDS[(i + 1) % ROAD_KINDS.length].id);
  };
  window.addEventListener("keydown", onKey);

  const width = SLOT * SLOTS.length + 8;
  const active = () => (held() || menuOpen() ? at("build") : tool() === null ? at("select") : tool() === "Demolish" ? at("demolish") : at("roads"));
  const lit = () => held() !== null || tool() !== null;
  const bead = () => {
    const h = held(), t = tool();
    return h ? BLUEPRINTS[h.kind].color : t === null ? undefined : t === "Demolish" ? DEMOLISH_COLOR : road(t).color;
  };
  // The bead slides on a spring, and is drawn out by its own speed: long
  // and thin as it goes, round again as it lands.
  const [beadX, beadV] = follow(() => cx(active()) - 20);
  const [beadSize] = follow(() => (lit() ? 1 : 0.2), { rest: 0.002 });
  const stretch = () => Math.min(0.45, Math.abs(beadV()) / 1400);

  const cardHeight = 56 + Math.ceil(ROAD_ABOUT.length / 38) * 20;
  /** Every road on the shelf, placed: risen above it when open, sunk into it when not. */
  const rows = () => {
    const i = ROAD_KINDS.findIndex((r) => r.id === about());
    return ROAD_KINDS.map((r, k) => ({
      t: r.id as Tool, open: shelf(), info: shelf() && k === i,
      w: shelf() && k === i ? 300 : 240,
      h: shelf() && k === i ? cardHeight : 44,
      x: cx(at("roads")),
      bottom: shelf() ? FIRST_ROW + k * ROW + (i >= 0 && i < k ? cardHeight - 44 : 0) : 10,
      delay: shelf() ? k * 52 : (ROAD_KINDS.length - 1 - k) * 28,
    }));
  };
  /** Each row on its springs, kept by place so a row moves rather than being made again. */
  const sprung = indexArray(rows, (r) => {
    const delay = () => r().delay;
    const [bottom] = follow(() => r().bottom, { delay, feel: LOOSE });
    const [h] = follow(() => r().h, { feel: LOOSE });
    const [w] = follow(() => r().w, { feel: LOOSE });
    const [shown] = follow(() => (r().open ? 1 : 0), { delay, rest: 0.002, feel: LOOSE });
    return { r, bottom, h, w, shown, fade: () => Math.max(0, Math.min(1, shown())) };
  });
  /** The road shelf's bump, risen while it is open. */
  const [bump] = follow(() => (shelf() ? 60 : 50));

  return (
    <>
      <BuildMenu />
      <div ref={dock} class="fixed bottom-7 left-1/2 -translate-x-1/2 select-none" style={{ width: `${width}px`, height: `${BAR}px` }}>
        {/* The glass: bar, bump, rows, run together (`engine/glass.ts`). */}
        <div data-glass="dock" class="absolute bottom-0 left-0 rounded-[30px] pointer-events-none" style={{ width: `${width}px`, height: `${BAR}px` }} />
        <div data-glass="dock" class="absolute rounded-[9px] pointer-events-none" style={{ left: `${cx(at("roads")) - 11}px`, bottom: `${bump()}px`, width: "22px", height: "18px" }} />
        <For each={sprung()}>
          {(m) => (
            <div
              data-glass="dock"
              class="absolute rounded-[22px] pointer-events-none"
              style={{ left: `${m.r().x - 22}px`, bottom: `${m.bottom()}px`, width: `${Math.max(0, m.w() * m.shown())}px`, height: `${m.h()}px`, opacity: m.fade() }}
            />
          )}
        </For>

        {/* What is in hand, in its colour, as tinted glass of its own on the
            bar and the rows: the bead, and the open shelf's drops. */}
        <div
          data-glass={bead() ? "beads" : undefined}
          data-dye={bead()}
          class="absolute rounded-full pointer-events-none"
          style={{ left: `${beadX()}px`, bottom: "10px", width: "40px", height: "40px", transform: `scale(${beadSize() * (1 + stretch())}, ${beadSize() * (1 - stretch() / 2)})` }}
        />
        <For each={sprung()}>
          {(m) => (
            <div
              data-glass="beads"
              data-dye={road(m.r().t).color}
              class="absolute rounded-full pointer-events-none"
              style={{ left: `${m.r().x - 18}px`, bottom: `${m.bottom() + m.h() - 40}px`, width: "36px", height: "36px", opacity: m.fade(), transform: `scale(${0.3 + 0.7 * Math.max(0, m.shown())})` }}
            />
          )}
        </For>

        {/* What is read and pressed. */}
        <For each={sprung()}>
          {(m) => (
            <div
              class="absolute overflow-hidden rounded-[22px]"
              style={{ left: `${m.r().x - 22}px`, bottom: `${m.bottom()}px`, width: `${m.w()}px`, height: `${m.h()}px`, opacity: m.fade(), "pointer-events": m.r().open ? "auto" : "none" }}
            >
              <button onClick={() => { setTool(m.r().t); open(false); }} class="absolute left-0 top-0 h-11 right-11 flex items-center gap-2.5 text-left cursor-pointer">
                <span class="grid w-11 h-11 shrink-0 place-items-center text-white"><Glyph d={road(m.r().t).glyph} size={17} /></span>
                <span class="ink text-[15px] font-semibold whitespace-nowrap">{road(m.r().t).label}</span>
                <span class="soft inline-flex items-center gap-0.5 serif italic font-light text-[15px] whitespace-nowrap" title="Built of a stone a tile">
                  <GoodIcon good="Stone" width="13" height="13" />1
                </span>
              </button>
              <button
                onClick={() => setAbout((a) => (a === m.r().t ? null : m.r().t))}
                class="press soft serif italic absolute right-2 top-2 w-7 h-7 rounded-full cursor-pointer text-sm"
                style={{ border: `1.5px solid rgb(var(--ink) / ${m.r().info ? 0.6 : 0.15})` }}
                aria-label="What is it?"
              >
                i
              </button>
              <Show when={m.r().info}>
                <p class="appear soft absolute left-[18px] right-4 top-[46px] m-0 text-[13.5px] leading-[1.45] font-medium">
                  <span class="serif italic">{ROAD_ABOUT}</span>
                </p>
              </Show>
            </div>
          )}
        </For>

        <button
          onClick={() => open(!shelf())}
          class="soft absolute grid place-items-center cursor-pointer"
          style={{ left: `${cx(at("roads")) - 11}px`, bottom: `${bump()}px`, width: "22px", height: "18px" }}
          aria-label="All roads"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ transform: `rotate(${(bump() - 50) * 18}deg)` }}>
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <For each={[...SLOTS]}>
          {(s, j) => {
            const on = () => j() === active() && s !== "undo";
            const d = () => (s === "select" ? SELECT : s === "roads" ? road(lastRoad()).glyph : s === "build" ? (held() ? BLUEPRINTS[held()!.kind].glyph : BUILD) : s === "demolish" ? DEMOLISH : UNDO);
            const act = () =>
              s === "select" ? setTool(null)
              : s === "roads" ? setTool(lastRoad())
              : s === "build" ? (hold(null), setTool(null), setMenuOpen(!menuOpen()))
              : s === "demolish" ? setTool("Demolish")
              : undo();
            const title = { select: "Select (V)", roads: "Roads (R)", build: "Build (B)", demolish: "Demolish (X)", undo: "Undo (Ctrl Z)" }[s];
            return (
              <button
                onClick={act}
                class="press absolute bottom-2 grid w-11 h-11 place-items-center rounded-full cursor-pointer"
                classList={{ "text-white": on() && lit(), ink: on() && !lit(), soft: !on() }}
                style={{ left: `${cx(j()) - 22}px` }}
                title={title}
              >
                <Glyph d={d()} size={21} />
              </button>
            );
          }}
        </For>
      </div>
    </>
  );
}
