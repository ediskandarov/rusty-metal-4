use super::{
    MIN_PARTICIPANTS, Match, STEP,
    control::{Admission, bind_controllers, receive_requests, send},
    prediction::PredictionStart,
};
use crate::{journal, simulator};
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use std::time::{Duration, Instant};
use tm4_network::{
    input::Input,
    protocol::{
        self as game_protocol, JOURNAL_MAX_TICKS, MembershipChange, Message, Request, SessionStart,
    },
};
const SIMULATOR_LAG_LIMIT: Duration = Duration::from_millis(250);

pub(super) fn update(
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
    let room_requests: Vec<_> = game
        .room_requests
        .as_ref()
        .map(|requests| requests.lock().unwrap().try_iter().collect())
        .unwrap_or_default();
    for request in room_requests {
        game.room_membership(request, &mut links, &mut commands);
    }
    let requests = receive_requests(
        &mut game,
        &mut links,
        &mut receivers,
        &link_states,
        &mut commands,
    );
    for (entity, request) in requests {
        game.request(&mut links, entity, request);
    }
    game.maintain_membership(&mut links, &mut commands);
    game.pump_resume(&mut links, &mut simulator);
    bind_controllers(&mut game, &owners, &mut commands);

    if !prepare_session(&mut game, &mut links, &mut simulator) {
        return;
    }
    let now = Instant::now();
    let native_tick = native_timeline.tick();
    if !synchronize_clock(&mut game, &mut links, native_tick, now) {
        return;
    }
    advance_simulation(
        &mut game,
        &mut links,
        &mut simulator,
        &mut accepted_senders,
        &mut commands,
        native_tick,
        now,
    );
}

fn prepare_session(
    game: &mut Match,
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    simulator: &mut simulator::Simulator,
) -> bool {
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
                    links,
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
        return false;
    }
    if !game.started {
        if game.controls.iter().enumerate().any(|(slot, player)| {
            game.participants.contains(slot) && player.compatibility != game.compatibility
        }) {
            game.fail(
                links,
                "Gameplay build or local resources do not match the authority.",
            );
            return false;
        }
        if let Err(error) = simulator.prepare_catalog() {
            eprintln!("Diagnostic setup failed: {error:#}");
            game.fail(links, "Diagnostic match configuration rejected.");
            return false;
        }
        game.catalog = Some(simulator.catalog.clone());
        game.participants.freeze();
        game.started = true;
        game.loading_since = Instant::now();
        let cars: Vec<String> = game
            .participants
            .slots()
            .map(|slot| game.participants.at_slot(slot).car.clone().unwrap())
            .collect();
        let model_pool =
            tm4_network::protocol::prepared_model_pool(&game.catalog.as_ref().unwrap().cars, &cars);
        let start = SessionStart {
            mode: tm4_network::protocol::MatchMode::Ffa,
            respawn_delay_ticks: tm4_network::protocol::FFA_RESPAWN_DELAY_TICKS,
            capacity: game.controls.len(),
            slots: game.participants.slots().map(|slot| slot as u8).collect(),
            participants: game
                .participants
                .slots()
                .map(|slot| game.participants.binding(slot).participant)
                .collect(),
            world: game
                .selected_world
                .clone()
                .unwrap_or_else(|| game.catalog.as_ref().unwrap().worlds[0].clone()),
            cars,
            model_pool,
            compatibility: game.compatibility.clone().unwrap(),
            seed: 12345,
            epoch: 1,
            portable: (2..=8).contains(&game.participants.count()),
        };
        game.session = Some(start.clone());
        match simulator.start(&start) {
            Ok((state, portable)) => {
                game.simulator_ready(links, state.digest, state.unsupported, portable)
            }
            Err(error) => {
                eprintln!("Embedded simulator setup failed: {error:#}");
                game.fail(links, "The embedded simulator could not start this match.");
                return false;
            }
        }
        if game.ended {
            return false;
        }
        let prepared = game
            .session
            .clone()
            .expect("simulation has an authoritative startup");
        game.broadcast(links, &Message::PredictionPrepare(prepared));
    }

    true
}

