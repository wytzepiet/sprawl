import { For, Show } from "solid-js";
import { MousePointer2, Route, Trash2, CarOff, RotateCcw, Building2 } from "./icons";
import {
  buildMode,
  setBuildMode,
  roadKind,
  setRoadKind,
  type BuildMode,
  type RoadKind,
} from "./buildMode";
import { useGame } from "../state/gameObjects";
import { tree, unlocked } from "../state/tree";
import {
  BuildButton,
  BuildMenuSheet,
  CancelZone,
  buildMenuOpen,
  setBuildMenuOpen,
} from "./BuildMenu";
import { placingBuilding, setPlacingBuilding } from "./buildMode";
import { Dynamic } from "solid-js/web";

const modes = [
  { id: "select" as BuildMode, label: "Select", icon: MousePointer2, key: "V" },
  { id: "road" as BuildMode, label: "Road", icon: Route, key: "R" },
  { id: "demolish" as BuildMode, label: "Demolish", icon: Trash2, key: "X" },
];

/** What the road tool can draw, in the order the T key cycles them. */
const ROAD_KINDS: { id: RoadKind; label: string; needs?: string }[] = [
  { id: "street", label: "Street" },
  { id: "oneway", label: "1-way", needs: "OneWay" },
  { id: "road", label: "Road", needs: "Road" },
];

export default function BuildModeToolbar() {
  const { send, growth } = useGame();
  // The build says which kinds may be drawn; a locked kind cannot be chosen.
  const may = (kind: RoadKind) => {
    const needs = ROAD_KINDS.find((r) => r.id === kind)?.needs;
    return !needs || unlocked(tree(), growth().taken, (e) => e.kind === needs);
  };
  const choose = (kind: RoadKind) => { if (may(kind)) setRoadKind(kind); };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (buildMode() === "road" && e.key.toLowerCase() === "t") {
      const i = ROAD_KINDS.findIndex((r) => r.id === roadKind());
      for (let j = 1; j <= ROAD_KINDS.length; j++) {
        const next = ROAD_KINDS[(i + j) % ROAD_KINDS.length].id;
        if (may(next)) { setRoadKind(next); break; }
      }
      return;
    }
    if (e.key.toLowerCase() === "b") {
      setBuildMenuOpen((v) => !v);
      return;
    }
    if (e.key === "Escape") {
      if (placingBuilding()) {
        setPlacingBuilding(null);
        return;
      }
      if (buildMenuOpen()) {
        setBuildMenuOpen(false);
        return;
      }
    }
    const mode = modes.find((m) => m.key.toLowerCase() === e.key.toLowerCase());
    if (mode) setBuildMode(mode.id);
  };

  window.addEventListener("keydown", handleKeyDown);

  return (
    <>
      <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        <Show when={buildMode() === "road"}>
          <div class="flex items-center p-1 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <For each={ROAD_KINDS}>
              {(r) => (
                <button
                  onClick={() => choose(r.id)}
                  disabled={!may(r.id)}
                  title={may(r.id) ? r.label : `${r.label}: take it on the tree (L)`}
                  class={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200
                  ${
                    roadKind() === r.id
                      ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)] cursor-pointer"
                      : may(r.id)
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
        <div class="flex items-center gap-1.5 p-2 rounded-2xl">
          <BuildButton />
          <div class="flex items-center gap-1 p-2 rounded-2xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]">
            <For each={modes}>
              {(m) => {
                return (
                  <button
                    onClick={() => setBuildMode(m.id)}
                    class={`group relative flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer
                  ${
                    buildMode() === m.id
                      ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.04)]"
                      : "text-stone-400 hover:text-stone-600 hover:bg-white/50"
                  }`}
                    title={`${m.label} (${m.key})`}
                  >
                    <Dynamic
                      component={m.icon}
                      size={18}
                      stroke-width={buildMode() === m.id ? 2.25 : 1.5}
                    />
                    <span
                      class={`text-xs font-semibold tracking-wide uppercase transition-all duration-300
                  ${buildMode() === m.id ? "opacity-100 max-w-20" : "opacity-0 max-w-0 overflow-hidden group-hover:opacity-60 group-hover:max-w-20"}`}
                    >
                      {m.label}
                    </span>
                    <kbd
                      class={`pointer-events-none absolute -top-1.5 -right-0.5 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm transition-opacity
                  ${buildMode() === m.id ? "opacity-0" : "opacity-0 group-hover:opacity-80"}`}
                    >
                      {m.key}
                    </kbd>
                  </button>
                );
              }}
            </For>
            <div class="w-px h-6 bg-black/10 mx-1" />
            <button
              onClick={() => send({ type: "DespawnAllCars" })}
              class="group flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer text-stone-400 hover:text-orange-500 hover:bg-orange-50/50"
              title="Despawn all cars"
            >
              <CarOff size={18} stroke-width={1.5} />
            </button>
            <button
              onClick={() => send({ type: "ResetWorld" })}
              class="group flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer text-stone-400 hover:text-red-500 hover:bg-red-50/50"
              title="Reset server"
            >
              <RotateCcw size={18} stroke-width={1.5} />
            </button>
          </div>
        </div>
      </div>
      <BuildMenuSheet />
      <CancelZone />
    </>
  );
}
