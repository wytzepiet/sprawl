import { PACKAGE, PER_PACKAGE, ROWS } from "./generated/rows";
import type { Building, BuildingKind, Good, GridCoord } from "./generated";

/**
 * Every kind of building, one row each, as the client draws it: its colour,
 * its glyph, and the shape it stands as on the map. The server's
 * `blueprint.rs` holds what a kind *does*, and writes the columns the
 * client reads of it (`generated/rows.ts`); this holds what it looks like.
 * Adding a kind is one row in each.
 *
 * Colours are chosen mid-dark so a white glyph reads on them, and spread far
 * enough apart in hue to be told apart at a dot's size. Glyphs are filled
 * silhouettes on a 24-unit grid — one shape, windows and doors cut out — so a
 * pin reads at a glance and still reads shrunk to a dot's neighbour.
 */
export const TABS = ["trade", "homes", "shops", "work", "industry", "services"] as const;
export type Tab = (typeof TABS)[number];

interface Look {
  label: string;
  /** What it does, for its page in the build menu. */
  about: string;
  /** Its colour on the map's pins and the toolbar. */
  color: string;
  /** Its colour as it stands in the town: the same family, as a material
   *  is, terracotta, slate, brick, timber, zinc. */
  material: string;
  /** SVG path of the glyph, on a 24-unit grid. */
  glyph: string;
  /** Which silhouette it stands as. */
  shape: "gabled" | "sawtooth" | "box";
  /** Heights a box may be built at; one is picked per building and kept. */
  heights: number[];
  /** Which shelf of the build menu it stands on. */
  tab: Tab;
}

/** A kind's look, and the server's columns of its row: what it is built
 *  from, which a depot's vans bring to its site, none standing at once;
 *  its footprint in tiles, wide along its frontage; its yard, along the
 *  frontage and deep, on the street side, [0, 0] none, parking on its
 *  drive; and a harbour's quay, along its back wall, where the ferry
 *  berths. */
export type Blueprint = Look & (typeof ROWS)[BuildingKind];

/** The four ways a plot can lie: which side the lot and street are on. */
export const FACINGS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** A kind that parks at the kerb before it: neither a house's drive nor a
 *  yard. Mirrors `lots::kerbed`. */
export const kerbed = (kind: BuildingKind) => kind !== "House" && BLUEPRINTS[kind].lot[1] === 0;

/** A building's tiles that face the way (dx, dy), nothing of its own
 *  beyond them, in order along that side. Mirrors `lots::side_of`. */
export function sideOf(tiles: GridCoord[], [dx, dy]: [number, number]): GridCoord[] {
  const on = (x: number, y: number) => tiles.some((t) => t.x === x && t.y === y);
  const along = (t: GridCoord) => t.x * Math.abs(dy) + t.y * Math.abs(dx);
  return tiles.filter((t) => !on(t.x + dx, t.y + dy)).sort((a, b) => along(a) - along(b));
}

