use std::collections::{HashMap, HashSet};

use crate::protocol::{EntityId, GameObjectEntry, GameObject, GridCoord};

pub struct Tracked {
    data: HashMap<EntityId, GameObjectEntry>,
    dirty: HashSet<EntityId>,
    removed: Vec<EntityId>,
    persist_dirty: HashSet<EntityId>,
    persist_removed: Vec<EntityId>,
    next_id: u64,
}

impl Tracked {
    pub fn new() -> Self {
        Self {
            data: HashMap::new(),
            dirty: HashSet::new(),
            removed: Vec::new(),
            persist_dirty: HashSet::new(),
            persist_removed: Vec::new(),
            next_id: 1,
        }
    }

    pub fn load(entries: Vec<GameObjectEntry>, next_id: u64) -> Self {
        let data: HashMap<EntityId, GameObjectEntry> =
            entries.into_iter().map(|e| (e.id, e)).collect();
        Self {
            data,
            dirty: HashSet::new(),
            removed: Vec::new(),
            persist_dirty: HashSet::new(),
            persist_removed: Vec::new(),
            next_id,
        }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    pub fn insert(&mut self, object: GameObject, position: Option<GridCoord>) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        self.data.insert(id, GameObjectEntry { id, object, position });
        self.dirty.insert(id);
        self.persist_dirty.insert(id);
        id
    }

    pub fn get(&self, id: EntityId) -> Option<&GameObjectEntry> {
        self.data.get(&id)
    }

    pub fn get_mut(&mut self, id: EntityId) -> Option<&mut GameObjectEntry> {
        if self.data.contains_key(&id) {
            self.dirty.insert(id);
            self.persist_dirty.insert(id);
        }
        self.data.get_mut(&id)
    }

    /// Mutable access without marking dirty (for internal state updates).
    pub fn get_mut_silent(&mut self, id: EntityId) -> Option<&mut GameObjectEntry> {
        self.data.get_mut(&id)
    }

    pub fn remove(&mut self, id: EntityId) {
        if self.data.remove(&id).is_some() {
            self.dirty.remove(&id);
            self.removed.push(id);
            self.persist_dirty.remove(&id);
            self.persist_removed.push(id);
        }
    }

    /// Returns (changed_ids, removed_ids) and clears both sets. For network flush.
    pub fn drain_dirty(&mut self) -> (Vec<EntityId>, Vec<EntityId>) {
        let changed: Vec<EntityId> = self.dirty.drain().collect();
        let removed = std::mem::take(&mut self.removed);
        (changed, removed)
    }

    /// Returns (changed_ids, removed_ids) for persistence and clears the persist sets.
    pub fn drain_persist_dirty(&mut self) -> (Vec<EntityId>, Vec<EntityId>) {
        let changed: Vec<EntityId> = self.persist_dirty.drain().collect();
        let removed = std::mem::take(&mut self.persist_removed);
        (changed, removed)
    }

    pub fn all_entries(&self) -> Vec<GameObjectEntry> {
        self.data.values().cloned().collect()
    }
}
