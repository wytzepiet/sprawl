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
