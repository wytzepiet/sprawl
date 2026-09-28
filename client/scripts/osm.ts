/**
 * A real place as a fixture town: OpenStreetMap's streets, buildings,
 * water and woods, laid on the game's grid, one character a tile.
 *
 *   bun run osm <name> <south>,<west>,<north>,<east>     fetch from Overpass
 *   bun run osm <name> @<lat>,<lon>,<w>,<h>              the same, by its middle and size in tiles
 *   bun run osm <name> <file.json>                       an Overpass answer saved earlier
 *
 * writes `server/fixtures/<name>.txt` (the key is in `server/src/fixtures.rs`).
 * A saved answer is what `https://overpass-api.de/api/interpreter` returns
 * for the query below with `out geom`; `--query s,w,n,e` prints that query,
 * to paste into overpass-turbo.eu or fetch by hand.
 *
 * What becomes what:
 * - A tile is twelve metres, the game's. Top row north.
 * - Main roads (`primary` to `tertiary`) are `#`, the rest a car can use
 *   (`residential`, `unclassified`, `living_street`, `pedestrian`) `=`.
 *   Service roads, paths and tracks are left out: at this scale they are
 *   driveways and noise.
 * - Water is `~`, woods `T`; parks and the rest stay grass.
 * - A building is what its tags, or a shop or café inside it, say. Homes
 *   that are small or low are houses, and a house covers every tile its
 *   footprint covers, so a terrace comes out as a row; the rest are
 *   apartments. Anything else is one letter at its middle, and the server
 *   seats it on the nearest street, as the mayor's hand would.
 * - Garages, sheds, churches and the like are left out.
 *
 * `OVERPASS=<url>` asks a mirror instead, such as
 * `https://overpass.kumi.systems/api/interpreter`, when the main one is busy.
 *
 * Map data © OpenStreetMap contributors, ODbL; the fixture says so.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TILE = 12;

type LatLon = { lat: number; lon: number };
type Tags = Record<string, string>;
type Element =
  | { type: "node"; lat: number; lon: number; tags?: Tags }
  | { type: "way"; geometry: LatLon[]; tags?: Tags }
  | { type: "relation"; tags?: Tags; members: { type: string; role: string; geometry?: LatLon[] }[] };

const query = ([s, w, n, e]: number[]) => `[out:json][timeout:90][bbox:${s},${w},${n},${e}];
(
  way[highway~"^(primary|secondary|tertiary|primary_link|secondary_link|tertiary_link|residential|unclassified|living_street|pedestrian)$"];
  way[building]; relation[building];
  way[natural~"^(water|wood)$"]; relation[natural~"^(water|wood)$"];
  way[landuse~"^(forest|basin|reservoir)$"]; relation[landuse~"^(forest|basin|reservoir)$"];
  way[waterway=riverbank]; relation[waterway=riverbank];
  node[shop]; node[amenity]; node[office]; node[craft];
);
out geom;`;

const [name, where] = process.argv.slice(2).filter((a) => a !== "--query");
if (!name || !where) {
  console.error("usage: bun run osm <name> <south,west,north,east | @lat,lon,w,h | saved.json>   (--query prints the query)");
  process.exit(1);
}
const box = where.endsWith(".json") ? null : where.startsWith("@") ? around(where.slice(1).split(",").map(Number)) : where.split(",").map(Number);
if (process.argv.includes("--query")) {
  console.log(query(box!));
  process.exit(0);
}

/** A box by its middle and its size in tiles. */
function around([lat, lon, w, h]: number[]) {
  const dLat = (h * TILE) / 111_320 / 2, dLon = (w * TILE) / (111_320 * Math.cos((lat * Math.PI) / 180)) / 2;
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => +v.toFixed(5));
}
const answer: { elements: Element[]; bbox?: number[] } = box ? await overpass(box) : await Bun.file(where).json();

/** Ask Overpass, which is shared and busy: a refusal is tried again a few
 *  times, further apart, before it is given up on. */
async function overpass(box: number[]) {
  for (let wait = 5; ; wait *= 2) {
    const r = await fetch(process.env.OVERPASS ?? "https://overpass-api.de/api/interpreter", {
      method: "POST",
      // Overpass turns away a request that does not say who it is.
      headers: { "User-Agent": "sprawl-fixtures (github.com/wytzepiet/sprawl)" },
      body: new URLSearchParams({ data: query(box) }),
    });
    if (r.ok) return r.json();
    if (wait > 40) throw new Error(`Overpass answered ${r.status}; try again later, or save the --query answer and pass the file`);
    console.error(`Overpass answered ${r.status}; again in ${wait} s`);
    await Bun.sleep(wait * 1000);
  }
}
const [south, west, north, east] = box ?? answer.bbox ?? bounds(answer.elements);

