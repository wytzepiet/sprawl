import {
  Color3,
  Color4,
  Constants,
  Effect,
  PostProcess,
  RenderTargetTexture,
  StandardMaterial,
  Texture,
  type AbstractEngine,
  type AbstractMesh,
  type Camera,
  type Material,
  type Mesh,
  type Scene,
} from "@babylonjs/core";

/** The line, in pixels, at any zoom. */
const WIDTH = 2;
/** How far the shape itself leans toward the colour, 0 to 1. */
const TINT = 0.18;
const PICKED = new Color3(0.72, 0.88, 1.0);
const UNDER = new Color3(0.72, 0.88, 1.0);
const EVERY_LAYER = 0x0fffffff;

Effect.ShadersStore.outlineFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D maskSampler;
uniform vec2 texel;
uniform float width;
uniform vec3 picked;
uniform vec3 under;
uniform float underAlpha;
uniform float tint;
// Every sample is taken before anything branches: WebGPU wants texture
// reads in uniform control flow, so the choice is made with arithmetic.
void main() {
  vec4 scene = texture2D(textureSampler, vUV);
  vec4 here = texture2D(maskSampler, vUV);
  // The mask, pushed out by the line width: a ring of taps, and the nearer
  // ring so a thin shape is not missed between them.
  float r = 0.0, g = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a)) * texel * width;
    vec4 m = texture2D(maskSampler, vUV + d);
    vec4 n = texture2D(maskSampler, vUV + d * 0.5);
    r = max(r, max(m.r, n.r));
    g = max(g, max(m.g, n.g));
  }
  // Read bilinearly, the mask's coverage runs from 0 to 1 over a pixel at
  // an edge. Blending on that, rather than stepping, is the anti-aliasing:
  // the inner edge fades in as the pixel leaves the mesh, the outer as the
  // ring stops finding it.
  float outside = 1.0 - smoothstep(0.35, 0.65, here.a);
  vec3 c = mix(scene.rgb, mix(scene.rgb, under, underAlpha), smoothstep(0.15, 0.5, g) * outside);
  c = mix(c, picked, smoothstep(0.15, 0.5, r) * outside);
  // And the shape itself leans a little toward the colour.
  c = mix(c, under, tint * underAlpha * here.g * (1.0 - outside));
  c = mix(c, picked, tint * here.r * (1.0 - outside));
  gl_FragColor = vec4(c, scene.a);
}`;

export interface Outline {
  /** Outline these meshes this frame: the picked ones solid, the ones under
   *  the pointer fainter. Call every frame; nothing is remembered. */
  show(picked: Mesh[], under: Mesh[]): void;
  dispose(): void;
}

/**
 * A cartoon outline, a few pixels wide at any zoom, around whichever meshes
 * are asked for: they are drawn into a mask only this pass reads — red for
 * picked, green for under the pointer — and a screen-space pass paints
 * wherever the mask, pushed out by the line width, reaches ground the mask
 * does not cover. The mask and the pass exist only while something is
 * shown; the rest of the time the effect costs nothing, not even the copy
 * a post-process forces.
 *
 * A mesh on a layer the camera never draws — a ghost standing in for a
 * thin instance — is still drawn into the mask: every mesh is lifted onto
 * every layer for the mask's pass and put back after, wearing the mask's
 * flat paint for the duration.
 */
export function createOutline(scene: Scene, engine: AbstractEngine, camera: Camera): Outline {
  const mask = new RenderTargetTexture("outline_mask", { ratio: 1 }, scene, false, true, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, Texture.BILINEAR_SAMPLINGMODE);
  mask.clearColor = new Color4(0, 0, 0, 0);
  mask.renderList = [];

  const paint = (name: string, color: Color3) => {
    const m = new StandardMaterial(`outline_${name}`, scene);
    m.emissiveColor = color;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    return m;
  };
  const red = paint("picked", new Color3(1, 0, 0));
  const green = paint("under", new Color3(0, 1, 0));

  // What each mesh wears and where it lives outside the mask's pass.
  const worn = new Map<AbstractMesh, { material: Material | null; layer: number; paint: Material }>();
  mask.onBeforeRenderObservable.add(() => {
    for (const m of mask.renderList!) {
      const w = worn.get(m);
      if (!w) continue;
      m.material = w.paint;
      m.layerMask = EVERY_LAYER;
    }
  });
  mask.onAfterRenderObservable.add(() => {
    for (const m of mask.renderList!) {
      const w = worn.get(m);
      if (!w) continue;
      m.material = w.material;
      m.layerMask = w.layer;
    }
  });

  const pass = new PostProcess("outline", "outline", ["texel", "width", "picked", "under", "underAlpha", "tint"], ["maskSampler"], 1.0, null, undefined, engine);
  // The scene renders into this pass's texture while it is attached, so the
  // texture has to carry the multisampling the screen would have had.
  pass.samples = 4;
  pass.onApply = (effect) => {
    effect.setTexture("maskSampler", mask);
    effect.setFloat2("texel", 1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
    effect.setFloat("width", WIDTH / engine.getHardwareScalingLevel());
    effect.setColor3("picked", PICKED);
    effect.setColor3("under", UNDER);
    effect.setFloat("underAlpha", 0.5);
    effect.setFloat("tint", TINT);
  };

  let active = false;
  const activate = (on: boolean) => {
    if (on === active) return;
    active = on;
    if (on) {
      scene.customRenderTargets.push(mask);
      camera.attachPostProcess(pass);
    } else {
      scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(mask), 1);
      camera.detachPostProcess(pass);
    }
  };

  return {
    show(picked, under) {
      mask.renderList!.length = 0;
      worn.clear();
      for (const m of picked) {
        worn.set(m, { material: m.material, layer: m.layerMask, paint: red });
        mask.renderList!.push(m);
      }
      for (const m of under) {
        if (worn.has(m)) continue;
        worn.set(m, { material: m.material, layer: m.layerMask, paint: green });
        mask.renderList!.push(m);
      }
      activate(mask.renderList!.length > 0);
    },
    dispose() {
      activate(false);
      pass.dispose();
      mask.dispose();
      red.dispose();
      green.dispose();
    },
  };
}
