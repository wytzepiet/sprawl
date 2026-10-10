import { BLUEPRINTS, GOODS, middle } from "../blueprints";
import { themes, type Theme } from "../engine/theme";
import { CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, TYPE_BY_BYTE } from "../engine/objects/terrainGeometry";
import { CAB, CAR, ROAD_WIDTH, TRAILER, VAN } from "../engine/objects/roadGeometry";
import { FERRY, deckPose, hull, TUG } from "../engine/objects/sea";
import { colourOf, LIVERY, moment, PALETTE, type Moment } from "../engine/objects/motion";
import type { Rgb } from "../engine/rgb";
import type { Building, Car, Draft, GameObjectEntry, RoadNode, TerrainType, Trailer } from "../generated";
import type { Pose as Stand } from "../generated/Pose";

/**
 * The game drawn flat, on a 2D canvas: the browser's (the minimap) or
 * `@napi-rs/canvas`'s in a script (`bun run flat`), from the same state the
 * 3D view draws, its vehicles placed by the same code (`motion.ts`). For
 * reading, not for looking at: every kind of thing its own plain shape and
 * colour, boxes by their good, and, close enough, ids beside things.
 *
 * World to screen is a half turn, as the camera has it: +x to the left,
 * +y up.
 */

/** What is drawn: the entities, as the client holds them; the ground, a
 *  chunk's tiles as the server sends them (`TerrainChunk.tiles`); the
 *  server's clock. */
export interface World {
  entities(each: (e: GameObjectEntry) => void): void;
  /** Every player's draft, and whose ours is: ours blue, a step stuck
   *  amber, anyone else's grey; with no `me`, every draft is ours. */
  drafts?: Draft[];
  me?: number;
  ground(cx: number, cy: number): Uint8Array | undefined;
  now: number;
  dayMs: number;
}

/** Where the view is: its middle in tiles, pixels to a tile, its size in
 *  pixels. */
export interface View {
  x: number;
  y: number;
  px: number;
  w: number;
  h: number;
}

/** A canvas to cache a chunk's ground in, as the caller's world makes one. */
export type Sheet = (w: number, h: number) => { getContext(kind: "2d"): CanvasRenderingContext2D | null };

const ground = new WeakMap<Uint8Array, unknown>();

const css = (c: Rgb, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
const INK = "#1d2330";
const RED = "#d23c32";

function terrainColour(t: Theme): Record<TerrainType, Rgb> {
  return { Sea: t.water, Water: t.water, Beach: t.beach, Grass: t.land, Forest: t.forest, Mountain: t.rock };
}

/** A chunk's ground, a pixel a tile, made once for its tiles. */
function chunkImage(tiles: Uint8Array, sheet: Sheet, theme: Theme): unknown {
  let image = ground.get(tiles);
  if (image) return image;
  const canvas = sheet(CHUNK_SIZE, CHUNK_SIZE);
  const g = canvas.getContext("2d")!;
  const data = g.createImageData(CHUNK_SIZE, CHUNK_SIZE);
  const colours = terrainColour(theme);
  for (let iy = 0; iy < CHUNK_SIZE; iy++)
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      const kind = TYPE_BY_BYTE[tiles[(iy + CHUNK_SKIRT) * CHUNK_STRIDE + ix + CHUNK_SKIRT]];
      if (!kind) continue;
      const c = colours[kind], k = (iy * CHUNK_SIZE + ix) * 4;
      [data.data[k], data.data[k + 1], data.data[k + 2], data.data[k + 3]] = [c.r * 255, c.g * 255, c.b * 255, 255];
    }
  g.putImageData(data, 0, 0);
  ground.set(tiles, canvas);
  return canvas;
}

/**
 * Draw the world into `g`, `view.w` by `view.h` pixels. `labels` adds ids
 * and a legend; without, it is the minimap's picture.
 */
