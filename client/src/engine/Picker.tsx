import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { screenToWorld } from "./view";
import { inHand } from "../ui/buildMode";
import { buildingAt, useGame } from "../state/gameObjects";
import { carrying, mayorsLorry, packageAt, setCarrying } from "../state/haul";
import { LOAD } from "../generated/rows";
import { carNear, select, setHovered } from "../state/selection";

/** How far a pointer may travel and still be a tap rather than a pan. */
const TAP_PX = 5;
const TAP_MS = 400;
/** How close to a car's centre a tap has to land, in tiles. */
const CAR_REACH = 0.45;

/**
 * A tap on the map picks what is under it: a car first, since cars are small
 * and sit on plots, then the building whose plot the tile belongs to. A tap on
 * nothing closes the card. Only in select mode; the tools own the pointer
 * otherwise.
 *
 * While you have a lorry, a tap on a package picks it up for it, and so
 * does a tap on the lorry with a load aboard; the next tap on a building
 * sends it there (`haul::send`), and a tap on anything else puts it down.
 */
export function Picker() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();
  let down: { x: number; y: number; t: number } | null = null;

  /** What is under a pointer: a car first, then the plot the tile belongs to. */
  const under = (e: PointerEvent): number | null => {
    const w = screenToWorld(scene, canvas, e);
    return carNear(w.wx, w.wy, CAR_REACH) ?? buildingAt(Math.floor(w.wx), Math.floor(w.wy))?.id ?? null;
  };
  const onPointerMove = (e: PointerEvent) => {
    setHovered(!inHand() && e.buttons === 0 ? under(e) : null);
  };
  const onPointerDown = (e: PointerEvent) => {
    down = e.button === 0 && !inHand() ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const held = performance.now() - down.t;
    down = null;
    if (moved > TAP_PX || held > TAP_MS) return;
    const w = screenToWorld(scene, canvas, e);
    const lorry = mayorsLorry();
    const c = carrying();
    if (c) {
      setCarrying(null);
      const to = buildingAt(Math.floor(w.wx), Math.floor(w.wy))?.id;
      if (to !== undefined && to !== c.from) send({ type: "Haul", data: { from: c.from, good: c.good, packages: LOAD, to } });
      return;
    }
    const picked = lorry && packageAt(w.wx, w.wy);
    if (picked) return setCarrying(picked);
    const id = under(e);
    const aboard = lorry && id === lorry.id ? lorry.car.cargo[0] : undefined;
    if (lorry && aboard) return setCarrying({ from: lorry.id, good: aboard.good, at: [w.wx, w.wy] });
    select(id);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointermove", onPointerMove);
  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointermove", onPointerMove);
  });
  return null;
}
