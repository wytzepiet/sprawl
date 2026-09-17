import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Need } from "../generated";

/** One day of the town's books, in hours of the edge's wage. */
interface TownPage {
  served: Partial<Record<Need, number>>;
  /** The visits behind the served line: lumps paid in town, per need. */
  visits: Partial<Record<Need, number>>;
  sold: Partial<Record<Need, number>>;
  bought: Partial<Record<Need, number>>;
  built: number;
}

interface Town {
  gdp: number;
  treasury: number;
  today: TownPage;
  season: TownPage[];
}

const [open, setOpen] = createSignal(false);
export { open as boardOpen, setOpen as setBoardOpen };

/** How often the open board asks again. */
const REFRESH_MS = 1000;

const sum = (m: Partial<Record<Need, number>>) => Object.values(m).reduce((a, b) => a + b, 0);
const mean = (pages: TownPage[], f: (p: TownPage) => number) => (pages.length ? pages.reduce((a, p) => a + f(p), 0) / pages.length : 0);
const hours = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/**
 * The town's page: the two dials read back by need and by good. What
 * was served today at the world's prices, per need, adds up to the GDP
 * dial; what crossed the door, per good, in and out, and what the mayor
 * built, adds up to the treasury's step. Beside each line, the same a
 * day over the season. docs/economy.md §10.
 */
export default function Board() {
  const [town, setTown] = createSignal<Town | null>(null);

  createEffect(on(open, (o) => {
    setTown(null);
    if (!o) return;
    let live = true;
    const fetchTown = async () => {
      const r = await fetch("/town");
      if (!live) return;
      setTown((await r.json()) as Town);
    };
    fetchTown();
    const timer = setInterval(fetchTown, REFRESH_MS);
    onCleanup(() => {
      live = false;
      clearInterval(timer);
    });
  }));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  /** Every need with a line on any page, in the order the first page names them. */
  const needs = (t: Town, of: (p: TownPage) => Partial<Record<Need, number>>) =>
    [...new Set([t.today, ...t.season].flatMap((p) => Object.keys(of(p))))] as Need[];

  return (
    <Show when={open() && town()}>
      {(t) => (
        <div class="fixed top-4 right-4 z-40 w-72 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-stone-800 text-sm select-none">
          <div class="flex items-center gap-2 px-3 pt-3 pb-2">
            <div class="min-w-0 flex-1">
              <div class="font-semibold">The town</div>
              <div class="text-xs text-stone-500">{t().season.length} {t().season.length === 1 ? "day" : "days"} of books, in hours</div>
            </div>
            <button class="text-stone-400 hover:text-stone-800 px-1 cursor-pointer" onClick={() => setOpen(false)} title="Close (Esc)">
              ×
            </button>
          </div>

          <Section title="Served" today={sum(t().today.served)} season={mean(t().season, (p) => sum(p.served))}>
            <For each={needs(t(), (p) => p.served)}>
              {(need) => (
                <>
                  <Line label={need} today={t().today.served[need] ?? 0} season={mean(t().season, (p) => p.served[need] ?? 0)} />
                  <Show when={(t().today.visits[need] ?? 0) > 0 || t().season.some((p) => (p.visits[need] ?? 0) > 0)}>
                    <Count label="visits" today={t().today.visits[need] ?? 0} season={mean(t().season, (p) => p.visits[need] ?? 0)} />
                  </Show>
                </>
              )}
            </For>
          </Section>

          <Section title="In at the door" today={sum(t().today.sold)} season={mean(t().season, (p) => sum(p.sold))}>
            <For each={needs(t(), (p) => p.sold)}>
              {(need) => <Line label={need} today={t().today.sold[need] ?? 0} season={mean(t().season, (p) => p.sold[need] ?? 0)} />}
            </For>
          </Section>

          <Section title="Out at the door" today={-sum(t().today.bought) - t().today.built} season={-mean(t().season, (p) => sum(p.bought) + p.built)}>
            <For each={needs(t(), (p) => p.bought)}>
              {(need) => <Line label={need} today={-(t().today.bought[need] ?? 0)} season={-mean(t().season, (p) => p.bought[need] ?? 0)} />}
            </For>
            <Show when={t().today.built > 0 || t().season.some((p) => p.built > 0)}>
              <Line label="Built" today={-t().today.built} season={-mean(t().season, (p) => p.built)} />
            </Show>
          </Section>

          <Section
            title="Treasury"
            today={sum(t().today.sold) - sum(t().today.bought) - t().today.built}
            season={mean(t().season, (p) => sum(p.sold) - sum(p.bought) - p.built)}
          >
            <Line label="Holds" today={t().treasury} />
          </Section>
        </div>
      )}
    </Show>
  );
}

/** A heading with its total: today's, and a day's over the season. */
function Section(props: { title: string; today: number; season: number; children: JSX.Element }) {
  return (
    <div class="px-3 py-2 border-t border-black/[0.05]">
      <div class="flex justify-between gap-2 mb-1">
        <span class="text-[10px] font-bold uppercase tracking-widest text-stone-400">{props.title}</span>
        <span class="text-[10px] font-bold uppercase tracking-widest text-stone-400 tabular-nums">
          <span class="inline-block w-12 text-right">today</span>
          <span class="inline-block w-12 text-right">/ day</span>
        </span>
      </div>
      <Line label="" today={props.today} season={props.season} bold />
      {props.children}
    </div>
  );
}

/** The count under a line: how many times, today and a day over the season. */
function Count(props: { label: string; today: number; season: number }) {
  return (
    <div class="flex justify-between gap-2 -mt-0.5 pb-0.5 text-[11px] text-stone-400 tabular-nums">
      <span class="pl-3">{props.label}</span>
      <span class="text-right">
        <span class="inline-block w-12 text-right">{props.today}</span>
        <span class="inline-block w-12 text-right">{props.season.toFixed(props.season >= 10 ? 0 : 1)}</span>
      </span>
    </div>
  );
}

function Line(props: { label: string; today: number; season?: number; bold?: boolean }) {
  return (
    <div class="flex justify-between gap-2 py-0.5 tabular-nums" classList={{ "font-semibold": props.bold }}>
      <span class="text-stone-500">{props.label}</span>
      <span class="text-right">
        <span class="inline-block w-12 text-right" classList={{ "text-red-600": props.today < 0 }}>{hours(props.today)}</span>
        <span class="inline-block w-12 text-right text-stone-500">{props.season === undefined ? "" : hours(props.season)}</span>
      </span>
    </div>
  );
}
