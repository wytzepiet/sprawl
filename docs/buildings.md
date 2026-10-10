# Buildings: the roster

Status: draft, 2026-10-10, for the player to correct. Built so far:
house, apartment, shop, office, factory, gas station, supermarket, the
general depot (`Depot`: crates 200, fuel 100, timber 60, a lorry and two
vans), the farm and the ferry harbour, each built from timber (house 4,
apartment 12, shop 4, office 10, factory 14, gas station 6, supermarket
16, depot 10, farm 8, harbour none). Goods are crates, fuel and timber. What kinds the game
has once trade, materials and chains are in: what each is for, what it
takes and makes, what it is built from, and what moves its goods. The
numbers are guesses to be tuned in play; the shape is the point. A kind is
a row in `server/src/blueprint.rs`, and nothing else in the game names
one.

## The principles

- **Every kind earns its place on the map.** It does something you can
  watch: people live in it, a vehicle leaves it, a stock in its yard rises
  and falls. A kind that only makes a number go up does not exist.
- **Chains are one input and one output a step**, each raw good from a
  terrain the island draws. Not every town's land has every one, which is
  why towns trade (`game.md` §Goods).
- **Jobs come from things that make things.** The office and the factory
  were placeholders, desks that make nothing; they go once the chains give
  the town its work. Until a chain's buildings exist, nothing pretends.
- **What a kind is built from is a row**, and materials come by tier:
  timber first; concrete and steel for the big, the tall and anything
  over water (`game.md` §Buildings).
- **Depots by class.** Boxed goods, liquids and bulk each have a vehicle,
  a depot and a ship of their own; a general depot holds a little of each.

## Goods

| Good | Class | Comes from | Used by |
|---|---|---|---|
| Crates (food) | box | farm, or imported | shops, supermarkets; homes' meals out |
| Grain | bulk | farm | food plant (later) |
| Fuel | liquid | refinery, or imported | gas stations; every fleet vehicle |
| Crude oil | liquid | oil well (where the island has it), or imported | refinery |
| Timber | box | sawmill (forest) | every building, tier one |
| Stone / gravel | bulk | quarry (mountain) | roads; cement works |
| Cement / concrete | bulk | cement works | big buildings, bridges, overpasses |
| Ore | bulk | mine (mountain) | steelworks |
| Steel | box | steelworks, or imported | tall buildings, industry, bridges |
| Asphalt | bulk | asphalt plant (gravel + bitumen) | road tops, later |

Labour is not a good (`shelved.md`, jobs across the border).

## Homes

| Kind | Holds | Built from | Notes |
|---|---|---|---|
| House | 2 households | timber | the first thing built |
| Apartment | 7 households | timber, concrete | |
| (grades) | | | nicer homes worth more GDP a night: the ladder of wants, `trade.md` §Open 4 |

## Serving people

| Kind | Serves | Shelf | Filled from | Built from |
|---|---|---|---|---|
| Shop | meals | crates | nearest depot with crates | timber |
| Supermarket | meals, a district's | crates, many | nearest depot | timber, concrete |
| Gas station | fuel | fuel | nearest depot with fuel, by tanker | timber, steel |

## Doors

| Kind | What | Ships | Built from |
|---|---|---|---|
| Ferry harbour | ramp, trailer park, tug | ferry: settlers, cars, the world's trailers | timber (the first placement may be free, `trade.md` §Open 6) |
| Container port (the Exchange) | cranes, container yard, the trade board | container ships | concrete, steel |
| Tanker berth | jetty, pipe, tanks | tankers by charter | concrete, steel |
| Bulk berth | grabs, heap or conveyor | bulkers by charter | concrete, steel |

All on the coast, all on the shipping company's lines (`shipping.md`).

## Depots

| Kind | Holds | Vehicles | Built from |
|---|---|---|---|
| General depot | a little of every class | lorries, a tanker, a tipper | timber |
| Warehouse | much of boxes | lorries, vans | timber, steel |
| Tank farm | much of liquids; a tankerful beside its berth | road tankers | concrete, steel |
| Bulk yard | much of bulk; a bulkerful beside its berth | tippers | concrete |

## Making things

| Kind | Stands on / by | Takes | Makes | Built from |
|---|---|---|---|---|
| Farm | flat land, its own fields | — | crates (later grain) | timber |
| Sawmill | by forest, which it fells and which regrows | — | timber | timber |
| Quarry | on the mountain | — | stone / gravel | timber, steel |
| Mine | on the mountain | — | ore | timber, steel |
| Oil well | where the island has oil | — | crude oil | steel |
| Cement works | anywhere | stone | cement / concrete | concrete, steel |
| Steelworks | anywhere, coast helps | ore (and coal, or imported) | steel | concrete, steel |
| Refinery | coast helps | crude oil | fuel | concrete, steel |
| Asphalt plant | near the work | gravel, bitumen | asphalt | concrete, steel |

A maker's yard fills and calls for pickup; the nearest depot with room
takes it, or a box to the world when nothing in town wants it. A full yard
stops the line, in sight.

## Later

- Power: the plant, pylons, substations (`roadmap.md` milestone 6).
- Fire station, hospital, police (milestone 7).
- Airport: the fast, dear door.
- Grades of home and of shop: the ladder of wants.

## Goes

- **Office and factory**, once the chains supply the jobs.
- **The port** as built, the depot with a ship of the world's: replaced by
  the ferry harbour and the container port.
- **The edge**, where a road leaves the map: the harbour is the only door.

## Open

1. Whether food stays a farm's crates, or grain goes through a food plant.
2. Where oil is: tiles the island draws, offshore, or only off the boat.
3. Whether the cement works makes concrete for sites, or concrete is mixed
   at the site from cement and gravel (as it is in life, within ninety
   minutes of the plant).
4. Which kinds take which materials, and how much: the rows.
5. Whether the sawmill's forest regrows, and how fast.
