import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { BLUEPRINTS, BuildingIcon } from "../blueprints";
import { selected, select, setFollowing, setSubject } from "../state/selection";
import type { BuildingKind, Need } from "../generated";

/** A line that points at something else on the map. */
interface Link {
  id: number;
  label: string;
  kind: "resident" | "building" | "car" | "gone";
}

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
      wage: number;
      selected: Need | null;
      since: string;
      buckets: Bucket[];
    }
  | {
      kind: "car";
      id: number;
      role: "Private" | "Van" | "Truck" | "Company";
      owner: Link;
      rider: Link | null;
      fuel: number | null;
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
      spots: number | null;
      here: { who: Link; doing: Need | null }[];
      household: Link[];
      staff: { who: Link; present: boolean }[];
      fleet: Link[];
      calls: { what: string; since: string; answered_by: Link | null }[];
      served: { need: Need; hours_today: number }[];
      money: Money | null;
    }
  | { kind: "gone"; id: number };

/** A building's prices and books, in hours of the edge's wage. */
interface Money {
  earns: number;
  jobs: number;
  prices: { need: Need; price: number; unit_cost: number; edge: number }[];
  today: Page | null;
  yesterday: Page | null;
}
interface Page {
  revenue: number;
  purchases: number;
  wages: number;
  margin: number;
}

/** How often an open card asks again. The world moves; the card should too. */
const REFRESH_MS = 1000;

/**
 * The card for whatever was tapped: who is in it, where it is going, what it
 * owes, each line a thing on the map you can go to. Read-only, and it says
 * nothing the map could not have shown — it only saves you watching for it.
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

  return (
    <Show when={card()}>
      {(c) => (
        <div class="card fixed top-4 left-4 z-40 w-72 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-stone-800 text-sm select-none">
          <Show when={c().kind === "resident"}>{ResidentCard(c() as Extract<Card, { kind: "resident" }>)}</Show>
          <Show when={c().kind === "car"}>{CarCard(c() as Extract<Card, { kind: "car" }>)}</Show>
          <Show when={c().kind === "building"}>{BuildingCard(c() as Extract<Card, { kind: "building" }>)}</Show>
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
    <div class="flex items-center gap-2 px-3 pt-3 pb-2">
      {props.icon}
      <div class="min-w-0 flex-1">
        <div class="font-semibold truncate">{props.title}</div>
        <Show when={props.sub}>
          <div class="text-xs text-stone-500 truncate">{props.sub}</div>
        </Show>
      </div>
      <button class="text-stone-400 hover:text-stone-800 px-1 cursor-pointer" onClick={() => select(null)} title="Close (Esc)">
        ×
      </button>
    </div>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="px-3 py-2 border-t border-black/[0.05]">
      <div class="text-[10px] font-bold uppercase tracking-widest text-stone-400 mb-1">{props.title}</div>
      {props.children}
    </div>
  );
}

/** A line you can go to. */
function To(props: { link: Link | null | undefined; fallback?: string }) {
  return (
    <Show when={props.link} fallback={<span class="text-stone-400">{props.fallback ?? "—"}</span>}>
      {(l) => (
        <button
          class="text-left underline decoration-stone-300 underline-offset-2 hover:decoration-stone-800 cursor-pointer"
          onClick={() => select(l().id)}
        >
          {l().label}
        </button>
      )}
    </Show>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex justify-between gap-2 py-0.5">
      <span class="text-stone-500">{props.label}</span>
      <span class="text-right truncate">{props.children}</span>
    </div>
  );
}

