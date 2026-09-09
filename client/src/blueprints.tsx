import type { JSX } from "solid-js";
import type { BuildingKind } from "./generated";

/**
 * Every kind of building, one row each, as the client draws it: its colour,
 * its glyph, how far out its pin holds before collapsing to a dot, and the
 * shape it stands as on the map. The server's `blueprint.rs` holds what a kind
 * *does*; this holds what it looks like. Adding a kind is one row in each.
 *
 * Colours are chosen mid-dark so a white glyph reads on them, and spread far
 * enough apart in hue to be told apart at a dot's size. Glyphs are filled
 * silhouettes on a 24-unit grid — one shape, windows and doors cut out — so a
 * pin reads at a glance and still reads shrunk to a dot's neighbour.
 */
export const TABS = ["homes", "shops", "work", "services"] as const;
export type Tab = (typeof TABS)[number];

export interface Blueprint {
  label: string;
  color: string;
  /** SVG path of the glyph, on a 24-unit grid. */
  glyph: string;
  /** Half-height of view, in tiles, beyond which the pin becomes a dot. */
  pinUntil: number;
  /** Which silhouette it stands as. */
  shape: "gabled" | "sawtooth" | "box";
  /** Heights a box may be built at; one is picked per building and kept. */
  heights: number[];
  /** What the mayor pays for one, in hours of need served. */
  price: number;
  /** Which shelf of the build menu it stands on. */
  tab: Tab;
  /** The building's own footprint in tiles, wide along its frontage. */
  size: [number, number];
  /** Its lot in tiles along the frontage and deep, on the street side; [0, 0] is none. */
  lot: [number, number];
  /** A depot: its lot is a yard of docks, not a ring, and fuses with nobody. */
  yard?: boolean;
}

/** The four ways a plot can lie: which side the lot and street are on. */
export const FACINGS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export interface Plot {
  size: [number, number];
  building: [[number, number], [number, number]];
  lot: [[number, number], [number, number]] | null;
}

/** A plot on the grid for a facing: its size, and where building and lot lie in it. Mirrors `blueprint::plot`. */
export function plot(kind: BuildingKind, facing: number): Plot {
  const { size: [bw, bh], lot: [lw, ld] } = BLUEPRINTS[kind];
  const has = lw > 0 && ld > 0;
  // As wide as the wider of building and lot, as the server lays it.
  const w = Math.max(bw, lw);
  switch (facing % 4) {
    case 2: return { size: [w, bh + ld], building: [[0, 0], [bw, bh]], lot: has ? [[0, bh], [lw, ld]] : null };
    case 0: return { size: [w, bh + ld], building: [[0, ld], [bw, bh]], lot: has ? [[0, 0], [lw, ld]] : null };
    case 1: return { size: [bh + ld, w], building: [[0, 0], [bh, bw]], lot: has ? [[bh, 0], [ld, lw]] : null };
    default: return { size: [bh + ld, w], building: [[ld, 0], [bh, bw]], lot: has ? [[0, 0], [ld, lw]] : null };
  }
}

/** The bulk of a city: somewhere people live or work, and there are hundreds. */
const COMMON = 7;
/** Places people go, which is what makes them worth finding from further off. */
const NOTABLE = 28;
/** Rare enough to be a landmark. */
const SPECIAL = 45;

