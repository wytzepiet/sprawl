import { Color4, Constants, Effect, PostProcess, RenderTargetTexture, Texture, type AbstractEngine, type Camera, type Scene } from "@babylonjs/core";
import { viewExtent } from "./view";

/**
 * The wash reads the sky at four rings of taps, each three times further
 * than the last, out to this many tiles: a kerb only shadows the nearest
 * ring, a tall building reaches the furthest.
 */
const RADIUS = 2.4;
/** How dark the foot of a wall gets, 0 to 1. A corner gets half again as dark. */
const STRENGTH = 0.25;
/**
 * A neighbour hides its part of the sky fully when it rises this many
 * tiles for every tile away: so a shadow reaches out in proportion to the
 * height of what casts it.
 */
const SLOPE = 0.5;
/**
 * A step in the surface this tall, in tiles, is inked, in full by a quarter
 * again. A road's border stands 0.025 off the ground, 0.015 off a terrain
 * patch, and is outlined; the patch itself at 0.01, or a field at 0.008, is
 * not.
 */
const JUMP = 0.012;
/**
 * How wide a line is, in pixels on the screen, whatever the step and its
 * angle: LINE when the view is ZOOM tiles from middle to top, growing as
 * the scene does but damped by the power GROWTH, so a view twice as close
 * draws the line a third wider rather than twice. Never under a pixel.
 */
const LINE = 1.4;
const ZOOM = 16;
const GROWTH = 0.4;
/** Depth where nothing was drawn: far enough that it never hides anything. */
const EMPTY = 60000;

Effect.ShadersStore.penFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform vec2 tile;
uniform float tilePx;
uniform float radius;
uniform float slope;
uniform float strength;
uniform vec2 line;
uniform float jump;
uniform float grain;
uniform float inked;
// Depth is the camera-space z: smaller is nearer the camera, which looking
// straight down means taller.
void main() {
  vec4 scene = texture2D(textureSampler, vUV);
  float z = texture2DLodEXT(depthSampler, vUV, 0.0).r;

  // The wash: how much of this pixel's sky its taller neighbours hide.
  float occ = 0.0;
  float d = radius / 27.0;
  for (int ring = 0; ring < 4; ring++) {
    // Eight taps on a ring are far apart, and a sharp edge read at eight
    // points is eight copies of it. Read from the mip whose texels span the
    // gap between taps, each tap is the average of its patch and the copies
    // run together into a gradient.
    float lod = log2(max(d * tilePx * 0.5, 1.0));
    for (int i = 0; i < 8; i++) {
      float a = (float(i) + float(ring) * 0.25) * 0.7853982;
      float zt = texture2DLodEXT(depthSampler, vUV + vec2(cos(a), sin(a)) * tile * d, lod).r;
      // How steeply the neighbour rises, seen from here: the sky it hides.
      // Only a rise counts, so roof edges stay clean.
      occ += clamp((z - zt) / (d * slope), 0.0, 1.0);
    }
    d *= 3.0;
  }
  occ *= step(z, ${EMPTY / 2}.0) / 32.0;

  // The pen: a line where the surface steps. Across a flat surface — even a
  // tilted one — a pixel's depth is the mean of its neighbours', so the
  // second difference is zero; at a step it is the height of the step. Only
  // the far side of a step is inked, so the line lies just outside whatever
  // stands up, the way a pen outlines it. A seam where two pieces of one
  // surface meet has no step and no line.
  // Looked at across four directions, not two: across a step at an angle
  // the straight taps reach less far, and the line came out thinner on a
  // diagonal road than on a straight one.
  float step2 = 0.0;
  for (int k = 0; k < 4; k++) {
    float a = float(k) * 0.7853982;
    vec2 o = vec2(cos(a), sin(a)) * line;
    float a1 = texture2DLodEXT(depthSampler, vUV + o, 0.0).r;
    float a2 = texture2DLodEXT(depthSampler, vUV - o, 0.0).r;
    step2 = max(step2, 2.0 * z - a1 - a2);
  }
  // A step finer than the depth map can tell from rounding is not inked.
  float j = max(jump, z * grain);
  float ink = smoothstep(j, 1.25 * j, step2) * inked;

  gl_FragColor = vec4(scene.rgb * (1.0 - strength * occ) * (1.0 - ink), scene.a);
}`;

// FXAA, the short form: where the brightness changes across a pixel, blend
// along the edge rather than across it. Babylon's own FXAA does not draw
// under WebGPU here, so it is written the way this file's pen is.
Effect.ShadersStore.smoothFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 texel;
void main() {
  vec3 luma = vec3(0.299, 0.587, 0.114);
  vec3 nw = texture2D(textureSampler, vUV + vec2(-1.0, -1.0) * texel).rgb;
  vec3 ne = texture2D(textureSampler, vUV + vec2(1.0, -1.0) * texel).rgb;
  vec3 sw = texture2D(textureSampler, vUV + vec2(-1.0, 1.0) * texel).rgb;
  vec3 se = texture2D(textureSampler, vUV + vec2(1.0, 1.0) * texel).rgb;
  vec4 m = texture2D(textureSampler, vUV);
  float lnw = dot(nw, luma), lne = dot(ne, luma), lsw = dot(sw, luma), lse = dot(se, luma), lm = dot(m.rgb, luma);
  float lo = min(lm, min(min(lnw, lne), min(lsw, lse)));
  float hi = max(lm, max(max(lnw, lne), max(lsw, lse)));
  vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), (lnw + lsw) - (lne + lse));
  float reduce = max((lnw + lne + lsw + lse) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * texel;
  vec3 a = 0.5 * (texture2D(textureSampler, vUV - dir / 6.0).rgb + texture2D(textureSampler, vUV + dir / 6.0).rgb);
  vec3 b = 0.5 * a + 0.25 * (texture2D(textureSampler, vUV - dir * 0.5).rgb + texture2D(textureSampler, vUV + dir * 0.5).rgb);
  float lb = dot(b, luma);
  gl_FragColor = vec4(mix(b, a, float(lb < lo || lb > hi)), m.a);
}`;

