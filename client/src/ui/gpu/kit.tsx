/** @jsxImportSource ~ui */
import { createSignal, For } from "solid-js";
import { follow } from "../../engine/spring";
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

/** Something to press: it gives under the finger and springs back. */
export function Press(props: JSX.Box & { onTap: () => void }) {
  const [down, setDown] = createSignal(false);
  const [s] = follow(() => (down() ? 0.92 : 1));
  return <box {...props} scale={s()} onPress={setDown} />;
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
      pad={[0, props.big ? 20 : 12]}
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
