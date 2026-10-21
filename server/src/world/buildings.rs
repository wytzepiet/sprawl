use crate::protocol::{
    Building, BuildingKind, Door, EntityId, GameObject, GridCoord, Placing, TerrainType,
};
use crate::world::World;

/// What lies behind a harbour's back, best first.
#[derive(Clone, Copy)]
enum Behind {
    Berth,
    Sea,
    Lake,
    Land,
}

impl World {
    /// Tiles a footprint of this size covers when placed at `pos`.
    ///
    /// `pos` is always the min corner, which keeps every caller — spatial
    /// index, occupancy, rendering — reading the same rectangle.
    pub fn footprint(pos: GridCoord, size: (u8, u8)) -> impl Iterator<Item = GridCoord> {
        let (w, h) = (size.0 as i32, size.1 as i32);
        (0..h).flat_map(move |dy| {
            (0..w).map(move |dx| GridCoord { x: pos.x + dx, y: pos.y + dy })
        })
    }

    /// Land a building can stand on. Water and mountain are out; roads and other
    /// buildings already hold their tiles.
    ///
    pub fn is_buildable(&self, coord: GridCoord) -> bool {
        if self.occupied.contains_key(&(coord.x, coord.y)) {
            return false;
        }
        if self.road_node_at(coord).is_some() {
            return false;
        }
        matches!(
            self.terrain.get(&(coord.x, coord.y)),
            Some(TerrainType::Grass | TerrainType::Forest)
        )
    }


    /// May a plot take its access from this road?
    ///
    /// A street, rather than a road or a driveway. A road is a through route
    /// nothing fronts onto. A driveway stands on a building's own tile — that
    /// is exactly what makes it that building's — so it is already spoken
    /// for, and a plot fronting onto one would run its door through somebody
    /// else's hallway.
    ///
    /// This is where access rules about a road belong, and the only place
    /// they belong.
    pub fn is_street(&self, id: EntityId) -> bool {
        let Some(entry) = self.objects.get(id) else { return false };
        let (Some(pos), GameObject::RoadNode(node)) = (entry.position, &entry.object) else { return false };
        node.road.is_empty() && !self.occupied.contains_key(&(pos.x, pos.y))
    }

    /// Is the only thing standing here a road that dead-ends on this tile?
    ///
    /// A building may be raised over one, because that is what a driveway is:
    /// a road that ends inside the plot. A road carrying traffic through has
    /// two arms and is a street, and a street may not be built over.
    ///
    fn is_driveway_stub(&self, coord: GridCoord) -> bool {
        let Some(node) = self.road_node_at(coord) else { return false };
        let Some(GameObject::RoadNode(node)) = self.objects.get(node).map(|e| &e.object) else { return false };
        let mut arms = node.outgoing.iter().chain(&node.incoming);
        if let Some(first) = arms.next() && arms.any(|a| a != first) {
            return false;
        }
        if self.occupied.contains_key(&(coord.x, coord.y)) {
            return false;
        }
        matches!(
            self.terrain.get(&(coord.x, coord.y)),
            Some(TerrainType::Grass | TerrainType::Forest)
        )
    }

    /// Could a driveway run from this road node to this tile?
    ///
    /// A driveway is an ordinary road, so it answers to the same geometry as
    /// any other: it may not meet the road it joins at a hairpin. Off a
    /// straight run only the perpendicular is legal — which for a diagonal
    /// street is itself diagonal, so a plot squarely beside one cannot be
    /// connected at all.
    fn driveway_reaches(&self, from: GridCoord, to: GridCoord) -> bool {
        !self.would_turn_sharply(from, to.x - from.x, to.y - from.y, true, true)
    }

    /// The one rule for where a driveway may run onto a plot lying this
    /// way: from a tile off the plot onto one of its entrance tiles, the
    /// yard's if its kind keeps one, else any of its own; beside it, or on
    /// the diagonal only outward from a corner, both tiles beside the
    /// entrance on `from`'s side off the plot (a diagonal into the middle
    /// of an edge would cut the neighbouring tile at a sharp angle). A
    /// yard is entered only by its gate, the middle of its front, from
    /// ahead of it, the street side its kind lays it on
    /// (`blueprint::lie`), so the yard is always where its street is and
    /// its lane runs straight in (`lots::park`).
    pub fn enters(tiles: &[GridCoord], kind: BuildingKind, facing: u8, from: GridCoord, to: GridCoord) -> bool {
        let on = |x: i32, y: i32| tiles.contains(&GridCoord { x, y });
        let (dx, dy) = (from.x - to.x, from.y - to.y);
        if !on(to.x, to.y) || on(from.x, from.y) || dx.abs() > 1 || dy.abs() > 1 {
            return false;
        }
        if dx != 0 && dy != 0 && (on(to.x + dx, to.y) || on(to.x, to.y + dy)) {
            return false;
        }
        match Self::yard_of(tiles, kind, facing) {
            Some(_) if Self::gate_of(tiles, kind, facing) != Some(to) => false,
            Some(yard) => {
                let (fx, fy) = crate::blueprint::FACINGS[facing as usize % 4];
                yard.contains(&to) && dx * fx + dy * fy > 0
            }
            None => true,
        }
    }

    /// The ways a building may turn to find its street, the way it faces
    /// first: a kind with a yard turns all the way round, the opposite
    /// way first, which keeps its shape; a harbour stays with its back to
    /// the sea; anything else has no front, its door on any side.
    fn facings(kind: BuildingKind, facing: u8) -> Vec<u8> {
        if crate::blueprint::blueprint(kind).quay || crate::blueprint::blueprint(kind).lot.1 == 0 {
            return vec![facing];
        }
        [0, 2, 1, 3].iter().map(|k| (facing + k) % 4).collect()
    }

    /// May the mayor's road run from `from` onto the plot standing at
    /// `to`, the building turned whichever way that takes?
    pub(super) fn may_enter_plot(&self, from: GridCoord, to: GridCoord) -> bool {
        self.facing_through(from, to).is_some()
    }

