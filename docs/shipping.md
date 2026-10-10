# Shipping: lines, boxes, yards and the sea

Status: direction, 2026-10-10, argued at length and liked; the numbers are
open. The ferry harbour is built (§Built: the ferry harbour, at the end);
the container port, lines between harbours, the planner, charters and the
sea's lanes are not. Gathers what `trade.md` §Shipping said and the sea of
`multiplayer.md` §2.1, brought up to date. `trade.md` keeps the money:
coins, the world's prices, listings, contracts, top-up rules.

## The idea

The sea is the way between towns and to the world, and the player never
handles a ship. Real shipping keeps three things apart, and so does this:
who runs the ships, how a load finds its way, and who asks for it. And it
keeps the truck apart from the box.

The thing to get right is that it is a joy to watch. A ship comes in, a
tug or a crane takes its boxes off one at a time, a lorry backs up to a
box and drives it home, and an order you placed is a box you can follow
across the sea, through a hub, onto your quay and into your depot. A
harbour working is the most satisfying thing in the game, and it is drawn
as it happens, never as a number going up.

## The shipping company

One company, the world's, runs every ship. The mayor never owns one.

- **Lines.** A line is a timetable over a route of harbours, its ships
  sailing it in a loop, so every ship is somewhere at sea at every
  moment, on the map, and nothing has to dispatch it.
- **Ships sail on time, full or not.** A wait is for the next sailing,
  never for a shipload; small loads from many senders share a ship.
- **The company follows the traffic.** A busy pair of harbours gets more
  sailings and bigger ships, up to what a harbour's size allows, and the
  harbour grows that. A queue at the ramp is the signal, and is seen.
- **One kind of thing a ship.** The ferry carries people and their cars,
  and the world's trailers; the container ship carries containers; the
  tanker liquid and the bulker bulk, by the shipload (§Charters). A line
  is run by ships of one kind.
- **A ship holds what fits on it.** A ferry's deck is a grid of spots, a
  container ship's a grid of slots stacked a few high. A bigger ship is a
  longer hull you can count the difference on. Capacity is never a
  number chosen apart from the drawing.

## Boxes and lorries

**Boxes are the world's, lorries are the town's.** What travels is a box:
an unaccompanied trailer rolled off a ferry, or a container lifted off a
ship, which in the game are the same thing landed two ways. A box belongs
to the shipping company and is the load, not a vehicle. Lorries belong to
buildings, a depot's fleet, and only a town's own lorries drive its roads:
no outside vehicle comes to a depot for a dock it would have to find.
There is no trucking company (`shelved.md`, haulers); a depot is its own
haulier.

A lorry drives to the harbour, hitches a full box from the yard, drives it
home and unloads it into the depot's stock; the empty stays at the depot.
Imports are as fast as the town's lorries and the road from the harbour
make them, which is the traffic game.

**Empties ride back, and are filled when they can be.** Real shipping moves
about a fifth of its boxes empty, and tries hard not to. Here, the next
time a lorry drives to the harbour it takes an empty with it, drop and
hook: it drops the box in the yard and hitches the next full one, so an
empty costs no trip of its own. If the depot has something to export the
empty is filled with it first and goes back full (a street turn, in the
trade). A town that buys and sells carries something both ways on every
trip; a town that only buys drives empties about, and a depot whose lorry
never goes back gathers a stack of them, in sight. Exports are the same in
reverse. Later the world may charge less for what rides in a box that
would have gone back empty, as lines sell their backhaul cheap.

**Everything comes boxed at first.** Crates and timber in boxes, fuel in
tank boxes, gravel and cement in lined bulk boxes, on the same sailings
and through the same yard. One way to learn.

## Harbours

**The ferry harbour comes first.** A ramp and a trailer park, the way small
islands are supplied; no small harbour has a crane. The ferry carries the
settlers' cars and the world's trailers on one deck, so the deck is the
door's size, and a full ferry leaves a trailer for the next sailing,
queued in sight. Settlers drive off forwards into town.

