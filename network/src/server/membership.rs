//! Authority reservations and ordered membership decisions on the existing tick timeline.
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};
use tm4_network::protocol::{ControllerIdentity, MembershipChange, Message, ParticipantId};

use super::{ControllerState, Match, control::send};
use crate::{resume, web};

const ADMISSION_DEADLINE: Duration = Duration::from_secs(45);
const EVENT_LEAD: u32 = tm4_network::protocol::PREDICTION_DEPTH as u32 * 2;

pub(super) struct Reservation {
    pub opened: Instant,
    pub tick: Option<u32>,
}
#[derive(Default)]
pub(super) struct LiveMembership {
    pub pending: HashMap<ParticipantId, Reservation>,
    pub scheduled: BTreeMap<u32, Vec<MembershipChange>>,
    pub departing: HashSet<ParticipantId>,
    retired: VecDeque<(u32, Entity)>,
}

impl Match {
    pub(super) fn configure_room(
        &mut self,
        members: Vec<(ControllerIdentity, web::RosterMember)>,
    ) -> Result<(), &'static str> {
        if self.started
            || self.ended
            || self.room_only
            || members.len() < 2
            || members.len() != self.participants.count()
            || self
                .controls
                .iter()
                .any(|control| control.connection.is_some() || control.controller.is_some())
        {
            return Err("room setup is not an empty preparation");
        }
        let mut identities = HashSet::new();
        let mut credentials = HashSet::new();
        if members.iter().any(|(binding, member)| {
            self.participants.resolve(binding).is_none()
                || !identities.insert(binding.participant)
                || !credentials.insert(&member.credential)
                || member.credential.len() != 64
                || !member
                    .credential
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !self
                    .catalog
                    .as_ref()
                    .is_some_and(|catalog| catalog.cars.contains(&member.car))
        }) {
            return Err("invalid room participant binding");
        }
        for (binding, member) in members {
            let participant = self.participants.at_slot_mut(usize::from(binding.slot));
            participant.room_credential = Some(member.credential);
            participant.car = Some(member.car);
            participant.lobby_ready = true;
        }
        self.room_only = true;
        Ok(())
    }

    pub(super) fn room_membership(
        &mut self,
        request: web::MembershipCommand,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        commands: &mut Commands,
    ) {
        if request.response.is_closed() {
            return;
        }
        let result = (|| {
            if !self.room_only || !self.started || self.ended {
                return Err("This room match has ended.");
            }
            match request.change {
                web::RoomMembership::Inspect { credential } => {
                    let identity = self.participants.find_room_credential(&credential);
                    Ok(web::MembershipReply {
                        pending: identity.is_some_and(|identity| {
                            self.participants.joining(usize::from(identity.slot))
                        }),
                        identity,
                        tick: None,
                    })
                }
                web::RoomMembership::Admit { credential, car } => {
                    if !self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.model_pool.contains(&car))
                    {
                        return Err("Choose a model from the match's prepared pool.");
                    }
                    if let Some(identity) = self.participants.find_room_credential(&credential) {
                        if self
                            .participants
                            .at_slot(usize::from(identity.slot))
                            .car
                            .as_ref()
                            != Some(&car)
                        {
                            return Err("This reservation already selected another model.");
                        }
                        return Ok(web::MembershipReply {
                            identity: Some(identity),
                            pending: self.participants.joining(usize::from(identity.slot)),
                            tick: self
                                .membership
                                .pending
                                .get(&identity.participant)
                                .and_then(|pending| pending.tick),
                        });
                    }
                    let identity = self.reserve_live()?;
                    let participant = self.participants.at_slot_mut(usize::from(identity.slot));
                    participant.room_credential = Some(credential);
                    participant.car = Some(car);
                    participant.lobby_ready = true;
                    participant.credential = resume::credential();
                    Ok(web::MembershipReply {
                        identity: Some(identity),
                        pending: true,
                        tick: None,
                    })
                }
                web::RoomMembership::Depart { credential } => {
                    let Some(identity) = self.participants.find_room_credential(&credential) else {
                        // A preparation deadline or a prior departure may already
                        // have released this lease. Explicit room leave is idempotent.
                        return Ok(web::MembershipReply {
                            identity: None,
                            pending: false,
                            tick: None,
                        });
                    };
                    if self.participants.joining(usize::from(identity.slot)) {
                        self.cancel_admission(identity, links, commands);
                        return Ok(web::MembershipReply {
                            identity: Some(identity),
                            pending: false,
                            tick: None,
                        });
                    }
                    let existing = self.membership.scheduled.iter().find_map(|(tick, changes)| changes.iter().any(|change| matches!(change, MembershipChange::Depart { identity: old } if *old == identity)).then_some(*tick));
                    let tick = if let Some(tick) = existing {
                        tick
                    } else {
                        self.schedule_departure(identity, links)?
                    };
                    Ok(web::MembershipReply {
                        identity: Some(identity),
                        pending: false,
                        tick: Some(tick),
                    })
                }
            }
        })();
        let _ = request.response.send(result);
    }

    pub(super) fn reserve_live(&mut self) -> Result<ControllerIdentity, &'static str> {
        if !self.started
            || self.tick == 0
            || self.ended
            || self
                .last_state
                .as_ref()
                .is_some_and(|state| state.round_finished || state.next_mode != 0)
            || self.prediction.anchor.is_none()
            || !self
                .session
                .as_ref()
                .is_some_and(|session| session.portable)
        {
            return Err("Live admission is unavailable for this match.");
        }
        let identity = self.participants.reserve_live()?;
        let slot = usize::from(identity.slot);
        self.controls[slot] = Default::default();
        self.controls[slot].progress_tick = self.tick;
        self.prediction.accepted[slot] = Default::default();
        self.membership.pending.insert(
            identity.participant,
            Reservation {
                opened: Instant::now(),
                tick: None,
            },
        );
        Ok(identity)
    }

    fn publish_plan(
        &self,
        tick: u32,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) {
        self.broadcast(
            links,
            &Message::Membership {
                tick,
                changes: self
                    .membership
                    .scheduled
                    .get(&tick)
                    .cloned()
                    .unwrap_or_default(),
            },
        );
    }

    fn schedule_membership(
        &mut self,
        change: MembershipChange,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) -> u32 {
        let tick = self.tick + EVENT_LEAD;
        let changes = self.membership.scheduled.entry(tick).or_default();
        assert!(
            !changes
                .iter()
                .any(|old| old.identity().slot == change.identity().slot)
        );
        changes.push(change);
        // Departures precede admissions, then gameplay input and ordinary simulation.
        changes.sort_by_key(|change| {
            (
                matches!(change, MembershipChange::Admit { .. }),
                change.identity().slot,
            )
        });
        self.publish_plan(tick, links);
        tick
    }

    pub(super) fn schedule_departure(
        &mut self,
        identity: ControllerIdentity,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) -> Result<u32, &'static str> {
        if !self.started || self.ended || self.participants.resolve(&identity).is_none() {
            return Err("This membership lease is no longer active.");
        }
        if !self.membership.departing.insert(identity.participant) {
            return Err("Departure is already scheduled.");
        }
        Ok(self.schedule_membership(MembershipChange::Depart { identity }, links))
    }

    pub(super) fn schedule_admission(
        &mut self,
        slot: usize,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) -> Result<u32, &'static str> {
        let identity = self.participants.binding(slot);
        if !self.participants.joining(slot)
            || self.ended
            || self
                .membership
                .pending
                .get(&identity.participant)
                .is_none_or(|pending| pending.tick.is_some())
        {
            return Err("Admission reservation expired.");
        }
        let car = self
            .participants
            .at_slot(slot)
            .car
            .clone()
            .ok_or("Select a prepared model first.")?;
        let tick = self.schedule_membership(MembershipChange::Admit { identity, car }, links);
        self.membership
            .pending
            .get_mut(&identity.participant)
            .unwrap()
            .tick = Some(tick);
        Ok(tick)
    }

    pub(super) fn retire_live(&mut self, identity: ControllerIdentity, commands: &mut Commands) {
        let preparing = self.participants.joining(usize::from(identity.slot));
        if self.participants.release_live(identity).is_err() {
            return;
        }
        self.membership.pending.remove(&identity.participant);
        self.membership.departing.remove(&identity.participant);
        let slot = usize::from(identity.slot);
        let retired = std::mem::take(&mut self.controls[slot]);
        self.prediction.accepted[slot] = Default::default();
        if let Some(controller) = retired.controller {
            commands.entity(controller).remove::<ControlledBy>();
            self.membership.retired.push_back((
                self.tick + u32::from(tm4_network::protocol::PREDICTION_DEPTH) * 2 + 2,
                controller,
            ));
        }
        if let Some(connection) = retired.connection {
            self.retired_connections.insert(connection);
            if !preparing {
                commands.trigger(Unlink {
                    entity: connection,
                    reason: UnlinkReason::UserRequested(Some("Gameplay membership retired".into())),
                });
            }
            // A preparation error must reach the client before it closes. Its
            // revoked, unidentified link remains subject to the existing deadline.
        }
    }

    pub(super) fn cancel_admission(
        &mut self,
        identity: ControllerIdentity,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        commands: &mut Commands,
    ) {
        if !self.participants.joining(usize::from(identity.slot)) {
            return;
        }
        if let Some(tick) = self
            .membership
            .pending
            .get(&identity.participant)
            .and_then(|pending| pending.tick)
        {
            if let Some(changes) = self.membership.scheduled.get_mut(&tick) {
                changes.retain(|change| change.identity() != identity);
            }
            self.publish_plan(tick, links);
        }
        if let Some(connection) = self.controls[usize::from(identity.slot)].connection {
            send(
                links,
                connection,
                &if let Some(state) = self
                    .last_state
                    .as_ref()
                    .filter(|state| self.ended && state.completion.reasons != 0)
                {
                    Message::Finished {
                        state: state.clone(),
                    }
                } else {
                    Message::Error {
                        message: "This admission preparation was cancelled.".into(),
                    }
                },
            );
        }
        self.retire_live(identity, commands);
    }

    pub(super) fn maintain_membership(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        commands: &mut Commands,
    ) {
        while self
            .membership
            .retired
            .front()
            .is_some_and(|(due, _)| *due <= self.tick || self.ended)
        {
            let (_, entity) = self.membership.retired.pop_front().unwrap();
            commands.entity(entity).try_despawn();
        }
        let round_finished = self
            .last_state
            .as_ref()
            .is_some_and(|state| state.round_finished);
        let expired: Vec<_> = self
            .participants
            .all_slots()
            .filter(|slot| self.participants.joining(*slot))
            .filter(|slot| {
                self.ended
                    || round_finished
                    || self
                        .membership
                        .pending
                        .get(&self.participants.binding(*slot).participant)
                        .is_none_or(|pending| pending.opened.elapsed() >= ADMISSION_DEADLINE)
            })
            .map(|slot| self.participants.binding(slot))
            .collect();
        for identity in expired {
            self.cancel_admission(identity, links, commands);
        }
        if self.ended {
            self.membership.scheduled.clear();
        }
    }

    pub(super) fn live_lobby(
        &self,
        slot: usize,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) {
        let Some(connection) = self.controls[slot].connection else {
            return;
        };
        send(
            links,
            connection,
            &Message::Lobby {
                cars: self
                    .session
                    .as_ref()
                    .map(|session| session.model_pool.clone())
                    .unwrap_or_default(),
                players: vec![tm4_network::protocol::LobbyPlayer {
                    slot,
                    connected: true,
                    car: self.participants.at_slot(slot).car.clone(),
                    ready: false,
                }],
            },
        );
    }

    pub(super) fn prepare_live(
        &mut self,
        slot: usize,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) {
        let Some(session) = self
            .session
            .as_ref()
            .filter(|session| session.portable)
            .cloned()
        else {
            return;
        };
        let Some(connection) = self.controls[slot].connection else {
            return;
        };
        let Some(token) = self
            .participants
            .at_slot(slot)
            .credential
            .clone()
            .or_else(resume::credential)
        else {
            send(
                links,
                connection,
                &Message::Error {
                    message: "A secure reconnect credential could not be prepared.".into(),
                },
            );
            return;
        };
        self.participants.at_slot_mut(slot).credential = Some(token.clone());
        self.next_resume = self.next_resume.wrapping_add(1);
        self.controls[slot].resume = Some(resume::Attempt::new(self.next_resume));
        send(links, connection, &Message::ResumeCredential { token });
        send(links, connection, &Message::ResumePrepare(session));
        for (&tick, changes) in &self.membership.scheduled {
            send(
                links,
                connection,
                &Message::Membership {
                    tick,
                    changes: changes.clone(),
                },
            );
        }
    }
}

// Preparation reuse retires the connection and native controller with the binding.
impl Match {
    pub(super) fn reserve_preparation(
        &mut self,
        slot: usize,
    ) -> Result<ControllerIdentity, &'static str> {
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
        self.controls[slot] = ControllerState::default();
        self.prediction.accepted[slot] = Default::default();
        Ok(binding)
    }
    pub(super) fn release_preparation(
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
    pub(super) fn replace_preparation(
        &mut self,
        binding: ControllerIdentity,
        commands: &mut bevy_ecs::prelude::Commands,
    ) -> Result<ControllerIdentity, &'static str> {
        self.release_preparation(binding, commands)?;
        self.reserve_preparation(usize::from(binding.slot))
    }
}
