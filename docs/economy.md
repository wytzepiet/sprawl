# Economy: stocks, prices, floats, and one door

Status: specification, drafted 2026-09-09 and reworked the same day after
a second argument, about where money goes when nobody spends it. Built
through step 2 of §12 on 2026-09-09; §12.2 records what building it
decided, and where it departs from the text above. Supersedes `game.md`
§Money, which points here. Builds on `residents.md` (buckets, taps, the
score), `services.md` (calls) and `parking.md` (lots as the place
vehicles stand). The single ledger of hours served that was both level
and money (`xp.rs`) is gone; `shelved.md` has it.

---

## 1. The idea

Eight rules carry it. The first five are economics; the last three are ours.

1. **Everyone has a purse.** Residents, buildings, the mayor. Money moves
   between purses; it is made and destroyed only at the edge.
2. **Everything is a stock.** A shelf of crates, a tank of fuel, a day of
   sleep, a factory's hours of labour, a building's distance from burning
   down: each is a stock with a cap, drained by use, refilled by a tap or a
   delivery. The deficit is the need. One type; nothing new decides
   anything.
3. **Everyone posts a price and nudges it by their own stock.** Selling out
   → a notch up. Piling up → a notch down. Never below cost. Nobody
   computes a market; every price is local and has memory.
4. **Everyone prices time at what they earn.** A resident's hour is their
   wage; a building's hour is its revenue. So money enters the one score
   `residents.md` already has as hours, and there is still one score.
5. **The edge is the band.** The edge buys and sells every good at a fixed
   price and hires everyone at a fixed wage, and the drive is the freight.
   Every local price and wage lives between the edge's and the cost of the
   trip. Nothing can run away.
6. **The mayor owns the town.** The mayor placed every building and paid
   for it. Every purse keeps a float and the rest sweeps to the treasury.
   There are no taxes because there is nothing left to tax.
7. **Rules come from economics; equilibria are tests; the closure is
   designed.** A rule enters this document if it is a named mechanism with
   a referent in the real economy. What economics predicts (prices fall as
   producers enter, margins compress, wages rise with the commute) is
   asserted by `cargo test`, never coded. Where money enters and leaves
   (§8) is a choice, made on purpose. And every mechanism is the arcade
   version of its referent: one number where the world has a curve, a day
   where the world has a quarter, one door where the world has a globe.
8. **Ignoring the economy never hurts; reading it only helps.** A player
   who places buildings and watches cars must be fine. Prices are the
   layer for the player who wants to win.

The point of all of it: a town can specialise, and specialising in what
the outside is short of pays. That is the game's fantasy the roads alone
do not give, and it should fall out of these rules rather than be added.

## 2. What exists, and what stays

- **The ledger.** `xp::Ledger` integrates hours of need served, continuously,
  from every resident standing in a building on a need it has a tap for.
  `balance = earned − spent`; placing costs `blueprint.price` hours,
  discounted by the build. Level is derived from the same cumulative sum.
- **Calls.** A building whose stock runs low calls; a warehouse's truck
  answers, or the edge's, slowly (`services.md` §5).
- **Three stocks in three shapes.** A shop's shelf is a fraction on the
  building; a car's tank is a need whose level *rises* as it drives; a
  resident's hunger is a bucket that fills. The same idea, three structs.

What stays: **level is hours served.** "How much life happened here" is
the right measure of a town's size, and it is what the build's points
should come from. What changes: money stops being that number. It becomes
its own quantity, in purses, moved by sales. The continuous ledger goes;
the level banks at the resident's settle in lumps like everything else.
And the three shapes become one (§4).

## 3. Actors

**A resident** has a wallet, a wage, and an employer. They earn by selling
a shift (§6.3) and spend at taps that charge (§5). Their stocks are their
needs, their car's tank and wear, and their household's food.

**A building** has a balance, the stocks in it, a posted price for what it
sells, and possibly vehicles. It is founded when the mayor places it; its
price includes the float it opens with. It buys inputs, pays wages, sells
outputs. A building whose balance runs dry does not vanish (§9). "Company"
in this document means a building; a company with two buildings waits for
a reason to exist.

