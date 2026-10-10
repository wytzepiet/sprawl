import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { BuildingKind, Need } from "../generated";
import { BLUEPRINTS } from "../blueprints";

/** One day of the town's books: GDP, per kind of building it was added
 *  at, and coins across the border, per good. */
interface TownPage {
  gdp: Partial<Record<BuildingKind, number>>;
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

const sum = (m: object) => (Object.values(m) as number[]).reduce((a, b) => a + b, 0);
const mean = (pages: TownPage[], f: (p: TownPage) => number) => (pages.length ? pages.reduce((a, p) => a + f(p), 0) / pages.length : 0);
const num = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/**
 * The town's page: the two dials read back by building and by good. The
 * GDP added today, per kind of building, adds up to the level's step; the coins
 * that crossed the border, per good, in and out, and what the mayor
 * built, add up to the treasury's. Beside each line, the same a day over
 * the season. docs/trade.md.
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
  const keys = <K extends string>(t: Town, of: (p: TownPage) => Partial<Record<K, number>>) =>
    [...new Set([t.today, ...t.season].flatMap((p) => Object.keys(of(p))))] as K[];

  return (
    <Show when={open() && town()}>
      {(t) => (
        <div class="fixed top-28 right-6 z-40 w-72 max-h-[calc(100vh-8rem)] overflow-y-auto rounded-xl bg-white/80 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-stone-800 text-sm select-none">
          <div class="flex items-center gap-2 px-3 pt-3 pb-2">
            <div class="min-w-0 flex-1">
              <div class="font-semibold">The town</div>
              <div class="text-xs text-stone-500">{t().season.length} {t().season.length === 1 ? "day" : "days"} of books</div>
            </div>
            <button class="text-stone-400 hover:text-stone-800 px-1 cursor-pointer" onClick={() => setOpen(false)} title="Close (Esc)">
              ×
            </button>
          </div>

          <Section title="GDP" today={sum(t().today.gdp)} season={mean(t().season, (p) => sum(p.gdp))}>
            <For each={keys(t(), (p) => p.gdp)}>
              {(kind) => <Line label={BLUEPRINTS[kind].label} today={t().today.gdp[kind] ?? 0} season={mean(t().season, (p) => p.gdp[kind] ?? 0)} />}
            </For>
          </Section>

          <Section title="Coins in at the border" today={sum(t().today.sold)} season={mean(t().season, (p) => sum(p.sold))}>
            <For each={keys<Need>(t(), (p) => p.sold)}>
              {(need) => <Line label={need} today={t().today.sold[need] ?? 0} season={mean(t().season, (p) => p.sold[need] ?? 0)} />}
            </For>
          </Section>

          <Section title="Coins out at the border" today={-sum(t().today.bought) - t().today.built} season={-mean(t().season, (p) => sum(p.bought) + p.built)}>
            <For each={keys<Need>(t(), (p) => p.bought)}>
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

function Line(props: { label: string; today: number; season?: number; bold?: boolean }) {
  return (
    <div class="flex justify-between gap-2 py-0.5 tabular-nums" classList={{ "font-semibold": props.bold }}>
      <span class="text-stone-500">{props.label}</span>
      <span class="text-right">
        <span class="inline-block w-12 text-right" classList={{ "text-red-600": props.today < 0 }}>{num(props.today)}</span>
        <span class="inline-block w-12 text-right text-stone-500">{props.season === undefined ? "" : num(props.season)}</span>
      </span>
    </div>
  );
}