export function drawFlat(g: CanvasRenderingContext2D, world: World, view: View, sheet: Sheet, { labels = true, theme = themes.light } = {}) {
  const S = view.px;
  const [x0, x1] = [view.x - view.w / 2 / S, view.x + view.w / 2 / S];
  const [y0, y1] = [view.y - view.h / 2 / S, view.y + view.h / 2 / S];
  const on = (x: number, y: number, m = 2) => x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;
  const screen = (x: number, y: number): [number, number] => [view.w / 2 - (x - view.x) * S, view.h / 2 - (y - view.y) * S];
  const world_ = () => g.setTransform(-S, 0, 0, -S, view.w / 2 + view.x * S, view.h / 2 + view.y * S);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = css(theme.water);
  g.fillRect(0, 0, view.w, view.h);
  world_();

  // The ground, a chunk an image, crisp.
  g.imageSmoothingEnabled = false;
  for (let cy = Math.floor(y0 / CHUNK_SIZE); cy <= Math.floor(y1 / CHUNK_SIZE); cy++)
    for (let cx = Math.floor(x0 / CHUNK_SIZE); cx <= Math.floor(x1 / CHUNK_SIZE); cx++) {
      const tiles = world.ground(cx, cy);
      if (tiles) g.drawImage(chunkImage(tiles, sheet, theme) as CanvasImageSource, cx * CHUNK_SIZE, cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    }

  const byId = new Map<number, GameObjectEntry>();
  const buildings: [GameObjectEntry, Building][] = [];
  const roads: [GameObjectEntry, RoadNode][] = [];
  const cars: [GameObjectEntry, Car][] = [];
  world.entities((e) => {
    byId.set(e.id, e);
    const o = e.object;
    if (o.kind === "Building") buildings.push([e, o.data]);
    else if (o.kind === "RoadNode" && e.position) roads.push([e, o.data]);
    else if (o.kind === "Car") cars.push([e, o.data]);
  });

  // A farm's land by where it is in its season.
  for (const [, b] of buildings)
    for (const t of b.land) {
      if (t.stage === "Grass" || !on(t.at.x, t.at.y)) continue;
      const ripe = world.now - t.since >= world.dayMs;
      g.fillStyle = css(t.stage === "Ploughed" ? theme.earth : t.stage === "Cut" ? theme.stubble : ripe ? theme.ripe : theme.growing);
      g.fillRect(t.at.x, t.at.y, 1, 1);
    }

  // Roads: from each node's middle to each it leads to, as wide as a
  // road; a one-way's arrow; a network no harbour reaches, red.
  g.lineCap = "round";
  g.lineWidth = ROAD_WIDTH;
  const mid = (e: GameObjectEntry): [number, number] => [e.position!.x + 0.5, e.position!.y + 0.5];
  for (const [e, n] of roads) {
    if (!on(e.position!.x, e.position!.y)) continue;
    g.strokeStyle = !n.joined ? RED : css(n.road ? theme.highway : theme.road);
    const [ax, ay] = mid(e);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(ax, ay);
    for (const id of n.outgoing) {
      const to = byId.get(id);
      if (!to?.position) continue;
      g.moveTo(ax, ay);
      g.lineTo(...mid(to));
    }
    g.stroke();
  }
  for (const [e, n] of roads) {
    if (!on(e.position!.x, e.position!.y)) continue;
    for (const id of n.outgoing) {
      const to = byId.get(id);
      if (!to?.position || (to.object.data as RoadNode).outgoing.includes(e.id)) continue;
      const [[ax, ay], [bx, by]] = [mid(e), mid(to)];
      arrow(g, (ax + bx) / 2, (ay + by) / 2, Math.atan2(by - ay, bx - ax), 0.12, "#f4f1ea");
    }
  }

  // Buildings: their tiles in their kind's colour, outlined; a site an
  // outline, filled from the bottom as its timber comes; the drive from
  // the street to the door.
  for (const [, b] of buildings) {
    if (!b.tiles.some((t) => on(t.x, t.y))) continue;
    const colour = BLUEPRINTS[b.kind].color;
    if (b.door) {
      g.strokeStyle = css(theme.road);
      g.lineWidth = ROAD_WIDTH / 2;
      g.beginPath();
      g.moveTo(b.door.street.x + 0.5, b.door.street.y + 0.5);
      g.lineTo(b.door.tile.x + 0.5, b.door.tile.y + 0.5);
      g.stroke();
    }
    const share = b.site ? b.site.level / Math.max(1, b.site.cap) : 1;
    g.fillStyle = colour;
    g.globalAlpha = b.site ? 0.15 : 0.55;
    for (const t of b.tiles) g.fillRect(t.x, t.y, 1, 1);
    if (b.site && share > 0) {
      // From the low edge on the screen, which is the high y.
      const top = Math.max(...b.tiles.map((t) => t.y)) + 1, low = Math.min(...b.tiles.map((t) => t.y));
      const cut = top - (top - low) * share;
      g.globalAlpha = 0.55;
      for (const t of b.tiles) if (t.y + 1 > cut) g.fillRect(t.x, Math.max(t.y, cut), 1, t.y + 1 - Math.max(t.y, cut));
    }
    g.globalAlpha = 1;
    outline(g, b.tiles, colour, 0.06, b.site ? [0.15, 0.1] : []);
    // A harbour's park: each dock, and the box standing there.
    for (const slot of b.park) {
      dock(g, slot.pose);
      if (slot.trailer) box(g, slot.pose, slot.trailer);
    }
  }

  // Drafts, over what stands (docs/game.md §Drafts): a drafted road a
  // band, a drafted building its tile, each look in one stroke so a draft
  // reads as one shape; what is drafted to come down, red over it.
  const drafted = { mine: "#2f7bf0", stuck: "#e39220", theirs: "#7f8898", doomed: RED };
  const bands = new Map<string, [number, number, number, number][]>();
  const tiles = new Map<string, [number, number][]>();
  const at = new Map<string, Building>();
  for (const [, b] of buildings) for (const t of b.tiles) at.set(`${t.x},${t.y}`, b);
  const road = new Set(roads.map(([e]) => `${e.position!.x},${e.position!.y}`));
  const put = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const d of world.drafts ?? [])
    for (const { step, stuck } of d.strokes.flat()) {
      const { tool, from, to } = step;
      const look = world.me !== undefined && d.owner !== world.me ? "theirs" : stuck ? "stuck" : "mine";
      if (tool === "Demolish") {
        if (look === "theirs") continue;
        const b = at.get(`${to.x},${to.y}`);
        if (from.x !== to.x || from.y !== to.y) put(bands, "doomed", [from.x + 0.5, from.y + 0.5, to.x + 0.5, to.y + 0.5]);
        else if (b) for (const t of b.tiles) put(tiles, "doomed", [t.x, t.y]);
        else if (road.has(`${to.x},${to.y}`)) put(tiles, "doomed", [to.x, to.y]);
      } else if (typeof tool === "string") put(bands, look, [from.x + 0.5, from.y + 0.5, to.x + 0.5, to.y + 0.5]);
      else put(tiles, look, [to.x, to.y]);
    }
  g.globalAlpha = 0.5;
  g.lineWidth = ROAD_WIDTH;
  for (const [look, segs] of bands) {
    g.strokeStyle = drafted[look as keyof typeof drafted];
    g.beginPath();
    for (const [ax, ay, bx, by] of segs) g.moveTo(ax, ay), g.lineTo(bx, by);
    g.stroke();
  }
  for (const [look, ts] of tiles) {
    g.fillStyle = drafted[look as keyof typeof drafted];
    g.beginPath();
    for (const [x, y] of ts) g.rect(x + 0.04, y + 0.04, 0.92, 0.92);
    g.fill();
  }
  g.globalAlpha = 1;

  // Vehicles where the server's clock has them now.
  const moments: [GameObjectEntry, Car, Moment][] = [];
  for (const [e, car] of cars) {
    const m = moment(e.id, car, world.now, byId.get(car.owner)?.position);
    if (m && on(m.body.at[0], m.body.at[1], 4)) moments.push([e, car, m]);
  }
  // Ships under what drives on land, which drives under the tug.
  const order = (c: Car) => (c.role === "Ferry" ? 0 : c.role === "Tug" ? 2 : 1);
  moments.sort((a, b) => order(a[1]) - order(b[1]));
  const dot = S < 6;
  for (const [e, car, m] of moments) {
    if (dot) {
      g.fillStyle = car.role === "Ferry" ? "#ffffff" : car.role === "Truck" ? css(LIVERY.cab) : INK;
      const r = (car.role === "Ferry" ? 1.2 : 0.4) * Math.max(1, 2 / S);
      g.fillRect(m.body.at[0] - r, m.body.at[1] - r, 2 * r, 2 * r);
      continue;
    }
    vehicle(g, e.id, car, m);
  }

  if (!labels) return;

  // Labels, upright, in pixels: buildings' kinds and ids; vehicles' ids,
  // close enough to read; what each ferry has aboard.
  g.setTransform(1, 0, 0, 1, 0, 0);
  const text = (s: string, x: number, y: number, size: number, colour = INK, align: CanvasTextAlign = "center") => {
    g.font = `${size}px sans-serif`;
    g.textAlign = align;
    g.textBaseline = "middle";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.strokeText(s, x, y);
    g.fillStyle = colour;
    g.fillText(s, x, y);
  };
  if (S >= 12)
    for (const [e, b] of buildings) {
      const [mx, my] = middle(b);
      if (!on(mx, my, 0)) continue;
      const [sx, sy] = screen(mx, my);
      text(`${BLUEPRINTS[b.kind].label} #${e.id}`, sx, sy, 11);
      if (b.site) text(`site ${Math.floor(b.site.level)}/${b.site.cap} timber`, sx, sy + 12, 10, "#553");
    }
  if (S >= 20)
    for (const [e, car, m] of moments) {
      const [sx, sy] = screen(m.body.at[0], m.body.at[1]);
      if (car.role === "Ferry") text(`ferry #${e.id}`, sx, sy - FERRY.w * S * 0.5 - 8, 11);
      else text(`${e.id}`, sx, sy - 9, 9, "#334");
    }
  grid(g, view, x0, x1, y0, y1, screen);
  legend(g, world, cars, byId, view.h);
}

