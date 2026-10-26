/** @jsxImportSource ~ui */
import { For, Show, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { BLUEPRINTS, GOODS, packages } from "../blueprints";
import { goodsOf, select, selected, setFollowing, setSubject } from "../state/selection";
import { packagesOf } from "../engine/objects/pads";
import { LOAD } from "../generated/rows";
import { card, getEntity, useGame } from "../state/gameObjects";
import { now } from "../state/sea";
import { destinations, mayorsLorry } from "../state/haul";
import { DepotPanel } from "./Depot";
import { SitePanel } from "./Site";
import { BAD, Bar, Btn, GDP, GOOD, GoodDot, Press, Row, Section, To, type Link } from "./kit";
import type { JSX } from "~ui/jsx-runtime";
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
    <Show when={!goodsOf(selected())} fallback={<PileHead />}>
    <Show when={card()}>
      {(c) => {
        const head = () => {
          const k = c();
          switch (k.kind) {
            case "resident":
              return { title: k.name, sub: k.at ? `at ${k.at.label}` : "off the map" };
            case "car": {
              const what = k.id === mayorsLorry()?.id ? "Your lorry" : ROLE[k.role];
              return { title: k.rider ? `${k.rider.label}'s ${what.toLowerCase()}` : what, sub: k.trip ? `to ${k.trip.to.label}` : k.parked_at ? `parked at ${k.parked_at.label}` : k.role === "Ferry" ? "of the harbour" : "parked out of sight" };
            }
            case "building": {
              const bp = BLUEPRINTS[k.building_kind];
              const site = buildingOf(k.id)?.site;
              return {
                title: site ? `${bp.label} · a site` : bp.label,
                sub: k.reached ? (site ? "going up as its materials land" : undefined) : "no road reaches it",
                icon: (
                  <box w={36} h={36} round={18} fill={bp.color} opacity={site ? 0.65 : 1} align="center" justify="center">
                    <icon d={bp.glyph} size={19} ink="white" />
                  </box>
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
    <Show when={!goodsOf(selected())} fallback={<PileBody />}>
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
    </Show>
  );
}

/** The pile picked: its good, how much, and where. */
const pile = () => {
  const p = goodsOf(selected());
  const b = p && buildingOf(p.at);
  return p && b ? { ...p, b, n: packagesOf(b, p.good) } : null;
};

function PileHead() {
  return (
    <Show when={pile()}>
      {(p) => <Header title={GOODS[p().good].label[0].toUpperCase() + GOODS[p().good].label.slice(1)} sub={`${packages(p().good, p().n)} at the ${BLUEPRINTS[p().b.kind].label.toLowerCase()}`} icon={<GoodDot good={p().good} size={36} />} />}
    </Show>
  );
}

/** Where your lorry can take a pile: every building that takes it, the
 *  nearest first, a tap each; or a tap on one on the map. */
function PileBody() {
  const { send } = useGame();
  const bring = (to: number) => {
    const p = pile();
    const lorry = mayorsLorry();
    if (!p || !lorry) return;
    send({ type: "Haul", data: { from: p.at, good: p.good, packages: LOAD, to } });
    select(lorry.id);
  };
  const named = (id: number) => {
    const b = buildingOf(id);
    if (!b) return "";
    const bp = BLUEPRINTS[b.kind];
    if (b.site) return `${bp.label} · a site`;
    return b.kind === "Harbour" ? "Harbour · to sell" : bp.label;
  };
  return (
    <Show when={pile()}>
      {(p) => (
        <Section title="Your lorry can bring it to">
          <For each={destinations(p().at, p().good).slice(0, 5)} fallback={<text size={13} soft>Nowhere takes it yet: place a site</text>}>
            {(id) => (
              <Row label={named(id)}>
                <Btn onTap={() => bring(id)}>Bring</Btn>
              </Row>
            )}
          </For>
          <text size={12} soft>or tap a building</text>
        </Section>
      )}
    </Show>
  );
}

/** A pane of glass where it lies, at most as tall as its room; what is
 *  taller scrolls under the wheel or a finger. */
export function Pane(props: { children: JSX.Element; layer: string; at: JSX.Box["at"]; w?: number; room: number }) {
  const [tall, setTall] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - props.room, scroll() + by)));
  createEffect(() => tall() <= props.room && setScroll(0));
  return (
    <glass layer={props.layer} at={props.at} w={props.w} h={Math.min(tall(), props.room)} round={22} clip onScroll={roll}>
      <box y={-scroll()} pad={{ bottom: 6 }} onSize={(_, h) => setTall(h)}>
        {props.children}
      </box>
    </glass>
  );
}

export function Header(props: { title: string; sub?: string; icon?: JSX.Element; onClose?: () => void }) {
  return (
    <box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 10 }}>
      {props.icon}
      <box grow={1} gap={2}>
        <text size={16} weight={600} lines={1}>{props.title}</text>
        <Show when={props.sub}>
          <text size={12} soft lines={1}>{props.sub}</text>
        </Show>
      </box>
      <Press w={28} h={28} round={14} align="center" justify="center" onTap={props.onClose ?? (() => select(null))}>
        <icon d={CLOSE} size={14} stroke={2.4} ink="ink/0.6" />
      </Press>
    </box>
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
            <box dir="row" align="center" gap={8} minH={22}>
              <text w={64} size={13.5} weight={c.selected === b.need ? 600 : undefined} soft={c.selected !== b.need}>{b.need}</text>
              <Bar value={b.full} color={c.selected === b.need ? GDP : "#A8A29E"} />
              <box grow={1} />
              <Show when={b.option} fallback={<text size={12} soft>nothing found</text>}>
                {(id) => <To link={{ id: id(), label: "→ option", kind: "building" }} />}
              </Show>
            </box>
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
            <Row label="Due"><text size={13.5}>{t().due}</text></Row>
            <Show when={t().late_s > 0}>
              <Row label="Lost to traffic"><text size={13.5}>{Math.round(t().late_s)} s</text></Row>
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
                <text size={12} soft>since {a.since}</text>
              </Row>
            )}
          </For>
        </Section>
      </Show>
    </>
  );
}

/** Links, one a line. */
const Links = (props: { each: Link[] }) => <For each={props.each}>{(l) => <box minH={22} justify="center"><To link={l} /></box>}</For>;

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
      <Show when={site()}>{(s) => <SitePanel id={props.id} site={s()} depots={c().depots} makers={c().makers} calls={c().calls} />}</Show>
      <Show when={!site() && kind() === "Depot"}>
        <DepotPanel id={props.id} lorries={lorries()} />
      </Show>
      <Show when={kind() !== "Depot" && c().stocks.length > 0}>
        <Section title="Stocks">
          <For each={c().stocks}>{(s) => <Row label={s.what}><Bar value={s.full} color={s.full <= 0 ? BAD : GOOD} /></Row>}</For>
        </Section>
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
          <For each={c().staff}>{(s) => <box minH={22} justify="center" opacity={s.present ? 1 : 0.5}><To link={s.who} /></box>}</For>
        </Section>
      </Show>
      <Show when={c().fleet.length > 0 && kind() !== "Harbour"}>
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
          <For each={c().served.filter((s) => s.hours_today > 0)}>{(s) => <Row label={s.need}><text size={13.5}>{s.hours_today.toFixed(1)} h</text></Row>}</For>
        </Section>
      </Show>
    </>
  );
}
