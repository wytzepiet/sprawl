import { createEffect, on, onCleanup } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { Dots } from "../engine/dots";
import { screenToWorld, viewExtent, rectOf } from "../engine/view";
import { builtVersion, eachEntity, useGame } from "../state/gameObjects";
import { free, pen, priority, setClimb, setPen, setTool, tool } from "../ui/buildMode";
import { hand, MIDDLE, mayAt, mayStart, movesOver, nodeAtH, nodeIn, nodesOn, otherSide, snap, spot, STEPS, TOP, toward, type Hand, type Side } from "../engine/may";
import type { GridCoord, TerrainType, Tool } from "../generated";
import type { Bounds } from "../engine/OrthoCamera";

/**
 * The road brush, made for drawing roads and nothing else. A drag lays
 * the road in hand a step at a time, straight or diagonal toward the
 * pointer, a one-way running the way the drag goes; with Shift held, or
 * the eraser in hand, it pulls up what it crosses, and a tap takes the
 * tile. Only on the level's map, and never its own roads: the gates.
 *
 * The pen has a height (`pen`, in levels). A drag starts on the road at
 * the pen's height on the tile pressed, or the one there nearest it; each
 * step goes on at its height, or, short of the pen's, climbs toward it:
 * the tile after a change of height is the slope. A step onto a road
 * already there at a height it may join takes that one.
 *
 * A one-way drawn along a one-way's tiles goes beside it, side by side,
 * on the side of the road it came from, else on the right (`decks.rs`).
 * Drawn along a road on a side, a drag keeps to it; drawn onto it from its
 * own side, it joins it there. A drag pressed where two roads share a
 * tile starts on the one nearer the pointer.
 *
 * A change of the pen's height (↑ ↓) turns the end of the road last laid
 * into the slope to the new height, where it may be one: the road ends
 * there, nothing else joins it, it came to it on the level, and the tile
 * has room for a slope. The next step goes on from it at the new height.
 * Where it may not be, the pen alone changes, and the next tile drawn is
 * the slope; straight after a slope, neither.
 *
 * The dots show where a drag may start and, while dragging, the steps the
 * tile underfoot allows (`dots.ts`), as the town's brush does.
 */
