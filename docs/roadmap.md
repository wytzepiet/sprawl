# Roadmap

How `game.md` gets built, in playable steps. Each milestone ends with
something you can sit down and play for an evening and notice is better
than the last. Estimates are working days for one person with an
assistant; they are guesses, and the order matters more than the numbers.

## Where we are (2026-09-23)

Built: roads and streets, one-way, the tree as the build, every kind on
the build menu as a piece of map, placed by hand and paid for out of the
treasury, residents with needs and commutes, call-outs for stock with a
warehouse and trucks from the edge, the supermarket, day and night, a
fresh world per seed. Money: one purse moved at the door, posted prices,
labour bought on the building's turn, the farm with its land and tractor,
its crates fetched by the warehouse or picked up for the edge. Legibility:
a card for anything on the map with a season of books and each price's
line over it, and the town's page. The port: a depot on the coast whose
lorry is a ship, sailing to the map's edge and back with every shelf's
worth at the sea's crossing (`economy.md` §12.10).

Decided on 2026-09-23 and not built: the island seen whole, the terminal
as the door with the world's ferry and its batch, sites built from
delivered materials, the tapped lorry and the warehouse as the first
hire, one material and a works, the cut of services, wear and leisure.
`game.md` is the design; the built sections of `economy.md` are the
record of the code until it changes.

Not built, unchanged: parking past the driveway, power, fire, hospital,
the advisor, road speed and priority, levels, trains, multiplayer,
deployment.

## Milestone 0: The cut (≈ 2 days)

Delete before building. Each goes to `shelved.md` with its last commit.

- Services as a good: the office's row, the consultant's car, the firm's
  fifth, the household's services stock.
- Wear, parts and the workshop.
- Leisure, bars, restaurants as evenings out; the household's budget
  shares.
- The survey and the fog, the generated road network, the road exit.
- The port's own ship (it becomes the world's, at a berth, in milestone
  1).

Then the seasons again with three goods, crates, fuel and labour, to see
that the band, no harm and tenure still hold on the smaller town.

*Playable:* the same town, smaller, and every truck on it carries
something you can name.

## Milestone 1: The opening (≈ 6 days)

The ten minutes `game.md` §The opening describes, from nothing.

- The generator makes an island: land that thins with distance from the
  centre until it is sea, a coast every spawn can stand on. The map is
  the island; no survey, no fog, no roads born with it.
- The terminal, placed by the player on the coast, standing at once. The
  world's ferry on a timetable with a batch: cars off the ramp, boxes
  onto the quay, which is the built port's shelves under a new name.
  The starting kit in its hold.
- A placement is a site with a materials stock and a call; the building
  stands when it is full; a tap before the first load cancels it.
  One material, boxed, on the quay to begin with.
- The town's one lorry, answering taps: a source, then a destination.
  The warehouse as the first hire, its lorries fetching from the quay
  and its vans delivering on their own.
- The pump, opening full, refilled by a tanker off the ferry.
- Legibility for the opening only: the icon over a waiting site, the
  meter's one line, the terminal's card, lumps at the ramp.

*Playable:* place the terminal, draw a road, build a shop with your own
lorry, place a warehouse and watch it take over.

## Milestone 2: Goods move (≈ 5 days)

The industrial half of the game exists.

- The cargo drawn on a loaded truck, the crates on the tractor.
- The works: a row that makes materials from ore, its yard filling with
  work; ore from a mine on the mountain, or bulk off the ferry, dear.
- Exports by ship: a maker's surplus carried to the quay and gone on the
  next sailing, paid at the sea's crossing when the boat leaves.
- The container berth from the tree: boxes by the shipload at a fifth of
  the ferry's crossing.

*Playable:* a works that stops the lorries from the quay, and the road
between the mine and the sites as the thing you fix.

## Milestone 3: Money you can read (≈ 3 days)

- Every building's card leads with its net at the door, houses with
  books of their own.
- The ghost's cost line: what this building would cost the reserve
  today, and from where.
- The town's page with the season and the one chart.
- The crossing's value, run through the seasons (`economy.md` §13.8).

*Playable:* the first time you place a works because the quay's list told
you to, and watch its card pay for itself.

## Milestone 4: Food and farms (≈ 2 days)

Mostly built. What remains: the warehouse fetching from the quay, the
band's ceiling on crates dropping where the port's van reaches, and a
second farm as the answer to fields too far from the yard.

*Playable:* a farm belt outside town and the choice of where the
warehouse goes between farms and shops.

## Milestone 5: Roads that are roads (≈ 5 days)

The skill ceiling. This can slot earlier if traffic is the pain first.

- Per-edge cruise speed: roads faster than streets, in pathfinding and
  physics.
- Priority at junctions: roads over streets, via the intersection
  registry.
- Levels: an overpass is a road one level up; bridges over water.

*Playable:* an interchange that actually flows, and a bypass that empties
the high street.

## Milestone 6: Power (≈ 5 days)

- The plant as a facility that calls for coal; coal as bulk at a berth.
- Pylons, the one drawn line, plant to substation.
- Substations with a reach along the roads; the placer's ghost lights
  the reach.
- Night as the gauge: unpowered buildings dark, powered ones lit.

*Playable:* siting a plant by the port and pulling a pylon line across the
water to the town.

## Milestone 7: Services and the panel (≈ 5 days)

- Fire as a stock: full until it ignites, draining while it burns,
  spreading to a neighbour's, rubble at zero; the fire station's truck.
- Health as a stock only a hospital refills; the ambulance.
- The inspect panel: per-day rates on any building, each line pointing
  at the map.

*Playable:* the first fire you were too far from.

## Milestone 8: The advisor (≈ 3 days)

- Read-only tools over the inspect rates and the network's delays.
- Answers carry entity ids; the client highlights them.
- Hosted, tool calls relayed through the client to the player's server.

*Playable:* "why is the west district losing money", answered with three
junctions lit up.

## Milestone 9: Other people (≈ 8 days)

- Deployment: the server on a VPS, the client built, reconnects.
- Multiplayer: several towns on one island, each with a build and a
  terminal; roads between them; influence from traffic as the claim; the
  region board. `multiplayer.md` §4 onward is the spec.

*Playable:* two towns on one island, and your rush hour on their road.

## Later, if a build asks for it

Sidings and trains from a quarry to a works. Berths per class: the tank
and the bulk carrier. The raw goods table, one per avenue. Nuclear.
Tourists and the airport as a door. Obedience as a stock, the park that
refills it, the police. A ride-along camera in any vehicle. Tram as a
mid-game reward, if ever.

## How each step is done

The same way as today: a spec section first if the design is not in
`game.md` already, a harness test that runs a day of the town and asserts
the behaviour, the change, a look at it running, a commit with the reason
in the message. Nothing is done until it has been watched.
