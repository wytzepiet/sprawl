import { createSignal } from "solid-js";
import type { Clock } from "../generated";

/** How hard each sample pulls the local estimate toward the server's. */
const SMOOTH = 0.2;
/** Wall-clock milliseconds the estimate may run ahead of the last sample. */
const MAX_LEAD_MS = 150;

let baseSim = 0;
let baseLocal = 0;
// Two copies on purpose: the plain one is read per car per frame by simNow,
// the signal exists so the UI can react to a speed change.
let speed = 1;
const [speedSignal, setSpeedSignal] = createSignal(1);
let dayMs = 120_000;
let synced = false;

/**
 * Sim time now, extrapolated from the last sample at the server's speed.
 *
 * Sim time and wall time only run at the same rate while speed is 1, so this
 * cannot be a fixed offset from Date.now() — at 10x the two diverge as fast as
 * they advance.
 */
export function simNow(): number {
  if (!synced) return baseSim;
  return baseSim + (Date.now() - baseLocal) * speed;
}

/** Length of a full day/night cycle, in sim milliseconds. */
export function dayLengthMs(): number {
  return dayMs;
}

/** Sim steps per tick the server is running. 0 means paused. Reactive. */
export const simSpeed = speedSignal;

/** Position in the current day, 0 at midnight, wrapping at 1. */
export function timeOfDay(): number {
  return (simNow() % dayMs) / dayMs;
}

/**
 * Fold a server timestamp into the local estimate.
 *
 * Eased rather than assigned: samples land ~20 times a second, and snapping to
 * each one makes every extrapolated car twitch. A speed change is the exception
 * — the old estimate was built at the old rate, so there is nothing to ease
 * from and it snaps instead.
 *
 * Easing alone settles into a steady lead, because every sample is already a
 * network hop old and only a fraction of that gap is closed each time. The lead
 * is harmless and even helps motion look smooth, but it scales with speed, so
 * it is capped in wall-clock terms — otherwise 20x drifts hours ahead and
 * lurches back the moment the speed changes.
 */
export function syncClock(sample: number, nextSpeed = speed, nextDayMs = dayMs): void {
  const predicted = simNow();
  const jumped = !synced || nextSpeed !== speed;
  speed = nextSpeed;
  if (jumped) setSpeedSignal(nextSpeed);
  dayMs = nextDayMs;
  const eased = predicted + (sample - predicted) * SMOOTH;
  baseSim = jumped ? sample : Math.min(eased, sample + MAX_LEAD_MS * speed);
  baseLocal = Date.now();
  synced = true;
}

export function syncFromClock(c: Clock): void {
  syncClock(c.now, c.speed, c.day_ms);
}
