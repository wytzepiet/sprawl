/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, plural, sea, until } from "../state/sea";
import { boxOf } from "../state/deals";
import { setFollowing } from "../state/selection";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { quoteOf, total } from "../state/market";
import { BAD, Btn, coins, GOOD, GoodDot, SEA, Section, StepBar } from "./kit";
import type { JSX } from "~ui/jsx-runtime";
import type { Building, CallLine, DepotLine, Good, MakerLine, Stock } from "../generated";

/**
 * A site's card: each material it waits on, and where that is — on the
 * van, in stock at the depot, in a maker's yard, in the trailer park, on
 * the boat — and, where it is stuck, the one tap that frees it: a box
 * bought at the market, on the next ferry.
 * docs/game.md §Buildings.
 */
export function SitePanel(props: { site: NonNullable<Building["site"]>; depots: DepotLine[]; makers: MakerLine[]; calls: CallLine[] }) {
  const materials = () => (Object.entries(props.site) as [Good, Stock][]).filter(([, s]) => s);
  const short = (s: Stock) => Math.max(0, Math.ceil(s.cap - s.level));
  const waiting = () => materials().filter(([, s]) => short(s) > 0);
  return (
    <Section title="Going up">
      <text size={15} weight={600}>{waiting().length ? `Waiting on ${waiting().map(([g, s]) => `${short(s)} ${GOODS[g].label}`).join(" and ")}` : "All its materials are here"}</text>
      <For each={materials()}>
        {([good, stock]) => (
          <box pad={{ top: 8 }} gap={6}>
            <box dir="row" align="center" gap={10}>
              <GoodDot good={good} size={26} />
              <box grow={1} gap={4}>
                <box dir="row" align="end" justify="between">
                  <text size={13} weight={600}>{GOODS[good].label[0].toUpperCase() + GOODS[good].label.slice(1)}</text>
                  <box dir="row" align="end" gap={2}>
                    <text serif size={13}>{Math.floor(stock.level)}</text>
                    <text serif size={12} soft>/ {stock.cap}</text>
                  </box>
                </box>
                <StepBar steps={stock.cap} at={Math.floor(stock.level) - 1} color={GOODS[good].color} />
              </box>
            </box>
            <Show when={short(stock) > 0}>
              <Where good={good} short={short(stock)} depots={props.depots} makers={props.makers} calls={props.calls} />
            </Show>
          </box>
        )}
      </For>
    </Section>
  );
}

/** Where a material a site waits on is, and the fix where it is stuck. */
function Where(props: { good: Good; short: number; depots: DepotLine[]; makers: MakerLine[]; calls: CallLine[] }) {
  const { send, growth } = useGame();
  const g = () => props.good;
  const label = () => GOODS[g()].label;
  const box = () => GOODS[g()].box;
  const nearest = () => props.depots[0] ?? null;
  const van = () => props.calls.find((c) => c.good === g() && c.answered_by)?.answered_by ?? null;
  const stocked = () => props.depots.find((d) => (d.stocks[g()] ?? 0) >= 1) ?? null;
  const maker = () => props.makers.find((m) => m.good === g() && m.level >= 1) ?? null;
  /** Its boxes in from the world, the furthest along first. */
  const inbound = () => sea.shipments.filter((s) => s.good === g() && !s.outbound && s.units > 0).sort((a, b) => boxOf(b).step - boxOf(a).step);
  /** A box in a trailer park, and the depot whose lorry would fetch it. */
  const parked = () => {
    const s = inbound().find((s) => s.leg === "Parked");
    const d = s && (props.depots.find((d) => d.depot.id === s.to) ?? nearest());
    return s && d ? { s, d } : null;
  };
  const coming = () => inbound().find((s) => s.leg !== "Parked") ?? null;
  const boxes = () => Math.max(1, Math.ceil(props.short / box()));
  const quote = () => quoteOf(g());
  const cost = () => (quote() ? total(quote()!, boxes(), false) : 0);
  const sailing = () => sea.sailings[0];
  const [ordered, setOrdered] = createSignal(false);
  const order = () => {
    if (!quote() || !sailing()) return;
    send({ type: "Trade", data: { good: g(), boxes: boxes(), out: false } });
    setOrdered(true);
  };
  return (
    <box pad={{ left: 36 }}>
      <>{() => {
        const v = van();
        if (v) return <Line dot={GOOD} text="On the van, on its way" act={<Btn onTap={() => setFollowing(v.id)}>follow</Btn>} />;
        const d = stocked();
        if (d) return <Line dot={GOOD} text={`In stock at the depot: ${Math.floor(d.stocks[g()] ?? 0)}`} sub="its van brings it" />;
        const m = maker();
        if (m) return <Line dot={GOOD} text={`At the ${BLUEPRINTS[m.kind].label.toLowerCase()}: ${Math.floor(m.level)} ${label()}`} sub="the depot's lorry fetches it, then its van brings it" />;
        const p = parked();
        if (p) return <Line dot={p.d.joined ? SEA : "#E0A030"} text={`${Math.round(p.s.units)} ${label()} in the trailer park`} sub={p.d.joined ? "the lorry fetches it as the depot has room" : "no road joins the depot to the harbour"} />;
        const s = coming();
        if (s) {
          const b = boxOf(s);
          return <Line dot={SEA} text={`${Math.round(s.units)} ${label()} ${b.words}`} sub={b.eta ? `in ${until(b.eta)}` : undefined} />;
        }
        if (!nearest()) return <Line dot={BAD} text="No depot yet" sub={`build one by the harbour: its vans bring the ${label()}`} />;
        const x = sailing();
        return (
          <Line
            dot={BAD}
            text={ordered() ? `Booked: lands ${x ? clockAt(x.lands) : "on the next ferry"}` : `No ${label()} in town, and none coming`}
            sub={x ? `${plural(boxes(), "box", "boxes")} of ${boxes() * box()} on the next ferry, landing ${clockAt(x.lands)}, ${coins(-cost())} coins` : "no harbour: nothing can come"}
            act={
              <Btn big color={GOODS[g()].color} onTap={order} disabled={ordered() || !x || !quote() || growth().treasury < cost()}>
                {ordered() ? "Booked ✓" : `Book ${label()}`}
              </Btn>
            }
          />
        );
      }}</>
    </box>
  );
}

/** A line of where a material is: a dot of how it stands, what, and the
 *  fix, if there is one, under it, so the words keep the card's width. */
function Line(props: { dot: string; text: string; sub?: string; act?: JSX.Element }) {
  return (
    <box pad={{ y: 2 }} gap={6}>
      <box dir="row" align="start" gap={10}>
        <box w={10} h={10} round={5} fill={props.dot} y={3} />
        <box grow={1} gap={1}>
          <text size={13.5} weight={600}>{props.text}</text>
          <Show when={props.sub}>
            <text size={11.5} soft>{props.sub}</text>
          </Show>
        </box>
      </box>
      <Show when={props.act}>
        <box dir="row" justify="end">{props.act}</box>
      </Show>
    </box>
  );
}
