import { createSignal, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { clockAt, landsAt, legWords, LEGS, plural, sea, until } from "../state/sea";
import { setFollowing } from "../state/selection";
import { boxCost, GOODS } from "../blueprints";
import type { DepotLine } from "./Harbour";
import { Btn, coins, GoodDot, Section, type Link } from "./kit";
import type { Stock } from "../generated";

/**
 * A site's card: what it waits on, and where that is — on its way in the
 * van, in stock at the depot, on the boat, or nothing coming, with the
 * order beside it and when it would land. docs/game.md §Buildings.
 */
export function SitePanel(props: { site: Stock; depots: DepotLine[]; van: Link | null }) {
  const { send } = useGame();
  const short = () => Math.max(0, Math.ceil(props.site.cap - props.site.level));
  const nearest = () => props.depots[0] ?? null;
  const stocked = () => props.depots.find((d) => (d.stocks.Timber ?? 0) >= 1) ?? null;
  /** The nearest timber on its way in from the world, by how far along it is. */
  const coming = () =>
    sea.shipments
      .filter((s) => s.good === "Timber" && !s.outbound && s.units > 0)
      .sort((a, b) => LEGS.indexOf(b.leg) - LEGS.indexOf(a.leg))[0] ?? null;
  const boxes = () => Math.max(1, Math.ceil(short() / GOODS.Timber.box));
  const sailing = () => sea.sailings[0];
  const [ordered, setOrdered] = createSignal(false);
  const order = () => {
    const d = nearest();
    if (!d) return;
    send({ type: "Order", data: { depot: d.depot.id, good: "Timber", boxes: boxes() } });
    setOrdered(true);
  };
  return (
    <>
      <Section title="Going up">
        <div class="flex items-center gap-3">
          <GoodDot good="Timber" size={34} />
          <div class="flex-1">
            <div class="text-[15px] font-semibold">
              {short() > 0 ? `Waiting on ${short()} of ${props.site.cap} timber` : "All its timber is here"}
            </div>
            <div class="mt-1 flex gap-[3px]">
              {Array.from({ length: props.site.cap }, (_, i) => (
                <span class="h-2 flex-1 rounded-full transition-colors duration-500" style={{ background: i < props.site.level ? GOODS.Timber.color : "rgb(var(--ink) / 0.1)" }} />
              ))}
            </div>
          </div>
        </div>
      </Section>
      <Section title="Where it is">
        <Show when={props.van}>
          {(v) => (
            <Line dot="#57A773" text="On the van, on its way" act={<Btn onClick={() => setFollowing(v().id)}>follow</Btn>} />
          )}
        </Show>
        <Show when={!props.van && stocked()}>
          {(d) => <Line dot="#57A773" text={`In stock at the depot: ${Math.floor(d().stocks.Timber ?? 0)}`} sub="its van brings it" />}
        </Show>
        <Show when={!props.van && !stocked() && coming()}>
          {(s) => {
            const w = () => legWords(s());
            return <Line dot="#2B6CA3" text={`${GOODS.Timber.box} timber ${w().words}`} sub={w().eta ? `in ${until(w().eta!)}` : undefined} />;
          }}
        </Show>
        <Show when={!props.van && !stocked() && !coming()}>
          <Show when={nearest()} fallback={<Line dot="#D9483B" text="No depot yet" sub="build one by the harbour: its van brings timber" />}>
            <Line
              dot="#D9483B"
              text={ordered() ? "Ordered: on the next ferry" : "Nothing coming"}
              sub={sailing() ? `${plural(boxes(), "box", "boxes")} would land ${clockAt(landsAt(sailing()!))}, ${coins(-boxes() * boxCost("Timber"))} coins` : undefined}
              act={<Btn big color={GOODS.Timber.color} onClick={order} disabled={ordered() || !sailing()}>Order timber</Btn>}
            />
          </Show>
        </Show>
      </Section>
    </>
  );
}

function Line(props: { dot: string; text: string; sub?: string; act?: any }) {
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

