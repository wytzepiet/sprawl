import type { Color3, Scene } from "@babylonjs/core";
import { snap, STEPS } from "./may";
import { projector } from "./view";

/**
 * The hand's dots, drawn flat over the scene on canvases of their own: a
 * small faint one on every tile a drag may start from, and while dragging
 * a full one on every step the tile underfoot allows, the tile itself
 * held by a bigger one, and a drop drawn out of it along the step the
 * pointer points. The drag's shapes are drawn on a canvas seen through a
 * blur and a hard edge (the "goo" filter), so what comes near runs
 * together like liquid: the drop hangs off its tile on a stream that
 * thins as it stretches, and the dot of the step it points leans toward
 * it and swells until the two meet. When the step lands that dot pops. A
 * step refused, the drop strains half as far and no further.
 *
 * Every dot is a spring: its size eases toward shown or gone and a
 * little past, so dots grow and shrink in and out rather than blink,
 * and fade with their size. Positions are in tiles; the scene's own
 * projection puts them on the screen each frame.
 */

/** How big each dot is, in tiles. */
const START_R = 0.07;
const NEXT_R = 0.13;
const HERE_R = 0.24;
const DROP_R = 0.19;
/** How far along a step the drop may be drawn, of the way to the next
 *  tile: there, or refused. */
const REACH = 0.85;
const STRAIN = 0.4;
/** The size spring: stiff, and a little under-damped, so it overshoots. */
const STIFF = 260;
const DAMP = 2 * Math.sqrt(STIFF) * 0.55;
/** The drop follows the pointer on a looser one. */
const DROP_STIFF = 420;
const DROP_DAMP = 2 * Math.sqrt(DROP_STIFF) * 0.7;
/** A pop's kick to a dot's size, per second. */
const POP = 9;
/** The starts faint; the drag's shapes are opaque, run together. */
const START_ALPHA = 0.5;
/** The goo's blur, in tiles: how near shapes run together. */
const GOO = 0.07;
/** Beads in the stream between the drop and its tile. */
const BEADS = 6;
/** Just over the roads, under anything standing: where the dots lie. */
const Z = 0.08;

type Kind = "start" | "next" | "here";
interface Dot {
  x: number;
  y: number;
  kind: Kind;
  /** Size, 0 gone to 1 shown, and how fast it moves. */
  s: number;
  v: number;
  /** Where its size is going, and how long before it sets off. */
  to: number;
  wait: number;
}

const RADIUS: Record<Kind, number> = { start: START_R, next: NEXT_R, here: HERE_R };

export class Dots {
  /** What Brush puts on the page: the two canvases and the filter. */
  readonly el: HTMLDivElement;
  private plain: CanvasRenderingContext2D;
  private goo: CanvasRenderingContext2D;
  private blur: SVGFEGaussianBlurElement;
  private dots = new Map<string, Dot>();
  /** The drop: where it is and how fast it goes, in tiles; its size;
   *  the tile it hangs off; and where it is pulled. */
  private drop = { x: 0, y: 0, vx: 0, vy: 0, s: 0, v: 0, to: 0 };
  private anchor: { x: number; y: number } | null = null;
  /** Is the drag still holding on, or has the drop been let go. */
  private held = false;
  private pointer = { x: 0, y: 0 };
  /** The tile of the step the drop reaches for, if that step may be taken. */
  private toward: { x: number; y: number } | null = null;
  /** Was anything drawn last frame: one clear is owed when it all goes. */
  private drawn = false;

  constructor(private scene: Scene, private view: HTMLCanvasElement, private ink: () => Color3) {
    this.el = document.createElement("div");
    this.el.className = "fixed inset-0 pointer-events-none";
    // A blur, then alpha pushed hard to opaque or nothing: shapes near
    // enough that their blurs overlap come out as one.
    this.el.innerHTML = `<svg width="0" height="0" style="position:absolute"><filter id="hand-goo" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="4"/><feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11"/></filter></svg>`;
    this.blur = this.el.querySelector("feGaussianBlur")!;
    const layer = (filter: string) => {
      const c = document.createElement("canvas");
      c.style.cssText = `position:absolute;inset:0;width:100vw;height:100vh;${filter}`;
      this.el.appendChild(c);
      return c.getContext("2d")!;
    };
    this.plain = layer("");
    this.goo = layer("filter:url(#hand-goo)");
  }

