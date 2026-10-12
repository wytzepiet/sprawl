import "../app.css";
import { createSignal, For, Show, onCleanup } from "solid-js";
import Canvas, { Registered, useEngine } from "../engine/Canvas";
import { OrthoCamera, type Bounds } from "../engine/OrthoCamera";
import DayNightLights, { DayNightProvider, pinTimeOfDay } from "../engine/DayNightCycle";
import { InstancePoolProvider } from "../engine/InstancePool";
import World from "../engine/World";
import { GameProvider } from "../state/gameObjects";
import { ThemeProvider } from "../engine/theme";
import Glass from "../ui/Glass";
import { projector } from "../engine/view";
import { setTool, tool } from "../ui/buildMode";
import type { LevelState, Tool } from "../generated";
import { connectLevel, type LevelConnection } from "./connection";
import { RoadBrush } from "./RoadBrush";
import { best, keep } from "./progress";

/**
 * Interchange: the puzzle. A level is a piece of map with roads coming in
 * at its edges and traffic that wants to get from one to another; you
 * draw the roads between, then test them. The level runs in the browser,
 * on the game's own simulation (`server/src/level.rs`, `server/web`).
 */

export interface LevelText {
  name: string;
  title: string;
  notes: string[];
  text: string;
}

export const LEVELS: LevelText[] = Object.entries(
  import.meta.glob<string>("../../../server/levels/*.txt", { query: "?raw", import: "default", eager: true }),
)
  .map(([path, text]) => {
    const notes = text.split("\n").filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s*/, ""));
    return { name: path.split("/").pop()!.replace(/\.txt$/, ""), title: notes[0] ?? "", notes: notes.slice(1), text };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export default function Interchange() {
  const params = new URLSearchParams(location.search);
  const [playing, setPlaying] = createSignal<string | null>(params.get("l"));
  const go = (name: string | null) => {
    history.replaceState(null, "", name ? `/interchange?l=${name}` : "/interchange");
    setPlaying(name);
  };
  return (
    <Show when={LEVELS.find((l) => l.name === playing())} keyed fallback={<LevelList go={go} />}>
      {(level) => <Play level={level} back={() => go(null)} next={() => {
        const i = LEVELS.findIndex((l) => l.name === level.name);
        go(LEVELS[i + 1]?.name ?? null);
      }} />}
    </Show>
  );
}

/** Every level, in order, each open once the one before it is solved. */
function LevelList(props: { go: (name: string) => void }) {
  const open = (i: number) => i === 0 || best(LEVELS[i - 1].name) !== null;
  return (
    <div class="min-h-screen w-full overflow-auto" style={{ background: "linear-gradient(160deg,#dfe9d6,#c9dccb)" }}>
      <div class="mx-auto max-w-3xl px-6 py-14">
        <h1 class="serif text-5xl font-light" style={{ color: "#2f3d38" }}>Interchange</h1>
        <p class="mt-3 max-w-xl text-[15px]" style={{ color: "#2f3d38b8" }}>
          Roads come in at the edges of each map, and their traffic wants to get across. Join them, with as little asphalt as you can, and keep it moving.
        </p>
        <div class="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <For each={LEVELS}>
            {(l, i) => (
              <button
                disabled={!open(i())}
                onClick={() => props.go(l.name)}
                class="press flex items-center justify-between rounded-2xl bg-white/80 px-5 py-4 text-left shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: "#2f3d38", cursor: open(i()) ? "pointer" : undefined }}
              >
                <span>
                  <span class="text-[11px] font-bold uppercase tracking-widest opacity-60">{i() + 1}</span>
                  <span class="serif ml-3 text-xl">{l.title}</span>
                </span>
                <Show when={best(l.name)}>{(b) => <span class="text-[15px] font-semibold tabular-nums">{b().toFixed(1)}%</span>}</Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

const TOOLS: { tool: Tool; key: string; label: string; icon: string }[] = [
  { tool: "Street", key: "1", label: "Two-way road", icon: "⇄" },
  { tool: "OneWay", key: "2", label: "One-way road: runs the way you drag", icon: "→" },
  { tool: "Demolish", key: "E", label: "Eraser (or hold Shift)", icon: "⌫" },
];

function Play(props: { level: LevelText; back: () => void; next: () => void }) {
  const [state, setState] = createSignal<LevelState | null>(null);
  let line: LevelConnection | null = null;
  pinTimeOfDay(0.42);
  onCleanup(() => pinTimeOfDay(null));
  const bounds = (): Bounds | null => {
    const s = state();
    return s && { x0: s.min_x, y0: s.min_y, x1: s.max_x, y1: s.max_y };
  };
  const hear = (s: LevelState) => {
    setState(s);
    if (s.phase === "Done") keep(props.level.name, s.efficiency);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.tool);
    else if (e.key === "Escape") props.back();
    else if (e.key === " " && state()?.phase === "Build") line?.test(), e.preventDefault();
    else if (e.key.toLowerCase() === "z") line?.send({ type: "Undo" });
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  // A script's hand on the level (`bun run look`-style photographs).
  if (import.meta.env.DEV) Object.assign(window, { sprawlLevel: { line: () => line, state } });

  return (
    <ThemeProvider>
      <GameProvider connect={(on) => (line = connectLevel(props.level.name, props.level.text, on, hear))}>
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
      </div>

      {/* The road palette. */}
      <div data-glass="bar" class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full p-1.5 select-none">
        <For each={TOOLS}>
          {(t) => (
            <button
              class="press flex h-11 w-11 flex-col items-center justify-center rounded-full cursor-pointer"
              classList={{ soft: tool() !== t.tool }}
              style={tool() === t.tool ? dark : {}}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool(t.tool)}
            >
              <span class="text-lg leading-none">{t.icon}</span>
            </button>
          )}
        </For>
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
