import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { projector } from "./view";
import { eaves } from "./town/mass";
import { storeysOf } from "./town/grid";
import { builtVersion, buildingAt, getObjectsAt } from "../state/gameObjects";
import { drafts, lastDone, myMarks, theirMarks } from "../state/drafts";
import { plot } from "../blueprints";
import type { Building, BuildingKind, Mark } from "../generated";

/**
 * The drafts on the map (docs/game.md §Drafts), drawn flat over the scene
 * on canvases of their own as the hand's dots are: a drafted road a broad
 * band from tile to tile, a drafted building a box as tall as its kind
 * stands, each look on a canvas of its own seen through at a strength, so
 * what is drawn of one draft runs together into one translucent shape. Our
 * own draft is blue, a step that no longer fits amber, anyone else's grey;
 * what we have drafted to come down is red over the thing itself, which
 * goes on working. A ghost grows in as it is drawn and shrinks away when
 * taken back; built, it flashes pale and sinks into the ground, where its
 * site or its road stands.
 */
type Look = "mine" | "stuck" | "theirs" | "doomed";
const LOOKS: Record<Look, { side: string; top: string; opacity: number }> = {
  mine: { side: "#2F7BF0", top: "#86B9FF", opacity: 0.55 },
  stuck: { side: "#E39220", top: "#FFD27A", opacity: 0.62 },
  theirs: { side: "#7F8898", top: "#C2C8D3", opacity: 0.4 },
  doomed: { side: "#E0402F", top: "#FF8D7D", opacity: 0.5 },
};
/** A road's band, of a tile; a box's inset from its tile's edge. */
const BAND = 0.62;
const INSET = 0.07;
/** How long a built ghost takes to land, in seconds. */
const LAND = 0.65;
/** The size spring: quick, and a little over. */
const STIFF = 220;
const DAMP = 2 * Math.sqrt(STIFF) * 0.6;

interface Shape {
  look: Look;
  /** A band from tile to tile, or a box on a tile this tall. */
  a: [number, number];
  b?: [number, number];
  h: number;
  /** A kind that grows into one building: its tiles stand as one box. */
  join?: BuildingKind;
}
interface Ghost extends Shape {
  s: number;
  v: number;
  to: number;
  /** Landing, as built: how far, 0 to 1. */
  land: number | null;
}

const key = (s: Shape) => `${s.look}:${s.a}:${s.b ?? ""}`;
const tall = (kind: BuildingKind) => eaves({ kind, storeys: storeysOf(kind) }) + 0.12;

/** What a step drafted looks like on the map. */
function shapesOf(m: Mark, look: Look): Shape[] {
  const { tool, from, to } = m.step;
  if (tool === "Demolish") {
    // The live thing itself, in red: a building whole, a road's tile, or
    // what joins two tiles.
    if (from.x !== to.x || from.y !== to.y) return [{ look: "doomed", a: [from.x, from.y], b: [to.x, to.y], h: 0 }];
    const b = buildingAt(to.x, to.y)?.object.data as Building | undefined;
    if (b) return b.tiles.map((t) => ({ look: "doomed", a: [t.x, t.y], h: tall(b.kind) + 0.02 }));
    return getObjectsAt(to.x, to.y).some((o) => o.object.kind === "RoadNode") ? [{ look: "doomed", a: [to.x, to.y], h: 0.04 }] : [];
  }
  if (typeof tool !== "string") {
    const [w, d] = plot(tool.Building, 0).size;
    return [{ look, a: [to.x, to.y], h: tall(tool.Building), join: w * d > 1 ? tool.Building : undefined }];
  }
  return [{ look, a: [from.x, from.y], b: [to.x, to.y], h: 0 }];
}

