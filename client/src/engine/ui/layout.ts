import { faceOf, setText, type Laid, type Run } from "./glyphs";
import type { UiNode } from "./node";

/**
 * Where everything lies: a little of flexbox, what the cards need and no
 * more. A box runs its children down (`col`, the default) or across
 * (`row`), with `gap` between and `pad` round; in a column each child is
 * as wide as the column, in a row as wide as what is in it, and those that
 * `grow` share what is left; a row too wide takes it out of its texts. A text is as tall as its lines at the width
 * it is given. A child placed `at` its parent's edges is out of the flow.
 */

const pads = (p: UiNode["props"]["pad"]): [number, number, number, number] =>
  p === undefined ? [0, 0, 0, 0] : typeof p === "number" ? [p, p, p, p] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;

/** The runs of a text: its own words and those of the texts in it, each in the style it inherits. */
function runs(n: UiNode, up: Omit<Run, "text">, out: Run[] = []): Run[] {
  const p = n.props;
  const style = {
    face: p.weight || p.serif !== undefined ? faceOf(p.weight ?? 500, p.serif) : up.face,
    size: p.size ?? up.size,
    ink: p.ink ?? (p.soft ? "ink/0.72" : up.ink),
  };
  for (const k of n.kids) {
    if (k.tag === "#text") out.push({ ...style, text: k.value });
    else if (k.tag === "text") runs(k, style, out);
  }
  return out;
}
const BODY = { face: 0 as const, size: 14, ink: "ink" };
/** Line height, as a share of the size: Tailwind's `leading-tight`. */
const LEAD = 1.25;

/** A text set at a width, kept until the tree changes. */
function set(n: UiNode, width: number, version: number): Laid {
  const was = n.lines as { at: string; laid: Laid } | undefined;
  const at = `${version}|${width}`;
  if (was?.at === at) return was.laid;
  const laid = setText(runs(n, BODY), width, n.props.lead ?? LEAD, n.props.lines);
  n.lines = { at, laid };
  return laid;
}

const flows = (n: UiNode) => n.kids.filter((k) => k.tag !== "#text" && !k.props.at);

/** How wide it would be with all the room it wants. */
function natural(n: UiNode, v: number): number {
  const p = n.props;
  if (p.w !== undefined) return p.w;
  if (n.tag === "icon") return p.size ?? 16;
  if (n.tag === "text") return Math.ceil(set(n, Infinity, v).w);
  const [, r, , l] = pads(p.pad);
  const kids = flows(n).map((k) => natural(k, v));
  const gaps = Math.max(0, kids.length - 1) * (p.gap ?? 0);
  return l + r + (p.dir === "row" ? kids.reduce((a, b) => a + b, 0) + gaps : Math.max(0, ...kids));
}

/** Lay it out at a width; its height follows. */
function place(n: UiNode, width: number, v: number) {
  const p = n.props;
  n.w = width;
  if (n.tag === "icon") return void (n.h = p.size ?? 16);
  if (n.tag === "text") return void (n.h = p.h ?? set(n, width, v).h);
  const [t, r, b, l] = pads(p.pad);
  const inner = Math.max(0, width - l - r);
  const gap = p.gap ?? 0;
  const kids = flows(n);
  const align = p.align ?? "stretch";
  let tall: number;
  if (p.dir === "row") {
    const fixed = kids.map((k) => (k.props.grow ? 0 : Math.min(natural(k, v), inner)));
    const grows = kids.reduce((a, k) => a + (k.props.grow ?? 0), 0);
    const spare = inner - fixed.reduce((a, b) => a + b, 0) - gap * Math.max(0, kids.length - 1);
    // Too wide: the texts give, each by its share, cut short with an ellipsis.
    const give = kids.reduce((a, k, i) => a + (k.tag === "text" && k.props.w === undefined ? fixed[i] : 0), 0);
    if (spare < 0 && give > 0) kids.forEach((k, i) => k.tag === "text" && k.props.w === undefined && (fixed[i] = Math.max(0, fixed[i] + (spare * fixed[i]) / give)));
    const left = Math.max(0, spare);
    kids.forEach((k, i) => place(k, k.props.grow ? (left * k.props.grow) / grows : fixed[i], v));
    tall = p.h !== undefined ? p.h - t - b : Math.max(0, ...kids.map((k) => k.h));
    const used = kids.reduce((a, k) => a + k.w, 0) + gap * Math.max(0, kids.length - 1);
    let x = l + lead(p.justify, inner - used);
    const step = p.justify === "between" && kids.length > 1 ? (inner - used) / (kids.length - 1) : 0;
    for (const k of kids) {
      if (align === "stretch" && k.props.h === undefined && k.tag === "box") k.h = tall;
      k.x = x;
      k.y = t + cross(align, tall - k.h);
      x += k.w + gap + step;
    }
  } else {
    for (const k of kids) place(k, k.props.w ?? (align === "stretch" ? inner : Math.min(natural(k, v), inner)), v);
    const used = kids.reduce((a, k) => a + k.h, 0) + gap * Math.max(0, kids.length - 1);
    tall = p.h !== undefined ? p.h - t - b : used;
    let y = t + lead(p.justify, tall - used);
    const step = p.justify === "between" && kids.length > 1 ? (tall - used) / (kids.length - 1) : 0;
    for (const k of kids) {
      k.x = l + cross(align, inner - k.w);
      k.y = y;
      y += k.h + gap + step;
    }
  }
  n.h = p.h ?? tall + t + b;
  for (const k of n.kids) if (k.props.at && k.tag !== "#text") pin(k, n.w, n.h, v);
  if (p.onSize) sized.push(n);
}

/** A child out of the flow, at its distances from its parent's edges:
 *  held by both sides, as wide as they leave it. */
function pin(k: UiNode, w: number, h: number, v: number) {
  const at = k.props.at;
  const both = at.left !== undefined && at.right !== undefined;
  place(k, k.props.w ?? (both ? w - at.left - at.right : natural(k, v)), v);
  k.x = at.left ?? (at.right !== undefined ? w - at.right - k.w : 0);
  k.y = at.top ?? (at.bottom !== undefined ? h - at.bottom - k.h : 0);
}

/** The boxes that asked to be told their size, told once the tree is laid out. */
const sized: UiNode[] = [];
/** Where the first child starts, along the way or across it, in the room spare. */
const lead = (j: string | undefined, spare: number) => (j === "center" ? spare / 2 : j === "end" ? spare : 0);
const cross = lead;

/** Lay out the whole tree in a screen this big, each child of the root
 *  pinned to its edges; then tell those that asked how big they came out. */
export function layout(root: UiNode, width: number, height: number, version: number) {
  root.w = width;
  root.h = height;
  for (const k of root.kids) if (k.tag !== "#text") pin(k, width, height, version);
  for (const n of sized.splice(0)) n.props.onSize(n.w, n.h);
}
