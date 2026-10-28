import { Box, Ink, Text, Icon, type BoxProps } from "~ui";
import { For, Show, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { BLUEPRINTS, chain, GOODS } from "../blueprints";
import { select, setFollowing, setSubject } from "../state/selection";
import { card, getEntity } from "../state/gameObjects";
import { now } from "../state/sea";
import { DepotPanel } from "./Depot";
import { SitePanel } from "./Site";
import { BAD, Bar, GDP, GOOD, Press, Row, Section, To, type Link, ROUND } from "./kit";
import type { JSX } from "solid-js";
import type { Building, BuildingCard, CarCard, CarRole, ResidentCard } from "../generated";

const CLOSE = "M6 6l12 12M18 6L6 18";

createRoot(() => {
  // A resident is not on the map; where they are is.
  createEffect(on(card, (c) => {
    if (c?.kind !== "resident") return;
    const at = c.at?.id ?? null;
    setSubject(at);
    setFollowing((f) => (f === c.id || (at !== null && f !== null) ? at : f));
  }));

  // `#1234` in the address is a card to open on arrival: a thing you can
  // point someone at.
  const fromHash = () => {
    const id = Number(location.hash.slice(1));
    if (id) select(id);
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
});

/** The client's own record of a building, read again with the sea. */
const buildingOf = (id: number) => {
  now();
  const e = getEntity(id);
  return e?.object.kind === "Building" ? (e.object.data as Building) : null;
};

/**
 * The card for whatever was tapped, as the select tab's sheet: its head
 * the thing's name and where it is, peeking over the dock; drawn up,
 * who is in it, where it is going, what it owes, each line a thing on the
 * map you can go to; and, for a depot and a site, what the mayor does
 * there.
 */
export function InspectHead() {
  return (
    <Show when={card()}>
      {(c) => {
        const head = () => {
          const k = c();
          switch (k.kind) {
            case "resident":
              return { title: k.name, sub: k.at ? `at ${k.at.label}` : "off the map" };
            case "car": {
              const what = ROLE[k.role];
              return { title: k.rider ? `${k.rider.label}'s ${what.toLowerCase()}` : what, sub: k.trip ? `to ${k.trip.to.label}` : k.parked_at ? `parked at ${k.parked_at.label}` : k.role === "Ferry" ? "of the harbour" : "parked out of sight" };
            }
            case "building": {
              const bp = BLUEPRINTS[k.building_kind];
              const b = buildingOf(k.id);
              const site = b?.site;
              const idle = !site && b && bp.jobs > 0 && b.hands === 0;
              return {
                title: site ? `${bp.label} · a site` : bp.label,
                sub: !k.reached ? "no road reaches it" : site ? "going up as its materials land" : idle ? "nobody works here: everyone has work nearer, build homes close by" : undefined,
                icon: (
                  <Box w={36} h={36} round={18} fill={bp.color} opacity={site ? 0.65 : 1} align="center" justify="center">
                    <Icon d={bp.glyph} size={19} ink="white" />
                  </Box>
                ),
              };
            }
            case "gone":
              return { title: "Gone", sub: "Nothing stands here any more" };
          }
        };
        return <Header title={head().title} sub={head().sub} icon={(head() as { icon?: JSX.Element }).icon} />;
      }}
    </Show>
  );
}

export function InspectBody() {
  /** The building whose card is open, by id alone: what the mayor works
   *  with on it is made once, not again with every refresh. */
  const building = createMemo(() => {
    const c = card();
    return c?.kind === "building" ? c.id : null;
  });
  return (
    <Show when={card()}>
      {(c) => (
        <>
          <Show when={c().kind === "resident"}>{ResidentLines(c() as ResidentCard)}</Show>
          <Show when={c().kind === "car"}>{CarLines(c() as CarCard)}</Show>
          <Show when={building()} keyed>
            {(id) => <BuildingLines id={id} card={() => card() as BuildingCard} />}
          </Show>
        </>
      )}
    </Show>
  );
}

/** A pane of glass where it lies, at most as tall as its room; what is
 *  taller scrolls under the wheel or a finger. */
export function Pane(props: { children: JSX.Element; layer: string; at: BoxProps["at"]; w?: number; room: number }) {
  const [tall, setTall] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - props.room, scroll() + by)));
  createEffect(() => tall() <= props.room && setScroll(0));
  return (
    <Ink layer={props.layer} at={props.at} w={props.w} h={Math.min(tall(), props.room)} round={ROUND} clip onScroll={roll}>
      <Box y={-scroll()} pad={{ bottom: 6 }} onSize={(_, h) => setTall(h)}>
        {props.children}
      </Box>
    </Ink>
  );
}

export function Header(props: { title: string; sub?: string; icon?: JSX.Element; onClose?: () => void }) {
  return (
    <Box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 10 }}>
      {props.icon}
      <Box grow={1} gap={2}>
        <Text size={16} weight={600} lines={1}>{props.title}</Text>
        <Show when={props.sub}>
          <Text size={12} soft lines={1}>{props.sub}</Text>
        </Show>
      </Box>
      <Press w={28} h={28} round={14} align="center" justify="center" onTap={props.onClose ?? (() => select(null))}>
        <Icon d={CLOSE} size={14} stroke={2.4} ink="ink/0.6" />
      </Press>
    </Box>
  );
}

