# Sprawl: the knowledge base

Start with `game.md`. It is one page and it is the shape of everything.
The rest is detail, in the order you would need it.

| Document | What it holds | Status |
|---|---|---|
| `game.md` | How the game works: the rule, roads, buildings, the build, people, goods, money, power, services, what is out, and the order to build it in. | Current, 2026-09-06. |
| `roadmap.md` | The order to build `game.md` in, as playable milestones with rough sizes. | Living. |
| `architecture.md` | How the code is shaped: the discrete event simulation, the tracked state, the wire, persistence, the client. | Current. |
| `residents.md` | How a resident decides what to do: needs as buckets of owed time, taps, the utility search, alarms. | Built; §11 and §13 record what was open at the time. |
| `services.md` | Placeables as services: streets vs roads, spawning onto streets, the build as the gate, call-outs, conditions. | §2–5 built for stock; fire, illness and the inspect panel not yet. |
| `parking.md` | Lots as road: spot tables, trips to spots, giving way by length, reverse gear, reservation windows, the test lot. | Specification, 2026-09-06; only the house stopgap built. |
| `shelved.md` | Ideas built or argued and set aside, with why and what bringing them back would take. | Living. |
| `archive/` | Documents superseded in full. Kept so nothing has to be reinvented from memory. | Read only for archaeology. |

A design decision lives in exactly one of these. When a decision changes,
the document changes; the old text goes to `shelved.md` if the idea might
come back, and to `archive/` if the whole document is done. `CLAUDE.md`
at the root holds how to work on the code, not what the game is.
