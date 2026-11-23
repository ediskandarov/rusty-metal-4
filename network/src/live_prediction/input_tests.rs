use super::*;
use bevy_time::TimeUpdateStrategy;
use lightyear::prelude::client::ClientPlugins;

const STEP: std::time::Duration = std::time::Duration::from_nanos(33_333_333);

#[derive(Resource, Default)]
struct Samples(Vec<(Tick, ControllerCommand)>);

fn fixture(delay: u16) -> (App, Entity, Tick) {
    let mut app = App::new();
    app.add_plugins((
        bevy_app::TaskPoolPlugin::default(),
        bevy_state::app::StatesPlugin,
    ));
    app.add_plugins(ClientPlugins {
        tick_duration: STEP,
    });
    crate::protocol::protocol(&mut app);
    app.insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
    app.init_resource::<Samples>();
    app.init_resource::<LivePrediction>();
    app.add_systems(
        FixedPreUpdate,
        write_local.in_set(InputSystems::WriteClientInputs),
    );
    app.add_systems(
        FixedUpdate,
        |timeline: Res<LocalTimeline>,
         local: Single<&ActionState<ControllerCommand>, With<InputMarker<ControllerCommand>>>,
         mut samples: ResMut<Samples>| {
            samples.0.push((timeline.tick(), local.0));
        },
    );
    app.finish();
    app.cleanup();
    app.update();
    let link = app.world_mut().spawn_empty().id();
    app.world_mut().resource_mut::<NetworkingMetadata>().mode = NetworkTopology::Client(link);
    app.update();
    set_delay(&mut app, delay);
    app.world_mut()
        .resource_mut::<LocalTimelineSync>()
        .set_synced(true);
    let anchor = app.world().resource::<LocalTimeline>().tick();
    let command = ControllerCommand {
        epoch: 7,
        input: Input::default(),
    };
    let mut buffer = NativeBuffer::default();
    buffer.set(anchor, ActionState(command));
    let local = app
        .world_mut()
        .spawn((
            InputMarker::<ControllerCommand>::default(),
            ActionState(command),
            buffer,
        ))
        .id();
    app.insert_resource(LivePrediction {
        session: Some(Session {
            epoch: 7,
            capacity: 8,
            mask: 1,
            local_slot: 0,
            anchor,
        }),
        ..Default::default()
    });
    (app, local, anchor)
}

fn set_delay(app: &mut App, delay: u16) {
    app.insert_resource(InputTimelineConfig::new(
        SyncConfig::default(),
        InputDelayConfig {
            minimum_input_delay_ticks: delay,
            maximum_input_delay_before_prediction: delay,
            maximum_predicted_ticks: PREDICTION_DEPTH,
        },
    ));
}

#[test]
fn native_pipeline_assigns_delayed_taps_without_a_command_writer() {
    for delay in [0, 3, 22] {
        let (mut app, local, anchor) = fixture(delay);
        let gas = Input {
            buttons: 0x40,
            ..Default::default()
        };
        app.world_mut()
            .resource_mut::<LivePrediction>()
            .sample(gas)
            .unwrap();
        app.world_mut()
            .resource_mut::<LivePrediction>()
            .sample(Input::default())
            .unwrap();
        for _ in 0..delay + 4 {
            app.update();
        }
        let samples = &app.world().resource::<Samples>().0;
        assert_eq!(samples.len(), usize::from(delay + 4));
        for (index, (tick, command)) in samples.iter().enumerate() {
            assert_eq!(*tick, anchor + index as i32 + 1);
            assert_eq!(
                command.input.buttons,
                if index == usize::from(delay) { 0x40 } else { 0 },
                "delay {delay}, sample {index}"
            );
        }
        let buffer = app
            .world()
            .get::<NativeBuffer<ControllerCommand>>(local)
            .unwrap();
        assert_eq!(
            buffer.get(anchor + i32::from(delay) + 1).unwrap().0.input,
            gas
        );
        assert!(app.world().resource::<LivePrediction>().edges.is_empty());
    }
}

