import type { JSX } from "solid-js";
import { useGame } from "../state/gameObjects";
import { setTreeOpen } from "./SkillTree";

/** Ring geometry, in the dial's own 60-unit box. */
const R = 25;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The city's two dials, one in each bottom corner.
 *
 * The level on the left is the town's GDP to date: value served in town at
 * the world's prices, banked as each visit ends, with today's beneath it.
 * The treasury on the right is the town's one purse, stepped at the door:
 * a shift worked beyond the edge, a lorry in from it, a placement. Both
 * move in lumps, and the lumps are on the map first — a number floating
 * over the building — so a dial that steps is an event you could have
 * watched, never a rate.
 *
 * Each is a ring around the thing it is earning: the city's level on the left,
 * the building it is saving toward on the right. Nothing is labelled — a ring
 * closing around a picture of a shop needs no caption — and putting them in
 * opposite corners keeps the middle of the screen, which is the game, clear.
 */
export default function GrowthMeter() {
  const { growth } = useGame();
  const treasury = () => growth().treasury;
  /** Days the treasury covers at today's imports; nothing crosses the door at zero. */
  const cover = () => (growth().imports > 0 ? treasury() / growth().imports : Infinity);
  const low = () => cover() < 3;

  return (
    <>
      <span class="fixed bottom-4 left-4 select-none cursor-pointer" onClick={() => setTreeOpen(true)} title="The skill tree (L)">
        <Dial color="#5B57C8" now={growth().toward} max={growth().needed} caption={`GDP ${Math.floor(growth().gdp)} today`}>
          <span class="grid h-full w-full place-items-center rounded-full bg-stone-800 leading-none text-white">
            <span class="text-[7px] font-bold uppercase tracking-widest text-white/50">Lvl</span>
            <span class="text-[15px] font-bold tabular-nums">{growth().level}</span>
          </span>
        </Dial>
      </span>

      {/* What the town has to spend, in hours of the edge's wage, and what
          the door netted today. No ring: there is no goal but the one the
          mayor is saving for. */}
      <span class="fixed bottom-4 right-4 flex select-none flex-col items-center gap-1.5 pointer-events-none">
        <Dial color={low() ? "#D9483B" : "#57A773"} now={treasury()} max={0} caption={low() && Number.isFinite(cover()) ? `${cover().toFixed(1)} days of imports` : `${growth().income >= 0 ? "+" : ""}${Math.floor(growth().income)} today`}>
          <span class="grid h-full w-full place-items-center rounded-full bg-stone-800 leading-none text-white">
            <span class="text-[13px] font-bold tabular-nums">{Math.floor(treasury())}</span>
            <span class="text-[7px] font-bold uppercase tracking-widest text-white/50">hours</span>
          </span>
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
function Dial(props: { color: string; now: number; max: number; caption?: string; children: JSX.Element }) {
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
        {props.caption ?? `${Math.floor(props.now).toLocaleString()} / ${Math.round(props.max).toLocaleString()}`}
      </span>
    </span>
  );
}