// --- The grid ---------------------------------------------------------------

/** Metres east and south of the north-west corner. */
const mPerLat = 111_320;
const mPerLon = 111_320 * Math.cos(((south + north) / 2) * (Math.PI / 180));
const place = ({ lat, lon }: LatLon): [number, number] => [(lon - west) * mPerLon, (north - lat) * mPerLat];
const W = Math.round(((east - west) * mPerLon) / TILE);
const H = Math.round(((north - south) * mPerLat) / TILE);
const grid = Array.from({ length: H }, () => Array<string>(W).fill("."));
const inGrid = (c: number, r: number) => c >= 0 && r >= 0 && c < W && r < H;
const set = (c: number, r: number, ch: string) => inGrid(c, r) && (grid[r][c] = ch);

/** A ring as tile coordinates, in tiles. */
const inTiles = (ring: LatLon[]) => ring.map((p) => place(p).map((m) => m / TILE) as [number, number]);

function inside([x, y]: [number, number], ring: [number, number][]) {
  let on = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}

/** The tiles whose middles a ring holds. */
function tilesIn(ring: [number, number][]): [number, number][] {
  const xs = ring.map(([x]) => x), ys = ring.map(([, y]) => y);
  const out: [number, number][] = [];
  for (let r = Math.max(0, Math.floor(Math.min(...ys))); r <= Math.min(H - 1, Math.ceil(Math.max(...ys))); r++) {
    for (let c = Math.max(0, Math.floor(Math.min(...xs))); c <= Math.min(W - 1, Math.ceil(Math.max(...xs))); c++) {
      if (inside([c + 0.5, r + 0.5], ring)) out.push([c, r]);
    }
  }
  return out;
}

/** A multipolygon's outer ways joined end to end into rings. */
function rings(e: Element): LatLon[][] {
  if (e.type === "way") return [e.geometry];
  if (e.type !== "relation") return [];
  const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;
  const open = e.members.filter((m) => m.type === "way" && m.role === "outer" && m.geometry).map((m) => [...m.geometry!]);
  const done: LatLon[][] = [];
  while (open.length) {
    const ring = open.pop()!;
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]); ) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const end = ring[ring.length - 1];
        const joined = same(w[0], end) ? w : same(w[w.length - 1], end) ? [...w].reverse() : null;
        if (!joined) continue;
        ring.push(...joined.slice(1));
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    done.push(ring);
  }
  return done;
}

// --- Ground -----------------------------------------------------------------

const tagged = (e: Element) => e.tags ?? {};
const isWater = (t: Tags) => t.natural === "water" || t.waterway === "riverbank" || t.landuse === "basin" || t.landuse === "reservoir";
const isWood = (t: Tags) => t.natural === "wood" || t.landuse === "forest";
for (const [test, ch] of [[isWood, "T"], [isWater, "~"]] as const) {
  for (const e of answer.elements) {
    if (!test(tagged(e))) continue;
    for (const ring of rings(e)) for (const [c, r] of tilesIn(inTiles(ring))) set(c, r, ch);
  }
}

// --- Buildings --------------------------------------------------------------

/** What a set of tags asks for, if a place of business. An industrial
 *  building is graded by size: the Dutch register calls every backyard
 *  shed industrial. */
function trade(t: Tags, m2: number): string | null {
  if (t.shop === "supermarket") return "M";
  if (t.amenity === "fuel") return "G";
  if (["restaurant", "cafe", "fast_food", "ice_cream"].includes(t.amenity)) return "R";
  if (["bar", "pub", "biergarten", "nightclub"].includes(t.amenity)) return "B";
  if (t.shop) return "S";
  if (t.office || t.building === "office") return "O";
  if (t.craft) return "W";
  if (["industrial", "manufacture"].includes(t.building)) return m2 < 150 ? "" : m2 < 800 ? "W" : "F";
  if (["warehouse", "storage_tank"].includes(t.building)) return m2 < 400 ? "" : "D";
  if (["retail", "commercial", "supermarket", "kiosk"].includes(t.building)) return "S";
  return null;
}

const SKIP = new Set(["garage", "garages", "shed", "roof", "hut", "carport", "church", "chapel", "cathedral", "school", "hospital",
  "university", "public", "civic", "train_station", "transportation", "service", "greenhouse", "barn", "farm_auxiliary", "stable",
  "bunker", "ruins", "construction", "toilets", "parking", "boathouse"]);
