# Interchange: a puzzle mode, and the roads it needs

Status: brainstorm, 2026-10-12. Nothing built. A second way to play,
Freeways-like, and the four road systems it forces into being: one-way
lanes, priority, levels, lights. To be argued, then one-shot and played.

## Why now, and not after the main game

Every system this mode needs is already in `game.md` (§Roads: "priority
over streets and levels for overpasses. One-way is a toggle") and
`network.md` (lanes each way, merges, roundabouts, "a link has a level").
The town needs them anyway. The puzzle is the cheapest bench to build them
on: a level is a handful of tiles, a known demand, a number at the end, and
nothing else moving. A lane change that jams shows in a minute, not after a
day of town. So the mode does not compete with the main game; it is how
its roads get built and tested, and it is fun on its own.

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
  direction. Starting a road on a road splits it, ending on one merges it,
  and a road drawn across another is lifted over it. Cars yield where they
  merge.

What we take: edge gates, demands, live traffic, the jam as failure, the
cost of material. What we change: the grid (our brush, our 8 directions),
levels that form one connected map, and demands with a flow rate.

Mini Motorways for comparison: its lights are reported (by players) to
switch at once when a car waits on the cross road. Opinion is split on
whether they beat a four-way stop under load. Roundabouts are the
early-game favourite there, but only while their inflow stays in check.

## The mode

**A level** is a fixture (`server/fixtures/*.txt`, the existing text map)
plus a header:

```
TITLE="Clover"
GATE A W 0,12 in+out      # a road at the west edge, row 12
GATE B N 14,0 in
GATE C E 31,12 out
SINK S 20,20 House        # a building that eats/spawns cars
WANT A->C 30/min
WANT B->A 10/min
WANT B->C 10/min
PAR 140                    # asphalt for three stars
```

Terrain, water, trees and pre-placed buildings come from the fixture as
today. A **gate** is a stub of road at the edge that the level owns: a
road you cannot demolish, that cars appear on and leave by. It is what a
harbour exit is to the town (`network.rs` counts a network as joined when
it reaches one), so gates are exits and the "joined" check works as is.

**A demand** spawns cars at its rate (Poisson, so they bunch like real
traffic) on a trip from one gate (or building) to another. That is the one
new kind of trip: node to node, no lot, no owner, gone on arrival. Today
every trip is `start_trip(car, node, building)` (`car/spawn.rs:16`); the
new one is smaller than that, not larger.

**No mode flag.** A level world has no residents, no shops, no economy; it
just has demands. The resident, call and economy wake-ups have nothing to
wake. The car physics, the edge queues and the intersection manager carry
over untouched.

**The loop:** traffic runs from the first second, and you build live, as
in the town. A level is **solved** when, over a rolling three minutes
of sim time, every demand is met (delivered ≥ 90% of asked) and no gate's
spawn queue is backed up. Then it is scored:

- **Asphalt**: tiles laid, a deck tile ×3, a slope ×2, a light +5. The
  number on screen while you build, against par.
- **Flow**: mean trip time over free-flow trip time. 1.0 is perfect.
- Stars: ★ solved, ★★ under par, ★★★ under par with flow < 1.3.
- **Jammed**: a gate's queue over N cars for 30 s. The level says so,
  you fix it. Nothing resets on its own.

**The map.** The levels are tiles of one big overworld. A level's east gate
*is* its neighbour's west gate: the same highway, crossing the seam.
Solving a level opens its neighbours through its gates. The map
zoomed out shows every solved level as its own drawing, from the
plan renderer (`bun run plan`, flat SVG, already exists). The finished map
is a highway network you built interchange by interchange. Later, the
demands can come from the overworld itself: route a few big flows across
the map, and each level's demands are what passes through its tile. That
gives demands a reason, and makes the map one thing, not a list.

**Server shape.** One level per server world, loaded by `ResetWorld` from
the level's fixture (it exists). Progress (stars, best asphalt, your
layout) in a SQLite table, so going back to a level shows what you built.
Single player only.

## The roads

### 0. One-way routes are a bug today

The router (`pathfinding.rs` `hops_from`, `junctions_from`) walks the
**undirected** segments of `RoadNetwork` and never reads `outgoing`. A car
can be routed the wrong way up a one-way and then find no edge to queue
on. Fix first: a segment knows, per direction, whether it can be driven
(each of its links has both directions or one), and the router skips the
ones it can't. Small. Every later step relies on it.

### 1. One-way, one lane

