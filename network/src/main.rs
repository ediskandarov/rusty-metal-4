mod journal;

use std::{
    collections::{HashSet, VecDeque},
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
use lightyear::prelude::server::*;
use lightyear::prelude::*;
use lightyear::websocket::server::{ServerConfig, WebSocketServerIo};
use tm4_network::protocol as game_protocol;
use tm4_network::{
    input::{ControllerCommand, Input, InputHistory},
    protocol::{
        CHECKSUM_SEED, Catalog, Compatibility, ControllerIdentity, JOURNAL_MAX_TICKS, MAX_PLAYERS,
        Message, REPLAY_CHUNK_TICKS, REPLAY_SCHEMA, REPLAY_WINDOW_CHUNKS, Request, RoundState,
        SessionChannel, SessionStart, checksum, protocol,
    },
};

const TICK_RATE: u64 = 30;
const REPLAY_IDLE: Duration = Duration::from_secs(5);
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
    replay: Replay,
}

#[derive(Default)]
enum Replay {
    #[default]
    Available,
    Streaming {
        sent: u32,
        unconfirmed: VecDeque<u32>,
        progressed: Instant,
    },
    Spent,
    Failed,
}

impl Replay {
    fn receives_live(&self) -> bool {
        matches!(self, Self::Available | Self::Spent)
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
    recent: VecDeque<Vec<Input>>,
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
        use lightyear::prelude::input::native::{ActionState, NativeBuffer, NativeStateSequence};
        self.recent.push_back(inputs.to_vec());
        if self.recent.len() > usize::from(game_protocol::PREDICTION_DEPTH + 1) {
            self.recent.pop_front();
        }
        let end = self.anchor.unwrap() + tick as i32 + 1;
        let mut packet = game_protocol::AcceptedInputs::new(end);
        packet.rebroadcast = true;
        let start = end - (self.recent.len() - 1) as u32;
        for (slot, player) in players.iter().enumerate() {
            let Some(controller) = player.controller else {
                continue;
            };
            let mut buffer = NativeBuffer::<Input>::default();
            for (offset, inputs) in self.recent.iter().enumerate() {
                buffer.set(start + offset as i32, ActionState(inputs[slot]));
            }
            packet.inputs.push(PerTargetData {
                target: InputTarget::Entity(controller),
                states: NativeStateSequence::build_from_input_buffer(
                    &buffer,
                    self.recent.len(),
                    end,
                )
                .expect("accepted history contains a row for every slot"),
            });
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
    next_step: Instant,
    lobby_since: Option<Instant>,
    loading_since: Instant,
    overruns: u32,
    in_flight: Option<(Vec<Input>, Instant)>,
    last_step_round_trip: Option<Duration>,
    session: Option<SessionStart>,
    last_state: Option<RoundState>,
    journal_directory: PathBuf,
    journal: Option<journal::Journal>,
    journal_sealed: bool,
    replay_available: bool,
    fast_until: u32,
    prediction: Option<AcceptedTimeline>,
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

    fn pump_replay(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    ) {
        let Some(journal) = &mut self.journal else {
            return;
        };
        let head = journal.ticks();
        for player in &mut self.players {
            let Some(entity) = player.entity else {
                continue;
            };
            let Replay::Streaming {
                sent, unconfirmed, ..
            } = &mut player.replay
            else {
                continue;
            };
            if !self.replay_available {
                send(
                    links,
                    entity,
                    &Message::Error {
                        message: "Match journal reached unsupported simulation state.".into(),
                    },
                );
                player.replay = Replay::Failed;
                continue;
            }
            if unconfirmed.is_empty() && *sent == head {
                send(
                    links,
                    entity,
                    &Message::RecoveryEnd {
                        tick: head,
                        state: self.last_state.as_ref().unwrap().clone(),
                    },
                );
                player.replay = Replay::Spent;
                player.progress_tick = head;
                continue;
            }
            while unconfirmed.len() < REPLAY_WINDOW_CHUNKS && *sent < head {
                let end = (*sent + REPLAY_CHUNK_TICKS).min(head);
                let data = match journal.range(*sent, end) {
                    Ok(data) => data,
                    Err(error) => {
                        eprintln!("Reading recovery journal failed: {error}");
                        send(
                            links,
                            entity,
                            &Message::Error {
                                message: "Unable to read the match journal.".into(),
                            },
                        );
                        player.replay = Replay::Failed;
                        break;
                    }
                };
                send(
                    links,
                    entity,
                    &Message::RecoveryFrames {
                        start: *sent,
                        head,
                        checksum: checksum(CHECKSUM_SEED, &data),
                        data,
                    },
                );
                *sent = end;
                unconfirmed.push_back(end);
            }
        }
    }

    fn fail(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        message: &'static str,
    ) {
        self.ended = true;
        self.replay_available = false;
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
                recoverable,
            } if self.started && epoch == 1 => {
                if is_authority && !self.authority_ready {
                    self.authority_ready = true;
                    self.initial_digest = Some(digest);
                    self.replay_available = recoverable;
                } else if let Some(slot) = slot {
                    self.players[slot].ready = true;
                    self.players[slot].initial_digest = Some(digest);
                }
            }
            Request::PredictionClock {
                epoch: 1,
                anchor,
                tick,
            } if self.started && !self.ended && self.prediction.is_some() => {
                if let Some(slot) = slot.filter(|&slot| self.players[slot].ready) {
                    self.prediction
                        .as_mut()
                        .unwrap()
                        .vote(slot, Tick(anchor), Tick(tick));
                }
            }
            Request::Input {
                epoch,
                sequence,
                tick,
                input,
            } if self.started
                && epoch == 1
                && self
                    .prediction
                    .as_ref()
                    .is_none_or(|timeline| timeline.anchor.is_some()) =>
            {
                if let Some(player) = slot.map(|slot| &mut self.players[slot])
                    && player.replay.receives_live()
                {
                    let earliest = self.tick + u32::from(self.in_flight.is_some());
                    let result = player.history.enqueue(earliest, sequence, tick, input);
                    send(
                        links,
                        entity,
                        &Message::InputAck {
                            sequence,
                            tick: result.ok(),
                            rejected: result.err(),
                        },
                    );
                }
            }
            Request::Progress { tick } if tick <= self.tick => {
                if let Some(player) = slot.map(|slot| &mut self.players[slot])
                    && player.replay.receives_live()
                {
                    player.progress_tick = player.progress_tick.max(tick);
                }
            }
            Request::Recover { epoch: 1, tick }
                if self.started
                    && !self.ended
                    && self.prediction.is_none()
                    && tick < self.tick
                    && slot.is_some() =>
            {
                let player = &mut self.players[slot.unwrap()];
                if !self.replay_available || !matches!(player.replay, Replay::Available) {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message: "Authoritative journal recovery is unavailable.".into(),
                        },
                    );
                    return;
                }
                let journal = self
                    .journal
                    .as_ref()
                    .expect("completed ticks have a journal");
                let (used, capacity) = journal.memory_bytes();
                println!(
                    "Recovery requested at {}: {} journal ticks, cache {used} bytes / {capacity} allocated",
                    self.tick,
                    journal.ticks(),
                );
                player.history.disconnect();
                player.replay = Replay::Streaming {
                    sent: 0,
                    unconfirmed: VecDeque::with_capacity(REPLAY_WINDOW_CHUNKS),
                    progressed: Instant::now(),
                };
                send(
                    links,
                    entity,
                    &Message::RecoveryBegin {
                        schema: REPLAY_SCHEMA,
                        epoch: 1,
                        head: self.tick,
                        initial_digest: self.initial_digest.expect("stepping requires readiness"),
                    },
                );
            }
            Request::ReplayApplied { epoch: 1, tick } if slot.is_some() => {
                let player = &mut self.players[slot.unwrap()];
                if let Replay::Streaming {
                    unconfirmed,
                    progressed,
                    ..
                } = &mut player.replay
                {
                    if unconfirmed.front() == Some(&tick) {
                        unconfirmed.pop_front();
                        *progressed = Instant::now();
                    } else {
                        player.replay = Replay::Failed;
                        send(
                            links,
                            entity,
                            &Message::Error {
                                message: "Invalid match journal progress.".into(),
                            },
                        );
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
                    self.replay_available &= state.unsupported.is_none();
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
                        acknowledged: self
                            .players
                            .iter()
                            .map(|player| player.history.processed_sequence)
                            .collect(),
                    };
                    for player in &self.players {
                        if player.replay.receives_live()
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
            player.replay = Replay::Failed;
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
            .and_then(|p| match p.replay {
                Replay::Streaming { progressed, .. }
                    if now.duration_since(progressed) > REPLAY_IDLE =>
                {
                    Some("Client journal progress timed out.")
                }
                Replay::Failed => Some("Client journal recovery failed."),
                _ if p.replay.receives_live() && game.tick.saturating_sub(p.progress_tick) > 90 => {
                    Some("Client session progress timed out.")
                }
                _ => None,
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
        // Controller input enters through Lightyear's native tick/input channel.
        if !matches!(request, Request::Input { .. }) {
            game.request(&mut links, entity, request);
        }
    }
    game.pump_replay(&mut links);
    for (slot, player) in game.players.iter_mut().enumerate() {
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
        };
        if game.prediction.is_some() && start.world != "Construction Yard" {
            game.fail(
                &mut links,
                "Live rollback requires stock Construction Yard.",
            );
            return;
        }
        let message = Message::Start(start.clone());
        game.session = Some(start.clone());
        send(&mut links, authority, &message);
        if game.prediction.is_some() {
            game.broadcast(&mut links, &Message::PredictionPrepare(start));
        } else {
            game.broadcast(&mut links, &message);
        }
    }

    let now = Instant::now();
    if game
        .prediction
        .as_ref()
        .is_some_and(|timeline| timeline.anchor.is_none())
        && game.players.iter().any(|player| player.entity.is_none())
    {
        game.fail(
            &mut links,
            "A player disconnected before the match clocks were agreed.",
        );
        return;
    }
    if game.prediction.is_some() && game.authority_ready && game.tick == 0 && !game.replay_available
    {
        game.fail(
            &mut links,
            "This roster contains car behavior that live rollback cannot restore.",
        );
        return;
    }
    if !game.authority_ready || game.players.iter().any(|player| !player.ready) {
        game.next_step = now;
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
            recoverable: game.replay_available,
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
        game.next_step = Instant::now();
    }
    let players = game.players.len();
    let loading_expired = now.duration_since(game.loading_since) > Duration::from_secs(45);
    if let Some(timeline) = &mut game.prediction
        && timeline.anchor.is_none()
    {
        if loading_expired {
            game.fail(
                &mut links,
                "Players did not synchronize their match clocks.",
            );
            return;
        }
        let native_tick = native_timeline.tick();
        match timeline.negotiate(native_tick, players) {
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
    let native_lag = game
        .prediction
        .as_ref()
        .and_then(|timeline| timeline.anchor)
        .map(|anchor| native_timeline.tick() - (anchor + game.tick as i32 + 1));
    let lag = native_lag.map_or_else(
        || now.saturating_duration_since(game.next_step),
        |ticks| STEP * ticks.max(0) as u32,
    );
    let fast = native_lag.is_none() && game.tick < game.fast_until;
    if let Some((_, since)) = game.in_flight {
        if now.duration_since(since) > Duration::from_secs(3) {
            game.fail(&mut links, "The simulator did not finish its tick.");
            return;
        }
        if native_lag.is_none() || lag <= SIMULATOR_LAG_LIMIT {
            return;
        }
    }
    if !fast && lag > SIMULATOR_LAG_LIMIT {
        eprintln!(
            "Authority tick {} late by {} ms (native lag {:?}, in-flight {:?}, last step round trip {:?})",
            game.tick,
            lag.as_millis(),
            native_lag,
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
    let should_step = native_lag.map_or_else(|| fast || now >= game.next_step, |ticks| ticks >= 0);
    if should_step {
        if !fast && lag > STEP {
            game.overruns += 1;
        }
        let tick = game.tick;
        let inputs: Vec<_> = game
            .players
            .iter_mut()
            .map(|player| player.history.sample(tick))
            .collect();
        if game.prediction.is_some() {
            let game = &mut *game;
            let packet = game
                .prediction
                .as_mut()
                .unwrap()
                .packet(tick, &inputs, &game.players);
            for player in &game.players {
                if let Some(entity) = player.entity
                    && let Ok(mut sender) = accepted_senders.get_mut(entity)
                {
                    sender.send::<lightyear::prelude::input::InputChannel>(packet.clone());
                }
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
        if native_lag.is_none() {
            game.next_step = if fast {
                now + STEP
            } else {
                game.next_step + STEP
            };
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
    mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    controllers: Query<(
        &ControllerIdentity,
        &lightyear::prelude::input::native::NativeBuffer<ControllerCommand>,
    )>,
) {
    for (identity, buffer) in &controllers {
        let Some(mut tick) = buffer.start_tick else {
            continue;
        };
        let Some((last, _)) = buffer.get_last_with_tick() else {
            continue;
        };
        for _ in 0..64 {
            if tick > last {
                break;
            }
            if let Some(action) = buffer.get(tick) {
                let command = action.0;
                let player = &mut game.players[identity.slot as usize];
                if command.sequence > player.received_sequence {
                    player.received_sequence = command.sequence;
                    if let Some(owner) = player.entity {
                        game.request(
                            &mut links,
                            owner,
                            Request::Input {
                                epoch: command.epoch,
                                sequence: command.sequence,
                                tick: command.tick,
                                input: command.input,
                            },
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
    let fast_until = if cfg!(debug_assertions) {
        env::var("TM4_TEST_FAST_UNTIL")
            .ok()
            .map(|value| value.parse::<u32>())
            .transpose()?
            .unwrap_or(0)
            .min(JOURNAL_MAX_TICKS)
    } else {
        0
    };
    if fast_until != 0 {
        println!(
            "Diagnostic authority advances without wall-clock pacing through tick {fast_until}"
        );
    }
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
        next_step: Instant::now(),
        lobby_since: None,
        loading_since: Instant::now(),
        overruns: 0,
        in_flight: None,
        last_step_round_trip: None,
        session: None,
        last_state: None,
        journal_directory: env::var_os("TM4_JOURNAL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("build/network-journals")),
        journal: None,
        journal_sealed: false,
        replay_available: false,
        fast_until,
        prediction: (env::var("TM4_NATIVE_PREDICTION").as_deref() == Ok("1"))
            .then(AcceptedTimeline::default),
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
