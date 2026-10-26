import { createSignal, Show, onCleanup } from "solid-js";
import Canvas, { Registered, useEngine } from "../engine/Canvas";
import Gpu from "../engine/Hud";
import { underGlass } from "../engine/glass";
import { Camera, type Bounds } from "../engine/Camera";
import DayNightLights, { DayNightProvider, pinTimeOfDay } from "../engine/DayNightCycle";
import { InstancePoolProvider } from "../engine/InstancePool";
import World from "../engine/World";
import { eachEntity, GameProvider, getEntity } from "../state/gameObjects";
import { projector, screenToWorld } from "../engine/view";
import { priority, setPriority, setTool, tool } from "../ui/buildMode";
import type { LevelState } from "../generated";
import { connectLevel, type LevelConnection } from "./connection";
import { climb, RoadBrush, setPen } from "./RoadBrush";
import Hud, { tell, TOOLS } from "../ui/interchange/Hud";
import { held } from "../ui/interchange/Signs";
import { best, keep, keepLayout, layoutOf } from "./progress";
import { LEVELS, neighbours, type LevelText } from "./levels";
import Map, { isOpen } from "./Map";
import { drawFlow } from "./flow";
import { drawDemand, gateRgb } from "./demand";
import { setCarColour } from "../engine/objects/CarObject";

/**
 * Interchange: the puzzle. A level is a piece of map with roads coming in
 * at its edges and traffic that wants to get from one to another; you
 * draw the roads between, then test them. The level runs in the browser,
 * on the game's own simulation (`server/interchange/src/level.rs`, `server/web`).
 */

export default function Interchange() {
  const params = new URLSearchParams(location.search);
  const [playing, setPlaying] = createSignal<string | null>(params.get("l"));
  const go = (name: string | null) => {
    history.replaceState(null, "", name ? `/interchange?l=${name}` : "/interchange");
    setPlaying(name);
  };
  return (
    <Show when={LEVELS.find((l) => l.name === playing() && (isOpen(l) || import.meta.env.DEV))} keyed fallback={<Map go={go} />}>
      {(level) => <Play level={level} back={() => go(null)} next={() => go(neighbours(level).find((n) => best(n.name) === null)?.name ?? null)} />}
    </Show>
  );
}

function Play(props: { level: LevelText; back: () => void; next: () => void }) {
  const [state, setState] = createSignal<LevelState | null>(null);
  let line: LevelConnection | null = null;
  // Each car in the colour of the gate it is bound for: the one nearest
  // where its route ends.
  setCarColour((car) => {
    const [s, end] = [state(), car.trip?.route_positions.at(-1)];
    if (!s || !end) return null;
    const near = s.gates.reduce((a, b) => (Math.hypot(a.end_x + 0.5 - end[0], a.end_y + 0.5 - end[1]) <= Math.hypot(b.end_x + 0.5 - end[0], b.end_y + 0.5 - end[1]) ? a : b));
    return gateRgb(s, near.label);
  });
  onCleanup(() => setCarColour(null));
  pinTimeOfDay(0.42);
  setPen(0);
  setPriority(false);
  onCleanup(() => (pinTimeOfDay(null), setPen(0), setPriority(false)));
  const bounds = (): Bounds | null => {
    const s = state();
    return s && { x0: s.min_x, y0: s.min_y, x1: s.max_x, y1: s.max_y };
  };
  const hear = (s: LevelState) => {
    setState(s);
    if (s.phase === "Done") keep(props.level.name, s.efficiency);
  };
  const onKey = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") return line?.send({ type: "Undo" }), e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (t) setTool(t.tool);
    else if (key === "v") setTool(null);
    else if (key === "p") setPriority(!priority());
    else if (e.key === "ArrowUp" || e.key === "PageUp") climb().up?.(), e.preventDefault();
    else if (e.key === "ArrowDown" || e.key === "PageDown") climb().down?.(), e.preventDefault();
    else if (e.key === "Escape") props.back();
    else if (e.key === " " && state()?.phase === "Build") line?.test(), e.preventDefault();
    else if (key === "z") line?.send({ type: "Undo" });
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  // A script's hand on the level (`bun run look`-style photographs).
  if (import.meta.env.DEV) Object.assign(window, { sprawlLevel: { line: () => line, state } });

  return (
    <GameProvider connect={(on) => (line = connectLevel(props.level.name, props.level.text, layoutOf(props.level.name), on, hear, (json) => keepLayout(props.level.name, json)))}>
      <DayNightProvider>
        <Canvas>
          <Camera bounds={bounds} />
          <DayNightLights>
            <Registered>
              <InstancePoolProvider>
                <World brush={() => (<><RoadBrush /><Flagger line={() => line} /></>)} />
              </InstancePoolProvider>
            </Registered>
          </DayNightLights>
          <Frame state={state} />
          <Gpu ui={() => <Hud level={props.level} state={state} line={() => line} back={props.back} next={props.next} />} />
        </Canvas>
      </DayNightProvider>
    </GameProvider>
  );
}