function Bar(props: { value: number; color?: string }) {
  return (
    <span class="inline-block h-1.5 w-20 rounded-full bg-black/[0.06] overflow-hidden align-middle">
      <span class="block h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, props.value)) * 100)}%`, "background-color": props.color ?? "#5B57C8" }} />
    </span>
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
      <Section title="Work">
        <Row label="Earns">{h(c.wage)} / h</Row>
      </Section>
      <Section title={`Needs, since ${c.since}`}>
        <For each={c.buckets}>
          {(b) => (
            <div class="flex items-center justify-between gap-2 py-0.5" classList={{ "font-semibold": c.selected === b.need }}>
              <span class="w-16 text-stone-600">{b.need}</span>
              <Bar value={b.full} color={c.selected === b.need ? "#5B57C8" : "#A8A29E"} />
              <span class="w-24 text-right text-xs text-stone-500 truncate">
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

function CarCard(c: Extract<Card, { kind: "car" }>) {
  const what = c.role === "Truck" ? "Lorry" : c.role === "Van" ? "Van" : "Car";
  return (
    <>
      <Header title={c.rider ? `${c.rider.label}'s ${what.toLowerCase()}` : what} sub={c.trip ? `to ${c.trip.to.label}` : c.parked_at ? `parked at ${c.parked_at.label}` : "parked out of sight"} />
      <Section title="Who">
        <Row label="Aboard"><To link={c.rider} fallback="nobody" /></Row>
        <Row label={c.role === "Private" ? "Owner" : "Of"}><To link={c.owner} /></Row>
        <Show when={c.fuel !== null}>
          <Row label="Fuel"><Bar value={c.fuel!} color={c.fuel! < 0.2 ? "#D9483B" : "#57A773"} /></Row>
        </Show>
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

/** Hours of the edge's wage, to a tenth. */
function h(v: number): string {
  return `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} h`;
}

function BuildingCard(c: Extract<Card, { kind: "building" }>) {
  const bp = BLUEPRINTS[c.building_kind];
  return (
    <>
      <Header
        title={bp.label}
        sub={c.reached ? (c.spots !== null ? `${c.spots} parking spots` : undefined) : "no road reaches it"}
        icon={
          <span class="grid h-8 w-8 place-items-center rounded-full" style={{ "background-color": bp.color }}>
            <BuildingIcon kind={c.building_kind} class="text-white" width="18" height="18" />
          </span>
        }
      />
      <Show when={c.stocks.length > 0}>
        <Section title="Stocks">
          <For each={c.stocks}>{(s) => <Row label={s.need}><Bar value={s.full} color={s.full <= 0 ? "#D9483B" : "#57A773"} /></Row>}</For>
        </Section>
      </Show>
      <Show when={c.money}>
        {(m) => (
          <Section title="Books">
            <Row label="Earns">{h(m().earns)} / h</Row>
            <For each={m().prices}>
              {(p) => (
                <Row label={p.need}>
                  {h(p.price)} <span class="text-stone-400">· edge {h(p.edge)}</span>
                </Row>
              )}
            </For>
            <Show when={m().today}>
              {(t) => (
                <>
                  <Row label="Today in">{h(t().revenue)}</Row>
                  <Show when={t().purchases > 0}><Row label="Bought">{h(t().purchases)}</Row></Show>
                  <Show when={t().wages > 0}><Row label="Wages">{h(t().wages)}</Row></Show>
                  <Row label="Margin"><span classList={{ "text-red-600": t().margin < 0 }}>{h(t().margin)}</span></Row>
                </>
              )}
            </Show>
          </Section>
        )}
      </Show>
      <Show when={c.here.length > 0}>
        <Section title={`Here now · ${c.here.length}`}>
          <For each={c.here}>{(h) => <Row label={h.doing ?? ""}><To link={h.who} /></Row>}</For>
        </Section>
      </Show>
      <Show when={c.household.length > 0}>
        <Section title={`Lives here · ${c.household.length}`}>
          <For each={c.household}>{(l) => <div class="py-0.5"><To link={l} /></div>}</For>
        </Section>
      </Show>
      <Show when={c.staff.length > 0}>
        <Section title={`Works here · ${c.staff.filter((s) => s.present).length} of ${c.staff.length} in`}>
          <For each={c.staff}>
            {(s) => (
              <div class="py-0.5" classList={{ "text-stone-400": !s.present }}>
                <To link={s.who} />
              </div>
            )}
          </For>
        </Section>
      </Show>
      <Show when={c.fleet.length > 0}>
        <Section title="Fleet">
          <For each={c.fleet}>{(l) => <div class="py-0.5"><To link={l} /></div>}</For>
        </Section>
      </Show>
      <Show when={c.calls.length > 0}>
        <Section title="Calls">
          <For each={c.calls}>{(k) => <Row label={`${k.what} since ${k.since}`}><To link={k.answered_by} fallback="waiting" /></Row>}</For>
        </Section>
      </Show>
      <Show when={c.served.some((s) => s.hours_today > 0)}>
        <Section title="Served today">
          <For each={c.served.filter((s) => s.hours_today > 0)}>{(s) => <Row label={s.need}>{s.hours_today.toFixed(1)} h</Row>}</For>
        </Section>
      </Show>
    </>
  );
}
