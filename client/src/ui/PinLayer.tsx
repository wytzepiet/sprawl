import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector, viewExtent } from "../engine/view";
import { pinned, reached, arrived } from "../state/gameObjects";
import { BLUEPRINTS, BuildingIcon } from "../blueprints";
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
/**
 * How far an off-screen marker sits in from each edge. Enough for the whole
 * pin, which hangs above its anchor — and a good deal more along the bottom,
 * where the toolbar is and a marker would be hidden behind it.
 */
const EDGE = { top: 48, left: 48, right: 48, bottom: 108 };

/** How far the disc's centre sits above the pin's point, in pixels: 18 of the
 *  30 units of the SVG's height, at 35px tall. */
const DISC = (18 / 30) * 35;

/** How long a pin takes to travel between the edge and its plot — the same
 *  beat its tail takes to turn, set in app.css. */
const TRAVEL_MS = 300;

/** The distinct pin thresholds, ascending: the only zooms at which anything changes. */
const STEPS = [...new Set(Object.values(BLUEPRINTS).map((b) => b.pinUntil))].sort((a, b) => a - b);

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
 * Pins over the map: one per building, saying what it is, and one per
 * one no road reaches, asking. HTML, positioned each frame by projecting the world
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

      // A building no road reaches is asking for one, and you cannot answer
      // what you cannot see — so one that has drifted off the map is pinned
      // to the edge instead, pointing at where it actually is: down the line
      // from the middle of the view to it, as far as the inset border allows
      // in whichever direction runs out first. Placed by its disc rather
      // than its point, since the point swings round to face the building
      // and the disc is what stays put.
      const edge = !reached(e) && off;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const [dx, dy] = [sx - cx, sy - cy];
      const limX = rect.width / 2 - (dx > 0 ? EDGE.right : EDGE.left);
      const limY = rect.height / 2 - (dy > 0 ? EDGE.bottom : EDGE.top);
      const t = Math.min(
        Math.abs(dx) < 1e-3 ? Infinity : limX / Math.abs(dx),
        Math.abs(dy) < 1e-3 ? Infinity : limY / Math.abs(dy),
      );
      const ex = cx + dx * t;
      const ey = cy + dy * t + DISC;

      // Going between the edge and the plot, the pin travels rather than
      // jumps, over the same beat its tail takes to turn, so the two read as
      // one motion.
      const was = el.dataset.edge === "1";
      if (was !== edge) {
        el.dataset.edge = edge ? "1" : "0";
        el.dataset.since = el.dataset.edge !== undefined ? String(now) : "0";
      }
      let [x, y] = edge ? [ex, ey] : [sx, sy];
      const k = (now - Number(el.dataset.since ?? 0)) / TRAVEL_MS;
      if (k < 1) {
        const [fx, fy] = edge ? [sx, sy] : [ex, ey];
        const s = k * k * (3 - 2 * k);
        x = fx + (x - fx) * s;
        y = fy + (y - fy) * s;
      }
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.classList.toggle("offscreen", edge);
      // The tail is drawn pointing down, so turning it to face the building
      // is a quarter turn back from the bearing, not forward.
      el.style.setProperty("--aim", edge ? `${Math.atan2(dy, dx) - Math.PI / 2}rad` : "0rad");
      el.style.display = off && !edge && k >= 1 ? "none" : "";
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
              classList={{ dormant: dormant(), collapsed: dot(), arrived: arrived(e.id) }}
              style={{ display: "none" }}
            >
              {/* Both shapes are always here, one of them faded out, so going
                  between them is a transition rather than a cut. The pin
                  shrinks into its own point; the dot grows from it. */}
              <div class="marker relative">
                <div class="body">
                {/* The tail is its own square box centred on the disc, so
                    turning it is turning about the disc: down when the pin
                    sits on its plot, toward the building when it is pinned
                    to the edge. The shadow is a second outline a pixel down,
                    not a filter: a filter is repainted per pin per frame,
                    and a city has hundreds of pins. */}
                <svg class="tail" viewBox="-19 -19 38 38">
                  <path d={OUTLINE} fill="rgba(0,0,0,0.3)" transform="translate(0.4 1.2)" />
                  <path d={OUTLINE} fill="#fff" stroke={dormant() ? "#D9483B" : "none"} stroke-width="1.5" />
                </svg>
                <svg class="head" viewBox="-11 -11 22 30">
                  {/* The disc nearly fills the head: the white is a rim on the
                      colour, not a field it floats in. */}
                  <circle r="7.8" fill={BLUEPRINTS[kind()].color} />
                  <BuildingIcon kind={kind()} class="glyph text-white" x="-6.5" y="-6.5" width="13" height="13" />
                </svg>
                </div>
                <span class="dot" style={{ "background-color": BLUEPRINTS[kind()].color }} />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
