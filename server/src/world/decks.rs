//! Roads above the ground: overpasses, and the slopes up to them.
//!
//! A road node has a height in half-levels (`RoadNode::height`): 0 the
//! ground, 2 a level up, 4 two, 6 three. An odd height is a slope, a tile
//! whose road climbs from the level below at the edge it comes in by to
//! the one above at the edge it goes out by: one arm down and one up,
//! straight on or round a bend, and nothing else joins it. Links join nodes of the
//! same even height, a slope to the level at either end of it, or a slope
//! to the next slope on, so a road climbs several levels over as many
//! tiles, on and on.
//!
//! Several nodes may stand on one tile, as long as each is a level clear of
//! the others: a slope counts as the levels at both its ends. So a slope
//! from the first level to the second may pass over a ground road, and a
//! slope from the ground may not. Links crossing on the diagonal, between
//! tiles, cross over each other a level apart; within a level, they cross
//! at the corner, and their cars take turns there (`World::crossing_of`).
//!
//! Two one-ways may share a tile side by side, as roads share it stacked:
//! each a node of its own, moved a little to one side of the tile's middle
//! (`RoadNode::side`), a thin road beside the other: across the way they
//! run, straight on; round a bend, the one inside it and the other out.
//! A one-way running through a tile moves over when another is laid
//! beside it, and back when that one goes. A road on a side is joined
//! along its run, one way, to the road on its own side or the middle; or,
//! straight on, from its own side, a road merging into it or branching off
//! it; never from the other side, which the road beside it is in the way
//! of.
//!
//! The ground's middle nodes are `roads`, as they always were, and
//! everything the town does with a tile's road is theirs. The rest, above
//! the ground or beside the middle, are `decks`.

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode, TerrainType};

use super::World;

/// The highest a road stands: three levels up.
pub const TOP: u8 = 6;

/// Which side of its tile a node stands: the step across its road it is
/// moved by; `MIDDLE`, not moved.
pub type Side = [i8; 2];
pub const MIDDLE: Side = [0, 0];

/// How far from its tile's middle a node on a side stands, in tiles.
pub const SIDE_OFFSET: f64 = 0.17;

/// How far a step goes toward a side: positive toward it, zero across it,
/// along the run of a road on that side.
pub(crate) fn toward((dx, dy): (i32, i32), side: Side) -> i32 {
    dx * side[0] as i32 + dy * side[1] as i32
}

/// The other side.
pub fn other(side: Side) -> Side {
    [-side[0], -side[1]]
}

/// The way across a road through a tile by these arms (each the step to
/// its next tile): across the way from the one's edge to the other's,
/// straight on or round a bend; one arm, across it. In small whole steps,
/// either way round.
pub(crate) fn across(arms: &[(i32, i32)]) -> Option<Side> {
    let (x, y) = match arms {
        [a] => (-a.1, a.0),
        [a, b] => (-(b.1 - a.1), b.0 - a.0),
        _ => return None,
    };
    let g = gcd(x.abs(), y.abs()).max(1);
    Some([(x / g) as i8, (y / g) as i8])
}

fn gcd(a: i32, b: i32) -> i32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Crossings' ids (`World::crossing_of`): apart from every entity's.
pub const CROSSINGS: EntityId = 1 << 62;

/// How far apart two nodes on one tile must stand: a level, and a level
/// more for each that is a slope, which reaches up or down half of one.
fn clearance(a: u8, b: u8) -> u8 {
    2 + a % 2 + b % 2
}

impl World {
    /// The middle road node on a tile at a height.
    pub fn node_at(&self, coord: GridCoord, height: u8) -> Option<EntityId> {
        self.node_in(coord, height, MIDDLE)
    }