    /// The way the building on `to` would face with its door on `to`
    /// from `from`: the first of its `facings` that the step `enters`.
    fn facing_through(&self, from: GridCoord, to: GridCoord) -> Option<u8> {
        let &b = self.occupied.get(&(to.x, to.y))?;
        let GameObject::Building(bd) = &self.objects.get(b)?.object else { return None };
        Self::facings(bd.kind, bd.facing).into_iter().find(|&f| Self::enters(&bd.tiles, bd.kind, f, from, to))
    }

    /// The driveway a plot lying this way finds for itself: a street tile
    /// a driveway may run from (`enters`), whose turn onto it is not too
    /// sharp; straight before diagonal.
    pub fn driveway_for(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<(EntityId, GridCoord)> {
        let mut candidates: Vec<(bool, GridCoord, GridCoord)> = Vec::new();
        for &t in tiles {
            for (dx, dy) in (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (dx, dy))) {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if Self::enters(tiles, kind, facing, n, t) {
                    candidates.push((dx != 0 && dy != 0, t, n));
                }
            }
        }
        candidates.sort_by_key(|c| c.0);
        candidates.into_iter().find_map(|(_, t, n)| {
            let id = self.road_node_at(n)?;
            (self.is_street(id) && self.driveway_reaches(n, t)).then_some((id, t))
        })
    }

    /// The bounds of some tiles: their min corner, and how far they reach.
    pub fn bounds(tiles: &[GridCoord]) -> (GridCoord, (u8, u8)) {
        let (x0, y0) = (tiles.iter().map(|t| t.x).min().unwrap_or(0), tiles.iter().map(|t| t.y).min().unwrap_or(0));
        let (x1, y1) = (tiles.iter().map(|t| t.x).max().unwrap_or(0), tiles.iter().map(|t| t.y).max().unwrap_or(0));
        (GridCoord { x: x0, y: y0 }, ((x1 - x0 + 1) as u8, (y1 - y0 + 1) as u8))
    }