const HOMES = new Set(["house", "detached", "semidetached_house", "terrace", "bungalow", "residential", "yes", "apartments", "farm", "dormitory"]);

const pois = answer.elements.filter((e): e is Extract<Element, { type: "node" }> => e.type === "node" && !!e.tags);
const area = (ring: [number, number][]) =>
  Math.abs(ring.reduce((a, [x, y], i) => a + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0) / 2) * TILE * TILE;

for (const e of answer.elements) {
  const t = tagged(e);
  if (!t.building || SKIP.has(t.building) || t.amenity === "place_of_worship") continue;
  for (const ring of rings(e).map(inTiles)) {
    const inner = pois.filter((p) => inside(place(p).map((m) => m / TILE) as [number, number], ring)).map((p) => p.tags!);
    const m2 = area(ring);
    const kind = [...inner, t].map((x) => trade(x, m2)).find((k) => k !== null) ?? (HOMES.has(t.building) ? null : undefined);
    if (kind === undefined || kind === "") continue;
    const tiles = tilesIn(ring);
    const levels = Number(t["building:levels"] ?? 0);
    // Upstairs-downstairs flats in a row are a terrace at this scale: a
    // block of flats is tall or big.
    const flats = levels >= 4 || m2 > (t.building === "apartments" ? 250 : 600);
    if (kind === null && !flats) {
      // A house on every tile it covers: a terrace is a row of them.
      for (const [c, r] of tiles.length ? tiles : [middle(ring)]) if (grid[r]?.[c] === ".") set(c, r, "H");
      continue;
    }
    const [c, r] = middle(ring);
    if (grid[r]?.[c] === "." || grid[r]?.[c] === "H") set(c, r, kind ?? "A");
  }
}

function middle(ring: [number, number][]): [number, number] {
  const n = ring.length - (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  const [x, y] = ring.slice(0, n).reduce(([a, b], [x, y]) => [a + x / n, b + y / n], [0, 0]);
  return [Math.floor(x), Math.floor(y)];
}

// --- Roads, last: a road crosses water on a bridge and nothing stands on it -

const MAIN = /^(primary|secondary|tertiary)(_link)?$/;
for (const e of answer.elements) {
  if (e.type !== "way" || !e.tags?.highway || e.tags.area === "yes") continue;
  const ch = MAIN.test(e.tags.highway) ? "#" : "=";
  const pts = inTiles(e.geometry).map(([x, y]) => [Math.floor(x), Math.floor(y)]);
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i], pts[i + 1], ch);
}

/** Bresenham between two tiles: a line one tile thick that steps on the
 *  diagonal, which the fixtures lay as a diagonal street. */
function line([c0, r0]: number[], [c1, r1]: number[], ch: string) {
  const [dc, dr] = [Math.abs(c1 - c0), -Math.abs(r1 - r0)];
  const [sc, sr] = [c0 < c1 ? 1 : -1, r0 < r1 ? 1 : -1];
  for (let err = dc + dr; ; ) {
    if (grid[r0]?.[c0] !== "#") set(c0, r0, ch);
    if (c0 === c1 && r0 === r1) return;
    const e2 = 2 * err;
    if (e2 >= dr) (err += dr), (c0 += sc);
    if (e2 <= dc) (err += dc), (r0 += sr);
  }
}

function bounds(elements: Element[]): number[] {
  const pts = elements.flatMap((e) => (e.type === "node" ? [e] : e.type === "way" ? e.geometry : e.members.flatMap((m) => m.geometry ?? [])));
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}

// --- Out ------------------------------------------------------------------

// A border of grass, so no row starts with `#`, which would read as a note.
const rows = ["." + ".".repeat(W) + ".", ...grid.map((r) => "." + r.join("") + "."), "." + ".".repeat(W) + "."];
const title = process.env.TITLE ?? name;
const text = `# ${title}\n# ${south},${west},${north},${east}, from OpenStreetMap. Map data © OpenStreetMap contributors, ODbL.\n${rows.join("\n")}\n`;
const out = resolve(import.meta.dir, `../../server/fixtures/${name}.txt`);
writeFileSync(out, text);
const count = (ch: string) => rows.join("").split(ch).length - 1;
console.log(`${out}: ${W + 2}×${H + 2} tiles, ${count("H")} houses, ${count("A")} apartments, ${"SORBGMWFD".split("").reduce((a, c) => a + count(c), 0)} other buildings`);
