import { MaterialPluginBase, RegisterMaterialPlugin, type Material } from "@babylonjs/core";

/**
 * How the scene's light, unbounded, is brought into what a screen can show:
 * AgX, Troy Sobotka's, as film takes light, in Benjamin Wrensch's fit, with
 * its punchy look. Laid into every material where Babylon's own curve would
 * go, after the exposure and before the colour is put into gamma; Babylon's
 * is left off (`DayNightCycle.tsx`).
 *
 * The light is leant a little toward grey, so a saturated light (a red sun)
 * never rests on one channel; put into stops; drawn through film's S-curve,
 * a soft toe and a long shoulder, so a bright colour passes on toward white
 * rather than to yellow or magenta; then given more contrast and colour, the
 * punchy look; and leant back.
 */
const GLSL = `const mat3 toneIn = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const mat3 toneOut = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
vec3 toneMap(vec3 c) {
c = (clamp(log2(max(toneIn * c, vec3(1e-10))), -12.47393, 4.026069) + 12.47393) / 16.5;
vec3 c2 = c * c, c4 = c2 * c2;
c = 15.5 * c4 * c2 - 40.14 * c4 * c + 31.96 * c4 - 6.868 * c2 * c + 0.4298 * c2 + 0.1191 * c - 0.00232;
float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
c = luma + 1.4 * (pow(max(c, vec3(0.)), vec3(1.35)) - luma);
return pow(max(toneOut * c, vec3(0.)), vec3(2.2));
}`;

const WGSL = `const toneIn = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const toneOut = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
fn toneMap(c0: vec3f) -> vec3f {
var c = (clamp(log2(max(toneIn * c0, vec3f(1e-10))), vec3f(-12.47393), vec3f(4.026069)) + 12.47393) / 16.5;
let c2 = c * c;
let c4 = c2 * c2;
c = 15.5 * c4 * c2 - 40.14 * c4 * c + 31.96 * c4 - 6.868 * c2 * c + 0.4298 * c2 + 0.1191 * c - 0.00232;
let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
c = luma + 1.4 * (pow(max(c, vec3f(0.)), vec3f(1.35)) - luma);
return pow(max(toneOut * c, vec3f(0.)), vec3f(2.2));
}`;

class ToneMap extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "ToneMap", 0);
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  getClassName() {
    return "ToneMap";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> | null {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === 1
      ? { CUSTOM_IMAGEPROCESSINGFUNCTIONS_DEFINITIONS: WGSL, "!rgb=toGammaSpaceVec3\\(rgb\\);": "rgb=toGammaSpaceVec3(toneMap(rgb));" }
      : { CUSTOM_IMAGEPROCESSINGFUNCTIONS_DEFINITIONS: GLSL, "!result\\.rgb=toGammaSpace\\(result\\.rgb\\);": "result.rgb=toGammaSpace(toneMap(result.rgb));" };
  }
}

RegisterMaterialPlugin("ToneMap", (material) => new ToneMap(material));
