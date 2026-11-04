import { expect, test } from "bun:test";
import { carried, moment, straightBehind, travelled } from "./motion";
import { LANE_OFFSET } from "./roadGeometry";
import type { Car, Package, Trip } from "../../generated";

const near = (a: number[], b: number[], d = 1e-6) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(d);
const car = (c: Partial<Car>): Car => ({ owner: 1, trip: null, role: "Private", spot: null, run: null, sail: null, cargo: [], commuting: false, due: 0, ...c });
const bundle: Package = { id: 9, good: "Logs" };

test("a vehicle is where the server's state has it, and what it carries with it", () => {
  // Parked: in its spot; a lorry's flatbed straight behind its cab, and
  // its cargo on it.
  const spot = { at: [3, 4] as [number, number], heading: 0.5 };
  const lorry = car({ role: "Truck", spot, cargo: [bundle] });
  const parked = moment(1, lorry, 0)!;
  near(parked.body.at, spot.at);
  near(parked.bed!.at, straightBehind(spot).at);
  expect(carried(lorry)).toEqual(["Logs"]);
  // On a trip, along its route by the trip's physics: here a straight
  // street, so x is the distance driven, on its lane.
  const trip: Trip = { destination: 0, eta: 0, route_heights: [],
        lanes: [], shift: null,
        route_positions: [[0, 0.5], [10, 0.5]], from_lot: 0, to_lot: 0, backing: [], cusps: [], manoeuvres: [], leaves: null, stands: null, progress: 2, speed: 1, acceleration: 0, total_route_length: 10, updated_at: 1000 };
  const driving = moment(3, car({ trip }), 4000)!;
  expect(driving.body.at[0]).toBeCloseTo(5, 1);
  expect(driving.body.at[1]).toBeCloseTo(0.5 + LANE_OFFSET);
  expect(Math.cos(driving.body.heading)).toBeCloseTo(1, 2);
  // Pulling away, no faster than cruising: a second to 1.5, then held,
  // not gaining for all three as it did, ahead of where the server has it.
  expect(travelled({ ...trip, acceleration: 0.5 }, 4000)).toEqual([6.25, 1.5]);
  // Nowhere to be seen: out of sight.
  expect(moment(4, car({}), 0)).toBeNull();
});
