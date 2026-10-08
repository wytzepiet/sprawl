/**
 * A lab for the Babylon Lite fork: each of its additions on one small page.
 * Open /spike.html on the worktree's client (?night for the moon).
 *
 * - plugin attributes: tiles carry a per-instance `tileLook` (stripe, shine) and
 *   a box a per-vertex `edge` — no data hidden in the matrix
 * - a crown cut to a circle in CUSTOM_FRAGMENT_UPDATE_ALPHA: its shadow must be round
 * - PCF shadow bounds set from a box, not the casters
 * - the sky as a cube environment drawn here: +x red, +y green, +z (up) blue
 * - half-float and r8 pixel textures with mips, sampled by plugins
 */
import {
  addToScene,
  createCubeEnvironment,
  createDirectionalLight,
  createEngineWithFeatures,
  createFreeCamera,
  createMeshFromData,
  createPbrMaterial,
  createPcfDirectionalShadowGenerator,
  createSceneContext,
  createTexture2DFromPixels,
  enableMaterialPlugins,
  enableOrthographicCamera,
  enablePbrMaterialPluginVertexData,
  enablePixelTextureMipmaps,
  registerSceneWithShadowSupport,
  renderFrame,
  setMeshAttribute,
  setShadowGeneratorBounds,
  setShadowTaskCasterMeshes,
  setThinInstances,
  updateCubeEnvironment,
  type MaterialPlugin,
} from "@babylonjs/lite";

const log = (s: string) => ((document.getElementById("log")!.textContent += s + "\n"), console.log(s));
const q = new URLSearchParams(location.search);
const NIGHT = q.has("night");
const GAIN = Number(q.get("gain") ?? (NIGHT ? 0.05 : 1));

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = await createEngineWithFeatures(canvas, { requiredFeatures: ["float32-filterable"], msaaSamples: 1, maxDevicePixelRatio: 2 });
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.3, g: 0.35, b: 0.4, a: 1 };

const camera = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
camera.nearPlane = 1;
camera.farPlane = 100;
enableOrthographicCamera(camera, { halfHeight: 8 });
scene.camera = camera;

const sun = createDirectionalLight([-0.3, -0.5, -0.8]);
sun.diffuse = NIGHT ? [0.05, 0.06, 0.1] : [1.2, 1.1, 0.9];
sun.specular = [0, 0, 0];
if (q.has("nosun")) sun.intensity = 0;
// The shadow camera looks from the light's position: put it up the beam, above everything.
sun.position.x = 15; sun.position.y = 25; sun.position.z = 40;
addToScene(scene, sun);
const sg = createPcfDirectionalShadowGenerator(engine, sun, { mapSize: 2048, bias: 0.001, normalBias: 0.02 });
sun.shadowGenerator = sg;
setShadowGeneratorBounds(sg, [-9, -9, 0], [9, 9, 3]);

// Textures: an rg16float stripe table (half-float bits) and an r8 grain, both mipmapped.
await enablePixelTextureMipmaps();
const half = (v: number) => {
  const f = new Float32Array([v]);
  const b = new Uint32Array(f.buffer)[0];
  return ((b >>> 16) & 0x8000) | ((((b >>> 23) & 0xff) - 112) << 10) | ((b & 0x7fffff) >>> 13);
};
const stripes = createTexture2DFromPixels(engine, new Uint16Array([1, 0.2, 0.2, 1, 0.2, 0.6, 1, 1].map(half)), 4, 1, {
  format: "rg16float",
  mipmaps: true,
  minFilter: "linear",
  magFilter: "linear",
  addressModeU: "repeat",
});
const grain = createTexture2DFromPixels(engine, Uint8Array.from({ length: 64 * 64 }, () => 128 + 127 * Math.random()), 64, 64, {
  format: "r8unorm",
  mipmaps: true,
  minFilter: "linear",
  magFilter: "linear",
  addressModeU: "repeat",
  addressModeV: "repeat",
});

