mod assets;
mod health;
mod journal;
mod participant;
mod resume;
mod simulator;
mod system_metrics;
mod web;

use std::{
    collections::HashSet,
    env,
    error::Error,
    net::SocketAddr,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use aeronet_io::connection::LocalAddr;
use bevy_app::{App, PostUpdate, PreUpdate, Update};
use bevy_ecs::prelude::*;
use lightyear::prelude::input::native::{ActionState, NativeBuffer, NativeStateSequence};
use lightyear::prelude::server::*;
use lightyear::prelude::*;
use lightyear::websocket::server::{ServerConfig, WebSocketServerIo};
use tm4_network::protocol as game_protocol;
use tm4_network::{
    input::{ControllerCommand, Input, InputHistory},
    protocol::{
        CHECKSUM_SEED, Catalog, Compatibility, ControllerIdentity, JOURNAL_MAX_TICKS, LobbyPlayer,
        MAX_PLAYERS, Message, REPLAY_CHUNK_TICKS, Request, RoundState, SessionChannel,
        SessionStart, checksum, protocol,
    },
};

#[cfg(test)]
use participant::Participant;
use participant::ParticipantRoster;

const TICK_RATE: u64 = 30;
const STEP: Duration = Duration::from_nanos(1_000_000_000 / TICK_RATE);
const SIMULATOR_LAG_LIMIT: Duration = Duration::from_millis(250);

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

#[derive(Component)]
struct Admission {
    opened: Instant,
    window: Instant,
    messages: u32,
    unacknowledged: HashSet<lightyear::transport::packet::message::MessageId>,
}

const START_LEAD_TICKS: i32 = 12;
const MAX_START_LEAD_TICKS: i32 = 180;
const MAX_START_ATTEMPTS: u8 = 5;
const MIN_PARTICIPANTS: usize = 2;

struct ClockOffer {
    anchor: Tick,
    sent: Tick,
    votes: [Option<Tick>; MAX_PLAYERS],
}

#[derive(Debug, PartialEq)]
enum PredictionStart {
    Waiting,
    Offer(Tick),
    Commit(Tick),
    Unavailable,
}

#[derive(Default)]
struct AcceptedTimeline {
    anchor: Option<Tick>,
    offer: Option<ClockOffer>,
    attempts: u8,
    accepted: [NativeBuffer<Input>; MAX_PLAYERS],
}

impl AcceptedTimeline {
    fn vote(&mut self, slot: usize, anchor: Tick, tick: Tick) {
        if let Some(offer) = &mut self.offer
            && offer.anchor == anchor
            && offer.votes[slot].is_none()
        {
            offer.votes[slot] = Some(tick);
        }
    }

    fn negotiate(&mut self, now: Tick, slots: &[usize]) -> PredictionStart {
        let lead = if let Some(offer) = &self.offer {
            let votes: Vec<_> = slots.iter().map(|slot| offer.votes[*slot]).collect();
            if votes.iter().any(Option::is_none) {
                return PredictionStart::Waiting;
            }
            let round_trip = (now - offer.sent).max(1);
            let latest =
                votes.iter().flatten().fold(
                    now,
                    |latest, &tick| {
                        if tick - latest > 0 { tick } else { latest }
                    },
                );
            // Allow a full measured exchange for final delivery, plus room for
            // each browser's prediction clock to advance while the vote travels.
            let runway = 2 * round_trip + 2;
            if offer.anchor - latest >= runway {
                let anchor = offer.anchor;
                self.anchor = Some(anchor);
                self.offer = None;
                return PredictionStart::Commit(anchor);
            }
            (latest - now).saturating_add(3 * round_trip + START_LEAD_TICKS)
        } else {
            START_LEAD_TICKS
        };
        if self.attempts >= MAX_START_ATTEMPTS || lead > MAX_START_LEAD_TICKS {
            return PredictionStart::Unavailable;
        }
        let anchor = now + lead;
        self.offer = Some(ClockOffer {
            anchor,
            sent: now,
            votes: [None; MAX_PLAYERS],
        });
        self.attempts += 1;
        PredictionStart::Offer(anchor)
    }

    fn packet(
        &mut self,
        tick: u32,
        inputs: &[Input],
        controls: &[ControllerState],
    ) -> game_protocol::AcceptedInputs {
        use lightyear::input::input_message::{ActionStateSequence, InputTarget, PerTargetData};
        let end = self.anchor.unwrap() + tick as i32 + 1;
        let mut packet = game_protocol::AcceptedInputs::new(end);
        packet.rebroadcast = true;
        for (slot, player) in controls.iter().enumerate() {
            let buffer = &mut self.accepted[slot];
            buffer.set(end, ActionState(inputs[slot]));
            if buffer.len() > usize::from(game_protocol::PREDICTION_DEPTH + 1) {
                buffer.pop(end - u32::from(game_protocol::PREDICTION_DEPTH + 1));
            }
            if let Some(controller) = player.controller {
                packet.inputs.push(PerTargetData {
                    target: InputTarget::Entity(controller),
                    states: NativeStateSequence::build_from_input_buffer(buffer, buffer.len(), end)
                        .expect("accepted history contains a row for every slot"),
                });
            }
        }
        packet
    }
}

#[derive(Resource)]
struct Match {
    participants: ParticipantRoster,
    controls: Vec<ControllerState>,
    authority_ready: bool,
    compatibility: Option<Compatibility>,
    catalog: Option<Catalog>,
    selected_world: Option<String>,
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

fn send(
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    entity: Entity,
    message: &Message,
) {
    if let Ok((_, mut sender)) = links.get_mut(entity) {
        sender.send::<SessionChannel>(message.clone());
    }
}

impl Match {
    fn configure_room(
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
    fn broadcast(
        &self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        message: &Message,
    ) {
        for entity in self.controls.iter().filter_map(|player| player.connection) {
            send(links, entity, message);
        }
    }

    fn pump_resume(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        simulator: &mut simulator::Simulator,
    ) {
        if self.ended {
            return;
        }
        let Some(anchor) = self.prediction.anchor else {
            return;
        };
        for player in &mut self.controls {
            let (Some(entity), Some(attempt)) = (player.connection, player.resume.as_mut()) else {
                continue;
            };
            if attempt.failed {
                continue;
            }
            if attempt.requested.is_none() && self.tick >= attempt.retry_at {
                if let Some(state) = self.last_state.clone() {
                    attempt.requested = Some(resume::Snapshot {
                        tick: self.tick,
                        state,
                        checksum: 0,
                        total: 0,
                        data: Vec::new(),
                        sent: 0,
                        acknowledged: 0,
                    });
                    let capture = simulator.snapshot();
                    self.health.lock().unwrap().event(if capture.is_ok() {
                        "rustymetal4_checkpoint_capture_success_total"
                    } else {
                        "rustymetal4_checkpoint_capture_errors_total"
                    });
                    match capture {
                        Ok(data) => {
                            let snapshot = attempt.requested.as_mut().unwrap();
                            snapshot.total = data.len();
                            snapshot.checksum = checksum(CHECKSUM_SEED, &data);
                            snapshot.data = data;
                            attempt.progress = Instant::now();
                        }
                        Err(error) => {
                            eprintln!("Portable capture unavailable: {error:#}");
                            attempt.retries += 1;
                            if attempt.retries >= 4 {
                                attempt.failed = true;
                            } else {
                                attempt.requested = None;
                                attempt.retry_at = self.tick + 12;
                                attempt.progress = Instant::now();
                            }
                        }
                    }
                }
            }
            let Some(snapshot) = attempt
                .requested
                .as_mut()
                .filter(|snapshot| snapshot.ready())
            else {
                continue;
            };
            if !attempt.announced {
                send(
                    links,
                    entity,
                    &Message::SnapshotBegin {
                        attempt: attempt.id,
                        tick: snapshot.tick,
                        anchor: anchor.0,
                        total: snapshot.total as u32,
                        checksum: snapshot.checksum,
                        state: snapshot.state.clone(),
                    },
                );
                attempt.announced = true;
            }
            if snapshot.sent == snapshot.acknowledged && snapshot.sent < snapshot.total {
                let offset = snapshot.sent;
                snapshot.sent = (offset + game_protocol::SNAPSHOT_CHUNK_BYTES).min(snapshot.total);
                send(
                    links,
                    entity,
                    &Message::SnapshotChunk {
                        attempt: attempt.id,
                        offset: offset as u32,
                        data: snapshot.data[offset..snapshot.sent].to_vec(),
                    },
                );
            }
            let Some(target) = attempt.target else {
                continue;
            };
            if attempt.pending_frame.is_some() || attempt.offered {
                continue;
            }
            if attempt.sent_frames < target {
                let end = (attempt.sent_frames + REPLAY_CHUNK_TICKS).min(target);
                // The last block waits for its actual frontier instead of turning
                // a future target into several serial one-tick exchanges.
                if end > self.tick || end <= attempt.sent_frames {
                    continue;
                }
                let Some(data) = self
                    .journal
                    .as_mut()
                    .and_then(|journal| journal.range(attempt.sent_frames, end).ok())
                else {
                    attempt.failed = true;
                    continue;
                };
                send(
                    links,
                    entity,
                    &Message::CatchupFrames {
                        attempt: attempt.id,
                        start: attempt.sent_frames,
                        head: target,
                        checksum: checksum(CHECKSUM_SEED, &data),
                        data,
                    },
                );
                attempt.sent_frames = end;
                attempt.pending_frame = Some(end);
            }
            // The ordered channel can carry the offer with the last block. Slot
            // control still requires both the applied-block and live acknowledgments.
            if attempt.sent_frames == target {
                send(
                    links,
                    entity,
                    &Message::ResumeLive {
                        attempt: attempt.id,
                        anchor: anchor.0,
                        head: target,
                        sequence: player.received_sequence,
                    },
                );
                attempt.offered = true;
            }
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
        state: RoundState,
        dispatched: Instant,
    ) {
        self.last_step_duration = Some(dispatched.elapsed());
        let result = self
            .journal
            .as_mut()
            .expect("stepping requires a journal")
            .append(tick, &inputs, &state);
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
        self.ended = state.next_mode != 0;
        if self.ended && !self.finish_journal(journal::End::Finished) {
            self.fail(links, "The match journal could not be finalized.");
            return;
        }
        let message = Message::Frame {
            tick,
            inputs,
            state: state.clone(),
        };
        for player in &mut self.controls {
            if let Some(attempt) = player.resume.as_mut() {
                if attempt.target.is_some_and(|target| tick >= target) {
                    if attempt.frames.len() == usize::from(game_protocol::PREDICTION_DEPTH) {
                        attempt.frames.pop_front();
                    }
                    attempt.frames.push_back(message.clone());
                }
            } else if player.receives_live()
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
                cars: self.catalog.as_ref().unwrap().cars.clone(),
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

    fn request(
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
                if !self.room_only {
                    self.request(links, entity, Request::Join { compatibility });
                } else if let Some(binding) = self.participants.find_room_credential(&token)
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
                let requested = self.participants.find_credential(&token);
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
                    send(links, entity, &Message::ResumePrepare(session.clone()));
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
                    player.progress_tick = head;
                    send(links, entity, &Message::ResumeActive { head });
                    for frame in attempt.frames {
                        send(links, entity, &frame);
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

fn detach_connection(
    game: &mut Match,
    slot: usize,
    entity: Entity,
    commands: &mut Commands,
) -> bool {
    let control = &mut game.controls[slot];
    if !control.disconnect(entity) {
        return false;
    }
    if !game.started && !game.room_only {
        let binding = game.participants.binding(slot);
        game.replace_preparation(binding, commands)
            .expect("open lobby is mutable");
    }
    !game.started
}

fn bind_controllers(game: &mut Match, owners: &Query<&ControlledBy>, commands: &mut Commands) {
    // Binding data and Lightyear ownership are independent. Replacing a link
    // preserves the participant, accepted history and sequence watermark.
    let Match {
        participants,
        controls,
        ..
    } = game;
    for (slot, player) in controls.iter_mut().enumerate() {
        let Some(owner) = player.connection else {
            continue;
        };
        if let Some(controller) = player.controller {
            if !owners
                .get(controller)
                .is_ok_and(|current| current.owner == owner)
            {
                commands.entity(controller).insert((
                    ControlledBy {
                        owner,
                        lifetime: Lifetime::Persistent,
                    },
                    NativeBuffer::<ControllerCommand>::default(),
                ));
            }
        } else {
            player.controller = Some(
                commands
                    .spawn((
                        participants.binding(slot),
                        ActionState::<ControllerCommand>::default(),
                        Replicate::to_clients(NetworkTarget::All),
                        ControlledBy {
                            owner,
                            lifetime: Lifetime::Persistent,
                        },
                    ))
                    .id(),
            );
        }
    }
}

fn update(
    native_timeline: Res<LocalTimeline>,
    mut accepted_senders: Query<&mut MessageSender<game_protocol::AcceptedInputs>, With<Connected>>,
    mut game: ResMut<Match>,
    mut simulator: NonSendMut<simulator::Simulator>,
    mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    mut receivers: Query<(Entity, &mut MessageReceiver<Request>, &mut Admission)>,
    link_states: Query<Option<&Unlinked>, With<LinkOf>>,
    owners: Query<&ControlledBy>,
    mut commands: Commands,
) {
    let mut lobby_changed = false;
    game.retired_connections
        .retain(|entity| links.contains(*entity));
    for slot in game.participants.slots().collect::<Vec<_>>() {
        if let Some(entity) = game.controls[slot]
            .connection
            .filter(|entity| !links.contains(*entity))
        {
            lobby_changed |= detach_connection(&mut game, slot, entity, &mut commands);
        }
    }

    if lobby_changed {
        game.broadcast_lobby(&mut links);
    }

    let mut requests = Vec::new();
    let active_links = link_states
        .iter()
        .filter(|closed| closed.is_none_or(|state| matches!(&state.reason, UnlinkReason::Initial)))
        .count();
    let now = Instant::now();
    for (entity, mut receiver, mut admission) in &mut receivers {
        if now.duration_since(admission.window) >= Duration::from_secs(1) {
            admission.window = now;
            admission.messages = 0;
        }
        let known = game.controls.iter().any(|p| p.connection == Some(entity));
        let stalled = game
            .controls
            .iter()
            .find(|p| p.connection == Some(entity))
            .and_then(|p| {
                if let Some(attempt) = &p.resume {
                    return attempt
                        .timeout(now)
                        .then_some("Snapshot reconnect stopped or expired. Retry this match.");
                }
                (game.tick.saturating_sub(p.progress_tick) > 90)
                    .then_some("Client session progress timed out.")
            });
        let unidentified = !known && now.duration_since(admission.opened) > Duration::from_secs(10);
        let full = !known && active_links > MAX_PLAYERS + 5 && links.contains(entity);
        if let Some(reason) = full
            .then_some("Connection capacity reached.")
            .or(stalled)
            .or(unidentified.then_some("Unidentified connection timed out."))
        {
            eprintln!("{reason}");
            commands.trigger(Unlink {
                entity,
                reason: UnlinkReason::UserRequested(Some(reason.into())),
            });
            continue;
        }
        for request in receiver.receive() {
            admission.messages += 1;
            if admission.messages > 120 {
                commands.trigger(Unlink {
                    entity,
                    reason: UnlinkReason::UserRequested(Some(
                        "Session message rate exceeded".into(),
                    )),
                });
                break;
            }
            requests.push((entity, request));
        }
    }
    for (entity, request) in requests {
        game.request(&mut links, entity, request);
    }
    game.pump_resume(&mut links, &mut simulator);
    bind_controllers(&mut game, &owners, &mut commands);

    if !game.started && !game.ended {
        if game
            .controls
            .iter()
            .any(|player| player.connection.is_some())
        {
            if game.lobby_since.get_or_insert_with(Instant::now).elapsed()
                > Duration::from_secs(300)
            {
                game.fail(
                    &mut links,
                    "Lobby expired while waiting for players. Open a new match link to play.",
                );
            }
        } else {
            game.lobby_since = None;
        }
    }
    if game.ended
        || (!game.started
            && (game.participants.count() < MIN_PARTICIPANTS
                || game.controls.iter().enumerate().any(|(slot, player)| {
                    game.participants.contains(slot)
                        && (player.connection.is_none()
                            || !game.participants.at_slot(slot).lobby_ready)
                })))
    {
        return;
    }
    if !game.started {
        if game.controls.iter().enumerate().any(|(slot, player)| {
            game.participants.contains(slot) && player.compatibility != game.compatibility
        }) {
            game.fail(
                &mut links,
                "Gameplay build or local resources do not match the authority.",
            );
            return;
        }
        if let Err(error) = simulator.prepare_catalog() {
            eprintln!("Diagnostic setup failed: {error:#}");
            game.fail(&mut links, "Diagnostic match configuration rejected.");
            return;
        }
        game.catalog = Some(simulator.catalog.clone());
        game.participants.freeze();
        game.started = true;
        game.loading_since = Instant::now();
        let start = SessionStart {
            capacity: game.controls.len(),
            slots: game.participants.slots().map(|slot| slot as u8).collect(),
            world: game
                .selected_world
                .clone()
                .unwrap_or_else(|| game.catalog.as_ref().unwrap().worlds[0].clone()),
            cars: game
                .participants
                .slots()
                .map(|slot| game.participants.at_slot(slot).car.clone().unwrap())
                .collect(),
            compatibility: game.compatibility.clone().unwrap(),
            seed: 12345,
            epoch: 1,
            portable: (2..=8).contains(&game.participants.count()),
        };
        game.session = Some(start.clone());
        match simulator.start(&start) {
            Ok((state, portable)) => {
                game.simulator_ready(&mut links, state.digest, state.unsupported, portable)
            }
            Err(error) => {
                eprintln!("Embedded simulator setup failed: {error:#}");
                game.fail(
                    &mut links,
                    "The embedded simulator could not start this match.",
                );
                return;
            }
        }
        if game.ended {
            return;
        }
        let prepared = game
            .session
            .clone()
            .expect("simulation has an authoritative startup");
        game.broadcast(&mut links, &Message::PredictionPrepare(prepared));
    }

    let now = Instant::now();
    if game.prediction.anchor.is_none()
        && game
            .controls
            .iter()
            .enumerate()
            .any(|(slot, player)| game.participants.contains(slot) && player.connection.is_none())
    {
        game.fail(
            &mut links,
            "A player disconnected before the match clocks were agreed.",
        );
        return;
    }
    if !game.authority_ready
        || game
            .participants
            .slots()
            .any(|slot| !game.controls[slot].ready)
    {
        if now.duration_since(game.loading_since) > Duration::from_secs(45) {
            game.fail(&mut links, "Session loading exceeded 45 seconds.");
        }
        return;
    }
    if game.tick == 0
        && game.controls.iter().enumerate().any(|(slot, p)| {
            game.participants.contains(slot) && p.initial_digest != game.initial_digest
        })
    {
        game.fail(
            &mut links,
            "Initial simulation summaries disagree before tick zero.",
        );
        return;
    }
    if game.journal.is_none() {
        let header = journal::Header {
            start: game.session.clone().unwrap(),
            initial_digest: game.initial_digest.unwrap(),
        };
        match journal::Journal::create(&game.journal_directory, &header) {
            Ok(mut journal) => {
                journal.attach_export(game.journal_export.clone());
                println!("Match journal: {}", journal.path.display());
                game.journal = Some(journal);
            }
            Err(error) => {
                game.health
                    .lock()
                    .unwrap()
                    .event("rustymetal4_journal_write_errors_total");
                eprintln!("Opening match journal failed: {error}");
                game.fail(&mut links, "The match journal could not be opened.");
                return;
            }
        }
    }
    let slots: Vec<_> = game.participants.slots().collect();
    let loading_expired = now.duration_since(game.loading_since) > Duration::from_secs(45);
    if game.prediction.anchor.is_none() {
        if loading_expired {
            game.fail(
                &mut links,
                "Players did not synchronize their match clocks.",
            );
            return;
        }
        let native_tick = native_timeline.tick();
        match game.prediction.negotiate(native_tick, &slots) {
            PredictionStart::Offer(anchor) => {
                game.broadcast(&mut links, &Message::PredictionOffer { anchor: anchor.0 });
                return;
            }
            PredictionStart::Waiting => return,
            PredictionStart::Commit(anchor) => {
                game.broadcast(&mut links, &Message::PredictionBegin { anchor: anchor.0 });
            }
            PredictionStart::Unavailable => {
                game.fail(
                    &mut links,
                    "The players could not agree on a safe match start tick.",
                );
                return;
            }
        }
    }
    if game.tick >= JOURNAL_MAX_TICKS {
        game.fail(&mut links, "The match reached its journal disk budget.");
        return;
    }
    let due = game.prediction.anchor.unwrap() + game.tick as i32 + 1;
    let lag_ticks = native_timeline.tick() - due;
    let lag = STEP * lag_ticks.max(0) as u32;
    if lag > SIMULATOR_LAG_LIMIT {
        eprintln!(
            "Authority tick {} late by {} ms ({} Lightyear ticks, last C step {:?})",
            game.tick,
            lag.as_millis(),
            lag_ticks,
            game.last_step_duration,
        );
        game.fail(
            &mut links,
            "Simulator overrun: more than 250 ms behind the 30 Hz schedule.",
        );
        return;
    }
    if lag_ticks >= 0 {
        let step_started = Instant::now();
        let scheduled = *game.tick_schedule.get_or_insert(step_started);
        let lateness = step_started.saturating_duration_since(scheduled);
        let tick = game.tick;
        let inputs: Vec<_> = game
            .controls
            .iter_mut()
            .map(|player| player.history.sample(tick))
            .collect();
        let game = &mut *game;
        let packet = game.prediction.packet(tick, &inputs, &game.controls);
        for player in &game.controls {
            if let Some(entity) = player.connection
                && let Ok(mut sender) = accepted_senders.get_mut(entity)
            {
                sender.send::<lightyear::prelude::input::InputChannel>(packet.clone());
            }
        }
        match simulator.step(tick, &inputs) {
            Ok(state) => {
                if state.unsupported.is_some() {
                    game.health
                        .lock()
                        .unwrap()
                        .event("rustymetal4_simulation_unsupported_total");
                }
                game.completed(&mut links, tick, inputs, state, now);
                if game.tick == tick + 1 {
                    game.health
                        .lock()
                        .unwrap()
                        .tick(step_started.elapsed(), lateness);
                    game.tick_schedule = Some(scheduled + STEP);
                }
                if game.ended
                    && let Err(error) = simulator.finish()
                {
                    eprintln!("Simulation teardown failed: {error:#}");
                }
            }
            Err(error) => {
                game.health
                    .lock()
                    .unwrap()
                    .event("rustymetal4_simulation_errors_total");
                eprintln!("Embedded simulator tick {tick} failed: {error:#}");
                game.fail(
                    &mut links,
                    "The embedded simulator did not finish its tick.",
                );
            }
        }
    }
}

fn reap_closed_links(
    mut commands: Commands,
    links: Query<(Entity, &Unlinked), With<LinkOf>>,
    controllers: Query<(Entity, &ControlledBy)>,
) {
    for (entity, closed) in &links {
        if !matches!(&closed.reason, UnlinkReason::Initial) {
            for (controller, owner) in &controllers {
                if owner.owner == entity && matches!(owner.lifetime, Lifetime::Persistent) {
                    // Required components outlive their filter unless explicitly removed.
                    commands
                        .entity(controller)
                        .remove::<(ControlledBy, ControlledSend)>();
                }
            }
            commands.entity(entity).try_despawn();
        }
    }
}

// Use actual Lightyear acknowledgements as well as reported game progress: a peer
// that sends progress while never acknowledging our reliable messages must not
// retain an unbounded resend history.
fn bound_reliable_history(
    mut links: Query<(Entity, &Transport, &mut Admission)>,
    mut commands: Commands,
) {
    for (entity, transport, mut admission) in &mut links {
        let Some(channel) =
            transport.channel_send(lightyear::transport::channel::registry::ChannelKind::of::<
                SessionChannel,
            >())
        else {
            continue;
        };
        admission
            .unacknowledged
            .extend(channel.messages_sent().iter().copied());
        for id in channel.message_acks() {
            admission.unacknowledged.remove(id);
        }
        if admission.unacknowledged.len() > 128 {
            commands.trigger(Unlink {
                entity,
                reason: UnlinkReason::UserRequested(Some(
                    "Reliable message acknowledgement stalled".into(),
                )),
            });
        }
    }
}

// Read every newly received native-buffer record before FixedPreUpdate advances
// or trims it. Sampling only ActionState would lose transitions after a stalled frame.
fn accept_native_inputs(
    mut game: ResMut<Match>,
    connections: Query<(), With<Connected>>,
    controllers: Query<(
        Entity,
        &ControllerIdentity,
        &ControlledBy,
        &NativeBuffer<ControllerCommand>,
    )>,
) {
    if !game.started || game.ended || game.prediction.anchor.is_none() {
        return;
    }
    let earliest = game.tick;
    let health = game.health.clone();
    for (controller, identity, owner, buffer) in &controllers {
        let Some(slot) = game.participants.resolve(identity) else {
            continue;
        };
        let player = &mut game.controls[slot];
        if player.controller != Some(controller)
            || player.connection != Some(owner.owner)
            || !connections.contains(owner.owner)
        {
            continue;
        }
        let (Some(mut tick), Some((last, _))) = (buffer.start_tick, buffer.get_last_with_tick())
        else {
            continue;
        };
        for _ in 0..buffer.len() {
            if tick > last {
                break;
            }
            if let Some(action) = buffer.get(tick) {
                let command = action.0;
                if player.resume.is_none() && command.sequence > player.received_sequence {
                    player.received_sequence = command.sequence;
                    if command.epoch == 1 && player.receives_live() {
                        health.lock().unwrap().input(usize::from(identity.slot));
                        let queued = player.history.enqueue(
                            earliest,
                            command.sequence,
                            command.tick,
                            command.input,
                        );
                        if queued.is_err() {
                            health
                                .lock()
                                .unwrap()
                                .event("rustymetal4_input_rejected_total");
                        }
                    }
                }
            }
            tick += 1;
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mut first = args.next().unwrap_or_else(|| {
        if cfg!(feature = "embedded-server") {
            "--serve"
        } else {
            "2"
        }
        .into()
    });
    if first == "--precompile-simulation" {
        let input = args.next().ok_or("Expected source Wasm path")?;
        let output = args.next().ok_or("Expected compiled module path")?;
        if args.next().is_some() {
            return Err("Unexpected precompile argument".into());
        }
        simulator::precompile(Path::new(&input), Path::new(&output))?;
        return Ok(());
    }
    let serve = first == "--serve";
    if serve {
        first = args.next().unwrap_or_else(|| "2".into());
    }
    if first == "--inspect-journal" {
        let path = args.next().ok_or("Expected the journal path")?;
        println!(
            "{}",
            serde_json::to_string_pretty(&journal::inspect(Path::new(&path))?)?
        );
        return Ok(());
    }
    let count: usize = first.parse()?;
    if !(2..=MAX_PLAYERS).contains(&count) {
        return Err("Expected a player count from 2 to 8".into());
    }
    let addr: SocketAddr = env::var("TM4_MATCH_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8122".into())
        .parse()?;

    if !addr.ip().is_loopback() && !web::behind_proxy() {
        return Err(
            "Non-loopback WebSocket requires TM4_BEHIND_PROXY=1 and an authenticated HTTPS proxy"
                .into(),
        );
    }
    let launcher = if serve {
        Some(web::Launcher::start(count, addr)?)
    } else {
        None
    };
    let (count, selected_world, room_roster, simulator) = if let Some(launcher) = &launcher {
        loop {
            let Some(web::SetupRequest::Prepare) = launcher.wait_for_setup() else {
                return Ok(());
            };
            match simulator::Simulator::from_assets(&launcher.wasm, launcher.resource_directory()) {
                Ok(simulator) => {
                    launcher.ready(
                        simulator.catalog.worlds.clone(),
                        simulator.catalog.cars.clone(),
                        simulator.compatibility.clone(),
                    );
                    let Some(web::SetupRequest::Start(setup)) = launcher.wait_for_setup() else {
                        return Ok(());
                    };
                    break (setup.players, Some(setup.world), setup.roster, simulator);
                }
                Err(error) => {
                    launcher.phase("failed", &format!("Simulator setup failed: {error:#}"))
                }
            }
        }
    } else {
        (
            count,
            None,
            Vec::new(),
            simulator::Simulator::from_environment()?,
        )
    };
    let participants = ParticipantRoster::new(count, &(0..count).collect::<Vec<_>>())?;
    if !room_roster.is_empty() && room_roster.len() != count {
        return Err("Room members do not match the prepared participant roster".into());
    }
    // The mode assigns initial room members once. Admission uses these bindings,
    // never a room-list ordinal as a gameplay slot.
    let room_members = participants
        .slots()
        .map(|slot| participants.binding(slot))
        .zip(room_roster)
        .collect();
    if let Err(error) = run_match(
        participants,
        selected_world,
        room_members,
        addr,
        simulator,
        launcher.as_ref(),
    ) {
        if let Some(launcher) = &launcher {
            launcher.phase(
                "closed",
                &format!("Match server failed: {error}. Restart the server to try again."),
            );
            while !launcher.stopped.load(std::sync::atomic::Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
        } else {
            return Err(error);
        }
    }
    Ok(())
}

fn run_match(
    participants: ParticipantRoster,
    selected_world: Option<String>,
    room_members: Vec<(ControllerIdentity, web::RosterMember)>,
    addr: SocketAddr,
    simulator: simulator::Simulator,
    launcher: Option<&web::Launcher>,
) -> Result<(), Box<dyn Error>> {
    let count = participants.count();
    let capacity = participants.capacity();
    if !(MIN_PARTICIPANTS..=capacity).contains(&count) {
        return Err("Deathmatch needs at least two prepared participants".into());
    }
    let compatibility = simulator.compatibility.clone();
    let catalog = simulator.catalog.clone();
    let mut app = App::new();
    app.add_plugins((
        bevy_app::TaskPoolPlugin::default(),
        bevy_state::app::StatesPlugin,
        bevy_log::LogPlugin {
            filter: "warn".into(),
            ..Default::default()
        },
    ));
    app.add_plugins(ServerPlugins {
        tick_duration: STEP,
    });
    protocol(&mut app);
    use lightyear::input::server::InputValidationAppExt;
    app.add_input_validator(
        lightyear::input::server::authorize_controlled_targets::<
            lightyear::prelude::input::native::NativeStateSequence<ControllerCommand>,
        >,
    );
    app.add_observer(|event: On<Add, LinkOf>, mut commands: Commands| {
        commands.entity(event.entity).insert((
            Admission {
                opened: Instant::now(),
                window: Instant::now(),
                messages: 0,
                unacknowledged: HashSet::new(),
            },
            ReplicationSender,
            Transport::new(PriorityConfig::new(128 * 1024)),
            MessageSender::<Message>::default(),
            MessageSender::<game_protocol::AcceptedInputs>::default(),
            MessageReceiver::<Request>::default(),
        ));
    });
    let entity = app
        .world_mut()
        .spawn((
            RawServer,
            LocalAddr(addr),
            WebSocketServerIo {
                config: ServerConfig::builder()
                    .with_bind_address(addr)
                    .with_no_encryption()
                    .with_socket_config(lightyear::websocket::prelude::tungstenite::protocol::WebSocketConfig::default()
                        .max_message_size(Some(16 * 1024)).max_frame_size(Some(16 * 1024))
                        .write_buffer_size(1024).max_write_buffer_size(256 * 1024)),
            },
        ))
        .id();
    app.world_mut().trigger(LinkStart { entity });
    let mut game = Match {
        participants,
        controls: (0..capacity).map(|_| ControllerState::default()).collect(),
        authority_ready: false,
        compatibility: Some(compatibility),
        catalog: Some(catalog),
        selected_world,
        room_only: false,
        retired_connections: HashSet::new(),
        initial_digest: None,
        started: false,
        ended: false,
        tick: 0,
        lobby_since: None,
        loading_since: Instant::now(),
        last_step_duration: None,
        session: None,
        last_state: None,
        journal_directory: env::var_os("TM4_JOURNAL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("build/network-journals")),
        journal: None,
        journal_sealed: false,
        journal_export: launcher
            .map(|launcher| launcher.journal.clone())
            .unwrap_or_default(),
        prediction: AcceptedTimeline::default(),
        next_resume: 0,
        health: launcher
            .map(|launcher| launcher.health.clone())
            .unwrap_or_default(),
        tick_schedule: None,
    };
    if !room_members.is_empty() {
        game.configure_room(room_members)?;
    }
    app.insert_resource(game);
    app.insert_non_send(simulator);
    app.add_systems(Update, update);
    app.add_systems(
        PostUpdate,
        (bound_reliable_history, reap_closed_links)
            .chain()
            .after(lightyear::transport::plugin::TransportSystems::Send),
    );
    app.add_systems(
        PreUpdate,
        accept_native_inputs.after(lightyear::input::server::InputSystems::ReceiveInputs),
    );
    app.finish();
    app.cleanup();
    let started = Instant::now();
    while app.world().get::<Linked>(entity).is_none() {
        if started.elapsed() > Duration::from_secs(3) {
            return Err(format!("Unable to listen on {addr}").into());
        }
        app.update();
        thread::sleep(Duration::from_millis(1));
    }
    println!("Lightyear listening on ws://{addr} for {count} players");
    if let Some(launcher) = launcher {
        launcher.phase(
            "lobby",
            "Match ready. Players can open the player and select their own local disc.",
        );
    }
    let mut next_status = Instant::now();
    loop {
        if launcher
            .is_some_and(|launcher| launcher.stopped.load(std::sync::atomic::Ordering::Relaxed))
        {
            break;
        }
        app.update();
        if Instant::now() >= next_status {
            next_status = Instant::now() + Duration::from_millis(250);
            if let Some(launcher) = launcher {
                let game = app.world().resource::<Match>();
                let mut status = launcher.status.lock().unwrap();
                status.connected = game
                    .controls
                    .iter()
                    .filter(|player| player.connection.is_some())
                    .count();
                status.tick = game.tick;
                let mut health = game.health.lock().unwrap();
                for (slot, player) in game.controls.iter().enumerate() {
                    health.unacknowledged(
                        slot,
                        player
                            .connection
                            .and_then(|entity| app.world().get::<Admission>(entity))
                            .map_or(0, |admission| admission.unacknowledged.len()),
                    );
                }
                if game.ended {
                    if game
                        .last_state
                        .as_ref()
                        .is_some_and(|state| state.next_mode != 0)
                    {
                        status.phase = "results".into();
                        status.message =
                            "Match finished. Restart the server to prepare the next match.".into();
                    } else {
                        status.phase = "closed".into();
                        status.message =
                            "Match stopped. Restart the server to prepare a new match.".into();
                    }
                } else if game.started {
                    status.phase = "match".into();
                    status.message = "Roster locked. Existing participants can reconnect.".into();
                }
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

#[cfg(test)]
mod prediction_start_tests {
    use super::*;

    #[test]
    fn sparse_clock_quorum_does_not_wait_for_free_slots() {
        let mut timeline = AcceptedTimeline::default();
        let slots = [0, 3, 7];
        let PredictionStart::Offer(anchor) = timeline.negotiate(Tick(100), &slots) else {
            panic!("offer");
        };
        timeline.vote(0, anchor, Tick(101));
        timeline.vote(3, anchor, Tick(101));
        assert_eq!(
            timeline.negotiate(Tick(102), &slots),
            PredictionStart::Waiting
        );
        timeline.vote(7, anchor, Tick(101));
        assert_eq!(
            timeline.negotiate(Tick(102), &slots),
            PredictionStart::Commit(anchor)
        );
    }

    // Runs the ordinary production match path with preparation-only sparse bindings.
    // Terminate the fixture process after the browser test completes.
    #[test]
    #[ignore = "manual sparse browser fixture; requires private resources and compiled simulation"]
    fn sparse_match_browser_fixture() {
        let roster = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
        run_match(
            roster,
            None,
            Vec::new(),
            env::var("TM4_MATCH_LISTEN").unwrap().parse().unwrap(),
            simulator::Simulator::from_environment().unwrap(),
            None,
        )
        .unwrap();
    }

    #[test]
    #[ignore = "authenticated sparse room browser fixture; requires private resources and compiled simulation"]
    fn sparse_room_match_browser_fixture() {
        let roster = ParticipantRoster::new(8, &[3, 6]).unwrap();
        let members = vec![
            (
                roster.binding(6),
                web::RosterMember {
                    credential: "bb".repeat(32),
                    car: "Pizza Boy".into(),
                },
            ),
            (
                roster.binding(3),
                web::RosterMember {
                    credential: "aa".repeat(32),
                    car: "Orbital".into(),
                },
            ),
        ];
        run_match(
            roster,
            None,
            members,
            env::var("TM4_MATCH_LISTEN").unwrap().parse().unwrap(),
            simulator::Simulator::from_environment().unwrap(),
            None,
        )
        .unwrap();
    }

    #[test]
    fn closed_links_are_reaped_without_deleting_persistent_controllers() {
        let mut app = App::new();
        app.add_systems(PostUpdate, reap_closed_links);
        let server = app.world_mut().spawn_empty().id();
        let closed = app
            .world_mut()
            .spawn((
                LinkOf { server },
                Unlinked {
                    reason: UnlinkReason::ByPeer("test close".into()),
                },
            ))
            .id();
        let child = app.world_mut().spawn(ChildOf(closed)).id();
        let controller = app
            .world_mut()
            .spawn(ControlledBy {
                owner: closed,
                lifetime: Lifetime::Persistent,
            })
            .id();
        let pending = app
            .world_mut()
            .spawn((
                LinkOf { server },
                Unlinked {
                    reason: UnlinkReason::Initial,
                },
            ))
            .id();
        let connected = app.world_mut().spawn((LinkOf { server }, Linked)).id();
        assert!(app.world().get::<ControlledSend>(controller).is_some());
        app.update();
        assert!(app.world().get_entity(closed).is_err());
        assert!(app.world().get_entity(child).is_err());
        for entity in [server, controller, pending, connected] {
            assert!(app.world().get_entity(entity).is_ok());
        }
        assert!(app.world().get::<ControlledBy>(controller).is_none());
        assert!(app.world().get::<ControlledSend>(controller).is_none());
    }

    #[test]
    fn a_late_vote_reoffers_before_commit_and_ignores_old_votes() {
        let mut timeline = AcceptedTimeline::default();
        assert_eq!(
            timeline.negotiate(Tick(100), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        assert_eq!(
            timeline.negotiate(Tick(118), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Waiting
        );
        timeline.vote(1, Tick(112), Tick(123));
        let PredictionStart::Offer(anchor) =
            timeline.negotiate(Tick(120), &(0..2).collect::<Vec<_>>())
        else {
            panic!("Expired offer was not replaced");
        };
        assert!(timeline.anchor.is_none());
        timeline.vote(0, Tick(112), Tick(124));
        timeline.vote(1, anchor, Tick(126));
        assert_eq!(
            timeline.negotiate(Tick(125), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Waiting
        );
        timeline.vote(0, anchor, Tick(129));
        assert_eq!(
            timeline.negotiate(Tick(127), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Commit(anchor)
        );
        assert_eq!(timeline.anchor, Some(anchor));
    }

    #[test]
    fn an_unusable_peer_cannot_unbound_the_offer_window() {
        let mut timeline = AcceptedTimeline::default();
        assert_eq!(
            timeline.negotiate(Tick(100), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        timeline.vote(1, Tick(112), Tick(350));
        assert_eq!(
            timeline.negotiate(Tick(106), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Unavailable
        );
        assert!(timeline.anchor.is_none());
    }
}

#[cfg(test)]
mod lobby_tests {
    use super::*;

    #[test]
    fn car_selection_requires_catalog_membership_and_explicit_readiness() {
        let catalog = Catalog {
            cars: vec!["Orbital".into(), "Pizza Boy".into()],
            worlds: vec![],
        };
        let mut player = Participant::default();
        assert!(!player.lobby_ready);
        assert!(
            player
                .select_car(&catalog, "Pizza Boy".into(), true)
                .is_ok()
        );
        assert_eq!(player.car.as_deref(), Some("Pizza Boy"));
        assert!(player.lobby_ready);
        assert!(
            player
                .select_car(&catalog, "unknown".into(), false)
                .is_err()
        );
        assert_eq!(player.car.as_deref(), Some("Pizza Boy"));
        assert!(player.lobby_ready);
        player
            .select_car(&catalog, "Orbital".into(), false)
            .unwrap();
        assert!(!player.lobby_ready);
        assert_eq!(player.car.as_deref(), Some("Orbital"));
        let mut other = Participant::default();
        other.select_car(&catalog, "Orbital".into(), true).unwrap();
        assert_eq!(other.car, player.car);
    }
}

#[cfg(test)]
mod participant_control_tests {
    use super::*;
    use bevy_ecs::system::RunSystemOnce;
    use tm4_network::protocol::{ParticipantId, Score};

    fn game() -> Match {
        let compatibility = Compatibility {
            protocol: game_protocol::PROTOCOL_VERSION,
            build: "test".into(),
            content: "test".into(),
        };
        Match {
            participants: ParticipantRoster::new(2, &[0, 1]).unwrap(),
            controls: (0..2).map(|_| ControllerState::default()).collect(),
            authority_ready: true,
            compatibility: Some(compatibility.clone()),
            catalog: Some(Catalog {
                cars: vec!["Orbital".into(), "Pizza Boy".into()],
                worlds: vec!["Construction Yard".into()],
            }),
            selected_world: None,
            room_only: false,
            retired_connections: HashSet::new(),
            initial_digest: Some(123),
            started: true,
            ended: false,
            tick: 100,
            lobby_since: None,
            loading_since: Instant::now(),
            last_step_duration: None,
            session: Some(SessionStart {
                capacity: 2,
                slots: (0..2).map(|slot| slot as u8).collect(),
                world: "Construction Yard".into(),
                cars: vec!["Orbital".into(), "Pizza Boy".into()],
                compatibility,
                seed: 12345,
                epoch: 1,
                portable: true,
            }),
            last_state: Some(RoundState {
                remaining: 2,
                winner: -1,
                round_finished: false,
                accepts_continue: false,
                next_mode: 0,
                digest: 123,
                sections: [0; 5],
                unsupported: None,
                scores: vec![Score { wins: 3, losses: 1 }, Score { wins: 0, losses: 3 }],
            }),
            journal_directory: PathBuf::new(),
            journal: None,
            journal_sealed: false,
            journal_export: Default::default(),
            prediction: AcceptedTimeline {
                anchor: Some(Tick(1)),
                ..Default::default()
            },
            next_resume: 0,
            health: Default::default(),
            tick_schedule: None,
        }
    }

    fn connection(world: &mut World, id: u64) -> Entity {
        world
            .spawn((
                RemoteId(PeerId::Netcode(id)),
                Connected,
                MessageSender::<Message>::default(),
            ))
            .id()
    }

    fn request(world: &mut World, entity: Entity, request: Request) {
        let mut request = Some(request);
        world.run_system_once(move |mut game: ResMut<Match>, mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>| {
            game.request(&mut links, entity, request.take().unwrap());
        }).unwrap();
    }

    fn bind(world: &mut World) {
        world
            .run_system_once(
                |mut game: ResMut<Match>, owners: Query<&ControlledBy>, mut commands: Commands| {
                    bind_controllers(&mut game, &owners, &mut commands);
                },
            )
            .unwrap();
    }

    fn buffer(sequence: u32, buttons: u16) -> NativeBuffer<ControllerCommand> {
        let mut buffer = NativeBuffer::default();
        buffer.set(
            Tick(101),
            ActionState(ControllerCommand {
                epoch: 1,
                sequence,
                tick: 100,
                input: Input {
                    buttons,
                    ..Default::default()
                },
            }),
        );
        buffer
    }

    #[test]
    #[ignore = "requires private resources and diagnostic Wasm"]
    fn preparation_cancellation_waits_for_replacement_before_starting() -> anyhow::Result<()> {
        let mut world = World::new();
        let mut game = game();
        game.started = false;
        game.tick = 0;
        game.session = None;
        game.initial_digest = None;
        game.last_state = None;
        game.prediction = Default::default();
        let compatibility = game.compatibility.clone().unwrap();
        let wasm = std::fs::read(env::var("TM4_SIMULATION_WASM")?)?;
        let resources = PathBuf::from(env::var("TM4_RESOURCE_DIR")?);
        let simulator = simulator::Simulator::new(&wasm, &resources, compatibility.clone())?;
        world.insert_non_send(simulator);
        world.insert_resource(LocalTimeline::default());
        world.insert_resource(game);
        world
            .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
                for slot in [0, 1] {
                    let binding = game.participants.binding(slot);
                    game.release_preparation(binding, &mut commands).unwrap();
                }
            })
            .unwrap();
        world.run_system_once(update).unwrap();
        assert!(!world.resource::<Match>().started);
        assert!(!world.resource::<Match>().ended);
        assert!(world.resource::<Match>().session.is_none());

        // Two reservations exist, but cancelling one must not start the ready survivor.
        for slot in [0, 1] {
            world
                .resource_mut::<Match>()
                .reserve_preparation(slot)
                .unwrap();
        }
        let first = connection(&mut world, 71);
        request(
            &mut world,
            first,
            Request::Join {
                compatibility: compatibility.clone(),
            },
        );
        request(
            &mut world,
            first,
            Request::SelectCar {
                car: "Orbital".into(),
                ready: true,
            },
        );
        world
            .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
                let binding = game.participants.binding(1);
                game.release_preparation(binding, &mut commands).unwrap();
            })
            .unwrap();
        world.run_system_once(update).unwrap();
        assert!(!world.resource::<Match>().started);
        assert!(!world.resource::<Match>().ended);
        assert!(world.resource::<Match>().session.is_none());

        // This operation also proves the preceding updates did not freeze preparation.
        world
            .resource_mut::<Match>()
            .reserve_preparation(1)
            .unwrap();
        let replacement = connection(&mut world, 72);
        request(&mut world, replacement, Request::Join { compatibility });
        request(
            &mut world,
            replacement,
            Request::SelectCar {
                car: "Pizza Boy".into(),
                ready: true,
            },
        );
        world.run_system_once(update).unwrap();
        let game = world.resource::<Match>();
        assert!(game.started && !game.ended);
        assert_eq!(game.session.as_ref().unwrap().slots, vec![0, 1]);
        assert!(game.initial_digest.is_some());
        assert_eq!(
            world
                .non_send_mut::<simulator::Simulator>()
                .state()?
                .remaining,
            2
        );
        Ok(())
    }

    #[test]
    fn room_admission_and_preparation_reconnect_use_participant_bindings() {
        let mut world = World::new();
        let first = connection(&mut world, 3);
        let second = connection(&mut world, 6);
        let reconnect = connection(&mut world, 33);
        let mut game = game();
        game.started = false;
        game.participants = ParticipantRoster::new(8, &[3, 6]).unwrap();
        game.controls = (0..8).map(|_| ControllerState::default()).collect();
        let a = game.participants.binding(3);
        let b = game.participants.binding(6);
        game.configure_room(vec![
            (
                b,
                web::RosterMember {
                    credential: "bb".repeat(32),
                    car: "Pizza Boy".into(),
                },
            ),
            (
                a,
                web::RosterMember {
                    credential: "aa".repeat(32),
                    car: "Orbital".into(),
                },
            ),
        ])
        .unwrap();
        let compatibility = game.compatibility.clone().unwrap();
        world.insert_resource(game);
        request(
            &mut world,
            second,
            Request::Resume {
                token: "bb".repeat(32),
                compatibility: compatibility.clone(),
            },
        );
        request(
            &mut world,
            first,
            Request::Resume {
                token: "aa".repeat(32),
                compatibility: compatibility.clone(),
            },
        );
        bind(&mut world);
        assert_eq!(
            world.resource::<Match>().controls[3].connection,
            Some(first)
        );
        assert_eq!(
            world.resource::<Match>().controls[6].connection,
            Some(second)
        );
        let controller = world.resource::<Match>().controls[3].controller.unwrap();
        assert_eq!(world.get::<ControllerIdentity>(controller), Some(&a));
        world.resource_mut::<Match>().controls[3].received_sequence = 41;
        world
            .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                detach_connection(&mut game, 3, first, &mut commands);
            })
            .unwrap();
        request(
            &mut world,
            reconnect,
            Request::Resume {
                token: "aa".repeat(32),
                compatibility,
            },
        );
        bind(&mut world);
        let game = world.resource::<Match>();
        assert_eq!(game.controls[3].connection, Some(reconnect));
        assert_eq!(game.controls[3].controller, Some(controller));
        assert_eq!(game.controls[3].received_sequence, 41);
        assert_eq!(game.participants.binding(3), a);
        assert_eq!(
            world.get::<ControlledBy>(controller).unwrap().owner,
            reconnect
        );
    }

    #[test]
    fn preparation_reuse_retires_existing_controller_connection_and_input() {
        let mut world = World::new();
        let old = connection(&mut world, 1);
        let other = connection(&mut world, 2);
        let newcomer = connection(&mut world, 3);
        let mut game = game();
        game.started = false;
        game.controls[0].connection = Some(old);
        game.controls[1].connection = Some(other);
        game.controls[0].received_sequence = 41;
        game.controls[0]
            .history
            .enqueue(
                100,
                41,
                100,
                Input {
                    buttons: 0x40,
                    ..Default::default()
                },
            )
            .unwrap();
        game.prediction.accepted[0].set(
            Tick(101),
            ActionState(Input {
                buttons: 0x40,
                ..Default::default()
            }),
        );
        let retired = game.participants.binding(0);
        let unaffected = game.participants.binding(1);
        let compatibility = game.compatibility.clone().unwrap();
        world.insert_resource(game);
        bind(&mut world);
        let old_controller = world.resource::<Match>().controls[0].controller.unwrap();
        world.entity_mut(old_controller).insert(buffer(42, 0x40));
        world
            .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                game.replace_preparation(retired, &mut commands).unwrap();
            })
            .unwrap();
        bind(&mut world);
        assert!(world.get_entity(old_controller).is_err());
        {
            let mut game = world.resource_mut::<Match>();
            assert_eq!(game.controls[0].connection, None);
            assert_eq!(game.controls[0].controller, None);
            assert_eq!(game.controls[0].received_sequence, 0);
            assert_eq!(game.controls[0].history.sample(100), Input::default());
            assert_eq!(game.prediction.accepted[0].len(), 0);
            assert_ne!(game.participants.binding(0), retired);
            assert_eq!(game.participants.binding(1), unaffected);
        }
        request(
            &mut world,
            old,
            Request::SelectCar {
                car: "Pizza Boy".into(),
                ready: true,
            },
        );
        assert!(
            world
                .resource::<Match>()
                .participants
                .at_slot(0)
                .car
                .is_none()
        );
        request(
            &mut world,
            old,
            Request::Join {
                compatibility: compatibility.clone(),
            },
        );
        assert_eq!(
            world.resource::<Match>().controls[0].connection,
            None,
            "A stale Join on the retired connection reclaimed the replacement binding"
        );
        request(&mut world, newcomer, Request::Join { compatibility });
        bind(&mut world);
        let game = world.resource::<Match>();
        let current = game.controls[0].controller.unwrap();
        assert_ne!(current, old_controller);
        assert_eq!(game.controls[0].connection, Some(newcomer));
        assert_eq!(
            world.get::<ControllerIdentity>(current),
            Some(&game.participants.binding(0))
        );
        assert_eq!(world.get::<ControlledBy>(current).unwrap().owner, newcomer);
    }

    #[test]
    fn retired_room_credential_cannot_claim_a_reused_slot_and_running_release_is_fenced() {
        let mut world = World::new();
        let old = connection(&mut world, 1);
        let mut game = game();
        game.started = false;
        let retired = game.participants.binding(0);
        game.configure_room(vec![
            (
                retired,
                web::RosterMember {
                    credential: "aa".repeat(32),
                    car: "Orbital".into(),
                },
            ),
            (
                game.participants.binding(1),
                web::RosterMember {
                    credential: "bb".repeat(32),
                    car: "Pizza Boy".into(),
                },
            ),
        ])
        .unwrap();
        let compatibility = game.compatibility.clone().unwrap();
        world.insert_resource(game);
        request(
            &mut world,
            old,
            Request::Resume {
                token: "aa".repeat(32),
                compatibility: compatibility.clone(),
            },
        );
        bind(&mut world);
        world
            .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                game.replace_preparation(retired, &mut commands).unwrap();
            })
            .unwrap();
        request(
            &mut world,
            old,
            Request::Resume {
                token: "aa".repeat(32),
                compatibility,
            },
        );
        assert_eq!(world.resource::<Match>().controls[0].connection, None);
        world.resource_mut::<Match>().started = true;
        world
            .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
                let current = game.participants.binding(0);
                assert!(game.release_preparation(current, &mut commands).is_err());
                assert_eq!(game.participants.resolve(&current), Some(0));
            })
            .unwrap();
    }

    #[test]
    fn reused_sparse_slot_rejects_previous_owner_and_accepts_slot_seven() {
        let mut world = World::new();
        let owner = connection(&mut world, 7);
        let mut game = game();
        game.participants = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
        game.controls = (0..8).map(|_| ControllerState::default()).collect();
        let retired = game.participants.binding(7);
        game.started = false;
        world.insert_resource(game);
        world
            .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                game.replace_preparation(retired, &mut commands).unwrap();
            })
            .unwrap();
        let current = world.resource::<Match>().participants.binding(7);
        world.resource_mut::<Match>().controls[7].connection = Some(owner);
        world.resource_mut::<Match>().started = true;
        bind(&mut world);
        let controller = world.resource::<Match>().controls[7].controller.unwrap();
        world
            .entity_mut(controller)
            .insert((retired, buffer(1, 0x40)));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(world.resource::<Match>().controls[7].received_sequence, 0);
        world
            .entity_mut(controller)
            .insert((current, buffer(1, 0x40)));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(
            world.resource_mut::<Match>().controls[7]
                .history
                .sample(100)
                .buttons,
            0x40
        );
        assert!(
            world
                .resource::<Match>()
                .controls
                .iter()
                .enumerate()
                .filter(|(slot, _)| *slot != 7)
                .all(|(_, control)| control.received_sequence == 0)
        );
    }

    #[test]
    fn reconnect_keeps_binding_results_and_watermark_and_fences_the_old_connection() {
        let mut world = World::new();
        let old = connection(&mut world, 1);
        let replacement = connection(&mut world, 2);
        let duplicate = connection(&mut world, 3);
        let mut game = game();
        game.controls[0].connection = Some(old);
        game.controls[0].received_sequence = 41;
        let token = "ab".repeat(32);
        game.participants.at_slot_mut(0).credential = Some(token.clone());
        game.participants.at_slot_mut(0).car = Some("Orbital".into());
        let binding = game.participants.binding(0);
        let compatibility = game.compatibility.clone().unwrap();
        world.insert_resource(game);
        bind(&mut world);
        let controller = world.resource::<Match>().controls[0].controller.unwrap();
        // Native records not consumed before disconnect must not enter the new
        // connection's command stream, even if they carry a larger sequence.
        world.entity_mut(controller).insert(buffer(999, 99));
        world.resource_mut::<Match>().controls[0].disconnect(old);
        world.entity_mut(old).remove::<Connected>();
        request(
            &mut world,
            old,
            Request::Resume {
                token: token.clone(),
                compatibility: compatibility.clone(),
            },
        );
        assert!(world.resource::<Match>().controls[0].connection.is_none());
        request(
            &mut world,
            replacement,
            Request::Resume {
                token: "cd".repeat(32),
                compatibility: compatibility.clone(),
            },
        );
        assert!(world.resource::<Match>().controls[0].connection.is_none());
        let mut incompatible = compatibility.clone();
        incompatible.build = "other".into();
        request(
            &mut world,
            replacement,
            Request::Resume {
                token: token.clone(),
                compatibility: incompatible,
            },
        );
        assert!(world.resource::<Match>().controls[0].connection.is_none());
        request(
            &mut world,
            replacement,
            Request::Resume {
                token: token.clone(),
                compatibility: compatibility.clone(),
            },
        );
        bind(&mut world);
        assert!(
            world
                .get::<NativeBuffer<ControllerCommand>>(controller)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            world.get::<ControlledBy>(controller).unwrap().owner,
            replacement
        );
        {
            let game = world.resource::<Match>();
            assert_eq!(game.participants.binding(0), binding);
            assert_eq!(game.controls[0].controller, Some(controller));
            assert_eq!(game.controls[0].received_sequence, 41);
            assert_eq!(game.participants.at_slot(0).car.as_deref(), Some("Orbital"));
            assert_eq!(game.last_state.as_ref().unwrap().scores[0].wins, 3);
        }
        request(
            &mut world,
            duplicate,
            Request::Resume {
                token,
                compatibility,
            },
        );
        assert_eq!(
            world.resource::<Match>().controls[0].connection,
            Some(replacement)
        );
        // Delayed disconnect and session messages from the old link cannot
        // evict or advance the replacement's recovery attempt.
        assert!(!world.resource_mut::<Match>().controls[0].disconnect(old));
        request(&mut world, old, Request::Progress { tick: 100 });
        assert_eq!(world.resource::<Match>().controls[0].progress_tick, 0);
        let server = world.spawn_empty().id();
        world.entity_mut(old).insert((
            LinkOf { server },
            Unlinked {
                reason: UnlinkReason::ByPeer("delayed close".into()),
            },
        ));
        world.run_system_once(reap_closed_links).unwrap();
        assert_eq!(
            world.get::<ControlledBy>(controller).unwrap().owner,
            replacement
        );
        // Restore activation is unchanged; the next command must still exceed
        // the original participant's high-water mark.
        world.resource_mut::<Match>().controls[0].resume = None;
        world.entity_mut(controller).insert(buffer(41, 7));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(
            world.resource_mut::<Match>().controls[0]
                .history
                .sample(100),
            Input::default()
        );
        world.entity_mut(controller).insert(buffer(42, 8));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(
            world.resource_mut::<Match>().controls[0]
                .history
                .sample(100)
                .buttons,
            8
        );
    }

    #[test]
    fn input_requires_the_current_participant_controller_and_connected_owner() {
        let mut world = World::new();
        let owner = connection(&mut world, 1);
        let other = connection(&mut world, 2);
        let mut game = game();
        // The other tests exercise replacement through the preparation operation.
        game.controls[0].connection = Some(owner);
        world.insert_resource(game);
        bind(&mut world);
        let controller = world.resource::<Match>().controls[0].controller.unwrap();
        let identity = world.resource::<Match>().participants.binding(0);
        let wrong = world
            .resource::<Match>()
            .participants
            .binding(1)
            .participant;
        for invalid in [
            ControllerIdentity {
                participant: ParticipantId(999),
                ..identity
            },
            ControllerIdentity {
                participant: wrong,
                ..identity
            },
            ControllerIdentity {
                slot: 255,
                ..identity
            },
        ] {
            world.entity_mut(controller).insert((invalid, buffer(1, 9)));
            world.run_system_once(accept_native_inputs).unwrap();
            assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
        }
        world.entity_mut(controller).insert((
            identity,
            ControlledBy {
                owner: other,
                lifetime: Lifetime::Persistent,
            },
        ));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
        world.entity_mut(controller).insert(ControlledBy {
            owner,
            lifetime: Lifetime::Persistent,
        });
        // A second entity cannot borrow a valid participant binding.
        let forged = world
            .spawn((
                identity,
                ControlledBy {
                    owner,
                    lifetime: Lifetime::Persistent,
                },
                buffer(999, 9),
            ))
            .id();
        world
            .entity_mut(controller)
            .insert(NativeBuffer::<ControllerCommand>::default());
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
        world.despawn(forged);
        world.entity_mut(owner).remove::<Connected>();
        world.entity_mut(controller).insert(buffer(1, 9));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
        world.entity_mut(owner).insert(Connected);
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(
            world.resource_mut::<Match>().controls[0]
                .history
                .sample(100)
                .buttons,
            9
        );
        assert_eq!(world.resource::<Match>().controls[1].received_sequence, 0);
    }

    #[test]
    fn lobby_disconnect_preserves_authenticated_room_identity_but_not_an_open_seat() {
        for room in [false, true] {
            let mut world = World::new();
            let old = connection(&mut world, 1);
            let replacement = connection(&mut world, 2);
            let mut game = game();
            game.started = false;
            let token = "ab".repeat(32);
            if room {
                game.configure_room(vec![
                    (
                        game.participants.binding(0),
                        web::RosterMember {
                            credential: token.clone(),
                            car: "Orbital".into(),
                        },
                    ),
                    (
                        game.participants.binding(1),
                        web::RosterMember {
                            credential: "cd".repeat(32),
                            car: "Pizza Boy".into(),
                        },
                    ),
                ])
                .unwrap();
            }
            game.controls[0].connection = Some(old);
            game.controls[0].received_sequence = 41;
            let binding = game.participants.binding(0);
            let other_binding = game.participants.binding(1);
            let compatibility = game.compatibility.clone().unwrap();
            world.insert_resource(game);
            bind(&mut world);
            let controller = world.resource::<Match>().controls[0].controller.unwrap();
            world
                .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                    assert!(detach_connection(&mut game, 0, old, &mut commands));
                })
                .unwrap();
            world.entity_mut(old).remove::<Connected>();
            let join = if room {
                Request::Resume {
                    token,
                    compatibility,
                }
            } else {
                Request::Join { compatibility }
            };
            request(&mut world, replacement, join);
            bind(&mut world);
            let game = world.resource::<Match>();
            assert_eq!(game.controls[0].connection, Some(replacement));
            assert_eq!(game.participants.binding(1), other_binding);
            if room {
                assert_eq!(game.participants.binding(0), binding);
                assert_eq!(game.controls[0].controller, Some(controller));
                assert_eq!(game.controls[0].received_sequence, 41);
            } else {
                assert_ne!(
                    game.participants.binding(0).participant,
                    binding.participant
                );
                assert_ne!(game.controls[0].controller, Some(controller));
                assert_eq!(game.controls[0].received_sequence, 0);
            }
        }
    }
}
