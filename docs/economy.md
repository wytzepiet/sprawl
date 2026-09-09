# Economy: purses, prices, and one score for everyone

Status: specification, drafted 2026-09-09 from a long argument about what
money is for. Nothing here is built. Supersedes `game.md` §Money, which
now points here. Builds on `residents.md` (buckets, taps, the score, and
§8's stocks as buckets), `services.md` (calls) and `parking.md` (lots as
the place vehicles stand). What exists today is a single ledger of hours
served that is both level and money (`server/src/xp.rs`); §2 says what of
it stays.

---

## 1. The idea

Seven rules carry it. The first five are economics; the last two are ours.

1. **Everyone has a purse.** Residents, companies, the mayor. Money moves
   between purses; it is made and destroyed only at the sea and the edge.
2. **A stock is a bucket.** A company's shelf of food, a refinery's tank of
   oil, a resident's day of unsold hours: each is a bucket in the sense of
   `residents.md` §3, filled by use and drained by delivery. The deficit is
   the need. Nothing new decides anything.
3. **Everyone posts a price and nudges it by their own stock.** Selling out
   → a notch up. Piling up → a notch down. Never below cost. Nobody
   computes a market; every price is local and has memory.
4. **Everyone prices time at what they earn.** A resident's hour is their
   wage; a company's hour is its revenue. So money enters the one score
   `residents.md` already has as hours, and there is still one score.
5. **The sea and the edge are the band.** The sea buys and sells every good
   at a fixed price; the edge hires everyone at a fixed wage. Every local
   price and wage lives between those and the cost of the trip. Nothing
   can run away.
6. **Rules come from economics; equilibria are tests; the closure is
   designed.** A rule enters this document if it is a named mechanism with
   a referent. What economics predicts (prices fall as producers enter,
   margins compress, specialisation follows geography) is asserted by
   `cargo test`, never coded. Where money enters and leaves (§8) is a
   choice, made on purpose, because that is the part no theory settles.
7. **Ignoring the economy never hurts; reading it only helps.** A player
   who places buildings and watches cars must be fine. Prices are the
   layer for the player who wants to win.

The point of all of it: a city can specialise, and specialising in what
the region is short of pays. That is the game's fantasy the roads alone
do not give, and it should fall out of these rules rather than be added.

## 2. What exists, and what stays

- **The ledger.** `xp::Ledger` integrates hours of need served, continuously,
  from every resident standing in a building on a need it has a tap for.
  `balance = earned − spent`; placing costs `blueprint.price` hours,
  discounted by the build. Level is derived from the same cumulative sum.
- **Calls.** A building whose stock runs low calls; a warehouse's truck
  answers, or the edge's, slowly (`services.md` §4).
- **Stock as a bucket.** `residents.md` §8: a household's food is a bucket
  drained by a trip to a shop; the home Eat tap is gated on it.

What stays: **level is hours served.** "How much life happened here" is
the right measure of a city's size, and it is what the build's points
should come from. What changes: money stops being that number. It becomes
its own quantity, in purses, moved by sales. The continuous ledger goes;
the level banks at `settle()` in lumps like everything else.

## 3. Actors

**A resident** has a wallet, an employer, and a wage. They earn by selling
hours (§4) and spend at taps that charge (§5). They hold no stock but
their hours and, per `residents.md` §8, their household's food.

**A company** has a name, a balance, one or more buildings, the stocks in
them, and possibly a fleet. It is founded when the mayor places its first
building; the building's price includes the float it opens with. It
buys inputs, pays wages, sells outputs, and posts prices. A company whose
balance runs dry does not vanish (§9). Two people at the same firm is
flavour that costs nothing: "Piet Vancleef works at Watson Cookie Co."

**A hauler** is a company whose stock is idle capacity and whose price is
per container per tile (§5.3). A producer that owns trucks is its own
hauler at zero margin.

