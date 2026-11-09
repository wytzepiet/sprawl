import type { MaterialPlugin } from "@babylonjs/lite";

/**
 * A PBR material as the client knows Lite's (docs/renderer-contract.md §5.1):
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
