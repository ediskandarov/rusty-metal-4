use crate::input::{ControllerCommand, Input};
use bevy_app::App;
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use serde::{Deserialize, Serialize};
pub struct SessionChannel;

pub type AcceptedInputs = lightyear::input::input_message::InputMessage<
    lightyear::prelude::input::native::NativeStateSequence<Input>,
>;
pub const PREDICTION_DEPTH: u16 = 12;

pub const SNAPSHOT_CHUNK_BYTES: usize = 8192;
pub const SNAPSHOT_MAX_BYTES: usize = 256 * 1024;
pub const SNAPSHOT_MAX_CATCHUP: u32 = 240;
pub const JOURNAL_DISK_BYTES: usize = 1024 * 1024 * 1024;
pub const JOURNAL_MAX_TICKS: u32 =
    ((JOURNAL_DISK_BYTES - 8192) / (journal_frame_bytes(MAX_PLAYERS) + 5)) as u32;
pub const REPLAY_CHUNK_TICKS: u32 = 64;
pub const MAX_PLAYERS: usize = 8;
pub const PROTOCOL_VERSION: u16 = 12;

pub const JOURNAL_FRAME_PREFIX: usize = 29;
pub const JOURNAL_INPUT_BYTES: usize = 7;

pub const fn journal_frame_bytes(capacity: usize) -> usize {
    JOURNAL_FRAME_PREFIX + JOURNAL_INPUT_BYTES * capacity
}

pub fn checksum(seed: u32, bytes: &[u8]) -> u32 {
    bytes.iter().fold(seed, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(16_777_619)
    })
}

pub const CHECKSUM_SEED: u32 = 2_166_136_261;

/// Match-local participant identity, independent of connection and gameplay slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ParticipantId(pub u64);

/// The participant ID is never reused or rebound: it also identifies this ownership lease.
/// Binding replicated on the native Lightyear controller.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ControllerIdentity {
    pub participant: ParticipantId,
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
    #[cfg(all(feature = "client", target_family = "wasm"))]
    app.add_plugins(lightyear::prelude::input::native::InputPlugin::<Input> {
        config: lightyear::prelude::input::InputConfig {
            rebroadcast_inputs: true,
            // The client consumes this stream but only the match server may send it.
            send_interval: std::time::Duration::MAX,
            ..Default::default()
        },
    });
    #[cfg(not(all(feature = "client", target_family = "wasm")))]
    app.register_message::<AcceptedInputs>()
        .add_map_entities()
        .add_direction(NetworkDirection::ServerToClient);
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
pub struct LobbyPlayer {
    pub slot: usize,
    pub connected: bool,
    pub car: Option<String>,
    pub ready: bool,
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
    pub sections: [u32; 5],
    pub unsupported: Option<String>,
    pub scores: Vec<Score>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionStart {
    /// Width of slot-addressed input/result rows; independent of participant count.
    pub capacity: usize,
    /// Occupied gameplay slots, in the same order as the mode-selected cars.
    pub slots: Vec<u8>,
    pub world: String,
    pub cars: Vec<String>,
    pub compatibility: Compatibility,
    pub seed: u32,
    pub epoch: u32,
    #[serde(default)]
    pub portable: bool,
}

impl SessionStart {
    pub fn valid_slots(&self) -> bool {
        (2..=MAX_PLAYERS).contains(&self.capacity)
            && (2..=self.capacity).contains(&self.slots.len())
            && self.slots.len() == self.cars.len()
            && self
                .cars
                .iter()
                .all(|car| !car.is_empty() && !car.contains(['\0', '\n']))
            && !self.world.is_empty()
            && !self.world.contains('\0')
            && self.slots.windows(2).all(|pair| pair[0] < pair[1])
            && self
                .slots
                .iter()
                .all(|slot| usize::from(*slot) < self.capacity)
    }
    pub fn slot_mask(&self) -> u8 {
        self.slots.iter().fold(0, |mask, slot| mask | (1 << slot))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Request {
    Join {
        compatibility: Compatibility,
    },
    Resume {
        token: String,
        compatibility: Compatibility,
    },
    SnapshotReceived {
        attempt: u32,
        offset: u32,
    },
    ResumeClock {
        attempt: u32,
        target: u32,
    },
    ResumeLiveAck {
        attempt: u32,
        head: u32,
    },
    Ready {
        epoch: u32,
        digest: u32,
        unsupported: Option<String>,
    },
    Progress {
        tick: u32,
    },
    CatchupApplied {
        attempt: u32,
        tick: u32,
    },
    SelectCar {
        car: String,
        ready: bool,
    },
    PredictionClock {
        epoch: u32,
        anchor: u32,
        tick: u32,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Message {
    Welcome {
        slot: usize,
    },
    ResumeCredential {
        token: String,
    },
    ResumePrepare(SessionStart),
    SnapshotBegin {
        attempt: u32,
        tick: u32,
        anchor: u32,
        total: u32,
        checksum: u32,
        state: RoundState,
    },
    SnapshotChunk {
        attempt: u32,
        offset: u32,
        data: Vec<u8>,
    },
    ResumeCatchup {
        attempt: u32,
        start: u32,
        head: u32,
        digest: u32,
    },
    ResumeLive {
        attempt: u32,
        anchor: u32,
        head: u32,
        sequence: u32,
    },
    PredictionPrepare(SessionStart),
    PredictionBegin {
        anchor: u32,
    },
    ResumeActive {
        head: u32,
    },
    Frame {
        tick: u32,
        inputs: Vec<Input>,
        state: RoundState,
    },
    CatchupFrames {
        attempt: u32,
        start: u32,
        head: u32,
        data: Vec<u8>,
        checksum: u32,
    },
    Error {
        message: String,
    },
    Lobby {
        cars: Vec<String>,
        players: Vec<LobbyPlayer>,
    },
    PredictionOffer {
        anchor: u32,
    },
    ResumePending,
}
