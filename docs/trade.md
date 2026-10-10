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

Speed is a choice that costs: the ferry is slow and cheap and carries a
lot; a neighbour by road is fast if near; an airport, later, is fast and
dear and carries little. "I need it now" is always possible and always
costs.

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

## Shipments

Every shipment is a vehicle in the world, and the list of pending ones
is the way to it. Click one and the camera goes to the lorry, the
tanker, the ship, wherever it is, and follows it home. Because the world
is the server's, it is not an animation: a late shipment is late for a
reason you can see, a neighbour's rush hour or your own junction. In a
shared world it crosses other players' towns.

- A pin on the map for every shipment on its way.
- The world's ship comes over the horizon and grows as it nears the
  quay.
- The ride-along camera (`shelved.md`) is for this: sit behind the
  lorry and drive home with it.

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
   (Caesar III, Anno), and what opens the tree, which was GDP's running
   sum, a number priced at the world's prices.
5. The Exchange's name. Kontor (the Hanse's trading posts) and the
   weigh house (Waag) were the alternatives.
6. Whether the harbour and the first depot are free, or built from the
   starter pack.
7. How many coins the starter pack carries, and the world's two prices
   for each good.
