import { addTask, buildFrameGraphTask, getFrameGraph, type EngineContext, type SceneContext, type Task } from "@babylonjs/lite";

/**
 * The UI's glass, drawn by the GPU over the frame it lies on, not by the
 * page: a CSS filter over a live canvas is run again on every frame the
 * canvas draws, and the goo's took most of the laptop's GPU.
 *
 * The page says where the glass is. Every element marked `data-glass` is
 * a pane, a rounded box as the page lays it out; panes of one name
 * (`data-glass="dock"`) run together like liquid, a smooth union of their
 * shapes, and panes of different names do not. `data-dye` lays a colour
 * into a pane. The element itself draws nothing of the glass, only what
 * sits on it.
 *
 * Each frame the frame loop reads the panes (`read`), once, after the
 * springs have moved them and before the frame is drawn. Then, after the
 * scene, this task copies what lies under each run of glass out of the
 * frame, halves it a few times for the frost, and draws the glass over
 * it: the town seen through it blurred and bent at the rim, its body lit
 * by the light on a pane (`light`), the rim facing the sun catching it,
 * the sky round every edge, and a soft shadow under it.
 */

/** The most panes, and runs of them, drawn. */
const PANES = 48;
const RUNS = 8;
/** How far panes melt into each other, in CSS pixels: the goo. */
const MELT = 12;
/** How deep the rim's rounding goes, in CSS pixels: the lens. */
const BEVEL = 26;
/** How far the rim bends what is behind it at most, in CSS pixels: the
 *  glass's thickness; and how much it bends light, its refractive index. */
const BEND = 72;
const IOR = 1.5;
/** The frost: the halving read, a blur of about 2^FROST device pixels. */
const FROST = 2.4;
/** How much of the body is the light on the pane rather than what is
 *  seen through it: a wash, so the ink on it stays legible. */
const WASH = 0.48;
/** How far what is seen through the flat of the glass is calmed toward its
 *  surroundings, for legibility. */
const CALM = 0.4;
/** Halvings kept of what is under the glass; and room round a run, in
 *  device pixels, for the blur, the bending and the shadow. */
const LEVELS = 6;
const ROOM = 200;

/** The glass's own colour, sea glass, laid into the light through it. */
const SEA_GLASS: [number, number, number] = [0.62, 0.86, 0.82];
const COLOUR = 0.45;
/** How much the sun's colour is cast through the glass. */
const SUNLIT = 0.35;
/** How far a press's light spreads through the glass, in CSS pixels. */
const GLOW = 40;

/** The light the glass is held up in, set as the day turns (`ui/Glass.tsx`). */
export const light = {
  /** The pane's own colour, the light through it: 0–1. */
  tint: [1, 1, 1] as [number, number, number],
  /** The sun's glint on the rim facing it, and how strong. */
  sun: [1, 1, 1] as [number, number, number],
  sunStrength: 0.6,
  /** Toward the sun on the screen, y down. */
  toward: [0.6, -0.8] as [number, number],
  /** The sky round every edge. */
  sky: [1, 1, 1] as [number, number, number],
  /** How dark the far edge's shade is, and the shadow: the ink's colour. */
  ink: [0.18, 0.24, 0.22] as [number, number, number],
};

