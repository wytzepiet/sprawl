import { Box, Text } from "~ui";
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, sea, until } from "../state/sea";
import { pieceOf } from "../state/deals";
import { setFollowing } from "../state/selection";
import { BLUEPRINTS, GOODS, packages } from "../blueprints";
import { quoteOf, total } from "../state/market";
import { BAD, Btn, coins, GOOD, GoodDot, SEA, Section, StepBar } from "./kit";
import type { JSX } from "solid-js";
import type { Building, CallLine, DepotLine, Good, MakerLine, Stock } from "../generated";

/**
 * A site's card: each material it waits on, and where that is — on the
 * van, in stock at the depot, in a maker's yard, on the quay, on the
 * boat — and, where it is stuck, the one tap that frees it: packages
 * bought at the market, on the next ferry.
 * docs/game.md §Buildings.
 */
export function SitePanel(props: { site: NonNullable<Building["site"]>; depots: DepotLine[]; makers: MakerLine[]; calls: CallLine[] }) {
  const materials = () => (Object.entries(props.site) as [Good, Stock][]).filter(([, s]) => s);
  const short = (s: Stock) => Math.max(0, Math.ceil(s.cap - s.level));
  const waiting = () => materials().filter(([, s]) => short(s) > 0);
  return (
    <Section title="Going up">
      <Text size={15} weight={600}>{waiting().length ? `Waiting on ${waiting().map(([g, s]) => `${short(s)} ${GOODS[g].label}`).join(" and ")}` : "All its materials are here"}</Text>
      <For each={materials()}>
        {([good, stock]) => (
          <Box pad={{ top: 8 }} gap={6}>
            <Box dir="row" align="center" gap={10}>
              <GoodDot good={good} size={26} />
              <Box grow={1} gap={4}>
                <Box dir="row" align="end" justify="between">
                  <Text size={13} weight={600}>{GOODS[good].label[0].toUpperCase() + GOODS[good].label.slice(1)}</Text>
                  <Box dir="row" align="end" gap={2}>
                    <Text serif size={13}>{Math.floor(stock.level)}</Text>
                    <Text serif size={12} soft>/ {stock.cap}</Text>
                  </Box>
                </Box>
                <StepBar steps={stock.cap} at={Math.floor(stock.level) - 1} color={GOODS[good].color} />
              </Box>
            </Box>
            <Show when={short(stock) > 0}>
              <Where good={good} short={short(stock)} depots={props.depots} makers={props.makers} calls={props.calls} />
            </Show>
          </Box>
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
  const nearest = () => props.depots[0] ?? null;
  const van = () => props.calls.find((c) => c.good === g() && c.answered_by)?.answered_by ?? null;
  const stocked = () => props.depots.find((d) => (d.stocks[g()] ?? 0) >= 1) ?? null;
  const maker = () => props.makers.find((m) => m.good === g() && m.level >= 1) ?? null;
  /** Its packages in from the world, the furthest along first. */
  const inbound = () => sea.shipments.filter((s) => s.good === g() && !s.outbound).sort((a, b) => pieceOf(b).step - pieceOf(a).step);
  /** Packages on a quay, and the depot whose lorry would fetch them. */
  const parked = () => {
    const on = inbound().filter((s) => s.leg === "Quay");
    const d = on[0] && (props.depots.find((d) => d.depot.id === on[0].to) ?? nearest());
    return d ? { n: on.length, d } : null;
  };
  const coming = () => inbound().find((s) => s.leg !== "Quay") ?? null;
  const n = () => Math.max(1, Math.ceil(props.short / GOODS[g()].per));
  const quote = () => quoteOf(g());
  const cost = () => (quote() ? total(quote()!, n(), false) : 0);
  const sailing = () => sea.sailings[0];
  const [ordered, setOrdered] = createSignal(false);
  const order = () => {
    if (!quote() || !sailing()) return;
    send({ type: "Trade", data: { good: g(), packages: n(), out: false } });
    setOrdered(true);
  };
  return (
    <Box pad={{ left: 36 }}>
      <>{() => {
        const v = van();
        if (v) return <Line dot={GOOD} text="On the van, on its way" act={<Btn onTap={() => setFollowing(v.id)}>follow</Btn>} />;
        const d = stocked();
        if (d) return <Line dot={GOOD} text={`In stock at the depot: ${Math.floor(d.stocks[g()] ?? 0)}`} sub="its van brings it" />;
        const m = maker();
        if (m) return <Line dot={GOOD} text={`At the ${BLUEPRINTS[m.kind].label.toLowerCase()}: ${Math.floor(m.level)} ${label()}`} sub="the depot's lorry fetches it, then its van brings it" />;
        const p = parked();
        if (p) return <Line dot={p.d.joined ? SEA : "#FFD60A"} text={`${packages(g(), p.n)} on the quay`} sub={p.d.joined ? "the lorry fetches it as the depot has room" : "no road joins the depot to the harbour"} />;
        const s = coming();
        if (s) {
          const b = pieceOf(s);
          return <Line dot={SEA} text={`${packages(g(), inbound().filter((x) => x.leg === s.leg).length)} ${b.words}`} sub={b.eta ? `in ${until(b.eta)}` : undefined} />;
        }
        if (!nearest()) return <Line dot={BAD} text="No depot yet" sub={`build one by the harbour: its vans bring the ${label()}`} />;
        const x = sailing();
        return (
          <Line
            dot={BAD}
            text={ordered() ? `Booked: lands ${x ? clockAt(x.lands) : "on the next ferry"}` : `No ${label()} in town, and none coming`}
            sub={x ? `${packages(g(), n())} on the next ferry, landing ${clockAt(x.lands)}, ${coins(-cost())} coins` : "no harbour: nothing can come"}
            act={
              <Btn big color={GOODS[g()].color} onTap={order} disabled={ordered() || !x || !quote() || growth().treasury < cost()}>
                {ordered() ? "Booked ✓" : `Book ${label()}`}
              </Btn>
            }
          />
        );
      }}</>
    </Box>
  );
}

/** A line of where a material is: a dot of how it stands, what, and the
 *  fix, if there is one, under it, so the words keep the card's width. */
function Line(props: { dot: string; text: string; sub?: string; act?: JSX.Element }) {
  return (
    <Box pad={{ y: 2 }} gap={6}>
      <Box dir="row" align="start" gap={10}>
        <Box w={10} h={10} round={5} fill={props.dot} y={3} />
        <Box grow={1} gap={1}>
          <Text size={13.5} weight={600}>{props.text}</Text>
          <Show when={props.sub}>
            <Text size={11.5} soft>{props.sub}</Text>
          </Show>
        </Box>
      </Box>
      <Show when={props.act}>
        <Box dir="row" justify="end">{props.act}</Box>
      </Show>
    </Box>
  );
}
