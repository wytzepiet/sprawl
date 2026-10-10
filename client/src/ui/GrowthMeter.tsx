import { createEffect, createSignal, For, on } from "solid-js";
import { useGame } from "../state/gameObjects";
import { setBoardOpen } from "./Board";

/** The level's ring, in its own 56-unit box. */
const R = 24;
const CIRCUMFERENCE = 2 * Math.PI * R;
/** How long a lump takes to drip up out of the purse (`app.css` `.drip`). */
const DRIP_MS = 1600;

/**
 * The city's two dials, run together into one shape in the top right
 * corner: the level, a ring closing on the next, and the purse.
 *
 * The level is the town's GDP to date: the value it adds, landing as
 * each meal is served, each tank filled, each crop cut and each shift at
 * a desk worked. The purse is the town's coins, stepped at the border: a harvest sold to
 * the world, a lorry of crates bought from it, a placement; a tap opens
 * the town's books. The coins are on the map first, so what comes into
 * the purse drips up out of it as it lands: an event you could have
 * watched, never a rate.
 */
export default function GrowthMeter() {
  const { growth } = useGame();
  const treasury = () => growth().treasury;
  /** Days the treasury covers at today's imports; nothing crosses the door at zero. */
  const cover = () => (growth().imports > 0 ? treasury() / growth().imports : Infinity);
  const low = () => cover() < 3;
  const fill = () => (growth().needed > 0 ? Math.min(1, Math.max(0, growth().toward / growth().needed)) : 0);

  const [drips, setDrips] = createSignal<{ id: number; n: number }[]>([]);
  let next = 0;
  createEffect(on(treasury, (now, before) => {
    if (before === undefined || now - before < 1) return;
    const drip = { id: next++, n: Math.floor(now - before) };
    setDrips((d) => [...d, drip]);
    setTimeout(() => setDrips((d) => d.filter((x) => x !== drip)), DRIP_MS);
  }));

  return (
    <div class="fixed top-6 right-6 z-30 h-[120px] w-[260px] select-none">
      {/* The glass, one shape, the drips running out of it (`engine/glass.ts`). */}
      <div data-glass="meter" class="absolute right-0 top-0 h-[52px] w-[190px] rounded-full pointer-events-none" />
      <div data-glass="meter" class="absolute right-[168px] top-[-2px] h-14 w-14 rounded-full pointer-events-none" />
      <For each={drips()}>
        {() => <div data-glass="meter" data-dye="#57A773" class="drip absolute right-[70px] top-3 h-7 w-[38px] rounded-[14px] pointer-events-none" />}
      </For>

      <div class="ink absolute right-[168px] top-[-2px] grid h-14 w-14 place-items-center rounded-full" title={`Level ${growth().level}`}>
        <svg class="absolute inset-0 -rotate-90" viewBox="0 0 56 56" aria-hidden="true">
          <circle cx="28" cy="28" r={R} fill="none" stroke="rgb(var(--ink) / 0.12)" stroke-width="3" />
          <circle
            cx="28" cy="28" r={R} fill="none" stroke="#7B77E0" stroke-width="3" stroke-linecap="round"
            stroke-dasharray={`${CIRCUMFERENCE}`} stroke-dashoffset={`${CIRCUMFERENCE * (1 - fill())}`}
            class="transition-[stroke-dashoffset] duration-500 ease-out"
          />
        </svg>
        <span class="serif text-[21px]">{growth().level}</span>
      </div>
      <button onClick={() => setBoardOpen((o) => !o)} class="ink absolute right-0 top-0 flex h-[52px] w-[166px] items-baseline justify-end gap-1.5 pr-5 pt-[9px] cursor-pointer" title="The town's books">
        <span class="serif text-[28px] font-light tabular-nums" classList={{ "!text-red-500": low() }}>{Math.floor(treasury()).toLocaleString()}</span>
        <span class="soft text-xs font-semibold">coins</span>
      </button>
      <For each={drips()}>
        {(d) => <span class="drip pointer-events-none absolute right-[70px] top-3 grid h-7 w-[38px] place-items-center text-xs font-bold text-white">+{d.n}</span>}
      </For>
      {/* What the day has done, beneath. */}
      <div class="soft serif italic absolute right-5 top-[58px] text-[13px] whitespace-nowrap">
        {low() && Number.isFinite(cover()) ? `${cover().toFixed(1)} days of imports` : `${growth().income >= 0 ? "+" : "−"}${Math.abs(Math.floor(growth().income))} today`} · GDP {Math.floor(growth().gdp)}
      </div>
    </div>
  );
}
