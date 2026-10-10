import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { select } from "../state/selection";
import { GoodIcon, GOODS } from "../blueprints";
import type { Good } from "../generated";

/**
 * What the cards and panels are made of, on the glass: a section under a
 * small heading, a row of label and value, a gauge, a line that goes to
 * something on the map, a button, a stepper. Ink is the glass's own
 * (`ink`, `soft`), so it reads black on the day's glass and white on the
 * night's.
 */

/** A line that points at something else on the map. */
export interface Link {
  id: number;
  label: string;
  kind: "resident" | "building" | "car" | "gone";
}

export function Section(props: { title: string; children: JSX.Element; aside?: JSX.Element }) {
  return (
    <div class="px-4 py-2.5" style={{ "border-top": "1px solid rgb(var(--ink) / 0.08)" }}>
      <div class="mb-1.5 flex items-baseline justify-between gap-2">
        <span class="soft text-[10px] font-bold uppercase tracking-widest opacity-80">{props.title}</span>
        {props.aside}
      </div>
      {props.children}
    </div>
  );
}

export function Row(props: { label: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex justify-between gap-2 py-0.5">
      <span class="soft">{props.label}</span>
      <span class="truncate text-right">{props.children}</span>
    </div>
  );
}

/** A gauge: how full, in a colour. */
export function Bar(props: { value: number; color?: string; class?: string }) {
  return (
    <span class={`inline-block h-1.5 overflow-hidden rounded-full align-middle ${props.class ?? "w-20"}`} style={{ background: "rgb(var(--ink) / 0.1)" }}>
      <span
        class="block h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, props.value)) * 100)}%`, "background-color": props.color ?? "#7B77E0" }}
      />
    </span>
  );
}

/** A line you can go to. */
export function To(props: { link: Link | null | undefined; fallback?: string }) {
  return (
    <Show when={props.link} fallback={<span class="soft opacity-70">{props.fallback ?? "—"}</span>}>
      {(l) => (
        <button class="cursor-pointer text-left underline underline-offset-2" style={{ "text-decoration-color": "rgb(var(--ink) / 0.3)" }} onClick={() => select(l().id)}>
          {l().label}
        </button>
      )}
    </Show>
  );
}

/** A good's glyph on a disc of its colour. */
export function GoodDot(props: { good: Good; size?: number }) {
  const s = () => props.size ?? 22;
  return (
    <span class="grid shrink-0 place-items-center rounded-full text-white" style={{ width: `${s()}px`, height: `${s()}px`, "background-color": GOODS[props.good].color }}>
      <GoodIcon good={props.good} width={s() * 0.62} height={s() * 0.62} />
    </span>
  );
}

/**
 * A button on the glass: `big` is the one thing a card is for, solid in a
 * colour, springing under the finger; plain is a pill of ink.
 */
export function Btn(props: { onClick: () => void; children: JSX.Element; color?: string; big?: boolean; disabled?: boolean; title?: string; class?: string }) {
  return (
    <button
      onClick={() => !props.disabled && props.onClick()}
      title={props.title}
      disabled={props.disabled}
      class={`press inline-flex items-center justify-center gap-1.5 rounded-full font-semibold whitespace-nowrap ${props.big ? "h-11 px-5 text-[15px] text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]" : "h-7 px-3 text-xs"} ${props.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"} ${props.class ?? ""}`}
      style={props.big ? { "background-color": props.color ?? "#2B6CA3" } : { border: "1.5px solid rgb(var(--ink) / 0.18)", color: props.color }}
    >
      {props.children}
    </button>
  );
}

/** A number to step up and down. */
export function Stepper(props: { value: number; set: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string }) {
  const step = () => props.step ?? 1;
  const btn = "press grid h-7 w-7 place-items-center rounded-full text-base font-bold leading-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed";
  return (
    <span class="inline-flex items-center gap-1">
      <button class={btn} style={{ border: "1.5px solid rgb(var(--ink) / 0.18)" }} disabled={props.value <= props.min} onClick={() => props.set(Math.max(props.min, props.value - step()))} aria-label="Fewer">
        −
      </button>
      <span class="serif min-w-[2.2rem] text-center text-[19px] tabular-nums">{props.format ? props.format(props.value) : props.value}</span>
      <button class={btn} style={{ border: "1.5px solid rgb(var(--ink) / 0.18)" }} disabled={props.value >= props.max} onClick={() => props.set(Math.min(props.max, props.value + step()))} aria-label="More">
        +
      </button>
    </span>
  );
}

/** Coins, signed and whole: "−22", "+18". */
export const coins = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(Math.round(v)).toLocaleString()}`;
