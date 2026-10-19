import { createEffect, For, Show } from "solid-js";
import type { Build } from "../generated";
import { LEVELS, neighbours, type LevelText } from "./levels";
import { best, layoutOf, layouts } from "./progress";

/**
 * The map of levels: each where it lies (`@at`), joined to its neighbours
 * by the road between them; open once one of them is solved (the first
 * always), and drawn as what it is, its ground and the roads built on it.
 */
export const isOpen = (l: LevelText) => l === LEVELS[0] || neighbours(l).some((n) => best(n.name) !== null);

/** A card's size and the room between, in pixels. */
const CARD: [number, number] = [230, 170];
const GAP = 46;

export default function Map(props: { go: (name: string) => void }) {
  const cols = Math.max(...LEVELS.map((l) => l.at[0])) + 1;
  const rows = Math.max(...LEVELS.map((l) => l.at[1])) + 1;
  const px = (c: number, r: number): [number, number] => [c * (CARD[0] + GAP), r * (CARD[1] + GAP)];
  const links = LEVELS.flatMap((l) => neighbours(l).filter((n) => n.name > l.name).map((n) => [l, n] as const));
  const solved = () => LEVELS.filter((l) => best(l.name) !== null).length;
  return (
    <div class="min-h-screen w-full overflow-auto" style={{ background: "radial-gradient(circle at 30% 20%, #e4ecd9, #c5d8c4)" }}>
      <div class="mx-auto px-6 py-12" style={{ width: `${cols * (CARD[0] + GAP) + 48}px` }}>
        <div class="flex items-end justify-between">
          <div>
            <h1 class="serif text-5xl font-light" style={{ color: "#2f3d38" }}>Interchange</h1>
            <p class="mt-3 max-w-xl text-[15px]" style={{ color: "#2f3d38b8" }}>
              Roads come in at the edges of each map, and their traffic wants to get across. Join them, with as little asphalt as you can, and keep it moving. Solving a map opens the ones beside it.
            </p>
          </div>
          <span class="text-[13px] font-semibold tabular-nums" style={{ color: "#2f3d38b8" }}>{solved()} / {LEVELS.length} solved</span>
        </div>
        <div class="relative mt-10" style={{ width: `${cols * (CARD[0] + GAP) - GAP}px`, height: `${rows * (CARD[1] + GAP) - GAP}px` }}>
          <svg class="absolute inset-0 overflow-visible" style={{ "z-index": 0 }} width="100%" height="100%">
            <For each={links}>
              {([a, b]) => {
                const [[ax, ay], [bx, by]] = [px(...a.at), px(...b.at)];
                const lit = () => best(a.name) !== null || best(b.name) !== null;
                return (
                  <line
                    x1={ax + CARD[0] / 2} y1={ay + CARD[1] / 2} x2={bx + CARD[0] / 2} y2={by + CARD[1] / 2}
                    stroke={lit() ? "#4a4650" : "#2f3d3833"} stroke-width={lit() ? 10 : 6} stroke-linecap="round"
                  />
                );
              }}
            </For>
          </svg>
          <For each={LEVELS}>
            {(l) => {
              const [x, y] = px(...l.at);
              return (
                <button
                  disabled={!isOpen(l)}
                  onClick={() => props.go(l.name)}
                  class="press absolute flex flex-col overflow-hidden rounded-2xl text-left shadow-md disabled:cursor-not-allowed"
                  style={{ left: `${x}px`, top: `${y}px`, width: `${CARD[0]}px`, height: `${CARD[1]}px`, color: "#2f3d38", cursor: isOpen(l) ? "pointer" : undefined, "z-index": 1, background: "#fbfcf8" }}
                >
                  <Thumbnail level={l} open={isOpen(l)} />
                  <div class="flex items-center justify-between px-3 py-2">
                    <span class="serif truncate text-[17px]">{l.title}</span>
                    <Show when={best(l.name)} fallback={<span class="text-[11px] font-semibold opacity-50">{isOpen(l) ? "open" : "locked"}</span>}>
                      {(b) => <span class="text-[14px] font-semibold tabular-nums">{b().toFixed(1)}%</span>}
                    </Show>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

const GROUND: Record<string, string> = { "~": "#6f9fc4", "≈": "#5f8fb8", T: "#4f7a45", _: "#d9cfa3", "^": "#9a958c" };
const GRASS = "#9fbf7c";

/** A level drawn small: its ground, its gates, and the roads built on it
 *  (`layoutOf`), the higher the paler. Locked, under a fog. */
function Thumbnail(props: { level: LevelText; open: boolean }) {
  let canvas!: HTMLCanvasElement;
  const { rows } = props.level;
  const [w, h] = [Math.max(...rows.map((r) => r.length)), rows.length];
  createEffect(() => {
    layouts();
    const g = canvas.getContext("2d")!;
    const [cw, ch] = [CARD[0] * 2, (CARD[1] - 38) * 2];
    [canvas.width, canvas.height] = [cw, ch];
    const s = Math.min(cw / w, ch / h);
    const [ox, oy] = [(cw - w * s) / 2, (ch - h * s) / 2];
    g.fillStyle = GRASS;
    g.fillRect(0, 0, cw, ch);
    rows.forEach((row, r) =>
      [...row].forEach((c, col) => {
        g.fillStyle = /\d/.test(c) ? "#3c3a40" : (GROUND[c] ?? GRASS);
        g.fillRect(ox + col * s, oy + r * s, s + 0.5, s + 0.5);
      }),
    );
    // The roads, from the game's tiles back to the map's columns and rows.
    const steps: Build[] = JSON.parse(layoutOf(props.level.name) ?? "[]");
    g.lineCap = "round";
    for (const step of steps) {
      const up = Math.max(...(step.up ?? [0, 0]));
      g.strokeStyle = up ? `rgb(${120 + up * 18},${118 + up * 18},${125 + up * 18})` : "#3c3a40";
      g.lineWidth = s * 0.55;
      const at = (p: { x: number; y: number }): [number, number] => [ox + (w - 1 - p.x + 0.5) * s, oy + (-p.y + 0.5) * s];
      const [[x0, y0], [x1, y1]] = [at(step.from), at(step.to)];
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    if (!props.open) {
      g.fillStyle = "rgba(236,240,232,0.78)";
      g.fillRect(0, 0, cw, ch);
    }
  });
  return <canvas ref={canvas} class="block w-full" style={{ height: `${CARD[1] - 38}px` }} />;
}
