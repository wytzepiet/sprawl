import { Box, Text, Icon } from "~ui";
import { createSignal, For, Show } from "solid-js";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { held, hold } from "./buildMode";
import { BAD, Fade, Info, Press } from "./kit";
import { town } from "../state/town";
import { PageHead, push } from "./pages";
import { mayUse, road, take as takeRoad, type RoadKind } from "./Roads";
import { sheetWidth } from "./sheet";
import type { BuildingKind } from "../generated";
import { photo as photoOf } from "../engine/studio";

/** A picture's side, a cell's least width and the room between cells. */
const PIC = 76;
const CELL = 96;
const GAP = 6;

/** A road tool's or a building's page. */
export const info = (p: About) => push({ key: "kind" in p ? p.kind : p.road, view: () => <Page {...p} /> });

/** The build tab's head: what is in hand, or, while one is held, a
 *  place to let it go and put it back. */
export function BuildHead() {
  const [over, setOver] = createSignal(false);
  const n = () => town().hand.reduce((s, [, k]) => s + k, 0);
  return (
    <Show
      when={held()}
      fallback={
        <Box pad={{ x: 16, top: 14, bottom: 10 }}>
          <Text size={15} weight={600}>{n() ? `${n()} to build` : "Nothing in hand"}</Text>
          <Show when={!n()}>
            <Text size={12} soft>The town gives you more as it grows.</Text>
          </Show>
        </Box>
      }
    >
      <Box pad={{ x: 12, top: 14, bottom: 12 }} onHover={setOver} onDrop={() => (setOver(false), hold(null))} onTap={() => hold(null)}>
        <Box h={44} round={16} align="center" justify="center" stroke={[2, over() ? BAD : "ink/0.2"]}>
          <Text size={13} weight={600} ink={over() ? BAD : "ink/0.6"}>Drop here to put it back</Text>
        </Box>
      </Box>
    </Show>
  );
}

/** The hand, drawn up: every building the town has given, a picture of
 *  each and how many. Press on one and drag it onto the map, or tap to
 *  take it up and place it with a click; its i opens its page. */
export function BuildBody() {
  const across = () => Math.max(1, Math.floor((sheetWidth() - 24 + GAP) / (CELL + GAP)));
  const cell = () => Math.floor((sheetWidth() - 24 - GAP * (across() - 1)) / across());
  return (
    <Fade>
      <Box pad={{ x: 12, bottom: 12 }} dir="row" wrap gap={GAP}>
        <For each={town().hand.filter(([, n]) => n > 0)}>
          {([kind, n]) => (
            <Box w={cell()} pad={{ x: 6, top: 6, bottom: 8 }} gap={4} align="center" round={18} fill="ink/0.04" onTap={() => hold(kind)} onDrag={() => hold(kind)}>
              <Picture kind={kind} />
              <Box dir="row" align="center" gap={4}>
                <Text size={13} weight={600} lines={1}>{BLUEPRINTS[kind].label}</Text>
                <Info onTap={() => info({ kind })} />
              </Box>
              <Text size={12} soft>×{n}</Text>
            </Box>
          )}
        </For>
      </Box>
    </Fade>
  );
}

type About = { kind: BuildingKind } | { road: RoadKind };

/** What a kind does, in a line: what it makes, of what. */
const does = (kind: BuildingKind) => {
  const bp = BLUEPRINTS[kind];
  if (!bp.makes) return null;
  const takes = Object.keys(bp.takes).map((g) => GOODS[g as keyof typeof GOODS].label.toLowerCase());
  return `Makes ${GOODS[bp.makes].label.toLowerCase()}${takes.length ? ` from ${takes.join(" and ")}` : ""}, with ${bp.seats} at work.`;
};

/** A building's or a road tool's page: what it is and what it does,
 *  and a way to take it up. */
function Page(p: About) {
  const name = "kind" in p ? BLUEPRINTS[p.kind].label : road(p.road).label;
  const about = "kind" in p ? BLUEPRINTS[p.kind].about : road(p.road).about;
  const take = () => ("kind" in p ? hold(p.kind) : takeRoad(p.road));
  const may = () => ("kind" in p ? town().hand.some(([k, n]) => k === p.kind && n > 0) : mayUse(p.road));
  return (
    <Box pad={{ bottom: 14 }} gap={12}>
      <PageHead>
        <Text size={17} weight={700} grow={1}>{name}</Text>
      </PageHead>
      <Box dir="row" align="center" gap={12} pad={{ x: 12 }}>
        {"kind" in p ? (
          <Picture kind={p.kind} />
        ) : (
          <Box w={PIC} h={PIC} round={12} fill={road(p.road).color} align="center" justify="center">
            <Icon d={road(p.road).glyph} size={40} ink="white" />
          </Box>
        )}
        <Box grow={1} gap={8}>
          <Text size={14} soft lead={1.45}>{about}</Text>
          <Show when={"kind" in p && does(p.kind)}>{(d) => <Text size={13} soft>{d()}</Text>}</Show>
        </Box>
      </Box>
      <Show when={may()} fallback={<Box pad={{ x: 12 }}><Text size={13} soft>{"kind" in p ? "None in hand: the town gives more as it grows." : "Pick it when the town grows."}</Text></Box>}>
        <Box pad={{ x: 12 }}>
          <Press h={44} round={16} align="center" justify="center" fill="ink/0.85" onTap={take}>
            <Text size={14} weight={600} ink="glass">{"kind" in p ? "Build" : "Take"}</Text>
          </Press>
        </Box>
      </Show>
    </Box>
  );
}

/** A kind's picture: its photograph as the game draws it (`engine/studio.ts`);
 *  until it is taken, its glyph on its colour. */
export function Picture(props: { kind: BuildingKind; size?: number }) {
  const photo = () => photoOf(props.kind);
  const s = () => props.size ?? PIC;
  return (
    <Box w={s()} h={s()} round={12} fill={photo() ? "white" : BLUEPRINTS[props.kind].color} photo={photo()} align="center" justify="center">
      <Show when={!photo()}>
        <Icon d={BLUEPRINTS[props.kind].glyph} size={s() * 0.52} ink="white" />
      </Show>
    </Box>
  );
}
