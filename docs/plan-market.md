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

## The first version, and what waits

Wytze, 2026-10-20: keep the game simple. Everything below is the ceiling,
not the plan. The first version is:

- a world price per good that moves, oil the one that swings;
- freight from the real distance, so Buy and Sell differ by it;
- the market tab: the list, a good's graph, Buy, Sell, and "when";
- tanks and depots as what you can hold;
- the computer's mayors making and buying, which moves the price.

The world stays the shipping company, and freight leaves the game.
Waiting, until play asks for them: contracts, floors, every-sailing
orders, embassies, exchanges run by mayors. Out for good: freight
carried by players, and shipyards. A mayor earns from what stands in
their town, and a shipping line is ships between other people's
harbours; a ship is a one-off, not a good.

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

**Who you buy from, and which price you see.** You buy from the market,
as on an exchange, and name no seller: it fills from the cheapest
delivered to you, and the ferry says after where it came from. The graph,
the list and orders are in the world price, the one number every mayor
shares ("oil's at 84"); Buy and Sell show what you pay or get at your
harbour, the world's price with freight on or off, so the gap is always
in sight.

**Why deal with a mayor directly.** The market takes a fee on every
trade; a direct deal does not. In a shortage the market sells to the
highest bidder; a contract holds its price and amount (Japan's long
iron-ore deals with Australia). Some things are only had by asking: a
frontier good, a whole bulk load. An embassy
shows their stock, so you see who is about to run short. And two mayors
can act together: hold back, or join their islands by a bridge.

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

## Ways to get rich

The market is good if each of these is a whole game, and each has its own
way to go wrong. Every one is a real country.

- **The refiner.** No oil nearby: crude in by bulk, refined, sold on to
  the neighbours (Singapore). Lives on the margin between crude and
  fuel, the crack spread, which can close.
- **The breadbasket.** Land to spare: fill it with farms, export food
  (the Netherlands, small and the world's second exporter of it). Lives
  on land and seasons; food is heavy, so the neighbours are the market.
- **The extractor.** Sitting on a resource: dig it, pump it, sell it
  (Norway, Saudi Arabia). Rich while the price is high, and exposed to
  every crash; the town is only as good as one graph.
- **The trader.** Makes little, buys and sells everything (Geneva, where
  Vitol, Glencore and Trafigura trade more oil than most nations use).
  Lives on storage, contracts and timing, and on the other mayors'
  mistakes.

- **The maker of what others need to make.** Chips (Taiwan: decades of
  research, one light, dear good the whole world needs) and machinery:
  goods by the crate like any other, that other towns' buildings are
  built of, so towns come to depend on each other. A ship, a rig or a
  vehicle is not: it is one thing, bought once, with no price to chart,
  and so not on the market (Wytze, 2026-10-20).
- **The exchange.** A town whose harbour other mayors trade through,
  for a fee on each trade (London, Chicago, Rotterdam): the hub that sets
  the region's price because the region's goods pass through it.

Mixed towns are the usual, and switching is the drama: the extractor
whose price collapses builds a refinery and climbs the chain.

## No tree: what it is built from is the gate

Wytze, 2026-10-20: any building, any time, if you have what it takes.
The tree (`game.md` §The build, switched off) is not coming back. The
order is in the materials: a chip fab is built of machinery,
electronics and concrete, so it waits on a town that makes or buys
them, as nothing in Minecraft locks the diamond pick but the diamonds.
Specialising is what a chain costs to build and run, and pivoting is
buying different materials.

It also opens the hail mary: spend everything early on something too
dear for the town, and be its only maker for a while (ASML is the one
maker of the machines that print the newest chips). What a sole maker
may charge is capped by the world: it sells everything, dear, so a
monopoly earns up to the world's price plus its long freight, which is
regional and fair. A few frontier goods the world sells scarcely or not
at all are where a true monopoly lives, and the bet that can ruin a town.

What a tree gave, guidance, comes from elsewhere:

- **Missions** say what is next (`missions.md`), early and plainly.
- **The build menu leads with what is in reach**: what can be built now
  first, then each of the rest with what it still lacks, a recipe book
  rather than a wall of forty buildings.

## Simple on top, deep underneath

Wytze, 2026-10-20: the surface is a good's graph, Buy and Sell, and
nothing else. Depth comes as buildings, each adding one thing to that
surface where it stands:

- **A tank farm or a warehouse** lets you hold enough to bet.
- **An exchange** adds contracts (a price for a month, with a named
  partner) and orders that wait ("sell when oil passes 90").
- **An embassy for another mayor**, their flag on a building in your
  town, opens trade with them directly: past the world's spread, their
  prices and stock in sight, contracts with them alone. Its standing
  grows with the trade between you (`orders.rs`'s trust, made a place).
  The partners you have are the embassies on your map.

**A building decides what may be done, the tab is where it is done, the
map is where it is seen.** Wytze tried stock on each depot alone, and
you want the total; a building with a trade panel is only a button. So
the goods tab is one, global: a good's graph, the town's total (as Anno
tops its warehouses' sum), Buy, Sell. A building changes what that tab
can do, never gets a panel of its own: a tank farm raises the ceiling
it shows, an exchange adds its contracts, an embassy its mayor's row.
The map shows the result: tanks filling, a ship at the bulk berth, a
flag. A tap on the building opens the tab on what it holds.

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
