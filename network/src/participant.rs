//! Fixed-roster participant data and its explicit gameplay-slot bindings.
//! Connections and input history live separately in the match's control records.
use std::collections::HashMap;

use tm4_network::protocol::{Catalog, ControllerIdentity, MAX_PLAYERS, ParticipantId};

#[derive(Default)]
pub(crate) struct Participant {
    pub car: Option<String>,
    pub lobby_ready: bool,
    pub credential: Option<String>,
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
    slots: Vec<ParticipantId>,
    next_id: u64,
}

impl ParticipantRoster {
    pub fn new(count: usize) -> Self {
        assert!(count <= MAX_PLAYERS);
        let mut roster = Self {
            participants: HashMap::new(),
            slots: Vec::new(),
            next_id: 1,
        };
        // The fixed roster starts with one participant record per lobby seat.
        // Open-lobby re-entry allocates anew; authenticated recovery does not.
        for _ in 0..count {
            let id = roster.allocate();
            roster.slots.push(id);
        }
        roster
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

    pub fn binding(&self, slot: usize) -> ControllerIdentity {
        ControllerIdentity {
            participant: self.slots[slot],
            slot: slot as u8,
        }
    }

    pub fn resolve(&self, binding: &ControllerIdentity) -> Option<usize> {
        let slot = usize::from(binding.slot);
        (self.slots.get(slot) == Some(&binding.participant)).then_some(slot)
    }

    pub fn at_slot(&self, slot: usize) -> &Participant {
        &self.participants[&self.slots[slot]]
    }

    pub fn at_slot_mut(&mut self, slot: usize) -> &mut Participant {
        self.participants.get_mut(&self.slots[slot]).unwrap()
    }

    pub fn find_credential(&self, token: &str) -> Option<usize> {
        self.slots.iter().position(|id| {
            self.participants[id]
                .credential
                .as_deref()
                .is_some_and(|expected| crate::resume::matches_credential(expected, token))
        })
    }

    pub fn replace_lobby_participant(&mut self, slot: usize) {
        let old = self.slots[slot];
        let new = self.allocate();
        self.slots[slot] = new;
        self.participants.remove(&old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_are_unique_and_reject_unknown_or_wrong_participants() {
        let roster = ParticipantRoster::new(8);
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
    fn lobby_reentry_has_a_new_identity_without_reassigning_other_slots() {
        let mut roster = ParticipantRoster::new(2);
        let old = roster.binding(0);
        let other = roster.binding(1);
        roster.at_slot_mut(0).credential = Some("ab".repeat(32));
        roster.at_slot_mut(0).car = Some("Orbital".into());
        assert_eq!(roster.find_credential(&"ab".repeat(32)), Some(0));
        roster.replace_lobby_participant(0);
        let current = roster.binding(0);
        assert_ne!(current.participant, old.participant);
        assert_eq!(current.slot, old.slot);
        assert_eq!(roster.resolve(&old), None);
        assert_eq!(roster.resolve(&current), Some(0));
        assert_eq!(roster.binding(1), other);
        assert_eq!(roster.find_credential(&"ab".repeat(32)), None);
        assert!(roster.at_slot(0).car.is_none());
    }
}