fn synchronize_clock(
    game: &mut Match,
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    native_tick: Tick,
    now: Instant,
) -> bool {
    if game.prediction.anchor.is_none()
        && game
            .controls
            .iter()
            .enumerate()
            .any(|(slot, player)| game.participants.contains(slot) && player.connection.is_none())
    {
        game.fail(
            links,
            "A player disconnected before the match clocks were agreed.",
        );
        return false;
    }
    // Tick-zero readiness belongs to initial clock negotiation. Live members
    // prepare through a current snapshot and must never restart this quorum.
    if !game.authority_ready
        || (game.prediction.anchor.is_none()
            && game
                .participants
                .slots()
                .any(|slot| !game.controls[slot].ready))
    {
        if now.duration_since(game.loading_since) > Duration::from_secs(45) {
            game.fail(links, "Session loading exceeded 45 seconds.");
        }
        return false;
    }
    if game.tick == 0
        && game.controls.iter().enumerate().any(|(slot, p)| {
            game.participants.contains(slot) && p.initial_digest != game.initial_digest
        })
    {
        game.fail(
            links,
            "Initial simulation summaries disagree before tick zero.",
        );
        return false;
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
                game.fail(links, "The match journal could not be opened.");
                return false;
            }
        }
    }
    let slots: Vec<_> = game.participants.slots().collect();
    let loading_expired = now.duration_since(game.loading_since) > Duration::from_secs(45);
    if game.prediction.anchor.is_none() {
        if loading_expired {
            game.fail(links, "Players did not synchronize their match clocks.");
            return false;
        }
        match game.prediction.negotiate(native_tick, &slots) {
            PredictionStart::Offer(anchor) => {
                game.broadcast(links, &Message::PredictionOffer { anchor: anchor.0 });
                return false;
            }
            PredictionStart::Waiting => return false,
            PredictionStart::Commit(anchor) => {
                game.broadcast(links, &Message::PredictionBegin { anchor: anchor.0 });
            }
            PredictionStart::Unavailable => {
                game.fail(
                    links,
                    "The players could not agree on a safe match start tick.",
                );
                return false;
            }
        }
    }
    true
}

fn advance_simulation(
    game: &mut Match,
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    simulator: &mut simulator::Simulator,
    accepted_senders: &mut Query<
        &mut MessageSender<game_protocol::AcceptedInputs>,
        With<Connected>,
    >,
    commands: &mut Commands,
    native_tick: Tick,
    now: Instant,
) {
    if game.tick >= JOURNAL_MAX_TICKS {
        game.fail(links, "The match reached its journal disk budget.");
        return;
    }
    let due = game.prediction.anchor.unwrap() + game.tick as i32 + 1;
    let lag_ticks = native_tick - due;
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
            links,
            "Simulator overrun: more than 250 ms behind the 30 Hz schedule.",
        );
        return;
    }
    if lag_ticks >= 0 {
        let step_started = Instant::now();
        let scheduled = *game.tick_schedule.get_or_insert(step_started);
        let lateness = step_started.saturating_duration_since(scheduled);
        let tick = game.tick;
        let proposed = game.membership.scheduled.remove(&tick).unwrap_or_default();
        let mut changes = Vec::with_capacity(proposed.len());
        for change in &proposed {
            let identity = change.identity();
            match simulator.membership(tick, change) {
                Ok(true) => {
                    match change {
                        MembershipChange::Admit { .. } => {
                            game.participants
                                .commit_live(identity)
                                .expect("admission owns its reservation");
                            game.membership.pending.remove(&identity.participant);
                        }
                        MembershipChange::Depart { .. } => game.retire_live(identity, commands),
                    }
                    changes.push(change.clone());
                }
                Ok(false) if matches!(change, MembershipChange::Admit { .. }) => {
                    if let Some(connection) = game.controls[usize::from(identity.slot)].connection {
                        send(links, connection, &Message::Error { message: "The selected car could not be prepared; the admission was cancelled.".into() });
                    }
                    game.retire_live(identity, commands);
                }
                result => {
                    eprintln!("Membership event rejected: {change:?}: {result:?}");
                    game.fail(
                        links,
                        "The authoritative membership event could not be applied.",
                    );
                    return;
                }
            }
        }
        if changes != proposed {
            // A failed preparation is not a committed event. Replace the forecast
            // before confirming this row; replay records only actual mutations.
            game.broadcast(
                links,
                &Message::Membership {
                    tick,
                    changes: changes.clone(),
                },
            );
        }
        let occupied: Vec<_> = game.participants.slots().collect();
        let inputs: Vec<_> = game
            .controls
            .iter_mut()
            .enumerate()
            .map(|(slot, player)| {
                if occupied.contains(&slot) {
                    player.history.sample(tick)
                } else {
                    Input::default()
                }
            })
            .collect();
        let packet = game
            .prediction
            .packet(tick, &inputs, &game.controls, &occupied);
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
                game.completed(links, tick, inputs, changes, state, now);
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
                game.fail(links, "The embedded simulator did not finish its tick.");
            }
        }
    }
}
