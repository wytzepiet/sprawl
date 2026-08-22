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

### Stocks are for businesses; residents just have an interval

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

**But a stock only earns itself where the depletion rate varies.** A shop drains
at customer rate, which swings hard, so a shop needs one. A household's grocery
cadence barely moves, so "next visit = now + my interval" gives the identical
deadline with none of the state. So: stocks for businesses, a plain interval for
residents. That is a net deletion, and it means the resident side needs no
per-person meter at all.

The interval wants per-resident jitter, seeded from the resident id so it is
stable across reconnects — otherwise the whole city shops on the same day.

### One entry shape, and five numbers

The earlier position here was that commitments and needs are different kinds of
thing and should stay apart. They are not: one shape covers both, and covers
more besides. Splitting them by shape made the behaviour on a miss *implicit in
the shape*, which sounds cleaner but is strictly less expressive — it has no way
to say "this keeps getting more urgent until it happens."

An entry carries five things:

- **start** and **end** — the window in which arriving is still worth it. Not
  when you are expected: that is derived. `end` is usually not an entry fact
  at all but the destination's closing time, already known from `hours()`;
  only genuinely appointment-like entries carry their own.
- **duration** — how long the thing takes once it has begun.
- **where** — a specific building, chosen when the entry is booked. Store the
  building, not a rule like "nearest food place": people go to the same shop,
  and repetition is what makes congestion legible. Re-resolving "nearest"
  every trip would smear traffic into noise. Re-resolve only when the stored
  one is gone, which is what settle already does for jobs.
- **priority** — what wins a conflict.
- **on-miss** — *drop* (the showing has passed, it is gone) or *rebook flat*
  (groceries — go tomorrow, no more urgent than usual). A third rung, *rebook
  climbing*, where priority rises each time until it happens, is the obvious
  extension for freight deadlines and would give the honest failure the
  readout wants — an entry that keeps escalating and never resolves is a
  broken network saying so. Build it when freight exists, not before.

**Everything else is arithmetic on those.** No type tag, no planned-versus-todo
distinction, no fixed-end-versus-fixed-duration flag — the numbers already say
it:

```
slack   = (end − start) − duration
leave   = min(max(arrival, start) + duration, end)
on time = arrival ≤ end − duration
late by = max(0, arrival − (end − duration))
```

- **Slack is rigidity.** Zero slack is an appointment: a shift is 8:00→17:00
  with a nine-hour duration, so there is exactly one on-time arrival. Large
  slack is a to-do: groceries are 17:45→22:00 for twenty minutes, and any
  moment inside works. Everything real sits somewhere on that line — the
  dentist at threeish, picking someone up before six — which is why it should
  be a continuum and not two types.
- **The clock starts when the window opens, not when you arrive.** Otherwise
  turning up early ends your shift early. Arriving early means waiting.
- **Lateness is spent slack**, which is why no "expected at" field is needed.
  Rolling into the shop at 21:00 is not late; rolling into a shift at 8:30 is
  thirty minutes late.
- **Slack also decides whether a partial visit counts.** Zero-slack entries
  mean *be there until it is over*, so arriving at 16:00 gets you one hour of
  work and twenty minutes into the film gets you the rest of it — truncation
  is the point. Slack-positive entries are a thing that takes as long as it
  takes, and arriving too late to fit it is a failure rather than a short
  visit: half a haircut and half an unloaded truck do not exist. That counts
  as missed, and the ladder takes it from there.
- **You do not go if you cannot finish.** Feasibility is `arrival + duration ≤
  end`, so the walk stops offering groceries after 21:40. Arriving too late
  only happens when traffic made it happen — which makes it a good signal, not
  a nuisance: the network just ate someone's errand.

Priority plus on-miss between them also settle conflicts, which is why there is
no property for that either. What loses is decided by priority; what happens to
the loser is decided by its own ladder. Groceries lose to a shift, rebook flat,
done. A delivery deadline loses once, climbs, wins tomorrow.

Nothing ever *moves*. Moving an entry and missing-then-rebooking it reach the
same outcome, but moving is predicted and rebooking is observed — and the
prediction rests on future positions and future traffic, which are precisely the
things that cannot be known. So there is no cascade to resolve, because nothing
pushes anything. A wide window makes the question moot anyway: an entry that
never named a time cannot be displaced from it.

