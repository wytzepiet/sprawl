use crate::car::spawn::start_trip;
use crate::car::CRUISE_SPEED;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::blueprint::blueprint;
use crate::economy;
use crate::needs::{Bucket, Need, Tap};
use crate::world::pathfinding::Routes;
use crate::protocol::{BuildingKind, ChunkCoord, EntityId, GameObject, GridCoord, Resident, DAY_MS};
use crate::world::World;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BinaryHeap, HashMap};

/// Real roads bend; the crow does not. Straight-line travel time is scaled up
/// by this before promising to be anywhere. Being systematically a little
/// early beats being systematically late for reasons that are nobody's fault.
const DETOUR: f64 = 1.4;

/// How long to sit on a failed departure — a blocked driveway, a severed road —
/// before looking again.
const RETRY_MS: u64 = 10_000;

/// How many arrivals it takes for the learned delay to mostly forget the
/// old ones.


/// Who is at, or on their way to, each building for each need. Counted
/// fresh at every wake from what residents are doing — a claim is being
/// present or being en route, so there is nothing to release.
type Crowd = HashMap<(EntityId, Need), u32>;

/// One resident thinking, as docs/residents.md specifies. Reads the clock and
/// the world, brings what they owe up to date, scores every place that could
/// serve any of it, and either goes to the best one or stays — scheduling
/// the earliest moment that answer could change. Carries no memory of why it
/// was woken: any wake, at any time, converges on the same behaviour.
pub fn handle_resident_wake(
    world: &mut World,
    events: &mut EventQueue,
    id: EntityId,
    now: GameTime,
) {
    let Some(r) = resident(world, id).cloned() else { return };

    // Off-map: someone who has not driven in yet. They enter the way
    // everyone enters — by road, in at the nearest road exit, car and all.
    let Some(mut at) = r.at else {
        let entry = position_of(world, r.home)
            .and_then(|(x, y)| world.entry_node_near(crate::protocol::GridCoord { x, y }));
        let started = match entry {
            Some(node) => start_trip(world, events, r.car, node, r.home, now, GameTime::MAX),
            None => false,
        };
        if !started {
            events.wake(RETRY_MS, id);
        }
        return;
    };

    // Riding: the trip's arrival is what wakes us next, not the clock.
    if matches!(world.objects.get(at).map(|e| &e.object), Some(GameObject::Car(_))) {
        return;
    }

    // Standing somewhere that no longer exists — a demolished workplace, a
    // save that outlived its car. Home is where you are when the world has
    // moved on; if home is gone too, settle is about to take us with it.
    if world.objects.get(at).is_none() {
        if world.objects.get(r.home).is_none() {
            return;
        }
        at = r.home;
    }

    let crowd = headcount(world);
    settle(world, id, at, now, &crowd);
    let Some(r) = resident(world, id).cloned() else { return };
    let mut buckets = buckets(world, &r);
    let mut routes = routes_from(world, at);
    let verdicts = verdicts(world, &r, id, &buckets, at, now, &crowd, &mut routes);
    drop(routes);

    // The note the demand readout reads: how far short of being served on
    // the spot each need fell — one where nothing was found at all.
    for (b, v) in buckets.iter_mut().zip(&verdicts) {
        b.shortfall = match *v {
            Verdict::Nothing => 1.0,
            Verdict::Go { score, .. } => {
                let ideal = b.need.ceiling(b.stock.short());
                if ideal > 0.0 { (1.0 - score / ideal).clamp(0.0, 1.0) } else { 0.0 }
            }
        };
    }
    store(world, id, r.car, &buckets);

    // Actionable: can be set out for now, or is right here — where waiting
    // for it to open is the action. Waiting for somewhere else is not; that
    // time goes to the best thing that can be started, and the departure
    // becomes an alarm.
    let best = verdicts
        .iter()
        .enumerate()
        .filter_map(|(i, v)| match *v {
            Verdict::Go { score, departure, leave, building, .. }
                if departure == now || building == at =>
            {
                Some((i, score, departure, leave, building))
            }
            _ => None,
        })
        // Strictly better wins, so ties fall to the earlier bucket.
        .fold(None, |best: Option<(usize, f64, GameTime, GameTime, EntityId)>, o| match best {
            Some((_, s, ..)) if s >= o.1 => best,
            _ => Some(o),
        });

    // When could the answer change? When the choice is due to set out, or
    // runs out (it empties, or its tap closes); when another is due to set
    // out; or when a bucket left behind has grown enough to outrank the
    // choice.
    let score = best.map_or(0.0, |(_, s, ..)| s);
    let mut alarm = best.map_or(GameTime::MAX, |(_, _, d, l, _)| if d > now { d } else { l });
    for (i, v) in verdicts.iter().enumerate() {
        if Some(i) == best.map(|(b, ..)| b) {
            continue;
        }
        let b = &buckets[i];
        alarm = alarm.min(match *v {
            Verdict::Go { departure, .. } if departure > now => departure.min(overtake(b, v, score, now)),
            _ => overtake(b, v, score, now),
        });
    }

    let Some((i, _, departure, leave, there)) = best else {
        // Nothing to do anywhere, and nothing to wait for. Look again in a
        // while: a world with nothing on offer is the unmet-demand case, and
        // it is not this resident's to solve.
        set_selected(world, events, id, None, now);
        events.wake(RETRY_MS, id);
        return;
    };
    set_selected(world, events, id, Some(buckets[i].need), now);
    // Not yet time to set out, or already there: stay put. Staying restates
    // how long the car's spot is held.
    if at == there {
        world.restate(r.car, leave.saturating_add(crate::world::lots::SLACK));
    }
    if departure > now || at == there {
        events.wake(alarm.max(now) - now, id);
        return;
    }
    // Leaving ends the visit here, whatever the next one is for.
    pay_the_tab(world, events, id, at, now);
    if !drive(world, events, r.car, at, there, now, leave) {
        events.wake(RETRY_MS, id);
    }
}

