import {
  addTaskAtStart,
  addToScene,
  createFreeCamera,
  createRenderTask,
  createShaderMaterial,
  createStorageBuffer,
  createSurfaceRenderTargetTexture,
  getCsmReceiverTexture,
  getCsmStaticTexture,
  getFrameGraph,
  getViewProjectionMatrix,
  invertMat4,
  markClusteredLightContainerDirty,
  onCsmReceiverUpdate,
  onRenderTargetTextureResize,
  setShaderStorageBuffer,
  setShaderTexture,
  setShaderUniform,
  setShadowStaticOnly,
  updateStorageBuffer,
  withSampledDepthTexture,
  wgsl,
  type ClusteredLightContainer,
  type ClusteredSpotLight,
  type EngineContext,
  type Mesh,
  type RenderTask,
  type SceneContext,
  type ShaderMaterial,
  type ShadowGenerator,
  type Texture2D,
} from "@babylonjs/lite";
import { _vis } from "@babylonjs/lite/src/engine/engine";
import { meshOf } from "./geometry";

/**
 * The town is drawn once and kept, and only what moves is drawn every frame.
 *
 * A phone's GPU spent all of every frame drawing a town that had not
 * changed. So the scene's meshes are of two kinds. Still ones (the land,
 * roads, buildings, trees) are drawn into a picture of their own, with how
 * far away each pixel is, and only when something still has changed: the
 * view moved, something was built, the sun went on a little. Live ones (the
 * vehicles, the goods, the water) are drawn every frame over a copy of that
 * picture, hidden behind buildings by its depth.
 *
 * The picture is drawn a margin wider than the screen, and while the view
 * moves it is slid under the live things to where the view now is, every
 * frame, and drawn again only now and then: a pan keeps the screen's pace on
 * a phone that draws the town at a third of it. Sliding is exact for the
 * ground and near enough for what stands on it with a lens this narrow, and
 * the next drawing puts it right.
 *
 * The picture is lit by what stands still alone: no headlight, and no
 * shadow of anything that moves, or they would stay behind on it. Those are
 * laid over it as it is shown, each frame: where the sun's map has a shadow
 * its still layer has not, the sun's share of the light is taken away; and
 * each headlight lights the pixels its cone reaches, found by their depth,
 * the way a deferred renderer lights its surfaces.
 */

/** The picture's margin past each edge of the screen, as a share of it. */
export const MARGIN = 0.12;
/** While the view moves, the picture drawn again at most this often. */
const MOVING_MS = 100;
/** Something still changed: drawn again at most this often. */
const CHANGED_MS = 100;
/** And again this often whatever happened: the sun moves, and whatever was
 *  not told to the picture (`stale`) is in it this soon. */
const EVERY_MS = 500;

/** Meshes drawn every frame, over the picture and never into it. */
const lives = new WeakSet<Mesh>();

/** A mesh drawn every frame, over the still picture and never into it:
 *  said before it is added to the scene. */
export function live(mesh: Mesh): Mesh {
  lives.add(mesh);
  return mesh;
}

/** Whether a mesh stands still: drawn into the picture, and its shadow
 *  into the sun's map's still layer. */
export const isStill = (mesh: Mesh) => !lives.has(mesh);

let staleSince = Infinity;
/** Something still has changed: the picture is drawn again soon. */
export function stale() {
  staleSince = Math.min(staleSince, performance.now());
}

const VIEW_UNIFORMS = [
  { name: "screen", type: "vec2<f32>" },
  { name: "seen", type: "mat4x4<f32>" },
  { name: "seenInverse", type: "mat4x4<f32>" },
  { name: "stillView", type: "mat4x4<f32>" },
  { name: "stillInverse", type: "mat4x4<f32>" },
] as const;
const PICTURE = [
  { name: "still", sampleType: "float" },
  { name: "stillDepth", sampleType: "depth" },
] as const;

