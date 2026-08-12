import { onCleanup } from "solid-js";
import { Color3, Mesh, StandardMaterial, VertexData } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { pickWorld } from "./pickWorld";
import { useGame } from "../state/gameObjects";
import { buildMode, paintCategory } from "../ui/buildMode";
import { CATEGORY_COLOR } from "./objects/buildings";
import type { GridCoord } from "../generated";

/** Above the terrain and its zone lines, below the fog. */
const PREVIEW_Z = 0.05;
const PREVIEW_ALPHA = 0.35;
/** How often a growing stroke is re-laid. Below noticing, well above per-tile. */
const RELAYOUT_MS = 120;

/**
 * The build brush: paint tiles, get buildings.
 *
 * The stroke is only a wish — the server lays out whatever plots actually fit
 * and leaves the rest, so the brush promises coverage rather than a particular
 * set of houses. It is laid out as one piece and re-laid as it grows, so plots
 * merge and split under the cursor rather than settling on release.
 */
export function ZoneDrawer() {
  const { scene, canvas } = useEngine();
  const { send } = useGame();

  /** Tiles painted since pointerdown, keyed to dedupe a wandering cursor. */
  const painted = new Map<string, GridCoord>();
  let last: GridCoord | null = null;
  let lastSent = 0;

  /**
   * Send the whole stroke so far, not the tiles just added.
   *
   * The server replaces the drafts of yours that a stroke covers, so re-sending
   * the accumulated set re-lays the lot — which is what lets a lone house be
   * torn up and laid again as half an apartment as the stroke widens. Sending
   * only the new tiles would leave the earlier plots standing in the way.
   */
  function sendStroke() {
    lastSent = performance.now();
    send({ type: "PaintArea", data: { tiles: [...painted.values()], category: paintCategory() } });
  }

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

  function add(tile: GridCoord) {
    painted.set(`${tile.x},${tile.y}`, tile);
  }

  /**
   * Paint every tile between where the brush was and where it now is. A pointer
   * event lands wherever the mouse got to, which on a fast drag is several
   * tiles on, so walking the line is what makes the stroke continuous rather
   * than a row of dots.
   */
  function paintTo(tile: GridCoord) {
    const dx = tile.x - last!.x;
    const dy = tile.y - last!.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let i = 1; i <= steps; i++) {
      add({
        x: last!.x + Math.round((dx * i) / steps),
        y: last!.y + Math.round((dy * i) / steps),
      });
    }
    last = tile;
  }

  /** One quad per painted tile, rebuilt only when the set actually grows. */
  function redraw() {
    if (painted.size === 0) {
      mesh.setEnabled(false);
      return;
    }
    const positions: number[] = [];
    const indices: number[] = [];
    for (const t of painted.values()) {
      const b = positions.length / 3;
      positions.push(
        t.x, t.y, PREVIEW_Z,
        t.x + 1, t.y, PREVIEW_Z,
        t.x + 1, t.y + 1, PREVIEW_Z,
        t.x, t.y + 1, PREVIEW_Z,
      );
      indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.applyToMesh(mesh, true);

    material.emissiveColor = Color3.FromHexString(CATEGORY_COLOR[paintCategory()]);
    mesh.setEnabled(true);
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (buildMode() !== "zone") return;
    last = pick(e);
    add(last);
    redraw();
    sendStroke();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!last) return;
    const before = painted.size;
    // The browser merges every sample it took since the last frame into one
    // event. Walking them keeps a curved stroke on the path the mouse took
    // rather than the chord across it.
    const merged = e.getCoalescedEvents?.() ?? [];
    for (const ce of merged.length ? merged : [e]) paintTo(pick(ce));
    if (painted.size === before) return;
    redraw();
    // Re-laying the stroke means dropping and rebuilding every plot in it, so
    // this is throttled rather than run per tile: a wide area would otherwise
    // put hundreds of deletes and upserts on the wire several times a second.
    if (performance.now() - lastSent >= RELAYOUT_MS) sendStroke();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!last) return;
    // A flick releases the button past the last pointermove, so without this
    // the tail of every fast stroke is lost.
    paintTo(pick(e));
    sendStroke();
    painted.clear();
    last = null;
    redraw();
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
