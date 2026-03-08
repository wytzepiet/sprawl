import { createSignal, For, Show } from "solid-js";
import { Color3 } from "@babylonjs/core";
import MultiCanvasProvider from "../engine/MultiCanvasProvider";
import MultiCanvasView from "../engine/MultiCanvasView";
import BuildingPreview from "../engine/objects/BuildingPreview";
import { BUILDINGS } from "../engine/objects/buildings";
import { Building2 } from "./icons";
import { setPlacingBuilding } from "./buildMode";

const [buildMenuOpen, setBuildMenuOpen] = createSignal(false);
export { buildMenuOpen, setBuildMenuOpen };

const PREVIEW_SIZE = 120;

export function BuildButton() {
  return (
    <button
      onClick={() => setBuildMenuOpen((v) => !v)}
      class={`group relative flex items-center gap-2 px-5 py-3 rounded-2xl transition-all duration-300 cursor-pointer
        bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(255,255,255,0.7)_inset]
        ${buildMenuOpen()
          ? "text-stone-800 shadow-[0_1px_3px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.04)]"
          : "text-stone-400 hover:text-stone-600 hover:bg-white/90"
        }`}
      title="Build (B)"
    >
      <Building2 size={20} stroke-width={buildMenuOpen() ? 2.25 : 1.5} />
      <span class="text-xs font-semibold tracking-wide uppercase">Build</span>
      <kbd class={`pointer-events-none text-[9px] font-mono px-1 py-0.5 rounded-md bg-white border border-black/[0.06] text-stone-400 leading-none shadow-sm
        ${buildMenuOpen() ? "opacity-0" : "opacity-60"}`}>
        B
      </kbd>
    </button>
  );
}

export function BuildMenuSheet() {
  return (
    <Show when={buildMenuOpen()}>
      <div class="fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <div class="pointer-events-auto w-full max-w-2xl mx-4 mb-4 p-4 rounded-2xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_-4px_30px_rgba(0,0,0,0.1),0_0_0_1px_rgba(255,255,255,0.7)_inset] animate-slide-up">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold text-stone-600 uppercase tracking-wide">Buildings</h2>
            <button
              onClick={() => setBuildMenuOpen(false)}
              class="text-stone-400 hover:text-stone-600 text-xs cursor-pointer"
            >
              ✕
            </button>
          </div>
          <MultiCanvasProvider canvasSize={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}>
            <div class="grid grid-cols-3 sm:grid-cols-4 gap-3">
              <For each={BUILDINGS}>
                {(building) => (
                  <button
                    class="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-black/[0.04] transition-colors cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      const buildingId = building().id;
                      const onMove = () => {
                        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                        (e.currentTarget as HTMLElement).removeEventListener("pointermove", onMove);
                        (e.currentTarget as HTMLElement).removeEventListener("pointerup", onUp);
                        setPlacingBuilding(buildingId);
                        setBuildMenuOpen(false);
                      };
                      const onUp = () => {
                        (e.currentTarget as HTMLElement).removeEventListener("pointermove", onMove);
                        (e.currentTarget as HTMLElement).removeEventListener("pointerup", onUp);
                      };
                      (e.currentTarget as HTMLElement).addEventListener("pointermove", onMove);
                      (e.currentTarget as HTMLElement).addEventListener("pointerup", onUp);
                    }}
                  >
                    <MultiCanvasView
                      style={{
                        width: "100%",
                        "aspect-ratio": "1",
                        "border-radius": "0.75rem",
                        display: "block",
                      }}
                      class="bg-stone-100"
                    >
                      <BuildingPreview color={Color3.FromHexString(building().color)} />
                    </MultiCanvasView>
                    <span class="text-[11px] font-medium text-stone-500">{building().label}</span>
                  </button>
                )}
              </For>
            </div>
          </MultiCanvasProvider>
        </div>
      </div>
    </Show>
  );
}
