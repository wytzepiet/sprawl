/** @jsxImportSource ~ui */
import { createRoot, createSignal, For, onCleanup, Show } from "solid-js";
import { follow, LOOSE } from "../engine/spring";
import { getEntity } from "../state/gameObjects";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { select, setFollowing } from "../state/selection";
import { GOODS } from "../blueprints";
import type { Good, Neighbour } from "../generated";
import type { JSX } from "~ui/jsx-runtime";

/**
 * What the cards are made of, on the glass the GPU draws: a button that
 * springs under the finger, a bar of steps, a good on a disc, a town's
 * crest. Ink is the glass's own ("ink"), black on the day's glass and
 * white on the night's.
 */

/** Something to press: it rises under the pointer, gives under the finger and springs back. */
export function Press(props: JSX.Box & { onTap: () => void }) {
  const [down, setDown] = createSignal(false);
  const [over, setOver] = createSignal(false);
  const [s] = follow(() => (down() ? 0.92 : over() ? 1.08 : 1), { rest: 0.001 });
  const [y] = follow(() => (over() && !down() ? -2 : 0));
  return <box {...props} scale={s()} y={y()} onPress={setDown} onHover={setOver} />;
}

/** False on the frame it is made, true from the next: what a spring in starts from. */
function born() {
  const [is, set] = createSignal(false);
  const frame = requestAnimationFrame(() => set(true));
  onCleanup(() => cancelAnimationFrame(frame));
  return is;
}

/** What answers a press: it springs in from small. */
export function Pop(props: JSX.Box) {
  const b = born();
  const [s] = follow(() => (b() ? 1 : 0.6), { rest: 0.001, feel: LOOSE });
  return <box {...props} scale={s()} opacity={Math.min(1, 0.4 + 0.6 * ((s() - 0.6) / 0.4))} />;
}

/** What a growing card holds: it comes in once the card has room for it, rising a little. */
export function Appear(props: JSX.Box) {
  const b = born();
  const [o] = follow(() => (b() ? 1 : 0), { rest: 0.001, delay: () => 150 });
  return <box {...props} y={4 * (1 - o())} opacity={Math.max(0, Math.min(1, o()))} />;
}

/**
 * A button on the glass: `big` is the one thing a card is for, solid in a
 * colour; plain is a pill rimmed in ink.
 */
export function Btn(props: { onTap: () => void; children: JSX.Element; color?: string; big?: boolean; disabled?: boolean }) {
  return (
    <Press
      dir="row"
      align="center"
      gap={6}
      h={props.big ? 44 : 30}
      pad={{ x: props.big ? 20 : 12 }}
      round={22}
      fill={props.big ? props.color ?? "#2B6CA3" : undefined}
      stroke={props.big ? undefined : [1.5, "ink/0.18"]}
      shadow={props.big}
      opacity={props.disabled ? 0.4 : 1}
      onTap={() => !props.disabled && props.onTap()}
    >
      <text size={props.big ? 15 : 12.5} weight={600} ink={props.big ? "white" : props.color}>
        {props.children}
      </text>
    </Press>
  );
}

/** A way cut into its steps, filled up to the step at `at`. */
export function StepBar(props: { steps: number; at: number; color: string }) {
  return (
    <box dir="row" gap={3}>
      <For each={Array.from({ length: props.steps })}>{(_, i) => <box grow={1} h={6} round={3} fill={i() <= props.at ? props.color : "ink/0.1"} />}</For>
    </box>
  );
}

/** A good's glyph on a disc of its colour. */
export function GoodDot(props: { good: Good; size?: number }) {
  const s = () => props.size ?? 22;
  return (
    <box w={s()} h={s()} round={s() / 2} fill={GOODS[props.good].color} align="center" justify="center">
      <icon d={GOODS[props.good].glyph} size={s() * 0.62} ink="white" />
    </box>
  );
}

/** A town's crest: its initials on a disc of its colour, rimmed in glass white (`flat/crest.ts`). */
export function Crest(props: { n: Pick<Neighbour, "town" | "colour">; size: number }) {
  const initials = () => props.n.town.split(" ").map((w) => w[0]).join("");
  return (
    <box w={props.size} h={props.size} round={props.size / 2} fill={props.n.colour} stroke={[Math.max(1, props.size / 12), "#ffffffeb"]} align="center" justify="center">
      <text serif size={props.size * (initials().length > 1 ? 0.42 : 0.55)} ink="white" lead={1}>
        {initials()}
      </text>
    </box>
  );
}

/** A small glyph drawn as lines, the way the page's icons were. */
export const Line = (props: { d: string; size: number; width?: number; ink?: string }) => <icon d={props.d} size={props.size} stroke={props.width ?? 2} ink={props.ink} />;

