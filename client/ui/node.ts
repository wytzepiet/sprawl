import { createRenderer } from "solid-js/universal";

/**
 * The UI the GPU draws (`paint.ts`), as a tree Solid keeps
 * (`solid-js/universal`): the four elements of `jsx-runtime.ts` and the
 * words in them. A node holds what it was given; layout (`layout.ts`)
 * writes where it lies; paint reads both, a frame at a time. It knows
 * nothing of the game, which gives it the glass's colours (`createPaint`)
 * and mounts what it draws on `root`.
 */
export interface UiNode {
  tag: "box" | "glass" | "text" | "icon" | "#text" | "root";
  props: Record<string, any>;
  parent: UiNode | null;
  kids: UiNode[];
  /** A word's own text. */
  value: string;
  /** Where layout put it, in its parent's box, and how big: CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lines of a text, as laid out (`glyphs.ts`). */
  lines?: unknown;
}

/** Props that move what is laid out; the rest only change how it is drawn. */
const LAYOUT = new Set(["dir", "gap", "pad", "align", "justify", "grow", "wrap", "w", "h", "minW", "maxW", "minH", "maxH", "at", "size", "weight", "serif", "lines", "lead", "d"]);

/** What changed since the tree was last laid out and drawn. */
export const dirt = { layout: 1, paint: 1 };
const moved = (layout: boolean) => {
  dirt.paint++;
  if (layout) dirt.layout++;
};

export const node = (tag: UiNode["tag"], value = ""): UiNode => ({ tag, props: {}, parent: null, kids: [], value, x: 0, y: 0, w: 0, h: 0 });

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = createRenderer<UiNode>({
  createElement: (tag) => node(tag as UiNode["tag"]),
  createTextNode: (value) => node("#text", value),
  replaceText(n, value) {
    n.value = value;
    moved(true);
  },
  isTextNode: (n) => n.tag === "#text",
  setProperty(n, name, value) {
    n.props[name] = value;
    moved(LAYOUT.has(name));
  },
  insertNode(parent, n, anchor) {
    if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
    n.parent = parent;
    const at = anchor ? parent.kids.indexOf(anchor) : -1;
    if (at < 0) parent.kids.push(n);
    else parent.kids.splice(at, 0, n);
    moved(true);
  },
  removeNode(parent, n) {
    const at = parent.kids.indexOf(n);
    if (at >= 0) parent.kids.splice(at, 1);
    n.parent = null;
    moved(true);
  },
  getParentNode: (n) => n.parent ?? undefined,
  getFirstChild: (n) => n.kids[0],
  getNextSibling(n) {
    const kids = n.parent?.kids;
    return kids ? kids[kids.indexOf(n) + 1] : undefined;
  },
});
