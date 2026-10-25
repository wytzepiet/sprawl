# The first half hour

Plan, 2026-10-25, to put `plan-goods.md` §The rule of thumb and §The
opening into the game: problems that come to the player, the fix that
unlocks the next thing, and a first sale within a few minutes. For
Wytze to react to; nothing here is built. It sits on the goods work
(pads, packages, the pallet ferry) and changes `missions.md` where they
meet. The opening's first cut is built (§The opening, built).

## Pacing, as numbers first

The opening is judged by a clock, not by feel alone, so it gets a test
before it changes, the way the season test keeps the town.

`cargo test first_half_hour` plays the opening with the hand's best
moves and asserts the beats, in real minutes of play (a day is twenty):

| Beat | By |
|---|---|
| The first road drawn | 0:30 |
| Goods on the producer's pad | 1:00 |
| The first coins land | 3:00 |
| The first problem the player did not ask for | 5:00 |
| A new kind of building asked for | every 3 to 5 minutes after |
| The first jam | about 15:00 |

It prints each beat's time, so a change to the ferry, a building or a
mission shows what it did to the start. Today's opening, measured the
same way, is the baseline.

**The baseline, 2026-10-25** (`cargo test first_half_hour -- --ignored
--nocapture`, on the test street, whose harbour and street stand already):

| | Today |
|---|---|
| Depot placed and joined | 0:10 |
| Goods on the quay | 0:25 |
| Goods in the depot, houses placed | 1:32 |
| First coins: the opening's reward, settlers home | 3:11 |
| The market: a box bought | 3:21 |
| First letter | 5:58 |
| First coins earned by a sale | 9:47 |
| Anything after that | nothing, to 30:00 |

The first three minutes are close to the beats; the first sale is at
ten, and from then on nothing arrives: no situation opens in the half
hour, since the starter pack keeps every shelf stocked.

## The opening: you are the first lorry

Decided with Wytze, 2026-10-25, after the sawmill-first cut below was
built and timed. The cold start (houses wait on a depot, a depot's
desks wait on houses, the sawmill on hands) is solved the way Factorio
solves it: **the player is the generalist.** You are the town's first
lorry and its first builder, and every building after replaces a chore
you were doing by hand. That is the automation, felt.

1. **Spawn.** The game gives a random patch of coast over a floor
   (forest in reach, flat land, open sea, room from neighbours) and
   seats the dock on it; a player who dislikes it starts again. No
   placing the dock.
2. **The cutscene.** The ferry sails in; your lorry rolls off; the
   dock's forklifts lift the starter pack onto the quay. Skippable, and
   for the newcomer only.
3. **A guide** greets you: a robot-like voice, anonymous, a line at a
   time. Named people are trade partners, and only them.
4. **A road to the woods**, from the quay.
5. **The sawmill, built by you.** Tap the starter timber on the quay
   and the forklift lifts it onto your lorry; tap the sawmill's site
   and you drive there, on your roads, and stand while its ring fills.
   It stands with a lorry's load of its own in the yard.
6. **Houses for its hands**, beside it, of its own timber, hauled and
   built by you. Settlers come on the next ferry: jobs bring people.
7. **The first sale.** The rest of the yard, driven to the quay; the
   coins land as the ferry casts off. The first ferry waits for it.
8. **You cannot keep up**: the yard fills while you build, the quay
   waits while you haul, and their pins fill. The **depot** hires your
   driver: its lorry hauls and its vans build, on their own. Your lorry
   stays, for a rush job.
9. Later, **the construction company** takes the big builds (§plan-goods
   §Jobs, buildings that grow): builder-hours, crews in vans.

What the sim needs: a lorry of the mayor's (`CarRole::Hand`) that is
sent with one errand (load this at that pad, take it there), and a site
it stands at is built after a while, as its forklift holds a lorry
today. Steering is never asked for: a tap picks the destination and it
drives the roads.

## The sawmill cut, built and timed

