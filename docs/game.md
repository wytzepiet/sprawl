# Sprawl: how the game works

The short version of every design decision, 2026-09-09. Older documents
hold the detail; this one is the shape.

## The rule

**Everything that happens in the city is a vehicle you can watch.** People
move by car, goods by truck, ship and train. Nothing exists that is not
drawn moving on the map, and nothing is read from a panel that could not
have been seen on the map first. Sprawl, the sea of cars and lots, is what
the rules produce by default; the game is what you make of it.

**Every system pays out as an event you can see on the map.** A visit
ends and the money lands on the shop; a truck arrives and the house goes
up; a car drives to the edge because the town has no fuel. A dial may sum
the events, but the events come first. A system that is only a rate on a
dial might as well not exist.

## Roads

You draw the network. **Streets** front buildings and take driveways.
**Roads** are through routes nothing fronts onto: faster, later with
priority over streets and levels for overpasses. One-way is a toggle.
Intersections are the skill ceiling: roundabouts, merges, interchanges are
built from these three things. The survey's own roads run off the map;
they are the door for everything that comes from outside.

## Buildings

**You place every building, and every building costs.** Pick a kind from
a hotkey menu, tap beside a street, and it snaps to the frontage with its
lot behind; hold to nudge first. The meter pays for it. Saving for the
next thing and putting it down is the loop: earn, save, place, watch it
work, earn faster. Nothing arrives on its own — a town that grew while
you looked away was never yours. What to build next is read from the
road: cars driving to the edge for fuel want a gas station, workers
pouring in from the frontier want homes.

There is no line between placeables and the rest. A depot, a gas station,
a port and a house are all placed the same way; they differ in price and
in what you watch afterwards. A **service** is still a building whose
vehicle answers calls — warehouse, supermarket, gas station, fire
station, hospital — and until it exists the call is answered from beyond
the edge, slowly.

## The build

The skill tree is a town plan. Points come from the city's level. Four
avenues: homes, commerce, industry, roads. Placeables unlock where two
avenues meet. The build is the one gate for what may be bought, how much
road, which road kinds. It says what may exist and in what proportion,
never where.

## People

A resident has needs (home, work, rest, eat, leisure) and chooses where
to serve them by time and value. Every trip is a car. Everyone owns one,
and the car has the one need a machine has, fuel, which its driver weighs
alongside their own; parked cars sit in the building's spots, so who is
home and how busy a shop is can be seen from the lot. Arrivals from outside come by road,
later by train or plane, and get a car at the door. Nobody walks.

**Everything the city lacks exists beyond the edge.** Every road exit is
a building with every tap, unlimited homes and unlimited jobs. A resident
with no shop in town drives to the edge to eat; a job with no one to fill
it is filled by someone who commutes in from there and lives nowhere you
can see. The edge is far by design: the drive is the price, and the price
is what makes a town of its own worth building. A neighbour's roads must
be drivable through — an edge that moves behind a neighbour who provides
nothing is pressure on them, not a wall for you.

## Goods

One token, the container; a second, the crate, for food. **Factories
produce goods**, **farms produce food**, both call for pickup. **Shops,
supermarkets and restaurants consume them** and call for delivery. A
buyer takes the cheapest delivered option, and a **warehouse** is what
wins when it is nearer than the producer. What nobody in town buys, the
edge buys, by road, slowly. The **port**, later, is a second door with
cheaper freight. **Trains** are a bigger, cheaper truck from a station
on a mainline the map was born with.

**Construction is a delivery.** A placed site is a call; a construction
firm's truck answers it with materials, from the edge until you have one,
and the building goes up when the truck leaves. Build time is the drive —
seconds to a minute, set by distance, never a countdown. Tap the site
before the truck arrives and the cost comes back in full: that is the
undo. One material and one truck; a second material only when the map
gives a reason to choose. Roads stay instant under the brush.

## Money

The town has one purse. Money enters when the town sells labour or goods
to the outside and leaves when it buys from it or builds; inside, a sale
is a line in two sets of books and nothing moves. Everything is a stock
that runs down — a shelf, a tank, an appetite, a house's hours of labour
— and every building is a row that draws some stocks and fills one:
labour is a good, and a house is where it is made. Every building posts
a price for what it fills, nudging it up when the stock empties and down
when it fills, never below cost. A resident prices money in hours of
their wage, so the one score that already picks their day picks by price
too; a building prices money in hours of its takings and picks by
delivered price, its workers included: whoever has the deficit picks,
and only the delivery varies by good. Beyond the edge is a world that runs the same rows at
capacity and charges a crossing, so nothing can run away and no price is
authored. Two numbers: GDP, hours of need served in town, which is how
rich the town is and what opens the tree; and the treasury, what the
town has earned from the outside net of what the mayor built, which is
what the mayor can spend. Nothing crosses the edge for a town with
nothing to pay, and a town that cannot feed itself dies; so a town must
sell something, or grow its own. Ignoring prices never hurts; reading
them is how you win. `economy.md` is the mechanism.

## Power

A plant burns what trucks bring it. Pylons, the one drawn line, carry it
to substations; a substation powers every building within a reach along
the roads. Night is the gauge: powered buildings glow. Nuclear later.

## Conditions and services

Stock, fire, health, obedience: a stock a call refills, with a
consequence that scales with how late the answer was, and something lost
at zero — a resident, a building. Fire station and hospital are the
first; police when there is crime to answer. Services are paid from the
treasury and earn nothing; there is only what they save.

## Legibility

The map warns first: red for unjoined, grey for empty shelves, dark for
unpowered, a dimming shop for one losing money. Click anything for a panel
of per-day rates, each line a trip or a tap that points back at the map.

**The advisor** is the inspect panel in language: a model with read-only
tools over the same rates, answering the questions that cross three
panels ("why is the west district losing money") and pointing at the map.
It never builds, and it never knows anything the map and panels cannot
show by hand, so it sells time, not knowledge. A few questions a month
are free; more is the subscription.

## Out

Pedestrians, transit, water, sewage, garbage, zoning, sliders, policies,
drawn wires, panels that control, buildings that arrive on their own,
proposals to accept, pending spawns to adjust.

Filed, not promised: roads built by trucks and the gravel and oil behind
them; big infrastructure built by cranes; several materials; edge prices
that drift with the world's trade; a sea that is one connected body, and
ports on it.

## Order

`roadmap.md` holds it, as playable milestones. The shape: placing, then
the edge, then construction, then goods, then money, then food, the port,
power, services, the advisor, other people.