/// Everything a resident weighs: their own buckets, and their car's tank,
/// which they drive and so decide for. In one list, in one order, so an
/// index into the verdicts is an index into this.
fn buckets(world: &World, r: &Resident) -> Vec<Bucket> {
    let mut all = r.buckets.clone();
    if let Some(GameObject::Car(c)) = world.objects.get(r.car).map(|e| &e.object) {
        all.push(Bucket { need: Need::Fuel, stock: c.fuel, shortfall: 0.0 });
    }
    all
}

/// Put the buckets back where each lives: the person's on the person, the
/// tank on the car.
fn store(world: &mut World, id: EntityId, car: EntityId, buckets: &[Bucket]) {
    if let Some(GameObject::Resident(me)) = world.objects.get_mut(id).map(|e| &mut e.object) {
        me.buckets = buckets.iter().filter(|b| b.need != Need::Fuel).cloned().collect();
    }
    if let Some(tank) = buckets.iter().find(|b| b.need == Need::Fuel)
        && let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object)
    {
        c.fuel = tank.stock;
    }
}

/// One verdict per bucket: the best any of its candidates offers.
fn verdicts(world: &World, r: &Resident, id: EntityId, buckets: &[Bucket], at: EntityId, now: GameTime, crowd: &Crowd, routes: &mut Option<Routes>) -> Vec<Verdict> {
    // Money enters as time: what they make an hour is what an hour of it
    // costs them.
    let earning = economy::earning(world, id);
    buckets
        .iter()
        .map(|b| match b.need {
            Need::Work => r.work.map_or(Verdict::Nothing, |w| verdict_at(world, r, earning, at, b, w, now, crowd, routes, true)),
            Need::Rest | Need::Home => verdict_at(world, r, earning, at, b, r.home, now, crowd, routes, true),
            Need::Eat | Need::Leisure | Need::Fuel => search(world, r, earning, at, b, now, crowd, routes),
        })
        .collect()
}

/// The ways out from where a resident stands, searched once for the whole
/// decision. `None` where no road reaches the building.
fn routes_from(world: &World, at: EntityId) -> Option<Routes<'_>> {
    world.road_node_for_building(at).map(|node| Routes::from(world, node))
}

/// The best one place offers a bucket, through any of its taps for the need.
fn verdict_at(
    world: &World,
    r: &Resident,
    earning: f64,
    at: EntityId,
    b: &Bucket,
    building: EntityId,
    now: GameTime,
    crowd: &Crowd,
    routes: &mut Option<Routes>,
    exact: bool,
) -> Verdict {
    // Everyone else there or on the way, plus this resident. The count is a
    // snapshot taken before anyone moved, so it can disagree with `mine`
    // about whether this resident is among them — take them out if they are
    // there to take out.
    let mine = (at == building && r.selected == Some(b.need)) as u32;
    let seen = crowd.get(&(building, b.need)).copied().unwrap_or(0);
    let company = seen.saturating_sub(mine) + 1;
    let tau = if at == building {
        0
    } else if exact {
        travel_ms(world, routes, at, building)
    } else {
        crow_flies_ms(world, at, building)
    };
    // A shift is sold, not bought, and once taken it is the constant
    // habit: whoever hired them is where.
    let price = if b.need == Need::Work { 0.0 } else { economy::price_of(world, building, b.need) };
    let cost = Cost { price, earning };
    taps_of(world, building)
        .iter()
        .filter(|t| t.need == b.need)
        .map(|t| evaluate(world, r.car, at, building, t, b, now, company, tau, exact, cost))
        .fold(Verdict::Nothing, Verdict::better)
}

