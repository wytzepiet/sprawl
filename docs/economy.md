# Economy: stocks, rows, prices, one purse and one door

Status: specification, drafted 2026-09-09 and reworked twice the same
day: once after an argument about where money goes when nobody spends
it, and again after one about where it comes from. The second rework is
the first rule below — the town has one purse — and everything that
followed from purses went with them (`shelved.md`). Built through the
services of step 5 of §12; §12.2 to §12.5 record what building each step
decided, and wear (step 5's other half) is open (§13.14). Supersedes
`game.md` §Money, which
points here. Builds on `residents.md` (buckets, taps, the
score), `services.md` (calls) and `parking.md` (lots as the place
vehicles stand). The single ledger of hours served that was both level
and money (`xp.rs`) is gone; `shelved.md` has it.

---

## 1. The idea

Eight rules carry it. The first five are economics; the last three are ours.

1. **The town has one purse.** Money enters when the town sells to the
   outside and leaves when it buys from it. Inside, a sale is a line in
   two sets of books and no money moves, because there is nobody else's
   money: residents and buildings post prices and keep books, and the
   town pays.
2. **Everything is a row: stocks in, a stock out.** A building draws
   down its inputs — crates, litres, hours of labour, services — and
   fills its output at a rate. A shop turns crates into meals; a well
   turns labour and services into oil; a house turns meals, fuel,
   evenings and services into hours of labour. Labour is a good like any
   other, made where people live, with one difference the whole game
   rests on: it delivers itself (§5.2). A stock has a cap and drains by
   use, and its deficit is the need. One type; nothing new decides
   anything.
3. **Everyone posts a price and nudges it by their own stock.** Selling out
   → a notch up. Piling up → a notch down. Never below cost. Nobody
   computes a market; every price is local and has memory.
4. **Everyone prices time at what they earn.** A resident's hour is their
   wage; a building's hour is its revenue. So money enters the one score
   `residents.md` already has as hours, and there is still one score.
5. **The edge is the band.** Beyond the edge is a world that runs the
   same rows at capacity and charges a crossing. It sells and buys every
   good at what its rows say, in unlimited quantity, hires everyone at
   one wage, and the drive is the freight. Every local price lives
   between the edge's and the cost of the trip. Nothing can run away,
   and no price is authored: the rows are.
6. **The mayor owns the town.** The mayor placed every building, paid the
   outside for it, and holds the one purse. There are no taxes because
   there is nothing to tax.
7. **Rules come from economics; equilibria are tests; the closure is
   designed.** A rule enters this document if it is a named mechanism with
   a referent in the real economy. What economics predicts (prices fall as
   producers enter, margins compress, wages rise with the commute) is
   asserted by `cargo test`, never coded. Where money enters and leaves
   (§8) is a choice, made on purpose. And every mechanism is the arcade
   version of its referent: one number where the world has a curve, a day
   where the world has a quarter, one door where the world has a globe.
8. **Ignoring prices never hurts; reading them only helps. A town must
   sell something.** A player who places buildings and watches cars must
   be fine, as long as the town has a door: nothing crosses it for a
   town with nothing to pay, and a town that buys more than it sells
   slumps until it does not (§9). Prices are the layer for the player
   who wants to win; the door is the one stake.

Two numbers say how the town is doing, and they are different things.
**GDP** is hours of need served in town, per day: the town's real
income, what economics means by rich, and its running sum is the level
that opens the tree. **The treasury** is what the town has earned from
the outside, net of what the mayor has built with it. A town can be rich
by the first and broke by the second, which is Hume's point (§8.1):
money is not wealth. Only the door moves the treasury, so the game of
the treasury is the game of the door: sell labour and goods out, make in
town what would otherwise be bought in, and spend what that earns on the
rows that do more of both. The point of all of it: a town can
specialise, and specialising in what the outside is short of pays. That
is the game's fantasy the roads alone do not give, and it should fall
out of these rules rather than be added.

## 2. What exists, and what stays

- **Steps 1 to 5, as built** (§12.2 to §12.5): stocks, posted prices,
  the building's turn, the one purse and the door, labour bought on the
  building's turn, services made at the office and drawn by every
  building. All stand.
- **Purses.** Every resident had a wallet and every building a balance;
  each kept a float and swept the rest to the treasury, a resident's
  sweep was rent, and a building whose purse ran dry stopped. Built, run
  for a season, and set aside (`shelved.md`): every internal payment was
  a transfer between two purses of one owner, so the treasury could only
  ever collect the net flow at the door, and forty purses said that
  forty times over — through floats, sweeps, rent and a solvency rule
  whose one visible product was a bar with a full shelf and no money.
  One purse says it once.
- **Calls.** A building whose stock runs low calls; a warehouse's van
  answers, or an office's car, or the edge's (`services.md` §5).

What stays: **level is hours served**, and it is now named for what it
measures (§10). What changes: money stops being anyone's but the town's.

## 3. Actors

**A resident** has a wage and an employer. They sell a shift (§6.3) and
spend at taps that charge (§5), and both are lines in the books: what
they earn is what an hour of their time is worth in the score, and what
they pay is what a building took. Their stocks are their needs, their
car's tank and wear, and their household's food and services.

**A building** has the stocks in it, a posted price for what it fills,
books, and possibly vehicles. It is founded when the mayor places it and
pays the outside for it. It draws its inputs, pays wages, sells its
output; all of it is recorded (§10) and none of it moves money unless it
crosses the door. A building whose books are red does not vanish (§9).
"Company" in this document means a building; a company with two
buildings waits for a reason to exist.

**The mayor** has the treasury (§8.2), the town's one purse. The mayor
never trades; the mayor builds.

**The edge** is the world beyond, with rows of its own that never run
short and prices that do not move (§8.1).

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

**Labour is a good, and a home is its row.** A house turns what its
household consumes into hours of labour, the way a factory turns crates
into goods, and the recipe is already written: `Need::drain` is the
inputs a head a day, from time-use data, and the shift is the output.

| in, a head a day | out |
|---|---|
| a night; about two and a half sittings; an evening; fuel by the tile; services — the upkeep, repairs and everything else a household pays for that is on no shelf | a shift of labour |

The labour stock does not keep: an hour not sold is gone by morning,
which is the one way labour is not coal. The house is where every chain
starts, and it has running costs like a well. Its inputs are fetched by
the household driving to them, which is the delivery for goods served
in person (§6.1), and the score decides when; the row only says how
much. Which is what keeps a street of houses by the exit from being a
mint (§11.12): a household consumes nine tenths of what its labour is
worth (§8.1), and nets the town the rest only when nothing crosses.

**A row with an empty input stops.** A factory with an empty yard does
not run; a household with an empty stock does not work: the Work tap is
closed to a resident whose food, sleep, time off or tank stands at zero,
until it does not. That is the one consequence at zero for a stock that
drains by time, and it is what a holiday is: time off run to nothing,
work off the table, and the score sending them to refill it. A week of
night shifts and long drives ends the same way in a lie-in; illness,
when it comes (step 5), is a sick day by the same rule. Nothing enforces
a recipe; the row stops when it is short, as every row does.

A **good** is a stock that moves. Today: the container and the crate.
Two more come with this document:

- **Services.** An office turns its labour stock into a services stock.
  Every business, and every home, holds a services stock that drains per
  day of operation and calls when low; an office answers with a car, its staff driving out,
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
and it fills them on its turn (§6.2) like any other input: every seller
of labour it can reach, at the delivered price, cheapest first. The
sellers are households — the town's, and the world's beyond the edge —
and each posts an **ask** on its hours and nudges it by its own stock
like any other price: hours sold out, a job held, and the ask drifts up;
hours piling up, no job, and it drifts down, and slowly. Wages are
sticky downward in every labour market ever measured; `α_down` for the
ask is a fraction of `α_up`, and that asymmetry is the one number in this
section with its own referent.

Labour is delivered in person, so the delivered price of a household's
hours is its ask plus the commute spread over the shift, and the resident
drives. A building far from homes finds its near sellers few and its far
ones dear, and pays for the commute through what it pays — compensating
differentials, Rosen (1986) — with no second line for travel and no rule
about distance. The world's households beyond the edge sell at the edge
wage plus the crossing plus the drive from the exit (§8.1), and the
town's sell for no less than the edge would pay them net of the crossing
and their drive out, since below that they sell there instead. Between
those is the band for wages, the same shape as the band for crates.

Employment is a standing relation, derived in the settlement pass. A
building with a full line still reads the market on its turn, and swaps
a worker only for one cheaper delivered by a **hiring threshold**: firms
replace people for a saving of a tenth to a fifth, not for a penny, and
about one in forty jobs turns over in a month. Tenure is then emergent,
and a household whose ask has drifted above its neighbours' is the one
that gets swapped, which is what keeps an ask honest. Nobody quits when
rich — labour supply is close to inelastic — so the Work need stays the
constant habit `residents.md` §3.1 makes it: it is when a resident
leaves the house, and whoever hired them is where.

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
parameter. Nothing is refused for want of money: the town pays, and what
it paid is in the books. What the price does is rank.

That is the whole protocol, and there are no special cases in it. The
party with the deficit scans the sellers it can reach and takes the
cheapest delivered — a resident for a meal, a shop for crates, a factory
for hours, a house for services. Nobody posts a listing and waits for
replies: a listing is a stored intention, and `residents.md` §2 deleted
those so that any wake reads the world and converges on the same
answer. What remains as state is the seller's posted price, which is a
fact about its own stock, and the trip in flight, which is a record of
what is happening.

What varies by good is only the **delivery**: who moves, and in what.

| good | who moves | in what |
|---|---|---|
| a meal, an evening, a tank | the buyer, to the seller | their own car: the visit |
| a crate, a litre | the seller, to the buyer | a van or a lorry: the delivery |
| hours of labour | the seller, to the buyer | their own car: the commute |
| services | the seller, to the buyer | the office's car: the call-out |

The delivery is what the trip on the map is, and the trip on the map is
the game; the rest of the protocol never looks at which row it is. Two
inputs follow from who moves, and they are inputs, not branches.
**Presence:** a mover that goes in person can be in one place, so their
in-person options block each other; a building that dispatches has many
in flight at once. **Travel:** the mover's own drive, or the vehicle's
leg.

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

Deleted: labour is bought on the building's turn like any other input
(§5.2, §6.2). What was here — the resident ranking vacancies by wage
over commute, with a switching threshold — was the same market seen from
the seller's side, and it was the one place the score read a price as a
gain. Its numbers moved to §5.2: the commute in the delivered price, the
threshold to the buyer as a hiring cost.

## 7. Moving goods

A truck carries one load, from the seller to the buyer, and goes home.
**A farm's tractor is its delivery.** A field is a lot the tractor
drives, to seed and to harvest; the farm's row is tractor-hours per
field, and a field the tractor cannot reach in a day yields nothing
that day. Fields too far from the yard, or too many, show as unworked
fields on the map before they show as a number, and the second farm is
the fix. Roads to the fields matter, because the drive is the delivery.
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
- **`edge_price` is not authored.** It is what a row's output is worth
  beyond the edge, where the same rows run at capacity at the edge wage
  of one, link by link along the chain, and every row's output is worth
  more than what went in: **the inputs bought in, plus the labour, plus
  what the row keeps.** For a firm what it keeps is capital's share of
  what labour added, a third — the split of value added between labour
  and capital is among the steadiest numbers in economics — so a firm's
  output is its inputs plus its labour over two thirds. For a household
  what it keeps is its saving, a tenth of income, so a head's labour is
  worth its inputs over nine tenths. A crate is the farm's labour over
  two thirds; a meal is the crate plus the counter's labour over two
  thirds; a shift is a head's night, sittings, evening, fuel and services
  over nine tenths, which is the edge wage of one. Two numbers, each with
  a referent, and every price follows. Plus the **crossing**: a share of
  the value lost each way for carrying it across, the iceberg cost of
  trade theory (Samuelson 1954). The world sells to the town at its price
  plus the crossing and buys at its price less the crossing, labour
  included. Until the chain behind a good has a row in town, its price at
  the edge is a number with the row's name on it (§13.3).
- **The town's money is what its rows keep.** A factory in town pays its
  people the labour share and keeps capital's third on everything it
  makes, less the crossing on what it ships; that is why exporting fills
  the treasury, and why capital is worth placing. A house keeps its
  household's tenth when nothing crosses; a commuter's tenth is eaten by
  the crossing, so a bedroom town nets about nothing. A shop keeps its
  third on the meal it adds to the crate, and what it saves the treasury
  is the crossing on a meal that would otherwise have crossed. The deeper
  the chain in town, the more shares the town keeps: that is
  specialisation paying, from two numbers.
- **The edge hires everyone at `edge_wage`**, at every exit, forever,
  like any good the edge buys without limit. So no wage falls below it
  minus the commute, and a town's people can always sell their hours,
  which is the export of last resort. What the edge sells, a meal, a
  tank, the groceries behind a meal at home, a commuter's shift, it
  sells to a town that can pay: **nothing crosses the door at zero.**
  There is no floor but the town's own shelves, and no mercy; a broke
  town lives on what it holds and what it makes, and its people at the
  edge earning its way back.
- **What nobody in town buys, the edge buys.** A workplace whose output
  has no local buyer sells it at the edge, its truck or its staff driving
  off the map and back. This is what makes offices and factories the
  town's export base before there is a port.
- **The door breaks even, by construction.** A household that buys its
  whole row at the edge and sells its labour there nets the town its
  saving less the crossing, which at a tenth each is nothing. That is not
  a calibration but the household row's own arithmetic: its inputs at
  the world's prices are nine tenths of what its labour sells for. Then
  every net flow through the door is because the town does something
  different from the outside: a row of its own keeps a share, a meal
  served in town keeps the crossing. One check, no mechanism, and a test
  (§11.9).

Money enters when labour or goods are sold at the edge — a resident's
shift there, a lorry leaving loaded; it leaves when they are bought
there — a crate, a litre, a meal — when a commuter from beyond the edge
takes a wage home, and when the mayor builds, since a placement is
materials from beyond the edge. The money supply drifts, and every drift
ends at a bound with a name: drain it out and prices fall to floors,
wages to the edge, exports become attractive and it comes back; flood it
in and prices rise to the ceiling and imports become attractive.

Later, **the port** is a second door with the same prices and cheaper
freight, on a sea that is one connected body so that one price is the
world's. Filed: the world's costs drifting slowly with its net trade,
one global rule, so that a season's meta moves. Not before a season
exists.

### 8.2 One purse

Every sale in town is two lines: revenue on the seller's page, and a
purchase or wages on the buyer's. No money moves, because there is only
the town's, and the town paying itself is a record. The treasury moves
at the door and nowhere else, so it is the town's balance of payments,
cumulative, less what the mayor built with it. This is Hume's specie
stock kept honestly. A shop that sells to its neighbours makes the town
no richer in money, and a meal cooked at home makes it no poorer; what
either does is serve a need, which is GDP (§10). What the shop does for
the treasury is keep in town the meal that would otherwise have been
bought at the edge, and what it costs the treasury is its crates and the
wages that leave with any staff who commute in from beyond it.

What this buys: no taxes, no landlord, no floats, no sweep, no question
of what a resident does with savings, no bankruptcy (§9), and nothing in
the town that can be a sink. A warehouse that shortens no route sells
nothing (§6.2); market discipline does what a rule would. And the
treasury is the one place money accumulates, which is what a budget is.
The mayor spends it on buildings, road past the allowance, and nothing
else.

## 9. Failure, and why it stays legible

A building whose books are red — purchases and wages over revenue, day
after day — does not stop, because the town pays, and the town is what
it costs. Its card says so in one line (§10), and the fix is the
mayor's: demolish it, or build what it is missing. That is what owning
it means. A bar among four on one street costs its crates and the wages
that leave with its commuters, and that is a number beside its two meals
a day; a purse running dry was a bar with a full shelf and nothing to
say. Nothing propagates through households: consumption is set by needs
and needs do not spiral.

The one failure is the town's, and it is a slump, not an end. A
treasury at zero cannot import: shelves and pumps run down and go grey,
commuters stop coming, and the town lives on what it holds and makes.
A sound town bounces in a day, since its exporters keep selling. A town
that eats more than it sells runs its shelves down and its people's
stomachs with them, and a row with an empty input stops (§4) — but the
edge always buys hours, a partial shift on an empty stomach is still
sold when it ends, and every row keeps a share, so the first payday
reopens the door and someone eats. What a deficit town gets is a long,
visible bad time: grey shops, people driving out to work, and a dial
that says how many days of imports are left, in red. That is rule 8
made mechanical, once, with the one stake the game has. A farm makes
the slump shallower still: food grown in town is served without the
door.

Emigration (`game.md` §Money, "the floor is emigration") is no longer
needed for the floor and is filed.

## 10. Legibility

Everything a price does is an event on the map first.

- **The dial.** GDP: hours of need served in town, per day, and the
  level that is its running sum. The treasury, which steps at the door
  and only there: a lorry leaving loaded, a shift worked beyond the
  edge, a placement.
- **The lump.** A `Sale` on the wire: building, amount, when the sale
  ends. The number floats above the building; it is a line in the books
  made visible, and it moves the meter only when the other party is the
  outside. A red lump on a truck in from the edge is an import.
- **The building.** Shelves grey at empty stock (built); a yard stacked at
  full output; the inspect panel shows each stock's level, price, and its
  trend over the week.
- **The company.** Revenue, purchases, wages, margin, and what of each
  crossed the door. A refinery whose margin has gone negative is a
  line, not a mystery.
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
   more treasury than it began, net of what it placed. Every building
   in the red on the last day is printed with what it costs, since that
   is the town's to read, not a failure.
7. **The conga.** A delivery from a depot moves the treasury by nothing,
   and a warehouse inserted where it shortens nothing sells nothing. (A
   property of one delivery, so a unit test, not a season.)
8. **No ringing.** Price variance at steady state stays under a bound.
9. **The door breaks even.** A household that works and consumes only at
   the edge moves the treasury by nothing over a day. (A property of the
   household row, so a unit test, not a season.)
10. ~~**No sinks.**~~ There is nothing outside the treasury to be one.
11. **Tenure.** Over a season the fraction of residents who change jobs in
    a month sits near the referent.
12. **The bedroom town, and the job centre.** A street of houses beside
    the exit and nothing else, its residents commuting to the edge; and
    a street of workplaces and nothing else, staffed from beyond it.
    Each against the full town. Treasury and GDP per resident-day are
    printed for all three. A house nets its household's saving and no
    more, so the bedroom town may not beat the full town by more than
    that, and it is the poorer town by GDP; imported labour pays the
    crossing and the drive, so the job centre earns less than the full
    town.

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
4. **One purse, one protocol.** Wallets, balances, floats, the sweep
   and rent go; the treasury moves at the door; the books carry what a
   purse carried. GDP is value served in town at the world's prices,
   housing included, and the level is its running sum. Labour is bought
   on the building's turn: households post an ask, the edge's at the
   edge wage plus the crossing, and the wage rules of §12.2 go. The
   bedroom town and the job-centre town beside the full one (§11.12).
   §12.4 has what it needs decided.
5. **Services and wear.** The office's stock and its car; the workshop;
   the household's services stock. §12.5 has what services needed
   decided; wear waits (§13.14).
6. **Rows.** Every workplace's inputs, output and rate on its row;
   `edge_price` derived link by link from the rows at capacity, each
   keeping its share, plus the crossing (§8.1); freight as fuel and
   hours per leg. Lands with the farm, the first row with two links
   behind it. Step 4 already prices what exists: a pass-through's hours
   at one over two thirds, and the household at nine tenths of the edge
   wage.
7. **Panels, the board, the advisor's tools.**

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
decision the text left open, or moved one it had made. The float, the
sweep, pass-throughs' purses and the wage rules below are what step 4
removed; they are kept here as the record of what was built and why.

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

- **The cost.** Money is on the score's hot path: a price and an earning
  looked up per option, a sale and a restock check at each visit's end,
  a pass over the staff at midnight. Measured on `how_fast_a_town_runs`
  before and after, the test town runs at the same 0.05 simulated days a
  second, with a few percent more wakes for the jobs the new rows add.
  Step 3's delivered-price search and step 4's services land on the same
  path; run that gauge before and after each, and `bun run profile` if
  it moves.

What running the season found, and did not fix: a shop needs about
forty meals a day to carry two staff at the edge's wage, which is a
district, not a street. The wage cut keeps such a shop alive at a wage
its trade is worth, staffed from beyond the edge; whether that is the
game, or shops should be smaller, is open (§13.7).

### 12.3 Step 3, as built

The building's turn is `calls::cheapest_seller`; the numbers are in
`economy.rs` with the rest.

- **The delivered price is the score.** Every seller fills the order
  alike, so §6.1's score ranks them by its denominator alone: the time
  until the load lands, plus the order at the posted price in hours of
  the buyer's own earning. A depot's van is an option while the depot
  has the good on its shelf and a van standing free; the outside always
  is, by a lorry that drives in from the nearest exit at the edge's
  wholesale. A van loads as it leaves — what the shelf has, up to the
  order — and the load rides on the call; the money moves when it
  lands, and the buyer looks at its shelf again then, since a load
  short of the order or a long lead leaves it under the reorder point.
  Reading the depot's shelf at landing instead let two vans promise the
  same crates, and the second landed empty-handed at a shelf that,
  selling nothing, never called again. The nearest-depot search, and
  its waiting for a van to come home, are gone: a buyer whose depot is
  busy buys from beyond the edge, at the drive's cost.
- **A building's earning** is yesterday's takings over the day; before
  it has a day of them, what the edge would pay for everything it could
  sell (§13.3, resolved as it suggested).
- **A depot posts a price on its shelf**, nudged like any other. It
  opens at the edge's wholesale, which is its floor, so a depot that
  saves nobody a drive sells nothing and sweeps nothing (§11.7). What it
  could sell in a day, for selling out and piling up, is its shelf
  turned once. Its wages stay the treasury's: the row answers calls,
  and §8.2's special case is about who answers, not who sells.
- **`(s, S)`.** The shelf is `S`. The reorder point is what the taps
  could sell during the lead time — the last delivery's, from the call
  to the load landing; before the first, as long as a lorry is away
  beyond the edge — plus a full house, everyone the taps seat at once,
  so a rush during the lead does not empty the shelf. Half the shelf,
  which it replaces, sent a supermarket for stock with seventy meals on
  the shelf and a shop next door to a depot with twenty.
- **Freight is the drive** (§5.3), in the buyer's time, and nothing is
  charged for it in money: the van's fuel and its driver's hours are
  the depot's, as they were. The band a depot can price in is what its
  customers' hours are worth over the drive it saves, which is the
  argument for a road.

### 12.4 Step 4, to the number, and as built

Built 2026-09-10. The decisions the mechanism did not make on its own,
and what running it found.

- **A placement is an import.** The building's price goes to the edge,
  and no longer includes a float, since there is none to open with.
  The rows' prices come down by the float they carried.
- **Earnings stay what they were.** A resident prices money in their
  wage and a building in yesterday's takings (§6.1, §12.3); both are
  lines in the books, not purses.
- **Wages at the door.** A resident's shift beyond the edge brings the
  edge wage in; a commuter's shift in town takes the town's wage out. A
  resident's shift in town moves nothing.
- **Goods at the door.** A delivery from beyond the edge costs the
  treasury the load at the edge's wholesale; a fetch, the same; a load
  sold to the edge earns it. A delivery from a depot moves nothing and
  is two lines.
- **A meal at the edge** costs the treasury the edge's price; a meal at
  home costs its groceries, which are the edge's until something in
  town delivers them (§12.2). Nothing else a resident buys moves money.
- **The treasury can go to zero and no lower.** An import the treasury
  cannot pay for does not happen; a resident at the edge is served
  regardless (§8.1).
- **The wage rules of §12.2 go** — the cut to what an hour brings in,
  the rise for a desk the edge filled, the floor. Each was a proxy for
  something the market now does: the crossing and the commute price
  imported labour, the ask prices the town's, and a building whose hours
  cost more than they bring in is in the red on its card (§9).
- **The ask does not nudge yet.** A household's hours are all sold the
  day it holds a job, so "selling out" is every day it is employed and
  the ratchet never stops: an ask rising five percent a day is swapped
  out within the week, falls back at one percent a day, and the tenure
  season becomes a churn. What selling out means for a person — more
  buyers than shifts — needs the market to show it, and that is open
  (§13.11). Until then the ask is the reservation: the edge wage net of
  the crossing for the town's households, plus it for the world's, and
  the delivered price differs by the commute alone.
- **The stake.** A fresh town starts with a hundred hours in the
  treasury, the floats its buildings used to open with in one place, so
  that it can import until its first shift is sold.
- **A commuter unpaid.** An import the treasury cannot cover is paid as
  far as it goes, a commuter's wage included: the shortfall is a line in
  the building's books and the commuter comes back tomorrow. What a
  town that cannot pay its imported labour should do about it is open.

- **GDP at the world's prices.** A need served in town banks its units
  times `edge_price` for that unit, the edge's excluded; a night is the
  household row's upkeep, about a third of a day's wage a head until the
  row says otherwise (§13.10). The level thresholds are retuned to the
  new scale.
- **The crossing is a tenth** (§13.8) until a season says otherwise.

What running the first cut found. Ten days of the full town, the
bedroom town and the job centre (§11.12), with the world pricing
everything at the cost of its inputs and the household drawing housing
alone: the full town and the job centre sat at zero from the first day,
and the bedroom town netted six hours a head a day. The mint was the
household row four hours short of its own labour's worth; and a world
priced at cost leaves a town nothing but the crossing, twice, against
it — the old design hid the same fact by seeding every purse and
pricing a meal for the ladder. What closed it is §8.1's two shares:
every row's output is worth its inputs plus what the row keeps, and
the town's money is what its rows keep. As built:

- **A pass-through's hours** sell to the edge at one over two thirds
  an hour, less the crossing: capital's third on labour that made
  nothing else. GDP banks the hours at the world's price.
- **The household draws nine tenths of the edge wage a day** at the
  world's prices: a night at a third of a day's wage, sittings and an
  evening at the table's prices, transport at its budget sixth, and
  services as the rest, about 2.4 hours a head a day, imported with the
  night's upkeep until an office in town makes them. Fuel is what the
  car burns; the sixth is the row's estimate of it, and the check holds
  in the broad lines, which is what it is for.
- **An empty stock closes the Work tap** (§4). The wake budget held at
  36 a resident-day on the first day and 20 after, and tenure stayed at
  zero changes.
- **Nothing crosses the door at zero**, and there is no floor. A meal
  beyond the edge, the groceries behind one at home and a commuter's
  shift are options only while the treasury can pay for them; the first
  cut served a broke town's people for free, which was the one mercy in
  the model and inconsistent with its crates. A dead state — nothing at
  the door and nobody fit to work — was built and taken out again: a
  town with anyone fit to work bootstraps, since a partial shift on an
  empty stomach is still sold and labour is the export of last resort,
  so it was a corner reachable only by construction. Zero is a slump.
  The dial shows days of imports left, red under three.
- **The stake is five hundred**, a few weeks of a starting town's
  imports. The first cut started at a hundred, gone at the first
  midnight; a treasury at zero cannot import fuel, a dry tank closes the
  Work tap, and the whole town spent its days driving to the edge for
  fuel instead of working. A season places forty buildings at once, so
  it is given a week of its households' row as working capital and
  measured from there.
- **The season town is shaped like a town** — mostly homes, an export
  base with about as many desks as the homes have people, one of each
  shop — where before it cycled every kind equally, seventeen shops,
  bars, supermarkets and warehouses for 177 people. Ten days of it:
  the treasury climbs about fifteen a day on a door of seven hundred
  each way; every office, factory and workshop is in the black by
  twenty-five to thirty a day, every shop, bar, supermarket and
  warehouse in the red, as §9 says they should be; and desks are worked
  about six hours of nine, the rest lost to commutes across a
  170-tile street, which is traffic's to fix. The bedroom town nets
  about one a head a day, its households' saving, where the first cut
  netted six; the full town nets about one too, its exporters' shares
  less what its twenty shop workers cost, and three times the GDP a
  head; the job centre, staffed from an exit four hours away, loses
  one and a quarter a head a day to the crossing and the drive.


### 12.5 Step 5, services, to the number and as built

Built 2026-09-10; wear and the workshop wait (§13.14). The decisions
the mechanism did not make on its own, and what running it found.

- **Services is a good like the others, keyed with them.** `Services`
  stands beside the meal, the evening, the tank and the hour in `Need`;
  no tap serves it and no resident carries it, so the search never sees
  it: a building's alone, delivered by a call. A building's stocks are
  a map by good — its shelf, and its services — so the building's turn
  (§6.2) runs over every stock alike and a call carries the good.
- **The unit is an hour of the office's make**, and its price at the
  edge is what an hour of labour makes: the hour and the services a firm
  buys in for it, over two thirds (§8.1). Every firm's row now has that
  one input, a fifth of an hour's worth for each hour of labour
  (purchased services against the wage bill, about a fifth in
  input-output tables), so a pass-through's hour is worth 1.8 where it
  was 1.5, and the town keeps its third on the services too. The office
  makes a unit an hour, prices its shelf like a depot, opens at the
  edge's price, and its floor is what the edge pays for a unit, since it
  can always ship one there.
- **The draw.** A home draws a head's share a day for each head under
  its roof: the household row's balance after the table, the evening
  and the car — the night's upkeep, repairs and the rest, about 4.9
  hours a head at the world's prices, which is the night's third and
  §12.4's balance in one stock; the two imports at midnight are gone.
  A firm draws a fifth of an hour's worth for each hour its desks could
  work, a fact about the row, staffed or not. The stock drains as time
  passes, like a tank: at every look at the building — a tab paid there,
  a delivery landed, midnight — what the row used since the last look
  comes off. A stock holds two days of it, so a building calls about
  every other day, as a shop's shelf does, and the reorder point is the
  draw over the lead. Two cuts came before this one. A week's cover,
  drawn at midnight in one lump: forty buildings founded together order
  the same day, the offices have shipped their shelves to the edge by
  then, and the town buys the week from consultants, losing the
  crossing twice on what it makes itself. Two days' cover, still at
  midnight: every building calls at the same instant, the office's one
  car takes one order and the edge the other thirty-six, the failed
  ones are picked up by the hourly retry as the car frees, so who
  bought from the office was a matter of timing and its price rang;
  and forty consultants at once at one entry is a jam.
- **A night served is the household's services**, banked as GDP as
  they are drawn, for what the stock had, whoever made it. A firm's
  draw is a line and no GDP: intermediate. Services land on a home's
  stock and bank when drawn, not when they land, as a meal at home
  banks when eaten and not when the groceries come. An empty stock
  serves nothing: the hours are not banked, and the building is grey.
  Nothing stops for it — §4's list stands — since an office short of
  services would otherwise stop making them, and a broke town with one
  office would never start.
- **The office answers with its car**, a facility vehicle like a depot's
  van; from beyond the edge a consultant drives in in one, at the
  edge's price plus the crossing, while the treasury can pay. A depot's
  fetch and a maker's shipment are one kind of call, a trip past the
  edge by the building's own vehicle: a shelf run full ships the lot,
  since the edge buys without limit, the car is paid when it is home,
  and a shipment is no sale for the nudge — nobody in town bought it,
  which is piling up, so an office nobody buys from drifts to the floor
  and its town's buyers find it before the consultant. A shelf that
  stood full at the last look ships, before the office's own draw is
  taken off it. A row never calls for what its own labour makes.
  `answers` left the row: a kind with a shelf and vehicles is a depot,
  and `makes` says whose labour fills the shelf.
- **Everyone prices money in their row.** A home's earning came out as
  nothing — its wages are booked where its people work — so every
  delivered price was infinite and the consultant from the edge won
  every order. A home prices money in its household's shifts, eight
  hours a head at the edge's wage; a pass-through in its hours over two
  thirds; a shop in its counter, as before: the row's output at capacity
  at the world's prices, until it has a day of takings.
- **Founded full**, like a shelf: a placed home has two days of
  services in hand it did not pay for, as a placed shop has a full
  shelf.
- **A call nothing could answer is tried again in an hour.** Before, an
  open call was tried again only when another call was raised or a
  vehicle came home. A home calls at midnight with the household's car
  in the driveway and nothing can pull in; a street of homes raises no
  other call and owns no vehicle, so the bedroom town sat ten days with
  forty calls open and every home dry. The retry is a wake that is
  nobody's, like midnight.

What running it found, ten days of the three towns of §11.12 (`DAYS=10
cargo test season -- --ignored --nocapture`), against §12.4's ten:

- **The full town** nets about two a head a day where it netted one,
  and its GDP is 11.3 a head a day where it was 9.9: the night is worth
  its services now, a firm's hour is worth 1.8, and what the offices sell
  in town no longer crosses the door twice. The door alternates days —
  about 130 out one day and 1,080 the next — because forty buildings
  founded in one minute run their two days of services down together;
  the offices' cars make about sixty-five call-outs a day between them
  and ship to the edge twice or so, and consultants take the rest. Every
  office, factory and workshop is in the black on most days and in the
  red on the day its services land, since a firm buys two days of them
  at once against a day's takings; the shops, bars, supermarket and
  warehouse are in the red as before, a little deeper for their draw.
  Desks are worked six to eight hours of nine, as before; the wake
  budget holds at 28 the first day and 17 to 21 after; tenure stays at
  zero changes.
- **The offices' price runs to the ceiling.** Three offices make about
  two hundred units a day and the town draws about four hundred, so
  each shelf empties most days, each price steps up from 1.75 to 2.03
  or 2.14 in ten days, and over the edge's delivered 1.98 the marginal
  buyer takes a consultant: the price sits a notch over the edge's and
  a notch under, which is where a scarce good sits, and the fourth
  office is the mayor's to place. The ring test reads the last third of
  a season as its steady state and allows a price pinned to the band's
  edge its one notch up and back.
- **The bedroom town** nets 1.7 a head a day where it netted 1.19 — its
  homes are founded with two days of services in hand — and its GDP is
  4.8 a head a day where it was 2.8. It is served entirely by
  consultants, about 1,900 out on the days they come; it stays under
  the full town's rate plus the saving, and the poorer town by GDP.
- **The job centre** loses 1.5 a head a day where it lost 1.3: its firms
  now draw services too, from consultants at the crossing, and its
  fourteen offices ship everything they make to the edge, since nobody
  in a town of desks is home to buy it.
- **Two things the season found and this step fixed** are recorded above
  with their bullets: a home priced money in nothing and always bought
  from the edge; and an unanswered call was never tried again.


## 13. Open

1. ~~`α_up`, `α_down`, and the wage asymmetry, with a referent each.~~ §12.2.
2. ~~The switching threshold's value.~~ §12.2; now the hiring threshold, §5.2.
3. ~~A new building's `earning` before it has a day of revenue.~~ §12.3.
4. Household delivery (§6.1) — permitted, unbuilt. Until then a meal at
   home is groceries from the edge (§12.2).
5. `edge_price` drift for seasons (§8.1).
6. How scarce coast should be, when the port comes.
7. Shop labour against shop trade (§12.2): fewer staff per shop, shorter
   shifts, or a town whose shops are meant to fail until it has a
   district — and the price of a meal against the ladder, which §12.2
   settled by making a sitting worth an hour. Under one purse this is a
   cost the town carries, not a failure (§9); whether the cost is right
   is the open part.
8. The crossing's value (§8.1), with a referent: iceberg estimates for
   trade costs run from a tenth to a half of value; a border between a
   town and its region is the low end.
9. ~~Productivity per workplace row.~~ Capital's share of what labour
   adds, a third, on every firm's row (§8.1); rows the town runs better
   than the world wait for the tree.
10. ~~The household's services rate.~~ The balance of the row at nine
    tenths of the edge wage (§8.1, §12.4).
11. What selling out means for a household's hours, so that the ask can
    nudge (§12.4).
12. ~~Where the town's money comes from in a world priced at cost.~~
    What its rows keep: capital's third, the household's tenth (§8.1).
13. The household row's transport is a budget sixth, and its services
    the balance; the car burns what it burns. With freight (§12 step 6)
    the row's transport becomes the fuel the commute costs, per tile at
    the world's price, services get their own share, and the door's
    check (§11.9) becomes a season print. Until then a household nets a
    little over its tenth when it drives less than the sixth, which is
    the bedroom town's 1.19 against 0.72 (§12.4).
14. Wear (§4): a car's second per-tile stock, the workshop as its tap.
    Step 5's other half; services went first because the office was
    already a row with nothing to sell.
15. A firm's services are a fifth of its labour and its output the sum
    over two thirds (§12.5); with the rows (step 6) the input and the
    output are the row's own, link by link, and the fifth goes.
