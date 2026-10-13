import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { useEngine } from "./Canvas";
import { Dots } from "./dots";
import { projector, screenToWorld, viewExtent, rectOf } from "./view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { aim, held, hold, isRoad, priority, setAim, setPriority, setTool, tool, turn } from "../ui/buildMode";
import { fit, fits, hand, mayAt, mayStart, placing, snap, STEPS, type Hand } from "./may";
import { BLUEPRINTS, GoodIcon, GOODS } from "../blueprints";
import type { Building, Good, GridCoord, TerrainType, Tool } from "../generated";

/**
 * The mayor's hand on the map. A road or the demolisher is laid as the
 * drag goes, a step from one tile to the next, each sent as it is taken
 * (`Build { tool, from, to }`), straight or diagonal toward the pointer;
 * the demolisher's tap takes everything at its tile, a building whole,
 * and its drag cuts only the road it crosses.
 *
 * A building in hand, dragged from the build menu, is placed whole where
 * it is let go (`Place`): shown where it would stand as the town would be
 * drawn with it (`TownLayer.hold`), turned to the nearest street or, a
 * harbour, the sea, unless the hand turns it (R, the wheel, two fingers);
 * beside it, what it is built of against what the town has, or why it
 * may not go there.
 *
 * Where the hand may go is worked out here (`may.ts`) and shown by the
 * dots (`dots.ts`): one on every tile in view a drag may start from, or a
 * building may stand round, and while dragging the steps the tile it is
 * on allows. A step refused is not taken: the drag waits there, straining.
 *
 * Alt with the bare hand is the eyedropper: it picks up the road it
 * presses on, and a drag from there lays more of it.
 */
