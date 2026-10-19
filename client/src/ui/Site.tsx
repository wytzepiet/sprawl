import { createSignal, For, Show, type JSX } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, landsAt, legWords, LEGS, plural, sea, until } from "../state/sea";
import { setFollowing } from "../state/selection";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { cheapest } from "./Deck";
import type { DepotLine } from "./Harbour";
import { Btn, coins, GoodDot, Section, type Link } from "./kit";
import type { Building, BuildingKind, Good, Stock } from "../generated";

/** A maker of one of a site's materials, as its card lists it (`card.rs`). */
export interface MakerLine {
  maker: Link;
  kind: BuildingKind;
  good: Good;
  level: number;
  tiles: number;
}

type Call = { good: Good; answered_by: Link | null };

/**
 * A site's card: each material it waits on, and where that is — on the
 * van, in stock at the depot, in a maker's yard, in the trailer park, on
 * the boat — and, where it is stuck, the one tap that frees it: a box
 * booked on the next ferry, from whoever sells it cheapest.
 * docs/game.md §Buildings.
 */
export function SitePanel(props: { site: NonNullable<Building["site"]>; depots: DepotLine[]; makers: MakerLine[]; calls: Call[] }) {
  const materials = () => (Object.entries(props.site) as [Good, Stock][]).filter(([, s]) => s);
  const short = (s: Stock) => Math.max(0, Math.ceil(s.cap - s.level));
  const waiting = () => materials().filter(([, s]) => short(s) > 0);
  return (
    <Section title="Going up">
      <div class="text-[15px] font-semibold">
        {waiting().length ? `Waiting on ${waiting().map(([g, s]) => `${short(s)} ${GOODS[g].label}`).join(" and ")}` : "All its materials are here"}
      </div>
      <For each={materials()}>
        {([good, stock]) => (
          <div class="mt-2.5">
            <div class="flex items-center gap-2.5">
              <GoodDot good={good} size={26} />
              <div class="flex-1">
                <div class="flex items-baseline justify-between text-[13px]">
                  <span class="font-semibold capitalize">{GOODS[good].label}</span>
                  <span class="serif tabular-nums">{Math.floor(stock.level)}<span class="soft text-xs"> / {stock.cap}</span></span>
                </div>
                <div class="mt-1 flex gap-[3px]">
                  {Array.from({ length: stock.cap }, (_, i) => (
                    <span class="h-1.5 flex-1 rounded-full transition-colors duration-500" style={{ background: i < stock.level ? GOODS[good].color : "rgb(var(--ink) / 0.1)" }} />
                  ))}
                </div>
              </div>
            </div>
            <Show when={short(stock) > 0}>
              <Where good={good} short={short(stock)} depots={props.depots} makers={props.makers} calls={props.calls} />
            </Show>
          </div>
        )}
      </For>
    </Section>
  );
}

