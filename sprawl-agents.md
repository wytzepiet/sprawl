# Sprawl — Who Decides What Moves

Working notes, deliberately unfinished. This is the layer that turns Sprawl from
a traffic generator into a simulation, and everything else leans on it, so it is
worth thinking about properly before it is built.

Companion to `sprawl-guide.md`, which describes the game; this describes the
question the game currently has no answer to.

---

## The problem

Today every building emits a car every 4–8 seconds to a random other building.
It looks like traffic and it is not a simulation: nobody is going anywhere for a
reason. There is no rush hour, no consequence to where a factory was zoned, and
nothing a road layout can be good or bad *at*. Categories, driveways and
capacity all exist to feed this and currently feed nothing.

So: **who decides that a car exists, and why?**

Downstream of that answer is nearly the whole game — congestion that means
something, zoning that matters, the economy, and any reason to redesign a
junction.

## What we think we know

### People, not buildings, generate trips

A resident lives somewhere and works somewhere. Buildings have capacity: a house
holds a couple of people, an apartment more; shops, offices, workshops and
factories offer jobs. People are assigned to the nearest workplace with a free
slot, which is the rule that makes *where* you zone matter.

Residents are deliberately not things on the map — they have no position, they
are the reason a car exists. That also means they cost nothing to stream to
clients.

### Agents decide; buildings only publish

The building's job is to state facts about itself: when its shift starts, when
it is open, what it needs delivered. It never pushes anyone anywhere. The agent
reads those facts and decides.

This matters mostly for what it makes cheap later: a bakery that opens at 05:00
is a building with different hours, not a new mechanism. Adding specialised
buildings should never mean adding scheduling code.

### One wake-up per agent, and it re-decides on waking

The cars already work this way. A car wakes, looks at the world, decides, and
schedules its next wake for the moment something meaningful happens. The queue is
deduplicated per entity, so anything else can pull that wake *earlier* and
supersede it — which is how a braking car makes the one behind reconsider.

Every agent wants exactly that. A fire should yank the fire station's next
decision forward. A demolished road should force a re-plan on everyone routed
over it.

Possible simplification worth weighing: collapse every event into a single
`WakeUp { entity }`, dispatched on what the entity is. Then the event queue is
literally "the things about to think, in the order they will think," and a car
is just an agent whose decision is physics. One dedup rule, one variant.

### Needs are stocks, and a stock tells you when to wake

The tempting way to decide "does this person go shopping" is dice, or a hunger
bar polled every tick. Both are wrong for different reasons — dice give traffic
without consequence, polling costs per-tick work in a simulation that has
carefully avoided it.

A stock with a known depletion rate says exactly when it will hit zero. That is
not something to check; it is a time to schedule a wake for. Closed form, no
ticking — the same trick the cars use to avoid per-frame simulation.

The same loop covers freight: a shop's stock projects to empty, so a delivery is
scheduled to land before it does. A gas station running dry because the nearest
supplier is two days away is that loop failing honestly, and it is a *good*
failure — it tells the player to produce locally or find a neighbour.

Stocks probably belong to households and businesses rather than individuals. One
person does the groceries for a house of four, which is both more true and
several times fewer trips.

### Commitments and needs are different things

- **A commitment has a time**, and the time comes from outside you: a shift, an
  appointment, a bus at 08:15.
- **A need has no time, only an urgency**: food, boredom. It gets served in a
  gap.

Keeping them apart keeps the decision simple. Next wake is the earlier of *the
next commitment* and *the moment a need turns critical*. On waking: if a
commitment is due, honour it; otherwise serve the most pressing need, if it fits
before the next commitment. That last clause is what makes "no time for the
cinema tonight" a real answer rather than a coin flip.

Merging them forces fake times onto the needs and a re-sort every time a stock
moves.

### An agenda is optional, and mostly derivable

Agents *can* hold a plan, and the wake handler can read it. The useful line
seems to be: **store a plan when something other than you depends on it.** A bus
timetable, a booked delivery slot, a shift roster — other parties rely on that
future action, so it has to exist as data before it happens.

Private intentions do not need storing. They can be re-derived at the wake for
free, and then they cannot go stale. A resident who has a job already implies
"be there at that building's shift start, daily" — writing that into an agenda
duplicates it and creates a way for it to dangle when the workplace is
demolished.

So an ordinary resident's agenda is usually empty. Buses and scheduled freight
almost certainly will not be.

### Lateness is the readout

If people leave in time for their shift and congestion makes them late, that is
a direct measurement of a bad network, and it comes free from the same
scheduling. Worth designing towards, because "the city feels congested" needs a
number behind it eventually.

## The scale, which is now fixed

Worth writing down because a lot of the above only makes sense against it.

A **tile is about 12 m**. Not a choice — the physics already fixed it. A car is
0.35 tiles long and a car is about 4.2 m. Two cross-checks agree: a one-tile
road is a 12 m two-way street with pavements, and a 0.5-tile following gap is
6 m. Buildings land sensibly too — a one-tile house is a 12×12 m terraced plot,
a factory on six tiles is about 850 m².

