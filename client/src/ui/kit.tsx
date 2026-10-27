import { Box, Text, Icon, type BoxProps } from "~ui";
import { createRoot, createSignal, For, onCleanup, Show } from "solid-js";
import { follow, LOOSE, nextFrame } from "../engine/spring";
import { getEntity } from "../state/gameObjects";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { select, setFollowing } from "../state/selection";
import { GOODS } from "../blueprints";
import type { Good, Neighbour } from "../generated";
import type { JSX } from "solid-js";

/**
 * What the cards are made of, on the black (`~ui`): a button that
 * springs under the finger, a bar of steps, a good on a disc, a town's
 * crest. Ink is the black's own ("ink"): white.
 */

/** The colours the cards name, each for one thing, bright on the black:
 *  well and done; wrong, short or gone; GDP, and the missions that grow
 *  it; the sea and what comes over it; coins. */
export const GOOD = "#30D158";
export const BAD = "#FF453A";
export const GDP = "#A27BFF";
export const SEA = "#0A84FF";
export const COIN = "#FF9F0A";

/** The black round the game, on a wide screen: a phone's own edge is the
 *  game's. And the game's corner inside it; and how far what grows out
 *  of the black reaches past the screen's edge, unseen, so it is one
 *  piece with it. */
export const bezel = () => (wide() ? 5 : 0);
export const WINDOW = 18;
export const DROP = 40;
/** How tall the corners are: the clock, the level and the purse. */
export const CORNER = 40;
/** The black's corner, everywhere but a pill: the dock's, the window's,
 *  every card's. The melt between them is as wide (`ui/melt.ts`, MELT). */
export const ROUND = 30;

/** Something to press: it rises under the pointer, gives under the finger and springs back,
 *  by a few pixels whatever its size: a button's twelfth, a row's hair. */
export function Press(props: BoxProps & { onTap: () => void }) {
  const [down, setDown] = createSignal(false);
  const [over, setOver] = createSignal(false);
  const [size, setSize] = createSignal(44);
  const by = () => Math.min(0.08, 3.5 / size());
  const [s] = follow(() => (down() ? 1 - by() : over() ? 1 + by() : 1), { rest: 0.001 });
  const [y] = follow(() => (over() && !down() ? -2 : 0));
  const sized = (w: number, h: number) => (setSize(Math.max(w, h, 1)), props.onSize?.(w, h));
  const hover = (o: boolean) => (setOver(o), props.onHover?.(o));
  return <Box {...props} scale={s()} y={y()} onPress={setDown} onHover={hover} onSize={sized} />;
}

/** A tab bar: one pill, and in it a lighter one that slides to the tab
 *  shown, its name brightening as it passes under it; `lit` false, none
 *  is shown. */
export function Tabs<T extends string>(props: { tabs: readonly T[]; on: T; lit?: boolean; pick: (t: T) => void }) {
  const [w, setW] = createSignal(0);
  const seg = () => (w() - 6) / props.tabs.length;
  const [at] = follow(() => props.tabs.indexOf(props.on));
  const [shown] = follow(() => (props.lit ?? true ? 1 : 0), { rest: 0.001 });
  const lit = (i: number) => Math.max(0, 1 - Math.abs(at() - i)) * Math.max(0, Math.min(1, shown()));
  return (
    <Box pad={{ x: 12, top: 14, bottom: 12 }}>
      <Box dir="row" h={38} round={19} pad={3} fill="ink/0.09" onSize={(ww) => setW(ww)}>
        <Box at={{ left: 3 + at() * seg(), top: 3 }} w={seg()} h={32} round={16} fill="ink/0.2" opacity={Math.max(0, Math.min(1, shown()))} />
        <For each={props.tabs}>
          {(t, i) => (
            <Box grow={1} h={32} align="center" justify="center" onTap={() => props.pick(t)}>
              <Text size={13} weight={600} ink={`ink/${(0.55 + 0.45 * lit(i())).toFixed(3)}`}>{t[0].toUpperCase() + t.slice(1)}</Text>
            </Box>
          )}
        </For>
      </Box>
    </Box>
  );
}

/** A little i on a tile: a tap opens what it is. */
export function Info(props: { at?: BoxProps["at"]; onTap: () => void }) {
  return (
    <Press at={props.at} w={18} h={18} round={9} align="center" justify="center" fill="ink/0.08" onTap={props.onTap}>
      <Text serif size={11.5} weight={600} ink="ink/0.6">i</Text>
    </Press>
  );
}

/** False on the frame it is made, true from the next: what a spring in starts from. */
function born() {
  const [is, set] = createSignal(false);
  const frame = requestAnimationFrame(() => set(true));
  onCleanup(() => cancelAnimationFrame(frame));
  return is;
}

/** What a tab shows when it is switched to: it fades in, so one view
 *  gives way to the next. */
export function Fade(props: BoxProps) {
  const b = born();
  const [o] = follow(() => (b() ? 1 : 0), { rest: 0.001 });
  return <Box {...props} opacity={Math.max(0, Math.min(1, o()))} />;
}

/** What answers a press: it springs in from small. */
export function Pop(props: BoxProps) {
  const b = born();
  const [s] = follow(() => (b() ? 1 : 0.6), { rest: 0.001, feel: LOOSE });
  return <Box {...props} scale={s()} opacity={Math.min(1, 0.4 + 0.6 * ((s() - 0.6) / 0.4))} />;
}

