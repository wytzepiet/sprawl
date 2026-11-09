import type { Mesh } from "./mesh";
import type { Scene } from "./scene";
import { drawScene } from "./frame";
import { stats, writeDirtyMaterials } from "./pass";
import { writeShaderUniforms } from "./shader";

/** A canvas drawn to: the page's, or the studio's off the page. */
export interface Surface {
  engine: Engine;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  maxDevicePixelRatio: number;
  _scenes: Scene[];
}

export interface Engine {
  _device: GPUDevice;
  surfaces: Surface[];
  drawCallCount: number;
  gpuFrameTimeMs: number;
  _dirtyMeshes: Set<Mesh>;
  _timer: Timer | null;
  _timing: boolean;
  /** Pipelines by their composed key, built once for the engine. */
  _pipelines: Map<string, GPURenderPipeline | null>;
  /** Pipelines still being built: what waits on them (the studio) waits on this. */
  _building: number;
  /** What it did, summed: pipelines, bundles, pictures, relights, and their JS ms. */
  stats: Record<string, number>;
}

interface Timer {
  set: GPUQuerySet;
  resolve: GPUBuffer;
  read: GPUBuffer;
  busy: boolean;
}

export async function createEngine(canvas: HTMLCanvasElement, opts: { maxDevicePixelRatio?: number } = {}): Promise<Engine> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU: no adapter");
  const timed = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: timed ? ["timestamp-query"] : [] });
  device.addEventListener("uncapturederror", (e) => console.error("[renderer] GPU:", (e as GPUUncapturedErrorEvent).error.message));
  const engine: Engine = {
    _device: device,
    surfaces: [],
    drawCallCount: 0,
    gpuFrameTimeMs: 0,
    _dirtyMeshes: new Set(),
    _timer: null,
    _timing: false,
    _pipelines: new Map(),
    _building: 0,
    stats,
  };
  const surface = createSurface(engine, canvas, { alphaMode: "opaque" });
  surface.maxDevicePixelRatio = opts.maxDevicePixelRatio ?? 2;
  if (timed) {
    engine._timer = {
      set: device.createQuerySet({ type: "timestamp", count: 2 }),
      resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      busy: false,
    };
  }
  return engine;
}

export function createSurface(engine: Engine, canvas: HTMLCanvasElement | OffscreenCanvas, opts: { alphaMode?: GPUCanvasAlphaMode } = {}): Surface {
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device: engine._device, format, alphaMode: opts.alphaMode ?? "premultiplied" });
  const surface: Surface = { engine, canvas, context, format, maxDevicePixelRatio: 1, _scenes: [] };
  engine.surfaces.push(surface);
  return surface;
}

/** Each page canvas sized to its box at its ratio. */
export function resizeEngine(engine: Engine): void {
  for (const s of engine.surfaces) {
    const c = s.canvas;
    if (!("clientWidth" in c)) continue;
    const ratio = Math.min(devicePixelRatio, s.maxDevicePixelRatio);
    const [w, h] = [Math.max(1, Math.floor(c.clientWidth * ratio)), Math.max(1, Math.floor(c.clientHeight * ratio))];
    if (c.width === w && c.height === h) continue;
    [c.width, c.height] = [w, h];
  }
}

/** The client resizes each frame itself (`resizeEngine`). */
export const enableSurfaceResizeObserver = (_surface: Surface) => () => {};

export const isGpuTimingSupported = (engine: Engine) => !!engine._timer;
export const setGpuTimingEnabled = (engine: Engine, on: boolean) => void (engine._timing = on && !!engine._timer);
export const waitForGpuIdle = (engine: Engine) => engine._device.queue.onSubmittedWorkDone();
export const disposeEngine = (engine: Engine) => engine._device.destroy();

/** One frame of the given surfaces, in one submit. */
export function renderFrame(engine: Engine, _delta: number, surfaces: readonly Surface[] = engine.surfaces): void {
  const device = engine._device;
  engine.drawCallCount = 0;
  for (const m of engine._dirtyMeshes) m._flush();
  engine._dirtyMeshes.clear();
  writeDirtyMaterials(engine);
  writeShaderUniforms(engine);
  const encoder = device.createCommandEncoder();
  const timer = engine._timing && !engine._timer!.busy ? engine._timer! : null;
  if (timer) encoder.beginComputePass({ timestampWrites: { querySet: timer.set, beginningOfPassWriteIndex: 0 } }).end();
  for (const surface of surfaces) {
    if (!surface._scenes.length) continue;
    const target = surface.context.getCurrentTexture();
    for (const scene of surface._scenes) drawScene(scene, encoder, target);
  }
  if (timer) {
    encoder.beginComputePass({ timestampWrites: { querySet: timer.set, endOfPassWriteIndex: 1 } }).end();
    encoder.resolveQuerySet(timer.set, 0, 2, timer.resolve, 0);
    encoder.copyBufferToBuffer(timer.resolve, 0, timer.read, 0, 16);
  }
  device.queue.submit([encoder.finish()]);
  if (timer) {
    timer.busy = true;
    timer.read.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(timer.read.getMappedRange());
        const ms = Number(t[1] - t[0]) / 1e6;
        if (ms >= 0 && ms < 1000) engine.gpuFrameTimeMs = ms;
        timer.read.unmap();
        timer.busy = false;
      },
      () => (timer.busy = false),
    );
  }
}
