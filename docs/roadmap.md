# Roadmap

How `game.md` gets built, in playable steps. Each milestone ends with
something you can sit down and play for an evening and notice is better
than the last. Estimates are working days for one person with an
assistant; they are guesses, and the order matters more than the numbers.

## Where we are (2026-10-10)

Built: roads and streets, one-way, the tree as the build, buildings
painted a tile at a time with the hand's dots, residents with needs and
commutes, call-outs for stock with a warehouse and trucks from the edge,
the supermarket, the farm with its land and tractor, the port with its
own ship, kerb parking before shops, offices and flats, day and night,
the island's terrain, coast, trees and light. The price economy of
`economy.md` runs under all of it.

Decided on 2026-10-10 and not built: the economy is trade (`trade.md`).
Nothing inside a town has a price; coins move only when goods cross its
border; every trade is the player's, by hand or by a rule on a depot;
every shipment can be followed; depots keep everything; buildings are
built from materials a lorry brings. Still to build from 2026-09-23: the
harbour as the door with the world's ferry, sites, the tapped lorry, the
cut of services, wear and leisure.

Not built, unchanged: parking past the kerb, power, fire, hospital, the
advisor, road speed and priority, levels, trains, multiplayer,
deployment.

## Milestone 0: The cut (≈ 3 days)

Delete before building. Each goes to `shelved.md` with its last commit.

- The price economy: posted prices and the nudge, unit cost, the
  household's ask and the hiring threshold, money as hours in the score,
  the band's arithmetic, capital's third, the household's tenth, GDP,
  the books' prices. A buyer takes the nearest seller with stock, by
  road.
- Services as a good, wear and the workshop, leisure and the household
  budget.
- The port's own ship (it becomes the world's ferry, in milestone 1).
- The season's equilibrium tests, replaced by one that asserts the town
  keeps its shelves stocked and its residents fed over a season.

*Playable:* the same town, smaller, every truck on it carrying something
you can name, and nothing on a card you cannot see on the map.

## Milestone 1: The opening (≈ 6 days)

The four beats of `game.md` §The opening, from nothing.

- The harbour, built by the player on the coast; the world's ferry on a
  timetable with a batch; the quay as a small buffer.
- The general depot, holding a little of every class.
- The starter pack: the first sailing's load, carried by the town's one
  lorry, tapped by hand, from the quay to the depot, with the camera on
  it the first time.
- Sites: a placement waits for timber, steel and concrete, a lorry
  brings them from the depot, and it goes up as they land. The site's
  card says what it waits for and where that is.

*Playable:* build a harbour and a depot, watch the starter pack come
home, and build a street with your own lorry.

## Milestone 2: The world as a trader (≈ 5 days)

- Buying from the world at a premium and selling to it at a discount,
  by hand, at the harbour.
- The pending shipments: a list, a pin on the map for each, a click that
  follows the vehicle, an arrival time that moves with the traffic, and
  the lump of coins when it lands.
- Top-up rules on depots, the world as their source.
- Standing orders for the lorry: collect here, unload there, every so
  often.
- The cargo drawn on every loaded vehicle; a depot's yard showing its
  stock.

*Playable:* the first top-up rule, and the first morning its ship comes
over the horizon without you.

## Milestone 3: Chains in town (≈ 5 days)

- A sawmill by the forest and a quarry on the mountain: materials made
  in town, called for pickup, carried to the nearest depot with room.
- The warehouse, the tank farm and the bulk yard: much of one class.
- A full depot stops what fills it, and is seen.

*Playable:* a sawmill that stops the timber boats, and the road between
it and the building front as the thing you fix.

## Milestone 4: Roads that are roads (≈ 5 days)

- Per-edge cruise speed: roads faster than streets, in pathfinding and
  physics.
- Priority at junctions: roads over streets, via the intersection
  registry.
- Levels: an overpass is a road one level up; bridges over water.

*Playable:* an interchange that actually flows, and a bypass that empties
the high street.

## Milestone 5: Other people (≈ 10 days)

- Deployment: the server on a VPS, the client built, reconnects.
- Several towns on one island, each with a build and a harbour; roads
  between them; `multiplayer.md` §4's claim.
- The Exchange, and the trade board it opens: listings, standing
  offers, and contracts between players, the seller always delivering,
  from the world if it must.
- Shipments that cross towns, followed through a neighbour's streets.

*Playable:* sell your timber to a friend, and watch your convoy drive
into their town.

## Milestone 6: Power (≈ 5 days)

- The plant as a facility that calls for coal; coal as bulk at a berth.
- Pylons, the one drawn line, plant to substation.
- Substations with a reach along the roads.
- Night as the gauge: unpowered buildings dark, powered ones lit.

## Milestone 7: Services and the panel (≈ 5 days)

- Fire as a stock, the fire station's truck; health and the ambulance.
- The inspect panel: per-day rates on any building, each line pointing
  at the map.

## Milestone 8: The advisor (≈ 3 days)

- Read-only tools over the inspect rates and the network's delays;
  answers carry entity ids the client highlights.

## Later, if a build asks for it

The order board (`trade.md` §Open), which may be needed as early as
milestone 2 for a single player's income. Houses that climb a ladder of
wants. The airport as the fast, dear door. Sidings and trains. Berths
per class. Nuclear. Obedience, the park, the police. The ride-along
camera behind a shipment.

## How each step is done

The same way as today: a spec section first if the design is not in
`game.md` already, a harness test that runs a day of the town and asserts
the behaviour, the change, a look at it running, a commit with the reason
in the message. Nothing is done until it has been watched.
