# Interchange: a puzzle mode, and the roads it needs

Status: plan, 2026-10-12; the first passes built 2026-10-13 (§Built,
at the end). What is still to come is the order's rest. A second way to play, Freeways-like, and the road systems
it forces into being: one-way and multi-lane roads, merging that feels
right, priority, levels, lights, markings, a new road brush. To be one-shot
and played.

## Why now, and not after the main game

Every road system here is already in `game.md` (§Roads: "priority over
streets and levels for overpasses. One-way is a toggle") and `network.md`
(lanes each way, merges, roundabouts, "a link has a level"). The town needs
them anyway. The puzzle is the cheapest bench to build them on: a level is
a handful of tiles, a known demand and a number at the end. A merge that
jams shows in a minute, not after a day of town. The brush built for it is
the candidate for the main game's.

## What Freeways is

[Freeways](https://captaingames.itch.io/freeways) (Captain Games, 2015;
80 levels added in 2025 with undo, ~240 in all):

- Each level starts with **dead-end roads at the edge** that must be joined.
  You drag to draw roads and bridges; traffic flows while you build.
- **"Jammed!"** when it gridlocks; you fix it or restart.
- At the end an **efficiency** score is calculated from traffic flow, the
  concrete used and the complexity of the system.
- High scores unlock photos of real interchanges; levels unlock in a tree.
- From memory, unverified: roads are drawn one-way, freehand, in the drag's
  direction; a road drawn across another is lifted over it.

Mini Motorways' lights are reported (by players) to switch at once when a
car waits on the cross road. Its roundabouts are the early-game favourite,
but only while their inflow stays in check.

## Where it runs: in the browser, the sim compiled to wasm

The positions of the cars matter only to the one player, a level is small,
and **Test** has to fast-forward ten minutes of traffic in a couple of
seconds. Both say: run it on the player's machine. Not by writing a second
sim in TypeScript, but by **compiling the server's own sim to wasm**, so the
town and the puzzle drive the same cars.

It is closer than it sounds:

- **The sim is already plain Rust.** tokio, axum and rusqlite live only in
  `main.rs`, `network/`, `game_loop/` and `persistence.rs`. The four
  `Instant::now()` perf timers (`mountains.rs`, `world/mod.rs`,
  `shipping/`) are the only other thing that won't run in wasm, and
  they can go behind a clock passed in.
- **The client already talks to the sim through one small interface:**
  `Connection { send(ClientMessage), close() }` and
  `onMessage(ServerMessage)` (`client/src/network/connection.ts`). A
  **worker connection** that runs the wasm sim in a Web Worker and posts
  the same messages, as msgpack bytes, is a drop-in. The renderer,
  `driver.ts`, the trips, the brush: none of them knows.

The work:

1. **Split the crate into a workspace of three.** The line is IO, the
   one boundary the code already keeps: only `undo.rs` reaches into
   `game_loop` (for `lay` and `handle_link_demolish`, which move into
   `sim` with the rest of the build).
   - `sim`: protocol, engine, world, cars, junctions, terrain, town.
     No tokio, no SQLite. Its randomness is already seeded `SmallRng`.
     The town tests and the ts-rs bindings live here.
   - `server`: the binary. `main`, `network/`, the tokio shell of
     `game_loop`, `persistence`, `health`, `rand::random` for a new seed.
   - `web`: a `cdylib`, `wasm-bindgen` over `Game`, built for the worker.

   Then **`traffic` carved out of `sim`**, as the puzzle's node-to-node
   trip needs it: roads, the network, routing, the edge queues, junctions,
   cars driving. The seam is **arrival**: traffic reports "car X reached
   its stop", and the town decides what that means (park it, wake its
   driver); the puzzle despawns it. The test of the seam is that
   `traffic` compiles without the town. Where lots fall (driving into a
   bay is traffic, whose bay it is is town) is decided while carving.
   The puzzle then builds on `traffic` alone, and every road system it
   grows is the town's the day it lands.

   One crate with a `server` feature instead was weighed and dropped:
   the boundary would be a `cfg` on every IO line, enforced by nothing,
   where three crates make the compiler enforce it.
