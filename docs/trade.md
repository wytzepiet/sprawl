# Trade: depots, shipments, listings and contracts

Status: direction, 2026-10-10. Built: coins at the border, GDP, the
world's two prices (`economy.rs`), the ferry's deck: slots booked in
and out, each a deal with a partner (`orders.rs`, 2026-10-19, below),
bought and sold at the market since 2026-10-21 (`plan-market.md`);
the order board, letters from the mayors of the towns beyond the edge,
paid as their boxes sail (`orders.rs`, `missions.md` §Orders,
2026-10-12). Not built: the
Exchange, listings, standing offers, contracts. Replaces the price economy
of `economy.md` as the game's economy: what goes and what stays is at the
end, and `shelved.md` has the price economy under that date. `game.md` is
the short version; this is the detail.

## The problem

The economy as built is a real one: posted prices nudged by stock,
households that price money in hours, a labour market, a band round the
world's prices, one purse. It holds together, and it is not rewarding.
Its own rule 8 says why: ignoring prices never hurts. The player's levers
are buildings and roads, and between placing a shop and the reserve
moving lie half a dozen mechanisms nobody sees. A player who cannot
predict what an action does reads the result as weather.

What the game is good at is the opposite: things you can watch. A lorry
on the road is fun. A lorry whose load you know, going where you know,
for a reason you chose, is the best thing in the game.

## The idea

Inside a town, goods move by themselves, by the road: a buyer takes the
nearest seller with stock. Across a town's border, every trade is the
player's: bought or sold by hand, or by a rule the player wrote, and
every one is a shipment that drives, sails and can be followed. Depots
are where all of it is kept.

That is Anno's rule, already in `shelved.md`: automatic on the island,
explicit between islands.

## Coins

Coins are what trade is priced in, and only that. They move when goods
cross a town's border: in when the town sells, out when it buys. Nothing
inside the town has a price. A building costs materials, not coins, and
materials cost coins only when they are bought in.

## GDP

The level is GDP to date: the value the town adds, counted once, where
and when it appears on the map, at the world's prices, and nothing a
resident or a building decides by. A crop is worth its price as it is
cut. A meal or a tank served over a counter is worth the counter's
price less the crate or the fuel it used, whoever made that, so a shop
fed by the town's own farm and one fed from the boat add the same, and
the farm adds its crops on top. Work is valued through what it makes; a
farm hand's shift is in the crops already. Work that makes no good to
sell, a building there for what it does (an office until it has a
product, the Exchange, a fire station), is counted at cost, a wage an
hour, as GDP counts government work. Imports add nothing, and exports
nothing again. Each lands as a lump on the building it was added at.

GDP and coins are two numbers: the treasury is the balance of trade,
and a town serving its own people raises GDP without moving a coin.
Value sits on what is served, not on the visit, so ten restaurants do
not make anyone eat more: the level grows with how many people the town
has and how much of what they need it makes and serves for them. A
better building serving the same need for more, a villa's night or a
restaurant's dinner, is the ladder of wants (§Open 4), and a number on
its row.

## The world

Beyond the sea the world buys and sells everything, without limit:

- **Buying from the world costs a premium**, and comes on the slow boat.
  It is always there, so a town never runs out of anything for good. It
  is never the cheap way.
- **Selling to the world earns a discount.** It always takes what is
  offered, so a surplus is never stuck.
- **Every listing lives between the two.** A player who sells above the
  world's price sells nothing; one who sells below its buying price
  should have sold to the world.

Speed is a choice that costs: the scheduled ship is slow and cheap and
carries a lot; a neighbour by road is fast if near and joined; an express
boat or, later, an airport is fast and dear and carries little. "I need
it now" is always possible and always costs (`shipping.md`).

Shipping takes time, and that is part of the game: order before you need
it. Every shipment shows when it will land, and the estimate moves when
the lorry meets traffic. A wait you can see coming is planning; one that
surprises is a chore.

## The Exchange

Trading with other players starts with a building: the container port,
which is the Exchange (`shipping.md`). Until a town has one it trades with
the world and the mayors, through its ferry's deck, which is all a new
player needs to learn: the harbour, the depot, the road. Trading at scale and trading with players
are the same step, and it is a building you can watch work: the stacks,
the cranes, the boxes for your neighbour. The Exchange opens the trade
board, listings to other towns,
standing offers and contracts, and is where they are managed. It comes
later in the tree, once a player knows what their town is short of and
what it has too much of. In single player the world, and later computer
towns, are on the board.

## Listings

