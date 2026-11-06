import { createContext, onCleanup, onMount, useContext, type JSX } from "solid-js";
import { hand, handle } from "./hand";
import { createMelt, type Melted } from "./melt";
import { moved } from "../src/engine/spring";
import "./ink.css";

/**
 * Ink: the UI as the page draws it, pure black on the game, and the few
 * things it is made of. A box lays out what is in it as a flexbox does,
 * down (the default) or across; a text is words; an icon an SVG path; a
 * pane is the black. Panes of one layer inside a `Melt` of that layer run
 * together like liquid, drawn on its canvas; any other pane is a black
 * box of its own. It knows nothing of the game. Sizes are CSS pixels;
 * colours are "#rgb[a]", "#rrggbb[aa]", "white", or the black's own:
 * "ink" (white, written on it) and "glass" (the black), with a share
 * after a slash ("ink/0.1").
 */

/** Where it stands among its siblings, how it moves, and the hand. */
export interface Common {
  children?: JSX.Element;
  ref?: (el: HTMLElement) => void;
  /** A fixed size; without it, as big as what is in it (a row's), or as wide as its parent (a column's). */
  w?: number;
  h?: number;
  /** The least and the most it may be, whatever its size would be. */
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
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
  /** The wheel over it, or a drag of a finger (`held`): how far, down
   *  positive. A drag let go says so once more, by 0 and not held. */
  onScroll?: (dy: number, held?: boolean) => void;
  /** The pointer come over it, and gone. */
  onHover?: (over: boolean) => void;
  /** Pressed, and let go. */
  onPress?: (down: boolean) => void;
  /** Pressed and dragged off it: the town has the pointer from here. */
  onDrag?: () => void;
  /** Pressed and slid along: where the pointer is across it, 0 at its
   *  left and 1 at its right, from the press till let go, said once more
   *  then, not held. A handle on a bar. */
  onSlide?: (at: number, held: boolean) => void;
  /** A drag the town has let go over it. */
  onDrop?: () => void;
  /** Laid out at this size, and again whenever it changes. */
  onSize?: (w: number, h: number) => void;
}

export interface BoxProps extends Common {
  dir?: "row" | "col";
  gap?: number;
  /** All round, or by side: a side named wins over its axis. */
  pad?: number | { x?: number; y?: number; top?: number; right?: number; bottom?: number; left?: number };
  /** A row too wide for its room goes on in another line, `gap` below. */
  wrap?: boolean;
  /** Across the way it runs. */
  align?: "start" | "center" | "end" | "stretch";
  /** Along it. */
  justify?: "start" | "center" | "end" | "between";
  fill?: string;
  /** A picture, filling it, in place of the fill. */
  photo?: string;
  round?: number;
  /** A line round its inside: how wide, in what. */
  stroke?: [number, string];
  /** A soft shadow under it. */
  shadow?: boolean;
  /** What is in it is cut to its rounded shape. */
  clip?: boolean;
}

export interface InkProps extends BoxProps {
  /** Panes of one layer melt together, inside a `Melt` of that layer. */
  layer: string;
  /** A colour laid into the black. */
  dye?: string;
  /** The black is all round its box and the box is the hole: a frame,
   *  the bezel round the game. */
  hole?: boolean;
}

