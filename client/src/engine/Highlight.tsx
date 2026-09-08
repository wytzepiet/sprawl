import { onCleanup } from "solid-js";
import { Color3, MeshBuilder, StandardMaterial, Vector3, type Mesh } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { getEntity } from "../state/gameObjects";
import { carPoses, hovered, selected } from "../state/selection";
import type { Building } from "../generated";

const TINT = new Color3(0.36, 0.34, 0.78);
/** How thick the frame around a plot is, in tiles. */
const EDGE = 0.08;
const Z = 0.02;

/**
 * A ring under the car, a frame around the plot: faint for what the pointer
 * is over, solid for what was picked. Cars and buildings are thin instances
 * of shared meshes, so nothing can be outlined on its own — a marker placed
 * from the same per-frame position the cars publish is what follows one.
 */
export function Highlight() {
  const { scene } = useEngine();

  const material = (alpha: number) => {
    const m = new StandardMaterial(`highlight_${alpha}`, scene);
    m.emissiveColor = TINT;
    m.disableLighting = true;
    m.alpha = alpha;
    return m;
  };
  /** One marker: a ring for a car, four edges for a plot. */
  const marker = (alpha: number) => {
    const mat = material(alpha);
    const ring = MeshBuilder.CreateTorus("highlight_ring", { diameter: 0.7, thickness: 0.07, tessellation: 32 }, scene);
    ring.rotation.x = Math.PI / 2;
    ring.material = mat;
    const edges: Mesh[] = Array.from({ length: 4 }, (_, i) => {
      const e = MeshBuilder.CreateBox(`highlight_edge_${i}`, { size: 1 }, scene);
      e.material = mat;
      return e;
    });
    const all = [ring, ...edges];
    for (const m of all) {
      m.isPickable = false;
      m.receiveShadows = false;
      m.setEnabled(false);
    }
    const hide = () => all.forEach((m) => m.setEnabled(false));
    const place = (id: number | null) => {
      if (id === null) return hide();
      const car = carPoses.get(id);
      if (car) {
        edges.forEach((e) => e.setEnabled(false));
        ring.setEnabled(true);
        ring.position.set(car[0], car[1], Z);
        return;
      }
      const e = getEntity(id);
      if (e?.object.kind !== "Building" || !e.position) return hide();
      ring.setEnabled(false);
      const [w, h] = (e.object.data as Building).size;
      const { x, y } = e.position;
      const frame: [number, number, number, number][] = [
        [x + w / 2, y, w + EDGE, EDGE],
        [x + w / 2, y + h, w + EDGE, EDGE],
        [x, y + h / 2, EDGE, h + EDGE],
        [x + w, y + h / 2, EDGE, h + EDGE],
      ];
      edges.forEach((edge, i) => {
        const [cx, cy, sx, sy] = frame[i];
        edge.setEnabled(true);
        edge.position.set(cx, cy, Z);
        edge.scaling = new Vector3(sx, sy, 0.02);
      });
    };
    return { place, dispose: () => all.forEach((m) => m.dispose()) };
  };

  const soft = marker(0.35);
  const firm = marker(0.9);
  const obs = scene.onBeforeRenderObservable.add(() => {
    const s = selected();
    const h = hovered();
    firm.place(s);
    soft.place(h !== null && h !== s ? h : null);
  });
  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    soft.dispose();
    firm.dispose();
  });
  return null;
}
