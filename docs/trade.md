# Trade: depots, shipments, listings and contracts

Status: direction, 2026-10-10. Nothing built. Replaces the price economy
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
it now" is always possible and always costs (§Shipping).

Shipping takes time, and that is part of the game: order before you need
it. Every shipment shows when it will land, and the estimate moves when
the lorry meets traffic. A wait you can see coming is planning; one that
surprises is a chore.

## The Exchange

Trading with other players starts with a building: the Exchange,
placed on any street. Until a town has one it trades with the world
alone, at the harbour by hand and through its depots' top-up rules,
which is all a new player needs to learn: the harbour, the depot, the
road. The Exchange opens the trade board, listings to other towns,
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
buy up to its amount at its price; the buyer's top-up rules (below)
decide when.

**The seller always delivers.** A seller who cannot fill an order from
their own stock has it bought from the world at the world's price, and
pays the difference. The buyer sees one source and one price, and never
pays for the seller's trouble. Ending a contract early takes a day's
notice, so no town starves overnight.

## Top-up

A rule on a depot, for one good: keep above so much, fill up to so
much, from these sources in this order.

```
North depot · bread
  keep above   50
  fill up to   200
  from         contracts → listings under 3 → the world
```

The rule is the depot's own: it is about the depot's stock, shown on
the depot, and it works from the first depot with the world as its
source. Listings and contracts join the sources once the town has an
Exchange. That is the whole rule: when to order, how much, and from
where. A contract first because it is cheapest, listings next, the world last as
the net that always holds. A town that makes no food lives this way for
good, paying for it in coins and in depending on a neighbour, and that
is a choice against using the land for farms.

## Automation is seen

Everything is manual first and automatable later, and automation never
hides. It is a thing on the map:

- **Vehicles with orders.** The first loads are the town's one lorry,
  tapped by hand. Then the same lorry is given standing orders: every
  morning, collect at the quay, unload at the north depot. The
  automation is the lorry; what is automated is what is driving.
- **Rules live on buildings.** A depot's top-up shows over it as the
  good and its level; the stack in its yard is the level. When it
  reorders a ship sets out from the horizon.
- **Automation costs capacity.** A standing order needs a lorry, a berth
  slot, a contract. Automating more is building more, and three lorries
  on standing orders through one junction is a jam you made.
- **Failure is loud and on the map.** A lorry with nothing to collect
  waits with an icon; a depot under its floor glows; a late convoy is
  seen stuck.
- **An automated shipment is the same event as a manual one.** It has a
  pin, it can be followed, and its arrival is a moment: the lorry turns
  in, the crates stack, the number ticks up. At scale the moments
  become a dashboard, the list of what is on its way, and then the flow
  itself: a steady line of your lorries, a quay that never empties.

## Shipping

Status: direction, 2026-10-10, argued and liked, not settled in its
numbers. Nothing built.

The sea is the default way between towns, and the player never handles a
ship. Real shipping keeps three things apart, and so does this: who runs
the ships, how a load finds its way, and who asks for it.

**The shipping company runs the lines.** One company, the world's, runs
every ship. A line is a timetable over a route of harbours, its ships
sailing it in a loop, so every ship is somewhere at sea at every moment,
on the map, without anything dispatching it. Every harbour gets a line,
and a busy pair of harbours gets more sailings: the company follows the
traffic, up to what a harbour's size allows, and the tree grows that.
Ships sail on time whether full or not, so a wait is for the next
sailing, never for a shipload; small loads from many senders share a
ship. A sailing has room per class: vehicles, boxes, liquid, bulk. The
ferry is a line whose ships carry mostly vehicles, settlers and the
world's lorries among them, and is the same thing as a cargo line.

**A shipment is planned, not driven.** The player says what, from where,
to where, and by when: an order by hand, a top-up rule on a depot, a
contract with a player, a request from the world or from someone the
world stands for. A planner finds its route over the timetable: the
sailings, the changes of ship at a hub, and the road leg at the end,
earliest arrival first. This is a journey planner, the problem trains
and container lines solved long ago (Connection Scan: every departure in
time order, swept once), and it is worth making smart, because watching
a load go to a hub, wait, change ship and come home is the fun of it. A
shipment that misses its connection is planned again from where it is.
Every step is on the map and a click follows it: on a ship, in a yard
waiting for the next, on a lorry. Its arrival time is the plan's, and
moves when the plan does; because the world is the server's, a late
load is late for a reason you can see, a full yard or your own junction.
A pin marks every load on its way, and the ride-along camera
(`shelved.md`) is for sitting behind one and coming home with it.

**Urgency costs.** The timetable is the cheap, reliable way. An express
boat, sent for one load, is the fast and dear one; an airport later the
fastest and dearest. "I need it now" is always possible.

