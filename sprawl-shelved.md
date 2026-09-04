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
Demand-driven spawning (`sprawl-spawner.md` §1) puts buildings where they
want to be and lets the road network be the thing the player designs.

**To bring back.** Only as an optional policy drawn *after* the fact —
"no industry here" — as `sprawl-agents.md` already suggests. Last lived at
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