export const BLUEPRINTS: Record<BuildingKind, Blueprint> = {
  House: {
    label: "House",
    color: "#3F9B5A",
    // A gabled roof over a body, the door cut out.
    glyph: "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z",
    pinUntil: COMMON,
    shape: "gabled",
    heights: [0],
    price: 3, tab: "homes",
    size: [1, 1],
    lot: [0, 0],
  },
  Apartment: {
    label: "Apartment",
    color: "#2E7D6F",
    // A tall block, three floors of windows and a door.
    glyph: "M5 2h14v20H5zM8 5h3v3H8zM13 5h3v3h-3zM8 10h3v3H8zM13 10h3v3h-3zM8 15h3v3H8zM13 15h3v3h-3zM10.5 19h3v3h-3z",
    pinUntil: COMMON,
    shape: "box",
    heights: [0.85, 1.15, 1.5],
    price: 8, tab: "homes",
    size: [2, 1],
    lot: [2, 1],
  },
  Shop: {
    label: "Shop",
    color: "#2F7FD4",
    // A storefront: scalloped awning, window and door beneath.
    glyph:
      "M3 3h18l2 5.5a2.5 2.5 0 0 1-4.7 1.2A2.5 2.5 0 0 1 14.2 9.7a2.5 2.5 0 0 1-4.4 0 2.5 2.5 0 0 1-4.1 0A2.5 2.5 0 0 1 1 8.5zM4 12h16v10H4zM6 14h6v4H6zM14 14h4v8h-4z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.45, 0.55],
    price: 4, tab: "shops",
    size: [1, 1],
    lot: [2, 1],
  },
  Office: {
    label: "Office",
    color: "#5B57C8",
    // A briefcase, the handle cut out.
    glyph:
      "M9 3h6a1.5 1.5 0 0 1 1.5 1.5V7H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3.5V4.5A1.5 1.5 0 0 1 9 3zm.5 2v2h5V5zM2 12h20v1.5H2z",
    pinUntil: COMMON,
    shape: "box",
    // Tall, and worth varying: a few towers among them is what gives a
    // business district a skyline instead of a plateau.
    heights: [1.0, 1.45, 2.3],
    price: 10, tab: "work",
    size: [2, 1],
    lot: [2, 1],
  },
  Workshop: {
    label: "Workshop",
    color: "#C97A1E",
    // A wrench.
    glyph:
      "M21.5 6.2a6.3 6.3 0 0 1-8.1 8.1l-7.3 7.3a2.3 2.3 0 0 1-3.2-3.2l7.3-7.3a6.3 6.3 0 0 1 8.1-8.1l-3.7 3.7 1.1 3.2 3.2 1.1z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.42, 0.5],
    price: 5, tab: "work",
    size: [1, 1],
    lot: [2, 1],
  },
  Factory: {
    label: "Factory",
    color: "#6B6F78",
    // Sawtooth roofs and a chimney.
    glyph: "M17 2h4v8.5l-4 0zM2 22V10.5l6 3v-3l6 3v-3l6 3V22zM5 16h3v3H5zM10 16h3v3h-3zM15 16h3v3h-3z",
    pinUntil: COMMON,
    shape: "sawtooth",
    heights: [0],
    price: 12, tab: "work",
    size: [2, 1],
    lot: [2, 1],
  },
  Restaurant: {
    label: "Restaurant",
    color: "#D9483B",
    // Fork and knife.
    glyph:
      "M5.5 2h1.6v6h1.2V2h1.4v6h1.2V2h1.6v7a3.5 3.5 0 0 1-2.2 3.3V22H7.7v-9.7A3.5 3.5 0 0 1 5.5 9zM15.5 2c2.2 1.6 3.3 4.6 3.3 8 0 1.8-.8 3-1.9 3.6V22h-2.3V2z",
    pinUntil: SPECIAL,
    shape: "box",
    heights: [0.5, 0.62],
    price: 5, tab: "shops",
    size: [1, 1],
    lot: [2, 1],
  },
  Bar: {
    label: "Bar",
    color: "#9B3FA0",
    // A pint glass, tapered, with a head of foam cut across it.
    glyph: "M5 2h14l-1.6 20H6.6zM6.3 5.5h11.4l-.2 2H6.5z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.45, 0.55],
    price: 4, tab: "shops",
    size: [1, 1],
    lot: [2, 1],
  },
  GasStation: {
    label: "Gas station",
    color: "#A3841A",
    // A pump: the body with its display, and the hose hooked to the side.
    glyph: "M3 2h11v20H3zM5.5 4.5h6v5h-6zM15.5 7h2.2l3.3 3.3V19a2.5 2.5 0 0 1-5 0v-1h2v1a.5.5 0 0 0 1 0v-7.9L17 9.2h-1.5z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.3],
    price: 6, tab: "services",
    size: [1, 1],
    lot: [2, 1],
  },
  Supermarket: {
    label: "Supermarket",
    color: "#1E8FA8",
    // A basket: handle arcs over, three slats cut out.
    glyph: "M12 2.5c3 0 5.5 2.4 6.3 5.5H21l-2 13H5L3 8h2.7C6.5 4.9 9 2.5 12 2.5zm0 2c-1.9 0-3.5 1.5-4.2 3.5h8.4C15.5 6 13.9 4.5 12 4.5zM7.5 11h1.6v6H7.5zm3.7 0h1.6v6h-1.6zm3.7 0h1.6v6h-1.6z",
    pinUntil: SPECIAL,
    shape: "box",
    heights: [0.5],
    price: 12, tab: "services",
    size: [2, 2],
    lot: [2, 1],
  },
  Warehouse: {
    label: "Warehouse",
    color: "#7A5C3E",
    // A wide shed: the roof, a loading door and two bays.
    glyph: "M2 9.5 12 3l10 6.5V22H2zM5 12h14v2.5H5zM5 16h5v6H5zM14 16h5v6h-5z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.6],
    price: 15, tab: "services",
    size: [2, 2],
    lot: [2, 2],
    yard: true,
  },
  Edge: {
    label: "Beyond the edge",
    color: "#6B7280",
    // A road running off the map: a lane, and an arrow away down it.
    glyph: "M3 3h3v18H3zm15 0h3v18h-3zM11 3h2v10h3l-4 5-4-5h3z",
    pinUntil: 0,
    shape: "box",
    heights: [0],
    // Not for sale at any price, so it stands on no shelf of the menu.
    price: Infinity, tab: "services",
    size: [1, 1],
    lot: [0, 0],
  },
};

/**
 * Every kind the mayor may put down: everything with a price. The edge has
 * none — it is the world past the frontier, not a thing a town has — so it
 * never reaches the build menu. Mirrors the server's own reading of the
 * table.
 */
export const KINDS = (Object.keys(BLUEPRINTS) as BuildingKind[]).filter((k) => Number.isFinite(BLUEPRINTS[k].price));

/** The glyph for a kind, as an SVG that takes the current colour. */
export function BuildingIcon(props: JSX.SvgSVGAttributes<SVGSVGElement> & { kind: BuildingKind }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" {...props}>
      <path d={BLUEPRINTS[props.kind].glyph} />
    </svg>
  );
}
