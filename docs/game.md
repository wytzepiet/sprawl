# Sprawl: how the game works

The short version of every design decision, 2026-09-08. Older documents
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

A resident has needs (home, work, rest, eat, leisure, fuel) and chooses
where to serve them by time and value. Every trip is a car. Everyone owns
one; parked cars sit in the building's spots, so who is home and how busy
a shop is can be seen from the lot. Arrivals from outside come by road,
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
supermarkets and restaurants consume them** and call for delivery. Every
call goes through a **warehouse**. The **port** is the door: warehouses
import by ship when empty and export when full; with no warehouse, shops
and factories trade with the edge directly. **Trains** are a bigger,
cheaper truck from a station on a mainline the map was born with.

**Construction is a delivery.** A placed site is a call; a construction
firm's truck answers it with materials, from the edge until you have one,
and the building goes up when the truck leaves. Build time is the drive —
seconds to a minute, set by distance, never a countdown. Tap the site
before the truck arrives and the cost comes back in full: that is the
undo. One material and one truck; a second material only when the map
gives a reason to choose. Roads stay instant under the brush.

## Money

Every tap has a fixed price: an hour of hunger served costs the resident
and earns the shop; an hour worked earns the resident and costs the
employer; an hour at home is rent, to the city. Every container moved
costs per tile, cheaper by ship or train. The city takes a fixed cut of
every sale. Businesses hold a balance and close when it runs dry. Residents
pass money through at first; if they get wallets, the floor is emigration:
the car drives off the map. Prices never float. Money lands in lumps: a
visit ends and the amount shows above the building, the city's cut taken
from the same lump, the meter stepping up with an address on every step.
It is spent on buildings, road beyond the allowance, and fuel for the
plant.

## Power

A plant burns what trucks bring it. Pylons, the one drawn line, carry it
to substations; a substation powers every building within a reach along
the roads. Night is the gauge: powered buildings glow. Nuclear later.

## Conditions and services

Stock, fire, illness: a state a call changes, with a consequence that
scales with how late the answer was. Fire station and hospital are the
first; police when there is crime to answer.

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
floating prices, drawn wires, panels that control, buildings that arrive
on their own, proposals to accept, pending spawns to adjust.

Filed, not promised: roads built by trucks and the gravel and oil behind
them; big infrastructure built by cranes; several materials; prices that
rise with scarcity across neighbours.

## Order

1. Placing: a hotkey menu, tap to place, the meter pays. The spawner off.
   One evening on a fresh seed 7 to feel whether saving and placing is
   the loop. If it is, the spawner goes.
2. The edge: exits as buildings with every tap, homes and jobs.
3. Construction: the site as a call, the truck, the refund.
4. Money: lumps at the building, the cut, balances, closures.
5. Food and farms.
6. The port.
7. Power: plant, pylons, substations, night.
8. Fire, then hospital, then the inspect panel.
9. Trains, if a build needs more bulk than the port.