2. **A `Game` that the loop only drives.** `game_loop::run` today
   holds the world, the event queue and the junctions inside one async
   function. Pull them out into `Game { command(msg), advance_to(t) ->
   Vec<ServerMessage> }`. The tokio loop becomes a thin shell around it;
   the wasm wrapper becomes another. This makes the server smaller, not
   just different.
3. **`web`**: `wasm-bindgen` over `Game`; a `rand` seeded per level
   so a layout always scores the same.
4. **The worker connection** in the client, and a level loaded from a
   fixture compiled in or fetched.

What it buys beyond the puzzle: the puzzle can ship as a static page (a
web link, itch.io) with no server at all. And later the main game's
client can ask the wasm sim `may(tool, from, to)` instead of keeping its
copy of the rules in `may.ts`.

**Scores across players** (the percentile chart, below) need one small
endpoint: it receives a layout, re-runs it with the same wasm sim on the
server (the same code, the same seed, so the same number), and keeps the
histogram per level. That makes cheating with a doctored score
impossible. It is not needed to play; it can come last.

## The mode

### A level, and the map it is part of

**The overworld is one map.** The terrain generator (`terrain.rs`: sea,
water, beach, grass, forest, mountain with its cliffs) makes one landscape,
and the levels are rectangles of it, say 32 × 24 tiles. A river crosses
three levels because it is one river. The **macro network**, a handful of
highways and towns on the overworld, set by hand per map, says what
crosses each rectangle's edge: those crossings are the level's **gates**,
and the flows along the macro routes are its **demands**. Neighbours agree
by construction: level A's east gate *is* level B's west gate, carrying the
same cars.

**Taste in the terrain.** Not every level has a river. A level's character
is what its rectangle happens to hold, so the map is laid out (seed, then
hand-nudged) so that levels get one idea each: a plain crossroads, a river
to bridge, a coast to squeeze along, a mountain to climb or go round, a
forest that is dear to clear. Placed buildings (a town's edge, a factory,
a harbour) are sources and sinks with their own flows.

Terrain and roads on one scale: `terrain.rs` already gives water a height
of −1, ground 0 and mountain 2. Road levels use the same unit (see Levels),
so a road at level 2 runs on a mountain's top as ground, a road at 0 over
water is a bridge, and a slope climbs a cliff.

**A gate** is a stub of road at the edge, in any cross-section:
two-way, one-way in, one-way out, a 2-lane one-way, a divided road, or two
gates side by side. Gates are fixed; you build from them. A gate works
as a harbour exit does today (`network.rs` counts a network as joined when
it reaches one).

**A demand** spawns cars on a trip from one gate (or building) to
another, at its rate, Poisson so they bunch. That is the one new kind of
trip: node to node, no lot, no owner, gone at the far gate. Today every
trip is `start_trip(car, node, building)` (`car/spawn.rs:16`); the new one
is smaller. A level has no residents and no economy, so nothing wakes but
cars: **no mode flag**.

### Playing a level

- **Build.** Cars already drive what you've built, slowly, for the
  sight of it. Nothing is scored.
- **Test.** The level resets its traffic and fast-forwards: the worker runs
  the sim flat out and the client plays it back sped up (the clock
  already has a speed; the driver extrapolates by it). It ends at ten sim
  minutes, or at the first **gridlock**: a gate backed up past N cars
  for 30 s, or a car that hasn't moved in a minute. A gridlock stops the
  test, pans to where it jammed, and goes back to Build.
- **Score**, if it got through: an **efficiency percentage**, the main
  thing, with stars beside it.

**Efficiency**, proposed:

    efficiency = flow × material
    flow     = Σ free-flow trip time / Σ actual trip time   (≤ 1; a car
               still waiting at its gate counts as having waited the whole test)
    material = reference cost / your cost

**Cost** is asphalt per tile, a deck tile ×3, a slope ×2, a light as N tiles
of asphalt. The **reference** is our own solve, shipped with the level
(it is also its test: `cargo test` asserts it solves). So 100% is "as good
as ours", and beating us shows as 104%. To argue: whether going over 100 is
a delight or a bug.

**The chart**: a histogram of everyone's efficiency on the level, your bar
lit, like Poly Bridge's. It needs the score endpoint. Until then it
shows only your own attempts.

