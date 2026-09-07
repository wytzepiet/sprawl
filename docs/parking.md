# Parking: lots, spots, manoeuvres and reservations

Status: specification, drafted 2026-09-06. §8 step 1 built the same day
in its generic form: every building has a two-spot lot on its driveway
(`world/lots.rs`), trips end in a spot and start from one, a parked car
carries its pose on the wire, and the client draws nothing it is not told.
The ring lot (§3.1), the plot laid out by its facing, the slab and the
ring drawn, staff at the door, and a full lot refusing the trip, are
built (2026-09-07), lots fuse along a frontage (§3.2), and a visitor
tap's slots are its lot's spots (§3.3), and a claim on a junction lasts
until the tail has cleared it (§4.2). Reverse is not needed until the
warehouse gets its bays; windows and the test lot are not built. Follows
`services.md` (streets, driveways, call-outs) and `residents.md` (how a
trip is chosen). `game.md` §People says parked cars sit in the building's
spots; this is how.

---

## 1. The idea

Four rules carry the whole thing.

1. **A lot is road.** The spots and aisles of a plot are nodes and edges
   of the same network cars already drive, hung off the driveway node.
   Nothing new moves; the queues, the following and the giving way that
   work on the street work in the lot.
2. **A spot is a node.** Parking is a trip whose destination is a spot.
   The server knows who stands where because that is where the trip
   ended. The client draws a trip; it never has to invent a spot.
3. **Reverse is a gear on an edge.** An edge entered backwards is driven
   like any other, slowly. Only the drawing and the right of way know.
4. **A reservation is a window on a spot.** A trip books a spot from the
   earliest it could arrive to when it plans to leave. What the resident
   already knows about its own day is what makes the lot's throughput.

## 2. What exists: how a car gets down a street

The mechanics the lot inherits, as they are built today, so the rest of
this document can say only what changes.

- **Nodes and edges.** A road node is an entity on a grid tile. An edge is
  a pair of adjacent nodes with a length and a queue of the cars on it, in
  order (`world.edges`, `EdgeSegment { length, cars }`). A car is a point
  on an edge with a nose and a tail of 0.175 tiles each, and it must keep
  `MIN_GAP` behind the car ahead in the same queue.
- **Runs.** Between two junctions the road is a *segment*: a run with
  nothing joining it. Each run remembers how long cars took to pass it, a
  blend of the last twenty or so, so a jam is remembered and forgotten at
  the rate of traffic through it (`network.rs`, `Passage`).
- **Pathfinding.** A* from run end to run end, cost in milliseconds: the
  learned passage where there is one, free-flow at cruise speed where
  there is not, and the crow's flight as the bound (`pathfinding.rs`).
  Routes step over whole corridors, not tile by tile.
- **Giving way.** A junction where paths can actually cross has a
  first-come queue. A car approaching registers its entry and exit arms;
  it is let through when its path does not cross anyone already passing,
  found by sweeping counter-clockwise from its entry arm, which is the
  right-hand rule. Without passage it must stop `INTERSECTION_STOP_MARGIN`
  short of the node. Its claim is dropped the moment its route index has
  passed the node (`intersection/mod.rs`, `simulation.rs`).
- **Trips.** A trip is born at a driveway node with a route, a free-flow
  ETA fixed at departure, and the physics to extrapolate from; it dies on
  arrival, when the car is placed on the building and the driver steps out
  (`spawn.rs`, `park_car`). The client draws every car from its trip,
  offset onto the right-hand lane, corners rounded.
- **Choosing a trip.** A resident scores each option by what it serves
  over the time from now until the visit ends. The journey is estimated
  as distance over cruise speed, times a detour factor, times a city-wide
  delay learned from every arrival. Departure is set so as to arrive as
  the tap opens; the resident waits at home until then, which is already
  the shape a full lot needs (`resident.rs`, `evaluate`).

Two things are missing for a lot and are all that §3–4 add: nodes off
the grid, and a claim on a junction that lasts for the vehicle's length.

## 3. The lot as a piece of road

Decided 2026-09-07 over drawings at the game's scale (a tile is 12 m, a
car 4.2 by 2.2, a one-way lane 2.4). The ring lot won; what follows is
its geometry and the rules around it.

### 3.1 The ring

