# Sprawl — Development Guide

A multiplayer persistent city building and traffic simulation game. Players build road networks, buildings spawn organically, and thousands of cars drive autonomously using realistic physics. The simulation runs 24/7 — your city keeps growing while you sleep.

## The Game

The core loop: build roads, watch traffic emerge, spot bottlenecks, redesign, repeat.

Roads are the primary player action. When you place a road, surrounding tiles get zoned (residential, commercial, industrial). Buildings spawn automatically along zoned roads near attractors (hospitals, fire stations, schools, etc.). The player shapes the city through road layout and attractor placement — not by placing individual buildings.

The road network is the game. Good road design = smooth traffic = happy city = growth. Bad roads = congestion = decline. The player learns to read traffic patterns and design better networks.

The world is tile-based. All roads are on the grid. Roads have simple combinable properties:

- Direction: two-way, or one-way
- Lanes: one or two lanes (for one-way roads)
- Priority: roads can have priority over others at intersections
- Level: 0, 1, or 2 — allowing roads to pass over each other (bridges, overpasses)

From these simple building blocks, players naturally construct roundabouts, highways, interchanges, and any other road configuration. The complexity emerges from the rules, not from special-cased road types.

### The World

The world has terrain: water, land, and mountains. Players can build on land but not on water or mountains (tunnels may come later). The terrain gives each world a unique geography that constrains and inspires road design.

A pre-existing small road network exists in the world that players connect to. This "main network" provides structure and starting points. Players can never destroy a road that would disconnect themselves or another player from the main network — connectivity is always preserved.

### World Generation

The world is generated using a combination of a noise function (for large-scale terrain features like continents, mountains, and water) and wave function collapse (for tile-level detail that ensures connectivity — rivers flow continuously, roads connect properly, terrain transitions look natural).

The world is not generated all at once. An initial world is pre-calculated with enough space for players to spawn, including some buffer terrain around the edges. As players build toward the edges or new players spawn at the frontier, more terrain is generated on demand. This keeps the world feeling expansive without paying the cost of generating a massive world upfront.

### Multiplayer

The game is persistent and shared. Multiple players build cities in the same world. Cities can connect via roads — traffic flows between them. Players compete indirectly for population (people move to the most attractive city) and cooperate through trade (cities specialize in different resources and depend on each other).

The shared road network is the communication medium. You can see another player's traffic flowing into your city. A simple text chat with shareable coordinates supports coordination.

### Visual Style

Top-down orthographic view with a Google Maps aesthetic. Clean, readable, slightly stylized. The visual hook is dynamic lighting:

- Daytime: sun tracking across the sky, long shadows at dawn/dusk, building shadows falling on roads and cars
- Nighttime: street lights casting warm pools, car headlights and taillights glowing, the city alive in the dark
- Simple 3D geometry (extruded boxes for buildings, simple shapes for cars) with 2D SVG textures projected from above

Think Mini Motorways meets SimCity meets a cozy lo-fi screensaver you can actually play. The world itself should evoke the Mini Motorways aesthetic — colorful terrain with water, land, and mountains visible from above.

### Art Direction

Visuals are simple by design — this is a web game. 3D geometry is minimal (boxes, cylinders). Art is 2D SVGs projected orthographically onto 3D meshes. Shadows cast by the 3D geometry are the main visual depth cue. Assets can be procedurally generated or pre-generated using an LLM (SVG top-down views with matching 3D dimensions). Zone types are visually distinct through color: residential (warm), commercial (blue), industrial (orange).

## Architecture

### Philosophy

Every layer follows the same principle: only do work when something actually changes. No unnecessary computation, no wasted bandwidth, no busywork. The architecture is reactive end-to-end.

### Server (Rust)

A single-threaded event loop. No ECS, no framework — just a priority queue and event handlers.

The simulation is a discrete event simulation (DES). Cars don't tick every frame. They fire events at meaningful moments: reaching an intersection, changing acceleration, entering a new road. A car cruising on an open road produces zero work. This means the server can handle massive worlds because CPU usage is proportional to state changes, not entity count.

Car movement is along pre-calculated road paths. Between events, position along the path is derived from kinematic equations (progress + speed × time + ½ × acceleration × time²), not simulation steps. This is the key insight that makes the architecture efficient — the server sends sparse acceleration change events and both server and client can reconstruct exact positions at any point in time.

Events are debounced with realistic reaction delays (~300-800ms). When a car ahead brakes, the car behind doesn't react instantly — it schedules a recalc event in the future. This is both physically realistic and prevents cascade spam under load. Most events are simple "recalculate your acceleration" notifications that get bounced if one is already pending.

The game loop:

```
loop {
    process priority events due now
    maybe send network deltas
    maybe persist to disk
    process background tasks if time remains
    sleep until next tick
}
```

The server ticks at 100hz to spread events evenly across ticks, but most ticks process only a handful of events in microseconds. Background tasks (like non-urgent route recalculations) fill remaining tick budget.

### State Model

Everything in the game is a `GameObject` — cars, buildings, roads, traffic lights, routes. All stored in a single flat collection (`Tracked<EntityId, GameObjectEntry>`) where mutations are automatically tracked for dirty logging.

Each `GameObjectEntry` has:
- A `u64` entity ID (auto-incrementing, never reused)
- The `GameObject` enum value
- An optional tile position (for spatial indexing)