**Preconditions belong to the journey, not the agenda.** Running out of fuel
does not displace the shopping trip — you stop at the station on the way. At the
wake where the drive is decided, an empty tank simply makes the station the
immediate destination. The test: if something is a prerequisite of *moving*, it
belongs in the journey; only things worth travelling for on their own become
entries.

### One agenda, and nothing outside it

Every resident action is an agenda entry. Not most — all. A shift is an entry,
the weekly shop is an entry, a delivery run is an entry, an ambulance dispatch
is an entry someone else wrote. The wake handler walks the agenda, takes the
highest-priority live entry, drives there, and sleeps until that entry's
boundary. There is no second path and no per-kind branch in the handler: adding
a behaviour means adding something that *writes* an entry, never editing the
thing that reads them.

That is the whole extension point, and it is worth stating as a test: if a new
behaviour cannot be expressed as an entry someone writes, the shape is wrong.
Dispatch passes — an emergency is an outside party putting a one-off on your
calendar. Freight passes — a depot proposes a run, and the driver accepting it
is the same grammar as the player accepting a building, one level down.

**Entries are booked, never chained.** A resident leaving the shop books the
next shop — but derived from a durable fact about them (their grocery interval,
their job), never from the entry that just completed. That distinction is the
whole robustness argument: a chain breaks permanently the first time a trip
fails, a resident is stranded, or a load lands mid-drive, and the resident
silently stops shopping forever with nothing in the world explaining why.

So the healing rule is not a repair path, it is the ordinary path: **a resident
with a live need and nothing on the agenda for it books one.** That is the same
code that runs when they first move in. Nothing has to detect that a chain
broke, because there is no chain.

Booking is the one *write* in a loop that is otherwise all reads, which makes it
the one place a duplicate wake can do damage — wake twice, book two grocery
trips. The guard is the healing rule itself: book only when no entry for that
need exists. Worth noticing that the repair and the guard are the same predicate,
because that is the only reason the write is safe.

**Decide from where you are, never from where you will be.** At a wake, `at` is
a fact — the previous entry already happened or already did not, and reality has
resolved it. So travel time is measured from the current position to a candidate
destination, and the entry before is never consulted. Everything awkward about
scheduling dissolves here: inserting an entry between two others costs nothing
because nothing downstream was stored; there is no cascade because there is no
chain; and "not enough time" is discovered at the wake rather than at the
booking, which is correct anyway, since whether it fits depends on traffic that
has not happened yet.

The next wake is then just the earliest departure across live entries —
`min(start − estimated travel from here)`, with the estimate coming from the
segment table below.

**The whole wake is one loop, and home is just the last entry.**

```
on wake(at, now):
    if riding: return                          // the arrival wakes us
    for entry in agenda + [home], priority desc:
        if not live(entry, now):        continue
        if not feasible(at, entry):     continue   // arrive in time to finish
        if breaks a higher-priority entry: continue
        drive(at -> entry.where); return
    sleep until the earliest departure across entries
```

An entry that could interrupt a drive in progress — an emergency recall — is
the one thing that would break `if riding: return`, and it wants its own think.
Later.

Home is not a fallback rule, it is the lowest-priority always-live entry, and it
passes the same checks as everything else. Idling is what happens when nothing
passes — falling off the end of the loop rather than a waiting behaviour.

That last check is the one step of lookahead, and it is where **priority does
its second job**: does taking this make me miss a *higher-priority* entry I
could otherwise still make? Only *strictly* higher. If the thing coming up
matters less than the shop, go shopping and let its own ladder deal with it —
and on equal priority, do the thing you can do now: neither dominates, so the
certain errand beats the speculative one, and residents idle less. The
onward-travel term is measured from the candidate's destination, not from home,
so the check matches the route people actually take. No solver, no stored
timeline, no re-planning pass.

If a resident's day ever needs *showing* — an inspector panel, say — project it
by running that greedy walk forward under free-flow assumptions. A derived
timeline, never a stored one.

**Booking is where travel time enters.** The wake stays greedy and memoryless,
but the *booking* has to account for the journey or it will book things that can
never be made — and then the on-miss ladder rebooks them, forever, with nothing
in the world explaining why. Two rules prevent it:

- **Book into a gap, not at a point — and the window *is* the gap.** A flexible
  entry is placed in a gap in the standing commitments — the shift, mainly —
  wide enough for `travel there + duration + travel onward`, and its window
  runs the length of that gap. Starting it at some later arbitrary hour makes
  a worker drive home at 17:00 and back out past the shop at 17:35; with the
  window opening when the shift ends, they go straight there like a person.
  Only the stable skeleton is consulted, never other flexible entries, so
  there is still no chaining and no cascade. It is a feasibility check, not a
  solve, over a handful of entries.
- **Make flexible windows wide.** Groceries are not "18:00", they are "between
  17:45 and 22:00". A window that wide is immune to estimation error, which is
  the real answer to travel times being uncertain: you do not need precision
  when you have slack. Window width is how an entry says how flexible it is,
  and only genuinely rigid things get narrow ones.

If no gap is wide enough, do not book it. A resident whose commute eats their
whole evening genuinely does not shop today — a real consequence of a badly laid
out city, and the honest version of what would otherwise be an invisible loop.

Destination choice is filtered the same way: pick a supermarket you can actually
reach in the gap you have. settle already picks the nearest job with room; add
"reachable in time" and a too-far job simply does not get taken, which is the
city saying something worth hearing.

This supersedes the earlier position that private intentions should stay
underivable and unstored. The dangling worry that motivated it was right, and it
is answered better here: entries dangle when they are chained off each other,
not when they are stored. Rebuild an entry from the fact that justifies it — a
job, a stock — and demolishing the workplace simply stops the entry being
rebuilt.

### Estimating a trip before making it

Agents have to know how long a journey takes before they take it — to time a
departure, to check an entry is feasible, and to choose a route. All three want
the same number, so they should share one.

**One cost function: the average of free-flow time and observed passage time.**
Free-flow is length ÷ speed limit; observed is what cars actually took. Halving
between them means a genuinely fast road stays attractive even when busy, which
is both realistic and what stops traffic flip-flopping. It also composes — an
average per segment summed along a path equals the average over the whole trip —
so the A* can cost segment by segment without the arithmetic drifting.

Because the route's cost *is* the arrival estimate, routing and ETA are one
computation. Nothing needs to remember how long its own last trip took.

- **Contract the road graph into segments.** A segment ends wherever another
  road meets it, so that **nothing enters or leaves except at the ends** —
  which is the measurement claim, and the load-bearing one. A tile-edge is
  crossed in about a second and its average is noise; a segment's average
  means one thing precisely because every traversal covers all of it.

  For *pathfinding* alone a leaner rule exists — split only where a driver has
  a choice, which with one-way roads means out-degree, so a merge would not
  split anything. It is rejected because it breaks the measurement from the
  other side: traffic joining partway along means some traversals cover only
  part of the run. It would also be *directional* — one segment northbound,
  two southbound — so there would be two contractions to maintain instead of
  one. The cost of the stricter rule is a few extra pass-through nodes in the
  search, which is nothing next to having gone from ~10⁵ tiles to a few
  thousand junctions.

  Splitting on undirected neighbour count means one-way roads need no special
  handling: a one-way pair is one arm, and a divided highway simply comes out
  as two segments. Contraction is maintained locally — an edit throws away the
  segments touching it and rebuilds just those, since enumerating the split,
  merge and extend cases by hand is where the bugs would live. It also makes A* a search over a few thousand junctions rather than
  ~10⁵ tiles, which is what makes recomputing a route every trip affordable.
- **Directional from day one.** One average per direction, never merged. The
  graph is already directed; collapsing the pair now would make the inbound
  jam unrecoverable later, and no rendering could bring it back.
- **Measure entry-to-entry** — from entering a segment to entering the next,
  not to reaching the end. That folds the junction wait into the number, so
  queueing at lights is captured without modelling intersections separately.
  Refine to per-(segment, exit) only if left turns prove to differ enough.
- **Twenty-four bins per direction, shrunk toward a prior.** Never read a bin
  raw: `est = (n·mean + k·prior) / (n + k)`. Zero samples gives exactly the
  prior, and confidence grows smoothly with evidence, so there is no "do we
  have enough data yet" branch anywhere. The prior is a hierarchy — bin →
  segment's all-day mean → `free_flow × city_curve(hour)`, where the city
  curve is one 24-slot table of map-wide congestion. That last term is what
  makes a road built this morning already expect to be slow at eight, which
  is exactly where the player most wants a sane answer.