export function RoadBrush(props: { ground: (x: number, y: number) => TerrainType | undefined; bounds: () => Bounds | null }) {
  const { scene, canvas, afterRender } = useEngine();
  const dots = new Dots(scene, canvas);
  const stopTick = afterRender(() => dots.frame());
  const { send } = useGame();
  if (tool() === null) setTool("Street");
  let current: GridCoord | null = null;
  /** Where on `current` the drag stands: how high, in half-levels, and
   *  on which side. */
  let place: Place = { h: 0, s: MIDDLE };
  /** The tile the drag came to `current` from. */
  let came: GridCoord | null = null;
  let pressed: GridCoord | null = null;
  let prevWorld: { wx: number; wy: number } | null = null;
  let accDx = 0;
  let accDy = 0;
  /** Shift: the eraser, for as long as it is held. */
  let erasing = false;
  const using = (): Tool | null => (erasing ? "Demolish" : tool());

  const pick = (e: { clientX: number; clientY: number }) => screenToWorld(scene, canvas, e);
  const tileOf = (e: { clientX: number; clientY: number }) => {
    const w = pick(e);
    return { x: Math.floor(w.wx), y: Math.floor(w.wy) };
  };
  const send_ = (tool: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place, road = priority()) =>
    send({
      type: "Build",
      data: {
        tool, from, to, road,
        ...(pf.h || pt.h ? { up: [pf.h, pt.h] as [number, number] } : {}),
        ...(sided(pf) || sided(pt) ? { sides: [pf.s, pt.s] as [Side, Side] } : {}),
      },
    });
  /** The last step of road laid: its end is what a change of height makes
   *  a slope. */
  let last: { from: GridCoord; pf: Place; to: GridCoord; pt: Place } | null = null;
  const step = (from: GridCoord, pf: Place, to: GridCoord, pt: Place) => {
    const t = using();
    if (t === null) return;
    send_(t, from, pf, to, pt);
    if (t !== "Demolish" && t !== "Light" && (from.x !== to.x || from.y !== to.y)) last = { from, pf, to, pt };
  };

  const edge = (a: { id: number; node: { outgoing: number[]; incoming: number[] } }, b: { id: number; node: { incoming: number[] } }) => a.node.outgoing.includes(b.id) || b.node.incoming.includes(a.id);
  /** The height the end of the last road laid would take as the slope a
   *  level up (1) or down (-1), if it may be one: a road in the middle of
   *  its tile, as a slope has the tile to itself. */
  const slopeTo = (by: 1 | -1): number | null => {
    if (!world || !last || sided(last.pf) || sided(last.pt)) return null;
    const { from, pf: { h: hf }, to, pt: { h: ht } } = last;
    const [f, t] = [nodeAtH(world, from, hf), nodeAtH(world, to, ht)];
    if (!f || !t || !t.node.laid || hf !== ht || ht % 2) return null;
    const arms = new Set([...t.node.outgoing, ...t.node.incoming]);
    if (arms.size !== 1 || !arms.has(f.id)) return null;
    const h = ht + by;
    if (h < 1 || h > TOP - 1 || !inside(to)) return null;
    if (world.occupied.has(`${to.x},${to.y}`) || props.ground(to.x, to.y) === "Mountain") return null;
    // Room for it among the tile's other roads (`World::room_at`).
    return nodesOn(world, to).every(([g, n]) => n.id === t.id || Math.abs(g - h) >= 2 + (g % 2) + (h % 2)) ? h : null;
  };
  /** The end of the last road laid made the slope at height h: taken up
   *  and laid again, as it ran, with what it had; and the pen at the
   *  level it leads to. */
  const makeSlope = (by: 1 | -1, h: number) => {
    const { from, pf, to, pt } = last!;
    const [f, t] = [nodeAtH(world!, from, pf.h)!, nodeAtH(world!, to, pt.h)!];
    const road = f.node.road && t.node.road;
    const [out, back] = [edge(f, t), edge(t, f)];
    const wide = f.node.wide.includes(t.id) || t.node.wide.includes(f.id);
    const up: Place = { h, s: MIDDLE };
    send_("Demolish", from, pf, to, pt, false);
    if (out && back) send_("Street", from, pf, to, up, road);
    else if (out) send_(wide ? "Wide" : "OneWay", from, pf, to, up, road);
    else send_(wide ? "Wide" : "OneWay", to, up, from, pf, road);
    last = { from, pf, to, pt: up };
    if (current && current.x === to.x && current.y === to.y) place = up;
    setPen((h + by) / 2);
  };
  /** What ↑ and ↓ do now: make the end of the last road laid the slope,
   *  where it may be one; else move the pen, and the next tile drawn is
   *  the slope; but not straight after a slope, which is never two. */
  const offerClimb = () => {
    const linked = !!world && !!last && !!nodeIn(world, last.to, last.pt.h, last.pt.s);
    const [up, down] = linked ? [slopeTo(1), slopeTo(-1)] : [null, null];
    const sloped = linked && last!.pt.h % 2 === 1;
    setClimb({
      up: up !== null ? () => makeSlope(1, up) : pen() < 3 && !sloped ? free(1) : null,
      down: down !== null ? () => makeSlope(-1, down) : pen() > 0 && !sloped ? free(-1) : null,
    });
  };
  /** Where a drag pressed here, at this point of the tile, stands: on the
   *  road at the pen's height, or the one there nearest it, the nearer
   *  the pointer of two side by side; or at the pen's height. */
  const startAt = (t: GridCoord, wx: number, wy: number): Place => {
    const want = pen() * 2;
    const on = world ? nodesOn(world, t) : [];
    if (!on.length) return { h: want, s: MIDDLE };
    const off = ([, n]: (typeof on)[number]) => {
      const [x, y] = spot(t, n.node.side ?? MIDDLE);
      return Math.abs(n.node.height - want) * 10 + Math.hypot(x - wx, y - wy);
    };
    const [, n] = on.sort((a, b) => off(a) - off(b))[0];
    return { h: n.node.height, s: n.node.side ?? MIDDLE };
  };
  /** The sides a step from `at` (on `p`) to `to` at height `h` may take,
   *  the likeliest first: on along a road on a side; onto a road on a
   *  side from its own side; beside a one-way there, on the side the drag
   *  came from, else on the right; else the middle. */
  const sidesFor = (at: GridCoord, p: Place, to: GridCoord, h: number): Side[] => {
    const d: [number, number] = [to.x - at.x, to.y - at.y];
    const right: Side = [-d[1], d[0]];
    const from = came ? toward([came.x - at.x, came.y - at.y], right) : 0;
    const first: Side = from < 0 ? otherSide(right) : right;
    const there = nodesOn(world!, to).filter(([g]) => g === h).map(([, n]) => n.node.side ?? MIDDLE);
    const out: Side[] = [];
    if (sided(p) && toward(d, p.s) === 0) out.push(p.s);
    for (const s of there) if (toward([at.x - to.x, at.y - to.y], s) > 0) out.push(s);
    const m = nodeAtH(world!, to, h);
    const fromNode = nodeIn(world!, at, p.h, p.s);
    if (there.some((s) => s[0] || s[1]) || (m && !(fromNode && edge(fromNode, m)) && movesOver(world!, to, h, first))) out.push(first, otherSide(first));
    out.push(MIDDLE);
    return out;
  };
  /** Where a step from `at` (on `p`) to `to` would stand: the road there
   *  it may join, at the height it goes on at or climbs to and the side
   *  `sidesFor` gives; null where it may not go. The eraser takes
   *  whatever road joins them. */
  const stepTo = (at: GridCoord, p: Place, to: GridCoord): Place | null => {
    const t = using();
    if (!world || t === null || t === "Light") return null;
    const want = pen() * 2;
    const there = nodesOn(world, to).map(([g, n]): Place => ({ h: g, s: n.node.side ?? MIDDLE }));
    if (t === "Demolish") {
      const ok = there.filter((q) => mayAt(world!, t, at, p.h, to, q.h, false, [p.s, q.s]));
      return ok.length ? ok.sort((a, b) => Math.abs(a.h - p.h) - Math.abs(b.h - p.h))[0] : null;
    }
    const plan = p.h === want ? want : p.h + Math.sign(want - p.h);
    const heights = [plan, ...[...new Set(there.map((q) => q.h))].filter((g) => Math.abs(g - p.h) <= 1 && g !== plan).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))];
    for (const h of heights) for (const s of sidesFor(at, p, to, h)) if (allowedStep(t, at, p, to, { h, s })) return { h, s };
    return null;
  };

  let world: Hand | null = null;
  createEffect(on(builtVersion, () => {
    world = hand(eachEntity, props.ground);
    draw();
  }));
  createEffect(on([tool, pen, priority], () => draw(), { defer: true }));

  const inside = (t: GridCoord) => {
    const b = props.bounds();
    return !!b && t.x >= b.x0 && t.x <= b.x1 && t.y >= b.y0 && t.y <= b.y1;
  };
  /** One of the level's own roads: a gate's. */
  const fixed = (t: GridCoord) => world?.roads.get(`${t.x},${t.y}`)?.node.laid === false;
  /** The level's rule over the world's: the server's (`Level::allows`). */
  const allowedStep = (t: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place) => {
    if (!world) return false;
    const ground = !pf.h && !pt.h && !sided(pf) && !sided(pt);
    if (t === "Demolish") return (from.x === to.x && from.y === to.y ? !(fixed(to) && ground) : !(fixed(from) && fixed(to) && ground)) && mayAt(world, t, from, pf.h, to, pt.h, false, [pf.s, pt.s]);
    return inside(from) && inside(to) && mayAt(world, t, from, pf.h, to, pt.h, priority(), [pf.s, pt.s]);
  };
  const allowed = (at: GridCoord, i: number) => stepTo(at, place, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] }) !== null;
  const mayStartHere = (t: Tool, at: GridCoord) =>
    !!world && (t === "Light" ? nodesOn(world, at).some(([h, n]) => mayAt(world!, t, at, h, at, h, false, [n.node.side ?? MIDDLE, n.node.side ?? MIDDLE])) : pen() > 0 && t !== "Demolish" ? inside(at) : (mayStart(world, t, at, priority()) || nodesOn(world, at).length > 0) && (t === "Demolish" ? !fixed(at) || STEPS.some(([dx, dy]) => allowedStep(t, at, GROUND, { x: at.x + dx, y: at.y + dy }, GROUND)) : inside(at)));

  const viewBox = () => {
    const rect = rectOf(canvas);
    const mid = screenToWorld(scene, canvas, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    const { halfW, halfH } = viewExtent(scene, canvas);
    const half = Math.max(halfW, halfH);
    return [Math.floor(mid.wx - half), Math.floor(mid.wy - half), Math.ceil(mid.wx + half), Math.ceil(mid.wy + half)];
  };
  let drawnOver = "";
  let frames = 0;
  const stopWatch = afterRender(() => {
    if (using() === null || current || ++frames % 15) return;
    if (viewBox().join() !== drawnOver) draw();
  });

  function draw() {
    offerClimb();
    const t = using();
    const starts: [number, number][] = [];
    const nexts: [number, number][] = [];
    const [x0, y0, x1, y1] = viewBox();
    if (world && t !== null) {
      if (current) for (const [i, [dx, dy]] of STEPS.entries()) if (allowed(current, i)) nexts.push([current.x + dx, current.y + dy]);
      drawnOver = [x0, y0, x1, y1].join();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mayStartHere(t, { x, y })) starts.push([x, y]);
    }
    dots.aim(starts, nexts, current ? { x: current.x + 0.5, y: current.y + 0.5 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || using() === null) return;
    current = tileOf(e);
    prevWorld = pick(e);
    place = startAt(current, prevWorld.wx, prevWorld.wy);
    came = null;
    accDx = 0;
    accDy = 0;
    pressed = current;
    dots.grab(current, { x: prevWorld.wx, y: prevWorld.wy });
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!current || !prevWorld) return;
    const w = pick(e);
    dots.pull({ x: w.wx, y: w.wy });
    accDx += w.wx - prevWorld.wx;
    accDy += w.wy - prevWorld.wy;
    prevWorld = w;
    if (Math.max(Math.abs(accDx), Math.abs(accDy)) < 0.1) return;

    const sector = snap(accDx, accDy);
    const [sx, sy] = STEPS[sector];
    let cur = current!;
    for (let i = 0; i < 50; i++) {
      const dist = Math.max(Math.abs(w.wx - (cur.x + 0.5)), Math.abs(w.wy - (cur.y + 0.5)));
      if (dist < 0.6) break;
      const next: GridCoord = { x: cur.x + sx, y: cur.y + sy };
      const newDist = Math.max(Math.abs(w.wx - (next.x + 0.5)), Math.abs(w.wy - (next.y + 0.5)));
      if (newDist >= dist) break;
      const q = stepTo(cur, place, next);
      if (q === null) break;
      step(cur, place, next, q);
      dots.step(next);
      came = cur;
      cur = next;
      place = q;
    }
    if (cur !== current) {
      current = cur;
      draw();
    }
    accDx = 0;
    accDy = 0;
  };

  const onPointerUp = () => {
    if (pressed && current === pressed && using() === "Demolish" && !(fixed(pressed) && !place.h && !sided(place))) step(pressed, place, pressed, place);
    // Lights: a tap on a junction, where it was pressed.
    if (pressed && current === pressed && using() === "Light" && world && mayAt(world, "Light", pressed, place.h, pressed, place.h, false, [place.s, place.s])) step(pressed, place, pressed, place);
    pressed = null;
    if (current) dots.release();
    current = null;
    prevWorld = null;
    draw();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift" && erasing !== (e.type === "keydown")) {
      erasing = e.type === "keydown";
      draw();
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    stopWatch();
    stopTick();
    setTool(null);
    setClimb({ up: free(1), down: free(-1) });
  });

  return dots.el;
}

/** Where on a tile a drag stands: how high, in half-levels, and on which
 *  side (`RoadNode::height`, `RoadNode::side`). */
type Place = { h: number; s: Side };
const GROUND: Place = { h: 0, s: MIDDLE };
const sided = (p: Place) => !!(p.s[0] || p.s[1]);