export interface TextProps extends Common {
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

export interface IconProps extends Common {
  /** An SVG path in a 24-unit square (or `view`). */
  d: string;
  size?: number;
  /** Drawn as a line this wide, in the path's units, rather than filled. */
  stroke?: number;
  view?: number;
  ink?: string;
}

/** A colour as CSS. */
export function paint(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const [name, share] = c.split("/");
  let [r, g, b, a] = [0, 0, 0, Number(share ?? 1)];
  if (name === "ink" || name === "white") [r, g, b] = [255, 255, 255];
  else if (name !== "glass") {
    let h = name.slice(1);
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    const v = parseInt(h.slice(0, 6), 16);
    [r, g, b] = [v >> 16, (v >> 8) & 255, v & 255];
    if (h.length === 8) a *= parseInt(h.slice(6), 16) / 255;
  }
  return `rgba(${r},${g},${b},${a})`;
}

const px = (v: number | undefined) => (v === undefined ? undefined : `${v}px`);
const FLEX = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", between: "space-between" } as const;

/** Top, right, bottom, left: a side named, else its axis, else none. */
const pads = (p: BoxProps["pad"]) =>
  p === undefined ? undefined
  : typeof p === "number" ? `${p}px`
  : `${p.top ?? p.y ?? 0}px ${p.right ?? p.x ?? 0}px ${p.bottom ?? p.y ?? 0}px ${p.left ?? p.x ?? 0}px`;

/** What everything takes: its size, its place, how it moves; and whether
 *  the hand finds it. */
function common(p: Common, catches: boolean): JSX.CSSProperties {
  const moved = p.x || p.y || (p.scale ?? 1) !== 1;
  const o = p.opacity ?? 1;
  return {
    width: px(p.w),
    height: px(p.h),
    "min-width": px(p.minW),
    // Told how wide, it is that wide, whatever room it is in (`ink.css`).
    "max-width": px(p.maxW) ?? (p.w === undefined ? undefined : "none"),
    "min-height": px(p.minH),
    "max-height": px(p.maxH),
    "flex-grow": p.grow === undefined ? undefined : String(p.grow),
    "flex-basis": p.grow === undefined ? undefined : "0",
    position: p.at ? "absolute" : undefined,
    left: px(p.at?.left),
    top: px(p.at?.top),
    right: px(p.at?.right),
    bottom: px(p.at?.bottom),
    transform: moved ? `translate(${p.x ?? 0}px,${p.y ?? 0}px) scale(${p.scale ?? 1})` : undefined,
    "transform-origin": p.origin ? `${p.origin[0] * 100}% ${p.origin[1] * 100}%` : undefined,
    opacity: o === 1 ? undefined : String(o),
    // Faded all the way, it is gone: drawn nowhere, found by nothing.
    visibility: o < 0.002 ? "hidden" : undefined,
    "pointer-events": catches || p.onTap || p.onScroll || p.onPress || p.onHover || p.onDrag || p.onDrop || p.onSlide ? "auto" : undefined,
    cursor: p.onTap ? "pointer" : undefined,
  };
}

/** What asked to be told its size, told by one watcher for all of them. */
const sizing = new WeakMap<Element, (w: number, h: number) => void>();
const sizes = new ResizeObserver((all) => {
  for (const e of all) sizing.get(e.target)?.(e.borderBoxSize[0].inlineSize, e.borderBoxSize[0].blockSize);
});

/** The hand and the size, on an element. */
function hook(el: HTMLElement, p: Common) {
  handle(el, p);
  p.ref?.(el);
  if (!p.onSize) return;
  sizing.set(el, (w, h) => p.onSize?.(w, h));
  sizes.observe(el);
  onCleanup(() => sizes.unobserve(el));
}

/** The corner: a squircle's where the page can draw one, a pill's ends round. */
function corner(p: BoxProps): JSX.CSSProperties {
  const r = p.round;
  if (!r) return {};
  const pill = (p.h !== undefined && r >= p.h / 2 - 0.5) || (p.w !== undefined && r >= p.w / 2 - 0.5);
  return pill ? { "border-radius": "9999px" } : { "--r": `${r}px` };
}

function boxStyle(p: BoxProps, fill: string | undefined, catches: boolean): JSX.CSSProperties {
  return {
    ...common(p, catches),
    "flex-direction": p.dir === "row" ? "row" : undefined,
    "flex-wrap": p.wrap ? "wrap" : undefined,
    gap: px(p.gap),
    padding: pads(p.pad),
    "align-items": p.align ? FLEX[p.align] : undefined,
    "justify-content": p.justify ? FLEX[p.justify] : undefined,
    background: p.photo ? `center / cover url(${p.photo})` : paint(fill),
    "box-shadow": [p.stroke && `inset 0 0 0 ${p.stroke[0]}px ${paint(p.stroke[1])}`, p.shadow && "0 2px 5px rgba(0,0,0,0.22)"].filter(Boolean).join(",") || undefined,
    overflow: p.clip ? "hidden" : undefined,
    ...corner(p),
  };
}

const classes = (p: BoxProps) => `b${p.dir === "row" ? " r" : ""}${p.round && !corner(p)["border-radius"] ? " sq" : ""}`;

export function Box(props: BoxProps) {
  return (
    <div ref={(el) => hook(el, props)} class={classes(props)} style={boxStyle(props, props.fill, !!(props.fill || props.photo))}>
      {props.children}
    </div>
  );
}

/** A Melt's: its layer, the panes on it, and the Melt round it. */
interface MeltCtx {
  layer: string;
  melted: Melted;
  up?: MeltCtx;
}
const MeltContext = createContext<MeltCtx>();

/**
 * Where panes of a layer run together: a box with a canvas under what is
 * in it, the black of every pane of its layer drawn there as one, a
 * smooth union of their shapes (`melt.ts`), so what touches the bezel
 * grows out of it. A pane's content lies over the black, in the page.
 */
export function Melt(props: BoxProps & { layer: string }) {
  const melted: Melted = new Set();
  let canvas!: HTMLCanvasElement;
  onMount(() => onCleanup(createMelt(canvas, melted)));
  return (
    <MeltContext.Provider value={{ layer: props.layer, melted, up: useContext(MeltContext) }}>
      <Box {...props}>
        <canvas ref={canvas} class="melt" />
        {props.children}
      </Box>
    </MeltContext.Provider>
  );
}

/** A pane of the black: melted with its layer's, or a black box of its own. */
export function Ink(props: InkProps) {
  let m = useContext(MeltContext);
  while (m && m.layer !== props.layer) m = m.up;
  const melted = m?.melted;
  const ref = (el: HTMLElement) => {
    hook(el, props);
    if (!melted) return;
    const pane = { el, props };
    melted.add(pane);
    moved();
    onCleanup(() => (melted.delete(pane), moved()));
  };
  return (
    <div ref={ref} class={classes(props)} style={boxStyle(props, melted ? undefined : props.dye ?? "glass", !props.hole)}>
      {props.children}
    </div>
  );
}

export function Text(props: TextProps) {
  const style = (): JSX.CSSProperties => ({
    ...common(props, false),
    "flex-shrink": props.w === undefined ? undefined : "0",
    "font-size": px(props.size),
    // A weight or the face named sets the face; else it is the words' round it.
    "font-family": props.serif ? "Nunito" : props.weight ? "Inter" : undefined,
    "font-weight": props.serif ? "700" : props.weight ? String(props.weight) : undefined,
    color: paint(props.ink ?? (props.soft ? "ink/0.72" : undefined)),
    "line-height": props.lead === undefined ? undefined : String(props.lead),
    "text-align": props.align,
    "-webkit-line-clamp": props.lines && props.lines > 1 ? String(props.lines) : undefined,
  });
  const cls = () => `t${props.lines === 1 ? " one" : props.lines ? " some" : ""}`;
  return (
    <span ref={(el) => hook(el, props)} class={cls()} style={style()}>
      {props.children}
    </span>
  );
}

export function Icon(props: IconProps) {
  const size = () => props.size ?? 16;
  return (
    <svg ref={(el) => hook(el as unknown as HTMLElement, props)} class="i" width={size()} height={size()} viewBox={`0 0 ${props.view ?? 24} ${props.view ?? 24}`} style={common(props, false)}>
      <path
        d={props.d}
        fill={props.stroke ? "none" : paint(props.ink ?? "ink")}
        fill-rule="evenodd"
        stroke={props.stroke ? paint(props.ink ?? "ink") : undefined}
        stroke-width={props.stroke}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Where the UI goes: over the whole screen, the hand on it (`hand.ts`). */
export function Root(props: { children: JSX.Element }) {
  let el!: HTMLDivElement;
  onMount(() => onCleanup(hand(el)));
  return (
    <div ref={el} class="ink">
      {props.children}
    </div>
  );
}
