# Shelved

Ideas that were built, played, and set aside. Each entry says what it was,
why it went, what bringing it back would take, and the last commit where
the code lived — so nothing has to be reinvented from memory, and nothing
has to stay in the tree to be remembered.

## The continuous ledger

**What.** `xp.rs`: one number that was both the city's level and the
mayor's money, integrating hours of need served from every resident
standing in a building on a need it had a tap for, continuously, with a
rate for the client to run the dials forward between updates. Placing
cost hours of need served, discounted by the build.

**Why shelved.** Money became its own quantity, in purses, moved by sales
(`economy.md`). Level is still hours served, but banked in lumps as each
visit ends, like everything else; and a dial that steps is an event that
happened on the map, where a dial that glides is a rate.

**To bring back.** `Ledger { settled, since, streams }` with `at`,
`rate`, `settle`, and `resident::served` feeding its streams at every
change of `at` or `selected`. Last lived at `0954125`.

## Purses, floats, the sweep and rent

**What.** `economy.md` §8.2 as first built: every resident had a wallet
and every building a balance, in hours of the edge's wage. A visit's
price left the wallet and landed on the building as a lump; a shift left
the building and landed in the wallet. Every purse kept a float — a
payday of meals for a resident, a day of wages and a full shelf for a
shop — and what was over it swept to the treasury at each income, a
resident's sweep being rent on the home (Schwabe's law). A building
whose purse ran dry stopped buying and hiring (§9); the mayor could fund
it back to its float. `economy::float`, `sweep`, `rent`, `solvent`,
`fund`, `Resident.wallet`, `Building.balance`, `RESIDENT_FLOAT`.

**Why shelved.** The mayor owned every purse, so every internal payment
was a transfer between two purses of one owner, and the treasury could
only ever collect the net flow at the door — which one purse collects
directly. What the forty purses added was floats to size, a sweep to
time, rent to derive, and a solvency rule whose one visible product in a
season was a bar with a full shelf, no money, and nothing to say. The
information a purse seemed to hold was elsewhere: a resident's standing
is their wage, a building's is its books.

**To bring back.** Only if someone in town owns something the mayor does
not — a firm that moved in by itself, a landlord — so that a transfer
between purses changes who has what. Then `wallet` and `balance` on the
structs, `sale` moving money instead of writing lines, and §8.2 as it
was. Last lived at the commit before `economy.md` step 4.

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


## The survey and the fog

**What.** Terrain was revealed in chunks around what a building had
reached (`REVEAL_RADIUS`, `World::revealed`, `newly_revealed`,
`revealed_bounds`), the client drew fog past it (`FogOfWar.ts`) and
clamped the camera to it, a ship's voyage was cut where it entered the
fog, and the road exits stood where a road left the survey. Multiplayer
was to share the survey (`multiplayer.md` §3).

**Why shelved.** Decided 2026-09-23. The fog did two jobs, hiding
terrain and bounding the door, and neither survives the island: the map
is one island seen whole, and the door is the terminal on the coast. With
many players the surveyed land pushed the road door away from a town in
the middle, which is why the sea became the door in the first place; and
a player who can pan anywhere is exploring by looking, which is what the
fog denied.

**To bring back.** `revealed` and `reveal_around` in `world/mod.rs`, the
chunk reveal in the game loop, `FogOfWar.ts` and the camera clamp. Only
if the island is ever bigger than a player should see at once. Last lived
at `df49b81`.

## The generated road network and the road exit

**What.** `road_gen.rs`: anchors in a checkerboard of chunks, the shortest
runs between them with an acute-angle rule, a ring laid past the frontier
so arriving from off the map was a long haul, and the starting town's
streets laid the same way. The `Edge` building stood where a road left the
survey, with every tap and the world's prices; everything the town lacked
was served there (`economy.md` §8.1).

**Why shelved.** Decided 2026-09-23. The first road is the player's, from
the ramp, and a road born with the map was a road the player did not
draw. The road exit was a door that receded as neighbours surveyed past
it; the terminal on the coast does not. "The edge is far by design, the
drive is the price" becomes the sailing and the boat's batch.

**To bring back.** `road_gen::{generate, extend_to, start_town}`,
`World::stand_edges`, `entry_node_near`, `nearest_edge`, the `Edge` kind.
Last lived at `df49b81`.

## Services as a good

**What.** `economy.md` §12.5: services as a need drawn by the day by every
household and a fifth of every firm's labour, made by the office at its
row's rate, delivered by a consultant's car from an office in town or from
beyond the edge, with the office as the town's export base before there
was a port. `Need::Services`, `SERVICES`, `draw`, the office's `makes`,
`CarRole::Company`.

**Why shelved.** Decided 2026-09-23. It was the one good that was not a
load: nothing to stack on a truck, nothing on a shelf, a car that drove
to a house and back. It was the most complex row in the game, the one
whose price rang in §13.23, and it existed to make the household row
balance, which a player could not see. A production game keeps goods
that are loads; the works replaces the office as the export base.

**To bring back.** The office blueprint, `Need::Services` and its stock
on homes and firms, `economy::draw`, `services()`, the fifth on
`worth`, `season_no_harm`'s services report. Last lived at `df49b81`.

## Wear, parts and the workshop

**What.** `economy.md` §12.6: a second per-tile stock on every car, put
right at a workshop that bought parts from beyond the edge or the
warehouse, priced as a service every two and a half tanks.

**Why shelved.** Decided 2026-09-23. A stock on every car and a chain that
fed only itself, there so that a car's running cost matched a referent.
Fuel is enough for a car to want, and a pump is enough to place for it.