  /** What should show: dots on these tiles, the others go. Those that
   *  come, come in a ripple out from `from`. */
  aim(starts: [number, number][], nexts: [number, number][], from: { x: number; y: number }) {
    for (const d of this.dots.values()) d.to = 0;
    const show = (kind: Kind, x: number, y: number) => {
      const key = `${kind}${x},${y}`;
      const d = this.dots.get(key);
      if (d) return void ((d.to = 1), (d.wait = 0));
      const wait = Math.min(0.3, Math.hypot(x + 0.5 - from.x, y + 0.5 - from.y) * 0.012);
      this.dots.set(key, { x, y, kind, s: 0, v: 0, to: 1, wait });
    };
    for (const [x, y] of starts) show("start", x, y);
    for (const [x, y] of nexts) show("next", x, y);
    if (this.anchor && this.held) show("here", this.anchor.x, this.anchor.y);
  }

  /** The drag takes hold of a tile: the drop wells up out of it. */
  grab(at: { x: number; y: number }, pointer: { x: number; y: number }) {
    this.anchor = at;
    this.held = true;
    this.pointer = pointer;
    Object.assign(this.drop, { x: at.x + 0.5, y: at.y + 0.5, vx: 0, vy: 0, to: 1 });
  }

  pull(pointer: { x: number; y: number }) {
    this.pointer = pointer;
  }

  /** A step landed on this tile: it holds the drop now, and pops. */
  step(to: { x: number; y: number }) {
    this.anchor = to;
    const key = `here${to.x},${to.y}`;
    const d = this.dots.get(key) ?? { x: to.x, y: to.y, kind: "here" as const, s: 1, v: 0, to: 1, wait: 0 };
    d.v += POP;
    this.dots.set(key, d);
  }

  /** Let go: the drop runs back into its tile and both go. */
  release() {
    this.drop.to = 0;
    this.held = false;
  }

