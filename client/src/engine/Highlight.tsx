import { onCleanup } from "solid-js";
import {
  Color3,
  Color4,
  Constants,
  Effect,
  Matrix,
  Mesh,
  PostProcess,
  RenderTargetTexture,
  StandardMaterial,
  Texture,
  VertexData,
} from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { hovered, parts, subject } from "../state/selection";

/** The line, in pixels, at any zoom. */
const WIDTH = 2;
const PICKED = new Color3(0.72, 0.88, 1.0);
const UNDER = new Color3(0.72, 0.88, 1.0);
/** Ghosts live on a layer the main camera never draws. */
const GHOST_LAYER = 0x10000000;
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
  gl_FragColor = vec4(c, scene.a);
}`;

/**
 * The thing under the pointer, and the thing picked, given a cartoon
 * outline: the silhouette of the very mesh, at the very matrix the pool
 * drew it with, a fixed few pixels wide whatever the zoom.
 *
 * Cars and buildings are thin instances of shared meshes, which cannot be
 * outlined one at a time. So a ghost of the mesh is moved onto the wanted
 * instance and drawn into a mask that only this pass reads — red for the
 * picked thing, green for the one under the pointer — and a screen-space
 * pass paints wherever the mask, pushed out by the line width, reaches
 * ground the mask itself does not cover.
 */
export function Highlight() {
  const { scene, engine } = useEngine();
  const pool = useInstancePool();
  const camera = scene.activeCamera;
  if (!camera) return null;

  // Cleared and drawn only while something is picked or under the pointer;
  // the rest of the time the whole effect costs nothing, not even the copy a
  // post-process forces.
  const mask = new RenderTargetTexture("highlight_mask", { ratio: 1 }, scene, false, true, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, Texture.BILINEAR_SAMPLINGMODE);
  mask.clearColor = new Color4(0, 0, 0, 0);
  mask.renderList = [];
  // The ghosts are drawn by the mask and by nothing else.
  mask.onBeforeRenderObservable.add(() => mask.renderList!.forEach((m) => (m.layerMask = EVERY_LAYER)));
  mask.onAfterRenderObservable.add(() => mask.renderList!.forEach((m) => (m.layerMask = GHOST_LAYER)));

  const paint = (color: Color3) => {
    const m = new StandardMaterial(`highlight_paint_${color.toHexString()}`, scene);
    m.emissiveColor = color;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    return m;
  };
  const red = paint(new Color3(1, 0, 0));
  const green = paint(new Color3(0, 1, 0));

  const pass = new PostProcess("outline", "outline", ["texel", "width", "picked", "under", "underAlpha"], ["maskSampler"], 1.0, null, undefined, engine);
  // The scene renders into this pass's texture while it is attached, so the
  // texture has to carry the multisampling the screen would have had.
  pass.samples = 4;
  pass.onApply = (effect) => {
    effect.setTexture("maskSampler", mask);
    effect.setFloat2("texel", 1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
    effect.setFloat("width", WIDTH * engine.getHardwareScalingLevel() ** -1);
    effect.setColor3("picked", PICKED);
    effect.setColor3("under", UNDER);
    effect.setFloat("underAlpha", 0.5);
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

  const ghosts = new Map<string, Mesh>();
  const ghostFor = (key: string, slot: number): Mesh | null => {
    const name = `${key}#${slot}`;
    let g = ghosts.get(name);
    if (g) return g;
    const geometry = pool.geometryOf(key);
    if (!geometry) return null;
    g = new Mesh(`highlight_${name}`, scene);
    const vd = new VertexData();
    vd.positions = geometry.positions;
    vd.indices = geometry.indices;
    vd.normals = geometry.normals;
    vd.applyToMesh(g);
    g.material = slot === 0 ? red : green;
    g.isPickable = false;
    g.layerMask = GHOST_LAYER;
    g.setEnabled(false);
    ghosts.set(name, g);
    return g;
  };

  const _m = new Matrix();
  const trace = (id: number | null, slot: number) => {
    if (id === null) return;
    for (const part of parts.get(id) ?? []) {
      const g = ghostFor(part.key, slot);
      if (!g || !pool.matrixOf(part.key, part.id, _m)) continue;
      g.freezeWorldMatrix(_m.clone());
      g.setEnabled(true);
      mask.renderList!.push(g);
    }
  };
  const obs = scene.onBeforeRenderObservable.add(() => {
    for (const g of mask.renderList!) g.setEnabled(false);
    mask.renderList!.length = 0;
    const s = subject();
    const h = hovered();
    trace(s, 0);
    if (h !== null && h !== s) trace(h, 1);
    activate(mask.renderList!.length > 0);
  });
  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    activate(false);
    pass.dispose();
    mask.dispose();
    for (const g of ghosts.values()) g.dispose();
    red.dispose();
    green.dispose();
  });
  return null;
}
