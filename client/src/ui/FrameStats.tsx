import { createSignal, onCleanup, For } from "solid-js";
import { EngineInstrumentation, SceneInstrumentation } from "@babylonjs/core";
import { useEngine } from "../engine/Canvas";

const UPDATE_INTERVAL = 250;

/**
 * Where a frame actually goes. The point is to separate CPU from GPU: if CPU
 * frame time is a couple of ms while frames still take 16ms+, no amount of
 * JavaScript work — or moving it to a worker — will help.
 *
 * Mounted inside <Canvas> so it can reach the engine. Instrumentation is not
 * free, so unmount it when not profiling.
 */
export default function FrameStats() {
  const { engine, scene } = useEngine();

  const si = new SceneInstrumentation(scene);
  si.captureFrameTime = true;
  si.captureRenderTime = true;
  si.captureInterFrameTime = true;
  si.captureActiveMeshesEvaluationTime = true;
  // Isolates the shadow map: it is the only render target in this scene.
  si.captureRenderTargetsRenderTime = true;

  const ei = new EngineInstrumentation(engine);
  // Needs timestamp-query support; stays 0 where the backend will not report it.
  ei.captureGPUFrameTime = true;

  // Dev-only handle so perf hypotheses can be A/B'd against a live scene.
  if (import.meta.env.DEV) {
    Object.assign(window, { __scene: scene, __engine: engine });
  }

  const [rows, setRows] = createSignal<[string, string][]>([]);

  const ms = (v: number) => `${v.toFixed(2)}ms`;
  const interval = setInterval(() => {
    const gpu = ei.gpuFrameTimeCounter.lastSecAverage / 1e6; // ns -> ms
    const casters =
      scene.lights.reduce(
        (n, l) => n + (l.getShadowGenerator()?.getShadowMap()?.renderList?.length ?? 0),
        0,
      );

    setRows([
      ["fps", engine.getFps().toFixed(0)],
      ["cpu frame", ms(si.frameTimeCounter.lastSecAverage)],
      ["  render", ms(si.renderTimeCounter.lastSecAverage)],
      ["  shadow rt", ms(si.renderTargetsRenderTimeCounter.lastSecAverage)],
      ["  mesh eval", ms(si.activeMeshesEvaluationTimeCounter.lastSecAverage)],
      ["inter-frame", ms(si.interFrameTimeCounter.lastSecAverage)],
      ["gpu frame", gpu > 0 ? ms(gpu) : "n/a"],
      ["draw calls", String(si.drawCallsCounter.lastSecAverage.toFixed(0))],
      ["active meshes", String(scene.getActiveMeshes().length)],
      ["total meshes", String(scene.meshes.length)],
      ["lights", String(scene.lights.length)],
      ["shadow casters", String(casters)],
    ]);
  }, UPDATE_INTERVAL);

  onCleanup(() => {
    clearInterval(interval);
    si.dispose();
    ei.dispose();
  });

  return (
    <div class="fixed top-3 left-3 z-50 p-3 rounded-xl bg-black/60 backdrop-blur-md text-[11px] font-mono text-white/80 select-none pointer-events-none">
      <div class="text-[9px] uppercase tracking-widest text-white/40 mb-2">frame</div>
      <For each={rows()}>
        {([k, v]) => (
          <div class="flex justify-between gap-6">
            <span class="text-white/50 whitespace-pre">{k}</span>
            <span class="tabular-nums">{v}</span>
          </div>
        )}
      </For>
    </div>
  );
}