### The map as a place

Zoomed out, the overworld shows every solved level as what you built, and
**cars drive across it for real**: one world holds the whole map, a car
leaves level A's gate and is in level B at once, the same car. An
unsolved level is its terrain, greyed, with its gates' stubs: its traffic
stops at its edge, so the map fills with life as you solve it. A **test**
runs the level alone: the same rectangle, with its gate flows from the
macro network, nothing outside. The zoomed-out view needs a cheaper draw
for the far zoom (cars as dots, roads as lines; `canvas.md`'s flat view is
that idea).

Solving a level opens the neighbours its gates lead to.

**The camera** (Freeways' is fixed; ours isn't): zoom and pan, clamped to
the level's rectangle plus a margin of a few tiles, so you see a little of
each neighbour past the edge. A solved neighbour is live, its cars coming
and going through your gates; a locked one lies under **fog**, its
terrain dimmed and soft-edged, its gates' stubs showing through. Because
the overworld is one world, the margin is free: it is the same map drawn
a bit further. Zoom out past the level and it becomes the overworld view.

## The brush (new, for this mode; the main game adopts it if it's better)

Today's brush grew out of placing buildings. This one is made for drawing
roads:

- **The road palette: cross-sections, not names.** A row of small icons
  drawn as what they are, keys 1–5: `→` one-way, `⇄` two-way,
  `⇉` 2-lane one-way, `⇄|` divided, and later `⇉⇇` divided 2+2. The
  icon is the road's section, so nothing needs reading.
- **Drag to draw**, snapped to the 8 directions as now; a one-way runs the
  way you drag. The ghost is the real road (lanes, markings) in white,
  red where refused, with **+12** in asphalt by the cursor and the
  running total against the reference at the top.
- **The pen has a height.** Scroll (or Q/E) lifts it a level. The ghost
  floats at its height with its shadow on the ground, and the decks above
  the pen fade. Where a drag joins a road at another level, the tile next
  to the join becomes the slope, ghosted as one; if it can't be (a
  junction, or something else in the tile), it's red.
- **Crossing a road at the same level makes an intersection**, as today.
  A bridge is drawn deliberately, with the pen raised.
- **Edit in place, not redraw.** Hover a stretch: an arrow to flip it,
  +/− for lanes, a toggle for priority. Hover a junction: who gives way
  (click an arm to make it major), a light.
- **Erase by dragging** with the right button; **Z** undo (it exists:
  `undo.rs`).

## The roads

### 0. One-way routes are a bug today

The router (`pathfinding.rs` `hops_from`, `junctions_from`) walks the
**undirected** segments of `RoadNetwork` and never reads `outgoing`. A car
can be routed the wrong way up a one-way and then find no edge to queue
on. Fix first: a segment knows which ways it can be driven, and the router
skips the ones it can't. Small. Everything else relies on it.

### 1. Cross-sections: a link has lanes each way

As `network.md` has it: a link has lanes forward, lanes back, and whether
a **median** divides them. One-way 1 is (1, 0); two-way is (1, 1); a
divided road is (1, 1, barrier); a 2-lane one-way is (2, 0). One-way
already exists (`Tool::OneWay`, `outgoing`/`incoming`, chevrons).

**The divided road** is one link with a **grass median**: two
one-lane carriageways with a strip of verge between, so it reads as two
roads, not one road with a line. Drawing a one-way against an existing
one-way on the same tiles makes it one. The rules: straight across and
right turns at a junction, no left and no U-turn across the median, and a
side road joins the near carriageway only. It keeps a node per tile, and
"no turn across" is one line in the junction's movement rule. Where it
meets an undivided road, the carriageways taper together on that tile.
(A barrier median is the same link with a different look, for the
motorway sections later.)

**Shallow joins.** The rule against a turn sharper than 90° is partly
direction-aware (`would_be_too_sharp`, `outgoing_only`). Make it entirely
about **movements**: at a node, every (way in, way out) a car could take
must turn 90° or less. A one-way that joins at 45° offers only the gentle
movement, so it's allowed; a two-way laid the same way would offer the
hairpin, so it isn't. The same rule in `may.ts` (or, in the puzzle, asked of
the wasm sim and not kept twice).