**The mayor** has the treasury (§8.2). The mayor never trades.

**The edge** has a purse of infinite depth and prices that do not move
(§8.1).

Filed, until the port exists: haulers as companies whose stock is idle
capacity. Today a building's own truck moves its goods, or the edge's.

## 4. Stocks

A **stock** is `(level, cap)` on whoever holds it: a resident, a car, a
building. It drains by use and refills at a tap or by a delivery. Its
deficit `cap − level` is the need, and its deficit over its cap is the
weight in the score. This is `residents.md` §3's bucket with the sign
flipped: the bucket counted hours owed, the stock counts hours left, and
the algebra is the same with `level` read as `cap − stock`. The flip is
made because a shelf, a tank and an appetite read naturally as things
that run down, and because it makes them one struct.

Three ways a stock drains, and the rule for which:

- **By time.** Sleep, hunger, leisure: `use` is a rate, derived from
  time-use data as `residents.md` §3.1 derives `fill`.
- **By the world.** A shelf drains per visit, a tank per tile, a labour
  stock per unit produced, a services stock per day of operation. The
  rate is a fact about the building or the car.
- **By a draw.** Health, a building's distance from fire, obedience: full
  until a hazard fires, then draining until a tap or a call refills it.
  The hazard is a rate with a referent (illness incidence, fire risk).
  This is the one kind `residents.md` did not have, and it needs one rule
  the others do not: **a consequence at zero.** A resident's health at
  zero is death; a building's fire stock at zero is rubble. Nothing else
  in the model does anything at empty but score badly.

A **constant** stock (Work, at `k`) neither drains nor refills; the tap's
curve alone decides when it is served, exactly as now. It is the habit
that gets a resident out of the house, and it stays: money is not the
reason to work here (§6.3).

A **good** is a stock that moves. Today: the container and the crate.
Two more come with this document:

- **Services.** An office turns its labour stock into a services stock.
  Every business holds a services stock that drains per day of operation
  and calls when low; an office answers with a car, its staff driving out,
  the way a warehouse answers with a van. No office in town, and a
  consultant drives in from the edge, slowly. An office with no clients in
  town sells to the edge: its cars drive off the map and back. Offices and
  factories are both able to export, which is what lets a town be an
  office park as readily as a factory town.
- **Wear.** A car has a tank already, a stock drained per tile and refilled
  at a gas station. Wear is a second per-tile stock with a slower rate,
  refilled at a workshop. The driver weighs it alongside their own needs,
  as they weigh fuel.

A factory turns input stocks into an output stock at a rate while it has
labour, inputs, and room; a full yard stops the line, so a glut is seen as
stacked containers and felt as wages not paid. **What nobody in town buys,
the edge buys** (§8.1), so every workplace has a revenue from the day it
is placed.

## 5. Prices

### 5.1 The rule

Firms do not solve supply and demand. Asked how they set prices (Blinder
et al., 1998), they say: cost plus a markup, and the markup moves with
inventory. Every agent-based economy that stays stable uses the same
rule; so did Patrician in 2000. It is local — a building sees only its
own shelf — and it has memory, which a price computed fresh from a
formula does not.

```
each game-day, for each output stock a building sells:
  level < target  →  price *= 1 + α_up
  level > target  →  price *= 1 − α_down
  price = max(price, unit_cost)
```

`unit_cost` is what the building paid for the inputs in one unit of
output plus the wages it paid while making it, over the last day. A
shop's unit cost is what it paid for the crate, delivered, plus the hours
behind the counter. A new building's price starts at its unit cost: a
shop that opened at the edge's price would lose the freight on every
crate. `α` is a few percent; the daily step and the band (§8) are what
keep it from ringing. Its value and the asymmetry between up and down
want a referent before they are written down (§14).

### 5.2 Wages