export function Ghosts() {
  const { scene, canvas, afterRender } = useEngine();
  const el = document.createElement("div");
  el.className = "fixed inset-0 pointer-events-none";
  const layer = (opacity: number) => {
    const c = document.createElement("canvas");
    c.style.cssText = `position:absolute;inset:0;width:100vw;height:100vh;opacity:${opacity}`;
    el.appendChild(c);
    return c.getContext("2d")!;
  };
  const layers = Object.fromEntries((Object.keys(LOOKS) as Look[]).map((l) => [l, layer(LOOKS[l].opacity)])) as Record<Look, CanvasRenderingContext2D>;
  // What lands is drawn over the rest, pale and nearly solid.
  const landing = layer(0.9);
  const ghosts = new Map<string, Ghost>();

  createEffect(on([drafts, builtVersion], () => {
    const want = new Map<string, Shape>();
    for (const m of myMarks()) for (const s of shapesOf(m, m.stuck ? "stuck" : "mine")) want.set(key(s), s);
    for (const m of theirMarks()) for (const s of shapesOf(m, "theirs")) if (s.look !== "doomed") want.set(key(s), s);
    const built = lastDone() === "commit";
    for (const [k, g] of ghosts) {
      if (want.has(k) || g.to === 0) continue;
      g.to = 0;
      if (built && g.look === "mine") g.land = 0;
    }
    for (const [k, s] of want) {
      const g = ghosts.get(k);
      if (g) Object.assign(g, s, { to: 1, land: null });
      else ghosts.set(k, { ...s, s: 0, v: 0, to: 1, land: null });
    }
  }));

  let last = performance.now();
  let drawn = false;
  const stop = afterRender(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const [k, g] of ghosts) {
      if (g.land !== null) {
        g.land += dt / LAND;
        if (g.land >= 1) ghosts.delete(k);
        continue;
      }
      g.v += (STIFF * (g.to - g.s) - DAMP * g.v) * dt;
      g.s += g.v * dt;
      if (g.to === 0 && g.s <= 0.01) ghosts.delete(k);
    }
    if (!ghosts.size && !drawn) return;
    drawn = ghosts.size > 0;
    draw();
  });

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    for (const ctx of [...Object.values(layers), landing]) {
      if (ctx.canvas.width !== w || ctx.canvas.height !== h) [ctx.canvas.width, ctx.canvas.height] = [w, h];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
    const project = projector(scene, canvas);
    const at = (x: number, y: number, z: number): [number, number] => {
      const p = project.at(x, y, z);
      return [p.sx, p.sy];
    };
    const o = at(0, 0, 0), e = at(1, 0, 0);
    const tile = Math.hypot(e[0] - o[0], e[1] - o[1]);
    // Bands first, under the boxes; the boxes' sides, then their tops, so
    // a row of them reads as one roof.
    const order = [...ghosts.values()].sort((p, q) => +!p.b - +!q.b);
    // Tiles of one building drafted stand as one: no gap where they meet.
    const joined = new Set(order.filter((g) => g.join).map((g) => `${g.look}${g.join}${g.land === null}${g.a}`));
    const meets = (g: Ghost, dx: number, dy: number) => !!g.join && joined.has(`${g.look}${g.join}${g.land === null}${[g.a[0] + dx, g.a[1] + dy]}`);
    // What lands, lands together: its canvas fades as one, so where its
    // bands overlap they do not show it.
    const t = Math.min(1, ...order.map((g) => g.land ?? 1));
    landing.canvas.style.opacity = `${0.9 * (1 - t * t)}`;
    for (const top of [false, true]) {
      for (const g of order) {
        const look = LOOKS[g.look];
        const ctx = g.land !== null ? landing : layers[g.look];
        // Landing: a pulse up, then down into the ground.
        const k = g.land !== null ? (t < 0.2 ? 1 + 0.6 * t : 1.12 * (1 - (t - 0.2) / 0.8) ** 2) : Math.max(0, g.s);
        ctx.globalAlpha = g.land !== null ? 1 : Math.min(1, Math.max(0, g.s));
        const [x, y] = g.a;
        if (g.b) {
          if (top) continue;
          const [bx, by] = g.b;
          ctx.strokeStyle = g.land !== null ? "#EAF3FF" : look.side;
          ctx.lineWidth = BAND * tile * k;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(...at(x + 0.5, y + 0.5, 0.02));
          ctx.lineTo(...at(bx + 0.5, by + 0.5, 0.02));
          ctx.stroke();
          continue;
        }
        const i = INSET + (1 - Math.min(1, k)) * 0.3;
        const z = g.h * k;
        const side = (dx: number, dy: number) => (meets(g, dx, dy) ? 0 : i);
        const [x0, y0, x1, y1] = [x + side(-1, 0), y + side(0, -1), x + 1 - side(1, 0), y + 1 - side(0, 1)];
        const roof = [at(x0, y0, z), at(x1, y0, z), at(x1, y1, z), at(x0, y1, z)];
        ctx.fillStyle = g.land !== null ? (top ? "#FFFFFF" : "#CFE3FF") : top ? look.top : look.side;
        ctx.beginPath();
        for (const p of top ? roof : hull([...roof, at(x0, y0, 0), at(x1, y0, 0), at(x1, y1, 0), at(x0, y1, 0)])) ctx.lineTo(...p);
        ctx.closePath();
        ctx.fill();
      }
    }
    for (const ctx of [...Object.values(layers), landing]) ctx.globalAlpha = 1;
  }

  onCleanup(() => {
    stop();
    el.remove();
  });
  return el;
}

/** The convex hull of some points, in order round it. */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: [number, number][]) => {
    const out: [number, number][] = [];
    for (const q of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}
