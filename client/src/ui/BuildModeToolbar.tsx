import { createSignal, For, Show } from "solid-js";
import { MousePointer2, Route, Trash2, CarOff, RotateCcw } from "./icons";
import { isRoad, ROADS, setTool, tool } from "./buildMode";
import { useGame } from "../state/gameObjects";
import { tree, unlocked } from "../state/tree";
import { BLUEPRINTS, BuildingIcon, KINDS } from "../blueprints";
import type { BuildingKind, Tool } from "../generated";
import { Dynamic } from "solid-js/web";

type Road = (typeof ROADS)[number];

/** What the road tool can draw, in the order the T key cycles them. */
const ROAD_KINDS: { id: Road; label: string; needs?: string }[] = [
  { id: "Street", label: "Street" },
  { id: "OneWay", label: "1-way", needs: "OneWay" },
  { id: "Road", label: "Road", needs: "Road" },
];

const same = (a: Tool | null, b: Tool | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One bar of tools: the bare hand, a road, every kind of building, and the
 * demolisher. Pick one and drag on the map; it is laid as the drag goes.
 */
export default function BuildModeToolbar() {
  const { send, growth } = useGame();
  // The build says which kinds may be drawn or painted; a locked kind
  // cannot be chosen. A building the mayor cannot yet afford is shown
  // greyed: the thing you are saving for is the one you keep looking at.
  const mayDraw = (kind: Road) => {
    const needs = ROAD_KINDS.find((r) => r.id === kind)?.needs;
    return !needs || unlocked(tree(), growth().taken, (e) => e.kind === needs);
  };
  const may = (kind: BuildingKind) => unlocked(tree(), growth().taken, (e) => e.kind === "Building" && e.building === kind);
  const afford = (kind: BuildingKind) => growth().treasury >= BLUEPRINTS[kind].price;
  // The road the Road button picks up again: the last one drawn.
  const [road, setRoad] = createSignal<Road>("Street");
  const takeRoad = (kind: Road) => {
    if (!mayDraw(kind)) return;
    setRoad(kind);
    setTool(kind);
  };
  const kinds = () => KINDS.filter(may);

  const tools: { id: "hand" | "road" | "demolish"; label: string; icon: typeof Route; key: string }[] = [
    { id: "hand", label: "Select", icon: MousePointer2, key: "V" },
    { id: "road", label: "Road", icon: Route, key: "R" },
    { id: "demolish", label: "Demolish", icon: Trash2, key: "X" },
  ];
  const take = (id: "hand" | "road" | "demolish") => (id === "hand" ? setTool(null) : id === "road" ? setTool(road()) : setTool("Demolish"));
  const holding = (id: "hand" | "road" | "demolish") => (id === "hand" ? tool() === null : id === "road" ? isRoad(tool()) : tool() === "Demolish");

  const handleKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (isRoad(tool()) && key === "t") {
      const i = ROAD_KINDS.findIndex((r) => r.id === tool());
      for (let j = 1; j <= ROAD_KINDS.length; j++) {
        const next = ROAD_KINDS[(i + j) % ROAD_KINDS.length].id;
        if (mayDraw(next)) { takeRoad(next); break; }
      }
      return;
    }
    if (e.key === "Escape") return setTool(null);
    // A digit picks up the building at that place on the bar.
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= kinds().length) {
      const kind = kinds()[n - 1];
      if (afford(kind)) setTool({ Building: kind });
      return;
    }
    const t = tools.find((m) => m.key.toLowerCase() === key);
    if (t) take(t.id);
  };

  window.addEventListener("keydown", handleKeyDown);

  const chip = (on: boolean) =>
    `group relative flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all duration-300 cursor-pointer ${
      on ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.04)]" : "text-stone-400 hover:text-stone-600 hover:bg-white/50"
    }`;

  return (
    <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
      <Show when={isRoad(tool())}>
        <div class="flex items-center p-1 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
          <For each={ROAD_KINDS}>
            {(r) => (
              <button
                onClick={() => takeRoad(r.id)}
                disabled={!mayDraw(r.id)}
                title={mayDraw(r.id) ? r.label : `${r.label}: take it on the tree (L)`}
                class={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200
                ${
                  tool() === r.id
                    ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)] cursor-pointer"
                    : mayDraw(r.id)
                      ? "text-stone-400 hover:text-stone-600 cursor-pointer"
                      : "text-stone-300 line-through cursor-not-allowed"
                }`}
              >
                {r.label}
              </button>
            )}
          </For>
          <kbd class="self-center ml-1 mr-1 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm">
            T
          </kbd>
          {/* What the build still allows to be laid. */}
          <span class={`ml-2 mr-2 text-xs tabular-nums ${growth().road_tiles_left === 0 ? "text-red-500 font-semibold" : "text-stone-500"}`}>
            {growth().road_tiles_left} tiles
          </span>
        </div>
      </Show>
      <div class="flex items-center gap-1 p-2 rounded-2xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]">
        <For each={tools.slice(0, 2)}>
          {(t) => (
            <button onClick={() => take(t.id)} class={chip(holding(t.id))} title={`${t.label} (${t.key})`}>
              <Dynamic component={t.icon} size={18} stroke-width={holding(t.id) ? 2.25 : 1.5} />
            </button>
          )}
        </For>
        <div class="w-px h-6 bg-black/10 mx-1" />
        <For each={kinds()}>
          {(kind, i) => (
            <button
              onClick={() => afford(kind) && setTool({ Building: kind })}
              class={`${chip(same(tool(), { Building: kind }))} ${afford(kind) ? "" : "opacity-40 cursor-not-allowed"}`}
              style={{ color: same(tool(), { Building: kind }) ? BLUEPRINTS[kind].color : undefined }}
              title={`${BLUEPRINTS[kind].label}: ${BLUEPRINTS[kind].price} h${i() < 9 ? ` (${i() + 1})` : ""}${afford(kind) ? "" : ", save up"}`}
            >
              <BuildingIcon kind={kind} width={18} height={18} />
            </button>
          )}
        </For>
        <div class="w-px h-6 bg-black/10 mx-1" />
        <button onClick={() => take("demolish")} class={chip(holding("demolish"))} title="Demolish (X)">
          <Trash2 size={18} stroke-width={holding("demolish") ? 2.25 : 1.5} />
        </button>
        <div class="w-px h-6 bg-black/10 mx-1" />
        <button
          onClick={() => send({ type: "DespawnAllCars" })}
          class="group flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all duration-300 cursor-pointer text-stone-400 hover:text-orange-500 hover:bg-orange-50/50"
          title="Despawn all cars"
        >
          <CarOff size={18} stroke-width={1.5} />
        </button>
        <button
          onClick={() => send({ type: "ResetWorld" })}
          class="group flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all duration-300 cursor-pointer text-stone-400 hover:text-red-500 hover:bg-red-50/50"
          title="Reset server"
        >
          <RotateCcw size={18} stroke-width={1.5} />
        </button>
      </div>
    </div>
  );
}
