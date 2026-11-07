import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "~ui";
import { setBuildingListener } from "../state/gameObjects";
import { BLUEPRINTS, GOODS, middle } from "../blueprints";
import { onMap } from "./kit";
import { useEngine } from "../engine/Canvas";
import type { Building, GameObjectEntry, Good } from "../generated";

/**
 * A ping over a building when something lands there: a family's want met
 * as its car comes home, a lorry's load set down at a shop or a works, a
 * family moving in, a house growing a level. A disc pops up, a ring goes
 * out round it, and it rises and fades; another of the same, while it
 * shows, adds to its count.
 */
interface Ping {
  key: string;
  id: number;
  at: [number, number, number];
  color: string;
  glyph: string;
  n: number;
  /** What it says beside the disc, if anything. */
  label: (n: number) => string;
  /** Bumped each time it is added to, to play again. */
  beat: number;
}

const LIFE_MS = 1600;
const PERSON = "M12 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM3 22c0-5 4-8.5 9-8.5s9 3.5 9 8.5z";
const UP = "M12 3l8 9h-5v9H9v-9H4z";
const GROW = "#F2B53A";
const MOVE_IN = "#4FA36B";

const [pings, setPings] = createSignal<Ping[]>([]);
const timers = new Map<string, number>();
/** Whether a place is in view: a ping off screen is never made. */
let seen = (_x: number, _y: number) => false;

function ping(p: Omit<Ping, "n" | "beat">, n = 1) {
  if (!seen(p.at[0], p.at[1])) return;
  const had = pings().find((q) => q.key === p.key);
  const next: Ping = had ? { ...had, n: had.n + n, beat: had.beat + 1 } : { ...p, n, beat: 0 };
  setPings((l) => [...l.filter((q) => q.key !== p.key), next]);
  clearTimeout(timers.get(p.key));
  timers.set(p.key, window.setTimeout(() => (setPings((l) => l.filter((q) => q.key !== p.key)), timers.delete(p.key)), LIFE_MS));
}

/** The highest id seen: a building newer than it was just built, not
 *  just come into view; and not while the town first loads. */
let newest = 0;
let settled = 0;

function changed(before: GameObjectEntry | undefined, after: GameObjectEntry) {
  const b = after.object.data as Building;
  const was = before?.object.data as Building | undefined;
  settled ||= performance.now() + 4000;
  const fresh = !before && after.id > newest && performance.now() > settled;
  newest = Math.max(newest, after.id);
  const [x, y] = middle(b);
  const at: [number, number, number] = [x, y, 0.9];
  if (b.home) {
    if (fresh) ping({ key: `in:${after.id}`, id: after.id, at, color: MOVE_IN, glyph: PERSON, label: () => "moved in" });
    if (!was?.home) return;
    if (b.home.level > was.home.level) ping({ key: `up:${after.id}`, id: after.id, at, color: GROW, glyph: UP, label: () => "grew" });
    // A want its car was out for, gone: met.
    for (const w of was.home.wants) {
      if (w.by === null || b.home.wants.some((v) => v.good === w.good && v.since === w.since)) continue;
      const g = GOODS[w.good];
      ping({ key: `met:${after.id}:${w.good}`, id: after.id, at, color: g.color, glyph: g.glyph, label: () => "" });
    }
    return;
  }
  if (!was) return;
  // Set down from a lorry: on a shop's shelves, or what a works takes.
  const takes = BLUEPRINTS[b.kind].makes;
  for (const [good, s] of Object.entries(b.stocks) as [Good, { level: number }][]) {
    const more = Math.floor(s.level + 1e-9) - Math.floor((was.stocks[good]?.level ?? 0) + 1e-9);
    if (more <= 0 || good === takes) continue;
    const g = GOODS[good];
    ping({ key: `in:${after.id}:${good}`, id: after.id, at, color: g.color, glyph: g.glyph, label: (n) => `+${n}` }, more);
  }
}

export default function Pings() {
  const { cull } = useEngine();
  seen = (x, y) => cull.sees(x, y);
  setBuildingListener(changed);
  onCleanup(() => setBuildingListener(null));
  return (
    <div style={{ position: "absolute", inset: "0", overflow: "hidden", "pointer-events": "none" }}>
      <For each={pings()}>{(p) => <One ping={p} />}</For>
    </div>
  );
}

const STYLE = `
@keyframes ping-rise { 0% { transform: translateY(0) scale(.3); opacity: 0 } 12% { transform: translateY(-6px) scale(1.18); opacity: 1 } 24% { transform: translateY(-10px) scale(1) } 75% { opacity: 1 } 100% { transform: translateY(-34px) scale(.92); opacity: 0 } }
@keyframes ping-ring { 0% { transform: scale(.5); opacity: .9 } 100% { transform: scale(2.4); opacity: 0 } }
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function One(props: { ping: Ping }) {
  style();
  const at = onMap(() => props.ping.at);
  const D = 30;
  return (
    <Show when={at()}>
      {(p) => (
        <div style={{ position: "absolute", left: "0", top: "0", transform: `translate(${p().sx}px, ${p().sy - 26}px)`, "pointer-events": "none" }}>
          <Show when={props.ping.beat + 1} keyed>
            {(_beat) => (
              <div style={{ position: "absolute", left: `${-D / 2}px`, top: `${-D / 2}px`, animation: `ping-rise ${LIFE_MS}ms cubic-bezier(.2,.8,.3,1) forwards` }}>
                <div style={{ position: "absolute", inset: "0", "border-radius": "50%", border: `3px solid ${props.ping.color}`, animation: "ping-ring 700ms ease-out forwards" }} />
                <div style={{ position: "relative", width: `${D}px`, height: `${D}px`, "border-radius": "50%", background: props.ping.color, border: "2px solid white", "box-sizing": "border-box", display: "flex", "align-items": "center", "justify-content": "center", "box-shadow": "0 2px 6px #0004" }}>
                  <Icon d={props.ping.glyph} size={15} ink="white" />
                </div>
                <Show when={props.ping.label(props.ping.n)}>
                  {(l) => (
                    <div style={{ position: "absolute", left: `${D + 3}px`, top: "6px", "white-space": "nowrap", font: "700 13px system-ui, sans-serif", color: "white", "text-shadow": "0 1px 3px #000a" }}>{l()}</div>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
