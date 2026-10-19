/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, indexArray, on, onCleanup, Show } from "solid-js";
import { follow, LOOSE } from "../../engine/spring";
import { useEngine } from "../../engine/Canvas";
import { held, hold, priority, setPriority, setTool, tool } from "../buildMode";
import { BLUEPRINTS, GOODS } from "../../blueprints";
import { useGame } from "../../state/gameObjects";
import { picking, setPicking } from "../../state/deals";
import BuildMenu, { menuOpen, setMenuOpen } from "./BuildMenu";
import { FERRY, Line, Press, wide } from "./kit";

/** What the road shelf holds. */
const ROAD_KINDS = [
  { id: "Street", label: "Street", color: "#8FA39A", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z" },
  { id: "OneWay", label: "One-way", color: "#7A8F86", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM12 3l5.5 6.5h-4V21h-3V9.5h-4z" },
  { id: "Road", label: "Road", color: "#E0B443", glyph: "M2 2h2v20H2zM20 2h2v20h-2zM7.5 2h2.2v4.5H7.5zM7.5 9.75h2.2v4.5H7.5zM7.5 17.5h2.2V22H7.5zM14.3 2h2.2v4.5h-2.2zM14.3 9.75h2.2v4.5h-2.2zM14.3 17.5h2.2V22h-2.2z" },
] as const;
const SELECT = "M4 2.5l16 8-7 2-2.6 7.5z";
const BUILD = "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z";
const DEMOLISH = "M3.5 16.5h11a2.25 2.25 0 0 1 0 4.5h-11a2.25 2.25 0 0 1 0-4.5zM5 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM9 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM13 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM4 12h11v3.5H4zM5.5 6.5h5l1.2 4.5H5.5zM6.7 7.7h3l.6 2.3H6.7zM15.5 13h2.5v1.5h-2.5zM18.5 10l3-1v12.5h-3z";
const UNDO = "M9.5 4 3 10l6.5 6v-4h5a4.5 4.5 0 0 1 0 9H11v3h3.5a7.5 7.5 0 0 0 0-15h-5z";
const UP = "M6 15l6-6 6 6";
const DOWN = "M6 9l6 6 6-6";
const DEMOLISH_COLOR = "#D9483B";

/** The dock's measure: a slot every 52px, the bar 60 tall; the road
 *  shelf's rows rise every 56px above it. */
const SLOT = 52;
const BAR = 60;
const ROW = 56;
const FIRST_ROW = 86;
const cx = (j: number) => 30 + SLOT * j;
/** The slots: the bare hand, the roads, the build menu, the demolisher,
 *  a new deal on the ferry, undo. */
const SLOTS = ["select", "roads", "build", "demolish", "trade", "undo"] as const;
const at = (s: (typeof SLOTS)[number]) => SLOTS.indexOf(s);
const WIDTH = SLOT * SLOTS.length + 8;

/** The roads on the shelf: a road is a street with priority. */
type Kind = (typeof ROAD_KINDS)[number]["id"];
const kind = (): Kind | null => {
  const t = tool();
  return t === "Street" && priority() ? "Road" : t === "Street" || t === "OneWay" ? t : null;
};
const take = (k: Kind) => (setPriority(k === "Road"), setTool(k === "Road" ? "Street" : k));
const road = (k: Kind) => ROAD_KINDS.find((r) => r.id === k)!;
/** What a road takes, said under its "i". */
const ROAD_ABOUT = "Laid at once, on a stone a tile from the nearest depot; with none in stock, the world sends it express, at twice the ferry's price.";
const ABOUT_H = 56 + Math.ceil(ROAD_ABOUT.length / 38) * 20;

/**
 * The tools, as a drawing program groups them: the bare hand, the roads
 * (the last one taken shows, its key again takes the next, the bump over
 * it opens them all), the build menu, the demolisher, a new deal, and undo.
 *
 * Drawn as glass that runs together like the hand's dots: the bar, its
 * bump and the road shelf's rows in one layer; what is in hand, in its
 * colour, as dyed glass of its own over it.
 */
export default function Dock() {
  const { send } = useGame();
  const { canvas } = useEngine();
  const [lastRoad, setLastRoad] = createSignal<Kind>("Street");
  createEffect(() => {
    const k = kind();
    if (k) setLastRoad(k);
  });
  const roadInHand = () => tool() !== null && tool() !== "Demolish";

  // The road shelf, open or not, and the road whose card is.
  const [shelf, setShelf] = createSignal(false);
  const [about, setAbout] = createSignal<Kind | null>(null);
  const open = (o: boolean) => (setAbout(null), setShelf(o));
  // Whatever takes up another tool puts the shelf and the menu away, and
  // a press on the town.
  createEffect(on(tool, (t) => (open(false), t !== null && setMenuOpen(false)), { defer: true }));
  const away = () => (open(false), setMenuOpen(false));
  canvas.addEventListener("pointerdown", away);
  onCleanup(() => canvas.removeEventListener("pointerdown", away));

  const undo = () => send({ type: "Undo" });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") return e.preventDefault(), undo();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toUpperCase();
    if (e.key === "Escape") return away(), setTool(null);
    if (key === "V") return setTool(null);
    if (key === "X") return setTool("Demolish");
    if (key === "B") return hold(null), setMenuOpen(!menuOpen());
    if (key === "T") return setPicking(picking() === null ? false : null);
    if (key !== "R") return;
    if (!roadInHand()) return take(lastRoad());
    // Again: the next road.
    const i = ROAD_KINDS.findIndex((r) => r.id === kind());
    take(ROAD_KINDS[(i + 1) % ROAD_KINDS.length].id);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const active = () => (held() || menuOpen() ? at("build") : tool() === null ? at("select") : tool() === "Demolish" ? at("demolish") : at("roads"));
  const lit = () => held() !== null || tool() !== null;
  const bead = () => {
    const h = held(),
      t = tool();
    return h ? BLUEPRINTS[h.kind].color : t === null ? undefined : t === "Demolish" ? DEMOLISH_COLOR : road(kind() ?? "Street").color;
  };
  // The bead slides on a spring, and is drawn out by its own speed: long
  // and thin as it goes, round again as it lands.
  const [beadX, beadV] = follow(() => cx(active()));
  const [beadSize] = follow(() => (lit() ? 1 : 0.2), { rest: 0.002 });
  const stretch = () => Math.min(0.45, Math.abs(beadV()) / 1400);
  const beadW = () => 40 * beadSize() * (1 + stretch());
  const beadH = () => 40 * beadSize() * (1 - stretch() / 2);

  /** Every road on the shelf, placed: risen above it when open, sunk into it when not. */
  const rows = () => {
    const i = ROAD_KINDS.findIndex((r) => r.id === about());
    return ROAD_KINDS.map((r, k) => ({
      t: r.id as Kind,
      open: shelf(),
      info: shelf() && k === i,
      w: shelf() && k === i ? 300 : 240,
      h: shelf() && k === i ? ABOUT_H : 44,
      bottom: shelf() ? FIRST_ROW + k * ROW + (i >= 0 && i < k ? ABOUT_H - 44 : 0) : 10,
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
  const left = cx(at("roads"));

  return (
    <>
      <BuildMenu />
      <box at={{ left: 0, right: 0, bottom: wide() ? 28 : 76 }} align="center">
        <box w={WIDTH} h={BAR}>
          {/* The glass: bar, bump, rows, run together. */}
          <glass layer="dock" at={{ left: 0, bottom: 0 }} w={WIDTH} h={BAR} round={30} />
          <glass layer="dock" at={{ left: left - 11, bottom: bump() }} w={22} h={18} round={9} />
          <For each={sprung()}>
            {(m) => <glass layer="dock" at={{ left: left - 22, bottom: m.bottom() }} w={Math.max(0, m.w() * m.shown())} h={m.h()} round={22} opacity={m.fade()} />}
          </For>

          {/* What is in hand, in its colour, as dyed glass of its own on the
              bar and the rows: the bead, and the open shelf's drops. */}
          <Show when={bead()}>
            {(dye) => <glass layer="beads" dye={dye()} at={{ left: beadX() - beadW() / 2, bottom: 30 - beadH() / 2 }} w={beadW()} h={beadH()} round={beadH() / 2} />}
          </Show>
          <For each={sprung()}>
            {(m) => (
              <glass
                layer="beads"
                dye={road(m.r().t).color}
                at={{ left: left - 18, bottom: m.bottom() + m.h() - 40 }}
                w={36}
                h={36}
                round={18}
                opacity={m.fade()}
                scale={0.3 + 0.7 * Math.max(0, m.shown())}
              />
            )}
          </For>

          {/* What is read and pressed. */}
          <For each={sprung()}>
            {(m) => (
              <box at={{ left: left - 22, bottom: m.bottom() }} w={m.w()} h={m.h()} round={22} clip opacity={m.fade()}>
                <box at={{ left: 0, top: 0, right: 44 }} h={44} dir="row" align="center" gap={10} onTap={m.r().open ? () => (take(m.r().t), open(false)) : undefined}>
                  <box w={44} h={44} align="center" justify="center">
                    <icon d={road(m.r().t).glyph} size={17} ink="white" />
                  </box>
                  <text size={15} weight={600}>{road(m.r().t).label}</text>
                  <box dir="row" align="center" gap={2}>
                    <icon d={GOODS.Stone.glyph} size={13} ink="ink/0.6" />
                    <text serif size={15} soft>1</text>
                  </box>
                </box>
                <Press
                  at={{ right: 8, top: 8 }}
                  w={28}
                  h={28}
                  round={14}
                  align="center"
                  justify="center"
                  stroke={[1.5, `ink/${m.r().info ? 0.6 : 0.15}`]}
                  onTap={() => m.r().open && setAbout((a) => (a === m.r().t ? null : m.r().t))}
                >
                  <text serif size={14} soft>i</text>
                </Press>
                <Show when={m.r().info}>
                  <text at={{ left: 18, right: 16, top: 46 }} serif size={13.5} soft lead={1.45}>{ROAD_ABOUT}</text>
                </Show>
              </box>
            )}
          </For>

          <box at={{ left: left - 11, bottom: bump() }} w={22} h={18} align="center" justify="center" onTap={() => open(!shelf())}>
            <Line d={shelf() ? DOWN : UP} size={11} width={2.5} ink="ink/0.6" />
          </box>
          <For each={[...SLOTS]}>
            {(s, j) => {
              const on = () => (s === "trade" ? picking() !== null : j() === active() && s !== "undo");
              const d = () => (s === "select" ? SELECT : s === "roads" ? road(lastRoad()).glyph : s === "build" ? (held() ? BLUEPRINTS[held()!.kind].glyph : BUILD) : s === "demolish" ? DEMOLISH : s === "trade" ? FERRY : UNDO);
              const act = () =>
                s === "select" ? setTool(null)
                : s === "roads" ? take(lastRoad())
                : s === "build" ? (hold(null), setTool(null), setMenuOpen(!menuOpen()))
                : s === "demolish" ? setTool("Demolish")
                : s === "trade" ? setPicking(picking() === null ? false : null)
                : undo();
              return (
                <Press at={{ left: cx(j()) - 22, bottom: 8 }} w={44} h={44} round={22} align="center" justify="center" onTap={act}>
                  <icon d={d()} size={21} ink={on() && lit() ? "white" : on() ? "ink" : "ink/0.6"} />
                </Press>
              );
            }}
          </For>
        </box>
      </box>
    </>
  );
}
