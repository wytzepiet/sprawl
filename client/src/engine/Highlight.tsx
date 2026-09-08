import { onCleanup } from "solid-js";
import { Color3, Matrix, Mesh, StandardMaterial, VertexData } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { hovered, parts, selected } from "../state/selection";

const TINT = new Color3(0.36, 0.34, 0.78);

/**
 * The thing under the pointer, and the thing picked, traced exactly: a ghost
 * of the very mesh, at the very matrix the pool drew it with, wearing an
 * outline. Cars and buildings are thin instances of shared meshes, which
 * cannot be outlined one at a time; a ghost per bucket, moved onto whichever
 * instance is wanted, can.
 */
export function Highlight() {
  const { scene } = useEngine();
  const pool = useInstancePool();

  const ghosts = new Map<string, Mesh>();
  const material = (alpha: number) => {
    const m = new StandardMaterial(`highlight_${alpha}`, scene);
    m.emissiveColor = TINT;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    m.alpha = alpha;
    // Drawn on top of the instance it traces, not fighting it for depth.
    m.zOffset = -2;
    return m;
  };
  const soft = material(0.25);
  const firm = material(0.45);

  /** The ghost for a bucket, built from its geometry the first time. */
  const ghostFor = (key: string, slot: number): Mesh | null => {
    const name = `${key}#${slot}`;
    let g = ghosts.get(name);
    if (g) return g;
    const geometry = pool.geometryOf(key);
    if (!geometry) return null;
    g = new Mesh(`highlight_${name}`, scene);
    const vd = new VertexData();
    vd.positions = geometry.positions;
    vd.indices = geometry.indices;
    vd.normals = geometry.normals;
    vd.applyToMesh(g);
    g.isPickable = false;
    g.renderOutline = true;
    g.outlineColor = TINT;
    g.outlineWidth = 0.03;
    g.setEnabled(false);
    ghosts.set(name, g);
    return g;
  };

  const _m = new Matrix();
  const shown = new Set<Mesh>();
  const trace = (id: number | null, mat: StandardMaterial, slot: number) => {
    if (id === null) return;
    for (const part of parts.get(id) ?? []) {
      const g = ghostFor(part.key, slot);
      if (!g || !pool.matrixOf(part.key, part.id, _m)) continue;
      g.material = mat;
      g.freezeWorldMatrix(_m.clone());
      g.setEnabled(true);
      shown.add(g);
    }
  };
  const obs = scene.onBeforeRenderObservable.add(() => {
    for (const g of shown) g.setEnabled(false);
    shown.clear();
    const s = selected();
    const h = hovered();
    trace(s, firm, 0);
    if (h !== null && h !== s) trace(h, soft, 1);
  });
  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    for (const g of ghosts.values()) g.dispose();
    soft.dispose();
    firm.dispose();
  });
  return null;
}