/** An arrow at (x, y) pointing along `angle`, `size` long. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, colour: string) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = colour;
  g.beginPath();
  g.moveTo(size, 0);
  g.lineTo(-size, size * 0.8);
  g.lineTo(-size, -size * 0.8);
  g.closePath();
  g.fill();
  g.restore();
}

/** The outline round some tiles: each tile's edge with no tile beyond. */
function outline(g: CanvasRenderingContext2D, tiles: { x: number; y: number }[], colour: string, width: number, dash: number[]) {
  const has = new Set(tiles.map((t) => `${t.x},${t.y}`));
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.setLineDash(dash);
  g.beginPath();
  for (const { x, y } of tiles) {
    if (!has.has(`${x},${y - 1}`)) g.moveTo(x, y), g.lineTo(x + 1, y);
    if (!has.has(`${x},${y + 1}`)) g.moveTo(x, y + 1), g.lineTo(x + 1, y + 1);
    if (!has.has(`${x - 1},${y}`)) g.moveTo(x, y), g.lineTo(x, y + 1);
    if (!has.has(`${x + 1},${y}`)) g.moveTo(x + 1, y), g.lineTo(x + 1, y + 1);
  }
  g.stroke();
  g.setLineDash([]);
}

/** A body `l` long along its pose's heading and `w` across, filled and
 *  outlined; and a bar across its front, its windscreen, so it is seen
 *  which way it points. */