export function Brush(props: { ground: (x: number, y: number) => TerrainType | undefined }) {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  let current: GridCoord | null = null;
  /** The tile pressed on, while the hand is down. */
  let pressed: GridCoord | null = null;
  /** Has the drag taken a step yet: the next carries it on. */
  let stepped = false;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const tileOf = (e: { clientX: number; clientY: number }) => {
    const w = pick(e);
    return { x: Math.floor(w.wx), y: Math.floor(w.wy) };
  };
  /** A step sent; `on`, carrying on the drag (`Build::on`): one action
   *  to undo, and it joins the roads it meets only where it starts and
   *  ends. */
  const step = (from: GridCoord, to: GridCoord, on = false) => {
    const t = tool();
    if (t !== null) send({ type: "Build", data: { tool: t, from, to, road: priority(), on } });
  };

  // The world as the hand sees it, read again when something is built.
  let world: Hand | null = null;
  /** The tile under the pointer, while it is over the map. */
  let hover: GridCoord | null = null;
  const aimAt = () => {
    const h = held();
    setAim(world && hover && h ? placing(world, h.kind, hover, h.facing) : null);
  };
  createEffect(on(builtVersion, () => {
    world = hand(eachEntity, props.ground);
    draw();
    aimAt();
  }));
  // And drawn again when another tool or building is taken up, or turned.
  createEffect(on([tool, held, priority], () => (draw(), aimAt()), { defer: true }));
  const allowed = (at: GridCoord, i: number) => {
    const t = tool();
    return !!world && t !== null && mayAt(world, t, at, 0, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] }, 0, priority());
  };

  /** The tiles the view covers. */
  const viewBox = () => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  // Drawn again when the view moves on a tile.
  let drawnOver = "";
  let frames = 0;
  const stopWatch = afterRender(() => {
    if ((tool() === null && held() === null) || current || ++frames % 15) return;
    if (viewBox().join() !== drawnOver) draw();
  });

  /** Tell the dots what to show: the starts in view while nothing is
   *  pressed, the steps out of the tile underfoot while dragging; with a
   *  building in hand, every tile it may stand round. */
  function draw() {
    const t = tool(), h = held();
    const starts: [number, number][] = [];
    const nexts: [number, number][] = [];
    const [x0, y0, x1, y1] = viewBox();
    const start = !world ? null
      : h ? (at: GridCoord) => (h.facing === null ? fits(world!, h.kind, at) : !fit(world!, h.kind, at, h.facing).why)
      : t !== null ? (at: GridCoord) => mayStart(world!, t, at, priority())
      : null;
    if (start) {
      if (current && t !== null) for (const [i, [dx, dy]] of STEPS.entries()) if (allowed(current, i)) nexts.push([current.x + dx, current.y + dy]);
      drawnOver = [x0, y0, x1, y1].join();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (start({ x, y })) starts.push([x, y]);
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  /** What road stands at a tile, as the tool that lays it, and whether
   *  it has priority. */
  const toolAt = (at: GridCoord): [Tool, boolean] | null => {
    const n = world?.roads.get(`${at.x},${at.y}`)?.node;
    if (!n) return null;
    const oneWay = n.outgoing.some((o) => !n.incoming.includes(o)) || n.incoming.some((i) => !n.outgoing.includes(i));
    return [oneWay ? "OneWay" : "Street", n.road];
  };
  // The eyedropper: with the bare hand, Alt on a road picks up what laid
  // it, before the camera or the picker see the press, so the same drag
  // carries it on.
  const onEyedrop = (e: PointerEvent) => {
    if (e.button !== 0 || !e.altKey || tool() !== null || held() !== null) return;
    const t = toolAt(tileOf(e));
    if (t) (setPriority(t[1]), setTool(t[0]));
  };

  /** Let go with a building in hand: placed, if it may stand there, and
   *  the hand empty, unless Shift keeps it for another. */
  const place = (shift: boolean) => {
    const p = aim();
    if (!p || p.why) return;
    send({ type: "Place", data: { kind: p.kind, at: p.at, facing: p.facing } });
    if (!shift) hold(null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || held() !== null) return;
    if (tool() === null) return;
    current = tileOf(e);
    prevWorld = pick(e);
    accDx = 0;
    accDy = 0;
    // The demolisher's tap waits for the hand to come up where it went
    // down: a drag cuts only what it crosses, not the point it starts from.
    pressed = current;
    stepped = false;
    dots.grab(current, { x: prevWorld.wx, y: prevWorld.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) {
      const at = tileOf(e);
      if (at.x !== hover?.x || at.y !== hover?.y) (hover = at), aimAt();
      return;
    }
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;

    // Need enough accumulated movement to determine direction
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;

    const sector = snap(accDx, accDy);
    const [sx, sy] = STEPS[sector];
    let cur = current!;

    for (let i = 0; i < 50; i++) {
      const cx = cur.x + 0.5;
      const cy = cur.y + 0.5;
      const dist = Math.max(Math.abs(w.wx - cx), Math.abs(w.wy - cy));
      if (dist < 0.6) break;

      const next: GridCoord = { x: cur.x + sx, y: cur.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (newDist >= dist) break; // would move away from pointer
      if (!allowed(cur, sector)) break; // refused: wait here

      step(cur, next, stepped);
      stepped = true;
      dots.step(next);
      cur = next;
    }
    if (cur !== current) {
      current = cur;
      draw();
    }

    accDx = 0;
    accDy = 0;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (held() !== null && e.button === 0 && touches.size < 2) return place(e.shiftKey);
    if (pressed && current === pressed && tool() === "Demolish") step(pressed, pressed);
    pressed = null;
    if (current) dots.release();
    current = null;
    prevWorld = null;
    draw();
  };

  // Turning a building in hand: R, the wheel, or two fingers twisting.
  const onKey = (e: KeyboardEvent) => {
    if (held() === null || e.ctrlKey || e.metaKey) return;
    if (e.key === "r" || e.key === "R") turn(e.shiftKey ? -1 : 1);
    else if (e.key === "Escape") hold(null);
    else return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  let wheeled = 0;
  const onWheel = (e: WheelEvent) => {
    if (held() === null) return;
    e.preventDefault();
    // A notch a quarter turn, however fine the wheel.
    const now = performance.now();
    if (now - wheeled > 120) turn(e.deltaY > 0 ? 1 : -1), (wheeled = now);
  };
  const touches = new Map<number, { x: number; y: number }>();
  let twist: number | null = null;
  const angle = () => {
    const [a, b] = [...touches.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    twist = touches.size === 2 ? angle() : null;
  };
  const onTouchMove = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (twist === null || held() === null || touches.size !== 2) return;
    // A quarter turn for every sixty degrees the fingers twist.
    let d = angle() - twist;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > Math.PI / 3) turn(d > 0 ? 1 : -1), (twist = angle());
  };
  const onTouchUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    twist = null;
  };

  canvas.addEventListener("pointerdown", onEyedrop, { capture: true });
  canvas.addEventListener("pointerdown", onTouchDown, { capture: true });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onTouchMove);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerup", onTouchUp);
  canvas.addEventListener("pointercancel", onTouchUp);
  canvas.addEventListener("wheel", onWheel, { passive: false, capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
  const onLeave = () => ((hover = null), aimAt());
  canvas.addEventListener("pointerleave", onLeave);

  // In development, the hand put in a pose a photograph cannot drag it
  // into (`bun run look --hold`): a building held over a tile.
  if (import.meta.env.DEV)
    Object.assign(window, {
      sprawlHold: (kind: Building["kind"] | null, x: number, y: number, facing: number | null = null) => {
        if (held()?.kind !== kind || held()?.facing !== facing) hold(kind, facing);
        hover = { x, y };
        aimAt();
      },
    });

  // Beside the building in hand: what it is, what it is built of against
  // what the town has, and that it may be let go there or why not. Over
  // a plot that may not stand, its tiles in red, flat on the ground.
  const label = document.createElement("div");
  label.className = "fixed inset-0 pointer-events-none";
  const plot = document.createElement("canvas");
  plot.style.cssText = "position:absolute;inset:0;width:100vw;height:100vh";
  label.appendChild(plot);
  const unrender = render(() => <HeldLabel />, label);
  const stopLabel = afterRender(() => {
    const p = aim();
    const g = plot.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    if (plot.width !== w || plot.height !== h) [plot.width, plot.height] = [w, h];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    const tag = label.querySelector<HTMLElement>("[data-held]");
    if (!p) return;
    const project = projector(scene, canvas);
    const xs = p.tiles.map((t) => t.x), ys = p.tiles.map((t) => t.y);
    // Over the plot's far edge, clear of it.
    const top = project.at((Math.min(...xs) + Math.max(...xs) + 1) / 2, Math.max(...ys) + 1.2, 0.6);
    if (tag) [tag.style.left, tag.style.top] = [`${top.sx}px`, `${top.sy}px`];
    g.fillStyle = p.why ? "rgba(216,67,47,0.42)" : "rgba(47,123,240,0.22)";
    g.strokeStyle = p.why ? "rgba(216,67,47,0.9)" : "rgba(47,123,240,0.85)";
    g.lineWidth = 2;
    g.beginPath();
    for (const t of p.tiles) {
      const corners = [[t.x, t.y], [t.x + 1, t.y], [t.x + 1, t.y + 1], [t.x, t.y + 1]].map(([x, y]) => project.at(x, y, 0.05));
      g.moveTo(corners[0].sx, corners[0].sy);
      for (const c of corners.slice(1)) g.lineTo(c.sx, c.sy);
      g.closePath();
    }
    if (p.why) g.fill();
    g.stroke();
  });
  document.body.appendChild(label);

  onCleanup(() => {
    stopLabel();
    unrender();
    label.remove();
    canvas.removeEventListener("pointerleave", onLeave);
    setAim(null);
    canvas.removeEventListener("pointerdown", onEyedrop, { capture: true });
    canvas.removeEventListener("pointerdown", onTouchDown, { capture: true });
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onTouchMove);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointerup", onTouchUp);
    canvas.removeEventListener("pointercancel", onTouchUp);
    canvas.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("keydown", onKey, { capture: true });
    stopWatch();
    stopTick();
  });

  return dots.el;
}

/** What the town has of a good: on its standing depots' shelves; or,
 *  asked of none, how many depots stand. */
function inTown(good: Good | null): number {
  let n = 0;
  eachEntity((e) => {
    if (e.object.kind !== "Building") return;
    const b = e.object.data;
    if (b.kind === "Depot" && !b.site) n += good ? (b.stocks[good]?.level ?? 0) : 1;
  });
  return n;
}

/** The building in hand's tag: its name, what it takes against what the
 *  town has, and whether it may be let go here, or why not. */
function HeldLabel() {
  const lines = createMemo(() => {
    const p = aim();
    builtVersion();
    // The town's first depot stands at once, for nothing.
    if (!p || (p.kind === "Depot" && !inTown(null))) return [];
    return (Object.entries(BLUEPRINTS[p.kind].materials) as [Good, number][]).map(([good, n]) => ({ good, n, have: inTown(good) }));
  });
  return (
    <Show when={aim()}>
      {(p) => (
        <div data-held data-glass="toast" class="ink absolute rounded-2xl px-3.5 py-2 text-[13px] whitespace-nowrap" style={{ transform: "translate(-50%,-100%)" }}>
          <div class="flex items-center gap-2.5 font-semibold">
            <span>{BLUEPRINTS[p().kind].label}</span>
            <For each={lines()}>
              {(l) => (
                <span class="inline-flex items-center gap-1 font-medium" style={{ color: l.have >= l.n ? undefined : "#C2361F" }} title={`${l.n} ${GOODS[l.good].label}; ${Math.floor(l.have)} in the depots`}>
                  <GoodIcon good={l.good} width="13" height="13" />
                  {l.n}
                  <span class="soft font-normal">/ {Math.floor(l.have)}</span>
                </span>
              )}
            </For>
            <Show when={!lines().length}>
              <span class="soft font-normal italic">stands at once</span>
            </Show>
          </div>
          <div class="text-[12px]" style={{ color: p().why ? "#C2361F" : "#2E7D4F" }}>
            {p().why ?? (p().kind === "Harbour" && !p().door ? "The ferry berths here; a street comes with it" : "Let go to build")}
          </div>
        </div>
      )}
    </Show>
  );
}
