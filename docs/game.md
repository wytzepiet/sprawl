# Sprawl: how the game works

The short version of every design decision, 2026-09-23; the economy
rewritten 2026-10-10 around trade (`trade.md`). Older documents hold the
detail; this one is the shape. What each version set aside, and why, is
in `shelved.md` under its date.

## The rule

**Everything that happens in the city is a vehicle you can watch.** People
move by car, goods by truck, ship and train. Nothing exists that is not
drawn moving on the map, and nothing is read from a panel that could not
have been seen on the map first. Sprawl, the sea of cars and lots, is what
the rules produce by default; the game is what you make of it.

**Every system pays out as an event you can see on the map.** A visit
ends and the money lands on the shop; a truck arrives and the building goes
up; a car drives onto the ferry because the town has no fuel. A dial may
sum the events, but the events come first. A system that is only a rate on
a dial might as well not exist.

**Automation is earned, and seen.** The first loads are yours: the town's
one lorry moves when you tap it, and the first lorry that moves on its own
orders is a relief you remember. Everything that dispatches itself was
once something you did by hand, and the hand never goes away; it only
becomes absurd. Automation is a thing on the map, a vehicle with orders or
a rule on a building that shows it, never a setting in a menu, and an
automated shipment is the same event as a manual one.

**Every shipment can be followed.** Click a pending import and the camera
goes to the lorry or the ship carrying it, wherever it is, and follows it
home.

## The island and the door

The world is one island in a sea, seen whole from the first minute. There
is no fog and no survey. You can look anywhere, and what you see is the
map: grass, forest, mountain, coast. Beyond the shore is the world, and it
is reached only by sea.

**The door is the harbour**, built on the coast first, so every town
starts on the coast and grows inland. The world runs a ferry to it on a
timetable: so many cars a sailing, so many sailings a day, a crossing
time. Cars roll off the ramp, the world's lorries and tankers among them;
goods come off onto the quay, a small buffer that wants moving to a
depot; what the town sells goes back the same way. The boat's batch is
the door's size. The tree grows the door: a bigger ferry, then a berth
per handling class where a bigger ship lands boxes, fuel or bulk by the
shipload, cheaper. The mayor never owns a ship, and
nothing arrives anywhere but the ramp.

Neighbours are reached by road and the world by sea. That is the whole of
multiplayer's geography, and a single player's island is the same island
with one town on it.

## Roads

You draw the network, and the first road is yours, from the ramp. No road
is born with the map. **Streets** front buildings and take driveways.
**Roads** are through routes nothing fronts onto: faster, later with
priority over streets and levels for overpasses. One-way is a toggle.
Intersections are the skill ceiling: roundabouts, merges, interchanges are
built from these three things, and your steel lorries share them with the
school run.

## Buildings

**You place every building, and every building is built from materials
delivered to it.** Pick a kind from a hotkey menu, tap beside a street,
and it snaps to the frontage with its lot behind. What stands is a site:
a dotted outline with one stock, the materials it needs, and a call like
a shop with an empty shelf. Deliveries land on it, and when the stock is
full the building stands. Build time is the deliveries; tap the site
before the first load lands and the call is cancelled and nothing is
spent. The materials are timber, steel and concrete, and they come from a
depot: a lorry drives them to the site, and the site goes up as they land,
outline, scaffolding, walls. Its card says what it waits for and where
that is, and a click follows it. There is no construction firm. The site
is the buyer, the depot is the builder, and a sawmill or a quarry in town
is later a nearer source for the same call.

**A building costs materials, not coins.** Materials cost coins only
when they are bought in. Early on that is every building; later, with a
sawmill and a quarry, nothing at all. Building ten houses tomorrow means
topping up timber today.

There is no line between placeables and the rest. A depot, a pump, a works
and a house are all placed the same way; they differ in what they need and
what you watch afterwards. A **service** is a building whose vehicle
answers calls, and until it exists the call is answered from beyond the
sea, slowly.

## The build

The skill tree is a town plan. Points come from the city's level (what
the level counts is open: `trade.md` §Open). Four
avenues: homes, commerce, industry, roads. Placeables unlock where two
avenues meet, in chain order, so a kind arrives after the map has shown
the need for it. The build is the one gate for what may be bought, how
much road, which road kinds, and how big the door is. It says what may
exist and in what proportion, never where.

## People

A resident has a home, a job, a car and an appetite. Their needs are home,
work and eat, and the car has the one need a machine has, fuel, which its
driver weighs alongside their own. Every trip is a car; everyone owns one;
parked cars sit in the building's spots, so who is home and how busy a
shop is can be seen from the lot. Arrivals come off the ferry and drive off
the ramp. Nobody walks.

