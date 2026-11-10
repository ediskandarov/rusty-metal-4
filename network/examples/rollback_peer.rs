//! Loopback fixture that sends a controlled stream of native Lightyear remote inputs.
use aeronet_io::connection::LocalAddr;
use bevy_app::{App, ScheduleRunnerPlugin, Update};
use bevy_ecs::prelude::*;
use lightyear::input::input_message::{
    ActionStateSequence, InputMessage, InputTarget, PerTargetData,
};
use lightyear::prelude::input::InputChannel;
use lightyear::prelude::input::native::{ActionState, NativeBuffer, NativeStateSequence};
use lightyear::prelude::server::*;
use lightyear::prelude::*;
use std::time::Duration;
use tm4_network::input::Input;
use tm4_network::rollback_probe::*;

type RemoteInput = InputMessage<NativeStateSequence<Input>>;

fn deliver(
    remote: Single<Entity, With<ProbeSlot>>,
    mut links: Query<
        (
            &mut MessageReceiver<ProbeInput>,
            &mut MessageSender<RemoteInput>,
        ),
        With<Connected>,
    >,
) {
    for (mut inbox, mut output) in &mut links {
        for request in inbox.receive().take(16) {
            let count = request.controls.len();
            if count == 0 || count > usize::from(ROLLBACK_DEPTH + 1) {
                continue;
            }
            let end = Tick(request.end_tick);
            let mut buffer = NativeBuffer::<Input>::default();
            let start = end - (count - 1) as u32;
            for (index, input) in request.controls.into_iter().enumerate() {
                buffer.set(start + index as i32, ActionState(input));
            }
            let mut message = RemoteInput::new(end);
            message.rebroadcast = true;
            message.inputs.push(PerTargetData {
                target: InputTarget::Entity(*remote),
                states: NativeStateSequence::build_from_input_buffer(&buffer, count, end).unwrap(),
            });
            output.send::<InputChannel>(message);
        }
    }
}

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .unwrap_or("19326".into())
        .parse()
        .unwrap();
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut app = App::new();
    app.add_plugins((
        bevy_app::TaskPoolPlugin::default(),
        bevy_state::app::StatesPlugin,
        ScheduleRunnerPlugin::run_loop(Duration::from_millis(2)),
    ));
    app.add_plugins(ServerPlugins {
        tick_duration: STEP,
    });
    probe_protocol(&mut app);
    app.add_observer(|event: On<Add, LinkOf>, mut commands: Commands| {
        commands.entity(event.entity).insert((
            ReplicationSender,
            Transport::new(PriorityConfig::new(32 * 1024)),
            MessageReceiver::<ProbeInput>::default(),
            MessageSender::<RemoteInput>::default(),
        ));
    });
    app.world_mut()
        .spawn((ProbeSlot, Replicate::to_clients(NetworkTarget::All)));
    app.add_systems(Update, deliver);
    let server = app
        .world_mut()
        .spawn((
            RawServer,
            LocalAddr(addr),
            WebSocketServerIo {
                config: ServerConfig::builder()
                    .with_bind_address(addr)
                    .with_no_encryption(),
            },
        ))
        .id();
    app.world_mut().trigger(LinkStart { entity: server });
    println!("Rollback probe peer listening on {addr}");
    app.run();
}
