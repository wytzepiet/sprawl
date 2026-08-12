import { For, Show } from "solid-js";
import { Route, Trash2, CarOff, RotateCcw, Building2 } from "./icons";
import {
  appMode,
  setAppMode,
  tool,
  setTool,
  roadOneWay,
  setRoadOneWay,
  paintCategory,
  setPaintCategory,
  placingBuilding,
  setPlacingBuilding,
  type Tool,
} from "./buildMode";
import { useGame, pending } from "../state/gameObjects";
import {
  BuildButton,
  BuildMenuSheet,
  buildMenuOpen,
  setBuildMenuOpen,
} from "./BuildMenu";
import { CATEGORY_COLOR } from "../engine/objects/buildings";
import type { Category } from "../generated";
import { Dynamic } from "solid-js/web";

const tools = [
  { id: "road" as Tool, label: "Road", icon: Route, key: "R" },
  { id: "zone" as Tool, label: "Zone", icon: Building2, key: "Z" },
  { id: "demolish" as Tool, label: "Demolish", icon: Trash2, key: "X" },
];

/** The build brush's three palettes, in the order their hotkeys run. */
const CATEGORIES: { id: Category; label: string; key: string }[] = [
  { id: "Residential", label: "Homes", key: "1" },
  { id: "Commercial", label: "Shops", key: "2" },
  { id: "Industrial", label: "Works", key: "3" },
];

const PANEL =
  "flex p-1 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]";

export default function BuildModeToolbar() {
  const { send } = useGame();

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      e.preventDefault();
      setAppMode((m) => (m === "build" ? "view" : "build"));
      return;
    }
    // Committing has a key; discarding does not. Throwing away a morning's
    // layout should take aim, not a stray keystroke.
    if (e.key === "Enter" && pending() > 0) {
      send({ type: "Commit" });
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
      setAppMode("view");
      return;
    }
    if (appMode() !== "build") return;

    if (tool() === "road" && e.key.toLowerCase() === "t") {
      setRoadOneWay((v) => !v);
      return;
    }
    if (e.key.toLowerCase() === "b") {
      setBuildMenuOpen((v) => !v);
      return;
    }
    if (tool() === "zone") {
      const cat = CATEGORIES.find((c) => c.key === e.key);
      if (cat) {
        setPaintCategory(cat.id);
        return;
      }
    }
    const t = tools.find((m) => m.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.id);
  };

  window.addEventListener("keydown", handleKeyDown);

  return (
    <>
      <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {/* Uncommitted work is shown in both modes. Hidden behind a mode
            toggle it would be work you forget you have, and it expires. */}
        <Show when={pending() > 0}>
          <div class="flex items-center gap-1 p-1 rounded-xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_16px_rgba(0,0,0,0.10)]">
            <span class="px-3 text-xs font-semibold tracking-wide uppercase text-stone-400">
              {pending()} pending
            </span>
            <button
              onClick={() => send({ type: "Discard" })}
              class="px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase cursor-pointer transition-colors duration-200 text-stone-400 hover:text-red-500 hover:bg-red-50"
              title="Throw away everything you have drafted"
            >
              Discard
            </button>
            <button
              onClick={() => send({ type: "Commit" })}
              class="group relative flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase cursor-pointer transition-colors duration-200 bg-stone-800 text-white hover:bg-stone-900"
              title="Make it real (Enter)"
            >
              Build
              <kbd class="text-[9px] font-mono px-1 py-0.5 rounded-md bg-white/20 text-white/80 leading-none">
                Enter
              </kbd>
            </button>
          </div>
        </Show>

      <Show
        when={appMode() === "build"}
        fallback={
          <button
            onClick={() => setAppMode("build")}
            class="group flex items-center gap-2 px-5 py-3 rounded-2xl cursor-pointer transition-all duration-300
              bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]
              text-stone-500 hover:text-stone-800 hover:bg-white/90"
          >
            <Building2 size={20} stroke-width={1.5} />
            <span class="text-xs font-semibold tracking-wide uppercase">Build</span>
            <kbd class="text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm">
              Space
            </kbd>
          </button>
        }
      >
        <div class="flex flex-col items-center gap-2">
          <Show when={tool() === "road"}>
            <div class={PANEL}>
              <For each={[false, true]}>
                {(one) => (
                  <button
                    onClick={() => setRoadOneWay(one)}
                    class={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200 cursor-pointer
                    ${
                      roadOneWay() === one
                        ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                        : "text-stone-400 hover:text-stone-600"
                    }`}
                  >
                    {one ? "1-way" : "2-way"}
                  </button>
                )}
              </For>
              <kbd class="self-center ml-1 mr-1 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm">
                T
              </kbd>
            </div>
          </Show>

          <Show when={tool() === "zone"}>
            <div class={PANEL}>
              <For each={CATEGORIES}>
                {(c) => (
                  <button
                    onClick={() => setPaintCategory(c.id)}
                    class={`group relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200 cursor-pointer
                    ${
                      paintCategory() === c.id
                        ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                        : "text-stone-400 hover:text-stone-600"
                    }`}
                    title={`${c.label} (${c.key})`}
                  >
                    <span
                      class="w-3 h-3 rounded-full"
                      style={{ "background-color": CATEGORY_COLOR[c.id] }}
                    />
                    {c.label}
                    <kbd
                      class={`pointer-events-none absolute -top-1.5 -right-0.5 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm transition-opacity
                      ${paintCategory() === c.id ? "opacity-0" : "opacity-0 group-hover:opacity-80"}`}
                    >
                      {c.key}
                    </kbd>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="flex items-center gap-1.5 p-2 rounded-2xl">
            <BuildButton />
            <div class="flex items-center gap-1 p-2 rounded-2xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]">
              <For each={tools}>
                {(m) => (
                  <button
                    onClick={() => setTool(m.id)}
                    class={`group relative flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer
                    ${
                      tool() === m.id
                        ? "bg-white text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.04)]"
                        : "text-stone-400 hover:text-stone-600 hover:bg-white/50"
                    }`}
                    title={`${m.label} (${m.key})`}
                  >
                    <Dynamic
                      component={m.icon}
                      size={18}
                      stroke-width={tool() === m.id ? 2.25 : 1.5}
                    />
                    <span
                      class={`text-xs font-semibold tracking-wide uppercase transition-all duration-300
                      ${tool() === m.id ? "opacity-100 max-w-20" : "opacity-0 max-w-0 overflow-hidden group-hover:opacity-60 group-hover:max-w-20"}`}
                    >
                      {m.label}
                    </span>
                    <kbd
                      class={`pointer-events-none absolute -top-1.5 -right-0.5 text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm transition-opacity
                      ${tool() === m.id ? "opacity-0" : "opacity-0 group-hover:opacity-80"}`}
                    >
                      {m.key}
                    </kbd>
                  </button>
                )}
              </For>
              <div class="w-px h-6 bg-black/10 mx-1" />
              <button
                onClick={() => setAppMode("view")}
                class="group flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all duration-300 cursor-pointer text-stone-400 hover:text-stone-700 hover:bg-white/50"
                title="Done (Space)"
              >
                <span class="text-xs font-semibold tracking-wide uppercase">Done</span>
                <kbd class="text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm">
                  Space
                </kbd>
              </button>
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
      </Show>
      </div>
      <BuildMenuSheet />
    </>
  );
}
