# Sprawl: the knowledge base

Start with `game.md`. It is one page and it is the shape of everything.
The rest is detail, in the order you would need it.

| Document | What it holds | Status |
|---|---|---|
| `game.md` | How the game works: the rule, the island and the door, roads, buildings built from materials, the build, people, goods, money, power, services, legibility, the opening, what is out. | Current, 2026-09-23; money, goods, legibility and the opening rewritten 2026-10-10 around trade. |
| `plan.md` | The brief for the next build: the game in a paragraph, the mandate (the documents are vision, not law), where things stand, the work in order, how it is checked. | Brief, 2026-10-10. |
| `roadmap.md` | The order to build `game.md` in, as playable milestones with rough sizes: the cut, the opening, the world as a trader, chains in town, roads, other people, power, services, the advisor. | Living, 2026-10-10. |
| `trade.md` | The economy: coins that move only at a town's border, GDP as the level, the world's two prices, the Exchange, listings, standing offers, contracts, top-up rules on depots, automation that is seen, depots, materials, the opening. | Direction, 2026-10-10; coins at the border and GDP built. |
| `shipping.md` | The sea: the world's shipping company and its lines, boxes as the world's and lorries as the town's, empties and street turns, the ferry harbour and its tug, the container port as the Exchange, yards, the planner and hubs, charters, how ships find their way. | Direction, 2026-10-10; the ferry harbour built (§Built). |
| `buildings.md` | The roster: goods, homes, what serves people, doors, depots, what makes things, what goes. | Draft, 2026-10-10, for the player to correct. |
| `canvas.md` | The flat view: the game on a 2D canvas for the cloud, the minimap, the far zoom and low-end devices; tools for seeing what the server does. | Direction, 2026-10-10; nothing built. |
| `architecture.md` | How the code is shaped: the discrete event simulation, the tracked state, the wire, persistence, the client. | Current. |
| `residents.md` | How a resident decides what to do: needs as stocks of time, taps, the utility search, alarms. | Built; leisure and services went with milestone 0's cut, and money left the score: a visit is its time. The rest stands. |
| `services.md` | Placeables as services: streets vs roads, spawning onto streets, the build as the gate, call-outs, conditions. | §2–5 built for stock; fire, illness and the inspect panel not yet. |
| `economy.md` | Everything as a stock that runs down and every building as a row, labour as a good made at home, posted prices that move with stock, one protocol with money as hours, the world beyond the sea with the same rows and a crossing, one purse for the town moved only at the quay, GDP and the reserve as two different numbers, the tests that assert the equilibria. | Superseded 2026-10-10 by `trade.md`, and its code deleted by milestone 0 (last lived at `7364679`). Kept as the record of what was built and why; `shelved.md` says what would bring it back. |
| `plan-sea.md` | The build plan for item 10: the harness and metrics first, ships on routed water, your own second harbour with the world as hub, lines the company opens, blocks, the container port; what is cut and why. | Plan, 2026-10-10. |
| `multiplayer.md` | Many towns, one sea: coastal spawns, trade between players by sea and optional roads, influence from traffic as the claim. The sea itself moved to `shipping.md`. | Specification, 2026-09-10, rewritten 2026-10-10; nothing built. |
| `look.md` | How the town looks: the perimeter block, the town grid (a tile's look from its neighbours and a few facts), the ladders each kind climbs, the concept loop. | Direction, 2026-09-28; palette, fixture sheet built (the pen dropped 2026-10-02); the town grid in the sandbox, as of 2026-10-02. |
| `style.md` | How to judge a new thing that is seen: the feel, every verdict so far as a rule and its why, the three layers of checking (physics, real places, taste), where to find real places in any country, the canon awaiting sign-off, the ferry as the counter-example, and the order for making the work autonomous. | Guide, 2026-10-02. Read before building anything seen. |
| `network.md` | What vehicles touch, from a few primitives: links with lanes each way and a kind, stops, areas, faces, props; the check that every stop can be reached; facilities as templates that place links and stops and never draw. One-way, multi-lane, merges, on-ramps and roundabouts from lanes alone. | Design, 2026-10-02; nothing built. |
| `parking.md` | Lots as road: spot tables, trips to spots, giving way by length, reverse gear, reservation windows, the test lot. | Specification, 2026-09-06; only the house stopgap built. §9 records the gridlock between driveways and what curbs it. Direction of 2026-09-28 at the top: parking belongs to streets. |
| `shelved.md` | Ideas built or argued and set aside, with why and what bringing them back would take. | Living; 2026-10-10 added the price economy and jobs across the border; 2026-09-23 added the survey, the generated roads, services, wear, leisure, the port's ship, the construction firm, haulers, taxes, the charts, the avatar, belts. |
| `archive/` | Documents superseded in full. Kept so nothing has to be reinvented from memory. | Read only for archaeology. |

A design decision lives in exactly one of these. When a decision changes,
the document changes; the old text goes to `shelved.md` if the idea might
come back, and to `archive/` if the whole document is done. `CLAUDE.md`
at the root holds how to work on the code, not what the game is.
