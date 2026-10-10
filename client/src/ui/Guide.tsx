import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { eachEntity, getEntity, useGame } from "../state/gameObjects";
import { clockAt, sea, settled, until } from "../state/sea";
import { setTool } from "./buildMode";
import { selected } from "../state/selection";
import { track } from "./Shipments";
import { Btn } from "./kit";
import { myMarks } from "../state/drafts";
import type { DepotLine } from "./Harbour";
import type { Car, Tool } from "../generated";

/** What the guide remembers between visits: put away, and what it saw happen. */
interface Kept {
  away?: boolean;
  gift?: boolean;
  fetched?: boolean;
  settled?: boolean;
}
const KEY = "sprawl.opening";
/** Is the guide up: the card above it keeps clear of it. */
const [up, setUp] = createSignal(false);
export { up as guideUp };
const kept = (): Kept => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Kept;
  } catch {
    return {};
  }
};
const keep = (k: Kept) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    // A private window keeps nothing; the guide still works for the visit.
  }
};

/** How often the guide asks the harbour about its depots, while it waits on them. */
const ASK_MS = 2000;

/**
 * The opening, five beats (docs/game.md §The opening), in a pane of glass
 * in the corner: the harbour, the depot, the street between, the starter
 * pack fetched by the lorry, and the first houses and their people. Each
 * ticks itself off as the town shows it done, and the beat at hand says
 * what to do with a button that does it. Never in the way: put away with
 * a tap, and gone for good once the town is open.
 */
