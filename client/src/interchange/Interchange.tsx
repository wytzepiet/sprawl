import "../app.css";
import { createSignal, For, Show, onCleanup } from "solid-js";
import Canvas, { Registered, useEngine } from "../engine/Canvas";
import { OrthoCamera, type Bounds } from "../engine/OrthoCamera";
import DayNightLights, { DayNightProvider, pinTimeOfDay } from "../engine/DayNightCycle";
import { InstancePoolProvider } from "../engine/InstancePool";
import World from "../engine/World";
import { eachEntity, GameProvider, getEntity } from "../state/gameObjects";
import { ThemeProvider } from "../engine/theme";
import Glass from "../ui/Glass";
import { projector } from "../engine/view";
import { climb, pen, priority, setPen, setPriority, setTool, tool } from "../ui/buildMode";
import type { LevelState, Tool } from "../generated";
import { connectLevel, type LevelConnection } from "./connection";
import { RoadBrush } from "./RoadBrush";
import { best, keep, keepLayout, layoutOf } from "./progress";
import { LEVELS, neighbours, type LevelText } from "./levels";
import Map, { isOpen } from "./Map";
import { drawFlow } from "./flow";

/**
 * Interchange: the puzzle. A level is a piece of map with roads coming in
 * at its edges and traffic that wants to get from one to another; you
 * draw the roads between, then test them. The level runs in the browser,
 * on the game's own simulation (`server/src/level.rs`, `server/web`).
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

/** The palette: each tool its name, its key, what it does, and its
 *  picture (a path in a 24 square, its holes cut even-odd). */
