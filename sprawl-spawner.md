# The spawner: buildings arrive, the mayor disposes

Status: specification, being built. Elaborates "Who decides what gets
built" in `sprawl-agents.md`; reads the demand signal of `sprawl-needs.md`
§6. Written for review; the build plan is section 8.

---

## 1. Scope

Zoning is obsolete. The player will not paint residential, commercial and
industrial areas; buildings arrive on their own as **proposals**, and the
player accepts, rejects or moves them. Placeable buildings remain only for
things that do something special. This document specifies how a proposal
is chosen and sited, what accepting one does, and what the client shows.
It does not specify pacing beyond one constant, money, or the skill tree.

## 2. Rules carried over

From `sprawl-agents.md`, unchanged:

- **Nothing needs to cause a spawn.** Demand tilts the choice of kind; it
  never gates it. A building that appears participates automatically.
- **A proposal is not a world object.** It is a pin, a ghost footprint and
  two buttons. ✓ places the real building; ✗ dismisses it and suppresses
  that kind thereabouts for a while; unanswered, it waits. The queue is
  small and capped; the spawner holds when it is full.
- **The road is the price of yes.** Proposals land where there is no road.
  An accepted building stands **dormant** until the network reaches it;
  the driveway forms itself the moment a road lands adjacent.
- **Ambient, never modal.**

## 3. Dormancy

A building may exist without a driveway. `place_building` puts it on the
map; `attach_driveway` gives it one when a street is adjacent, using the
same plot geometry as today, run at connection time instead of placement
time. Every road laid for real — committed from a draft, or generated —
attaches driveways to the dormant buildings beside it.

What no road serves does not participate: `settle` houses and employs
nobody there, and the candidate search of `sprawl-needs.md` §4 does not
offer it. There is no `dormant` flag; dormancy is `road_node_for_building`
returning none, derived like every other index.

## 4. Choosing a kind

Each kind has a base weight. The weight is multiplied by
`1 + pressure`, where `pressure` is the unmet demand (needs §6) for the
need the kind serves, summed over the city: homes read immigration
pressure, workplaces read the jobless, shops read Eat and Leisure. A
recent ✗ on a kind near the site multiplies by zero. The draw is
weighted; demand tilts, never blocks.

## 5. Siting

A proposal is placed by a three-way draw, with an RNG seeded from
`(terrain_seed, spawn_counter)` so a fixed seed spawns the same city.

1. **Grow a cluster.** Pick an anchor among standing buildings, weighted
   by affinity for the kind: homes near homes; shops near homes; industry
   near industry and away from homes. Place at a distance drawn from
   `[3, 15]` tiles from the anchor, in a random direction.
2. **Seed a cluster.** With probability rising as the city's largest
   cluster grows, place instead `[40, 80]` tiles from everything standing,
   on land. This is what keeps housing from being one blob.
3. **Snap.** Find the nearest buildable footprint to the drawn point.
   Reject water, overlap, and anything closer than a tile to another
   building; reject the whole draw after a few misses and try again next
   tick.

Clusters are not stored. "The largest cluster" is derived by flood-filling
buildings within a few tiles of each other, on request.

## 6. Proposals

```
Proposal { id, kind, pos, size, rotation }
```

Held on the world, persisted, capped at five. Answered individually:

- **Accept** — `place_building` at the proposal's site. Dormant until
  roaded.
- **Reject** — removed; `(kind, pos, until)` recorded so the spawner skips
  that kind within a radius until `until`.
- **Move** — the pin is dragged; the proposal's `pos` changes, re-snapped.

The spawner runs on the game loop: while the queue has room and the base
interval has elapsed, propose. Base interval: one constant.

## 7. The client

Pins are HTML. One element per building and per proposal, positioned each
frame by projecting the world position to the screen; an icon per kind;
proposals carry a ghost footprint on the map and ✓/✗ on the pin. Far out,
pins collapse to dots. Pins are what says what a building *is*; the mesh
stays a neutral block.

## 8. Build plan

1. **Dormant buildings.** Place without a road; driveways attach on road
   commit and on generated roads; settle and candidates skip the unserved.
   Tests. *Done.* `place_building` / `attach_driveway` /
   `attach_driveways_along`; `spawn_building` is the roaded-only wrapper
   painting still uses. A drafted road reaches nothing until it commits.
2. **Spawner and queue.** Kind, siting, cap, accept/reject/move on the
   server, `/debug/proposals`. A harness that runs the street town for
   days and asserts: clusters form, a second cluster eventually appears,
   nothing overlaps, nothing is in water, two runs match.
3. **Protocol and client.** Proposals streamed; pin overlay; ✓/✗; ghost.
4. **Restaurant.** Eat and Leisure, open late, seats twelve. The first
   special kind.
5. **Delete zoning** in one stroke: `Category`, `paint_area`, `for_plot`,
   the brush, `KIND_CATEGORY`, `ZONE_*`.

Deferred: pacing beyond one constant, money, skill-tree tilts,
supermarket and the pantry stock it needs.
