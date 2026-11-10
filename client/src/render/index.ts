import { markMaterialUboDirty as mark, type OwnPbrMaterial } from "./material";
import type { Mesh } from "./mesh";
import { forcePicture } from "./frame";
import { dirtyMaterials } from "./pass";
import type { Scene } from "./scene";

/** Our own renderer, Lite-shaped (docs/renderer-design.md); `engine/gpu.ts` picks it by `?renderer=new`. */
export { createEngine, createSurface, disposeEngine, enableSurfaceResizeObserver, isGpuTimingSupported, renderFrame, resizeEngine, setGpuTimingEnabled, waitForGpuIdle } from "./engine";
export { createCubeEnvironment, updateCubeEnvironment } from "./env";
export { createPbrMaterial } from "./material";
export { holdPicture, remadeWithin, stalePicture } from "./frame";
export {
  createMeshFromData,
  disposeMeshGpu,
  flushThinInstances,
  markMeshRenderableDirty,
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

/** The still picture, ours: `still.ts`'s `createStill` under `?renderer=new`.
 *  The scene sorts its meshes by `isStill`; the sun and the headlights are
 *  the scene's own already, and a frame is one render. `drawn` is told of
 *  each picture drawn (`still.ts`'s `redraws`). */
export function ownStill(scene: Scene, isStill: (mesh: Mesh) => boolean, drawn: (why: string) => void) {
  scene._isStill = isStill;
  scene._pictured = drawn;
  return {
    sun() {},
    headlights() {},
    frame(_now: number, render: () => void, always = false) {
      if (always) forcePicture();
      render();
    },
  };
}
