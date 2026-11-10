use super::*;
use aeronet_io::connection::LocalAddr;
use bevy_app::{FixedPreUpdate, FixedUpdate, PreUpdate};
use bevy_time::TimeUpdateStrategy;
use lightyear::input::client::InputSystems;
use lightyear::prelude::client::*;
use lightyear::prelude::input::native::{ActionState, InputMarker, NativeBuffer};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = tm4Rollback, js_name = retain)]
    fn retain(tick: u32) -> bool;
    #[wasm_bindgen(js_namespace = tm4Rollback, js_name = restore)]
    fn restore(tick: u32) -> bool;
    #[wasm_bindgen(js_namespace = tm4Rollback, js_name = step)]
    fn step(
        tick: u32,
        local_buttons: u16,
        local_axes: u32,
        local_analog: bool,
        remote_buttons: u16,
        remote_axes: u32,
        remote_analog: bool,
        replaying: bool,
    ) -> bool;
    #[wasm_bindgen(js_namespace = tm4Rollback, js_name = finish)]
    fn finish() -> bool;
}

#[derive(Component, Clone, Debug, PartialEq)]
struct CheckpointTick(u32);

#[derive(Resource, Default)]
struct ProbeState {
    base: Option<Tick>,
    sample: Input,
    remote: Option<Entity>,
    failure: Option<&'static str>,
    restoring: bool,
    received_mismatch: bool,
    replays: u32,
}

fn write_local_input(
    state: Res<ProbeState>,
    manager: Res<PredictionManager>,
    mut local: Single<&mut ActionState<Input>, With<InputMarker<Input>>>,
) {
    if state.base.is_some() && !manager.is_rollback() {
        local.0 = state.sample;
    }
}

fn step_world(
    mut state: ResMut<ProbeState>,
    timeline: SyncedLocalTimeline,
    manager: Res<PredictionManager>,
    mut checkpoint: Single<&mut CheckpointTick, With<DeterministicPredicted>>,
    local: Single<&ActionState<Input>, With<InputMarker<Input>>>,
    remotes: Query<&ActionState<Input>, With<ProbeSlot>>,
) {
    let (Some(base), Some(remote_entity), None) = (state.base, state.remote, state.failure) else {
        return;
    };
    let Ok(remote) = remotes.get(remote_entity) else {
        state.failure = Some("Remote input slot disappeared");
        return;
    };
    let tick = checkpoint.0;
    if timeline.tick() != base + tick as i32 + 1 {
        state.failure = Some("C checkpoint tick disagrees with Lightyear's fixed tick");
        return;
    }
    let Input {
        buttons,
        axes,
        analog,
    } = local.0;
    if !step(
        tick,
        buttons,
        axes,
        analog,
        remote.0.buttons,
        remote.0.axes,
        remote.0.analog,
        manager.is_rollback(),
    ) || !retain(tick + 1)
    {
        state.failure = Some("C step or checkpoint capture refused");
        return;
    }
    checkpoint.0 = tick + 1;
    if manager.is_rollback() {
        state.replays += 1;
    }
}

fn observe_native_mismatch(mut state: ResMut<ProbeState>, manager: Res<PredictionManager>) {
    state.received_mismatch =
        state.base.is_some() && manager.earliest_mismatch_input.has_mismatches();
}

fn refuse_unhandled_mismatch(mut state: ResMut<ProbeState>, manager: Res<PredictionManager>) {
    if state.received_mismatch && !manager.is_rollback() {
        state.failure = Some("Lightyear rejected the input correction outside rollback history");
    }
}

fn restore_world(
    mut state: ResMut<ProbeState>,
    manager: Res<PredictionManager>,
    checkpoint: Single<&CheckpointTick, With<DeterministicPredicted>>,
) {
    let (Some(base), Some(rollback_tick), None) =
        (state.base, manager.get_rollback_start_tick(), state.failure)
    else {
        return;
    };
    if base + checkpoint.0 as i32 != rollback_tick || !restore(checkpoint.0) {
        state.failure = Some("C checkpoint refused Lightyear's restored history tick");
        return;
    }
    state.restoring = true;
}

fn finish_rollback(mut state: ResMut<ProbeState>) {
    if std::mem::take(&mut state.restoring) && state.failure.is_none() && !finish() {
        state.failure = Some("C replay finish refused");
    }
}

#[wasm_bindgen]
pub struct RollbackProbe {
    app: App,
    link: Entity,
    checkpoint: Option<Entity>,
}

