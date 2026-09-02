import { For, createMemo, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { pickWorld } from "../engine/pickWorld";
import { useGame, pinned } from "../state/gameObjects";
import { BuildingIcon } from "./buildingIcons";
import type { BuildingKind, GameObjectEntry } from "../generated";

/** Zoomed out past this (half the view height, in tiles), pins are dots. */
const FAR = 40;

/**
 * Pins over the map: one per building, saying what it is, and one per
 * proposal, asking. HTML, positioned each frame by projecting the world
 * position through the orthographic camera — text and buttons are what HTML
 * is for, and a class swap is all it takes to collapse them far out.
 */
export default function PinLayer() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();

  const entries = createMemo(() => pinned());
  const els = new Map<number, HTMLElement>();
  let layer!: HTMLDivElement;

  // Project every pin after each render. The camera is orthographic and looks
  // straight down, so this is the inverse of pickWorld: a lerp, not a matrix.
  const place = () => {
    const cam = scene.activeCamera;
    if (!cam || !cam.orthoLeft) return;
    const rect = canvas.getBoundingClientRect();
    const halfW = (cam.orthoRight! - cam.orthoLeft) / 2;
    const halfH = (cam.orthoTop! - cam.orthoBottom!) / 2;
    layer.classList.toggle("far", halfH > FAR);
    for (const e of entries()) {
      const el = els.get(e.id);
      if (!el || !e.position) continue;
      const [w, h] = (e.object.data as { size: [number, number] }).size;
      const wx = e.position.x + w / 2;
      const wy = e.position.y + h / 2;
      const nx = (wx - cam.position.x) / halfW;
      const ny = (wy - cam.position.y) / halfH;
      const sx = rect.left + ((1 - nx) / 2) * rect.width;
      const sy = rect.top + ((1 - ny) / 2) * rect.height;
      const off = sx < -40 || sy < -40 || sx > rect.right + 40 || sy > rect.bottom + 40;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.display = off ? "none" : "";
    }
  };
  const obs = scene.onAfterRenderObservable.add(place);
  onCleanup(() => scene.onAfterRenderObservable.remove(obs));

  // Dragging a proposal's pin re-sites it; the server snaps it to land that
  // fits, and the ghost follows on the next update.
  const drag = (e: GameObjectEntry, down: PointerEvent) => {
    down.stopPropagation();
    const el = els.get(e.id);
    el?.setPointerCapture(down.pointerId);
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const { wx, wy } = pickWorld(scene, canvas, ev);
      el!.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
      el!.dataset.wx = String(Math.floor(wx));
      el!.dataset.wy = String(Math.floor(wy));
    };
    const up = () => {
      el?.removeEventListener("pointermove", move);
      el?.removeEventListener("pointerup", up);
      if (moved && el?.dataset.wx) {
        send({ type: "MoveProposal", data: { id: e.id, pos: { x: Number(el.dataset.wx), y: Number(el.dataset.wy) } } });
      }
    };
    el?.addEventListener("pointermove", move);
    el?.addEventListener("pointerup", up);
  };

  return (
    <div ref={layer} class="pins fixed inset-0 pointer-events-none select-none">
      <For each={entries()}>
        {(e) => {
          const proposal = () => e.object.kind === "Proposal";
          const kind = () => (e.object.data as { kind: BuildingKind }).kind;
          return (
            <div
              ref={(el) => {
                els.set(e.id, el);
                onCleanup(() => els.delete(e.id));
              }}
              class="pin absolute left-0 top-0 flex flex-col items-center -translate-x-1/2 -translate-y-full"
              classList={{ proposal: proposal() }}
              style={{ display: "none" }}
            >
              <div
                class="head grid place-items-center rounded-full bg-white/90 shadow-[0_1px_6px_rgba(0,0,0,0.25)]"
                classList={{ "pointer-events-auto cursor-grab ring-2 ring-sky-400": proposal() }}
                onPointerDown={(ev) => proposal() && drag(e, ev)}
              >
                <BuildingIcon kind={kind()} class="glyph w-4 h-4 text-stone-700" />
              </div>
              <div class="tip w-0 h-0 border-x-[5px] border-x-transparent border-t-[7px] border-t-white/90" />
              {proposal() && (
                <div class="answer pointer-events-auto mt-1 flex gap-1 rounded-lg bg-white/90 p-0.5 shadow">
                  <button
                    class="w-7 h-7 rounded-md bg-emerald-500 text-white font-bold hover:bg-emerald-600 cursor-pointer"
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={() => send({ type: "Answer", data: { id: e.id, accept: true } })}
                  >
                    ✓
                  </button>
                  <button
                    class="w-7 h-7 rounded-md bg-stone-200 text-stone-700 font-bold hover:bg-red-100 hover:text-red-600 cursor-pointer"
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={() => send({ type: "Answer", data: { id: e.id, accept: false } })}
                  >
                    ✗
                  </button>
                </div>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
}
