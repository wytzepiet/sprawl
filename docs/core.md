# The core

Status: agreed with Wytze 2026-10-26 (thread "Find the core game loop"),
being built on `claude/project-thread-mv2dh8`, the core branch. Built
2026-10-27: the cuts, the lab's ladder (`server/src/research.rs`), and the
line kept by offices (`market.rs` `keep`); the line is a stepper beside
the shelf, not yet a handle dragged on it. Where
this page and an older one disagree, this page wins; the older text
moves to `shelved.md` as each piece is built.

## Why this page

For a week the game was redefined every evening and the opening rebuilt
to fit each time: a tutorial for a loop that did not exist yet. This
page is the loop, one way to play it, and what is cut until play asks
for it back. Nothing else is designed until it plays.

## The loop

**Pick what your town is becoming, chase its next unlock, make or buy
what the unlock costs, and fix the traffic and shortages that growth
brings.**

The fantasy is the town you build towards and can show: "I'm building
an oil empire", "a trading hub", seen by the other players of a public
world. Traffic is the puzzle on the way, not the point. Trade is how
you specialise and fill your gaps; a town may also keep to itself.

A browser game: picked up in a minute, a rabbit hole underneath.

## The start is open

Nothing is asked of the player. There is no guide and no mission: what
the player may build is short enough to need none.

- The build menu holds a harbour while the town has none, alone, since
  nothing else can stand without the door. Once it stands: road, house,
  depot, sawmill, lab.
- The first ferry brings the starter pack (`ferry.rs` `STARTER`):
  timber for the first houses and a lab, a little stone, crates, fuel.
- Lorries are the depots' and run of their own accord (`haul.rs`).
  There is no lorry of the mayor's.
- Every locked building shows in the menu, dimmed, with what it waits
  on: that is the goal you can see.

## Unlocks: the lab

A locked kind is opened once, for good, by research. A lab's hands do
it: tap a locked kind and its research is the lab's next, so many
researcher-hours, faster with more labs and more hands in them. A
research is never paid in the good it unlocks, and is never traded
(Wytze, 2026-10-25). Materials still gate every building, locked or not.

The first ladder, a rung at a time:

| Rung | Opens | Researcher-hours each |
|---|---|---|
| Start | harbour, road, house, depot, sawmill, lab | — |
| 1 | farm, shop, quarry, office | 24 |
| 2 | apartment, gas station, supermarket, factory | 96 |

A rung's kinds can be researched once the rung before it is. The
next rungs (a university, oil) are content, not new systems.

## Trade: one price, two buttons, one line

- **One price per good**, the market's (`market.rs`), moving with what
  everyone buys and sells. No graph at first.
- **Buy and Sell**, the mayor's own taps, never capped by anything but
  the ferry's deck and the treasury.
- **The line**: a handle on a good's stock bar in the market. Below it
  the town buys up to it; above it, it sells what is over. "Keep 40
  food" is the long-term contract, "sell timber over 200" the listing.
  It replaces the "when" orders.
- **Offices run the lines.** The handles are there from the start,
  dimmed: "Build an office to keep this stocked". All the town's offices
  together trade so many packages a day for the lines, and when the
  lines want more there is one pin, "trade desks full"; the fix is
  another office. Clerks commute, so a hub has a business district and
  a morning rush.
- **The partner is named on the map**: the ferry brings food from
  Ostdorp. Who, and the order book behind the price, never show as a
  panel.

## Cut for now

The opening mission and the trunk, the town's situations, the letters
from mayors beyond the edge (`missions.rs`, `orders.rs` but its
computer mayors, who move the market), the feed that shows them, the
price graph, and the "when" orders. Each comes back only when a playtest
asks for it.

## How it is built

A step at a time, each pushed to the core branch's preview and played:
the cuts, the unlocks, the line, the offices. One change an evening,
judged only by whether it is more fun than yesterday.