**The harbour's tug** moves trailers between deck and park, as a port's
tugmasters do: it lifts a trailer's nose, backs it up the ramp into its
lane on the deck, and pulls it off forwards at the other end. The town's
lorries never board: they drop a trailer in the park and hitch another,
so none waits for a ferry, and the ferry sails on time with whatever the
tug got aboard. Loading is slower than unloading, and a crowded park slows
the tug, in sight.

**The container port comes later**, its own building: cranes, a container
yard, container ships on the company's lines, many more boxes for less
each. It is the Exchange (`trade.md`): trading at scale and trading with
other players are one step, and it is a building you can watch work.

**Berths for tankers and bulkers** come after it (§Charters).

**Harbours have yards.** A ship unloads into its harbour's yard, the
trailer park or the container stacks, boxes by where they go next. The
yard is a buffer in transit, not stock: nothing in town draws on it, and
a load is the town's only once a lorry has carried it to a depot. A box in
a yard waits for its next ship, a transfer, or for a lorry. The yard's
size is the harbour's, and a full yard is a jam you can see.

## Planning a shipment

**A shipment is planned, not driven.** The player says what, from where, to
where and by when: an order by hand, a top-up rule on a depot, a contract
with a player, a request from the world or someone the world stands for. A
planner finds its route over the timetables: the sailings, the changes of
ship at a hub, earliest arrival first. This is a journey planner, the
problem trains and container lines solved long ago (the Connection Scan
Algorithm: every departure in time order, swept once), and it is worth
making smart, because watching a load go to a hub, wait, change ship and
come home is the fun of it. A shipment that misses its connection is
planned again from where it is.

Every step is on the map and a click follows it: on a ship, in a yard, on
a lorry. Its arrival time is the plan's, and moves when the plan does;
because the world is the server's, a late load is late for a reason you
can see, a full yard or your own junction. A pin marks every load on its
way, and the ride-along camera (`shelved.md`) is for sitting behind one
and coming home with it.

**Urgency costs.** The timetable is the cheap, reliable way. An express
boat, sent for one load, is the fast and dear one; an airport later the
fastest and dearest. "I need it now" is always possible.

**A harbour can be a hub.** The planner may route someone else's cargo
through your container port: their boxes sit in your yard waiting for
their connection. For each one handled, onto a ship or off it, your town
is paid dues: coins in, a service sold across the border, and GDP, since
handling is work that adds value, as a port's is in any country's
accounts. Only others' cargo pays; a box of your own changing ship in your
own yard is your own pocket. Dues are per box handled, not per day
sitting, so a yard clogged with others' boxes costs room and earns nothing
more. A big port in a good spot is a way to play.

**Roads between towns are a choice.** Towns are not joined by road unless
their players join them. Islands, towns far apart and a shared road too
small for two towns' traffic stop being problems; a road link is built
when lorries beat ships, a neighbour close enough to drive to. The
planner uses one where it exists.

## Charters

When an order or a top-up is big enough to fill a ship, a tank farm with
room for a tankerful, a bulk yard emptying ahead of a big build, the
planner offers a charter: a tanker or a bulker for that one load, point to
point, cheaper by the unit and only for the whole of it. A flow that
recurs becomes a standing charter, a tanker every few days (a contract of
affreightment, in the trade). It lands at the harbour's berth for its
class: a tanker pumps straight into a tank farm built beside its berth, or
into the berth's tanks for the town's road tankers to carry inland; a
bulker's grabs unload onto a heap for tippers, or into a bulk yard at the
berth. Only a tank farm can take a tankerful and only a bulk yard a
bulkerful, which is what each is for: chartering is the step from a town
that imports to one that trades.

## The sea

From `multiplayer.md` §2.1, argued 2026-09-10, still the design; the fog
it spoke of is gone, so the horizon is the map's edge.

- **A ship fills its tile**, and is as many tiles long as its class, held
  along its path the way a lorry's nose and tail are held on a road. Two
  ships cannot share a tile.
