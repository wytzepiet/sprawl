//! Roads above the ground: overpasses, and the slopes up to them.
//!
//! A road node has a height in half-levels (`RoadNode::height`): 0 the
//! ground, 2 a level up, 4 two, 6 three. An odd height is a slope, a tile
//! whose road climbs from the level below to the one above: it runs
//! straight through, one arm down and one up, and nothing else joins it.
//! Links join nodes of the same even height, or a slope to the level at
//! either end of it, so a road climbs a level over two tiles' run, centre
//! to centre, the way a car is driven.
//!
//! Several nodes may stand on one tile, as long as each is a level clear of
//! the others: a slope counts as the levels at both its ends. So a slope
//! from the first level to the second may pass over a ground road, and a
//! slope from the ground may not. Links crossing on the diagonal, between
//! tiles, keep the same clearance where they cross.
//!
//! The ground's nodes are `roads`, as they always were, and everything the
//! town does with a tile's road is the ground's. The rest are `decks`.

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode, TerrainType};

use super::World;

/// The highest a road stands: three levels up.
pub const TOP: u8 = 6;

/// How far apart two nodes on one tile must stand: a level, and a level
/// more for each that is a slope, which reaches up or down half of one.
fn clearance(a: u8, b: u8) -> u8 {
    2 + a % 2 + b % 2
}

impl World {
    /// The road node on a tile at a height.
    pub fn node_at(&self, coord: GridCoord, height: u8) -> Option<EntityId> {
        if height == 0 { self.road_node_at(coord) } else { self.decks.get(&(coord.x, coord.y, height)).copied() }
    }

    /// Every road node on a tile, and how high it stands.
    pub fn nodes_on(&self, coord: GridCoord) -> Vec<(u8, EntityId)> {
        let mut out: Vec<(u8, EntityId)> = (1..=TOP).filter_map(|h| Some((h, *self.decks.get(&(coord.x, coord.y, h))?))).collect();
        if let Some(g) = self.road_node_at(coord) {
            out.insert(0, (0, g));
        }
        out
    }

