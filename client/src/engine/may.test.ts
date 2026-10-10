import { describe, expect, test } from "bun:test";
import { may, type Hand } from "./may";
import type { TerrainType } from "../generated";

/** The server's test street (`game_loop` tests): grass, and a street along
 *  y = 0, every tile linked both ways to the next. */
function street(): Hand & { wet: Set<string> } {
  const wet = new Set<string>();
  const h: Hand & { wet: Set<string> } = {
    roads: new Map(),
    at: new Map(),
    occupied: new Map(),
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
});