A lot tile carries a one-way ring of lane hugging its edge, cars in the
island inside it, each spot a pull-through: in from the lane on the
street side, straight across the island, out onto the lane on the far
side. Nothing reverses, nothing waits for a car parking, and a car that
finds no spot drives round and out. The driveway joins the ring wherever
the street is, on any side, and a ring takes any number of entrances: a
road drawn into a lot tile is one more, not the old one moved. The loop
turns the way that puts the most front lane ahead of its entrances, a
car is handed the first free spot ahead of the entrance it comes in by,
so it is not sent round for one just behind it, and it leaves by
whichever entrance is nearest ahead.

The island of a one-tile ring is 0.4 wide: two cars across it. Wider is
better: a ring w tiles wide holds `floor((w - 0.6) / 0.2)` cars, so 2, 7,
12, 17, 22 for one to five tiles. Deeper is more rings: a lot d tiles
deep is d rings stacked, one per tile row, their side lanes in line so a
car carries on from one ring into the next; at a seam two lanes run side
by side, opposite ways. One generator, one shape.

### 3.2 Lots fuse

A lot is a run of lot tiles along one frontage, not a building's own.
Every kind that has a lot arrives with its lot tile on the street side,
and when two lot tiles touch they are one lot: one slab, one ring, an
entrance per building, spots shared. Two shops alone park two each;
together they park seven, four in a row seventeen. Nobody places the
strip mall; it grows out of shops arriving side by side, and a long
straight street grows better ones than a tangle. That is the mayor's
lever, and it is the thing the mayor already does. Extending a lot by
hand is a later purchase, not a requirement.

### 3.3 The lot decides the slots

