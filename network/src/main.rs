mod journal;
mod resume;

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
        CHECKSUM_SEED, Catalog, Compatibility, ControllerIdentity, JOURNAL_MAX_TICKS, MAX_PLAYERS,
        Message, REPLAY_CHUNK_TICKS, Request, RoundState, SessionChannel, SessionStart, checksum,
        protocol,
    },
};

const TICK_RATE: u64 = 30;
const STEP: Duration = Duration::from_nanos(1_000_000_000 / TICK_RATE);
const SIMULATOR_LAG_LIMIT: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Player {
    entity: Option<Entity>,
    ready: bool,
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
    token: String,
    authority: Option<Entity>,
    authority_ready: bool,
    compatibility: Option<Compatibility>,
    catalog: Option<Catalog>,
    initial_digest: Option<u32>,
    started: bool,
    ended: bool,
    tick: u32,
    lobby_since: Option<Instant>,
    loading_since: Instant,
    in_flight: Option<(Vec<Input>, Instant)>,
    last_step_round_trip: Option<Duration>,
    session: Option<SessionStart>,
    last_state: Option<RoundState>,
    journal_directory: PathBuf,
    journal: Option<journal::Journal>,
    journal_sealed: bool,
    prediction: AcceptedTimeline,
    next_resume: u32,
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
    ) {
        if self.ended {
            return;
        }
        let Some(anchor) = self.prediction.anchor else {
            return;
        };
        let Some(authority) = self.authority else {
            return;
        };
        for player in &mut self.players {
            let (Some(entity), Some(attempt)) = (player.entity, player.resume.as_mut()) else {
                continue;
            };
            if attempt.failed {
                continue;
            }
            if attempt.requested.is_none()
                && self.in_flight.is_none()
                && self.tick >= attempt.retry_at
            {
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
                    send(
                        links,
                        authority,
                        &Message::SnapshotRequest {
                            attempt: attempt.id,
                            tick: self.tick,
                        },
                    );
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
            if self.tick.saturating_sub(target) > u32::from(game_protocol::PREDICTION_DEPTH) {
                attempt.failed = true;
                send(
                    links,
                    entity,
                    &Message::Error {
                        message: "The reconnect handoff expired. Retry this match.".into(),
                    },
                );
                continue;
            }
            if attempt.sent_frames < target {
                let end = (attempt.sent_frames + REPLAY_CHUNK_TICKS)
                    .min(target)
                    .min(self.tick);
                if end <= attempt.sent_frames {
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
        self.finish_journal(journal::End::Aborted);
        let error = Message::Error {
            message: message.into(),
        };
        self.broadcast(links, &error);
        if let Some(authority) = self.authority {
            send(links, authority, &error);
        }
        eprintln!("{message}");
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
        let is_authority = self.authority == Some(entity);
        match request {
            Request::Join { compatibility }
                if !self.started && !self.ended && slot.is_none() && !is_authority =>
            {
                if let Some(slot) = self
                    .players
                    .iter()
                    .position(|player| player.entity.is_none())
                {
                    self.players[slot].entity = Some(entity);
                    self.players[slot].compatibility = Some(compatibility);
                    send(links, entity, &Message::Welcome { slot: Some(slot) });
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
            } if !is_authority && slot.is_none() => {
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
                    self.next_resume = self.next_resume.wrapping_add(1);
                    let player = &mut self.players[slot];
                    player.entity = Some(entity);
                    player.history.disconnect();
                    player.resume = Some(resume::Attempt::new(self.next_resume));
                    player.reassign_controller = true;
                    send(links, entity, &Message::Welcome { slot: Some(slot) });
                    send(links, entity, &Message::ResumePrepare(session.clone()));
                } else {
                    send(links, entity, &Message::Error {
                        message: "This participant cannot resume this match. If its previous connection is still closing, retry in a moment.".into(),
                    });
                }
            }
            Request::SnapshotUpload {
                attempt: id,
                tick,
                total,
                offset,
                checksum,
                data,
            } if is_authority => {
                if let Some(attempt) = self
                    .players
                    .iter_mut()
                    .filter_map(|player| player.resume.as_mut())
                    .find(|attempt| attempt.id == id && !attempt.failed)
                    && let Some(snapshot) = attempt.requested.as_mut()
                {
                    if snapshot.tick != tick
                        || snapshot.ready()
                        || !snapshot.upload(total as usize, offset as usize, checksum, data)
                    {
                        attempt.failed = true;
                    } else {
                        attempt.progress = Instant::now();
                    }
                }
            }
            Request::SnapshotUnavailable { attempt: id } if is_authority => {
                if let Some(attempt) = self
                    .players
                    .iter_mut()
                    .filter_map(|player| player.resume.as_mut())
                    .find(|attempt| attempt.id == id && !attempt.failed && !attempt.announced)
                {
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
                    && attempt.target.is_none()
                    && let Some(snapshot) = attempt
                        .requested
                        .as_ref()
                        .filter(|snapshot| snapshot.ready())
                {
                    if snapshot.acknowledged != snapshot.total
                        || target < snapshot.tick
                        || target - snapshot.tick > game_protocol::SNAPSHOT_MAX_CATCHUP
                        || target > self.tick + 60
                        || self.tick.saturating_sub(target) > 12
                    {
                        attempt.failed = true;
                    } else {
                        attempt.target = Some(target);
                        attempt.sent_frames = snapshot.tick;
                        attempt.progress = Instant::now();
                        send(
                            links,
                            entity,
                            &Message::ResumeCatchup {
                                attempt: id,
                                start: snapshot.tick,
                                head: target,
                                digest: snapshot.state.digest,
                            },
                        );
                    }
                }
            }
            Request::ResumeLiveAck { attempt: id, head } if slot.is_some() => {
                let player = &mut self.players[slot.unwrap()];
                if let Some(attempt) = &player.resume
                    && attempt.id == id
                    && attempt.offered
                    && attempt.target == Some(head)
                    && attempt.pending_frame.is_none()
                    && !attempt.failed
                {
                    let attempt = player.resume.take().unwrap();
                    player.progress_tick = head;
                    send(links, entity, &Message::ResumeActive { head });
                    for frame in attempt.frames {
                        send(links, entity, &frame);
                    }
                }
            }
            Request::Authority {
                token,
                compatibility,
                catalog,
            } if !self.started
                && self.authority.is_none()
                && slot.is_none()
                && token == self.token =>
            {
                if catalog.cars.len() < self.players.len()
                    || catalog.worlds.is_empty()
                    || catalog.cars.len() > 64
                    || catalog.worlds.len() > 64
                {
                    self.authority = Some(entity);
                    self.fail(
                        links,
                        "The authority catalog cannot supply this map and roster.",
                    );
                    return;
                }
                self.authority = Some(entity);
                self.compatibility = Some(compatibility);
                self.catalog = Some(catalog);
                send(links, entity, &Message::Welcome { slot: None });
            }
            Request::Ready {
                epoch,
                digest,
                unsupported,
                portable,
            } if self.started && !self.ended && epoch == 1 => {
                if is_authority && !self.authority_ready {
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
                                if let (Some(entity), Some(token)) =
                                    (player.entity, player.credential.clone())
                                {
                                    send(links, entity, &Message::ResumeCredential { token });
                                }
                            }
                        }
                    }
                } else if let Some(slot) = slot {
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
            Request::Completed { tick, state }
                if is_authority
                    && tick == self.tick
                    && state.scores.len() == self.players.len() =>
            {
                if let Some((inputs, dispatched)) = self.in_flight.take() {
                    self.last_step_round_trip = Some(dispatched.elapsed());
                    let result = self
                        .journal
                        .as_mut()
                        .expect("stepping requires a journal")
                        .append(tick, &inputs, &state);
                    if let Err(error) = result {
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
                                if attempt.frames.len()
                                    == usize::from(game_protocol::PREDICTION_DEPTH)
                                {
                                    attempt.failed = true;
                                } else {
                                    attempt.frames.push_back(message.clone());
                                }
                            }
                        } else if player.receives_live()
                            && let Some(entity) = player.entity
                        {
                            send(links, entity, &message);
                        }
                    }
                    self.last_state = Some(state);
                    if self.ended {
                        send(links, entity, &Message::Finished);
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
    mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    mut receivers: Query<(Entity, &mut MessageReceiver<Request>, &mut Admission)>,
    mut commands: Commands,
) {
    let started = game.started;
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
            }
        }
    }
    if game.authority.is_some_and(|entity| !links.contains(entity)) {
        game.authority = None;
        if game.started && !game.ended {
            game.fail(&mut links, "The simulator disconnected.");
        }
    }

    let mut requests = Vec::new();
    let now = Instant::now();
    for (entity, mut receiver, mut admission) in &mut receivers {
        if now.duration_since(admission.window) >= Duration::from_secs(1) {
            admission.window = now;
            admission.messages = 0;
        }
        let known =
            game.authority == Some(entity) || game.players.iter().any(|p| p.entity == Some(entity));
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
        if let Some(reason) =
            stalled.or(unidentified.then_some("Unidentified connection timed out."))
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
    game.pump_resume(&mut links);
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
    let Some(authority) = game.authority else {
        return;
    };
    if game.ended || (!game.started && game.players.iter().any(|player| player.entity.is_none())) {
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
        game.started = true;
        game.loading_since = Instant::now();
        let start = SessionStart {
            players: game.players.len(),
            world: game.catalog.as_ref().unwrap().worlds[0].clone(),
            cars: game.catalog.as_ref().unwrap().cars[..game.players.len()].to_vec(),
            compatibility: game.compatibility.clone().unwrap(),
            seed: 12345,
            epoch: 1,
            portable: game.players.len() == 2,
        };
        game.session = Some(start.clone());
        send(&mut links, authority, &Message::Start(start.clone()));
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
            Ok(journal) => {
                println!("Match journal: {}", journal.path.display());
                game.journal = Some(journal);
            }
            Err(error) => {
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
    if let Some((_, since)) = game.in_flight {
        if now.duration_since(since) > Duration::from_secs(3) {
            game.fail(&mut links, "The simulator did not finish its tick.");
            return;
        }
        if lag <= SIMULATOR_LAG_LIMIT {
            return;
        }
    }
    if lag > SIMULATOR_LAG_LIMIT {
        eprintln!(
            "Authority tick {} late by {} ms ({} Lightyear ticks, in-flight {:?}, last step round trip {:?})",
            game.tick,
            lag.as_millis(),
            lag_ticks,
            game.in_flight
                .as_ref()
                .map(|(_, since)| now.duration_since(*since)),
            game.last_step_round_trip,
        );
        game.fail(
            &mut links,
            "Simulator overrun: more than 250 ms behind the 30 Hz schedule.",
        );
        return;
    }
    if lag_ticks >= 0 {
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
        send(
            &mut links,
            authority,
            &Message::Step {
                tick: game.tick,
                inputs: inputs.clone(),
            },
        );
        game.in_flight = Some((inputs, now));
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
    let earliest = game.tick + u32::from(game.in_flight.is_some());
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
                        let _ = player.history.enqueue(
                            earliest,
                            command.sequence,
                            command.tick,
                            command.input,
                        );
                    }
                }
            }
            tick += 1;
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let first = args.next().unwrap_or_else(|| "2".into());
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
    let token = env::var("TM4_AUTHORITY_TOKEN")?;
    if token.len() < 32 {
        return Err("TM4_AUTHORITY_TOKEN must have at least 32 characters".into());
    }
    let addr: SocketAddr = env::var("TM4_MATCH_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8122".into())
        .parse()?;

    if !addr.ip().is_loopback() {
        return Err("This diagnostic server requires a loopback address; public admission/TLS is not implemented".into());
    }
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
    app.add_observer(
        |event: On<Add, LinkOf>, mut commands: Commands, links: Query<Entity, With<LinkOf>>| {
            if links.iter().count() > MAX_PLAYERS + 5 {
                commands.trigger(Unlink {
                    entity: event.entity,
                    reason: UnlinkReason::UserRequested(Some("Connection capacity reached".into())),
                });
                return;
            }
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
        },
    );
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
        token,
        authority: None,
        authority_ready: false,
        compatibility: None,
        catalog: None,
        initial_digest: None,
        started: false,
        ended: false,
        tick: 0,
        lobby_since: None,
        loading_since: Instant::now(),
        in_flight: None,
        last_step_round_trip: None,
        session: None,
        last_state: None,
        journal_directory: env::var_os("TM4_JOURNAL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("build/network-journals")),
        journal: None,
        journal_sealed: false,
        prediction: AcceptedTimeline::default(),
        next_resume: 0,
    });
    app.add_systems(Update, update);
    app.add_systems(
        PostUpdate,
        bound_reliable_history.after(lightyear::transport::plugin::TransportSystems::Send),
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
    loop {
        app.update();
        thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(test)]
mod prediction_start_tests {
    use super::*;

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
