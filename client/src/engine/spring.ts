import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";

/** Something on a spring: where it is, and how fast it is going. */
export interface Sprung { s: number; v: number }

/**
 * One step of a spring toward `to`: pulled by how far off it is, held back
 * by how fast it goes. Under-damped, it starts quick, runs a little past
 * and settles, and a new target mid-flight keeps the speed it has. The
 * hand's dots and the UI are moved by this one rule.
 */
export function step(d: Sprung, to: number, stiff: number, damp: number, dt: number) {
  d.v += (stiff * (to - d.s) - damp * d.v) * dt;
  d.s += d.v * dt;
}

/** How a spring feels: how hard it pulls, and how much of its swing it
 *  keeps (1 is none; lower runs further past and back). */
export interface Feel { stiff: number; ratio: number }
/** The UI's usual spring: quick, and past by a few percent. */
export const TIGHT: Feel = { stiff: 420, ratio: 0.62 };
/** A looser one, for what should feel poured: slower, and swinging past. */
export const LOOSE: Feel = { stiff: 290, ratio: 0.56 };
/** Close enough to stop: a tenth of a pixel, or of whatever is sprung. */
const REST = 0.1;

/**
 * A number that follows `target` on a spring, a frame at a time, and its
 * speed. Waits `delay` ms after the target moves before it goes, so a
 * shelf's rows can come one after another; asleep when at rest.
 */
export function follow(target: Accessor<number>, opts: { delay?: Accessor<number>; rest?: number; feel?: Feel } = {}): [Accessor<number>, Accessor<number>] {
  const { stiff, ratio } = opts.feel ?? TIGHT;
  const damp = 2 * Math.sqrt(stiff) * ratio;
  const d: Sprung = { s: target(), v: 0 };
  const [value, setValue] = createSignal(d.s);
  const [speed, setSpeed] = createSignal(0);
  const rest = opts.rest ?? REST;
  let to = d.s;
  let frame = 0;
  let wait = 0;
  let last = 0;

  const tick = (now: number) => {
    step(d, to, stiff, damp, Math.min(0.032, (now - last) / 1000));
    last = now;
    if (Math.abs(to - d.s) < rest && Math.abs(d.v) < rest * 10) {
      [d.s, d.v, frame] = [to, 0, 0];
    } else frame = requestAnimationFrame(tick);
    setValue(d.s);
    setSpeed(d.v);
  };
  const go = (t: number) => {
    to = t;
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  // Only a target that moves: one read again at the same place (the rows
  // are made afresh with every growth update) must not restart the wait.
  createEffect(on(createMemo(target), (t) => {
    clearTimeout(wait);
    const ms = opts.delay?.() ?? 0;
    if (ms > 0) wait = window.setTimeout(() => go(t), ms);
    else go(t);
  }, { defer: true }));
  onCleanup(() => { cancelAnimationFrame(frame); clearTimeout(wait); });
  return [value, speed];
}
