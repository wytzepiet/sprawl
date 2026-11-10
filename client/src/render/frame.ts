import { createFreeCamera, getViewMatrix, getViewProjectionMatrix, invertMat4 } from "@babylonjs/lite";
import { FORWARD_GROUP, SCENE_BYTES, SCENE_OFFSETS, TILE } from "./compose";
import { COMPOSITE, FRAME_FLOATS, FRAME_OFFSETS, RELIGHT } from "./deferred";
import { brdfLut } from "./env";
import type { Mesh } from "./mesh";
import { count, DrawList, layoutOf, type Targets } from "./pass";
import type { Scene, ShadowGenerator } from "./scene";
import { runTasks } from "./shader";
import { mark, timing } from "./engine";

/** A mesh's kind: its name with its chunk taken out (`cost.ts`'s). */
const kindOf = (m: Mesh) => m.name.replace(/-?\d+(\.\d+)?/g, "").replace(/[,#]+/g, "").replace(/_+/g, "_");

/**
 * A scene's frame (docs/renderer-design.md, "The frame"). Where the still
 * picture is ours (`scene._isStill`): the still meshes into a G-buffer a
 * margin wider than the screen, only when the view or they changed; that lit
 * into a linear picture, again as the sun moves; and every frame that
 * picture slid to where the view is, what moves shading and lighting it,
 * tone mapped into the screen, and the live meshes drawn forward over it.
 * Otherwise (the studio) every mesh forward, every frame.
 */
interface GBuffer {
  albedo: GPUTexture;
  normal: GPUTexture;
  extra: GPUTexture;
  depth: GPUTexture;
}

export interface Frame {
  draw(encoder: GPUCommandEncoder, target: GPUTexture): void;
  drawn(): { mesh: Mesh }[];
  meshChanged(mesh: Mesh, drawn: boolean): void;
  castersChanged(): void;
}

/** The picture's margin past each edge of the screen, as a share of it (`still.ts`'s). */
const MARGIN = 0.12;
/** While the view moves the picture is slid, and drawn again only as the
 *  screen nears its edge or zooms in on it, at most this often. */
const [EDGE, ZOOMED, MOVING_MS] = [0.95, 1.25, 50];
const knobs = new URLSearchParams(globalThis.location?.search ?? "");
/** The sun moves the light on the picture this often (`?relight=<ms>`). */
const RELIGHT_MS = Number(knobs.get("relight") ?? 1000);
/** The picture's size against the screen's (`?pictureScale=`). */
const SCALE = Number(knobs.get("pictureScale") ?? 1) * (1 + 2 * MARGIN);
/** A picture is drawn over this many frames (`?spread=`), half as many
 *  while the view moves (the screen is past the edge of the last in some
 *  five frames at a pan's fastest), its meshes a share each, into a
 *  G-buffer of its own while the last is shown: a town's picture is 30 ms
 *  of a desktop card's time, and drawn in one frame it dropped frames. */
const SPREAD = Math.max(1, Number(knobs.get("spread") ?? 6));
/** A picture for something built or taken away, the view still, over
 *  `CHANGED` frames: begun the frame after, unless what is changing is
 *  still being made (`holdPicture`: the town's paving comes from a worker
 *  a moment after a road's asphalt, and one shown without the other
 *  flashed); then once it is made, or once the change has waited
 *  `STALE_MS`, so a road drawn tile by tile is seen as it goes, and a town
 *  streaming in, a change every frame, is drawn four times a second. */
const [CHANGED, STALE_MS] = [3, 250];

/** Since when something still has changed that no picture begun since holds. */
let staleSince = Infinity;
/** What says it is still being made, and a picture of a change waits for. */
const making = new Set<() => boolean>();
export function holdPicture(busy: () => boolean): () => void {
  making.add(busy);
  return () => void making.delete(busy);
}
/** Something still has changed that the renderer was not told of: the picture is drawn again soon. */
export function stalePicture() {
  staleSince = Math.min(staleSince, performance.now());
}
/** The next picture is drawn whatever (the bench's cost meter). */
let forced = false;
export const forcePicture = () => void (forced = true);

const SHADOW: Targets = { colors: [], depth: "depth32float", depthWrite: true, depthCompare: "less-equal" };
const GBUFFER: Targets = { colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }, { format: "rgba8unorm" }], depth: "depth32float", depthWrite: true, depthCompare: "greater-equal" };
const forwardTo = (format: GPUTextureFormat): Targets => ({ colors: [{ format }], depth: "depth32float", depthWrite: true, depthCompare: "greater-equal" });

