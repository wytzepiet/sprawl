import { addTask, buildFrameGraphTask, getFrameGraph, type EngineContext, type SceneContext, type Task } from "@babylonjs/lite";
import type { Layer, Palette, Pane } from "~ui/paint";

/**
 * The UI's black, drawn by the GPU over the frame: the bezel round the
 * game, and everything the UI holds grown out of it, as a phone's island
 * grows out of the black round its screen.
 *
 * The UI says where the black is: each `glass` of the UI the GPU draws
 * (`ui/paint.ts`) is a pane. Panes of one layer (`layer="bezel"`) run
 * together like liquid, a smooth union of their shapes, so what touches
 * the bezel grows out of it with a fillet where they meet; panes of
 * different layers do not. A pane with a `hole` is black all round its
 * box, the box its hole: the frame. A dye lays a colour into a pane.
 *
 * The layers lie in the order the UI's tree gives them: a later layer is
 * drawn over an earlier one, with its shadow on it, and what the UI writes
 * on a layer over its panes (a stack of cards, `ui/stack.tsx`).
 *
 * Each frame the frame loop reads the panes (`read`), after the springs
 * have moved them, and again once the camera has moved, for what is
 * pinned to the map, before the frame is drawn. Then, after the scene,
 * this task draws each run of panes over it: black, a faint sheen just
 * inside its edge, and a soft shade on the town where it slips under.
 */

/** The most panes, and runs of them, drawn. */
const PANES = 64;
const RUNS = 16;
/** How far panes melt into each other, in CSS pixels: the fillet where an island leaves the bezel. */
const MELT = 26;
/** How dark the shade is that the black lays on the town, and how far it reaches, in CSS pixels. */
const SHADE = 0.24;
const REACH = 10;
/** Room round a run, in CSS pixels, for its shade. */
const ROOM = 48;
/** How far a press's light spreads through the black, in CSS pixels. */
const GLOW = 40;

/** The black and what is written on it: white ink, a black shadow. */
export const palette: Palette = { tint: [0.035, 0.035, 0.04], text: [1, 1, 1], ink: [0, 0, 0] };

const WGSL = /* wgsl */ `
struct Pane { box: vec4f, round: vec4f, dye: vec4f }
struct Run { first: u32, count: u32, pad0: u32, pad1: u32 }
struct Black {
  panes: array<Pane, ${PANES}>,
  runs: array<Run, ${RUNS}>,
  tint: vec4f,
  size: vec4f,
  touch: vec4f,
}
@group(0) @binding(0) var<uniform> black: Black;

struct Out { @builtin(position) position: vec4f, @location(0) @interpolate(flat) run: u32 }
@vertex fn whole(@builtin(vertex_index) i: u32, @builtin(instance_index) run: u32) -> Out {
  var corners = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: Out;
  out.position = vec4f(corners[i], 0, 1);
  out.run = run;
  return out;
}

fn box(p: vec2f, pane: Pane) -> f32 {
  let r = pane.round.x;
  let q = abs(p - pane.box.xy) - pane.box.zw + r;
  let d = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - r;
  // A frame is black outside its box; a pane fading out sinks into the
  // rest rather than blinking.
  return select(d, -d, pane.round.w > 0.5) + (1 - pane.round.y) * pane.round.z;
}

struct Field { d: f32, dye: vec4f }
fn field(p: vec2f, run: Run) -> Field {
  let k = black.size.w;
  var f = Field(1e6, vec4f(0));
  for (var i = run.first; i < run.first + run.count; i++) {
    let pane = black.panes[i];
    if (pane.round.y <= 0.002) { continue; }
    let d = box(p, pane);
    // Smooth union (Inigo Quilez's polynomial): melt within k.
    let h = clamp(0.5 + 0.5 * (f.d - d) / k, 0, 1);
    f.d = mix(f.d, d, h) - k * h * (1 - h);
    // The dye melts as the shapes do: a pane's colour to its edge,
    // blended only where it runs into another.
    f.dye = mix(f.dye, pane.dye, h);
  }
  return f;
}

@fragment fn pane(in: Out) -> @location(0) vec4f {
  let run = black.runs[in.run];
  let p = in.position.xy;
  let f = field(p, run);
  let dpr = black.size.z;

  // Outside: the shade it lays on the town, a little below, as if the
  // town lay just under it.
  if (f.d > 0.5) {
    let s = field(p - vec2f(0, 2 * dpr), run).d;
    let shade = ${SHADE} * exp(-max(s, 0) / (${REACH} * dpr));
    return vec4f(0, 0, 0, shade);
  }

  var body = black.tint.rgb;
  // A dye is the colour itself, flat and bright on the black.
  body = mix(body, f.dye.rgb / max(f.dye.a, 1e-3), f.dye.a);
  // A faint sheen just inside the edge, as a screen's glass catches it.
  body += vec3f(0.06) * exp(-max(-f.d, 0) / (1.4 * dpr)) * (1 - 0.5 * f.dye.a);
  // Pressed, it lifts a little under the finger.
  let toTouch = p - black.touch.xy;
  let glow = black.touch.z * exp(-dot(toTouch, toTouch) / (2 * black.touch.w * black.touch.w));
  body += vec3f(0.07) * glow;

  let cover = clamp(0.5 - f.d, 0, 1);
  return vec4f(body * cover, cover);
}
`;

