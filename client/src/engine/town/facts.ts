import type { Town } from "./grid";
import { formOf, kin } from "./mass";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts.
 *
 * - **Heads**: the tiles of a shed that are its office, a couple of storeys
 *   taller (in `town`, the town as drawn).
 * - **Enclosed**: open ground closed in by buildings, a courtyard, which
 *   no street and no edge of the map reaches.
 */
export interface Facts {
  /** The town as drawn: the painted one with the heads raised. */
  town: Town;
  head(c: number, r: number): boolean;
  enclosed(c: number, r: number): boolean;
}

export function facts(painted: Town): Facts {
  const { lifted, heads } = sheds(painted);
  const closed = courtyards(painted);
  return {
    town: lifted,
    head: (c, r) => heads.has(`${c},${r}`),
    enclosed: (c, r) => closed.has(`${c},${r}`),
  };
}

/** Open ground in regions (joined side by side) that touch neither a road
 *  nor the map's edge. */
function courtyards(town: Town): Set<string> {
  const open = (c: number, r: number) => ["open", "paved"].includes(town.tile(c, r).kind);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!open(c, r) || seen.has(`${c},${r}`)) continue;
      const region: [number, number][] = [[c, r]];
      seen.add(`${c},${r}`);
      let reached = false;
      for (let i = 0; i < region.length; i++) {
        const [x, y] = region[i];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx < 0 || ny < 0 || nx >= town.w || ny >= town.h) reached = true;
          else if (town.tile(nx, ny).kind === "road") reached = true;
          else if (open(nx, ny) && !seen.has(`${nx},${ny}`)) seen.add(`${nx},${ny}`), region.push([nx, ny]);
        }
      }
      if (!reached) for (const [x, y] of region) out.add(`${x},${y}`);
    }
  }
  return out;
}

/**
 * A shed as a business park has it: an office at its street end, a couple
 * of storeys over the hall and lighter. It is found from the building's
 * tiles: its long way is the way it is longer, and its head is the end,
 * right across, with the tile that has most street round it, the corner on
 * a junction if it has one. A workshop of a tile or three is a hall alone.
 */
function sheds(town: Town) {
  const key = (c: number, r: number) => `${c},${r}`;
  const heads = new Set<string>();
  const seen = new Set<string>();
  /** How much street is round a tile, the nearer the more: behind its
   *  yard, a shed's corner on the junction has most. */
  const street = (c: number, r: number) => {
    let n = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
    return n;
  };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = town.tile(c, r);
      if (formOf(me).family !== "industry" || seen.has(key(c, r))) continue;
      seen.add(key(c, r));
      const cells = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [x, y] = [cells[i][0] + dc, cells[i][1] + dr];
          if (kin(me, town.tile(x, y)) && !seen.has(key(x, y))) seen.add(key(x, y)), cells.push([x, y]);
        }
      }
      if (cells.length < 4) continue;
      const span = (k: number) => Math.max(...cells.map((p) => p[k])) - Math.min(...cells.map((p) => p[k]));
      const long = span(1) > span(0) ? 1 : 0;
      const ends = [Math.min(...cells.map((p) => p[long])), Math.max(...cells.map((p) => p[long]))];
      const head = cells.filter((p) => ends.includes(p[long])).reduce((a, b) => (street(b[0], b[1]) > street(a[0], a[1]) ? b : a));
      if (street(head[0], head[1])) for (const p of cells) if (p[long] === head[long]) heads.add(key(p[0], p[1]));
    }
  }
  const lifted: Town = { ...town, tile: (c, r) => (heads.has(key(c, r)) ? { ...town.tile(c, r), storeys: town.tile(c, r).storeys + 2 } : town.tile(c, r)) };
  return { lifted, heads };
}