So cruise speed is **65 km/h**, a chunk is **384 m**, and a ten-chunk city is
under 4 km across.

The day was 120 s, which made a 1 km commute take thirteen game hours. It is now
**20 minutes**, so an hour is about 900 m of driving:

- a 500 m commute → ~30 min
- 1 km → ~1 h
- 4 km across a sprawling city → ~4.3 h, which is what earns a highway
- a frontier freight haul → over a day, without tuning anything for it

Twenty minutes is arguably still short. It is workable.

## Where new people come from — less settled

Immigration has to come from *outside*, and "outside" turned out to be harder
than it looks in a shared, unbounded world.

**The map edge does not work.** Distance to the edge varies with where you
spawned and gets worse when neighbours build around you — a cost you cannot plan
around and did not cause.

**The fog does not work either**, for the same reason: revealed land is shared
and monotonic, so a neighbour's growth pushes the frontier arbitrarily far from
you.

Where we landed, tentatively: **source from the nearest place outside your own
city.** Usually that is a neighbour's buildings; for an isolated player it is the
frontier, which is close precisely because it is their own buildings that
revealed it. Nothing materialises out of thin air — a car pulls out of a
driveway, which is what every car here already does.

That inverts the problem. Neighbours crowding in used to push your source of
people further away; now they *are* the source, and density means shorter trips
and more inbound traffic. Cities feed each other.

**Distance as a feature.** Distance to the frontier is really a measure of how
many neighbours you have, so "far from the outside world" and "surrounded by
suppliers" are the same fact — they arrive together with no rule tying them. A
frontier city trades cheaply with off-map and specialises in export. An inland
city faces long hauls but has five cities in reach, so it trades locally. Nobody
is disadvantaged; they are playing different maps because they *are* on
different maps. A station or airport then becomes a real choice — reaching past
your region once the local supply is tapped — rather than a patch for a broken
rule.

Long hauls should be genuinely driven. Event-driven cost scales with
interactions, not distance, so a truck on an empty highway is the cheapest car in
the world. The thing to watch is *volume* — how many trucks one delivery is —
and that is a goods-granularity question for later.

## Who decides what gets built — the sibling question

Settled in direction, unbuilt. The question above was "who decides that a car
exists"; this one is "who decides that a building does", and the answer turned
out to have the same shape: not the player, and not dice — demand.

### Zones were a proxy for demand

Painting a commercial zone is the player telling the game where commerce is
needed, because the game could not know. Once households measurably drive too
far for groceries and shops measurably run out of stock, the game *does* know,
and the proxy is redundant. So: **the game proposes buildings, the player
disposes.** Generic buildings — homes, shops, a little restaurant — appear as
proposals driven by observed demand. The player accepts, rejects, or moves
them, and being the mayor is the game: the city keeps happening, and you deal
with it, rather than authoring every square inch and waiting.

This also just *starts* the game. Draw a road into the wilderness and the
first proposal pops; accepted homes attract immigrants; residents create
shopping demand; shops create freight demand. One exogenous pressure — people
wanting to move in — ignites the chain, and from there the loop feeds itself.
There is always a new thing to deal with, which is where the pull comes from.

### The rules that keep it honest

- **Existence from demand, siting from chance.** *Whether* a building spawns
  is demand — homes because people want in, shops because households drive
  too far — and the UI must be able to show that cause, or it does not
  spawn. *Where* it lands is legitimately stochastic: cluster affinity,
  jittered placement, the occasional new seed striking out somewhere fresh.
  Randomness in placement is the texture that makes a city look grown;
  randomness in existence is a slot machine. This is the doc's old open
  question answered: dice belong in siting, nowhere else.
- **Connecting the road is accepting.** A spawn appears as a ghost — a pin
  and a footprint, dormant, housing nobody, off-road as often as not. Draw a
  road to it and it becomes real; ignore it and it eventually gives up and
  fades. The approval mechanic and the core verb of the game are the same
  gesture, and no accept/reject buttons exist. Moving a spawn is dragging
  its pin before it is connected — priced, once money exists, so organic
  placement stays the incentivised default.
- **Dormant is the new draft.** A ghost building reserves nothing firmly and
  houses nobody, exactly like a draft; settle already ignores what has no
  address. The driveway forms itself the moment a road lands adjacent — the
  same machinery that validates plots today, run at connection time instead
  of placement time.
- **Ambient, never modal.** A pop, a soft edge-arrow that tracks while
  panning, and then the ghost waits. Response on the player's rhythm, or the
  game becomes an inbox. Letting one fade *is* rejecting it, and fading
  suppresses that kind-in-that-area for a while.
- **Connecting must be able to be wrong.** Rush a road to the supermarket
  ghost beside the congested corner and you bought a jam; drag it two blocks
  and you bought longer shopping trips. Every spawn type has to pass this
  test: siting is a traffic decision, because traffic is the game.

