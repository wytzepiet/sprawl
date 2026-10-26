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
//! Several nodes may stand on one tile, at heights, and moved a little to
//! one side of its middle (`RoadNode::side`), a thin road beside another.
//! Where they may stand is one rule (`clear.rs`): every road clear of every
//! other, their widths apart on the map or a level apart in height, as they
//! lie. So a slope from the first level to the second may pass over a
//! ground road, and a slope from the ground may not; two one-ways run side
//! by side, straight or round a bend, one inside it and the other out, and
//! part; a ramp climbs beside a road on its tiles. A road in the middle of
//! a tile moves over when another is laid beside it (`moving_over`), and
//! back when it would lie clear there again (`settle_sides`). Links
//! crossing on the diagonal, between tiles, cross over each other a level
//! apart; within a level, they cross at the corner, and their cars take
//! turns there (`Map::crossing_of`).
//!
//! The ground's middle nodes are `roads`, as they always were, and
//! everything the town does with a tile's road is theirs. The rest, above
//! the ground or beside the middle, are `decks`.

use model::{EntityId, GameObject, GridCoord, RoadNode, Tool};
use land::TerrainType;

use super::clear::End;
use super::Map;

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

/// Crossings' ids (`Map::crossing_of`): apart from every entity's.
pub const CROSSINGS: EntityId = 1 << 62;

/// Where a road on a side of a tile stands (`Map::node_pos`).
pub(crate) fn spot(at: GridCoord, side: Side) -> [f64; 2] {
    let [sx, sy] = side.map(f64::from);
    let by = if sx == 0.0 && sy == 0.0 { 0.0 } else { SIDE_OFFSET / (sx * sx + sy * sy).sqrt() };
    [at.x as f64 + 0.5 + sx * by, at.y as f64 + 0.5 + sy * by]
}

impl Map {
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

    /// The steps from a node to each of these, by their tiles.
    pub(crate) fn steps_to(&self, id: EntityId, arms: &[EntityId]) -> Option<Vec<(i32, i32)>> {
        let at = self.objects.get(id)?.position?;
        arms.iter().map(|&n| self.objects.get(n)?.position.map(|p| (p.x - at.x, p.y - at.y))).collect()
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
    }

    /// A road on a side goes back to the middle of its tile where it
    /// would lie clear there: what it moved over for has gone.
    pub(super) fn settle_sides(&mut self, coord: GridCoord) {
        for (h, id) in self.nodes_on(coord) {
            if self.side_of(id) != MIDDLE && self.node_at(coord, h).is_none() && self.lies_clear(&super::clear::Sketch { links: Vec::new(), moves: vec![(id, MIDDLE)] }) {
                self.move_to(id, MIDDLE);
            }
        }
    }

