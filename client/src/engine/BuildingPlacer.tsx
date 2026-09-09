import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { preview, useGame } from "../state/gameObjects";
import { overCancel, placingBuilding, setOverCancel, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor } from "./objects/buildings";
import { frameOf, markingGeometry, runSlabGeometry, yardGeometry } from "./objects/lots";
import { BLUEPRINTS, FACINGS, plot } from "../blueprints";
import { screenToWorld } from "./view";
import { createSpring2D } from "./spring";
import type { BuildingKind, GameObjectEntry, Operation, Site } from "../generated";

/** The ghost door node's id: no real thing has it. */
const DOOR = -1;

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);
const GHOST_LOT = new Color3(0.82, 0.9, 1.0);
const GHOST_MARK = new Color3(0.55, 0.7, 0.9);
const REFUSED = new Color3(0.95, 0.45, 0.4);
const REFUSED_LOT = new Color3(1.0, 0.8, 0.78);
const REFUSED_MARK = new Color3(0.9, 0.55, 0.5);
/** The ghost's lot floats above any road it is dragged across, so it is
 *  never seen underneath one. */
const GHOST_Z = 0.05;
/** How far the pointer moves, in tiles, before the server is asked again. */
const ASK_STEP = 0.5;

/**
 * The ghost of the building being dragged in: the plot as it would land,
 * building, lot and driveway, turned to face the street beside the pointer.
 * The server is asked, with the rules it will place by — straight-on
 * streets, diagonals at a corner, nothing too sharp to drive — so what is
 * shown is what is placed. Red where nothing fits, and it follows anyway.
 */
