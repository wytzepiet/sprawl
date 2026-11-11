// The renderer, by symbol: Lite's, or with `?renderer=new` our own
// (`client/src/render/`, docs/renderer-design.md). The pure maths is Lite's either
// way: no GPU in it, and the same matrices for free. Ours conform to Lite's
// shapes as far as the client reads them, and are typed as Lite's here.
import * as lite from "@babylonjs/lite";
import * as own from "../render";

export const NEW = new URLSearchParams(globalThis.location?.search ?? "").get("renderer") === "new";
const pick = <T>(l: T, o: unknown): T => (NEW ? (o as T) : l);
export {
  attachFreeControl,
  composeMat4IntoBuffer,
  createFreeCamera,
  createGeometryRendererTask,
  createPickingRay,
  createStorageBuffer,
  GeometryTextureType,
  getCameraPosition,
  getCsmReceiverTexture,
  getFrameGraph,
  getViewProjectionMatrix,
  invertMat4,
  setShaderStorageBuffer,
  updateStorageBuffer,
  wgsl,
  withSampledDepthTexture,
} from "@babylonjs/lite";
export const createEngine = pick(lite.createEngine, own.createEngine);
export const createSurface = pick(lite.createSurface, own.createSurface);
export const disposeEngine = pick(lite.disposeEngine, own.disposeEngine);
export const enableSurfaceResizeObserver = pick(lite.enableSurfaceResizeObserver, own.enableSurfaceResizeObserver);
export const isGpuTimingSupported = pick(lite.isGpuTimingSupported, own.isGpuTimingSupported);
export const renderFrame = pick(lite.renderFrame, own.renderFrame);
export const resizeEngine = pick(lite.resizeEngine, own.resizeEngine);
export const setGpuTimingEnabled = pick(lite.setGpuTimingEnabled, own.setGpuTimingEnabled);
export const waitForGpuIdle = pick(lite.waitForGpuIdle, own.waitForGpuIdle);
export const createCubeEnvironment = pick(lite.createCubeEnvironment, own.createCubeEnvironment);
export const updateCubeEnvironment = pick(lite.updateCubeEnvironment, own.updateCubeEnvironment);
export const createPbrMaterial = pick(lite.createPbrMaterial, own.createPbrMaterial);
export const markMaterialUboDirty = pick(lite.markMaterialUboDirty, own.markMaterialUboDirty);
export const createMeshFromData = pick(lite.createMeshFromData, own.createMeshFromData);
export const disposeMeshGpu = pick(lite.disposeMeshGpu, own.disposeMeshGpu);
export const flushThinInstances = pick(lite.flushThinInstances, own.flushThinInstances);
export const markMeshRenderableDirty = pick(lite.markMeshRenderableDirty, own.markMeshRenderableDirty);
/** Ours alone: a mesh drawn with another's vertices (`render/mesh.ts`). */
export const meshLike = pick<(of: lite.Mesh, name: string) => lite.Mesh>(null!, own.meshLike);
export const setMeshAttribute = pick(lite.setMeshAttribute, own.setMeshAttribute);
export const setMeshVisible = pick(lite.setMeshVisible, own.setMeshVisible);
export const setThinInstanceColors = pick(lite.setThinInstanceColors, own.setThinInstanceColors);
export const setThinInstanceCount = pick(lite.setThinInstanceCount, own.setThinInstanceCount);
export const setThinInstances = pick(lite.setThinInstances, own.setThinInstances);
export const updateMeshPositions = pick(lite.updateMeshPositions, own.updateMeshPositions);
export const addClusteredLightContainer = pick(lite.addClusteredLightContainer, own.addClusteredLightContainer);
export const addToScene = pick(lite.addToScene, own.addToScene);
export const createClusteredLightContainer = pick(lite.createClusteredLightContainer, own.createClusteredLightContainer);
export const createClusteredPointLight = pick(lite.createClusteredPointLight, own.createClusteredPointLight);
export const createClusteredSpotLight = pick(lite.createClusteredSpotLight, own.createClusteredSpotLight);
export const createCsmDirectionalShadowGenerator = pick(lite.createCsmDirectionalShadowGenerator, own.createCsmDirectionalShadowGenerator);
export const createDirectionalLight = pick(lite.createDirectionalLight, own.createDirectionalLight);
export const createSceneContext = pick(lite.createSceneContext, own.createSceneContext);
export const enableCsmStaticCache = pick(lite.enableCsmStaticCache, own.enableCsmStaticCache);
export const enableMaterialPlugins = pick(lite.enableMaterialPlugins, own.enableMaterialPlugins);
export const enablePbrMaterialPluginVertexData = pick(lite.enablePbrMaterialPluginVertexData, own.enablePbrMaterialPluginVertexData);
export const getCsmStaticTexture = pick(lite.getCsmStaticTexture, own.getCsmStaticTexture);
export const markClusteredLightContainerDirty = pick(lite.markClusteredLightContainerDirty, own.markClusteredLightContainerDirty);
export const onCsmReceiverUpdate = pick(lite.onCsmReceiverUpdate, own.onCsmReceiverUpdate);
export const registerSceneWithShadowSupport = pick(lite.registerSceneWithShadowSupport, own.registerSceneWithShadowSupport);
export const removeFromScene = pick(lite.removeFromScene, own.removeFromScene);
export const setLightDiffuseColor = pick(lite.setLightDiffuseColor, own.setLightDiffuseColor);
export const setShadowGeneratorBounds = pick(lite.setShadowGeneratorBounds, own.setShadowGeneratorBounds);
export const setShadowGeneratorEnabled = pick(lite.setShadowGeneratorEnabled, own.setShadowGeneratorEnabled);
export const setShadowStaticOnly = pick(lite.setShadowStaticOnly, own.setShadowStaticOnly);
export const setShadowTaskCasterMeshes = pick(lite.setShadowTaskCasterMeshes, own.setShadowTaskCasterMeshes);
export const addMeshToTask = pick(lite.addMeshToTask, own.addMeshToTask);
export const addTaskAtStart = pick(lite.addTaskAtStart, own.addTaskAtStart);
export const createRenderTask = pick(lite.createRenderTask, own.createRenderTask);
export const createShaderMaterial = pick(lite.createShaderMaterial, own.createShaderMaterial);
export const createSurfaceRenderTargetTexture = pick(lite.createSurfaceRenderTargetTexture, own.createSurfaceRenderTargetTexture);
export const onRenderTargetTextureResize = pick(lite.onRenderTargetTextureResize, own.onRenderTargetTextureResize);
export const removeMeshFromTask = pick(lite.removeMeshFromTask, own.removeMeshFromTask);
export const setShaderTexture = pick(lite.setShaderTexture, own.setShaderTexture);
export const setShaderUniform = pick(lite.setShaderUniform, own.setShaderUniform);
export const createTexture2DFromPixels = pick(lite.createTexture2DFromPixels, own.createTexture2DFromPixels);
export const enablePixelTextureMipmaps = pick(lite.enablePixelTextureMipmaps, own.enablePixelTextureMipmaps);
export const releaseTexture = pick(lite.releaseTexture, own.releaseTexture);
export const updateTexture2DFromPixels = pick(lite.updateTexture2DFromPixels, own.updateTexture2DFromPixels);
/** Ours alone: the still picture inside the renderer (`still.ts`). */
export const { ownStill, stalePicture, holdPicture, hurryPicture, remadeWithin } = own;
export { _vis } from "@babylonjs/lite/src/engine/engine";
export type {
  ClusteredLightContainer,
  ClusteredPointLight,
  ClusteredSpotLight,
  CubeEnvironment,
  DirectionalLight,
  EngineContext,
  MaterialPlugin,
  Mesh,
  PbrMaterialProps,
  RenderTask,
  SceneContext,
  ShaderMaterial,
  ShadowGenerator,
  Texture2D,
  ToneMapping,
} from "@babylonjs/lite";