**A landlord** is a company whose building is homes; the Home tap charges
rent. This makes the mayor's income two taxes and no special cases.

**The mayor** has the treasury (§10). The mayor never trades goods.

**The sea and the edge** have purses of infinite depth and prices that do
not move (§8).

## 4. Goods and stocks

A **good** has a name, a unit, and a **handling class**: *box* (anything
that fits a container: today's container and crate), *liquid* (oil, fuel,
later), *bulk* (coal, ore, later). The class is the vehicle's axis, not
the good's: a container ship does not know what is in the box, which is
why the box exists. Two goods of the same class share trucks, ships and
terminals; mixed loads are normal. Ports come per class and all want
coast.

A **stock** is `(good, level, cap, target, reorder)` on a building. An
input stock is a need: its deficit `cap − level` is the bucket the
company decides on. An output stock is for sale at the posted price. A
factory turns input stocks into an output stock at a rate while it has
workers, inputs, and room; a full yard stops the line, and the Work tap
with it, so a glut is seen as stacked containers and felt as wages not
paid.

**Work is a good.** Each resident's output stock fills to eight hours at
midnight and what is unsold is gone at the next — labour is perishable,
which is the one fact about it everyone agrees on. Its handling class is
none: the worker drives themselves. **Sleep is not a good.** It is a tap
with no stock behind it, at home, as now.

## 5. Prices

### 5.1 The rule

Firms do not solve supply and demand. Asked how they set prices (Blinder
et al., 1998), they say: cost plus a markup, and the markup moves with
inventory. Every agent-based economy that stays stable uses the same
rule; so did Patrician in 2000. It is local — a company sees only its own
shelf — and it has memory, which a price computed fresh from a formula
does not.

```
each game-day, for each output stock a company sells:
  level < target  →  price *= 1 + α_up
  level > target  →  price *= 1 − α_down
  price = max(price, unit_cost)
```

`unit_cost` is what the company paid for the inputs in one unit of output
plus the wages it paid while making it, over the last day. A shop's unit
cost is what it paid for the crate plus the hours behind the counter. A
well's is wages. `α` is a few percent; the daily step and the band (§8)
are what keep it from ringing. Its value and the asymmetry between up and
down want a referent before they are written down (§14).

### 5.2 Wages

A wage is the price of the good Work, posted by the employer. The stock
it watches is **vacancies**: slots unfilled → raise; more applicants than
slots → lower, and lower slowly. Wages are sticky downward in every labour
market ever measured; `α_down` for wages is a fraction of `α_up`. That
one asymmetry is the most robust fact in the field, and it is the only
special case in this section.

### 5.3 Freight

A hauler posts a price per container per tile. Its stock is idle
capacity: vehicles standing → lower; calls queueing → raise; floor at fuel
plus the driver's wages per tile. A ship's floor is a fraction of a
truck's because one crew and one tank move a hundred boxes — real freight
runs at a tenth of trucking per ton-mile, and it falls out of vehicle
capacity here without a constant. Long hauls go by sea even with the
detour to the port, because the buyer takes the cheapest delivered price
(§6.2).

## 6. Choosing: one score

### 6.1 The amendment

`residents.md` §4.1 scores an option as need relieved per hour of the
resident's time, from now until the visit is over. Money enters as time:

```
score = w × drained / (leave − now + price / earning)
```

`earning` is what the actor makes per hour — a resident's wage, a
company's revenue over the last day. This is Becker (1965), the theory of
the allocation of time: a person prices money in hours of their own
labour. A meal that costs an hour's wage is scored as an hour longer. A
low-wage resident sees the same meal as three hours and cooks; a
high-wage one barely notices. That is Engel's law — the poor spend on
food first, the rich on leisure — from one division and no new
parameter. An option the purse cannot pay for is not an option.

One property distinguishes residents' options from companies': **presence**.
A resident must be there, so their in-person options block each other; a
company's option dispatches a vehicle, and many are in flight at once.
The score is the same. A resident could in principle order food to the
house through the same primitive; it is left unbuilt, because the
shopping trip is traffic and traffic is the game.

