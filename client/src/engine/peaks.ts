import { Color3, MaterialDefines, MaterialPluginBase, StandardMaterial, type Material, type Mesh, type Scene } from "@babylonjs/core";
import type { MeshBuffers } from "./objects/terrainGeometry";
import { PEAK, PEAK_GLSL, PEAK_WGSL } from "./objects/peakShape";

/**
 * The mountains lit at every pixel by their shape (`peakShape`): their
 * surface is coarse (`layPeaks`), each point of it carrying how far up its
 * climb it is and which way that rises, and a pixel's facing is the slope
 * of the climb times the shape there, worked out where it is on the map
 * (its points are laid there) and turned into the world's frame. So a ridge
 * is as sharp as the screen, however few points the surface has.
 */

/** How far apart the shape is read either way, in tiles, for its slope. */
const STEP = 0.01;

class PeakDefines extends MaterialDefines {
  PEAK = false;
}

const f = (x: number) => x.toFixed(4);

class PeakPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "Peak", 200, new PeakDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: PeakDefines) {
    defines.PEAK = true;
  }

  getAttributes(attributes: string[]) {
    attributes.push("peakClimb");
  }

  getClassName() {
    return "PeakPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> {
    if (shaderLanguage === 1) {
      return shaderType === "vertex"
        ? {
            CUSTOM_VERTEX_DEFINITIONS: `attribute peakClimb: vec3f; varying vPeakClimb: vec3f; varying vPeakAt: vec2f; varying vPeakX: vec3f; varying vPeakY: vec3f; varying vPeakZ: vec3f;`,
            CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vPeakClimb = vertexInputs.peakClimb; vertexOutputs.vPeakAt = vertexInputs.position.xy; vertexOutputs.vPeakX = normalize((finalWorld * vec4f(1., 0., 0., 0.)).xyz); vertexOutputs.vPeakY = normalize((finalWorld * vec4f(0., 1., 0., 0.)).xyz); vertexOutputs.vPeakZ = normalize((finalWorld * vec4f(0., 0., 1., 0.)).xyz);`,
          }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `varying vPeakClimb: vec3f; varying vPeakAt: vec2f; varying vPeakX: vec3f; varying vPeakY: vec3f; varying vPeakZ: vec3f;\n${PEAK_WGSL}`,
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let peakAt = fragmentInputs.vPeakAt;
let peakHere = peakShape(peakAt);
let peakSlope = vec2f(peakShape(peakAt + vec2f(${f(STEP)}, 0.)) - peakHere, peakShape(peakAt + vec2f(0., ${f(STEP)})) - peakHere) / ${f(STEP)};
let peakRise = ${f(PEAK)} * (fragmentInputs.vPeakClimb.yz * peakHere + fragmentInputs.vPeakClimb.x * peakSlope);
normalW = normalize(fragmentInputs.vPeakZ - peakRise.x * fragmentInputs.vPeakX - peakRise.y * fragmentInputs.vPeakY);`,
          };
    }
    return shaderType === "vertex"
      ? {
          CUSTOM_VERTEX_DEFINITIONS: `attribute vec3 peakClimb; varying vec3 vPeakClimb; varying vec2 vPeakAt; varying vec3 vPeakX; varying vec3 vPeakY; varying vec3 vPeakZ;`,
          CUSTOM_VERTEX_MAIN_END: `vPeakClimb = peakClimb; vPeakAt = position.xy; vPeakX = normalize((finalWorld * vec4(1., 0., 0., 0.)).xyz); vPeakY = normalize((finalWorld * vec4(0., 1., 0., 0.)).xyz); vPeakZ = normalize((finalWorld * vec4(0., 0., 1., 0.)).xyz);`,
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: `varying vec3 vPeakClimb; varying vec2 vPeakAt; varying vec3 vPeakX; varying vec3 vPeakY; varying vec3 vPeakZ;\n${PEAK_GLSL}`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: `vec2 peakAt = vPeakAt;
float peakHere = peakShape(peakAt);
vec2 peakSlope = vec2(peakShape(peakAt + vec2(${f(STEP)}, 0.)) - peakHere, peakShape(peakAt + vec2(0., ${f(STEP)})) - peakHere) / ${f(STEP)};
vec2 peakRise = ${f(PEAK)} * (vPeakClimb.yz * peakHere + vPeakClimb.x * peakSlope);
normalW = normalize(vPeakZ - peakRise.x * vPeakX - peakRise.y * vPeakY);`,
        };
  }
}

/** A material for the mountains, in their colour. */
export function peakMaterial(scene: Scene, name: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.specularColor = new Color3(0.07, 0.07, 0.07);
  material.specularPower = 64;
  material.backFaceCulling = false;
  new PeakPlugin(material);
  return material;
}

/** A mesh's climbs, beside what `VertexData` holds of it. */
export function giveClimb(mesh: Mesh, buf: MeshBuffers) {
  if (buf.climb) mesh.setVerticesData("peakClimb", buf.climb, false, 3);
}
