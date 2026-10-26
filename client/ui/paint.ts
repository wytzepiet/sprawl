import type { EngineContext } from "@babylonjs/lite";
import { composeSlugShader } from "@babylonjs/lite/src/text/shaders/slug-shader";
import { ensureSharedAtlasGpu } from "@babylonjs/lite/src/text/_gpu/text-textures";
import { atlas, icon, ICON_UNIT, type Laid } from "./glyphs";
import { layout } from "./layout";
import { dirt, node, type UiNode } from "./node";

/**
 * The UI drawn into the frame, in the order the tree gives: each box a
 * rounded rectangle, each letter and icon a glyph, each `glass` a pane of
 * the glass (`engine/glass.ts`). What is drawn after a pane of a new layer
 * lies on it, so a card over a card frosts what is written on the one
 * behind. What a `clip` box holds is cut to its rounded shape, in the
 * shader: one more SDF, no stencil.
 */

/** A pane, for the glass, in CSS pixels. */
export interface Pane {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fade: number;
  dye?: string;
  /** The black outside the box, not in it. */
  hole?: boolean;
}

/** A layer: its panes, and what lies on them. */
export interface Layer {
  panes: Pane[];
  boxes: [number, number];
  glyphs: [number, number];
}

/** Something the hand can find, in CSS pixels, front last. */
export interface Hit {
  node: UiNode;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  clip: Clip;
}
type Clip = [number, number, number, number, number];
const OPEN: Clip = [-1e6, -1e6, 1e6, 1e6, 0];

export const root = node("root");

/** The glass's colours, 0–1: its own (`tint`), the ink written on it
 *  (`text`), and its shadow's (`ink`). The game's to give (`createPaint`). */
export interface Palette {
  tint: [number, number, number];
  text: [number, number, number];
  ink: [number, number, number];
}
let palette: Palette = { tint: [1, 1, 1], text: [0, 0, 0], ink: [0, 0, 0] };

const BOX_FLOATS = 24;
const GLYPH_FLOATS = 16;

