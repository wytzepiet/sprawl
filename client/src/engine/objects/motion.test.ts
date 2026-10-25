import { expect, test } from "bun:test";
import { carried, moment, straightBehind, travelled } from "./motion";
import { deckPose } from "./sea";
import { LANE_OFFSET } from "./roadGeometry";
import type { Car, Package, Trip } from "../../generated";

const near = (a: number[], b: number[], d = 1e-6) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(d);
const car = (c: Partial<Car>): Car => ({ owner: 1, trip: null, role: "Private", spot: null, stocks: {}, run: null, sail: null, cargo: [], load: null, deck: [], passengers: [], booked: [], due: 0, errand: null, ...c });
const bundle: Package = { id: 9, good: "Timber", to: null, outbound: false, order: 1, partner: null, price: 0 };

test("a vehicle is where the server's state has it, and what it carries with it", () => {
  // Parked: in its spot; a lorry's flatbed straight behind its cab, and
  // its cargo on it.
  const spot = { at: [3, 4] as [number, number], heading: 0.5 };
  const lorry = car({ role: "Truck", spot, cargo: [bundle] });
  const parked = moment(1, lorry, 0)!;
  near(parked.body.at, spot.at);
  near(parked.bed!.at, straightBehind(spot).at);
  expect(carried(lorry)).toEqual(["Timber"]);
  // Moored: a pallet in its bay, four to a bay; and two settlers in the
  // first bay with none from the sea end, the last.
  const ferry = moment(2, car({ role: "Ferry", spot, deck: [null, null, null, null, null, bundle], passengers: [7, 8] }), 0)!;
  const pallet = ferry.deck!.find((d) => d.good)!;
  expect(pallet.good).toBe("Timber");
  expect(Math.hypot(pallet.at.at[0] - deckPose(spot, 1).at[0], pallet.at.at[1] - deckPose(spot, 1).at[1])).toBeLessThan(0.15);
  const seats = ferry.deck!.filter((d) => d.settler !== undefined);
  expect(seats.length).toBe(2);
  for (const s of seats) expect(Math.hypot(s.at.at[0] - deckPose(spot, 14).at[0], s.at.at[1] - deckPose(spot, 14).at[1])).toBeLessThan(0.2);
  // On a trip, along its route by the trip's physics: here a straight
  // street, so x is the distance driven, on its lane.
  const trip: Trip = { destination: 0, eta: 0, route_heights: [],
        lanes: [], shift: null,
        route_positions: [[0, 0.5], [10, 0.5]], from_lot: 0, to_lot: 0, backing: [], cusps: [], leaves: null, stands: null, progress: 2, speed: 1, acceleration: 0, total_route_length: 10, updated_at: 1000 };
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