/// What a visit costs: the posted price per unit of the need, and what an
/// hour of money is worth to whoever pays it.
#[derive(Clone, Copy)]
struct Cost {
    price: f64,
    earning: f64,
}

/// The best of whatever is around, found the way a search finds anything
/// dear to look at closely: every candidate is scored on what is cheap to
/// know — where it stands, as the crow flies, with room for everyone — and
/// only the leader is asked what it really costs: the route as the roads
/// have been giving it, whether a road reaches it at all, how many can park
/// and when. Every real answer can only lower a score, so once the leader
/// is exact, nothing under it can catch up. A resident weighing a town
/// pays for one or two real answers, not one per shop. A verdict is a
/// bucket's own best, whatever the other buckets scored: the alarms and
/// the notes read it as such.
fn search(world: &World, r: &Resident, earning: f64, at: EntityId, b: &Bucket, now: GameTime, crowd: &Crowd, routes: &mut Option<Routes>) -> Verdict {
    let need = b.need;
    let mut heap: BinaryHeap<Candidate> = world
        .revealed
        .iter()
        .flat_map(|&c| world.buildings_in(c))
        // The edge stands beyond the survey, so it is in no revealed chunk,
        // and it is what makes a need with nothing in town answerable at all.
        .chain(world.edge.iter().copied())
        // A home's kitchen is its residents' alone.
        .filter(|&id| id == r.home || kind(world, id).is_some_and(|k| blueprint(k).homes == 0))
        // Empty shelves sell nothing.
        .filter(|&id| crate::calls::stocked(world, id))
        // No road, no visit. Without this a building the road never reached
        // is scored on the crow-flies estimate — which, having no route to
        // lengthen it, comes out *cheaper* than anywhere real — so it wins,
        // the drive is refused, and the search picks it again every retry.
        .filter(|&id| world.road_node_for_building(id).is_some())
        .filter(|&id| taps_of(world, id).iter().any(|t| t.need == need))
        .filter_map(|id| Candidate::new(id, false, verdict_at(world, r, earning, at, b, id, now, crowd, routes, false)))
        .collect();
    while let Some(top) = heap.pop() {
        if top.exact {
            return top.verdict;
        }
        heap.extend(Candidate::new(top.id, true, verdict_at(world, r, earning, at, b, top.id, now, crowd, routes, true)));
    }
    Verdict::Nothing
}

/// A building in the running, by the score it has so far. The best score
/// first; at a tie the exact one, since the estimate cannot beat it; then
/// by id, so a town decides the same way however its chunks iterate.
struct Candidate {
    score: f64,
    exact: bool,
    id: EntityId,
    verdict: Verdict,
}

impl Candidate {
    fn new(id: EntityId, exact: bool, verdict: Verdict) -> Option<Candidate> {
        match verdict {
            Verdict::Go { score, .. } => Some(Candidate { score, exact, id, verdict }),
            Verdict::Nothing => None,
        }
    }
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .total_cmp(&other.score)
            .then(self.exact.cmp(&other.exact))
            .then(other.id.cmp(&self.id))
    }
}


/// What one place offers one bucket.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "verdict")]
enum Verdict {
    /// How much, per unit of time from now until the visit is over; when to
    /// set out — now, or later so as to arrive as it opens; and when the
    /// visit would be over, the earlier of the bucket emptying and the tap
    /// closing.
    Go {
        score: f64,
        departure: GameTime,
        leave: GameTime,
        building: EntityId,
        /// Time from now until service, in ms: the wait, the journey, the
        /// overhead. What a fuller bucket cannot shorten.
        fixed: f64,
        rate: f64,
        /// How much of the level the visit would serve. Less than all of it
        /// means the tap closes first, and a fuller bucket scores no better.
        drained: f64,
    },
    Nothing,
}

