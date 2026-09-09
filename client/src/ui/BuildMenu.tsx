import { createMemo, createSignal, For, Show } from "solid-js";
import BuildMenuScene, { slots } from "./BuildMenuScene";
import { BLUEPRINTS, KINDS, TABS, plot, type Tab } from "../blueprints";
import { PinBody } from "./Pin";
import type { BuildingKind } from "../generated";
import { Building2 } from "./icons";
import { placingBuilding, setOverCancel, setPlacingBuilding } from "./buildMode";
import { useGame } from "../state/gameObjects";
import { tree, unlocked } from "../state/tree";

const [buildMenuOpen, setBuildMenuOpen] = createSignal(false);
export { buildMenuOpen, setBuildMenuOpen };

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

/**
 * Where the shelf was, while a building is being dragged: drag it back here
 * and let go, and it is put back. The building is not placed, and nothing
 * is spent.
 */
export function CancelZone() {
  return (
    <Show when={placingBuilding()}>
      <div class="fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <div
          class="pointer-events-auto w-full max-w-2xl mx-4 mb-4 h-20 rounded-2xl border-2 border-dashed border-stone-400/60 bg-white/50 backdrop-blur-xl grid place-items-center text-xs font-semibold uppercase tracking-wide text-stone-500 animate-slide-up"
          onPointerEnter={() => setOverCancel(true)}
          onPointerLeave={() => setOverCancel(false)}
        >
          Drop here to put it back
        </div>
      </div>
    </Show>
  );
}

export function BuildMenuSheet() {
  const { growth } = useGame();
  // The build says what may be placed; the rest is shown, and locked. What
  // the mayor cannot yet afford is shown too, and greyed: the thing you are
  // saving for is the tile you keep looking at.
  const may = (kind: BuildingKind) => unlocked(tree(), growth().taken, (e) => e.kind === "Building" && e.building === kind);
  const hours = () => growth().balance / 60;
  const afford = (kind: BuildingKind) => hours() >= BLUEPRINTS[kind].price;
  const [tab, setTab] = createSignal<Tab>("homes");
  const kinds = () => KINDS.filter((k) => BLUEPRINTS[k].tab === tab());
  // One tile of the shelf in pixels, so a pin can point at its plot's
  // centre whatever the plot's size. Horizontally that is a fraction of
  // the slot; vertically an offset from the canvas middle, on the row.
  const [tilePx, setTilePx] = createSignal(0);
  const [over, setOver] = createSignal<BuildingKind | null>(null);
  // The shelf is built once for its kinds; a new tab is a new shelf.
  const shelf = createMemo(() => {
    const k = kinds();
    return <BuildMenuScene kinds={k} hovered={over()} onFit={setTilePx} />;
  });
  // The row stands centred in the shelf; each slot is laid over its plot,
  // and its pin over the building, up being up as the shelf's camera has
  // it.
  const row = () => slots(kinds());
  // A slot is centred on its plot: half a tile of the gap on either side.
  const slotLeft = (i: number) => `calc(50% + ${(row().start[i] + 0.5 - row().total / 2) * tilePx()}px)`;
  const slotWidth = (i: number) => `${row().width[i] * tilePx()}px`;
  const pinLeft = (kind: BuildingKind, i: number) => `${((0.5 + plot(kind, 2).building[0][0] + plot(kind, 2).building[1][0] / 2) / row().width[i]) * 100}%`;
  const deepest = () => Math.max(...kinds().map((k) => plot(k, 2).size[1]));
  const pinTop = (kind: BuildingKind) => `calc(50% - ${(plot(kind, 2).building[0][1] + plot(kind, 2).building[1][1] / 2 - deepest() / 2) * tilePx()}px)`;
  const pick = (kind: BuildingKind, e: PointerEvent) => {
    e.preventDefault();
    if (!may(kind) || !afford(kind)) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onMove = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      setPlacingBuilding(kind);
      setBuildMenuOpen(false);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
  return (
    <Show when={buildMenuOpen()}>
      <div class="fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <div class="pointer-events-auto w-full max-w-2xl mx-4 mb-4 p-4 rounded-2xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_-4px_30px_rgba(0,0,0,0.1),0_0_0_1px_rgba(255,255,255,0.7)_inset] animate-slide-up">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-1">
              <For each={TABS}>
                {(t) => (
                  <button
                    class="text-xs font-semibold tracking-wide uppercase px-2 py-1 rounded-lg transition-colors cursor-pointer"
                    classList={{ "bg-stone-800 text-white": tab() === t, "text-stone-500 hover:text-stone-800 hover:bg-black/[0.04]": tab() !== t }}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                )}
              </For>
            </div>
            <button
              onClick={() => setBuildMenuOpen(false)}
              class="text-stone-400 hover:text-stone-600 text-xs cursor-pointer"
            >
              ✕
            </button>
          </div>
          {/* One world for the whole shelf, and a slot laid over each kind
              standing in it: the pin, the label, and the drag to place it. */}
          <div class="pins relative rounded-xl overflow-hidden" style={{ height: "210px" }}>
            {shelf()}
            <div class="absolute inset-0">
              <For each={kinds()}>
                {(kind, i) => (
                  <button
                    class={`absolute top-0 bottom-0 flex flex-col items-center justify-end pb-2 ${may(kind) && afford(kind) ? "cursor-grab active:cursor-grabbing" : "bg-white/60 cursor-not-allowed"}`}
                    style={{ left: slotLeft(i()), width: slotWidth(i()) }}
                    title={!may(kind) ? "Take it on the tree (L)" : !afford(kind) ? `Save up: ${BLUEPRINTS[kind].price}h` : undefined}
                    onPointerDown={(e) => pick(kind, e)}
                    onPointerEnter={() => setOver(kind)}
                    onPointerLeave={() => setOver((o) => (o === kind ? null : o))}
                  >
                    <div class="pin absolute -translate-x-1/2 -translate-y-full pointer-events-none" style={{ left: pinLeft(kind, i()), top: pinTop(kind) }} classList={{ "opacity-40": !may(kind) }}>
                      <div class="marker relative">
                        <PinBody kind={kind} />
                      </div>
                    </div>
                    <span class={`text-[11px] font-medium ${may(kind) ? "text-stone-600" : "text-stone-400"}`}>{BLUEPRINTS[kind].label}</span>
                    <span class={`text-[10px] font-semibold tabular-nums ${afford(kind) && may(kind) ? "text-stone-500" : "text-stone-300"}`}>{BLUEPRINTS[kind].price} h</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