/**
 * The town drawn in pen and wash, from a camera looking down on it: its depth
 * map is a height map, so a step in depth is something standing over
 * something else.
 *
 * The wash is ambient occlusion. Each pixel looks round itself at four rings
 * of taps and darkens by how much of its sky the taller ones hide — the
 * ground at the foot of a building, the floor between trees. No hemisphere,
 * no blur pass: the depth map's mips are the blur.
 *
 * The pen is a black line wherever the surface steps: round a crown over the
 * ground or over a lower crown, along the top and foot of a cliff, round a
 * building, a car, a road. Where two pieces of one surface meet — road
 * segments, cliff walls across a chunk edge — there is no step and no line,
 * which is why this is read off the depth rather than off the meshes' edges.
 * F7 lifts the pen.
 */
export function createPen(scene: Scene, engine: AbstractEngine, camera: Camera, canvas: HTMLCanvasElement) {
  // A step is read off the difference of neighbouring depths, which half a
  // float blurs to a sixteenth of a tile at the tilted camera's distance.
  // Full floats where they can be filtered, for the wash's mips.
  const caps = engine.getCaps();
  const type = caps.textureFloatLinearFiltering && caps.textureFloatRender ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_HALF_FLOAT;
  const map = new RenderTargetTexture(
    "pen_depth", { ratio: 1 }, scene, true, true, type, false,
    Texture.TRILINEAR_SAMPLINGMODE, true, false, false, Constants.TEXTUREFORMAT_RED,
  );
  const depth = scene.enableDepthRenderer(camera, false, type === Constants.TEXTURETYPE_FLOAT, Texture.TRILINEAR_SAMPLINGMODE, true, map);
  depth.clearColor = new Color4(EMPTY, 0, 0, 1);

  let inked = true;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "F7") inked = !inked;
  };
  window.addEventListener("keydown", onKey);

  // A half float rounds depth to about a thousandth of itself, and a
  // difference of three depths can gather a few of those.
  const grain = type === Constants.TEXTURETYPE_FLOAT ? 0 : 1 / 256;

  const pass = new PostProcess("pen", "pen", ["tile", "tilePx", "radius", "slope", "strength", "line", "jump", "grain", "inked"], ["depthSampler"], 1.0, camera);
  // First in the chain, so the scene renders into this pass's texture. Not
  // multisampled — four samples a pixel cost a fifth of the frame — so the
  // edges, the ink's among them, are smoothed after, by FXAA.
  pass.onApply = (effect) => {
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const halfH = viewExtent(scene, canvas).halfH;
    // A tile on screen, in render pixels and as a fraction of the screen.
    const tilePx = h / (2 * halfH);
    effect.setTexture("depthSampler", map);
    effect.setFloat2("tile", tilePx / w, tilePx / h);
    effect.setFloat("tilePx", tilePx);
    effect.setFloat("radius", RADIUS);
    effect.setFloat("slope", SLOPE);
    effect.setFloat("strength", STRENGTH);
    // Screen pixels to the render's, which a sharp display has more of.
    const px = Math.max(1, LINE * (ZOOM / halfH) ** GROWTH) / engine.getHardwareScalingLevel();
    effect.setFloat2("line", px / w, px / h);
    effect.setFloat("jump", JUMP);
    effect.setFloat("grain", grain);
    effect.setFloat("inked", inked ? 1 : 0);
  };
  const smooth = new PostProcess("smooth", "smooth", ["texel"], null, 1.0, camera);
  smooth.onApply = (effect) => effect.setFloat2("texel", 1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
  camera.detachPostProcess(smooth); // TEMP: comparing without FXAA

  return () => {
    window.removeEventListener("keydown", onKey);
    smooth.dispose(camera);
    pass.dispose(camera);
    scene.disableDepthRenderer(camera);
    map.dispose();
  };
}