    /// The road node on a tile at a height and side.
    pub fn node_in(&self, coord: GridCoord, height: u8, side: Side) -> Option<EntityId> {
        if height == 0 && side == MIDDLE {
            return self.road_node_at(coord);
        }
        self.decks.get(&(coord.x, coord.y))?.iter().copied().find(|&id| self.height_of(id) == height && self.side_of(id) == side)
    }

    /// Every road node on a tile, and how high it stands.
    pub fn nodes_on(&self, coord: GridCoord) -> Vec<(u8, EntityId)> {
        let mut out: Vec<(u8, EntityId)> = self.road_node_at(coord).map(|g| (0, g)).into_iter().collect();
        out.extend(self.decks.get(&(coord.x, coord.y)).into_iter().flatten().map(|&id| (self.height_of(id), id)));
        out
    }

    pub fn height_of(&self, id: EntityId) -> u8 {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::RoadNode(n)) => n.height,
            _ => 0,
        }
    }

    pub fn side_of(&self, id: EntityId) -> Side {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::RoadNode(n)) => n.side,
            _ => MIDDLE,
        }
    }

    /// Is there room on this tile for a road at this height and side: its
    /// own node there already, or every other a level clear of it, or at
    /// its height on the other side; and above the ground, nothing built
    /// under it and no mountain. A middle node that would move over to
    /// make room (`moves_over`) is not in the way.
    pub fn room_at(&self, coord: GridCoord, height: u8, side: Side) -> bool {
        if self.node_in(coord, height, side).is_some() {
            return true;
        }
        if height > 0 && (self.occupied.contains_key(&(coord.x, coord.y)) || self.terrain.get(&(coord.x, coord.y)) == Some(&TerrainType::Mountain)) {
            return false;
        }
        self.nodes_on(coord).into_iter().all(|(h, id)| {
            let beside = side != MIDDLE && h == height && (self.side_of(id) == other(side) || Some(id) == self.moves_over(coord, height, side));
            beside || h.abs_diff(height) >= clearance(h, height)
        })
    }

    /// The middle node on a tile that moves over to the other side when a
    /// node is laid on this one: a one-way running straight through, or
    /// ending, along the run across the side, with one lane.
    pub fn moves_over(&self, coord: GridCoord, height: u8, side: Side) -> Option<EntityId> {
        if side == MIDDLE || self.node_in(coord, height, other(side)).is_some() {
            return None;
        }
        let id = self.node_at(coord, height)?;
        let mut arms = self.arms_of(id, false);
        arms.sort_unstable();
        arms.dedup();
        let one_lane = arms.iter().all(|&n| (self.edges.contains_key(&(id, n)) != self.edges.contains_key(&(n, id))) && !self.is_wide(id, n) && !self.is_wide(n, id));
        let way = across(&self.steps_to(id, &arms)?)?;
        (one_lane && (side == way || side == other(way))).then_some(id)
    }

    /// The steps from a node to each of these, by their tiles.
    pub(crate) fn steps_to(&self, id: EntityId, arms: &[EntityId]) -> Option<Vec<(i32, i32)>> {
        let at = self.objects.get(id)?.position?;
        arms.iter().map(|&n| self.objects.get(n)?.position.map(|p| (p.x - at.x, p.y - at.y))).collect()
    }

    /// The run a road on this side of a tile follows round a bend: the
    /// steps of the road beside it, or of the one that moves over for it,
    /// where those bend. Straight on, none: its run is across its side.
    fn bend_of(&self, coord: GridCoord, height: u8, side: Side) -> Option<Vec<(i32, i32)>> {
        let beside = self.node_in(coord, height, other(side)).or_else(|| self.moves_over(coord, height, side))?;
        let mut arms = self.arms_of(beside, false);
        arms.sort_unstable();
        arms.dedup();
        let steps = self.steps_to(beside, &arms)?;
        match steps.as_slice() {
            [a, b] if (a.0 + b.0, a.1 + b.1) != (0, 0) => Some(steps),
            _ => None,
        }
    }

    /// A node moved to another side of its tile, or back to its middle, its
    /// links with it: indexed where it now stands, and its edges as long as
    /// they now are.
    pub(super) fn move_to(&mut self, id: EntityId, side: Side) {
        let Some(at) = self.objects.get(id).and_then(|e| e.position) else { return };
        let was = self.side_of(id);
        let height = self.height_of(id);
        if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            n.side = side;
        }
        if height == 0 && was == MIDDLE {
            self.roads.remove(&(at.x, at.y));
            self.decks.entry((at.x, at.y)).or_default().push(id);
        } else if height == 0 && side == MIDDLE {
            if let Some(v) = self.decks.get_mut(&(at.x, at.y)) {
                v.retain(|&n| n != id);
            }
            self.roads.insert((at.x, at.y), id);
        }
        for (a, b) in self.edges_involving(id) {
            let len = self.segment_length(a, b);
            if let Some(seg) = self.edges.get_mut(&(a, b)) {
                seg.length = len;
            }
        }
    }

    /// A road on a side with nothing beside it any more goes back to the
    /// middle of its tile.
    pub(super) fn settle_sides(&mut self, coord: GridCoord) {
        for (h, id) in self.nodes_on(coord) {
            let side = self.side_of(id);
            if side != MIDDLE && self.node_in(coord, h, other(side)).is_none() && self.node_at(coord, h).is_none() {
                self.move_to(id, MIDDLE);
            }
        }
    }

    /// Lay a road node on a tile at a height and side, or find the one
    /// there; a one-way in the middle there moves over to the other side.
    /// The mayor's.
    pub(super) fn place_node_of(&mut self, coord: GridCoord, height: u8, side: Side, road: bool) -> EntityId {
        if height == 0 && side == MIDDLE {
            return self.place_ground(coord, road);
        }
        if let Some(id) = self.node_in(coord, height, side) {
            return id;
        }
        if let Some(beside) = self.moves_over(coord, height, side) {
            self.move_to(beside, other(side));
        }
        let id = self.insert_at(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![], joined: false, road, laid: true, height, light: None, wide: vec![], side, banned: vec![] }),
            Some(coord),
        );
        self.decks.entry((coord.x, coord.y)).or_default().push(id);
        self.laid += 1;
        self.unsettle_round(coord);
        id
    }

    /// May a road be laid from one tile at one height and side to the next
    /// at another: the ground's rule (`may_lay`) where both ends are in the
    /// ground's middles.
    pub fn may_lay_at(&self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, one_way: bool) -> bool {
        self.may_lay_at_on(from, hf, sf, to, ht, st, one_way, None)
    }

    /// `may_lay_at`, a drag going on from `to` that way, if it does
    /// (`World::leads_nowhere`).
    #[allow(clippy::too_many_arguments)]
    pub fn may_lay_at_on(&self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, one_way: bool, goes_on: Option<(i32, i32)>) -> bool {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 || hf > TOP || ht > TOP {
            return false;
        }
        let middles = sf == MIDDLE && st == MIDDLE;
        // On the ground, the ground's rule, and a slope's clearance over it.
        if hf == 0 && ht == 0 && middles {
            return self.may_lay_on(from, to, one_way, goes_on) && self.room_at(from, 0, MIDDLE) && self.room_at(to, 0, MIDDLE);
        }
        // Level, a slope's end, or one slope on to the next; never a
        // level's jump.
        let on = hf % 2 == 1 && ht % 2 == 1 && hf.abs_diff(ht) == 2;
        if (hf.abs_diff(ht) > 1 && !on) || (hf == ht && hf % 2 == 1) {
            return false;
        }
        if !self.room_at(from, hf, sf) || !self.room_at(to, ht, st) {
            return false;
        }
        // A road on a side: along its run one way, on to the road on its
        // own side or the middle, not across to the other; or, straight
        // on, out toward its side: a road joining it, or a one-way come in
        // from that side to turn and run on beside the other.
        for (at, h, side, way, there) in [(from, hf, sf, (dx, dy), st), (to, ht, st, (-dx, -dy), sf)] {
            if side == MIDDLE {
                continue;
            }
            let bend = self.bend_of(at, h, side);
            let along = bend.as_ref().map_or(toward(way, side) == 0, |steps| steps.contains(&way));
            if along {
                let crossed = there != MIDDLE && toward((there[0] as i32, there[1] as i32), side) <= 0;
                if !one_way || crossed {
                    return false;
                }
            } else if bend.is_some() || toward(way, side) < 0 || (!one_way && self.node_in(at, h, side).is_none()) || self.node_in(at, h, side).is_some_and(|id| self.unique_connection_count(id) > 2) {
                // Off its run, a road on a side takes one road joining it,
                // and that one ends there: nothing crosses the two.
                return false;
            }
        }
        // Where an end is on the ground, it is the ground's: not into a
        // building, not over water.
        for (t, h) in [(from, hf), (to, ht)] {
            let wet = matches!(self.terrain.get(&(t.x, t.y)), Some(TerrainType::Water | TerrainType::Sea | TerrainType::Beach | TerrainType::Mountain));
            if h == 0 && ((wet && self.road_node_at(t).is_none()) || self.occupied.contains_key(&(t.x, t.y))) {
                return false;
            }
        }
        if self.link_between_at(from, hf, sf, to, ht, st).is_some() {
            return false;
        }
        // A slope runs straight through: one arm down, one up.
        if !self.slope_takes(from, hf, sf, (dx, dy), ht) || !self.slope_takes(to, ht, st, (-dx, -dy), hf) {
            return false;
        }
        !self.node_in(from, hf, sf).is_some_and(|id| self.leads_nowhere(id, (dx, dy), !one_way, true, None))
            && !self.node_in(to, ht, st).is_some_and(|id| self.leads_nowhere(id, (-dx, -dy), true, !one_way, goes_on))
    }

    /// Would a slope here take an arm this way to a node at `other`: it has
    /// none yet, or the one it has is at the other end of the climb; it
    /// may bend, as any road may. Not a slope, anything may join it.
    fn slope_takes(&self, at: GridCoord, height: u8, side: Side, way: (i32, i32), other: u8) -> bool {
        if height % 2 == 0 {
            return true;
        }
        let Some(id) = self.node_in(at, height, side) else { return true };
        let arms = self.arms_of(id, false);
        let mut unique: Vec<EntityId> = arms.clone();
        unique.sort_unstable();
        unique.dedup();
        match unique.as_slice() {
            [] => true,
            [arm] => {
                let Some(p) = self.objects.get(*arm).and_then(|e| e.position) else { return false };
                (p.x - at.x, p.y - at.y) != way && self.height_of(*arm) != other
            }
            _ => false,
        }
    }

    /// Where the diagonal link between two nodes crosses one on the other
    /// diagonal, within a level of it: the crossing, which cars on either
    /// take turns at as at a junction (`car::simulation`'s gates), known by
    /// the corner they cross over and the lower of their heights there. A
    /// link a level clear of the other passes over it.
    pub fn crossing_of(&self, a: EntityId, b: EntityId) -> Option<EntityId> {
        let (p, q) = (self.objects.get(a)?.position?, self.objects.get(b)?.position?);
        let (dx, dy) = (q.x - p.x, q.y - p.y);
        if dx.abs() != 1 || dy.abs() != 1 {
            return None;
        }
        let twice = self.height_of(a) + self.height_of(b);
        let (c, d) = (GridCoord { x: p.x + dx, y: p.y }, GridCoord { x: p.x, y: p.y + dy });
        let other = self.nodes_on(c).into_iter().flat_map(|(hc, nc)| self.nodes_on(d).into_iter().map(move |(hd, nd)| (hc + hd, nc, nd))).find(|&(sum, nc, nd)| (self.edges.contains_key(&(nc, nd)) || self.edges.contains_key(&(nd, nc))) && sum.abs_diff(twice) < 4)?;
        let (x, y) = (p.x.min(q.x) as i64 + (1 << 20), p.y.min(q.y) as i64 + (1 << 20));
        Some(CROSSINGS | ((x as u64) << 30) | ((y as u64) << 8) | twice.min(other.0) as u64)
    }

    /// Lay a road from one tile at one height and side to the next at
    /// another, its edges with it. Unchecked: `may_lay_at` says whether it
    /// may be.
    #[allow(clippy::too_many_arguments)]
    pub fn place_road_at(&mut self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, one_way: bool, road: bool) {
        let a = self.place_node_of(from, hf, sf, road);
        let b = self.place_node_of(to, ht, st, road);
        if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(a).map(|e| &mut e.object)
            && !n.outgoing.contains(&b)
        {
            n.outgoing.push(b);
        }
        if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(b).map(|e| &mut e.object) {
            if one_way {
                if !n.incoming.contains(&a) {
                    n.incoming.push(a);
                }
            } else if !n.outgoing.contains(&a) {
                n.outgoing.push(a);
            }
        }
        if !self.edges.contains_key(&(a, b)) {
            self.insert_edge(a, b);
        }
        if !one_way && !self.edges.contains_key(&(b, a)) {
            self.insert_edge(b, a);
        }
    }

    /// The road joining two tiles at these heights and sides, if any: its
    /// two nodes.
    pub fn link_between_at(&self, a: GridCoord, ha: u8, sa: Side, b: GridCoord, hb: u8, sb: Side) -> Option<(EntityId, EntityId)> {
        let (na, nb) = (self.node_in(a, ha, sa)?, self.node_in(b, hb, sb)?);
        (self.edges.contains_key(&(na, nb)) || self.edges.contains_key(&(nb, na))).then_some((na, nb))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grass() -> World {
        let mut world = World::new();
        for y in -4..6 {
            for x in -2..14 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world
    }

    const fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    /// Lay a path of (x, y, height), each step checked.
    fn lay(world: &mut World, path: &[(i32, i32, u8)]) {
        for p in path.windows(2) {
            let ((x0, y0, h0), (x1, y1, h1)) = (p[0], p[1]);
            assert!(world.may_lay_at(at(x0, y0), h0, MIDDLE, at(x1, y1), h1, MIDDLE, false), "{:?} refused", p);
            world.place_road_at(at(x0, y0), h0, MIDDLE, at(x1, y1), h1, MIDDLE, false, false);
        }
    }

    /// A road climbs over another: up a slope, a level along, over the
    /// road below, down a slope; cars can be routed over it, and the two
    /// roads never meet.
    #[test]
    fn an_overpass_crosses_a_road_without_meeting_it() {
        let mut world = grass();
        world.place_road_path(&(0..12).map(|x| at(x, 0)).collect::<Vec<_>>());
        // North to south across it, x = 5.
        lay(&mut world, &[(5, -3, 0), (5, -2, 1), (5, -1, 2), (5, 0, 2), (5, 1, 2), (5, 2, 1), (5, 3, 0)]);
        assert_eq!(world.nodes_on(at(5, 0)).len(), 2, "the ground road and the deck over it");
        let ground = world.road_node_at(at(5, 0)).unwrap();
        assert_eq!(world.arms_of(ground, false).len(), 2, "the road below is not joined to it");
        let route = crate::world::pathfinding::Routes::from(&world, world.road_node_at(at(5, -3)).unwrap()).route_to(world.road_node_at(at(5, 3)).unwrap()).unwrap();
        assert_eq!(route.len(), 7, "straight over");
    }

    /// What a slope may and may not be.
    #[test]
    fn a_slope_runs_straight_and_clear() {
        let mut world = grass();
        world.place_road_path(&(0..12).map(|x| at(x, 0)).collect::<Vec<_>>());
        assert!(!world.may_lay_at(at(5, -1), 1, MIDDLE, at(5, 0), 1, MIDDLE, false), "two slopes level with each other");
        assert!(world.may_lay_at(at(5, -2), 1, MIDDLE, at(5, -1), 3, MIDDLE, false), "a slope on to the next");
        assert!(!world.may_lay_at(at(5, -1), 0, MIDDLE, at(5, 0), 2, MIDDLE, false), "a level in one step");
        assert!(!world.may_lay_at(at(5, -1), 2, MIDDLE, at(5, 0), 1, MIDDLE, false), "a slope from the ground's road's own tile");
        assert!(world.may_lay_at(at(5, -1), 3, MIDDLE, at(5, 0), 4, MIDDLE, false), "a slope from the first level over it");
        lay(&mut world, &[(3, -3, 0), (3, -2, 1), (3, -1, 2)]);
        assert!(!world.may_lay_at(at(3, -2), 1, MIDDLE, at(4, -2), 2, MIDDLE, false), "a third arm on a slope");
        assert!(!world.may_lay_at(at(3, -2), 1, MIDDLE, at(2, -2), 0, MIDDLE, false), "a third arm on a slope");
        lay(&mut world, &[(7, -4, 0), (7, -3, 1)]);
        assert!(!world.may_lay_at(at(7, -3), 1, MIDDLE, at(8, -3), 0, MIDDLE, false), "a slope's two arms at one level");
        assert!(world.may_lay_at(at(7, -3), 1, MIDDLE, at(8, -3), 2, MIDDLE, false), "a slope round a bend");
        assert!(world.may_lay_at(at(3, -1), 2, MIDDLE, at(4, -1), 2, MIDDLE, false), "a junction on the level");
    }

    /// A road climbs two levels on, slope after slope, over a road below,
    /// and cars are routed along it.
    #[test]
    fn slopes_run_on_two_levels_up() {
        let mut world = grass();
        world.place_road_path(&(0..12).map(|x| at(x, 0)).collect::<Vec<_>>());
        lay(&mut world, &[(5, -4, 0), (5, -3, 1), (5, -2, 3), (5, -1, 4), (5, 0, 4), (5, 1, 4), (5, 2, 3), (5, 3, 1), (5, 4, 0)]);
        let route = crate::world::pathfinding::Routes::from(&world, world.road_node_at(at(5, -4)).unwrap()).route_to(world.road_node_at(at(5, 4)).unwrap()).unwrap();
        assert_eq!(route.len(), 9, "up two levels, over, down two");
    }

    /// Diagonals cross between tiles: on one level at a crossing, which
    /// their cars take turns at; a level apart, one over the other.
    #[test]
    fn diagonals_cross_at_a_crossing_or_a_level_apart() {
        let mut world = grass();
        lay(&mut world, &[(4, 0, 0), (5, 1, 0)]);
        assert!(world.may_lay_at(at(5, 0), 0, MIDDLE, at(4, 1), 0, MIDDLE, false));
        lay(&mut world, &[(5, 0, 0), (4, 1, 0)]);
        let node = |world: &World, x, y, h| world.node_at(at(x, y), h).unwrap();
        let crossing = world.crossing_of(node(&world, 4, 0, 0), node(&world, 5, 1, 0));
        assert!(crossing.is_some() && crossing == world.crossing_of(node(&world, 4, 1, 0), node(&world, 5, 0, 0)), "the two do not cross at one crossing");
        lay(&mut world, &[(6, -1, 2), (6, 0, 2), (7, 1, 2)]);
        lay(&mut world, &[(6, 1, 0), (7, 0, 0)]);
        assert_eq!(world.crossing_of(node(&world, 6, 1, 0), node(&world, 7, 0, 0)), None, "a level apart, they cross");
    }
}
