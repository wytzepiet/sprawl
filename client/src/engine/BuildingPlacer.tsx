import { createMemo, createSignal, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor, SLAB } from "./objects/buildings";
import { buildRoadGeometry, BORDER_HALF_W, BORDER_Z, HALF_W, ROAD_Z } from "./objects/roadGeometry";
import { frameOf, markingGeometry, runSlabGeometry, yardGeometry } from "./objects/lots";
import { BLUEPRINTS, FACINGS, plot } from "../blueprints";
import { screenToWorld } from "./view";
import { createSpring2D } from "./spring";
import type { BuildingKind, GridCoord } from "../generated";

const GHOST_COLOR = new Color3(0.6, 0.8, 1.0);
const GHOST_LOT = new Color3(0.82, 0.9, 1.0);
const GHOST_MARK = new Color3(0.55, 0.7, 0.9);
const REFUSED = new Color3(0.95, 0.45, 0.4);
const REFUSED_LOT = new Color3(1.0, 0.8, 0.78);
const REFUSED_MARK = new Color3(0.9, 0.55, 0.5);
/** How far the pointer moves, in tiles, before the server is asked again. */
const ASK_STEP = 0.5;

/**
 * Where a plot would land, as the server says: its origin tile, which way
 * it faces, whether it can land at all, and the driveway it would get.
 */
interface Site {
  pos: GridCoord;
  facing: number;
  fits: boolean;
  door: GridCoord | null;
  street: GridCoord | null;
}

/**
 * The ghost of the building being dragged in: the plot as it would land,
 * building, lot and driveway, turned to face the street beside the pointer.
 * The server is asked, with the rules it will place by — straight-on
 * streets, diagonals at a corner, nothing too sharp to drive — so what is
 * shown is what is placed. Red where nothing fits, and it follows anyway.
 */
export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();
  const [site, setSite] = createSignal<Site | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });
  const kind = (): BuildingKind => placingBuilding() ?? "House";

  let asked: [number, number] | null = null;
  let latest = 0;
  const ask = async (wx: number, wy: number) => {
    const placing = placingBuilding();
    if (!placing) return;
    const key: [number, number] = [Math.round(wx / ASK_STEP), Math.round(wy / ASK_STEP)];
    if (asked && asked[0] === key[0] && asked[1] === key[1]) return;
    asked = key;
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
    const { wx, wy } = screenToWorld(scene, canvas, e);
    void ask(wx, wy);
  };

  const onPointerUp = () => {
    const placing = placingBuilding();
    if (!placing) return;
    const s = site();
    if (s?.fits) send({ type: "PlaceBuilding", data: { pos: s.pos, kind: placing } });
    setPlacingBuilding(null);
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
  // The driveway as the road builder would draw it: a stub at the door
  // reaching for the street, and the street's new arm reaching back —
  // straight or on the diagonal, wherever the server found one. Built in
  // the plot's frame, so it rides the spring with the rest.
  const drive = createMemo(() => {
    const s = site();
    if (!s?.door || !s.street) return null;
    const [mx, my] = middle();
    const a = { x: s.door.x + 0.5 - s.pos.x - mx, y: s.door.y + 0.5 - s.pos.y - my };
    const b = { x: s.street.x + 0.5 - s.pos.x - mx, y: s.street.y + 0.5 - s.pos.y - my };
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const norm = (t: number) => (t < 0 ? t + 2 * Math.PI : t);
    const stub = (from: { x: number; y: number }, at: number, hw: number, z: number) => {
      const g = buildRoadGeometry([{ angle: norm(at), flow: "twoway" }], hw, z);
      if (!g) return null;
      const positions = g.positions.slice();
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] += from.x;
        positions[i + 1] += from.y;
      }
      return { ...g, positions };
    };
    const parts = [stub(a, angle, BORDER_HALF_W, BORDER_Z), stub(a, angle, HALF_W, ROAD_Z), stub(b, angle + Math.PI, BORDER_HALF_W, BORDER_Z), stub(b, angle + Math.PI, HALF_W, ROAD_Z)];
    const positions: number[] = [], indices: number[] = [], normals: number[] = [];
    for (const p of parts) {
      if (!p) continue;
      const base = positions.length / 3;
      positions.push(...p.positions);
      normals.push(...p.normals);
      indices.push(...p.indices.map((i) => i + base));
    }
    return { positions, indices, normals };
  });
  const driveAt = () => [spring.pos()[0], spring.pos()[1], 0.01] as [number, number, number];
  const shown = () => !!(placingBuilding() && site());
  const ok = () => site()?.fits ?? true;

  return (
    <>
      <Mesh name="building_ghost" geometry={buildingGeo()} position={buildingPos()} color={ok() ? GHOST_COLOR : REFUSED} enabled={shown()} />
      <Mesh
        name="lot_ghost"
        geometry={lot() ? runSlabGeometry(lot()!.w, lot()!.depth, false) : runSlabGeometry(1, 1, false)}
        position={lot() ? lotAt(SLAB.z) : [0, 0, -10]}
        rotation={[0, 0, lot()?.rot ?? 0]}
        color={ok() ? GHOST_LOT : REFUSED_LOT}
        enabled={shown() && !!lot()}
      />
      <Mesh
        name="lot_ghost_marks"
        geometry={lot() ? (BLUEPRINTS[kind()].yard ? yardGeometry(lot()!.w, lot()!.ld) : markingGeometry(lot()!.w)) : markingGeometry(1)}
        position={lot() ? lotAt(0) : [0, 0, -10]}
        rotation={[0, 0, lot()?.rot ?? 0]}
        color={ok() ? GHOST_MARK : REFUSED_MARK}
        enabled={shown() && !!lot()}
      />
      <Mesh name="drive_ghost" geometry={drive() ?? { positions: [], indices: [], normals: [] }} position={drive() ? driveAt() : [0, 0, -10]} color={GHOST_LOT} enabled={shown() && !!drive()} />
    </>
  );
}
