import { createMemo, createSignal, onCleanup } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import Mesh from "./Mesh";
import { useGame } from "../state/gameObjects";
import { placingBuilding, setPlacingBuilding } from "../ui/buildMode";
import { shapeFor, SLAB } from "./objects/buildings";
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

/** Where a plot would land: its origin tile, which way it faces, and
 *  whether it can land there at all. */
interface Site {
  cell: GridCoord;
  facing: number;
  fits: boolean;
}

/**
 * The ghost of the building being dragged in: the plot as it would land,
 * building and lot, turned to face the street beside the pointer. The
 * server decides the same way — first facing that fits and fronts a street,
 * south if none does — so what is shown is what is placed.
 */
export function BuildingPlacer() {
  const { scene, canvas } = useEngine();
  const { send, getObjectsAt } = useGame();
  const [site, setSite] = createSignal<Site | null>(null);
  const spring = createSpring2D(scene, { stiffness: 0.3, damping: 0.4 });
  const kind = (): BuildingKind => placingBuilding() ?? "House";

  const road = (x: number, y: number) => {
    const e = getObjectsAt(x, y).find((o) => o.object.kind === "RoadNode");
    return e ? (e.object.data as { road: boolean; outgoing: number[]; incoming: number[] }) : undefined;
  };

  /**
   * Every tile of the footprint free, or holding only a driveway stub. A
   * street beside it is not required: a plot with none stands red until
   * the mayor draws one to it.
   */
  function fits(cell: GridCoord, facing: number): boolean {
    const [w, h] = plot(kind(), facing).size;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        for (const entry of getObjectsAt(cell.x + dx, cell.y + dy)) {
          if (entry.object.kind === "Building") return false;
          if (entry.object.kind === "RoadNode") {
            const { outgoing, incoming } = entry.object.data;
            if (new Set([...outgoing, ...incoming]).size !== 1) return false;
          }
        }
      }
    }
    return true;
  }

  /** A street right in front of the plot's front row: the lot's, or the
   *  building's where there is no lot. */
  function fronts(cell: GridCoord, facing: number): boolean {
    const lie = plot(kind(), facing);
    const [dx, dy] = FACINGS[facing % 4];
    const [[fx, fy], [fw, fh]] = lie.lot ?? lie.building;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const tx = cell.x + fx + x + dx, ty = cell.y + fy + y + dy;
        const inside = tx >= cell.x && tx < cell.x + lie.size[0] && ty >= cell.y && ty < cell.y + lie.size[1];
        const r = road(tx, ty);
        if (!inside && r && !r.road) return true;
      }
    }
    return false;
  }

  /** The plot whose building is under the pointer — the building is the
   *  thing held; its lot swings round it. Turned the first way that fits
   *  and fronts a street; failing that, the first way that fits at all;
   *  failing that, facing south, and refused. */
  function siteAt(wx: number, wy: number): Site {
    const at = (facing: number): GridCoord => {
      const [[bx, by], [bw, bh]] = plot(kind(), facing).building;
      return { x: Math.floor(wx - bx - bw / 2 + 0.5), y: Math.floor(wy - by - bh / 2 + 0.5) };
    };
    for (const facing of [0, 1, 2, 3]) {
      const cell = at(facing);
      if (fits(cell, facing) && fronts(cell, facing)) return { cell, facing, fits: true };
    }
    for (const facing of [0, 1, 2, 3]) {
      const cell = at(facing);
      if (fits(cell, facing)) return { cell, facing, fits: true };
    }
    return { cell: at(2), facing: 2, fits: false };
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!placingBuilding()) return;
    const { wx, wy } = screenToWorld(scene, canvas, e);
    const found = siteAt(wx, wy);
    const [[bx, by], [bw, bh]] = plot(kind(), found.facing).building;
    const centre: [number, number] = [found.cell.x + bx + bw / 2, found.cell.y + by + bh / 2];
    if (!site()) {
      spring.snap(...centre);
    } else {
      spring.setTarget(...centre);
    }
    setSite(found);
  };

  const onPointerUp = () => {
    const placing = placingBuilding();
    if (!placing) return;
    const s = site();
    if (s?.fits) send({ type: "PlaceBuilding", data: { pos: s.cell, kind: placing } });
    setPlacingBuilding(null);
    setSite(null);
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
  const buildingAt = () => [spring.pos()[0], spring.pos()[1], 0] as [number, number, number];
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
  const shown = () => !!(placingBuilding() && site());
  const ok = () => site()?.fits ?? true;

  return (
    <>
      <Mesh name="building_ghost" geometry={buildingGeo()} position={buildingAt()} color={ok() ? GHOST_COLOR : REFUSED} enabled={shown()} />
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
    </>
  );
}