/** The panes as last read, in CSS pixels, with their rounding, and a key
 *  that changes when any of them moves: an overlay at rest draws again. */
const glazed: { x: number; y: number; w: number; h: number; r: number; hole?: boolean }[] = [];
let glazedKey = "";
export const glazedAt = () => glazedKey;

/**
 * Take the black out of a flat overlay over the page, the hand's dots,
 * the plot in hand, the interchange's lights: the black is drawn in the
 * frame, under the page, so what an overlay draws would lie on it. `ctx`
 * is in CSS pixels.
 */
export function underGlass(ctx: CanvasRenderingContext2D) {
  if (!glazed.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  ctx.beginPath();
  for (const p of glazed) if (!p.hole) ctx.roundRect(p.x, p.y, p.w, p.h, p.r);
  ctx.fill();
  // A frame's black is all round its hole.
  for (const p of glazed.filter((p) => p.hole)) {
    ctx.beginPath();
    ctx.rect(-1e4, -1e4, 2e4 + p.x + p.w, 2e4 + p.y + p.h);
    ctx.roundRect(p.x, p.y, p.w, p.h, p.r);
    ctx.fill("evenodd");
  }
  ctx.restore();
}

/** The black's task, after the scene, and how to read the panes. `ui` is
 *  the UI the GPU draws (`ui/paint.ts`): each of its layers drawn on its
 *  own panes. */
export function createGlass(engine: EngineContext, scene: SceneContext, ui: { read(): Layer[]; ink(pass: GPURenderPassEncoder, l: Layer): void }) {
  const device = engine._device;
  const surface = engine.surfaces[0];
  const module = device.createShaderModule({ label: "black", code: WGSL });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] });
  const pipeline = device.createRenderPipeline({
    label: "black",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "whole" },
    fragment: {
      module,
      entryPoint: "pane",
      targets: [{ format: surface.format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
    },
  });

  // The uniforms: panes (box, round, dye: 12 floats), runs (4 u32), then three vec4s.
  const floats = PANES * 12 + RUNS * 4 + 3 * 4;
  const data = new Float32Array(floats);
  const ints = new Uint32Array(data.buffer);
  const uniforms = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }] });

  // A press on the UI, which lights the black (`touchAt`).
  const touch = { x: 0, y: 0, down: false, glow: 0, at: performance.now() };

  // The runs of panes this frame, in device pixels, each with room round
  // it; and the UI's layers, each drawn on its run, if it has one, with
  // what lies on it.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  let runs: Box[] = [];
  let groups: { run: number; layer: Layer }[] = [];
  let seen = "";

  /** Read the UI's panes: their boxes, rounding, fade and dye. Returns a
   *  key that changes when any of them moved. */
  const read = (): string => {
    const canvas = surface.canvas as HTMLCanvasElement;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    data.fill(0);
    runs = [];
    groups = [];
    glazed.length = 0;
    let i = 0;
    let key = "";
    /** A run of panes that melt together, into the uniforms; whether there was room. */
    const run = (panes: Pane[]) => {
      if (runs.length === RUNS) return false;
      const first = i;
      const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of panes) {
        if (i === PANES) break;
        glazed.push({ x: p.x, y: p.y, w: p.w, h: p.h, r: p.r, hole: p.hole });
        const [hx, hy] = [(p.w / 2) * dpr, (p.h / 2) * dpr];
        const o = i * 12;
        data[o] = (p.x + p.w / 2) * dpr;
        data[o + 1] = (p.y + p.h / 2) * dpr;
        data[o + 2] = hx;
        data[o + 3] = hy;
        data[o + 4] = Math.min(p.r * dpr, hx, hy);
        data[o + 5] = p.fade;
        data[o + 6] = Math.min(hx, hy);
        data[o + 7] = p.hole ? 1 : 0;
        const dye = p.dye ? hexRgb(p.dye) : null;
        if (dye) data.set([...dye, 1], o + 8);
        // A frame reaches every edge of the screen.
        box.x0 = Math.min(box.x0, p.hole ? 0 : p.x * dpr);
        box.y0 = Math.min(box.y0, p.hole ? 0 : p.y * dpr);
        box.x1 = Math.max(box.x1, p.hole ? canvas.width : (p.x + p.w) * dpr);
        box.y1 = Math.max(box.y1, p.hole ? canvas.height : (p.y + p.h) * dpr);
        key += `${Math.round(data[o])},${Math.round(data[o + 1])},${Math.round(hx)},${Math.round(hy)},${p.fade.toFixed(2)},${p.dye ?? ""},${p.hole ? 1 : 0};`;
        i++;
      }
      if (i === first) return false;
      const o = PANES * 12 + runs.length * 4;
      ints[o] = first;
      ints[o + 1] = i - first;
      const room = ROOM * dpr;
      runs.push({
        x0: Math.max(0, Math.floor(box.x0 - room)),
        y0: Math.max(0, Math.floor(box.y0 - room)),
        x1: Math.min(canvas.width, Math.ceil(box.x1 + room)),
        y1: Math.min(canvas.height, Math.ceil(box.y1 + room)),
      });
      return true;
    };
    for (const layer of ui.read()) groups.push({ run: layer.panes.length && run(layer.panes) ? runs.length - 1 : -1, layer });
    const o = PANES * 12 + RUNS * 4;
    data.set([...palette.tint, 1], o);
    data.set([canvas.width, canvas.height, dpr, MELT * dpr], o + 4);
    const now = performance.now();
    const dt = Math.min(0.1, (now - touch.at) / 1000);
    touch.at = now;
    touch.glow = touch.down ? touch.glow + (1 - touch.glow) * Math.min(1, dt * 14) : touch.glow * Math.exp(-dt * 3.5);
    if (touch.glow < 0.005) touch.glow = 0;
    data.set([touch.x * dpr, touch.y * dpr, touch.glow, GLOW * dpr], o + 8);
    glazedKey = key;
    seen = key + (touch.glow ? touch.glow.toFixed(3) : "");
    return seen;
  };

  const task: Task = {
    name: "black",
    engine,
    scene,
    _passes: [],
    record() {},
    execute() {
      if (!groups.length || !surface.scRT._colorView) return 0;
      const encoder = engine._currentEncoder;
      device.queue.writeBuffer(uniforms, 0, data);
      const canvas = surface.canvas as HTMLCanvasElement;
      const [w, h] = [canvas.width, canvas.height];
      let draws = 0;
      // The black over the frame, group by group, each with what lies on it.
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: surface.scRT._colorView, loadOp: "load", storeOp: "store" }] });
      for (const g of groups) {
        const b = runs[g.run];
        if (b && b.x1 > b.x0 && b.y1 > b.y0) {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.setScissorRect(b.x0, b.y0, Math.min(w, b.x1) - b.x0, Math.min(h, b.y1) - b.y0);
          pass.draw(3, 1, 0, g.run);
          draws++;
        }
        pass.setScissorRect(0, 0, w, h);
        ui.ink(pass, g.layer);
        draws += 2;
      }
      pass.end();
      return draws;
    },
    dispose() {
      uniforms.destroy();
    },
  };
  addTask(scene, task);
  buildFrameGraphTask(getFrameGraph(scene), task);
  /** A press on the UI, which lights the black. */
  const touchAt = (x: number, y: number, down: boolean) => {
    [touch.x, touch.y, touch.down] = [x, y, down];
  };
  return { read, key: () => seen, touchAt };
}

/** "#rrggbb" as 0–1. */
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