function body(g: CanvasRenderingContext2D, p: Stand, l: number, w: number, fill: string, front = true) {
  g.save();
  g.translate(p.at[0], p.at[1]);
  g.rotate(p.heading);
  g.fillStyle = fill;
  g.fillRect(-l / 2, -w / 2, l, w);
  g.strokeStyle = INK;
  g.lineWidth = 0.02;
  g.strokeRect(-l / 2, -w / 2, l, w);
  if (front) {
    g.fillStyle = "rgba(20,26,40,0.75)";
    g.fillRect(l / 2 - Math.min(0.08, l * 0.3), -w / 2 + 0.02, Math.min(0.05, l * 0.2), w - 0.04);
  }
  g.restore();
}

/** A box: its good's colour, or hollow if it is empty. */
function box(g: CanvasRenderingContext2D, p: Stand, t: Trailer) {
  const full = t.good && t.units > 0;
  g.save();
  g.translate(p.at[0], p.at[1]);
  g.rotate(p.heading);
  g.fillStyle = full ? GOODS[t.good!].color : "rgba(255,255,255,0.7)";
  g.fillRect(-TRAILER.l / 2, -TRAILER.w / 2, TRAILER.l, TRAILER.w);
  g.strokeStyle = INK;
  g.lineWidth = full ? 0.02 : 0.035;
  g.strokeRect(-TRAILER.l / 2, -TRAILER.w / 2, TRAILER.l, TRAILER.w);
  g.restore();
}

