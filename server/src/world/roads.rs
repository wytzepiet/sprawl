use std::collections::HashSet;

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    /// The road on this tile.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.roads.get(&(coord.x, coord.y)).copied()
    }

    /// Place a road node at coord. Idempotent: returns the node already
    /// standing here, whatever kind it is. `laid` is the mayor's own hand,
    /// counted against the build; the survey's roads and driveways are
    /// streets, laid by nobody, and free.
    fn place_road_of(&mut self, coord: GridCoord, road: bool, laid: bool) -> EntityId {
        if let Some(id) = self.road_node_at(coord) {
            return id;
        }

        let id = self.insert_at(
            GameObject::RoadNode(RoadNode {
                outgoing: vec![],
                incoming: vec![],
                joined: false,
                road,
                laid,
            }),
            Some(coord),
        );
        self.roads.insert((coord.x, coord.y), id);
        self.laid += laid as u32;
        self.unsettle_round(coord);
        let beyond = !self.revealed.contains(&crate::world::chunk_of(coord));
        self.network.set_exit(id, beyond);
        id
    }

    /// A node's neighbours.
    pub fn arms_of(&self, id: EntityId, outgoing_only: bool) -> Vec<EntityId> {
        let Some(entry) = self.objects.get(id) else { return Vec::new() };
        let GameObject::RoadNode(ref node) = entry.object else { return Vec::new() };
        if outgoing_only {
            node.outgoing.clone()
        } else {
            node.outgoing.iter().chain(node.incoming.iter()).copied().collect()
        }
    }

    /// Check if adding a connection in direction (dx, dy) at `coord` would create
    /// an angle sharper than 90° with existing connections.
    pub(super) fn would_be_too_sharp(&self, coord: GridCoord, dx: i32, dy: i32, outgoing_only: bool) -> bool {
        let id = match self.road_node_at(coord) {
            Some(id) => id,
            None => return false,
        };
        for nid in self.arms_of(id, outgoing_only) {
            if let Some(neighbor) = self.objects.get(nid)
                && let Some(npos) = neighbor.position {
                    let ndx = npos.x - coord.x;
                    let ndy = npos.y - coord.y;
                    if ndx * dx + ndy * dy > 0 {
                        return true;
                    }
                }
        }
        false
    }

    /// Check if two nodes at the given coords are connected as outgoing.
    pub fn are_connected(&self, a: GridCoord, b: GridCoord) -> bool {
        let a_id = match self.road_node_at(a) {
            Some(id) => id,
            None => return false,
        };
        let b_id = match self.road_node_at(b) {
            Some(id) => id,
            None => return false,
        };
        if let Some(entry) = self.objects.get(a_id)
            && let GameObject::RoadNode(ref node) = entry.object {
                return node.outgoing.contains(&b_id) || node.incoming.contains(&b_id);
            }
        false
    }

    /// Place road nodes at `from` and `to`, and connect them as outgoing.
    /// The mayor's own hand: what it lays is counted against the build.
    /// May a road be laid from one tile to the next: the one rule, which the
    /// mayor's hand is refused by and the map of where a road may go is
    /// drawn from.
    pub fn may_lay(&self, from: GridCoord, to: GridCoord, one_way: bool) -> bool {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 {
            return false;
        }
        // Not over water or up a mountain: a road already there, a bridge
        // the survey laid, may be carried on from.
        let wet = |t: GridCoord| {
            self.road_node_at(t).is_none()
                && matches!(self.terrain.get(&(t.x, t.y)), Some(crate::protocol::TerrainType::Water | crate::protocol::TerrainType::Sea | crate::protocol::TerrainType::Mountain))
        };
        if wet(from) || wet(to) {
            return false;
        }
        // A road may end on a building — that is its door — but never start
        // on one, or it would run in one side and out the other.
        if self.claimed_plot_at(from).is_some() {
            return false;
        }
        let into_building = self.claimed_plot_at(to).is_some();
        // A building is entered where its entry rule allows, whatever the angle.
        if into_building && !self.may_enter_plot(from, to) {
            return false;
        }
        if self.are_connected(from, to) {
            return false;
        }
        if dx.abs() == 1 && dy.abs() == 1 && self.are_connected(GridCoord { x: from.x + dx, y: from.y }, GridCoord { x: from.x, y: from.y + dy }) {
            return false;
        }
        if one_way {
            !self.would_be_too_sharp(from, dx, dy, true)
        } else {
            // Into a building, nothing stands on its tile to turn from.
            !self.would_be_too_sharp(from, dx, dy, false) && (into_building || !self.would_be_too_sharp(to, -dx, -dy, false))
        }
    }

    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool, road: bool) {
        if !self.may_lay(from, to, one_way) {
            return;
        }
        // Into a building is its door, moved here: the street it runs
        // from is laid, and nothing on the building's tile.
        if let Some(id) = self.claimed_plot_at(to) {
            self.place_road_of(from, road, true);
            self.set_door(id, Some(crate::protocol::Door { tile: to, street: from }));
            // Reached, as by a survey road: a depot's fleet and a farm's
            // land come with the door, not with the first call.
            self.open_door(id);
            return;
        }

        let from_id = self.place_road_of(from, road, true);
        let to_id = self.place_road_of(to, road, true);

        if let Some(entry) = self.objects.get_mut(from_id)
            && let GameObject::RoadNode(ref mut node) = entry.object
                && !node.outgoing.contains(&to_id) {
                    node.outgoing.push(to_id);
                }

        if one_way {
            if let Some(entry) = self.objects.get_mut(to_id)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.incoming.contains(&from_id) {
                        node.incoming.push(from_id);
                    }
        } else if let Some(entry) = self.objects.get_mut(to_id)
        && let GameObject::RoadNode(ref mut node) = entry.object
            && !node.outgoing.contains(&from_id) {
                node.outgoing.push(from_id);
            }

    }

    /// Lay a street along a path, both ways, with no player-input checks:
    /// the survey's streets and test worlds.
    pub fn place_road_path(&mut self, path: &[GridCoord]) {
        self.place_road_path_of(path, false);
    }

    /// Lay a street or a road along a path and connect consecutive nodes
    /// both ways. Free: the survey's roads are not the mayor's tiles.
    pub fn place_road_path_of(&mut self, path: &[GridCoord], road: bool) {
        if path.len() < 2 {
            return;
        }
        // Expand diagonal steps through existing road nodes to avoid triangles
        let mut expanded: Vec<GridCoord> = vec![path[0]];
        for pair in path.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            if dx != 0 && dy != 0 {
                let mid1 = GridCoord { x: a.x + dx, y: a.y };
                let mid2 = GridCoord { x: a.x, y: a.y + dy };
                if self.road_node_at(mid1).is_some() {
                    expanded.push(mid1);
                } else if self.road_node_at(mid2).is_some() {
                    expanded.push(mid2);
                }
            }
            expanded.push(b);
        }
        let ids: Vec<_> = expanded.iter().map(|&c| self.place_road_of(c, road, false)).collect();
        for pair in ids.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            // Add outgoing a→b
            if let Some(entry) = self.objects.get_mut(a)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.outgoing.contains(&b) {
                        node.outgoing.push(b);
                    }
            // Add outgoing b→a
            if let Some(entry) = self.objects.get_mut(b)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.outgoing.contains(&a) {
                        node.outgoing.push(a);
                    }
            self.insert_edge(a, b);
            self.insert_edge(b, a);
        }
        // A street reaches whatever dormant building stands beside it — once
        // the nodes are joined, since a building reached stables its fleet
        // in a lot read off its door and the street it joins.
        self.open_doors_along(&expanded);
    }

    /// Two road nodes let go of each other, both ways: the link and the
    /// edges along it.
    pub fn unlink_roads(&mut self, a: EntityId, b: EntityId) {
        for (x, y) in [(a, b), (b, a)] {
            if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(x).map(|e| &mut e.object) {
                n.outgoing.retain(|&o| o != y);
                n.incoming.retain(|&i| i != y);
            }
        }
        for (x, y) in [(a, b), (b, a)] {
            if self.edges.contains_key(&(x, y)) {
                self.remove_edge(x, y);
            }
        }
    }

    /// Remove a road node by id and clean up every reference to it. A tile
    /// the mayor laid is refunded.
    pub fn demolish_node(&mut self, id: EntityId) {
        let Some(pos) = self.objects.get(id).and_then(|e| e.position) else { return };
        let (neighbor_ids, incoming_ids, laid) = match self.objects.get(id) {
            Some(entry) => {
                if let GameObject::RoadNode(ref node) = entry.object {
                    (node.outgoing.clone(), node.incoming.clone(), node.laid)
                } else {
                    return;
                }
            }
            None => return,
        };
        self.laid -= laid as u32;

        for nid in neighbor_ids.iter().chain(incoming_ids.iter()) {
            if let Some(entry) = self.objects.get_mut(*nid)
                && let GameObject::RoadNode(ref mut node) = entry.object {
                    node.outgoing.retain(|&x| x != id);
                    node.incoming.retain(|&x| x != id);
                }
        }

        self.objects.remove(id);
        self.unindex(id, pos);
        self.roads.remove(&(pos.x, pos.y));
        self.unsettle_round(pos);
    }

    /// Check if a node is an intersection (>2 unique connections).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) > 2
    }

    /// Count what the mayor has laid, from the nodes' own flags.
    pub fn rebuild_laid(&mut self) {
        self.laid = self
            .objects
            .roads()
            .filter(|e| matches!(e.object, GameObject::RoadNode(ref n) if n.laid))
            .count() as u32;
    }

    pub(super) fn unique_connection_count(&self, node_id: EntityId) -> usize {
        let unique: HashSet<EntityId> = self.arms_of(node_id, false).into_iter().collect();
        unique.len()
    }
}