/** F: this moment, and the tile under the pointer, marked as something
 *  wrong in the replay the level keeps (`server/interchange/src/replay.rs`), and then
 *  what. */
function Flagger(props: { line: () => LevelConnection | null }) {
  const { scene, canvas } = useEngine();
  let at: { clientX: number; clientY: number } | null = null;
  const move = (e: PointerEvent) => (at = { clientX: e.clientX, clientY: e.clientY });
  const key = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const w = at && screenToWorld(scene, canvas, at);
    const tile: [number, number] | null = w ? [Math.floor(w.wx), Math.floor(w.wy)] : null;
    props.line()?.flag(tile);
    const note = prompt("Flagged. What looks wrong here?");
    if (note) props.line()?.note(note);
    tell(`Flagged${tile ? ` at ${tile[0]},${tile[1]}` : ""}: copy the replay to send it`);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("keydown", key);
  onCleanup(() => (window.removeEventListener("pointermove", move), window.removeEventListener("keydown", key)));
  return null;
}

/**
 * Drawn over the map: the way the one-ways run, where the held sign's
 * cars go, each junction's lights, and where a test jammed. The fog past
 * its edge and the gates' signs are the GPU's (`ui/interchange/Signs.tsx`).
 */
function Frame(props: { state: () => LevelState | null }) {
  const { scene, canvas, afterRender } = useEngine();
  const el = document.createElement("canvas");
  el.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:5";
  document.body.appendChild(el);
  const stop = afterRender(() => {
    const s = props.state();
    const g = el.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    if (el.width !== w || el.height !== h) [el.width, el.height] = [w, h];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!s) return;
    const p = projector(scene, canvas);
    // While building, the way the one-ways run.
    if (s.phase === "Build" && tool() !== null) drawFlow(g, (x, y, z) => p.at(x, y, z), performance.now() / 1000);
    // Where the held sign's cars go.
    const from = held();
    if (from) drawDemand(g, (x, y, z) => p.at(x, y, z), s, from, performance.now() / 1000);
    // Each junction's lights: a lamp before each way in, on its side of
    // the road, green where its phase is (`intersection::phases_of`).
    eachEntity((e) => {
      if (e.object.kind !== "RoadNode" || e.object.data.light == null || !e.position) return;
      const at = e.position;
      const arms = [...new Set([...e.object.data.outgoing, ...e.object.data.incoming])]
        .map((id) => getEntity(id)?.position)
        .filter((q): q is { x: number; y: number } => !!q)
        .map((q): [number, number] => [Math.sign(q.x - at.x), Math.sign(q.y - at.y)])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const phases = phasesOf(arms);
      const shown = e.object.data.light;
      for (const [dx, dy] of arms) {
        const green = shown !== ALL_RED && phases[shown]?.some(([px, py]) => px === dx && py === dy);
        const lamp = p.at(at.x + 0.5 + dx * 0.42 + dy * 0.2, at.y + 0.5 + dy * 0.42 - dx * 0.2, 0.2);
        g.fillStyle = "#1f1d22";
        g.beginPath();
        g.arc(lamp.sx, lamp.sy, 6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = green ? "#3ad16b" : "#e2412f";
        g.beginPath();
        g.arc(lamp.sx, lamp.sy, 4, 0, Math.PI * 2);
        g.fill();
      }
    });
    if (s.jam) {
      const at = p.at(s.jam[0] + 0.5, s.jam[1] + 0.5, 0);
      const t = performance.now() / 1000;
      g.strokeStyle = "#C2361F";
      g.lineWidth = 3;
      g.beginPath();
      g.arc(at.sx, at.sy, 22 + 6 * Math.sin(t * 5), 0, Math.PI * 2);
      g.stroke();
    }
    underGlass(g);
  });
  onCleanup(() => (stop(), el.remove()));
  return null;
}

/** A junction's lights between phases (`protocol::ALL_RED`). */
const ALL_RED = 255;

/** `intersection::phases_of`: the arms in their phases, each with the one
 *  straight across from it, else alone; in the server's order. */
function phasesOf(arms: [number, number][]): [number, number][][] {
  const left = [...arms];
  const phases: [number, number][][] = [];
  while (left.length) {
    const a = left.shift()!;
    const i = left.findIndex(([x, y]) => x === -a[0] && y === -a[1]);
    phases.push(i >= 0 ? [a, left.splice(i, 1)[0]] : [a]);
  }
  return phases;
}
