/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, now, sea, until } from "../state/sea";
import { pieceOf } from "../state/deals";
import { setFollowing } from "../state/selection";
import { mayorsLorry } from "../state/haul";
import { BLUEPRINTS, GOODS, packages } from "../blueprints";
import { quoteOf, total } from "../state/market";
import { Bar, BAD, Btn, coins, GOOD, GoodDot, SEA, Section, StepBar } from "./kit";
import { BUILD_MS } from "../generated/rows";
import type { JSX } from "~ui/jsx-runtime";
import type { Building, CallLine, DepotLine, Good, MakerLine, Stock } from "../generated";

/**
 * A site's card: each material it waits on, and where that is — on the
 * van, in stock at the depot, in a maker's yard, on the quay, on the
 * boat — and, where it is stuck, the one tap that frees it: packages
 * bought at the market, on the next ferry.
 * docs/game.md §Buildings.
 */
export function SitePanel(props: { id: number; site: NonNullable<Building["site"]>; depots: DepotLine[]; makers: MakerLine[]; calls: CallLine[] }) {
  const materials = () => (Object.entries(props.site) as [Good, Stock][]).filter(([, s]) => s);
  const short = (s: Stock) => Math.max(0, Math.ceil(s.cap - s.level));
  const waiting = () => materials().filter(([, s]) => short(s) > 0);
  /** How far your lorry is through building what it brought, while it
   *  stands here: a package a `BUILD_MS`. */
  const building = () => {
    const l = mayorsLorry();
    const e = l?.car.errand;
    if (!l || e?.doing !== "Build" || e.to !== props.id) return null;
    return Math.max(0, Math.min(1, 1 - (l.car.due - now()) / (e.packages * BUILD_MS)));
  };
  return (
    <Section title="Going up">
      <text size={15} weight={600}>{waiting().length ? `Waiting on ${waiting().map(([g, s]) => `${short(s)} ${GOODS[g].label}`).join(" and ")}` : "All its materials are here"}</text>
      <Show when={building() !== null}>
        <box dir="row" align="center" gap={10} pad={{ top: 6 }}>
          <text size={13} weight={600}>Your lorry is building</text>
          <Bar value={building()!} color={GOOD} />
        </box>
      </Show>
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
              <Where site={props.id} good={good} short={short(stock)} depots={props.depots} makers={props.makers} calls={props.calls} />
            </Show>
          </box>
        )}
      </For>
    </Section>
  );
}

/** Where a material a site waits on is, and the fix where it is stuck. */
function Where(props: { site: number; good: Good; short: number; depots: DepotLine[]; makers: MakerLine[]; calls: CallLine[] }) {
  const { send, growth } = useGame();
  const g = () => props.good;
  const label = () => GOODS[g()].label;
  const nearest = () => props.depots[0] ?? null;
  const van = () => props.calls.find((c) => c.good === g() && c.answered_by)?.answered_by ?? null;
  const stocked = () => props.depots.find((d) => (d.stocks[g()] ?? 0) >= 1) ?? null;
  const maker = () => props.makers.find((m) => m.good === g() && m.level >= 1) ?? null;
  /** Its packages in from the world, the furthest along first. */
  const inbound = () => sea.shipments.filter((s) => s.good === g() && !s.outbound).sort((a, b) => pieceOf(b).step - pieceOf(a).step);
  /** Packages on a quay, the harbour's, and the depot whose lorry would
   *  fetch them. */
  const parked = () => {
    const on = inbound().filter((s) => s.leg === "Quay");
    return on[0] ? { n: on.length, at: on[0].carrier, d: props.depots.find((d) => d.depot.id === on[0].to) ?? nearest() } : null;
  };
  /** Your lorry: on its way with this, or free to go and fetch it. */
  const lorry = () => mayorsLorry();
  const mine = () => {
    const e = lorry()?.car.errand;
    return !!e && e.to === props.site && e.good === g();
  };
  const bring = (from: number | null) =>
    lorry() && from !== null && <Btn big color={GOODS[g()].color} onTap={() => send({ type: "Haul", data: { from, good: g(), packages: n(), to: props.site } })}>Bring it yourself</Btn>;
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
    <box pad={{ left: 36 }}>
      <>{() => {
        if (mine()) return <Line dot={GOOD} text="Your lorry is on it" act={<Btn onTap={() => setFollowing(lorry()!.id)}>follow</Btn>} />;
        const v = van();
        if (v) return <Line dot={GOOD} text="On the van, on its way" act={<Btn onTap={() => setFollowing(v.id)}>follow</Btn>} />;
        const d = stocked();
        if (d) return <Line dot={GOOD} text={`In stock at the depot: ${Math.floor(d.stocks[g()] ?? 0)}`} sub="its van brings it" />;
        const m = maker();
        if (m) return <Line dot={GOOD} text={`At the ${BLUEPRINTS[m.kind].label.toLowerCase()}: ${Math.floor(m.level)} ${label()}`} sub={nearest() ? "the depot's lorry fetches it, then its van brings it" : undefined} act={bring(m.maker.id)} />;
        const p = parked();
        if (p) return <Line dot={!p.d || p.d.joined ? SEA : "#E0A030"} text={`${packages(g(), p.n)} on the quay`} sub={!p.d ? undefined : p.d.joined ? "the lorry fetches it as the depot has room" : "no road joins the depot to the harbour"} act={bring(p.at)} />;
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
