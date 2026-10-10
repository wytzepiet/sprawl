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
are the world's and the lorries the town's, and an empty goes back with
the next trip, filled with an export if there is one. What the town
sells leaves the same way. The ferry's deck is the door's size, and the
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
**Roads** are through routes nothing fronts onto: faster, later with
priority over streets and levels for overpasses. One-way is a toggle.
Intersections are the skill ceiling: roundabouts, merges, interchanges are
built from these three things, and your steel lorries share them with the
school run.

**Roads are instant.** A committed road is there at once, with no crew to
wait for, because the network is the thing you iterate on: a shortcut, a
junction drawn again, and the traffic answering in the same minute. A
road that waited on a paving crew would also make a jam slow to fix, the
crew stuck in the jam. What a road takes comes straight out of the depots' stock as it
is committed: gravel for its base and asphalt for its top, and concrete
and steel for a bridge or an overpass, which is the big project you stock
a big depot for. Until the quarry (`roadmap.md` milestone 3) a road costs
only the build's tiles. Demolition gives back part of what a road took,
so trying things is never punished.

## Drafts

**Everything you place or take away is a draft until you commit it.** A
swipe of the finger is not a hundred tonnes of concrete, and a swipe of
the demolisher is not half the town. A drafted road or building stands
on its tiles, blue and translucent, and reserves them, so in a shared
town nobody else builds there; it joins what it touches, so a house beside
a drafted street is fine; and it does nothing yet: no traffic on it, nobody
living in it, no call from it. A drafted demolition is a red tint on the
real thing, which goes on working until the commit. Beside the draft
stands its bill: each material it takes against what the depots hold,
short in red, and the coins for anything that has to be bought in.

**Commit** makes it real in one stroke: roads first, then buildings, then
the demolitions, each as if it had been drawn live, and round again while
anything more goes in, so a house drafted over one drafted to come down
goes up once the old one is gone. Roads are laid and draw their
materials; buildings become sites; demolitions come down. What the stock
cannot cover the bill offers to order, with when it would land, and what
no longer fits (someone built there meanwhile) stays a draft, marked.
Undo takes back the last stroke and discard the lot. A draft is the
player's own and outlives a restart.

Why it is back after being shelved (`shelved.md`): once building costs
materials the second step buys something, the bill; and this one is
lighter. A draft only takes up space. It is never part of the road graph,
a draft building has no door, and so nothing that runs the town has to
know drafts exist.

**Built, 2026-10-10** (`server/src/drafts.rs`, `client/src/ui/Bill.tsx`,
`client/src/engine/Ghosts.tsx`). A draft is nothing but the steps of the
hand as they were taken, a drag to a stroke, kept per player
(`World::drafts`, its own table in the save). There is no draft road node
or draft building anywhere: the server never works out what a draft
*would* be, it replays the steps through the handler that builds live
when it is committed (`take_step`), and what that handler refuses is the
step that no longer fits. The one rule of where the hand may go is still
the live one; at the moment of drafting the server only asks that a step
is on the map, onto ground it could stand on, and on nobody else's draft.
The client's hand sees its own draft as built, so its dots let a house be
drawn beside a drafted street (`may.ts`).

- **The second step is nearly free.** The moment anything is drafted the
  bill appears over the toolbar: what is drawn in words ("15 road, a
  harbour, a depot, 3 houses"), each material against what the town has
  (in the depots or on its way, less what standing sites still wait
  for), short in red, the order for the shortfall at the harbour one tap
  away, and Build. Enter builds, Ctrl or Cmd Z takes back a stroke, Esc
  with nothing in hand drops the draft. Built, the ghosts flash pale and
  sink into their sites.
- **The demolisher rubs a draft out**: a tap on one's own drafted tile
  takes back what lies on it, a drag across a drafted road cuts that
  link, and a tap on a demolition drafted takes it back.
- **The first depot is free on the bill**, as it stands at once; a
  harbour takes nothing.
- **Roads cost nothing yet**, so the bill counts buildings only; a
  road's materials are a line in `drafts::bill` once roads draw on stock.
- **Anyone's draft is drawn**: one's own blue, a stuck step amber,
  another player's grey, as land taken.
- `bun run act` drafts each command and commits it, as the bill's Build
  would; `act draft …` leaves it drafted, and says the bill; `act
  commit | undo | discard`. `PLAYER=<id> bun run look --ui` sees a draft
  as its owner does.

## Buildings

**You place every building, and every building is built from materials
delivered to it.** Pick a kind from a hotkey menu, tap beside a street,
and it snaps to the frontage with its lot behind. What stands is a site:
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

**Nobody waits on a mechanic they were not taught.** The first depot
comes with a top-up rule already on it, drawn over it like any rule:
keep above so much timber, from the world. The player sees automation
before they need to understand it, and can change it. And anything that
stalls says why where it stalls, with the fix beside it: a site's card
says "waiting on 12 timber, none in stock" and offers the order, with
when it would land.

There is no line between placeables and the rest. A depot, a pump, a works
and a house are all placed the same way; they differ in what they need and
what you watch afterwards. A **service** is a building whose vehicle
answers calls, and until it exists the call is answered from beyond the
sea, slowly.

## The build

**Switched off, to be designed again.** The skill tree as built is old: its
avenues and nodes name kinds that are gone or going, it reads poorly and
it plays poorly. Until the roster settles (`buildings.md`) everything is
unlocked and the tree's screen is hidden; the level, which is GDP to date
(`trade.md` §GDP), still counts. The tree that replaces it is designed
from the roster, with a look of its own.

What it should keep from the old idea: the build is a town plan, the one
gate for what may be built, how much road, which road kinds and how big
the door is; a kind arrives after the map has shown the need for it; it
says what may exist and in what proportion, never where.

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
or sold by hand at the harbour, or by a top-up rule on a depot. Trading
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

1. Build a harbour on the coast.
2. Build a depot.
3. Connect them with a road.
4. A shipment arrives: the starter pack, trailers off the first ferry.
   You tap the town's one lorry to fetch them, and the camera follows it
   from the harbour to the depot the first time; the crates stack in its
   yard.
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

Filed, not promised: big infrastructure built
by cranes; the raw goods table above; the world's prices drifting with
its trade; sidings and trains; the airport as the fast, dear door; a
ride-along camera behind a shipment.

## Order

`roadmap.md` holds it, as playable milestones. The shape: the cut, then
the opening, then the world as a trader, then chains in town, then roads
that are roads, then other people and trade between them, power,
services, the advisor.
