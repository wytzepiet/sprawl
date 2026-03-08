use std::collections::{HashMap, HashSet};

use crate::protocol::{EntityId, GameObjectEntry, GameObject, GridCoord};

pub struct Tracked {
    data: HashMap<EntityId, GameObjectEntry>,
    dirty: HashSet<EntityId>,
    removed: Vec<EntityId>,
    next_id: u64,
}

impl Tracked {
    pub fn new() -> Self {
        Self {
            data: HashMap::new(),
            dirty: HashSet::new(),
            removed: Vec::new(),
            next_id: 1,
        }
    }

    pub fn insert(&mut self, object: GameObject, position: Option<GridCoord>) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        self.data.insert(id, GameObjectEntry { id, object, position });
        self.dirty.insert(id);
        id
    }

    pub fn get(&self, id: EntityId) -> Option<&GameObjectEntry> {
        self.data.get(&id)
    }

    pub fn get_mut(&mut self, id: EntityId) -> Option<&mut GameObjectEntry> {
        if self.data.contains_key(&id) {
            self.dirty.insert(id);
        }
        self.data.get_mut(&id)
    }

    pub fn remove(&mut self, id: EntityId) {
        if self.data.remove(&id).is_some() {
            self.dirty.remove(&id);
            self.removed.push(id);
        }
    }

    /// Returns (changed_ids, removed_ids) and clears both sets.
    pub fn drain_dirty(&mut self) -> (Vec<EntityId>, Vec<EntityId>) {
        let changed: Vec<EntityId> = self.dirty.drain().collect();
        let removed = std::mem::take(&mut self.removed);
        (changed, removed)
    }

    pub fn all_entries(&self) -> Vec<GameObjectEntry> {
        self.data.values().cloned().collect()
    }

    pub fn clear(&mut self) {
        for id in self.data.keys().copied().collect::<Vec<_>>() {
            self.removed.push(id);
        }
        self.data.clear();
        self.dirty.clear();
    }
}