**Everything the town lacks exists beyond the sea.** A resident with no
shop in town drives onto the ferry to eat abroad; a car with no pump rides
the boat to fuel; a job nobody fills is filled by a commuter off the
morning boat, who goes home on the evening one. The sailing is the
price, and a seat on the boat is a seat a commuter wanted, so a town that
sends its people abroad for lunch finds its workers waiting on the far
side. The signal is the queue at the ramp.

## Goods

One mechanism inside a town: a good is a load on a shelf, carried by the
vehicle of its class. Containers ride a lorry: crates, timber, steel.
Liquid rides a tanker: fuel. Bulk rides a tipper: gravel, cement, grain.
Makers call for pickup, buyers call for delivery, and **a buyer takes the
nearest seller with stock, by road.** Nothing inside a town has a price.
The player never routes a load inside the town; the road decides who is
nearest, and the game is the road.

**Depots keep everything.** What is made or bought is stored somewhere
real. A general depot holds a little of every class; a warehouse, a tank
farm and a bulk yard hold much of one. The town's stock is what its
depots hold, and where a depot stands matters, since goods ship from
it. A full depot stops what fills it, and is seen.

Chains are one input and one output a row, each from a terrain the island
draws: timber from forest, stone and gravel from the mountain, crops from
flat land, oil off the boat. Not every town's land has every one, which
is why towns trade.

## Money

**Coins are what trade is priced in, and only that.** They move when
goods cross the town's border: in when it sells, out when it buys. There
are no prices, wages or taxes inside a town.

**Across the border every trade is the player's** (`trade.md`): bought
or sold by hand at the harbour, or by a top-up rule on a depot. Trading
with other players comes later, with the Exchange: listings, standing
offers and contracts. Each is a shipment that drives or sails and can
be followed, and the coins land when it does.

**The world beyond the sea always trades**, badly: it sells anything at a
premium, on the slow boat, and buys anything at a discount. A town never
runs out of anything for good, and the world is never the cheap way.
Every player's price lives between its two. Speed costs: the ferry is
slow and cheap, a neighbour by road fast if near, an airport later fast
and dear. Order before you need it.

## Power

A plant burns what ships bring it. Pylons, the one drawn line, carry it to
substations; a substation powers every building within a reach along the
roads. Night is the gauge: powered buildings glow. Nuclear later.

## Conditions and services

Stock, fire, health, obedience: a stock a call refills, with a consequence
that scales with how late the answer was, and something lost at zero. Fire
station and hospital are the first; police when there is crime to answer.
Services are buildings whose vehicles answer calls; they earn nothing, and
there is only what they save.

## Legibility

The map warns first: red for unjoined, grey for empty shelves, dark for
unpowered, a glowing depot for one under its floor, and over a waiting
site the icon of what it waits for and the boat it is on. Every trade
lands as a lump of coins when its shipment does, one colour in and one
out, and the cargo is drawn on the truck.

The pending shipments are a list, each one a click from the vehicle
carrying it, with an arrival time that moves with the traffic. The
harbour's card is the list of what crossed today, both ways, vehicles
first, each line lighting on the map what used it. Click anything else
for a card that leads with what it did today.

**The advisor** is the inspect panel in language: a model with read-only
tools over the same rates, answering the questions that cross three
panels and pointing at the map. It never builds, and it never knows
anything the map cannot show by hand.

## The opening

1. Build a harbour on the coast.
2. Build a depot.
3. Connect them with a road.
4. A shipment arrives: the starter pack. The camera follows the lorry
   from the quay to the depot, the first time, and the crates stack in
   its yard.
5. Build. A house is a site; a lorry brings its timber from the depot,
   and it goes up. The next boat brings its people.

Four beats, each teaching one thing: ships come here, things are kept
here, roads move them, this is what arriving looks like. The manual phase
is the town's one lorry, tapped by hand, until the first lorry with
standing orders; the lorry stays for good, a slump you can dig out of by
hand, never a chore.

## Out

Pedestrians, transit, water, sewage, garbage, zoning, sliders, policies,
drawn wires, panels that control, buildings that arrive on their own,
proposals to accept, fog, a survey, roads born with the map, a mayor with
a body or a wheel, conveyor belts, hand-wired supply pairs inside a
town, trucking companies, prices and wages inside a town, taxes, leisure
as a need, services as a good, wear on cars.

Filed, not promised: roads built from asphalt; big infrastructure built
by cranes; the raw goods table above; the world's prices drifting with
its trade; sidings and trains; the airport as the fast, dear door; a
ride-along camera behind a shipment.

## Order

`roadmap.md` holds it, as playable milestones. The shape: the cut, then
the opening, then the world as a trader, then chains in town, then roads
that are roads, then other people and trade between them, power,
services, the advisor.