const LIGHT_FLOATS = 12;
const MAX_LIGHTS = 512;

export function drawScene(scene: Scene, encoder: GPUCommandEncoder, target: GPUTexture) {
  (scene._frame ??= makeFrame(scene)).draw(encoder, target);
}

/** A scene UBO (compose.ts's `Scene`) and its group 0. */
function sceneUbo(device: GPUDevice) {
  const buffer = device.createBuffer({ size: SCENE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new Float32Array(SCENE_BYTES / 4);
  const group = device.createBindGroup({ layout: layoutOf(device, { entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }] }), entries: [{ binding: 0, resource: { buffer } }] });
  return {
    group,
    data,
    set: (name: string, v: ArrayLike<number>) => data.set(v, SCENE_OFFSETS.get(name)! / 4),
    write: () => device.queue.writeBuffer(buffer, 0, data),
  };
}

function makeFrame(scene: Scene): Frame {
  const engine = scene.engine;
  const device = engine._device;
  const surface = scene.surface;
  const deferred = () => !!scene._isStill;
  const stays = (m: Mesh) => !scene._isStill || scene._isStill(m);
  let gen: ShadowGenerator | null = null;
  const casts = (m: Mesh) => !!gen?.casters.has(m);
  const shown = (m: Mesh) => m.visible && !!m.material;

  // The uniforms: the camera's, the picture's eye's, the sun's; and the frame's own.
  const [camera, eyeUbo, sunUbo] = [sceneUbo(device), sceneUbo(device), sceneUbo(device)];
  const frameData = new Float32Array(FRAME_FLOATS);
  const frameBuffer = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const put = (name: string, v: ArrayLike<number>) => frameData.set(v, FRAME_OFFSETS.get(name)!);
  const lightData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  const lightBuffer = device.createBuffer({ size: lightData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let [lamps, beams, lightsSeen] = [0, 0, -1];
  /** The lights by the screen's tiles, for the composite and the forward
   *  pass; the lamps by the picture's, for the relight. */
  const [screenBins, pictureBins] = [binner(device, lightData), binner(device, lightData)];

  // The targets, made as their sizes say.
  const texture = (w: number, h: number, format: GPUTextureFormat, layers = 1) =>
    device.createTexture({ size: [w, h, layers], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  let maps: { size: number; still: GPUTexture; live: GPUTexture } | null = null;
  /** Two G-buffers: the one shown, `sets[front]`, and the next, drawn into
   *  over the frames (`SPREAD`); and the light on the one shown. */
  let picture: { w: number; h: number; sets: GBuffer[]; lit: GPUTexture } | null = null;
  let front = 0;
  /** The next picture as it is drawn: the meshes in it so far, and the frames left. */
  let next: { done: Set<Mesh>; frames: number; vp: Float32Array; eye: number[] } | null = null;
  let screen: { w: number; h: number; depth: GPUTexture } | null = null;
  const compare = device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" });
  const linear = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
  const clamped = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const blankSky = device.createTexture({ size: [1, 1, 6], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
  const lut = brdfLut(engine);
  const arrayView = (t: GPUTexture) => t.createView({ dimension: "2d-array" });
  const layerView = (t: GPUTexture) => t.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 });

  // The forward pass's group 3, and the relight's and composite's group, made again when what they bind is new.
  let resources: { key: string; forward: GPUBindGroup; relight: GPUBindGroup[]; composite: GPUBindGroup[] } | null = null;
  const FORWARD_LAYOUT = layoutOf(device, FORWARD_GROUP);
  const deferredEntries = (lit: boolean): GPUBindGroupLayoutEntry[] => [
    { binding: 0, visibility: 2, buffer: { type: "uniform" } },
    ...[1, 2, 3].map((binding) => ({ binding, visibility: 2, texture: { sampleType: "unfilterable-float" as const } })),
    { binding: 4, visibility: 2, texture: { sampleType: "depth" } },
    { binding: 5, visibility: 2, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 6, visibility: 2, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 7, visibility: 2, sampler: { type: "comparison" } },
    { binding: 8, visibility: 2, buffer: { type: "read-only-storage" } },
    { binding: 9, visibility: 2, texture: { viewDimension: "cube" } },
    { binding: 10, visibility: 2, sampler: {} },
    { binding: 11, visibility: 2, texture: {} },
    { binding: 12, visibility: 2, sampler: {} },
    ...(lit ? [{ binding: 13, visibility: 2, texture: { sampleType: "unfilterable-float" as const } }] : []),
    { binding: 14, visibility: 2, buffer: { type: "read-only-storage" } },
  ];
  const [RELIGHT_LAYOUT, COMPOSITE_LAYOUT] = [layoutOf(device, { entries: deferredEntries(false) }), layoutOf(device, { entries: deferredEntries(true) })];
  const fullscreen = (code: string, layout: GPUBindGroupLayout, format: GPUTextureFormat, depth: boolean) => {
    const module = device.createShaderModule({ code });
    count("pipelines", 1);
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      ...(depth ? { depthStencil: { format: "depth32float" as const, depthWriteEnabled: true, depthCompare: "always" as const } } : {}),
    });
  };
  let relightPipeline: GPURenderPipeline | null = null;
  let compositePipeline: GPURenderPipeline | null = null;

  function bindResources() {
    const sky = scene._env?.view ?? blankSky.createView({ dimension: "cube" });
    const key = [maps?.still.label, maps?.size, picture?.w, picture?.h, scene._env?.texture.label, !!scene._env, screenBins.buffer.size, pictureBins.buffer.size].join();
    if (resources?.key === key) return;
    const [still, live] = [arrayView(maps!.still), arrayView(maps!.live)];
    const common = [
      { binding: 5, resource: still },
      { binding: 6, resource: live },
      { binding: 7, resource: compare },
      { binding: 8, resource: { buffer: lightBuffer } },
      { binding: 9, resource: sky },
      { binding: 10, resource: linear },
      { binding: 11, resource: lut },
      { binding: 12, resource: clamped },
    ];
    const gbuffers = (picture?.sets ?? []).map((g) => [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: g.albedo.createView() },
      { binding: 2, resource: g.normal.createView() },
      { binding: 3, resource: g.extra.createView() },
      { binding: 4, resource: g.depth.createView() },
    ]);
    resources = {
      key,
      forward: device.createBindGroup({ layout: FORWARD_LAYOUT, entries: [...common.map((e) => ({ binding: e.binding - 5, resource: e.resource })), { binding: 8, resource: { buffer: screenBins.buffer } }] }),
      relight: gbuffers.map((g) => device.createBindGroup({ layout: RELIGHT_LAYOUT, entries: [...g, ...common, { binding: 14, resource: { buffer: pictureBins.buffer } }] })),
      composite: gbuffers.map((g) => device.createBindGroup({ layout: COMPOSITE_LAYOUT, entries: [...g, ...common, { binding: 13, resource: picture!.lit.createView() }, { binding: 14, resource: { buffer: screenBins.buffer } }] })),
    };
    forward.dirty = true;
  }

  // What each pass draws.
  const ordered = (wants: (m: Mesh) => boolean) =>
    function* (): Iterable<[Mesh, unknown]> {
      const list = scene.meshes.filter(wants).sort((a, b) => a.renderOrder - b.renderOrder);
      for (const m of list) yield [m, m.material];
    };
  const wants = {
    shadowStill: (m: Mesh) => shown(m) && casts(m) && stays(m),
    shadowLive: (m: Mesh) => shown(m) && casts(m) && !stays(m),
    gbuffer: (m: Mesh) => deferred() && shown(m) && stays(m),
    forward: (m: Mesh) => shown(m) && (!deferred() || !stays(m)),
  };
  const shadowStill = new DrawList(engine, "shadow", SHADOW, ordered(wants.shadowStill), () => [sunUbo.group]);
  const shadowLive = new DrawList(engine, "shadow", SHADOW, ordered(wants.shadowLive), () => [sunUbo.group]);
  const gbuffer = new DrawList(engine, "gbuffer", GBUFFER, ordered(wants.gbuffer), () => [eyeUbo.group]);
  const forward = new DrawList(engine, "forward", forwardTo(surface.format), ordered(wants.forward), () => [camera.group, resources!.forward]);
  const lists: [DrawList, (m: Mesh) => boolean][] = [
    [shadowStill, wants.shadowStill],
    [shadowLive, wants.shadowLive],
    [gbuffer, wants.gbuffer],
    [forward, wants.forward],
  ];

  // When each layer is due.
  let staticDue = true;
  /** A still caster changed: the still map is drawn again with the next picture. */
  let castersDue = true;
  /** A live caster changed, or the sun's map moved: the live map is drawn again. */
  let liveDue = true;
  let relightDue = true;
  let [drawnAt, from, lastView, relitAt] = [-Infinity, "", "", -Infinity];
  let fit: { dir: number[]; version: number; matrix: Float32Array; caster: Float32Array } | null = null;
  let stillVp: Float32Array | null = null;
  const eye = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }) as any;

  /** The sun's map fitted to the client's box, as Lite fits it (csm-shadow-task-hooks.ts). */
  function refit(g: ShadowGenerator): boolean {
    const d = g._light.direction;
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    let [dx, dy, dz] = [d.x / len, d.y / len, d.z / len];
    const moved = !fit || Math.acos(Math.min(1, Math.max(-1, dx * fit.dir[0]! + dy * fit.dir[1]! + dz * fit.dir[2]!))) > g.refitAngle;
    if (fit && !moved && fit.version === g.version) return false;
    const b = g.bounds;
    if (!b) return false;
    if (Math.abs(dy) >= 1) dz = 1e-13;
    const corners = Array.from({ length: 8 }, (_, k) => [b[k & 1 ? 3 : 0]!, b[k & 2 ? 4 : 1]!, b[k & 4 ? 5 : 2]!]);
    const c = [0, 1, 2].map((i) => corners.reduce((s, p) => s + p[i]!, 0) / 8);
    const view = lightView(dx, dy, dz, c[0]!, c[1]!, c[2]!);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of corners) {
      for (let i = 0; i < 3; i++) {
        const v = view[i]! * p[0]! + view[4 + i]! * p[1]! + view[8 + i]! * p[2]! + view[12 + i]!;
        lo[i] = Math.min(lo[i]!, v);
        hi[i] = Math.max(hi[i]!, v);
      }
    }
    const at = lightView(dx, dy, dz, c[0]! + dx * lo[2]!, c[1]! + dy * lo[2]!, c[2]! + dz * lo[2]!);
    const m = ortho(at, lo[0]!, hi[0]!, lo[1]!, hi[1]!, 0, hi[2]! - lo[2]!);
    const half = g.mapSize / 2;
    for (const i of [12, 13]) m[i] = m[i]! + (Math.round(m[i]! * half) - m[i]! * half) / half;
    const caster = m.slice();
    caster[14] = caster[14]! + g.bias * 0.5;
    fit = { dir: [dx, dy, dz], version: g.version, matrix: m, caster };
    return true;
  }

  /** Whether the picture still holds the screen: each corner of it, on the
   *  ground, inside the picture short of its edge, not zoomed in past a blur. */
  function holds(inverse: ArrayLike<number>): boolean {
    if (!stillVp) return false;
    const at = (m: ArrayLike<number>, x: number, y: number, z: number) => {
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      return [0, 1, 2].map((i) => (m[i]! * x + m[4 + i]! * y + m[8 + i]! * z + m[12 + i]!) / w);
    };
    const xs: number[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const [a, b] = [at(inverse, x, y, 0), at(inverse, x, y, 1)];
      const t = a[2]! / (a[2]! - b[2]!);
      if (!(t > 0) || !Number.isFinite(t)) return false;
      const p = at(stillVp, a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, 0);
      if (Math.abs(p[0]!) > EDGE || Math.abs(p[1]!) > EDGE) return false;
      xs.push(p[0]!);
    }
    return ((Math.max(...xs) - Math.min(...xs)) / 2) * SCALE * ZOOMED > 1;
  }

  /** The common fields of a scene UBO. */
  function common(u: ReturnType<typeof sceneUbo>, vp: ArrayLike<number>, view: ArrayLike<number>, w: number, h: number, now: number) {
    const cam = scene.camera;
    const sun = gen?._light ?? scene.lights[0];
    const ip = scene.imageProcessing;
    u.set("viewProjection", vp);
    u.set("view", view);
    u.set("vEyePosition", [cam.position.x, cam.position.y, cam.position.z, 1]);
    u.set("vImageInfos", [ip.exposure, ip.contrast ?? 1, 0.8, 1]);
    if (sun) {
      const d = sun.direction;
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      u.set("sunDir", [-d.x / len, -d.y / len, -d.z / len, 0]);
      u.set("sunColor", [sun.diffuse[0] * sun.intensity, sun.diffuse[1] * sun.intensity, sun.diffuse[2] * sun.intensity, 0]);
    }
    if (scene._env) u.set("sh", scene._env.sh);
    u.set("time", [now / 1000, 0, 0, 0]);
    u.set("screen", [w, h, 1 / w, 1 / h]);
    if (fit) u.set("shadowMatrix", fit.matrix);
    u.set("shadowInfo", [gen?.enabled ? 0 : 1, gen?.mapSize ?? 1, 1 / (gen?.mapSize ?? 1), 0]);
  }

  /** The lamps and headlights lit now, packed: lamps first, then headlights. */
  function pack() {
    const c = scene._container;
    if (!c || c.version === lightsSeen) return;
    lightsSeen = c.version;
    let n = 0;
    const add = (l: { position: number[]; diffuse: number[]; range: number; intensity: number }, dir: number[] | null, angle: number) => {
      if (!(l.intensity > 0 && l.range > 0) || n >= MAX_LIGHTS) return false;
      const len = dir ? Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1 : 1;
      lightData.set([l.position[0]!, l.position[1]!, l.position[2]!, l.range, l.diffuse[0]!, l.diffuse[1]!, l.diffuse[2]!, l.intensity], n * LIGHT_FLOATS);
      lightData.set(dir ? [dir[0]! / len, dir[1]! / len, dir[2]! / len, Math.cos(Math.min(Math.max(angle, 0), Math.PI) / 2)] : [0, 0, -1, -1], n * LIGHT_FLOATS + 8);
      n++;
      return true;
    };
    for (const l of c.points) add(l, null, 0);
    const lampCount = n;
    for (const l of c.spots) add(l, l.direction, l.angle);
    [lamps, beams] = [lampCount, n - lampCount];
    if (n) device.queue.writeBuffer(lightBuffer, 0, lightData, 0, n * LIGHT_FLOATS);
  }

  function sizeTargets(w: number, h: number) {
    const size = gen?.mapSize ?? 1;
    if (!maps || maps.size !== size) {
      maps?.still.destroy();
      maps?.live.destroy();
      maps = { size, still: texture(size, size, "depth32float"), live: texture(size, size, "depth32float") };
      maps.still.label = `still-${Math.random()}`;
      const clear = device.createCommandEncoder();
      for (const t of [maps.still, maps.live]) clear.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: layerView(t), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } }).end();
      device.queue.submit([clear.finish()]);
      staticDue = liveDue = true;
    }
    if (!screen || screen.w !== w || screen.h !== h) {
      screen?.depth.destroy();
      screen = { w, h, depth: texture(w, h, "depth32float") };
    }
    const [pw, ph] = [Math.round(w * SCALE), Math.round(h * SCALE)];
    if (deferred() && (!picture || picture.w !== pw || picture.h !== ph)) {
      if (picture) for (const t of [...picture.sets.flatMap((g) => [g.albedo, g.normal, g.extra, g.depth]), picture.lit]) t.destroy();
      const set = (): GBuffer => ({ albedo: texture(pw, ph, "rgba8unorm"), normal: texture(pw, ph, "rgba8unorm"), extra: texture(pw, ph, "rgba8unorm"), depth: texture(pw, ph, "depth32float") });
      picture = { w: pw, h: ph, sets: [set(), set()], lit: texture(pw, ph, "rgba16float") };
      [from, next, stillVp] = ["", null, null];
    }
    bindResources();
  }

  const shadowPass = (encoder: GPUCommandEncoder, map: GPUTexture, list: DrawList) => {
    const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: layerView(map), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    list.draw(pass);
    pass.end();
  };

  return {
    drawn: () => {
      const all = new Set<Mesh>();
      for (const [l] of lists) for (const m of l.drawn) all.add(m);
      return [...all].map((mesh) => ({ mesh }));
    },
    meshChanged(mesh, drawn) {
      if (drawn) for (const [list, want] of lists) if (list.drawn.has(mesh) || want(mesh)) list.dirty = true;
      if (!stays(mesh)) return void (liveDue ||= casts(mesh));
      if (casts(mesh)) castersDue = true;
      if (deferred()) stalePicture();
    },
    castersChanged() {
      shadowStill.dirty = shadowLive.dirty = true;
      castersDue = liveDue = true;
    },

    draw(encoder, target) {
      const cam = scene.camera;
      const [w, h] = [target.width, target.height];
      const now = performance.now();
      const g = scene.lights.find((l) => l.shadowGenerator)?.shadowGenerator ?? null;
      if (g !== gen) (gen = g), g && (g._scene = scene), this.castersChanged();
      sizeTargets(w, h);
      const clear = scene.clearColor;
      if (!cam) {
        encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: clear }] }).end();
        return;
      }
      const began = now;
      const vp = Float32Array.from(getViewProjectionMatrix(cam, w / h) as ArrayLike<number>);
      const inverse = Float32Array.from((invertMat4(vp as never) ?? vp) as ArrayLike<number>);
      pack();
      screenBins.fill(vp, w, h, lamps, beams);
      bindResources();

      // The picture, when due.
      const here = `${cam.position.x},${cam.position.y},${cam.position.z},${cam.fov},${w},${h}`;
      const moving = here !== lastView;
      lastView = here;
      const since = now - drawnAt;
      const due = deferred() && (forced || (moving ? since >= MOVING_MS && !holds(inverse) : here !== from || (staleSince <= now && (now - staleSince >= STALE_MS || ![...making].some((busy) => busy())))));

      // The sun's maps: the still one as the sun turns, and as what casts
      // changed, with the picture that shows it; the live one as what moves does.
      if (gen && refit(gen)) staticDue = liveDue = true;
      if (castersDue && (due || !deferred())) [staticDue, castersDue] = [true, false];
      if (fit) {
        common(sunUbo, fit.caster, fit.matrix, w, h, now);
        sunUbo.write();
      }
      const shadowing = !!gen?.enabled && !!fit;
      if (shadowing && staticDue) {
        staticDue = false;
        shadowPass(encoder, maps!.still, shadowStill);
        mark(engine, "stillShadow");
        relightDue = true;
        engine._drew = Math.max(engine._drew, 2);
        count("stillShadows", 1);
      }
      if (shadowing && deferred() && liveDue) {
        liveDue = false;
        shadowPass(encoder, maps!.live, shadowLive);
        mark(engine, "liveShadow");
        count("liveShadows", 1);
      }

      common(camera, vp, getViewMatrix(cam) as ArrayLike<number>, w, h, now);
      camera.write();
      runTasks(scene, encoder, camera.group, () => resources!.forward, w, h);
      mark(engine, "tasks");

      if (!deferred()) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: clear }],
          depthStencilAttachment: { view: screen!.depth.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
        });
        forward.draw(pass);
        pass.end();
        return;
      }

      // The next picture begun when due, the first at once; then a share
      // of its meshes each frame, and shown once all are in.
      if (due && !next) {
        count(forced ? "picture.forced" : here !== from ? "picture.moved" : "picture.changed");
        staleSince = Infinity;
        [drawnAt, from] = [now, here];
        eye.position.set(cam.position.x, cam.position.y, cam.position.z);
        eye.target.set(cam.target.x, cam.target.y, cam.target.z);
        eye.nearPlane = cam.nearPlane;
        eye.farPlane = cam.farPlane;
        eye.fov = 2 * Math.atan(Math.tan(cam.fov / 2) * (picture!.h / h));
        const vp = Float32Array.from(getViewProjectionMatrix(eye, picture!.w / picture!.h) as ArrayLike<number>);
        common(eyeUbo, vp, getViewMatrix(eye) as ArrayLike<number>, picture!.w, picture!.h, now);
        eyeUbo.write();
        next = { done: new Set(), frames: forced || !stillVp ? 1 : here === from ? CHANGED : moving ? Math.ceil(SPREAD / 2) : SPREAD, vp, eye: [cam.position.x, cam.position.y, cam.position.z, 1] };
        forced = false;
      }
      if (next) {
        const t0 = performance.now();
        const g = picture!.sets[1 - front]!;
        const first = !next.done.size;
        const { some, left } = gbuffer.share(next.done, next.frames--);
        // Timed, each mesh in a pass of its own, its time told by its kind.
        const each = timing(engine) ? some.map((m) => [m]) : [some];
        each.forEach((group, i) => {
          const load = first && i === 0 ? ("clear" as const) : ("load" as const);
          const pass = encoder.beginRenderPass({
            colorAttachments: [g.albedo, g.normal, g.extra].map((t) => ({ view: t.createView(), loadOp: load, storeOp: "store" as const, clearValue: [0, 0, 0, 0] })),
            depthStencilAttachment: { view: g.depth.createView(), depthClearValue: 0, depthLoadOp: load, depthStoreOp: "store" },
          });
          gbuffer.drawSome(pass, group);
          pass.end();
          mark(engine, each.length > 1 ? `g.${kindOf(group[0]!)}` : "gbuffer");
        });
        engine._drew = 3;
        count("gbufferMs", performance.now() - t0);
        if (!left) {
          front = 1 - front;
          stillVp = next.vp;
          put("stillView", stillVp);
          put("stillInverse", (invertMat4(stillVp as never) ?? stillVp) as ArrayLike<number>);
          put("eye", next.eye);
          next = null;
          relightDue = true;
          scene._pictured();
          count("gbuffer", 1);
        }
      }

      // The frame's uniforms, then the relight when due.
      const sun = gen?._light ?? scene.lights[0];
      const ip = scene.imageProcessing;
      put("seen", vp);
      put("seenInverse", inverse);
      if (fit) put("shadowMatrix", fit.matrix);
      if (sun) {
        const d = sun.direction;
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        put("sunDir", [-d.x / len, -d.y / len, -d.z / len, 0]);
        put("sunColor", [sun.diffuse[0] * sun.intensity, sun.diffuse[1] * sun.intensity, sun.diffuse[2] * sun.intensity, 0]);
      }
      put("shadowInfo", [shadowing ? 0 : 1, gen?.mapSize ?? 1, 1 / (gen?.mapSize ?? 1), 0]);
      put("image", [ip.exposure, ip.contrast ?? 1, 0.8, 0]);
      put("screen", [w, h, 0, 0]);
      put("clear", [clear.r, clear.g, clear.b, 1]);
      if (scene._env) put("sh", scene._env.sh);
      device.queue.writeBuffer(frameBuffer, 0, frameData);
      if (relightDue || now - relitAt >= RELIGHT_MS) {
        const t0 = performance.now();
        relightDue = false;
        relitAt = now;
        relightPipeline ??= fullscreen(RELIGHT, RELIGHT_LAYOUT, "rgba16float", false);
        pictureBins.fill(stillVp!, picture!.w, picture!.h, lamps, 0);
        bindResources();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: picture!.lit.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(relightPipeline);
        pass.setBindGroup(0, resources!.relight[front]!);
        pass.draw(3);
        pass.end();
        mark(engine, "relight");
        engine._drew = Math.max(engine._drew, 1);
        count("relights", 1);
        count("relightMs", performance.now() - t0);
      }

      // The composite, then what moves over it, in one pass.
      compositePipeline ??= fullscreen(COMPOSITE, COMPOSITE_LAYOUT, surface.format, true);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: clear }],
        depthStencilAttachment: { view: screen!.depth.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      pass.setPipeline(compositePipeline);
      pass.setBindGroup(0, resources!.composite[front]!);
      pass.draw(3);
      engine.drawCallCount++;
      forward.draw(pass);
      pass.end();
      count("frames", 1);
      count("frameMs", performance.now() - began);
    },
  };
}