**Harbours have yards.** A ship unloads into its harbour's yard: boxes
stacked by where they go next, tanks into a tank row, bulk onto a heap.
The yard is a buffer in transit, not stock. Nothing in town draws on it;
a load in a yard is the town's only once a lorry has carried it to a
depot. A load in a yard either waits for its next ship, a transfer, or
for a lorry to its depot. The yard's size is the harbour's, and a yard
full of boxes is a jam you can see.

**The last mile is a choice.** By default the town's own lorries collect
from the yard, as importers' own trucks do (merchant haulage): tapped by
hand at first, then on standing orders, which is the manual phase of
`game.md`. Or the shipping company's lorry brings it to the depot's door
for a fee (carrier haulage), for the player who would rather not.

**A harbour can be a hub.** The planner may route someone else's cargo
through your harbour: their boxes sit in your yard waiting for their
connection. For each one handled, onto a ship or off it, your town is
paid dues: coins in, since it is a service sold across the border, and
GDP, since handling is work that adds value, as a port's is in any
country's accounts. Only others' cargo pays; a box of your own changing
ship in your own yard is your own pocket. Dues are per box handled, not
per day sitting, so a yard clogged with others' boxes costs room and
earns nothing more. A big harbour in a good spot is a way to play.

**Roads between towns are a choice.** Towns are not joined by road
unless their players join them. Islands, towns far apart and a shared
road too small for two towns' traffic stop being problems; a road link
is built when lorries beat ships, a neighbour close enough to drive to.
A shipment's planner uses one where it exists.

**Containers are the bread and butter.** Everything a town orders
travels by the container at first: crates and timber in boxes, fuel in
tank containers, gravel and cement in lined bulk boxes, on the same
sailings and through the same yard. One way to learn. The container is
what is lifted, stacked and followed, and it is seen: the ship comes in,
the cranes lift its boxes onto the stacks one at a time, lorries back up
to the stacks and drive off with them. A harbour working is the
satisfying thing to watch in the game, and it is drawn as it happens,
never as a number going up.

**Liquids and bulk by the shipload.** When an order or a top-up is
big enough to fill a ship, a tank farm with room for a tankerful, a
bulk yard emptying ahead of a big build, the planner offers a charter: a
tanker or a bulker for that one load, point to point, cheaper by the
unit and only for the whole of it. A flow that recurs becomes a
standing charter, a tanker every few days (a contract of affreightment,
in the trade). It lands at the harbour's berth for its class, which is
the berth `game.md` §The island and the door grows the door with: a
tanker pumps straight into a tank farm built beside its berth, or into
the berth's tanks for road tankers to carry inland; a bulker's grabs
unload onto a heap in the yard for tippers, or into a bulk yard at the
berth. Only a tank farm can take a tankerful and only a bulk yard a
bulkerful, which is what each is for: chartering is the step from a
town that imports to one that trades.

Open:

1. How the company decides sailings: a frequency per line from the last
   days' bookings, or a ship added when the next sailings are full.
2. What the planner minimises: arrival only, or arrival with the price,
   and whether the player can say "cheapest" or "fastest".
3. Where hubs come from: any harbour the planner finds useful, or ones
   the player declares; and what the dues are.
4. How a top-up rule books: "will I be under my floor by the next
   arrival", and how it avoids booking twice for one shortfall.
5. How big a box is, and whether a part-full box sails.
8. How big an order has to be before a charter is offered, and whether
   the pipe from a berth to a tank farm is drawn or follows from their
   standing side by side.
6. Carrier haulage's fee, and whether the company's lorries are drawn
   on the town's roads like anyone's.
7. Whether players run lines of their own one day, against `game.md`'s
   "the mayor never owns a ship".

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
gravel depot, the more road can be laid in one go. Placing anything is a
draft until it is committed, and the draft's bill says what it will take
against what is in stock (`game.md` §Drafts).

## The opening

1. Build a harbour on the coast.
2. Build a depot.
3. Connect them with a road.
4. A shipment arrives: the starter pack. The camera follows the lorry
   from the quay to the depot the first time, so the player learns that
   shipments can be followed. The crates stack.
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
3. The order board: what the world and computer towns want, so a single
   player has goals and income. Ideas: orders drawn from what the town
   makes, with one thing it lacks; big contracts announced days ahead
   that every town on the island fills together; demand that softens
   when everyone ships the same good.
4. What a town wants from inside: whether houses climb a ladder of wants
   (Caesar III, Anno), and so what a night at home is worth in GDP
   (nothing yet).
5. The Exchange's name. Kontor (the Hanse's trading posts) and the
   weigh house (Waag) were the alternatives.
6. Whether the harbour and the first depot are free, or built from the
   starter pack.
7. How many coins the starter pack carries, and the world's two prices
   for each good.