#[wasm_bindgen]
impl RollbackProbe {
    #[wasm_bindgen(constructor)]
    pub fn new(endpoint: String) -> Self {
        console_error_panic_hook::set_once();
        let mut app = App::new();
        app.add_plugins((
            bevy_app::TaskPoolPlugin::default(),
            bevy_state::app::StatesPlugin,
        ));
        app.add_plugins(ClientPlugins {
            tick_duration: STEP,
        });
        probe_protocol(&mut app);
        app.insert_resource(InputTimelineConfig::new(
            SyncConfig {
                // The test controls frame delivery after initial sync.
                error_margin: 2048.0,
                max_error_margin: 2048.0,
                speedup_factor: 1.0,
                ..Default::default()
            },
            InputDelayConfig::no_input_delay(),
        ));
        app.insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
        app.init_resource::<ProbeState>();
        app.init_resource::<PredictionManager>();
        app.world_mut()
            .resource_mut::<PredictionManager>()
            .rollback_policy = RollbackPolicy {
            state: RollbackMode::Disabled,
            input: RollbackMode::Check,
            max_rollback_ticks: ROLLBACK_DEPTH,
        };
        app.component::<CheckpointTick>().local_rollback();
        app.add_systems(
            FixedPreUpdate,
            write_local_input.in_set(InputSystems::WriteClientInputs),
        );
        app.add_systems(FixedUpdate, step_world);
        app.add_systems(
            PreUpdate,
            (
                observe_native_mismatch
                    .after(InputSystems::ReceiveInputMessages)
                    .before(RollbackSystems::Check),
                refuse_unhandled_mismatch
                    .after(RollbackSystems::Check)
                    .before(RollbackSystems::Prepare),
                restore_world
                    .after(RollbackSystems::Prepare)
                    .before(RollbackSystems::Rollback),
                finish_rollback.in_set(RollbackSystems::EndRollback),
            ),
        );
        let link = app
            .world_mut()
            .spawn((
                RawClient,
                ReplicationReceiver,
                LocalAddr("127.0.0.1:0".parse().unwrap()),
                WebSocketClientIo::from_url(ClientConfig::default(), endpoint),
                Transport::new(PriorityConfig::new(32 * 1024)),
                MessageSender::<ProbeInput>::default(),
            ))
            .id();
        app.finish();
        app.cleanup();
        app.world_mut().trigger(LinkStart { entity: link });
        Self {
            app,
            link,
            checkpoint: None,
        }
    }

    pub fn ready(&mut self) -> bool {
        let world = self.app.world_mut();
        if world.get::<Connected>(self.link).is_none()
            || !world.resource::<LocalTimelineSync>().is_synced()
        {
            return false;
        }
        world
            .query_filtered::<Entity, With<ProbeSlot>>()
            .iter(world)
            .count()
            == 1
    }

    pub fn arm(&mut self, c_depth: u16) -> Result<u32, JsValue> {
        if self.checkpoint.is_some() || c_depth != ROLLBACK_DEPTH || !self.ready() || !retain(0) {
            return Err(JsValue::from_str(
                "Rollback probe could not retain the initial C world",
            ));
        }
        let world = self.app.world_mut();
        let base = world.resource::<LocalTimeline>().tick();
        let remote = world
            .query_filtered::<Entity, With<ProbeSlot>>()
            .single(world)
            .unwrap();
        world.entity_mut(remote).insert((
            ActionState::<Input>::default(),
            NativeBuffer::<Input>::default(),
        ));
        world.spawn((
            ActionState::<Input>::default(),
            InputMarker::<Input>::default(),
        ));
        let mut history = PredictionHistory::default();
        history.add_predicted(base, Some(CheckpointTick(0)));
        self.checkpoint = Some(
            world
                .spawn((
                    DeterministicPredicted::default(),
                    CheckpointTick(0),
                    history,
                ))
                .id(),
        );
        let mut state = world.resource_mut::<ProbeState>();
        state.base = Some(base);
        state.remote = Some(remote);
        world
            .resource_mut::<PredictionManager>()
            .input_rollback_floor = Some(base);
        Ok(base.0)
    }

    pub fn pump(
        &mut self,
        advance: bool,
        buttons: u16,
        axes: u32,
        analog: bool,
    ) -> Result<(), JsValue> {
        let world = self.app.world_mut();
        if let Some(failure) = world.resource::<ProbeState>().failure {
            return Err(JsValue::from_str(failure));
        }
        world.resource_mut::<ProbeState>().sample = Input {
            buttons,
            axes,
            analog,
        };
        *world.resource_mut::<TimeUpdateStrategy>() =
            TimeUpdateStrategy::ManualDuration(if advance { STEP } else { Duration::ZERO });
        self.app.update();
        let world = self.app.world();
        if let Some(failure) = world.resource::<ProbeState>().failure {
            return Err(JsValue::from_str(failure));
        }
        if self.checkpoint.is_some() && world.get::<Connected>(self.link).is_none() {
            return Err(JsValue::from_str("Rollback probe connection closed"));
        }
        Ok(())
    }

    pub fn send_remote(&mut self, end_tick: u32, buttons: Vec<u16>) -> Result<(), JsValue> {
        if self.checkpoint.is_none()
            || buttons.is_empty()
            || buttons.len() > usize::from(ROLLBACK_DEPTH + 1)
        {
            return Err(JsValue::from_str("Invalid delayed input window"));
        }
        self.app
            .world_mut()
            .get_mut::<MessageSender<ProbeInput>>(self.link)
            .ok_or_else(|| JsValue::from_str("Probe connection closed"))?
            .send::<ProbeChannel>(ProbeInput {
                end_tick,
                controls: buttons
                    .into_iter()
                    .map(|buttons| Input {
                        buttons,
                        ..Default::default()
                    })
                    .collect(),
            });
        Ok(())
    }

    pub fn confirmed(&self) -> Option<u32> {
        let world = self.app.world();
        let remote = world.resource::<ProbeState>().remote?;
        world
            .get::<NativeBuffer<Input>>(remote)?
            .last_remote_tick
            .map(|tick| tick.0)
    }

    pub fn replayed(&self) -> u32 {
        self.app.world().resource::<ProbeState>().replays
    }

    pub fn close(&mut self) {
        self.app.world_mut().trigger(Unlink {
            entity: self.link,
            reason: UnlinkReason::UserRequested(None),
        });
    }
}
