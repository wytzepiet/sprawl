# Sprawl: how the game works

The short version of every design decision, 2026-09-06. Older documents
hold the detail; this one is the shape.

## The rule

**Everything that happens in the city is a vehicle you can watch.** People
move by car, goods by truck, ship and train. Nothing exists that is not
drawn moving on the map, and nothing is read from a panel that could not
have been seen on the map first. Sprawl, the sea of cars and lots, is what
the rules produce by default; the game is what you make of it.

## Roads

You draw the network. **Streets** front buildings and take driveways.
**Roads** are through routes nothing fronts onto: faster, later with
priority over streets and levels for overpasses. One-way is a toggle.
Intersections are the skill ceiling: roundabouts, merges, interchanges are
built from these three things. The survey's own roads run off the map;
they are the door for everything that comes from outside.

## Buildings

Generic kinds arrive on their own onto settled streets: homes, shops,
offices, workshops, factories, restaurants, bars. The mayor places the
**placeables**, and a placeable is a building that does something:
warehouse, supermarket, gas station, port, plant, fire station, hospital.
A placeable is a service: something calls, its vehicle answers, and until
it exists the call is answered from beyond the edge, slowly.

## The build

The skill tree is a town plan. Points come from the city's level. Four
avenues: homes, commerce, industry, roads. Placeables unlock where two
avenues meet. The build is the one gate for what may arrive, what may be
placed, how much road, which road kinds.

## People

A resident has needs (home, work, rest, eat, leisure, fuel) and chooses
where to serve them by time and value. Every trip is a car. Everyone owns
one; parked cars sit in the building's spots, so who is home and how busy
a shop is can be seen from the lot. Arrivals from outside come by road,
later by train or plane, and get a car at the door. Nobody walks.

## Goods

One token, the container; a second, the crate, for food. **Factories
produce goods**, **farms produce food**, both call for pickup. **Shops,
supermarkets and restaurants consume them** and call for delivery. Every
call goes through a **warehouse**. The **port** is the door: warehouses
import by ship when empty and export when full; with no warehouse, shops
and factories trade with the edge directly. **Trains** are a bigger,
cheaper truck from a station on a mainline the map was born with.

## Money

Every tap has a fixed price: an hour of hunger served costs the resident
and earns the shop; an hour worked earns the resident and costs the
employer; an hour at home is rent, to the city. Every container moved
costs per tile, cheaper by ship or train. The city takes a fixed cut of
every sale. Businesses hold a balance and close when it runs dry. Residents
pass money through at first; if they get wallets, the floor is emigration:
the car drives off the map. Prices never float. Income is a rate you
watch, spent on roads, placeables and fuel for the plant.

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
floating prices, drawn wires, panels that control.

## Order

1. Parking: spots on plots, cars drive in and out.
2. Goods: factories produce, warehouse at 3x2, the container on the truck.
3. Money: prices on taps and deliveries, balances, closures.
4. Food and farms.
5. The port.
6. Power: plant, pylons, substations, night.
7. Fire, then hospital, then the inspect panel.
8. Trains, if a build needs more bulk than the port.