### 2. Markings

Painted into the baked road surface (`town/surface.ts`), where the
chevrons and kerbs already come from:

- **Centre lines on every road**: dashed between lanes going the same
  way, solid (or double) between the ways where overtaking is not a
  thing; none on a one-lane one-way.
- **Give-way**: shark's teeth across the minor arm at the junction's edge.
  **Stop**: a solid line and STOP where it's a stop. At a 45° merge, teeth
  where the joining lane meets the road.
- **Lights**: a stop line per arm.
- A barrier is geometry, not paint: a low concrete wall with a lit top.

### 3. Merging that feels right

Train-track merging (a lane change only at a node, waiting for a gap
there) makes cars **stop** where real drivers ease off a little and slot
in. The fix is one idea, used three times: the **virtual lead**.

A car that is going to share road with another car ahead of the merge
point projects it onto its own path by its distance to that point,
and follows it as if it were already in front: the `LeadCar` obstacle the
physics has today (`car/mod.rs`), with a car from another queue. Then:

- **A merge at a node** (two arms into one exit): each car maps the
  other by distance to the node; whoever is further ahead leads, the
  other eases off to fall in behind. That's the zip. Neither stops unless
  the road beyond is full. The intersection manager keeps **crossings**
  only; a merge is no longer a conflict it grants.
- **Priority**: a minor car maps major cars as virtual leads, and
  majors don't map it. So a minor car slows to fit a gap and stops at
  the teeth only if none comes. A major car never brakes for a minor one.
- **A lane change** on a 2-lane link: a car that wants the other lane (for
  its next turn, a few nodes ahead; or a free lane when its own is slow)
  maps the car ahead in that lane as its lead and adjusts its speed to
  fit the gap. Once it fits (a gap ahead and a gap behind,
  by its speed), it moves across over about a tile: in both queues while
  it does, then only the new one. The car behind it in the new lane
  maps it once it signals, and makes room. That courtesy is what stops a
  late change from becoming a stop.
- **A lane that ends** (a 2-lane road becoming 1): the ending lane is a
  merge into the other along the last tile, the same as above.

This is the gap-acceptance-and-follow scheme real traffic sims use (IDM
following, MOBIL lane changes), shrunk to what we have: one more source
of leads, and a lateral position the client draws as a smooth S.

**It must keep the DES cheap.** What makes many cars cheap today: a car
holds one acceleration between wakes, so where it is in between is
arithmetic, on the server and the client alike; it wakes when an obstacle
it knows about needs a decision (`wake_time`) or its stretch ends; and
when its acceleration changes it wakes the one car behind it
(`car_behind_on_edge`), 50 ms later for brake lights and 150 for a gap.
Nobody polls. The virtual lead keeps every one of those:

- **Following one more car is the same arithmetic.** A virtual lead is a
  `LeadCar` obstacle whose distance is taken along a different queue.
- **Who to wake on a change becomes a short list, not one car.** A car
  that maps another registers as its **shadow**; when the lead changes
  its acceleration, it wakes the car behind it *and* its shadows. A car
  is shadowed by at most one or two others at a time, so a wake stays
  O(1).
- **Finding the lead is O(1).** The other car is at the head of the other
  arm's queue (a merge at a node) or the nearest in the neighbouring
  lane's queue (ordered by position, so a short search).
- **A merge window, entered once.** A car wakes once when it comes
  within merge range, as it already wakes at the end of a stretch; on the
  major road with no merge ahead nothing changes.
- **The order is settled once.** Who leads at a merge is fixed when the
  second car enters the window (by when each would reach the point),
  and never flips. Two cars that kept re-deciding would wake each other
  forever; this is the zip, decided.
- **Lane changes only when the route asks.** A car changes lane for its
  next turn or a lane that ends, never to overtake, at first. That bounds
  changes to about one per car per junction. Overtaking can come later if
  it is worth its wakes.
- **Measured, not hoped.** The town test already asserts wakes per
  resident against a budget. The puzzle gets the same: a level heavy with
  merges and lane changes, its wakes per car-minute asserted within a
  margin of a level with none.

### 4. Priority

The intersection manager is FIFO with a pluggable conflict `Rule`
(`intersection/mod.rs`), which makes every junction a four-way stop.
Priority changes who is granted, not what conflicts:

