import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { useGame, pinned } from "../state/gameObjects";
import { simNow } from "../network/clock";
import { BuildingIcon } from "./buildingIcons";
import { PIN_COLORS } from "./pinLook";
import type { BuildingKind } from "../generated";

/** Ring geometry, in the dial's own 60-unit box. */
const R = 25;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The city's two dials, one in each bottom corner.
 *
 * Both are fed by the same thing — the city's buildings serving people — so
 * they fill while the city works. Each update is a snapshot and a rate, and
 * the dials run forward from it at that rate, so they climb as the work is
 * done rather than stepping when a shift ends. A city that has seized up
 * stops earning, and the dials say so before anything else does.
 *
 * Each is a ring around the thing it is earning: the city's level on the left,
 * the building it is saving toward on the right. Nothing is labelled — a ring
 * closing around a picture of a shop needs no caption — and putting them in
 * opposite corners keeps the middle of the screen, which is the game, clear.
 */
export default function GrowthMeter() {
  const { growth } = useGame();
  // Points earned since the sample was taken. Re-read a few times a second;
  // the ring's own transition smooths the rest.
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => setTick((t) => t + 1), 250);
  onCleanup(() => clearInterval(timer));
  const since = () => {
    tick();
    return growth().rate * Math.max(0, simNow() - growth().at);
  };
  const xp = () => growth().xp + since();
  const offerXp = () => Math.min(growth().offer_xp + since(), growth().offer_needed);
  const waiting = () =>
    pinned()
      .filter((e) => e.object.kind === "Proposal")
      .map((e) => ({ id: e.id, kind: (e.object.data as { kind: BuildingKind }).kind }));
  const nextColor = () => {
    const kind = growth().next;
    return kind ? PIN_COLORS[kind] : "#9CA3AF";
  };

  return (
    <>
      <span class="fixed bottom-4 left-4 select-none pointer-events-none">
        <Dial color="#5B57C8" now={xp()} max={growth().xp_needed}>
          <span class="grid h-full w-full place-items-center rounded-full bg-stone-800 leading-none text-white">
            <span class="text-[7px] font-bold uppercase tracking-widest text-white/50">Lvl</span>
            <span class="text-[15px] font-bold tabular-nums">{growth().level}</span>
          </span>
        </Dial>
      </span>

      <span class="fixed bottom-4 right-4 flex select-none flex-col items-center gap-1.5 pointer-events-none">
        {/* Offered and still owed an answer: stacked over the dial they came
            from, since they are the same errand one step further on. */}
        <Show when={waiting().length > 0}>
          <span class="flex items-center gap-1 rounded-full border border-black/[0.06] bg-white/70 px-1.5 py-1 backdrop-blur-xl shadow-[0_2px_10px_rgba(0,0,0,0.08)]">
            <For each={waiting()}>
              {(p) => (
                <span
                  class="grid h-4 w-4 place-items-center rounded-full ring-[1.5px] ring-sky-400"
                  style={{ "background-color": PIN_COLORS[p.kind] }}
                >
                  <BuildingIcon kind={p.kind} class="h-2.5 w-2.5 text-white" />
                </span>
              )}
            </For>
          </span>
        </Show>

        <Dial color={nextColor()} now={offerXp()} max={growth().offer_needed}>
          <Show
            when={growth().next}
            fallback={<span class="block h-full w-full rounded-full bg-stone-300" />}
          >
            {(kind) => (
              <span
                class="grid h-full w-full place-items-center rounded-full"
                style={{ "background-color": PIN_COLORS[kind() as BuildingKind] }}
              >
                <BuildingIcon kind={kind() as BuildingKind} class="h-6 w-6 text-white" />
              </span>
            )}
          </Show>
        </Dial>
      </span>
    </>
  );
}

/**
 * A ring closing around whatever it is earning, with the count beneath.
 *
 * The ring starts at twelve o'clock and runs clockwise, which is the direction
 * everything that measures a wait runs in. Its track is drawn in full behind
 * it, so an empty dial still reads as a dial rather than as a missing one.
 */
function Dial(props: { color: string; now: number; max: number; children: JSX.Element }) {
  const fill = () => (props.max > 0 ? Math.min(1, Math.max(0, props.now / props.max)) : 0);
  return (
    <span class="flex flex-col items-center gap-1">
      <span class="relative grid h-14 w-14 place-items-center drop-shadow-[0_2px_6px_rgba(0,0,0,0.18)]">
        <svg class="absolute inset-0 -rotate-90" viewBox="0 0 60 60" aria-hidden="true">
          <circle cx="30" cy="30" r={`${R}`} fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="6" />
          <circle
            cx="30"
            cy="30"
            r={`${R}`}
            fill="none"
            stroke={props.color}
            stroke-width="6"
            stroke-linecap="round"
            stroke-dasharray={`${CIRCUMFERENCE}`}
            stroke-dashoffset={`${CIRCUMFERENCE * (1 - fill())}`}
            class="transition-[stroke-dashoffset] duration-500 ease-out"
          />
        </svg>
        <span class="relative h-9 w-9">{props.children}</span>
      </span>
      <span class="rounded-full bg-white/70 px-1.5 py-0.5 text-[9px] font-bold leading-none tabular-nums text-stone-600 backdrop-blur-xl">
        {Math.floor(props.now).toLocaleString()} / {Math.round(props.max).toLocaleString()}
      </span>
    </span>
  );
}
