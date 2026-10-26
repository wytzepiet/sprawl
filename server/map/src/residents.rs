use model::{EntityId, GameObject};
use crate::Map;

impl Map {
    pub fn tie(&mut self, resident: EntityId, building: EntityId) {
        self.people.entry(building).or_default().insert(resident);
    }

    pub fn untie(&mut self, resident: EntityId, building: EntityId) {
        if let Some(p) = self.people.get_mut(&building) {
            p.remove(&resident);
        }
    }

    pub fn home_of(&self, id: EntityId) -> Option<EntityId> {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => Some(r.home),
            _ => None,
        }
    }

    /// Who works at a building, by id.
    pub fn staff(&self, building: EntityId) -> Vec<EntityId> {
        self.people
            .get(&building)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&id| matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.work == Some(building)))
            .collect()
    }

    /// Who lives at a building, by id.
    pub fn household(&self, building: EntityId) -> Vec<EntityId> {
        self.people.get(&building).into_iter().flatten().copied().filter(|&id| self.home_of(id) == Some(building)).collect()
    }

    /// Is this car one its owner still has: a resident's own, or a
    /// standing facility's fleet.
    pub fn owns(&self, owner: EntityId, car: EntityId) -> bool {
        match self.objects.get(owner).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.car == car,
            Some(GameObject::Building(_)) => true,
            _ => false,
        }
    }

    pub fn resident_ids(&self) -> Vec<EntityId> {
        self.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(_))).map(|e| e.id).collect()
    }
}
