import type { JSX as Solid } from "solid-js";
import type { UiNode } from "./node";

/**
 * The elements the GPU draws, and what each takes: a file that starts
 * `@jsxImportSource ~ui` is written in these and no others (`vite.config.ts`
 * compiles `src/ui/gpu/` for them). Sizes are CSS pixels; colours are
 * "#rrggbb", "#rrggbbaa", or the glass's own: "ink", "glass", with a share
 * after a slash ("ink/0.1").
 */
export declare namespace JSX {
  type Element = Solid.Element;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface ArrayElement extends Array<Element> {}

  /** Where it stands among its siblings, how it moves, and the hand. */
  interface Common {
    children?: Element;
    ref?: UiNode | ((n: UiNode) => void);
    /** A fixed size; without it, as big as what is in it (a row's), or as wide as its parent (a column's). */
    w?: number;
    h?: number;
    /** A share of a row's room left over. */
    grow?: number;
    /** Out of its parent's flow, at these distances from its edges. */
    at?: { left?: number; top?: number; right?: number; bottom?: number };
    /** Moved, scaled and faded without laying anything out again: what springs drive. */
    x?: number;
    y?: number;
    scale?: number;
    /** Where it scales from, as a share of its size: [0.5, 1] is the middle of its foot. */
    origin?: [number, number];
    opacity?: number;
    /** A tap: down and up on it, and not dragged between. */
    onTap?: () => void;
    /** The wheel over it, or a drag of a finger: how far, down positive. */
    onScroll?: (dy: number) => void;
    /** Pressed, and let go. */
    onPress?: (down: boolean) => void;
    /** Laid out at this size: told every time the tree is laid out. */
    onSize?: (w: number, h: number) => void;
  }

  interface Box extends Common {
    dir?: "row" | "col";
    gap?: number;
    /** All round, [up and down, either side], or [top, right, bottom, left]. */
    pad?: number | [number, number] | [number, number, number, number];
    /** Across the way it runs. */
    align?: "start" | "center" | "end" | "stretch";
    /** Along it. */
    justify?: "start" | "center" | "end" | "between";
    fill?: string;
    round?: number;
    /** A line round it: how wide, in what. */
    stroke?: [number, string];
    /** A soft shadow under it. */
    shadow?: boolean;
    /** What is in it is cut to its rounded shape. */
    clip?: boolean;
  }

  interface Glass extends Box {
    /** Panes of one layer melt together; a later layer lies over an earlier one. */
    layer: string;
    dye?: string;
  }

  interface Text extends Common {
    size?: number;
    weight?: 500 | 600 | 700;
    /** The numbers' face. */
    serif?: boolean;
    ink?: string;
    /** The ink, softened. */
    soft?: boolean;
    /** At most this many lines, the last cut with an ellipsis. */
    lines?: number;
    /** Line height, as a share of the size. */
    lead?: number;
    align?: "start" | "center" | "end";
  }

  interface Icon extends Common {
    /** An SVG path in a 24-unit square (or `view`). */
    d: string;
    size?: number;
    /** Drawn as a line this wide, in the path's units, rather than filled. */
    stroke?: number;
    view?: number;
    ink?: string;
  }

  interface IntrinsicElements {
    box: Box;
    glass: Glass;
    text: Text;
    icon: Icon;
  }
}