A building holds a **labour stock**: the hours its line needs, drained as
it produces, refilled by workers on shift. Its deficit is its vacancies,
and a wage is the price posted on that deficit, nudged like any other:
slots unfilled → raise; more applicants than slots → lower, and lower
slowly. Wages are sticky downward in every labour market ever measured;
`α_down` for wages is a fraction of `α_up`. That one asymmetry is the
most robust fact in the field, and it is the only special case in this
section.

A vacancy is an order for labour: buyer, good, quantity, price. Labour is
the one good the seller delivers in person, so the commute is the
delivery and the resident drives. A building far from homes cannot fill
its slots at the going wage, its vacancies stay open, and the nudge
raises the wage until it can. The building pays for the commute through
the wage — compensating differentials, Rosen (1986) — and there is no
second line for travel.

### 5.3 Freight

Filed until the port. Today a truck is its owner's, and what it costs is
the fuel and the driver's hours, which are already in unit cost. A
hauler's posted price per container per tile, and a ship's floor at a
fraction of a truck's because one crew moves a hundred boxes, come back
with the second door (§8.1).

## 6. Choosing: one protocol

### 6.1 The score

Every decision in the game is one procedure. A **stock** with a deficit;
a **tap** with a curve, a rate, an overhead, and now a price; a **mover**
with a position and an earning. `residents.md` §4.1 scores an option as
need relieved per hour of the mover's time, from now until the visit is
over. Money enters as time:

```
score = w × drained / (leave − now + price / earning)
```

`earning` is what the mover makes per hour — a resident's wage, a
building's revenue over the last day. This is Becker (1965), the theory
of the allocation of time: a person prices money in hours of their own
labour. A meal that costs an hour's wage is scored as an hour longer. A
low-wage resident sees the same meal as three hours and cooks; a
high-wage one barely notices. That is Engel's law — the poor spend on
food first, the rich on leisure — from one division and no new
parameter. An option the purse cannot pay for is not an option.

That is the whole protocol. Nobody posts a listing and waits for replies:
a listing is a stored intention, and `residents.md` §2 deleted those so
that any wake reads the world and converges on the same answer. The
party in need scans the sellers it can reach and picks. What remains as
state is the seller's posted price, which is a fact about its own stock,
and the trip in flight, which is a record of what is happening.

Two things differ between a resident and a building calling it, and
they are inputs, not branches. **Presence:** a resident must be there, so
their in-person options block each other; a building's option dispatches
a vehicle, and many are in flight at once. **Travel:** a resident's is
their own drive; a building's is its truck's leg, or the edge's.

A resident could in principle order food to the house through the same
primitive; it is left unbuilt, because the shopping trip is traffic and
traffic is the game.

### 6.2 A building's turn

A building wakes when an input stock falls to its reorder point — the
`(s, S)` policy of every inventory textbook: order up to `target` when
`level` hits `reorder`, where `reorder` is expected use over the lead time
plus a margin. The option set is every seller of the good it can reach:
posted price, plus the freight for the leg, plus the time until it lands.
The **delivered price** is what it compares. "Every call goes through a
warehouse" (`game.md` §Goods) becomes "a buyer takes the cheapest
delivered option": the warehouse wins when it is nearer than the
producer, which is what a warehouse is for, and loses when it is not.
The call list keeps what it holds today, the truck already on its way.

### 6.3 Which job

For a shift the resident is the seller. Their options are buildings with
vacancies and the edge. The value of a shift is its pay in the numéraire
every resident shares, the edge wage, so

```
score = w_work × hours × (wage / edge_wage) / (commute + hours)
```

A nearby job at four fifths of the edge wage beats the long drive; one at
a third does not. The reservation wage is the commute. This is the one
place the score reads a price as a gain rather than a cost, and it is
written down here as the special case it is.

Employment is a standing relation, derived in the settlement pass as it
is today; only the ranking changes, from distance to this score. A
resident with a job still ranks vacancies, and switches when the new
score beats the current by a **switching threshold**: people move for a
raise of a tenth to a fifth, and about one in forty moves in a month.
Tenure is then emergent, and a building that raises its wage can hire
away from its neighbour, which is the pressure that makes wages mean
something.

