//! Capacity, reservations and immutable running participant data and its explicit gameplay-slot bindings.
//! Connections and input history live separately in the match's control records.
use std::collections::HashMap;

use tm4_network::protocol::{Catalog, ControllerIdentity, MAX_PLAYERS, ParticipantId};

#[derive(Default)]
pub(crate) struct Participant {
    pub car: Option<String>,
    pub lobby_ready: bool,
    pub credential: Option<String>,
    pub room_credential: Option<String>,
}

impl Participant {
    pub fn select_car(
        &mut self,
        catalog: &Catalog,
        car: String,
        ready: bool,
    ) -> Result<(), &'static str> {
        if !catalog.cars.contains(&car) {
            return Err("This car is not available on the server.");
        }
        self.car = Some(car);
        self.lobby_ready = ready;
        Ok(())
    }
}

pub(crate) struct ParticipantRoster {
    participants: HashMap<ParticipantId, Participant>,
    // Slots are simulation capacity; these IDs are never array indices.
    slots: Vec<Option<ParticipantId>>,
    frozen: bool,
    next_id: u64,
}

impl ParticipantRoster {
    pub fn new(capacity: usize, reservations: &[usize]) -> Result<Self, &'static str> {
        if !(2..=MAX_PLAYERS).contains(&capacity) {
            return Err("invalid capacity");
        }
        let mut roster = Self {
            participants: HashMap::new(),
            slots: vec![None; capacity],
            frozen: false,
            next_id: 1,
        };
        for &slot in reservations {
            roster.reserve(slot)?;
        }
        Ok(roster)
    }

    fn allocate(&mut self) -> ParticipantId {
        let id = ParticipantId(self.next_id);
        self.next_id = self
            .next_id
            .checked_add(1)
            .expect("participant identity exhausted");
        assert!(
            self.participants
                .insert(id, Participant::default())
                .is_none()
        );
        id
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }
    pub fn count(&self) -> usize {
        self.participants.len()
    }
    pub fn contains(&self, slot: usize) -> bool {
        self.slots.get(slot).is_some_and(Option::is_some)
    }
    pub fn slots(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(slot, id)| id.map(|_| slot))
    }
    // These operations are preparation-only. Running membership needs a future deterministic event path.
    fn reserve(&mut self, slot: usize) -> Result<ControllerIdentity, &'static str> {
        if self.frozen || slot >= self.capacity() || self.contains(slot) {
            return Err("slot unavailable");
        }
        let id = self.allocate();
        self.slots[slot] = Some(id);
        Ok(self.binding(slot))
    }
    fn release(&mut self, binding: ControllerIdentity) -> Result<(), &'static str> {
        if self.frozen || self.resolve(&binding).is_none() {
            return Err("stale or running binding");
        }
        self.slots[usize::from(binding.slot)] = None;
        self.participants.remove(&binding.participant);
        Ok(())
    }
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn binding(&self, slot: usize) -> ControllerIdentity {
        ControllerIdentity {
            participant: self.slots[slot].expect("free slot has no controller"),
            slot: slot as u8,
        }
    }

    pub fn resolve(&self, binding: &ControllerIdentity) -> Option<usize> {
        let slot = usize::from(binding.slot);
        (self.slots.get(slot) == Some(&Some(binding.participant))).then_some(slot)
    }

    pub fn at_slot(&self, slot: usize) -> &Participant {
        &self.participants[&self.slots[slot].unwrap()]
    }

    pub fn at_slot_mut(&mut self, slot: usize) -> &mut Participant {
        self.participants
            .get_mut(&self.slots[slot].unwrap())
            .unwrap()
    }

    pub fn find_credential(&self, token: &str) -> Option<usize> {
        self.slots.iter().position(|id| {
            id.and_then(|id| {
                self.participants[&id]
                    .credential
                    .as_deref()
                    .map(|expected| crate::resume::matches_credential(expected, token))
            })
            .unwrap_or(false)
        })
    }

    pub fn find_room_credential(&self, token: &str) -> Option<ControllerIdentity> {
        self.slots().find_map(|slot| {
            self.at_slot(slot)
                .room_credential
                .as_deref()
                .filter(|expected| crate::resume::matches_credential(expected, token))
                .map(|_| self.binding(slot))
        })
    }
}