Exists: `Tool::OneWay`, `outgoing`/`incoming` on `RoadNode`, chevrons on
the client. Two changes.

**Shallow joins.** The rule against a turn sharper than 90° is
partly direction-aware already (`would_be_too_sharp`, `outgoing_only`).
Make it entirely about **movements**: at a node, every pair (way in, way
out) a car could actually take must turn 90° or less. A one-way that
merges at 45° into a road it runs along offers only the gentle movement,
so it is allowed. A two-way laid the same way would offer the hairpin back,
so it isn't. The same rule in `may.ts` on the client, as always.

**Two opposing one-ways in one tile** (a dual carriageway, the middle open
so you can't turn left across it). Two ways to model it:

- (a) two nodes in the tile, side by side;
- (b) one link with **1 lane each way and a median** (`network.md`'s
  "2 and 2, a median between", at 1 and 1). The node's wiring rule says
  what it means: no U-turn, no left across the median, a side road
  joins the near carriageway only.

**Pick (b).** It is `network.md`'s own design, it keeps a node per tile
(and per level, below), and "no left across" is one more line in the
junction's movement rule, not a second network. Drawing a one-way
against an existing one-way on the same tiles turns that link into
the divided 1+1. The renderer draws two narrow carriageways and a
strip of verge.

### 2. Priority

The intersection manager is FIFO with a pluggable conflict `Rule`
(`intersection/mod.rs`). That is a four-way stop, which is why every
junction behaves the same today. Priority is a change to who gets
granted, not to what conflicts:

- Each arm of a junction is **major** or **minor**, from the kinds that
  meet there. A road (`#`) is major over a street; equal kinds stay FIFO
  as today. In the puzzle, a toggle on the road tool.
- A minor car is granted only if no conflicting major car is
  registered and due within a gap time (`QUEUE_AHEAD` already registers
  cars three nodes early, so the manager knows who is coming). It is the
  give-way that cars leaving a lot already do (`gap_at`), at a junction.
- Drawn as shark's teeth (or a stop line) across the minor arm's lane, at
  the node's edge. Merges at a 45° on-ramp get the teeth too.

What falls out of this: **roundabouts** are a ring of one-way road
with priority, plus minor arms. No roundabout code.

Starvation is real (a busy major road locks a side road out for good). That
is the puzzle working: the answer is a light, a bridge or a better merge.
A long-waiting minor car does not cheat its way in.

### 3. Levels: overpasses

The deepest change on the server is one line of the data model:
`World.roads` maps a tile to **one** node (`roads.rs:8`, about 80 uses
in 9 files). It becomes a tile and a **level** (0–3) to a node. Most
uses are "the road on this tile" and mean level 0 (driveways, doors,
buildings, terrain); those keep a `road_node_at(coord)` that means ground.
The brush and the network use the level.

**Rules:**

- A node has a level; links join nodes of the same level, or a **slope**.
- A **slope tile** holds a node whose two arms leave in a straight line
  (orthogonal or diagonal), one at level L, one at L+1. It cannot be a
  junction, it cannot take a third arm, and nothing else may stand on
  its tile at L or L+1. The whole rise is inside that one tile; every
  other node is flat. That keeps the renderer simple (below) and gives a
  grade you can read at a glance.
- Two nodes may share a tile if their levels differ by at least 1. A slope
  counts as both L and L+1. So a ramp from 1 to 2 may pass over a road at
  0, but a ramp from 0 to 1 may not.
- Diagonal links may cross (today's rule refuses an X between tiles)
  if they are on different levels.
- Buildings, driveways and gates are level 0 only.
- A level costs: a deck tile is dearer than ground; in the town, it costs
  the concrete and steel `game.md` already names.

**The brush.** A level picker (keys 1–4, or a small dial on the toolbar)
sets the level you draw at. When a drag starts on a road at another level,
**the first tile you draw becomes the slope**; when it ends on one, the
last tile does. If that tile can't be a slope (a turn, or a road already
there), the ghost goes red, as any refused tile does. Worth trying after
it plays: Freeways' way, where a road drawn across a road is lifted over
it on its own, with slopes on the tiles either side if there is room.

**Rendering.** The ground roads are flat atlas tiles baked from each tile's
links (`town/surface.ts` → `roads.ts`). A deck tile is **the same baked
surface on a quad at its level's height**, with:

- a **skirt** extruded down from the surface's outline (the kerb code
  already has the outline): the deck's edge, a parapet line on top;
