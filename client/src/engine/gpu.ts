// The renderer (`client/src/render/`, docs/renderer-design.md), as the engine names it.
export * from "../render";
export { composeMat4IntoBuffer, createFreeCamera, createPickingRay, getViewProjectionMatrix, invertMat4 } from "../render/camera";
export { wgsl } from "../render/wgsl";
export type { Engine as EngineContext } from "../render/engine";
export type { CubeEnvironment } from "../render/env";
export type { MaterialPlugin, OwnPbrMaterial as PbrMaterial } from "../render/material";
export type { Mesh } from "../render/mesh";
export type { ClusteredLightContainer, ClusteredPointLight, ClusteredSpotLight, DirectionalLight, Scene as SceneContext, ShadowGenerator } from "../render/scene";
export type { RenderTask, ShaderMaterial } from "../render/shader";
export type { Texture2D } from "../render/texture";