Nobody quits when rich — labour supply is close to inelastic, and a game
where the wealthy stop showing up has a mystery in it — so the Work need
stays the constant habit `residents.md` §3.1 makes it; only *where* is
economic.

## 7. Moving goods

A truck carries one load, from the seller to the buyer, and goes home.
**The warehouse** is a building with stocks of many goods that buys from
producers and the edge and sells locally. **Construction** is unchanged:
materials are a good, the construction firm a building, the site a call
(`game.md` §Goods).

Filed: orders as a record with a hauler; handling classes (box, liquid,
bulk) and a port per class; joint replenishment, so a ship fills with
everything at once; multi-drop rounds. Each waits for the vehicle that
needs it.

## 8. The door, and where money goes

This section is not economics. It is the closure, chosen on purpose,
because it is the part every broken game economy got wrong by pretending
to simulate it.

### 8.1 The edge

A town is an open economy. Its money supply is what it has exported less
what it has imported, and what balances that is prices: drain money out
and local prices and wages fall, exports get cheap, and it comes back.
That is Hume's price-specie flow (1752), and the band is it.

- **The edge sells and buys every good at `edge_price[good]`**, in
  unlimited quantity, and the drive is the freight. So no local price
  exceeds the edge's plus the trip in, and none falls below the edge's
  minus the trip out. Every price lives in that band, and the band is a
  distance.
- **The edge hires everyone at `edge_wage`**, at every exit, forever. So
  no wage falls below it minus the commute, and nobody starves: the drive
  is the price, and it is always payable. Needs served at the edge are
  served at the edge's prices; a resident who cannot pay is served anyway
  and owes nothing, because the floor has to be a floor.
- **What nobody in town buys, the edge buys.** A workplace whose output
  has no local buyer sells it at the edge, its truck or its staff driving
  off the map and back. This is what makes offices and factories the
  town's export base before there is a port.
- **The door breaks even.** `edge_wage` and `edge_price` are set so that
  a resident who works and eats entirely at the edge nets zero. Then every
  net flow through the door is because the town does something different
  from the outside: cheaper meals keep money in, higher wages bring it in.
  One calibration, no mechanism, and a test (§11.9).

Money is made when a resident is paid at the edge or a good is sold to
it; destroyed when a good is bought from it or a need is served there.
The money supply drifts, and every drift ends at a bound with a name:
drain it out and prices fall to floors, wages to the edge, exports become
attractive and it comes back; flood it in and prices rise to the ceiling
and imports become attractive.

Later, **the port** is a second door with the same prices and cheaper
freight, on a sea that is one connected body so that one price is the
world's. Filed: `edge_price` drifting slowly with the world's net trade,
one global rule, so that a season's meta moves. Not before a season
exists.

### 8.2 Floats and the sweep

Money that lands in a purse that never spends is destroyed as far as
circulation goes. Residents spend at taps, buildings on inputs and wages,
the mayor on buildings. A profit nobody pays out, a landlord's rent, and a
resident's savings have no outlet, and every one of them is a sink.

Real economies return profit to households as dividends and turn savings
into houses and factories. This game has one investor, who founded every
building and seeded its float: the mayor. So the mayor is the residual
claimant of the whole town.

- **Every purse keeps a float.** The float is what the purse spends
  between two incomes. For a shop: one full restock plus wages until the
  next delivery, which the reorder rule already knows. For a resident: a
  payday of meals and fuel. For a house: nothing, because a house spends
  nothing. No table of caps; one rule, and the referent is working
  capital.
- **The rest sweeps to the treasury** at each income, as a lump on the
  building where the sale landed, or the home where the wage landed. A
  resident's sweep is their rent, and rent is what they can afford —
  Schwabe's law, the one household expense that rises with income. Rent
  never enters the score, so a broke resident always goes home.