    /// How a building on these tiles lies facing this way, laid out by its
    /// bounds: their corner, and the plot (`blueprint::lie`).
    pub fn lie(tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> (GridCoord, crate::blueprint::Plot) {
        let (origin, size) = Self::bounds(tiles);
        (origin, crate::blueprint::lie(kind, facing, size))
    }

    /// A building's yard tiles, lying this way, if its kind keeps a yard
    /// and it is big enough to work: one short of its smallest plot, as a
    /// fixture may draw it, has no yard, as it has no door.
    pub fn yard_of(tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<Vec<GridCoord>> {
        if !Self::works(tiles, kind) {
            return None;
        }
        let (o, p) = Self::lie(tiles, kind, facing);
        let ((lx, ly), ls) = p.lot?;
        Some(Self::footprint(GridCoord { x: o.x + lx as i32, y: o.y + ly as i32 }, ls).filter(|t| tiles.contains(t)).collect())
    }

    /// A harbour's gate: the middle tile of its front, the one way in,
    /// where its lane starts down to the ramp (`World::berth_at`).
    pub fn gate_of(tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<GridCoord> {
        if !Self::works(tiles, kind) {
            return None;
        }
        let (o, (w, h)) = Self::bounds(tiles);
        let (w, h) = (w as i32, h as i32);
        Some(match crate::blueprint::FACINGS[facing as usize % 4] {
            (0, -1) => GridCoord { x: o.x + w / 2, y: o.y },
            (0, _) => GridCoord { x: o.x + w / 2, y: o.y + h - 1 },
            (-1, _) => GridCoord { x: o.x, y: o.y + h / 2 },
            _ => GridCoord { x: o.x + w - 1, y: o.y + h / 2 },
        })
    }

    /// Does a building on these tiles work: does it hold the smallest of
    /// its kind (`blueprint::plot`), one way round or the other? A placed
    /// one always does; one a fixture draws short of it stands, with no
    /// door and no yard, as if no road reached it.
    fn works(tiles: &[GridCoord], kind: BuildingKind) -> bool {
        let (w, h) = crate::blueprint::plot(kind, 0).size;
        [(w, h), (h, w)].iter().any(|&size| tiles.iter().any(|&t| Self::footprint(t, size).all(|f| tiles.contains(&f))))
    }

    /// The street node a building is reached by: where every trip to it
    /// ends and from it starts, its lot taking the car the rest of the way.
    /// The edge stands on its road. `None` is a building no road reaches.
    pub fn street_of(&self, id: EntityId) -> Option<EntityId> {
        self.door_of(id).map(|(_, street)| street)
    }

    /// A building's door as it stands: its tile the drive runs onto, and
    /// the street node the drive runs from. Read off what is kept
    /// (`Building::door`) against the map, so a street taken away leaves
    /// the building cut off, and one laid there again reaches it again.
    pub fn door_of(&self, id: EntityId) -> Option<(GridCoord, EntityId)> {
        let Some(GameObject::Building(b)) = self.objects.get(id).map(|e| &e.object) else { return None };
        let door = b.door?;
        if !Self::works(&b.tiles, b.kind) || !b.tiles.contains(&door.tile) {
            return None;
        }
        let street = self.road_node_at(door.street)?;
        self.is_street(street).then_some((door.tile, street))
    }

    /// A building's door and the way it faces, which lays its yard out:
    /// set together, so the yard is always on its door's side.
    pub(super) fn set_door(&mut self, id: EntityId, facing: u8, door: Option<crate::protocol::Door>) {
        if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            b.facing = facing;
            b.door = door;
        }
        self.unsettled.insert(id);
    }

    /// A street laid, taken up or cut on this tile: whatever has its door
    /// onto it, and whatever beside it has none, is oriented again at the
    /// settle (`orient`).
    pub(crate) fn unsettle_round(&mut self, tile: GridCoord) {
        for (dx, dy) in (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (dx, dy))) {
            let Some(&b) = self.occupied.get(&(tile.x + dx, tile.y + dy)) else { continue };
            let door = match self.objects.get(b).map(|e| &e.object) {
                Some(GameObject::Building(bd)) => bd.door,
                _ => continue,
            };
            if door.is_none_or(|d| d.street == tile) || self.door_of(b).is_none() {
                self.unsettled.insert(b);
            }
        }
    }

    /// A road's dead end under a building placed over it: the road goes,
    /// and the street it ended off becomes the building's door, if it
    /// may be one, the building turned to it. That is how the mayor says
    /// where a door goes before the building is there.
    fn take_stub(&mut self, id: EntityId, tile: GridCoord) {
        let Some(node) = self.road_node_at(tile) else { return };
        let street = self.arms_of(node, false).first().and_then(|&a| self.objects.get(a)?.position);
        self.demolish_node(node);
        if let Some(street) = street {
            self.door_through(id, street, tile);
        }
    }

    /// A door on `to` from the street on `from`, the building turned the
    /// first of its ways that takes it; nothing where none does, or the
    /// street may not be one.
    pub(super) fn door_through(&mut self, id: EntityId, from: GridCoord, to: GridCoord) {
        let street = self.road_node_at(from).is_some_and(|s| self.is_street(s) && self.driveway_reaches(from, to));
        if let Some(facing) = self.facing_through(from, to).filter(|_| street) {
            self.set_door(id, facing, Some(crate::protocol::Door { tile: to, street: from }));
        }
    }

    /// Every building standing on the land, as (id, position) — the edge is
    /// not one of them; it stands where the map stops. Only tests still want
    /// the world flattened like this; the simulation itself always knows
    /// which building it means.
    #[cfg(test)]
    pub fn all_buildings(&self) -> Vec<(EntityId, GridCoord)> {
        self.objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(_)))
            .filter_map(|e| e.position.map(|p| (e.id, p)))
            .collect()
    }

    /// A kind's smallest plot with its corner at `pos`, this way round, on
    /// open land, road or no road: dormant till one comes.
    #[cfg(test)]
    pub fn place_building(&mut self, pos: GridCoord, kind: BuildingKind, facing: u8) -> Option<EntityId> {
        let tiles: Vec<GridCoord> = Self::footprint(pos, crate::blueprint::plot(kind, facing).size).collect();
        let open = tiles.iter().all(|&t| self.may_stand(t));
        let quay = crate::blueprint::blueprint(kind).quay;
        (open && (!quay || self.berth_at(&tiles, kind, facing).is_some())).then(|| self.raise(kind, tiles, facing))
    }

    /// The building on this tile, if any.
    pub(super) fn claimed_plot_at(&self, tile: GridCoord) -> Option<EntityId> {
        self.occupied.get(&(tile.x, tile.y)).copied()
    }

    /// A building placed by the mayor: the town's first depot, and anything
    /// built of nothing, stands at once, and the rest are sites waiting for
    /// their timber.
    pub fn founded(&mut self, id: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(id).map(|e| &e.object) else { return };
        let kind = b.kind;
        let first_depot = crate::economy::depot(kind)
            && !self.objects.iter().any(|e| e.id != id && matches!(e.object, GameObject::Building(ref o) if o.kind == kind && o.site.is_none()));
        if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            if first_depot {
                b.site = None;
            }
        }
        let standing = matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_none());
        if standing {
            crate::economy::stand(self, id);
        }
    }

    /// Where a building's door is, and so which way it faces and where
    /// its yard lies: decided here and nowhere else, whenever the streets
    /// round it change (`unsettle_round`, then `settle`). A door that
    /// still stands is kept, however many streets come beside it, so a
    /// building never turns while it works. One that is gone moves to the
    /// first street it finds, the building turned the first of its
    /// `facings` that has one: its own way, then about, then a side. None
    /// anywhere, it has no door, and no road reaches it. Whether it is
    /// reached.
    pub fn orient(&mut self, id: EntityId) -> bool {
        let Some(GameObject::Building(b)) = self.objects.get(id).map(|e| &e.object) else { return false };
        let (tiles, kind, facing, door) = (b.tiles.clone(), b.kind, b.facing, b.door);
        if !Self::works(&tiles, kind) {
            return false;
        }
        let stands = match (door, self.door_of(id)) {
            (Some(d), Some(_)) => Self::enters(&tiles, kind, facing, d.street, d.tile) && self.driveway_reaches(d.street, d.tile),
            _ => false,
        };
        if !stands {
            let quay = crate::blueprint::blueprint(kind).quay;
            let found = Self::facings(kind, facing).into_iter().find_map(|f| {
                if quay && self.berth_at(&tiles, kind, f).is_none() {
                    return None;
                }
                let (street, tile) = self.driveway_for(&tiles, kind, f)?;
                Some((f, crate::protocol::Door { tile, street: self.objects.get(street)?.position? }))
            });
            match found {
                Some((f, door)) => self.set_door(id, f, Some(door)),
                None if door.is_some() => self.set_door(id, facing, None),
                None => {}
            }
            if found.is_none() {
                return false;
            }
        }
        // Reached: a depot's lorries come with it, and a farm claims its land.
        crate::calls::stable(self, id);
        self.claim_land(id);
        true
    }

    /// Every building beside any of these tiles oriented at once: a
    /// fixture's or a test's streets, laid with nobody settling after.
    pub fn open_doors_along(&mut self, tiles: &[GridCoord]) {
        let mut near: Vec<EntityId> = tiles
            .iter()
            .flat_map(|t| {
                (-1..=1).flat_map(move |dx| (-1..=1).map(move |dy| (t.x + dx, t.y + dy)))
            })
            .filter_map(|t| self.occupied.get(&t).copied())
            .collect();
        near.sort_unstable();
        near.dedup();
        for id in near {
            self.orient(id);
        }
    }

    /// The first way round a kind's plot with its corner at `pos` stands
    /// on open land with a street before it.
    #[cfg(test)]
    pub fn site_for(&self, pos: GridCoord, kind: BuildingKind) -> Option<u8> {
        (0..4).find(|&f| {
            let tiles: Vec<GridCoord> = Self::footprint(pos, crate::blueprint::plot(kind, f).size).collect();
            tiles.iter().all(|&t| self.may_stand(t))
                && (!crate::blueprint::blueprint(kind).quay || self.berth_at(&tiles, kind, f).is_some())
                && self.driveway_for(&tiles, kind, f).is_some()
        })
    }

    /// A building that can be driven to, or nothing: its corner at `pos`,
    /// the first way round it fits with a street before it. Standing, and
    /// stocked, as a town written by hand is.
    #[cfg(test)]
    pub fn place_on_street(&mut self, pos: GridCoord, kind: BuildingKind) -> Option<EntityId> {
        let id = self.place_building(pos, kind, self.site_for(pos, kind)?)?;
        self.finish(id);
        Some(id)
    }

    /// A building as a town written by hand has it: standing, its timber
    /// in, its shelves full but for what its own land fills.
    pub fn finish(&mut self, id: EntityId) {
        if matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_some()) {
            crate::economy::stand(self, id);
        }
        if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            let kind = b.kind;
            for (good, stock) in b.stocks.iter_mut() {
                if !crate::economy::makes(kind, *good) {
                    stock.level = stock.cap;
                }
            }
        }
    }

    /// The plot a kind placed round `at` facing this way stands on: its
    /// whole footprint, building and yard, laid round the tile as the
    /// hand holds it (`World::placing`).
    pub fn plot_at(kind: BuildingKind, at: GridCoord, facing: u8) -> Vec<GridCoord> {
        let (w, h) = crate::blueprint::plot(kind, facing).size;
        Self::footprint(GridCoord { x: at.x - w as i32 / 2, y: at.y - h as i32 / 2 }, (w, h)).collect()
    }

    /// May a kind be placed round `at` facing this way, and if not, why,
    /// in the words the hand's preview says it in (`World::placing`): open
    /// land under the whole plot, or a road's dead end it stands over;
    /// a street before its front, its yard's if it keeps one, or all along
    /// one side for one that parks at the kerb; and a harbour's back on
    /// open sea, which brings its own street.
    pub fn fit(&self, kind: BuildingKind, at: GridCoord, facing: u8) -> Result<Vec<GridCoord>, &'static str> {
        let tiles = Self::plot_at(kind, at, facing);
        for &t in &tiles {
            if self.occupied.contains_key(&(t.x, t.y)) {
                return Err("Something stands there");
            }
            if self.road_node_at(t).is_some() && !self.is_driveway_stub(t) {
                return Err("A street runs through it");
            }
            match self.terrain.get(&(t.x, t.y)) {
                Some(TerrainType::Grass | TerrainType::Forest) => {}
                Some(TerrainType::Sea | TerrainType::Water) => return Err("Its plot runs into the water"),
                Some(TerrainType::Beach) => return Err("On the beach: it stands on grass or forest"),
                _ => return Err("Not on open land"),
            }
        }
        if crate::blueprint::blueprint(kind).quay {
            return match self.behind(&tiles, kind, facing) {
                Behind::Berth => Ok(tiles),
                Behind::Sea => Err("The water behind is too narrow: the ferry needs 6 tiles of open sea straight out"),
                Behind::Lake => Err("A lake: the ferry comes only by sea"),
                Behind::Land => Err("No berth: its back is not on the sea"),
            };
        }
        // A building that parks at the kerb needs a street all along one
        // side, where its bays go (`kerb_bays`).
        use crate::world::lots::{kerbed, side_of, SIDES};
        match self.driveway_for(&tiles, kind, facing) {
            Some(_) if kerbed(kind) && !SIDES.iter().any(|&d| self.street_along(&side_of(&tiles, d), d)) => Err("No street along a whole side, for its parking"),
            Some(_) => Ok(tiles),
            None if crate::blueprint::blueprint(kind).lot.1 > 0 => Err("No street before its yard"),
            None => Err("No street beside it"),
        }
    }

    /// May a building stand on this tile: open land, or a road's dead end
    /// it takes over as its door.
    pub fn may_stand(&self, t: GridCoord) -> bool {
        self.is_buildable(t) || self.is_driveway_stub(t)
    }

    /// The street a harbour placed on these tiles brings with it, from the
    /// middle of its park's front: on to the nearest street in reach, with
    /// as few bends as may be, or a short one straight inland where none
    /// is. Nothing where a street already runs to its park. Its steps in
    /// the order they are laid.
    pub fn stub(&self, kind: BuildingKind, tiles: &[GridCoord], facing: u8) -> Vec<(GridCoord, GridCoord)> {
        use std::cmp::Reverse;
        use crate::fixed::HashMap;
        /// How far it looks for a street to join, in tiles each way; and
        /// how far it runs inland where there is none.
        const REACH: i32 = 12;
        const STUB: i32 = 4;
        if self.driveway_for(tiles, kind, facing).is_some() {
            return Vec::new();
        }
        let ahead = crate::blueprint::FACINGS[facing as usize];
        let (o, size) = Self::bounds(tiles);
        let mid = GridCoord { x: o.x + size.0 as i32 / 2, y: o.y + size.1 as i32 / 2 };
        // One tile out from its front.
        let out = if facing % 2 == 0 { size.1 } else { size.0 } as i32 / 2 + 1;
        let front = GridCoord { x: mid.x + ahead.0 * out, y: mid.y + ahead.1 * out };
        let street = |t: GridCoord| self.road_node_at(t).is_some();
        let open = |t: GridCoord| (t.x - front.x).abs() <= REACH && (t.y - front.y).abs() <= REACH && self.is_buildable(t) && !tiles.contains(&t);
        let steps = |path: &[GridCoord]| path.windows(2).map(|w| (w[0], w[1])).collect();
        // Fewest bends, then fewest tiles: a step costs two, a bend five
        // more. A state is a tile and the way in to it.
        type State = (i32, i32, usize);
        let mut came: HashMap<State, State> = HashMap::default();
        let mut cost: HashMap<State, u32> = HashMap::default();
        let mut heap = std::collections::BinaryHeap::new();
        if open(front) || street(front) {
            for d in 0..4 {
                cost.insert((front.x, front.y, d), 0);
                heap.push(Reverse((0, (front.x, front.y, d))));
            }
        }
        while let Some(Reverse((c, here))) = heap.pop() {
            let (x, y, d) = here;
            if cost[&here] < c {
                continue;
            }
            if street(GridCoord { x, y }) {
                let mut path = vec![GridCoord { x, y }];
                let mut k = here;
                while let Some(&p) = came.get(&k) {
                    path.push(GridCoord { x: p.0, y: p.1 });
                    k = p;
                }
                path.reverse();
                return steps(&path);
            }
            for (nd, &(dx, dy)) in crate::blueprint::FACINGS.iter().enumerate() {
                let next = (x + dx, y + dy, nd);
                let t = GridCoord { x: next.0, y: next.1 };
                let nc = c + 2 + if nd == d { 0 } else { 5 };
                if (open(t) || street(t)) && cost.get(&next).is_none_or(|&b| nc < b) {
                    cost.insert(next, nc);
                    came.insert(next, here);
                    heap.push(Reverse((nc, next)));
                }
            }
        }
        let inland: Vec<GridCoord> = (0..STUB).map(|k| GridCoord { x: front.x + ahead.0 * k, y: front.y + ahead.1 * k }).take_while(|&t| open(t)).collect();
        steps(&inland)
    }

    /// What lies behind a harbour's back on these tiles facing this way:
    /// a berth (`berth_at`), else the best of what is there.
    fn behind(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Behind {
        if self.berth_at(tiles, kind, facing).is_some() {
            return Behind::Berth;
        }
        let Some(gate) = World::gate_of(tiles, kind, facing) else { return Behind::Land };
        let (dx, dy) = crate::blueprint::FACINGS[facing as usize % 4];
        let (_, (w, h)) = World::bounds(tiles);
        let deep = if dx == 0 { h } else { w } as i32;
        match self.terrain.get(&(gate.x - dx * deep, gate.y - dy * deep)) {
            Some(TerrainType::Sea) => Behind::Sea,
            Some(TerrainType::Water) => Behind::Lake,
            _ => Behind::Land,
        }
    }

    /// How a kind held at a tile would be placed: turned the way the hand
    /// turned it, or, left to itself, the first way it fits, and where none
    /// does, toward the nearest street, a harbour toward the sea, so the
    /// reason shown is the one that matters; round the tile itself, or one
    /// beside it that fits, as the coast a harbour backs onto and the street
    /// a depot's yard must front are a tile from where the eye puts them.
    pub fn placing(&self, kind: BuildingKind, at: GridCoord, facing: Option<u8>) -> Placing {
        const NEAR: [(i32, i32); 9] = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)];
        let tried: Vec<Placing> = NEAR.iter().map(|&(dx, dy)| self.turned(kind, GridCoord { x: at.x + dx, y: at.y + dy }, facing)).collect();
        tried.iter().find(|p| p.why.is_none()).unwrap_or(&tried[0]).clone()
    }

    fn turned(&self, kind: BuildingKind, at: GridCoord, facing: Option<u8>) -> Placing {
        if let Some(f) = facing {
            return self.placed_as(kind, at, f);
        }
        let all: Vec<Placing> = (0..4).map(|f| self.placed_as(kind, at, f)).collect();
        if let Some(ok) = all.iter().find(|p| p.why.is_none()) {
            return ok.clone();
        }
        let quay = crate::blueprint::blueprint(kind).quay;
        let rank = |p: &Placing| if quay { self.behind(&p.tiles, kind, p.facing) as u32 } else { self.nearest_street(Self::front(&p.tiles, p.facing)) };
        all.into_iter().min_by_key(rank).expect("four ways round")
    }

    /// A kind placed round a tile facing this way, as it would stand.
    fn placed_as(&self, kind: BuildingKind, at: GridCoord, facing: u8) -> Placing {
        let (tiles, why) = match self.fit(kind, at, facing) {
            Ok(tiles) => (tiles, None),
            Err(why) => (Self::plot_at(kind, at, facing), Some(why.to_string())),
        };
        let door = why.is_none().then(|| self.driveway_for(&tiles, kind, facing)).flatten().and_then(|(id, tile)| Some(Door { tile, street: self.objects.get(id)?.position? }));
        Placing { kind, at, tiles, facing, door, why }
    }

    /// The tile one out from the middle of a plot's front.
    fn front(tiles: &[GridCoord], facing: u8) -> GridCoord {
        let (o, (w, h)) = Self::bounds(tiles);
        let (dx, dy) = crate::blueprint::FACINGS[facing as usize % 4];
        let (mx, my) = (o.x as f64 + (w as f64 - 1.0) / 2.0, o.y as f64 + (h as f64 - 1.0) / 2.0);
        let (hw, hh) = ((w as f64 - 1.0) / 2.0 + 1.0, (h as f64 - 1.0) / 2.0 + 1.0);
        GridCoord { x: (mx + dx as f64 * hw).round() as i32, y: (my + dy as f64 * hh).round() as i32 }
    }

    /// Steps to the nearest street tile from this one, as far as eight.
    fn nearest_street(&self, t: GridCoord) -> u32 {
        (0..=8).find(|&r| (-r..=r).any(|dy| (-r..=r).any(|dx| (dx as i32).abs().max((dy as i32).abs()) == r && self.road_node_at(GridCoord { x: t.x + dx, y: t.y + dy }).is_some()))).map_or(99, |r| r as u32)
    }

    /// The first way round a kind fits at `at`, if any does.
    pub fn facing_for(&self, kind: BuildingKind, at: GridCoord) -> Option<u8> {
        (0..4).find(|&f| self.fit(kind, at, f).is_ok())
    }

    /// A building stood on its tiles, facing this way: a site, or
    /// standing where it takes nothing or is the town's first depot, its
    /// door open onto a street beside its front. The one way a building
    /// comes, whoever asks: the hand placing it (`fit` first), a fixture.
    pub fn raise(&mut self, kind: BuildingKind, tiles: Vec<GridCoord>, facing: u8) -> EntityId {
        let id = self.insert_at(GameObject::Building(Building::new(kind, tiles.clone(), facing)), Some(tiles[0]));
        for &t in &tiles {
            self.take_stub(id, t);
            self.occupy(id, t);
        }
        self.founded(id);
        self.orient(id);
        id
    }

    /// The tile is the building's: occupancy, and every chunk it stands in
    /// indexed, so it is seen from any of them.
    fn occupy(&mut self, id: EntityId, t: GridCoord) {
        self.occupied.insert((t.x, t.y), id);
        self.spatial.entry(crate::world::chunk_of(t)).or_default().insert(id);
        self.built.insert(crate::world::chunk_of(t));
    }

    /// The one way a building leaves.
    pub fn remove_building(&mut self, id: EntityId) {
        self.drop_lot(id);
        let Some(entry) = self.objects.get(id) else { return };
        let GameObject::Building(ref b) = entry.object else { return };
        let tiles = b.tiles.clone();
        // Its fleet goes with it: what stands in the yard now, and what is
        // out when it gets back (`park_car`). Its people go at `settle`.
        let chunks: Vec<_> = tiles.iter().map(|&t| crate::world::chunk_of(t)).collect();
        let yard: Vec<EntityId> = self
            .objects
            .fleet(id)
            .filter(|&car| matches!(self.objects.get(car), Some(e) if e.position.is_some_and(|p| chunks.contains(&crate::world::chunk_of(p))) && matches!(e.object, GameObject::Car(ref c) if c.trip.is_none())))
            .collect();
        for car in yard {
            self.despawn_car(car);
        }
        self.unsettled.insert(id);

        for tile in &tiles {
            self.occupied.remove(&(tile.x, tile.y));
            self.unindex(id, *tile);
        }
        self.objects.remove(id);
    }

    /// A save from when a drive was a road: the road node on a building's
    /// tile, its own or the stub it was placed over, becomes its door,
    /// and goes. A car on its way over one is scrapped, and the settle
    /// that follows a load gives its owner another.
    pub fn doors_from_drives(&mut self) {
        let buildings: Vec<(EntityId, Vec<GridCoord>)> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Building(ref b) => Some((e.id, b.tiles.clone())),
                _ => None,
            })
            .collect();
        let mut gone: crate::fixed::HashSet<EntityId> = Default::default();
        for (id, tiles) in buildings {
            for tile in tiles {
                let Some(node) = self.road_node_at(tile) else { continue };
                gone.insert(node);
                self.take_stub(id, tile);
            }
        }
        let stranded: Vec<EntityId> = self
            .objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.as_ref().is_some_and(|t| t.route.iter().any(|n| gone.contains(n)))))
            .map(|e| e.id)
            .collect();
        for car in stranded {
            self.despawn_car(car);
        }
    }

    /// Rebuild the tile→building index from the stored buildings.
    pub fn rebuild_occupied(&mut self) {
        self.occupied.clear();
        for e in self.objects.iter() {
            let GameObject::Building(ref b) = e.object else { continue };
            for &tile in &b.tiles {
                self.occupied.insert((tile.x, tile.y), e.id);
                self.spatial.entry(crate::world::chunk_of(tile)).or_default().insert(e.id);
                self.built.insert(crate::world::chunk_of(tile));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::roads::tests::{agrees_with_the_edges, lift_road};
    use crate::world::decks::MIDDLE;

    /// A world with nothing in it but grass and the given road path.
    fn world_with_road(path: &[(i32, i32)]) -> World {
        let mut world = World::meadow(-8..8, -8..8);
        let coords: Vec<GridCoord> = path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
        world.place_road_path(&coords);
        world
    }

    #[test]
    fn a_building_cannot_be_raised_over_a_street() {
        // Adjacent steps, so the middle tile really is a node with two arms.
        let mut world = world_with_road(&[(1, 0), (2, 0), (3, 0)]);
        assert!(
            world.place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, 2).is_none(),
            "the road runs through, so nothing may stand on it"
        );
    }

    /// A door is drawn, not granted. The player runs a road into the
    /// building like any other, and that is its door: the street tile is
    /// laid, and nothing on the building's.
    #[test]
    fn a_road_drawn_into_a_building_is_its_door() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        let b = world
            .place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, 2)
            .unwrap();

        world.place_road_at(GridCoord { x: 2, y: 1 }, 0, MIDDLE, GridCoord { x: 2, y: 0 }, 0, MIDDLE, false, false);
        let street = world.road_node_at(GridCoord { x: 2, y: 1 });
        assert!(street.is_some(), "the street ran up to it");
        assert!(world.road_node_at(GridCoord { x: 2, y: 0 }).is_none(), "and no road onto it");
        assert_eq!(world.door_of(b), Some((GridCoord { x: 2, y: 0 }, street.unwrap())));
    }

    /// There is only ever one door, and it is the one drawn last: drawing
    /// a second moves it.
    #[test]
    fn a_second_door_replaces_the_first() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        world.place_road_path(&[GridCoord { x: 0, y: 2 }, GridCoord { x: 0, y: 0 }]);
        let b = world
            .place_building(GridCoord { x: 1, y: 0 }, BuildingKind::House, 2)
            .unwrap();

        // In from below, then in from the left.
        world.place_road_at(GridCoord { x: 1, y: 1 }, 0, MIDDLE, GridCoord { x: 1, y: 0 }, 0, MIDDLE, false, false);
        assert_eq!(world.door_of(b).map(|d| d.0), Some(GridCoord { x: 1, y: 0 }));
        world.place_road_at(GridCoord { x: 0, y: 0 }, 0, MIDDLE, GridCoord { x: 1, y: 0 }, 0, MIDDLE, false, false);
        assert_eq!(world.street_of(b), world.road_node_at(GridCoord { x: 0, y: 0 }), "the new door is the one");
    }

    /// A road ends at a building. Letting one leave again would put a through
    /// road across somebody's hallway, and give the plot two doors besides.
    #[test]
    fn a_road_cannot_carry_on_out_of_a_building() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        world
            .place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, 2)
            .unwrap();
        world.place_road_at(GridCoord { x: 2, y: 1 }, 0, MIDDLE, GridCoord { x: 2, y: 0 }, 0, MIDDLE, false, false);

        assert!(!world.may_lay(GridCoord { x: 2, y: 0 }, GridCoord { x: 3, y: 0 }, false), "the road stops at the door");
    }

    #[test]
    fn takes_a_road_straight_on() {
        let world = world_with_road(&[(0, 1), (1, 1)]);
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_some());
    }

    /// The case the corner rule exists for: no perimeter tile is orthogonally
    /// adjacent to this road, only the corner touches it.
    #[test]
    fn takes_a_road_off_its_corner() {
        let world = world_with_road(&[(1, 1), (2, 2)]);
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_some());
    }

    #[test]
    fn corner_rule_reaches_past_a_wide_footprint() {
        // Footprint covers (0,0) and (1,0); the road only meets its far corner.
        let world = world_with_road(&[(2, 1), (3, 2)]);
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 0, y: 0 }, (2, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_some());
    }

    #[test]
    fn no_road_in_reach_is_no_access() {
        let world = world_with_road(&[(5, 5), (6, 5)]);
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_none());
    }

    /// A road two tiles out is not access, diagonally or otherwise.
    #[test]
    fn diagonals_do_not_reach_two_tiles() {
        let world = world_with_road(&[(2, 2), (3, 3)]);
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_none());
    }

    fn diagonal_world() -> World {
        world_with_road(&[(0, 0), (1, 1), (2, 2)])
    }

    /// Adjacency is not access. A plot in a diagonal's elbow touches the road
    /// on two sides, but a driveway to either would be a hairpin, so it has no
    /// way to connect and cannot be built.
    #[test]
    fn plot_in_the_elbow_of_a_diagonal_cannot_connect() {
        let world = diagonal_world();
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 1, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_none());
    }

    /// The perpendicular of a diagonal is diagonal, so this one connects.
    #[test]
    fn plot_offset_diagonally_from_a_diagonal_connects() {
        let world = diagonal_world();
        assert!(world.driveway_for(&World::footprint(GridCoord { x: 2, y: 0 }, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, 0).is_some());
    }

    /// One house on one tile, built.
    fn house(world: &mut World, x: i32, y: i32) -> EntityId {
        world
            .place_on_street(GridCoord { x, y }, BuildingKind::House)
            .expect("a road should be beside it")
    }

    /// Red means one thing: not joined to the world. A road that reaches a
    /// way out is how people arrive; one that reaches nothing is an
    /// island, and every node of it says so — and stops saying so the moment
    /// a road joins it up, or starts again when the road is cut.
    #[test]
    fn a_road_that_reaches_nothing_is_an_island() {
        // The street's far end is its way out.
        let mut world = World::meadow(-8..140, -8..8).street(0..130);
        world.open_exit(world.road_node_at(GridCoord { x: 129, y: 0 }).unwrap());
        let joined = |world: &World, at: GridCoord| {
            let id = world.road_node_at(at).unwrap();
            matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.joined)
        };
        assert!(joined(&world, GridCoord { x: 0, y: 0 }), "the street reaches its way out");

        let lane: Vec<GridCoord> = (2..6).map(|y| GridCoord { x: 3, y }).collect();
        world.place_road_path(&lane);
        assert!(!joined(&world, GridCoord { x: 3, y: 4 }), "a lane touching nothing is an island");

        world.place_road_path(&[GridCoord { x: 3, y: 0 }, GridCoord { x: 3, y: 1 }, GridCoord { x: 3, y: 2 }]);
        assert!(joined(&world, GridCoord { x: 3, y: 5 }), "joined to the street, it is joined to the world");

        lift_road(&mut world, GridCoord { x: 3, y: 1 });
        assert!(!joined(&world, GridCoord { x: 3, y: 5 }), "cut off again");
        assert!(joined(&world, GridCoord { x: 3, y: 0 }), "the street is unmoved");

        // Cut the street between the town and its way out: the whole town
        // is an island, and the far end still reaches beyond.
        lift_road(&mut world, GridCoord { x: 60, y: 0 });
        assert!(!joined(&world, GridCoord { x: 0, y: 0 }), "the town lost its way out");
        assert!(joined(&world, GridCoord { x: 100, y: 0 }), "the far end still reaches beyond");
    }

    #[test]
    fn a_door_opens_onto_the_street() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        house(&mut world, 0, 0);
        agrees_with_the_edges(&world);

        let house = world.all_buildings()[0].0;
        let door = world.street_of(house).unwrap();
        let street = world.road_node_at(GridCoord { x: 2, y: 1 }).unwrap();
        assert!(world.network.connected(door, street), "the street it opens onto is the street");
    }

    /// The index refuses searches it knows will fail. The risk in that is
    /// refusing one that would have succeeded, which no amount of "nothing
    /// crashed" would show.
    #[test]
    fn a_search_across_one_network_still_finds_its_way() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1), (3, 1), (4, 1)]);
        house(&mut world, 0, 0);
        house(&mut world, 4, 0);
        let buildings = world.all_buildings();
        assert_eq!(buildings.len(), 2);

        let from = world.street_of(buildings[0].0).unwrap();
        let to = world.street_of(buildings[1].0).unwrap();
        assert!(
            crate::world::pathfinding::Routes::from(&world, from).route_to(to).is_some(),
            "a road runs between them, so a car must be able to drive it",
        );
    }

    /// A door is no road: a house beside a straight street leaves it one
    /// run, with no junction for its traffic to wait at, and taking the
    /// house away leaves the street as it was.
    #[test]
    fn a_door_leaves_the_street_one_run() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        let house = house(&mut world, 1, 0);
        assert_eq!(world.street_of(house), world.road_node_at(GridCoord { x: 1, y: 1 }));
        assert_eq!(world.network.segment_count(), 1, "the street unbroken");
        world.remove_building(house);
        assert_eq!(world.network.segment_count(), 1);
        agrees_with_the_edges(&world);
    }

    #[test]
    fn footprint_covers_every_tile() {
        let pos = GridCoord { x: 10, y: 10 };
        let tiles: Vec<_> = World::footprint(pos, (2, 3)).collect();
        assert_eq!(tiles.len(), 6);
        assert_eq!(tiles[0], pos);
        assert_eq!(tiles[5], GridCoord { x: 11, y: 12 });
    }

    fn tiles_of(world: &World, id: EntityId) -> Vec<GridCoord> {
        match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.tiles.clone(),
            _ => Vec::new(),
        }
    }

    /// A building is placed whole, round the tile it is dropped on: every
    /// tile of its plot its own, its yard before it on the street, and
    /// its door open at once.
    #[test]
    fn a_building_is_placed_whole_with_its_yard_on_the_street() {
        let world_ = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let mut world = world_;
        // A depot is three by four: its yard two deep toward the street at
        // y = 0, so facing -y (0), its middle two rows in.
        let at = GridCoord { x: 0, y: 3 };
        assert_eq!(world.facing_for(BuildingKind::Depot, at), Some(0));
        let tiles = world.fit(BuildingKind::Depot, at, 0).expect("the depot fits by the street");
        let id = world.raise(BuildingKind::Depot, tiles, 0);
        assert_eq!(tiles_of(&world, id).len(), 12);
        assert!(world.street_of(id).is_some(), "its door is open");
        let yard = World::yard_of(&tiles_of(&world, id), BuildingKind::Depot, 0).unwrap();
        assert!(yard.iter().all(|t| t.y <= 2), "its yard is not on the street side: {yard:?}");
    }

    /// A building keeps its door while it stands, whatever else comes
    /// beside it; when its street goes, its door moves to whichever side
    /// has one, the building turned so its yard is there, and its lot is
    /// laid again where the yard now is.
    #[test]
    fn a_yard_turns_to_the_street_it_has() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let at = GridCoord { x: 0, y: 3 };
        let tiles = world.fit(BuildingKind::Depot, at, 0).unwrap();
        let id = world.raise(BuildingKind::Depot, tiles.clone(), 0);
        world.finish(id);
        let facing = |w: &World| match w.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.facing,
            _ => unreachable!(),
        };
        let yard = |w: &World| World::yard_of(&tiles, BuildingKind::Depot, facing(w)).unwrap();
        // A street along its back: the door it has stands, so nothing turns.
        world.place_road_path(&(-6..=6).map(|x| GridCoord { x, y: 5 }).collect::<Vec<_>>());
        world.settle();
        assert_eq!(facing(&world), 0);
        // Its own street taken up: it turns about, its yard to the back.
        for x in -6..=6 {
            lift_road(&mut world, GridCoord { x, y: 0 });
        }
        world.settle();
        assert_eq!(facing(&world), 2, "it turned to the street behind");
        assert!(yard(&world).iter().all(|t| t.y >= 3), "its yard is at the back: {:?}", yard(&world));
        let (door, street) = world.door_of(id).expect("reached from behind");
        assert!(yard(&world).contains(&door) && world.objects.get(street).unwrap().position.unwrap().y == 5);
        assert!(world.lot_mut(id).is_some(), "its lot is laid in the new yard");
        // That one gone too, and a street down its side: it turns sideways.
        for x in -6..=6 {
            lift_road(&mut world, GridCoord { x, y: 5 });
        }
        world.place_road_path(&(-2..=7).map(|y| GridCoord { x: 2, y }).collect::<Vec<_>>());
        world.settle();
        assert_eq!(facing(&world), 1, "it turned to the side street");
        // And none at all: no door, and so no yard to drive to.
        for y in -2..=7 {
            lift_road(&mut world, GridCoord { x: 2, y });
        }
        world.settle();
        assert!(world.door_of(id).is_none() && world.street_of(id).is_none());
    }

    /// Where it may not go, it says why: the words the hand's preview
    /// shows under the pointer.
    #[test]
    fn a_plot_that_does_not_fit_says_why() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        assert_eq!(world.fit(BuildingKind::House, GridCoord { x: 0, y: 4 }, 2), Err("No street beside it"));
        assert_eq!(world.fit(BuildingKind::Depot, GridCoord { x: 0, y: 3 }, 2), Err("No street before its yard"));
        assert_eq!(world.fit(BuildingKind::House, GridCoord { x: 0, y: 0 }, 2), Err("A street runs through it"));
        let house = world.fit(BuildingKind::House, GridCoord { x: 0, y: 1 }, 2).unwrap();
        world.raise(BuildingKind::House, house, 2);
        assert_eq!(world.fit(BuildingKind::Shop, GridCoord { x: 0, y: 1 }, 2), Err("Something stands there"));
        world.terrain.insert((3, 1), TerrainType::Water);
        assert_eq!(world.fit(BuildingKind::House, GridCoord { x: 3, y: 1 }, 2), Err("Its plot runs into the water"));
    }
}