impl Verdict {
    fn better(self, other: Verdict) -> Verdict {
        match (self, other) {
            (Verdict::Go { score: a, .. }, Verdict::Go { score: b, .. }) if b > a => other,
            (Verdict::Nothing, _) => other,
            _ => self,
        }
    }
}

/// Section 4.1: score one (bucket, tap) pair over the visit it would get,
/// counted from now — so a wait for the tap to open costs what it costs.
/// Nobody sets out early to wait somewhere else, but someone already there
/// is scored on waiting honestly, and does not go home for five minutes.
/// Money enters as time: the visit's price in hours of the resident's own
/// wage is added to the visit (docs/economy.md §6.1, Becker 1965).
fn evaluate(
    world: &World,
    car: EntityId,
    at: EntityId,
    building: EntityId,
    tap: &Tap,
    bucket: &Bucket,
    now: GameTime,
    company: u32,
    tau: GameTime,
    exact: bool,
    cost: Cost,
) -> Verdict {
    let h = tap.overhead;
    // An estimate has room for everyone; the real lot decides otherwise.
    let rate = tap.serving(if exact { slots_at(world, building, tap) } else { u32::MAX }, company);
    // The visit as the tap allows it; then, going there for it, as the lot
    // allows it: if no spot is clear for the whole visit from when the car
    // would arrive, the earliest gap is when to arrive instead, and the
    // visit is planned again from there. Waiting for a spot is waiting,
    // the same as waiting for the tap to open.
    let plan = |arrive: GameTime| -> Option<(GameTime, GameTime, f64, GameTime)> {
        let opening = tap.curve.next_nonzero(arrive + h)?;
        let departure = (opening - h - tau).max(now);
        let entry = departure + tau + h;
        let dry = tap.curve.next_zero(entry);
        let available = tap.curve.integral(entry, dry);
        if available <= 0.0 {
            return None;
        }
        let drained = if rate.is_finite() { bucket.stock.short().min(rate * available) } else { bucket.stock.short() };
        // Less than a millisecond owed is nothing: the clock cannot tell.
        if drained < 1.0 {
            return None;
        }
        let leave = if rate.is_finite() {
            tap.curve.advance(entry, drained / rate).unwrap_or(dry as f64)
        } else {
            entry as f64
        };
        Some((departure, (leave.ceil() as GameTime).min(dry), drained, entry))
    };
    let Some(mut planned) = plan(now + tau) else { return Verdict::Nothing };
    if exact && at != building && tap.need != Need::Work {
        let (_, leave, _, entry) = planned;
        if let Some(t) = world.spot_window(building, car, entry - h, leave.saturating_add(crate::world::lots::SLACK))
            && t > entry - h
        {
            // A lot held by cars that have not said when they leave frees
            // never, as far as anyone can plan: no visit, not a visit at
            // the end of time.
            if t == GameTime::MAX {
                return Verdict::Nothing;
            }
            planned = match plan(t) {
                Some(p) => p,
                None => return Verdict::Nothing,
            };
        }
    }
    let (departure, leave, drained, entry) = planned;
    // The visit's price, in the resident's own hours, in milliseconds.
    let money = cost.price * drained / bucket.need.unit();
    let priced = money / cost.earning * HOUR;
    let score = bucket.stock.weight() * drained / ((leave - now) as f64 + priced);
    Verdict::Go {
        score,
        departure,
        leave,
        building,
        fixed: (entry - now) as f64 + priced,
        rate,
        drained,
    }
}

/// Section 4.2: the earliest a bucket left behind could outrank the choice.
///
/// Its level grows linearly while it is not served, and its score with it:
/// `(L / cap) * L / (fixed + L / r)`, when the whole level would be served.
/// Setting that equal to the choice's score is a quadratic in `L`, so the
/// level it overtakes at is closed-form, and the time to reach it follows.
/// A bucket with no option at all is bounded by its ceiling instead. One
/// that cannot grow, would need more than its cap, or whose tap closes
/// before the level is served, never overtakes by level. One already past
/// the crossing is not overtaking anything by growing: it is waiting on its
/// departure, or on the world to offer it something, and those wake it. One
/// sitting exactly on it has tied and lost to an earlier bucket, and wins a
/// millisecond on.
fn overtake(b: &Bucket, v: &Verdict, score: f64, now: GameTime) -> GameTime {
    if b.need.drain() == 0.0 {
        return GameTime::MAX;
    }
    let cap = b.need.cap();
    let short = b.stock.short();
    let target = match *v {
        Verdict::Go { drained, .. } if drained < short => return GameTime::MAX,
        Verdict::Go { fixed, rate, .. } => {
            // L^2 / cap = score * (fixed + L / rate)
            let half_b = score * cap / rate / 2.0;
            let c = score * cap * fixed;
            half_b + (half_b * half_b + c).sqrt()
        }
        Verdict::Nothing => match b.need.short_for(score) {
            Some(short) => short,
            None => return GameTime::MAX,
        },
    };
    if target >= cap || target < short {
        return GameTime::MAX;
    }
    now + ((target - short) / b.need.drain()).ceil().max(1.0) as GameTime
}