Every visitor came by car, so a building serves at once exactly as many
as can park. Slots are a fact about the asphalt, not a number in a row: a
visitor tap's slots are the lot's spots (shared taps share them; the
Fuel tap's are its pump spots, which are pull-throughs with a pump). A
busier shop is a shop with a wider lot or a neighbour. A lot is never
bigger than its building.

Staff park unseen: their car drives the ring like anyone's, along the
back lane, and in at a door node under the building's front, where it
stops with no pose and is not drawn; it leaves the same way. Jobs stay
as the rows say. Lorries unload in the strip between the back lane and
the building, a bay entered from the lane and left onto it, when the run
is as long as the lorry; at a lone shop they stop on the back lane and
the island waits, or on the street outside, which blocks a lane the
honest way.

| Kind | Building | Lot | Visitors at once |
|---|---|---|---|
| House | 1×1 | driveway | its own 2 |
| Shop, bar, gas station | 1×1 | 1×1, fuses | 2 alone, 7 as a pair, 12 as three |
| Restaurant | 1×1 | 1×1, fuses | 2 alone |
| Apartment | 2×1 | 2×1 | 7 homes |
| Workshop, office, factory | as now | none | staff only |
| Supermarket | 2×2 | 2×2 lattice | 21 |
| Warehouse | 2×1 | 2×1, bays later | lorries |

### 3.4 Drawn as one unit

The plot is one slab of asphalt, 0.10 in from the plot's edge with the
street's kerb round it, corners rounded to 0.13, the building standing on
the back of it and the ring on the front. Box buildings get a corner
radius of 0.08, which is what keeps a corner out from under a diagonal
road's kerb; the gabled house and the sawtooth factory stay square. A
road that passes a slab's corner draws over it. The strip of land between
slab and plot edge is the map's green; the strip between two stacked
rings can be too, and an island end can hold a tree. No rule forbids a
diagonal road cutting a plot's corner; the padding and the radius absorb
it.

### 3.5 Lot nodes on the server

Lot nodes are server-only, made when a run is (re)computed and dropped
when it goes. A lot node is an entry in a side table on the world with
an id from the entity counter, so a route is one `Vec<EntityId>`
throughout, and edges into the lot are ordinary `world.edges` entries.
They are not in the run network: a route search ends at the driveway
node and the lot path is appended (§3.6). The client holds the same
generator in TypeScript and draws the slab, ring and spot markings from
a building's lot rectangle; nothing about a lot is streamed.

### 3.6 Routing

A route to a spot is the street route to the driveway node with the ring
path to the spot appended: along the lane to the spot's entry, through
the spot. A route from a spot is the spot's exit lane round to the
driveway and the street route on. The trip's length and free-flow ETA
include the ring, so a spot at the far end is honestly a little later.
A car with no spot drives the ring and leaves by the driveway.

Choosing *which* spot is §5. Routing takes a spot as given.

## 4. Driving in the lot

### 4.1 Aisles

An aisle edge is an edge with a speed limit, the way a corner already
imposes one: the obstacle scan emits `SpeedLimit` for the lot's edges at
lot speed, a third of cruise. Cars follow each other along it with the
same gap rule as the street. A car heading for a spot and a car leaving
one share the aisle in whichever order they got there.

### 4.2 Giving way in the lot, and the claim by length

Where a spot's edge meets the aisle is a node with more than two arms, so
it is a junction, so the existing first-come queue with the right-hand
sweep arbitrates it. A car pulling out of a spot registers its entry and
exit arms and waits for the aisle traffic already passing; a car on the
aisle waits for the one already pulling out. No new rule.

One change, and it is the one that makes backing up honest: **a claim on
a junction lasts until the vehicle's tail has cleared it**, not until its
route index has passed. Today a car is a point and the claim is dropped
at the node, which is fine at street speed and wrong for a vehicle
crawling through a node sideways for several seconds. The clearing test
becomes `progress > node_dist + tail`, where a car's tail is 0.175 and a
truck's includes its trailer. That applies to street junctions too, and
is the correct rule there as well; it makes a slow car through a junction
block the crossing traffic for exactly as long as it is in the way.

### 4.3 Reverse gear

An edge whose table entry says `Reverse` is driven like any edge, at a
crawl (a fraction of lot speed), and:

- the client draws the vehicle facing against the edge's direction;
- the vehicle's claim on the junction at the edge's start is taken before
  it begins, since it is the aisle it is backing out of or across, and
  held for the whole manoeuvre by the rule in §4.2;
- at that junction it has right of way: a reversing vehicle is slow and
  committed, and the sweep is skipped in its favour. Everyone on the
  aisle waits, which is the thing you asked for.

A truck arriving at a warehouse drives the aisle forward, past its bay,
to the bend beyond it, then takes the bay's edge in reverse. Leaving, it
takes the bay's edge forward and is on the aisle facing out. The table
says both: the bay hangs off the far bend, and its edge is reverse gear.

### 4.4 The trailer

The simulation never sees a trailer except as length. On the client, a
truck with a trailer is a second body: its heading is the direction from
its axle to the hitch on the tractor, and its axle sits one trailer
length behind the hitch along that heading, updated per frame. Forward,
that follower rule is stable and draws the right curve. In reverse, the
same pose is a function of where the tractor is along the bay edge,
whichever way it is moving; walk the tractor forward along the edge once
with the follower rule and keep the poses as a table per bay edge. Backing
in is the drive-out played backwards, which is what it looks like in
life.

## 5. Reservations

### 5.1 Windows

A spot holds windows: `(from, to, car)`, sorted, past ones pruned. A car
needs one window on one spot for its visit, and the visit is known at
decision time: it is the option's arrival and leave (`Verdict::Go`
carries both).

- `from` is the **free-flow ETA**: the earliest the car could be there.
  Nothing is reserved before that, since the car cannot be there before
  it, and the spot is someone else's until then.
- `to` is the option's **leave**, plus a little slack for the lot itself.

The window is booked when the trip starts, not when the option is scored;
scoring is speculative and happens at every wake. Between the two someone
else may have taken it, in which case `start_trip` fails the way it fails
for a blocked driveway now, and the resident re-decides at once. The
window is released when the car leaves the spot, and trimmed to now.

### 5.2 Choosing a spot and a time

Given a lot and a visit `[eta, leave]`, in order:

1. A spot with no window overlapping the visit. Nearest the exit first,
   which is a stable order from the table.
2. Otherwise, the earliest `t > eta` at which some spot is clear for
   `[t, t + (leave - eta)]`, over all spots. That is a merge over sorted
   windows, tens of entries, done once per option scored.