- **A facility that answers calls pays its wages from the treasury.** A
  hospital has wages and no sales; under the float alone its ambulance
  would stop rolling when it was broke. Services are paid from tax
  everywhere, and the blueprint row already marks which kinds answer.
  This is the one special case.

The treasury is spent on buildings (whose price seeds the float), road
past the allowance, and nothing else; the plant buys its own coal.

What this buys: no taxes, no landlord, no question of what a resident does
with savings. A warehouse that shortens no route makes no margin and
sweeps nothing, so the mayor cannot farm hops; market discipline does
what a rule would. And the treasury is the one place money accumulates,
which is what a score is.

Level is unchanged: hours served, banked at the resident's settle.

## 9. Failure, and why it stays legible

A building whose balance falls below its float stops buying. Its shelves
empty and go grey; its wages stop and its vacancies close, so its workers
take the next best score, which is at worst the edge. It does not vanish
and it does not take the building with it. The mayor can put money in
(spend, as for any placement) or demolish. A resident whose wallet is
empty works where the score sends them — the edge always hires — and eats
at the edge until it refills. Nothing propagates through households:
consumption is set by needs and needs do not spiral. That is rule 8 made
mechanical.

Emigration (`game.md` §Money, "the floor is emigration") is no longer
needed for the floor and is filed.

## 10. Legibility

Everything a price does is an event on the map first.

- **The lump.** A `Sale` on the wire: building, amount, when the sale
  ends. The number floats above the building; the sweep steps the meter.
  A red lump on a truck leaving for the edge is an import.
- **The building.** Shelves grey at empty stock (built); a yard stacked at
  full output; the inspect panel shows each stock's level, price, and its
  trend over the week.
- **The company.** Revenue, purchases, wages, margin, balance against
  float. A refinery whose margin has gone negative is a line, not a
  mystery.
- **The town.** Per need, visits served per day; per good, in and out per
  day. The cinema's decline is a number beside the pump's.
- **The region.** Per good, per town: price, stock, trade. Each row a link
  to the map. Trucks leaving for the edge loaded are the same fact at
  build zoom.
- **The probe.** The edge's price list is a quote. Ship one crate and
  watch what lands.
- **The advisor.** Reads the above and points: "food fetches most in the
  east and your land is flat."

## 11. Tests

Equilibria are asserted, not coded. Each is an `#[ignore]` test in the
manner of `town`, run on a fixed seed over a simulated season, where a
season is thirty game-days until something says otherwise.

1. **Entry lowers price.** Fixed population; add farms one at a time. The
   food price falls monotonically to the floor; food sold rises to
   saturation and stops.
2. **Margins compress.** Two refineries earn a lower margin each than one.
3. **A bedroom community.** Town A all homes, town B all jobs: B's wages
   sit above the edge wage while A commutes; homes added to B bring them
   down.
4. **Geography.** Oil under one of two towns. The other imports it; a
   well in the first exports it, and the well's price exceeds the edge's
   minus freight. Waits for the port.
5. **The band.** Over a season no price leaves
   `[edge − freight_out, edge + freight_in]` and no wage falls below
   `edge_wage − commute`. (As built: no wage a resident of the town works
   for; a building staffed from beyond the edge pays what its trade is
   worth, which can be the floor — §12.2.)
6. **No harm.** A town built ignoring every price ends the season with
   more treasury than it began, net of what it placed, and no building
   placed is below its float within its first week.
7. **The conga.** A warehouse inserted where it shortens nothing makes no
   margin, sweeps nothing, and the treasury is unchanged. (A property of
   one delivery, so a unit test, not a season.)
8. **No ringing.** Price variance at steady state stays under a bound.
9. **The door breaks even.** A resident who works and eats only at the
   edge ends the season with the wallet they began. (A property of one
   payday, so a unit test, not a season.)
10. **No sinks.** Over a season the money outside the treasury stays
    under a bound: floats, and what is in transit. (Printed by the no-harm
    season, not asserted: the sweep is the mechanism, and any bound would
    be a number picked to pass.)