// A pixel of the screen, found in the picture: the ray through it meets
// the ground, that point is looked up in the picture, and the height there
// is where the ray is met again, twice more. With the view where the
// picture was drawn from, a pixel finds its own, whatever the height.
const FIND = wgsl`fn unproject(m: mat4x4f, ndc: vec3f) -> vec3f { let p = m * vec4f(ndc, 1.); return p.xyz / p.w; }
struct Found { texel: vec2i, depth: f32, at: vec3f, eye: vec3f, };
fn pictureAt(texel: vec2i) -> vec3f {
  let size = vec2f(textureDimensions(still));
  let t = (vec2f(texel) + 0.5) / size;
  return unproject(shaderUniforms.stillInverse, vec3f(t.x * 2. - 1., 1. - t.y * 2., textureLoad(stillDepth, texel, 0)));
}
fn find(pixel: vec2f) -> Found {
  let screen = shaderUniforms.screen;
  let size = vec2f(textureDimensions(still));
  let ndc = vec2f(pixel.x / screen.x * 2. - 1., 1. - pixel.y / screen.y * 2.);
  let a = unproject(shaderUniforms.seenInverse, vec3f(ndc, 1.));
  let b = unproject(shaderUniforms.seenInverse, vec3f(ndc, 0.5));
  var f: Found;
  f.eye = a;
  var h = 0.;
  for (var i = 0; i < 3; i++) {
    let p = a + (b - a) * ((h - a.z) / (b.z - a.z));
    let c = shaderUniforms.stillView * vec4f(p, 1.);
    let s = c.xy / c.w;
    let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
    f.texel = clamp(vec2i(floor(uv * size + 0.001)), vec2i(0), vec2i(size) - 1);
    f.depth = textureLoad(stillDepth, f.texel, 0);
    if (f.depth <= 0.) { break; }
    f.at = pictureAt(f.texel);
    h = f.at.z;
  }
  return f;
}`;

const SCREEN = wgsl`struct VertexOutput { @builtin(position) position: vec4f, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4f(input.position.xy, 0., 1.);
  return out;
}`;

// The picture where the view now is: its colour, and its depth as the view
// sees it; darker where something moving shades it from the sun.
const SHOWN = wgsl`struct VertexOutput { @builtin(position) position: vec4f, };
struct Out { @location(0) color: vec4f, @builtin(frag_depth) depth: f32, };
${FIND}
fn sunLost(w: vec3f) -> f32 {
  let l = shaderUniforms.shadowMatrix * vec4f(w, 1.);
  let c = l.xyz / l.w;
  let uv = vec2f(0.5 * c.x + 0.5, 0.5 - 0.5 * c.y);
  if (any(uv < vec2f(0.)) || any(uv > vec2f(1.))) { return 0.; }
  let depth = clamp(c.z, 0., 0.99999994);
  let o = shaderUniforms.shadowInfo.z * 0.5;
  var lost = 0.;
  for (var i = 0; i < 4; i++) {
    let at = uv + vec2f(select(-o, o, (i & 1) == 1), select(-o, o, i >= 2));
    lost += textureSampleCompareLevel(shadowStill, shadowStillSampler, at, 0, depth) - textureSampleCompareLevel(shadowNow, shadowNowSampler, at, 0, depth);
  }
  return max(lost * 0.25, 0.);
}
@fragment fn mainFragment(input: VertexOutput) -> Out {
  let f = find(input.position.xy);
  var out: Out;
  var color = textureLoad(still, f.texel, 0).rgb;
  if (f.depth <= 0.) {
    out.depth = 0.;
  } else {
    let c = shaderUniforms.seen * vec4f(f.at, 1.);
    out.depth = clamp(c.z / c.w, 0., 1.);
    if (shaderUniforms.shadowInfo.x > 0.) { color *= 1. - shaderUniforms.shadowInfo.x * sunLost(f.at); }
  }
  out.color = vec4f(color, 1.);
  return out;
}`;

