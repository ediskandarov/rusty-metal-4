mod app;
mod control;
mod membership;
mod participant;
mod prediction;
mod recovery;
mod requests;
mod tick;

pub(crate) use app::run_match;
pub(crate) use participant::ParticipantRoster;

use crate::{health, journal, resume, web};
use bevy_ecs::prelude::*;
use control::send;
use lightyear::prelude::*;
use prediction::AcceptedTimeline;
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant},
};
use tm4_network::protocol as game_protocol;
use tm4_network::{
    input::{Input, InputHistory},
    protocol::{
        Catalog, Compatibility, LobbyPlayer, MembershipChange, Message, RoundState, SessionStart,
    },
};

const TICK_RATE: u64 = 30;
const STEP: Duration = Duration::from_nanos(1_000_000_000 / TICK_RATE);
const MIN_PARTICIPANTS: usize = 2;

// Connection, synchronization and command acceptance outlive individual links,
// but are independent of participant data and its gameplay-slot binding.
#[derive(Default)]
struct ControllerState {
    connection: Option<Entity>,
    ready: bool,
    compatibility: Option<Compatibility>,
    initial_digest: Option<u32>,
    history: InputHistory,
    controller: Option<Entity>,
    received_sequence: u32,
    progress_tick: u32,
    resume: Option<resume::Attempt>,
}

impl ControllerState {
    fn disconnect(&mut self, entity: Entity) -> bool {
        if self.connection != Some(entity) {
            return false;
        }
        self.connection = None;
        self.history.disconnect();
        self.resume = None;
        true
    }

    fn receives_live(&self) -> bool {
        self.resume.is_none() && self.connection.is_some()
    }
}

#[derive(Resource)]
struct Match {
    participants: ParticipantRoster,
    membership: membership::LiveMembership,
    room_requests: Option<web::MembershipQueue>,
    controls: Vec<ControllerState>,
    authority_ready: bool,
    compatibility: Option<Compatibility>,
    catalog: Option<Catalog>,
    selected_world: Option<String>,
    limits: game_protocol::FfaLimits,
    room_only: bool,
    // Unlink is deferred. These revoked links cannot readmit themselves meanwhile.
    retired_connections: HashSet<Entity>,
    initial_digest: Option<u32>,
    started: bool,
    ended: bool,
    tick: u32,
    lobby_since: Option<Instant>,
    loading_since: Instant,
    last_step_duration: Option<Duration>,
    session: Option<SessionStart>,
    last_state: Option<RoundState>,
    journal_directory: PathBuf,
    journal: Option<journal::Journal>,
    journal_sealed: bool,
    journal_export: journal::SharedExport,
    prediction: AcceptedTimeline,
    next_resume: u32,
    health: health::Shared,
    tick_schedule: Option<Instant>,
}

impl Match {
    fn final_result(&self, session_id: &str) -> Option<web::MatchResult> {
        let state = self.last_state.as_ref()?;
        if !self.ended || state.completion.reasons == 0 {
            return None;
        }
        Some(web::MatchResult {
            session_id: session_id.into(),
            completion: state.completion.clone(),
            participants: self
                .participants
                .slots()
                .map(|slot| web::ResultParticipant {
                    identity: self.participants.binding(slot),
                    credential: self.participants.at_slot(slot).room_credential.clone(),
                    score: state.scores[slot].clone(),
                })
                .collect(),
        })
    }

    fn broadcast(
        &self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        message: &Message,
    ) {
        for entity in self.controls.iter().filter_map(|player| player.connection) {
            send(links, entity, message);
        }
    }

    fn finish_journal(&mut self, end: journal::End) -> bool {
        let Some(journal) = &mut self.journal else {
            return true;
        };
        if self.journal_sealed {
            return true;
        }
        self.journal_sealed = true;
        if let Err(error) = journal.finish(end) {
            self.health
                .lock()
                .unwrap()
                .event("rustymetal4_journal_write_errors_total");
            eprintln!("Journal finalization failed: {error}");
            return false;
        }
        let (used, capacity) = journal.memory_bytes();
        println!(
            "Journal sealed ({end:?}): {} ticks, cache {used} bytes / {capacity} allocated",
            journal.ticks(),
        );
        true
    }