/** The ferry, side on: news of it, and the dock's new deal. */
export const FERRY = "M2 14h20l-2.5 5.5h-15zM6 9h9v4H6zM8 5.5h4V9H8z";

/** The window's size, and whether it is wide: a phone's is not. */
export const { view, wide } = createRoot(() => {
  const [view, setView] = createSignal({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => setView({ w: window.innerWidth, h: window.innerHeight }));
  return { view, wide: () => view().w >= 768 };
});

/** How far a moment has run since it was made, 0 to 1 over `ms`: what a
 *  thing that comes, does its turn and goes is drawn by. */
export function elapsed(ms: number) {
  const [t, set] = createSignal(0);
  const start = performance.now();
  let frame = requestAnimationFrame(function tick(now) {
    set(Math.min(1, (now - start) / ms));
    if (now - start < ms) frame = requestAnimationFrame(tick);
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return t;
}

/** A value along keys of [when, what], straight between them. */
export function keys(t: number, at: [number, number][]) {
  const i = at.findIndex(([k]) => k >= t);
  if (i <= 0) return at[i < 0 ? at.length - 1 : 0][1];
  const [[k0, v0], [k1, v1]] = [at[i - 1], at[i]];
  return v0 + ((v1 - v0) * (t - k0)) / (k1 - k0);
}

/** Coins, signed and whole: "−22", "+18". */
export const coins = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(Math.round(v)).toLocaleString()}`;

/** A line that points at something else on the map. */
export interface Link {
  id: number;
  label: string;
  kind: "resident" | "building" | "car" | "gone";
}

/** A part of a card under a line saying what it is, ruled off the part above. */
export function Section(props: { title: string; children: JSX.Element }) {
  return (
    <box pad={{ x: 16, y: 10 }} gap={4}>
      <box at={{ left: 16, top: 0, right: 16 }} h={1} fill="ink/0.08" />
      <text size={12} weight={600} soft>{props.title}</text>
      {props.children}
    </box>
  );
}

/** A label and its value, on one line. */
export function Row(props: { label: string; children: JSX.Element }) {
  return (
    <box dir="row" align="center" justify="between" gap={8} minH={22}>
      <text size={13.5} soft lines={1}>{props.label}</text>
      <box dir="row" align="center" gap={6}>{props.children}</box>
    </box>
  );
}

/** A gauge: how full, in a colour, filling on a spring. */
export function Bar(props: { value: number; color?: string; w?: number; h?: number }) {
  const w = () => props.w ?? 80;
  const h = () => props.h ?? 6;
  const [v] = follow(() => Math.max(0, Math.min(1, props.value)), { rest: 0.001 });
  return (
    <box w={w()} h={h()} round={h() / 2} fill="ink/0.1">
      <box at={{ left: 0, top: 0 }} w={w() * Math.max(0, v())} h={h()} round={h() / 2} fill={props.color ?? "#7B77E0"} />
    </box>
  );
}

/** A line you can go to: a tap opens its card. */
export function To(props: { link: Link | null | undefined; fallback?: string }) {
  return (
    <Show when={props.link} fallback={<text size={13.5} soft>{props.fallback ?? "—"}</text>}>
      {(l) => (
        <text size={13.5} weight={600} lines={1} onTap={() => select(l().id)}>
          {l().label}
        </text>
      )}
    </Show>
  );
}

/** The eye: the camera to it, and after it as it goes. */
export function Follow(props: { id: number; fallback?: number }) {
  return (
    <Press dir="row" align="center" gap={4} h={24} pad={{ x: 8 }} round={12} stroke={[1.5, "ink/0.15"]} onTap={() => setFollowing(getEntity(props.id)?.position || !props.fallback ? props.id : props.fallback)}>
      <Line d={EYE} size={12} width={2.4} ink="ink/0.6" />
      <text size={11} weight={600} soft>follow</text>
    </Press>
  );
}
export const EYE = "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0";

/** Where a point of the map is on the screen this frame, for what is
 *  pinned to it: asked before each frame is drawn, after the camera has
 *  moved, so it is drawn where the town is. */
export function onMap(at: () => [number, number, number] | null) {
  const { scene, canvas, beforeRender } = useEngine();
  const [p, set] = createSignal<{ sx: number; sy: number } | null>(null, { equals: (a, b) => a?.sx === b?.sx && a?.sy === b?.sy });
  onCleanup(beforeRender(() => {
    const w = scene.camera && at();
    set(w ? projector(scene, canvas).at(...w) : null);
  }));
  return p;
}
