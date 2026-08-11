import { onCleanup } from "solid-js";
import { Color3, Mesh, StandardMaterial, VertexData } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { pickWorld } from "./pickWorld";
import { useGame } from "../state/gameObjects";
import { activeTool, paintCategory } from "../ui/buildMode";
import { CATEGORY_COLOR } from "./objects/buildings";
import type { GridCoord } from "../generated";

/** Above the terrain and its zone lines, below the fog. */
const PREVIEW_Z = 0.05;
const PREVIEW_ALPHA = 0.35;

/**
 * The build brush: drag a rectangle, get buildings.
 *
 * The rectangle is only a wish — the server lays out whatever plots actually
 * fit and leaves the rest, so the preview promises coverage rather than a
 * particular set of houses.
 */
export function ZoneDrawer() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();

  let anchor: GridCoord | null = null;
  let cursor: GridCoord | null = null;

  const material = new StandardMaterial("zonePreview", scene);
  material.disableLighting = true;
  material.specularColor = Color3.Black();
  material.alpha = PREVIEW_ALPHA;
  material.backFaceCulling = false;
  material.disableDepthWrite = true;

  const mesh = new Mesh("zonePreview", scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.renderingGroupId = 1;
  mesh.setEnabled(false);

  const pick = (e: { clientX: number; clientY: number }): GridCoord => {
    const { wx, wy } = pickWorld(scene, canvas, e);
    return { x: Math.floor(wx), y: Math.floor(wy) };
  };

  /** Every tile in the rectangle the drag spans, inclusive of both corners. */
  function selection(): GridCoord[] {
    if (!anchor || !cursor) return [];
    const tiles: GridCoord[] = [];
    for (let y = Math.min(anchor.y, cursor.y); y <= Math.max(anchor.y, cursor.y); y++) {
      for (let x = Math.min(anchor.x, cursor.x); x <= Math.max(anchor.x, cursor.x); x++) {
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  /** One quad, so the whole selection is a single draw however large it gets. */
  function redraw() {
    if (!anchor || !cursor) {
      mesh.setEnabled(false);
      return;
    }
    const x0 = Math.min(anchor.x, cursor.x);
    const y0 = Math.min(anchor.y, cursor.y);
    const x1 = Math.max(anchor.x, cursor.x) + 1;
    const y1 = Math.max(anchor.y, cursor.y) + 1;

    const data = new VertexData();
    data.positions = [x0, y0, PREVIEW_Z, x1, y0, PREVIEW_Z, x1, y1, PREVIEW_Z, x0, y1, PREVIEW_Z];
    data.indices = [0, 2, 1, 0, 3, 2];
    data.applyToMesh(mesh, true);

    material.emissiveColor = Color3.FromHexString(CATEGORY_COLOR[paintCategory()]);
    mesh.setEnabled(true);
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (activeTool() !== "zone") return;
    anchor = pick(e);
    cursor = anchor;
    redraw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!anchor) return;
    const cell = pick(e);
    if (cell.x === cursor!.x && cell.y === cursor!.y) return;
    cursor = cell;
    redraw();
  };

  const onPointerUp = () => {
    if (!anchor) return;
    const tiles = selection();
    anchor = null;
    cursor = null;
    redraw();
    if (tiles.length) send({ type: "PaintArea", data: { tiles, category: paintCategory() } });
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    mesh.dispose();
    material.dispose();
  });

  return <></>;
}
