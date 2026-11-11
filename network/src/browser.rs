//! This module owns a separate Wasm memory from Emscripten. wasm-bindgen copies
//! strings across JS/Rust; controller values are scalars. No C pointer crosses it.
use crate::input::{ControllerCommand, Input};
use crate::live_prediction::{self, LivePrediction};
use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use lightyear::prelude::client::*;
use lightyear::prelude::input::native::{ActionState, InputMarker, NativeBuffer};
use lightyear::prelude::*;
use std::collections::VecDeque;

use crate::protocol::{ControllerIdentity, Message, Request, SessionChannel, protocol};
use aeronet_io::connection::LocalAddr;
use wasm_bindgen::prelude::*;

#[derive(Resource, Default)]
struct Inbox {
    messages: VecDeque<Message>,
    overflow: bool,
}

fn receive(mut inbox: ResMut<Inbox>, mut receivers: Query<&mut MessageReceiver<Message>>) {
    for mut receiver in &mut receivers {
        for message in receiver.receive() {
            if inbox.messages.len() >= 128 {
                inbox.overflow = true;
                break;
            }
            inbox.messages.push_back(message);
        }
    }
}

fn attach_controls(
    mut commands: Commands,
    slots: Query<Entity, (With<ControllerIdentity>, Without<ActionState<Input>>)>,
    query: Query<
        Entity,
        (
            With<ControllerIdentity>,
            With<Controlled>,
            Without<InputMarker<ControllerCommand>>,
        ),
    >,
) {
    for entity in &slots {
        commands
            .entity(entity)
            .insert(NativeBuffer::<Input>::default());
    }
    for entity in &query {
        commands.entity(entity).insert((
            ActionState::<ControllerCommand>::default(),
            InputMarker::<ControllerCommand>::default(),
        ));
    }
}
#[wasm_bindgen]
pub struct NetworkClient {
    app: App,
    connection: Entity,
    prediction_ready: Option<Request>,
}

#[wasm_bindgen]
impl NetworkClient {
    #[wasm_bindgen(constructor)]
    pub fn new(endpoint: String) -> Self {
        console_error_panic_hook::set_once();
        let mut app = App::new();
        app.add_plugins((
            bevy_app::TaskPoolPlugin::default(),
            bevy_state::app::StatesPlugin,
            bevy_log::LogPlugin {
                filter: "warn".into(),
                ..Default::default()
            },
        ));
        app.add_plugins(ClientPlugins {
            tick_duration: std::time::Duration::from_secs_f64(1.0 / 30.0),
        });
        protocol(&mut app);
        live_prediction::install(&mut app);
        app.init_resource::<Inbox>();
        app.add_systems(Update, receive);
        app.add_systems(Update, attach_controls);
        let connection = app
            .world_mut()
            .spawn((
                RawClient,
                ReplicationReceiver,
                LocalAddr("127.0.0.1:0".parse().unwrap()),
                WebSocketClientIo::from_url(ClientConfig::default(), endpoint),
                Transport::new(PriorityConfig::new(128 * 1024)),
                MessageSender::<Request>::default(),
                MessageReceiver::<Message>::default(),
            ))
            .id();
        app.finish();
        app.cleanup();
        app.world_mut().trigger(LinkStart { entity: connection });
        Self {
            app,
            connection,
            prediction_ready: None,
        }
    }

    pub fn connected(&self) -> bool {
        self.app.world().get::<Connected>(self.connection).is_some()
    }

