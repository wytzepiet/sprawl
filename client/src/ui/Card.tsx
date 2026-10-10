import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { BLUEPRINTS, BuildingIcon } from "../blueprints";
import { selected, select, setFollowing, setSubject } from "../state/selection";
import { getEntity } from "../state/gameObjects";
import { now, sailingOf } from "../state/sea";
import { guideUp } from "./Guide";
import { HarbourPanel, Timetable, type DepotLine } from "./Harbour";
import { DepotPanel } from "./Depot";
import { SitePanel, type MakerLine } from "./Site";
import { Bar, Row, Section, To, type Link } from "./kit";
import type { Building, BuildingKind, CarRole, Good, Need } from "../generated";

interface Bucket {
  need: Need;
  full: number;
  owed_h: number;
  option: "nothing" | { building: number; score: number; departure: string; leave: string; wait_h: number };
}

type Card =
  | {
      kind: "resident";
      id: number;
      name: string;
      home: Link;
      work: Link | null;
      at: Link | null;
      car: Link;
      selected: Need | null;
      since: string;
      buckets: Bucket[];
    }
  | {
      kind: "car";
      id: number;
      role: CarRole;
      owner: Link;
      rider: Link | null;
      stocks: { need: Need; full: number }[];
      trip: { to: Link; due: string; late_s: number } | null;
      parked_at: Link | null;
      answering: { what: string; for: Link; since: string }[];
    }
  | {
      kind: "building";
      id: number;
      label: string;
      building_kind: BuildingKind;
      reached: boolean;
      stocks: { need: Need; full: number }[];
      here: { who: Link; doing: Need | null }[];
      household: Link[];
      staff: { who: Link; present: boolean }[];
      fleet: Link[];
      calls: { what: string; good: Good; since: string; answered_by: Link | null }[];
      served: { need: Need; hours_today: number }[];
      depots: DepotLine[];
      makers: MakerLine[];
    }
  | { kind: "gone"; id: number };
type BuildingCard = Extract<Card, { kind: "building" }>;

/** How often an open card asks again. The world moves; the card should too. */
const REFRESH_MS = 1000;

/**
 * The card for whatever was tapped: who is in it, where it is going, what it
 * owes, each line a thing on the map you can go to; and, for the harbour, a
 * depot and a site, what the mayor does there. On the glass, in the glass's
 * ink.
 */
