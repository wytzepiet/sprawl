# The market: a mayor in a world of prices

Direction, 2026-10-20, from a long talk with Wytze about what the game's
loop is. Nothing built. It changes `trade.md` where they meet; until it is
built, `trade.md` is what the code does.

## The idea

**Sprawl is a trading game whose goods are made, stored and shipped on
the map.** Every good has a world price that moves, with a graph. A
mayor watches it and answers by building: a rig when oil is dear, a tank
farm to hold oil bought cheap, a bigger harbour to ship more for less.
The town is the production line and the warehouse; the sea between
islands is what makes prices differ from place to place.

Why: the loop needs a next thing that the player chooses, not a list
handed to them. A price that moves while you are away is a reason to
come back (Animal Crossing's turnips, a single good, were checked by
millions every day); "oil is expensive, I'll produce it" is a decision
the map makes possible; and the profit is plainly yours, which is the
legible income `trade.md` was after.

What was weighed and left, the same evening: choosing between offers
by price alone (you always take the cheapest, so it is no choice);
pressing "order 10 timber" each time (a chore with no skill in it);
the deck as the place you order (the ferry is not there while you
import, so it was a menu dressed as a ship); bars of needs to keep up
(not this game); resident tiers (Wytze wants to build industry, not
raise residents); a Factorio of belts and lines drawn between buildings
(very satisfying, and a second game on top of a simple one; kept as an
idea, not a plan).

## Prices

- **One world price per good, and a graph of it.** It moves with what
  every town sells and buys (in multiplayer a neighbour's glut is your
  crash), with events (a storm shuts the oil fields), and with seasons.
- **Most goods are steady; one or two are not.** The turnip lesson: one
  volatile good is enough to make the market a game. Oil and steel
  first; the rest move slowly.
- **A harbour buys at the world price plus freight and sells at the
  world price less it.** A quick flip always loses the spread, so only
  a real move pays. `trade.md`'s world premium and discount are this,
  already, with freight in place of a fixed tenth.

## Distance is the moat

As with real commodities, a local price is a world benchmark plus the
cost of getting the good there (Brent and WTI, the LME's warehouses).
Arbitrage keeps two places within freight of each other, and no closer.

- **A neighbour buys from you above the world price, and still saves.**
  They pay the world's long freight; you pay only your short hop to
  them. What lies between is your margin.
- **Freight comes from the sea.** The ships already sail real routes
  between islands (`shipping.md`), so the cost of a crossing is the
  distance, not a table.
- **What a good weighs against what it is worth decides its market.**
  Gravel, cement and timber barely travel: regional businesses, where
  being the nearest quarry is the whole advantage. Oil and steel sit
  between: a near producer has a real edge. Electronics and machinery
  are light and dear, and trade at the world price everywhere.

## A mayor is a nation, not a trader

Nations rarely day-trade. They stockpile, sign long contracts, and
choose how much to make.

- **Reserves are physical, and at home.** Buying cheap oil means
  storing it in your own tanks, as the US keeps its reserve in salt
  caverns. No goods owned on paper abroad: what you hold is on the map.
  Depot space is the price of a bet.
- **Contracts are deals with named partners.** "Halden takes 50 timber
  a week at 4 coins, for a month" locks a price against the graph, as
  Qatar sells its gas on twenty-year terms. Every trade still has a
  partner, by name (`trade.md` §The deck).
- **Production is the market move.** Build what is dear. In
  multiplayer, mayors may agree to hold back together, as OPEC does.

## The harbour grows into the empire

Freight per unit falls steeply with the size of the ship, but a bigger
ship needs a deeper berth and room ashore for a whole load.

- **Each step of the door is a bigger ship and cheaper freight**: the
  ferry, more sailings, the container port, then a tanker terminal and
  bulk berths (`game.md` §The island and the door).
- **A bulk load needs storage for all of it at once**: the tank farm is
  half the investment, and a full load bought at the wrong moment ties
  up coins and tanks.
- **The hub sells on.** Singapore has no oil and is one of the world's
  great oil ports: crude in by supertanker, refined, sold on to the
  region in small tankers. A mayor can be the petro empire with no well,
  by geography and investment.

The long goal, then, has a shape: from a ferry pier to the region's port.

## It needs other mayors

A market is only as alive as the towns in it, which is the point:
player-to-player trade was the goal from the start (`multiplayer.md`).
Until there are players, the computer's mayors are the market. They
exist already (`orders.rs` §WHO: Old Tam of Saltmere, Mira of
Northgate, …), each with goods they make and want; here each would own
an island, make and buy at the world price, and move it. A player who
joins takes an island's place beside them.

## Open

1. Which goods are volatile, and how fast the steady ones drift.
2. How a price is set: a curve over every town's stock and flow, or an
   order book. The first is simpler and needs no counterpart to be
   online.
3. Whether the graph lives on the harbour's card, the stock tab, or both;
   and how to keep the market from becoming a screen of menus.
4. What a contract can be broken for, and what breaking it costs.
5. Events: how many, how often, and whether a player can see one coming.
