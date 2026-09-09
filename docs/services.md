# Services: what the mayor places, and why

Status: specification, agreed 2026-09-05. §2–4 built the same day (roads
have no speed of their own yet). §5 built for stock: `calls.rs`, the
supermarket and warehouse rows, trucks from beyond the edge or a
warehouse's own, empty shelves drawn grey. Fire, illness, the inspect
panel not yet. §3 was rewritten 2026-09-09 when the spawner went
(`shelved.md`): nothing arrives on its own any more, so all that is left
of that section is where a placed building may land. Follows
`residents.md` (how residents decide), and supersedes the parts of it
that say buildings arrive unconnected for the mayor to road.

---

## 1. The idea

The mayor designs the street network and places every building on it.

The rule that makes one of them worth its price: **a service is a
building whose vehicle answers calls.** Something in the city calls for
it, a vehicle goes, and if the facility has not been built the call is
answered from beyond the edge of the map — slowly, along the mayor's
entry roads. A young city works with none of them. Building one is a
visible relief, and a strategic choice about where.

Six systems carry the whole list. Everything on the list is a row against
them.

## 2. Streets and roads

A road node is a **street** or a **road**. Buildings front streets only:
a driveway is never laid onto a road, and nothing is placed beside one. A
road is faster (its cruise speed is a multiple of a street's; the number
lives on the kind) and drawn wider and darker.

- Drawn with a toggle beside one-way. Default: street.
- `RoadNode { outgoing, incoming, joined, road: bool }` on the wire. The
  server's `road_for_plot` refuses a road; the client's driveway and
  frontage checks read the same flag.
- Unlocked on the roads branch of the tree; until then every road is a
  street.

Later, on the same node: priority (a road has right of way over a street
at a junction), levels (an overpass is a road one level up), and traffic
lights. Combined they give merge lanes, roundabouts and interchanges.
None of it is in scope now; the flag is the seed.

## 3. Placing onto streets

A site is a plot that fronts a **joined street** with a free driveway.
The driveway is laid at placement, and placement refuses a plot with no
street rather than leaving it red — so nothing ever stands unconnected,
and red keeps its one meaning: not joined to the world.

## 4. The build

The tree the client already draws (`SkillTree.tsx`, the map) moves to the
server as the same map, and the player's **build** is the set of nodes
taken. Points come from the level dial; a node may be taken when a
neighbour is taken; the root always is.

The build is the one door every question goes through:

```
may_place(kind)    -> bool     // placement
weight(class)      -> f64      // the discount an avenue puts on its class's price
road_tiles()       -> u32      // drawing; player-laid tiles count, generated do not, demolition refunds
may_draw(road)     -> bool     // road kind, one-way
```

`take(node)` checks adjacency and points and applies the row's effect.
Nothing else reads the tree. This is where the checks live, centrally,
before any mutation.

Effects stay discounts and unlocks. Keystones are a later variant.

## 5. Call-outs

The one mechanic under every service.

- A **call** is raised by something in the city with a kind, a place and
  a time: a resident who needs shopping, a shop low on stock, a resident
  fallen ill, a building on fire.
- A **facility** kind answers calls of a kind with a **vehicle it owns**.
  For stock the caller chooses: every facility with the good and a
  vehicle free is a seller, and the cheapest delivered wins
  (`economy.md` §6.2). For an emergency the nearest with a vehicle free
  answers. If none, the call is answered from **beyond the edge**: a
  vehicle appears at the nearest entry node and drives in. Later,
  "beyond the edge" is another player's city.
- The vehicle drives to the caller, spends the row's service time there,
  and returns. The call resolves with a **consequence scaled by how long
  it took**: a late delivery is an empty shelf, a late ambulance a longer
  illness, a late fire truck a fire that spread.
- **Rounds** are scheduled calls: a shop calling for stock every day, a
  patrol. **Emergencies** are random calls with a rate on the row.

Vehicles are cars owned by buildings, not residents: `Car { owner:
Owner::Resident(id) | Owner::Building(id), role }`. The car simulation is
unchanged; only who dispatches it and the look differ.

Rows, first pass:

| facility | answers | vehicle | consequence of lateness |
|---|---|---|---|
| Gas station | fuel (exists as a need) | none: the car comes to it | the car drives to the edge to fill |
| Supermarket | shopping: a need, residents come to it; stock: calls the warehouse | delivery van, to homes that call | shelves empty, residents' shopping unmet |
| Warehouse | stock, from shops and supermarkets | truck | shops run dry, call the edge instead |
| Hospital | health: a resident's stock, drained by a draw | ambulance | the stock drains longer; at zero the resident dies |
| Fire station | fire: a building's stock, drained by a draw | fire truck | the fire spreads to a neighbour; at zero the building is rubble |
| Police | obedience: a resident's stock; the jail refills it | patrol car | needs the crime to be an event on the map first; last |
| Park | leisure, and a little obedience, with no trip | none | none |

Refinery, port and airport are the same rows at the next scale up: they
answer stock calls from gas stations and warehouses.

## 6. Stocks

The state a call changes is a stock, the one type `economy.md` §4 gives
everything: a level and a cap, drained by use, refilled by a tap or a
delivery. A call is raised when it is low. There is no `Condition` enum.

- **Stock** on a building: drained per visit, refilled by a delivery.
- **Fire** on a building: full until a hazard draw ignites it, draining
  while it burns; the truck stops the drain and refills it; a burning
  neighbour drains it too. At zero the building is rubble, standing
  until the mayor demolishes it. Never a decay on a schedule: a building
  that burns on a countdown is the thing `game.md` rules out.
- **Health** on a resident: full until a draw, then draining; a hospital
  tap refills it, and an ambulance call brings in someone too low to
  drive. Off work while low; at zero, dead. A park tap refills it a
  little, slowly: lifestyle versus illness.
- **Obedience** on a resident, later: drains by a draw; low, the resident
  commits a crime, which is an event on the map with a victim — a shelf
  emptied, a wallet — and a getaway car. A park refills a little; a
  patrol deters; the jail is a tap with a stay, the resident away like a
  lorry beyond the edge.

Services earn nothing; their wages are lines in the books like anyone's,
and the town pays (`economy.md` §8.2). What they save is residents and
buildings.

## 7. Legibility

A service whose effect cannot be seen is not a decision.

- Vehicles look like their job: a van in the shop's colour, a truck, an
  ambulance, a fire truck.
- A building shows its state: a fire is drawn, an empty shelf dims the
  shop, a burned building is dark.
- Click a building: who works here, who is inside, what it served today,
  its stock, its calls answered and how late. All of it exists on the
  server already; this is the panel that reads it.

## 8. The tree

The four avenues stay pure: homes, commerce, industry, roads. Placeables
unlock at the **corners**, where two avenues meet:

- homes × commerce: leisure — restaurant, bar, park unlock there
- commerce × industry: logistics — warehouse, later port
- industry × roads: fuel and energy — gas station, later refinery
- roads × homes: services — hospital, fire station, later police

## 9. Build order

1. Streets and roads, placing onto streets, the build. One piece of
   work: it removes more than it adds (hold, arrival states, edge markers
   for arrivals) and puts the central check in place.
2. Call-outs, once, generic, with the **supermarket** and **warehouse**
   as the first two rows — the daily traffic — and a delivery van look.
3. Stocks with **fire**, since it is the emergency people feel; then
   the hospital.
4. The inspect panel, once there is behaviour worth reading.
5. Police, when there is a crime model to answer.

## 10. What this removes

- The hold while anything is unconnected.
- The arrival pin state, its bounce, and edge markers for arrivals.
- Any building the mayor has to road by hand.
