mod assets;
mod health;
mod journal;
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

const TICK_RATE: u64 = 30;
const STEP: Duration = Duration::from_nanos(1_000_000_000 / TICK_RATE);
const SIMULATOR_LAG_LIMIT: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Player {
    entity: Option<Entity>,
    ready: bool,
    car: Option<String>,
    lobby_ready: bool,
    compatibility: Option<Compatibility>,
    initial_digest: Option<u32>,
    history: InputHistory,
    controller: Option<Entity>,
    received_sequence: u32,
    progress_tick: u32,
    credential: Option<String>,
    resume: Option<resume::Attempt>,
    reassign_controller: bool,
}

impl Player {
    fn select_car(
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

    fn receives_live(&self) -> bool {
        self.resume.is_none() && self.entity.is_some()
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

    fn negotiate(&mut self, now: Tick, players: usize) -> PredictionStart {
        let lead = if let Some(offer) = &self.offer {
            let votes = &offer.votes[..players];
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
        players: &[Player],
    ) -> game_protocol::AcceptedInputs {
        use lightyear::input::input_message::{ActionStateSequence, InputTarget, PerTargetData};
        let end = self.anchor.unwrap() + tick as i32 + 1;
        let mut packet = game_protocol::AcceptedInputs::new(end);
        packet.rebroadcast = true;
        for (slot, player) in players.iter().enumerate() {
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
    players: Vec<Player>,
    authority_ready: bool,
    compatibility: Option<Compatibility>,
    catalog: Option<Catalog>,
    selected_world: Option<String>,
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
    fn broadcast(
        &self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        message: &Message,
    ) {
        for entity in self.players.iter().filter_map(|player| player.entity) {
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
        for player in &mut self.players {
            let (Some(entity), Some(attempt)) = (player.entity, player.resume.as_mut()) else {
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
        for player in &mut self.players {
            if let Some(attempt) = player.resume.as_mut() {
                if attempt.target.is_some_and(|target| tick >= target) {
                    if attempt.frames.len() == usize::from(game_protocol::PREDICTION_DEPTH) {
                        attempt.frames.pop_front();
                    }
                    attempt.frames.push_back(message.clone());
                }
            } else if player.receives_live()
                && let Some(entity) = player.entity
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
                for player in &mut self.players {
                    player.credential = resume::credential();
                    if let (Some(entity), Some(token)) = (player.entity, player.credential.clone())
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
                    .players
                    .iter()
                    .map(|player| LobbyPlayer {
                        connected: player.entity.is_some(),
                        car: player.car.clone(),
                        ready: player.lobby_ready,
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
        let slot = self
            .players
            .iter()
            .position(|player| player.entity == Some(entity));
        match request {
            Request::Join { compatibility } if !self.started && !self.ended && slot.is_none() => {
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
                    .players
                    .iter()
                    .position(|player| player.entity.is_none())
                {
                    self.players[slot].entity = Some(entity);
                    self.players[slot].compatibility = Some(compatibility);
                    self.players[slot].car = self.catalog.as_ref().unwrap().cars.get(slot).cloned();
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
            Request::SelectCar { car, ready } if !self.started && !self.ended && slot.is_some() => {
                match self.players[slot.unwrap()].select_car(
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
            Request::Resume { compatibility, .. } if !self.started && !self.ended => {
                self.request(links, entity, Request::Join { compatibility });
            }
            Request::Resume {
                token,
                compatibility,
            } if slot.is_none() => {
                let requested = self.players.iter().position(|player| {
                    player
                        .credential
                        .as_deref()
                        .is_some_and(|expected| resume::matches_credential(expected, &token))
                });
                let session = self.session.as_ref().filter(|session| {
                    session.portable
                        && session.compatibility == compatibility
                        && self.started
                        && !self.ended
                        && self.tick > 0
                });
                if let (Some(slot), Some(session)) = (requested, session)
                    && self.players[slot].entity.is_none()
                {
                    self.health
                        .lock()
                        .unwrap()
                        .event("rustymetal4_reconnections_accepted_total");
                    self.next_resume = self.next_resume.wrapping_add(1);
                    let player = &mut self.players[slot];
                    player.entity = Some(entity);
                    player.history.disconnect();
                    player.resume = Some(resume::Attempt::new(self.next_resume));
                    player.reassign_controller = true;
                    send(links, entity, &Message::Welcome { slot });
                    send(links, entity, &Message::ResumePrepare(session.clone()));
                } else {
                    send(links, entity, &Message::Error {
                        message: "This participant cannot resume this match. If its previous connection is still closing, retry in a moment.".into(),
                    });
                }
            }
            Request::SnapshotReceived {
                attempt: id,
                offset,
            } if slot.is_some() => {
                if let Some(attempt) = self.players[slot.unwrap()].resume.as_mut()
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
                if let Some(attempt) = self.players[slot.unwrap()].resume.as_mut()
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
                let player = &mut self.players[slot.unwrap()];
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
                    self.players[slot].ready = true;
                    self.players[slot].initial_digest = Some(digest);
                }
            }
            Request::PredictionClock {
                epoch: 1,
                anchor,
                tick,
            } if self.started && !self.ended => {
                if let Some(slot) = slot.filter(|&slot| self.players[slot].ready) {
                    self.prediction.vote(slot, Tick(anchor), Tick(tick));
                }
            }
            Request::Progress { tick } if tick <= self.tick => {
                if let Some(player) = slot.map(|slot| &mut self.players[slot])
                    && player.receives_live()
                {
                    player.progress_tick = player.progress_tick.max(tick);
                }
            }
            Request::CatchupApplied { attempt: id, tick } if slot.is_some() => {
                let player = &mut self.players[slot.unwrap()];
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

fn update(
    native_timeline: Res<LocalTimeline>,
    mut accepted_senders: Query<&mut MessageSender<game_protocol::AcceptedInputs>, With<Connected>>,
    mut game: ResMut<Match>,
    mut simulator: NonSendMut<simulator::Simulator>,
    mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    mut receivers: Query<(Entity, &mut MessageReceiver<Request>, &mut Admission)>,
    link_states: Query<Option<&Unlinked>, With<LinkOf>>,
    mut commands: Commands,
) {
    let started = game.started;
    let mut lobby_changed = false;
    for slot in 0..game.players.len() {
        let player = &mut game.players[slot];
        if player.entity.is_some_and(|entity| !links.contains(entity)) {
            player.entity = None;
            player.history.disconnect();
            player.resume = None;
            if !started {
                if let Some(controller) = player.controller {
                    commands.entity(controller).despawn();
                }
                *player = Player::default();
                lobby_changed = true;
            }
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
        let known = game.players.iter().any(|p| p.entity == Some(entity));
        let stalled = game
            .players
            .iter()
            .find(|p| p.entity == Some(entity))
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
    for (slot, player) in game.players.iter_mut().enumerate() {
        if std::mem::take(&mut player.reassign_controller)
            && let (Some(controller), Some(owner)) = (player.controller, player.entity)
        {
            commands.entity(controller).insert(ControlledBy {
                owner,
                lifetime: Lifetime::Persistent,
            });
        }
        if let Some(owner) = player.entity
            && player.controller.is_none()
        {
            player.controller = Some(commands.spawn((
                ControllerIdentity { slot: slot as u8 },
                lightyear::prelude::input::native::ActionState::<ControllerCommand>::default(),
                Replicate::to_clients(NetworkTarget::All),
                ControlledBy { owner, lifetime: Lifetime::Persistent },
            )).id());
        }
    }

    if !game.started && !game.ended {
        if game.players.iter().any(|player| player.entity.is_some()) {
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
            && game
                .players
                .iter()
                .any(|player| player.entity.is_none() || !player.lobby_ready))
    {
        return;
    }
    if !game.started {
        if game
            .players
            .iter()
            .any(|player| player.compatibility != game.compatibility)
        {
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
        game.started = true;
        game.loading_since = Instant::now();
        let start = SessionStart {
            players: game.players.len(),
            world: game
                .selected_world
                .clone()
                .unwrap_or_else(|| game.catalog.as_ref().unwrap().worlds[0].clone()),
            cars: game
                .players
                .iter()
                .map(|player| player.car.clone().unwrap())
                .collect(),
            compatibility: game.compatibility.clone().unwrap(),
            seed: 12345,
            epoch: 1,
            portable: (2..=8).contains(&game.players.len()),
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
        game.broadcast(&mut links, &Message::PredictionPrepare(start));
    }

    let now = Instant::now();
    if game.prediction.anchor.is_none() && game.players.iter().any(|player| player.entity.is_none())
    {
        game.fail(
            &mut links,
            "A player disconnected before the match clocks were agreed.",
        );
        return;
    }
    if !game.authority_ready || game.players.iter().any(|player| !player.ready) {
        if now.duration_since(game.loading_since) > Duration::from_secs(45) {
            game.fail(&mut links, "Session loading exceeded 45 seconds.");
        }
        return;
    }
    if game.tick == 0
        && game
            .players
            .iter()
            .any(|p| p.initial_digest != game.initial_digest)
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
    let players = game.players.len();
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
        match game.prediction.negotiate(native_tick, players) {
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
            .players
            .iter_mut()
            .map(|player| player.history.sample(tick))
            .collect();
        let game = &mut *game;
        let packet = game.prediction.packet(tick, &inputs, &game.players);
        for player in &game.players {
            if let Some(entity) = player.entity
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
    controllers: Query<(&ControllerIdentity, &NativeBuffer<ControllerCommand>)>,
) {
    if !game.started || game.ended || game.prediction.anchor.is_none() {
        return;
    }
    let earliest = game.tick;
    let health = game.health.clone();
    for (identity, buffer) in &controllers {
        let (Some(mut tick), Some((last, _))) = (buffer.start_tick, buffer.get_last_with_tick())
        else {
            continue;
        };
        let player = &mut game.players[usize::from(identity.slot)];
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
    let (count, selected_world, simulator) = if let Some(launcher) = &launcher {
        loop {
            let Some(web::SetupRequest::Prepare) = launcher.wait_for_setup() else {
                return Ok(());
            };
            match simulator::Simulator::from_assets(&launcher.wasm, launcher.resource_directory()) {
                Ok(simulator) => {
                    launcher.ready(simulator.catalog.worlds.clone());
                    let Some(web::SetupRequest::Start(setup)) = launcher.wait_for_setup() else {
                        return Ok(());
                    };
                    break (setup.players, Some(setup.world), simulator);
                }
                Err(error) => {
                    launcher.phase("failed", &format!("Simulator setup failed: {error:#}"))
                }
            }
        }
    } else {
        (count, None, simulator::Simulator::from_environment()?)
    };
    if let Err(error) = run_match(count, selected_world, addr, simulator, launcher.as_ref()) {
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
    count: usize,
    selected_world: Option<String>,
    addr: SocketAddr,
    simulator: simulator::Simulator,
    launcher: Option<&web::Launcher>,
) -> Result<(), Box<dyn Error>> {
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
    app.insert_resource(Match {
        players: (0..count).map(|_| Player::default()).collect(),
        authority_ready: false,
        compatibility: Some(compatibility),
        catalog: Some(catalog),
        selected_world,
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
    });
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
                    .players
                    .iter()
                    .filter(|player| player.entity.is_some())
                    .count();
                status.tick = game.tick;
                let mut health = game.health.lock().unwrap();
                for (slot, player) in game.players.iter().enumerate() {
                    health.unacknowledged(
                        slot,
                        player
                            .entity
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
            timeline.negotiate(Tick(100), 2),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        assert_eq!(timeline.negotiate(Tick(118), 2), PredictionStart::Waiting);
        timeline.vote(1, Tick(112), Tick(123));
        let PredictionStart::Offer(anchor) = timeline.negotiate(Tick(120), 2) else {
            panic!("Expired offer was not replaced");
        };
        assert!(timeline.anchor.is_none());
        timeline.vote(0, Tick(112), Tick(124));
        timeline.vote(1, anchor, Tick(126));
        assert_eq!(timeline.negotiate(Tick(125), 2), PredictionStart::Waiting);
        timeline.vote(0, anchor, Tick(129));
        assert_eq!(
            timeline.negotiate(Tick(127), 2),
            PredictionStart::Commit(anchor)
        );
        assert_eq!(timeline.anchor, Some(anchor));
    }

    #[test]
    fn an_unusable_peer_cannot_unbound_the_offer_window() {
        let mut timeline = AcceptedTimeline::default();
        assert_eq!(
            timeline.negotiate(Tick(100), 2),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        timeline.vote(1, Tick(112), Tick(350));
        assert_eq!(
            timeline.negotiate(Tick(106), 2),
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
        let mut player = Player::default();
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
        let mut other = Player::default();
        other.select_car(&catalog, "Orbital".into(), true).unwrap();
        assert_eq!(other.car, player.car);
    }
}