- **Spread each sample across neighbouring bins with a triangular kernel**,
  wrapping at midnight. Smoothing at write time keeps reads to one lookup,
  makes the curve continuous by construction, and fills sparse bins from
  their neighbours — a segment only ever driven at 8am still answers sensibly
  for 9am.
- **Keep the mean an EMA with the sample count capped** around twenty.
  Otherwise a segment converges after a thousand samples and then ignores the
  bypass you built. The cap is what keeps it a memory rather than a monument.
- **Recontraction inherits.** Rebuilding segments at commit would otherwise
  throw the history away, and roads change often enough to sting. Seed each
  new segment from the length-weighted average of the old segments covering
  its tiles, with the count halved to mark lower confidence; the shrinkage
  formula then does the right thing on its own.

Storage is a mean and a count per bin per direction — a few hundred bytes per
segment. Per-tile it would have been a table nobody wants to save, which is why
time-of-day averaging is only affordable *because* of the contraction.

**Build two of these, not seven.** Ship the per-segment, per-direction observed
average blended with free-flow — flat, no bins — and stop. Each remaining
mechanism has a symptom that will ask for it, and none of those symptoms exists
yet: add bins when rush hour is visibly mistimed, the kernel when bins come out
sparse, the city curve when newly built roads plan badly, inheritance when
recontraction visibly resets a busy corridor. The design is worth having written
down; building it all now is speculative complexity of exactly the kind this
project deletes.

### Routes are recomputed, never inherited

Traffic must visibly adapt when the player changes the roads. That rules out
habit — an agent that keeps its old route because it is used to it silently
launders your improvements, and the bypass you just built appears to do nothing.

So routes are recomputed per trip. Caching is allowed only as a pure
optimisation: store the route against a global road epoch, and when the epoch
changes, **recompute rather than revalidate.** Checking "is my old path still
intact" would keep a route that is no longer the best one, which is habit
smuggled back in. Intact is not the question; optimal is. Store the junction
node ids rather than segment ids, since segments are recontracted on every
commit and their ids churn.

The oscillation that habit was patching is better handled two ways: the
free-flow average already stops congestion from fully deciding a route, and
**the weighting is jittered per agent** — some drivers bail at the first queue,
some stubbornly take the fast road anyway. Seeded per resident, so it is stable.
Agents then stop switching in unison, which is what makes oscillation visible,
and unlike habit it hides nothing: everyone still recomputes from scratch, so a
new road is found by everyone at once.

**Eager rerouting only for cars in flight.** They are few, and `EdgeSegment`
already holds them, so "who was driving over what you just demolished" needs no
new index. A sleeping resident with a stale estimate simply wakes at the old
time, recomputes, and arrives late once — then the averages absorb it. The
correction path already exists, so a reverse index from roads to agendas would
be redundant state.

### Lateness is the shock, commute time is the chronic

If people leave in time for their shift and congestion makes them late, that is
a direct measurement of a bad network, and it comes free from the same
scheduling.

But once departures are timed on observed data, residents adapt, and lateness
decays back toward zero. That is not the readout failing — it splits into two
instruments, and the pair is better than the original:

- **Lateness is the shock instrument.** People are late when something
  *changed* — a new jam, a road rerouted under them. It spikes and decays. That
  is exactly the thing worth alerting on.
- **Commute time is the chronic instrument.** Adapting is not free: leaving
  twenty minutes earlier every day means residents spend their lives driving.
  That is a standing cost, and it is the number that still says "this city is
  badly laid out" long after lateness has settled.

Estimation error surfaces where it should, too. A flexible entry booked as a
wide window absorbs a bad estimate silently; a shift or a showing is narrow, and
those are precisely the entries where being late *should* be visible.

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

- **Nothing needs to cause a spawn.** Supply creates demand as often as it
  answers it; a building just appears, and the decide functions see it —
  the trips follow on their own, because everything that exists here
  participates. Some spawns matter visibly, some are just another house,
  and that is fine. Spawning is a pacing instrument the designer owns:
  base rates, cluster affinity, jittered siting, the occasional fresh
  seed, skill-tree tilts — with demand-weighting available as one tuning
  input, never as a gate the economy must open first.
