# Multiplayer: one world, many towns, one sea

Status: specification, argued 2026-09-10 on top of `economy.md` step 4.
Nothing here is built; it is written so the reasoning is not lost before
the port milestone (`roadmap.md`). Builds on `economy.md` (the door, the
band, the crossing, the building's turn), `services.md` §5 (calls) and
the survey (`world.rs`, `revealed`). The archived guide's one hard rule
survives: a road that would disconnect someone from what they depend on
can never be demolished.

---

## 1. The idea

Several players build towns on one map. Each has a build, a treasury and
a GDP of its own (`economy.md` §1); the map, the fog, the sea and the
roads are shared. The outside stands beyond the sea and nowhere else.
Towns reach each other by road, and reach the outside by ship.

Five rules carry it, and each is a thing the game already has, moved.

1. **The door is a port.** No road runs off the map. The edge building
   (`blueprint.rs`, `Edge`) stands at a terminal on the coast, with the
   same taps, prices and crossing, and its lorries and commuters come
   off a ferry instead of appearing at a road end.
2. **The fog is the survey, and it is shared.** What any town has
   surveyed, everyone can see. Land nobody has surveyed is fog, and it
   is nobody's.
3. **The claim is influence, and influence is traffic.** A road tile
   holds a stock of influence per player, filled by that player's cars
   driving it, drained by time. Rights follow the stock.
4. **Trade wants itself.** A crate that goes down a road to the next
   town pays no crossing and waits for no boat; both towns' treasuries
   move on the same trade (`economy.md` §8.1). The region board shows
   the difference before a road is laid.
5. **Every town is coastal at birth.** Spawns are on the coast with a
   terminal; the interior is what towns grow into. Nobody is landlocked
   young.

## 2. The port

A town's terminal is the edge (`economy.md` §8.1): a building the mayor
did not place and cannot demolish, serving every good the outside sells
at the world's price plus the crossing, buying at less it, and hiring
at the edge wage. What changes is the delivery.

- **The ferry.** The world runs a service to every terminal: so many
  cars a sailing, so many sailings a day, and a crossing time. A car
  bound for the outside — a resident commuting, a lorry with a load to
  sell — drives onto the ramp and leaves the map as a depot's lorry does
  today (`calls.rs`, `AWAY_MS`); it comes back with the boat. Arrivals
  come off in a batch, which is the door's capacity, and the thing the
  road edge never had.
- **Capacity is what makes prices move.** While the berths are free the
  band holds as `economy.md` §8.1 says. When a sailing is full the next
  order waits, its lead time grows, its delivered price with it, and a
  town that has outgrown its ferry sees prices climb above the band
  until it builds the second terminal. The reorder point learns the
  lead (`economy.md` §12.3) and orders earlier and bigger on a slow boat.
- **The queue at the ramp** is traffic with a cause: the town's own
  demand for the outside, and the morning boat unloading is rush hour.
- **The tree raises the service.** A bigger terminal is more sailings;
  a berth is a cargo ship, a bigger batch at lower freight per crate;
  one berth per handling class — oil, bulk, containers — as
  `economy.md` §7 files. Ships the mayor owns are haulers, filed until
  a reason.
- **Nobody eats abroad.** The outside hires by ferry and sells by ship;
  it does not serve a meal. A town eats what it makes and what the boat
  brings while it can pay (`economy.md` §9).

The port row is three numbers: cars a sailing, sailings a day, the
crossing time. Set per season.

### 2.1 The sea

The sea is one body, big enough that its middle is fog. Surveyed water
is navigable water; ships do not enter fog, and the fog line at sea is
the horizon: where the outside's ferry appears, and where every arrival
is first seen. Nothing is spawned off-coast in secret, because the fog
is where the world begins. A port town that surveys a wide bay has a
long approach.

- **A ship fills its tile**, and is as many tiles long as its class: a
  ferry one, a container ship three, held along its path the way a
  lorry's nose and tail are held on a road. Two ships cannot share a
  tile.
- **Lanes are one-way, and laid by routing.** Nobody places a lane. A
  voyage is an A\* search over the water's tiles with heading in the
  state, and the lane is the path it took, remembered as a **use**
  stock on each tile with a direction, filled by the ships that take it
  and drained by time (`economy.md` §4, one type). "Existing" means
  used; a removed port's lanes fade in a day, and nothing sailed last
  season steers this one. The search weighs four things, and every
  behaviour below is one of them:
  - **Along an existing lane, its way: cheap.** Reuse, so trunks form,
    crossings fall, and a bay reads like a separation scheme.
  - **Beside a lane, one tile clear: normal**, and a little cheaper on
    its right. A return lane lies beside the outbound one with a tile
    between, so ships pass port to port with no rule about passing.
    Lane, gap, lane is three tiles: the passing width.
  - **Against a lane: dear**, and taking it makes the lane two-way. In
    open water this is never paid, since the tile beside is always
    there; a two-way lane appears only where there is no room for two,
    which is restricted water, and two-way is what a block is.
  - **A turn costs by its angle**, 45° a little, 90° a lot, and a long
    class may not turn 90° at all, which is its turning circle. Lanes
    come out as the diagonals and doglegs of a chart, and a lane a
    ferry laid is one a container ship can follow.
- **A two-way lane is a block**, signalled as a single-track railway
  is. A ship reserves the whole run before entering, `parking.md`'s
  reservation window over a passage instead of a spot: free, or held
  by ships going the same way, it enters and follows; held against it,
  it waits at the mouth, first come, ties by length. Same-direction
  ships go through as a convoy and the other side waits, which is how
  Suez runs, and with Suez's fairness: once a ship waits at the far
  mouth the signal closes to new entries, the block drains, and it
  flips. A block is the whole two-way run, however many pieces or
  branches, so a ship in one waits for nothing but its own exit, and
  there is no deadlock.
- **A lane is a segment.** Ships on a lane going its way follow each
  other with a gap by length, as cars on a stretch do; a convoy is
  ships that want the same thing at the same time. Open water off the
  lanes has no interaction, and nothing slows a ship there but a
  slower one ahead, which is another class, passing on the outside.
- **Routing is on demand, over the lanes.** A voyage is a search over
  the lane graph — ports, junctions, mouths — as cars route over
  junctions and stretches, not tiles. Tiles are searched only to join
  it: from a port no lane reaches, or across a gap between two lanes,
  and the search lays a lane behind it so the gap is closed for the
  next ship. The first voyage between two far ports is the dear one and
  happens once; the cost of the sea is how much new water gets opened,
  not how many ships sail. Nothing is generated when a port is placed.
- **The berth is a lot**, as many tiles as the ship. Ships queue for it
  with the same reservation window. One berth and three ships in the
  roads is the harbour's rush hour, and the capacity that lets prices
  leave the band.
- **Good coast is wide coast.** A bay that takes two ships abreast is a
  harbour; a fjord takes one at a time and every arrival queues at its
  mouth. A port behind a one-tile strait has the strait's capacity, not
  the berth's. Terrain is not dredged, so the coast a town spawns on is
  the port it gets, and where the terminal stands is a choice of
  bottleneck read off the map. This is `economy.md` §13.6's mechanism.

Shipping is one search on a water grid with four costs, one physics
profile, slow with a long stop, and a use stock on tiles; everything
else it needs is a lot, a reservation or a segment already written.

## 3. The fog

The survey is what stands: a building surveys the land around it
(`REVEAL_RADIUS`), and a laid road surveys a strip beside it. In one
world the surveyed set is one set: any town's survey is everyone's to
see. Fog is the rest.

- **Fog is nobody's.** Anyone may lay road into it; the strip it
  surveys is then seen by all and claimed by whoever drives it (§4).
- **Building toward a neighbour lifts their fog.** That is settling the
  land between, and it is symmetric: both lose the fog and gain the
  road.
- **You can see the lights.** A client pans anywhere surveyed, so from
  day one every town sees its neighbours across the dark, and the
  region board (§5) shows what they are short of before the road meets.
- **Lifting fog is not free.** The road allowance and the price past it
  are the brake on surveying toward a rival with road; the survey may
  follow only buildings a road reaches, which is already the test of a
  building's existence. Both are numbers.

## 4. The claim

A road tile holds one stock per player (`economy.md` §4: one type),
filled by that player's cars driving it, drained by time, and seeded on
a driveway by the building placed at it. What a player may do follows
from whose stock is largest:

- **Build beside a road where your influence is the largest.** A road
  in fog has nobody's; the first town whose people drive it has it. A
  road two towns' commuters share is both towns', and either may build
  beside it. Borders follow use and move as towns grow, drawn by
  nobody.
- **Demolish only what is mostly yours**, and never a tile whose loss
  would disconnect another player's traffic from what it reaches. The
  second half is the archived guide's rule, and it is what makes
  griefing pointless: a road two towns depend on can be cut by neither,
  and influence can be gained only by needing a road.
- **No table of territory.** Ownership is derived from what drives,
  like every other index in `world.rs`; a world reloaded settles the
  same claims from the same traffic.

Influence cannot be farmed, because cars are residents' decisions, not
the player's: a loop that makes trips is a town.

## 5. Why roads get built

Nothing incentivises trade; the rows do.

- **A neighbour's crate skips the crossing and the boat.** The seller
  keeps their third without the tariff; the buyer pays less than the
  port and waits for nothing. Both treasuries move. Labour is the same:
  a bedroom town's people need desks, a factory town's desks need
  people, and only a road carries them without a ferry.
- **The region board** (`economy.md` §10): per good, per town, price,
  stock and trade. Fuel at 2.9 here, 2.1 next door, 3.3 off the boat.
  A proposed road shows what it would save at today's prices, both
  towns' books side by side; the game knows both numbers.
- **Resources are not everywhere.** Oil under one town, flat land in
  another, deep water in a third (`economy.md` §11.4, §13.6). Then a
  town without oil does not save a tenth by trading; it cannot make
  fuel at all except off the boat, and the neighbour's well is the near
  seller.
- **The crossing is the tariff.** Outside the region it is paid, inside
  it is not, which is what a trade bloc is. One number, and the one to
  raise if roads are not getting built.
- **The port town.** A town whose row is the door: every terminal class
  on its coast, a share kept on every crate that lands, and
  distribution sold inland by truck and later by train. Specialisation
  in the good the outside is nearest to.
- **A season scored on GDP or treasury** makes a good road a shared
  win: both rise on the same trade.

## 6. Spawning

Towns spawn on the coast with a terminal, spaced so their surveys do
not touch: more than two survey radii apart. Fifty spawns on one day are
fifty coastal towns with fog between them, each with its door, none in
anyone's shadow. The interior is settled by growth, and a young town
walks into it only by choice.

What separates towns later is geography, and that is the game: the
coast keeps its door, the interior has its neighbours.

## 7. What moves

Every delivery is a trip on the map (`economy.md` §6.1), and the ones
this document adds are the same rule:

| good | who moves | in what |
|---|---|---|
| the outside's goods and people | the world's ferry | a batch at the ramp |
| crates between towns | the seller's van or lorry | the road between |
| labour between towns | the resident | the commute down the road |
| a farm's crop | the farm's tractors | over the fields to the yard |
| oil, bulk, containers | a ship per class | a berth each |

## 8. Order to build

Nothing before the port milestone. Then:

1. **The coast.** Map generation with a sea that is one body and fog in
   its middle, and spawns on it. The pre-existing road network and the
   road exits go; the terminal stands where a road meets the coast, and
   every town starts with one.
2. **The ferry.** `AWAY_MS` with a timetable and a batch. The edge's
   lorries and commuters ride it. The port row's three numbers.
3. **The shared survey and the road strip.** Roads survey; any town's
   survey is everyone's.
4. **Influence.** The stock per tile per player, filled by traffic,
   seeded by placement; build and demolish rights from it; the
   disconnection rule.
5. **The region board and the road's savings line.**
6. **Berths and ships per class**, with the handling classes of
   `economy.md` §7, and the port town.

## 9. Open

1. The width of a road's claim, and the survey radius in a shared world.
   The sea's small numbers: the use stock's drain, the four costs of
   the search, and the passing width.
2. Whether influence needs buildings as a source at all, or a placed
   building's driveway is the only seed.
3. The ferry's three numbers per season, and the first sailing's hour.
4. Whether a mainline nobody owns should be born with the map, joinable
   by anyone, if playtesting says towns do not find each other.
5. The edge's prices as the region's — what the towns around a door
   trade at, aggregated slowly — once doors are shared (`economy.md`
   §8.1).