- **piers** at tile centres down to the ground, every tile, or every
  other one on a straight;
- the **slope** as the same quad tilted along its direction;
- a **shadow** on whatever is under it, which the shadow map gives free.

Levels at 0.35 of a tile each, so three stack within a building's height.
From above, a deck hides what runs under it. While the brush is at a
lower level, the decks above go translucent.

**Cars** get a height: the server already sends `route_positions`, so
each gets a z (the node's level, the slope's rise in between), and
`driver.ts` lifts the body. The physics may ignore grade at first.

### 4. Lanes: two-lane one-ways

The headache, but bounded, if we follow `network.md`: **a car changes
lane only at a node.**

- A directed edge holds **one queue per lane** instead of one
  (`segments.rs`). Following stays "the car ahead in my queue".
- **Lane wiring by rule** at a node, never placed: straight on, lane to
  lane; turns from the outside lanes; where 2 meet 1, the two merge.
- **Lane choice**: a car looks a few nodes ahead on its route and wants a
  lane that can make its next turn. At each node it moves to the wanted
  lane **if there's a gap** there (`gap_at` again); if not, it stays and
  tries at the next node. If it reaches its turn in the wrong lane, it
  waits at the node for a gap. That's the real-life failure, and in the
  puzzle it is the lesson: give weaving space.
- **Merges**: 2 into 1 is two arms into one exit. The FIFO manager
  already treats "same exit" as a conflict and grants in arrival order:
  that is a **zip merge, for free**. With priority, the through lane is
  major and the joining lane gives way.
- **Client**: the lane offset is fixed today (`LANE_OFFSET`, 0.15 server /
  0.1 client: worth making one number). It becomes per lane; a
  change across a node is a smooth sideways S on that tile.
  Roads draw at the width of their lanes, with dashed lines between.

A two-lane two-way road (2 and 2) is the same machinery and should come
free.

### 5. Traffic lights

Lights are a third grant policy for the same manager: FIFO (stop), priority
(give way), **signal**.

- **Phases are not set by hand.** From the conflict rule, group the
  junction's movements into compatible sets (straight and right from
  opposite arms, and so on). That is a small graph colouring on at
  most eight arms.
- **Adaptive**: a phase stays green while cars come; it ends after a
  minimum green when another phase has waiting cars, or at a maximum. That is
  what Mini Motorways' lights seem to do, and it's easy to read: you can
  see why it changed.
- **What the player decides** is one thing: an optional **main
  direction** (click an arm), which gets the longer green, so a feeder
  crosses an artery without starving it.
- Drawn: a pole per arm, the lamp's colour live, stop lines.
- In the puzzle a light costs asphalt points: cheaper than a bridge,
  dearer than nothing. A junction of two big flows tempts you to buy one,
  and the bridge is the better answer.

## Order

Each step is playable on its own.

| # | What | Size | Notes |
|---|---|---|---|
| 0 | One-way routes in the router | S | A test that routes round a one-way. |
| 1 | Puzzle MVP: gates, demands, node-to-node trips, jam, asphalt, score, 5 hand-made levels, a level list | M | Already a game with one-ways and at-grade junctions. |
| 2 | Shallow joins by movement; priority and shark's teeth | S–M | Roundabouts fall out. |
| 3 | Levels: data model, slope rule, brush, decks, piers, car height | L | Mostly client. The real interchange. |
| 4 | Lanes: per-lane queues, wiring, choice, zip; dual carriageway | L | The sim's biggest change. |
| 5 | The overworld: shared gates, unlocks, map of drawings, generated levels | M | |
| 6 | Lights | M | |

Levels before lanes: an interchange can't exist without grade separation,
while it can work (if tightly) on one lane. Lanes are also the step most
likely to need a second pass, so it should come after the fun is proven.

Checks per step: the server tests, `cargo check`, `tsc`, and a fixture per
new look (`bun run shots`, `bun run plan`). A **level is its own test**: a
solved layout saved beside each hand-made level, asserted to solve in
`cargo test`, so a change to the sim that breaks a level fails the suite.

## Open, for the player

1. Live building, as in the town, or a build phase and a run phase? Live
   is assumed; it's what the sim does anyway.
2. Score: the three numbers above, or Freeways' single efficiency %?
3. The dual carriageway as (b), a divided link, or should two one-ways in
   a tile stay two separate roads you can see as two?
4. Auto-bridging on crossing, or the level picker only, at first?
5. Overworld demands: hand-set per level, or routed from big flows across
   the map from the start?
