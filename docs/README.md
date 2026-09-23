# Sprawl: the knowledge base

Start with `game.md`. It is one page and it is the shape of everything.
The rest is detail, in the order you would need it.

| Document | What it holds | Status |
|---|---|---|
| `game.md` | How the game works: the rule, the island and the door, roads, buildings built from materials, the build, people, goods, money, power, services, legibility, the opening, what is out. | Current, 2026-09-23. |
| `roadmap.md` | The order to build `game.md` in, as playable milestones with rough sizes: the cut, the opening, goods, money, roads, power, services, the advisor, other people. | Living, 2026-09-23. |
| `architecture.md` | How the code is shaped: the discrete event simulation, the tracked state, the wire, persistence, the client. | Current. |
| `residents.md` | How a resident decides what to do: needs as stocks of time, taps, the utility search, alarms. | Built; leisure and services go with the cut (`economy.md` §12.11), the rest stands. |
| `services.md` | Placeables as services: streets vs roads, spawning onto streets, the build as the gate, call-outs, conditions. | §2–5 built for stock; fire, illness and the inspect panel not yet. |
| `economy.md` | Everything as a stock that runs down and every building as a row, labour as a good made at home, posted prices that move with stock, one protocol with money as hours, the world beyond the sea with the same rows and a crossing, one purse for the town moved only at the quay, GDP and the reserve as two different numbers, the tests that assert the equilibria. | Built through §12 step 7 and the port (§12.10), 2026-09-17. §12.11 is the cut of 2026-09-23: what goes, what stays, and the seasons to run after. The built sections are the record of the code until it changes. |
| `multiplayer.md` | One island, many towns: influence from traffic as the claim, why roads get built, coastal spawns, the port town. The door and the ferry moved to `game.md`; the fog is gone. | Specification, 2026-09-10, trimmed 2026-09-23; nothing built. |
| `parking.md` | Lots as road: spot tables, trips to spots, giving way by length, reverse gear, reservation windows, the test lot. | Specification, 2026-09-06; only the house stopgap built. §9 records the gridlock between driveways and what curbs it. |
| `shelved.md` | Ideas built or argued and set aside, with why and what bringing them back would take. | Living; 2026-09-23 added the survey, the generated roads, services, wear, leisure, the port's ship, the construction firm, haulers, taxes, the charts, the avatar, belts. |
| `archive/` | Documents superseded in full. Kept so nothing has to be reinvented from memory. | Read only for archaeology. |

A design decision lives in exactly one of these. When a decision changes,
the document changes; the old text goes to `shelved.md` if the idea might
come back, and to `archive/` if the whole document is done. `CLAUDE.md`
at the root holds how to work on the code, not what the game is.
