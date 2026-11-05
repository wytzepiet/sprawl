import { ROWS } from "./generated/rows";
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
  House: {
    label: "House",
    about: "A family. It wants fish, and as it grows bread, furniture and clothes, and drives to the nearest shop for them; kept waiting too long, it leaves. Fed well, it grows: given planks it becomes a house, bricks a townhouse, glass an apartment.",
    color: "#E8566F",
    material: "#B85A44",
    glyph: "M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z",
    shape: "gabled",
    heights: [0],
  },
  Shop: {
    label: "Shop",
    about: "Families buy here what the makers make. Its two lorries fetch each good the town eats from the nearest maker that has it, so the shelf is never far behind.",
    color: "#D9A02B",
    material: "#B8743A",
    glyph: "M2 3h20l1.5 6.5c0 1.6-1.3 2.8-2.9 2.8-1.5 0-2.7-1-2.9-2.4-.3 1.4-1.5 2.4-2.9 2.4S12.3 11.3 12 9.9c-.3 1.4-1.5 2.4-2.9 2.4S6.5 11.3 6.2 9.9c-.2 1.4-1.4 2.4-2.9 2.4C1.8 12.3.5 11.1.5 9.5zM3.5 14h17v8h-17zm3 2v6h4v-6zm7 0v3.5h4V16z",
    shape: "box",
    heights: [0.45],
  },
  Fishery: {
    label: "Fishery",
    about: "On the shore, its back to the water: two boats bring in fish while its crew is at work.",
    color: "#2B8CB8",
    material: "#4E6A84",
    glyph: "M2 12c3-4 7-6 11-6 3 0 6 1.5 9 4-3 2.5-6 4-9 4-4 0-8-2-11-6l-2 3V9zM16 9.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM2 19h20v2.5H2z",
    shape: "box",
    heights: [0.45],
  },
  Woodcutter: {
    label: "Woodcutter",
    about: "Fells the forest round it into logs. It needs trees within reach.",
    color: "#5E8C3A",
    material: "#6B5034",
    glyph: "M12 1.5 5 10h3l-4 6h6v6h4v-6h6l-4-6h3z",
    shape: "gabled",
    heights: [0],
  },
  Sawmill: {
    label: "Sawmill",
    about: "Saws logs into planks. Its lorry fetches the logs. Loud: no house near it grows.",
    color: "#B07A3E",
    material: "#7E6248",
    glyph: "M2 9h20v13H2zM2 9l5-6h10l5 6zM5 12h14v2.5H5zM12 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    shape: "box",
    heights: [0.6],
  },
  Farm: {
    label: "Farm",
    about: "Claims the grass behind it as fields, and its tractor ploughs, sows and harvests wheat.",
    color: "#C9A93A",
    material: "#9A7B4A",
    glyph: "M3 22V11l9-7 9 7v11h-6v-6H9v6zM10.5 8.5h3v3h-3z",
    shape: "gabled",
    heights: [0],
  },
  Bakery: {
    label: "Bakery",
    about: "Bakes bread from wheat. Its lorry fetches the wheat.",
    color: "#E08A3C",
    material: "#B85A44",
    glyph: "M2 19v-5C2 8.5 6.5 5 12 5s10 3.5 10 9v5zM6.6 8.6l2.6 4.2 1.3-.8-2.6-4.2zM10.8 7.4l2.6 4.2 1.3-.8-2.6-4.2zM15 8.2l2.6 4.2 1.3-.8-2.6-4.2z",
    shape: "gabled",
    heights: [0],
  },
  ClayPit: {
    label: "Clay pit",
    about: "Digs clay out of the ochre ground. Put it on the ochre.",
    color: "#C0703A",
    material: "#A86A3E",
    glyph: "M2 21l3-9h14l3 9zM6 9.5 9 3h6l3 6.5z",
    shape: "box",
    heights: [0.15],
  },
  Brickworks: {
    label: "Brickworks",
    about: "Fires clay into bricks, burning logs. Loud: no house near it grows.",
    color: "#A8452E",
    material: "#8E4A40",
    glyph: "M3 22V8h5V2h3v6h10v14zM6 12h5v3H6zm7 0h5v3h-5zM6 17h5v3H6zm7 0h5v3h-5z",
    shape: "box",
    heights: [0.7],
  },
  Workshop: {
    label: "Workshop",
    about: "Makes furniture of planks. Loud: no house near it grows.",
    color: "#8A5A9E",
    material: "#6B5A7E",
    glyph: "M4 10h16v3H4zM5 13h2.5v9H5zm11.5 0H19v9h-2.5zM6 3h12v6H6z",
    shape: "gabled",
    heights: [0],
  },
  SandPit: {
    label: "Sand pit",
    about: "Digs sand where the land meets the sea.",
    color: "#D8C27A",
    material: "#C4AE72",
    glyph: "M2 21c4-6 7-9 10-9s6 3 10 9zM12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    shape: "box",
    heights: [0.15],
  },
  Glassworks: {
    label: "Glassworks",
    about: "Melts sand into glass, burning logs. Loud: no house near it grows.",
    color: "#4FA3A5",
    material: "#5A7F86",
    glyph: "M7 2h10v4l-3 4v10h3v2H7v-2h3V10L7 6z",
    shape: "box",
    heights: [0.7],
  },
  SheepFarm: {
    label: "Sheep farm",
    about: "Keeps sheep on the grass round it, and shears them for wool.",
    color: "#B8B2A0",
    material: "#8A8272",
    glyph: "M7 8a5 5 0 0 1 10 0 4 4 0 0 1 1.5 7.7V20h-2v-4h-9v4h-2v-4.3A4 4 0 0 1 7 8z",
    shape: "gabled",
    heights: [0],
  },
  Tailor: {
    label: "Tailor",
    about: "Sews clothes of wool.",
    color: "#C24D7A",
    material: "#8E4A60",
    glyph: "M8 2l4 3 4-3 6 4-3 4-2-1v13H7V9l-2 1-3-4z",
    shape: "gabled",
    heights: [0],
  },
};