### 6.2 A company's turn

A company wakes when an input stock falls to its reorder point — the
`(s, S)` policy of every inventory textbook: order up to `target` when
`level` hits `reorder`, where `reorder` is expected use over the lead time
plus a margin. When one stock triggers, every other stock below its own
target rides along (joint replenishment), which is how a port fills a
ship with everything at once rather than one good per voyage.

The option set is every seller of the good it can reach: posted price,
plus a hauler's quote for the leg, plus the time until it lands. The
**delivered price** is what it compares. "Every call goes through a
warehouse" (`game.md` §Goods) becomes "a buyer takes the cheapest
delivered option": the warehouse wins when it is nearer than the
producer, which is what a warehouse is for, and loses when it is not.

### 6.3 Which job

For Work the resident is the seller. Their options are employers with
vacancies and the edge. The value of a shift is its pay in the numéraire
every resident shares, the edge wage, so

```
score = w_work × hours × (wage / edge_wage) / (commute + hours)
```

A nearby job at four fifths of the edge wage beats the long drive; one at
a third does not. The reservation wage is the commute. Nobody quits when
rich — labour supply is close to inelastic and a game where the wealthy
stop showing up has a mystery in it — so the Work need stays the habit
`residents.md` §3.1 makes it; only *where* is economic.

## 7. Moving goods

An **order** is `(buyer, seller, good, quantity, hauler)`. The hauler's
vehicle has a class and a capacity: a truck one or two boxes, a container
ship many, a tanker and a hopper their own. One order per trip to begin
with; consolidation happens at the buyer through §6.2, not in the
hauler's routing. Multi-drop rounds are filed, not promised.

**The warehouse** is a company with stocks of many goods that buys from
producers and ports and sells locally. **The port** is a company holding
every good its terminals can handle, whose supplier is the sea and whose
lead time is the distance to the sea's edge by water. **Construction** is
unchanged: materials are a good, the construction firm a company, the
site an order (`game.md` §Goods).

## 8. The sea and the edge: the band

This section is not economics. It is the closure, chosen on purpose,
because it is the part every broken game economy got wrong by pretending
to simulate it.

- **The sea sells and buys every good at `sea_price[good]`**, in unlimited
  quantity, with the lead time of the voyage. So no local price exceeds
  the sea's plus the freight in, and none falls below the sea's minus the
  freight out. Every price lives in that band, and the band is a distance.
- **The edge hires everyone at `edge_wage`**, at every exit, forever. So
  no wage falls below it minus the commute, and nobody starves: the drive
  is the price, and it is always payable. Needs served at the edge are
  served at the sea's prices; a resident who cannot pay is served anyway
  and owes nothing, because the floor has to be a floor.

Money is made when a resident is paid at the edge or a good is sold to
the sea; destroyed when a good is bought from it or a need is served
there. The money supply drifts, and every drift ends at a bound with a
name: drain it out and prices fall to floors, wages to the edge, exports
become attractive and it comes back; flood it in and prices rise to the
ceiling and imports become attractive. Single-player is sane because the
sea alone spans the band.

Filed: `sea_price` drifting slowly with the world's net trade, one global
rule, so that a season's meta moves. Not before a season exists.

## 9. Failure, and why it stays legible

A company whose balance reaches zero stops buying. Its shelves empty and
go grey; its wages stop and its vacancies close, so its workers take the
next best score, which is at worst the edge. It does not vanish and it
does not take the building with it. The mayor can put money in (spend, as
for any placement) or demolish. A resident whose wallet is empty works
where the score sends them — the edge always hires — and eats at the edge
until it refills. Nothing propagates through households: consumption is
set by needs and needs do not spiral. That is rule 7 made mechanical.

Emigration (`game.md` §Money, "the floor is emigration") is no longer
needed for the floor and is filed.

