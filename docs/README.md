# Sprawl: the knowledge base

Start with `game.md`. It is one page and it is the shape of everything.
The rest is detail, in the order you would need it.

| Document | What it holds | Status |
|---|---|---|
| `game.md` | How the game works: the rule, roads, buildings, the build, people, goods, money, power, services, what is out, and the order to build it in. | Current, 2026-09-09. |
| `roadmap.md` | The order to build `game.md` in, as playable milestones with rough sizes. | Living. |
| `architecture.md` | How the code is shaped: the discrete event simulation, the tracked state, the wire, persistence, the client. | Current. |
| `residents.md` | How a resident decides what to do: needs as stocks of time, taps, the utility search, alarms. | Built; §11 and §13 record what was open at the time. The bucket became a stock and money entered the score with `economy.md`. |
| `services.md` | Placeables as services: streets vs roads, spawning onto streets, the build as the gate, call-outs, conditions. | §2–5 built for stock; fire, illness and the inspect panel not yet. |
| `economy.md` | Everything as a stock that runs down, purses, posted prices that move with stock, one protocol with money as hours, the edge as the one door, floats and the sweep to the mayor, the tests that assert the equilibria. | Built through §12 step 3, 2026-09-09; §12.2 and §12.3 are what building decided. |
| `parking.md` | Lots as road: spot tables, trips to spots, giving way by length, reverse gear, reservation windows, the test lot. | Specification, 2026-09-06; only the house stopgap built. |
| `shelved.md` | Ideas built or argued and set aside, with why and what bringing them back would take. | Living. |
| `archive/` | Documents superseded in full. Kept so nothing has to be reinvented from memory. | Read only for archaeology. |

A design decision lives in exactly one of these. When a decision changes,
the document changes; the old text goes to `shelved.md` if the idea might
come back, and to `archive/` if the whole document is done. `CLAUDE.md`
at the root holds how to work on the code, not what the game is.
