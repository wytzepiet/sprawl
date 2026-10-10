import { expect, test } from "bun:test";
import { moment, straightBehind } from "./motion";
import { deckPose } from "./sea";
import { LANE_OFFSET } from "./roadGeometry";
import type { Car, Trailer, Trip } from "../../generated";

const near = (a: number[], b: number[], d = 1e-6) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(d);
const car = (c: Partial<Car>): Car => ({ owner: 1, trip: null, role: "Private", spot: null, stocks: {}, run: null, hitched: null, deck: [], passengers: [], shunt: null, booked: [], due: 0, ...c });
const box: Trailer = { id: 9, good: "Timber", units: 20, to: null, outbound: false, order: null };

test("a vehicle is where the server's state has it, and what it carries with it", () => {
  // Parked: in its spot; a lorry's box straight behind its cab.
  const spot = { at: [3, 4] as [number, number], heading: 0.5 };
  const lorry = moment(1, car({ role: "Truck", spot, hitched: box }), 0)!;
  near(lorry.body.at, spot.at);
  const b = straightBehind({ x: 3, y: 4, heading: 0.5 });
  near(lorry.box!.at, [b.x, b.y]);
  // Moored: its boxes in their deck slots.
  const ferry = moment(2, car({ role: "Ferry", spot, deck: [null, box] }), 0)!;
  expect(ferry.deck!.map((d) => d.box?.id)).toEqual([9]);
  near(ferry.deck![0].at.at, deckPose(spot, 1).at);
  // On a trip, along its route by the trip's physics: here a straight
  // street, so x is the distance driven, on its lane.
  const trip: Trip = { destination: 0, eta: 0, route_positions: [[0, 0.5], [10, 0.5]], from_lot: 0, to_lot: 0, backing: [], progress: 2, speed: 1, acceleration: 0, total_route_length: 10, updated_at: 1000, route_index: 1, seg_fraction: 0.2, seg_length: 10 };
  const driving = moment(3, car({ trip }), 4000)!;
  expect(driving.body.at[0]).toBeCloseTo(5, 1);
  expect(driving.body.at[1]).toBeCloseTo(0.5 + LANE_OFFSET);
  expect(Math.cos(driving.body.heading)).toBeCloseTo(1, 2);
  // Nowhere to be seen: out of sight.
  expect(moment(4, car({}), 0)).toBeNull();
});