**To bring back.** `Need::Wear`, `Bucket::driven`'s second entry, the
workshop blueprint, `resident::drove`'s wear line. Last lived at
`df49b81`.

## Leisure, evenings out and the household budget

**What.** Leisure as a need with bars and restaurants as its taps, an
evening out priced at the world's, and the household row's budget shares
(`TRANSPORT` a sixth, services the balance, sittings and an evening at the
world's price) that made a head's labour worth its inputs over nine
tenths.

**Why shelved.** Decided 2026-09-23. Sinks that were only there to be
sinks. They consumed hours to make the row balance and nobody could watch
them land. People eat and their cars burn fuel; that is what a person
costs, and both are trucks on the road.

**To bring back.** `Need::Leisure`, the bar and restaurant blueprints,
`economy::household` as written, §12.4's row. Last lived at `df49b81`.

## The port's own ship

**What.** `economy.md` §12.10 as built: the port a depot whose lorry is a
ship, sailing from the quay to the map's edge when a shelf ran low and
landing every shelf's worth at the sea's crossing. `CarRole::Ship`,
`World::{set_sail, sail_home, ship_step, moor}`, `calls::dispatch`'s
fetch by ship.

**Why shelved.** Decided 2026-09-23. The ship is the world's, on a
timetable with a batch, and the mayor never owns one. A ship the town
sends when it likes gives the door no size, and the size is what makes
prices move and a works worth building. The quay, the shelves, the vans
and the voyage over the sea all stay; only who owns the boat and when it
sails changes.

**To bring back.** `CallKind::Fetch if economy::ships(row)` and the
reorder point as the ship's trigger. Last lived at `df49b81`.

## The construction firm

**What.** `game.md` as of 2026-09-09: construction as a delivery by a
construction firm's truck, from the edge until the town had one. Never
built; placements paid the door in full at once.

**Why shelved.** Decided 2026-09-23. The site is a buyer with one stock
and the depot is already the builder; a firm whose only product was a
truck was a second depot with a name. Sites are built by whoever the one
protocol sends: the tapped lorry, a depot's van, a lorry off the ferry.

**To bring back.** Nothing to bring; a firm would be a depot that holds
materials, which is a warehouse.

## Haulers

**What.** `economy.md` §3 and §5.3, filed from the start: a company whose
vehicles carry for others at a posted price a load a tile, its stock idle
capacity. Argued again 2026-09-23 for exports by ship and for the site's
deliveries.

**Why shelved.** A second dispatch mechanism, and the first step toward
routing loads by hand, which is the Transport Fever slide. The world's
lorry off the ferry already carries for anyone, and every building's own
vehicle carries its own.

**To bring back.** Only if a call ever exists that no owner's vehicle and
no world's vehicle can answer.

## Taxes

**What.** Argued 2026-09-23: the mayor's purse as a share of every hour of
need served in town, so that every visit paid and the closed town had a
budget. One line in `economy::gdp`.

**Why shelved.** A tax pays the town where the sale happens, so the
tax-maximising strategy is self-sufficiency, every neighbour is a rival
for diners, and the multiplayer island has no reason for towns to need
each other. The door pays the town that sells to others, and that is the
cooperative game. It would also have removed the slump, and the balance
of trade as the score.

**To bring back.** Don't. What it was for, seeing what earns money, is
the per-building net at the door and the terminal's card.

## The trade panel and the charts

**What.** Argued and mocked 2026-09-23, on a Design canvas at
https://claude.ai/artifact/Rdy5vyxzPzkQGPqT81xgxW: a docked panel of
every good's flows; a two-row supply-and-disposition bar; a zero-centred
bar with the overhang as the door; a self-sufficiency ratio to a 100
percent mark; a trade-balance list with a made-here track; and the one
that worked, a diverging bullet chart with the town's own volume as pale
wings behind the traded slice in strong colour.

**Why shelved.** A game needs a chart like that when it has six goods and
three flows each. With three goods and the terminal's card, one line on
the meter says what the chart said. The last chart is kept for the town's
page, on day twenty, drawn once, and as a building's own headline.

**To bring back.** The canvas holds the artboards; the data is
`Town.sold` and `bought` per need plus made and used per good, which the
books already keep.

## The mayor's car, driving, and hand-mining

**What.** Argued 2026-09-23 after the arcade idle games and Factorio: an
avatar that carries and mines; a lorry the player steers; a car that
takes raw goods from terrain tiles.

**Why shelved.** The avatar is a fork in genre: steering, a follow camera,
touch controls, a second way to do what the tap does. What it teaches,
the tapped lorry and the ferry teach. Hand-mining survives without it: the
tapped lorry may take a terrain tile as a source, slowly, which is a
quarry's manual phase.

**To bring back.** Cheapest first: a ride-along camera in any vehicle, no
input. Then, if the itch stays, the wheel on rails: the lorry follows the
lane, the player supplies throttle and the turn at each junction, on the
physics that exists. Never free steering.

## Conveyor belts and hand-wired supply pairs

**What.** Argued 2026-09-23: Factorio's belts between buildings; or
telling each buyer which seller it buys from, like drawing a line in
Transport Fever.

**Why shelved.** A belt is a second transport network that never meets
the road and would win inside industry, and at twelve-metre tiles it is
a conveyor the length of a district. Hand-wired pairs kill the one
protocol: a shorter road would change nothing, prices would decide
nothing, and forty buildings would be hundreds of assignments. Anno's
rule: automatic on the island, explicit only between islands.

**To bring back.** Lines, later, for the few big pipes only: a ship
between two ports on a schedule, a siding from a quarry to a works.
Never the last mile.