Calling `get_mut()` on the collection automatically marks the object as dirty. At flush time, only changed objects are processed. This gives us change tracking with zero ceremony — just use the data structure normally and it tracks what changed.

Runtime indexes (spatial index by tile, type indexes, listener maps, the road graph for pathfinding) are derived from the persisted objects and rebuilt on startup. They are not persisted. This means indexes can be freely added, changed, or removed without migrations.

Pathfinding uses A* on a precomputed intersection graph (not the full tile grid). Since intersections are few compared to tiles, pathfinding is fast. The intersection graph is only rebuilt when roads change.

### Client (SolidJS + Babylon.js)

The client is a SolidJS app with Babylon.js for 3D rendering. SolidJS was chosen because its fine-grained reactivity maps perfectly to the server's event-driven model — state only updates when something actually changes.

A single SolidJS store holds all game objects, provided via context:

```
WebSocket event arrives → setGameObjects(id, object) → Solid tracks which components depend on which objects → only affected Babylon meshes update
```

SolidJS components manage Babylon.js resources (meshes, materials, lights) instead of DOM nodes. Component mount creates the mesh, effects update it reactively, cleanup disposes it. The component tree gives you lifecycle management for free — demolish a building and its entire subtree (textures, shadows, particles) cleans up automatically.

Car rendering: a Solid effect sets up kinematic parameters (position, velocity, acceleration, timestamp) when the server sends an update. Babylon's render loop interpolates the position every frame using the same kinematic equations as the server. No per-frame reactivity needed for movement — just math.

Cars move along road paths. The car object references a road ID, and the client looks up the road's path geometry to position the car. SolidJS's store proxy tracks this dependency — if the road isn't loaded yet, the effect re-runs automatically when it appears.

### Networking

WebSocket with spatial pub/sub. The server tracks each client's viewport and manages subscriptions entirely server-side — the client just reports its screen position. The server sends full object upserts (not partial patches) for changed objects that fall within the client's viewport.

When a positioned object moves into or out of a client's viewport, it's automatically sent or cleaned up. Metadata objects (like routes) without positions are sent alongside their parent object when referenced.

Network send rate is decoupled from simulation tick rate. The server simulates at 100hz but sends network updates at ~20hz. Deltas accumulate between sends and are deduplicated (a car updated 5 times since last send only sends the final state).

On client connect: the server sends all objects in the client's viewport plus referenced metadata. On reconnect after a server restart: the client auto-reconnects, and if the frontend version changed (checked via git hash), it reloads to get the new bundle.

### Persistence

SQLite with JSON fields. One table for game objects, one for metadata (like the next entity ID counter). The full object is serialized as JSON via serde, and ts-rs generates matching TypeScript types from the same Rust structs. One set of type definitions serves as: Rust game state, SQLite JSON shape, WebSocket message format, and TypeScript client types.

Persistence runs on a configurable interval (frequent in dev, ~60 seconds in prod). Only dirty objects are written, in a single transaction. Losing a minute of car positions on crash is acceptable — cars just recalculate routes and carry on.

The same `Tracked` collection that drives network deltas also drives persistence. Dirty sets are flushed to both consumers at their own rates via cursors.

### Deployment

Docker Compose on a Hetzner VPS. CI (GitHub Actions with Blacksmith for fast Rust Docker builds) builds images, pushes to GitHub Container Registry, and tells the VPS to pull and restart.

Both containers (Rust game server + Bun/SolidStart for the frontend) restart together. The game server handles SIGTERM gracefully — flushes state to SQLite and exits. Clients see a brief "Reconnecting..." overlay and resume automatically. Frontend-only changes deploy without any visible interruption.

The setup:
- Game server: Rust binary in a slim container
- Frontend: SolidStart on Bun
- Nginx: reverse proxy, SSL termination, WebSocket upgrade
- SQLite: persistent volume for game state

A Hetzner CPX22 (2 vCPU, 4GB RAM, €6.49/mo) is more than enough. The event-driven architecture uses <1% CPU for a large world. RAM is the actual limit — a city with 100k cars, 50k buildings, and 500k tiles fits in ~65MB.

## Build Order

1. **Basic simulation** — Priority queue, event loop, cars moving along roads on a simple grid. Get the traffic feel right with 100 cars on localhost before building anything else.

2. **Rendering** — Babylon.js scene with orthographic camera, simple box meshes, cars moving along roads. SolidJS store driving Babylon updates. Sun shadows.

3. **Networking** — WebSocket server, spatial pub/sub, client interpolation. Two browser windows seeing the same simulation.

4. **Persistence** — SQLite snapshots, graceful shutdown, state recovery on restart.

5. **Gameplay** — Road building, zoning, attractors, building spawning. The actual game.

6. **Multiplayer** — Multiple players, interconnected cities, chat.

7. **Polish** — Night lighting, procedural buildings, sound, UI.

## Build Philosophy

- Keep the architecture dead simple — HashMaps, a priority queue, and event handlers.
- The simulation doesn't know about rendering. The renderer doesn't know about networking. Clean separation.
- Don't optimize until you've measured. Don't add infrastructure until you've felt pain.
- Start single-threaded. Only offload to threads when a specific bottleneck demands it (probably just A* pathfinding, if ever).
- Ship something playable, then iterate.