/** Where a box stands in a park or on a deck, empty or not. */
function dock(g: CanvasRenderingContext2D, p: Stand, colour = "rgba(255,255,255,0.8)") {
  g.save();
  g.translate(p.at[0], p.at[1]);
  g.rotate(p.heading);
  g.strokeStyle = colour;
  g.lineWidth = 0.02;
  g.setLineDash([0.05, 0.04]);
  g.strokeRect(-TRAILER.l / 2 - 0.02, -TRAILER.w / 2 - 0.02, TRAILER.l + 0.04, TRAILER.w + 0.04);
  g.restore();
}

/** A vehicle by its role, at its moment, with what it carries. */
function vehicle(g: CanvasRenderingContext2D, id: number, car: Car, m: Moment) {
  switch (car.role) {
    case "Ferry": {
      // Its hull, the same at both ends; the bridge amidships; the deck's
      // slots, three lanes by five.
      g.save();
      g.translate(m.body.at[0], m.body.at[1]);
      g.rotate(m.body.heading - Math.PI / 2);
      g.beginPath();
      for (const [hx, hy] of hull(0)) g.lineTo(hx, hy);
      g.closePath();
      g.fillStyle = css(LIVERY.ferry);
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 0.03;
      g.stroke();
      g.restore();
      body(g, m.body, 0.2, FERRY.w, "#3d73a8", false);
      for (let k = 0; k < 15; k++) dock(g, deckPose(m.body, k), "rgba(40,50,70,0.45)");
      for (const d of m.deck ?? []) d.box ? box(g, d.at, d.box) : body(g, d.at, CAR.l, CAR.w, css(PALETTE[colourOf(d.settler!)]));
      return;
    }
    case "Tug":
      if (m.box && car.hitched) box(g, m.box, car.hitched);
      return body(g, m.body, 0.25, 0.16, css(TUG));
    case "Truck":
      if (m.box && car.hitched) box(g, m.box, car.hitched);
      return body(g, m.body, CAB.l, CAB.w, css(LIVERY.cab));
    case "Van":
      return body(g, m.body, VAN.l, VAN.w, css(LIVERY.van));
    case "Tractor":
      return body(g, m.body, VAN.l, VAN.w, css(LIVERY.tractor));
    default:
      return body(g, m.body, CAR.l, CAR.w, css(PALETTE[colourOf(id)]));
  }
}

/** The grid, faint, every fifth tile numbered along the top and left in
 *  the game's own tiles, as `bun run act` takes them. */
function grid(g: CanvasRenderingContext2D, view: View, x0: number, x1: number, y0: number, y1: number, screen: (x: number, y: number) => [number, number]) {
  g.lineWidth = 1;
  g.font = "10px sans-serif";
  g.fillStyle = "rgba(0,0,0,0.55)";
  for (let x = Math.ceil(x0); x <= x1; x++) {
    const [sx] = screen(x, 0);
    g.strokeStyle = `rgba(0,0,0,${x % 5 ? 0.05 : 0.16})`;
    g.beginPath();
    g.moveTo(Math.round(sx) + 0.5, 0);
    g.lineTo(Math.round(sx) + 0.5, view.h);
    g.stroke();
    // A tile is named by its corner of least x, on the screen its right.
    if (x % 5 === 0) (g.textAlign = "right"), g.fillText(`${x}`, sx - 2, 8);
  }
  for (let y = Math.ceil(y0); y <= y1; y++) {
    const [, sy] = screen(0, y);
    g.strokeStyle = `rgba(0,0,0,${y % 5 ? 0.05 : 0.16})`;
    g.beginPath();
    g.moveTo(0, Math.round(sy) + 0.5);
    g.lineTo(view.w, Math.round(sy) + 0.5);
    g.stroke();
    if (y % 5 === 0) (g.textAlign = "left"), g.fillText(`${y}`, 2, sy - 6);
  }
}