/** What a growing card holds: it comes in once the card has room for it, rising a little. */
export function Appear(props: BoxProps) {
  const b = born();
  const [o] = follow(() => (b() ? 1 : 0), { rest: 0.001, delay: () => 150 });
  return <Box {...props} y={4 * (1 - o())} opacity={Math.max(0, Math.min(1, o()))} />;
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
      fill={props.big ? props.color ?? SEA : undefined}
      stroke={props.big ? undefined : [1.5, "ink/0.18"]}
      opacity={props.disabled ? 0.4 : 1}
      onTap={() => !props.disabled && props.onTap()}
    >
      <Text size={props.big ? 15 : 12.5} weight={600} ink={props.big ? "white" : props.color}>
        {props.children}
      </Text>
    </Press>
  );
}

/** A way cut into its steps, filled up to the step at `at`. */
export function StepBar(props: { steps: number; at: number; color: string }) {
  return (
    <Box dir="row" gap={3}>
      <For each={Array.from({ length: props.steps })}>{(_, i) => <Box grow={1} h={6} round={3} fill={i() <= props.at ? props.color : "ink/0.1"} />}</For>
    </Box>
  );
}

/** A good's glyph on a disc of its colour. */
export function GoodDot(props: { good: Good; size?: number }) {
  const s = () => props.size ?? 22;
  return (
    <Box w={s()} h={s()} round={s() / 2} fill={GOODS[props.good].color} align="center" justify="center">
      <Icon d={GOODS[props.good].glyph} size={s() * 0.62} ink="white" />
    </Box>
  );
}

/** A town's crest: its initials on a disc of its colour, rimmed in glass white (`flat/crest.ts`). */
export function Crest(props: { n: Pick<Neighbour, "town" | "colour">; size: number }) {
  const initials = () => props.n.town.split(" ").map((w) => w[0]).join("");
  return (
    <Box w={props.size} h={props.size} round={props.size / 2} fill={props.n.colour} stroke={[Math.max(1, props.size / 12), "#ffffffeb"]} align="center" justify="center">
      <Text serif size={props.size * (initials().length > 1 ? 0.42 : 0.55)} ink="white" lead={1}>
        {initials()}
      </Text>
    </Box>
  );
}

/** A small glyph drawn as lines, the way the page's icons were. */
export const Line = (props: { d: string; size: number; width?: number; ink?: string }) => <Icon d={props.d} size={props.size} stroke={props.width ?? 2} ink={props.ink} />;

/** The ferry, side on: news of it, and the dock's new deal. */
export const FERRY = "M2 14h20l-2.5 5.5h-15zM6 9h9v4H6zM8 5.5h4V9H8z";
/** The empty hand's arrow. */
export const SELECT = "M4 2.5l16 8-7 2-2.6 7.5z";

/** The window's size, and whether it is wide: a phone's is not. */
export const { view, wide } = createRoot(() => {
  const [view, setView] = createSignal({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => setView({ w: window.innerWidth, h: window.innerHeight }));
  return { view, wide: () => view().w >= 768 };
});

/** Asks `url` now and every `ms` after, handing on each answer, until
 *  the scope that asked ends. */
export function poll<T>(url: string, ms: number, got: (answer: T) => void) {
  let live = true;
  const ask = async () => {
    const answer = (await (await fetch(url)).json()) as T;
    if (live) got(answer);
  };
  ask();
  const timer = setInterval(ask, ms);
  onCleanup(() => {
    live = false;
    clearInterval(timer);
  });
}

/** How far a moment has run since it was made, 0 to 1 over `ms`: what a
 *  thing that comes, does its turn and goes is drawn by. */
export function elapsed(ms: number) {
  const [t, set] = createSignal(0);
  const start = performance.now();
  let live = true;
  nextFrame(function tick(now) {
    set(Math.min(1, (now - start) / ms));
    if (live && now - start < ms) nextFrame(tick);
  });
  onCleanup(() => (live = false));
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
    <Box pad={{ x: 16, y: 10 }} gap={4}>
      <Box at={{ left: 16, top: 0, right: 16 }} h={1} fill="ink/0.08" />
      <Text size={12} weight={600} soft>{props.title}</Text>
      {props.children}
    </Box>
  );
}

/** A label and its value, on one line. */
export function Row(props: { label: string; children: JSX.Element }) {
  return (
    <Box dir="row" align="center" justify="between" gap={8} minH={22}>
      <Text size={13.5} soft lines={1}>{props.label}</Text>
      <Box dir="row" align="center" gap={6}>{props.children}</Box>
    </Box>
  );
}

/** A gauge: how full, in a colour, filling on a spring. */
export function Bar(props: { value: number; color?: string; w?: number; h?: number }) {
  const w = () => props.w ?? 80;
  const h = () => props.h ?? 6;
  const [v] = follow(() => Math.max(0, Math.min(1, props.value)), { rest: 0.001 });
  return (
    <Box w={w()} h={h()} round={h() / 2} fill="ink/0.1">
      <Box at={{ left: 0, top: 0 }} w={w() * Math.max(0, v())} h={h()} round={h() / 2} fill={props.color ?? GDP} />
    </Box>
  );
}

/** A line you can go to: a tap opens its card. */
export function To(props: { link: Link | null | undefined; fallback?: string }) {
  return (
    <Show when={props.link} fallback={<Text size={13.5} soft>{props.fallback ?? "—"}</Text>}>
      {(l) => (
        <Text size={13.5} weight={600} lines={1} onTap={() => select(l().id)}>
          {l().label}
        </Text>
      )}
    </Show>
  );
}

/** The eye: the camera to it, and after it as it goes. */
export function Follow(props: { id: number; fallback?: number }) {
  return (
    <Press dir="row" align="center" gap={4} h={24} pad={{ x: 8 }} round={12} stroke={[1.5, "ink/0.15"]} onTap={() => setFollowing(getEntity(props.id)?.position || !props.fallback ? props.id : props.fallback)}>
      <Line d={EYE} size={12} width={2.4} ink="ink/0.6" />
      <Text size={11} weight={600} soft>follow</Text>
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