- **Lanes are laid by routing, and nobody places one.** A voyage is a
  search over the water's tiles with heading in the state, and its path
  is remembered as a use stock on each tile with a direction, filled by
  the ships that take it and drained by time. The search weighs four
  things, and every behaviour is one of them:
  - **Along an existing lane, its way: cheap.** Reuse, so trunks form,
    crossings fall, and a bay reads like a separation scheme.
  - **Beside a lane, one tile clear: normal**, a little cheaper on its
    right. A return lane lies beside the outbound one with a tile between,
    so ships pass port to port with no rule about passing.
  - **Against a lane: dear**, and taking it makes the lane two-way. In
    open water this is never paid; a two-way lane appears only where there
    is no room for two, which is restricted water.
  - **A turn costs by its angle**, and a long class may not turn 90° at
    all, which is its turning circle.
- **A two-way lane is a block**, signalled as a single-track railway is: a
  ship reserves the whole run before entering, free or held by ships going
  its way, and waits at the mouth otherwise; a convoy goes through and the
  other side waits, as Suez runs, with Suez's fairness: once a ship waits
  at the far mouth the block closes to new entries, drains and flips. No
  deadlock.
- **Following is by tile.** Ships on the same lane tiles going the same way
  keep a gap by length; open water off the lanes has no interaction but a
  slower ship ahead.
- **Routing is on demand, over the tiles, cached**, the lanes a discount
  inside the search and never a graph it is confined to, so the straight
  line nobody has sailed is still found. A cache keyed by from, to and
  class, expiring with the use stock, makes the common voyage free; it is
  memoisation, rebuilt from nothing on load.
- **The berth is a lot**, as many tiles as the ship, queued for with
  `parking.md`'s reservation window. One berth and three ships waiting off
  the harbour is its rush hour.
- **Good coast is wide coast.** A bay that takes two ships abreast is a
  harbour; a fjord takes one at a time, and a port behind a one-tile strait
  has the strait's capacity. Terrain is not dredged, so where a harbour
  stands is a choice of bottleneck read off the map.

A ship's voyage and a timetable meet here: a line's timetable is planned
on the routed voyage's length, and a ship held up in a block or at a berth
is late, visibly, and the planner replans what was booked on it.

## Open

1. How the company decides sailings: a frequency per line from the last
   days' bookings, or a ship added when the next sailings are full.
2. What the planner minimises: arrival only, or arrival with the price,
   and whether the player can say "cheapest" or "fastest".
3. Where hubs come from: any port the planner finds useful, or ones the
   player declares; and what the dues are.
4. How a top-up rule books: "will I be under my floor by the next
   arrival", and how it avoids booking twice for one shortfall.
5. How much a box holds, and whether a part-full box sails.
6. How big an order has to be before a charter is offered, and whether the
   pipe from a berth to a tank farm is drawn or follows from their
   standing side by side.
7. Whether the world prices backhaul lower, and by how much.
8. Whether players run lines of their own one day, against `game.md`'s
   "the mayor never owns a ship".
9. The sea's small numbers: the use stock's drain, the four costs of the
   search, the passing width; the ferry's deck and the first sailings.

## Built: the ferry harbour

What runs, as of 2026-10-10 (`world/sea.rs`, `haul.rs`), and where it
parted from the direction above.

- **The harbour** is a kind like any other: a terminal row on the quay
  and a trailer park on the street side, 3 by 3, with its back to the
  sea and six tiles of open sea straight out behind it, which is the
  berth. It costs no timber: it is where timber first comes in. Its
  street is the town's way out: a road that reaches a harbour is joined,
  and one that reaches none is drawn red. The edge, its lorries and the
  port's call-driven ship are gone.
- **The quay is any paving at the water.** A built tile at the water's
  edge is drawn as water under it: the beach, cliff and foam step back,
  and the paving's edge is a stone wall straight down, capped
  (`town/draw.ts`, `TerrainChunks.ts`). The berth is a link span from the
  quay onto the ferry's land end under a gantry, two dolphins it lies
  between, a walkway out to them and bollards along the quay
  (`BuildingObject.tsx`). The rest of the shore stays rock and sand: only
  what the town paves becomes quay.