const TOOLS: { tool: Tool; key: string; name: string; label: string; glyph: string }[] = [
  { tool: "Street", key: "1", name: "Two-way", label: "A road both ways", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z" },
  { tool: "OneWay", key: "2", name: "One-way", label: "Runs the way you drag; laid back against another, a divided road", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM12 3l5.5 6.5h-4V21h-3V9.5h-4z" },
  { tool: "Wide", key: "3", name: "Two lanes", label: "One-way, two lanes: cars keep right to turn right, left to turn left", glyph: "M1.5 2h2v20h-2zM20.5 2h2v20h-2zM8 4l3.5 5H9v12H7V9H4.5zM16 4l3.5 5H17v12h-2V9h-2.5z" },
  { tool: "Light", key: "4", name: "Lights", label: "Tap a junction for traffic lights, again to take them away", glyph: "M8 1.5h8A1.5 1.5 0 0 1 17.5 3v18a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 21V3A1.5 1.5 0 0 1 8 1.5zM12 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM12 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM12 15.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z" },
  { tool: "Demolish", key: "X", name: "Bulldozer", label: "Takes up road; hold Shift for it with any tool", glyph: "M3.5 16.5h11a2.25 2.25 0 0 1 0 4.5h-11a2.25 2.25 0 0 1 0-4.5zM5 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM9 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM13 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM4 12h11v3.5H4zM5.5 6.5h5l1.2 4.5H5.5zM6.7 7.7h3l.6 2.3H6.7zM15.5 13h2.5v1.5h-2.5zM18.5 10l3-1v12.5h-3z" },
];
/** The priority road's sign, a diamond in a diamond. */
const DIAMOND = "M12 1 23 12 12 23 1 12zM12 4.2 19.8 12 12 19.8 4.2 12z";
const DIAMOND_IN = "M12 6.8 17.2 12 12 17.2 6.8 12z";

/** A button's key, small in its corner. */
function KeyCap(props: { children: string }) {
  return <span class="absolute -right-0.5 -top-0.5 rounded-md px-1 text-[9px] font-bold leading-[14px]" style={{ background: "rgb(var(--ink) / 0.12)" }}>{props.children}</span>;
}

function Glyph(props: { d: string; fill?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" fill-rule="evenodd" aria-hidden="true">
      <path d={props.d} fill={props.fill} />
    </svg>
  );
}

function Play(props: { level: LevelText; back: () => void; next: () => void }) {
  const [state, setState] = createSignal<LevelState | null>(null);
  let line: LevelConnection | null = null;
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
    <ThemeProvider>
      <GameProvider connect={(on) => (line = connectLevel(props.level.name, props.level.text, layoutOf(props.level.name), on, hear, (json) => keepLayout(props.level.name, json)))}>
        <DayNightProvider>
          <Canvas>
            <OrthoCamera bounds={bounds} />
            <DayNightLights>
              <Registered>
                <InstancePoolProvider>
                  <World brush={(ground) => <RoadBrush ground={ground} bounds={bounds} />} />
                </InstancePoolProvider>
              </Registered>
            </DayNightLights>
            <Frame state={state} />
          </Canvas>
          <Glass />
          <Hud level={props.level} state={state} line={() => line} back={props.back} next={props.next} />
        </DayNightProvider>
      </GameProvider>
    </ThemeProvider>
  );
}

/**
 * Drawn over the scene: everything past the map's edge under a fog, each
 * gate's label at its stub with how many wait there, and where a test
 * jammed.
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
    const projector_ = p;
    const corners = [[s.min_x, s.min_y], [s.max_x + 1, s.min_y], [s.max_x + 1, s.max_y + 1], [s.min_x, s.max_y + 1]].map(([x, y]) => p.at(x, y, 0));
    // The fog: the whole screen, less the map.
    g.fillStyle = "rgba(236,240,232,0.62)";
    g.beginPath();
    g.rect(0, 0, innerWidth, innerHeight);
    g.moveTo(corners[0].sx, corners[0].sy);
    for (const c of corners.slice(1).reverse()) g.lineTo(c.sx, c.sy);
    g.closePath();
    g.fill("evenodd");
    g.strokeStyle = "rgba(47,61,56,0.35)";
    g.lineWidth = 1.5;
    g.setLineDash([6, 6]);
    g.beginPath();
    g.moveTo(corners[0].sx, corners[0].sy);
    for (const c of corners.slice(1)) g.lineTo(c.sx, c.sy);
    g.closePath();
    g.stroke();
    g.setLineDash([]);
    // While building, the way the one-ways run.
    if (s.phase === "Build") drawFlow(g, (x, y, z) => p.at(x, y, z), performance.now() / 1000);
    // Each gate's label, out past its end.
    for (const gate of s.gates) {
      // Just past the map's edge, beside the road, so it hides no car.
      const [dx, dy] = [Math.sign(gate.end_x - gate.x), Math.sign(gate.end_y - gate.y)];
      const at = p.at(gate.x + 0.5 + dx * 1.1 + dy * 1.1, gate.y + 0.5 + dy * 1.1 + dx * 1.1, 0);
      const r = 15;
      g.fillStyle = "#2f3d38";
      g.beginPath();
      g.arc(at.sx, at.sy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "white";
      g.font = "600 15px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(gate.label, at.sx, at.sy + 0.5);
      g.font = "600 11px system-ui, sans-serif";
      const way = gate.ins && gate.outs ? "in · out" : gate.ins ? "in" : "out";
      g.fillStyle = "#2f3d38";
      g.fillText(way, at.sx, at.sy + r + 10);
      if (gate.waiting > 1) {
        g.fillStyle = gate.waiting > 5 ? "#C2361F" : "#B7791F";
        g.fillText(`${gate.waiting} waiting`, at.sx, at.sy + r + 24);
      }
    }
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
        const p = projector_.at(at.x + 0.5 + dx * 0.42 + dy * 0.2, at.y + 0.5 + dy * 0.42 - dx * 0.2, 0.2);
        g.fillStyle = "#1f1d22";
        g.beginPath();
        g.arc(p.sx, p.sy, 6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = green ? "#3ad16b" : "#e2412f";
        g.beginPath();
        g.arc(p.sx, p.sy, 4, 0, Math.PI * 2);
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

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

function Hud(props: { level: LevelText; state: () => LevelState | null; line: () => LevelConnection | null; back: () => void; next: () => void }) {
  const s = () => props.state();
  const button = "press rounded-full px-5 h-10 text-sm font-semibold cursor-pointer";
  const dark = { background: "rgb(var(--ink))", color: "rgb(var(--glass))" };
  return (
    <>
      {/* The level and its traffic. */}
      <div data-glass="panel" class="ink fixed top-6 left-6 z-50 w-72 rounded-3xl px-5 py-4 select-none">
        <div class="flex items-center gap-3">
          <button class="press soft cursor-pointer text-lg" title="All levels (Esc)" onClick={props.back}>←</button>
          <span class="serif text-2xl">{props.level.title}</span>
        </div>
        <For each={props.level.notes}>{(n) => <p class="soft mt-1.5 text-[13px] leading-snug">{n}</p>}</For>
        <div class="mt-3 space-y-1">
          <For each={s()?.wants ?? []}>
            {(w) => (
              <div class="flex items-center justify-between text-[13px]">
                <span class="flex items-center gap-1.5 font-semibold">
                  <Badge>{w.from}</Badge>→<Badge>{w.to}</Badge>
                  <span class="soft font-normal">{w.per_min} cars/min</span>
                </span>
                <Show when={s()?.phase !== "Build"} fallback={<span style={{ color: w.joined ? "#2E7D4F" : "#C2361F" }}>{w.joined ? "joined" : "no road"}</span>}>
                  <span class="tabular-nums">{w.delivered}/{w.due}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class="mt-3 flex items-baseline justify-between" style={{ "border-top": "1px solid rgb(var(--ink) / 0.1)", "padding-top": "10px" }}>
          <span class="soft text-[12px] font-bold uppercase tracking-widest">Asphalt</span>
          <span class="tabular-nums">
            <span class="text-xl font-semibold">{s()?.cost ?? 0}</span>
            <span class="soft text-sm"> / {s()?.par ?? 0} par</span>
          </span>
        </div>
        <div class="soft mt-2 text-[11px] leading-snug">
          Drag to draw · 1–4 roads and lights · X bulldoze (or hold Shift) · P priority · ↑↓ height · Z undo · Space test · right-drag to pan
        </div>
        <Show when={s()?.phase === "Build" && (s()?.cost ?? 0) > 0}>
          <button class="press soft mt-2 text-[12px] underline cursor-pointer" onClick={() => confirm("Take up every road you built here?") && props.line()?.send({ type: "ResetWorld" })}>
            Start over
          </button>
        </Show>
      </div>

      {/* What the hand holds, said over the palette. */}
      <Show when={TOOLS.find((t) => t.tool === tool())}>
        {(t) => (
          <div class="ink pointer-events-none fixed bottom-[84px] left-1/2 z-50 -translate-x-1/2 whitespace-nowrap text-[13px] select-none" style={{ "text-shadow": "0 1px 3px rgb(255 255 255 / 0.8)" }}>
            <span class="font-semibold">{t().name}{t().tool !== "Light" && t().tool !== "Demolish" && priority() ? ", priority" : ""}</span>
            <span class="soft"> · {t().label}</span>
          </div>
        )}
      </Show>
      {/* The road palette. */}
      <div data-glass="bar" class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full p-1.5 select-none">
        <For each={TOOLS}>
          {(t) => (
            <button
              class="press relative flex h-11 w-11 flex-col items-center justify-center rounded-full cursor-pointer"
              classList={{ soft: tool() !== t.tool }}
              style={tool() === t.tool ? dark : {}}
              title={`${t.name}: ${t.label} (${t.key})`}
              onClick={() => setTool(t.tool)}
            >
              <Glyph d={t.glyph} />
              <KeyCap>{t.key}</KeyCap>
            </button>
          )}
        </For>
        <div class="mx-1 h-6 w-px" style={{ background: "rgb(var(--ink) / 0.15)" }} />
        {/* Priority: whatever road is drawn with it on has it. */}
        <button
          class="press relative flex h-11 items-center gap-1.5 rounded-full px-3 cursor-pointer text-[13px] font-semibold"
          classList={{ soft: !priority() }}
          style={priority() ? dark : {}}
          title="Priority: whoever joins or crosses a road drawn with it gives way. Draw along a road to give it priority, or take it (P)"
          onClick={() => setPriority(!priority())}
        >
          <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true">
            <path d={DIAMOND} fill="currentColor" fill-rule="evenodd" />
            <path d={DIAMOND_IN} fill={priority() ? "#E0B443" : "currentColor"} />
          </svg>
          Priority
          <KeyCap>P</KeyCap>
        </button>
        <div class="mx-1 h-6 w-px" style={{ background: "rgb(var(--ink) / 0.15)" }} />
        {/* The pen's height: the road drawn after a change climbs to it. */}
        <div class="flex items-center gap-0.5" title="How high you draw: the end of the road you last drew becomes the slope up or down (↑ ↓); greyed where it can't be one">
          <button class="press soft h-9 w-7 rounded-full cursor-pointer disabled:opacity-25 disabled:cursor-default" disabled={!climb().down} onClick={() => climb().down?.()}>▼</button>
          <span class="w-14 text-center text-[13px] font-semibold tabular-nums">{pen() === 0 ? "Ground" : `Level ${pen()}`}</span>
          <button class="press soft h-9 w-7 rounded-full cursor-pointer disabled:opacity-25 disabled:cursor-default" disabled={!climb().up} onClick={() => climb().up?.()}>▲</button>
        </div>
        <div class="mx-1 h-6 w-px" style={{ background: "rgb(var(--ink) / 0.15)" }} />
        <Show when={s()?.phase === "Build"} fallback={<Show when={s()?.phase === "Test"}><button class={button} style={dark} onClick={() => props.line()?.finish()}>Skip to the end</button></Show>}>
          <button class={button} style={dark} onClick={() => props.line()?.test()} title="Space">Test</button>
        </Show>
      </div>

      {/* The test as it runs, and its verdict. */}
      <Show when={s() && s()!.phase !== "Build" ? s() : null}>
        {(t) => (
          <div data-glass="panel" class="ink fixed top-6 right-6 z-50 w-72 rounded-3xl px-5 py-4 select-none">
            <Show when={t().phase === "Test"}>
              <div class="soft text-[12px] font-bold uppercase tracking-widest">Testing</div>
              <div class="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "rgb(var(--ink) / 0.1)" }}>
                <div class="h-full rounded-full" style={{ width: pct(t().test_ms / t().test_total_ms), background: "#7B77E0" }} />
              </div>
              <div class="soft mt-2 text-[13px]">Flow so far {pct(t().flow / Math.max(1e-9, t().par_flow))} of par</div>
            </Show>
            <Show when={t().phase === "Jammed"}>
              <div class="text-[12px] font-bold uppercase tracking-widest" style={{ color: "#C2361F" }}>Jammed</div>
              <div class="serif mt-1 text-2xl">{t().message}</div>
              <button class={`${button} mt-3`} style={dark} onClick={() => props.line()?.build()}>Back to building</button>
            </Show>
            <Show when={t().phase === "Done"}>
              <div class="soft text-[12px] font-bold uppercase tracking-widest">Efficiency</div>
              <div class="serif text-6xl font-light tabular-nums">{t().efficiency.toFixed(1)}<span class="text-3xl">%</span></div>
              <div class="soft mt-2 space-y-0.5 text-[13px]">
                <div class="flex justify-between"><span>Flow</span><span class="tabular-nums">{pct(t().flow / Math.max(1e-9, t().par_flow))} of par</span></div>
                <div class="flex justify-between"><span>Asphalt</span><span class="tabular-nums">{t().cost} for a par of {t().par}</span></div>
                <Show when={best(props.level.name)}>{(b) => <div class="flex justify-between"><span>Your best</span><span class="tabular-nums">{b().toFixed(1)}%</span></div>}</Show>
              </div>
              <div class="mt-3 flex gap-2">
                <button class={button} style={{ background: "rgb(var(--ink) / 0.08)" }} onClick={() => props.line()?.build()}>Improve</button>
                <button class={button} style={dark} onClick={props.next}>Next level</button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

function Badge(props: { children: string }) {
  return <span class="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: "rgb(var(--ink))", color: "rgb(var(--glass))" }}>{props.children}</span>;
}
