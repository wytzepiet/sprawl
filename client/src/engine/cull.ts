import { setMeshVisible, type Mesh, type SceneContext } from "@babylonjs/lite";
import { groundCover } from "./view";

/** A box on the map: low x, low y, high x, high y, in tiles. */
export type Area = readonly [number, number, number, number];

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

  constructor(
    private scene: SceneContext,
    private canvas: HTMLCanvasElement,
  ) {}

  /** A mesh drawn while its area is in view (and while wanted). */
  keep(mesh: Mesh, area: Area) {
    const shown = this.meets(area);
    this.kept.set(mesh, { area, wanted: true, shown });
    if (!shown) setMeshVisible(mesh, false);
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
    this.apply(mesh, k);
  }

  /** The view as it stands: before each frame. */
  update() {
    if (!this.scene.camera) return;
    const { cx, cy, radius } = groundCover(this.scene, this.canvas);
    this.view = [cx - radius, cy - radius, cx + radius, cy + radius];
    for (const [mesh, k] of this.kept) this.apply(mesh, k);
  }

  private apply(mesh: Mesh, k: { area: Area; wanted: boolean; shown: boolean }) {
    const shown = k.wanted && this.meets(k.area);
    if (shown === k.shown) return;
    k.shown = shown;
    setMeshVisible(mesh, shown);
  }

  private meets([x0, y0, x1, y1]: Area) {
    const [v0, w0, v1, w1] = this.view;
    return x1 >= v0 && x0 <= v1 && y1 >= w0 && y0 <= w1;
  }
}
