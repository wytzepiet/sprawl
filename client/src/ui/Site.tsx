import { createSignal, For, Show, type JSX } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, landsAt, legWords, LEGS, plural, sea, until } from "../state/sea";
import { setFollowing } from "../state/selection";
import { BLUEPRINTS, boxCost, GOODS } from "../blueprints";
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
 * the boat — and, where it is stuck, the one tap that frees it: send the
 * lorry for the box in the park, order a box on the next ferry, give the
 * depot a rule so the next site does not wait. docs/game.md §Buildings.
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
  const cost = () => boxes() * boxCost(g());
  const sailing = () => sea.sailings[0];
  const [ordered, setOrdered] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [ruled, setRuled] = createSignal(false);
  const order = () => {
    const d = nearest();
    if (!d) return;
    send({ type: "Order", data: { depot: d.depot.id, good: g(), boxes: boxes() } });
    setOrdered(true);
  };
  /** The rule a depot's card offers: a box kept, two filled to. */
  const rule = () => {
    const d = nearest();
    if (!d) return;
    send({ type: "SetRule", data: { depot: d.depot.id, good: g(), rule: { keep: box(), fill: 2 * box(), sell: null } } });
    setRuled(true);
  };
  const ruleless = () => nearest() && !nearest()!.rules[g()];
  return (
    <div class="mt-1 pl-[36px]">
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
          <Show when={!p().d.standing} fallback={<Line dot="#2B6CA3" text={`${Math.round(p().s.units)} ${label()} in the trailer park`} sub="the lorry fetches it: it has standing orders" />}>
            <Line
              dot="#E0A030"
              text={`${Math.round(p().s.units)} ${label()} in the trailer park`}
              sub={sent() ? "the lorry is on its way" : p().d.joined ? "the lorry waits to be sent" : "no road joins the depot to the harbour"}
              act={<Btn big color="#A0714A" onClick={() => (send({ type: "Send", data: { depot: p().d.depot.id } }), setSent(true))} disabled={sent() || !p().d.joined}>{sent() ? "Sent ✓" : "Send the lorry"}</Btn>}
            />
          </Show>
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
            text={ordered() ? `Ordered: lands ${sailing() ? clockAt(landsAt(sailing()!)) : "on the next ferry"}` : `No ${label()} in town, and none coming`}
            sub={sailing() ? `${plural(boxes(), "box", "boxes")} of ${boxes() * box()} on the next ferry, landing ${clockAt(landsAt(sailing()!))}, ${coins(-cost())} coins` : "no harbour: nothing can come"}
            act={
              <Btn big color={GOODS[g()].color} onClick={order} disabled={ordered() || !sailing() || growth().treasury < cost()} title={growth().treasury < cost() ? "The treasury cannot pay for it" : undefined}>
                {ordered() ? "Ordered ✓" : `Order ${label()}`}
              </Btn>
            }
          />
        </Show>
      </Show>
      <Show when={ruleless() && !van() && !stocked()}>
        <Line
          dot="rgb(var(--ink) / 0.3)"
          text={ruled() ? `The depot keeps ${label()} now` : `The depot keeps no ${label()} of its own`}
          sub={ruled() ? `a box kept, two filled to, ordered when it runs low` : `give it a rule, and the next site waits on nothing`}
          act={<Btn onClick={rule} disabled={ruled()}>{ruled() ? "Ruled ✓" : `Keep ${box()} in stock`}</Btn>}
        />
      </Show>
    </div>
  );
}

function Line(props: { dot: string; text: string; sub?: string; act?: JSX.Element }) {
  return (
    <div class="flex items-center gap-2.5 py-0.5">
      <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: props.dot }} />
      <div class="min-w-0 flex-1 leading-tight">
        <div class="text-[13.5px] font-semibold">{props.text}</div>
        <Show when={props.sub}>
          <div class="soft text-[11.5px]">{props.sub}</div>
        </Show>
      </div>
      {props.act}
    </div>
  );
}