// Tiles: thin instances with a per-instance attribute.
const tilePlugin: MaterialPlugin = {
  name: "Tile",
  getAttributes: () => [{ name: "tileLook", type: "vec2<f32>", perInstance: true }],
  getVaryings: () => [{ name: "vTileLook", type: "vec2f" }, { name: "vTileAt", type: "vec2f" }],
  getSamplers: () => [
    { texture: "stripes", sampler: "stripesSampler" },
    { texture: "grain", sampler: "grainSampler" },
  ],
  bindTextures: (out) => out.push({ texture: stripes }, { texture: grain }),
  getCustomCode: (t) =>
    t === "vertex"
      ? { CUSTOM_VERTEX_MAIN_END: "out.vTileLook = tileLook; out.vTileAt = position.xy;" }
      : {
          CUSTOM_FRAGMENT_MAIN_BEGIN: "if (length(input.vTileAt - 0.5) > 0.6) { discard; }",
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
            "let st = textureSample(stripes, stripesSampler, vec2f(input.vTileLook.x / 4. + 0.125, 0.5)).rg; baseColor = vec3f(st, 0.4) * (0.5 + 0.5 * textureSample(grain, grainSampler, input.vTileAt).r); roughness = mix(roughness, 0.15, input.vTileLook.y);",
        },
};
const tileMat = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 0.9, plugins: [tilePlugin] });
const square = (z: number) =>
  createMeshFromData(engine, "square", new Float32Array([0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 2, 1, 0, 3, 2]), new Float32Array(8));
const tiles = square(0);
tiles.material = tileMat;
tiles.receiveShadows = true;
const N = 16;
const mats = new Float32Array(N * N * 16);
const looks = new Float32Array(N * N * 2);
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    mats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i - N / 2, j - N / 2, 0, 1], k * 16);
    looks.set([(i + j) % 4, i % 2], k * 2);
  }
setThinInstances(tiles, mats, N * N);
setMeshAttribute(engine, tiles, "tileLook", looks);
tiles.boundMin = [-N / 2, -N / 2, 0];
tiles.boundMax = [N / 2, N / 2, 0];
addToScene(scene, tiles);

// A box with a per-vertex attribute: how near each corner is to a face's edge, shaded darker.
const edgePlugin: MaterialPlugin = {
  name: "Edge",
  getAttributes: () => [{ name: "edge", type: "f32" }],
  getVaryings: () => [{ name: "vEdge", type: "f32" }],
  getCustomCode: (t) =>
    t === "vertex" ? { CUSTOM_VERTEX_MAIN_END: "out.vEdge = edge;" } : { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "baseColor = mix(vec3f(0.9, 0.5, 0.3), vec3f(0.2, 0.1, 0.1), input.vEdge);" },
};
const p: number[] = [], n: number[] = [], e: number[] = [], idx: number[] = [];
for (const [nn, u, v] of [
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
]) {
  const base = p.length / 3;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
    p.push(nn[0] + u[0] * a + v[0] * b, nn[1] + u[1] * a + v[1] * b, 1 + nn[2] + u[2] * a + v[2] * b);
    n.push(...nn);
    e.push(a === 0 ? 0 : 1);
  }
  idx.push(base, base + 4, base + 1, base + 1, base + 4, base + 2, base + 2, base + 4, base + 3, base + 3, base + 4, base);
}
const box = createMeshFromData(engine, "box", new Float32Array(p), new Float32Array(n), new Uint32Array(idx), new Float32Array((p.length / 3) * 2));
box.material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 0.6, plugins: [edgePlugin] });
setMeshAttribute(engine, box, "edge", new Float32Array(e));
box.receiveShadows = true;
box.position.x = -3;
addToScene(scene, box);

// A crown: a square cut to a circle where the shadow pass also cuts.
const crownPlugin: MaterialPlugin = {
  name: "Crown",
  getVaryings: () => [{ name: "vCrown", type: "vec2f" }],
  getCustomCode: (t) =>
    t === "vertex"
      ? { CUSTOM_VERTEX_MAIN_END: "out.vCrown = position.xy;" }
      : { CUSTOM_FRAGMENT_UPDATE_ALPHA: "if (length(input.vCrown) > 1.) { discard; }", CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "baseColor = vec3f(0.3, 0.6, 0.25);" },
};
const crown = createMeshFromData(engine, "crown", new Float32Array([-1, -1, 2, 1, -1, 2, 1, 1, 2, -1, 1, 2]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 2, 1, 0, 3, 2]), new Float32Array(8));
crown.material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 0.7, plugins: [crownPlugin] });
crown.position.x = 3;
crown.position.y = 2;
addToScene(scene, crown);

