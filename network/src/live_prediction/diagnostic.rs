//! Diagnostic-only driver for the production prediction systems and the real C bridge.
//! Supplies deterministic native input buffers; membership corrections still use the
//! normal plan replacement and Lightyear forced-rollback schedules.
use super::*;
use bevy_time::TimeUpdateStrategy;
use lightyear::prelude::client::ClientPlugins;

#[wasm_bindgen]
pub struct MembershipPredictionFixture {
    app: App,
    anchor: Tick,
}

#[wasm_bindgen]
impl MembershipPredictionFixture {
    #[wasm_bindgen(constructor)]
    pub fn new(start: &str) -> Result<MembershipPredictionFixture, JsValue> {
        let start: crate::protocol::SessionStart =
            serde_json::from_str(start).map_err(|error| JsValue::from_str(&error.to_string()))?;
        if !start.valid_slots() {
            return Err(JsValue::from_str("Invalid prediction fixture startup"));
        }
        let mut app = App::new();
        app.add_plugins((
            bevy_app::TaskPoolPlugin::default(),
            bevy_state::app::StatesPlugin,
        ));
        app.add_plugins(ClientPlugins {
            tick_duration: std::time::Duration::from_nanos(33_333_333),
        });
        crate::protocol::protocol(&mut app);
        install(&mut app);
        app.insert_resource(TimeUpdateStrategy::ManualDuration(
            std::time::Duration::from_nanos(33_333_333),
        ));
        app.finish();
        app.cleanup();
        // Initialize topology/time before declaring this in-process fixture synchronized.
        app.update();
        let client = app.world_mut().spawn_empty().id();
        app.world_mut().resource_mut::<NetworkingMetadata>().mode = NetworkTopology::Client(client);
        app.update();
        let world = app.world_mut();
        world.resource_mut::<LocalTimelineSync>().set_synced(true);
        // The fixture owns delivery, not a second gameplay clock or a C-state model.
        world.resource_mut::<LocalTimeline>().apply_delta(10);
        let anchor = world.resource::<LocalTimeline>().tick();
        let mask = start.slot_mask();
        prepare(
            world,
            mask,
            start.participants.clone(),
            start.model_pool,
            false,
        );
        for (&slot, participant) in start.slots.iter().zip(start.participants) {
            let entity = world
                .spawn((
                    ControllerIdentity { slot, participant },
                    ActionState::<Input>::default(),
                    NativeBuffer::<Input>::default(),
                ))
                .id();
            if slot == start.slots[0] {
                world.entity_mut(entity).insert((
                    InputMarker::<ControllerCommand>::default(),
                    ActionState::<ControllerCommand>::default(),
                    NativeBuffer::<ControllerCommand>::default(),
                ));
            }
        }
        start_at(
            world,
            Session {
                epoch: start.epoch,
                capacity: start.capacity as u8,
                mask,
                local_slot: start.slots[0],
                anchor,
            },
            PREDICTION_DEPTH,
            0,
            0,
        )
        .map_err(JsValue::from_str)?;
        Ok(Self { app, anchor })
    }

    pub fn controller(&mut self, slot: u8, participant: &str) -> Result<(), JsValue> {
        let participant = serde_json::from_str::<ParticipantId>(&format!("\"{participant}\""))
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        self.app.world_mut().spawn((
            ControllerIdentity { slot, participant },
            ActionState::<Input>::default(),
            NativeBuffer::<Input>::default(),
        ));
        Ok(())
    }

    pub fn plan(&mut self, tick: u32, changes: &str) -> Result<(), JsValue> {
        let changes =
            serde_json::from_str(changes).map_err(|error| JsValue::from_str(&error.to_string()))?;
        LivePrediction::drain_confirmed(
            self.app.world_mut(),
            vec![Message::Membership { tick, changes }],
        )
        .map_err(|error| JsValue::from_str(&format!("{error:?}")))?;
        Ok(())
    }

    pub fn pump(&mut self) -> Result<u32, JsValue> {
        let world = self.app.world_mut();
        let end = world.resource::<LocalTimeline>().tick() + 32;
        for mut buffer in world.query::<&mut NativeBuffer<Input>>().iter_mut(world) {
            let first = buffer.last_remote_tick.map_or(self.anchor, |tick| tick + 1);
            for offset in 0..=(end - first).max(0) {
                buffer.set(first + offset, ActionState(Input::default()));
            }
            buffer.last_remote_tick = Some(end);
        }
        self.app.update();
        let state = self.app.world().resource::<LivePrediction>();
        if let Some(error) = &state.error {
            return Err(JsValue::from_str(&format!("{error:?}")));
        }
        Ok(state.head)
    }

    pub fn diagnostics(&self) -> String {
        let world = self.app.world();
        let mut result = world
            .resource::<LivePrediction>()
            .diagnostics(world.resource::<PredictionWindowWait>());
        result["nativeTick"] = serde_json::json!(world.resource::<LocalTimeline>().tick().0);
        result["synced"] = serde_json::json!(world.resource::<LocalTimelineSync>().is_synced());
        result["seconds"] = serde_json::json!(world.resource::<Time<Virtual>>().elapsed_secs());
        result.to_string()
    }
}
