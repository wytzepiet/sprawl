import { markMaterialUboDirty as mark, type OwnPbrMaterial } from "./material";
import type { Mesh } from "./mesh";
import { forcePicture } from "./frame";
import { dirtyMaterials } from "./pass";
import type { Scene } from "./scene";

/** The renderer (docs/renderer-design.md); `engine/gpu.ts` names it for the engine. */
export { createEngine, createSurface, disposeEngine, enableSurfaceResizeObserver, isGpuTimingSupported, renderFrame, resizeEngine, setGpuTimingEnabled, waitForGpuIdle } from "./engine";
export { createCubeEnvironment, updateCubeEnvironment } from "./env";
export { createPbrMaterial } from "./material";
export { changedWithin, holdPicture, hurryPicture, remadeWithin, stalePicture } from "./frame";
export {
  createMeshFromData,
  disposeMeshGpu,
  flushThinInstances,
  markMeshRenderableDirty,
  meshLike,
  setMeshAttribute,
  setMeshVisible,
  setThinInstanceColors,
  setThinInstanceCount,
  setThinInstances,
  updateMeshPositions,
} from "./mesh";
export {
  addClusteredLightContainer,
  addToScene,
  createClusteredLightContainer,
  createClusteredPointLight,
  createClusteredSpotLight,
  createCsmDirectionalShadowGenerator,
  createDirectionalLight,
  createSceneContext,
  enableCsmStaticCache,
  enableMaterialPlugins,
  enablePbrMaterialPluginVertexData,
  getCsmStaticTexture,
  markClusteredLightContainerDirty,
  onCsmReceiverUpdate,
  registerSceneWithShadowSupport,
  removeFromScene,
  setLightDiffuseColor,
  setShadowGeneratorBounds,
  setShadowGeneratorEnabled,
  setShadowStaticOnly,
  setShadowTaskCasterMeshes,
} from "./scene";
export {
  addMeshToTask,
  addTaskAtStart,
  createRenderTask,
  createShaderMaterial,
  createSurfaceRenderTargetTexture,
  onRenderTargetTextureResize,
  removeMeshFromTask,
  setShaderTexture,
  setShaderUniform,
} from "./shader";
export { createTexture2DFromPixels, enablePixelTextureMipmaps, releaseTexture, updateTexture2DFromPixels } from "./texture";

/** Its UBO written again as the next frame begins. */
export function markMaterialUboDirty(material: OwnPbrMaterial) {
  mark(material);
  dirtyMaterials.add(material);
}

/** The still picture (`still.ts`'s `createStill`): the scene sorts its
 *  meshes by `isStill`, and a frame is one render. `drawn` is told of each
 *  picture drawn (`still.ts`'s `redraws`). */
export function ownStill(scene: Scene, isStill: (mesh: Mesh) => boolean, drawn: (why: string) => void) {
  scene._isStill = isStill;
  scene._pictured = drawn;
  return {
    frame(_now: number, render: () => void, always = false) {
      if (always) forcePicture();
      render();
    },
  };
}
