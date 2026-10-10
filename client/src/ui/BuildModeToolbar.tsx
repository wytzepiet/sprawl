import { createEffect, createSignal, For, indexArray, on, Show } from "solid-js";
import { follow, LOOSE } from "../engine/spring";
import { setTool, tool } from "./buildMode";
import { BLUEPRINTS, GoodIcon, KINDS, plot, TABS } from "../blueprints";
import type { Tool } from "../generated";
import Bill from "./Bill";

/** What the road shelf holds. */
const ROAD_KINDS = [
  { id: "Street", label: "Street", color: "#8FA39A", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z" },
  { id: "OneWay", label: "One-way", color: "#7A8F86", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM12 3l5.5 6.5h-4V21h-3V9.5h-4z" },
  { id: "Road", label: "Road", color: "#E0B443", glyph: "M2 2h2v20H2zM20 2h2v20h-2zM7.5 2h2.2v4.5H7.5zM7.5 9.75h2.2v4.5H7.5zM7.5 17.5h2.2V22H7.5zM14.3 2h2.2v4.5h-2.2zM14.3 9.75h2.2v4.5h-2.2zM14.3 17.5h2.2V22h-2.2z" },
] as const;
const SELECT = "M4 2.5l16 8-7 2-2.6 7.5z";
const DEMOLISH = "M9 2h6l1 2h4v2.5H4V4h4zM5.5 8h13l-1.2 14H6.7zM9 11v8h2v-8zm4 0v8h2v-8z";
const DEMOLISH_COLOR = "#D9483B";

/** A shelf: the roads, or one tab of buildings. Each tool is a `Tool`. */
type Shelf = "road" | (typeof TABS)[number];
const SHELVES: { id: Shelf; key: string; label: string }[] = [
  { id: "road", key: "R", label: "Roads" },
  { id: "trade", key: "1", label: "Harbour and depot" },
  { id: "homes", key: "2", label: "Homes" },
  { id: "shops", key: "3", label: "Shops" },
  { id: "work", key: "4", label: "Work" },
  { id: "services", key: "5", label: "Services" },
];

/** The dock's measure: a slot every 52px, the bar 60 tall; a shelf's
 *  rows rise every 56px above it. */
const SLOT = 52;
const BAR = 60;
const ROW = 56;
const FIRST_ROW = 86;
const cx = (j: number) => 30 + SLOT * j;

const same = (a: Tool | null, b: Tool | null) => JSON.stringify(a) === JSON.stringify(b);
const shelfOf = (t: Tool | null): Shelf | null =>
  t === null || t === "Demolish" ? null : typeof t === "string" ? "road" : BLUEPRINTS[t.Building].tab;
const road = (t: Tool) => ROAD_KINDS.find((r) => r.id === t)!;
const label = (t: Tool) => (typeof t === "string" ? road(t).label : BLUEPRINTS[t.Building].label);
const color = (t: Tool) => (typeof t === "string" ? road(t).color : BLUEPRINTS[t.Building].color);
/** What a building is built of: its timber, which a depot's van brings. */
const timber = (t: Tool) => (typeof t === "string" ? null : BLUEPRINTS[t.Building].timber);
/** What the card under the "i" says of each kind beyond its size. */
const ABOUT: Partial<Record<string, string>> = {
  Harbour: "The door: the ferry berths at its back, so it stands on the coast with open sea straight out behind it. Stands at once.",
  Depot: "Keeps the town's goods. Its lorry fetches boxes from the harbour; its vans take timber to sites. The first stands at once.",
};
const glyph = (t: Tool) => (typeof t === "string" ? road(t).glyph : BLUEPRINTS[t.Building].glyph);

function Glyph(props: { d: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor" fill-rule="evenodd" aria-hidden="true">
      <path d={props.d} />
    </svg>
  );
}

/**
 * The tools, a shelf at a time, as a drawing program groups them: the bare
 * hand, the roads, four shelves of buildings, the demolisher. A shelf
 * shows the last thing taken from it, and picking it up takes that again;
 * its key pressed again takes the next. The bump over it opens the whole
 * shelf, and each thing on it says what it is.
 *
 * Drawn as glass that runs together like the hand's dots: the bar, its
 * bumps and a shelf's rows in one goo, under one opacity so it stays
 * glassy; what is built, in its colour, in another at full strength.
 */
export default function BuildModeToolbar() {
  /** What a shelf holds. */
  const tools = (s: Shelf): Tool[] =>
    s === "road" ? ROAD_KINDS.map((r) => r.id as Tool) : KINDS.filter((k) => BLUEPRINTS[k].tab === s).map((k) => ({ Building: k }));
  const shelves = () => SHELVES.filter((s) => tools(s.id).length > 0);

  // The last thing in hand from each shelf, however it got there, which its button shows.
  const [last, setLast] = createSignal<Partial<Record<Shelf, Tool>>>({});
  createEffect(() => { const t = tool(), s = shelfOf(t); if (s) setLast((l) => ({ ...l, [s]: t! })); });
  const face = (s: Shelf) => last()[s] ?? tools(s)[0];
  /** Picking up a shelf takes its face. */
  const pick = (s: Shelf) => setTool(face(s));

  // The shelf whose menu is open, and the thing on it whose card is.
  // A press outside the dock puts the menu away.
  const [menu, setMenu] = createSignal<Shelf | null>(null);
  const [about, setAbout] = createSignal<Tool | null>(null);
  const open = (s: Shelf | null) => { setAbout(null); setMenu(s); };
  // Whatever picks up another tool — a slot, a key, the eyedropper — puts the menu away.
  createEffect(on(tool, () => open(null), { defer: true }));
  let dock!: HTMLDivElement;
  window.addEventListener("pointerdown", (e) => { if (!dock.contains(e.target as Node)) open(null); }, { capture: true });

  const onKey = (e: KeyboardEvent) => {
    const key = e.key.toUpperCase();
    if (e.key === "Escape") open(null);
    if (e.key === "Escape" || key === "V") return setTool(null);
    if (key === "X") return setTool("Demolish");
    const s = shelves().find((s) => s.key === key);
    if (!s) return;
    const all = tools(s.id);
    if (shelfOf(tool()) !== s.id) return pick(s.id);
    // Again: the next on the shelf.
    const i = all.findIndex((t) => same(t, tool()));
    setTool(all[(i + 1) % all.length]);
  };
  window.addEventListener("keydown", onKey);

  /** The slots: the hand, each shelf, the demolisher. */
  const slots = () => [null, ...shelves().map((s) => s.id), "Demolish" as const];
  const width = () => SLOT * slots().length + 8;
  const active = () => {
    const t = tool();
    return t === null ? 0 : t === "Demolish" ? slots().length - 1 : 1 + shelves().findIndex((s) => s.id === shelfOf(t));
  };
  const held = () => tool() !== null;
  const bead = () => { const t = tool(); return t === null ? undefined : t === "Demolish" ? DEMOLISH_COLOR : color(t); };
  // The bead slides on a spring, and is drawn out by its own speed: long
  // and thin as it goes, round again as it lands.
  const [beadX, beadV] = follow(() => cx(active()) - 20);
  const [beadSize] = follow(() => (held() ? 1 : 0.2), { rest: 0.002 });
  const stretch = () => Math.min(0.45, Math.abs(beadV()) / 1400);

  /** A thing's size, and the card's height to show it. */
  const size = (t: Tool) => (typeof t === "string" ? "" : `${plot(t.Building, 0).size.join("×")} tiles. ${ABOUT[t.Building] ?? (timber(t) ? `A site until a depot's van brings its ${timber(t)} timber.` : "")}`);
  const cardHeight = (t: Tool) => 56 + Math.ceil(size(t).length / 38) * 20;

  /** Every row of every shelf, placed: risen above its shelf when open, sunk into it when not. */
  const rows = () =>
    shelves().flatMap((s, si) => {
      const all = tools(s.id);
      const isOpen = menu() === s.id;
      const at = all.findIndex((t) => same(t, about()));
      return all.map((t, i) => {
        const info = isOpen && i === at;
        return {
          t, open: isOpen, info,
          w: info ? 300 : 240,
          h: info ? cardHeight(t) : 44,
          x: cx(si + 1),
          bottom: isOpen ? FIRST_ROW + i * ROW + (at >= 0 && at < i ? cardHeight(all[at]) - 44 : 0) : 10,
          delay: isOpen ? i * 52 : (all.length - 1 - i) * 28,
        };
      });
    });
  /** Each row on its springs, kept by place so a row moves rather than being made again. */
  const sprung = indexArray(rows, (r) => {
    const delay = () => r().delay;
    const [bottom] = follow(() => r().bottom, { delay, feel: LOOSE });
    const [h] = follow(() => r().h, { feel: LOOSE });
    const [w] = follow(() => r().w, { feel: LOOSE });
    const [shown] = follow(() => (r().open ? 1 : 0), { delay, rest: 0.002, feel: LOOSE });
    return { r, bottom, h, w, shown, fade: () => Math.max(0, Math.min(1, shown())) };
  });
  /** A shelf's bump, risen while its menu is open. */
  const bumps = indexArray(shelves, (s) => follow(() => (menu() === s().id ? 60 : 50))[0]);

  return (
    <div ref={dock} class="fixed bottom-7 left-1/2 -translate-x-1/2 select-none" style={{ width: `${width()}px`, height: `${BAR}px` }}>
      {/* The glass: bar, bumps, rows, run together (`engine/glass.ts`). */}
      <div data-glass="dock" class="absolute bottom-0 left-0 rounded-[30px] pointer-events-none" style={{ width: `${width()}px`, height: `${BAR}px` }} />
      <For each={bumps()}>
        {(bump, si) => <div data-glass="dock" class="absolute rounded-[9px] pointer-events-none" style={{ left: `${cx(si() + 1) - 11}px`, bottom: `${bump()}px`, width: "22px", height: "18px" }} />}
      </For>
      <For each={sprung()}>
        {(m) => (
          <div
            data-glass="dock"
            class="absolute rounded-[22px] pointer-events-none"
            style={{ left: `${m.r().x - 22}px`, bottom: `${m.bottom()}px`, width: `${Math.max(0, m.w() * m.shown())}px`, height: `${m.h()}px`, opacity: m.fade() }}
          />
        )}
      </For>

      {/* What is built, in its colour, as tinted glass of its own on the
          bar and the rows: the bead in hand, and the open shelf's drops. */}
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
            data-dye={color(m.r().t)}
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
            <button
              onClick={() => { setTool(m.r().t); open(null); }}
              class="absolute left-0 top-0 h-11 right-11 flex items-center gap-2.5 text-left cursor-pointer"
            >
              <span class="grid w-11 h-11 shrink-0 place-items-center text-white"><Glyph d={glyph(m.r().t)} size={17} /></span>
              <span class="ink text-[15px] font-semibold whitespace-nowrap">{label(m.r().t)}</span>
              <Show when={timber(m.r().t) !== null}>
                <span class="soft inline-flex items-center gap-1 serif italic font-light text-[15px] whitespace-nowrap" title="Timber it is built of">
                  {timber(m.r().t) ? <><GoodIcon good="Timber" width="13" height="13" />{timber(m.r().t)}</> : "at once"}
                </span>
              </Show>
            </button>
            <button
              onClick={() => setAbout((a) => (same(a, m.r().t) ? null : m.r().t))}
              class="press soft serif italic absolute right-2 top-2 w-7 h-7 rounded-full cursor-pointer text-sm"
              style={{ border: `1.5px solid rgb(var(--ink) / ${m.r().info ? 0.6 : 0.15})` }}
              aria-label="What is it?"
            >
              i
            </button>
            <Show when={m.r().info}>
              <p class="appear soft absolute left-[18px] right-4 top-[46px] m-0 text-[13.5px] leading-[1.45] font-medium">
                <span class="serif italic">{size(m.r().t)}</span>
              </p>
            </Show>
          </div>
        )}
      </For>

      <For each={shelves()}>
        {(s, si) => (
          <button
            onClick={() => open(menu() === s.id ? null : s.id)}
            class="soft absolute grid place-items-center cursor-pointer"
            style={{ left: `${cx(si() + 1) - 11}px`, bottom: `${bumps()[si()]?.() ?? 50}px`, width: "22px", height: "18px" }}
            aria-label={`All ${s.label.toLowerCase()}`}
          >
            <svg
              viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
              style={{ transform: `rotate(${((bumps()[si()]?.() ?? 50) - 50) * 18}deg)` }}
            >
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        )}
      </For>
      <For each={slots()}>
        {(s, j) => {
          const on = () => j() === active();
          const shelf = s === null || s === "Demolish" ? null : SHELVES.find((x) => x.id === s)!;
          const d = () => (s === null ? SELECT : s === "Demolish" ? DEMOLISH : glyph(face(s)));
          const act = () => (s === null ? setTool(null) : s === "Demolish" ? setTool("Demolish") : pick(s));
          return (
            <button
              onClick={act}
              class="press absolute bottom-2 grid w-11 h-11 place-items-center rounded-full cursor-pointer"
              classList={{ "text-white": on() && held(), ink: on() && !held(), soft: !on() }}
              style={{ left: `${cx(j()) - 22}px` }}
              title={s === null ? "Select (V)" : s === "Demolish" ? "Demolish (X)" : `${shelf!.label} (${shelf!.key})`}
            >
              <Glyph d={d()} size={21} />
            </button>
          );
        }}
      </For>
      <Bill hidden={menu() !== null} />
    </div>
  );
}
