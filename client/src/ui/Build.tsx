import { Box, Text, Icon } from "~ui";
import { createSignal, For, Show } from "solid-js";
import { BLUEPRINTS, GOODS, KINDS, TABS, type Tab } from "../blueprints";
import { held, hold } from "./buildMode";
import { BAD, Fade, GDP, Info, Press, Tabs } from "./kit";
import { lockOf, research } from "../state/research";
import { home } from "../state/deals";
import { useGame } from "../state/gameObjects";
import { PageHead, push } from "./pages";
import { road, take as takeRoad, type RoadKind } from "./Roads";
import { open, setOpen, sheetWidth } from "./sheet";
import type { BuildingKind, Good } from "../generated";
import { photo as photoOf } from "../engine/studio";

/** A picture's side, a cell's least width and the room between cells. */
const PIC = 76;
const CELL = 96;
const GAP = 6;

const materials = (kind: BuildingKind) => Object.entries(BLUEPRINTS[kind].materials) as [Good, number][];

/** The kinds of building, by the menu's own groups: the harbour alone
 *  while the town has none, since nothing stands without the door; then
 *  every other kind, open or still to learn (docs/core.md). */
const groups = () => {
  const shown = home() === null ? ["Harbour" as BuildingKind] : KINDS.filter((k) => k !== "Harbour");
  return TABS.map((t) => ({ tab: t, kinds: shown.filter((k) => BLUEPRINTS[k].tab === t) })).filter((g) => g.kinds.length);
};
/** The group of buildings shown. */
const [group, setGroup] = createSignal<Tab>(TABS[0]);

/** A road tool's or a building's page. */
export const info = (p: About) => push({ key: "kind" in p ? p.kind : p.road, view: () => <Page {...p} /> });

/**
 * The build tab's head: the menu's groups, a tap on one drawing it up.
 * While a building is in hand, a place to let it go and put it back.
 */
export function BuildHead() {
  const [over, setOver] = createSignal(false);
  return (
    <Show
      when={held()}
      fallback={
        <Tabs tabs={groups().map((g) => g.tab)} on={group()} lit={open()} pick={(t) => (setGroup(t), setOpen(true))} />
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

/**
 * The build menu, drawn up: every kind of building in the group, a picture of it as it stands, its name and what it is
 * built of. Press on one and drag it onto the map: the sheet sinks to
 * its head, a place to let it go and put it back. A tap takes it up to
 * place with a click; its i opens its page.
 */
export function BuildBody() {
  const across = () => Math.max(1, Math.floor((sheetWidth() - 24 + GAP) / (CELL + GAP)));
  const cell = () => Math.floor((sheetWidth() - 24 - GAP * (across() - 1)) / across());
  const kinds = () => (groups().find((g) => g.tab === group()) ?? groups()[0])?.kinds ?? [];
  const { send } = useGame();
  return (
    <Show when={group()} keyed>
      {(g) => (
        <Fade>
          <Box pad={{ x: 12, bottom: 12 }} dir="row" wrap gap={GAP}>
              <For each={kinds()}>
                {(kind) => (
                  <Box
                    w={cell()}
                    pad={{ x: 6, top: 6, bottom: 8 }}
                    gap={4}
                    align="center"
                    round={18}
                    fill="ink/0.04"
                    opacity={lockOf(kind) === "open" ? 1 : lockOf(kind) === "next" ? 0.75 : 0.4}
                    onTap={() => (lockOf(kind) === "open" ? hold(kind) : lockOf(kind) === "next" && send({ type: "Research", data: { kind } }))}
                    onDrag={() => lockOf(kind) === "open" && hold(kind)}
                  >
                    <Picture kind={kind} />
                    <Box dir="row" align="center" gap={4}>
                      <Text size={13} weight={600} lines={1}>{BLUEPRINTS[kind].label}</Text>
                      <Info onTap={() => info({ kind })} />
                    </Box>
                    <Show when={lockOf(kind) === "open"} fallback={<Lock kind={kind} />}>
                      <Materials kind={kind} />
                    </Show>
                  </Box>
                )}
              </For>
            </Box>
        </Fade>
      )}
    </Show>
  );
}

/** What a kind is built of, a glyph and a number each; or "at once". */
function Materials(props: { kind: BuildingKind }) {
  return (
    <Box dir="row" align="center" gap={6}>
      <Show when={materials(props.kind).length} fallback={<Text serif size={12} soft>at once</Text>}>
        <For each={materials(props.kind)}>
          {([g, n]) => (
            <Box dir="row" align="center" gap={2}>
              <Icon d={GOODS[g].glyph} size={12} ink="ink/0.6" />
              <Text serif size={12} soft>{n}</Text>
            </Box>
          )}
        </For>
      </Show>
    </Box>
  );
}

/** A kind not yet open: what learning it takes, how far the labs have
 *  got, or that it waits on the rung below. */
function Lock(props: { kind: BuildingKind }) {
  const r = research;
  return (
    <Show when={lockOf(props.kind) === "next"} fallback={<Text size={12} soft>later</Text>}>
      <Show when={r().at === props.kind} fallback={<Text size={12} soft>learn · {r().cost}h</Text>}>
        <Box w={56} h={5} round={2.5} fill="ink/0.12">
          <Box w={(56 * r().done) / Math.max(1, r().of)} h={5} round={2.5} fill={GDP} />
        </Box>
      </Show>
    </Show>
  );
}

type About = { kind: BuildingKind } | { road: RoadKind };

/** A building's or a road tool's page: what it is and what it does,
 *  and a way to take it up. */
function Page(p: About) {
  const name = "kind" in p ? BLUEPRINTS[p.kind].label : road(p.road).label;
  const about = "kind" in p ? BLUEPRINTS[p.kind].about : road(p.road).about;
  const take = () => ("kind" in p ? hold(p.kind) : takeRoad(p.road));
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
          {"kind" in p && <Materials kind={p.kind} />}
        </Box>
      </Box>
      <Show when={!("kind" in p) || lockOf(p.kind) === "open"} fallback={<Box pad={{ x: 12 }}><Text size={13} soft>{"kind" in p && lockOf(p.kind) === "next" ? `A lab learns it in ${research().cost} researcher-hours: tap it in the menu.` : "A lab learns it once the kinds before it are learned."}</Text></Box>}>
        <Box pad={{ x: 12 }}>
          <Press h={44} round={16} align="center" justify="center" fill="ink/0.85" onTap={take}>
            <Text size={14} weight={600} ink="glass">{"kind" in p ? "Build" : "Take"}</Text>
          </Press>
        </Box>
      </Show>
    </Box>
  );
}

/** A kind's picture: its photograph as the game draws it, on its street
 *  at noon (`engine/studio.ts`); until it is taken, its glyph on its colour. */
function Picture(props: { kind: BuildingKind }) {
  const photo = () => photoOf(props.kind);
  return (
    <Box w={PIC} h={PIC} round={12} fill={photo() ? "white" : BLUEPRINTS[props.kind].color} photo={photo()} align="center" justify="center">
      <Show when={!photo()}>
        <Icon d={BLUEPRINTS[props.kind].glyph} size={40} ink="white" />
      </Show>
    </Box>
  );
}
