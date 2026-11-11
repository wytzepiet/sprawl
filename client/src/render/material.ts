import type { Texture2D } from "./texture";

/** Where in the surface's shader a plugin may write. */
export type MaterialPluginPoint =
  | "CUSTOM_FRAGMENT_DEFINITIONS"
  | "CUSTOM_FRAGMENT_MAIN_BEGIN"
  | "CUSTOM_FRAGMENT_UPDATE_ALPHA"
  | "CUSTOM_FRAGMENT_UPDATE_DIFFUSE"
  | "CUSTOM_FRAGMENT_BEFORE_LIGHTS"
  | "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION"
  | "CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR"
  | "CUSTOM_VERTEX_MAIN_BEGIN"
  | "CUSTOM_VERTEX_UPDATE_WORLDPOS"
  | "CUSTOM_VERTEX_MAIN_END";

/** A part of a material: what it adds to the shader, and what it gives it to read. */
export interface MaterialPlugin {
  readonly name: string;
  priority?: number;
  isEnabled?: boolean;
  dynamic?: boolean;
  defines?: Record<string, boolean | number>;
  getCustomCode?(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
  getUniforms?(): { ubo?: { readonly name: string; readonly type: string; readonly visibility?: "vertex" | "fragment" | "vertex-fragment" }[] };
  getAttributes?(): { readonly name: string; readonly type: "f32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>"; readonly perInstance?: boolean; readonly buffer?: string }[];
  getVaryings?(): { readonly name: string; readonly type: "f32" | "vec2f" | "vec3f" | "vec4f" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" }[];
  getSamplers?(): {
    readonly texture: string;
    readonly sampler: string;
    readonly textureType?: "texture_2d<f32>";
    readonly depthTexture?: boolean;
    readonly samplerType?: "sampler" | "sampler_non_filtering";
    readonly visibility?: "vertex" | "fragment" | "vertex-fragment";
  }[];
  writeUbo?(data: Float32Array, offsets: ReadonlyMap<string, number>): void;
  bindTextures?(out: { readonly texture: Texture2D }[]): void;
  getActiveTextures?(out: Texture2D[]): void;
}

/**
 * A PBR material as the client knows Lite's (docs/archive/renderer-contract.md §5.1):
 * the factors the template reads, and the plugins that write the surface.
 * Plain data; the shader is composed from it (`compose.ts`), the UBO written
 * from it (`writeMaterialUbo`) whenever `_uboVersion` moves.
 */
export interface OwnPbrMaterial {
  plugins: MaterialPlugin[];
  roughnessFactor: number;
  metallicFactor: number;
  reflectance: number;
  materialAlpha: number;
  doubleSided: boolean;
  _uboVersion: number;
}

export function createPbrMaterial(props: { plugins?: MaterialPlugin[]; roughnessFactor?: number; metallicFactor?: number; doubleSided?: boolean } = {}): OwnPbrMaterial {
  return {
    plugins: props.plugins ?? [],
    roughnessFactor: props.roughnessFactor ?? 1,
    metallicFactor: props.metallicFactor ?? 1,
    reflectance: 0.04,
    materialAlpha: 1,
    doubleSided: props.doubleSided ?? false,
    _uboVersion: 0,
  };
}

/** The UBO is written again before the next draw. */
export function markMaterialUboDirty(material: OwnPbrMaterial) {
  material._uboVersion++;
}

/** The plugins that run, lowest priority first (default 500; a stable sort). */
export const enabledPlugins = (material: OwnPbrMaterial) =>
  material.plugins.filter((p) => p.isEnabled !== false).sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));

/** The material's UBO, laid out as `compose` laid it (`Composed.materialUbo`). */
export function writeMaterialUbo(material: OwnPbrMaterial, offsets: ReadonlyMap<string, number>, data: Float32Array) {
  for (const k of ["roughnessFactor", "metallicFactor", "reflectance", "materialAlpha"] as const) data[offsets.get(k)! / 4] = material[k];
  for (const p of enabledPlugins(material)) p.writeUbo?.(data, offsets);
}

/** The plugins' textures in binding order (`Composed.materialTextures`):
 *  group 1, binding 1 + 2i the texture, 2 + 2i its sampler. */
export function materialTextures(material: OwnPbrMaterial) {
  const out: Parameters<NonNullable<MaterialPlugin["bindTextures"]>>[0] = [];
  for (const p of enabledPlugins(material)) p.bindTextures?.(out);
  return out.map((b) => b.texture);
}
