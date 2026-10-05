import { MaterialDefines, MaterialPluginBase, type Material } from "@babylonjs/core";

/**
 * How shiny each vertex is, on a material whose meshes are coloured by
 * vertex: the colour's alpha, which those meshes leave opaque (they never
 * set `hasVertexAlpha`), passed on by itself, scales the material's
 * highlight. So one mesh of
 * many surfaces can be water that gleams beside sand that barely does.
 */
class ShineDefines extends MaterialDefines {
  SHINE = false;
}

export class ShinePlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "Shine", 210, new ShineDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: ShineDefines) {
    defines.SHINE = true;
  }

  getClassName() {
    return "ShinePlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): { [point: string]: string } | null {
    const wgsl = shaderLanguage === 1;
    // Its own varying: without vertex alpha, Babylon hands the fragment the
    // colour's rgb alone, its alpha left at 1.
    if (shaderType === "vertex") {
      return wgsl
        ? { CUSTOM_VERTEX_DEFINITIONS: "varying vShine: f32;", CUSTOM_VERTEX_MAIN_END: "vertexOutputs.vShine = vertexInputs.color.a;" }
        : { CUSTOM_VERTEX_DEFINITIONS: "varying float vShine;", CUSTOM_VERTEX_MAIN_END: "vShine = color.a;" };
    }
    return wgsl
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: "varying vShine: f32;",
          "!var finalSpecular: vec3f=specularBase\\*specularColor;": "var finalSpecular: vec3f=specularBase*specularColor*fragmentInputs.vShine;",
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: "varying float vShine;",
          "!vec3 finalSpecular=specularBase\\*specularColor;": "vec3 finalSpecular=specularBase*specularColor*vShine;",
        };
  }
}
