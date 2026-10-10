# Roadmap

How `game.md` gets built, in playable steps. Each milestone ends with
something you can sit down and play for an evening and notice is better
than the last. Estimates are working days for one person with an
assistant; they are guesses, and the order matters more than the numbers.

The next build is briefed in `plan.md`: the flat view, the terrain, the
tree switched off, then milestones 1 to 3 and the container port of
milestone 5, as one long run with the authority to do them as it sees
best. The milestones below remain the shape of the whole.

## Where we are (2026-10-10)

Built: roads and streets, one-way, buildings painted a tile at a time
with the hand's dots, residents with needs and commutes, call-outs for
stock, the supermarket, the farm with its land and tractor, the
sawmill, kerb parking before shops, offices and flats, day and night,
islands in one ocean, coast, trees and light. Milestone 0 is done, and
most of milestones 1 and 2: the ferry harbour is the only door
(`shipping.md` §Built), sites wait for their timber, the tapped lorry
and its standing orders, orders by hand and top-up rules on depots,
every shipment followable.

Not built, unchanged: parking past the kerb, power, fire, hospital, the
advisor, road speed and priority, levels, trains, multiplayer,
deployment.

## Milestone 0: The cut (done, 2026-10-10)

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

## Milestone 1: The opening (≈ 9 days)

The four beats of `game.md` §The opening, from nothing, in four slices
each playable on its own.

1. The ferry harbour, built by the player on the coast, as the one
   door (`shipping.md`): a ramp and a trailer park; the shipping
   company's ferry on a timetable, its deck as many cars and trailers as
   fit, carrying settlers in their cars and the world's trailers. The
   town's lorries hitch a trailer in the park and fetch it to a depot;
   empties go back with the next trip, filled with an export when there
   is one. No outside vehicle drives the town. The road's edge, the generated roads
   and the fog go (`shelved.md`, 2026-09-23).
2. Drafts (`game.md` §Drafts): every placement and demolition a draft
   until committed, blue and reserved, drawn on the map with its bill;
   commit, undo, discard. A draft takes up space and is wired into
   nothing.
3. The general depot, holding a little of every class, and sites: a
   placement waits for its materials, timber first, a lorry brings them
   from the depot, and it goes up as they land. A building's cost is a
   row on its blueprint. The first depot comes with a top-up rule on it,
   and a stalled site offers its own fix. `Need` splits into the needs
   and the goods, since timber is a good and nobody's need.
4. The starter pack: the first ferry's trailers, fetched by the town's
   one lorry, tapped by hand, from the harbour to the depot, with the
   camera on it the first time.

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
- Charters (after the container port, `plan-sea.md`): a tanker or a bulker for a shipload, landing at the
  harbour's berth for its class, and the standing charter for a flow
  that recurs (`shipping.md`).
- A full depot stops what fills it, and is seen.

*Playable:* a sawmill that stops the timber boats, and the road between
it and the building front as the thing you fix.

## Milestone 4: Roads that are roads (≈ 5 days)

- Per-edge cruise speed: roads faster than streets, in pathfinding and
  physics.
- Priority at junctions: roads over streets, via the intersection
  registry.
- Levels: an overpass is a road one level up; bridges over water, taking
  concrete and steel from stock.
- Roads draw gravel and asphalt from stock as they are committed, once
  the quarry of milestone 3 makes them.

*Playable:* an interchange that actually flows, and a bypass that empties
the high street.

## Milestone 5: Other people (≈ 10 days)

- Deployment: the server on a VPS, the client built, reconnects.
- Several towns on the islands, each with a build and a harbour; roads
  between them; `multiplayer.md` §4's claim.
- The container port, which is the Exchange: cranes, a container yard,
  container ships, and the trade board it opens: listings, standing
  offers, and contracts between players, the seller always delivering,
  from the world if it must.
- The shipping company's network: a line to every harbour, sailings
  that follow the traffic, the planner routing each load through hubs,
  dues for a hub's handling, and roads between towns where players
  choose to build them (`shipping.md`).
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