2026-10-25, on Wytze's word: the sawmill is the starter, no pick
("wood is the first basic material you need; let's babysit the player
a bit"). The farm takes days to grow and the quarry's stone builds
nothing alone; both come later, asked for by the town.

1. Build a harbour (as before).
2. Build a depot, and 3. join them (as before).
4. **Build a sawmill.** The town's first stands at once, like its first
   depot, with a lorry's load (five bundles) in its yard, so the first
   sale waits on no shift and no hands (`World::founded`).
5. **Sell a bundle of timber**, a step of the opening, not a mission
   after it, so the sale does not wait on the settlers.
6. Fetch the starter pack, now two bundles of timber (the hands'
   houses), five of stone, two crates, two drums.
7. **Houses for its hands**, beside it: people take the work nearest
   home, so houses by the depot staff its desks instead.

Then the market: a pallet of fuel bought.

`first_half_hour` now plays it at three join hours (midnight, nine, six
in the evening), on the test street:

| | 0:00 | 9:00 | 18:00 |
|---|---|---|---|
| Depot, sawmill placed | 0:10, 0:20 | same | same |
| Goods on the quay | 0:25 | same | same |
| A bundle put up for sale | 0:30 | same | same |
| Houses placed | 1:31 | same | same |
| Settlers home | 5:58 | same | same |
| **First coins: the sale, the opening done** | 7:00 | same | same |
| First letter | 8:45 | same | same |
| The sawmill's hands at work | 8:11 | 18:26 | 11:05 |

What it shows:

- **The sale misses the first ferry.** It is up at 0:30, while the
  first ferry is in (0:25 to 1:27), but the lorry fetches the starter
  pack first and the bundle reaches the quay at 5:00; the next ferry is
  in at 5:58 and casts off at 7:00. The ferry's rhythm is the opening's
  heartbeat (§What to decide). Proposed: the first call waits at the
  quay for the first sale, the card saying so.
- **The depot's six desks take the first hands.** They make nothing (a
  depot's lorries run unstaffed); houses near it leave the sawmill
  empty. Proposed: a depot with no jobs.
- **Night shows**: joined at nine, the hands come home after their
  shift ends and first work at 18:26; the day/night rule is still open.

## The opening, cut

What the start asks today: build a harbour, build a depot, join them,
fetch the starter pack, build houses, then buy and sell at the market
(`missions.rs` `ROWS`). Five steps of plumbing before anything is made.

The new one:

1. **Place the harbour.** The player chooses where on the coast, and so
   where the town begins: ownership, and no bad luck from a seat the game
   picked. Its hand must say plainly where it fits and why not (the
   2026-10-10 playtest stalled here), and the camera opens on the coast.
2. **Pick a starter**: a sawmill, a farm or a quarry, each where the
   island offers it near the harbour. The dots show where.
3. **Draw the road** from it to the harbour's quay. Its packages start
   piling on its pad.
4. **The first load, sent once.** Packages pile on the pad and the
   town's truck pulses; one tap sends it. It drives your road, the
   packages wait on the quay, and they are paid for as the ferry casts off
   at the world's price: the first coins. From then on the truck runs by
   itself, and says so on its card.

**Automation is earned by outgrowing it, not by stopping tapping.** One
truck cannot keep up for long: the pad fills, its pin's ring fills, and
the fix is a second truck, then a depot nearer the coast, then bulk or
boxes. Who supplies whom stays automatic, the nearest by road (Wytze,
2026-10-25): traffic cannot be told where to go, so the player designs
roads round where it goes. Hand-drawn links between buildings were
weighed and left out.

Goes from the opening: the depot step (the quay is a pad and holds what
lands), the starter pack as a gift (the starter building is the gift),
and the market missions, which open later, when there is something to
trade.

## Problems that come

The situation missions already work this way (`When::Short`, `When::Dry`
in `missions.rs`, sensed on events, never on a scan). Each new problem is
one more `When`, sensed where the server already finds it:

| The problem | Sensed where | The fix it asks for | What the fix brings |
|---|---|---|---|
| The producer wants workers | its jobs unfilled | houses, a road to them | commuters on the haul road |
| The pad is full and you are still tapping | a pad at capacity, the truck idle | a depot and its own lorry | the first lorry that runs on its own |
| Residents are hungry | a meal not found | a farm and a shop | crates, a second chain |
| Cars run dry | already sensed | a gas station | drums to deliver |
| A site waits on timber or stone | already sensed | a sawmill or a quarry | the next chain |
| A junction jams | a vehicle stopped there over a minute | redraw it, on that tile | the road puzzle |
| A letter asks for more than you make | already written (`orders.rs`) | a second producer, a bigger yard | more trips |

The jam is the one that makes this our game: the server already knows a
car that stands for good (`Watch`, in replays). A mission that says
"lorries wait at this junction", with the tile and a follow, turns
traffic into a problem that arrives on its own.

## Shortages are pins

Every shortage speaks the same way (Wytze, 2026-10-25), in two places:

- **Where it bites, a pin with a ring that fills.** Whatever lacks
  something grows a pin with the icon of what it lacks: a worker over a
  sawmill short of hands, a crate over an empty shop, a drum over a dry
  gas station, a bundle over a waiting site, a factory short of its
  input, a car with an empty tank. The ring round it fills while the
  lack lasts, so it starts as a hint and ends urgent, and how full it is
  says how long it has waited. A tap opens the card with its fix. A car
  pins only once it is stranded, not every time it runs low, or the map
  fills with them.
- **In one place, a few meters along the top**: workers (jobs against
  residents, so many short or spare), and a bar for each good the town
  uses up, in hours of stock left. Only goods the town consumes get one,
  so early on there are two or three.

The pin says where, the meter how much, and a mission speaks only when a
ring fills. This replaces the map's other warnings (`game.md`
§Legibility) with one language. Houses stay the player's to place: the
sawmill's worker pin and the workers meter make the shortage plain;
streets the town fills with houses by itself can come later, if placing
them feels like bookkeeping.

## What to decide

- **Pressure that grows by itself** (letters and demand rising over
  time) or only when the player builds. `plan-goods.md` leans to the
  first, gently.
- **The ferry's rhythm in the first half hour.** Coins land as it casts
  off, so its timetable is the opening's heartbeat; the first sailings
  may need to come more often than later ones.

## The order to build it

1. `first_half_hour`, on today's opening, as the baseline.
2. The harbour's placing made plain, and the starter pick.
3. The quay as a pad and the first load sent, on the goods work.
4. The new problems, one `When` at a time, each with a test that it
   opens once at the right moment (`a_site_short_of_stone_asks_for_a_quarry_once`
   is the pattern).
5. Play it, read the beats, tune the ferry and the producers.
