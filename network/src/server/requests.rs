use super::{Match, control::send};
use crate::resume;
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use std::time::Instant;
use tm4_network::protocol::{Message, Request};

impl Match {
    pub(super) fn request(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        entity: Entity,
        request: Request,
    ) {
        if !links.contains(entity) || self.retired_connections.contains(&entity) {
            return;
        }
        let slot = self
            .controls
            .iter()
            .position(|player| player.connection == Some(entity));
        match request {
            Request::Join { compatibility }
                if self.started && !self.ended && slot.is_none() && !self.room_only =>
            {
                if Some(&compatibility) != self.compatibility.as_ref() {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message:
                                "Gameplay build or local resources do not match the authority."
                                    .into(),
                        },
                    );
                    return;
                }
                match self.reserve_live() {
                    Ok(identity) => {
                        let slot = usize::from(identity.slot);
                        self.controls[slot].connection = Some(entity);
                        self.controls[slot].compatibility = Some(compatibility);
                        send(links, entity, &Message::Welcome { slot });
                        self.live_lobby(slot, links);
                    }
                    Err(message) => send(
                        links,
                        entity,
                        &Message::Error {
                            message: message.into(),
                        },
                    ),
                }
            }
            Request::SelectCar { car, ready }
                if self.started
                    && !self.ended
                    && slot.is_some_and(|slot| self.participants.joining(slot))
                    && !self.room_only =>
            {
                let slot = slot.unwrap();
                if self.controls[slot].resume.is_some()
                    || !self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.model_pool.contains(&car))
                {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message: "Choose a model from this match's prepared pool.".into(),
                        },
                    );
                    return;
                }
                self.participants.at_slot_mut(slot).car = Some(car);
                if ready {
                    self.prepare_live(slot, links);
                } else {
                    self.live_lobby(slot, links);
                }
            }
            Request::Leave {} if self.started && !self.ended && slot.is_some() => {
                let slot = slot.unwrap();
                if !self.participants.joining(slot) {
                    let identity = self.participants.binding(slot);
                    if let Err(message) = self.schedule_departure(identity, links) {
                        send(
                            links,
                            entity,
                            &Message::Error {
                                message: message.into(),
                            },
                        );
                    }
                }
            }
            Request::Join { compatibility }
                if !self.started && !self.ended && slot.is_none() && !self.room_only =>
            {
                if Some(&compatibility) != self.compatibility.as_ref() {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message:
                                "Gameplay build or local resources do not match the authority."
                                    .into(),
                        },
                    );
                    return;
                }
                if let Some(slot) = self
                    .controls
                    .iter()
                    .enumerate()
                    .find(|(slot, player)| {
                        self.participants.contains(*slot) && player.connection.is_none()
                    })
                    .map(|(slot, _)| slot)
                {
                    self.controls[slot].connection = Some(entity);
                    self.controls[slot].compatibility = Some(compatibility);
                    self.participants.at_slot_mut(slot).car =
                        self.catalog.as_ref().unwrap().cars.get(slot).cloned();
                    send(links, entity, &Message::Welcome { slot });
                    self.broadcast_lobby(links);
                } else {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message: "The lobby is full.".into(),
                        },
                    );
                }
            }
            Request::SelectCar { car, ready }
                if !self.started && !self.ended && slot.is_some() && !self.room_only =>
            {
                match self.participants.at_slot_mut(slot.unwrap()).select_car(
                    self.catalog.as_ref().unwrap(),
                    car,
                    ready,
                ) {
                    Ok(()) => self.broadcast_lobby(links),
                    Err(message) => send(
                        links,
                        entity,
                        &Message::Error {
                            message: message.into(),
                        },
                    ),
                }
            }
            Request::Join { .. } if self.ended || self.started => send(
                links,
                entity,
                &Message::Error {
                    message: if self.ended {
                        "This lobby is closed. Open a new match link to play."
                    } else {
                        "This match has already started. Open a new match link to play."
                    }
                    .into(),
                },
            ),
            Request::Resume {
                token,
                compatibility,
            } if !self.started && !self.ended => {
                if self.room_only
                    && let Some(binding) = self.participants.find_room_credential(&token)
                    && self.participants.resolve(&binding).is_some()
                    && self.controls[usize::from(binding.slot)]
                        .connection
                        .is_none()
                    && slot.is_none()
                    && Some(&compatibility) == self.compatibility.as_ref()
                {
                    let slot = usize::from(binding.slot);
                    let player = &mut self.controls[slot];
                    player.connection = Some(entity);
                    player.compatibility = Some(compatibility);
                    send(links, entity, &Message::Welcome { slot });
                    self.broadcast_lobby(links);
                } else {
                    send(links, entity, &Message::Error { message: "This room participant cannot enter this match. Check your resources or close the other game tab.".into() });
                }
            }
            Request::Resume {
                token,
                compatibility,
            } if slot.is_none() => {
                let requested = self.participants.find_credential(&token).or_else(|| {
                    self.participants
                        .find_room_credential(&token)
                        .map(|identity| usize::from(identity.slot))
                });
                if requested.is_some()
                    && self.ended
                    && self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.compatibility == compatibility)
                    && let Some(state) = self
                        .last_state
                        .as_ref()
                        .filter(|state| state.completion.reasons != 0)
                {
                    send(
                        links,
                        entity,
                        &Message::Finished {
                            state: state.clone(),
                        },
                    );
                    return;
                }
                let session = self.session.as_ref().filter(|session| {
                    session.portable
                        && session.compatibility == compatibility
                        && self.started
                        && !self.ended
                        && self.tick > 0
                });
                if let (Some(slot), Some(session)) = (requested, session) {
                    if self.controls[slot].connection.is_some() {
                        send(links, entity, &Message::ResumePending);
                        return;
                    }
                    self.health
                        .lock()
                        .unwrap()
                        .event("rustymetal4_reconnections_accepted_total");
                    self.next_resume = self.next_resume.wrapping_add(1);
                    let player = &mut self.controls[slot];
                    player.connection = Some(entity);
                    player.history.disconnect();
                    player.resume = Some(resume::Attempt::new(self.next_resume));
                    send(links, entity, &Message::Welcome { slot });
                    if let Some(token) = self.participants.at_slot(slot).credential.clone() {
                        send(links, entity, &Message::ResumeCredential { token });
                    }
                    send(links, entity, &Message::ResumePrepare(session.clone()));
                    for (&tick, changes) in &self.membership.scheduled {
                        send(
                            links,
                            entity,
                            &Message::Membership {
                                tick,
                                changes: changes.clone(),
                            },
                        );
                    }
                } else {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message: "This participant cannot resume this match.".into(),
                        },
                    );
                }
            }
            Request::SnapshotReceived {
                attempt: id,
                offset,
            } if slot.is_some() => {
                if let Some(attempt) = self.controls[slot.unwrap()].resume.as_mut()
                    && attempt.id == id
                    && attempt.announced
                    && !attempt.failed
                    && let Some(snapshot) = attempt.requested.as_mut()
                {
                    if offset as usize != snapshot.sent || snapshot.sent == snapshot.acknowledged {
                        attempt.failed = true;
                    } else {
                        snapshot.acknowledged = snapshot.sent;
                        attempt.progress = Instant::now();
                    }
                }
            }
            Request::ResumeClock {
                attempt: id,
                target,
            } if slot.is_some() => {
                if let Some(attempt) = self.controls[slot.unwrap()].resume.as_mut()
                    && attempt.id == id
                    && !attempt.failed
                {
                    if let Some(start) = attempt.set_target(target, self.tick) {
                        let digest = if start == attempt.requested.as_ref().unwrap().tick {
                            Some(attempt.requested.as_ref().unwrap().state.digest)
                        } else {
                            self.journal
                                .as_mut()
                                .and_then(|journal| journal.range(start - 1, start).ok())
                                .map(|row| u32::from_le_bytes(row[..4].try_into().unwrap()))
                        };
                        if let Some(digest) = digest {
                            send(
                                links,
                                entity,
                                &Message::ResumeCatchup {
                                    attempt: id,
                                    start,
                                    head: target,
                                    digest,
                                },
                            );
                        } else {
                            attempt.failed = true;
                        }
                    } else {
                        attempt.failed = true;
                    }
                }
            }
            Request::ResumeLiveAck { attempt: id, head } if slot.is_some() => {
                let player = &mut self.controls[slot.unwrap()];
                if let Some(attempt) = &player.resume
                    && attempt.id == id
                {
                    if !attempt.can_activate(head, self.tick) {
                        player.resume.as_mut().unwrap().failed = true;
                        send(links, entity, &Message::Error {
                            message: "The reconnect acknowledgement exceeded its live input history. Retry this match.".into(),
                        });
                        return;
                    }
                    let attempt = player.resume.take().unwrap();
                    player.ready = true;
                    player.progress_tick = head;
                    send(links, entity, &Message::ResumeActive { head });
                    for frame in attempt.frames {
                        send(links, entity, &frame);
                    }
                    if self.participants.joining(slot.unwrap()) {
                        if let Err(message) = self.schedule_admission(slot.unwrap(), links) {
                            send(
                                links,
                                entity,
                                &Message::Error {
                                    message: message.into(),
                                },
                            );
                        }
                    }
                }
            }
            Request::Ready {
                epoch,
                digest,
                unsupported,
            } if self.started
                && !self.ended
                && epoch == 1
                && slot.is_some()
                && self.prediction.anchor.is_none() =>
            {
                if let Some(detail) = unsupported {
                    self.fail(links, &format!("Client initialization rejected: {detail}"));
                    return;
                }
                if let Some(slot) = slot {
                    self.controls[slot].ready = true;
                    self.controls[slot].initial_digest = Some(digest);
                }
            }
            Request::PredictionClock {
                epoch: 1,
                anchor,
                tick,
            } if self.started && !self.ended => {
                if let Some(slot) = slot.filter(|&slot| self.controls[slot].ready) {
                    self.prediction.vote(slot, Tick(anchor), Tick(tick));
                }
            }
            Request::Progress { tick } if tick <= self.tick => {
                if let Some(player) = slot.map(|slot| &mut self.controls[slot])
                    && player.receives_live()
                {
                    player.progress_tick = player.progress_tick.max(tick);
                }
            }
            Request::CatchupApplied { attempt: id, tick } if slot.is_some() => {
                let player = &mut self.controls[slot.unwrap()];
                if let Some(attempt) = &mut player.resume
                    && attempt.id == id
                {
                    if attempt.pending_frame == Some(tick) && !attempt.failed {
                        attempt.pending_frame = None;
                        attempt.progress = Instant::now();
                    } else {
                        attempt.failed = true;
                    }
                }
            }
            _ => send(
                links,
                entity,
                &Message::Error {
                    message: "Unexpected message.".into(),
                },
            ),
        }
    }
}