// A preparation binding is changed only together with its connection and native
// controller. Keeping these operations here makes raw roster mutation private.
impl crate::Match {
    pub fn reserve_preparation(&mut self, slot: usize) -> Result<ControllerIdentity, &'static str> {
        if self.started || self.ended {
            return Err("match membership is frozen");
        }
        if self
            .controls
            .get(slot)
            .is_none_or(|control| control.controller.is_some() || control.connection.is_some())
        {
            return Err("slot control has not been retired");
        }
        let binding = self.participants.reserve(slot)?;
        self.controls[slot] = crate::ControllerState::default();
        self.prediction.accepted[slot] = Default::default();
        Ok(binding)
    }
    pub fn release_preparation(
        &mut self,
        binding: ControllerIdentity,
        commands: &mut bevy_ecs::prelude::Commands,
    ) -> Result<(), &'static str> {
        if self.started || self.ended {
            return Err("match membership is frozen");
        }
        self.participants.release(binding)?;
        let slot = usize::from(binding.slot);
        let retired = std::mem::take(&mut self.controls[slot]);
        self.prediction.accepted[slot] = Default::default();
        if let Some(controller) = retired.controller {
            commands.entity(controller).try_despawn();
        }
        if let Some(connection) = retired.connection {
            self.retired_connections.insert(connection);
            commands.trigger(lightyear::prelude::Unlink {
                entity: connection,
                reason: lightyear::prelude::UnlinkReason::UserRequested(Some(
                    "Gameplay binding retired".into(),
                )),
            });
        }
        // The old connection is no longer associated with any participant. A new
        // reservation never inherits it, its authorization, credential or inputs.
        Ok(())
    }
    pub fn replace_preparation(
        &mut self,
        binding: ControllerIdentity,
        commands: &mut bevy_ecs::prelude::Commands,
    ) -> Result<ControllerIdentity, &'static str> {
        self.release_preparation(binding, commands)?;
        self.reserve_preparation(usize::from(binding.slot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_vacancy_reuse_and_running_fence() {
        let mut roster = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
        assert_eq!(roster.capacity(), 8);
        assert_eq!(roster.count(), 3);
        assert_eq!(roster.slots().collect::<Vec<_>>(), [0, 3, 7]);
        let old = roster.binding(3);
        let last = roster.binding(7);
        assert!(roster.reserve(3).is_err());
        roster.release(old).unwrap();
        assert!(!roster.contains(3));
        assert!(roster.release(old).is_err());
        let new = roster.reserve(3).unwrap();
        assert_ne!(old.participant, new.participant);
        let startup_ids: Vec<_> = roster
            .slots()
            .map(|slot| roster.binding(slot).participant)
            .collect();
        assert_eq!(
            serde_json::to_value(startup_ids).unwrap(),
            serde_json::json!(["0000000000000001", "0000000000000004", "0000000000000003"])
        );
        assert_eq!(roster.resolve(&old), None);
        assert_eq!(roster.binding(7), last);
        roster.freeze();
        assert!(roster.release(new).is_err());
        assert!(roster.reserve(1).is_err());
        assert_eq!(roster.resolve(&new), Some(3));
        assert_eq!(roster.count(), 3);
    }

    #[test]
    fn bindings_are_unique_and_reject_unknown_or_wrong_participants() {
        let roster = ParticipantRoster::new(8, &(0..8).collect::<Vec<_>>()).unwrap();
        let mut seen = std::collections::HashSet::new();
        for slot in 0..8 {
            let binding = roster.binding(slot);
            assert!(seen.insert(binding.participant));
            assert_eq!(roster.resolve(&binding), Some(slot));
            assert_eq!(
                roster.resolve(&ControllerIdentity {
                    slot: ((slot + 1) % 8) as u8,
                    ..binding
                }),
                None
            );
            assert_eq!(
                roster.resolve(&ControllerIdentity {
                    participant: ParticipantId(999),
                    ..binding
                }),
                None
            );
            assert_eq!(
                roster.resolve(&ControllerIdentity {
                    slot: 255,
                    ..binding
                }),
                None
            );
        }
    }

    #[test]
    fn empty_capacity_and_initial_reservations_are_explicit() {
        assert_eq!(ParticipantRoster::new(8, &[]).unwrap().count(), 0);
        assert!(ParticipantRoster::new(8, &[3, 3]).is_err());
        assert!(ParticipantRoster::new(8, &[8]).is_err());
        assert_eq!(
            ParticipantRoster::new(8, &[3, 6])
                .unwrap()
                .slots()
                .collect::<Vec<_>>(),
            [3, 6]
        );
    }
}
