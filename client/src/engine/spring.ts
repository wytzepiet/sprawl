import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";

/** What moves next frame, and what draws where things are once they have. */
const due = new Set<(now: number) => void>();
const after = new Set<() => void>();
let frame = 0;
let poked = false;
const run = (now: number) => {
  const moving = [...due];
  const look = moving.length > 0 || poked;
  due.clear();
  poked = false;
  try {
    for (const fn of moving) fn(now);
    if (look) for (const fn of after) fn();
  } finally {
    frame = due.size || poked ? requestAnimationFrame(run) : 0;
  }
};
const wake = () => (frame ||= requestAnimationFrame(run));

/** Run `fn` on the next frame, with every spring. */
export function nextFrame(fn: (now: number) => void) {
  due.add(fn);
  wake();
}

/** Run `fn` on every frame something moved on, once the springs have
 *  moved, and on the next frame after `moved()`: what draws where they
 *  put things. Returns how to stop. */
export function everyFrame(fn: () => void) {
  after.add(fn);
  moved();
  return () => void after.delete(fn);
}

/** Something has moved other than by a spring: what is drawn every frame
 *  looks again on the next. */
export function moved() {
  poked = true;
  wake();
}

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
 * shelf's rows can come one after another; asleep when at rest. While
 * `held` (a finger on it), it is where the target is, and let go, it
 * springs on with the finger's speed.
 */
export function follow(target: Accessor<number>, opts: { delay?: Accessor<number>; rest?: number; feel?: Feel; held?: Accessor<boolean> } = {}): [Accessor<number>, Accessor<number>] {
  const { stiff, ratio } = opts.feel ?? TIGHT;
  const damp = 2 * Math.sqrt(stiff) * ratio;
  const d: Sprung = { s: target(), v: 0 };
  const [value, setValue] = createSignal(d.s);
  const [speed, setSpeed] = createSignal(0);
  const rest = opts.rest ?? REST;
  let to = d.s;
  let moving = false;
  let wait = 0;
  let last = 0;

  const tick = (now: number) => {
    step(d, to, stiff, damp, Math.min(0.032, (now - last) / 1000));
    last = now;
    if (Math.abs(to - d.s) < rest && Math.abs(d.v) < rest * 10) {
      [d.s, d.v, moving] = [to, 0, false];
    } else nextFrame(tick);
    setValue(d.s);
    setSpeed(d.v);
  };
  const hold = (t: number) => {
    const now = performance.now();
    // The finger's speed, smoothed over its last few moves.
    d.v = d.v / 2 + (t - d.s) / Math.max(0.008, (now - last) / 1000) / 2;
    [d.s, to, last, moving] = [t, t, now, false];
    due.delete(tick);
    setValue(t);
    setSpeed(d.v);
  };
  const go = (t: number) => {
    to = t;
    if (moving) return;
    moving = true;
    // A finger that stood still before it let go threw nothing.
    if (performance.now() - last > 100) d.v = 0;
    last = performance.now();
    nextFrame(tick);
  };
  // Only a target that moves: one read again at the same place (the rows
  // are made afresh with every growth update) must not restart the wait.
  createEffect(on(createMemo(target), (t) => {
    clearTimeout(wait);
    if (opts.held?.()) return hold(t);
    const ms = opts.delay?.() ?? 0;
    if (ms > 0) wait = window.setTimeout(() => go(t), ms);
    else go(t);
  }, { defer: true }));
  onCleanup(() => { due.delete(tick); clearTimeout(wait); });
  return [value, speed];
}
