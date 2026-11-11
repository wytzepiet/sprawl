import { setMeshVisible, type Mesh, type SceneContext } from "./gpu";
import { MARGIN } from "./still";
import { groundCover } from "./view";

/** Hidden; with its area, only for being out of view, where our renderer
 *  has it cast its shadow still (`render/mesh.ts`; Lite's takes no area). */
const hide = (mesh: Mesh, reach: Area | null) => (setMeshVisible as (mesh: Mesh, visible: boolean, reach: Area | null) => void)(mesh, false, VIEW_CAST ? null : reach);
/** `?viewcast`, a trial's: only what is in view casts, as before, to measure against on one device. */
const VIEW_CAST = new URLSearchParams(globalThis.location?.search ?? "").has("viewcast");

/** A box on the map: low x, low y, high x, high y, in tiles. */
export type Area = readonly [number, number, number, number];

/** How far past the ground on screen a vehicle may stand and still show
 *  on it, in tiles: past its headlights' reach (`lights.ts`) and a ferry's
 *  half length, and well past how far one comes between its looks while
 *  it is out of it (`CarObject.tsx`). */
const NEAR = 3;

/**
 * What is drawn of the world: only what lies on the ground in view. Lite
 * culls nothing itself, so every chunk loaded round the view would be drawn,
 * trees and all, and cast into the shadow map. A chunk's meshes are kept by
 * the area they cover and shown while it meets the square round the ground
 * in view, the square the shadow map covers too (`DayNightCycle.tsx`), so
 * whatever casts into view is still drawn there. Shown or hidden only as the
 * view crosses a chunk's edge, as each change has Lite record its draws again.
 */
export class Culler {
  private kept = new Map<Mesh, { area: Area; wanted: boolean; shown: boolean }>();
  private view: Area = [0, 0, 0, 0];
  /** The ground on screen, and as far round it as something there shows
   *  on it (`sees`). */
  private seen: Area = [0, 0, 0, 0];

  constructor(
    private scene: SceneContext,
    private canvas: HTMLCanvasElement,
  ) {}

  /** A mesh drawn while its area is in view (and while wanted). */
  keep(mesh: Mesh, area: Area) {
    const shown = this.meets(area);
    this.kept.set(mesh, { area, wanted: true, shown });
    if (!shown) hide(mesh, area);
  }

  /** A mesh no longer kept: gone. */
  forget(mesh: Mesh) {
    this.kept.delete(mesh);
  }

  /** Whether a kept mesh is to be drawn at all when in view: detail let go when zoomed out. */
  want(mesh: Mesh, wanted: boolean) {
    const k = this.kept.get(mesh);
    if (!k || k.wanted === wanted) return;
    k.wanted = wanted;
    k.shown = wanted && this.meets(k.area);
    k.shown ? setMeshVisible(mesh, true) : hide(mesh, wanted ? k.area : null);
  }

  /** The view as it stands: before each frame. A mesh is shown or hidden
   *  as it is kept or wanted, so only a view that moved walks them all. */
  update() {
    if (!this.scene.camera) return;
    const { cx, cy, x0, y0, x1, y1, radius: r } = groundCover(this.scene, this.canvas);
    this.seen = [x0 - NEAR, y0 - NEAR, x1 + NEAR, y1 + NEAR];
    // The still town's picture reaches a margin past the screen.
    const radius = r * (1 + 2 * MARGIN);
    const view: Area = [cx - radius, cy - radius, cx + radius, cy + radius];
    if (view.every((v, i) => v === this.view[i])) return;
    this.view = view;
    for (const [mesh, k] of this.kept) this.apply(mesh, k);
  }

  private apply(mesh: Mesh, k: { area: Area; wanted: boolean; shown: boolean }) {
    const shown = k.wanted && this.meets(k.area);
    if (shown === k.shown) return;
    k.shown = shown;
    shown ? setMeshVisible(mesh, true) : hide(mesh, k.wanted ? k.area : null);
  }

  /** Whether a vehicle here shows on screen: on the ground in view, or
   *  near enough to it to light or shade it, or to reach into it. */
  sees(x: number, y: number) {
    const [v0, w0, v1, w1] = this.seen;
    return x >= v0 && x <= v1 && y >= w0 && y <= w1;
  }

  private meets([x0, y0, x1, y1]: Area) {
    const [v0, w0, v1, w1] = this.view;
    return x1 >= v0 && x0 <= v1 && y1 >= w0 && y0 <= w1;
  }
}