/**
 * Lights by the tiles of a target they may reach (compose.ts's `binsAt`):
 * the box round each light's reach, seen through `vp`, marks the tiles it
 * covers, so a pixel loops over its tile's few lights, not all of them.
 * `lights` holds `lamps` then `beams`, `LIGHT_FLOATS` apiece.
 */
function binner(device: GPUDevice, lights: Float32Array) {
  let data = new Uint32Array(0);
  let buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let rects = new Int32Array(0);
  let cursor = new Uint32Array(0);
  /** The tiles last written with no lights at all: nothing to write while none come. */
  let emptyFor = -1;
  return {
    get buffer() {
      return buffer;
    },
    fill(vp: ArrayLike<number>, w: number, h: number, lamps: number, beams: number) {
      const [tx, ty] = [Math.ceil(w / TILE), Math.ceil(h / TILE)];
      const tiles = tx * ty;
      const n = lamps + beams;
      if (!n && emptyFor === tiles) return;
      if (rects.length < n * 4) rects = new Int32Array(n * 8);
      if (cursor.length < tiles * 2) cursor = new Uint32Array(tiles * 2);
      cursor.fill(0, 0, tiles * 2);
      // Each light's tiles, and how many each tile has of lamps and of headlights.
      for (let i = 0; i < n; i++) {
        const [px, py, pz, r] = [lights[i * LIGHT_FLOATS]!, lights[i * LIGHT_FLOATS + 1]!, lights[i * LIGHT_FLOATS + 2]!, lights[i * LIGHT_FLOATS + 3]!];
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let k = 0; k < 8; k++) {
          const [x, y, z] = [px + (k & 1 ? r : -r), py + (k & 2 ? r : -r), pz + (k & 4 ? r : -r)];
          const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
          if (cw <= 1e-6) {
            [x0, y0, x1, y1] = [-Infinity, -Infinity, Infinity, Infinity];
            break;
          }
          const sx = ((vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!) / cw) * 0.5 + 0.5;
          const sy = 0.5 - ((vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!) / cw) * 0.5;
          [x0, x1, y0, y1] = [Math.min(x0, sx * w), Math.max(x1, sx * w), Math.min(y0, sy * h), Math.max(y1, sy * h)];
        }
        const at = i * 4;
        [rects[at], rects[at + 1], rects[at + 2], rects[at + 3]] = [Math.max(0, Math.floor(x0 / TILE)), Math.max(0, Math.floor(y0 / TILE)), Math.min(tx - 1, Math.floor(x1 / TILE)), Math.min(ty - 1, Math.floor(y1 / TILE))];
        const kind = i < lamps ? 0 : 1;
        for (let y = rects[at + 1]!; y <= rects[at + 3]!; y++) for (let x = rects[at]!; x <= rects[at + 2]!; x++) cursor[(y * tx + x) * 2 + kind]!++;
      }
      // The headers, then each tile's lamps and headlights after them.
      let total = tiles * 4;
      for (let t = 0; t < tiles; t++) total += cursor[t * 2]! + cursor[t * 2 + 1]!;
      if (data.length < total) {
        data = new Uint32Array(2 ** Math.ceil(Math.log2(total)));
        buffer.destroy();
        buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      }
      let next = tiles * 4;
      for (let t = 0; t < tiles; t++) {
        const [l, b] = [cursor[t * 2]!, cursor[t * 2 + 1]!];
        [data[t * 4], data[t * 4 + 1], data[t * 4 + 2], data[t * 4 + 3]] = [next, l, b, 0];
        [cursor[t * 2], cursor[t * 2 + 1]] = [next, next + l];
        next += l + b;
      }
      for (let i = 0; i < n; i++) {
        const at = i * 4;
        const kind = i < lamps ? 0 : 1;
        for (let y = rects[at + 1]!; y <= rects[at + 3]!; y++) for (let x = rects[at]!; x <= rects[at + 2]!; x++) data[cursor[(y * tx + x) * 2 + kind]!++] = i;
      }
      device.queue.writeBuffer(buffer, 0, data, 0, total);
      emptyFor = n ? -1 : tiles;
    },
  };
}

