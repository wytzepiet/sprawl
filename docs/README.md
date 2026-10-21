# Sprawl: the knowledge base

Start with `game.md`. It is one page and it is the shape of everything.
The rest is detail, in the order you would need it. What is built of
each, and since when, is in its own header, and only there.

| Document | What it holds |
|---|---|
| `game.md` | How the game works: the rule, the island and the door, roads, undo, buildings built from materials, people, goods and calls, money, power, services, legibility, the opening, what is out. |
| `roadmap.md` | What is built, and the order the rest is built in, each step pointing at its plan. |
| `missions.md` | Missions: steps the server reads off the town and a reward; the opening and the trunk, the town's situation, orders from other towns, dailies; how they are read cheaply, and how to add one. |
| `trade.md` | The economy: coins that move only at a town's border, GDP as the level, the world's two prices, the ferry's deck and its pins, the order board, the Exchange, listings, contracts, depots, materials, the opening. |
| `shipping.md` | The sea: the world's shipping company and its lines, boxes as the world's and lorries as the town's, boxes only ever full, the ferry harbour and its tug, the container port, yards, the planner and hubs, charters, how ships find their way. |
| `buildings.md` | The roster: goods, homes, what serves people, doors, depots, what makes things, what goes. |
| `canvas.md` | The flat view: the game on a 2D canvas, the minimap, the far zoom and low-end devices; tools for seeing what the server does. |
| `architecture.md` | How the code is shaped: the discrete event simulation, the tracked state, the wire, persistence, the client, deployment. |
| `residents.md` | How a resident decides what to do: needs as stocks of time, taps, the utility search, alarms. |
| `plan-sea.md` | The build plan for the sea: the harness and metrics first, ships on routed water, your own second harbour with the world as hub, lines the company opens, blocks, the container port; what is cut and why. |
| `plan-market.md` | The market: world prices that move with a graph, freight as the moat between islands, a mayor as a nation, the harbour growing into a hub, the computer's mayors as the market until there are players. |
| `plan-interchange.md` | A Freeways-like puzzle mode run in the browser on the sim compiled to wasm: levels, gates and demands, Build and Test, an efficiency percentage; a road brush; and the roads it needs: one-way, cross-sections, markings, merging, priority, levels, lanes, lights. |
| `multiplayer.md` | Many towns, one sea: coastal spawns, trade between players by sea and optional roads, influence from traffic as the claim. |
| `look.md` | How the town looks: the perimeter block, the town grid (a tile's look from its neighbours and a few facts), the ladders each kind climbs, the concept loop. |
| `style.md` | How to judge a new thing that is seen: the feel, every verdict so far as a rule and its why, the three layers of checking, where to find real places, the canon awaiting sign-off. Read before building anything seen. |
| `network.md` | What vehicles touch, from a few primitives: links with lanes each way and a kind, stops, areas, faces, props; the check that every stop can be reached; facilities as templates that place links and stops and never draw. |
| `parking.md` | Lots as road: the house's drive, yards with docks, kerb bays, reservation windows, changes of gear, giving way at a lot, car parks where the kerb runs out, and the gridlock between drives and what curbs it. |
| `shelved.md` | Ideas built or argued and set aside, with why and what bringing them back would take. |
| `archive/` | Documents done in full: the price economy (`economy.md`), services as placeables (`services.md`), the brief of 2026-10-10 (`plan.md`), that day's playtest, and older ones. Read only for archaeology. |

A design decision lives in exactly one of these. When a decision changes,
the document changes; the old text goes to `shelved.md` if the idea might
come back, and to `archive/` if the whole document is done. `CLAUDE.md`
at the root holds how to work on the code, not what the game is.
