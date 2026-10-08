import { onCleanup } from "solid-js";
import { flushThinInstances, setThinInstances, type Mesh } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { meshOf } from "./geometry";
import { hovered, parts, subject } from "../state/selection";

/**
 * The thing under the pointer, and the thing picked, given the outline
 * (`outline.ts`). Cars and buildings are thin instances of shared meshes,
 * which cannot be outlined one at a time; so a ghost of the very mesh, out
 * of the scene, is set on the very matrix the pool drew the instance with,
 * and the outline traces it.
 */
export function Highlight() {
  const { engine, beforeRender, outline } = useEngine();
  const pool = useInstancePool();

  const ghosts = new Map<string, Mesh>();
  const ghostFor = (key: string, slot: number): Mesh | null => {
    const name = `${key}#${slot}`;
    let g = ghosts.get(name);
    if (g) return g;
    const geometry = pool.geometryOf(key);
    if (!geometry) return null;
    g = meshOf(engine, `ghost_${name}`, geometry);
    setThinInstances(g, new Float32Array(16), 1);
    ghosts.set(name, g);
    return g;
  };

  const trace = (id: number | null, slot: number): Mesh[] => {
    const out: Mesh[] = [];
    if (id === null) return out;
    for (const part of parts.get(id) ?? []) {
      const g = ghostFor(part.key, slot);
      if (!g || !pool.matrixOf(part.key, part.id, g.thinInstances!.matrices as Float32Array)) continue;
      flushThinInstances(g);
      out.push(g);
    }
    return out;
  };
  onCleanup(
    beforeRender(() => {
      const s = subject();
      const h = hovered();
      outline.show(trace(s, 0), h !== null && h !== s ? trace(h, 1) : []);
    }),
  );
  onCleanup(() => outline.show([], []));
  return null;
}