// Each headlight's cone, as the box on the screen round it: six corners a
// beam, read off the beam's place in the list, none if it is off.
const BEAM_VERTEX = wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) @interpolate(flat) beam: u32, };
@vertex fn mainVertex(input: VertexInput, @builtin(vertex_index) vi: u32) -> VertexOutput {
  var out: VertexOutput;
  let b = vi / 6u;
  out.beam = b;
  out.position = vec4f(2., 2., 0., 1.);
  let at = beams[b * 3u];
  let light = beams[b * 3u + 1u];
  if (dot(light.rgb, vec3f(1.)) <= 0.) { return out; }
  let ahead = normalize(beams[b * 3u + 2u].xyz);
  let side = normalize(cross(ahead, vec3f(0., 0., 1.)) + vec3f(1e-5, 0., 0.));
  let up = cross(side, ahead);
  let spread = tan(acos(light.w));
  var lo = vec2f(1e9);
  var hi = vec2f(-1e9);
  for (var i = 0; i < 5; i++) {
    var p = at.xyz;
    if (i > 0) {
      let s = select(-1., 1., (i & 1) == 1);
      let u = select(-1., 1., i > 2);
      p += at.w * (ahead + spread * (s * side + u * up));
    }
    let c = shaderUniforms.seen * vec4f(p, 1.);
    let q = c.xy / max(c.w, 1e-4);
    lo = min(lo, q);
    hi = max(hi, q);
  }
  let k = vi % 6u;
  let x = select(lo.x, hi.x, k == 1u || k == 4u || k == 5u);
  let y = select(lo.y, hi.y, k == 2u || k == 3u || k == 5u);
  out.position = vec4f(x, y, 0., 1.);
  return out;
}`;

// A headlight on the picture: the surface under the pixel, its slope from
// the picture's depth beside it, lit as a spot light lights it.
const BEAM_FRAGMENT = wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) @interpolate(flat) beam: u32, };
${FIND}
fn along(f: Found, step: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(still));
  let fore = pictureAt(clamp(f.texel + step, vec2i(0), size - 1)) - f.at;
  let back = f.at - pictureAt(clamp(f.texel - step, vec2i(0), size - 1));
  return select(back, fore, dot(fore, fore) < dot(back, back));
}
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4f {
  let f = find(input.position.xy);
  if (f.depth <= 0.) { discard; }
  let at = beams[input.beam * 3u];
  let light = beams[input.beam * 3u + 1u];
  let ahead = normalize(beams[input.beam * 3u + 2u].xyz);
  let toLight = at.xyz - f.at;
  let d2 = dot(toLight, toLight);
  let range = at.w;
  if (d2 >= range * range) { discard; }
  let L = toLight / max(sqrt(d2), 1e-4);
  var N = normalize(cross(along(f, vec2i(1, 0)), along(f, vec2i(0, 1))));
  if (dot(N, f.eye - f.at) < 0.) { N = -N; }
  let fall = d2 / (range * range);
  let near = saturate(1. - fall * fall);
  let cone = saturate((dot(-ahead, L) - light.w) / max(1. - light.w, 0.001));
  let radiance = light.rgb * near * near / max(d2, 1e-4) * cone * cone;
  // The surface's own colour: the picture is it in the sky's light alone.
  let albedo = textureLoad(still, f.texel, 0).rgb / shaderUniforms.sky;
  return vec4f(albedo * max(dot(N, L), 0.) * radiance / 3.14159265, 1.);
}`;

export interface Still {
  /** Draw a frame: the still picture first, if it is due (`always`, to
   *  see what it costs), then the live things over it. `draw` renders the
   *  scene once. */
  frame(now: number, draw: () => void, always?: boolean): void;
  /** The sun, whose shadows of moving things stay off the picture and are
   *  laid over it, taking the sun's `share` of the light away; and the
   *  `sky`'s light, which the night's picture is a surface's colour in. */
  sun(shadows: ShadowGenerator, light: { share: number; sky: { r: number; g: number; b: number } }): void;
  /** The headlights, kept off the picture and laid over it. */
  headlights(container: ClusteredLightContainer, lights: ClusteredSpotLight[]): void;
}

/** The game's camera, as the still picture's is: a free camera at a target. */
type Eye = ReturnType<typeof createFreeCamera>;

/** Set up before the scene is registered: the picture's pass is a task of
 *  the scene's frame graph, which records its tasks then. */
