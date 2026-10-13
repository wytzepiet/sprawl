import { createSignal } from "solid-js";

/**
 * Each level's best efficiency, kept in this browser. Reactive, so the
 * list opens the next level the moment one is solved.
 */
const KEY = "interchange.best";

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

const [all, setAll] = createSignal(read());

export const best = (name: string): number | null => all()[name] ?? null;

/** A test passed with this efficiency: kept if it is the best yet. */
export function keep(name: string, efficiency: number) {
  if ((all()[name] ?? -1) >= efficiency) return;
  const next = { ...all(), [name]: efficiency };
  setAll(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows and full storage: the best lives as long as the tab.
  }
}

/** What the player built on each level, as the steps to lay it again
 *  (`Level::layout`), kept in this browser so a level comes back as it
 *  was left. */
const LAYOUTS = "interchange.layout.";

export function layoutOf(name: string): string | null {
  try {
    return localStorage.getItem(LAYOUTS + name);
  } catch {
    return null;
  }
}

export function keepLayout(name: string, json: string) {
  try {
    localStorage.setItem(LAYOUTS + name, json);
  } catch {
    // As with the bests: kept as long as the tab, at worst.
  }
  setLayouts((v) => v + 1);
}

/** Moves when any layout is kept, for what draws them. */
const [layouts, setLayouts] = createSignal(0);
export { layouts };
