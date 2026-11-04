# The core

Status: agreed with Wytze 2026-10-26 (thread "Find the core game loop"),
being built on `claude/project-thread-mv2dh8`, the core branch. Built
2026-10-27: the cuts, the lab's ladder (`server/src/research.rs`); and
2026-10-28, trade by itself (`market.rs` `keep`), which took the lines,
the offices and Buy and Sell away. Where
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

The ladder, a rung at a time (`research.rs`). Every rung is built of a
lot of the goods below it, so climbing grows the old chains too, and
each takes about as long in real time as the column says (a game day is
twenty minutes; a lab's four put in some 36 researcher-hours a day):

| Rung | Opens | Researcher-hours each | Real time |
|---|---|---|---|
| Start | harbour, road, house, depot, sawmill, lab, gas station, park | — | |
| 1 | farm, bakery, shop, quarry | 8 | a few minutes each, the first some fifteen in |
| 2 | cement works, apartment, supermarket, ore mine, coal mine; two-lane roads and lights | 150 | an evening |
| 3 | steelworks, machine works | 2000 | a day or two |
| 4 | container port | 6000 | about a week in all |
| 5 | oil well, refinery | 3000 | a few days after |

The chains: grain → bread; stone → cement; ore + coal → steel; steel →
machines; crude → fuel. Ore and coal lie in some mountains, oil under
some grass (`land::terrain::deposits`); a mine, a coal mine or a well
stands only with some within five tiles, and its card says what it
comes to at its best and how many of the makers below it it takes.

The container port is the goal of the ladder: ships of its own, and the
market three times as deep to the town, a big trade moving the price a
third as far: the town becomes a hub.

## Trade: by itself

Buying and selling a steady stream by hand is dumb work (Wytze,
2026-10-28). Whatever the town lacks, the ship brings and the town
pays; whatever is left over sails and the town is paid. The player's
lever is what the town makes, not a Buy button.

- **One price per good**, the market's (`market.rs`), moving with what
  everyone buys and sells.
- **Freight both ways**: what the town buys costs a quarter over the
  price, what it sells gets a quarter under (`economy::FREIGHT`), so
  making a good at home always beats the sea.
- **The town keeps each good by itself**, every hour: it buys up to
  what it will use before the ferry after next can bring more (the last
  day's use over what it made, and what its sites and bins still want),
  and sells what is over twice that, or over that and a full depot,
  whichever is more. Between the two it waits, so nothing bought is
  sold again the next hour.
- **Every deal has a partner**, one of the mayors beyond the edge
  (`orders.rs` §WHO): one whose town makes the good sells it, one whose
  town wants it buys. The Goods tab shows each good's day, made, used,
  in and out, the town's balance, and the deals.

## Cut for now

The opening mission and the trunk, the town's situations, the letters
from mayors beyond the edge (`missions.rs`, `orders.rs` but its
computer mayors, who move the market), the feed that shows them, the
price graph, and the "when" orders. Each comes back only when a playtest
asks for it.

## How it is built

A step at a time, each pushed to the core branch's preview and played:
the cuts, the unlocks, trade by itself. One change an evening,
judged only by whether it is more fun than yesterday.