/** The key, in the bottom left: the clock, each good's box, an empty, the
 *  vehicles by role; and each ferry's state. */
function legend(g: CanvasRenderingContext2D, world: World, cars: [GameObjectEntry, Car][], byId: Map<number, GameObjectEntry>, height: number) {
  const day = world.now / world.dayMs;
  const t = day % 1;
  const clock = `day ${Math.floor(day) + 1}  ${String(Math.floor(t * 24)).padStart(2, "0")}:${String(Math.floor((t * 1440) % 60)).padStart(2, "0")}  (${world.now} ms)`;
  const hhmm = (ms: number) => {
    const u = (ms / world.dayMs) % 1;
    return `${String(Math.floor(u * 24)).padStart(2, "0")}:${String(Math.floor((u * 1440) % 60)).padStart(2, "0")}`;
  };
  const ferries = cars.filter(([, c]) => c.role === "Ferry").map(([e, c]) => {
    const where = c.spot ? `moored, casts off ${hhmm(c.due)}` : c.run ? "at sea" : `away, berths ${hhmm(c.due)}`;
    const boxes = c.deck.filter(Boolean).length;
    const harbour = byId.get(c.owner)?.object.data as Building | undefined;
    const parked = harbour?.park.filter((s) => s.trailer).length ?? 0;
    return `ferry #${e.id} ${where}; ${boxes} boxes, ${c.passengers.length} settlers aboard; ${parked} in the park`;
  });
  const keys: [string, (x: number, y: number) => void][] = [
    ...(Object.keys(GOODS) as (keyof typeof GOODS)[]).map((good): [string, (x: number, y: number) => void] => [GOODS[good].label, (x, y) => swatch(g, x, y, GOODS[good].color)]),
    ["empty", (x, y) => swatch(g, x, y, "rgba(255,255,255,0.7)", 2)],
    ["lorry", (x, y) => swatch(g, x, y, css(LIVERY.cab))],
    ["van", (x, y) => swatch(g, x, y, css(LIVERY.van))],
    ["tractor", (x, y) => swatch(g, x, y, css(LIVERY.tractor))],
    ["tug", (x, y) => swatch(g, x, y, css(TUG))],
  ];
  const lines = [clock, ...ferries];
  g.font = "11px sans-serif";
  const row = keys.reduce((w, [label]) => w + 30 + g.measureText(label).width, 0);
  const [w, h] = [Math.max(row, ...lines.map((s) => g.measureText(s).width)) + 12, 14 * lines.length + 26];
  const [x, y] = [6, height - h - 6];
  g.fillStyle = "rgba(255,255,255,0.88)";
  g.fillRect(x, y, w, h);
  g.strokeStyle = "rgba(0,0,0,0.2)";
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
  g.textAlign = "left";
  g.textBaseline = "middle";
  lines.forEach((s, i) => ((g.fillStyle = INK), g.fillText(s, x + 6, y + 10 + i * 14)));
  let kx = x + 6;
  const ky = y + h - 11;
  for (const [label, draw] of keys) {
    draw(kx, ky);
    g.fillStyle = INK;
    g.fillText(label, kx + 18, ky);
    kx += 30 + g.measureText(label).width;
  }
}

function swatch(g: CanvasRenderingContext2D, x: number, y: number, fill: string, line = 1) {
  g.fillStyle = fill;
  g.fillRect(x, y - 4, 15, 8);
  g.strokeStyle = INK;
  g.lineWidth = line;
  g.strokeRect(x + 0.5, y - 3.5, 14, 7);
}