export const BLUEPRINTS = Object.fromEntries(Object.entries(LOOKS).map(([k, look]) => [k, { ...look, ...ROWS[k as BuildingKind] }])) as Record<BuildingKind, Blueprint>;

/** Every kind the mayor may put down. */
export const KINDS = Object.keys(BLUEPRINTS) as BuildingKind[];

/** Every good, as the client shows it: its name, its colour, its glyph. */
export const GOODS: Record<Good, { label: string; color: string; glyph: string }> = {
  Fish: { label: "fish", color: "#3B8FC4", glyph: "M2 12c3-4 7-6 11-6 3 0 6 1.5 9 4-3 2.5-6 4-9 4-4 0-8-2-11-6l-2 3V9zM16 9.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z" },
  Logs: { label: "logs", color: "#8A5A2E", glyph: "M7 13.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM17 13.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM12 4.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z" },
  Planks: { label: "planks", color: "#C9944E", glyph: "M2 5h20v4H2zM2 10.5h20v4H2zM2 16h20v4H2z" },
  Wheat: { label: "wheat", color: "#D9BE4E", glyph: "M11.25 12h1.5v10h-1.5zM12 2c1.2 1 1.6 2.4 0 4.2C10.4 4.4 10.8 3 12 2zM8 6c2 .2 3.4 1.4 3.4 3.6C9.4 9.4 8 8.2 8 6zm8 0c0 2.2-1.4 3.4-3.4 3.6 0-2.2 1.4-3.4 3.4-3.6zM8 10.4c2 .2 3.4 1.4 3.4 3.6C9.4 13.8 8 12.6 8 10.4zm8 0c0 2.2-1.4 3.4-3.4 3.6 0-2.2 1.4-3.4 3.4-3.6z" },
  Bread: { label: "bread", color: "#E08A3C", glyph: "M2 19v-5C2 8.5 6.5 5 12 5s10 3.5 10 9v5zM6.6 8.6l2.6 4.2 1.3-.8-2.6-4.2zM10.8 7.4l2.6 4.2 1.3-.8-2.6-4.2zM15 8.2l2.6 4.2 1.3-.8-2.6-4.2z" },
  Clay: { label: "clay", color: "#C0703A", glyph: "M3 20c0-5 4-10 9-10s9 5 9 10zM9 4h6v4H9z" },
  Bricks: { label: "bricks", color: "#B04A32", glyph: "M2 5h9v4H2zm11 0h9v4h-9zM2 10.5h4v4H2zm6 0h9v4H8zm11 0h3v4h-3zM2 16h9v4H2zm11 0h9v4h-9z" },
  Furniture: { label: "furniture", color: "#8A5A9E", glyph: "M4 10h16v3H4zM5 13h2.5v9H5zm11.5 0H19v9h-2.5zM6 3h12v6H6z" },
  Sand: { label: "sand", color: "#D8C27A", glyph: "M2 21c4-6 7-9 10-9s6 3 10 9z" },
  Glass: { label: "glass", color: "#4FA3A5", glyph: "M7 2h10v4l-3 4v10h3v2H7v-2h3V10L7 6z" },
  Wool: { label: "wool", color: "#B8B2A0", glyph: "M12 3a5 5 0 0 1 4.6 3A5 5 0 0 1 20 15a5 5 0 0 1-8 4 5 5 0 0 1-8-4 5 5 0 0 1 3.4-9A5 5 0 0 1 12 3z" },
  Clothes: { label: "clothes", color: "#C24D7A", glyph: "M8 2l4 3 4-3 6 4-3 4-2-1v13H7V9l-2 1-3-4z" },
};
