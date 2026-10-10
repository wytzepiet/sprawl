import { describe, expect, test } from "bun:test";
import { hand, may, placing, type Hand } from "./may";
import type { TerrainType } from "../generated";

/** The server's test street (`game_loop` tests): grass, and a street along
 *  y = 0, every tile linked both ways to the next. */
function street(): Hand & { wet: Set<string> } {
  const wet = new Set<string>();
  const h: Hand & { wet: Set<string> } = {
    roads: new Map(),
    at: new Map(),
    occupied: new Map(),
    taken: new Set(),
    ground: (x, y): TerrainType => (wet.has(`${x},${y}`) ? "Water" : "Grass"),
    wet,
  };
  for (let x = -2; x < 20; x++) {
    const id = x + 100;
    const arms = [id - 1, id + 1].filter((n) => n >= 98 && n < 120);
    h.roads.set(`${x},0`, { id, node: { outgoing: arms, incoming: [], joined: true, road: false, laid: false } });
    h.at.set(id, { x, y: 0 });
  }
  return h;
}

const at = (x: number, y: number) => ({ x, y });

describe("the hand's rule, as the server's", () => {
  test("a house beside the street, not on it, nor out of reach", () => {
    const h = street();
    const house = { Building: "House" as const };
    expect(may(h, house, at(5, 1), at(5, 1))).toBe(true);
    expect(may(h, house, at(5, 0), at(5, 0))).toBe(false);
    expect(may(h, house, at(5, 3), at(5, 3))).toBe(false);
  });
  test("a street off the street, not along it again, nor onto water", () => {
    const h = street();
    expect(may(h, "Street", at(5, 0), at(5, 1))).toBe(true);
    expect(may(h, "Street", at(5, 0), at(6, 0))).toBe(false);
    h.wet.add("5,1");
    expect(may(h, "Street", at(5, 0), at(5, 1))).toBe(false);
  });
  test("demolishing finds what stands, and a drag what joins", () => {
    const h = street();
    expect(may(h, "Demolish", at(5, 3), at(5, 3))).toBe(false);
    expect(may(h, "Demolish", at(5, 0), at(5, 0))).toBe(true);
    expect(may(h, "Demolish", at(5, 0), at(6, 0))).toBe(true);
    expect(may(h, "Demolish", at(5, 0), at(5, 1))).toBe(false);
  });

  test("a house beside a drafted street, and nothing on another's draft", () => {
    const grass = (): TerrainType => "Grass";
    const step = (tool: "Street", from: [number, number], to: [number, number]) => ({ stuck: false, step: { tool, from: at(...from), to: at(...to) } });
    const house = { Building: "House" as const };
    const bare = hand(() => {}, grass);
    expect(may(bare, house, at(1, 1), at(1, 1))).toBe(false);
    const drafted = hand(() => {}, grass, [step("Street", [0, 0], [1, 0]), step("Street", [1, 0], [2, 0])], [step("Street", [5, 0], [6, 0])]);
    expect(may(drafted, house, at(1, 1), at(1, 1))).toBe(true);
    expect(may(drafted, "Street", at(2, 0), at(3, 0))).toBe(true);
    expect(may(drafted, "Street", at(4, 0), at(5, 0))).toBe(false);
  });

  // The server's `a_harbour_is_placed_whole_and_never_in_part`: grass to
  // y = 3, the sea from y = 4.
  test("a harbour whole at a tap, its back on the sea, and nowhere else", () => {
    const coast = hand(() => {}, (_x, y): TerrainType => (y >= 4 ? "Sea" : "Grass"));
    const harbour = { Building: "Harbour" as const };
    expect(may(coast, harbour, at(9, 2), at(9, 2))).toBe(true);
    expect(may(coast, harbour, at(9, 1), at(9, 1))).toBe(false);
    expect(may(coast, harbour, at(9, 3), at(9, 3))).toBe(false);
    expect(may(coast, harbour, at(9, 2), at(10, 2))).toBe(false);
    expect(may(coast, harbour, at(10, -10), at(10, -10))).toBe(false);
    // A tap on the coast places it round the tile beside that fits.
    const p = placing(coast, "Harbour", at(9, 3))!;
    expect([p.at, p.facing, p.why]).toEqual([at(9, 2), 0, null]);
    expect(placing(coast, "Harbour", at(9, -10))!.why).toBe("No berth: its back is not on the sea");
    const lake = hand(() => {}, (_x, y): TerrainType => (y >= 4 ? "Water" : "Grass"));
    expect(placing(lake, "Harbour", at(9, 2))!.why).toBe("A lake: the ferry comes only by sea");
  });
});