const WGSL = /* wgsl */ `
struct Pane { box: vec4f, round: vec4f, dye: vec4f }
struct Run { first: u32, count: u32, pad0: u32, pad1: u32 }
struct Glass {
  panes: array<Pane, ${PANES}>,
  runs: array<Run, ${RUNS}>,
  tint: vec4f,
  sun: vec4f,
  toward: vec4f,
  sky: vec4f,
  ink: vec4f,
  size: vec4f,
  touch: vec4f,
}
@group(0) @binding(0) var<uniform> glass: Glass;
@group(0) @binding(1) var under: texture_2d<f32>;
@group(0) @binding(2) var soft: sampler;

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
  // A pane fading out sinks into the rest rather than blinking.
  return length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - r + (1 - pane.round.y) * pane.round.z;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
/** The rim's rise across the bezel, 0 at the edge to 1 where it is flat: a squircle. */
fn rise(x: f32) -> f32 { return pow(1 - pow(1 - clamp(x, 0, 1), 4.0), 0.25); }

struct Field { d: f32, dye: vec4f, size: f32 }
fn field(p: vec2f, run: Run) -> Field {
  let k = glass.size.w;
  var f = Field(1e6, vec4f(0), 0);
  for (var i = run.first; i < run.first + run.count; i++) {
    let pane = glass.panes[i];
    if (pane.round.y <= 0.002) { continue; }
    let d = box(p, pane);
    // Smooth union (Inigo Quilez's polynomial): melt within k.
    let h = clamp(0.5 + 0.5 * (f.d - d) / k, 0, 1);
    f.d = mix(f.d, d, h) - k * h * (1 - h);
    // How big the glass is here, for how thick it is.
    f.size = mix(f.size, pane.round.z, h);
    // The dye melts as the shapes do: a pane's colour to its edge, blended
    // only where it runs into another.
    f.dye = mix(f.dye, pane.dye, h);
  }
  return f;
}

@fragment fn pane(in: Out) -> @location(0) vec4f {
  let run = glass.runs[in.run];
  let p = in.position.xy;
  let f = field(p, run);
  let dpr = glass.size.z;

  // Outside: the shadow the pane casts, soft and a little below, darker
  // over busy ground than plain, so the glass always stands off it.
  if (f.d > 0.5) {
    let s = field(p - vec2f(0, 6 * dpr), run).d;
    let at = p / vec2f(textureDimensions(under, 0));
    let busy = abs(luma(textureSampleLevel(under, soft, at, 2).rgb) - luma(textureSampleLevel(under, soft, at, 5).rgb));
    let shadow = 0.1 * clamp(0.6 + 4 * busy, 0.6, 1.8) * exp(-max(s, 0) / (14 * dpr));
    return vec4f(glass.ink.rgb * shadow, shadow);
  }

  // The rim is a lens: a squircle's rounding over BEVEL, flat on top and
  // steep at the edge. Light comes up through it and bends at its surface
  // by Snell's law, so what is seen there comes from further out, most at
  // the edge, nothing on the flat.
  let e = 1.0;
  let g = normalize(vec2f(field(p + vec2f(e, 0), run).d - field(p - vec2f(e, 0), run).d,
                          field(p + vec2f(0, e), run).d - field(p - vec2f(0, e), run).d) + 1e-6);
  // Small glass is thinner: its lens no deeper than most of it, and
  // bending less for it.
  let bevel = min(${BEVEL} * dpr, max(f.size * 0.85, 1));
  let thick = bevel / (${BEVEL} * dpr);
  let depth = clamp(-f.d / bevel, 0.004, 1);
  let slope = (rise(min(depth + 0.004, 1)) - rise(depth - 0.004)) / 0.008;
  let tilt = atan(slope);
  let through = asin(sin(tilt) / ${IOR});
  let lens = tan(tilt - through) / 1.12;
  let n = normalize(vec3f(g * slope, 1));
  let rim = 1 - depth;

  // The town through it, bent by the lens, frosted a little, the colours
  // parting where it bends most.
  let dims = vec2f(textureDimensions(under, 0));
  let bend = g * lens * ${BEND} * dpr * thick;
  let uv = (p + bend) / dims;
  let split = g * lens * 3 * dpr * thick / dims;
  let frost = ${FROST};
  let seen = vec3f(
    textureSampleLevel(under, soft, uv + split, frost).r,
    textureSampleLevel(under, soft, uv, frost).g,
    textureSampleLevel(under, soft, uv - split, frost).b);

  // Behind the ink, what is seen is calmed: its contrast pulled toward the
  // mean round it, so busy ground does not fight what sits on the glass.
  // The rim, where the lens is, keeps it all.
  let around = textureSampleLevel(under, soft, uv, 4.5).rgb;
  let seenCalm = mix(seen, around, ${CALM} * (1 - lens));

  // Pressed, the glass lights from inside, under the finger and out
  // through any glass near it: what is seen through it brightens and
  // deepens in colour, as if lit from within, and the milk thins to let it.
  let toTouch = p - glass.touch.xy;
  let glow = glass.touch.z * exp(-dot(toTouch, toTouch) / (2 * glass.touch.w * glass.touch.w));
  let lit = seenCalm * (1 + 0.9 * glow);
  let vivid = max(mix(vec3f(luma(lit)), lit, 1 + 0.7 * glow), vec3f(0));

  // Its body: what is seen, washed with the light on a pane.
  var body = mix(vivid, glass.tint.rgb, glass.tint.a * (1 - 0.6 * glow));
  // Lit by the sun: its colour cast through the whole pane, gold at dawn
  // and dusk, nothing at noon's white or by night.
  body *= mix(vec3f(1), glass.sun.rgb, ${SUNLIT} * glass.sun.a);
  // Tinted glass keeps its colour: its hue and depth of colour hold, and
  // its lightness follows what is behind, within a band round its own.
  if (f.dye.a > 0.001) {
    let own = max(luma(f.dye.rgb), 1e-3);
    let want = clamp(own + (luma(vivid) - 0.5) * 0.55, 0.06, 0.94);
    var toned = f.dye.rgb * (want / own);
    let peak = max(max(toned.r, toned.g), toned.b);
    toned = select(toned, mix(toned / peak, vec3f(want), clamp((peak - 1) * 0.6, 0, 1)), peak > 1);
    body = mix(body, toned, f.dye.a * 0.88);
  }

  // The sky in the rounding, and the light caught on the rim: a thin bright
  // line where it faces the sun, a fainter one across from it, as light
  // runs round inside glass.
  // On tinted glass the light it catches takes its colour too, deep and
  // faint, so the rim stays one quiet piece with the body.
  let deep = mix(f.dye.rgb / max(f.dye.a, 1e-3), vec3f(1), 0.15);
  let sky = mix(glass.sky.rgb, deep, f.dye.a);
  let sun = mix(glass.sun.rgb, deep, f.dye.a);
  let fresnel = pow(1 - n.z, 3.0);
  body = mix(body, sky, fresnel * 0.3);
  let facing = dot(g, glass.toward.xy);
  // Brightest at the very edge and falling away fast, a soft tail behind.
  let line = exp(-max(-f.d, 0) / (0.8 * dpr));
  var caught = line * (pow(max(facing, 0), 1.5) + 0.35 * pow(max(-facing, 0), 2.0));
  body += sun * glass.sun.a * pow(max(facing, 0), 3.0) * pow(lens, 4.0) * 0.2;

  // And a light of its own: screened in, so it lifts the darks most.
  body = 1 - (1 - body) * (1 - 0.3 * glow);
  caught *= 1 - 0.5 * f.dye.a;
  caught += line * glow * 0.9;
  // The rim takes the sun's own colour rather than being lit over, so a
  // gold sun is a gold edge even on light glass, which added light would
  // only take to white.
  body = mix(body, sun, clamp(caught * glass.sun.a * 1.8, 0, 1)) + mix(vec3f(1), deep, f.dye.a) * glow * line * 0.25;

  let cover = clamp(0.5 - f.d, 0, 1);
  return vec4f(body * cover, cover);
}

`;

