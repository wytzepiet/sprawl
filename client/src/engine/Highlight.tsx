import { onCleanup } from "solid-js";
import { Matrix, Mesh, VertexData } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { createOutline } from "./outline";
import { hovered, parts, subject } from "../state/selection";

/** Ghosts live on a layer the main camera never draws. */
const GHOST_LAYER = 0x10000000;

/**
 * The thing under the pointer, and the thing picked, given the outline.
 * Cars and buildings are thin instances of shared meshes, which cannot be
 * outlined one at a time; so a ghost of the very mesh is moved onto the
 * very matrix the pool drew the instance with, and the outline traces it.
 */
export function Highlight() {
  const { scene, engine } = useEngine();
  const pool = useInstancePool();
  const camera = scene.activeCamera;
  if (!camera) return null;
  const outline = createOutline(scene, engine, camera);

  const ghosts = new Map<string, Mesh>();
  const ghostFor = (key: string, slot: number): Mesh | null => {
    const name = `${key}#${slot}`;
    let g = ghosts.get(name);
    if (g) return g;
    const geometry = pool.geometryOf(key);
    if (!geometry) return null;
    g = new Mesh(`ghost_${name}`, scene);
    const vd = new VertexData();
    vd.positions = geometry.positions;
    vd.indices = geometry.indices;
    vd.normals = geometry.normals;
    vd.applyToMesh(g);
    g.isPickable = false;
    g.layerMask = GHOST_LAYER;
    g.setEnabled(false);
    ghosts.set(name, g);
    return g;
  };

  const _m = new Matrix();
  const shown: Mesh[] = [];
  const trace = (id: number | null, slot: number): Mesh[] => {
    const out: Mesh[] = [];
    if (id === null) return out;
    for (const part of parts.get(id) ?? []) {
      const g = ghostFor(part.key, slot);
      if (!g || !pool.matrixOf(part.key, part.id, _m)) continue;
      g.freezeWorldMatrix(_m.clone());
      g.setEnabled(true);
      out.push(g);
      shown.push(g);
    }
    return out;
  };
  const obs = scene.onBeforeRenderObservable.add(() => {
    for (const g of shown) g.setEnabled(false);
    shown.length = 0;
    const s = subject();
    const h = hovered();
    outline.show(trace(s, 0), h !== null && h !== s ? trace(h, 1) : []);
  });
  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    outline.dispose();
    for (const g of ghosts.values()) g.dispose();
  });
  return null;
}