export function createStill(engine: EngineContext, scene: SceneContext): Still {
  const surface = engine.surfaces[0];
  const picture = createSurfaceRenderTargetTexture(
    engine,
    { lbl: "still", format: surface.format, dFormat: "depth24plus", samples: 1, size: { surface, scale: 1 + 2 * MARGIN } },
    withSampledDepthTexture,
  );
  const eye = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
  const stillTask = createRenderTask({ name: "still", rt: picture.rt, cam: eye, keep: (m) => !lives.has(m) }, engine, scene);
  addTaskAtStart(scene, stillTask);
  stillTask.enabled = false;
  // The scene's own pass draws only what is live, over the picture.
  const tasks = (getFrameGraph(scene) as unknown as { _tasks: RenderTask[] })._tasks;
  const main = tasks.find((t) => t.name === "scene")!;
  (main._config as { keep?: (m: Mesh) => boolean }).keep = (m) => lives.has(m);

  const shown = createShaderMaterial({
    name: "still",
    vertexSource: SCREEN,
    fragmentSource: SHOWN,
    attributes: ["position"],
    uniforms: [...VIEW_UNIFORMS, { name: "shadowMatrix", type: "mat4x4<f32>" }, { name: "shadowInfo", type: "vec4<f32>" }],
    samplers: [
      ...PICTURE,
      { name: "shadowNow", viewDimension: "2d-array", comparison: true },
      { name: "shadowStill", viewDimension: "2d-array", comparison: true },
    ],
    backFaceCulling: false,
    depthWrite: true,
    depthCompare: "always",
  });
  const lit = createShaderMaterial({
    name: "stillBeams",
    vertexSource: BEAM_VERTEX,
    fragmentSource: BEAM_FRAGMENT,
    attributes: ["position"],
    uniforms: [...VIEW_UNIFORMS, { name: "sky", type: "vec3<f32>" }],
    samplers: [...PICTURE],
    storageBuffers: [{ name: "beams", type: "array<vec4<f32>>" }],
    backFaceCulling: false,
    depthWrite: false,
    depthCompare: "always",
    needAlphaBlending: true,
    blendMode: "additive",
  });
  const both: ShaderMaterial[] = [shown, lit];
  const bind = () => {
    for (const m of both) setShaderTexture(m, "still", picture.texture), setShaderTexture(m, "stillDepth", picture.depthTexture!);
  };
  bind();
  onRenderTargetTextureResize(picture, () => (bind(), stale()));

  const quad = live(meshOf(engine, "still", { positions: [-1, -1, 0, 3, -1, 0, -1, 3, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }));
  quad.material = shown;
  // First of all: the live things are drawn over it.
  quad.renderOrder = -Number.MAX_VALUE;
  addToScene(scene, quad);

  let shadows: ShadowGenerator | null = null;
  let light = { share: 0, sky: { r: 1, g: 1, b: 1 } };
  let [shadowNow, shadowStill]: (Texture2D | null)[] = [null, null];
  /** The sun's share taken by a shadow, the map's size and a texel of it, and how dark its shadows are. */
  const shadowInfo = [0, 1, 1, 0];

  let beams: { container: ClusteredLightContainer; lights: ClusteredSpotLight[]; data: Float32Array; buffer: ReturnType<typeof createStorageBuffer>; on: boolean } | null = null;
  const held: number[] = [];

  const camera = () => scene.camera as Eye;
  // When the picture was last drawn, from where, and what of the scene it held.
  let [drawn, from, content] = [-Infinity, "", ""];
  const view = () => {
    const c = camera();
    return `${c.position.x},${c.position.y},${c.position.z},${c.fov},${surface.canvas.width},${surface.canvas.height}`;
  };
  const holding = () => `${(scene as unknown as { _renderableVersion: number })._renderableVersion},${_vis}`;
  let lastView = "";

  /** The picture's eye where the game's is, a margin wider. */
  function aim(now: number) {
    const c = camera();
    eye.position.set(c.position.x, c.position.y, c.position.z);
    eye.target.set(c.target.x, c.target.y, c.target.z);
    eye.nearPlane = c.nearPlane;
    eye.farPlane = c.farPlane;
    // As much wider as the picture is taller than the screen, so the
    // screen's pixels are the picture's, a margin in.
    eye.fov = 2 * Math.atan(Math.tan(c.fov / 2) * (picture.rt._height / Math.max(1, surface.canvas.height)));
    const vp = getViewProjectionMatrix(eye, picture.rt._width / Math.max(1, picture.rt._height));
    const inverse = Array.from(invertMat4(vp) ?? vp);
    for (const m of both) setShaderUniform(m, "stillView", Array.from(vp)), setShaderUniform(m, "stillInverse", inverse);
    [drawn, from] = [now, view()];
  }

  /** The headlights off, for the picture, and on again as they were. */
  function hold(on: boolean) {
    if (!beams) return;
    const { lights, container } = beams;
    if (on) for (let i = 0; i < lights.length; i++) (held[i] = lights[i].intensity), (lights[i].intensity = 0);
    else for (let i = 0; i < lights.length; i++) lights[i].intensity = held[i];
    markClusteredLightContainerDirty(container);
  }

  /** The headlights as they are now, for laying over the picture. */
  function pack() {
    if (!beams) return;
    const { lights, data } = beams;
    let any = false;
    data.fill(0);
    lights.forEach((l, i) => {
      if (l.intensity <= 0) return;
      any = true;
      const len = Math.hypot(...l.direction) || 1;
      const k = l.intensity;
      data.set([...l.position, l.range, l.diffuse[0] * k, l.diffuse[1] * k, l.diffuse[2] * k, Math.cos(Math.min(Math.max(l.angle, 0), Math.PI) / 2)], i * 12);
      data.set([l.direction[0] / len, l.direction[1] / len, l.direction[2] / len, 0], i * 12 + 8);
    });
    // Nothing to write while every headlight stays off.
    if (any || beams.on) updateStorageBuffer(engine, beams.buffer, data);
    beams.on = any;
  }

  /** The sun's map, and its still layer, bound as they now are. */
  function shade() {
    if (!shadows) return;
    const now = getCsmReceiverTexture(shadows);
    const still = getCsmStaticTexture(shadows) ?? now;
    if (now !== shadowNow) setShaderTexture(shown, "shadowNow", (shadowNow = now));
    if (still !== shadowStill) setShaderTexture(shown, "shadowStill", (shadowStill = still));
    const on = shadows._runtimeEnabledState?.enabled !== false && still !== now;
    shadowInfo[0] = on ? light.share * (1 - shadowInfo[3]) : 0;
    setShaderUniform(shown, "shadowInfo", shadowInfo);
    const { r, g, b } = light.sky;
    setShaderUniform(lit, "sky", [Math.max(r, 1e-3), Math.max(g, 1e-3), Math.max(b, 1e-3)]);
  }

  return {
    sun(s, l) {
      shadows = s;
      light = l;
      shade();
      // The map's place on the ground, as it is fitted each frame.
      onCsmReceiverUpdate(s, (data) => {
        setShaderUniform(shown, "shadowMatrix", Array.from(data.subarray(0, 16)));
        [shadowInfo[3], shadowInfo[1], shadowInfo[2]] = [data[72], data[73], data[74]];
      });
    },
    headlights(container, lights) {
      const data = new Float32Array(Math.max(1, lights.length) * 12);
      beams = { container, lights, data, buffer: createStorageBuffer(engine, data, "still-beams"), on: false };
      setShaderStorageBuffer(lit, "beams", beams.buffer);
      const corners = lights.length * 6;
      const cones = live(meshOf(engine, "stillBeams", { positions: new Array(corners * 3).fill(0), normals: new Array(corners * 3).fill(0), indices: Array.from({ length: corners }, (_, i) => i) }));
      cones.material = lit;
      // Over the picture, under the live things.
      cones.renderOrder = -Number.MAX_VALUE / 2;
      addToScene(scene, cones);
    },
    frame(now, render, always = false) {
      const c = scene.camera;
      if (!c) return render();
      const here = view();
      const moving = here !== lastView;
      lastView = here;
      const since = now - drawn;
      const due =
        always ||
        // Moved since it was drawn: now and then while moving, at once once it stops.
        (here !== from && (!moving || since >= MOVING_MS)) ||
        ((staleSince < Infinity || holding() !== content) && since >= CHANGED_MS) ||
        since >= EVERY_MS;
      if (due) {
        aim(now);
        stillTask.enabled = true;
        main.enabled = false;
        if (shadows) setShadowStaticOnly(shadows, true);
        hold(true);
        render();
        hold(false);
        if (shadows) setShadowStaticOnly(shadows, false);
        stillTask.enabled = false;
        main.enabled = true;
        // What changed as it was drawn is in it.
        content = holding();
        staleSince = Infinity;
      }
      const vp = getViewProjectionMatrix(c, surface.canvas.width / Math.max(1, surface.canvas.height));
      const inverse = Array.from(invertMat4(vp) ?? vp);
      for (const m of both) {
        setShaderUniform(m, "screen", [surface.canvas.width, surface.canvas.height]);
        setShaderUniform(m, "seen", Array.from(vp));
        setShaderUniform(m, "seenInverse", inverse);
      }
      shade();
      pack();
      render();
    },
  };
}
