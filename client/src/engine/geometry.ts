import { addToScene, createMeshFromData, disposeMeshGpu, releaseTexture, removeFromScene, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "@babylonjs/lite";

/** A shape as the town's code builds it, before it is a mesh. */
export interface MeshGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  uvs?: number[];
}

type Numbers = ArrayLike<number>;

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