/// Section 4.3: bring the stocks up to date. The one being served refills
/// by what its tap offered since the last look and drains only for the
/// part it did not; every other one drains the whole interval. A constant
/// need is constant: it neither refills nor drains. A driven need drains at
/// the end of a trip, in `drove`, and refills like any other.
///
/// What was served goes on the tab, to be paid as one lump when the visit
/// ends, and on GDP at the world's price for it: value the town made.
/// The edge's is some other town's.
fn settle(world: &mut World, id: EntityId, at: EntityId, now: GameTime, crowd: &Crowd) {
    let Some(r) = resident(world, id) else { return };
    let (last, selected) = (r.last_update, r.selected);
    let elapsed = (now - last) as f64;
    let serving: Option<(f64, f64)> = selected.and_then(|need| {
        let company = crowd.get(&(at, need)).copied().unwrap_or(0).max(1);
        taps_of(world, at)
            .iter()
            .find(|t| t.need == need)
            .map(|t| (t.serving(slots_at(world, at, t), company), t.curve.integral(last, now)))
    });
    // What the building put out is what it put out, whether or not the
    // stock had room for it: a shift worked is labour received.
    if let (Some(need), Some((rate, served))) = (selected, serving)
        && served > 0.0
    {
        let out = rate * served;
        *world.books.entry(at).or_default().today(now).served.entry(need).or_default() += out / HOUR;
        if !world.edge.contains(&at)
            && let Some(k) = kind(world, at)
        {
            world.gdp += out / need.unit() * economy::value(k, need);
        }
        if let Some(r) = resident_mut(world, id) {
            r.tab += out / need.unit();
        }
    }
    let Some(r) = resident(world, id).cloned() else { return };
    let mut buckets = buckets(world, &r);
    for b in &mut buckets {
        if b.need.constant() {
            continue;
        }
        let (served, rate) = match serving {
            Some((rate, served)) if Some(b.need) == selected => (served, rate),
            _ => (0.0, 0.0),
        };
        let idle = elapsed - served;
        b.stock.add(rate * served);
        b.stock.take(b.need.drain() * idle);
    }
    store(world, id, r.car, &buckets);
    if let Some(r) = resident_mut(world, id) {
        r.last_update = now;
    }
}

/// Who is where, for what: present and selected, or aboard a car bound
/// there. One pass over everyone.
fn headcount(world: &World) -> Crowd {
    let mut crowd = Crowd::new();
    for id in world.resident_ids() {
        let Some(r) = resident(world, id) else { continue };
        let (Some(at), Some(need)) = (r.at, r.selected) else { continue };
        let place = match world.objects.get(at).map(|e| &e.object) {
            Some(GameObject::Building(_)) => at,
            Some(GameObject::Car(c)) => match &c.trip {
                Some(t) => t.destination,
                None => continue,
            },
            _ => continue,
        };
        *crowd.entry((place, need)).or_default() += 1;
    }
    crowd
}

impl Tap {
    /// The rate each of `company` present is served at: full up to the
    /// slots, then shared.
    fn serving(&self, slots: u32, company: u32) -> f64 {
        self.rate * (slots as f64 / company.max(1) as f64).min(1.0)
    }
}

/// What a tap serves at once. At a building with a lot, a visitor's tap
/// serves as many as can park: the lot decides. Anywhere else, and for
/// the staff, the row's number.
fn slots_at(world: &World, building: EntityId, tap: &Tap) -> u32 {
    match world.spots_at(building) {
        Some(n) if tap.need != Need::Work => n,
        _ => tap.slots,
    }
}

/// Pull out of one building's driveway toward another's.
fn drive(
    world: &mut World,
    events: &mut EventQueue,
    car: EntityId,
    from_building: EntityId,
    dest_building: EntityId,
    now: GameTime,
    until: GameTime,
) -> bool {
    match world.road_node_for_building(from_building) {
        Some(node) => start_trip(world, events, car, node, dest_building, now, until),
        None => false,
    }
}