    pub fn send(&mut self, json: &str) -> Result<(), JsValue> {
        if json.len() > 8192 {
            return Err(JsValue::from_str("Message exceeds bridge limit"));
        }
        let mut value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let kind = value
            .as_object_mut()
            .and_then(|v| v.remove("type"))
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| JsValue::from_str("Missing bridge request type"))?;
        let request: Request = serde_json::from_value(serde_json::json!({kind: value}))
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        if matches!(request, Request::Ready { .. })
            && self
                .app
                .world()
                .resource::<LivePrediction>()
                .expected_slots
                .is_some()
        {
            self.prediction_ready = Some(request);
            return Ok(());
        }
        self.app
            .world_mut()
            .get_mut::<MessageSender<Request>>(self.connection)
            .ok_or_else(|| JsValue::from_str("Connection closed"))?
            .send::<SessionChannel>(request);
        Ok(())
    }

    pub fn prepare_prediction(&mut self, slots: u8) {
        live_prediction::prepare(self.app.world_mut(), slots);
    }

    pub fn prediction_clock(&self) -> u32 {
        self.app.world().resource::<LocalTimeline>().tick().0
    }

    pub fn begin_prediction(
        &mut self,
        anchor: u32,
        epoch: u32,
        players: u8,
        slot: u8,
        checkpoint_depth: u16,
    ) -> Result<(), JsValue> {
        live_prediction::begin(
            self.app.world_mut(),
            anchor,
            epoch,
            players,
            slot,
            checkpoint_depth,
        )
        .map_err(JsValue::from_str)
    }

    pub fn prediction_is_ready(&mut self) -> bool {
        live_prediction::ready(self.app.world_mut())
    }

    pub fn resume_target(&self, anchor: u32, head: u32) -> Result<u32, JsValue> {
        live_prediction::resume_target(self.app.world(), anchor, head).map_err(JsValue::from_str)
    }

    pub fn begin_resumed_prediction(
        &mut self,
        anchor: u32,
        epoch: u32,
        players: u8,
        slot: u8,
        checkpoint_depth: u16,
        head: u32,
        sequence: u32,
    ) -> Result<(), JsValue> {
        live_prediction::begin_resume(
            self.app.world_mut(),
            anchor,
            epoch,
            players,
            slot,
            checkpoint_depth,
            head,
            sequence,
        )
        .map_err(JsValue::from_str)
    }

    pub fn prediction_input(
        &mut self,
        buttons: u16,
        axes: u32,
        analog: bool,
    ) -> Result<(), JsValue> {
        self.app
            .world_mut()
            .resource_mut::<LivePrediction>()
            .sample(Input {
                buttons,
                axes,
                analog,
            })
            .map_err(JsValue::from_str)
    }

    /// Diagnostic packet delay acts before Lightyear decoding, not on C input callbacks.
    pub fn condition(&mut self, latency_ms: u32, jitter_ms: u32) -> Result<(), JsValue> {
        if latency_ms > 2000 || jitter_ms > 1000 {
            return Err(JsValue::from_str("Conditioner exceeds diagnostic bounds"));
        }
        let mut link = self
            .app
            .world_mut()
            .get_mut::<Link>(self.connection)
            .ok_or_else(|| JsValue::from_str("No link"))?;
        link.recv.conditioner = if latency_ms == 0 && jitter_ms == 0 {
            None
        } else {
            Some(lightyear::link::RecvLinkConditioner::new(
                LinkConditionerConfig::default()
                    .with_incoming_latency(std::time::Duration::from_millis(latency_ms as u64))
                    .with_incoming_jitter(std::time::Duration::from_millis(jitter_ms as u64)),
            ))
        };
        Ok(())
    }

    pub fn diagnostics(&self) -> String {
        let link = self.app.world().get::<Link>(self.connection);
        serde_json::json!({
            "rttMs": link.map(|l| l.stats.rtt.as_secs_f64() * 1000.0),
            "jitterMs": link.map(|l| l.stats.jitter.as_secs_f64() * 1000.0),
            "queuedPackets": link.map(|l| l.recv.len() + l.send.len()),
            "nativeTick": self.app.world().resource::<LocalTimeline>().tick().0,
            "prediction": self.app.world().resource::<LivePrediction>()
                .diagnostics(self.app.world().resource::<PredictionWindowWait>()),
        })
        .to_string()
    }

    pub fn update(&mut self) -> Result<String, JsValue> {
        self.app.update();
        if self.prediction_ready.is_some() && live_prediction::ready(self.app.world_mut()) {
            self.app
                .world_mut()
                .get_mut::<MessageSender<Request>>(self.connection)
                .ok_or_else(|| JsValue::from_str("Connection closed"))?
                .send::<SessionChannel>(self.prediction_ready.take().unwrap());
        }
        let mut inbox = self.app.world_mut().resource_mut::<Inbox>();
        if inbox.overflow {
            return Err(JsValue::from_str(
                "Session receive queue overflow; simulation stopped",
            ));
        }
        let messages: Vec<_> = inbox.messages.drain(..).collect();
        let messages = LivePrediction::drain_confirmed(self.app.world_mut(), messages)
            .map_err(|error| JsValue::from_str(&error))?;
        let values: Vec<_> = messages
            .into_iter()
            .map(|message| {
                let value = serde_json::to_value(message).unwrap();
                match value {
                    serde_json::Value::String(kind) => serde_json::json!({"type": kind}),
                    serde_json::Value::Object(value) => {
                        let (kind, mut fields) = value.into_iter().next().unwrap();
                        fields
                            .as_object_mut()
                            .unwrap()
                            .insert("type".into(), kind.into());
                        fields
                    }
                    _ => unreachable!(),
                }
            })
            .collect();
        Ok(serde_json::to_string(&values).unwrap())
    }
}