export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [site, setSite] = createSignal<Site | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });
  const kind = (): BuildingKind => placingBuilding() ?? "House";

  let asked: [number, number] | null = null;
  /** The point the building is held over: what placing sends, so the
   *  server decides the site the same way it did for the ghost. */
  let held: [number, number] = [0, 0];
  let latest = 0;
  const ask = async (wx: number, wy: number) => {
    const placing = placingBuilding();
    if (!placing) return;
    const key: [number, number] = [Math.round(wx / ASK_STEP), Math.round(wy / ASK_STEP)];
    if (asked && asked[0] === key[0] && asked[1] === key[1]) return;
    asked = key;
    held = [wx, wy];
    const n = ++latest;
    const r = await fetch(`/site/${placing}?x=${wx}&y=${wy}`);
    const found = (await r.json()) as Site;
    // A slower answer to an older question is not the answer.
    if (n !== latest || placingBuilding() !== placing) return;
    const [[bx, by], [bw, bh]] = plot(placing, found.facing).building;
    const centre: [number, number] = [found.pos.x + bx + bw / 2, found.pos.y + by + bh / 2];
    if (!site()) spring.snap(...centre);
    else spring.setTarget(...centre);
    setSite(found);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!placingBuilding()) return;
    // Over the cancel zone the ghost is gone: what you are holding is
    // about to be put back.
    if (overCancel()) {
      clearDrive(false);
      undo = [];
      setSite(null);
      asked = null;
      return;
    }
    const { wx, wy } = screenToWorld(scene, canvas, e);
    void ask(wx, wy);
  };

  const onPointerUp = () => {
    const placing = placingBuilding();
    if (!placing) return;
    const s = site();
    const placed = !!s?.fits && !overCancel();
    if (s && placed) send({ type: "PlaceBuilding", data: { at: held, kind: placing } });
    // Placed: the street keeps its new arm until the server's own version
    // of it arrives. Dropped: everything goes back.
    clearDrive(placed);
    undo = [];
    setPlacingBuilding(null);
    setOverCancel(false);
    setSite(null);
    asked = null;
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  });

  // Everything is laid out from the building's middle, which is what the
  // spring carries, so the building glides and the lot rides with it.
  const facing = () => site()?.facing ?? 2;
  const lie = createMemo(() => plot(kind(), facing()));
  const middle = () => {
    const [[bx, by], [bw, bh]] = lie().building;
    return [bx + bw / 2, by + bh / 2] as const;
  };
  const buildingGeo = createMemo(() => shapeFor(kind(), ...lie().building[1]));
  const buildingPos = () => [spring.pos()[0], spring.pos()[1], 0] as [number, number, number];
  // The lot in its own frame, turned into place: along the frontage it is
  // the lot's width, in from the street the whole plot's depth.
  const lot = createMemo(() => {
    const l = lie().lot;
    if (!l) return null;
    const [[lx, ly], [lw, ld]] = l;
    const alongX = FACINGS[facing() % 4][0] === 0;
    const w = alongX ? lw : ld;
    const depth = alongX ? lie().size[1] : lie().size[0];
    const { rot, origin } = frameOf(facing(), { x: lx, y: ly, w: lw, h: ld });
    return { w, depth, ld: alongX ? ld : lw, rot, origin };
  });
  const lotAt = (z: number) => {
    const l = lot()!;
    const [mx, my] = middle();
    return [spring.pos()[0] + l.origin[0] - mx, spring.pos()[1] + l.origin[1] - my, z] as [number, number, number];
  };
  // The driveway is a real road for the moment it would exist: a door node
  // on the door tile and the street's node with one more arm, put through
  // the store the way the server's ops are, so the street bends, its
  // neighbours redraw and the dead end loses its cap exactly as if the
  // road were laid. A two-way link is each node naming the other as
  // outgoing — incoming is for one-way streets, and a link named both ways
  // is drawn as one, chevrons and all. Taken back when the site moves or
  // the drag is dropped; when it is placed, the real nodes from the server
  // replace the street, and only the stand-in door has to go.
  let undo: Operation[] = [];
  const clearDrive = (placed: boolean) => {
    if (undo.length) preview(placed ? undo.filter((o) => o.op === "Delete") : undo);
    undo = [];
  };
  createEffect(on(site, (s) => {
    clearDrive(false);
    if (!s?.door || !s.street) return;
    const street = getObjectsAt(s.street.x, s.street.y).find((e) => e.object.kind === "RoadNode");
    if (!street || street.object.kind !== "RoadNode") return;
    const arms = street.object.data;
    const door: GameObjectEntry = {
      id: DOOR,
      position: { x: s.door.x, y: s.door.y },
      object: { kind: "RoadNode", data: { outgoing: [street.id], incoming: [], joined: arms.joined, road: false, laid: false } },
    };
    const joined: GameObjectEntry = {
      ...street,
      object: { kind: "RoadNode", data: { ...arms, outgoing: [...arms.outgoing, DOOR] } },
    };
    undo = [{ op: "Delete", data: DOOR }, { op: "Upsert", data: street }];
    preview([{ op: "Upsert", data: door }, { op: "Upsert", data: joined }]);
  }));
  onCleanup(() => clearDrive(false));

  const shown = () => !!(placingBuilding() && site());
  const ok = () => site()?.fits ?? true;

  return (
    <>
      <Mesh name="building_ghost" geometry={buildingGeo()} position={buildingPos()} color={ok() ? GHOST_COLOR : REFUSED} enabled={shown()} />
      <Mesh
        name="lot_ghost"
        geometry={lot() ? runSlabGeometry(lot()!.w, lot()!.depth, false) : runSlabGeometry(1, 1, false)}
        position={lot() ? lotAt(GHOST_Z) : [0, 0, -10]}
        rotation={[0, 0, lot()?.rot ?? 0]}
        color={ok() ? GHOST_LOT : REFUSED_LOT}
        enabled={shown() && !!lot()}
      />
      <Mesh
        name="lot_ghost_marks"
        geometry={lot() ? (BLUEPRINTS[kind()].yard ? yardGeometry(lot()!.w, lot()!.ld) : markingGeometry(lot()!.w)) : markingGeometry(1)}
        position={lot() ? lotAt(GHOST_Z + 0.005) : [0, 0, -10]}
        rotation={[0, 0, lot()?.rot ?? 0]}
        color={ok() ? GHOST_MARK : REFUSED_MARK}
        enabled={shown() && !!lot()}
      />
    </>
  );
}
