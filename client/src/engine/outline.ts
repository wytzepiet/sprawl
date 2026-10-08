import {
  addMeshToTask,
  addTaskAtStart,
  createRenderTask,
  createShaderMaterial,
  createSurfaceRenderTargetTexture,
  removeMeshFromTask,
  setMeshVisible,
  setShaderTexture,
  setShaderUniform,
  wgsl,
  type EngineContext,
  type MaterialPlugin,
  type Mesh,
  type SceneContext,
} from "@babylonjs/lite";
import { townMaterial } from "./material";
import { meshOf, show } from "./geometry";

/** The line, in pixels, at any zoom. */
const WIDTH = 2;
/** How far the shape itself leans toward the colour, 0 to 1. */
const TINT = 0.18;
/** The line's colour, as the screen shows it; the ring round what is under the pointer half as strong. */
const COLOUR = [0.72, 0.88, 1.0];
const UNDER = 0.5;

/** A mask's paint: red for picked, green for under the pointer, as is,
 *  after the light and the tone map. */
const paint = (name: string, colour: string): MaterialPlugin => ({
  name,
  priority: 1e6,
  getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `color = vec3f(${colour}); alpha = 1.0;` } : null),
});

const VERTEX = wgsl`struct VertexOutput { @builtin(position) position: vec4f, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4f(input.position.xy, 0., 1.);
  return out;
}`;
// The mask, pushed out by the line width: a ring of taps, and the nearer
// ring so a thin shape is not missed between them. Read bilinearly, the
// mask's coverage runs from 0 to 1 over a pixel at an edge; blending on
// that, rather than stepping, is the anti-aliasing. And the shape itself
// leans a little toward the colour. One colour over the frame, as alpha.
const FRAGMENT = wgsl`struct VertexOutput { @builtin(position) position: vec4f, };
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(mask));
  let uv = input.position.xy / size;
  let texel = 1. / size;
  let here = textureSampleLevel(mask, maskSampler, uv, 0.);
  var r = 0.;
  var g = 0.;
  for (var i = 0; i < 12; i++) {
    let a = f32(i) * 0.5235988;
    let d = vec2f(cos(a), sin(a)) * texel * shaderUniforms.width;
    let m = textureSampleLevel(mask, maskSampler, uv + d, 0.);
    let n = textureSampleLevel(mask, maskSampler, uv + d * 0.5, 0.);
    r = max(r, max(m.r, n.r));
    g = max(g, max(m.g, n.g));
  }
  let outside = 1. - smoothstep(0.35, 0.65, here.a);
  let ringUnder = ${UNDER.toFixed(2)} * smoothstep(0.15, 0.5, g) * outside;
  let ringPicked = smoothstep(0.15, 0.5, r) * outside;
  let tint = ${TINT.toFixed(2)} * (${UNDER.toFixed(2)} * here.g + here.r) * (1. - outside);
  let alpha = 1. - (1. - ringUnder) * (1. - ringPicked) * (1. - tint);
  return vec4f(vec3f(${COLOUR.join(", ")}), alpha);
}`;

export interface Outline {
  /** Outline these meshes from now on: the picked ones solid, the ones under
   *  the pointer fainter. Meshes of their own, out of the scene: ghosts. */
  show(picked: Mesh[], under: Mesh[]): void;
}

/**
 * A cartoon outline, a few pixels wide at any zoom, around whichever meshes
 * are asked for: they are drawn into a mask only this reads — red for
 * picked, green for under the pointer — and a quad over the whole screen,
 * drawn last of all, lays the colour wherever the mask, pushed out by the
 * line width, reaches ground the mask does not cover. The mask's pass runs
 * only while something is shown, and the quad is drawn only then.
 *
 * Made before the scene is registered: the mask's pass is a task of the
 * scene's frame graph, which records its tasks then.
 */
export function createOutline(engine: EngineContext, scene: SceneContext): Outline {
  const { rt, texture } = createSurfaceRenderTargetTexture(engine, { lbl: "outline", format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: engine.surfaces[0] });
  const task = createRenderTask({ name: "outline", rt, clrColor: { r: 0, g: 0, b: 0, a: 0 }, cs: true, autoMirror: false }, engine, scene);
  addTaskAtStart(scene, task);
  task.executionEnabled = false;
  const paints = { picked: townMaterial([paint("MaskPicked", "1., 0., 0.")]), under: townMaterial([paint("MaskUnder", "0., 1., 0.")]) };

  const material = createShaderMaterial({
    name: "outline",
    vertexSource: VERTEX,
    fragmentSource: FRAGMENT,
    attributes: ["position"],
    uniforms: [{ name: "width", type: "f32" }],
    samplers: ["mask"],
    needAlphaBlending: true,
    backFaceCulling: false,
    depthWrite: false,
    depthCompare: "always",
  });
  setShaderTexture(material, "mask", texture);
  setShaderUniform(material, "width", WIDTH * Math.min(devicePixelRatio, 2));
  const quad = meshOf(engine, "outline", { positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
  quad.material = material;
  // Last of all, over the fog too.
  quad.renderOrder = Number.MAX_VALUE;
  setMeshVisible(quad, false);
  show(scene, quad);

  let drawn = new Map<Mesh, "picked" | "under">();
  return {
    show(picked, under) {
      const want = new Map<Mesh, "picked" | "under">();
      for (const m of under) want.set(m, "under");
      for (const m of picked) want.set(m, "picked");
      for (const [m, kind] of drawn) if (want.get(m) !== kind) removeMeshFromTask(task, m);
      for (const [m, kind] of want) if (drawn.get(m) !== kind) addMeshToTask(task, m, { material: paints[kind] });
      drawn = want;
      const active = want.size > 0;
      task.executionEnabled = active;
      setMeshVisible(quad, active);
    },
  };
}
