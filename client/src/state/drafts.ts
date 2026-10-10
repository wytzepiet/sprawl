import { createSignal } from "solid-js";
import { me } from "./gameObjects";
import type { Draft, Mark } from "../generated";

/**
 * Every player's draft as the last update had it (docs/game.md §Drafts):
 * the steps of the hand not yet built, a stroke a drag, and the bill. Our
 * own is drawn blue and has the bill by the toolbar; everyone else's is
 * drawn as land taken.
 */
const [drafts, setDrafts] = createSignal<Draft[]>([], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
export { drafts };

export function hearDrafts(d: Draft[] | undefined) {
  setDrafts(d ?? []);
}

/** Our own draft, if we have one. */
export const mine = (): Draft | undefined => drafts().find((d) => d.owner === me());
/** Our own steps, in the order drawn. */
export const myMarks = (): Mark[] => mine()?.strokes.flat() ?? [];
/** Everyone else's steps. */
export const theirMarks = (): Mark[] => drafts().filter((d) => d.owner !== me()).flatMap((d) => d.strokes.flat());

/** The last thing done to our draft from here: what the ghosts that go
 *  next are doing, landing as built or simply taken back. */
const [last, setLast] = createSignal<"commit" | "other">("other");
export { last as lastDone };
export const done = (what: "commit" | "other") => setLast(what);