### What the player still authors

- **Roads, reactively.** The network is the player's entire medium: growth
  proposes, roads dispose. Speculative road-drawing is nothing to rely on —
  the game comes to you, and you answer with infrastructure. (This is the
  Mini Motorways loop, worth naming: the difference to protect is that our
  spawns have people, stocks and consequences behind them, so the city stays
  a place rather than a puzzle.)
- **Pivotal buildings.** Harbor, oil field, stadium — placed deliberately,
  because those moments should feel authored.
- **The skill tree steers the vocabulary and the odds.** Unlocking
  supermarkets teaches the spawner a new word; a point in "recreational
  homes spawn more" tilts the mix. Each building is just a building — the
  Residential/Commercial/Industrial trichotomy only ever existed to label
  zones, and it dies with them. Kinds already carry their own facts
  (`homes()`, `jobs()`, `hours()`); skill points get to touch any of them.

### Presentation that carries the meaning

- **Every building gets a map pin** saying what it is — the legibility layer
  zones used to provide, in the Google-Maps grammar the game already speaks.
  Pins collapse to dots as you zoom out, importance-weighted: the restaurant
  outlives the houses. A ghost's pin is how a spawn announces itself.
- **Plots contain their own parking.** A building's footprint includes its
  lot; nobody draws parking. The parked cars already rendering at buildings
  get real spots instead of jitter, and a full stadium lot reads from orbit.

### Consequences we get for free

- **The grid-city problem dissolves.** Grids happen because the player is the
  placement optimizer, and humans optimizing placement converge on rectangles.
  With the world proposing and the player judging, the city becomes a history
  of reactions — which is what real cities look like.
- **Clustering should be earned, not hardcoded.** Demand-siting already puts
  shops where trips concentrate, which is near other shops. Start with no
  adjacency rules and see how much district structure emerges; add a cheap
  nuisance signal only when homes start proposing next to the factory.
- **Zones may return as automation.** At scale, hand-approving becomes a
  chore, and the fix is standing approval — "auto-accept residential here" —
  which is zoning reinvented as an *optional policy the player draws after
  the city taught them what it wants*. Automate last; do not build it until
  approval fatigue is real.

### Open, for this half

- Pacing: spawns per hour that feels alive but not needy, and how long a
  ghost waits before giving up.
- Clustering: start with demand-siting plus affinity jitter and *no*
  adjacency rules; add a nuisance signal only when homes start ghosting in
  next to the factory.
- Shared world: a spawn belongs to whoever's demand produced it, probably by
  proximity — a neighbour must not connect a building into your street.
- When the zone-painting code dies: after the spawner proves itself on one
  building kind, in one stroke — categories and all — not half-supported
  alongside.

## Open questions

- **How much of daily life is worth modelling?** Work alone gives a rush hour.
  Shopping gives midday traffic and ties commercial zoning to something. Leisure
  gives evening traffic. Each one should have to earn itself against traffic you
  can actually watch — but the shape should not have to change to admit them.
- **Where does urgency come from?** A stock gives a hard deadline. Boredom does
  not. Is there a principled way to score a want, or is that where randomness
  legitimately belongs?
- **How do the non-resident agents fit?** Freight is stock-driven and probably
  carries a real agenda. Police and fire are purely reactive — woken by an
  incident, which is what dedup preemption is for. Buses are neither: a
  timetable other agents depend on.
- **What is the smallest version that produces a recognisable rush hour?** That
  is the first thing worth looking at, and the milestone that tells us the model
  is right: a small town, two routes, watched at 08:00 at 20×.
- **Does one entity mean one agent?** A household might be a better decision
  unit than a person for some things (groceries) and worse for others (commuting).

## State of the code

The first half of these notes is built and committed; the rush-hour milestone
exists and can be watched on seed 7:

- The event queue holds bare entity ids — the things about to think, in the
  order they will think — dispatched on what the entity is. The `to_work`
  boolean and the global peaks were discarded before ever being committed;
  state lives in the world, never in events.
- Residents commute because their workplace's hours say so, staggered by
  building kind. On any wake they re-derive where they should be; arrival at
  work prints lateness against the shift and time lost against the free-flow
  eta fixed at departure.
- Cars are permanent possessions (`Car { owner, trip: Option<Trip> }`),
  issued by settle, parked at buildings between trips, persistent across
  restarts, coloured and spotted by id hash on the client.
- Immigration works as designed above: residents start off-map and drive in
  from past the frontier, car and all, trickled over hours by a hash of who
  they are.

Next, in order — reshuffled because home spawns need only immigration
pressure, which already exists, so the mayor loop is playable before any
economy is:

1. Dormant buildings, the home spawner, and pins — ghosts appear, a road
   connects them, settle and the commute do the rest.
2. The household pantry and shopping trips — the demand data that lets shops
   and restaurants start ghosting in.
3. Freight to restock the shops — the first building that thinks.
