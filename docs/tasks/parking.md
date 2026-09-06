# Task: parking (roadmap milestone 1)

What an agent needs to start, in one read. The why is `../game.md`
(People) and `../roadmap.md`; this is the what and the where.

## The outcome

A parked car sits in a spot on its building's plot, so who is home and
how busy a shop is can be read from the lot. A car arriving drives from
the driveway to its spot; a car leaving drives from its spot to the
driveway. Client first; the server changes nothing until capacity (not
in this task).

## What exists

- **A parked car is a `Car` with `trip: None` and `position` = the
  building's origin tile.** The server sets that in `park_car`
  (`server/src/car/simulation.rs`). Trucks park at their facility the
  same way (`server/src/calls.rs`). Nothing else about parking exists.
- **The client draws a parked car at a hashed jitter** around that tile:
  `client/src/engine/objects/CarObject.tsx`, the `if (!car.trip)` branch.
  Replace this.
- **A moving car is drawn by extrapolating along `trip.route_positions`**
  with the server's kinematics, same file. The route ends at the
  driveway node, which stands on one of the building's own tiles.
- **A building's driveway** is the road node on its footprint:
  `World::road_node_for_building` on the server; on the client, the
  footprint's tiles are in `builtTiles` (`client/src/engine/World.tsx`)
  and `getObjectsAt(x, y)` (`client/src/state/gameObjects.tsx`) finds the
  road node on a tile. Its street neighbour (`outgoing`/`incoming`) says
  which way the driveway faces.
- **Buildings are turned** by `facingOf(id, w, h)` in
  `client/src/engine/objects/buildings.ts`; a spot table has to be in the
  plot's frame and turned the same way, or turned by the driveway side —
  pick one and say which. The driveway side is the honest one: the lot
  faces the street.
- **Every kind is one row** in `server/src/blueprint.rs` (what it does)
  and `client/src/blueprints.tsx` (what it looks like, with `size`). Spots
  belong in the client row: they are drawing.
- **Drawing goes through the instance pool** (`client/src/engine/
  InstancePool.tsx`): `ensureBucket`, `addInstance`, `updateInstance`,
  `removeInstance`. Cars update per frame in `scene.onBeforeRenderObservable`.
- **Which car is which is stable**: ids never change, and `hash(id, salt)`
  in `CarObject.tsx` is how a car gets a fact about itself.

## The design

- `spots: [dx, dy, angle][]` per client blueprint row, in tiles from the
  plot's origin, for the plot as if its driveway were on its south edge.
  House: two on the driveway, half out of the footprint. Shop: three
  along the front. Supermarket (2x2): a lot of about ten. Warehouse: bays
  for trucks. Turn the table by the driveway side.
- A parked car takes spot `hash(car.id) mod spots.length`; if the lot
  is smaller than the cars, spots repeat and cars overlap — fine for now,
  capacity is the next task.
- Arrival: extend the drawn route from the driveway node to the spot,
  the same quadratic curve the roads use; the server's route already
  ends at the driveway. Departure: the trip starts at the driveway; draw
  the car from its spot to the driveway for the first beat. Both are
  client-only: the server's clock and route are untouched, the client
  adds a short tail and a short head.
- Trucks at a facility park in its bays; a truck at a shop's door parks
  in the shop's spot nearest the driveway.

## Done when

- A house with two residents home shows two cars in the driveway.
- The supermarket's lot fills through the day and empties at night.
- A car pulling in visibly leaves the street and stops in a spot; one
  pulling out visibly leaves its spot first.
- No car is drawn on the building's roof.
- `bunx tsc --noEmit -p client` is clean; the server suite still passes
  (nothing there should change).

## Things that will bite

- **East is screen-left.** Looking down on the map, +x is to the left.
  Check turning by the driveway side against the map, not against a
  sketch.
- **Vite's hot swap of engine modules leaves the map undrawn.** Reload
  the page (Cmd+R) after touching anything under `client/src/engine`.
- **`pool.updateInstance` every frame is fine for cars; ensureBucket is
  not.** One bucket per material, made once.
- **The user's taste decides the look.** Measure what you can; show one
  screenshot, not five; close the tab after.

## How to run

`bun run dev` runs server and client; `curl localhost:3001/health` says
whether the binary is current; `cd client && bunx tsc --noEmit -p .`
type-checks; `cd server && cargo test` runs the suite. `CLAUDE.md` has
the rest.
