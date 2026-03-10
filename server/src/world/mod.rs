pub mod bezier;
mod buildings;
mod geometry;
pub mod pathfinding;
mod roads;
pub mod segments;

use std::collections::{HashMap, HashSet, VecDeque};

use crate::protocol::{EntityId, GameObject, GridCoord, SegmentId};
use crate::engine::tracked::Tracked;
use crate::world::segments::Segment;

pub struct World {
    pub objects: Tracked,
    pub(super) spatial: HashMap<GridCoord, HashSet<EntityId>>,
    pub segments: HashMap<SegmentId, Segment>,
    pub node_to_segment: HashMap<EntityId, SegmentId>,
    pub junction_outgoing: HashMap<EntityId, Vec<SegmentId>>,
    next_segment_id: SegmentId,
}

impl World {
    pub fn new() -> Self {
        Self {
            objects: Tracked::new(),
            spatial: HashMap::new(),
            segments: HashMap::new(),
            node_to_segment: HashMap::new(),
            junction_outgoing: HashMap::new(),
            next_segment_id: 1,
        }
    }

    pub fn from_loaded(objects: Tracked) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            segments: HashMap::new(),
            node_to_segment: HashMap::new(),
            junction_outgoing: HashMap::new(),
            next_segment_id: 1,
            objects,
        };
        // Rebuild spatial index from loaded objects
        for entry in world.objects.all_entries() {
            if let Some(pos) = entry.position {
                world.spatial.entry(pos).or_default().insert(entry.id);
            }
        }
        world
    }

    pub fn despawn_car(&mut self, car_id: EntityId) {
        if let Some(entry) = self.objects.get(car_id)
            && let GameObject::Car(ref car) = entry.object
            && let Some(seg) = self.segments.get_mut(&car.current_segment)
        {
            seg.cars.retain(|&id| id != car_id);
        }
        self.objects.remove(car_id);
    }

    pub fn despawn_all_cars(&mut self) {
        let car_ids: Vec<EntityId> = self.objects.all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(_)))
            .map(|e| e.id)
            .collect();
        for car_id in car_ids {
            self.objects.remove(car_id);
        }
        for seg in self.segments.values_mut() {
            seg.cars.clear();
        }
    }

    /// Build the segment graph from the current road network.
    /// Must be called after any road change. All cars must be despawned first.
    pub fn rebuild_segments(&mut self) {
        self.segments.clear();
        self.node_to_segment.clear();
        self.junction_outgoing.clear();
        self.next_segment_id = 1;

        // Collect all junction node IDs
        let junctions: Vec<EntityId> = self.objects.all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::RoadNode(_)))
            .filter(|e| self.is_junction(e.id))
            .map(|e| e.id)
            .collect();

        for &junction_id in &junctions {
            let outgoing = match self.objects.get(junction_id) {
                Some(e) => match &e.object {
                    GameObject::RoadNode(node) => node.outgoing.clone(),
                    _ => continue,
                },
                None => continue,
            };

            for &neighbor in &outgoing {
                // Walk from junction through neighbor until hitting another junction
                let mut nodes = vec![junction_id, neighbor];
                let mut current = neighbor;
                let mut prev = junction_id;

                while !self.is_junction(current) {
                    let next = match self.objects.get(current) {
                        Some(e) => match &e.object {
                            GameObject::RoadNode(node) => {
                                node.outgoing.iter().find(|&&id| id != prev).copied()
                            }
                            _ => None,
                        },
                        None => None,
                    };
                    match next {
                        Some(next_id) => {
                            nodes.push(next_id);
                            prev = current;
                            current = next_id;
                        }
                        None => break,
                    }
                }

                if !self.is_junction(current) {
                    continue;
                }

                let mut length = 0.0;
                for i in 1..nodes.len() {
                    length += self.segment_length(nodes[i - 1], nodes[i]);
                }

                let seg_id = self.next_segment_id;
                self.next_segment_id += 1;

                self.segments.insert(seg_id, Segment {
                    nodes: nodes.clone(),
                    length,
                    cars: VecDeque::new(),
                });

                for &node in &nodes[1..nodes.len() - 1] {
                    self.node_to_segment.insert(node, seg_id);
                }

                self.junction_outgoing.entry(junction_id).or_default().push(seg_id);
            }
        }

        println!(
            "rebuild_segments: {} segments, {} junctions",
            self.segments.len(),
            self.junction_outgoing.len()
        );
    }

    /// Find the car behind a given car on the same segment.
    pub fn car_behind_on_segment(&self, segment_id: SegmentId, car_id: EntityId) -> Option<EntityId> {
        let seg = self.segments.get(&segment_id)?;
        let pos = seg.car_position(car_id)?;
        if pos + 1 < seg.cars.len() {
            Some(seg.cars[pos + 1])
        } else {
            None
        }
    }
}