- **A ✓ and an ✗ over the ghost.** A spawn appears as a proposal — a pin, a
  ghost footprint, and two buttons. Not a world object and not a draft:
  drafts have a batch lifecycle that resolves with their owner's commit,
  and a proposal needs an individual, immediate answer. ✓ places the real
  building; ✗ dismisses it and suppresses that kind thereabouts for a
  while; unanswered, it simply waits in the queue. Moving one is dragging
  its pin before answering — priced, once money exists, so organic
  placement stays the incentivised default.
- **The road is the price of yes.** Proposals land where there is no road
  yet — that is the point, not a phase to reach later. Saying yes obligates
  you to run a road out there, which costs space, costs a detour for
  everyone already using that junction, and commits the city's shape in a
  direction. Saying no costs nothing but growth not taken. That is what
  makes ✗ a real answer before money exists, and it is what de-grids the
  city: the building lands first and the road comes to it, which is a
  desire line, which is how organic cities actually form. Money later
  formalises the price and buys an instant re-siting; it should not be the
  first answer, because infrastructure is already a currency.
- **Accepting and roading are separate decisions.** An accepted building
  stands dormant, pin waiting, until the network reaches it — settle simply
  skips what no road serves. The driveway forms itself the moment a road
  lands adjacent: the same machinery that validates plots today, run at
  connection time instead of placement time. Requiring the road *before*
  answering would collapse two decisions into one and make the proposal
  modal, which is the failure this section keeps guarding against.
- **Ambient, never modal.** A pop, a soft edge-arrow that tracks while
  panning, and then the proposal waits. Response on the player's rhythm, or
  the game becomes an inbox.
- **Pending proposals cap at a handful, and that is the whole pacing
  model.** The spawner holds once the queue is full, so proposals never
  expire — an ignored one just occupies a slot, which pauses growth, which
  is a legitimate choice. In a shared world this makes presence the
  progression currency: a city keeps *running* while its player is away —
  commutes, deliveries, roads carrying neighbours' traffic — but only
  *grows* while someone is there to judge. Coming back means a few waiting
  decisions, five minutes of mayoring, growth resumed. The guardrail:
  absence only ever costs growth not taken, never anything you had —
  nothing expires, nothing decays, nobody touches your street. Foregone
  growth is the whole price.
- **Accepting must be able to be wrong.** Take the supermarket beside the
  congested corner and you bought a jam; drag it two blocks and you bought
  longer shopping trips. Every spawn type has to pass this test: siting is
  a traffic decision, because traffic is the game.

### Connected, or dormant

Off-road spawning creates two states the player has never had to see before: a
building with no driveway, and a road network that joins nothing. They should
not become two concepts with two visual treatments and two explanations. They
are one question — **is your component the live one?**

**Local, not recomputed.** The first instinct was a flood fill per commit, on
the precedent `settle` sets. That is wrong here: a shared world is edited
constantly and from everywhere, so the cost of an edit has to depend on the edit
and not on the size of the city. Both operations are bounded by the *smaller*
piece involved — joining two networks relabels the smaller one, and cutting one
walks outward from both sides of the cut in step, stopping the moment either
side closes, so a stub breaking off a trunk road costs the stub.

`edges` is the one gate the committed road graph passes through, so the index
hangs off `insert_edge`/`remove_edge` and nothing that lays or pulls up a road
has to know it exists. It is undirected: a one-way pair is still one piece of
city, and every question it answers is about the network rather than about a
direction of travel.

The root is the map entry — where immigrants drive in from. An island network is
one nobody can drive into, so nothing on it can work, so it is grey. The rule
explains itself, which is the test.

**Show it, never prevent it.** A disconnected road commits fine and draws grey,
same as the dormant building it may be reaching towards. Building ahead and
joining up later stays possible, and road-drawing stays non-modal.

This also has to land *before* off-road spawning, for a reason that is not
cosmetic: `find_path` only returns `None` after exhausting the reachable set, so
a stranded resident retrying every ten seconds is an exhaustive A* over their
whole component, forever. Comparing component ids makes "no path" an O(1) answer
before the search starts.

### The meter is the pull

What fills the spawn meter is **arrivals that went well** — the readout the sim
already computes. This wires the two halves of the game together: untangling a
bottleneck stops being maintenance and becomes *how you grow*. A jammed city's
meter crawls; a working city's hums.

