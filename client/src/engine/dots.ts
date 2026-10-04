import type { Color3, Scene } from "@babylonjs/core";
import { snap, STEPS } from "./may";
import { projector } from "./view";

/**
 * The hand's dots, drawn flat over the scene on a canvas of their own: a
 * small faint one on every tile a drag may start from, and while dragging
 * a full one on every step the tile underfoot allows, the tile itself
 * held by a bigger one, and a drop drawn out of it along the step the
 * pointer points, on a neck that thins as it stretches, reaching for the
 * dot of that step. When the step lands the drop is already there, and
 * that dot pops. A step refused, it strains half as far and no further.
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
/** The starts faint; the rest opaque, a drop being one body whose circles
 *  and necks overlap where they meet. */
const ALPHA: Record<Kind, number> = { start: 0.5, next: 1, here: 1 };
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
  private ctx: CanvasRenderingContext2D;
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

  constructor(private scene: Scene, private view: HTMLCanvasElement, private canvas: HTMLCanvasElement, private ink: () => Color3) {
    this.ctx = canvas.getContext("2d")!;
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
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.dots.size && this.drop.s <= 0.01) return;

    // Looking straight down the map lands on the screen by one affine
    // map: where a tile's corner and its two edges go says where all go.
    const project = projector(this.scene, this.view);
    const o = project.at(0, 0, Z), ex = project.at(1, 0, Z), ey = project.at(0, 1, Z);
    const [ux, uy, vx, vy] = [ex.sx - o.sx, ex.sy - o.sy, ey.sx - o.sx, ey.sy - o.sy];
    const scale = Math.hypot(ux, uy);
    const at = (x: number, y: number): [number, number] => [o.sx + x * ux + y * vx, o.sy + x * uy + y * vy];
    const px = (r: number) => Math.max(1.5, r * scale);

    // The dots at rest in one path a colour, the moving ones each their own.
    const ink = this.ink();
    const colour = `${Math.round(ink.r * 255)}, ${Math.round(ink.g * 255)}, ${Math.round(ink.b * 255)}`;
    for (const kind of ["start", "next", "here"] as const) {
      const rest = new Path2D();
      const alpha = ALPHA[kind];
      for (const d of this.dots.values()) {
        if (d.kind !== kind || d.s <= 0) continue;
        const [cx, cy] = at(d.x + 0.5, d.y + 0.5);
        const r = px(RADIUS[kind]) * d.s;
        if (d.s === 1) {
          rest.moveTo(cx + r, cy);
          rest.arc(cx, cy, r, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${colour}, ${alpha * Math.min(1, d.s * 1.4)})`;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = `rgba(${colour}, ${alpha})`;
      ctx.fill(rest);
    }

    // The drop, and the necks that tie it to its tile and reach for the
    // dot of the step it points.
    const p = this.drop;
    if (p.s <= 0.01) return;
    const stretch = this.anchor ? Math.min(1, Math.hypot(p.x - this.anchor.x - 0.5, p.y - this.anchor.y - 0.5)) : 0;
    const drop = { c: at(p.x, p.y), r: px(DROP_R) * p.s * (1 - 0.35 * stretch) };
    const blobs = [drop];
    if (this.anchor) {
      const here = this.dots.get(`here${this.anchor.x},${this.anchor.y}`);
      blobs.push({ c: at(this.anchor.x + 0.5, this.anchor.y + 0.5), r: px(HERE_R) * Math.min(here?.s ?? 0, p.s) });
    }
    const t = this.toward && this.dots.get(`next${this.toward.x},${this.toward.y}`);
    const reaching = t ? { c: at(t.x + 0.5, t.y + 0.5), r: px(NEXT_R) * t.s } : null;
    // Each shape filled alone: their windings differ, and filled as one
    // path the overlaps would cancel into holes.
    ctx.fillStyle = `rgb(${colour})`;
    for (const b of blobs) {
      ctx.beginPath();
      ctx.arc(b.c[0], b.c[1], b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const other of [blobs[1], reaching]) {
      if (!other) continue;
      ctx.beginPath();
      neck(ctx, drop, other);
      ctx.fill();
    }
  }
}

/** A size spring: on toward `to` and past it a little. */
function spring(d: { s: number; v: number }, to: number, stiff: number, damp: number, dt: number) {
  d.v += (stiff * (to - d.s) - damp * d.v) * dt;
  d.s = Math.max(0, d.s + d.v * dt);
  // At rest, exactly: a dot at rest is drawn with the others.
  if (Math.abs(to - d.s) < 0.002 && Math.abs(d.v) < 0.01) [d.s, d.v] = [to, 0];
}

/**
 * The neck between two drops, as liquid draws one: two curves from one
 * circle's edge to the other's, pinched in the middle, gone once they are
 * too far apart. After the metaball of Hiroyuki Sato's Paper.js example.
 */
function neck(ctx: CanvasRenderingContext2D, a: { c: [number, number]; r: number }, b: { c: [number, number]; r: number }, v = 0.5, handle = 2.4) {
  const [r1, r2] = [a.r, b.r];
  const d = Math.hypot(b.c[0] - a.c[0], b.c[1] - a.c[1]);
  const reach = (r1 + r2) * 2.6;
  if (r1 <= 0 || r2 <= 0 || d > reach || d <= Math.abs(r1 - r2)) return;
  const [u1, u2] =
    d < r1 + r2
      ? [Math.acos((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d)), Math.acos((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d))]
      : [0, 0];
  const between = Math.atan2(b.c[1] - a.c[1], b.c[0] - a.c[0]);
  const spread = Math.acos((r1 - r2) / d);
  const a1 = between + u1 + (spread - u1) * v;
  const a2 = between - u1 - (spread - u1) * v;
  const a3 = between + Math.PI - u2 - (Math.PI - u2 - spread) * v;
  const a4 = between - Math.PI + u2 + (Math.PI - u2 - spread) * v;
  const on = (c: [number, number], ang: number, r: number): [number, number] => [c[0] + Math.cos(ang) * r, c[1] + Math.sin(ang) * r];
  const [p1, p2, p3, p4] = [on(a.c, a1, r1), on(a.c, a2, r1), on(b.c, a3, r2), on(b.c, a4, r2)];
  // Thinner as it stretches: the handles shorten with the distance.
  const h = Math.min(v * handle, Math.hypot(p1[0] - p3[0], p1[1] - p3[1]) / (r1 + r2)) * Math.min(1, (d * 2) / (r1 + r2)) * (1 - d / reach);
  const [h1, h2, h3, h4] = [on(p1, a1 - Math.PI / 2, r1 * h), on(p2, a2 + Math.PI / 2, r1 * h), on(p3, a3 + Math.PI / 2, r2 * h), on(p4, a4 - Math.PI / 2, r2 * h)];
  ctx.moveTo(...p1);
  ctx.bezierCurveTo(...h1, ...h3, ...p3);
  ctx.lineTo(...p4);
  ctx.bezierCurveTo(...h4, ...h2, ...p2);
  ctx.closePath();
}