11. **Tenure.** Over a season the fraction of residents who change jobs in
    a month sits near the referent.

## 12. Order to build

Each step is playable and nothing before step 2 can hurt anyone.

1. **Stocks, purses and the sweep.** The shelf, the tank and the bucket
   become one stock. Wallets and balances; wages paid; the float and the
   sweep; the continuous ledger replaced by lumps. Every price is its
   unit cost. Money exists and nothing floats. §12.1 has what step 1
   needs decided that the rest of this document leaves open.
2. **Posted prices.** The nudge (§5.1); the labour stock and wages on it
   (§5.2); `price / earning` in the score (§6.1); jobs ranked by wage
   with the switching threshold (§6.3). The band holds by construction.
3. **The building's turn.** `(s, S)` with delivered price across every
   reachable seller (§6.2); the call dispatcher's nearest-depot search
   goes.
4. **Services and wear.** The office's stock and its car; the workshop.
5. **Panels, the board, the advisor's tools.**

Then, with the port: freight, haulers, classes, the second door.

### 12.1 Step 1, to the number

Five decisions the mechanism does not make on its own. Each is one
line; the rest is the implementer's.

- **The unit is the hour, and the edge wage is one.** Everything else is
  relative to it: local wages float above, local prices around the
  edge's, and building prices are already in hours. The edge's price per
  good is the only table anyone authors.
- **The edge's prices come from budget shares**, as fill rates came from
  time-use data. A day at the edge earns eight; households spend about
  a third on housing, a sixth on food, a sixth on transport, a tenth on
  leisure. So a meal is about half an hour, a day's fuel about an hour,
  an evening out about one, and the sweep takes the housing share. The
  numbers are low stakes: the band turns a wrong table into a town that
  is a little dear or a little cheap, not one that runs away. Pick, run
  the season, look, adjust.
- **Every good has a unit, and a price is per unit.** A meal, a crate, a
  litre, an hour of labour. A tap turns one unit into hours of need at
  its rate; a shelf counts units, not visits. No fluid goods.
- **A workplace with nothing to sell sells its hours to the edge**, at
  the edge wage, so an office or a factory in step 1 is a pass-through
  with no margin and the mayor's income comes from shops and the
  resident sweep. Temporary: goods give the factory an output and step 4
  gives the office one, and the rule stops applying by itself.
- **Money moves when a sale ends, in one lump.** A sale is one tap
  serving one stock for one visit: a shift, a meal, a delivery. Paying
  at every wake would scatter a shift into small change, and the point
  of the lump is that a day's pay lands on the map as one number.

### 12.2 Steps 1 and 2, as built

`server/src/economy.rs` holds every number below with its referent. The
mechanism is the one above; these are the places where running it made a
decision the text left open, or moved one it had made.

- **The stock.** `Stock { level, cap }` is the one struct: a resident's
  needs, a car's tank and a building's shelf. The bucket's algebra reads
  `short = cap − level` and is otherwise `residents.md`'s.
- **Prices.** The edge's: a sitting a fifth of an hour, an evening out
  half an hour, a tank three; the crate behind a meal and the delivery
  behind a tank are half of that, wholesale. The budget shares would make
  the sitting half an hour and the evening an hour, and at those prices
  nobody lunches out and nobody goes out: the price is added to the visit
  in the resident's own hours, and the ladder in `residents.md` §5.5 is
  tuned to tenths — a full sitting at half an hour ties the shift it
  would interrupt. Raising what a meal is worth instead (a sitting worth
  an hour, served at twice the rate) was tried and undone: dinner then
  beats the evening out, time off piles up, and the afternoon after lunch
  becomes the outing, in work time. A tank is worth two hours — what
  running dry costs — and fills in twenty minutes; before it had a price
  it was worth twenty minutes.