/// The readout the whole system exists for, printed as a trip ends: how the
/// arrival compares to the shift, and to the free-flow promise made at
/// departure. People leave on time under free-flow assumptions, so both
/// numbers worsening together is a direct measurement of congestion on the
/// roads they actually drove.
pub fn arrival_readout(world: &mut World, id: EntityId, destination: EntityId, eta: GameTime, now: GameTime) {
    if let Some(r) = resident(world, id)
        && r.work == Some(destination)
        && let Some(open) = taps_of(world, destination)
            .iter()
            .find(|t| t.need == Need::Work)
            .and_then(|t| t.curve.next_nonzero(0))
    {
        let day = DAY_MS as i64;
        let mut diff = (time_of_day(now) as i64 - open as i64).rem_euclid(day);
        if diff > day / 2 {
            diff -= day;
        }
        let word = if diff > 0 { "late" } else { "early" };
        let lost = now.saturating_sub(eta) / 1000;
        println!(
            "commute: resident {id} at work {}s {word}, {lost}s lost to traffic",
            (diff / 1000).abs()
        );
    }
}

/// The arithmetic, made visible: what one resident owes, and what every
/// option scores right now. The model's failure mode is quiet, and this is
/// the only way to watch it think. Read-only — the buckets are shown as they
/// stood at the last wake, not settled.
pub fn inspect(world: &World, id: EntityId, now: GameTime) -> Value {
    let Some(r) = resident(world, id) else { return json!({ "error": "no such resident" }) };
    let Some(at) = r.at else { return json!({ "id": id, "at": null, "note": "off-map" }) };
    let crowd = headcount(world);
    let buckets = buckets(world, r);
    let verdicts = verdicts(world, r, id, &buckets, at, now, &crowd, &mut routes_from(world, at));
    json!({
        "id": id,
        "now": hhmm(now),
        "at": at,
        "at_kind": whereabouts(world, at),
        "home": r.home,
        "work": r.work,
        "selected": r.selected,
        "last_update": hhmm(r.last_update),
        "wage": r.wage,
        "earning": economy::earning(world, id),
        "buckets": buckets.iter().zip(&verdicts).map(|(b, v)| json!({
            "need": b.need,
            "short_h": b.stock.short() / HOUR,
            "full": b.stock.weight(),
            "option": v.describe(now),
        })).collect::<Vec<_>>(),
    })
}

/// Everyone, one line each: where they are and what they are doing.
pub fn inspect_all(world: &World, now: GameTime) -> Value {
    let mut rows: Vec<Value> = world
        .resident_ids()
        .into_iter()
        .filter_map(|id| resident(world, id).map(|r| (id, r)))
        .map(|(id, r)| json!({
            "id": id,
            "at": r.at,
            "at_kind": r.at.map(|a| whereabouts(world, a)),
            "selected": r.selected,
            "short_h": buckets(world, r).iter().map(|b| (format!("{:?}", b.need), b.stock.short() / HOUR)).collect::<std::collections::BTreeMap<_, _>>(),
        }))
        .collect();
    rows.sort_by_key(|v| v["id"].as_u64());
    json!({ "now": hhmm(now), "residents": rows })
}

/// One resident's note on one need, as left by their last wake: where they
/// live, how far short of being served it fell, and how much that weighs —
/// the need's fullness times the shortfall. Someone without a job wants one
/// outright. Read from the notes; nobody is asked to think again.
struct Want {
    home: GridCoord,
    need: Need,
    shortfall: f64,
    weight: f64,
}

fn wants(world: &World) -> impl Iterator<Item = Want> + '_ {
    world.resident_ids().into_iter().filter_map(|id| resident(world, id)).flat_map(|r| {
        let home = world.objects.get(r.home).and_then(|e| e.position);
        let jobless = r.work.is_none();
        r.at.and(home).into_iter().flat_map(move |home| {
            r.buckets.iter().filter_map(move |b| {
                let (shortfall, weight) = if b.need.drain() > 0.0 {
                    (b.shortfall, b.stock.weight() * b.shortfall)
                } else if b.need == Need::Work && jobless {
                    (1.0, 1.0)
                } else {
                    (0.0, 0.0)
                };
                (weight > 0.0).then_some(Want { home, need: b.need, shortfall, weight })
            })
        })
    })
}

