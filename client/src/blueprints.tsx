import type { JSX } from "solid-js";
import type { Building, BuildingKind } from "./generated";

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
  /** Its colour on the map's pins and the toolbar. */
  color: string;
  /** Its colour as it stands in the town: the same family, as a material
   *  is, terracotta, slate, brick, timber, zinc. */
  material: string;
  /** SVG path of the glyph, on a 24-unit grid. */
  glyph: string;
  /** Half-height of view, in tiles, beyond which the pin becomes a dot. */
  pinUntil: number;
  /** Which silhouette it stands as. */
  shape: "gabled" | "sawtooth" | "box";
  /** Heights a box may be built at; one is picked per building and kept. */
  heights: number[];
  /** What the mayor pays the world for one, in coins: its materials. */
  price: number;
  /** Which shelf of the build menu it stands on. */
  tab: Tab;
  /** The building's own footprint in tiles, wide along its frontage. */
  size: [number, number];
  /** Its yard in tiles along the frontage and deep, on the street side; [0, 0] is none: it parks on its drive. */
  lot: [number, number];
  /** A depot: its lot is a yard of docks, not a ring, and fuses with nobody. */
  yard?: boolean;
  /** A port: a quay along its back wall, out over the water, where its ship moors. */
  quay?: boolean;
}

/** The four ways a plot can lie: which side the lot and street are on. */
export const FACINGS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export interface Plot {
  size: [number, number];
  building: [[number, number], [number, number]];
  lot: [[number, number], [number, number]] | null;
}

/** The smallest of a kind, lying this way: its size, and where building and yard lie in it. Mirrors `blueprint::plot`. */
export function plot(kind: BuildingKind, facing: number): Plot {
  const { size: [bw, bh], lot: [lw, ld] } = BLUEPRINTS[kind];
  // As wide as the wider of building and yard, as the server lays it.
  const w = Math.max(bw, lw);
  return lie(kind, facing, facing % 2 === 0 ? [w, bh + ld] : [bh + ld, w]);
}

/** A building `size` across, lying this way: its yard the rows on its street side as deep as its kind's, its whole width; the rest the building. Mirrors `blueprint::lie`. */
export function lie(kind: BuildingKind, facing: number, [w, h]: [number, number]): Plot {
  const d = BLUEPRINTS[kind].lot[1];
  const yard = d > 0;
  switch (facing % 4) {
    case 2: return { size: [w, h], building: [[0, 0], [w, h - d]], lot: yard ? [[0, h - d], [w, d]] : null };
    case 0: return { size: [w, h], building: [[0, d], [w, h - d]], lot: yard ? [[0, 0], [w, d]] : null };
    case 1: return { size: [w, h], building: [[0, 0], [w - d, h]], lot: yard ? [[w - d, 0], [d, h]] : null };
    default: return { size: [w, h], building: [[d, 0], [w - d, h]], lot: yard ? [[0, 0], [d, h]] : null };
  }
}

/** Where a building stands and how big it is, in tiles: the middle and
 *  size of its bounds, its yard left out. */
