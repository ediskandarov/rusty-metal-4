use super::{
    AcceptedTimeline, ControllerState, Match, ParticipantRoster, STEP,
    control::{Admission, accept_native_inputs, bound_reliable_history, reap_closed_links},
    tick::update,
};
use crate::{management, simulator};
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
    mode: game_protocol::MatchMode,
    limits: game_protocol::FfaLimits,
    room_members: Vec<(ControllerIdentity, management::RosterMember)>,
    addr: SocketAddr,
    simulator: simulator::Simulator,
    control: Option<&management::Control>,
) -> Result<(), Box<dyn Error>> {
    let count = participants.count();
    let capacity = participants.capacity();
    let humans = participants.human_slots().count();
    mode.validate_roster(&tm4_network::modes::PreparedRoster {
        capacity,
        humans,
        bots: count - humans,
    })?;
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
        continuation: None,
        participants,
        membership: Default::default(),
        room_requests: control.map(|control| control.membership.clone()),
        controls: (0..capacity).map(|_| ControllerState::default()).collect(),
        authority_ready: false,
        compatibility: Some(compatibility),
        catalog: Some(catalog),
        selected_world,
        mode,
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
        journal_export: control
            .map(|control| control.journal.clone())
            .unwrap_or_default(),
        prediction: AcceptedTimeline::default(),
        next_resume: 0,
        health: control
            .map(|control| control.health.clone())
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
    println!(
        "Lightyear listening on ws://{addr} for {count} participants ({} human clients)",
        app.world()
            .resource::<Match>()
            .participants
            .human_slots()
            .count()
    );
    if let Some(control) = control {
        control.listening();
    }
    let mut next_status = Instant::now();
    loop {
        if control.is_some_and(|control| control.stopped.load(std::sync::atomic::Ordering::Relaxed))
        {
            break;
        }
        app.update();
        if Instant::now() >= next_status {
            next_status = Instant::now() + Duration::from_millis(250);
            if let Some(control) = control {
                super::reporting::publish(app.world(), control);
            }
        }
        let game = app.world().resource::<Match>();
        if game.ended
            && game.participants.human_slots().next().is_none()
            && game
                .session
                .as_ref()
                .is_some_and(|session| !session.bots.is_empty())
        {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    if !app
        .world_mut()
        .resource_mut::<Match>()
        .finish_journal(crate::journal::End::Aborted)
    {
        return Err("Unable to finalize the match journal during shutdown".into());
    }
    Ok(())
}