A player with an Exchange sells by posting a listing: a good, an
amount, a price. The goods are set aside in a depot, stacked in its
yard where they can be seen. Another player, or the world, buys from the trade board or by
visiting the depot. The seller's lorries load and drive to the buyer;
the coins land when the shipment does.

**A standing offer** is a listing that does not run out: "timber at 3
each, anything over 50 in stock". Buyers take what they want, and the
depot keeps selling. The floor keeps back what the town needs. The same
from the other side: "stone at 4 each, up to 100". Standing offers are
unlocked, not given: the first listings are by hand.

## Contracts

A contract is an agreement between two players: up to so much of a good
a day, at a price, for a period. "Up to 100 oil a day at 4, for seven
days." Either side proposes it and both accept; it shows on the trade
board.

A contract is a source, not a schedule. It gives the buyer the right to
buy up to its amount at its price; the buyer's pins (below) decide
when.

**The seller always delivers.** A seller who cannot fill an order from
their own stock has it bought from the world at the world's price, and
pays the difference. The buyer sees one source and one price, and never
pays for the seller's trouble. Ending a contract early takes a day's
notice, so no town starves overnight.

## The deck

Everything the town trades over the sea is a slot on the ferry's deck
(2026-10-19). It replaced the depot's rules, its standing-orders switch,
its sell buttons and the order form, a wall of panels that each did a
little of one job.

