import { For, Show } from "solid-js";
import { MousePointer2, Route, Trash2, CarOff, RotateCcw } from "./icons";
import {
  buildMode,
  setBuildMode,
  roadOneWay,
  setRoadOneWay,
  type BuildMode,
} from "./buildMode";
import { useGame } from "../state/gameObjects";
import {
  BuildButton,
  BuildMenuSheet,
  buildMenuOpen,
  setBuildMenuOpen,
} from "./BuildMenu";
import { placingBuilding, setPlacingBuilding } from "./buildMode";
import { Dynamic } from "@solidjs/web";

const modes = [
  { id: "select" as BuildMode, label: "Select", icon: MousePointer2, key: "V" },
  { id: "road" as BuildMode, label: "Road", icon: Route, key: "R" },
  { id: "demolish" as BuildMode, label: "Demolish", icon: Trash2, key: "X" },
];

export default function BuildModeToolbar() {
  const { send } = useGame();

  const handleKeyDown = (e: KeyboardEvent) => {
    if (buildMode() === "road" && e.key.toLowerCase() === "t") {
      setRoadOneWay((v) => !v);
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
          <div class="flex p-1 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <button
              onClick={() => setRoadOneWay(false)}
              class={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200 cursor-pointer
              ${
                !roadOneWay()
                  ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              2-way
            </button>
            <button
              onClick={() => setRoadOneWay(true)}
              class={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200 cursor-pointer
              ${
                roadOneWay()
                  ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              1-way
            </button>
            <kbd class="self-center ml-1 mr-1 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm">
              T
            </kbd>
          </div>
        </Show>
        <div class="flex items-center gap-1.5 p-2 rounded-2xl">
          <BuildButton />
          <div class="flex items-center gap-1 p-2 rounded-2xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]">
            <For each={modes}>
              {(m) => {
                return (
                  <button
                    onClick={() => setBuildMode(m().id)}
                    class={`group relative flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer
                  ${
                    buildMode() === m().id
                      ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.04)]"
                      : "text-stone-400 hover:text-stone-600 hover:bg-white/50"
                  }`}
                    title={`${m().label} (${m().key})`}
                  >
                    <Dynamic
                      component={m().icon}
                      size={18}
                      stroke-width={buildMode() === m().id ? 2.25 : 1.5}
                    />
                    <span
                      class={`text-xs font-semibold tracking-wide uppercase transition-all duration-300
                  ${buildMode() === m().id ? "opacity-100 max-w-20" : "opacity-0 max-w-0 overflow-hidden group-hover:opacity-60 group-hover:max-w-20"}`}
                    >
                      {m().label}
                    </span>
                    <kbd
                      class={`pointer-events-none absolute -top-1.5 -right-0.5 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm transition-opacity
                  ${buildMode() === m().id ? "opacity-0" : "opacity-0 group-hover:opacity-80"}`}
                    >
                      {m().key}
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
    </>
  );
}