Case 2 is the throughput: the car does not need the lot to be empty now,
only to have a gap starting when it would arrive, and windows a little
into the future are exactly what the resident's own plan provides. The
delay `t - eta` enters the option as wait, the same as waiting for a tap
to open: `evaluate` takes `entry = max(opening, t)`, departure is set so
as to arrive at `t`, and the resident waits at home. A full lot makes an
option worse, not impossible, and a resident with a better option
elsewhere takes it. That is the choice the mayor should see in the
numbers: a lot too small shows as visits going elsewhere.

### 5.3 Plans are plans

A window is a claim on the future, and the future slips. The rules that
keep it honest are few:

- **Occupancy is truth.** The car in the spot has it, whatever the
  windows say.
- **Late arrival extends.** A car that arrives after `from` keeps its
  spot until it actually leaves; its window's `to` is moved when the
  resident's leave moves. The resident already re-decides on every wake,
  and each decision that keeps them there restates `to`.
- **A taken spot on arrival is reassigned.** A car whose booked spot is
  occupied when it pulls in takes any spot free at that moment. If there
  is none, it waits on the aisle behind the last car, which is the
  edge's queue doing what it does, and is served when a spot frees. That
  is the lot's failure mode, local to the lot; only when the aisle fills
  does it reach the street. It should be rare, since it needs a plan to
  slip by more than the slack, and it should be visible when it is not.

No window survives a save. Occupancy is derived from where cars stand,
and every resident re-plans on load.

### 5.4 Spots are slots

A tap's slots are the lot's spots (§3.3), so a window on a spot is also a
place at the tap: booking the one books the other, and a full lot and a
full shop are the same fact.

### 5.5 Trucks

A call-out's truck books a bay the same way: a call is answered with a
trip, and the trip's destination is a bay whose window starts at the
free-flow ETA. A depot with every bay booked answers later, which is the
dispatch time slipping, which is what a mayor who under-built the depot
should see.

## 6. What the player sees

- Cars stand in spots, facing the way the table says, so who is home and
  how busy a shop is reads from the lot (`game.md`).
- A full lot: the counter of visits turned away or delayed, on the
  inspect panel when it exists, and before that on `/debug/lot/{id}`.
- Cars queuing in an aisle for a spot: rare, and the sign that plans are
  slipping, which means traffic.
- Trucks swinging into bays.

Lots are part of the blueprint. Whether a lot can be enlarged, or a
separate lot placed as a service, is a later question; the design does
not care where the spot table came from.

## 7. The test lot

A row that is nothing but a lot, to build and tune the mechanics on
before any real building depends on them.

- `Lot`: 3×2, by hand, a Leisure tap open all day so it draws visits,
  no stock, no calls. Two rings stacked, 24 spots, entrances on two
  sides; later, two reverse-gear bays for trucks.
- Traffic from the stress harness: a painted town around it of a hundred
  commuters, the way `town` is run today.
- Read-outs on `/debug/lot/{id}`: windows per spot, occupancy by hour,
  visits delayed and by how much, cars waiting in the aisle, and the
  passage time of the aisle's junctions.
- What to iterate: lot speed, the slack, the crawl, the claim length,
  the spot order, and whether case 2 in §5.2 ever makes a queue.

It stays a row in `blueprint.rs` until a real kind wants it, and then it
is deleted or becomes the lot placeable.

## 8. Build order

1. **Lot nodes and trips to spots.** Lot nodes on the world; routes
   extended into the lot; `park_car` at a spot; the client draws cars from
   trips and poses. First-come spot choice, no windows. *Built* with one
   generic lot for every row: two spots on the driveway lanes, a car
   driving in past the driveway node and turning to come out nose first.
   A lot that is full swallows the car: parked, with no pose, unseen.
   Next in this step: lot tiles on the rows, runs that fuse, the ring
   generator on both sides, the slab drawn, slots from spots. *Playable:*
   cars in spots everywhere, and the first strip mall.
2. **Giving way by length, and reverse.** The claim held until the tail
   clears; lot speed; reverse gear with priority; the client flips the
   heading. Warehouse bays. *Playable:* a truck backs into a bay while a
   car waits.
3. **Windows.** Booking at departure, the merge in `evaluate`, release
   and reassignment. *Playable:* a busy shop whose visitors wait at home
   for a spot instead of circling, and the numbers to show it.
4. **The test lot** and its harness run, and the trailer drawing.

Roughly: 3, 2, 2 and 2 days.