The player sees it as **deals**, a stack of cards in the corner like a
phone's notifications (`ui/Feed.tsx`, on `ui/stack.tsx`, drawn by the GPU), the one feed
at the top of the screen, with the missions and the ferry's news: a card is
every box of one good from or for one partner, said plainly ("Timber
from the world ×2"), where its furthest box is in words and on a bar of
the steps of its way, and the time to its next move. Words say what an
icon cannot; none is decoration. Folded, the newest is on top and two more
peek under it; a tap spreads them out, a tap on one opens it to its
boxes, each followed by the camera with a tap, and a box more.
A deal done shows its coins and slides away. A mayor's letter arrives
as a deal of the boxes it wants, accepted with a tap. No harbour is
ever named: the town trades through its harbour, and the game picks the
way. No harbour's or ferry's card trades.

- **A slot is a deal with a partner.** Coming in: a box of a good from
  someone, at their price a unit. Going out: a box for someone. The
  partner is named on the slot, with their crest: the market
  (`market.rs`, `plan-market.md`), which sells and buys anything at a
  price that moves, or a mayor (`orders.rs` §WHO), who buys what a
  letter of theirs asks for.
  Players join the list with the Exchange. Every coin in or out is a
  slot the player booked, so where the money came from is never a
  mystery: that was the price economy's flaw, and the reason trade is
  manual at all.
- **New deals** are the dock's market tab: a good, so many boxes, Buy
  or Sell; or an order that waits for a price.
- **Coming in** rides the next ferry and is paid for as it lands. It is
  for the town, not a depot: the nearest depot with room sends its
  lorry, so the player never chooses where a box goes.
- **Going out** waits at the harbour until a depot's lorry loads it,
  from what the depot has over its own reorder point, or from a maker's
  yard, and it is paid for as the ferry casts off. The town's own shelf
  comes before the world's.
- **Lorries go of their own accord**: to fetch what lands, to load what
  goes out. There is no switch.

A town that makes no food buys crates for good,
paying for it in coins and in depending on a neighbour, and that is a
choice against using the land for farms.

## Automation is seen

Everything is manual first and automatable later, and automation never
hides. It is a thing on the map:

- **Vehicles at work.** A depot's lorry fetches what lands and loads
  what goes out; what is automated is what is driving.
- **Automation costs capacity.** A box takes a slot of the deck, and a
  lorry's time. Automating more is building more, and three lorries
  through one junction is a jam you made.
- **Failure is loud and on the map.** A lorry with nothing to collect
  waits with an icon; a depot under its floor glows; a late convoy is
  seen stuck.
- **An automated shipment is the same event as a manual one.** It has a
  pin, it can be followed, and its arrival is a moment: the lorry turns
  in, the crates stack, the number ticks up. At scale the moments
  become a dashboard, the list of what is on its way, and then the flow
  itself: a steady line of your lorries, a quay that never empties.

## Shipping

How goods cross the sea, the shipping company and its lines, the planner,
boxes and lorries, harbours and their yards, hubs and charters, and how
ships find their way, is `shipping.md`. What is here is what it costs.

## Depots

Everything made or bought is kept somewhere real, and that is a depot.
The town's stock is what its depots hold, shown as one total; each good
still sits in a particular depot, and a listing or an order ships from
there, so where a depot stands matters.

| Depot | Holds | Capacity |
|---|---|---|
| General depot | everything | little of each |
| Warehouse | containers: general goods, food, steel | much |
| Tank farm | liquids: oil, fuel | much |
| Bulk yard | bulk: gravel, sand, cement, grain | much |

A general depot is flexible: one beside a growing district covers what
its sites need. A specialist holds far more of one class. A small town
lives on general depots, a big one builds specialists where the volume
is. Goods leave in the vehicle of their class whatever depot they leave
from, a tanker for oil, a tipper for gravel, so what moves can be read
off the road. A depot's yard shows its stock. A full depot stops what
fills it, a sawmill with nowhere to put timber, and is seen.

The harbour is where goods arrive, with a small buffer on its quay; what
lands there wants moving to a depot.

## Building materials

Every building is built from materials (`game.md` §Buildings): timber,
steel, concrete. What is placed is a site; a lorry drives the materials
from a depot to it, and it goes up as they land: outline, scaffolding,
walls. A site's card says what it waits for and where it is ("12
timber, on the boat, 4 minutes out"), and a click follows it. At first
every material comes by boat; a sawmill by the forest or a quarry in
the mountains makes them in town later. Building ten houses tomorrow
means topping up timber today.

Roads take theirs too, gravel and asphalt and, over water or over each
other, concrete and steel, but straight from the depots' stock as they
are committed, with no lorry: a road is instant, and so the bigger the
gravel depot, the more road can be laid in one go.

As built (2026-10-10): a road tile takes a unit of stone, off the
shelves of the depots nearest it as far as they hold any. What they lack
the world sends on the spot, express, at twice the ferry's price, paid
at the harbour as a lump; with no harbour yet there is no border to pay
at, and the first street is free. A road is never refused for want of
stone: refusing would make the network, the thing the player iterates
on, wait on a ferry, and the opening's first street comes before its
first stone. Laying it on credit (stock below zero, paid back by the
next box) was the other way, and lost: every shelf would have to learn
that it can be owed. Express is the rule the world already has, "I need
it now is always possible and always dear", and it makes the lesson
plain: about a coin a tile from the treasury, half that from a depot's
stone, nothing from the town's own quarry. Demolition gives nothing back
yet. A building in hand
says beside it what it takes against what the depots hold (`game.md`
§Buildings).

## The opening

1. Build a harbour on the coast.
2. Build a depot.
3. Connect them with a road.
4. A shipment arrives: the starter pack, pallets forklifted off the
   first ferry onto the harbour's quay. The player taps the town's one
   lorry to fetch them, and the camera follows it from the harbour to
   the depot the first time, so the player learns that shipments can be
   followed. Its packages are forklifted off its flatbed into the
   depot's open yard.
5. Build.

Four beats, each teaching one thing: ships come here, things are kept
here, roads move them, this is what arriving looks like. Then the player
has seen the whole loop.

## What goes, what stays

**Goes** (`shelved.md`, 2026-10-10): posted prices and the nudge, unit
cost, delivered price as a price, households pricing money in hours,
labour asks and the hiring threshold, the band and the crossing as
arithmetic, capital's third and the household's tenth, one purse as the
balance of payments, the season's equilibrium tests. The cut of
2026-09-23 (services, wear, leisure) goes with it.

**Stays:** stocks and their calls, residents' needs and their trips,
vehicles that fetch and deliver, the farm and its tractor, the
warehouse, sites built from delivered materials, the world beyond the
sea.

Inside a town a buyer takes the nearest seller with stock, by road.
People stay in their own town; only goods cross its border.

## Open

1. Where a contract's covering import physically goes: to the buyer on
   the seller's account, or through the seller's depot.
2. Who drives a listing's shipment, the seller's lorries or the
   buyer's. Seller to begin with.
3. The order board. Built as letters from four mayors beyond the edge
   (`missions.md` §Orders): drawn from what the town makes or sells,
   every third from a building it lacks; a box sold while one wants
   its good is marked for it and paid at the mayor's price, over the
   world's, as it sails with the ferry. Still open: big contracts
   announced days ahead that every town on the island fills together;
   demand that softens when everyone ships the same good; ships toward
   a town's own edge, if direction should ever cost.
4. What a town wants from inside: whether houses climb a ladder of wants
   (Caesar III, Anno), and so what a night at home is worth in GDP
   (nothing yet).
5. The Exchange is the container port (`shipping.md`); what the building is
   called on the menu.
6. Whether the harbour and the first depot are free, or built from the
   starter pack.
7. How many coins the starter pack carries, and the world's two prices
   for each good.
