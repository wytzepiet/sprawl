# Roadmap

How `game.md` gets built, in playable steps. Each milestone ends with
something you can sit down and play for an evening and notice is better
than the last. Estimates are working days for one person with an
assistant; they are guesses, and the order matters more than the numbers.

## Where we are (2026-09-09)

Built: roads and streets, one-way, the tree as the build, every kind on
the build menu as a piece of map, placed by hand and paid for out of the
treasury, residents with needs and commutes, call-outs for stock with a
warehouse and trucks from the edge, the supermarket, day and night, a
fresh world per seed. Nothing arrives on its own: the spawner went on
2026-09-09 (`shelved.md`). Money: purses, wages, posted prices, the
sweep, every sale a lump on the map (`economy.md` §12 steps 1 and 2).

Not built: parking, goods, food, the port, power, fire, hospital, the
inspect panel, road speed and priority, levels, trains, multiplayer,
deployment. Of milestone 3, road past the allowance, moving and
demolishing do not cost money yet.

## Milestone 1: You can see the cars (≈ 4 days)

The city becomes legible at the scale of one car.

- Parking as `parking.md` lays it out. Step 1 is built: lot nodes, trips
  that end in a spot, cars drawn from them, two spots on every driveway.
  Next, spot tables per row, then giving way by length and reverse gear.
- Warehouse at 3x2 with truck bays.

*Playable:* watch a household leave for work and come home; count the
cars at the supermarket.

## Milestone 2: Goods move (≈ 5 days)

The industrial half of the game exists.

- Stock becomes goods; factories fill a yard with work; calls get a
  direction (delivery, pickup); the container drawn on a loaded truck.
- The warehouse holds a level, and wins a call when it is nearer than
  the producer.
- The edge trades by road: a truck out past the frontier and back, for
  whatever the town lacks and whatever it makes that nobody here buys.

*Playable:* a factory district feeding a shopping street through a
warehouse, and the road between them as the thing you fix.

## Milestone 3: Money (≈ 5 days)

Every sale is a lump and every purse is real. `economy.md` §12 is the
order inside this milestone.

- The shelf, the tank and the bucket become one stock. Wallets and
  balances; wages paid; every purse keeps a float and sweeps the rest to
  the treasury. Level stays hours served, banked in lumps.
- Posted prices with the nudge; the labour stock and wages on it;
  `price / earning` in the resident's score; jobs ranked by wage, with a
  switching threshold. Prices held to the edge's band.
- Placeables, road tiles beyond the allowance, moving and demolishing
  cost money. The dial shows income as a rate over the lumps.

*Playable:* the first time a shop's price climbs because the warehouse
was too far, and you fix it with a road.

## Milestone 4: Food and farms (≈ 3 days)

A second chain, and space on the map.

- Food as a second token (the crate); farms as big placeables that fill
  with work; supermarkets and restaurants call for food.
- The warehouse holds both.
- The port: a facility on the coast whose vehicle is a ship, a second
  door with the edge's prices and cheaper freight. Haulers, handling
  classes and the rest of what `economy.md` filed come with it.

*Playable:* a farm belt outside town, trucks at harvest, and the choice
of where the warehouse goes between farms and shops.

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

- The plant as a facility that calls for coal; coal as bulk from the port.
- Pylons, the one drawn line, plant to substation.
- Substations with a reach along the roads; the placer's ghost lights the
  reach.
- Night as the gauge: unpowered buildings dark, powered ones lit.

*Playable:* siting a plant by the port and pulling a pylon line across the
water to the town.

## Milestone 7: Services and the panel (≈ 5 days)

- Fire as a stock: full until it ignites, draining while it burns,
  spreading to a neighbour's, rubble at zero; the fire station's truck.
- Health as a stock only a hospital refills; the ambulance.
- The inspect panel: per-day rates on any building, each line pointing at
  the map.

*Playable:* the first fire you were too far from, and the panel that
tells you a shop is bleeding on deliveries.

## Milestone 8: The advisor (≈ 3 days)

- Read-only tools over the inspect rates and the network's delays.
- Answers carry entity ids; the client highlights them.
- Hosted, tool calls relayed through the client to the player's server.

*Playable:* "why is the west district losing money", answered with three
junctions lit up.

## Milestone 9: Other people (≈ 8 days)

- Deployment: the server on a VPS, the client built, reconnects.
- Multiplayer: several players on one world, each with a build; roads
  between cities; the port as the door, with a ferry and a batch, and
  influence from traffic as the claim. `multiplayer.md` is the spec.

*Playable:* two cities on one map, and your rush hour on their road.

## Later, if a build asks for it

Trains from a mainline the map is born with. Nuclear. Mining as bulk on
rails. Tourists and the airport as a door. Obedience as a stock, the
park that refills it, the police and the jail. Tram as a mid-game reward,
if ever.

## How each step is done

The same way as today: a spec section first if the design is not in
`game.md` already, a harness test that runs a day of the town and asserts
the behaviour, the change, a look at it running, a commit with the reason
in the message. Nothing is done until it has been watched.
