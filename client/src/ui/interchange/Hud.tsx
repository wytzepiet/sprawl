/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import type { LevelState, Tool } from "../../generated";
import type { LevelConnection } from "../../interchange/connection";
import type { LevelText } from "../../interchange/levels";
import { best } from "../../interchange/progress";
import { climb, pen } from "../../interchange/RoadBrush";
import { gateColour } from "../../interchange/demand";
import { priority, setPriority, setTool, tool } from "../buildMode";
import { road } from "../Roads";
import { Bar, Btn, Press, Row, SELECT } from "../kit";
import Signs from "./Signs";

/** The palette: each tool its name, its key, what it does, and its
 *  picture (a path in a 24 square, its holes cut even-odd). */
export const TOOLS: { tool: Tool; key: string; name: string; label: string; glyph: string }[] = [
  { tool: "Street", key: "1", name: "Two-way", label: "A road both ways", glyph: road("Street").glyph },
  { tool: "OneWay", key: "2", name: "One-way", label: "Runs the way you drag; laid back against another, a divided road", glyph: road("OneWay").glyph },
  { tool: "Wide", key: "3", name: "Two lanes", label: "One-way, two lanes: cars keep right to turn right, left to turn left", glyph: "M1.5 2h2v20h-2zM20.5 2h2v20h-2zM8 4l3.5 5H9v12H7V9H4.5zM16 4l3.5 5H17v12h-2V9h-2.5z" },
  { tool: "Light", key: "4", name: "Lights", label: "Tap a junction for traffic lights, again to take them away", glyph: "M8 1.5h8A1.5 1.5 0 0 1 17.5 3v18a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 21V3A1.5 1.5 0 0 1 8 1.5zM12 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM12 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM12 15.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z" },
  { tool: "Demolish", key: "X", name: "Bulldozer", label: "Takes up road; hold Shift for it with any tool", glyph: road("Demolish").glyph },
];
/** A bin: everything taken up. */
const CLEAR = "M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7zM9.5 10.5v8h1.5v-8zM13 10.5v8h1.5v-8z";
/** The priority road's sign, a diamond in a diamond. */
const DIAMOND = "M12 1 23 12 12 23 1 12zM12 4.2 19.8 12 12 19.8 4.2 12z";
const DIAMOND_IN = "M12 6.8 17.2 12 12 17.2 6.8 12z";
const BACK = "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z";
const TO = "M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4z";
const UP = "M5 16h14l-7-9z";
const DOWN = "M5 8h14l-7 9z";

/** Something said for a moment at the foot of the screen. */
const [told, setTold] = createSignal<string | null>(null);
let toldTimer: ReturnType<typeof setTimeout> | undefined;
export const tell = (text: string) => {
  setTold(text);
  clearTimeout(toldTimer);
  toldTimer = setTimeout(() => setTold(null), 4000);
};

/** Everything played since the level opened, onto the clipboard to paste
 *  to Claude; or, where the clipboard will not have it, as a file. */
