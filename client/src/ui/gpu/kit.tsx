/** @jsxImportSource ~ui */
import { createSignal, For, onCleanup } from "solid-js";
import { follow, LOOSE } from "../../engine/spring";
import { GOODS } from "../../blueprints";
import type { Good } from "../../generated";
import type { Neighbour } from "../../generated/Neighbour";
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
