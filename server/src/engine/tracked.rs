use std::collections::{BTreeSet, HashMap, HashSet};

use crate::protocol::{EntityId, GameObjectEntry, GameObject, GridCoord};

pub struct Tracked {
    data: HashMap<EntityId, GameObjectEntry>,
    /// The ids, by id, in two piles: the road nodes, and everything else.
    /// A played world is mostly road the survey laid ahead of the frontier,
    /// and what looks for a depot, a van or a resident has no business
    /// walking it.
    roads: BTreeSet<EntityId>,
    things: BTreeSet<EntityId>,
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
            roads: BTreeSet::new(),
            things: BTreeSet::new(),
            dirty: HashSet::new(),
            removed: Vec::new(),
            persist_dirty: HashSet::new(),
            persist_removed: Vec::new(),
            next_id: 1,
        }
    }

    pub fn load(entries: Vec<GameObjectEntry>, next_id: u64) -> Self {
        let mut tracked = Self { next_id, ..Self::new() };
        for e in entries {
            tracked.file(e);
        }
        tracked
    }

    fn file(&mut self, entry: GameObjectEntry) {
        let pile = if matches!(entry.object, GameObject::RoadNode(_)) { &mut self.roads } else { &mut self.things };
        pile.insert(entry.id);
        self.data.insert(entry.id, entry);
    }

    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// An id with no entity behind it, for things that share the id space
    /// with entities without being one: a lot's nodes.
    pub fn reserve_id(&mut self) -> EntityId {
        self.next_id += 1;
        self.next_id - 1
    }

    pub fn insert(
        &mut self,
        object: GameObject,
        position: Option<GridCoord>,
    ) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        self.file(GameObjectEntry { id, object, position });
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


    pub fn get_mut_silent(&mut self, id: EntityId) -> Option<&mut GameObjectEntry> {
        self.data.get_mut(&id)
    }

    pub fn remove(&mut self, id: EntityId) {
        if self.data.remove(&id).is_some() {
            self.roads.remove(&id);
            self.things.remove(&id);
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

    /// Everything but the road, by id.
    ///
    /// The order is load-bearing rather than tidy. A hash map hands its
    /// values back in an order seeded afresh for every process, so anything
    /// built by walking it came out arranged differently each run: different
    /// tie-breaks between equally good routes, different traffic, and two
    /// runs of the same seed that disagree, which makes any before-and-after
    /// measurement meaningless.
    pub fn iter(&self) -> impl Iterator<Item = &GameObjectEntry> {
        self.things.iter().map(|id| &self.data[id])
    }

    /// The road nodes, by id.
    pub fn roads(&self) -> impl Iterator<Item = &GameObjectEntry> {
        self.roads.iter().map(|id| &self.data[id])
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }
}