/** Lite's `buildLightViewMatrixInto`: looking along the light from `p`. */
function lightView(fx: number, fy: number, fz: number, px: number, py: number, pz: number): Float32Array {
  const [ux0, uy0, uz0] = Math.abs(fy) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  let [rx, ry, rz] = [uy0 * fz - uz0 * fy, uz0 * fx - ux0 * fz, ux0 * fy - uy0 * fx];
  const r = Math.hypot(rx, ry, rz) || 1;
  [rx, ry, rz] = [rx / r, ry / r, rz / r];
  const [ux, uy, uz] = [fy * rz - fz * ry, fz * rx - fx * rz, fx * ry - fy * rx];
  return new Float32Array([rx, ux, fx, 0, ry, uy, fy, 0, rz, uz, fz, 0, -(rx * px + ry * py + rz * pz), -(ux * px + uy * py + uz * pz), -(fx * px + fy * py + fz * pz), 1]);
}

/** Lite's `orthoViewInto`: an off-centre orthographic projection times an affine view. */
function ortho(view: Float32Array, l: number, r: number, b: number, t: number, n: number, f: number): Float32Array {
  const [sx, sy, sz] = [2 / (r - l), 2 / (t - b), 1 / (f - n)];
  const [tx, ty, tz] = [-(r + l) / (r - l), -(t + b) / (t - b), -n / (f - n)];
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const w = view[i + 3]!;
    out[i] = sx * view[i]! + tx * w;
    out[i + 1] = sy * view[i + 1]! + ty * w;
    out[i + 2] = sz * view[i + 2]! + tz * w;
    out[i + 3] = w;
  }
  return out;
}