- **The ferry is double-ended**, as small island ferries are: it sails in
  one end first, lands its ramp on the quay, and sails out the other end
  first, so it never turns in the harbour and needs no room to. One
  ferry a harbour, the world's, on a fixed turn: two and a half hours
  from casting off to berthing again, an hour and a quarter at the ramp,
  first call half an hour after the harbour stands. It leaves the world
  with what was booked for it and the settlers waiting to come, and
  sails on time with whatever the tug got aboard; boxes it could not
  land ride round again.
- **The deck is the drawing**: fifteen slots, three lanes of five, a box
  or two settlers' cars a slot. Settlers board when the ferry leaves the
  world, roll off one every few seconds after it berths, and drive home
  from the harbour's street.
- **The park is the yard's docks.** A box stands in a dock where a
  docked lorry's trailer would. A lorry backs into a free dock to drop
  what it brought, moves along to the box it came for, hooks it, and
  drives home: drop and hook. The tug only takes a dock nobody holds.
- **The tug** shunts one box at a time: to the box, then with it. Off
  the ferry it backs bobtail up the ramp, tows the box down it and into
  a free dock from the quay side, so the box stands with its hitch to the
  lane for a lorry; onto the ferry it backs a box out of its dock and up
  the ramp, the box leading, to the deck's free slot nearest the sea end.
  It starts only what it can finish before the ferry sails.
- **A depot keeps one box**, on its lorry's hitch, not a stack in the
  yard: a lorry home from the harbour unloads onto the shelf and keeps
  the empty, and takes it back on its next trip, filled with what is sold
  if there is anything. A lorry fetches only a box its depot has room for
  whole, so no box waits half unloaded on a hitch.
- **Lorries are bought.** A depot comes with one and can import three
  more, forty coins each (`BuyLorry`): throughput at the border is a
  thing the mayor buys and can see, and four lorries through one
  junction is a jam they made.
- **The street turn.** A lorry with an empty, from a depot that sells a
  good, fills it at a maker's yard (a farm, a sawmill) and takes it
  straight to the harbour, and hooks an empty there for the next.
- **The lorry** is tapped (`Send`) or has standing orders (`Standing`).
  With either it goes when a box for its depot, or for the town, stands
  in a park, or when its depot has something to sell. The first lorry is
  tapped by hand; standing orders are one toggle on the depot.
- **Coins** cross at the harbour: an import is paid as its box lands in
  the park, an export as the ferry casts off with it, each a lump on the
  harbour. Booking checks the treasury against what is already booked.
- **The starter pack** is the first harbour's first sailing: three boxes
  of timber, one of crates, one of fuel, every box the town's (for the
  first depot's lorry to come), the world's gift. The town's first depot
  stands at once; everything after it is a site.
- **Rules** on a depot, a good each: keep above, fill up to, sell over.
  Under the floor, counting what is booked, at sea, parked or on a hitch
  for it, boxes enough to fill it are booked on the next sailing. Over the
  sell line, what is over goes out a box at a time, once it is a quarter
  of one. A new depot comes with rules for timber, crates and fuel.
- **Boxes per good**: a hundred crates, fifty tanks of fuel, twenty of
  timber. Nothing is boxed by class yet beyond the drawing: tank boxes
  and lined bulk boxes are the same box.
- **A box is drawn by what is in it** (`sea.ts`): crates in a dry van,
  ribbed across the roof, its doors a pale band at the back; fuel in a
  silver tank between two end frames; timber loose in an open tipper,
  logs as far along it as the box is full (a heap, for stone or gravel,
  is ready for a loose good to use). Each in its good's colour as the
  panels have it (`GOODS`). An empty, which has no class, is the tipper
  bare and pale. Seen from above, so all of it is on the top.
- **Seeing it**: `GET /sea` gives every shipment, timetable, park and
  lorry; `bun run act send|standing|order|sell` work the border by hand;
  `the_opening_from_the_harbour` plays the whole opening as a test.