  /** One frame: everything moves on, and is drawn. */
  frame() {
    const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000);
    let alive = false;
    for (const [key, d] of this.dots) {
      if (d.wait > 0) {
        d.wait -= dt;
        alive = true;
        continue;
      }
      spring(d, d.to, STIFF, DAMP, dt);
      if (d.to === 0 && d.s <= 0.01) this.dots.delete(key);
      else alive = true;
    }
    const p = this.drop;
    spring(p, p.to, STIFF, DAMP, dt);
    if (p.to > 0 || p.s > 0.01) {
      alive = true;
      // Drawn along the step the pointer points, as far as it points and
      // no further than the step reaches; let go, back into its tile.
      const a = this.anchor ? { x: this.anchor.x + 0.5, y: this.anchor.y + 0.5 } : { x: p.x, y: p.y };
      let [tx, ty] = [0, 0];
      this.toward = null;
      if (this.held && this.anchor) {
        const [ox, oy] = [this.pointer.x - a.x, this.pointer.y - a.y];
        const [dx, dy] = STEPS[snap(ox, oy)];
        const len = Math.hypot(dx, dy);
        const next = { x: this.anchor.x + dx, y: this.anchor.y + dy };
        const open = this.dots.has(`next${next.x},${next.y}`);
        if (open) this.toward = next;
        const along = Math.min(Math.max(0, (ox * dx + oy * dy) / len), (open ? REACH : STRAIN) * len);
        [tx, ty] = [(dx / len) * along, (dy / len) * along];
      }
      const ax = DROP_STIFF * (a.x + tx - p.x) - DROP_DAMP * p.vx;
      const ay = DROP_STIFF * (a.y + ty - p.y) - DROP_DAMP * p.vy;
      p.vx += ax * dt;
      p.vy += ay * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (alive || this.drawn) this.draw();
    this.drawn = alive;
  }

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    for (const ctx of [this.plain, this.goo]) {
      if (ctx.canvas.width !== w || ctx.canvas.height !== h) [ctx.canvas.width, ctx.canvas.height] = [w, h];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
    if (!this.dots.size && this.drop.s <= 0.01) return;

    // Looking straight down the map lands on the screen by one affine
    // map: where a tile's corner and its two edges go says where all go.
    const project = projector(this.scene, this.view);
    const o = project.at(0, 0, Z), ex = project.at(1, 0, Z), ey = project.at(0, 1, Z);
    const [ux, uy, vx, vy] = [ex.sx - o.sx, ex.sy - o.sy, ey.sx - o.sx, ey.sy - o.sy];
    const scale = Math.hypot(ux, uy);
    const at = (x: number, y: number): [number, number] => [o.sx + x * ux + y * vx, o.sy + x * uy + y * vy];
    // The goo's blur in pixels, and what it eats off a shape's edge.
    const sigma = Math.min(14, Math.max(1, GOO * scale));
    if (Math.abs(Number(this.blur.getAttribute("stdDeviation")) - sigma) > 0.25) this.blur.setAttribute("stdDeviation", sigma.toFixed(1));
    const px = (r: number) => Math.max(1.5, r * scale);
    const ink = this.ink();
    const colour = `${Math.round(ink.r * 255)}, ${Math.round(ink.g * 255)}, ${Math.round(ink.b * 255)}`;
    const disc = (ctx: CanvasRenderingContext2D, [cx, cy]: [number, number], r: number) => {
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    };

    // The starts: crisp, faint, the ones at rest in one path.
    {
      const ctx = this.plain;
      const rest = new Path2D();
      for (const d of this.dots.values()) {
        if (d.kind !== "start" || d.s <= 0) continue;
        const c = at(d.x + 0.5, d.y + 0.5);
        const r = px(START_R) * d.s;
        if (d.s === 1) {
          rest.moveTo(c[0] + r, c[1]);
          rest.arc(c[0], c[1], r, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${colour}, ${START_ALPHA * Math.min(1, d.s * 1.4)})`;
          ctx.beginPath();
          disc(ctx, c, r);
          ctx.fill();
        }
      }
      ctx.fillStyle = `rgba(${colour}, ${START_ALPHA})`;
      ctx.fill(rest);
    }

    // The drag: every shape one colour, run together by the filter.
    const ctx = this.goo;
    ctx.fillStyle = `rgb(${colour})`;
    ctx.beginPath();
    const p = this.drop;
    const dropAt: [number, number] = [p.x, p.y];
    const lean = (x: number, y: number, by: number): [number, number] => [x + (dropAt[0] - x) * by, y + (dropAt[1] - y) * by];
    const live = p.s > 0.01;
    for (const d of this.dots.values()) {
      if (d.kind === "start" || d.s <= 0) continue;
      const [cx, cy] = [d.x + 0.5, d.y + 0.5];
      let [c, r] = [[cx, cy] as [number, number], RADIUS[d.kind] * d.s];
      if (live && d.kind === "here") c = lean(cx, cy, 0.08 * p.s);
      // The step pointed at leans toward the drop and swells as it nears.
      if (live && this.toward && d.x === this.toward.x && d.y === this.toward.y) {
        const near = Math.max(0, 1 - Math.hypot(cx - p.x, cy - p.y) / Math.SQRT2);
        c = lean(cx, cy, 0.35 * near);
        r *= 1 + 0.4 * near;
      }
      disc(ctx, at(...c), px(r) + sigma * 0.6);
    }
    if (live && this.anchor) {
      // The drop, smaller as it is drawn out, and the stream it hangs on:
      // beads from the tile to it, thinnest midway, thinner the further.
      const [ax, ay] = [this.anchor.x + 0.5, this.anchor.y + 0.5];
      const stretch = Math.min(1, Math.hypot(p.x - ax, p.y - ay));
      const rd = DROP_R * p.s * (1 - 0.3 * stretch);
      disc(ctx, at(p.x, p.y), px(rd) + sigma * 0.6);
      const here = this.dots.get(`here${this.anchor.x},${this.anchor.y}`);
      const ra = HERE_R * Math.min(here?.s ?? 0, p.s);
      for (let i = 1; i <= BEADS; i++) {
        const t = i / (BEADS + 1);
        const pinch = 1 - 0.75 * Math.sin(Math.PI * t) * stretch;
        const r = (ra + (rd - ra) * t) * 0.55 * pinch;
        if (r > 0.01) disc(ctx, at(ax + (p.x - ax) * t, ay + (p.y - ay) * t), px(r));
      }
    }
    ctx.fill();
  }
}

/** A size spring: on toward `to` and past it a little. */
function spring(d: { s: number; v: number }, to: number, stiff: number, damp: number, dt: number) {
  d.v += (stiff * (to - d.s) - damp * d.v) * dt;
  d.s = Math.max(0, d.s + d.v * dt);
  // At rest, exactly: a dot at rest is drawn with the others.
  if (Math.abs(to - d.s) < 0.002 && Math.abs(d.v) < 0.01) [d.s, d.v] = [to, 0];
}
