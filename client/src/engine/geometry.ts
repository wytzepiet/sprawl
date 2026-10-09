import { addToScene, createMeshFromData, disposeMeshGpu, releaseTexture, removeFromScene, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "@babylonjs/lite";

/** A shape as the town's code builds it, before it is a mesh. */
export interface MeshGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  uvs?: number[];
}

type Numbers = ArrayLike<number>;

/** A point on a plan. */
export type P = [number, number];

/** A flat outline, convex and anticlockwise, extruded `thick` up from
 *  z = 0: its face fanned from `mid` and mapped by `uv`, its sides onto
 *  `rim`; every triangle its own three vertices, as the bevel wants. */
export function slab(ring: P[], mid: P, thick: number, uv: (p: P) => number[], rim: number[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    for (const p of [mid, b, a]) {
      positions.push(p[0], p[1], thick);
      normals.push(0, 0, 1);
      uvs.push(...uv(p));
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0];
    for (const [p, z] of [[a, 0], [b, thick], [b, 0], [a, 0], [a, thick], [b, thick]] as [P, number][]) {
      positions.push(p[0], p[1], z);
      normals.push(...n);
      uvs.push(...rim);
    }
  }
  return { positions, normals, uvs, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}


/** A mesh of a shape: its vertex colours, if it has them, as an eye sees them. */
export function meshOf(engine: EngineContext, name: string, geo: { positions: Numbers; normals: Numbers; indices: Numbers; uvs?: Numbers; colors?: Numbers | null }): Mesh {
  const vertices = geo.positions.length / 3;
  return createMeshFromData(
    engine,
    name,
    new Float32Array(geo.positions),
    new Float32Array(geo.normals),
    new Uint32Array(geo.indices),
    geo.uvs ? new Float32Array(geo.uvs) : new Float32Array(vertices * 2),
    undefined,
    undefined,
    geo.colors ? new Float32Array(geo.colors) : undefined,
  );
}

/** A mesh shown. */
export function show(scene: SceneContext, mesh: Mesh) {
  addToScene(scene, mesh);
}

/** A mesh gone, and what it held on the GPU with it once no frame in
 *  flight can still be drawing it. */
export function drop(scene: SceneContext, mesh: Mesh) {
  removeFromScene(scene, mesh);
  setTimeout(() => disposeMeshGpu(mesh), 1000);
}

/** A texture let go of once nothing drawn can still be reading it: the
 *  frames in flight when its mesh went have landed by then. */
export function retire(texture: Texture2D) {
  setTimeout(() => releaseTexture(texture), 1000);
}