/** Where a material a site waits on is, and the fix where it is stuck. */
function Where(props: { good: Good; short: number; depots: DepotLine[]; makers: MakerLine[]; calls: Call[] }) {
  const { send, growth } = useGame();
  const g = () => props.good;
  const label = () => GOODS[g()].label;
  const box = () => GOODS[g()].box;
  const nearest = () => props.depots[0] ?? null;
  const van = () => props.calls.find((c) => c.good === g() && c.answered_by)?.answered_by ?? null;
  const stocked = () => props.depots.find((d) => (d.stocks[g()] ?? 0) >= 1) ?? null;
  const maker = () => props.makers.find((m) => m.good === g() && m.level >= 1) ?? null;
  /** Its boxes in from the world, the furthest along first. */
  const inbound = () => sea.shipments.filter((s) => s.good === g() && !s.outbound && s.units > 0).sort((a, b) => LEGS.indexOf(b.leg) - LEGS.indexOf(a.leg));
  /** A box in a trailer park, and the depot whose lorry would fetch it. */
  const parked = () => {
    const s = inbound().find((s) => s.leg === "Parked");
    const d = s && (props.depots.find((d) => d.depot.id === s.to) ?? nearest());
    return s && d ? { s, d } : null;
  };
  const coming = () => inbound().find((s) => s.leg !== "Parked") ?? null;
  const boxes = () => Math.max(1, Math.ceil(props.short / box()));
  const offer = () => cheapest(g());
  const cost = () => boxes() * box() * (offer()?.price ?? 0);
  const sailing = () => sea.sailings[0];
  const [ordered, setOrdered] = createSignal(false);
  const order = () => {
    const o = offer();
    const s = sailing();
    if (!o || !s) return;
    for (let i = 0; i < boxes(); i++) send({ type: "Book", data: { harbour: s.harbour, good: g(), partner: o.partner, out: false } });
    setOrdered(true);
  };
  return (
    <div class="mt-1.5 pl-[36px]">
      <Show when={van()}>
        {(v) => <Line dot="#57A773" text="On the van, on its way" act={<Btn onClick={() => setFollowing(v().id)}>follow</Btn>} />}
      </Show>
      <Show when={!van() && stocked()}>
        {(d) => <Line dot="#57A773" text={`In stock at the depot: ${Math.floor(d().stocks[g()] ?? 0)}`} sub="its van brings it" />}
      </Show>
      <Show when={!van() && !stocked() && maker()}>
        {(m) => <Line dot="#57A773" text={`At the ${BLUEPRINTS[m().kind].label.toLowerCase()}: ${Math.floor(m().level)} ${label()}`} sub="the depot's lorry fetches it, then its van brings it" />}
      </Show>
      <Show when={!van() && !stocked() && !maker() && parked()}>
        {(p) => (
          <Line dot={p().d.joined ? "#2B6CA3" : "#E0A030"} text={`${Math.round(p().s.units)} ${label()} in the trailer park`} sub={p().d.joined ? "the lorry fetches it as the depot has room" : "no road joins the depot to the harbour"} />
        )}
      </Show>
      <Show when={!van() && !stocked() && !maker() && !parked() && coming()}>
        {(s) => {
          const w = () => legWords(s());
          return <Line dot="#2B6CA3" text={`${Math.round(s().units)} ${label()} ${w().words}`} sub={w().eta ? `in ${until(w().eta!)}` : undefined} />;
        }}
      </Show>
      <Show when={!van() && !stocked() && !maker() && !parked() && !coming()}>
        <Show when={nearest()} fallback={<Line dot="#D9483B" text="No depot yet" sub={`build one by the harbour: its vans bring the ${label()}`} />}>
          <Line
            dot="#D9483B"
            text={ordered() ? `Booked: lands ${sailing() ? clockAt(landsAt(sailing()!)) : "on the next ferry"}` : `No ${label()} in town, and none coming`}
            sub={sailing() ? `${plural(boxes(), "box", "boxes")} of ${boxes() * box()} on the next ferry, landing ${clockAt(landsAt(sailing()!))}, ${coins(-cost())} coins` : "no harbour: nothing can come"}
            act={
              <Btn big color={GOODS[g()].color} onClick={order} disabled={ordered() || !sailing() || !offer() || growth().treasury < cost()} title={growth().treasury < cost() ? "The treasury cannot pay for it" : undefined}>
                {ordered() ? "Booked ✓" : `Book ${label()}`}
              </Btn>
            }
          />
        </Show>
      </Show>
    </div>
  );
}

/** A line of where a material is: a dot of how it stands, what, and the
 *  fix, if there is one, under it, so the words keep the card's width. */
function Line(props: { dot: string; text: string; sub?: string; act?: JSX.Element }) {
  return (
    <div class="py-0.5">
      <div class="flex items-baseline gap-2.5">
        <span class="h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-full" style={{ background: props.dot }} />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="text-[13.5px] font-semibold">{props.text}</div>
          <Show when={props.sub}>
            <div class="soft text-[11.5px]">{props.sub}</div>
          </Show>
        </div>
      </div>
      <Show when={props.act}>
        <div class="mt-1.5 flex justify-end">{props.act}</div>
      </Show>
    </div>
  );
}
