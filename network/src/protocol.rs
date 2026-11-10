use crate::input::{ControllerCommand, Input, Rejection};
use bevy_app::App;
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use serde::{Deserialize, Serialize};
pub struct SessionChannel;

#[derive(Component, Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ControllerIdentity {
    pub slot: u8,
}

pub fn protocol(app: &mut App) {
    app.add_channel::<SessionChannel>(ChannelSettings {
        mode: ChannelMode::OrderedReliable(ReliableSettings::default()),
        priority: 10.0,
        ..Default::default()
    })
    .add_direction(NetworkDirection::Bidirectional);
    app.component::<ControllerIdentity>().replicate();
    app.register_message::<Request>()
        .add_direction(NetworkDirection::ClientToServer);
    app.register_message::<Message>()
        .add_direction(NetworkDirection::ServerToClient);
    app.add_plugins(lightyear::prelude::input::native::InputPlugin::<
        ControllerCommand,
    >::default());
    app.insert_resource(ReplicationMetadata::new(
        std::time::Duration::from_secs_f64(1.0 / 30.0),
    ));
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Compatibility {
    pub protocol: u16,
    pub build: String,
    pub content: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Catalog {
    pub worlds: Vec<String>,
    pub cars: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Score {
    pub wins: i32,
    pub losses: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundState {
    pub remaining: u8,
    pub winner: i8,
    pub round_finished: bool,
    pub accepts_continue: bool,
    pub next_mode: i32,
    pub digest: u32,
    pub scores: Vec<Score>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Request {
    Join {
        compatibility: Compatibility,
    },
    Authority {
        token: String,
        compatibility: Compatibility,
        catalog: Catalog,
    },
    Ready {
        epoch: u32,
        digest: u32,
    },
    Input {
        epoch: u32,
        sequence: u32,
        tick: u32,
        input: Input,
    },
    Progress {
        tick: u32,
    },
    Completed {
        tick: u32,
        state: RoundState,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Message {
    Welcome {
        slot: Option<usize>,
    },
    Start {
        players: usize,
        world: String,
        cars: Vec<String>,
        compatibility: Compatibility,
        seed: u32,
        epoch: u32,
    },
    Step {
        tick: u32,
        inputs: Vec<Input>,
    },
    Frame {
        tick: u32,
        inputs: Vec<Input>,
        state: RoundState,
        acknowledged: Vec<Option<u32>>,
    },
    InputAck {
        sequence: u32,
        tick: Option<u32>,
        rejected: Option<Rejection>,
    },
    Finished,
    Error {
        message: String,
    },
}