- Each arm is **major** or **minor**, from the road kinds that meet
  (a road over a street; equal kinds FIFO, as today) or the player's
  toggle.
- **Crossing** a major flow: a minor car is granted only if no conflicting
  major car is registered and due within a gap time (`QUEUE_AHEAD`
  already registers cars three nodes out). **Merging** into one: the
  virtual lead, above.
- **Roundabouts** fall out: a ring of one-way major road and minor arms.

A busy major road starves its side road. That's the puzzle: the answer is
a light, a bridge or a better merge.

### 5. Levels: overpasses

`World.roads` maps a tile to **one** node (`roads.rs:8`; about 80 uses in
9 files). It becomes a tile and a **level** to a node. Uses that mean the
ground (driveways, doors, buildings) keep a `road_node_at(coord)` for the
ground level; the brush and the network use the level.

- A node has a level, on terrain's scale (water −1, ground 0, mountain 2):
  levels 0–3 over ground. Links join nodes of the same level, or a
  **slope**.
- A **slope tile** holds a node whose two arms leave in a straight line
  (orthogonal or diagonal), one at level L, one at L+1. It can't be a
  junction, take a third arm, or share its tile with anything at L or
  L+1. The whole rise is in that one tile; every other node is flat.
- Two nodes may share a tile if their levels differ by at least 1. A slope
  counts as both of its levels. So a ramp from 1 to 2 can pass over a road
  at 0, and a ramp from 0 to 1 can't.
- Diagonal links may cross between tiles (refused today) if they are at
  different levels.
- Where a road stands above the ground (an overpass, or level 0 over
  water) it is a **deck**: piers, a skirt, parapets. On a mountain at its
  own level it is ground.
- Buildings and gates sit at ground level.

**Rendering.** A deck tile is **the same baked surface** the ground road
gets (`town/surface.ts` → `roads.ts`) on a quad at its height, with a
**skirt** extruded down from the surface's outline (the kerb code already
has it) and a parapet on top, **piers** at tile centres to the ground
(every other tile on a straight), and a slope as the quad tilted along
it. Shadows come from the shadow map. A level is 0.35 of a tile high.

