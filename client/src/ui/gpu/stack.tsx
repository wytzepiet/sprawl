/** @jsxImportSource ~ui */
import { createEffect, createMemo, createSignal, For, onCleanup, untrack, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { follow, LOOSE } from "../../engine/spring";
import type { JSX } from "~ui/jsx-runtime";

/** How far each card behind shows under the one in front, folded; how
 *  many show; and the room between cards spread out, more than the
 *  glass's melt, so each stays a card of its own. */
const PEEK = 9;
const BEHIND = 2;
const GAP = 14;
/** How long a card takes to go. */
const LEAVE_MS = 380;

interface Card<T> {
  key: string;
  item: Accessor<T>;
  set: (t: T) => void;
  gone: Accessor<boolean>;
  go: (g: boolean) => void;
}

/**
 * Cards of glass, one over another, like a phone's notifications: folded,
 * the first in front and the next two peeking out under it, smaller and
 * blank; open, a column, each its own height. Every card is a layer of
 * glass of its own, drawn front last, so the glass lies as the cards do
 * and the one in front frosts what is on those behind. A card comes in
 * from above and grows out of nothing; a card taken out slides away and
 * fades; one that changes height, or moves in the column, gets there on a
 * spring; a column too tall for its room scrolls under the wheel or a
 * finger. What is on a card is the caller's: `children` draws it, once,
 * told how deep it is; what changes on it, it reads from the item.
 */
export function Stack<T>(props: {
  each: readonly T[];
  key: (t: T) => string;
  open: boolean;
  /** The most height there is: spread taller, the column scrolls, and a
   *  card going out over an edge fades and shrinks as it goes. */
  room: number;
  /** A card to keep in sight, spread: the one opened, as it grows. */
  keep?: string | null;
  /** The glass's name: each card is a layer of it. */
  glass: string;
  round: number;
  children: (item: Accessor<T>, depth: Accessor<number>) => JSX.Element;
}) {
  const [cards, setCards] = createSignal<Card<T>[]>([]);
  const make = (key: string, t: T): Card<T> => {
    const [item, set] = createSignal(t);
    const [gone, go] = createSignal(false);
    return { key, item, set: (t) => set(() => t), gone, go };
  };
  // The cards as given, in their order; one taken out stays where it was
  // until it has gone.
  createEffect(() => {
    const keys = props.each.map(props.key);
    const old = untrack(cards);
    const byKey = new Map(old.map((c) => [c.key, c]));
    const next = props.each.map((t, i) => {
      const c = byKey.get(keys[i]);
      if (!c) return make(keys[i], t);
      c.set(t);
      c.go(false);
      return c;
    });
    old.forEach((c, i) => {
      if (keys.includes(c.key)) return;
      if (!c.gone()) {
        c.go(true);
        setTimeout(() => c.gone() && setCards((l) => l.filter((x) => x !== c)), LEAVE_MS);
      }
      next.splice(Math.min(i, next.length), 0, c);
    });
    setCards(next);
  });
  const live = createMemo(() => cards().filter((c) => !c.gone()));
  /** What is on each card, as laid out: its height. */
  const [height, setHeight] = createStore<Record<string, number>>({});
  const h = (c: Card<T> | undefined) => (c ? height[c.key] ?? 0 : 0);

  /** Where a card sits at a depth: down from the top, its height, its scale, its fade, its ink's. */
  const place = (c: Card<T>, d: number) => {
    if (props.open) {
      let y = 0;
      for (const x of live().slice(0, d)) y += h(x) + GAP;
      y -= scroll();
      const over = Math.max(0, -y, y + h(c) - props.room) / Math.max(1, h(c));
      return { y, h: h(c), s: 1 - 0.08 * Math.min(1, over), o: Math.max(0, 1 - 1.4 * over), ink: 1 };
    }
    const k = Math.min(d, BEHIND);
    return { y: k * PEEK, h: h(live()[0]), s: 1 - 0.05 * k, o: d > BEHIND ? 0 : 1, ink: d === 0 ? 1 : 0 };
  };
  const tall = () => {
    const l = live();
    if (!props.open) return l.length ? h(l[0]) + Math.min(l.length - 1, BEHIND) * PEEK : 0;
    return l.reduce((a, c) => a + h(c), 0) + Math.max(0, l.length - 1) * GAP;
  };
  const [scroll, setScroll] = createSignal(0);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - props.room, scroll() + by)));
  createEffect(() => (props.open ? roll(0) : setScroll(0)));
  createEffect(() => {
    const d = live().findIndex((c) => c.key === props.keep);
    if (!props.open || d < 0) return;
    let y = 0;
    for (const x of live().slice(0, d)) y += h(x) + GAP;
    const s = untrack(scroll);
    if (y < s) roll(y - s);
    else if (y + h(live()[d]) > s + props.room) roll(y + h(live()[d]) - s - props.room);
  });
  const [tallness] = follow(() => Math.min(tall(), props.room), { feel: LOOSE });

  return (
    <box h={tallness()} onScroll={(dy) => props.open && roll(dy)}>
      {/* The front card last, so it is drawn, and glazed, over the rest. */}
      <For each={[...cards()].reverse()}>
        {(c) => {
          const depth = createMemo<number>((was) => (c.gone() ? was : live().indexOf(c)), 0);
          const [born, setBorn] = createSignal(false);
          const frame = requestAnimationFrame(() => setBorn(true));
          onCleanup(() => cancelAnimationFrame(frame));
          onCleanup(() => setHeight(c.key, undefined!));
          const at = () => place(c, depth());
          const [y] = follow(() => (born() ? at().y : at().y - 18), { feel: LOOSE });
          const [x] = follow(() => (c.gone() ? 48 : 0));
          const [s] = follow(() => (born() && !c.gone() ? at().s : 0.9), { rest: 0.001 });
          const [o] = follow(() => (born() && !c.gone() ? at().o : 0), { rest: 0.001 });
          const [ink] = follow(() => at().ink, { rest: 0.001 });
          const [tall] = follow(() => at().h, { feel: LOOSE });
          return (
            <glass
              layer={`${props.glass}:${c.key}`}
              round={props.round}
              at={{ left: 0, right: 0, top: 0 }}
              h={Math.max(1, tall())}
              x={x()}
              y={y()}
              scale={s()}
              origin={[0.5, 1]}
              opacity={Math.max(0, Math.min(1, o()))}
              clip
            >
              <box opacity={Math.max(0, Math.min(1, ink()))} onSize={(_, hh) => height[c.key] !== hh && setHeight(c.key, hh)}>
                {untrack(() => props.children(c.item, depth))}
              </box>
            </glass>
          );
        }}
      </For>
    </box>
  );
}
