# The spawner: buildings arrive, the mayor disposes

Status: specification, being built. Elaborates "Who decides what gets
built" in `sprawl-agents.md`; reads the demand signal of `sprawl-needs.md`
§6. Written for review; the build plan is section 8.

---

## 1. Scope

Zoning is obsolete. The player will not paint residential, commercial and
industrial areas; buildings **arrive on their own**, onto the streets the
player has drawn, with their driveway laid, and the player moves them or
demolishes them afterwards. (They arrived as proposals to accept or reject
until 2026-09-04, and unconnected for the mayor to road until 2026-09-05;
see `sprawl-shelved.md` and `sprawl-services.md` §3.) Placeable buildings remain only for
things that do something special. This document specifies how an arrival
is chosen and sited, and what the client shows.
It does not specify pacing beyond one constant, money, or the skill tree.

## 2. Rules carried over

From `sprawl-agents.md`, unchanged:

- **Nothing needs to cause a spawn.** Demand tilts the choice of kind; it
  never gates it. A building that appears participates automatically.
- **An arrival is a building.** It is placed the moment the meter fills
  and a site is found: a plot fronting a street joined to the world, with
  a free driveway, which is laid with it. It is lived in at once. (Until
  2026-09-04 it was a proposal: a pin, a ghost and two buttons; until
  2026-09-05 it arrived anywhere and stood red until roaded. The notes
  below on those are kept for the record.)
- **The street is the price.** Nothing arrives where there is no street,
  so the network the mayor draws is what decides where the city goes.
- **Ambient, never modal.**

## 3. Dormancy

A building may lose its driveway — the mayor demolishes it — and then it
is dormant, drawn red, until a road lands beside it again. Every road laid
attaches driveways to the dormant buildings beside it. Red on the map
means one thing: not joined to the world.

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

Held on the world, persisted, one at a time. Answered:

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
   nothing overlaps, nothing is in water, two runs match. *Done.* What it
   taught: the draw must be seeded on the interval, not on what stands, or
   a draw that finds no room repeats itself forever; and affinity has to
   score the *site*, not just choose the anchor — eight candidates, keep
   the one whose neighbours suit the kind — or a random direction from a
   good anchor lands the factory on the residential street anyway.
3. **Protocol and client.** Proposals streamed; pin overlay; ✓/✗; ghost.
   *Done.* Proposals ride the existing entity stream; the client keeps a
   reactive registry of what carries a pin and projects each one after
   every frame through the orthographic camera — the inverse of
   `pickWorld`, a lerp. Far out, building pins collapse to dots and
   proposals keep asking. Dragging a proposal's pin sends `MoveProposal`.
   What it taught: accepting has to place the building outside the
   answering player's `acting_as`, or it lands as their draft.
4. **Restaurant.** Eat and Leisure, open late, seats twelve. The first
   special kind. *Done.* Staffed like a shop, offered by the spawner as a
   commercial kind tilted by unmet Eat and Leisure, and the one thing left
   in the build menu — placeable buildings are for what does something
   special, and that is now the rule rather than the exception.
5. **Delete zoning** in one stroke: `Category`, `paint_area`, `for_plot`,
   the brush, `KIND_CATEGORY`, `ZONE_*`. *Done*, taken before step 4 so
   the first special kind never had to be threaded through a category.
   The plot tint and its boundary lines went with it — the pin says what
   a building is now — and with them a terrain mesh, a material, and the
   zone bytes the chunk worker carried. Buildings still clear the trees
   beneath them. `PlaceBuilding` stays: it is how special buildings will
   be placed by hand.

Deferred: pacing beyond one constant, money, skill-tree tilts,
supermarket and the pantry stock it needs.
