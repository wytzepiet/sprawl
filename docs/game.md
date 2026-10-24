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
up; a trailer is towed off the ferry and a lorry backs up to take it
home. A dial may
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

The world is islands in a sea, seen whole from the first minute. There
is no fog and no survey. You can look anywhere, and what you see is the
map: grass, forest, mountain, coast. Beyond the shore is the world, and it
is reached only by sea.

**The map is mostly sea.** Several islands of different sizes and
different land, in one connected ocean that every coast can sail to,
because ships are how towns reach each other and the world. Land is a
sixth to a quarter of the map, in four to eight islands, the origin's the
biggest, with the origin forty tiles in from its coast on open grass;
each island has a character, most grass with some wood, some forest,
some mountain, and lakes inland but none on the sea. Each island is a
coast drawn round a centre and the map bent, so no sea is ever shut in
(`terrain.rs`). `every_seed_is_islands_in_one_ocean` checks it on the
first twenty seeds.

**The door is the harbour**, built on the coast first, so every town
starts on the coast and grows inland. It begins as a ferry harbour, a
ramp and a trailer park, the way small islands are supplied. The world's
shipping company's ferry calls on a timetable: the settlers drive their
cars off the ramp into town, and the world's trailers are towed off into
the trailer park, where they wait for the town's own lorries to fetch
them to a depot. No outside vehicle drives the town's roads; the boxes
are the world's and the lorries the town's, and a box is only ever full:
it is gone once unloaded at a depot, and the lorry drives off bobtail.
What the town sells leaves the same way, in a box loaded at the depot. The ferry's deck is the door's size, and the
door grows: more sailings, a bigger ferry, then the container port, a
building of its own with cranes and container ships and the trade board
(the Exchange), then berths for tankers and bulkers that land fuel or
gravel by the shipload (`shipping.md`). The mayor
never owns a ship, and nothing arrives anywhere but a harbour.

The sea is the default way between towns as well as to the world: the
world's shipping company runs every ship, a planner routes every load
over its timetable, through hubs, and harbours have yards where loads
wait to be collected (`shipping.md`, direction). Neighbours may
join their towns by road when they want to; nothing makes them. A
single player's island is the same island with one town on it.

## Roads

You draw the network, and the first road is yours, from the ramp. No road
is born with the map. **Streets** front buildings and take driveways.
**Roads** are through routes nothing fronts onto: faster, with priority
over the streets that meet them, and on levels for overpasses (built for
the interchange first). One-way is a toggle.
Intersections are the skill ceiling: roundabouts, merges, interchanges are
built from these three things, and your steel lorries share them with the
school run.

**Roads are instant.** A road is laid as it is drawn, with no crew to
wait for, because the network is the thing you iterate on: a shortcut, a
junction drawn again, and the traffic answering in the same minute. A
road that waited on a paving crew would also make a jam slow to fix, the
crew stuck in the jam. What a road takes comes straight out of the depots' stock as it
is laid: gravel for its base and asphalt for its top, and concrete
and steel for a bridge or an overpass, which is the big project you stock
a big depot for. As built, a tile takes a unit of stone off the nearest
depot's shelf, and what the depots lack the world sends express, dear,
so a road is never refused (`trade.md` §Building materials). Taken up
within five minutes, a road gives back what it took, so trying things is
never punished (§Undo).

## Undo

**What the hand does is done at once, and what it did lately is taken
back by taking it down.** A road is laid as it is drawn and a building
is a site the moment it is let go; there is no draft, no second step and
no undo button. A road or a building taken down within five minutes of
being laid or placed, a quarter of the town's day, is the slip undone: it
gives back what it cost (`undo::raze`, `undo::recoup`). The stone a road
took goes back on the shelves it came off and its express coins to the
purse; a building gives what its site had been brought, and what was on
a van to it, to the nearest depot, the rest in coins at the world's
price, or all it took if it stood. Taken down later, it gives back
nothing. Five minutes, not a count: what makes an action no longer a
slip is that the town has started to use it. The street a building
brought stays if someone's building since opens onto it. What the server
keeps for this (`World::placed`, `World::undo`) is forgotten on restart.

The interchange keeps its Z over the same record of road laid and taken
up: the newest action taken back, in order, refused with why when
something since rests on it (`undo::undo`). `bun run act undo` presses it.