## 10. The mayor

Two taxes, no others:

- **A cut of every sale on the mayor's land.** The lump lands on the
  building; the cut steps the meter with the building's address.
- **A cut of every wage paid on the mayor's land.** Today's ledger, in
  money.

Rent is a sale; freight landed in your port is a sale; a wage paid to a
commuter from next door is yours to tax. A warehouse that shortens no
route pays sales tax twice and makes no margin, so it dies, so the mayor
cannot farm hops; a buyer takes the cheapest delivered option and market
discipline does what a rule would. The treasury is spent on buildings
(whose price seeds the company), road past the allowance, and nothing
else; the plant buys its own coal.

Level is unchanged: hours served, banked at `settle()`.

## 11. Legibility

Everything a price does is an event on the map first.

- **The lump.** A `Sale` on the wire: building, amount, the mayor's cut.
  The number floats above the building; the meter steps. A red lump on a
  dock is an import.
- **The building.** Shelves grey at empty stock (built); a yard stacked at
  full output; the inspect panel shows each stock's level, price, and its
  trend over the week.
- **The company.** Revenue, purchases, wages, margin, balance. A refinery
  whose margin has gone negative is a line, not a mystery.
- **The city.** Per need, visits served per day; per good, in and out per
  day. The cinema's decline is a number beside the pump's.
- **The region.** Per good, per city: price, stock, trade. Each row a link
  to the map. Ships leaving a port loaded are the same fact at build zoom.
- **The probe.** A port's price list is a quote. Ship one crate and watch
  what lands.
- **The advisor.** Reads the above and points: "food fetches most in the
  east and your land is flat."

## 12. Tests

Equilibria are asserted, not coded. Each is an `#[ignore]` test in the
manner of `town`, run on a fixed seed over a simulated season.

1. **Entry lowers price.** Fixed population; add farms one at a time. The
   food price falls monotonically to the floor; food sold rises to
   saturation and stops.
2. **Margins compress.** Two refineries earn a lower margin each than one.
3. **A bedroom community.** Town A all homes, town B all jobs: B's wages
   sit above the edge wage while A commutes; homes added to B bring them
   down.
4. **Geography.** Oil under one of two cities. The other imports it; a
   well in the first exports it, and the well's price exceeds the sea's
   minus freight.
5. **The band.** Over a season no price leaves
   `[sea − freight_out, sea + freight_in]` and no wage falls below
   `edge_wage − commute`.
6. **No harm.** A town built ignoring every price ends the season with
   more treasury than it began, and no company founded by placement is
   dry within its first week.
7. **The conga.** A warehouse inserted where it shortens nothing makes no
   margin, dies, and total tax is unchanged.
8. **No ringing.** Price variance at steady state stays under a bound.

## 13. Order to build

Each step is playable and nothing before step 2 can hurt anyone.

1. **Purses and the Sale.** Companies founded with buildings; wallets;
   wages paid; rent charged; the two taxes; the continuous ledger
   replaced by lumps at `settle()`. Every price is the sea's. Money
   exists and nothing floats.
2. **Posted prices.** The nudge (§5.1); `price / earning` in the score
   (§6.1); jobs chosen by wage (§6.3). The band holds by construction.
3. **Freight and classes.** Haulers as companies; box as the first class;
   the port as a company whose supplier is the sea.
4. **The company's turn.** `(s, S)` with joint replenishment; delivered
   price across every reachable seller.
5. **Panels, the board, the advisor's tools.**

## 14. Open

1. `α_up`, `α_down`, and the wage asymmetry, with a referent each.
2. A new company's `earning` before it has a day of revenue — the sea
   price of its output times its rated output is the obvious seed.
3. Household delivery (§6.1) — permitted, unbuilt.
4. `sea_price` drift for seasons (§8).
5. What a resident does with savings beyond "affordable": nothing, until
   something on the map wants it.
6. Liquid and bulk terminals and how scarce coast should be.
