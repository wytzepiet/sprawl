import { describe, expect, test } from "bun:test";
import { fit, hand, may, placing, type Hand } from "./may";
import type { BuildingKind, TerrainType } from "../generated";

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
  for (let x = -6; x < 20; x++) {
    const id = x + 100;
    const arms = [id - 1, id + 1].filter((n) => n >= 94 && n < 120);
    h.roads.set(`${x},0`, { id, node: { outgoing: arms, incoming: [], joined: true, road: false, laid: false } });
    h.at.set(id, { x, y: 0 });
  }
  return h;
}

const at = (x: number, y: number) => ({ x, y });
const why = (h: Hand, kind: BuildingKind, x: number, y: number, facing: number) => fit(h, kind, at(x, y), facing).why;

describe("the hand's rule, as the server's", () => {
  // `World::fit`'s test, `a_plot_that_does_not_fit_says_why`.
  test("a building fits beside the street, and says why where it does not", () => {
    const h = street();
    expect(why(h, "House", 0, 1, 2)).toBe(null);
    expect(why(h, "House", 0, 4, 2)).toBe("No street beside it");
    expect(why(h, "Depot", 0, 3, 2)).toBe("No street before its yard");
    expect(why(h, "Depot", 0, 3, 0)).toBe(null);
    expect(why(h, "House", 0, 0, 2)).toBe("A street runs through it");
    h.wet.add("3,1");
    expect(why(h, "House", 3, 1, 2)).toBe("Its plot runs into the water");
  });
  test("left to itself, a depot turns its yard to the street", () => {
    const p = placing(street(), "Depot", at(0, 3), null);
    expect([p.facing, p.why, p.door?.street.y]).toEqual([0, null, 0]);
  });
  test("a street off the street, not along it again, nor onto water", () => {
    const h = street();
    expect(may(h, "Street", at(5, 0), at(5, 1))).toBe(true);
    expect(may(h, "Street", at(5, 0), at(6, 0))).toBe(false);
    h.wet.add("5,1");
    expect(may(h, "Street", at(5, 0), at(5, 1))).toBe(false);
  });
  test("demolishing finds what stands, and a drag the road it crosses", () => {
    const h = street();
    expect(may(h, "Demolish", at(5, 3), at(5, 3))).toBe(false);
    expect(may(h, "Demolish", at(5, 0), at(5, 0))).toBe(true);
    expect(may(h, "Demolish", at(5, 0), at(6, 0))).toBe(true);
    expect(may(h, "Demolish", at(5, 0), at(5, 1))).toBe(false);
  });

  // The server's `a_harbour_is_placed_whole_with_its_street`: grass to
  // y = 2, the sea from y = 3.
  test("a harbour with its back on the sea, and nowhere else", () => {
    const coast = hand(() => {}, (_x, y): TerrainType => (y >= 3 ? "Sea" : "Grass"));
    expect(fit(coast, "Harbour", at(9, 2), 0).why).toBe(null);
    expect(fit(coast, "Harbour", at(9, 2), 2).why).toBe("No berth: its back is not on the sea");
    // Held on the coast, it is placed round the tile beside that fits.
    const p = placing(coast, "Harbour", at(9, 3), null);
    expect([p.at, p.facing, p.why]).toEqual([at(9, 2), 0, null]);
    expect(placing(coast, "Harbour", at(9, -10), null).why).toBe("No berth: its back is not on the sea");
    const lake = hand(() => {}, (_x, y): TerrainType => (y >= 3 ? "Water" : "Grass"));
    expect(placing(lake, "Harbour", at(9, 2), null).why).toBe("A lake: the ferry comes only by sea");
  });
});

// `roads.rs`'s `a_one_way_may_merge_at_a_shallow_angle`.
describe("a one-way may merge at a shallow angle", () => {
  /** A one-way street east along y = 0. */
  function eastward(): Hand {
    const h: Hand = { roads: new Map(), at: new Map(), occupied: new Map(), ground: (): TerrainType => "Grass" };
    for (let x = 0; x < 10; x++) {
      const id = x + 100;
      h.roads.set(`${x},0`, { id, node: { outgoing: x < 9 ? [id + 1] : [], incoming: x > 0 ? [id - 1] : [], joined: true, road: false, laid: true } });
      h.at.set(id, { x, y: 0 });
    }
    return h;
  }
  test("on and off a one-way, and never against it", () => {
    const h = eastward();
    expect(may(h, "OneWay", at(4, -1), at(5, 0))).toBe(true);
    expect(may(h, "Street", at(4, -1), at(5, 0))).toBe(false);
    expect(may(h, "OneWay", at(5, 0), at(6, -1))).toBe(true);
    expect(may(h, "OneWay", at(6, -1), at(5, 0))).toBe(false);
    expect(may(h, "OneWay", at(5, 0), at(4, -1))).toBe(false);
  });
  test("never onto a two-way at a shallow angle; square on, anything", () => {
    const h = street();
    expect(may(h, "OneWay", at(4, -1), at(5, 0))).toBe(false);
    expect(may(h, "Street", at(5, -1), at(5, 0))).toBe(true);
  });
});