    fn fail(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        message: &str,
    ) {
        self.ended = true;
        self.health
            .lock()
            .unwrap()
            .event("rustymetal4_match_errors_total");
        self.finish_journal(journal::End::Aborted);
        let error = Message::Error {
            message: message.into(),
        };
        self.broadcast(links, &error);
        eprintln!("{message}");
    }

    fn completed(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        tick: u32,
        inputs: Vec<Input>,
        changes: Vec<MembershipChange>,
        state: RoundState,
        dispatched: Instant,
    ) {
        self.last_step_duration = Some(dispatched.elapsed());
        let result = self
            .journal
            .as_mut()
            .expect("stepping requires a journal")
            .append(tick, &inputs, &changes, &state);
        if let Err(error) = result {
            self.health
                .lock()
                .unwrap()
                .event("rustymetal4_journal_write_errors_total");
            eprintln!("Appending match journal failed: {error}");
            self.journal_sealed = true;
            self.fail(links, "The match journal could not be written.");
            return;
        }
        self.tick += 1;
        self.ended = state.completion.reasons != 0 || state.next_mode != 0;
        if self.ended && !self.finish_journal(journal::End::Finished) {
            self.fail(links, "The match journal could not be finalized.");
            return;
        }
        let message = Message::Frame {
            changes,
            tick,
            inputs,
            state: state.clone(),
        };
        for player in &mut self.controls {
            if self.ended && player.resume.is_some() {
                if let Some(entity) = player.connection {
                    send(
                        links,
                        entity,
                        &Message::Finished {
                            state: state.clone(),
                        },
                    );
                }
            } else if let Some(attempt) = player.resume.as_mut() {
                if attempt.target.is_some_and(|target| tick >= target) {
                    if attempt.frames.len() == usize::from(game_protocol::PREDICTION_DEPTH) {
                        attempt.frames.pop_front();
                    }
                    attempt.frames.push_back(message.clone());
                }
            } else if player.ready
                && player.receives_live()
                && let Some(entity) = player.connection
            {
                send(links, entity, &message);
            }
        }
        self.last_state = Some(state);
    }

    fn simulator_ready(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        digest: u32,
        unsupported: Option<String>,
        portable: bool,
    ) {
        if let Some(detail) = unsupported {
            self.fail(links, &format!("Live rollback cannot start: {detail}"));
            return;
        }
        self.authority_ready = true;
        self.initial_digest = Some(digest);
        if let Some(session) = &mut self.session {
            session.portable &= portable;
            if session.portable {
                for (slot, player) in self.controls.iter().enumerate() {
                    if !self.participants.contains(slot) {
                        continue;
                    }
                    let participant = self.participants.at_slot_mut(slot);
                    participant.credential = resume::credential();
                    if let (Some(entity), Some(token)) =
                        (player.connection, participant.credential.clone())
                    {
                        send(links, entity, &Message::ResumeCredential { token });
                    }
                }
            }
        }
    }

    fn broadcast_lobby(
        &self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) {
        self.broadcast(
            links,
            &Message::Lobby {
                cars: self.session.as_ref().map_or_else(
                    || self.catalog.as_ref().unwrap().cars.clone(),
                    |session| session.model_pool.clone(),
                ),
                players: self
                    .controls
                    .iter()
                    .enumerate()
                    .filter(|(slot, _)| self.participants.contains(*slot))
                    .map(|(slot, player)| LobbyPlayer {
                        slot,
                        connected: player.connection.is_some(),
                        car: self.participants.at_slot(slot).car.clone(),
                        ready: self.participants.at_slot(slot).lobby_ready,
                    })
                    .collect(),
            },
        );
    }
}

#[cfg(test)]
mod tests;
