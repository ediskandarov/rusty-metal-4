//! An isolated two-slot protocol for exercising native input prediction against the C world.
use crate::input::Input;
use bevy_app::App;
use bevy_ecs::prelude::*;
use lightyear::prelude::input::InputConfig;
use lightyear::prelude::input::native::InputPlugin;
use lightyear::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const STEP: Duration = Duration::from_nanos(33_333_333);
pub use crate::protocol::PREDICTION_DEPTH as ROLLBACK_DEPTH;

#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProbeSlot;

pub struct ProbeChannel;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProbeInput {
    pub end_tick: u32,
    pub controls: Vec<Input>,
}

pub fn probe_protocol(app: &mut App) {
    app.add_plugins(InputPlugin::<Input> {
        config: InputConfig {
            rebroadcast_inputs: true,
            ..Default::default()
        },
    });
    app.add_channel::<ProbeChannel>(ChannelSettings {
        mode: ChannelMode::OrderedReliable(ReliableSettings::default()),
        ..Default::default()
    })
    .add_direction(NetworkDirection::ClientToServer);
    app.register_message::<ProbeInput>()
        .add_direction(NetworkDirection::ClientToServer);
    app.component::<ProbeSlot>().replicate();
    app.insert_resource(ReplicationMetadata::new(STEP));
}

#[cfg(all(feature = "client", target_family = "wasm"))]
mod browser;