/// Who found nothing at all, by home chunk: how many, and how badly. What
/// the demand readout names as missing; a shop that is merely far or full
/// weighs on `pressure` without showing up here.
pub fn unmet(world: &World) -> HashMap<(ChunkCoord, Need), (u32, f64)> {
    let mut unmet: HashMap<(ChunkCoord, Need), (u32, f64)> = HashMap::new();
    for w in wants(world).filter(|w| w.shortfall >= 1.0) {
        let e = unmet.entry((crate::world::chunk_of(w.home), w.need)).or_default();
        e.0 += 1;
        e.1 += w.weight;
    }
    unmet
}

pub fn demand(world: &World, now: GameTime) -> Value {
    let unmet = unmet(world);
    let mut unmet: Vec<Value> = unmet
        .into_iter()
        .map(|((c, need), (people, pressure))| {
            json!({ "chunk": [c.cx, c.cy], "need": need, "people": people, "pressure": pressure })
        })
        .collect();
    unmet.sort_by_key(|v| (v["chunk"].to_string(), v["need"].to_string()));

    let mut delivered: Vec<Value> = world
        .books
        .iter()
        .flat_map(|(&building, k)| {
            let (today, yesterday) = (k.on(now), k.before(now));
            let needs: std::collections::BTreeSet<Need> = today.served.keys().chain(yesterday.served.keys()).copied().collect();
            needs.into_iter().map(move |need| {
                json!({
                    "building": building,
                    "kind": whereabouts(world, building),
                    "need": need,
                    "today_h": today.served.get(&need).copied().unwrap_or(0.0),
                    "yesterday_h": yesterday.served.get(&need).copied().unwrap_or(0.0),
                })
            }).collect::<Vec<_>>()
        })
        .collect();
    delivered.sort_by_key(|v| (v["building"].as_u64(), v["need"].to_string()));
    json!({ "now": hhmm(now), "unmet": unmet, "delivered": delivered })
}

impl Verdict {
    fn describe(&self, now: GameTime) -> Value {
        match *self {
            Verdict::Go { score, departure, leave, building, rate, .. } => json!({
                "building": building,
                "rate": rate,
                "score": score,
                "departure": hhmm(departure),
                "wait_h": (departure - now) as f64 / HOUR,
                "leave": hhmm(leave),
            }),
            Verdict::Nothing => json!("nothing"),
        }
    }
}

/// What kind of place `at` is — a building by kind, or the car.
fn whereabouts(world: &World, at: EntityId) -> String {
    match world.objects.get(at).map(|e| &e.object) {
        Some(GameObject::Building(b)) => format!("{:?}", b.kind),
        Some(GameObject::Car(_)) => "Car".into(),
        _ => "gone".into(),
    }
}

const HOUR: f64 = (DAY_MS / 24) as f64;

/// Clock time, with the day in front when it is not today's.
fn hhmm(t: GameTime) -> String {
    let day = t / DAY_MS as u64;
    let tod = time_of_day(t) as f64 / HOUR;
    format!("d{day} {:02}:{:02}", tod as u32, ((tod % 1.0) * 60.0) as u32)
}

fn resident(world: &World, id: EntityId) -> Option<&Resident> {
    match world.objects.get(id)?.object {
        GameObject::Resident(ref r) => Some(r),
        _ => None,
    }
}

fn resident_mut(world: &mut World, id: EntityId) -> Option<&mut Resident> {
    match world.objects.get_mut(id)?.object {
        GameObject::Resident(ref mut r) => Some(r),
        _ => None,
    }
}

/// A trip's end: what it burned comes off the tank.
pub fn drove(world: &mut World, car: EntityId, tiles: f64) {
    if let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object) {
        c.fuel.take(tiles * Need::per_tile());
    }
}

/// Step out somewhere. The time up to now was spent wherever they were —
/// in the car, served nothing — and is settled as such before the place
/// changes, or the drive would count as a visit. Leaving ends the visit,
/// and the visit is paid for as it ends.
pub fn set_at(world: &mut World, events: &mut EventQueue, id: EntityId, place: EntityId, now: GameTime) {
    if let Some(from) = resident(world, id).and_then(|r| r.at) {
        let crowd = headcount(world);
        settle(world, id, from, now, &crowd);
        pay_the_tab(world, events, id, from, now);
    }
    if let Some(r) = resident_mut(world, id) {
        r.at = Some(place);
    }
}