    /// Lay a road node on a tile at a height and side, or find the one
    /// there; above the ground or on a side, a one-way in the middle there
    /// moves over to the other side. `laid` is the mayor's own hand,
    /// counted to be paid for; a fixture's or a level's roads and
    /// driveways are streets, laid by nobody, and free.
    pub(super) fn place_node(&mut self, coord: GridCoord, height: u8, side: Side, laid: bool) -> EntityId {
        if let Some(id) = self.node_in(coord, height, side) {
            return id;
        }
        let ground = height == 0 && side == MIDDLE;
        if !ground {
            for (id, side) in self.moving_over(coord, height, side) {
                self.move_to(id, side);
            }
        }
        let id = self.insert_at(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![], joined: false, road: vec![], laid, height, light: None, wide: vec![], side }),
            Some(coord),
        );
        if ground {
            self.roads.insert((coord.x, coord.y), id);
        } else {
            self.decks.entry((coord.x, coord.y)).or_default().push(id);
        }
        self.laid += laid as u32;
        self.unsettle_round(coord);
        id
    }

    /// May a road be laid from one tile at one height and side to the next
    /// at another: the ground's rule (`may_lay`) where both ends are in the
    /// ground's middles.
    #[cfg(test)]
    pub fn may_lay_at(&self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, one_way: bool) -> bool {
        self.may_lay_at_on(from, hf, sf, to, ht, st, if one_way { Tool::OneWay } else { Tool::Street }, None, None)
    }

    /// `may_lay_at`, for a road drawn with this tool, a drag going on from
    /// `to` that way, if it does (`Map::leads_nowhere`), and on to `then`,
    /// if it is known where: a step of a level, a slope's end, or one slope
    /// on to the next; above the ground, nothing built under it and no
    /// mountain; and the road, with the next step's, and any they move
    /// over to make room (`moving_over`), clear of every road round them
    /// (`lies_clear`). With the next step's, as a drag that goes on beside
    /// a road moves that road over as it goes: a step is judged as the
    /// drag will leave it, not as it is for a moment.
    #[allow(clippy::too_many_arguments)]
    pub fn may_lay_at_on(&self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, tool: Tool, goes_on: Option<(i32, i32)>, then: Option<End>) -> bool {
        let one_way = tool != Tool::Street;
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 || hf > TOP || ht > TOP {
            return false;
        }
        if hf == 0 && ht == 0 && sf == MIDDLE && st == MIDDLE {
            // On the ground, the ground's rule; into a building, its door,
            // and no road on its tile.
            if !self.may_lay_on(from, to, one_way, goes_on) {
                return false;
            }
            if self.claimed_plot_at(to).is_some() {
                return true;
            }
        } else {
            let on = hf % 2 == 1 && ht % 2 == 1 && hf.abs_diff(ht) == 2;
            if (hf.abs_diff(ht) > 1 && !on) || (hf == ht && hf % 2 == 1) {
                return false;
            }
            for (t, h) in [(from, hf), (to, ht)] {
                let built = self.occupied.contains_key(&(t.x, t.y));
                let wet = matches!(self.terrain.get(&(t.x, t.y)), Some(TerrainType::Water | TerrainType::Sea | TerrainType::Beach | TerrainType::Mountain));
                let ground = h == 0 && wet && self.road_node_at(t).is_none();
                let above = h > 0 && self.terrain.get(&(t.x, t.y)) == Some(&TerrainType::Mountain);
                if built || ground || above {
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
            if self.node_in(from, hf, sf).is_some_and(|id| self.leads_nowhere(id, (dx, dy), !one_way, true, None))
                || self.node_in(to, ht, st).is_some_and(|id| self.leads_nowhere(id, (-dx, -dy), true, !one_way, goes_on))
            {
                return false;
            }
        }
        let half = if tool == Tool::OneWay { super::clear::LANE } else { super::clear::ROAD };
        let ends: Vec<End> = [(from, hf, sf), (to, ht, st)].into_iter().chain(then).collect();
        let mut moves: Vec<(EntityId, Side)> = Vec::new();
        for &(t, h, side) in &ends {
            if self.node_in(t, h, side).is_none() {
                moves.extend(self.moving_over(t, h, side).into_iter().filter(|m| !moves.iter().any(|n| n.0 == m.0)).collect::<Vec<_>>());
            }
        }
        let links = ends.windows(2).map(|w| ([w[0], w[1]], half)).collect();
        self.lies_clear(&super::clear::Sketch { links, moves })
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
    /// another, its edges with it: the mayor's. Into a building is its
    /// door, moved here: the street it runs from is laid, and nothing on
    /// the building's tile. Unchecked: `may_lay_at` says whether it may be.
    #[allow(clippy::too_many_arguments)]
    pub fn place_road_at(&mut self, from: GridCoord, hf: u8, sf: Side, to: GridCoord, ht: u8, st: Side, one_way: bool, road: bool) {
        if ht == 0 && st == MIDDLE
            && let Some(id) = self.claimed_plot_at(to)
        {
            self.place_node(from, hf, sf, true);
            self.door_through(id, from, to);
            // Reached, as by any street: a depot's fleet and a farm's
            // land come with the door, not with the first call.
            self.orient(id);
            return;
        }
        let a = self.place_node(from, hf, sf, true);
        let b = self.place_node(to, ht, st, true);
        self.join(a, b, one_way, road);
        // A new arm on a door's street may make its drive a hairpin.
        self.unsettle_round(from);
        self.unsettle_round(to);
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

    fn grass() -> Map {
        Map::meadow(-2..14, -4..6)
    }

    const fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    /// Lay a path of (x, y, height), each step checked.
    fn lay(world: &mut Map, path: &[(i32, i32, u8)]) {
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

    /// A ramp beside a road, on its tiles: a one-way climbing away from one
    /// it runs against, the two moved apart, which a level up would pass
    /// over it and in the middle would run into it; and the road beside it
    /// stays aside when something else on its tile goes.
    #[test]
    fn a_ramp_climbs_beside_a_road() {
        let mut world = grass();
        for x in 0..10 {
            world.place_road_at(at(x, 0), 0, MIDDLE, at(x + 1, 0), 0, MIDDLE, true, false);
        }
        const NORTH: Side = [0, -1];
        assert!(!world.may_lay_at(at(6, 0), 0, MIDDLE, at(5, 0), 1, MIDDLE, true), "a slope in the middle, into the road");
        assert!(world.may_lay_at(at(7, 0), 0, NORTH, at(6, 0), 0, NORTH, true));
        world.place_road_at(at(7, 0), 0, NORTH, at(6, 0), 0, NORTH, true, false);
        assert!(world.may_lay_at(at(6, 0), 0, NORTH, at(5, 0), 1, NORTH, true), "a slope beside it");
        world.place_road_at(at(6, 0), 0, NORTH, at(5, 0), 1, NORTH, true, false);
        assert!(!world.may_lay_at(at(5, 0), 1, NORTH, at(4, 0), 2, MIDDLE, true), "over it before it is a level up");
        assert!(world.may_lay_at(at(5, 0), 1, NORTH, at(4, 0), 2, NORTH, true), "up, beside it");
        world.place_road_at(at(5, 0), 1, NORTH, at(4, 0), 2, NORTH, true, false);
        assert!(world.may_lay_at(at(4, 0), 2, NORTH, at(3, 0), 2, MIDDLE, true), "and a level over it");
        let ground = world.node_at(at(5, 0), 0).or_else(|| world.node_in(at(5, 0), 0, [0, 1])).unwrap();
        assert_eq!(world.side_of(ground), [0, 1], "moved over for the slope");
        world.settle_sides(at(5, 0));
        assert_eq!(world.side_of(ground), [0, 1], "it stays aside while the slope stands");
    }

    /// Diagonals cross between tiles: on one level at a crossing, which
    /// their cars take turns at; a level apart, one over the other.
    #[test]
    fn diagonals_cross_at_a_crossing_or_a_level_apart() {
        let mut world = grass();
        lay(&mut world, &[(4, 0, 0), (5, 1, 0)]);
        assert!(world.may_lay_at(at(5, 0), 0, MIDDLE, at(4, 1), 0, MIDDLE, false));
        lay(&mut world, &[(5, 0, 0), (4, 1, 0)]);
        let node = |world: &Map, x, y, h| world.node_at(at(x, y), h).unwrap();
        let crossing = world.crossing_of(node(&world, 4, 0, 0), node(&world, 5, 1, 0));
        assert!(crossing.is_some() && crossing == world.crossing_of(node(&world, 4, 1, 0), node(&world, 5, 0, 0)), "the two do not cross at one crossing");
        lay(&mut world, &[(6, -1, 2), (6, 0, 2), (7, 1, 2)]);
        lay(&mut world, &[(6, 1, 0), (7, 0, 0)]);
        assert_eq!(world.crossing_of(node(&world, 6, 1, 0), node(&world, 7, 0, 0)), None, "a level apart, they cross");
    }
}