export default function Guide() {
  const { send } = useGame();
  const [k, setK] = createSignal<Kept>(kept());
  const note = (more: Kept) => {
    const next = { ...k(), ...more };
    if (JSON.stringify(next) === JSON.stringify(k())) return;
    setK(next);
    keep(next);
  };

  const harbour = () => sea.sailings[0]?.harbour ?? null;
  // The harbour's card lists the depots and whether a street joins them.
  const [depots, setDepots] = createSignal<{ id: number; joined: boolean; stocked: boolean }[]>([], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  createEffect(() => {
    const h = harbour();
    if (h === null || k().away) return;
    let live = true;
    const ask = async () => {
      const c = await (await fetch(`/inspect/${h}`)).json();
      if (live) setDepots(((c.depots ?? []) as DepotLine[]).map((d) => ({ id: d.depot.id, joined: d.joined, stocked: Object.values(d.stocks).some((v) => (v ?? 0) > 0) })));
    };
    void ask();
    const timer = setInterval(ask, ASK_MS);
    onCleanup(() => {
      live = false;
      clearInterval(timer);
    });
  });

  const gift = () => sea.shipments.filter((s) => s.order === 0);
  createEffect(() => {
    // A new world: what was seen of the last one is forgotten.
    if (sea.sailings.length === 0 && sea.shipments.length === 0 && (k().gift || k().fetched || k().settled)) note({ gift: false, fetched: false, settled: false });
    if (gift().length > 0) note({ gift: true });
    const lorry = (id: number | null) => {
      const o = id === null ? undefined : getEntity(id)?.object;
      return o?.kind === "Car" && (o.data as Car).role === "Truck";
    };
    // Fetched: a box of it on the lorry, or something on a depot's shelf.
    if (gift().some((s) => s.leg === "Yard" || (s.leg === "Hauled" && lorry(s.carrier))) || depots().some((d) => d.stocked)) note({ fetched: true });
    if (settled()) note({ settled: true });
  });

  const depot = () => depots()[0] ?? null;
  const parked = () => gift().filter((s) => s.leg === "Parked");
  const next = () => gift().find((s) => s.eta !== null);
  const fetch1 = () => {
    const d = depot();
    if (!d) return;
    send({ type: "Send", data: { depot: d.id } });
    // Ride with the depot's lorry to the park, and home with the box.
    let lorry: number | null = null;
    eachEntity((e) => {
      if (e.object.kind === "Car" && e.object.data.role === "Truck" && e.object.data.owner === d.id) lorry = e.id;
    });
    const box = parked()[0];
    if (box) track(box.trailer, lorry);
  };
  const take = (t: Tool) => () => setTool(t);
  /** Said under a beat while something of it is drawn and not built. */
  const drafted = () => (
    <Show when={myMarks().length > 0}>
      <p>
        Drawn in blue, it is only a draft: <b>Build</b>, by the toolbar, or Enter, makes it real.
      </p>
    </Show>
  );

  const steps = (): { title: string; done: boolean; body: () => JSX.Element }[] => [
    {
      title: "Build a harbour on the coast",
      done: harbour() !== null,
      body: () => (
        <>
          <p>Its back to the sea, open water straight out behind it: the ferry berths there. Built, it stands at once.</p>
          <Btn onClick={take({ Building: "Harbour" })} color="#2B6CA3">Take the harbour</Btn>
          {drafted()}
        </>
      ),
    },
    {
      title: "Build a depot",
      done: depots().length > 0,
      body: () => (
        <>
          <p>Where the town keeps what lands. Its lorry fetches boxes; its vans take timber and stone to the sites, and roads are laid on its stone.</p>
          <Btn onClick={take({ Building: "Depot" })} color="#A0714A">Take the depot</Btn>
          {drafted()}
        </>
      ),
    },
    {
      title: "Join them with a street",
      done: depots().some((d) => d.joined),
      body: () => (
        <>
          <p>From the depot's yard to the harbour's park. A street that reaches nothing is drawn red.</p>
          <p>A street is laid on stone, a unit a tile, off the depot's shelf. Till the starter pack's stone is in, the world sends it express, about a coin a tile.</p>
          <Btn onClick={take("Street")}>Take the street</Btn>
          {drafted()}
        </>
      ),
    },
    {
      title: "Fetch the starter pack",
      done: !!k().fetched,
      body: () => (
        <Show
          when={parked().length > 0}
          fallback={
            <p>
              Timber, stone, crates and fuel, the world's gift, are on the first ferry
              <Show when={next()}>{(s) => <>: in at {clockAt(s().eta!)}, <b class="tabular-nums">{until(s().eta!)}</b> from now</>}</Show>.
            </p>
          }
        >
          <p>{parked().length} boxes are in the trailer park. Tap the depot's lorry to fetch them, and ride along.</p>
          <Btn big onClick={fetch1} color="#A0714A" disabled={!depot()}>Send the lorry</Btn>
        </Show>
      ),
    },
    {
      title: "Build houses",
      done: !!k().settled,
      body: () => <>
        <p>Draw a row of them, and Build: each is a site till a van brings its four timber, and the bill says if the depot has it. Then the next ferry brings their people.</p>
        <p>The rest of the pack: tap the lorry again, or give it standing orders on the depot's card.</p>
        <Btn onClick={take({ Building: "House" })} color="#E8566F">Take a house</Btn>
        {drafted()}
      </>,
    },
  ];
  const at = () => steps().findIndex((s) => !s.done);
  createEffect(() => setUp(!k().away));
  /** With a card open, only the beat at hand: the card has the room. */
  const brief = () => selected() !== null;

  return (
    <Show when={!k().away}>
      <div data-glass="guide" class="ink fixed bottom-7 left-6 z-30 w-[300px] rounded-[22px] px-4 pt-3 pb-3.5 text-sm select-none">
        <div class="flex items-baseline gap-2">
          <span class="serif text-[19px]">{at() < 0 ? "Your town is open" : "The opening"}</span>
          <span class="soft text-xs tabular-nums">{at() < 0 ? "" : `${at()} of 5`}</span>
          <span class="flex-1" />
          <button class="soft press px-1 text-lg leading-none cursor-pointer" onClick={() => note({ away: true })} title="Put the guide away">×</button>
        </div>
        <ol class="mt-1.5">
          <Index each={steps()}>
            {(s, i) => (
              <li classList={{ "py-1": !brief() || i === at() }}>
                <div class="flex items-center gap-2" classList={{ "opacity-45": i > at() && at() >= 0, hidden: brief() && i !== at() }}>
                  <span
                    class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors duration-500"
                    style={s().done ? { background: "#57A773", color: "white" } : i === at() ? { background: "rgb(var(--ink))", color: "rgb(var(--glass))" } : { border: "1.5px solid rgb(var(--ink) / 0.3)" }}
                  >
                    <Show when={s().done} fallback={i + 1}>
                      <svg class="tick" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                    </Show>
                  </span>
                  <span class="font-semibold" classList={{ "line-through decoration-1 opacity-60": s().done }}>{s().title}</span>
                </div>
                <Show when={i === at() && !brief()}>
                  <div class="appear soft ml-7 mt-1 flex flex-col items-start gap-2 text-[12.5px] leading-snug [&_p]:m-0">{s().body()}</div>
                </Show>
              </li>
            )}
          </Index>
        </ol>
        <Show when={at() < 0}>
          <p class="soft m-0 mt-1 text-[12.5px] leading-snug">Ships come here, things are kept here, roads move them. The rest is yours.</p>
        </Show>
      </div>
    </Show>
  );
}