/// Turn to something else where they stand: the visit so far is over, and
/// paid for.
fn set_selected(world: &mut World, events: &mut EventQueue, id: EntityId, need: Option<Need>, now: GameTime) {
    if let Some(r) = resident(world, id)
        && r.selected != need
        && let Some(at) = r.at
    {
        pay_the_tab(world, events, id, at, now);
    }
    if let Some(r) = resident_mut(world, id) {
        r.selected = need;
    }
}

/// The lump: one visit, one sale. docs/economy.md §12.1.
fn pay_the_tab(world: &mut World, events: &mut EventQueue, id: EntityId, at: EntityId, now: GameTime) {
    let Some(r) = resident_mut(world, id) else { return };
    let (Some(need), tab) = (r.selected, std::mem::take(&mut r.tab)) else { return };
    if tab > 0.0 && matches!(world.objects.get(at).map(|e| &e.object), Some(GameObject::Building(_))) {
        economy::sale(world, id, at, need, tab, now);
        crate::calls::restock(world, events, at, now);
    }
}

fn kind(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

fn taps_of(world: &World, building: EntityId) -> &'static [Tap] {
    kind(world, building).map_or(&[], |k| &blueprint(k).taps)
}

/// Travel time between two buildings in game milliseconds: the quickest
/// route as the roads have been giving it, plus the crawl through the lots
/// at either end. Where no road joins them, as the crow flies with the
/// detour factor.
fn travel_ms(world: &World, routes: &mut Option<Routes>, from: EntityId, to: EntityId) -> GameTime {
    if let (Some(routes), Some(b)) = (routes.as_mut(), world.road_node_for_building(to))
        && let Some(ms) = routes.cost_to(b)
    {
        return (ms + LOT_MS) as GameTime;
    }
    let dist = match (position_of(world, from), position_of(world, to)) {
        (Some(a), Some(b)) => (a.0 - b.0).abs().max((a.1 - b.1).abs()) as f64,
        _ => 0.0,
    };
    (dist / CRUISE_SPEED * DETOUR * 1000.0) as GameTime
}

/// The least a trip between two buildings could take: as the crow flies at
/// the cruising speed, with nothing in the way. No route is shorter, so a
/// score built on it is one the real route can only lower.
fn crow_flies_ms(world: &World, from: EntityId, to: EntityId) -> GameTime {
    match (position_of(world, from), position_of(world, to)) {
        (Some(a), Some(b)) => {
            let (dx, dy) = ((a.0 - b.0) as f64, (a.1 - b.1) as f64);
            ((dx * dx + dy * dy).sqrt() / CRUISE_SPEED * 1000.0) as GameTime
        }
        _ => 0,
    }
}

/// The lot at either end of a trip: about a tile of ring each, at a crawl.
const LOT_MS: f64 = 2.0 / crate::car::LOT_SPEED * 1000.0;

fn position_of(world: &World, id: EntityId) -> Option<(i32, i32)> {
    world.objects.get(id)?.position.map(|p| (p.x, p.y))
}

fn time_of_day(now: GameTime) -> u32 {
    (now % DAY_MS as u64) as u32
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::protocol::{GridCoord, TerrainType};

    /// Not an assertion: what one cheap evaluation costs, for whoever is
    /// sizing a survey over many tiles. `cargo test --release how_dear_an_estimate_is -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn how_dear_an_estimate_is() {
        let mut world = World::new();
        for y in -6..6 {
            for x in -4..40 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..38).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        let home = world.place_on_street(GridCoord { x: 0, y: 1 }, BuildingKind::House).unwrap();
        let shop = world.place_on_street(GridCoord { x: 20, y: 1 }, BuildingKind::Shop).unwrap();
        world.settle();
        let id = world.resident_ids()[0];
        let r = resident(&world, id).unwrap().clone();
        let b = r.buckets.iter().find(|b| b.need == Need::Eat).unwrap().clone();
        let tap = taps_of(&world, shop).iter().find(|t| t.need == Need::Eat).unwrap();
        let n = 200_000u32;
        let started = std::time::Instant::now();
        let mut hits = 0u32;
        for i in 0..n {
            let now = (i as u64 * 977) % DAY_MS as u64;
            let mut bucket = b.clone();
            bucket.stock.take((i % 100) as f64 * 1000.0);
            let cost = Cost { price: 0.5, earning: 1.0 };
            if let Verdict::Go { .. } = evaluate(&world, r.car, home, shop, tap, &bucket, now, 1, 60_000, false, cost) {
                hits += 1;
            }
        }
        let per = started.elapsed().as_nanos() as f64 / n as f64;
        eprintln!("{n} estimates, {hits} of them a visit: {per:.0} ns each");
    }
}
