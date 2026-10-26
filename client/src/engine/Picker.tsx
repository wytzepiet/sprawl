import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { screenToWorld } from "./view";
import { inHand } from "../ui/buildMode";
import { buildingAt, useGame } from "../state/gameObjects";
import { mayorsLorry, packageAt, takes } from "../state/haul";
import { LOAD } from "../generated/rows";
import { carNear, goodsOf, select, selected, setHovered } from "../state/selection";
import { ghost } from "../state/guide";
import { take } from "../ui/Roads";

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
 * While you have a lorry, a pile of goods on a pad is picked as well;
 * with one picked, a tap on a building that takes it sends your lorry
 * with it there (`haul::send`), and picks the lorry, to follow it.
 *
 * A tap on the guide's ghost places it there; on it or its dashes while
 * it waits for its street, takes up the street to draw.
 */
export function Picker() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();
  let down: { x: number; y: number; t: number } | null = null;

  /** What is under a pointer: a car first, then a pile of goods your
   *  lorry could fetch, then the plot the tile belongs to. */
  const under = (e: PointerEvent): number | null => {
    const w = screenToWorld(scene, canvas, e);
    return carNear(w.wx, w.wy, CAR_REACH) ?? (mayorsLorry() ? packageAt(w.wx, w.wy) : null) ?? buildingAt(Math.floor(w.wx), Math.floor(w.wy))?.id ?? null;
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
    const g = ghost();
    const w = screenToWorld(scene, canvas, e);
    const tile = (t: { x: number; y: number }) => t.x === Math.floor(w.wx) && t.y === Math.floor(w.wy);
    if (g && (g.tiles.some(tile) || g.road.some(tile))) {
      if (g.road.length) return take("Street");
      return void send({ type: "Place", data: { kind: g.kind, at: g.at, facing: g.facing } });
    }
    const id = under(e);
    const pile = goodsOf(selected());
    const lorry = mayorsLorry();
    if (pile && lorry && id !== null && id !== pile.at && takes(id, pile.good)) {
      send({ type: "Haul", data: { from: pile.at, good: pile.good, packages: LOAD, to: id } });
      return select(lorry.id);
    }
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
