# Sprawl: how the game works

The short version of every design decision, 2026-09-23. Older documents
hold the detail; this one is the shape. What this version set aside, and
why, is in `shelved.md` under that date.

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

**Automation is earned.** The first loads are yours: the town's one lorry
moves when you tap it, and the first building whose vehicles move on their
own is a relief you remember. Everything that dispatches itself was once
something you did by hand, and the hand never goes away; it only becomes
absurd.

## The island and the door

The world is one island in a sea, seen whole from the first minute. There
is no fog and no survey. You can look anywhere, and what you see is the
map: grass, forest, mountain, coast. Beyond the shore is the world, and it
is reached only by sea.

**The door is the terminal**, the one building the world builds for you.
Placing it on the coast is how a game starts, so every town starts on the
coast and grows inland. The world runs a ferry to it on a timetable: so
many cars a sailing, so many sailings a day, a crossing time. Cars roll off
the ramp, the outside's commuters and the world's lorries and tankers among
them; boxes come off onto the quay, which is a depot's shelf; what the town
sells goes back the same way. The boat's batch is the door's size. When a
sailing is full the next load waits, its price rises, and making the thing
in town becomes worth it. The tree grows the door: a bigger ferry, then a
berth per handling class where a bigger ship lands boxes, fuel or bulk by
the shipload at a fifth of the crossing. The mayor never owns a ship, and
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
spent. Who delivers is the one protocol: the town's lorry when you tap
it, a depot's van, a lorry off the ferry when the quay is bare and the
town can pay. There is no construction firm. The site is the buyer, the
depot is the builder, and a works in town is later a cheaper source for
the same call.

**The mayor never spends money.** A building costs its materials, and
materials cost the reserve only when they come from outside. Early on that
is every building. Later, with a works and a quarry, nothing at all. The
list at the quay says which, and the ghost says it before you place.

There is no line between placeables and the rest. A depot, a pump, a works
and a house are all placed the same way; they differ in what they need and
what you watch afterwards. A **service** is a building whose vehicle
answers calls, and until it exists the call is answered from beyond the
sea, slowly.

## The build

The skill tree is a town plan. Points come from the city's level. Four
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
morning boat, whose wage goes home on the evening one. The sailing is the
price, and a seat on the boat is a seat a commuter wanted, so a town that
sends its people abroad for lunch finds its workers waiting on the far
side. The signal is the queue at the ramp.

## Goods

One mechanism: a good is a load on a shelf, carried by the vehicle of its
class. Boxes ride a lorry: crates, materials. Liquid rides a tanker: fuel.
Bulk rides a hopper, once there is a mine to fill one. **Farms produce
crates, a works produces materials**, both call for pickup. **Shops sell
meals, sites eat materials**, both call for delivery. A buyer takes the
cheapest delivered option, a **warehouse** is what wins when it is nearer
than the producer, and what nobody in town buys, the door buys. **The
player never routes a load.** The road decides who is nearest, and the
game is the road.

One material, until the map gives a reason for a second. The ceiling is
one per avenue of the tree, each from a terrain the island draws: lumber
from forest, concrete from a quarry, steel from a mine, asphalt from crude
at the port. Every row is one input and one output; a chain, never a
graph. Trains are a bigger, cheaper truck on a siding you lay, later.

Three sinks, all on the map: people eat and burn fuel, growth eats
materials, and the door takes the rest at the world's price less the
crossing.

## Money

Two things are called money, and the player spends neither.

**Prices decide where trucks go.** Every building posts a price in hours
for what it fills, nudging it up when the stock empties and down when it
fills, never below cost. A buyer takes the cheapest delivered, its workers
included, so a shorter road changes who wins. Beyond the sea is a world
that runs the same rows at capacity and charges a crossing, so no price
can run away and none is authored.

**The reserve is outside money.** The town has one purse. It moves only at
the quay: in when the town sells to the world, out when it buys from it,
out when a commuter takes a wage home. Inside town a sale is a line in two
sets of books and nothing moves. The town spends the reserve through its
imports; the mayor steers it by what they build. Nothing crosses the door
at zero, so a town that buys more than it sells finds its sites waiting
for a boat that does not come, until it sells something or makes its own.
A town's money is what it sells to others: that is why a town that trades
with nobody grows with nobody, and why the multiplayer island is a place
towns need each other.

Two numbers: GDP, hours of need served in town, which is how big the town
is and what opens the tree; and the reserve, which is whether it pays its
way. Taxes were argued and rejected: a tax pays the town where the sale
happens, which rewards self-sufficiency and turns every neighbour into a
rival for diners. `economy.md` is the mechanism.

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
unpowered, a dimming shop for one losing money, and over a waiting site
the icon of what it waits for and the boat it is on. Every load crossing
the ramp carries a lump, one colour in and one out, and the cargo is
drawn on the truck.

The meter has two dials and one line: GDP, the reserve, and the biggest
import today, which is the next thing to make. The terminal's card is the
list of what crossed today, both ways, vehicles first, each line lighting
on the map what used it. Click anything else for a card that leads with
what it did for the reserve. The town's page keeps the season, and the one
chart, for day twenty.

**The advisor** is the inspect panel in language: a model with read-only
tools over the same rates, answering the questions that cross three
panels and pointing at the map. It never builds, and it never knows
anything the map cannot show by hand.

## The opening

The ferry docks and unloads the kit: the town's lorry, the first settlers'
cars, and the starting materials onto the quay. You draw the first road
from the ramp. You place a shop; a site icon says materials; you tap the
quay, then the site, and your lorry builds it. You place houses; the next
boat brings the people; they drive home and then to your shop, and the
first lump lands. The farm's yard fills and you carry crates until the
shop is stocked, then carry the surplus to the quay and watch the boat
take it, and the reserve rise. Cars queue at the ramp with empty tanks:
you place a pump. The icons outrun one lorry: the tree offers the
warehouse, two lorries that do this by themselves, and you stop tapping.
Everything after is that loop, one good higher: sites want materials, the
works wants ore, ore is that mountain or that berth.

The manual phase ends within minutes and the lorry stays for good, the way
hand-mining stays: a slump you can dig out of by hand, never a chore.

## Out

Pedestrians, transit, water, sewage, garbage, zoning, sliders, policies,
drawn wires, panels that control, buildings that arrive on their own,
proposals to accept, fog, a survey, roads born with the map, a mayor with
a body or a wheel, conveyor belts, hand-wired supply pairs, trucking
companies, taxes, leisure as a need, services as a good, wear on cars.

Filed, not promised: roads built from asphalt; big infrastructure built
by cranes; the raw goods table above; edge prices that drift with the
world's trade; sidings and trains; a ride-along camera.

## Order

`roadmap.md` holds it, as playable milestones. The shape: the cut, then
the opening, then goods and the works, then money made legible, then
roads that are roads, power, services, the advisor, other people.