**Cars** get a height: each route position gets a z (the node's level, the
slope's rise in between), and `driver.ts` lifts the body.

### 6. Lights

A third grant policy for the same manager: FIFO (stop), priority (give
way), **signal**.

- **Phases are found, not set**: group the junction's movements into sets
  that don't conflict (a colouring on at most eight arms).
- **Adaptive**: a phase holds while cars come, ends after a minimum green
  when another has cars waiting, or at a maximum. You can see why it
  changed.
- **The player's one choice**: an optional main direction (click an arm),
  which gets the longer green.
- A pole per arm, the lamp live, a stop line. In the puzzle it costs as
  some tiles of asphalt: cheaper than a bridge, and usually not as good.

## Order

Each step playable.

| # | What | Size | Notes |
|---|---|---|---|
| 0 | One-way routes in the router | S | A test that routes round a one-way. |
| 1 | The sim to wasm: `sim`, `server`, `web` crates, `Game`, the worker connection | M | The town still runs on the server, unchanged. |
| 2 | `traffic` carved from `sim` at arrival; puzzle MVP: one hand-made rectangle, the camera, gates, demands, node-to-node trips, Build and Test, gridlock, efficiency | M | Already a game with what roads do today. |
| 3 | The new brush; centre lines; shallow joins; divided road | M | |
| 4 | The virtual lead: merges and priority, give-way markings | M | Roundabouts fall out. |
| 5 | Levels: tile + level, slopes, decks, piers, car height | L | Mostly client. The real interchange. |
| 6 | The overworld: one terrain, the macro network, levels cut from it, unlocks, the map with its cars | L | |
| 7 | Lanes: 2-lane links, lane changes | L | The virtual lead already built in 4. |
| 8 | Lights | M | |
| 9 | Scores endpoint and the chart | S | |

Levels come before lanes: an interchange can't exist without grade
separation, but it can work (if tightly) on one lane each way.

Checks per step: the server tests, `cargo check`, `tsc`, a fixture per new
look (`bun run shots`, `bun run plan`), and the wasm build. A level's
reference solve is its test.

## Open

Defaults taken unless the player says otherwise:

- Efficiency may go over 100% when you beat the reference.
- One overworld, the levels cut from it.
- A mode inside Sprawl's client (a route of its own), so it shares the
  renderer; a static build of it alone is a second Vite entry later.

Still open:

1. The macro network's first map: how many levels, which towns.

## Built (2026-10-13)

What runs, and where; the rest of the order above is still to come.

- **One-way routes**: a segment knows which ways it can be driven, and the
  search keeps to them (`network.rs`, `pathfinding.rs`).
- **The sim as a library**: `server/` is the `sprawl` crate with
  `game::Game`; `server/host/` the server; `server/web/` the game for a
  Web Worker (`bun run wasm` in `client/` builds it). A trip may end on a
  road, driven off its end (`car::spawn::drive_through`).
- **Levels** (`server/src/level.rs`, `server/levels/*.txt`): gates,
  wants, our own solve (`%` rows, arrows for one-ways, `%#` for priority,
  `%^h` for a height), Build and Test, a
  jam called by a backed-up gate or a stopped road, efficiency as flow
  and asphalt against our solve's. Every level's solve is its test.
- **The client** (`client/src/interchange/`): `/interchange` is the map of
  levels (`@at`), each opening its neighbours; a level keeps what was
  built on it. The camera keeps to the map, fog past it, the gates
  labelled. The road brush: two-way, one-way, two lanes, lights (1–4), the
  bulldozer (X, or Shift held), priority (P), the pen's height (↑ ↓);
  Space tests, Z undoes.
- **The road's shape and paint** (`town/surface.ts`): a road through a
  tile is a band along the curve its cars drive, its paint along the same
  curve; a junction's corners are filled along the turns. A one-way of one
  lane is thin, a divided road two thin ones with grass between, and a
  road goes from one width to the next within the tile where they meet.
  Dashed centre lines, a small arrow on a one-way, one a lane on a road of
  two. Priority is not a colour: a priority road has white edge lines,
  carried on through its junctions, in blocks across a side road's mouth,
  and the side road has shark's teeth.
- **Shallow joins**: the turn rule is about the turns a car can make.
- **The divided road**: a one-way laid against a one-way, grass between,
  right turns only (`World::divided`, `pathfinding::may_turn`).
- **Priority**: a through road is let through first at a junction.
  Priority is the hand's, not a kind of road (`Build.road`): any road
  drawn with it on has it, and drawn along again, gains or loses it.
  The town's Road is a street drawn with it.
- **Overpasses** (`world/decks.rs`, `client/src/engine/decks.ts`): node
  heights in half-levels, slopes, clearance, decks drawn and hatched
  above the pen, cars lifted.

- **Merging** eases in: cars bound for the same exit from equal roads
  are let through together and follow each other onto the road out
  (`intersection::paths_cross`, `join_run`); onto a priority road the
  minor still gives way. Not the shadow list of §3: the road out's queue
  is the virtual lead, and its car behind is woken as its own road's is.
- **Lights** (`intersection::Signal`): phases from the arms, adaptive
  with a gap-out, all red between, ticking on the junction's own wake.
- **Two lanes** (`Tool::Wide`, `EdgeSegment`'s lanes, `World::lanes_for`):
  a car's lane chosen per stretch for its turn ahead; lanes change at
  junctions only, not along a stretch (§4's lane change is still to
  come); gates `in2`/`out2`.
- **Ten levels**, a step each: a first road, round a hill, a crossroads,
  a merge, passing, a fork, giving way, over and under, rush hour, a
  roundabout.
- **The map of levels** and **kept layouts** (`Map.tsx`, `progress.ts`,
  `Level::layout`).

Not yet: lane changes along a stretch, the scores endpoint and its
chart, the overworld as one terrain with shared gates and cars crossing
between levels (the map's levels are made separately, and their gates do
not yet agree), auto-bridging, flipping a one-way in place. The sim is
not yet the same from run to run on different machines: some of what it
decides follows a `HashMap`'s order, which is random per process natively
and fixed in wasm; a score checked on the server needs that gone first.