interface Plot {
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

/** Does a building on these tiles hold the smallest of its kind, one way
 *  round or the other? Mirrors `World::works`. */
function works(tiles: GridCoord[], kind: BuildingKind): boolean {
  const [w, h] = plot(kind, 0).size;
  const on = (x: number, y: number) => tiles.some((t) => t.x === x && t.y === y);
  const holds = ([sw, sh]: number[]) => tiles.some((t) => Array.from({ length: sw * sh }, (_, i) => on(t.x + (i % sw), t.y + Math.floor(i / sw))).every(Boolean));
  return holds([w, h]) || holds([h, w]);
}

/** A building's yard tiles, lying this way, if its kind keeps one and it
 *  is big enough to work: the yard the server lays its lot in, drawn
 *  where the server has it. Mirrors `World::yard_of`. */
export function yardOf(tiles: GridCoord[], kind: BuildingKind, facing: number): GridCoord[] | null {
  if (!works(tiles, kind)) return null;
  const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const { lot } = lie(kind, facing, [Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1]);
  if (!lot) return null;
  const [[lx, ly], [lw, ld]] = lot;
  return tiles.filter((t) => t.x >= x0 + lx && t.x < x0 + lx + lw && t.y >= y0 + ly && t.y < y0 + ly + ld);
}

/** A harbour's gate: the middle tile of its front, the one way in, where
 *  its lane starts down to the ramp. Mirrors `World::gate_of`. */
export function gateOf(tiles: GridCoord[], kind: BuildingKind, facing: number): GridCoord | null {
  if (!works(tiles, kind)) return null;
  const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [mx, my] = [x0 + Math.floor((x1 - x0 + 1) / 2), y0 + Math.floor((y1 - y0 + 1) / 2)];
  const [dx, dy] = FACINGS[facing % 4];
  return dx === 0 ? { x: mx, y: dy < 0 ? y0 : y1 } : { x: dx < 0 ? x0 : x1, y: my };
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

const LOOKS: Record<BuildingKind, Look> = {
  Harbour: {
    label: "Harbour",
    about: "The town's door. The ferry lands settlers and pallets on its quay and takes pallets away. Built on the coast with its back to the sea, from nothing.",
    color: "#2B6CA3",
    material: "#4E6A84",
    // A quay with a crane over it: the mast, the jib, and the hook.
    glyph: "M2 19h20v3H2zM6 3h3v16H6zM9 5h12v2.5H9zM17.5 7.5h2.5v5h-2.5zM16 12.5h5.5v2.5H16z",
    shape: "box",
    heights: [0.5],
    tab: "trade",
  },
  Depot: {
    label: "Depot",
    about: "Keeps the town's goods. Its lorry fetches packages from the harbour and the makers; its two vans bring them to shops, pumps and building sites. Six jobs, six to six.",
    color: "#A0714A",
    material: "#7E6248",
    // A wide shed: the roof, a loading door and two bays.
    glyph: "M2 9.5 12 3l10 6.5V22H2zM5 12h14v2.5H5zM5 16h5v6H5zM14 16h5v6h-5z",
    shape: "box",
    heights: [0.6],
    tab: "trade",
  },
  House: {
    label: "House",
    about: "A home for two.",
    color: "#E8566F",
    material: "#B85A44",
    // A gabled roof over a body, the door cut out.
    glyph: "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z",
    shape: "gabled",
    heights: [0],
    tab: "homes",
  },
  Apartment: {
    label: "Apartment",
    about: "Homes for seven.",
    color: "#C73E5E",
    material: "#8E4A40",
    // A tall block, three floors of windows and a door.
    glyph: "M5 2h14v20H5zM8 5h3v3H8zM13 5h3v3h-3zM8 10h3v3H8zM13 10h3v3h-3zM8 15h3v3H8zM13 15h3v3h-3zM10.5 19h3v3h-3z",
    shape: "box",
    heights: [0.85, 1.15, 1.5],
    tab: "homes",
  },
  Shop: {
    label: "Shop",
    about: "Serves meals of bread, nine to six. Two jobs.",
    color: "#3B78B8",
    material: "#56708A",
    // A storefront: scalloped awning, window and door beneath.
    glyph:
      "M3 3h18l2 5.5a2.5 2.5 0 0 1-4.7 1.2A2.5 2.5 0 0 1 14.2 9.7a2.5 2.5 0 0 1-4.4 0 2.5 2.5 0 0 1-4.1 0A2.5 2.5 0 0 1 1 8.5zM4 12h16v10H4zM6 14h6v4H6zM14 14h4v8h-4z",
    shape: "box",
    heights: [0.45, 0.55],
    tab: "shops",
  },
  Office: {
    label: "Office",
    about: "Twelve jobs, eight to five.",
    color: "#2D4E7E",
    material: "#3F4D5E",
    // A briefcase, the handle cut out.
    glyph:
      "M9 3h6a1.5 1.5 0 0 1 1.5 1.5V7H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3.5V4.5A1.5 1.5 0 0 1 9 3zm.5 2v2h5V5zM2 12h20v1.5H2z",
    shape: "box",
    // Tall, and worth varying: a few towers among them is what gives a
    // business district a skyline instead of a plateau.
    heights: [1.0, 1.45, 2.3],
    tab: "work",
  },
  Factory: {
    label: "Machine works",
    about: "Builds machines of steel, for the oil wells, the refinery and the port. Twelve jobs, six to three.",
    color: "#5C6470",
    material: "#7A7F86",
    // Sawtooth roofs and a chimney.
    glyph: "M17 2h4v8.5l-4 0zM2 22V10.5l6 3v-3l6 3v-3l6 3V22zM5 16h3v3H5zM10 16h3v3h-3zM15 16h3v3h-3z",
    shape: "sawtooth",
    heights: [0],
    tab: "industry",
  },
  GasStation: {
    label: "Gas station",
    about: "Fills the town's tanks from its fuel, round the clock. One job at the kiosk, six to ten.",
    color: "#F2C230",
    material: "#C7A24E",
    // A pump: the body with its display, and the hose hooked to the side.
    glyph: "M3 2h11v20H3zM5.5 4.5h6v5h-6zM15.5 7h2.2l3.3 3.3V19a2.5 2.5 0 0 1-5 0v-1h2v1a.5.5 0 0 0 1 0v-7.9L17 9.2h-1.5z",
    shape: "box",
    heights: [0.3],
    tab: "services",
  },
  Supermarket: {
    label: "Supermarket",
    about: "Meals for a whole district, eight to nine, from big shelves of bread. Six jobs.",
    color: "#6EC1E4",
    material: "#8FA7B3",
    // A basket: handle arcs over, three slats cut out.
    glyph: "M12 2.5c3 0 5.5 2.4 6.3 5.5H21l-2 13H5L3 8h2.7C6.5 4.9 9 2.5 12 2.5zm0 2c-1.9 0-3.5 1.5-4.2 3.5h8.4C15.5 6 13.9 4.5 12 4.5zM7.5 11h1.6v6H7.5zm3.7 0h1.6v6h-1.6zm3.7 0h1.6v6h-1.6z",
    shape: "box",
    heights: [0.5],
    tab: "services",
  },
  Farm: {
    label: "Farm",
    about: "Grows grain on the grass behind it, which its tractor ploughs, sows and harvests. Four jobs, six to three.",
    color: "#D9A23B",
    material: "#B79A62",
    // A barn: the gambrel roof, the big door, and a hayloft window.
    glyph: "M12 2 21 8.5V22H3V8.5zM10.5 6.5h3v3h-3zM8 13h8v9H8zm1.6 1.6v5.8h4.8v-5.8z",
    shape: "box",
    heights: [0.4],
    tab: "work",
  },
  Sawmill: {
    label: "Sawmill",
    about: "Fells and saws the forest round it into timber. Built beside the woods. Four jobs, seven to four.",
    color: "#8A5A2B",
    material: "#7A5A3A",
    // A saw blade over a log: the teeth round, the log's rings below.
    glyph: "M12 2l1.6 2.2 2.6-.8.4 2.7 2.7.4-.8 2.6L20.7 11l-2.2 1.6.8 2.6-2.7.4-.4 2.7-2.6-.8L12 19.7l-1.6-2.2-2.6.8-.4-2.7-2.7-.4.8-2.6L3.3 11l2.2-1.6-.8-2.6 2.7-.4.4-2.7 2.6.8zm0 5.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM3 20h18v2H3z",
    shape: "box",
    heights: [0.35],
    tab: "work",
  },
  Quarry: {
    label: "Quarry",
    about: "Breaks stone from the mountain beside it. Built at the mountain's foot. Four jobs, seven to four.",
    color: "#7D7F86",
    material: "#8C8A84",
    // A rock face, benched, a pick across the heap below.
    glyph: "M2 21 8 7l3 4 4-7 7 17zM9.5 13.5l2 2.5 2-3.5 2.5 5.5h-8zM3 22h18v1H3z",
    shape: "box",
    heights: [0.3],
    tab: "work",
  },
  Lab: {
    label: "Lab",
    about: "Learns to build what the town cannot yet: tap a kind still to learn in the menu, and every lab works at it. Four at desks, eight to five.",
    color: "#4E8F8B",
    material: "#6F8C8A",
    // A flask: the neck, the round body, the liquid's line.
    glyph: "M9 2h6v2h-1v5.2l5.6 8.4A2.8 2.8 0 0 1 17.3 22H6.7a2.8 2.8 0 0 1-2.3-4.4L10 9.2V4H9zM7.4 16l-1.3 2a.9.9 0 0 0 .7 1.4h10.4a.9.9 0 0 0 .7-1.4l-1.3-2z",
    shape: "box",
    heights: [0.5],
    tab: "work",
  },
  Bakery: {
    label: "Bakery",
    about: "Bakes the farms' grain into bread for the shops, when the depot runs low. Four jobs, five to two.",
    color: "#C9772E",
    material: "#B07650",
    // A loaf, three cuts across its crust.
    glyph: "M2 19v-5C2 8.5 6.5 5 12 5s10 3.5 10 9v5zM6.6 8.6l2.6 4.2 1.3-.8-2.6-4.2zM10.8 7.4l2.6 4.2 1.3-.8-2.6-4.2zM15 8.2l2.6 4.2 1.3-.8-2.6-4.2z",
    shape: "box",
    heights: [0.4],
    tab: "work",
  },
  CementWorks: {
    label: "Cement works",
    about: "Burns stone into cement, for flats, big shops and everything heavier. Six jobs, seven to four.",
    color: "#8C969E",
    material: "#A3A6A3",
    // A kiln's silo and its stack, the shed beneath.
    glyph: "M4 22V12h5V4h5v8h2V2h3v10h1v10zM6.5 15h3v3h-3zM12 15h3v3h-3z",
    shape: "box",
    heights: [0.5],
    tab: "industry",
  },
  Mine: {
    label: "Ore mine",
    about: "Digs ore from the vein in the mountain beside it, rust in the rock. Six jobs, seven to four.",
    color: "#A24B2A",
    material: "#8A6A58",
    // A headframe over the shaft: its legs, the wheel on top.
    glyph: "M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM10.5 8h3l5 14h-3l-1.2-3.5H9.7L8.5 22h-3zm.2 7.5h2.6L12 11.8z",
    shape: "box",
    heights: [0.35],
    tab: "industry",
  },
  Colliery: {
    label: "Coal mine",
    about: "Digs coal from the seam in the mountain beside it. Six jobs, seven to four.",
    color: "#3A3A40",
    material: "#5A5A5E",
    // A mine cart heaped with coal, on its wheels.
    glyph: "M4 5l3 1.5L10 4l3 2 3-1.5 4 2.5H4zM2 9h20l-2 8H4zM7 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm10 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
    shape: "box",
    heights: [0.35],
    tab: "industry",
  },
  Steelworks: {
    label: "Steelworks",
    about: "Smelts ore with coal into steel. Built of cement. Sixteen jobs, six to three.",
    color: "#5A7FA6",
    material: "#6E7A86",
    // A blast furnace: its tapering stack, the hall, its glow.
    glyph: "M8 2h4l1 9h9v11H2V11h5zM5 15h4v4H5zM11 15h4v4h-4zM17 15h3v4h-3z",
    shape: "sawtooth",
    heights: [0],
    tab: "industry",
  },
  OilWell: {
    label: "Oil well",
    about: "Pumps crude from the oil under the grass. Two jobs, six to ten.",
    color: "#4B3A5A",
    material: "#6A5E70",
    // A pumpjack: the walking beam on its post, the horse's head nodding.
    glyph: "M2 6l14-3 .5 2.5-3.2.7L10 22H7l2.6-15.3L2.5 8.4zM17 2h3.5l1 7h-3zM4 20h16v2H4zM18.5 9h1.5v11h-1.5z",
    shape: "box",
    heights: [0.2],
    tab: "industry",
  },
  Refinery: {
    label: "Refinery",
    about: "Refines crude into fuel for the pumps and the market. Eight jobs, six to three.",
    color: "#7A4E8C",
    material: "#8A8288",
    // A column and a tank, piped together.
    glyph: "M5 2h4v20H5zM11 12h2v2h-2zM14 9a4 2 0 0 1 8 0v13h-8zM2 20h20v2H2z",
    shape: "box",
    heights: [0.9],
    tab: "industry",
  },
  Port: {
    label: "Container port",
    about: "The harbour grown: a crane on a deep quay, where the container ship berths. Built of cement, steel and machines.",
    color: "#1F4E79",
    material: "#41566B",
    // A gantry crane over a stack of boxes.
    glyph: "M3 2h3v20H3zM18 2h3v20h-3zM3 2h18v3H3zM11 5h2v4h-2zM8 9h8v3H8zM7 16h5v6H7zM12.5 16h4.5v6h-4.5zM9 13h6v3H9z",
    shape: "box",
    heights: [0.5],
    tab: "trade",
  },
};

export const BLUEPRINTS = Object.fromEntries(Object.entries(LOOKS).map(([k, look]) => [k, { ...look, ...ROWS[k as BuildingKind] }])) as Record<BuildingKind, Blueprint>;

/** Every kind the mayor may put down. */
export const KINDS = Object.keys(BLUEPRINTS) as BuildingKind[];

/**
 * Every good, as the client shows it: its name, its colour, its glyph, and
 * `box` units to a box (`Good::per_box`, `generated/rows.ts`). What it trades at is the
 * server's, a deal at a time (`Sea::offers`).
 */
const GOOD_LOOKS: Record<Good, { label: string; color: string; glyph: string }> = {
  Timber: {
    label: "timber",
    color: "#B07A3E",
    // Three logs stacked, their ends ringed.
    glyph: "M7 13.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM17 13.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM12 4.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z",
  },
  Bread: {
    label: "bread",
    color: "#E08A3C",
    // A loaf, three cuts across its crust.
    glyph: "M2 19v-5C2 8.5 6.5 5 12 5s10 3.5 10 9v5zM6.6 8.6l2.6 4.2 1.3-.8-2.6-4.2zM10.8 7.4l2.6 4.2 1.3-.8-2.6-4.2zM15 8.2l2.6 4.2 1.3-.8-2.6-4.2z",
  },
  Stone: {
    label: "stone",
    color: "#737A83",
    // A heap of broken rock, three stones on a pile.
    glyph: "M2 21l3.5-6 4 1 2.5-5 4 2 2.5 3.5L22 21zM7 9.5l3-3 3.5 1.5L12 11l-4 .5zM14.5 6.5 17 4l3 2-1 3.5-3 .5z",
  },
  Fuel: {
    label: "fuel",
    color: "#D4513B",
    // A jerrycan: its handle and spout.
    glyph: "M8 2h6v3h-6zM5 6h11l3 3v13H5zm3 5v8h8v-8zM17 2.5l3 3-1.5 1.5-3-3z",
  },
  Grain: {
    label: "grain",
    color: "#D9BE4E",
    // An ear of wheat: its kernels up the stalk.
    glyph: "M11.25 12h1.5v10h-1.5zM12 2c1.2 1 1.6 2.4 0 4.2C10.4 4.4 10.8 3 12 2zM8 6c2 .2 3.4 1.4 3.4 3.6C9.4 9.4 8 8.2 8 6zm8 0c0 2.2-1.4 3.4-3.4 3.6 0-2.2 1.4-3.4 3.4-3.6zM8 10.4c2 .2 3.4 1.4 3.4 3.6C9.4 13.8 8 12.6 8 10.4zm8 0c0 2.2-1.4 3.4-3.4 3.6 0-2.2 1.4-3.4 3.4-3.6z",
  },
  Cement: {
    label: "cement",
    color: "#9AA7B0",
    // A sack, tied at its neck.
    glyph: "M9 2h6l-1 3h-4zM8 6h8c2.5 2 4 6 4 10 0 4-2.5 6-8 6s-8-2-8-6c0-4 1.5-8 4-10z",
  },
  Ore: {
    label: "ore",
    color: "#A24B2A",
    // A lump of ore, a vein through it.
    glyph: "M7 3l8-1 6 6-1 9-7 5-9-3-2-8zM9 9l2 3 4-1 1 3-5 1-3-3z",
  },
  Coal: {
    label: "coal",
    color: "#3A3A40",
    // Three lumps in a heap.
    glyph: "M2 21l2-6 5-1 2 3 1-5 6-1 4 4 0 6zM8 6l5-2 3 3-2 3-5 1z",
  },
  Steel: {
    label: "steel",
    color: "#5A7FA6",
    // An I-beam, end on.
    glyph: "M3 3h18v4h-7v10h7v4H3v-4h7V7H3z",
  },
  Machinery: {
    label: "machines",
    color: "#3E9C8C",
    // A gear.
    glyph: "M10.5 2h3l.5 2.6 1.9.8 2.2-1.5 2.1 2.1-1.5 2.2.8 1.9 2.5.4v3l-2.6.5-.8 1.9 1.5 2.2-2.1 2.1-2.2-1.5-1.9.8-.4 2.5h-3l-.5-2.6-1.9-.8-2.2 1.5-2.1-2.1 1.5-2.2-.8-1.9L2 13.5v-3l2.6-.5.8-1.9-1.5-2.2 2.1-2.1 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  },
  Crude: {
    label: "crude",
    color: "#4B3A5A",
    // A drop of oil.
    glyph: "M12 2c3 4.5 7 8.5 7 13a7 7 0 0 1-14 0c0-4.5 4-8.5 7-13z",
  },
};
/** Each good's look, with the units a package of it holds and what one
 *  and several are called (`Good::per_package`, `Good::package`). */
export const GOODS = Object.fromEntries(Object.entries(GOOD_LOOKS).map(([g, look]) => [g, { ...look, per: PER_PACKAGE[g as Good], names: PACKAGE[g as Good] }])) as Record<Good, (typeof GOOD_LOOKS)[Good] & { per: number; names: [string, string] }>;

/** So many packages of a good, in words: "3 bundles of timber". */
export const packages = (g: Good, n: number) => `${n} ${GOODS[g].names[n === 1 ? 0 : 1]}`;
