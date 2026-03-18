import { createSignal, createMemo, onCleanup, For } from "solid-js";
import type { ServerMessage } from "../generated";

const TIMELINE_MS = 5000;
const WINDOW_MS = 1000;
const TIMELINE_W = 260;
const ROW_H = 20;
const DOT_R = 2;
const UPDATE_INTERVAL = 200; // ms between UI refreshes (5 fps is plenty for a debug display)

const COLORS: Record<string, string> = {
  Car: "#60a5fa",
  RoadNode: "#4ade80",
  Building: "#facc15",
  Delete: "#f87171",
  Pong: "#a78bfa",
  Error: "#fb923c",
};
let colorIdx = 0;
const FALLBACK_COLORS = ["#f472b6", "#38bdf8", "#34d399", "#fbbf24", "#c084fc"];
function colorFor(key: string): string {
  if (!COLORS[key]) {
    COLORS[key] = FALLBACK_COLORS[colorIdx % FALLBACK_COLORS.length];
    colorIdx++;
  }
  return COLORS[key];
}

// Buffer: timestamps per event kind
const buffer: Record<string, number[]> = {};
// Live car count from upserts/deletes
const activeCars = new Set<number>();

let active = false;

export function trackMessage(msg: ServerMessage) {
  if (!active) return;
  const now = performance.now();
  if (msg.type === "Update") {
    for (const op of msg.data.ops) {
      if (op.op === "Upsert") {
        (buffer[op.data.object.kind] ??= []).push(now);
        if (op.data.object.kind === "Car") activeCars.add(op.data.id);
      } else {
        (buffer["Delete"] ??= []).push(now);
        activeCars.delete(op.data);
      }
    }
  } else {
    (buffer[msg.type] ??= []).push(now);
  }
}

interface Row {
  key: string;
  color: string;
  rate: number;
  dots: number[]; // x positions in [0, TIMELINE_W]
}

export default function DebugOverlay() {
  active = true;
  const [tick, setTick] = createSignal(0);
  const interval = setInterval(() => setTick((t) => t + 1), UPDATE_INTERVAL);
  onCleanup(() => { active = false; clearInterval(interval); });

  const rows = createMemo<Row[]>(() => {
    tick();
    const now = performance.now();
    const timelineCutoff = now - TIMELINE_MS;
    const rateCutoff = now - WINDOW_MS;
    const result: Row[] = [];

    for (const key in buffer) {
      const times = buffer[key];
      // prune entries older than timeline window — binary search for cutoff
      let lo = 0;
      while (lo < times.length && times[lo] < timelineCutoff) lo++;
      if (lo > 0) times.splice(0, lo);
      if (times.length === 0) continue;

      let rateCount = 0;
      const dots: number[] = [];
      for (const t of times) {
        const age = now - t;
        dots.push(TIMELINE_W * (1 - age / TIMELINE_MS));
        if (t >= rateCutoff) rateCount++;
      }

      result.push({ key, color: colorFor(key), rate: rateCount, dots });
    }
    result.sort((a, b) => b.rate - a.rate);
    return result;
  });

  const eventsPerCar = createMemo(() => {
    const carRow = rows().find((r) => r.key === "Car");
    const count = activeCars.size;
    if (!carRow || count === 0) return 0;
    return (carRow.rate / count).toFixed(1);
  });

  return (
    <div class="fixed top-3 right-3 z-50 p-3 rounded-xl bg-black/60 backdrop-blur-md text-[11px] font-mono text-white/80 select-none pointer-events-none">
      <div class="flex items-baseline justify-between mb-2 gap-6">
        <span class="text-[9px] uppercase tracking-widest text-white/40">ops/s</span>
        <span class="text-[9px] text-white/30">{TIMELINE_MS / 1000}s</span>
      </div>
      <For each={rows()} fallback={<div class="text-white/30">waiting...</div>}>
        {(row) => (
          <div class="flex items-center gap-3" style={{ height: `${ROW_H}px` }}>
            <span class="w-20 truncate text-right" style={{ color: row.color }}>{row.key}</span>
            <svg width={TIMELINE_W} height={ROW_H} class="block shrink-0">
              {/* lane line */}
              <line x1="0" y1={ROW_H / 2} x2={TIMELINE_W} y2={ROW_H / 2}
                stroke="white" stroke-opacity="0.06" stroke-width="1" />
              {/* dots */}
              <For each={row.dots}>
                {(x) => (
                  <circle cx={x} cy={ROW_H / 2} r={DOT_R}
                    fill={row.color} opacity={0.8} />
                )}
              </For>
            </svg>
            <span class="w-8 text-right tabular-nums text-white/60">{row.rate}</span>
          </div>
        )}
      </For>
      {activeCars.size > 0 && (
        <div class="mt-2 pt-2 border-t border-white/10 flex justify-between text-[9px] text-white/50">
          <span>{activeCars.size} cars</span>
          <span>{eventsPerCar()} ev/car/s</span>
        </div>
      )}
    </div>
  );
}
