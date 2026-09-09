# Shelved

Ideas that were built, played, and set aside. Each entry says what it was,
why it went, what bringing it back would take, and the last commit where
the code lived — so nothing has to be reinvented from memory, and nothing
has to stay in the tree to be remembered.

## Zoning

**What.** The player painted residential, commercial and industrial areas
(`paint_area`, `Category`, `for_plot`), and buildings of the right kind
filled them in. `2f86374 Paint an area and get buildings`.

**Why shelved.** Painting is a decision the player makes blind, before
anything exists to react to, and it made the map a colouring exercise.
Demand-driven spawning replaced it and is shelved in its turn below; what
survives both is that the road network is the thing the player designs.

**To bring back.** Only as an optional policy drawn *after* the fact —
"no industry here" — as `archive/agents.md` already suggests. Last lived at
`7ded07b` (removed in `7ded07b The city proposes buildings`).

## Proposals

**What.** The spawner offered a building as a pin with a ghost footprint
and two buttons; the player accepted, rejected or dragged it. Rejection
kept that kind away from the spot for a day. `7ded07b The city proposes
buildings` through `dd53fbe`.

**Why shelved.** A question every few minutes is decision fatigue without
skill: the offered spot was the city's, and once the pin could be dragged
for free the spot meant nothing. Buildings now simply appear where the
city wants them, and the player deals with them afterwards — road them,
move them at a cost, or demolish them at a cost — which is a decision made
with something to look at.

**To bring back.** `GameObject::Proposal`, `spawner::{propose, answer,
relocate, snap}`, the pin's answer buttons in `PinLayer.tsx`. Last lived
at `dd53fbe`.

## Automatic growth: the spawner

**What.** Buildings arrived on their own. A meter filled with the hours of
need the city served; when it topped up, `spawner.rs` drew a kind by its
class weight and the demand pressure around each cluster, found a plot
fronting a joined street, and put the building there with its driveway
laid. Zoning and proposals above were its two earlier faces. `8dfe903 The
spawner is gone: every building is the mayor's to place and pay for`;
`spawner.md` is in `archive/`.

**Why shelved.** A town that grew while you looked away was never yours.
The meter was the game's whole pacing and the player could not touch it,
and what arrived was the draw's opinion rather than a decision — so the
only verbs left were road it, move it, demolish it, three ways of tidying
up after the city. Every kind stands on the build menu now, priced in
hours of need served against a balance the city earns, and saving for the
next thing and putting it down is the loop (`game.md` §Buildings). The
demand readout that fed the draw feeds the player instead.

**To bring back.** `server/src/spawner.rs` with its goal, draw, clusters
and pressure, and its call in the game loop. The class weight the tree's
avenues spend on price today (`xp::price`) would go back to being the
draw's odds. One thing the price table lost with it: an offer got dearer
as the city filled out (`EARN_PER_BUILDING`), which is what kept growth
from running away with itself — fixed prices need money to do that job.
Last lived at `8f86867`.

## Build mode: drafts, commit, discard

**What.** Roads and hand-placed buildings were drafts — world objects
invisible to traffic and settle — until the player committed them, and a
demolition was staged the same way, so a whole rerouting could be drawn
and then made real in one stroke. `7ec436a Build into a draft, and commit
or discard it`, `c545e9e Let an artery be rerouted and built over in one
commit`.

**Why shelved.** It was there so a change of mind cost nothing, and it
made every road a two-step act that players did not find intuitive. With
building free and demolition priced, the second step buys nothing; and
the draft's "now" and "after" worlds, four translucent looks and the
toolbar were most of the client's build code. Red on the map now means
one thing: not connected.

**To bring back.** `Draft`, `World::{drafts, acting_as, commit_drafts,
discard_drafts, erase_draft, draft_remove, is_going_away}`, the
`now`/`after` split in `road_node_at`, `draftLook.ts`, `BuildModeToolbar`.
Also the multiplayer claim it gave: an unfinished draft reserved its land
for its owner. Last lived at `dd53fbe`.

## Pedestrians, transit, walkability

**What.** People on the map: walkers on sidewalks, buses and trams with
drawn routes, walking to the shop next door, park-and-walk from lots you
could draw anywhere. Argued through on 2026-09-06; a client-only look
(`client/src/engine/Walkers.tsx`, press P) showed a person reads fine as
a dot at build zoom.

**Why shelved.** The game's rule is that everything that happens is a
vehicle you can watch, and its problem is traffic. People between
vehicles need a mode-choice model and drawing tools for routes, which is
transit planning, a different game, and the decision fatigue proposals
had. The one version worth keeping is invisible: people do not drive to a
shop next door. That is a rule with no tool, and can be added any time.

**To bring back.** Walkers as constant-speed trips over the road graph
(a car with the physics removed), trips with legs, crossings as a cost to
the walker and roads as walls. `game.md` says nobody walks.

## Water, sewage, garbage, and other pipes

**What.** Utility networks under the city, as in Cities Skylines.

**Why shelved.** A resource earns its place if it moves on the roads.
Water does not; it would be a second invisible grid with a bill. Power
stays because coal arrives by truck and the plant's reach runs along the
roads (`game.md`). Garbage is one link with nothing to refine or sell.

**To bring back.** Only as a placeable with a reach, like a substation,
for the silhouette — never as a network.

## Passenger rail and transit

**What.** Trains, buses, trams carrying people inside the city.

**Why shelved.** Between cities things move by ship, train and plane;
inside the city, by car. A person who arrives by train gets a car at the
station, the way an immigrant gets one at the edge. Transit inside the
city is the pedestrian question again.

**To bring back.** Stations as doors first (arrivals with a car), which
costs nothing new; anything more is the entry above.

