import { MaterialPluginBase, PBRMaterial, type Material, type Scene } from "@babylonjs/core";

/**
 * The town's material: PBR, lit by the sun and by the sky round it
 * (`sky.ts`), its colour and its shape written by plugins, pixel by pixel.
 *
 * Before the lights a plugin writes, in the material's own words:
 * - `baseColor`, the colour as an eye sees it: the mesh's own (its
 *   vertices', its texture's), which `diffuseColor`, the material's
 *   `albedoColor`, multiplies;
 * - `normalW`, which way the surface faces;
 * - `townShine`, 0 to 1, how far the surface is glossed from its own
 *   roughness toward a polish: a grain of sand, a worn stone, wet slate.
 *
 * Opened before every plugin in a block of their own (PBR declares a
 * `baseColor` of its own further on), and closed after them: the colour made
 * linear, as PBR wants its albedo, and once PBR has worked out its roughness,
 * the shine laid on it.
 */
const GLOSS = 0.12;

const OPEN = {
  wgsl: "{ var diffuseColor: vec3f = uniforms.vAlbedoColor.rgb; var baseColor: vec4f = vec4f(surfaceAlbedo / max(diffuseColor, vec3f(1e-4)), alpha);",
  glsl: "{ vec3 diffuseColor = vAlbedoColor.rgb; vec4 baseColor = vec4(surfaceAlbedo / max(diffuseColor, vec3(1e-4)), alpha);",
};
const CLOSE = {
  wgsl: "surfaceAlbedo = pow(max(baseColor.rgb * diffuseColor, vec3f(0.0)), vec3f(2.2)); alpha = baseColor.a; }",
  glsl: "surfaceAlbedo = pow(max(baseColor.rgb * diffuseColor, vec3(0.0)), vec3(2.2)); alpha = baseColor.a; }",
};

class TownOpen extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "TownOpen", -1e6);
    this._enable(true);
  }
  isCompatible() {
    return true;
  }
  getCustomCode(shaderType: string, shaderLanguage = 0) {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === 1;
    return {
      CUSTOM_FRAGMENT_MAIN_BEGIN: wgsl ? "var townShine: f32 = 0.0;" : "float townShine = 0.0;",
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: wgsl ? OPEN.wgsl : OPEN.glsl,
    };
  }
}

class TownClose extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "TownClose", 1e6);
    this._enable(true);
  }
  isCompatible() {
    return true;
  }
  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> | null {
    if (shaderType !== "fragment") return null;
    const gloss = GLOSS.toFixed(3);
    return shaderLanguage === 1
      ? {
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: CLOSE.wgsl,
          "!var roughness: f32=reflectivityOut\\.roughness;": `var roughness: f32=mix(reflectivityOut.roughness, ${gloss}, townShine); microSurface = 1.0 - roughness;`,
        }
      : {
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: CLOSE.glsl,
          "!float roughness=reflectivityOut\\.roughness;": `float roughness=mix(reflectivityOut.roughness, ${gloss}, townShine); microSurface = 1.0 - roughness;`,
        };
  }
}

/** A material of the town's, as rough as this when nothing glosses it:
 *  1 chalk, 0 a mirror. */
export function townMaterial(name: string, scene: Scene, roughness = 0.9): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.metallic = 0;
  material.roughness = roughness;
  new TownOpen(material);
  new TownClose(material);
  return material;
}