/** Halving what is under the glass, a level at a time: each texel the
 *  mean of the four above it. */
const HALVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var above: texture_2d<f32>;
@group(0) @binding(1) var bilinear: sampler;
@vertex fn whole(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(corners[i], 0, 1);
}
@fragment fn halve(@builtin(position) at: vec4f) -> @location(0) vec4f {
  return textureSampleLevel(above, bilinear, at.xy * 2 / vec2f(textureDimensions(above, 0)), 0);
}
`;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The glass task, after the scene, and how to read the page's panes. */
export function createGlass(engine: EngineContext, scene: SceneContext) {
  const device = engine._device;
  const surface = engine.surfaces[0];
  const format = surface._configureFormat;
  const module = device.createShaderModule({ label: "glass", code: WGSL });
  const halveModule = device.createShaderModule({ label: "glass-halve", code: HALVE_WGSL });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

  const paneLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const halfLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const panePipeline = device.createRenderPipeline({
    label: "glass",
    layout: device.createPipelineLayout({ bindGroupLayouts: [paneLayout] }),
    vertex: { module, entryPoint: "whole" },
    fragment: {
      module,
      entryPoint: "pane",
      targets: [{ format: surface.format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
    },
  });
  const halfPipeline = device.createRenderPipeline({
    label: "glass-halve",
    layout: device.createPipelineLayout({ bindGroupLayouts: [halfLayout] }),
    vertex: { module: halveModule, entryPoint: "whole" },
    fragment: { module: halveModule, entryPoint: "halve", targets: [{ format }] },
  });

  // The uniforms: panes (box, round, dye: 12 floats), runs (4 u32), then seven vec4s.
  const floats = PANES * 12 + RUNS * 4 + 7 * 4;
  const data = new Float32Array(floats);
  const ints = new Uint32Array(data.buffer);
  const uniforms = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // What lies under the glass, with its halvings; made again at a new size.
  let under: GPUTexture | null = null;
  let levels: GPUTextureView[] = [];
  let halves: GPUBindGroup[] = [];
  let paneGroup: GPUBindGroup | null = null;
  const fit = (w: number, h: number) => {
    if (under && under.width === w && under.height === h) return;
    under?.destroy();
    const count = Math.min(LEVELS, Math.floor(Math.log2(Math.min(w, h))) + 1);
    under = device.createTexture({
      label: "glass-under",
      size: { width: w, height: h },
      format,
      mipLevelCount: count,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    levels = Array.from({ length: count }, (_, i) => under!.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    halves = levels.slice(0, -1).map((view) => device.createBindGroup({ layout: halfLayout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] }));
    paneGroup = device.createBindGroup({
      layout: paneLayout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: under.createView() },
        { binding: 2, resource: sampler },
      ],
    });
  };

  // A press on the UI, which lights the glass from inside.
  const touch = { x: 0, y: 0, down: false, glow: 0, at: performance.now() };
  const press = (e: PointerEvent) => {
    if (e.target === surface.canvas) return;
    [touch.x, touch.y, touch.down] = [e.clientX, e.clientY, true];
  };
  const follow = (e: PointerEvent) => {
    if (touch.down) [touch.x, touch.y] = [e.clientX, e.clientY];
  };
  const lift = () => (touch.down = false);
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("pointermove", follow, true);
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);

  // The runs of glass this frame, in device pixels, each with room round it.
  let runs: Box[] = [];
  let seen = "";
  const radii = new WeakMap<Element, { key: string; r: number }>();

  /** Read the page's panes: their boxes, rounding, fade and dye. Returns a
   *  key that changes when any of them moved. */
  const read = (): string => {
    const canvas = surface.canvas as HTMLCanvasElement;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const byRun = new Map<string, { el: HTMLElement; r: DOMRect }[]>();
    for (const el of document.querySelectorAll<HTMLElement>("[data-glass]")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const name = el.dataset.glass || `pane${byRun.size}`;
      if (!byRun.has(name)) byRun.set(name, []);
      byRun.get(name)!.push({ el, r });
    }
    data.fill(0);
    runs = [];
    let i = 0;
    let key = "";
    for (const panes of byRun.values()) {
      if (runs.length === RUNS) break;
      const first = i;
      const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const { el, r } of panes) {
        if (i === PANES) break;
        const style = getComputedStyle(el);
        const fade = Number(style.opacity);
        if (fade <= 0.002) continue;
        let cached = radii.get(el);
        if (!cached || cached.key !== el.className) radii.set(el, (cached = { key: el.className, r: parseFloat(style.borderTopLeftRadius) || 0 }));
        const [hx, hy] = [(r.width / 2) * dpr, (r.height / 2) * dpr];
        const o = i * 12;
        data[o] = (r.left + r.width / 2) * dpr;
        data[o + 1] = (r.top + r.height / 2) * dpr;
        data[o + 2] = hx;
        data[o + 3] = hy;
        data[o + 4] = Math.min(cached.r * dpr, hx, hy);
        data[o + 5] = fade;
        data[o + 6] = Math.min(hx, hy);
        const dye = el.dataset.dye ? hexRgb(el.dataset.dye) : null;
        if (dye) data.set([...dye, 1], o + 8);
        box.x0 = Math.min(box.x0, r.left * dpr);
        box.y0 = Math.min(box.y0, r.top * dpr);
        box.x1 = Math.max(box.x1, r.right * dpr);
        box.y1 = Math.max(box.y1, r.bottom * dpr);
        key += `${Math.round(data[o])},${Math.round(data[o + 1])},${Math.round(hx)},${Math.round(hy)},${fade.toFixed(2)},${el.dataset.dye ?? ""};`;
        i++;
      }
      if (i === first) continue;
      const o = PANES * 12 + runs.length * 4;
      ints[o] = first;
      ints[o + 1] = i - first;
      runs.push({
        x0: Math.max(0, Math.floor(box.x0 - ROOM)),
        y0: Math.max(0, Math.floor(box.y0 - ROOM)),
        x1: Math.min(canvas.width, Math.ceil(box.x1 + ROOM)),
        y1: Math.min(canvas.height, Math.ceil(box.y1 + ROOM)),
      });
    }
    const o = PANES * 12 + RUNS * 4;
    data.set([...light.tint.map((v, k) => v * (1 - COLOUR + COLOUR * SEA_GLASS[k])), WASH], o);
    data.set([...light.sun, light.sunStrength], o + 4);
    data.set([...light.toward, 0, 0], o + 8);
    data.set([...light.sky, 1], o + 12);
    data.set([...light.ink, 1], o + 16);
    data.set([canvas.width, canvas.height, dpr, MELT * dpr], o + 20);
    const now = performance.now();
    const dt = Math.min(0.1, (now - touch.at) / 1000);
    touch.at = now;
    touch.glow = touch.down ? touch.glow + (1 - touch.glow) * Math.min(1, dt * 14) : touch.glow * Math.exp(-dt * 3.5);
    if (touch.glow < 0.005) touch.glow = 0;
    data.set([touch.x * dpr, touch.y * dpr, touch.glow, GLOW * dpr], o + 24);
    seen = key + light.tint.join() + (touch.glow ? touch.glow.toFixed(3) : "");
    return seen;
  };

  const task: Task = {
    name: "glass",
    engine,
    scene,
    _passes: [],
    record() {},
    execute() {
      const frame = surface.scRT._colorTexture;
      // A swapchain that is no copy source (a Lite without `copySource`)
      // has no glass rather than no frame.
      if (!runs.length || !frame || !(frame.usage & GPUTextureUsage.COPY_SRC)) return 0;
      const [w, h] = [frame.width, frame.height];
      fit(w, h);
      const encoder = engine._currentEncoder;
      device.queue.writeBuffer(uniforms, 0, data);
      const clipped = runs.map((b) => ({ x0: Math.min(b.x0, w), y0: Math.min(b.y0, h), x1: Math.min(b.x1, w), y1: Math.min(b.y1, h) })).filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
      // What lies under each run, out of the frame.
      for (const b of clipped) {
        encoder.copyTextureToTexture({ texture: frame, origin: { x: b.x0, y: b.y0 } }, { texture: under!, origin: { x: b.x0, y: b.y0 } }, { width: b.x1 - b.x0, height: b.y1 - b.y0 });
      }
      // Halved, level by level, within each run's box.
      let draws = 0;
      for (let level = 1; level < levels.length; level++) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: levels[level], loadOp: "load", storeOp: "store" }] });
        pass.setPipeline(halfPipeline);
        pass.setBindGroup(0, halves[level - 1]);
        const [lw, lh] = [Math.max(1, w >> level), Math.max(1, h >> level)];
        for (const b of clipped) {
          const x0 = b.x0 >> level;
          const y0 = b.y0 >> level;
          const x1 = Math.min(lw, (b.x1 >> level) + 1);
          const y1 = Math.min(lh, (b.y1 >> level) + 1);
          if (x1 <= x0 || y1 <= y0) continue;
          pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
          pass.draw(3);
          draws++;
        }
        pass.end();
      }
      // The glass, over the frame.
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: surface.scRT._colorView!, loadOp: "load", storeOp: "store" }] });
      pass.setPipeline(panePipeline);
      pass.setBindGroup(0, paneGroup!);
      runs.forEach((b, run) => {
        const c = { x0: Math.min(b.x0, w), y0: Math.min(b.y0, h), x1: Math.min(b.x1, w), y1: Math.min(b.y1, h) };
        if (c.x1 <= c.x0 || c.y1 <= c.y0) return;
        pass.setScissorRect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
        pass.draw(3, 1, 0, run);
        draws++;
      });
      pass.end();
      return draws;
    },
    dispose() {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointermove", follow, true);
      window.removeEventListener("pointerup", lift, true);
      window.removeEventListener("pointercancel", lift, true);
      under?.destroy();
      uniforms.destroy();
    },
  };
  if (import.meta.env.DEV) (window as unknown as { sprawlGlass: unknown }).sprawlGlass = light;
  addTask(scene, task);
  buildFrameGraphTask(getFrameGraph(scene), task);
  return { read, key: () => seen };
}

/** "#rrggbb" as 0–1. */
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
