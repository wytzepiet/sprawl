# Architecture

How the code is shaped, and why. Taken from the original development
guide (`archive/guide.md`), with what the game turned out to be removed.

## Philosophy

Every layer only does work when something actually changes. No
unnecessary computation, no wasted bandwidth, no busywork. The
architecture is reactive end to end.

## Server (Rust)

A single-threaded event loop: a priority queue and event handlers. No
ECS, no framework.

The simulation is a **discrete event simulation**. Cars do not tick every
frame; they wake at meaningful moments — reaching a junction, changing
acceleration, entering a run of road. A car cruising on an open road
produces no work, so CPU cost is proportional to state changes, not to
entity count. The loop steps the clock in fixed 10 ms steps (`STEP_MS`);
speed adds steps rather than lengthening them, so running fast cannot
change what the simulation does.

Car movement is along precomputed routes. Between wakes, position is
derived from kinematics (progress, speed, acceleration, time), on the
server and on the client alike, so the server sends sparse acceleration
changes and both sides reconstruct exact positions at any moment.

Residents wake the same way: a wake is a decision (`residents.md`), and
the decision schedules the next wake — an alarm for a departure, a
bucket overtaking another, a tap closing. Nothing polls.

Every wake is logged against a budget in tests, and the loop prints
`behind:` when a tick overruns, which is how a wake storm is caught
before a profiler is opened (see `CLAUDE.md`, "Is it fast?").

## State

Everything in the world is a `GameObject` — road nodes, buildings, cars,
residents — in one flat `Tracked` collection keyed by a `u64` id that is
never reused. Each entry carries the object and an optional tile position.
`get_mut` marks the object dirty; at flush time only dirty objects are
sent and persisted. Change tracking with no ceremony.

Every index is derived: the spatial index by chunk, the tile → road node
and tile → building maps, the road network with its components and exits,
the occupied tiles, the count of laid road. All are rebuilt at startup
from the objects, so an index can be added or changed without migrations.
The rule for anything new: if it can be derived, derive it.

Pathfinding is A* over the road graph.

## Wire

WebSocket, MessagePack. Spatial pub/sub by chunk: the client reports the
chunks in view and the server sends full upserts for changed objects in
them, plus deletes for what left. Send rate is decoupled from the tick.
Every update carries the clock, the growth meter and the build alongside
its ops, so a client never asks for ambient state separately. Terrain is
generated from the seed on both sides and sent per chunk.

One set of Rust structs, exported by `ts-rs`, is the game state, the
SQLite JSON shape, the wire format and the TypeScript types.

## Persistence

SQLite, one table of objects as JSON, one of metadata. Only dirty objects
are written, once a second, in one transaction. Trips are not saved: a
loaded world is people standing still until they think. Terrain is not
saved: it comes from the seed.

## Client (SolidJS + Babylon)

A SolidJS app, Babylon for the scene. Game objects arrive as ops into a
store; the world mounts and unmounts scene objects per op. Everything
drawn in quantity — roads, buildings, cars, trees — goes through an
instance pool, one bucket per material, so a city is a handful of draw
calls. Cars extrapolate along their routes every frame with the server's
own kinematics; buildings and roads are remounted only when they change.

HTML over the canvas for what HTML is good at: pins, the toolbar, the
tree, the build menu. Pins are positioned per frame through the scene's
projection.

## Deployment (plan)

Docker Compose on a small VPS: the Rust server, the client, Nginx for TLS
and the WebSocket upgrade, SQLite on a volume. The server flushes on
SIGTERM; clients reconnect. Not yet done.

## Build philosophy

- HashMaps, a priority queue, event handlers. Nothing cleverer until it
  has to be.
- The simulation does not know about rendering; the renderer does not
  know about the network.
- Measure before optimising, and only on a signal.
- Single-threaded until a specific bottleneck demands otherwise.
- Ship something playable, then iterate.
