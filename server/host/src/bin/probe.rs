//! Scratch: load a save, run it, and say what stands still.
#[path = "../persistence.rs"]
#[allow(dead_code)]
mod persistence;

use std::collections::HashMap;
use map::tracked::Tracked;
use model::{CarRole, GameObject, DAY_MS};
use sprawl::game::Game;
use sprawl::world::World;

fn main() {
    let path = std::env::args().nth(1).expect("save");
    let hours: u64 = std::env::args().nth(2).map_or(24, |h| h.parse().unwrap());
    let mut db = persistence::Db::open(std::path::Path::new(&path));
    let (entries, meta) = db.load();
    let mut world = World::from_loaded(Tracked::load(entries, meta.next_id), meta.terrain_seed);
    world.gdp = meta.gdp;
    world.treasury = meta.treasury;
    world.market = meta.market;
    world.research = meta.research;
    world.map.terrain = land::terrain::generate(world.map.terrain_seed);
    world.map.deposits = land::terrain::deposits(world.map.terrain_seed, &world.map.terrain);
    world.map.raise_mountains();
    world.map.restore();
    let start = meta.sim_time;
    let mut game = Game::new(world, start, 1, Box::new(World::new));
    let hour = DAY_MS as u64 / 24;
    let minute = hour / 60;
    // car -> (progress, route_index, since)
    let mut still: HashMap<u64, (f64, usize, u64)> = HashMap::new();
    let mut reported: HashMap<u64, u64> = HashMap::new();
    let mut t = start;
    let mut next_hour = start + hour;
    let end = start + hours * hour;
    while t < end {
        t += minute;
        game.run_to(t);
        let now = game.now;
        let w = &game.world;
        for e in w.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            let Some(trip) = &c.trip else { still.remove(&e.id); continue };
            let (p, _) = trip.at(now);
            let s = still.entry(e.id).or_insert((p, trip.route_index, now));
            if (s.0 - p).abs() > 0.01 || s.1 != trip.route_index {
                if let Some(at) = reported.remove(&e.id) {
                    println!("[{:.2}h] UNSTUCK car {} {:?} after {:.2}h standing", (now - start) as f64 / hour as f64, e.id, c.role, (now - s.2) as f64 / hour as f64);
                    let _ = at;
                }
                *s = (p, trip.route_index, now);
            } else if now - s.2 > 2 * hour && !reported.contains_key(&e.id) {
                reported.insert(e.id, now);
                let node = trip.route.get(trip.route_index).copied();
                let desc = |id: u64| -> String {
                    let Some(c) = w.map.car(id) else { return format!("{id}:gone") };
                    match &c.trip {
                        Some(tr) => format!("{id}:{:?} lots {}/{} holds {:?} node {:?}->{:?} ri {}/{} v {:.2} why {:?} wake {:?}", c.role, tr.from_lot, tr.to_lot, w.map.manoeuvres.iter().filter(|(_, (o, _))| *o == id).map(|(n, (_, t))| (*n, (now - t) as i64)).collect::<Vec<_>>(), tr.route.get(tr.route_index.saturating_sub(1)), tr.route.get(tr.route_index), tr.route_index, tr.route.len(), tr.at(now).1, tr.why, game.events.pending(id).map(|t| t as i64 - now as i64)),
                        None => format!("{id}:{:?} parked wake {:?}", c.role, game.events.pending(id).map(|t| t as i64 - now as i64)),
                    }
                };
                if let Some((model::Cause::Junction(n), _)) = trip.why {
                    let (pass, queue) = w.streets.who(n);
                    println!("   junction {n} passing:");
                    for id in pass { println!("     {}", desc(id)); }
                    println!("   queue:");
                    for id in queue { println!("     {}", desc(id)); }
                }
                println!("   self {}", desc(e.id));
                if let Some((model::Cause::Turn(o), _)) = trip.why { println!("   turn-holder {}", desc(o)); }
                for k in 0..3 { if let Some(c) = w.map.car(e.id).and_then(|c| c.trip.as_ref()).and_then(|t| t.why) { let _ = (k, c); } }
                println!("[{:.2}h] STUCK car {} {:?} owner {} to {} at {:?} node {:?} ri {}/{} p {:.2} why {:?} since {:.2}h", (now - start) as f64 / hour as f64, e.id, c.role, c.owner, trip.destination, e.position, node, trip.route_index, trip.route.len(), p, trip.why, (s.2 - start) as f64 / hour as f64);
            }
        }
        if t >= next_hour {
            next_hour += hour;
            let h = (t - start) / hour;
            let mut line = format!("[{h}h]");
            for (id, b) in w.map.of_kinds(|k| matches!(k, model::BuildingKind::Farm | model::BuildingKind::Depot | model::BuildingKind::Bakery)) {
                let s: Vec<String> = b.stocks.iter().filter(|(g, s)| s.level > 0.0 || matches!(g, model::Good::Grain)).map(|(g, s)| format!("{:?}{:.0}", g, s.level)).collect();
                line += &format!(" {:?}{}:{}", b.kind, id, s.join(","));
            }
            println!("{line}");
            let open: Vec<String> = w.calls.iter().map(|c| format!("{:?}@{}{}", c.good, c.at, if c.answered_by.is_some() { "*" } else { "" })).collect();
            println!("   calls {}", open.join(" "));
            let mut fleet = Vec::new();
            for e in w.map.objects.iter() {
                let GameObject::Car(ref c) = e.object else { continue };
                if matches!(c.role, CarRole::Van | CarRole::Truck) {
                    let state = match &c.trip { Some(tr) => format!("->{}", tr.destination), None => format!("@{}", w.map.claims.get(&e.id).copied().unwrap_or(0)) };
                    let load = c.load.map(|(g, u)| format!("{g:?}{u:.0}")).unwrap_or_default();
                    let cargo = if c.cargo.is_empty() { String::new() } else { format!("[{}{:?}]", c.cargo.len(), c.cargo[0].good) };
                    fleet.push(format!("{}{}:{}{}{}", if c.role == CarRole::Van { "v" } else { "L" }, e.id, state, load, cargo));
                }
            }
            println!("   fleet {}", fleet.join(" "));
            for (&h, _) in w.map.harbours.iter() {
                let b = w.map.building(h).unwrap();
                let mut out = std::collections::BTreeMap::new();
                for t in &b.outgoing { *out.entry(format!("{:?}", t.good)).or_insert(0) += 1; }
                let mut pad = std::collections::BTreeMap::new();
                for t in &b.pad { *pad.entry(format!("{:?}{}", t.good, if t.outbound { "^" } else { "v" })).or_insert(0) += 1; }
                let f = w.ferry_of(h).and_then(|f| w.map.car(f));
                println!("   harbour {h} outgoing {:?} pad {:?} quay_room {} ferry moored {:?} deck {} booked {} sold {:.0} bought {:.0}", out, pad, sprawl::haul::quay_room(w, h), f.map(|c| c.spot.is_some()), f.map_or(0, |c| c.deck.iter().flatten().count()), f.map_or(0, |c| c.booked.len()), w.treasury, 0.0);
            }
            for c in w.calls.iter().filter(|c| c.answered_by.is_some_and(|v| w.map.car(v).is_some_and(|car| car.trip.is_none() && w.map.claims.get(&v) == Some(&car.owner)))) {
                let v = c.answered_by.unwrap();
                let car = w.map.car(v).unwrap();
                println!("   loaded-at-home {v} for {:?}@{} raised {:.1}h ago; caller street {:?} kind {:?} site {}; depot street {:?}; wake {:?}", c.good, c.at, (now - c.raised) as f64 / hour as f64, w.map.street_of(c.at), w.map.building(c.at).map(|b| b.kind), w.map.building(c.at).is_some_and(|b| b.site.is_some()), w.map.street_of(car.owner), game.events.pending(v).map(|t| t as i64 - now as i64));
            }
        }
    }
}