// A mirror, to see the sky's orientation in reflections.
const mirror = square(0.5);
mirror.material = createPbrMaterial({ metallicFactor: 1, roughnessFactor: 0.05, baseColorFactor: [1, 1, 1, 1] });
mirror.position.x = -7;
mirror.position.y = -7;
mirror.scaling.x = 3;
mirror.scaling.y = 3;
addToScene(scene, mirror);

setShadowTaskCasterMeshes(sg, [box, crown]);

// The sky, drawn here in Babylon's cube layout: +x red, +y green, +z (up) blue, a little grey all round.
const SIZE = 16;
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]], [[-1, 0, 0], [0, 0, 1], [0, -1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]], [[0, 0, 1], [1, 0, 0], [0, -1, 0]], [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
];
const faces = FACES.map(() => new Float32Array(SIZE * SIZE * 4));
const drawSky = (gain: number) => {
  FACES.forEach(([nn, ax, ay], f) => {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const u = ((x + 0.5) / SIZE) * 2 - 1, v = ((y + 0.5) / SIZE) * 2 - 1;
        const d = [0, 1, 2].map((k) => nn[k] + ax[k] * u + ay[k] * v);
        const l = Math.hypot(...d);
        faces[f].set([...d.map((c) => (Math.max(c / l, 0) * 2 + 0.05) * gain), 1], (y * SIZE + x) * 4);
      }
  });
};
drawSky(GAIN);
const sky = createCubeEnvironment(scene, faces, { size: SIZE });

// ?stress=N: N more meshes like a chunk's, to time adding one after registration.
const STRESS = Number(q.get("stress") ?? 0);
const chunk = () => {
  const m = square(0);
  m.material = tileMat;
  m.receiveShadows = true;
  setThinInstances(m, mats.slice(0, 16 * 16), 16);
  setMeshAttribute(engine, m, "tileLook", looks.slice(0, 32));
  m.boundMin = [-8, -8, 0];
  m.boundMax = [8, 8, 0];
  addToScene(scene, m);
  return m;
};
for (let i = 0; i < STRESS; i++) chunk();

enableMaterialPlugins(scene);
enablePbrMaterialPluginVertexData();
await registerSceneWithShadowSupport(scene);
log("registered");

let last = performance.now();
let frames = 0;
let gain = GAIN;
let held = false;
const loop = (now: number) => {
  frames++;
  if (!held) renderFrame(engine, now - last);
  last = now;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
setInterval(() => ((document.getElementById("log")!.dataset.fps = String(frames)), (frames = 0)), 1000);
(window as unknown as { spike: unknown }).spike = {
  engine,
  scene,
  camera,
  sun,
  sg,
  /** Dim or brighten the sky, to see the environment follow. */
  sky(g: number) {
    gain = g;
    drawSky(gain);
    updateCubeEnvironment(sky, faces);
  },
  bounds: setShadowGeneratorBounds,
  /** Add one chunk-like mesh after registration; resolves with the main thread's time on it. */
  async add(n = 1) {
    let busy = 0;
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => (busy += e.duration)));
    obs.observe({ type: "longtask" });
    held = true;
    for (let i = 0; i < n; i++) chunk();
    // The next frames, drawn here and timed, until the build has landed and settled.
    const frames: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const a = performance.now();
      renderFrame(engine, 16);
      frames.push(+(performance.now() - a).toFixed(2));
    }
    const wall = performance.now() - t0;
    held = false;
    obs.disconnect();
    return { frames: frames.filter((f) => f > 0.5), max: Math.max(...frames), wall: +wall.toFixed(0), longtasks: +busy.toFixed(1), meshes: scene.meshes.length };
  },
  /** Mean ms of renderFrame over n frames, the loop held. */
  async frame(n = 120, pan = false) {
    let t = 0;
    held = true;
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (pan) {
        camera.position.x = Math.sin(i / 20) * 3;
        camera.target.x = camera.position.x;
        setShadowGeneratorBounds(sg, [camera.position.x - 9, -9, 0], [camera.position.x + 9, 9, 3]);
      }
      const a = performance.now();
      renderFrame(engine, 16);
      t += performance.now() - a;
    }
    held = false;
    return +(t / n).toFixed(3);
  },
};
