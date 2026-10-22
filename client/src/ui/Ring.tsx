/** @jsxImportSource ~ui */
import { createSignal, onCleanup, Show } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { screenToWorld } from "../engine/view";
import { buildingAt, useGame } from "../state/gameObjects";
import { select } from "../state/selection";
import { inHand } from "./buildMode";
import { DEMOLISH } from "./Roads";
import { BAD, Pop, Press } from "./kit";

/** How long a press on a building is held before its ring opens, and how
 *  far the finger may wander meanwhile. */
const LONG_MS = 500;
const STILL_PX = 8;

/**
 * A building's ring: a long press on it with the bare hand, or a right
 * click, opens two buttons round the pointer, its card and taking it
 * down: built lately, it gives back what it cost. Any other press
 * closes it.
 */
export default function Ring() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();
  const [ring, setRing] = createSignal<{ id: number; x: number; y: number } | null>(null);
  let down: { x: number; y: number; timer: number } | null = null;

  const open = (p: { clientX: number; clientY: number }) => {
    if (inHand()) return;
    const w = screenToWorld(scene, canvas, p);
    const b = buildingAt(Math.floor(w.wx), Math.floor(w.wy));
    if (b) setRing({ id: b.id, x: p.clientX, y: p.clientY });
  };
  const still = (e: PointerEvent) => !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= STILL_PX;
  const onDown = (e: PointerEvent) => {
    setRing(null);
    clearTimeout(down?.timer);
    const p = { clientX: e.clientX, clientY: e.clientY };
    down = { x: e.clientX, y: e.clientY, timer: e.button === 0 ? window.setTimeout(() => open(p), LONG_MS) : 0 };
  };
  const onMove = (e: PointerEvent) => down && !still(e) && clearTimeout(down.timer);
  const onUp = () => clearTimeout(down?.timer);
  // A right click that did not pan.
  const onMenu = (e: MouseEvent) => (!down || still(e as PointerEvent)) && open(e);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("contextmenu", onMenu);
  onCleanup(() => {
    clearTimeout(down?.timer);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("contextmenu", onMenu);
  });

  return (
    <Show when={ring()} keyed>
      {(r) => (
        <>
          <Pop at={{ left: r.x - 64, top: r.y - 80 }} w={52} h={52}>
            <glass layer="ring" w={52} h={52} round={26} align="center" justify="center">
              <Press w={52} h={52} round={26} align="center" justify="center" onTap={() => (setRing(null), select(r.id))}>
                <text serif size={24}>i</text>
              </Press>
            </glass>
          </Pop>
          <Pop at={{ left: r.x + 12, top: r.y - 80 }} w={52} h={52}>
            <glass layer="ring" dye={BAD} w={52} h={52} round={26} align="center" justify="center">
              <Press w={52} h={52} round={26} align="center" justify="center" onTap={() => (setRing(null), send({ type: "Raze", data: { building: r.id } }))}>
                <icon d={DEMOLISH} size={22} ink="white" />
              </Press>
            </glass>
          </Pop>
        </>
      )}
    </Show>
  );
}