## Buildings

**You place every building, and every building is built from materials
delivered to it.** A building is a fixed shape, its kind's plot: the
building and, for a kind with vehicles, its yard on the street side
(`blueprint.rs` `size` and `lot`). The toolbar's Build opens a menu of
every kind, each with a picture of it as the town draws it, its name and
what it is built of. Press on one and drag it onto the map: the menu
goes, and where it was is a place to let it go and put it back. While
it is in hand the dots show every place it fits; it turns itself to face
the nearest street, a harbour to face the sea, and R, the wheel or two
fingers twisting turn it by hand; the town is drawn as it would be with
it standing, its drive joined and its pavement laid, the building in
blue (`TownLayer.hold`); and beside it are what it takes against what
the depots hold, and, where it may not go, why ("No street before its
yard", "No quay: it stands half on the sea, its back on the water"). Let go where it fits
and it is placed at once, a site; anywhere else, nothing happens. The
rule of where it fits is the server's (`World::fit`), and the hand
asks it (`World::placing`). It is taken down whole, with one tap of the
demolisher. Its look still joins it to what is round it: a house beside
a house is a row (`town/layer.ts`).

What stands is a site:
a dotted outline with one stock, the materials it needs, and a call like
a shop with an empty shelf. Deliveries land on it, and when the stock is
full the building stands. Build time is the deliveries. The materials
are timber, steel and concrete, and they come from a depot: a lorry drives them to the site, and the site goes up as they land,
outline, scaffolding, walls. Its card says what it waits for and where
that is, and a click follows it. There is no construction firm. The site
is the buyer, the depot is the builder, and a sawmill or a quarry in town
is later a nearer source for the same call.

**A building costs materials, not coins.** Materials cost coins only
when they are bought in. Early on that is every building; later, with a
sawmill and a quarry, nothing at all. Building ten houses tomorrow means
topping up timber today. What a kind takes is a row on its blueprint,
and the materials come in by tier: the first buildings take timber
alone, so the opening teaches one material, one import and one lorry;
concrete and steel arrive with the kinds that are big, tall or over
water. More materials are more to trade and more ways to specialise, and
more to keep stocked; whether three feels like depth or a chore is for
play to say, and the rows are where it is tuned.

**Nobody waits on a mechanic they were not taught.** Every box the town
buys or sells is a slot on the ferry's deck the player booked, with a
named partner and a price (`trade.md` §The deck); a pin repeats a slot
every sailing, automation the player has turned on, never a purse that
falls by itself. And anything that stalls says why where it stalls,
with the fix beside it: a site's card says "waiting on 12 timber, none
in stock" and offers to book it, with when it would land.

There is no line between placeables and the rest. A depot, a pump, a works
and a house are all placed the same way; they differ in what they need and
what you watch afterwards. A **service** is a building whose vehicle
answers calls, and until it exists the call is answered from beyond the
sea, slowly.

## The build

**What a building is built from is the gate** (`plan-market.md` §No
tree). Any kind may be placed any time; what it waits on is its
materials, bought in if the town lacks them. There is no tree
(`shelved.md`). Guidance comes from the missions, which say what is next
(`missions.md`), and from the build menu, which gives beside each kind
what it takes against what the depots hold. The level is GDP to date
(`trade.md` §GDP), and gates nothing.

## People

A resident has a home, a job, a car and an appetite. Their needs are home,
work and eat, and the car has the one need a machine has, fuel, which its
driver weighs alongside their own. Every trip is a car; everyone owns one;
parked cars sit in the building's spots, so who is home and how busy a
shop is can be seen from the lot. Arrivals come off the ferry and drive off
the ramp. Nobody walks.

**People stay in their own town.** Only goods cross its border. A
resident with no shop in town goes without, and it shows; a job nobody in
town takes stays empty. The ferry brings settlers when the town has both
jobs and homes for them, so a town grows by giving people a reason to
come, and stops when it does not.

## Goods

One mechanism inside a town: a good is a load on a shelf, carried by the
vehicle of its class. Containers ride a lorry: crates, timber, steel.
Liquid rides a tanker: fuel. Bulk rides a tipper: gravel, cement, grain.
Makers call for pickup, buyers call for delivery, and **a buyer takes the
nearest seller with stock, by road.** Nothing inside a town has a price.
The player never routes a load inside the town; the road decides who is
nearest, and the game is the road.

**A call is a good and a place** (`calls.rs`). A shelf at its reorder
point calls, and so does a site for each material it waits on; the
nearest depot with the good on its shelf and a van free answers, by road.
The van drives to the caller, spends its service time at the door, and
goes home. What the town lacks comes by sea. A service's emergencies
will be calls the same way, the nearest vehicle free answering, and
lateness costs: a shelf empty, a fire spread.

**Depots keep everything.** What is made or bought is stored somewhere
real. A general depot holds a little of every class; a warehouse, a tank
farm and a bulk yard hold much of one. The town's stock is what its
depots hold, and where a depot stands matters, since goods ship from
it. A full depot stops what fills it, and is seen.

Chains are one input and one output a row, each from a terrain the island
draws: timber from forest, stone and gravel from the mountain, crops from
flat land, oil off the boat. Not every town's land has every one, which
is why towns trade. The kinds, what they take and make and what they are
built from, are in `buildings.md`.

## Money

**Coins are what trade is priced in, and only that.** They move when
goods cross the town's border: in when it sells, out when it buys. There
are no prices, wages or taxes inside a town.

**Across the border every trade is the player's** (`trade.md`): bought
or sold on the ferry's deck, a slot at a time or pinned. Trading
with other players comes later, with the Exchange, which is the
container port: listings, standing offers and contracts. Each is a shipment that drives or sails and can
be followed, and the coins land when it does.

**The world beyond the sea always trades**, badly: it sells anything at a
premium, on the slow boat, and buys anything at a discount. A town never
runs out of anything for good, and the world is never the cheap way.
Every player's price lives between its two. Speed costs: the scheduled
ship is slow and cheap, a neighbour by road fast if near and joined, an
express boat or an airport later fast and dear. Order before you need it.

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

1. Build a harbour on the coast: dragged there whole, with its own street.
2. Build a depot.
3. Connect them with a road.
4. A shipment arrives: the starter pack, trailers off the first ferry.
   The town's one lorry fetches them, and you can ride along from the
   harbour to the depot; the crates stack in its yard.
5. Build. A house is a site; a lorry brings its timber from the depot,
   and it goes up. The next boat brings its people.

Four beats, each teaching one thing: ships come here, things are kept
here, roads move them, this is what arriving looks like. The manual
phase is the deck, a slot booked by hand, until the first pin.

The opening is the first mission (`missions.md`): its steps are facts
the server reads off the town and ticks as they come true, and it pays
when the last is done. The trunk follows it on the ferry's deck: a box
booked, a slot of stone pinned, a box sold, and after it the town's situation opens a
mission when something first matters: a site short of stone asks for a
quarry.

**What pulls you on after it** is the order board (`missions.md`
§Orders). The playtest of 2026-10-10 found that once the opening was
done nothing asked anything of the town, and coins only fell. Now,
from the first ferry after it, letters come: four mayors of towns
beyond the map's edge, each a person with a voice, a direction and
the goods they want, ask for boxes of what the town makes, and every
third time for something a building it has not built would make. A
box sold while one is open is marked for that town, rides the lorry
to the park with the town's crest on it, and sails with the ferry to
the edge, and the mayor's coins land at the harbour as it casts off,
over what the world pays. Filling them raises the mayor's standing,
and so their orders and prices; and Port Aldra, the big city, writes
only once the town stands well with someone. It is income the player
earns by choosing what to make, and every bit of it is a box you can
watch go.

## Out

Pedestrians, transit, water, sewage, garbage, zoning, sliders, policies,
drawn wires, panels that control, buildings that arrive on their own,
proposals to accept, fog, a survey, roads born with the map, a mayor with
a body or a wheel, conveyor belts, hand-wired supply pairs inside a
town, trucking companies, prices and wages inside a town, taxes, leisure
as a need, services as a good, wear on cars.

Filed, not promised: big infrastructure built
by cranes; the raw goods table above; the world's prices drifting with
its trade; sidings and trains; the airport as the fast, dear door; a
ride-along camera behind a shipment.

## Order

`roadmap.md` holds it, each step pointing at its plan: the market, the
sea's network and the container port, chains in town, roads that are
roads, power, services, other people, the advisor.
