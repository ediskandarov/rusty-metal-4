use super::{
    AcceptedTimeline, ControllerState, MIN_PARTICIPANTS, Match, ParticipantRoster, STEP,
    control::{Admission, accept_native_inputs, bound_reliable_history, reap_closed_links},
    tick::update,
};
use crate::{simulator, web};
use aeronet_io::connection::LocalAddr;
use bevy_app::{App, PostUpdate, PreUpdate, Update};
use bevy_ecs::prelude::*;
use lightyear::prelude::server::*;
use lightyear::prelude::*;
use lightyear::websocket::server::{ServerConfig, WebSocketServerIo};
use std::{
    collections::HashSet,
    env,
    error::Error,
    net::SocketAddr,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
use tm4_network::{
    input::ControllerCommand,
    protocol as game_protocol,
    protocol::{ControllerIdentity, Message, Request, protocol},
};

pub(crate) fn run_match(
    participants: ParticipantRoster,
    selected_world: Option<String>,
    limits: game_protocol::FfaLimits,
    room_members: Vec<(ControllerIdentity, web::RosterMember)>,
    addr: SocketAddr,
    simulator: simulator::Simulator,
    launcher: Option<&web::Launcher>,
) -> Result<(), Box<dyn Error>> {
    let count = participants.count();
    let capacity = participants.capacity();
    if !(MIN_PARTICIPANTS..=capacity).contains(&count) {
        return Err("FFA needs at least two prepared participants".into());
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
        membership: Default::default(),
        room_requests: launcher.map(|launcher| launcher.membership.clone()),
        controls: (0..capacity).map(|_| ControllerState::default()).collect(),
        authority_ready: false,
        compatibility: Some(compatibility),
        catalog: Some(catalog),
        selected_world,
        limits,
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
                if let Some(session) = &game.session {
                    status.cars = session.model_pool.clone();
                }
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
                        .is_some_and(|state| state.completion.reasons != 0 || state.next_mode != 0)
                    {
                        let mut result = launcher.results.lock().unwrap();
                        if result.is_none() {
                            *result = game.final_result(
                                status
                                    .session_id
                                    .as_deref()
                                    .expect("a started match has an identity"),
                            );
                        }
                        status.phase = "results".into();
                        status.message =
                            "Match finished. Restart the server to prepare the next match.".into();
                    } else {
                        status.phase = "closed".into();
                        status.message =
                            "Match stopped. Restart the server to prepare a new match.".into();
                    }
                } else if game.started && game.tick > 0 {
                    status.phase = "match".into();
                    status.message = "Live admission uses the prepared model pool; existing participants can reconnect.".into();
                }
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}
