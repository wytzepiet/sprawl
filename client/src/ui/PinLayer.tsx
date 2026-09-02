import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { pickWorld } from "../engine/pickWorld";
import { useGame, pinned } from "../state/gameObjects";
import { BuildingIcon } from "./buildingIcons";
import type { BuildingKind, GameObjectEntry } from "../generated";

/**
 * How far you may zoom out and still get a full pin, as half the view height
 * in tiles. Past it the building is a dot.
 *
 * The ordinary stock of a city is nearly all of it, and a hundred pins saying
 * "house" is a hundred pins saying nothing — so houses, shops and factories
 * give up their pin as soon as you stop looking at individual plots, and the
 * ones that survive are the ones worth picking out. That is the whole reason
 * this is a table and not a constant: a kind earns its pin by being rare.
 */
const COMMON = 7;
const NOTABLE = 28;
const SPECIAL = 45;
const PIN_UNTIL: Record<BuildingKind, number> = {
  // The bulk of a city. Somewhere people live or work, and there are hundreds.
  House: COMMON,
  Apartment: COMMON,
  Office: COMMON,
  Factory: COMMON,
  // Places people go, which is what makes them worth finding from further off.
  Shop: NOTABLE,
  Workshop: NOTABLE,
  // Rare enough to be a landmark.
  Restaurant: SPECIAL,
};

/** The distinct thresholds, ascending: the only zooms at which anything changes. */
const STEPS = [...new Set(Object.values(PIN_UNTIL))].sort((a, b) => a - b);

/**
 * The pin outline: a circle of radius 10 at the origin, and a point at (0,18).
 * The two straight edges are the tangents from that point to the circle, so
 * they leave the arc at the same slope it ends on — one shape, not a disc with
 * a triangle stuck under it. Tangent points are at (±r·sinθ, r·cosθ) where
 * cosθ = r/d, which for r=10, d=18 puts them at (±8.315, 5.556).
 *
 * How far the point sits below the centre is the whole look: the further out,
 * the narrower the taper. At d=18 the apex is 67.5° and the straight run is 15
 * units, against the circle's 20 of width.
 */
const OUTLINE = "M-8.315 5.556A10 10 0 1 1 8.315 5.556L0 18Z";

/**
 * What kind of building this is, as colour. The buildings themselves are
 * deliberately neutral, so this is the only place a kind is coloured — chosen
 * mid-dark so a white glyph reads on it, and spread far enough apart in hue to
 * be told apart at a dot's size.
 */
const PIN_COLORS: Record<BuildingKind, string> = {
  House: "#3F9B5A",
  Apartment: "#2E7D6F",
  Shop: "#2F7FD4",
  Office: "#5B57C8",
  Workshop: "#C97A1E",
  Factory: "#6B6F78",
  Restaurant: "#D9483B",
};

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
  // How many of the thresholds the view has passed. A number rather than the
  // zoom itself, so it changes a handful of times instead of every frame.
  const [step, setStep] = createSignal(0);
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
    const perTile = rect.height / (2 * halfH);

    const passed = STEPS.filter((s) => halfH > s).length;
    if (passed !== step()) setStep(passed);

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

      // A pin points at the middle of its plot, so an answer hung straight off
      // it would cover the very building it is asking about. Drop it past the
      // plot's near edge instead — which is half a footprint, in pixels, and so
      // depends on how big the plot is and how far you are zoomed in.
      if (e.object.kind === "Proposal") {
        el.style.setProperty("--drop", `${(h / 2) * perTile + 6}px`);
      }
    }
  };
  const obs = scene.onAfterRenderObservable.add(place);
  onCleanup(() => scene.onAfterRenderObservable.remove(obs));

  // Pins have to take clicks, which means they also swallow the wheel — and the
  // layer is a sibling of the canvas, so nothing bubbles across on its own.
  // Hand the scroll on, so the camera still zooms wherever the cursor is.
  onMount(() => {
    const relay = (ev: WheelEvent) => {
      ev.preventDefault();
      canvas.dispatchEvent(new WheelEvent("wheel", ev));
    };
    layer.addEventListener("wheel", relay, { passive: false });
    onCleanup(() => layer.removeEventListener("wheel", relay));
  });

  // Dragging a proposal's pin re-sites it; the server snaps it to land that
  // fits, and the ghost follows on the next update.
  const drag = (e: GameObjectEntry, down: PointerEvent) => {
    // The right button always pans, pin or no pin, so only take the left one.
    if (down.button !== 0) {
      return;
    }
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
          // A proposal is a question put to the player, so it never collapses.
          const dot = createMemo(() => !proposal() && step() > STEPS.indexOf(PIN_UNTIL[kind()]));
          return (
            <div
              ref={(el) => {
                els.set(e.id, el);
                onCleanup(() => {
                  if (els.get(e.id) === el) els.delete(e.id);
                });
              }}
              class="pin absolute left-0 top-0 flex flex-col items-center -translate-x-1/2 -translate-y-full"
              classList={{ proposal: proposal(), collapsed: dot() }}
              style={{ display: "none" }}
            >
              {/* Both shapes are always here, one of them faded out, so going
                  between them is a transition rather than a cut. The pin
                  shrinks into its own point; the dot grows from it. */}
              <div class="marker relative">
                <svg
                  class="head drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
                  viewBox="-11 -11 22 30"
                  classList={{ "pointer-events-auto cursor-grab": proposal() }}
                  onPointerDown={(ev) => proposal() && drag(e, ev)}
                >
                  <path d={OUTLINE} fill="#fff" stroke={proposal() ? "#38BDF8" : "none"} stroke-width="1.5" />
                  {/* The disc nearly fills the head: the white is a rim on the
                      colour, not a field it floats in. */}
                  <circle r="7.8" fill={PIN_COLORS[kind()]} />
                  <BuildingIcon kind={kind()} class="glyph text-white" x="-6.5" y="-6.5" width="13" height="13" />
                </svg>
                <span class="dot" style={{ "background-color": PIN_COLORS[kind()] }} />
                {/* Hung below the marker rather than sitting in the column, so
                    the pin keeps its own place over the plot and the answer
                    falls clear of the building being asked about. */}
                {proposal() && (
                  <div class="answer pointer-events-auto absolute left-1/2 -translate-x-1/2 flex gap-1 rounded-lg bg-white/90 p-0.5 shadow">
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
            </div>
          );
        }}
      </For>
    </div>
  );
}