- **A meal at home costs the groceries.** The kitchen is the household's
  and a home sells nothing, but what they eat there is bought at
  wholesale from beyond the edge, until something in town delivers it
  (§6.1's household delivery, still unbuilt). Otherwise a free kitchen
  beats every shop at every price.
- **The floor is marginal cost.** A price never goes under the delivery
  behind it, and an evening has none. The hours behind the counter are
  not in the floor: spread over a bar's evenings they come to an hour's
  wage each, and at that price nobody goes out; spread over the day's
  actual sales they rise as trade falls and price a quiet shop out. This
  is the shutdown rule: a firm sells while the price covers the sale, and
  pays its staff from the margin or runs through its float. A new
  building opens at the edge's price rather than at cost, since a price
  it has sold nothing at cannot be known yet.
- **The nudge.** Prices step up five percent a day and down three; wages
  up five and down one (§13.1, resolved: Blinder et al. 1998 on the pace,
  and wage stickiness for the asymmetry). "Selling out" is the shelf
  running empty, or selling more than eight tenths of what the tap could
  in a day; "piling up" is under four tenths. The switching threshold is
  fifteen percent (§13.2, resolved: the median job-to-job wage gain).
- **Wages track what an hour brings in.** A building's wage never rises
  past what an hour of its labour earned yesterday — the edge's wage, for
  a workplace with nothing to sell — and a wage above it is cut to it at
  once (Bewley 1999: firms hold wages while they make money and cut when
  they do not). A shop with no trade pays what its trade is worth, and
  its staff take the next best score. Without this every shop in a small
  town pays eighteen hours a day for a handful of meals and is dry on the
  second day. A day nobody worked says nothing, and the wage stands; and
  no wage goes under a tenth of the edge's, since someone paid nothing
  prices money at infinitely many hours and the score cannot say so.
  The signal for a rise is a desk the edge had to fill: a job the town
  cannot fill at the going wage is still filled from beyond the edge, as
  `game.md` says, and the wage rises until the town fills it.
- **The float and the sweep.** A building's float is a day of wages, for
  a kind whose takings come in through the day and whose wages go out at
  the end of it, plus a full shelf at wholesale; nothing for a house or a
  pass-through; the shelf alone for a service. A resident's is a day's
  wage at the edge. Both sweep at each income, as §8.2 says: a resident
  at each payday, a building at each sale, so the treasury climbs as the
  town trades rather than stepping at midnight. §9's "below its float"
  is read as "its purse is empty": a purse with money in it buys and
  hires, an empty one stops, and the float is what the sweep leaves it
  to run on, and dips into for wages and restocks between sales.
- **Pass-throughs.** A workplace with nothing to sell sells its hours to
  the edge before it pays for them, so it needs no purse (§12.1).
- **On the wire.** A `Sale` per lump: the building, the amount, when.
  The client floats it over the building; the treasury steps. Level is
  hours served, banked at each settle, the edge's excluded.
- **Prices step once a day**, as §5.1 says, because selling out and
  piling up are measured over a window and a day is the smallest honest
  one. They step at midnight, all at once; counting the till when each
  tap closes instead would stagger them and is the natural next cut.

What running the season found, and did not fix: a shop needs about
forty meals a day to carry two staff at the edge's wage, which is a
district, not a street. The wage cut keeps such a shop alive at a wage
its trade is worth, staffed from beyond the edge; whether that is the
game, or shops should be smaller, is open (§13.7).

## 13. Open

1. ~~`α_up`, `α_down`, and the wage asymmetry, with a referent each.~~ §12.2.
2. ~~The switching threshold's value.~~ §12.2.
3. A new building's `earning` before it has a day of revenue — the edge
   price of its output times its rated output is the obvious seed.
4. Household delivery (§6.1) — permitted, unbuilt. Until then a meal at
   home is groceries from the edge (§12.2).
5. `edge_price` drift for seasons (§8.1).
6. How scarce coast should be, when the port comes.
7. Shop labour against shop trade (§12.2): fewer staff per shop, shorter
   shifts, or a town whose shops are meant to fail until it has a
   district — and the price of a meal against the ladder, which §12.2
   settled by making a sitting worth an hour.
