import { Box, Text } from "~ui";
import { createSignal, Index, Show } from "solid-js";
import { follow } from "../../engine/spring";
import { gateColour } from "../../interchange/demand";
import type { LevelState } from "../../generated";
import { onMap } from "../kit";

/** The gate whose sign is held down: where its cars go is drawn over the
 *  map (`interchange/demand.ts`). */
export const [held, setHeld] = createSignal<string | null>(null);

/** Past the map's edge, a fog; round it, a line. */
const FOG = "#ecf0e89e";
const EDGE = "#2f3d3859";
/** As wide as any screen: the fog is a frame round the map, a stroke,
 *  which the hand passes through as it would not a fill. */
const FAR = 10_000;

/**
 * The map's edge, everything past it under a fog, and each gate's sign
 * there: a road sign in its colour, its number, whether cars come in or
 * go out by it, and how many wait there. Held down, where its cars go is
 * drawn over the map; and a press on it lays no road.
 */
export default function Signs(props: { state: () => LevelState | null; hint: (h: [string, string] | null) => void }) {
  const a = onMap(() => {
    const s = props.state();
    return s && [s.min_x, s.min_y, 0];
  });
  const b = onMap(() => {
    const s = props.state();
    return s && [s.max_x + 1, s.max_y + 1, 0];
  });
  const edge = () => {
    const [p, q] = [a(), b()];
    return p && q && { x: Math.min(p.sx, q.sx), y: Math.min(p.sy, q.sy), w: Math.abs(q.sx - p.sx), h: Math.abs(q.sy - p.sy) };
  };
  return (
    <>
      <Show when={edge()}>
        {(e) => (
          <>
            <Box at={{ left: e().x - FAR, top: e().y - FAR }} w={e().w + 2 * FAR} h={e().h + 2 * FAR} stroke={[FAR, FOG]} />
            <Box at={{ left: e().x, top: e().y }} w={e().w} h={e().h} stroke={[1.5, EDGE]} />
          </>
        )}
      </Show>
      <Index each={props.state()?.gates ?? []}>{(g) => <Sign gate={g()} colour={gateColour(props.state()!, g().label)} hint={props.hint} />}</Index>
    </>
  );
}

/** A gate's sign, just past the map's edge beside its road, so it hides no car. */
function Sign(props: { gate: LevelState["gates"][number]; colour: string; hint: (h: [string, string] | null) => void }) {
  const at = onMap(() => {
    const g = props.gate;
    const [dx, dy] = [Math.sign(g.end_x - g.x), Math.sign(g.end_y - g.y)];
    return [g.x + 0.5 + dx * 1.1 + dy * 1.1, g.y + 0.5 + dy * 1.1 + dx * 1.1, 0];
  });
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [scale] = follow(() => (held() === props.gate.label ? 1.12 : 1), { rest: 0.001 });
  const io = () => (props.gate.ins && props.gate.outs ? "in · out" : props.gate.ins ? "in" : "out");
  return (
    <Show when={at()}>
      {(p) => (
        <Box
          at={{ left: Math.round(p().sx - size().w / 2), top: Math.round(p().sy - size().h / 2) }}
          align="center"
          scale={scale()}
          onSize={(w, h) => setSize({ w, h })}
          onPress={(down) => props.gate.ins && setHeld(down ? props.gate.label : null)}
          onHover={(over) => props.hint(over ? [`Gate ${props.gate.label}`, props.gate.ins ? "Hold to see where its cars go" : "Cars leave the map here"] : null)}
        >
          <Box w={32} h={32} round={7} fill={props.colour} stroke={[2.5, "white"]} shadow align="center" justify="center">
            <Text size={16} weight={700} ink="white">{props.gate.label}</Text>
          </Box>
          <Box w={3} h={8} fill="#4a4f55" />
          <Box h={16} round={8} pad={{ x: 6 }} justify="center" fill="#2f3d38d9">
            <Text size={10} weight={600} ink="white">{io()}</Text>
          </Box>
          <Show when={props.gate.waiting > 1}>
            <Text size={11} weight={600} ink={props.gate.waiting > 5 ? "#C2361F" : "#B7791F"}>{props.gate.waiting} waiting</Text>
          </Show>
        </Box>
      )}
    </Show>
  );
}