async function copyReplay(line: LevelConnection | null, name: string) {
  if (!line) return;
  const json = await line.replay();
  try {
    await navigator.clipboard.writeText(json);
    tell(`Replay copied (${Math.ceil(json.length / 1024)} KB): paste it to Claude`);
  } catch {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = `${name}-replay.json`;
    a.click();
    tell("Replay saved as a file");
  }
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
/** The flow, against our own solve's where the level has one; an open
 *  level's, as it is: how near its trips came to empty roads. */
const flowOf = (s: LevelState) => (s.par_flow === null ? pct(s.flow) : `${pct(s.flow / Math.max(1e-9, s.par_flow))} of par`);

type Props = { level: LevelText; state: () => LevelState | null; line: () => LevelConnection | null; back: () => void; next: () => void };

/**
 * A level's glass, over the map: the gates' signs round it, the level and
 * its traffic, the road palette, the test as it runs and its verdict.
 * Over the palette, what the hand holds, or what the pointer is over.
 */
export default function Hud(props: Props) {
  const [hint, setHint] = createSignal<[string, string] | null>(null);
  const held = (): [string, string] | null => {
    const t = TOOLS.find((t) => t.tool === tool());
    return t ? [`${t.name}${t.tool !== "Light" && t.tool !== "Demolish" && priority() ? ", priority" : ""}`, t.label] : null;
  };
  const said = () => hint() ?? held();
  return (
    <>
      <Signs state={props.state} hint={setHint} />
      <Level {...props} />
      <Verdict {...props} />
      <box at={{ left: 0, right: 0, bottom: 24 }} align="center" gap={10}>
        <Show when={told()}>
          {(t) => (
            <glass layer="toast" round={18} pad={{ x: 16, y: 8 }}>
              <text size={13}>{t()}</text>
            </glass>
          )}
        </Show>
        <Show when={said()}>
          {(h) => (
            <glass layer="hint" round={16} pad={{ x: 14, y: 6 }} maxW={720}>
              <text size={13} lines={2} align="center">
                <text weight={600}>{h()[0]}</text>
                <text soft> · {h()[1]}</text>
              </text>
            </glass>
          )}
        </Show>
        <Palette {...props} hint={setHint} />
      </box>
    </>
  );
}

/** The level and its traffic. */
function Level(props: Props) {
  const s = () => props.state();
  const reset = () => confirm("Take up every road you built here?") && props.line()?.send({ type: "ResetWorld" });
  return (
    <glass layer="level" at={{ left: 24, top: 24 }} w={288} round={24} pad={{ x: 20, y: 16 }} gap={6}>
      <box dir="row" align="center" gap={12}>
        <Press w={28} h={28} round={14} align="center" justify="center" onTap={props.back}>
          <icon d={BACK} size={18} ink="ink/0.72" />
        </Press>
        <text serif size={24}>{props.level.title}</text>
      </box>
      <For each={props.level.notes}>{(n) => <text size={13} soft lead={1.35}>{n}</text>}</For>
      <box gap={4} pad={{ top: 6 }}>
        <For each={s()?.wants ?? []}>
          {(w) => (
            <box dir="row" align="center" justify="between" gap={8}>
              <box dir="row" align="center" gap={6}>
                <Badge colour={gateColour(s()!, w.from)}>{w.from}</Badge>
                <icon d={TO} size={13} ink="ink/0.72" />
                <Badge colour={gateColour(s()!, w.to)}>{w.to}</Badge>
                <text size={13} soft>{w.per_min} cars/min</text>
              </box>
              <Show when={s()?.phase !== "Build"} fallback={<text size={13} ink={w.joined ? "#2E7D4F" : "#C2361F"}>{w.joined ? "joined" : "no road"}</text>}>
                <text size={13}>{w.delivered}/{w.due}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
      <box h={1} fill="ink/0.1" />
      <box dir="row" align="end" justify="between">
        <text size={12} weight={600} soft>Asphalt</text>
        <text size={20} weight={600}>
          {s()?.cost ?? 0}
          <Show when={s()?.par != null}>
            <text size={14} weight={500} soft> / {s()?.par} par</text>
          </Show>
        </text>
      </box>
      <text size={11} soft lead={1.35}>
        V look · drag to draw · 1–4 roads and lights · X bulldoze (or hold Shift) · P priority · PgUp PgDn height · Z undo · Space test · right-drag to pan · F flag something wrong
      </text>
      <box dir="row" gap={8} pad={{ top: 4 }}>
        <Btn onTap={() => copyReplay(props.line(), props.level.name)}>Copy replay</Btn>
        <Show when={s()?.phase === "Build" && (s()?.cost ?? 0) > 0}>
          <Btn onTap={reset}>Start over</Btn>
        </Show>
      </box>
    </glass>
  );
}

/** A gate's label, in its colour. */
function Badge(props: { children: string; colour: string }) {
  return (
    <box w={20} h={20} round={10} fill={props.colour} align="center" justify="center">
      <text size={11} weight={700} ink="white">{props.children}</text>
    </box>
  );
}

/** A button's key, small in its corner. */
function KeyCap(props: { children: string }) {
  return (
    <box at={{ right: -2, top: -2 }} h={14} round={5} pad={{ x: 4 }} justify="center" fill="ink/0.12">
      <text size={9} weight={700}>{props.children}</text>
    </box>
  );
}

/** A button of the palette: dark while it is what is in hand. */
function Button(props: { on: boolean; d: string; cap?: string; hint: [string, string]; say: (h: [string, string] | null) => void; onTap: () => void }) {
  return (
    <Press w={44} h={44} round={22} align="center" justify="center" fill={props.on ? "ink" : undefined} onTap={props.onTap} onHover={(over) => props.say(over ? props.hint : null)}>
      <icon d={props.d} size={20} ink={props.on ? "glass" : "ink/0.72"} />
      <Show when={props.cap}>{(k) => <KeyCap>{k()}</KeyCap>}</Show>
    </Press>
  );
}

const Rule = () => <box w={1} h={24} fill="ink/0.15" />;

/** The road palette, the pen's height, and the test. */
function Palette(props: Props & { hint: (h: [string, string] | null) => void }) {
  const s = () => props.state();
  const height = (over: boolean) => props.hint(over ? ["Height", "the end of the road you last drew becomes the slope up or down (PgUp, PgDn); greyed where it can't be one"] : null);
  return (
    <glass layer="bar" dir="row" align="center" gap={6} h={56} round={28} pad={6}>
      {/* The empty hand: the roads as they are, no building. */}
      <Button on={tool() === null} d={SELECT} cap="V" hint={["Look", "the roads as they are, every level solid, nothing in hand"]} say={props.hint} onTap={() => setTool(null)} />
      <Rule />
      <For each={TOOLS}>{(t) => <Button on={tool() === t.tool} d={t.glyph} cap={t.key} hint={[t.name, t.label]} say={props.hint} onTap={() => setTool(t.tool)} />}</For>
      {/* Every road built here taken up, the level as it began. */}
      <Button on={false} d={CLEAR} hint={["Clear", "take up every road you built here"]} say={props.hint} onTap={() => confirm("Take up every road you built here?") && props.line()?.send({ type: "ResetWorld" })} />
      <Rule />
      {/* Priority: whatever road is drawn with it on has it. */}
      <Press
        dir="row"
        align="center"
        gap={6}
        h={44}
        round={22}
        pad={{ x: 12 }}
        fill={priority() ? "ink" : undefined}
        onTap={() => setPriority(!priority())}
        onHover={(over) => props.hint(over ? ["Priority", "whoever joins or crosses a road drawn with it gives way. Draw along a road to give it priority, or take it"] : null)}
      >
        <box w={18} h={18}>
          <icon at={{ left: 0, top: 0 }} d={DIAMOND} size={18} ink={priority() ? "glass" : "ink/0.72"} />
          <icon at={{ left: 0, top: 0 }} d={DIAMOND_IN} size={18} ink={priority() ? "#E0B443" : "ink/0.72"} />
        </box>
        <text size={13} weight={600} ink={priority() ? "glass" : "ink/0.72"}>Priority</text>
        <KeyCap>P</KeyCap>
      </Press>
      <Rule />
      {/* The pen's height: the road drawn after a change climbs to it. */}
      <box dir="row" align="center" gap={2}>
        <Press w={28} h={36} round={14} align="center" justify="center" opacity={climb().down ? 1 : 0.25} onTap={() => climb().down?.()} onHover={height}>
          <icon d={DOWN} size={14} ink="ink/0.72" />
        </Press>
        <text w={56} size={13} weight={600} align="center">{pen() === 0 ? "Ground" : `Level ${pen()}`}</text>
        <Press w={28} h={36} round={14} align="center" justify="center" opacity={climb().up ? 1 : 0.25} onTap={() => climb().up?.()} onHover={height}>
          <icon d={UP} size={14} ink="ink/0.72" />
        </Press>
      </box>
      <Show when={s()?.phase === "Build" || s()?.phase === "Test"}>
        <Rule />
        <Show when={s()?.phase === "Build"} fallback={<Btn big onTap={() => props.line()?.finish()}>Skip to the end</Btn>}>
          <Btn big onTap={() => props.line()?.test()}>Test</Btn>
        </Show>
      </Show>
    </glass>
  );
}

/** The test as it runs, and its verdict. */
function Verdict(props: Props) {
  return (
    <Show when={props.state()?.phase !== "Build" ? props.state() : null}>
      {(t) => (
        <glass layer="verdict" at={{ right: 24, top: 24 }} w={288} round={24} pad={{ x: 20, y: 16 }} gap={8}>
          <Show when={t().phase === "Test"}>
            <text size={12} weight={600} soft>Testing</text>
            <Bar value={t().test_ms / t().test_total_ms} w={248} />
            <text size={13} soft>Flow so far {flowOf(t())}</text>
          </Show>
          <Show when={t().phase === "Jammed"}>
            <text size={12} weight={600} ink="#C2361F">Jammed</text>
            <text serif size={24}>{t().message}</text>
            <box dir="row">
              <Btn big onTap={() => props.line()?.build()}>Back to building</Btn>
            </box>
          </Show>
          <Show when={t().phase === "Done"}>
            <text size={12} weight={600} soft>{t().par === null ? "Flow" : "Efficiency"}</text>
            <text serif size={56} lead={1}>
              {t().efficiency.toFixed(1)}
              <text size={28}>%</text>
            </text>
            <box>
              <Row label="Flow"><text size={13.5}>{flowOf(t())}</text></Row>
              <Row label="Asphalt"><text size={13.5}>{t().par === null ? `${t().cost}` : `${t().cost} for a par of ${t().par}`}</text></Row>
              <Show when={best(props.level.name)}>{(b) => <Row label="Your best"><text size={13.5}>{b().toFixed(1)}%</text></Row>}</Show>
            </box>
            <box dir="row" gap={8} pad={{ top: 4 }}>
              <Btn onTap={() => props.line()?.build()}>Improve</Btn>
              <Btn big onTap={props.next}>Next level</Btn>
            </box>
          </Show>
        </glass>
      )}
    </Show>
  );
}