function ResidentLines(c: ResidentCard) {
  return (
    <>
      <Section title="Where">
        <Row label="Now"><To link={c.at} fallback="off the map" /></Row>
        <Row label="Home"><To link={c.home} /></Row>
        <Row label="Work"><To link={c.work} fallback="no job" /></Row>
        <Row label="Car"><To link={c.car} /></Row>
      </Section>
      <Section title={`Needs, since ${c.since}`}>
        <For each={c.needs}>
          {(b) => (
            <Box dir="row" align="center" gap={8} minH={22}>
              <Text w={64} size={13.5} weight={c.selected === b.need ? 600 : undefined} soft={c.selected !== b.need}>{b.need}</Text>
              <Bar value={b.full} color={c.selected === b.need ? GDP : "#8E8E93"} />
              <Box grow={1} />
              <Show when={b.option} fallback={<Text size={12} soft>nothing found</Text>}>
                {(id) => <To link={{ id: id(), label: "→ option", kind: "building" }} />}
              </Show>
            </Box>
          )}
        </For>
      </Section>
    </>
  );
}

const ROLE: Record<CarRole, string> = { Private: "Car", Truck: "Lorry", Van: "Van", Tractor: "Tractor", Ferry: "Ferry" };

function CarLines(c: CarCard) {
  return (
    <>
      <Section title="Who">
        <Row label="Aboard"><To link={c.rider} fallback="nobody" /></Row>
        <Row label={c.role === "Private" ? "Owner" : "Of"}><To link={c.owner} /></Row>
        <For each={c.stocks}>{(s) => <Row label={s.what}><Bar value={s.full} color={s.full < 0.2 ? BAD : GOOD} /></Row>}</For>
      </Section>
      <Show when={c.trip}>
        {(t) => (
          <Section title="Trip">
            <Row label="To"><To link={t().to} /></Row>
            <Row label="Due"><Text size={13.5}>{t().due}</Text></Row>
            <Show when={t().late_s > 0}>
              <Row label="Lost to traffic"><Text size={13.5}>{Math.round(t().late_s)} s</Text></Row>
            </Show>
          </Section>
        )}
      </Show>
      <Show when={c.answering.length > 0}>
        <Section title="Answering">
          <For each={c.answering}>
            {(a) => (
              <Row label={a.what}>
                <To link={a.at} />
                <Text size={12} soft>since {a.since}</Text>
              </Row>
            )}
          </For>
        </Section>
      </Show>
    </>
  );
}

/** Links, one a line. */
const Links = (props: { each: Link[] }) => <For each={props.each}>{(l) => <Box minH={22} justify="center"><To link={l} /></Box>}</For>;

/**
 * A building's card: made once for the building, its lines read from the
 * card as it refreshes. What the mayor does here comes first: a site's
 * materials, a depot's lorries and stock.
 */
function BuildingLines(props: { id: number; card: () => BuildingCard }) {
  const c = props.card;
  const kind = () => c().building_kind;
  /** Still going up: the client's own record of the site. */
  const site = createMemo(() => buildingOf(props.id)?.site ?? null);
  const lorries = () => c().fleet.filter((l) => l.label === "Lorry").map((l) => l.id);
  return (
    <>
      <Show when={site()}>{(s) => <SitePanel site={s()} depots={c().depots} makers={c().makers} calls={c().calls} />}</Show>
      <Show when={!site() && kind() === "Depot"}>
        <DepotPanel id={props.id} lorries={lorries()} />
      </Show>
      <Show when={kind() !== "Depot" && c().stocks.length > 0}>
        <Section title="Stocks">
          <For each={c().stocks}>{(s) => <Row label={s.what}><Bar value={s.full} color={s.full <= 0 ? BAD : GOOD} /></Row>}</For>
        </Section>
      </Show>
      <Show when={!site() && chain(kind())}>
        {(ch) => (
          <Section title="At its best">
            <Row label={`${GOODS[ch().good].label} a day`}><Text size={13.5}>{Math.round(ch().day)}</Text></Row>
            <For each={ch().takes}>{(t) => <Row label={`takes the ${GOODS[t.good].label} of`}><Text size={13.5}>{t.n.toFixed(1)} {BLUEPRINTS[t.kind].label.toLowerCase()}</Text></Row>}</For>
            <For each={ch().feeds}>{(f) => <Row label="keeps going"><Text size={13.5}>{f.n.toFixed(1)} {BLUEPRINTS[f.kind].label.toLowerCase()}</Text></Row>}</For>
          </Section>
        )}
      </Show>
      <Show when={c().here.length > 0}>
        <Section title={`Here now · ${c().here.length}`}>
          <For each={c().here}>{(h) => <Row label={h.doing ?? ""}><To link={h.who} /></Row>}</For>
        </Section>
      </Show>
      <Show when={c().household.length > 0}>
        <Section title={`Lives here · ${c().household.length}`}>
          <Links each={c().household} />
        </Section>
      </Show>
      <Show when={c().staff.length > 0}>
        <Section title={`Works here · ${c().staff.filter((s) => s.present).length} of ${c().staff.length} in`}>
          <For each={c().staff}>{(s) => <Box minH={22} justify="center" opacity={s.present ? 1 : 0.5}><To link={s.who} /></Box>}</For>
        </Section>
      </Show>
      <Show when={c().fleet.length > 0 && !BLUEPRINTS[kind()].quay}>
        <Section title="Fleet">
          <Links each={c().fleet} />
        </Section>
      </Show>
      <Show when={!site() && c().calls.length > 0}>
        <Section title="Calls">
          <For each={c().calls}>{(k) => <Row label={`${k.what} since ${k.since}`}><To link={k.answered_by} fallback="waiting" /></Row>}</For>
        </Section>
      </Show>
      <Show when={c().served.some((s) => s.hours_today > 0)}>
        <Section title="Served today">
          <For each={c().served.filter((s) => s.hours_today > 0)}>{(s) => <Row label={s.need}><Text size={13.5}>{s.hours_today.toFixed(1)} h</Text></Row>}</For>
        </Section>
      </Show>
    </>
  );
}