/** A colour as premultiplied 0–1: "#rgb[a]", "#rrggbb[aa]", "white", or the glass's "ink" and "glass", with "/share". */
function rgba(c: string | undefined, fade: number): [number, number, number, number] {
  if (!c) return [0, 0, 0, 0];
  const [name, share] = c.split("/");
  let [r, g, b, a] = [0, 0, 0, Number(share ?? 1)];
  if (name === "ink") [r, g, b] = palette.text;
  else if (name === "glass") [r, g, b] = palette.tint;
  else if (name === "white") [r, g, b] = [1, 1, 1];
  else {
    let h = name.slice(1);
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    const v = parseInt(h.slice(0, 6), 16);
    [r, g, b] = [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    if (h.length === 8) a *= parseInt(h.slice(6), 16) / 255;
  }
  a *= fade;
  return [r * a, g * a, b * a, a];
}

/** How much further a squircle's corner reaches than the circle it stands for. */
export const SQUIRCLE_REACH = 1.8;

/** The distance to a box of half size `half` round the origin, its corners
 *  squircles, not quarter circles: the corner's curve a superellipse (an
 *  L4 circle), reaching a little further to stand for a radius `r`. */
export const WGSL_SQUIRCLE = /* wgsl */ `
fn squircle(p: vec2f, half: vec2f, r: f32) -> f32 {
  let k = min(r * ${SQUIRCLE_REACH}, min(half.x, half.y));
  let q = abs(p) - half + k;
  let m = max(q, vec2f(0)) * max(q, vec2f(0));
  return sqrt(sqrt(dot(m, m))) + min(max(q.x, q.y), 0) - k;
}`;

const WGSL_CLIP = /* wgsl */ `
${WGSL_SQUIRCLE}
fn clipped(p: vec2f, b: vec4f, r: f32) -> f32 {
  return clamp(0.5 - squircle(p - (b.xy + b.zw) * 0.5, (b.zw - b.xy) * 0.5, r), 0, 1);
}`;

const CORNERS = /* wgsl */ `var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));`;

const BOX_WGSL = /* wgsl */ `
struct U { size: vec4f, shade: vec4f }
@group(0) @binding(0) var<uniform> u: U;
struct I {
  @location(0) rect: vec4f, @location(1) form: vec4f, @location(2) fill: vec4f,
  @location(3) line: vec4f, @location(4) cb: vec4f, @location(5) cr: vec4f,
}
struct V {
  @builtin(position) pos: vec4f, @location(0) p: vec2f,
  @location(1) @interpolate(flat) rect: vec4f, @location(2) @interpolate(flat) form: vec4f,
  @location(3) @interpolate(flat) fill: vec4f, @location(4) @interpolate(flat) line: vec4f,
  @location(5) @interpolate(flat) cb: vec4f, @location(6) @interpolate(flat) cr: vec4f,
}
@vertex fn vert(in: I, @builtin(vertex_index) i: u32) -> V {
  ${CORNERS}
  let c = corners[i];
  // Room round it for the edge's softening and the shadow.
  let room = 1 + in.form.z * 3 + abs(in.form.w);
  let p = in.rect.xy + in.rect.zw * 0.5 + c * (in.rect.zw * 0.5 + room);
  var v: V;
  v.pos = vec4f(p.x / u.size.x * 2 - 1, 1 - p.y / u.size.y * 2, 0, 1);
  v.p = p; v.rect = in.rect; v.form = in.form; v.fill = in.fill; v.line = in.line; v.cb = in.cb; v.cr = in.cr;
  return v;
}
${WGSL_CLIP}
fn dist(p: vec2f, rect: vec4f, r: f32) -> f32 {
  return squircle(p - rect.xy - rect.zw * 0.5, rect.zw * 0.5, r);
}
@fragment fn frag(v: V) -> @location(0) vec4f {
  let r = min(v.form.x, min(v.rect.z, v.rect.w) * 0.5);
  let d = dist(v.p, v.rect, r);
  var col = v.fill * clamp(0.5 - d, 0, 1);
  if (v.form.y > 0) {
    let a = clamp(0.5 - d, 0, 1) * clamp(0.5 + d + v.form.y, 0, 1);
    col = v.line * a + col * (1 - v.line.a * a);
  }
  if (v.form.z > 0) {
    let s = dist(v.p - vec2f(0, v.form.w), v.rect, r);
    let shade = u.shade.a * v.fill.a * exp(-max(s, 0) / v.form.z) * clamp(0.5 + d, 0, 1);
    col = col + vec4f(u.shade.rgb * shade, shade) * (1 - col.a);
  }
  return col * clipped(v.p, v.cb, v.cr.x);
}`;

const GLYPH_VERT = /* wgsl */ `
struct TU { mvp: mat4x4f, vp: vec4f, col: vec4f }
@group(0) @binding(0) var<uniform> tu: TU;
struct GM { b: vec4f, a: vec4f, t: vec4f }
@group(0) @binding(3) var<storage, read> gm: array<GM>;
struct I {
  @location(0) at: vec2f, @location(1) unit: f32, @location(2) slot: u32,
  @location(3) col: vec4f, @location(4) cb: vec4f, @location(5) cr: vec4f,
}
struct V {
  @builtin(position) pos: vec4f, @location(0) tc: vec2f,
  @location(1) @interpolate(flat) bn: vec4f, @location(2) @interpolate(flat) ga: vec4f,
  @location(3) @interpolate(flat) cl: vec4f, @location(4) @interpolate(flat) cb: vec4f,
  @location(5) @interpolate(flat) cr: vec4f,
}
@vertex fn main(in: I, @builtin(vertex_index) i: u32) -> V {
  ${CORNERS}
  let cn = corners[i];
  let md = gm[in.slot];
  // The glyph's own box, in its units, y up; set on the screen, y down,
  // and grown a pixel each way for the edge's softening.
  let tx = mix(md.b.xy, md.b.zw, step(vec2f(0), cn));
  let p = in.at + vec2f(tx.x, -tx.y) * in.unit + vec2f(cn.x, -cn.y);
  var v: V;
  v.pos = vec4f(p.x / tu.vp.x * 2 - 1, 1 - p.y / tu.vp.y * 2, 0, 1);
  v.tc = tx + cn / in.unit;
  v.bn = md.t; v.ga = md.a; v.cl = in.col; v.cb = in.cb; v.cr = in.cr;
  return v;
}`;

/** The UI's drawing: the tree laid out and walked each frame it moved,
 *  its instances written, and each layer drawn when the glass asks. */
export function createPaint(engine: EngineContext, colours: Palette) {
  palette = colours;
  const device = engine._device;
  const surface = engine.surfaces[0];
  const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  const attrs = (floats: number[]): GPUVertexBufferLayout => {
    let at = 0;
    return {
      arrayStride: floats.reduce((a, b) => a + Math.abs(b), 0) * 4,
      stepMode: "instance",
      attributes: floats.map((n, i) => {
        const a: GPUVertexAttribute = { shaderLocation: i, offset: at * 4, format: n === -1 ? "uint32" : (`float32${n === 1 ? "" : `x${n}`}` as GPUVertexFormat) };
        at += Math.abs(n);
        return a;
      }),
    };
  };

  const boxModule = device.createShaderModule({ label: "ui-box", code: BOX_WGSL });
  const boxLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] });
  const boxPipeline = device.createRenderPipeline({
    label: "ui-box",
    layout: device.createPipelineLayout({ bindGroupLayouts: [boxLayout] }),
    vertex: { module: boxModule, entryPoint: "vert", buffers: [attrs([4, 4, 4, 4, 4, 4])] },
    fragment: { module: boxModule, entryPoint: "frag", targets: [{ format: surface.format, blend }] },
  });
  const boxU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const boxGroup = device.createBindGroup({ layout: boxLayout, entries: [{ binding: 0, resource: { buffer: boxU } }] });

  // Letters and icons: Lite's Slug fragment shader, with the clip laid into its coverage.
  const slug = composeSlugShader({
    _id: "ui-clip",
    _fragmentSlots: {
      FI: "@location(4) @interpolate(flat) cb: vec4f, @location(5) @interpolate(flat) cr: vec4f, @builtin(position) fp: vec4f," as never,
      FH: WGSL_CLIP as never,
      CO: "cov = cov * clipped(in.fp.xy, in.cb, in.cr.x);" as never,
    },
  });
  const glyphLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  const glyphPipeline = device.createRenderPipeline({
    label: "ui-glyph",
    layout: device.createPipelineLayout({ bindGroupLayouts: [glyphLayout] }),
    vertex: { module: device.createShaderModule({ label: "ui-glyph-vert", code: GLYPH_VERT }), entryPoint: "main", buffers: [attrs([2, 1, -1, 4, 4, 4])] },
    fragment: { module: device.createShaderModule({ label: "ui-glyph-frag", code: slug._frag }), entryPoint: "main", targets: [{ format: surface.format, blend }] },
  });
  const glyphU = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let glyphGroup: GPUBindGroup | null = null;
  let atlasSeen = -1;

  let boxes = new Float32Array(BOX_FLOATS * 64);
  let glyphs = new Float32Array(GLYPH_FLOATS * 512);
  let glyphInts = new Uint32Array(glyphs.buffer);
  let boxBuf: GPUBuffer | null = null;
  let glyphBuf: GPUBuffer | null = null;
  let boxCount = 0;
  let glyphCount = 0;
  let layers: Layer[] = [];
  let hits: Hit[] = [];
  let laidAt = "";
  let paintedAt = "";
  let seen = 0;

  const fit = (buf: GPUBuffer | null, bytes: number) => {
    if (buf && buf.size >= bytes) return buf;
    buf?.destroy();
    return device.createBuffer({ size: Math.max(1024, 2 ** Math.ceil(Math.log2(bytes))), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  };

  const box = (x: number, y: number, w: number, h: number, r: number, fill: number[], line: number[], lineW: number, shadow: boolean, clip: Clip, k: number) => {
    if (boxes.length < (boxCount + 1) * BOX_FLOATS) {
      const more = new Float32Array(boxes.length * 2);
      more.set(boxes);
      boxes = more;
    }
    const o = boxCount++ * BOX_FLOATS;
    boxes.set([x * k, y * k, w * k, h * k, r * k, lineW * k, shadow ? 5 * k : 0, shadow ? 2 * k : 0, ...fill, ...line, clip[0] * k, clip[1] * k, clip[2] * k, clip[3] * k, clip[4] * k, 0, 0, 0], o);
  };
  const glyph = (x: number, y: number, unit: number, slot: number, col: number[], clip: Clip, k: number) => {
    if (glyphs.length < (glyphCount + 1) * GLYPH_FLOATS) {
      const more = new Float32Array(glyphs.length * 2);
      more.set(glyphs);
      glyphs = more;
      glyphInts = new Uint32Array(glyphs.buffer);
    }
    const o = glyphCount++ * GLYPH_FLOATS;
    glyphs.set([x * k, y * k, unit * k, 0, ...col, clip[0] * k, clip[1] * k, clip[2] * k, clip[3] * k, clip[4] * k, 0, 0, 0], o);
    glyphInts[o + 3] = slot;
  };

  /** The tree walked: where each node lies on the screen, at what scale and fade, cut by what. */
  const walk = (n: UiNode, ax: number, ay: number, s: number, fade: number, clip: Clip, k: number, layer: Map<string, Layer>) => {
    for (const c of n.kids) {
      if (c.tag === "#text") continue;
      const p = c.props;
      const ms = p.scale ?? 1;
      const [ox, oy] = p.origin ? [p.origin[0] * c.w, p.origin[1] * c.h] : [c.w / 2, c.h / 2];
      const x = ax + s * (c.x + (p.x ?? 0) + ox - ms * ox);
      const y = ay + s * (c.y + (p.y ?? 0) + oy - ms * oy);
      const cs = s * ms;
      const f = fade * (p.opacity ?? 1);
      if (f < 0.002) continue;
      const [w, h] = [c.w * cs, c.h * cs];
      const r = Math.min((p.round ?? 0) * cs, w / 2, h / 2);
      if (c.tag === "glass") {
        let l = layer.get(p.layer);
        if (!l) {
          close();
          layers.push((l = { panes: [], boxes: [boxCount, 0], glyphs: [glyphCount, 0] }));
          layer.set(p.layer, l);
        }
        l.panes.push({ x, y, w, h, r, fade: f, dye: p.dye, hole: p.hole });
      }
      if (c.tag === "box" && (p.fill || p.stroke)) box(x, y, w, h, r, rgba(p.fill, f), rgba(p.stroke?.[1], f), (p.stroke?.[0] ?? 0) * cs, !!p.shadow, clip, k);
      if (c.tag === "text") {
        const laid = (c.lines as { laid: Laid } | undefined)?.laid;
        const spare = c.w - (laid?.w ?? 0);
        const shift = p.align === "center" ? spare / 2 : p.align === "end" ? spare : 0;
        for (const g of laid?.glyphs ?? []) glyph(x + (g.x + shift) * cs, y + g.y * cs, g.unit * cs, g.slot, rgba(g.ink, f), clip, k);
      }
      if (c.tag === "icon") {
        const view = p.view ?? 24;
        const slot = icon(p.d, p.stroke, view);
        if (slot >= 0) glyph(x, y + h, ((ICON_UNIT * (p.size ?? 16)) / view) * cs, slot, rgba(p.ink ?? "ink", f), clip, k);
      }
      if (p.onTap || p.onScroll || p.onPress || p.onHover || p.onDrag || p.onDrop || (c.tag === "glass" && !p.hole) || p.fill) hits.push({ node: c, x, y, w, h, r, clip });
      const inner: Clip = p.clip ? [Math.max(clip[0], x), Math.max(clip[1], y), Math.min(clip[2], x + w), Math.min(clip[3], y + h), r] : clip;
      walk(c, x, y, cs, f, inner, k, layer);
    }
  };
  /** The layer drawn so far ends here. */
  const close = () => {
    const l = layers[layers.length - 1];
    if (!l) return;
    l.boxes[1] = boxCount - l.boxes[0];
    l.glyphs[1] = glyphCount - l.glyphs[0];
  };

  return {
    /** Lay out and walk the tree if anything moved: the layers to draw, front last. */
    read(): Layer[] {
      const canvas = surface.canvas as HTMLCanvasElement;
      const [cw, ch] = [canvas.clientWidth, canvas.clientHeight];
      const k = canvas.width / Math.max(1, cw);
      const at = `${dirt.layout}|${cw}|${ch}`;
      if (at !== laidAt) {
        layout(root, cw, ch, dirt.layout);
        laidAt = at;
        dirt.paint++;
      }
      // The ink takes the light: a turn of the day draws the UI again.
      const painted = `${dirt.paint}|${k}|${palette.text}|${palette.tint}`;
      if (painted === paintedAt) return layers;
      paintedAt = painted;
      seen++;
      boxCount = glyphCount = 0;
      layers = [{ panes: [], boxes: [0, 0], glyphs: [0, 0] }];
      hits = [];
      walk(root, 0, 0, 1, root.props.opacity ?? 1, OPEN, k, new Map());
      close();
      boxBuf = fit(boxBuf, boxCount * BOX_FLOATS * 4);
      glyphBuf = fit(glyphBuf, glyphCount * GLYPH_FLOATS * 4);
      if (boxCount) device.queue.writeBuffer(boxBuf, 0, boxes, 0, boxCount * BOX_FLOATS);
      if (glyphCount) device.queue.writeBuffer(glyphBuf, 0, glyphs, 0, glyphCount * GLYPH_FLOATS);
      device.queue.writeBuffer(boxU, 0, new Float32Array([canvas.width, canvas.height, 0, 0, ...palette.ink, 0.22]));
      device.queue.writeBuffer(glyphU, 64, new Float32Array([canvas.width, canvas.height, 0, 0, 1, 1, 1, 1]));
      // New letters go up to the atlas, and a grown atlas is bound anew.
      const a = atlas();
      if (a) {
        const { _rebuilt, _gpu } = ensureSharedAtlasGpu(device, a as never);
        if (_rebuilt || !glyphGroup || atlasSeen !== _gpu._uploadedVersion) {
          atlasSeen = _gpu._uploadedVersion;
          glyphGroup = device.createBindGroup({
            layout: glyphLayout,
            entries: [
              { binding: 0, resource: { buffer: glyphU } },
              { binding: 1, resource: _gpu._curveTex.createView() },
              { binding: 2, resource: _gpu._bandTex.createView() },
              { binding: 3, resource: { buffer: _gpu._metaBuf } },
            ],
          });
        }
      }
      return layers;
    },
    /** Changes whenever the UI is drawn anew: the frame loop runs fast while it does. */
    key: () => seen,
    hits: () => hits,
    /** What lies on a layer, into a pass over the frame. */
    ink(pass: GPURenderPassEncoder, l: Layer) {
      if (l.boxes[1] && boxBuf) {
        pass.setPipeline(boxPipeline);
        pass.setBindGroup(0, boxGroup);
        pass.setVertexBuffer(0, boxBuf);
        pass.draw(6, l.boxes[1], 0, l.boxes[0]);
      }
      if (l.glyphs[1] && glyphBuf && glyphGroup) {
        pass.setPipeline(glyphPipeline);
        pass.setBindGroup(0, glyphGroup);
        pass.setVertexBuffer(0, glyphBuf);
        pass.draw(6, l.glyphs[1], 0, l.glyphs[0]);
      }
    },
  };
}
