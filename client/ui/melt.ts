import { everyFrame, moved } from "../src/engine/spring";
import { paint, type InkProps } from "./index";

/** The panes of a Melt: each its element, and what it was given. */
export type Melted = Set<{ el: HTMLElement; props: InkProps }>;

/** The most panes a Melt draws. */
const PANES = 32;
/** How much further a squircle's corner reaches than the circle it stands for. */
const REACH = 1.8;
/** How far panes melt into each other, in CSS pixels: the fillet where
 *  an island leaves the bezel, as wide as the black's corners reach
 *  (kit's ROUND, squircled). */
const MELT = 30 * REACH;
/** The finest the black is drawn: past two, nobody sees its edge sharper. */
const MAX_RATIO = 2;

/** Where the black may be: round each pane, as far as it can melt. */
const VERT = `#version 300 es
in vec2 at;
uniform vec3 size;
void main() {
  gl_Position = vec4(at.x / size.x * 2.0 - 1.0, 1.0 - at.y / size.y * 2.0, 0, 1);
}`;

/**
 * The black: each pane's distance, a box whose corners are squircles, not
 * quarter circles, the corner's curve a superellipse (an L4 circle)
 * reaching a little further to stand for its radius; a corner too big for
 * its box eases toward meeting the other, rounding toward a circle as it
 * nears, so a short card leans to a pill, and a pill's ends are circles.
 * A frame is black outside its box; a pane fading out sinks into the rest
 * rather than blinking. Then a round union of them all, melting within
 * `k`, where two edges meet the fillet a squircle's corner too; a dye
 * melts as the shapes do.
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec4 box[${PANES}];
uniform vec4 corner[${PANES}];
uniform vec4 dye[${PANES}];
uniform int count;
uniform vec3 size;
out vec4 colour;

float squircle(vec2 p, vec2 hb, float r) {
  float m0 = min(hb.x, hb.y);
  bool pill = r >= m0 - 0.5;
  float k = pill ? m0 : m0 * tanh(r * ${REACH} / m0);
  float n = pill ? 2.0 : mix(4.0, 2.0, smoothstep(0.7, 1.0, k / m0));
  vec2 q = abs(p) - hb + k;
  vec2 m = max(q, vec2(1e-6));
  return pow(pow(m.x, n) + pow(m.y, n), 1.0 / n) + min(max(q.x, q.y), 0.0) - k;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  float k = size.z;
  float f = 1e6;
  vec4 tint = vec4(0);
  for (int i = 0; i < count; i++) {
    vec4 b = box[i], r = corner[i];
    float d = squircle(p - b.xy, b.zw, r.x);
    d = (r.w > 0.5 ? -d : d) + (1.0 - r.y) * r.z;
    float h = clamp(0.5 + 0.5 * (f - d) / k, 0.0, 1.0);
    vec2 u = max(vec2(k - f, k - d), vec2(0));
    f = max(k, min(f, d)) - sqrt(sqrt(dot(u * u, u * u)));
    tint = mix(tint, dye[i], h);
  }
  float cover = clamp(0.5 - f, 0.0, 1.0);
  vec3 body = tint.rgb / max(tint.a, 1e-3) * tint.a;
  colour = vec4(body * cover, cover);
}`;

/**
 * A Melt's canvas: its panes read where the page put them, after the
 * springs have moved them this frame (`everyFrame`), and drawn again
 * only when one of them has moved. Returns how to stop.
 */
export function createMelt(canvas: HTMLCanvasElement, panes: Melted) {
  // Drawn off the page and handed to it as a picture: the page shows a
  // picture as it is, where a WebGL canvas may be read back each frame.
  const off = new OffscreenCanvas(1, 1);
  const gl = off.getContext("webgl2", { premultipliedAlpha: true, antialias: false })!;
  const shown = canvas.getContext("bitmaprenderer")!;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  gl.useProgram(program);
  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  const at = gl.getAttribLocation(program, "at");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const [uBox, uCorner, uDye, uCount, uSize] = ["box", "corner", "dye", "count", "size"].map(u);
  const boxes = new Float32Array(PANES * 4);
  const corners = new Float32Array(PANES * 4);
  const dyes = new Float32Array(PANES * 4);
  let seen = "";
  /** The quads the black is drawn in: two triangles each. */
  let quads: number[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number) => quads.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);

  // Read again when something moved: a spring did (`everyFrame`), or a
  // pane or the Melt itself changed size, or a pane came or went.
  const sizes = new ResizeObserver(moved);
  const watched = new WeakSet<Element>();
  const watch = (el: Element) => watched.has(el) || (watched.add(el), sizes.observe(el));
  watch(canvas);

  const draw = () => {
    const c = canvas.getBoundingClientRect();
    const k = Math.min(devicePixelRatio, MAX_RATIO);
    const [w, h] = [Math.round(c.width * k), Math.round(c.height * k)];
    // Not shown: nothing to draw.
    if (!w || !h) return;
    let key = `${w},${h};`;
    let n = 0;
    boxes.fill(0);
    corners.fill(0);
    dyes.fill(0);
    quads = [];
    const m = MELT * k;
    for (const { el, props } of panes) {
      watch(el);
      // Faded as its content is: by its own fade and every one round it.
      let fade = props.opacity ?? 1;
      for (let a = el.parentElement; a && a !== canvas.parentElement; a = a.parentElement) fade *= Number(a.style.opacity || 1);
      if (n === PANES || fade < 0.002) continue;
      const r = el.getBoundingClientRect();
      // What scales it scales its corner.
      const s = el.offsetWidth ? r.width / el.offsetWidth : 1;
      const [hx, hy] = [(r.width / 2) * k, (r.height / 2) * k];
      boxes.set([(r.left - c.left) * k + hx, (r.top - c.top) * k + hy, hx, hy], n * 4);
      corners.set([Math.min((props.round ?? 0) * s * k, hx, hy), fade, Math.min(hx, hy), props.hole ? 1 : 0], n * 4);
      const dye = props.dye && paint(props.dye)!.match(/[\d.]+/g)!.map(Number);
      if (dye) dyes.set([dye[0] / 255, dye[1] / 255, dye[2] / 255, 1], n * 4);
      // Only near the black: round a pane, or a frame's edges, inside
      // as far as its corners reach and it melts.
      const [x0, y0, x1, y1] = [(r.left - c.left) * k, (r.top - c.top) * k, (r.right - c.left) * k, (r.bottom - c.top) * k];
      if (!props.hole) quad(x0 - m, y0 - m, x1 + m, y1 + m);
      else {
        const e = (props.round ?? 0) * s * k * REACH + m;
        quad(0, 0, w, y0 + e), quad(0, y1 - e, w, h), quad(0, 0, x0 + e, h), quad(x1 - e, 0, w, h);
      }
      key += `${r.left},${r.top},${r.width},${r.height},${fade},${props.dye},${props.round};`;
      n++;
    }
    if (key === seen) return;
    seen = key;
    if (off.width !== w || off.height !== h) [off.width, off.height] = [w, h];
    gl.viewport(0, 0, w, h);
    gl.uniform4fv(uBox, boxes);
    gl.uniform4fv(uCorner, corners);
    gl.uniform4fv(uDye, dyes);
    gl.uniform1i(uCount, n);
    gl.uniform3f(uSize, w, h, MELT * k);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quads), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, quads.length / 2);
    shown.transferFromImageBitmap(off.transferToImageBitmap());
  };
  const stop = everyFrame(draw);
  return () => {
    stop();
    sizes.disconnect();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