    pub fn height_of(&self, id: EntityId) -> u8 {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::RoadNode(n)) => n.height,
            _ => 0,
        }
    }

    /// Is there room on this tile for a road at this height: its own node
    /// there already, or every other a level clear of it; and above the
    /// ground, nothing built under it and no mountain.
    pub fn room_at(&self, coord: GridCoord, height: u8) -> bool {
        if self.node_at(coord, height).is_some() {
            return true;
        }
        if height > 0 && (self.occupied.contains_key(&(coord.x, coord.y)) || self.terrain.get(&(coord.x, coord.y)) == Some(&TerrainType::Mountain)) {
            return false;
        }
        self.nodes_on(coord).into_iter().all(|(h, _)| h.abs_diff(height) >= clearance(h, height))
    }

    /// Lay a road node on a tile at a height above the ground, or find the
    /// one there. The mayor's.
    pub(super) fn place_deck_of(&mut self, coord: GridCoord, height: u8, road: bool) -> EntityId {
        if let Some(id) = self.node_at(coord, height) {
            return id;
        }
        let id = self.insert_at(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![], joined: false, road, laid: true, height, light: None, wide: vec![] }),
            Some(coord),
        );
        self.decks.insert((coord.x, coord.y, height), id);
        self.laid += 1;
        id
    }

    /// May a road be laid from one tile at one height to the next at
    /// another, above the ground: the ground's rule (`may_lay`) where both
    /// ends are on it.
    pub fn may_lay_at(&self, from: GridCoord, hf: u8, to: GridCoord, ht: u8, one_way: bool) -> bool {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 || hf > TOP || ht > TOP {
            return false;
        }
        // On the ground, the ground's rule, and a slope's clearance over it.
        if hf == 0 && ht == 0 {
            return self.may_lay(from, to, one_way) && self.room_at(from, 0) && self.room_at(to, 0);
        }
        // Level, or a slope's end: never two slopes, never a level's jump.
        if hf.abs_diff(ht) > 1 || (hf == ht && hf % 2 == 1) {
            return false;
        }
        if !self.room_at(from, hf) || !self.room_at(to, ht) {
            return false;
        }
        // Where an end is on the ground, it is the ground's: not into a
        // building, not over water.
        for (t, h) in [(from, hf), (to, ht)] {
            let wet = matches!(self.terrain.get(&(t.x, t.y)), Some(TerrainType::Water | TerrainType::Sea | TerrainType::Beach | TerrainType::Mountain));
            if h == 0 && ((wet && self.road_node_at(t).is_none()) || self.occupied.contains_key(&(t.x, t.y))) {
                return false;
            }
        }
        let (a, b) = (self.node_at(from, hf), self.node_at(to, ht));
        if let (Some(a), Some(b)) = (a, b) {
            let joined = self.edges.contains_key(&(a, b)) || self.edges.contains_key(&(b, a));
            // Joined already; but a one-way laid against a one-way makes a
            // divided road.
            if joined && !(one_way && self.edges.contains_key(&(b, a)) && !self.edges.contains_key(&(a, b))) {
                return false;
            }
        }
        // A slope runs straight through: one arm down, one up.
        if !self.slope_takes(from, hf, (dx, dy), ht) || !self.slope_takes(to, ht, (-dx, -dy), hf) {
            return false;
        }
        // Crossing a link on the other diagonal, a level clear of it.
        if dx != 0 && dy != 0 && self.crossed(GridCoord { x: from.x + dx, y: from.y }, GridCoord { x: from.x, y: from.y + dy }, hf + ht) {
            return false;
        }
        !self.node_at(from, hf).is_some_and(|id| self.turns_sharply(id, (dx, dy), !one_way, true))
            && !self.node_at(to, ht).is_some_and(|id| self.turns_sharply(id, (-dx, -dy), true, !one_way))
    }

    /// Would a slope here take an arm this way to a node at `other`: it has
    /// none yet, or the one it has is straight behind and at the other end
    /// of the climb. Not a slope, anything may join it.
    fn slope_takes(&self, at: GridCoord, height: u8, way: (i32, i32), other: u8) -> bool {
        if height % 2 == 0 {
            return true;
        }
        let Some(id) = self.node_at(at, height) else { return true };
        let arms = self.arms_of(id, false);
        let mut unique: Vec<EntityId> = arms.clone();
        unique.sort_unstable();
        unique.dedup();
        match unique.as_slice() {
            [] => true,
            [arm] => {
                let Some(p) = self.objects.get(*arm).and_then(|e| e.position) else { return false };
                (p.x - at.x, p.y - at.y) == (-way.0, -way.1) && self.height_of(*arm) != other
            }
            _ => false,
        }
    }

    /// Is there a link between these two tiles whose middle stands within a
    /// level of `twice` (the sum of a link's two heights)?
    fn crossed(&self, a: GridCoord, b: GridCoord, twice: u8) -> bool {
        self.nodes_on(a).into_iter().any(|(ha, na)| {
            self.nodes_on(b).into_iter().any(|(hb, nb)| {
                (self.edges.contains_key(&(na, nb)) || self.edges.contains_key(&(nb, na))) && (ha + hb).abs_diff(twice) < 4
            })
        })
    }

    /// `would_turn_sharply`, of a node by its id.
    pub(super) fn turns_sharply(&self, id: EntityId, (dx, dy): (i32, i32), arriving: bool, leaving: bool) -> bool {
        let Some(at) = self.objects.get(id).and_then(|e| e.position) else { return false };
        self.arms_of(id, false).into_iter().any(|nid| {
            let Some(npos) = self.objects.get(nid).and_then(|n| n.position) else { return false };
            if (npos.x - at.x, npos.y - at.y) == (dx, dy) {
                return false;
            }
            let ahead = (npos.x - at.x) * dx + (npos.y - at.y) * dy > 0;
            ahead && ((arriving && self.edges.contains_key(&(id, nid))) || (leaving && self.edges.contains_key(&(nid, id))))
        })
    }

    /// Lay a road from one tile at one height to the next at another, its
    /// edges with it: the ground's way where both ends are on it. Unchecked:
    /// `may_lay_at` says whether it may be.
    pub fn place_road_at(&mut self, from: GridCoord, hf: u8, to: GridCoord, ht: u8, one_way: bool, road: bool) {
        let a = if hf == 0 { self.place_ground(from, road) } else { self.place_deck_of(from, hf, road) };
        let b = if ht == 0 { self.place_ground(to, road) } else { self.place_deck_of(to, ht, road) };
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

    /// The road joining two tiles at these heights, if any: its two nodes.
    pub fn link_between_at(&self, a: GridCoord, ha: u8, b: GridCoord, hb: u8) -> Option<(EntityId, EntityId)> {
        let (na, nb) = (self.node_at(a, ha)?, self.node_at(b, hb)?);
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
            assert!(world.may_lay_at(at(x0, y0), h0, at(x1, y1), h1, false), "{:?} refused", p);
            world.place_road_at(at(x0, y0), h0, at(x1, y1), h1, false, false);
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
        assert!(!world.may_lay_at(at(5, -1), 1, at(5, 0), 1, false), "two slopes in a row");
        assert!(!world.may_lay_at(at(5, -1), 0, at(5, 0), 2, false), "a level in one step");
        assert!(!world.may_lay_at(at(5, -1), 2, at(5, 0), 1, false), "a slope from the ground's road's own tile");
        assert!(world.may_lay_at(at(5, -1), 3, at(5, 0), 4, false), "a slope from the first level over it");
        lay(&mut world, &[(3, -3, 0), (3, -2, 1), (3, -1, 2)]);
        assert!(!world.may_lay_at(at(3, -2), 1, at(4, -2), 2, false), "a third arm on a slope");
        assert!(!world.may_lay_at(at(3, -2), 1, at(2, -2), 0, false), "a bend in a slope");
        assert!(world.may_lay_at(at(3, -1), 2, at(4, -1), 2, false), "a junction on the level");
    }

    /// Diagonals may cross between tiles only a level apart.
    #[test]
    fn diagonals_cross_a_level_apart() {
        let mut world = grass();
        lay(&mut world, &[(4, 0, 0), (5, 1, 0)]);
        assert!(!world.may_lay_at(at(5, 0), 0, at(4, 1), 0, false));
        lay(&mut world, &[(3, -1, 2), (4, -1, 2), (5, 0, 2)]);
        assert!(world.may_lay_at(at(5, 0), 2, at(4, 1), 2, false));
    }
}
