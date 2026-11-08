import { setMeshVisible, setShadowGeneratorEnabled, type EngineContext, type Mesh, type SceneContext } from "@babylonjs/lite";
import { frameKnobs } from "./Canvas";
import { isStill, stillKnobs } from "./still";

/** `?gpu`: switches for what a frame at rest draws, to watch a GPU meter
 *  by, and how many frames and redraws of the picture a second. A
 *  diagnosis, not a feature: it goes once the answer is known. */
export function gpuPanel(engine: EngineContext, scene: SceneContext, timed: boolean) {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:12px;bottom:90px;z-index:99;background:#000;color:#fff;font:13px/1.4 system-ui;padding:10px;border-radius:12px;display:flex;flex-direction:column;gap:4px;max-height:70vh;overflow:auto";
  const rate = document.createElement("div");
  box.append(rate);
  const toggle = (label: string, set: (on: boolean) => void) => {
    const b = document.createElement("button");
    let on = true;
    const show = () => ((b.textContent = `${on ? "●" : "○"} ${label}`), (b.style.opacity = on ? "1" : "0.5"));
    b.style.cssText = "all:unset;cursor:pointer;padding:2px 0";
    b.onclick = () => ((on = !on), set(on), show());
    show();
    box.append(b);
  };
  toggle("frames 30 a second at rest (off: 5)", (on) => (frameKnobs.stillFps = on ? 30 : 5));
  toggle("town redrawn for the sun twice a second", (on) => (stillKnobs.everyMs = on ? 500 : Infinity));
  const sun = scene.lights.map((l) => l.shadowGenerator).find((g) => !!g);
  if (sun) toggle("sun's shadow map", (on) => setShadowGeneratorEnabled(sun, on));
  // What is drawn every frame, by kind: a mesh's name without its chunk.
  const kinds = new Map<string, Mesh[]>();
  for (const m of scene.meshes.filter((m) => !isStill(m))) {
    const kind = m.name.replace(/-?\d+(\.\d+)?/g, "").replace(/[,#_]+/g, "_");
    kinds.set(kind, [...(kinds.get(kind) ?? []), m]);
  }
  for (const [kind, meshes] of kinds) toggle(`${kind} (${meshes.length})`, (on) => meshes.forEach((m) => setMeshVisible(m, on)));
  const cpu = document.createElement("div");
  rate.after(cpu);
  let [frames, redraws] = [frameKnobs.frames, stillKnobs.redraws];
  setInterval(() => {
    rate.textContent = `${frameKnobs.frames - frames} frames/s · ${stillKnobs.redraws - redraws} redraws/s`;
    // The main thread's second: what its frames took, the longest, and how
    // often the screen waited over 50 ms for it (anything at all blocking it).
    cpu.textContent = `${timed ? `gpu ${engine.gpuFrameTimeMs.toFixed(1)} ms/frame · ` : ""}js ${Math.round(frameKnobs.busyMs)} ms/s · worst ${Math.round(frameKnobs.worstMs)} ms · ${frameKnobs.stalls} stalls >50 ms`;
    [frames, redraws] = [frameKnobs.frames, stillKnobs.redraws];
    Object.assign(frameKnobs, { busyMs: 0, worstMs: 0, stalls: 0 });
  }, 1000);
  document.body.append(box);
}
