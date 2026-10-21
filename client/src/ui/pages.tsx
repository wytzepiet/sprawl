/** @jsxImportSource ~ui */
import { createEffect, createMemo, createSignal, For, onCleanup, untrack, type Accessor } from "solid-js";
import { follow, type Feel } from "../engine/spring";
import { Line, Press } from "./kit";
import type { JSX } from "~ui/jsx-runtime";

/**
 * Pages: whatever opens on its own, a building's page, a good's, slides
 * up from the foot of the screen as a sheet of its own over the dock.
 * What it opened from tucks behind it, a little smaller, blank, its top
 * standing out over the new sheet's, as the notifications stack. Back,
 * a drag down or a press on the town takes the front one away again.
 */
export interface Page {
  /** The same page pushed again comes to the front, not twice. */
  key: string;
  view: () => JSX.Element;
  /** How much more its glass blurs the town (`frost`). */
  frost?: number;
}

const [pages, setPages] = createSignal<Page[]>([]);
export { pages };
export const push = (p: Page) => setPages((l) => [...l.filter((x) => x.key !== p.key), p]);
export const pop = () => setPages((l) => l.slice(0, -1));
export const clear = () => setPages([]);

/** How far each sheet behind stands out over the one in front, how many
 *  show, and how much smaller each is. */
export const PEEK = 10;
const BEHIND = 2;
const SHRINK = 0.04;
/** How a page slides in and settles: a little past where it stops. */
const SLIDE: Feel = { stiff: 305, ratio: 0.7 };
/** How long a page takes to go. */
const LEAVE_MS = 380;

/** Where a sheet `depth` behind the front one sits, the front `front`
 *  tall: its height and scale, from the foot, so its top stands out. */
export function behind(front: number, depth: number) {
  const d = Math.min(depth, BEHIND);
  const s = 1 - SHRINK * d;
  return { h: (front + d * PEEK) / s, s, ink: depth === 0 ? 1 : 0 };
}

const [front, setFront] = createSignal(0);
/** The front page's height, for what lies behind it. */
export { front };

interface Shown {
  page: Page;
  gone: Accessor<boolean>;
  go: (g: boolean) => void;
}

/** A page's head: the way back, and what the page is. */
export function PageHead(props: { children: JSX.Element }) {
  return (
    <box dir="row" align="center" gap={10} pad={{ left: 8, right: 16, top: 12, bottom: 10 }}>
      <Press w={36} h={36} round={18} align="center" justify="center" onTap={pop}>
        <Line d="M15 5l-7 7 7 7" size={20} width={2.6} />
      </Press>
      {props.children}
    </box>
  );
}

/** The pages, front last, over the dock: `bottom` from the screen's
 *  foot, `width` wide, `room` the most a page may stand. */
export function Pages(props: { bottom: number; width: number; room: number }) {
  const [shown, setShown] = createSignal<Shown[]>([]);
  // The pages as pushed; one taken away stays until it has slid out.
  createEffect(() => {
    const now = pages();
    const old = untrack(shown);
    const next = now.map((p) => {
      const s = old.find((x) => x.page.key === p.key);
      if (s) return (s.go(false), s);
      const [gone, go] = createSignal(false);
      return { page: p, gone, go };
    });
    for (const s of old) {
      if (now.some((p) => p.key === s.page.key)) continue;
      if (!s.gone()) {
        s.go(true);
        setTimeout(() => s.gone() && setShown((l) => l.filter((x) => x !== s)), LEAVE_MS);
      }
      next.push(s);
    }
    setShown(next);
  });
  const live = createMemo(() => shown().filter((s) => !s.gone()));

  return (
    <box at={{ left: 0, right: 0, bottom: props.bottom }} align="center">
      <box w={props.width} h={1}>
        <For each={shown()}>
          {(s) => {
            const depth = createMemo<number>((was) => (s.gone() ? was : live().length - 1 - live().indexOf(s)), 0);
            const [own, setOwn] = createSignal(0);
            const [scroll, setScroll] = createSignal(0);
            const [pull, setPull] = createSignal(0);
            const fits = () => Math.min(own(), props.room);
            createEffect(() => depth() === 0 && !s.gone() && setFront(fits()));
            const [born, setBorn] = createSignal(false);
            const frame = requestAnimationFrame(() => setBorn(true));
            onCleanup(() => cancelAnimationFrame(frame));
            const at = () => (depth() === 0 ? { h: fits(), s: 1, ink: 1 } : behind(front(), depth()));
            const [h] = follow(() => at().h, { feel: SLIDE });
            const [sc] = follow(() => at().s, { rest: 0.001 });
            const [ink] = follow(() => at().ink, { rest: 0.001 });
            // In from below the screen, and out the same way.
            const [y] = follow(() => (born() && !s.gone() ? pull() : fits() + props.bottom + 40), { feel: SLIDE });
            const roll = (by: number) => setScroll(Math.max(0, Math.min(own() - props.room, scroll() + by)));
            /** A finger dragging it down from its top takes it away, past a
             *  little way; short of that it springs back. Else it scrolls. */
            const drag = (by: number, held?: boolean) => {
              if (held === undefined || (pull() === 0 && (by > 0 || scroll() > 0))) return roll(by);
              if (held) return setPull(Math.max(0, pull() - by));
              if (pull() > 60) pop();
              setPull(0);
            };
            return (
              <glass layer={`page:${s.page.key}`} round={30} at={{ left: 0, bottom: 0 }} w={props.width} h={Math.max(1, h())} y={y()} scale={sc()} origin={[0.5, 1]} frost={s.page.frost} clip onScroll={drag}>
                <box w={props.width} y={-scroll()} opacity={Math.max(0, Math.min(1, ink()))} onSize={(_, hh) => setOwn(hh)}>
                  <box at={{ left: props.width / 2 - 18, top: 6 }} w={36} h={5} round={2.5} fill="ink/0.18" />
                  {untrack(() => s.page.view())}
                </box>
              </glass>
            );
          }}
        </For>
      </box>
    </box>
  );
}
