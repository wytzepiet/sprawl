import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector, viewExtent } from "../engine/view";
import { pinned, reached } from "../state/gameObjects";
import { BLUEPRINTS } from "../blueprints";
import { PinBody } from "./Pin";
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
/** The distinct pin thresholds, ascending: the only zooms at which anything changes. */
const STEPS = [...new Set(Object.values(BLUEPRINTS).map((b) => b.pinUntil))].sort((a, b) => a - b);



/**
 * Pins over the map: one per building, saying what it is; red where no road
 * joined to the world reaches it. HTML, positioned each frame by projecting the world
 * position through the orthographic camera — text and buttons are what HTML
 * is for, and a class swap is all it takes to collapse them far out.
 */
export default function PinLayer() {
  const { scene, canvas } = useEngine();

  const entries = createMemo(() => pinned());
  // How many of the thresholds the view has passed. A number rather than the
  // zoom itself, so it changes a handful of times instead of every frame.
  const [step, setStep] = createSignal(0);
  const els = new Map<number, HTMLElement>();
  let layer!: HTMLDivElement;

  // Project every pin after each render, through the scene's own matrix — so a
  // pin lands where its plot is drawn whatever projection the camera uses.
  const place = () => {
    if (!scene.activeCamera) return;
    const { halfH } = viewExtent(scene, canvas);
    const project = projector(scene, canvas);
    const rect = project.rect;

    const passed = STEPS.filter((s) => halfH > s).length;
    if (passed !== step()) setStep(passed);

    const now = performance.now();
    for (const e of entries()) {
      const el = els.get(e.id);
      if (!el || !e.position) continue;
      const [w, h] = (e.object.data as { size: [number, number] }).size;
      const { sx, sy } = project.at(e.position.x + w / 2, e.position.y + h / 2);
      const off = sx < -40 || sy < -40 || sx > rect.right + 40 || sy > rect.bottom + 40;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.display = off ? "none" : "";
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

  return (
    <div ref={layer} class="pins fixed inset-0 pointer-events-none select-none">
      <For each={entries()}>
        {(e) => {
          const kind = () => (e.object.data as { kind: BuildingKind }).kind;
          // A building no road reaches is asking for one, so it never collapses.
          const dormant = createMemo(() => !reached(e));
          const dot = createMemo(() => !dormant() && step() > STEPS.indexOf(BLUEPRINTS[kind()].pinUntil));
          return (
            <div
              ref={(el) => {
                els.set(e.id, el);
                onCleanup(() => {
                  if (els.get(e.id) === el) els.delete(e.id);
                });
              }}
              class="pin absolute left-0 top-0 flex flex-col items-center -translate-x-1/2 -translate-y-full"
              classList={{ dormant: dormant(), collapsed: dot() }}
              style={{ display: "none" }}
            >
              {/* Both shapes are always here, one of them faded out, so going
                  between them is a transition rather than a cut. The pin
                  shrinks into its own point; the dot grows from it. */}
              <div class="marker relative">
                <PinBody kind={kind()} dormant={dormant()} />
                <span class="dot" style={{ "background-color": BLUEPRINTS[kind()].color }} />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