It also keeps the grammar consistent. Congestion never takes anything away, it
only slows the meter — foregone growth, the same shape as ignoring proposals and
the same shape as being away. Three pressures, one guardrail, no penalties
anywhere in the game. And it makes a bad ✓ cost something measurable: site a
supermarket badly and the long trips it creates literally slow your growth, so
"accepting must be able to be wrong" becomes a number on screen rather than a
design aspiration.

- **Two bars, one signal.** A slow one ending in a level number, a faster one
  ending in a picture of what is coming. Same input, different time constants,
  neither spent on the other — so growth is never traded against unlocks. The
  endcaps carry the difference: anticipating an unlock and anticipating an
  object are different feelings.
- **Show the kind, never the site.** The kind is anticipation, and it gives
  the wait something to do — eye up where you would want it, maybe run a road
  out on spec, which is the first reason speculative road-drawing has ever had
  to exist. The site must stay a surprise, because the site is the whole
  decision; reveal it early and the ✓ is over before the proposal lands.
- **A stalled meter is the queue cap made visible.** The spawner holding on a
  full queue was an invisible rule; as a bar that has stopped filling with
  something you want sitting behind it, it becomes legible pressure to go and
  answer proposals — with nothing lost by not.
- **Legibility is the risk.** A slow meter must visibly be *because of jams*.
  Hovering it should show the arrivals feeding it, late ones greyed. That is
  the difference between "my city is congested" and "the game is being
  stingy."

### Rate is not the constraint, and should not be a skill node

Cap the queue at a handful and the limiter is never the spawner — it is how
fast you can run roads out to what you accepted. The price of yes is the
throttle. So spawn rate should be generous: keep the queue fed and let the real
constraint sit downstream where the decisions are.

Which kills the obvious skill node. If the queue is usually full, +20% spawn
rate buys nothing — a point spent on a stat that does not bind. The tree should
touch **vocabulary** (unlocking supermarkets teaches the spawner a new word,
visible in the meter rather than buried in a menu), **mix**, and **cap size**,
which genuinely binds because it is more growth in flight at once. Three real
nodes and no fake ones.

No separate spawn currency. The queue cap is already the pacing model, and a
spend-to-spawn resource would be a second throttle to tune against the first.

### What the player still authors

- **Roads, reactively.** The network is the player's main medium: growth
  proposes, the player judges, and roads make the answer real. Speculative
  road-drawing is nothing to rely on — the game comes to you, and you
  answer with infrastructure. (This is the
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

- Pacing: how fast good arrivals should fill the meter, and the size of the
  cap. Oversupply regulates itself on the input side — the city grows into
  what it has before more spawns; nothing needs to despawn, and nothing
  needs to expire.
- **Does the road price actually bite?** The thing to watch on the first
  playtest. If accepting a wilderness spawn feels free, ✗ stays theoretical
  and the cap is doing nothing — and the variety argument would be built on
  sand. Watch for whether you ever press ✗, and why.
- The second building kind, and the trip it creates. Adding `Restaurant` to
  the enum is twenty minutes; making residents drive to it is the work, and
  it is what proves the agenda. Supermarket is the better first case
  precisely because it is a stock rather than a window.
- Clustering: start with demand-siting plus affinity jitter and *no*
  adjacency rules; add a nuisance signal only when homes start ghosting in
  next to the factory.
- Shared world: a proposal belongs to whoever it grew beside, probably by
  proximity — a neighbour must not accept a building into your street.
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
- **How do the non-resident agents fit?** Freight is stock-driven; police and
  fire are reactive, woken by an incident, which is what dedup preemption is
  for; buses are neither, being a timetable other agents depend on. All three
  should be entries someone writes — that is the test the agenda has to keep
  passing, and if one of them cannot be expressed that way the shape is wrong.
- **What weight does congestion get, and how much jitter?** The average of
  free-flow and observed is a half; per-agent jitter around it is what stops
  synchronised switching. Both numbers want watching in a real jam before
  being trusted.
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

1. Proposals, the home spawner, and pins — a ghost with ✓/✗ appears, an
   accepted home stands dormant until a road reaches it, and settle and the
   commute do the rest.
2. The household pantry and shopping trips — the demand data that lets shops
   and restaurants start ghosting in.
3. Freight to restock the shops — the first building that thinks.