export function standing(b: Building): { at: [number, number]; size: [number, number] } {
  const xs = b.tiles.map((t) => t.x), ys = b.tiles.map((t) => t.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const [[bx, by], [bw, bh]] = lie(b.kind, b.facing, [Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1]).building;
  return { at: [x0 + bx + bw / 2, y0 + by + bh / 2], size: [bw, bh] };
}

/** Where a building stands: the middle of its bounds, its yard left out. */
export const middle = (b: Building): [number, number] => standing(b).at;

/** The bulk of a city: somewhere people live or work, and there are hundreds. */
const COMMON = 7;
/** Places people go, which is what makes them worth finding from further off. */
const NOTABLE = 28;
/** Rare enough to be a landmark. */
const SPECIAL = 45;

export const BLUEPRINTS: Record<BuildingKind, Blueprint> = {
  House: {
    label: "House",
    color: "#E8566F",
    material: "#B85A44",
    // A gabled roof over a body, the door cut out.
    glyph: "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z",
    pinUntil: COMMON,
    shape: "gabled",
    heights: [0],
    price: 5, tab: "homes",
    size: [1, 1],
    lot: [0, 0],
  },
  Apartment: {
    label: "Apartment",
    color: "#C73E5E",
    material: "#8E4A40",
    // A tall block, three floors of windows and a door.
    glyph: "M5 2h14v20H5zM8 5h3v3H8zM13 5h3v3h-3zM8 10h3v3H8zM13 10h3v3h-3zM8 15h3v3H8zM13 15h3v3h-3zM10.5 19h3v3h-3z",
    pinUntil: COMMON,
    shape: "box",
    heights: [0.85, 1.15, 1.5],
    price: 15, tab: "homes",
    size: [2, 1],
    lot: [0, 0],
  },
  Shop: {
    label: "Shop",
    color: "#3B78B8",
    material: "#56708A",
    // A storefront: scalloped awning, window and door beneath.
    glyph:
      "M3 3h18l2 5.5a2.5 2.5 0 0 1-4.7 1.2A2.5 2.5 0 0 1 14.2 9.7a2.5 2.5 0 0 1-4.4 0 2.5 2.5 0 0 1-4.1 0A2.5 2.5 0 0 1 1 8.5zM4 12h16v10H4zM6 14h6v4H6zM14 14h4v8h-4z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.45, 0.55],
    price: 18, tab: "shops",
    size: [1, 1],
    lot: [0, 0],
  },
  Office: {
    label: "Office",
    color: "#2D4E7E",
    material: "#3F4D5E",
    // A briefcase, the handle cut out.
    glyph:
      "M9 3h6a1.5 1.5 0 0 1 1.5 1.5V7H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3.5V4.5A1.5 1.5 0 0 1 9 3zm.5 2v2h5V5zM2 12h20v1.5H2z",
    pinUntil: COMMON,
    shape: "box",
    // Tall, and worth varying: a few towers among them is what gives a
    // business district a skyline instead of a plateau.
    heights: [1.0, 1.45, 2.3],
    price: 15, tab: "work",
    size: [2, 1],
    lot: [0, 0],
  },
  Factory: {
    label: "Factory",
    color: "#5C6470",
    material: "#7A7F86",
    // Sawtooth roofs and a chimney.
    glyph: "M17 2h4v8.5l-4 0zM2 22V10.5l6 3v-3l6 3v-3l6 3V22zM5 16h3v3H5zM10 16h3v3h-3zM15 16h3v3h-3z",
    pinUntil: COMMON,
    shape: "sawtooth",
    heights: [0],
    price: 25, tab: "work",
    size: [2, 1],
    lot: [0, 0],
  },
  GasStation: {
    label: "Gas station",
    color: "#F2C230",
    material: "#C7A24E",
    // A pump: the body with its display, and the hose hooked to the side.
    glyph: "M3 2h11v20H3zM5.5 4.5h6v5h-6zM15.5 7h2.2l3.3 3.3V19a2.5 2.5 0 0 1-5 0v-1h2v1a.5.5 0 0 0 1 0v-7.9L17 9.2h-1.5z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.3],
    price: 14, tab: "services",
    size: [1, 1],
    lot: [0, 0],
  },
  Supermarket: {
    label: "Supermarket",
    color: "#6EC1E4",
    material: "#8FA7B3",
    // A basket: handle arcs over, three slats cut out.
    glyph: "M12 2.5c3 0 5.5 2.4 6.3 5.5H21l-2 13H5L3 8h2.7C6.5 4.9 9 2.5 12 2.5zm0 2c-1.9 0-3.5 1.5-4.2 3.5h8.4C15.5 6 13.9 4.5 12 4.5zM7.5 11h1.6v6H7.5zm3.7 0h1.6v6h-1.6zm3.7 0h1.6v6h-1.6z",
    pinUntil: SPECIAL,
    shape: "box",
    heights: [0.5],
    price: 47, tab: "services",
    size: [2, 2],
    lot: [0, 0],
  },
  Depot: {
    label: "Depot",
    color: "#A0714A",
    material: "#7E6248",
    // A wide shed: the roof, a loading door and two bays.
    glyph: "M2 9.5 12 3l10 6.5V22H2zM5 12h14v2.5H5zM5 16h5v6H5zM14 16h5v6h-5z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.6],
    price: 56, tab: "services",
    size: [2, 2],
    lot: [3, 2],
    yard: true,
  },
  Farm: {
    label: "Farm",
    color: "#D9A23B",
    material: "#B79A62",
    // A barn: the gambrel roof, the big door, and a hayloft window.
    glyph: "M12 2 21 8.5V22H3V8.5zM10.5 6.5h3v3h-3zM8 13h8v9H8zm1.6 1.6v5.8h4.8v-5.8z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.4],
    price: 40, tab: "work",
    size: [3, 2],
    lot: [2, 2],
    yard: true,
  },
  Harbour: {
    label: "Harbour",
    color: "#2B6CA3",
    material: "#4E6A84",
    // A quay with a crane over it: the mast, the jib, and the hook.
    glyph: "M2 19h20v3H2zM6 3h3v16H6zM9 5h12v2.5H9zM17.5 7.5h2.5v5h-2.5zM16 12.5h5.5v2.5H16z",
    pinUntil: NOTABLE,
    shape: "box",
    heights: [0.5],
    price: 0, tab: "services",
    size: [3, 1],
    lot: [3, 2],
    yard: true,
    quay: true,
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
