use crate::protocol::{
    Building, BuildingKind, EntityId, GameObject, GridCoord, TerrainType,
};
use crate::world::World;

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
            Some(TerrainType::Grass | TerrainType::Beach | TerrainType::Forest)
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
        !node.road && !self.occupied.contains_key(&(pos.x, pos.y))
    }

    /// Is the only thing standing here a road that dead-ends on this tile?
    ///
    /// A building may be raised over one, because that is what a driveway is:
    /// a road that ends inside the plot. A road carrying traffic through has
    /// two arms and is a street, and a street may not be built over.
    ///
    fn is_driveway_stub(&self, coord: GridCoord) -> bool {
        let Some(node) = self.road_node_at(coord) else { return false };
        if self.unique_connection_count(node) > 1 {
            return false;
        }
        if self.occupied.contains_key(&(coord.x, coord.y)) {
            return false;
        }
        matches!(
            self.terrain.get(&(coord.x, coord.y)),
            Some(TerrainType::Grass | TerrainType::Beach | TerrainType::Forest)
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
        !self.would_be_too_sharp(from, to.x - from.x, to.y - from.y, false)
    }

    /// How a kind's plot could lie at `pos`: the first facing whose whole
    /// plot is open land and whose lot fronts a street, with that street and
    /// the tile the driveway lands on. A kind with no lot fronts a street
    /// on any side, facing it.
    pub fn site_for(&self, pos: GridCoord, kind: BuildingKind) -> Option<(u8, EntityId, GridCoord)> {
        // Every way round starts on this tile, and the ghost asks about it
        // again on every frame the mayor drags a building over the map.
        if !(self.is_buildable(pos) || self.is_driveway_stub(pos)) {
            return None;
        }
        (0..4u8).find_map(|facing| self.site_facing(pos, kind, facing).map(|(street, door)| (facing, street, door)))
    }

    /// The one rule for where a driveway may run onto a plot: from a tile
    /// off the plot onto one of its entrance tiles — the lot's, or the
    /// building's own where there is no lot — either beside it, or, on the
    /// diagonal, only outward from a corner of the plot: both tiles beside
    /// the entrance on `from`'s side off the plot. A diagonal into the
    /// middle of an edge would cut the neighbouring tile at a sharp angle.
    /// Pure geometry, so the brush, the search and the preview all ask it.
    pub fn may_enter(tiles: &[GridCoord], entrances: &[GridCoord], from: GridCoord, to: GridCoord) -> bool {
        let on = |x: i32, y: i32| tiles.contains(&GridCoord { x, y });
        if !entrances.contains(&to) || !on(to.x, to.y) || on(from.x, from.y) {
            return false;
        }
        let (dx, dy) = (from.x - to.x, from.y - to.y);
        if dx.abs() > 1 || dy.abs() > 1 {
            return false;
        }
        dx == 0 || dy == 0 || (!on(to.x + dx, to.y) && !on(to.x, to.y + dy))
    }

    /// May the mayor's road run from `from` onto the plot standing at `to`?
    pub(super) fn may_enter_plot(&self, from: GridCoord, to: GridCoord) -> bool {
        let Some(&b) = self.occupied.get(&(to.x, to.y)) else { return false };
        let Some(entry) = self.objects.get(b) else { return false };
        let (Some(pos), GameObject::Building(bd)) = (entry.position, &entry.object) else { return false };
        let _ = pos;
        let lot = Self::yard_of(&bd.tiles, bd.kind, bd.facing);
        Self::may_enter(&bd.tiles, lot.as_deref().unwrap_or(&bd.tiles), from, to)
    }

    /// The driveway a plot finds for itself: the best street tile a driveway
    /// may run from, by `may_enter`, whose turn is not too sharp. Ahead of a
    /// lot before beside it, and beside it only if asked — a plot never
    /// chooses its facing by a flank, but one that already stands may open
    /// out of one; straight before diagonal. A plot with no lot is entered
    /// from any side, facing whichever street it finds.
    pub fn driveway_for(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8, sides_too: bool) -> Option<(EntityId, GridCoord)> {
        let lot = Self::yard_of(tiles, kind, facing);
        self.driveway_between(tiles, lot.as_deref(), lot.as_ref().map(|_| facing), sides_too)
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

    /// A building's yard tiles, lying this way, if its kind keeps a yard.
    pub fn yard_of(tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<Vec<GridCoord>> {
        let (o, p) = Self::lie(tiles, kind, facing);
        let ((lx, ly), ls) = p.lot?;
        Some(Self::footprint(GridCoord { x: o.x + lx as i32, y: o.y + ly as i32 }, ls).filter(|t| tiles.contains(t)).collect())
    }

    /// Does a building on these tiles work: does it hold the smallest of
    /// its kind (`blueprint::plot`), one way round or the other? One that
    /// does not stands, and nothing is served there, as if no road reached.
    pub fn works(tiles: &[GridCoord], kind: BuildingKind) -> bool {
        let (w, h) = crate::blueprint::plot(kind, 0).size;
        [(w, h), (h, w)].iter().any(|&size| tiles.iter().any(|&t| Self::footprint(t, size).all(|f| tiles.contains(&f))))
    }

    /// `driveway_for` on bare geometry: the building's tiles, its lot's,
    /// and the way it faces if a lot decides that.
    pub fn driveway_between(&self, tiles: &[GridCoord], lot: Option<&[GridCoord]>, facing: Option<u8>, sides_too: bool) -> Option<(EntityId, GridCoord)> {
        let (fx, fy) = facing.map_or((0, 0), |f| crate::blueprint::FACINGS[f as usize % 4]);
        let entrances = lot.unwrap_or(tiles);
        let mut candidates: Vec<(u8, GridCoord, GridCoord)> = Vec::new();
        for &t in entrances {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let n = GridCoord { x: t.x + dx, y: t.y + dy };
                    if !Self::may_enter(tiles, entrances, n, t) {
                        continue;
                    }
                    let ahead = dx * fx + dy * fy;
                    let rank = match (facing.is_some(), ahead) {
                        (false, _) => 0,
                        (true, a) if a > 0 => 0,
                        (true, 0) if sides_too => 2,
                        _ => continue,
                    } + (dx != 0 && dy != 0) as u8;
                    candidates.push((rank, t, n));
                }
            }
        }
        candidates.sort_by_key(|c| c.0);
        candidates.into_iter().find_map(|(_, t, n)| {
            let id = self.road_node_at(n)?;
            (self.is_street(id) && self.driveway_reaches(n, t)).then_some((id, t))
        })
    }

    /// The street and door a kind's plot would have at `pos` facing this
    /// way, if it fits there.
    pub fn site_facing(&self, pos: GridCoord, kind: BuildingKind, facing: u8) -> Option<(EntityId, GridCoord)> {
        if !self.fits(pos, kind, facing) {
            return None;
        }
        let tiles: Vec<GridCoord> = Self::footprint(pos, crate::blueprint::plot(kind, facing).size).collect();
        self.driveway_for(&tiles, kind, facing, false)
    }

    /// Can a kind's plot stand here this way round: open ground under the
    /// whole footprint, and, for a kind whose lorry is a ship, water
    /// behind its back for the quay (`world/sea.rs`).
    pub fn fits(&self, pos: GridCoord, kind: BuildingKind, facing: u8) -> bool {
        let p = crate::blueprint::plot(kind, facing);
        Self::footprint(pos, p.size).all(|t| self.is_buildable(t) || self.is_driveway_stub(t))
            && (!crate::economy::ships(kind) || self.quay_at(&Self::footprint(pos, p.size).collect::<Vec<_>>(), kind, facing).is_some())
    }

    /// The street node a building is reached by: where every trip to it
    /// ends and from it starts, its lot taking the car the rest of the way.
    /// The edge stands on its road. `None` is a building no road reaches.
    pub fn street_of(&self, id: EntityId) -> Option<EntityId> {
        if self.edge.contains(&id) {
            let b = self.objects.get(id)?.position?;
            return self.road_node_at(b);
        }
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

    pub(super) fn set_door(&mut self, id: EntityId, door: Option<crate::protocol::Door>) {
        if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            b.door = door;
        }
    }

    /// What joins two tiles beside each other, for the demolisher to cut:
    /// a road between them, a building's door onto its street, or a row of
    /// houses drawn as one.
    pub fn link_between(&self, a: GridCoord, b: GridCoord) -> Option<Link> {
        if (a.x - b.x).abs() > 1 || (a.y - b.y).abs() > 1 || a == b {
            return None;
        }
        if self.are_connected(a, b) {
            return Some(Link::Road(self.road_node_at(a)?, self.road_node_at(b)?));
        }
        let (on_a, on_b) = (self.occupied.get(&(a.x, a.y)).copied(), self.occupied.get(&(b.x, b.y)).copied());
        let door = |id: Option<EntityId>, tile: GridCoord, street: GridCoord| {
            id.filter(|&id| matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Building(bd)) if bd.door == Some(crate::protocol::Door { tile, street })))
        };
        if let Some(id) = door(on_a, a, b).or(door(on_b, b, a)) {
            return Some(Link::Door(id));
        }
        match (on_a, on_b) {
            (Some(x), Some(y)) if x != y && self.joined_of(x).contains(&b) => Some(Link::Row(x, y)),
            _ => None,
        }
    }

    /// A door shut: the building is cut off from its street until one is
    /// drawn to it again, and its lot goes.
    pub fn close_door(&mut self, id: EntityId) {
        self.drop_lot(id);
        self.set_door(id, None);
    }

    /// Two houses of a row let go of each other where they meet.
    pub fn unlink(&mut self, a: EntityId, b: EntityId) {
        let tiles = |w: &World, id| match w.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(bd)) => bd.tiles.clone(),
            _ => Vec::new(),
        };
        let (ta, tb) = (tiles(self, a), tiles(self, b));
        for (id, other) in [(a, tb), (b, ta)] {
            if let Some(GameObject::Building(bd)) = self.objects.get_mut(id).map(|e| &mut e.object) {
                bd.joined.retain(|t| !other.contains(t));
            }
        }
    }

    /// A road's dead end under a building painted over it: the road goes,
    /// and the street it ended off becomes the building's door, if it
    /// may be one. That is how the mayor says where a door goes before
    /// the building is there.
    fn take_stub(&mut self, id: EntityId, tile: GridCoord) {
        let Some(node) = self.road_node_at(tile) else { return };
        let street = self.arms_of(node, false).first().and_then(|&a| self.objects.get(a)?.position);
        for edge in self.edges_involving(node) {
            self.remove_edge(edge.0, edge.1);
        }
        self.demolish_node(node);
        // Whatever else the stub's street served is served again.
        self.open_doors_along(&[tile]);
        if let Some(street) = street
            && self.road_node_at(street).is_some_and(|s| self.is_street(s) && self.driveway_reaches(street, tile))
        {
            self.set_door(id, Some(crate::protocol::Door { tile, street }));
        }
    }

    /// Every building standing on the land, as (id, position) — the edge is
    /// not one of them; it stands where the map stops. Only tests still want
    /// the world flattened like this; the simulation itself always knows
    /// which building it means.
    #[cfg(test)]
    pub fn all_buildings(&self) -> Vec<(EntityId, GridCoord)> {
        self.objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(_)) && !self.edge.contains(&e.id))
            .filter_map(|e| e.position.map(|p| (e.id, p)))
            .collect()
    }

    /// Put a building on the map, road or no road.
    ///
    /// Everything that has to happen per building — occupancy, spatial
    /// indexing across every chunk it touches, revealing the map — happens
    /// here, so none of it can be forgotten at a call site. A building with
    /// no road is dormant: it stands, and nothing serves it until one comes.
    pub fn place_building(
        &mut self,
        pos: GridCoord,
        kind: BuildingKind,
        facing: u8,
    ) -> Option<EntityId> {
        if !self.fits(pos, kind, facing) {
            return None;
        }
        let tiles: Vec<GridCoord> = Self::footprint(pos, crate::blueprint::plot(kind, facing).size).collect();
        let id = self.insert_at(GameObject::Building(Building::new(kind, tiles.clone(), facing)), Some(pos));
        for tile in &tiles {
            self.take_stub(id, *tile);
            self.occupied.insert((tile.x, tile.y), id);
            // A footprint can straddle a chunk border, and clients subscribe by
            // chunk — indexed only at its origin, a building would vanish for
            // anyone looking at the other half.
            self.spatial.entry(crate::world::chunk_of(*tile)).or_default().insert(id);
        }
        self.reveal_around(pos);
        Some(id)
    }

    /// The building on this tile, if any.
    pub(super) fn claimed_plot_at(&self, tile: GridCoord) -> Option<EntityId> {
        self.occupied.get(&(tile.x, tile.y)).copied()
    }

    /// Give a building its door, if a street is beside it; nothing beside
    /// it, nothing happens. A building whose door still stands keeps it.
    pub fn open_door(&mut self, id: EntityId) -> bool {
        let Some(GameObject::Building(b)) = self.objects.get(id).map(|e| &e.object) else { return false };
        if !Self::works(&b.tiles, b.kind) {
            return false;
        }
        if self.door_of(id).is_none() {
            let (tiles, kind, facing) = (b.tiles.clone(), b.kind, b.facing);
            // It faces the way a street lets it: the way it was laid if a
            // street is there, else the first that has one.
            let facing = std::iter::once(facing).chain(0..4).find(|&f| self.driveway_for(&tiles, kind, f, false).is_some()).unwrap_or(facing);
            if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
                b.facing = facing;
            }
            let Some((street, tile)) = self.driveway_for(&tiles, kind, facing, true) else { return false };
            let Some(street) = self.objects.get(street).and_then(|e| e.position) else { return false };
            self.set_door(id, Some(crate::protocol::Door { tile, street }));
        }
        // Reached: a depot's lorries come with it, and a farm claims its land.
        crate::calls::stable(self, id);
        self.claim_land(id);
        true
    }

    /// Every dormant building beside any of these tiles gets its door.
    /// Called for every road laid for real, so a road reaching a building
    /// is all it takes.
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
            self.open_door(id);
        }
    }

    /// A building that can be driven to, or nothing: the placer works out
    /// the facing itself, and the driveway goes in with it.
    pub fn place_on_street(&mut self, pos: GridCoord, kind: BuildingKind) -> Option<EntityId> {
        let (facing, _, _) = self.site_for(pos, kind)?;
        let id = self.place_building(pos, kind, facing)?;
        self.open_door(id);
        Some(id)
    }

    /// A step of the mayor's brush: `to` painted with a kind, and joined to
    /// the building of the kind on `from` beside it, if there is one: a
    /// kind that grows takes the tile in, one a tile big stands a building
    /// of its own linked to it (`Building::joined`), a row of houses. A tap,
    /// or a step from anything else, is a building of its own. A step from
    /// one building onto another of its kind joins the two, the older kept,
    /// or links them. The building laid, if a tile was.
    pub fn paint(&mut self, kind: BuildingKind, from: GridCoord, to: GridCoord) -> Option<EntityId> {
        if !self.may_paint(kind, from, to) {
            return None;
        }
        let here = self.drawn_from(kind, from, to);
        let grows = grows(kind);
        if let (Some(a), Some(&b)) = (here, self.occupied.get(&(to.x, to.y))) {
            if grows {
                self.join(a.min(b), a.max(b));
            } else {
                self.link(a, from, b, to);
            }
            return None;
        }
        let id = match here.filter(|_| grows) {
            Some(id) => {
                if let Some(GameObject::Building(b)) = self.objects.get_mut(id).map(|e| &mut e.object) {
                    b.tiles.push(to);
                }
                id
            }
            None => self.insert_at(GameObject::Building(Building::new(kind, vec![to], 2)), Some(to)),
        };
        self.take_stub(id, to);
        self.occupy(id, to);
        self.open_door(id);
        if let Some(a) = here.filter(|_| !grows) {
            self.link(a, from, id, to);
        }
        Some(id)
    }

    /// May a step of the brush paint `to` with a kind, from `from`: open
    /// ground, or another building of the kind to join or link to the one
    /// the step came from. The one rule, which the brush is refused by and
    /// the client's dots mirror (`client/src/engine/may.ts`).
    pub fn may_paint(&self, kind: BuildingKind, from: GridCoord, to: GridCoord) -> bool {
        match self.occupied.get(&(to.x, to.y)) {
            Some(&there) => {
                self.kind_at(there) == Some(kind)
                    && self.drawn_from(kind, from, to).is_some_and(|here| here != there && (grows(kind) || !self.joined_of(here).contains(&to)))
            }
            None => self.is_buildable(to) || self.is_driveway_stub(to),
        }
    }

    /// Would a building painted from `from` to `to` be reached: one already
    /// standing there, joined or linked to; grown on to one of its kind;
    /// or, new, on a tile a street may run a drive to. The mayor paints
    /// only what can work; a town written as a fixture stands as written.
    pub fn would_be_reached(&self, kind: BuildingKind, from: GridCoord, to: GridCoord) -> bool {
        self.occupied.contains_key(&(to.x, to.y))
            || (grows(kind) && self.drawn_from(kind, from, to).is_some())
            || self.road_node_at(to).is_some()
            || self.driveway_between(&[to], None, None, true).is_some()
    }

    /// The building of the kind on `from` beside `to`: what a step to `to`
    /// carries on from.
    fn drawn_from(&self, kind: BuildingKind, from: GridCoord, to: GridCoord) -> Option<EntityId> {
        let beside = (from.x - to.x).abs() <= 1 && (from.y - to.y).abs() <= 1 && from != to;
        let id = *self.occupied.get(&(from.x, from.y))?;
        (beside && self.kind_at(id) == Some(kind)).then_some(id)
    }

    fn joined_of(&self, id: EntityId) -> &[GridCoord] {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => &b.joined,
            _ => &[],
        }
    }

    /// Two buildings linked where they meet: each keeps the other's tile.
    fn link(&mut self, a: EntityId, at_a: GridCoord, b: EntityId, at_b: GridCoord) {
        for (id, other) in [(a, at_b), (b, at_a)] {
            if let Some(GameObject::Building(bd)) = self.objects.get_mut(id).map(|e| &mut e.object)
                && !bd.joined.contains(&other)
            {
                bd.joined.push(other);
            }
        }
    }

    fn kind_at(&self, id: EntityId) -> Option<BuildingKind> {
        match self.objects.get(id)?.object {
            GameObject::Building(ref b) => Some(b.kind),
            _ => None,
        }
    }

    /// One building of a kind takes in another beside it: its tiles, and
    /// the other is gone.
    fn join(&mut self, keep: EntityId, gone: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(gone).map(|e| &e.object) else { return };
        let tiles = b.tiles.clone();
        self.remove_building(gone);
        if let Some(GameObject::Building(b)) = self.objects.get_mut(keep).map(|e| &mut e.object) {
            b.tiles.extend(&tiles);
        }
        for t in tiles {
            self.occupy(keep, t);
        }
        self.drop_lot(keep);
        self.open_door(keep);
    }

    /// A tile taken out of the building on it. A building cut in two is
    /// two: the part with the tile it is known by keeps it, its people and
    /// its stock, and every other part is a building of its own, new. The
    /// last tile taken is the building gone.
    pub fn unpaint(&mut self, tile: GridCoord) -> bool {
        let Some(&id) = self.occupied.get(&(tile.x, tile.y)) else { return false };
        let Some(GameObject::Building(b)) = self.objects.get(id).map(|e| &e.object) else { return false };
        let (kind, facing) = (b.kind, b.facing);
        let rest: Vec<GridCoord> = b.tiles.iter().copied().filter(|&t| t != tile).collect();
        if rest.is_empty() {
            // Its row lets go of it.
            for t in b.joined.clone() {
                if let Some(&other) = self.occupied.get(&(t.x, t.y))
                    && let Some(GameObject::Building(o)) = self.objects.get_mut(other).map(|e| &mut e.object)
                {
                    o.joined.retain(|&j| j != tile);
                }
            }
            self.remove_building(id);
            return true;
        }
        self.drop_lot(id);
        self.occupied.remove(&(tile.x, tile.y));
        let mut parts = pieces(&rest);
        let anchor = self.objects.get(id).and_then(|e| e.position).unwrap_or(tile);
        let first = parts.iter().position(|p| p.contains(&anchor)).unwrap_or(0);
        let kept = parts.remove(first);
        if let Some(entry) = self.objects.get_mut(id) {
            if !kept.contains(&anchor) {
                entry.position = Some(kept[0]);
            }
            if let GameObject::Building(ref mut b) = entry.object {
                b.tiles = kept.clone();
            }
        }
        self.reindex(id, &kept);
        for part in parts {
            let new = self.insert_at(GameObject::Building(Building::new(kind, part.clone(), facing)), Some(part[0]));
            for &t in &part {
                self.occupy(new, t);
            }
            self.open_door(new);
        }
        self.open_door(id);
        true
    }

    /// The tile is the building's: occupancy, and every chunk it stands in
    /// indexed, so it is seen from any of them.
    fn occupy(&mut self, id: EntityId, t: GridCoord) {
        self.occupied.insert((t.x, t.y), id);
        self.spatial.entry(crate::world::chunk_of(t)).or_default().insert(id);
        self.reveal_around(t);
    }

    /// Index a building in exactly the chunks its tiles are in.
    fn reindex(&mut self, id: EntityId, tiles: &[GridCoord]) {
        let chunks: std::collections::HashSet<_> = tiles.iter().map(|&t| crate::world::chunk_of(t)).collect();
        for (chunk, ids) in self.spatial.iter_mut() {
            if !chunks.contains(chunk) {
                ids.remove(&id);
            }
        }
        for chunk in chunks {
            self.spatial.entry(chunk).or_default().insert(id);
        }
    }

    /// The one way a building leaves.
    pub fn remove_building(&mut self, id: EntityId) {
        self.drop_lot(id);
        let Some(entry) = self.objects.get(id) else { return };
        let GameObject::Building(ref b) = entry.object else { return };
        let tiles = b.tiles.clone();

        for tile in &tiles {
            self.occupied.remove(&(tile.x, tile.y));
            self.unindex(id, *tile);
        }
        self.objects.remove(id);
    }

    /// A save from when a drive was a road: the road node on a building's
    /// tile, its own or the stub it was painted over, becomes its door,
    /// and goes. A car on its way over one is scrapped, and the settle
    /// that follows a load gives its owner another.
    pub fn doors_from_drives(&mut self) {
        let buildings: Vec<(EntityId, Vec<GridCoord>)> = self
            .objects
            .iter()
            .filter(|e| !self.edge.contains(&e.id))
            .filter_map(|e| match e.object {
                GameObject::Building(ref b) => Some((e.id, b.tiles.clone())),
                _ => None,
            })
            .collect();
        let mut gone: std::collections::HashSet<EntityId> = Default::default();
        for (id, tiles) in buildings {
            for tile in tiles {
                let Some(node) = self.road_node_at(tile) else { continue };
                if self.door_of(id).is_none()
                    && let Some(street) = self.arms_of(node, false).first().and_then(|&a| self.objects.get(a)?.position)
                {
                    self.set_door(id, Some(crate::protocol::Door { tile, street }));
                }
                for edge in self.edges_involving(node) {
                    self.remove_edge(edge.0, edge.1);
                }
                self.demolish_node(node);
                gone.insert(node);
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

    /// Rebuild the tile→building index from the stored buildings, reading
    /// a save's plot into its tiles on the way.
    pub fn rebuild_occupied(&mut self) {
        self.occupied.clear();
        let ids: Vec<EntityId> = self.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
        for id in ids {
            let Some(entry) = self.objects.get_mut_silent(id) else { continue };
            let pos = entry.position;
            let GameObject::Building(ref mut b) = entry.object else { continue };
            if let (Some(size), Some(pos)) = (b.size.take(), pos) {
                b.tiles = Self::footprint(pos, size).collect();
            }
            for tile in b.tiles.clone() {
                self.occupied.insert((tile.x, tile.y), id);
                self.spatial.entry(crate::world::chunk_of(tile)).or_default().insert(id);
            }
        }
    }
}

/// Tiles in the pieces they fall into, each held together by tiles beside
/// one another or on a diagonal: a building cut in two is two.
fn pieces(tiles: &[GridCoord]) -> Vec<Vec<GridCoord>> {
    let mut left: Vec<GridCoord> = tiles.to_vec();
    let mut out = Vec::new();
    while let Some(seed) = left.first().copied() {
        let mut piece = vec![seed];
        left.retain(|&t| t != seed);
        let mut i = 0;
        while i < piece.len() {
            let p = piece[i];
            let (near, far): (Vec<GridCoord>, Vec<GridCoord>) = left.iter().partition(|t| (t.x - p.x).abs() <= 1 && (t.y - p.y).abs() <= 1);
            piece.extend(near);
            left = far;
            i += 1;
        }
        out.push(piece);
    }
    out
}

/// What joins two tiles beside each other (`World::link_between`).
pub enum Link {
    /// A road, between these two nodes, either way.
    Road(EntityId, EntityId),
    /// This building's door onto its street.
    Door(EntityId),
    /// Two houses of a row.
    Row(EntityId, EntityId),
}

/// Does a kind grow into one building as it is painted, or stand a
/// building a tile, linked to its row: a kind a tile big, a home or a
/// shop of its own on each.
fn grows(kind: BuildingKind) -> bool {
    crate::blueprint::plot(kind, 0).size != (1, 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A world with nothing in it but grass and the given road path.
    fn world_with_road(path: &[(i32, i32)]) -> World {
        let mut world = World::new();
        for y in -8..8 {
            for x in -8..8 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
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

        world.handle_place_road(GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }, false, false);
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
        world.handle_place_road(GridCoord { x: 1, y: 1 }, GridCoord { x: 1, y: 0 }, false, false);
        assert_eq!(world.door_of(b).map(|d| d.0), Some(GridCoord { x: 1, y: 0 }));
        world.handle_place_road(GridCoord { x: 0, y: 0 }, GridCoord { x: 1, y: 0 }, false, false);
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
        world.handle_place_road(GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }, false, false);

        world.handle_place_road(GridCoord { x: 2, y: 0 }, GridCoord { x: 3, y: 0 }, false, false);
        assert!(world.road_node_at(GridCoord { x: 3, y: 0 }).is_none(), "the road stops at the door");
    }

    #[test]
    fn takes_a_road_straight_on() {
        let world = world_with_road(&[(0, 1), (1, 1)]);
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_some());
    }

    /// The case the corner rule exists for: no perimeter tile is orthogonally
    /// adjacent to this road, only the corner touches it.
    #[test]
    fn takes_a_road_off_its_corner() {
        let world = world_with_road(&[(1, 1), (2, 2)]);
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_some());
    }

    #[test]
    fn corner_rule_reaches_past_a_wide_footprint() {
        // Footprint covers (0,0) and (1,0); the road only meets its far corner.
        let world = world_with_road(&[(2, 1), (3, 2)]);
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 0, y: 0 }, (2, 1)).collect::<Vec<_>>(), None, None, false).is_some());
    }

    #[test]
    fn no_road_in_reach_is_no_access() {
        let world = world_with_road(&[(5, 5), (6, 5)]);
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_none());
    }

    /// A road two tiles out is not access, diagonally or otherwise.
    #[test]
    fn diagonals_do_not_reach_two_tiles() {
        let world = world_with_road(&[(2, 2), (3, 3)]);
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 0, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_none());
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
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 1, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_none());
    }

    /// The perpendicular of a diagonal is diagonal, so this one connects.
    #[test]
    fn plot_offset_diagonally_from_a_diagonal_connects() {
        let world = diagonal_world();
        assert!(world.driveway_between(&World::footprint(GridCoord { x: 2, y: 0 }, (1, 1)).collect::<Vec<_>>(), None, None, false).is_some());
    }

    /// The reachability index is maintained edit by edit rather than rebuilt,
    /// so the thing worth testing is that it never drifts from the graph it
    /// claims to describe. Brute-forces the answer and demands agreement.
    fn agrees_with_the_edges(world: &World) {
        let mut adj: std::collections::HashMap<EntityId, Vec<EntityId>> =
            std::collections::HashMap::new();
        for &(a, b) in world.edges.keys() {
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
        }
        let nodes: Vec<EntityId> = adj.keys().copied().collect();
        for &from in &nodes {
            let mut seen = HashSet::from([from]);
            let mut stack = vec![from];
            while let Some(n) = stack.pop() {
                for &next in adj.get(&n).into_iter().flatten() {
                    if seen.insert(next) {
                        stack.push(next);
                    }
                }
            }
            for &to in &nodes {
                assert_eq!(
                    world.network.connected(from, to),
                    seen.contains(&to),
                    "index disagrees about {from} -> {to}",
                );
            }
        }
    }

    /// Demolition as the game loop does it: edges first, then the node.
    fn lift_road(world: &mut World, at: GridCoord) {
        let Some(id) = world.road_node_at(at) else { return };
        for edge in world.edges_involving(id) {
            world.remove_edge(edge.0, edge.1);
        }
        world.demolish_node(id);
    }

    /// One house on one tile, built.
    fn house(world: &mut World, x: i32, y: i32) -> EntityId {
        world
            .place_on_street(GridCoord { x, y }, BuildingKind::House)
            .expect("a road should be beside it")
    }

    #[test]
    fn the_index_follows_roads_being_laid() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0)]);
        agrees_with_the_edges(&world);

        // A second road that touches nothing is a second network.
        world.place_road_path(&[GridCoord { x: 0, y: 5 }, GridCoord { x: 1, y: 5 }]);
        let a = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let b = world.road_node_at(GridCoord { x: 1, y: 5 }).unwrap();
        assert!(!world.network.connected(a, b), "roads that never meet are two networks");
        agrees_with_the_edges(&world);

        // Joining them makes one.
        world.place_road_path(&[
            GridCoord { x: 2, y: 0 },
            GridCoord { x: 2, y: 5 },
            GridCoord { x: 1, y: 5 },
        ]);
        assert!(world.network.connected(a, b), "a road between them joins them");
        agrees_with_the_edges(&world);
    }

    /// Red means one thing: not joined to the world. A road that reaches
    /// past the survey is how people arrive; one that reaches nothing is an
    /// island, and every node of it says so — and stops saying so the moment
    /// a road joins it up, or starts again when the road is cut.
    #[test]
    fn a_road_that_reaches_nothing_is_an_island() {
        let mut world = World::new();
        for y in -8..8 {
            for x in -8..140 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        // The survey covers the middle; the street runs out past it.
        world.reveal_around(GridCoord { x: 0, y: 0 });
        let street: Vec<GridCoord> = (0..130).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        let joined = |world: &World, at: GridCoord| {
            let id = world.road_node_at(at).unwrap();
            matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.joined)
        };
        assert!(joined(&world, GridCoord { x: 0, y: 0 }), "the street reaches beyond the survey");

        let lane: Vec<GridCoord> = (2..6).map(|y| GridCoord { x: 3, y }).collect();
        world.place_road_path(&lane);
        assert!(!joined(&world, GridCoord { x: 3, y: 4 }), "a lane touching nothing is an island");

        world.place_road_path(&[GridCoord { x: 3, y: 0 }, GridCoord { x: 3, y: 1 }, GridCoord { x: 3, y: 2 }]);
        assert!(joined(&world, GridCoord { x: 3, y: 5 }), "joined to the street, it is joined to the world");

        lift_road(&mut world, GridCoord { x: 3, y: 1 });
        assert!(!joined(&world, GridCoord { x: 3, y: 5 }), "cut off again");
        assert!(joined(&world, GridCoord { x: 3, y: 0 }), "the street is unmoved");

        // Cut the street inside the survey, between the town and the world:
        // the whole town is an island, and the far end still reaches beyond.
        lift_road(&mut world, GridCoord { x: 60, y: 0 });
        assert!(!joined(&world, GridCoord { x: 0, y: 0 }), "the town lost its way out");
        assert!(joined(&world, GridCoord { x: 100, y: 0 }), "the far end still reaches beyond");
    }

    #[test]
    fn lifting_a_road_cuts_the_network_where_it_stood() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (3, 0)]);
        let west = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let east = world.road_node_at(GridCoord { x: 3, y: 0 }).unwrap();
        assert!(world.network.connected(west, east));

        lift_road(&mut world, GridCoord { x: 2, y: 0 });
        assert!(!world.network.connected(west, east), "the cut severs the road");
        agrees_with_the_edges(&world);
    }

    #[test]
    fn lifting_one_road_of_a_loop_leaves_it_whole() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (2, 1), (2, 2), (1, 2), (0, 2), (0, 1), (0, 0)]);
        let a = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let b = world.road_node_at(GridCoord { x: 2, y: 2 }).unwrap();

        lift_road(&mut world, GridCoord { x: 1, y: 0 });
        assert!(world.network.connected(a, b), "the long way round still joins them");
        agrees_with_the_edges(&world);
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

    #[test]
    fn a_search_onto_an_island_is_refused() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        world.place_road_path(&[GridCoord { x: 0, y: 6 }, GridCoord { x: 1, y: 6 }]);
        let here = world.road_node_at(GridCoord { x: 0, y: 1 }).unwrap();
        let island = world.road_node_at(GridCoord { x: 1, y: 6 }).unwrap();
        assert!(crate::world::pathfinding::Routes::from(&world, here).route_to(island).is_none());
    }

    #[test]
    fn a_straight_street_is_one_segment_and_a_junction_splits_it() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]);
        assert_eq!(world.network.segment_count(), 1, "an unbroken street is one run");

        // A side road off the middle: the street becomes two, plus the branch.
        world.place_road_path(&[GridCoord { x: 2, y: 0 }, GridCoord { x: 2, y: 1 }]);
        assert_eq!(world.network.segment_count(), 3, "a junction cuts the run");

        lift_road(&mut world, GridCoord { x: 2, y: 1 });
        assert_eq!(world.network.segment_count(), 1, "and the halves join back up");
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

    /// A stroke along a street with the brush, from tile to tile.
    fn stroke(world: &mut World, kind: BuildingKind, tiles: &[(i32, i32)]) -> Vec<Option<EntityId>> {
        let at: Vec<GridCoord> = tiles.iter().map(|&(x, y)| GridCoord { x, y }).collect();
        (0..at.len()).map(|i| world.paint(kind, at[i.saturating_sub(1)], at[i])).collect()
    }

    fn tiles_of(world: &World, id: EntityId) -> Vec<GridCoord> {
        match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.tiles.clone(),
            _ => Vec::new(),
        }
    }

    /// A kind that grows is one building as far as it is painted; a house
    /// is a house a tile, however it was painted.
    #[test]
    fn a_stroke_is_one_building_and_houses_are_a_tile_each() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let factory = stroke(&mut world, BuildingKind::Factory, &[(-4, 1), (-3, 1), (-2, 1)]);
        assert!(factory.iter().all(|&id| id == factory[0]), "one factory: {factory:?}");
        assert_eq!(tiles_of(&world, factory[0].unwrap()).len(), 3);
        let houses = stroke(&mut world, BuildingKind::House, &[(1, 1), (2, 1), (3, 1)]);
        assert_eq!(houses.iter().flatten().collect::<HashSet<_>>().len(), 3, "three houses: {houses:?}");
    }

    /// Smaller than its kind works in, a building stands and nothing is
    /// served there: no driveway, as if no road came. Painted out to size,
    /// it gets one.
    #[test]
    fn a_building_too_small_does_not_work_until_it_is_painted_out() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let depot = stroke(&mut world, BuildingKind::Warehouse, &[(0, 1)])[0].unwrap();
        assert!(world.street_of(depot).is_none(), "one tile is no depot");
        stroke(&mut world, BuildingKind::Warehouse, &[(0, 1), (1, 1), (1, 2), (0, 2), (0, 3), (1, 3), (1, 4), (0, 4)]);
        assert_eq!(tiles_of(&world, depot).len(), 8);
        assert!(world.street_of(depot).is_some(), "two by four is, and the street reaches it");
    }

    /// A building cut in two is two: the part with the tile it is known by
    /// is still it, and the other is new.
    #[test]
    fn a_building_cut_in_two_is_two() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let factory = stroke(&mut world, BuildingKind::Factory, &[(-2, 1), (-1, 1), (0, 1), (1, 1), (2, 1)])[0].unwrap();
        assert!(world.unpaint(GridCoord { x: 0, y: 1 }));
        assert_eq!(tiles_of(&world, factory), vec![GridCoord { x: -2, y: 1 }, GridCoord { x: -1, y: 1 }]);
        let other = world.occupied[&(2, 1)];
        assert_ne!(other, factory);
        assert_eq!(world.occupied[&(1, 1)], other);
        assert!(world.street_of(other).is_some(), "the new one is reached too");
        // The last tile taken is the building gone.
        world.unpaint(GridCoord { x: 1, y: 1 });
        world.unpaint(GridCoord { x: 2, y: 1 });
        assert!(world.objects.get(other).is_none());
    }

    /// A step from one building onto another of its kind joins them, and
    /// the older is kept.
    #[test]
    fn a_step_across_joins_two_into_the_older() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        let a = stroke(&mut world, BuildingKind::Factory, &[(-2, 1), (-1, 1)])[0].unwrap();
        let b = stroke(&mut world, BuildingKind::Factory, &[(1, 1), (0, 1)])[0].unwrap();
        assert_ne!(a, b, "a tap starts a building of its own");
        world.paint(BuildingKind::Factory, GridCoord { x: 0, y: 1 }, GridCoord { x: -1, y: 1 });
        assert!(world.objects.get(b).is_none(), "the younger is taken in");
        assert_eq!(tiles_of(&world, a).len(), 4);
    }

    fn joined(world: &World, x: i32) -> Vec<GridCoord> {
        match world.objects.get(world.occupied[&(x, 1)]).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.joined.clone(),
            _ => Vec::new(),
        }
    }

    /// Houses drawn in a row are linked, each a house of its own; one
    /// tapped beside them is not, until the hand draws from one onto it;
    /// one taken away lets go of its row.
    #[test]
    fn houses_drawn_in_a_row_are_linked_and_tapped_ones_are_not() {
        let mut world = world_with_road(&(-6..=6).map(|x| (x, 0)).collect::<Vec<_>>());
        stroke(&mut world, BuildingKind::House, &[(1, 1), (2, 1)]);
        let at = |x| GridCoord { x, y: 1 };
        assert_eq!(joined(&world, 1), vec![at(2)]);
        assert_eq!(joined(&world, 2), vec![at(1)]);
        stroke(&mut world, BuildingKind::House, &[(3, 1)]);
        assert!(joined(&world, 3).is_empty(), "a tap beside a house is a house apart");
        assert_eq!(world.paint(BuildingKind::House, at(2), at(3)), None, "a link lays no house");
        assert_eq!(joined(&world, 3), vec![at(2)]);
        assert!(!world.may_paint(BuildingKind::House, at(2), at(3)), "nor links twice");
        world.unpaint(at(2));
        assert!(joined(&world, 1).is_empty() && joined(&world, 3).is_empty(), "a house gone lets go of its row");
    }
}
