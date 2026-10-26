use std::collections::{BTreeMap, BTreeSet};
use fixed::{HashMap, HashSet};

use model::{BuildingKind, EntityId, GameObjectEntry, GameObject, GridCoord};

pub struct Tracked {
    data: HashMap<EntityId, GameObjectEntry>,
    /// The ids, by id, in two piles: the road nodes, and everything else.
    /// A big town is mostly road, and what looks for a depot, a van or a
    /// resident has no business walking it.
    roads: BTreeSet<EntityId>,
    things: BTreeSet<EntityId>,
    /// Each owner's cars, by id: a facility's fleet, a household's car.
    /// A car's owner is its own from `Car::new` to its scrapping, so the
    /// two places a car is filed and taken out keep this.
    fleets: HashMap<EntityId, BTreeSet<EntityId>>,
    /// The buildings of each kind, by id: what looks for a depot or a
    /// harbour walks those, not the town. A building's kind is its own for
    /// good, as a car's owner is.
    kinds: BTreeMap<BuildingKind, BTreeSet<EntityId>>,
    dirty: HashSet<EntityId>,
    removed: Vec<EntityId>,
    persist_dirty: HashSet<EntityId>,
    persist_removed: Vec<EntityId>,
    next_id: u64,
}

impl Tracked {
    pub fn new() -> Self {
        Self {
            data: HashMap::default(),
            roads: BTreeSet::new(),
            things: BTreeSet::new(),
            fleets: HashMap::default(),
            kinds: BTreeMap::new(),
            dirty: HashSet::default(),
            removed: Vec::new(),
            persist_dirty: HashSet::default(),
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
        match entry.object {
            GameObject::Car(ref c) => {
                self.fleets.entry(c.owner).or_default().insert(entry.id);
            }
            GameObject::Building(ref b) => {
                self.kinds.entry(b.kind).or_default().insert(entry.id);
            }
            _ => {}
        }
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
        if let Some(entry) = self.data.remove(&id) {
            match entry.object {
                GameObject::Car(ref c) => {
                    if let Some(fleet) = self.fleets.get_mut(&c.owner) {
                        fleet.remove(&id);
                        if fleet.is_empty() {
                            self.fleets.remove(&c.owner);
                        }
                    }
                }
                GameObject::Building(ref b) => {
                    if let Some(kind) = self.kinds.get_mut(&b.kind) {
                        kind.remove(&id);
                    }
                }
                _ => {}
            }
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
    /// The order is load-bearing rather than tidy: what the game decides
    /// by walking it must not change with how a hasher spreads the ids
    /// (`fixed.rs`), or a new hasher is a different game. `get` stays a
    /// hash map's, the hottest call there is: two ordered maps alone cost
    /// the town two thirds more instructions.
    pub fn iter(&self) -> impl Iterator<Item = &GameObjectEntry> {
        self.things.iter().map(|id| &self.data[id])
    }

    /// The cars an owner has, by id.
    pub fn fleet(&self, owner: EntityId) -> impl Iterator<Item = EntityId> + '_ {
        self.fleets.get(&owner).into_iter().flatten().copied()
    }

    /// The buildings of a kind, by id.
    pub fn of_kind(&self, kind: BuildingKind) -> impl Iterator<Item = EntityId> + '_ {
        self.kinds.get(&kind).into_iter().flatten().copied()
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
