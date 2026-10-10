# The sea: a build plan for plan item 10

Status: plan, 2026-10-10. This is a brief for one long session. It
builds on what runs (`shipping.md` §Built: one ferry per harbour, a tug,
a trailer park, depots' lorries, rules), and covers `plan.md` item 10:
the container port and the network. Where it parts from `shipping.md`
it says so and gives the reason. Change the other documents to match as
each stage lands.

## What it is for

Today the sea is one ferry per harbour, a shuttle to a world 48 tiles
out that then disappears. Item 10 makes the sea a place: ships you can
see from berth to berth, lines between your harbours, a box that changes
ship and comes home, and a door that grows when the ferry is the jam.
Every stage below keeps the feel: everything is a vehicle you can watch,
the player's decisions are on the map, and automation is earned and
seen.

## Decisions

**The second harbour is your own.** In single player the second harbour
is one *you* build on another island. The terrain already makes islands
with their own character (forest, mountain; `terrain.rs`) so that towns
have reasons to trade, and the cheapest way to use that is to let the
player build an outpost there. A sawmill on the forest island needs a
harbour, a depot and a few houses, and its timber has to sail home. That
is the network in miniature, and it rehearses multiplayer exactly: a
second harbour on another island, on the same lines. It needs no AI and
no prices between harbours (every box is the player's), and the existing
code already brings settlers in by their nearest harbour
(`waiting_settlers`). Computer towns are postponed, not cut: they are
the order board (`trade.md` §Open 3) and the first payers of dues, and
they come after this plan.

**The world is the map's edge.** A line to the world sails to the sea
tile on the map's edge nearest its last harbour, in sight all the way,
and leaves the map there. `shipping.md` §The sea already says "the
horizon is the map's edge", while the code cuts the voyage off at
`HORIZON` (48 tiles); the code is brought in line. The world is where
imports come from and exports go, not a place your own boxes change
ships: a box between two of your harbours that went out to the edge
and back would be absurd at forty tiles apart. (The player, 2026-10-10:
"there needs to be a mechanic to adopt new more direct lines fast,
especially between your own ports.")

**A new harbour is connected the day it stands.** Building a harbour
should change the map at once, so the company does not wait for
traffic it has no data for: the cold start is answered from the map and
from what the towns want, not from history.

- **The forecast decides; the map only makes it fast.** Your harbours
  are not always worth joining: two a short drive apart are joined
  already (a lorry does it), and a harbour that only imports for its own
  town has nothing to carry to the others. (The player, 2026-10-10:
  "mostly yes, but not necessarily always"; and "you can drive from Spain
  to Morocco, but you wouldn't if you can ship".) So the test is which
  way is faster, not whether a road exists: when a harbour stands, the
  company joins it to the nearest of your harbours where the sea leg,
  with its loading at both ends, beats the road by `SEA_GAIN` (a third),
  or where there is no road at all, and only if the forecast (below)
  says boxes would flow: one side makes, or holds over its sell line, what the other
  side's rules keep. Then the first sailing leaves within the hour. If
  not, there is no line, and the harbour card says why and what would
  open one: "No line to Home harbour: nothing to carry yet. A sawmill
  here, or a timber rule there, would open one." A third harbour joins
  its nearest the same way, so connected harbours grow as a tree. Each
  harbour keeps its own ferry to the world as well.
- **The sailings are sized by forecast, not history.** What a line is
  worth before any box has moved is what its two ends say they want:
  the depots' rules (keep, fill, sell, the same numbers `top_up` books
  against) and what the makers near each harbour make a day. That gives
  boxes a day each way, and the sailings a day follow from it.
- **A box waiting is a signal now.** Demand counts when a box is booked
  or stands in a yard for a call with no direct line, not when it is
  delivered. A backlog for one pair, `BACKLOG` boxes, opens a line or adds
  a sailing at the next departure, not at midnight.
- **Lines prove themselves.** A new line is on trial for its first
  `TRIAL` days, drawn as such on its card; after that the loads it
  carried thicken it, thin it, or withdraw it, with a day's notice in the
  news. The forecast starts it; what moves keeps it.

The harness carries a scenario for exactly this, `new port`: a third
harbour built mid-run, asserting the time to its first direct sailing
and the share of sailings that leave near empty.

**Routing is decided where the box stands.** A box carries no stored
plan. At a yard, when a ship is loading, the box boards if this ship is
the first leg of its earliest journey from here, found by a Connection
Scan over the published timetable. A missed connection replans itself,
because the next ship asks again. This follows `haul.rs`'s rule ("a
lorry reads what it should do from where it is and what it carries").
The ETA shown is the same scan, run on demand.

**A route is computed once per leg and kept.** The sea does not change:
terrain is not dredged and harbours are buildings, so the route between
two berths is a pure function of the map. A route is found when its line
is made, kept on the line, and rebuilt from nothing on load, like the
other caches. The `shipping.md` design is cut for now: lanes as a use
stock on every tile, a heading in the search state, four tuned costs.
That design solves dense traffic, and this game has a handful of ships.
The parts that show are kept, more cheaply:

- **Trunks** form on their own. Shortest paths round the same headland
  pull to the same corner points, so lines share legs.
- **Two-way separation** is a fixed offset. A ship keeps `KEEP_RIGHT` of
  a tile to the right of its leg's centreline, so ships on one leg in
  opposite directions pass port to port, half a lane apart. No rule
  about passing is needed.
- **Blocks** apply only to narrow water. A run of a route where the
  clearance is under two ship widths is a block, held by ships going one
  way at a time, with Suez fairness (`shipping.md` §The sea). It is built
  in the harness first; the game needs it only where a harbour sits in a
  fjord.

If the pictures show spaghetti, add lane attraction back then, as a
discount in the same search.

**A container is a trailer.** `shipping.md` already says it: one box,
landed two ways. `Trailer` stays the only box struct. The container port
is a separate building because it is a separate thing to watch (cranes,
stacks, a bigger ship), not because the box is different.

**The Exchange is cut from item 10.** Its job is the trade board:
listings, standing offers and contracts with other players. In single
player the only counterparty is the world, and the harbour card already
trades with it. The building comes with its first counterparty
(computer towns or players). Until then the container port is just the
bigger door.

**Charters, dues and express boats are deferred.**

- **Charters** need bulk and liquid classes, a tank farm and a bulk yard.
  None of these exist (the goods are crates, fuel and timber, and fuel
  rides in a box), and chains (item 9) have not made the volume that
  would fill a tanker. Charters come after the chains that need them.
- **Dues** are paid only on other people's cargo, and a single player
  has none. The harness counts the boxes a port handles for others, so
  the numbers are ready when computer towns arrive.
- **The express boat** is cut. The ferry is frequent enough at this
  scale.

## The numbers, measured

A spike over seeds 0 to 19 (8-way Dijkstra over the sea tiles, since
deleted):

- **Voyage lengths.** From the home island's coast to the other islands
  is 90 to 720 tiles sailed, about 350 at the median, and 1.05 to 1.4
  times the straight line. To the map's edge is 350 to 490 tiles.
- **At today's `PACE`** (1.2 s a tile), 350 tiles is 7 real minutes, or
  8.4 game hours, at speed one. That is too slow beside a 2.5-hour ferry
  turn. Built: ships sail at `SEA_PACE` (200 ms a tile, `PACE / 6`) at
  full speed and gather way over `GATHER` (30 s) from a berth, covering
  the first fifty tiles at half speed on average. The map's sea is
  compressed (islands 36 tiles apart, about 430 m), so the ships are
  too, honestly. The edge is then 2.1 to 2.3 hours from the home coast,
  the other islands 1.1 to 3.1.
- **Search cost.** A single-source flood over all ~850k sea tiles with a
  `HashMap` took 1.3 to 2.1 s. A coarse 8×8 grid, a cell open only if
  every tile in it is sea, could not leave a coastal start (seed 1). So:
  a flat `Vec<u8>` clearance grid (distance to land, capped at 15),
  computed once per seed, and point-to-point A* on tiles, 8-way, octile
  heuristic, extra cost where clearance is under 3, then string-pulled to
  waypoints along lines of sight. Budget: 50 ms a route, paid once per
  line.

## The harness comes first

The router and the planner can be tested in isolation, so they are
built that way and iterated against numbers before the game sees them.
Built 2026-10-10 (stage 1); this section says what is there.

**Pure functions over plain data,** in `server/src/shipping/`, which
never names `World` or `EventQueue`:

- `mod.rs`: how a ship moves along a leg. `covered(len, ease, t)` and
  `sail_ms(len, ease)`: a ship gathers way at an even push from rest
  over `GATHER` (30 s) at an end that is a berth, and loses it the same
  way coming in; at full speed it takes `SEA_PACE` (200 ms) a tile; at
  the map's edge it is at full speed. This replaces the plan's
  `SEA_PACE`/`PACE`/`APPROACH` three-part speed: one law, two numbers,
  invertible in closed form, which the client reads the same way.
- `water.rs`: `Water { x0, y0, w, h, clearance: Vec<u8> }` from any
  terrain map (`Water::of`), clearance being steps to land, eight ways,
  capped at 15. `Berth` moved here from `world/sea.rs`.
  `route(&Water, from: &Berth, to: End::Berth | End::Edge)` is A* over
  tiles (eight ways, no corner cutting, +3 tiles a step at clearance 1,
  +1 at 2), pulled tight along lines of sight that keep as far off land
  as the tiles they replace (up to 3), its corners rounded to arcs of
  `ROUNDING` (4 tiles) where they fit on the water and the legs have
  room, tighter where not; it starts and ends at the moored ferry's
  middle, straight along the berth's line, and an edge route runs out
  over the map's border. `narrows(&route)` is the runs of clearance 1
  beyond the berths' approaches. `tightest(&route)` is the class check:
  no turn tighter than `TURN` (half the ferry's length) outside the
  berths' own `BERTH` tiles, where the ferry turns on its thrusters.
  The `KEEP_RIGHT` offset is not built: with one ferry a line nothing
  passes, and it is the first thing to add when two ships share a leg.
- `lines.rs`: `Call = Harbour(u64) | World`. `Line { calls, legs, ships:
  Vec<(id, first departure)>, slots, dwell, stay, every }`: each ship
  keeps its own phase, so a sailing is added at a departure without
  moving the others. `timetable(&[Line], from, until)`;
  `earliest(&[Connection], from, to, ready)` is the Connection Scan,
  with `TRANSFER` (half an hour) to change ship at a harbour and no
  changing ship at the world at all; `boards(..)` is the boarding
  decision. The company's rule: `opens(forecast, same_road)`, a line
  only where the forecast says boxes would flow and no road joins the
  two; `prior(ways)` picks the nearest harbour by sea not on the same
  road network; `Line::sized(per_day, ceiling)` turns a forecast into ships,
  a dwell (the tug's time for a call's share, `MIN_DWELL` to `DWELL`) and
  `every`, no more sailings than fill half a box; `backlog(line, left,
  full)` turns boxes left behind into a `Change`: a longer dwell when the
  deck had room (the tug was short of time), a sailing more when it was
  full; `slot(lines, line, at, from)` picks when a new sailing leaves.
- `open_lines(&History)` and `dues` are not built: the first is replaced
  by the prior and the backlog (§Decisions), the second waits for
  boxes that are not the player's.

**The clock face** (found by the harness, not in the first plan). With
one berth a harbour, its world ferry and a line to another harbour met
at the berth: on `two`, 65 hours of ships waiting in ten days; on the
hub, the queue grew without end. Slotting a new line into a free window
did not help while rounds were three and four hours long: they meet
every twelve hours whatever the phase. So every line's round is a
power of two of `TAKT` (an hour): 1, 2, 4, 8 hours. Of any two lines at
a harbour one's round divides the other's, their berth windows keep
their places on the clock, and `slot` puts a new line's sailings in the
first window clear at both ends (a quarter hour of overlap allowed).
What a round has to spare is spent at the world, or at the anchorage
off the first call. Berth waits fell to a few minutes in ten days.

**A scenario harness**, `shipping/sim.rs` (test only). A discrete-event
loop: ships sail their routes by `covered`, queue for the one berth,
wait at the anchorage when early, cut their dwell to half when late,
and load and land by `boards`. The land side is rates: each harbour's
tug moves `tug` boxes an hour (one at a time, only what it can finish
before the ship sails) and its depot's lorries make `dray` round trips
an hour, drop and hook, as `haul.rs` does: an export filled from the
empty the depot kept, or a spare empty out, and an import home. The
world keeps `EMPTIES` standing in each yard. The company's rule runs
as in the game will: a harbour standing gets the world's ferry, and a
line to its nearest by sea once its forecast (the scenario's demand
from and to it, `from=` a day for a maker or rule that starts later)
says boxes would flow, asked again each midnight; a departure that leaves `BACKLOG` boxes
behind changes its line. Blocks are not built (stage 5).

**Scenarios are text** in `server/scenarios/*.txt`. The grid comes
first: `~` is sea, `.` is land, `A` to `Z` but `W` are harbours (the
letter on the quay tile, land behind it, `BERTH` tiles of sea straight
out), and the map's border is the world. Below the grid, directives:

```text
harbour A docks=9 dray=4/h tug=4/h day=0 road=1  # stands on day 0
line A B ships=2 dwell=1h                 # a line besides the company's
demand B->A timber 6/day from=0           # even times; W is the world
stay 0.5h                                 # beyond the edge
days 10
expect delivered >= 0.95                  # any metric; hours bare
pending stage 5: blocks                   # runs, prints, asserts nothing
```

`cargo test scenario -- --nocapture` runs all of them, twice each to
check the hash, and `SCENARIO=two` one. Each prints its pages (the
company's moves and a line a day) and a row of the table. `SVG=1`
writes `.dev/scenarios/<name>.svg`: land, each line's legs, the narrows
in red, the harbours, and a dot every ten minutes for each ship.

**The metrics** (hours where a time):

| Metric | What |
|---|---|
| `delivered` | boxes landed at their destination ÷ boxes quoted to land by the end |
| `transit`, `transit_p90` | ready to landed |
| `late_p90` | p90 of landed − the ETA quoted when the box was made |
| `stretch` | mean transit ÷ mean quoted transit |
| `transfers` | mean ship changes per box |
| `via_world` | boxes between two harbours that went by the world (must be 0) |
| `missed` | box-departures a ship sailed without, deck full or the tug out of time |
| `util` | boxes aboard at each sailing ÷ slots, mean over lines |
| `empties` | empty box-rides ÷ all box-rides |
| `berth_wait`, `wait_max` | ships off a harbour, in all and the longest |
| `block_wait` | 0 until stage 5 |
| `yard_peak` | most boxes in any yard |
| `landed_per_call` | boxes off a ship at a harbour, per call: the calibration |
| `coins_in`, `coins_out` | the world's prices for exports landed beyond and imports landed |
| `first_sailing` | the longest from a line between harbours opening to its first sailing |
| `forecast_ratio` | worst of forecast ÷ carried (the busier way, a day, after the trial), or its inverse |
| `near_empty` | sailings between harbours after their trial with no full box aboard |
| `links`, `idle_lines` | lines between harbours, and those opened on a forecast of nothing |
| `flow_to_line` | the longest a harbour with a flow forecast waited for its line |

**The scenarios, as they stand:**

```text
scenario     delivere  transit transit_ late_p90  stretch transfer   missed     util  empties berth_wa yard_pea landed_p coins_in coins_ou
congested        0.99     2.90     5.67     1.11     1.18     0.00     0.00     0.04     0.62     3.75     5.00     0.56     0.00  1056.00
hub              0.99     5.39     8.84     5.36     1.53     0.36    29.00     0.03     0.20     2.31     5.00     0.45   360.00   880.00
new_port         0.98     5.70     9.65     5.00     1.54     0.30    50.00     0.03     0.40     0.05     7.00     0.63     0.00   660.00
strait           0.99     4.64     5.78     5.06     2.41     0.00     0.00     0.02     0.10     0.01     4.00     0.53     0.00     0.00
two              1.00     3.36     3.50     0.25     1.08     0.00     0.00     0.04     0.55     0.01     5.00     0.63   360.00   660.00
world            1.00     1.82     1.82     0.57     1.37     0.00     1.00     0.04     0.46     0.00     4.00     0.69    54.00  1540.00
```

1. **`world`**: one harbour, today's ferry (fifteen slots, an hour and a
   quarter at the ramp, a 2.5-hour turn by its `stay`) and the season
   town's trade. Calibrated on `landed_per_call`: the season test, ten
   days, lands 56 boxes off 65 calls, 0.86 a call; the harness 0.69.
2. **`two`**: the outpost linked to home the hour it stands; no box goes
   by the world, the first sailing within the hour.
3. **`hub`**: three outposts round a central harbour that stands first,
   so the prior builds the hub; `stretch` 1.52, nothing by the world.
4. **`congested`**: the hub's one berth with four lines; waits visible,
   none longer than four hours.
5. **`strait`**: pending stage 5; the narrows are drawn.
6. **`new_port`**: C stands on day 3 and is linked to B, its nearest, so
   its trade with A changes ship at B (`transfers` 0.30). D stands on
   day 4 with nothing to carry and gets no line (`idle_lines` 0) until
   its maker starts on day 6, when it is linked that midnight
   (`flow_to_line` 0). The plan's targets are not met yet: B's one berth
   takes four lines, and the fourth's first clean window is 1.9 hours
   out (asked: an hour); a third of sailings after the trial carry no
   full box (asked: a quarter), the light way of an uneven trade. The
   scenario holds today's numbers (2 hours, 35%), to be tightened as
   they improve.

## Stages

Each stage leaves the game playable and the suite green
(`cargo test && cargo check`, `bunx tsc --noEmit -p .`, `season`,
`the_opening`, `every_seed`), and ends with pictures (`bun run look`,
`bun run plan --live`).

### Stage 1: the harness and the water (no game change)

- **Player.** Nothing yet. The engineer gets `cargo test scenario` and
  the SVGs.
- **Data.** `shipping::{Water, Line, Call, Connection, Journey}` as
  above. No change to `protocol.rs`.
- **Systems.** `water.rs`, `lines.rs`, `sim.rs`, the scenario parser,
  the metrics, and the five scenarios. Calibrate `world` against the
  game's ferry.
- **Tests.**
  - Every scenario's `expect`.
  - On seeds 0 to 19: a route from the home island's best harbour site to
    the edge and to every island never crosses land, has no turn sharper
    than `shipping.md`'s class limit, and is found in under 50 ms. This
    extends `every_seed` (ignored).
  - Same input gives the same hash.
- **Deleted.** Nothing. This stage is the instrument.
- **Built** (2026-10-10): as §The harness comes first says, with the
  clock face it found. On seeds 0 to 19, 125 ways (the edge and every
  other island from the home harbour site nearest the origin): median
  4.4 ms, p90 13 ms, worst 22 ms; the edge 454 to 493 tiles, 2.1 to 2.3
  hours. `cargo test every_seed -- --ignored` runs it.

### Stage 2: ships sail real routes (one harbour, the world)

- **Player.** The ferry comes in from the map's edge along a smooth,
  plausible track, past headlands rather than through them, and leaves
  the same way, keeping right. The harbour card says "At sea, 40 tiles
  out" and draws the voyage line from the route, not from a guess.
- **Data.**
  - The ship's `run: Option<Run>` (tiles, a pace) gives way to a
    `sail: Option<Sail>`, with `Sail { path: Vec<[f64; 2]>, started,
    ends, ease }`. It has the shape of `Shunt` and is sent once.
  - `Run` stays for the tractor.
  - `World.water: Water` is built at load, and `World.lines` holds one
    line per harbour, `[Harbour(h), World]`, made in `commission`.
- **Systems.**
  - `ferry_wake` sets a `Sail` from the line's leg.
  - The ship wakes only at the chunk crossings along the path (for the
    spatial index) and at arrival, not every tile.
  - `TURN` is no longer a constant. It is the line's cycle: the legs at
    `SEA_PACE`, the dwell, and `WORLD_STAY` beyond the edge.
  - `next_call` reads the timetable.
- **Client.**
  - `sailing()` in `sea.ts` reads a pose at a time off `Sail.path` with
    the same ease. It no longer rebuilds a path from tile centres or
    guesses inbound by which end is nearer the berth (`CarObject.tsx`).
  - The route is drawn faintly on the water while its harbour is
    selected.
- **Tests.**
  - `the_opening_from_the_harbour` unchanged, still green.
  - A ferry's `Sail` never crosses land on the opening's map.
  - The season unchanged.
- **Deleted.**
  - `horizon`, `voyage_out`, `HORIZON`, `AROUND`, and `Job::Sail`.
  - `voyage_step`'s per-tile wakes.
  - The client's tile-centre reconstruction and its `near()` guess.
  - "Beyond the horizon" becomes "Beyond the edge".

### Stage 3: the second harbour, connected the day it stands

- **Player.**
  - Build a harbour on another island, then a depot and a sawmill there.
  - Within the hour of the harbour standing, a new ferry sails in on a
    direct line between it and your nearest harbour. The news says so;
    the harbour card says "New line to Home harbour, on trial".
  - The home depot's timber rule books from your own depot first, while
    that depot is over its keep line, then from the world.
  - The outpost's lorry fills a box at the sawmill and drops it in its
    park; the line's ferry carries it home. The shipment list shows its
    calls.
- **Data.**
  - The world's yard `World.beyond: Vec<Trailer>` replaces each ferry's
    `Car.booked`: a booked box waits at the world for a ship bound in.
    This makes `Trailer`'s doc comment, which already says
    `World::booked`, true.
  - `Trailer` is unchanged. Its destination is the harbour of its `to`
    depot (`to: None` with `outbound` is the world).
  - `Line.calls` can be two harbours. `Shipment` gains `via:
    Vec<EntityId>`, the journey's calls, for the list.
- **Systems.**
  - A harbour standing, a rule set or a maker built asks the company
    (§Decisions): the nearest of your harbours where the sea beats the
    road by `SEA_GAIN` (or there is no road) gets a line if `forecast` (the two ends' rules and makers)
    says boxes would flow, its sailings sized by it, and its ferry
    `commission`ed. Otherwise the harbour card says what would open one.
  - Two ships now call at one harbour (the world's ferry and the line's),
    so the berth needs a queue: a ship arriving at a taken berth waits
    at the anchorage, `APPROACH` tiles out on its leg, and berths in
    arrival order. The tug serves whichever ship is at the ramp.
  - `board()` asks `lines::boards` for each box in the yard and in
    `beyond`.
  - `harbour_for` and `waiting_settlers` choose the nearest harbour *by
    road* (the street graph's component), not by Manhattan distance.
    Across water, Manhattan distance picks the wrong island, which is a
    real bug the moment there are two.
  - `top_up` looks at your own depots on other islands before the world.
  - Coins: none move between your own harbours. A box you sell still pays
    as it leaves on any ship bound for the world.
- **Client.** The harbour card lists every line calling there. A ship at
  anchor is drawn idling, and its card says "waiting for the berth". The
  shipments list shows a box's calls as dots, with the current one lit.
- **Tests.**
  - New `the_outpost`: two islands on a test map. The line's first
    sailing leaves within an hour of the sawmill on the second island
    standing, with the home depot keeping timber; a second harbour a
    short drive away on the home island gets no line, and one at the far
    end of a long coast road does; timber
    made on one island reaches the depot on the other directly
    (`transfers` = 0), and none of it is bought.
  - Scenarios `two` and `new port` with game numbers.
  - The season with one outpost.
- **Deleted.** `Car.booked`. `ferry_of(harbour)` as "the" ferry: callers
  ask for the ship at the berth (`berthed`) or the lines calling there.
  The `inbound`/`spot` special cases in `next_call` and in `haul::sea`'s
  `arrives`/`departs`; `Sailing` reads the timetable.

### Stage 4: the lines follow the traffic

- **Player.** A line the forecast underrated fills up: a backlog of
  boxes in a park adds a sailing at the next departure, and the card
  says why ("12 boxes waiting: a sailing added"). A line that carries
  nothing through its trial is withdrawn with a day's notice. With three
  harbours, steady traffic between two that are not neighbours in the
  tree opens a direct line between them.
- **Data.** `World.history`: boxes moved and waiting per pair per day,
  kept for `TRIAL` days. `Line.trial_until`.
- **Systems.** At each departure, a pair's backlog over `BACKLOG` adds a
  sailing or opens a line. At midnight, lines past their trial are
  thickened, thinned or withdrawn by what they carried against their
  forecast.
- **Client.** Lines on trial drawn dashed on the far zoom; the news says
  when one opens, grows or goes.
- **Tests.**
  - `the_outpost` extended: a burst of sawmill output adds a sailing the
    same day; an outpost whose sawmill is demolished loses its line after
    its trial, warned.
  - Scenarios `hub` and `congested`.
- **Deleted.** Nothing new; this is the rule in `lines.rs` replacing
  stage 3's fixed sailings.

### Stage 5: blocks in narrow water

- **Player.** In a fjord or a strait, ships take turns. A convoy goes
  through, then the other side does, as at Suez.
- **Data.** `World.blocks: BTreeMap<BlockId, Block { way: i8, inside:
  Vec<EntityId>, waiting: [Vec<EntityId>; 2] }>`, derived from the
  routes' `narrows`.
- **Systems.** A ship's `Sail` is split at each block's mouth. It wakes
  there, enters if the block is free or held its way and not closing,
  and otherwise waits. Its arrival is then late, and visibly so.
- **Tests.** Scenario `strait`, and a game test on a fixture with a
  narrow entrance.
- **Ships.** Only if a seed or a fixture shows one. If no seed's starting
  harbour needs it, ship this stage last or after item 10.

### Stage 6: the container port

- **Player.**
  - A new kind, `Port`. It is a long quay along the water (two berths'
    worth), two cranes, a container yard of stacks, and a gate to the
    street. It is built from timber for now; concrete and steel come when
    the chains make them.
  - A container ship of the world's, longer, with 48 slots in three
    tiers, takes over the world line at that harbour. The ferry stays for
    settlers.
  - The crane lifts a box off the ship in seconds. It lands on a stack,
    and lorries drop and hook at the stacks' docks as they do in a park.
  - The trigger to build it is one you can see: the ferry sailing with
    boxes left behind (`missed`), and a full park.
- **Data.**
  - `BuildingKind::Port` (its blueprint row).
  - `CarRole::Ship` with a `ShipClass { Ferry, Container }` on the line.
    The class sets the length, the slots and the deck poses.
  - The yard is the building's `park: Vec<Slot>`, with more slots.
    Stacking is drawn: a slot's pose has a tier.
  - The crane is a prop with a `Lift { from: Place, to: Place, started,
    ends }`, as the tug's `Shunt` is, a crane a berth.
- **Systems.** `tug_wake` generalises to `handler_wake`. A tug shunts,
  and a crane lifts; both run the same `next_move`/`arrive` over
  `Place::Deck|Park`. Lorries are unchanged: a stack's dock is a dock.
- **Client.** The port's quay, the crane prop (gantry, trolley, spreader
  following `Lift`), stacked boxes, and the container ship's hull, which
  reuses `boxShape` for the slots. Use a fixture `11-port.txt` for the
  sheet.
- **Tests.**
  - New `a_port_outruns_the_ferry`: the same demand that leaves boxes
    behind on the ferry is cleared at the port.
  - Scenario `world` with a container class.
  - The season with a port.
- **Deleted.**
  - The `FERRY_LENGTH`/`DECK`/`LANES`/`ROWS` constants as globals; they
    become rows of `ShipClass`.
  - The tug-only paths in `next_move`.

### After item 10, in order

1. Computer towns on the other islands: a harbour, a few buildings, and
   wants and makes. With them come the order board, the first dues paid
   (counted since stage 1), and the Exchange as the board's building.
2. Charters, after the chains make bulk and liquid classes.
3. Lane attraction in the search, if the pictures ask for it.

## The first stage to build

Stage 1, then stage 2 straight after. The harness is the instrument for
everything that follows. It turns "is the network good?" into numbers
that a change moves, in a second, without a browser. Its `world`
calibration pins it to the game as it is, and its `two` scenario is the
spec for stage 3 before stage 3 exists.

Build `water.rs` and the `every_seed` route check first, since stage 2
needs them. Then build `lines.rs` with CSA, the sim, the parser, the
metrics and the SVG. Stage 2 is the first thing the player sees: the
ferry on a real course, from the real edge.

## Risks

- **The harness drifts from the game.** It shares the decision functions
  but not the land side.
  - The `world` calibration and `the_outpost` assert the same metrics in
    both.
  - No decision may live in `world/sea.rs` that is not a call into
    `shipping/`.
- **Voyages are long.** Even at `SEA_PACE`, a box to the world and back
  is a game day. That may be right (order ahead), or a chore. Tune
  `SEA_PACE` and `WORLD_STAY` in the harness against `transit`, not by
  feel in the game.
- **A line on a bad forecast.** The forecast reads rules and makers,
  which a player changes all the time; a line sized on a rule set
  yesterday may sail empty today. Mitigation: sailings are cheap to add
  and drop, the trial is short, and the harness's `new port` scenario
  scores empty sailings.
- **Settlers on two islands.** The outpost's houses fill from its own
  harbour, and its people stay on their island because there is no road.
  The season test needs an outpost to prove they eat.
- **Per-ship state in `Car`.** `Car` already carries a ferry's deck and
  passengers and a tug's shunt. A ship class is the last field it should
  take. If stage 6 wants more, ships move out of `Car` into the sea's
  own map, with the tug and the crane.

## Open

1. `BACKLOG`, `TRIAL`, `SEA_GAIN`, `SEA_PACE`, `WORLD_STAY`, `KEEP_RIGHT`, `APPROACH`: set
   in the harness.
2. Whether the player can ask for a line by hand (a tap on a harbour:
   "connect to…"), or the prior and the backlog are always enough.
3. Whether freight is charged between your own harbours. For now it is
   not: the cost is time and lorries.
4. Where the container port's settlers come from: the ferry staying on
   at a harbour with a port, or a ro-ro berth at the port.

## Contradictions found, 2026-10-10

Fixed in this commit: `README.md`, `roadmap.md`, `buildings.md`, and
`trade.md` §Automation. The rest are for the stages that change the
code, or for the player to decide.

- **`README.md`** says `shipping.md` has "nothing built". The ferry
  harbour is built.
- **`roadmap.md`**:
  - "Where we are" is a day behind. It has no harbour, trucks from the
    edge, and the port's ship.
  - Charters are in milestone 3, while `plan.md` puts them in item 10;
    this plan defers them past both.
  - Milestone 5 has "several towns on one island", where the map is now
    islands.
- **`buildings.md`**: the Doors table builds the ferry harbour from
  timber, and its own header and `shipping.md` §Built say it takes none.
- **`shipping.md` §The sea**: "the horizon is the map's edge", while
  `sea.rs` cuts the voyage at `HORIZON` = 48 tiles and unplaces the ship.
  The client says "Beyond the horizon". Stage 2 makes the code match.
- **`trade.md` §Automation is seen**: "when it reorders a ship sets out
  from the horizon". The ferry sails on its timetable whatever is booked.
- **`trade.md` §Listings / §Depots**: "the stack in its yard", where
  `shipping.md` §Built has a depot keep one box on its lorry's hitch.

Left for the code (stale comments, and a bug):

- **`protocol.rs`**:
  - `Trailer`'s doc says "booked beyond the sea (`World::booked`)", but
    the field is `Car.booked`.
  - `CarRole::Truck`, `Car.owner` and `Car.away` speak of "beyond the
    edge".
  - `Leg::Yard` is documented as "in a depot's yard, waiting to be
    unloaded". `haul::boxes` uses it for any box on a lorry standing at
    home, the empty included.
- **`fixtures.rs`**: the key says `P port`, but `'P'` builds a
  `Harbour`.
- **`haul.rs`**: `harbour_for` and `waiting_settlers` choose by
  Manhattan distance. With harbours on two islands this picks across
  the water. Stage 3 fixes it.