#[test]
fn native_pipeline_handles_multiple_fixed_steps_and_delay_changes() {
    let (mut app, local, _) = fixture(3);
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .sample(Input {
            buttons: 0x40,
            ..Default::default()
        })
        .unwrap();
    app.insert_resource(TimeUpdateStrategy::ManualDuration(STEP * 3));
    app.update();
    assert_eq!(app.world().resource::<Samples>().0.len(), 3);
    set_delay(&mut app, 0);
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .sample(Input::default())
        .unwrap();
    app.update();
    let samples = &app.world().resource::<Samples>().0;
    assert_eq!(samples.len(), 6);
    assert!(
        samples[3..]
            .iter()
            .all(|(_, command)| command.input == Input::default())
    );
    // Standard native semantics: a newer sample may replace a queued future
    // sample when delay shrinks. We do not secretly move that sample elsewhere.
    let buffer = app
        .world()
        .get::<NativeBuffer<ControllerCommand>>(local)
        .unwrap();
    for (tick, command) in &samples[3..] {
        assert_eq!(buffer.get(*tick).unwrap().0, *command);
    }
}

#[test]
fn native_prestart_buffering_keeps_the_battle_epoch_and_does_not_consume_taps() {
    let (mut app, local, now) = fixture(22);
    let anchor = now + 5;
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .session
        .as_mut()
        .unwrap()
        .anchor = anchor;
    let mut buffer = NativeBuffer::default();
    buffer.set(
        anchor,
        ActionState(ControllerCommand {
            epoch: 7,
            input: Input::default(),
        }),
    );
    app.world_mut().entity_mut(local).insert(buffer);
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .sample(Input {
            buttons: 0x40,
            ..Default::default()
        })
        .unwrap();
    for offset in 1..=30 {
        app.update();
        if offset > 5 {
            let buffer = app
                .world()
                .get::<NativeBuffer<ControllerCommand>>(local)
                .unwrap();
            let input = buffer.get(now + offset).unwrap().0;
            assert_eq!(input.epoch, 7);
            assert_eq!(input.input.buttons, if offset <= 27 { 0 } else { 0x40 });
        }
    }
}

#[test]
fn fresh_link_statistics_recompute_native_delay_without_retiming_history() {
    use bevy_ecs::system::RunSystemOnce;
    let (mut app, local, _) = fixture(0);
    let NetworkTopology::Client(link) = app.world().resource::<NetworkingMetadata>().mode else {
        panic!("client fixture");
    };
    app.world_mut().entity_mut(link).insert((
        Link::default(),
        RemoteId(PeerId::Netcode(1)),
        Connected,
    ));
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .expected_slot_mask = Some(1);
    app.world_mut().get_mut::<Link>(link).unwrap().stats.rtt = std::time::Duration::from_secs(2);
    let tick = app.world().resource::<LocalTimeline>().tick();
    let start = app
        .world()
        .get::<NativeBuffer<ControllerCommand>>(local)
        .unwrap()
        .start_tick;
    app.world_mut()
        .run_system_once(refresh_input_delay)
        .unwrap();
    assert!(app.world().resource::<LocalTimelineSync>().input_delay() > 0);
    app.world_mut().get_mut::<Link>(link).unwrap().stats.rtt =
        std::time::Duration::from_millis(250);
    app.world_mut()
        .run_system_once(refresh_input_delay)
        .unwrap();
    assert_eq!(app.world().resource::<LocalTimelineSync>().input_delay(), 0);
    assert_eq!(app.world().resource::<LocalTimeline>().tick(), tick);
    assert_eq!(
        app.world()
            .get::<NativeBuffer<ControllerCommand>>(local)
            .unwrap()
            .start_tick,
        start
    );
}

#[test]
fn excessive_native_delay_does_not_consume_pending_input() {
    let (mut app, _, _) = fixture(40);
    let gas = Input {
        buttons: 0x40,
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<LivePrediction>()
        .sample(gas)
        .unwrap();
    app.update();
    let state = app.world().resource::<LivePrediction>();
    assert!(
        matches!(&state.error, Some(PredictionFailure::Fatal(message))
        if message == "Input delay exceeds the retained command history")
    );
    assert_eq!(state.edges.front(), Some(&gas));
}