export default function Card() {
  const [card, setCard] = createSignal<Card | null>(null);

  createEffect(on(selected, (id) => {
    setCard(null);
    if (id === null) return;
    let live = true;
    const fetchCard = async () => {
      const r = await fetch(`/inspect/${id}`);
      if (!live) return;
      const c = (await r.json()) as Card;
      setCard(c);
      // A resident is not on the map; where they are is.
      if (c.kind === "resident") {
        const at = c.at?.id ?? null;
        setSubject(at);
        setFollowing((f) => (f === id || (at !== null && f !== null) ? at : f));
      }
    };
    fetchCard();
    const timer = setInterval(fetchCard, REFRESH_MS);
    onCleanup(() => {
      live = false;
      clearInterval(timer);
    });
  }));

  // `#1234` in the address is a card to open on arrival: a thing you can
  // point someone at.
  const fromHash = () => {
    const id = Number(location.hash.slice(1));
    if (id) select(id);
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
  onCleanup(() => window.removeEventListener("hashchange", fromHash));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") select(null);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  /** The building whose card is open, by id alone: what the mayor works
   *  with on it is made once, not again with every refresh. */
  const building = createMemo(() => {
    const c = card();
    return c?.kind === "building" ? c.id : null;
  });
  const asBuilding = () => card() as BuildingCard;

  return (
    <Show when={card()}>
      {(c) => (
        <div data-glass="card" style={{ "max-height": guideUp() ? "calc(100vh - 96px - 136px)" : "calc(100vh - 8.5rem)" }} class="ink card fixed top-24 left-6 z-40 w-[320px] overflow-y-auto rounded-[22px] text-sm select-none pb-1.5">
          <Show when={c().kind === "resident"}>{ResidentCard(c() as Extract<Card, { kind: "resident" }>)}</Show>
          <Show when={c().kind === "car"}>{CarCard(c() as Extract<Card, { kind: "car" }>)}</Show>
          <Show when={building()} keyed>
            {(id) => <BuildingCard id={id} card={asBuilding} />}
          </Show>
          <Show when={c().kind === "gone"}>
            <Header title="Gone" sub="Nothing stands here any more" />
          </Show>
        </div>
      )}
    </Show>
  );
}

function Header(props: { title: string; sub?: string; icon?: JSX.Element }) {
  return (
    <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
      {props.icon}
      <div class="min-w-0 flex-1">
        <div class="truncate text-[16px] font-semibold">{props.title}</div>
        <Show when={props.sub}>
          <div class="soft truncate text-xs">{props.sub}</div>
        </Show>
      </div>
      <button class="soft press px-1 text-lg leading-none cursor-pointer" onClick={() => select(null)} title="Close (Esc)">
        ×
      </button>
    </div>
  );
}

function ResidentCard(c: Extract<Card, { kind: "resident" }>) {
  return (
    <>
      <Header title={c.name} sub={c.at ? `at ${c.at.label}` : "off the map"} />
      <Section title="Where">
        <Row label="Now"><To link={c.at} fallback="off the map" /></Row>
        <Row label="Home"><To link={c.home} /></Row>
        <Row label="Work"><To link={c.work} fallback="no job" /></Row>
        <Row label="Car"><To link={c.car} /></Row>
      </Section>
      <Section title={`Needs, since ${c.since}`}>
        <For each={c.buckets}>
          {(b) => (
            <div class="flex items-center justify-between gap-2 py-0.5" classList={{ "font-semibold": c.selected === b.need }}>
              <span class="soft w-16">{b.need}</span>
              <Bar value={b.full} color={c.selected === b.need ? "#7B77E0" : "#A8A29E"} />
              <span class="soft w-24 truncate text-right text-xs">
                <Show when={b.option !== "nothing"} fallback="nothing found">
                  <To link={{ id: (b.option as { building: number }).building, label: "→ option", kind: "building" }} />
                </Show>
              </span>
            </div>
          )}
        </For>
      </Section>
    </>
  );
}

const ROLE: Record<CarRole, string> = { Private: "Car", Truck: "Lorry", Van: "Van", Tractor: "Tractor", Ferry: "Ferry", Tug: "Tug" };

function CarCard(c: Extract<Card, { kind: "car" }>) {
  const what = ROLE[c.role];
  const sailing = () => (c.role === "Ferry" ? sailingOf(c.owner.id) : undefined);
  return (
    <>
      <Header title={c.rider ? `${c.rider.label}'s ${what.toLowerCase()}` : what} sub={c.trip ? `to ${c.trip.to.label}` : c.parked_at ? `parked at ${c.parked_at.label}` : c.role === "Ferry" ? `of the harbour` : "parked out of sight"} />
      <Show when={sailing()}>{(s) => <Section title="Timetable"><Timetable sailing={s()} /></Section>}</Show>
      <Section title="Who">
        <Row label="Aboard"><To link={c.rider} fallback="nobody" /></Row>
        <Row label={c.role === "Private" ? "Owner" : "Of"}><To link={c.owner} /></Row>
        <For each={c.stocks}>
          {(s) => <Row label={s.need}><Bar value={s.full} color={s.full < 0.2 ? "#D9483B" : "#57A773"} /></Row>}
        </For>
      </Section>
      <Show when={c.trip}>
        {(t) => (
          <Section title="Trip">
            <Row label="To"><To link={t().to} /></Row>
            <Row label="Due">{t().due}</Row>
            <Show when={t().late_s > 0}>
              <Row label="Lost to traffic">{Math.round(t().late_s)} s</Row>
            </Show>
          </Section>
        )}
      </Show>
      <Show when={c.answering.length > 0}>
        <Section title="Answering">
          <For each={c.answering}>{(a) => <Row label={a.what}><To link={a.for} /> · since {a.since}</Row>}</For>
        </Section>
      </Show>
    </>
  );
}

/**
 * A building's card: made once for the building, its lines read from the
 * card as it refreshes. What the mayor does here comes first: a site's
 * materials, a harbour's ferry and order, a depot's lorry and rules.
 */
function BuildingCard(props: { id: number; card: () => BuildingCard }) {
  const c = props.card;
  const kind = () => c().building_kind;
  const bp = () => BLUEPRINTS[kind()];
  /** Still going up: the client's own record of the site. */
  const site = createMemo(() => {
    now();
    const e = getEntity(props.id);
    return e?.object.kind === "Building" ? (e.object.data as Building).site : null;
  });
  const lorries = () => c().fleet.filter((l) => l.label === "Lorry").map((l) => l.id);
  return (
    <>
      <Header
        title={site() ? `${bp().label} · a site` : bp().label}
        sub={c().reached ? (site() ? "going up as its materials land" : undefined) : "no road reaches it"}
        icon={
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ "background-color": bp().color, opacity: site() ? 0.65 : 1 }}>
            <BuildingIcon kind={kind()} class="text-white" width="19" height="19" />
          </span>
        }
      />
      <Show when={site()}>{(s) => <SitePanel site={s()} depots={c().depots} makers={c().makers} calls={c().calls} />}</Show>
      <Show when={!site() && kind() === "Harbour"}>
        <HarbourPanel id={props.id} depots={c().depots} />
      </Show>
      <Show when={!site() && kind() === "Depot"}>
        <DepotPanel id={props.id} lorries={lorries()} depots={[]} />
      </Show>
      <Show when={kind() !== "Depot" && c().stocks.length > 0}>
        <Section title="Stocks">
          <For each={c().stocks}>{(s) => <Row label={s.need}><Bar value={s.full} color={s.full <= 0 ? "#D9483B" : "#57A773"} /></Row>}</For>
        </Section>
      </Show>
      <Show when={c().here.length > 0}>
        <Section title={`Here now · ${c().here.length}`}>
          <For each={c().here}>{(h) => <Row label={h.doing ?? ""}><To link={h.who} /></Row>}</For>
        </Section>
      </Show>
      <Show when={c().household.length > 0}>
        <Section title={`Lives here · ${c().household.length}`}>
          <For each={c().household}>{(l) => <div class="py-0.5"><To link={l} /></div>}</For>
        </Section>
      </Show>
      <Show when={c().staff.length > 0}>
        <Section title={`Works here · ${c().staff.filter((s) => s.present).length} of ${c().staff.length} in`}>
          <For each={c().staff}>
            {(s) => (
              <div class="py-0.5" classList={{ "opacity-50": !s.present }}>
                <To link={s.who} />
              </div>
            )}
          </For>
        </Section>
      </Show>
      <Show when={c().fleet.length > 0}>
        <Section title="Fleet">
          <For each={c().fleet}>{(l) => <div class="py-0.5"><To link={l} /></div>}</For>
        </Section>
      </Show>
      <Show when={!site() && c().calls.length > 0}>
        <Section title="Calls">
          <For each={c().calls}>{(k) => <Row label={`${k.what} since ${k.since}`}><To link={k.answered_by} fallback="waiting" /></Row>}</For>
        </Section>
      </Show>
      <Show when={c().served.some((s) => s.hours_today > 0)}>
        <Section title="Served today">
          <For each={c().served.filter((s) => s.hours_today > 0)}>{(s) => <Row label={s.need}>{s.hours_today.toFixed(1)} h</Row>}</For>
        </Section>
      </Show>
    </>
  );
}
