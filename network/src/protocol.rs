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
pub const PROTOCOL_VERSION: u16 = 17;

pub const JOURNAL_FRAME_PREFIX: usize = 130;
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ParticipantId(pub u64);

impl std::fmt::Display for ParticipantId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

impl Serialize for ParticipantId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ParticipantId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.len() != 16
            || !text
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        {
            return Err(serde::de::Error::custom("invalid participant identity"));
        }
        let id = u64::from_str_radix(&text, 16).map_err(serde::de::Error::custom)?;
        if id == 0 {
            return Err(serde::de::Error::custom("participant identity is zero"));
        }
        Ok(Self(id))
    }
}

/// The participant ID is never reused or rebound: it also identifies this ownership lease.
/// Binding replicated on the native Lightyear controller.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ControllerIdentity {
    pub participant: ParticipantId,
    pub slot: u8,
}

/// A membership decision is applied before the accepted input row at its tick.
/// Model names must belong to the immutable startup-selected prepared pool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MembershipChange {
    Admit {
        identity: ControllerIdentity,
        car: String,
    },
    Depart {
        identity: ControllerIdentity,
    },
}

// JSON uses the shared API discriminator; Lightyear's postcard transport requires
// an externally tagged enum because it cannot deserialize self-describing maps.
#[derive(Deserialize, Serialize)]
#[serde(
    remote = "MembershipChange",
    tag = "kind",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum JsonMembershipChange {
    Admit {
        identity: ControllerIdentity,
        car: String,
    },
    Depart {
        identity: ControllerIdentity,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(remote = "MembershipChange")]
enum WireMembershipChange {
    Admit {
        identity: ControllerIdentity,
        car: String,
    },
    Depart {
        identity: ControllerIdentity,
    },
}

impl Serialize for MembershipChange {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            JsonMembershipChange::serialize(self, serializer)
        } else {
            WireMembershipChange::serialize(self, serializer)
        }
    }
}

impl<'de> Deserialize<'de> for MembershipChange {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if deserializer.is_human_readable() {
            JsonMembershipChange::deserialize(deserializer)
        } else {
            WireMembershipChange::deserialize(deserializer)
        }
    }
}

impl MembershipChange {
    pub fn identity(&self) -> ControllerIdentity {
        match self {
            Self::Admit { identity, .. } | Self::Depart { identity } => *identity,
        }
    }
    pub fn valid(&self, capacity: usize, pool: &[String]) -> bool {
        let identity = self.identity();
        identity.participant.0 != 0
            && usize::from(identity.slot) < capacity
            && match self {
                Self::Admit { car, .. } => pool.contains(car),
                Self::Depart { .. } => true,
            }
    }
}

pub fn valid_membership(changes: &[MembershipChange], capacity: usize, pool: &[String]) -> bool {
    changes.len() <= MAX_PLAYERS
        && changes.iter().enumerate().all(|(index, change)| {
            change.valid(capacity, pool)
                && !changes[..index].iter().any(|old| {
                    old.identity().slot == change.identity().slot
                        || old.identity().participant == change.identity().participant
                })
        })
}

/// Fixed-width journal membership section: count, then eight 11-byte entries.
/// Unused entries are zero. Car indices address the immutable startup roster.
pub fn encode_membership(changes: &[MembershipChange], pool: &[String], bytes: &mut [u8]) -> bool {
    if bytes.len() != 89 || !valid_membership(changes, MAX_PLAYERS, pool) {
        return false;
    }
    bytes.fill(0);
    bytes[0] = changes.len() as u8;
    for (change, entry) in changes.iter().zip(bytes[1..].chunks_exact_mut(11)) {
        let identity = change.identity();
        entry[0] = match change {
            MembershipChange::Admit { .. } => 1,
            MembershipChange::Depart { .. } => 2,
        };
        entry[1] = identity.slot;
        entry[2..10].copy_from_slice(&identity.participant.0.to_le_bytes());
        if let MembershipChange::Admit { car, .. } = change {
            entry[10] = pool.iter().position(|model| model == car).unwrap() as u8;
        }
    }
    true
}

pub fn decode_membership(
    bytes: &[u8],
    capacity: usize,
    pool: &[String],
) -> Option<Vec<MembershipChange>> {
    if bytes.len() != 89 || bytes[0] as usize > MAX_PLAYERS {
        return None;
    }
    let mut changes = Vec::with_capacity(bytes[0] as usize);
    for (index, entry) in bytes[1..].chunks_exact(11).enumerate() {
        if index >= bytes[0] as usize {
            if entry.iter().any(|byte| *byte != 0) {
                return None;
            }
            continue;
        }
        let identity = ControllerIdentity {
            slot: entry[1],
            participant: ParticipantId(u64::from_le_bytes(entry[2..10].try_into().ok()?)),
        };
        changes.push(match entry[0] {
            1 => MembershipChange::Admit {
                identity,
                car: pool.get(entry[10] as usize)?.clone(),
            },
            2 if entry[10] == 0 => MembershipChange::Depart { identity },
            _ => return None,
        });
    }
    valid_membership(&changes, capacity, pool).then_some(changes)
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
    pub frags: i32,
    pub deaths: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchCompletion {
    pub tick: u32,
    /// Bit 1: time, bit 2: frags. Both may be reached on the same completed tick.
    pub reasons: u32,
    /// Every occupied participant tied for the highest score; zero for an empty match.
    pub winners: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundState {
    pub completion: MatchCompletion,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    Ffa,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FfaLimits {
    pub time_limit_ticks: u32,
    pub frag_limit: u32,
}

impl FfaLimits {
    pub fn valid(self) -> bool {
        (1..=i32::MAX as u32).contains(&self.time_limit_ticks)
            && (1..=i32::MAX as u32).contains(&self.frag_limit)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfaDefaults {
    time_limit_ticks: u32,
    frag_limit: u32,
    respawn_delay_ticks: u32,
}

fn ffa_defaults() -> FfaDefaults {
    serde_json::from_str(include_str!("../../config/ffa.json")).expect("valid FFA defaults")
}

impl Default for FfaLimits {
    fn default() -> Self {
        let defaults = ffa_defaults();
        Self {
            time_limit_ticks: defaults.time_limit_ticks,
            frag_limit: defaults.frag_limit,
        }
    }
}

pub fn ffa_respawn_delay_ticks() -> u32 {
    ffa_defaults().respawn_delay_ticks
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionStart {
    pub mode: MatchMode,
    pub limits: FfaLimits,
    #[serde(rename = "respawnDelayTicks")]
    pub respawn_delay_ticks: u32,
    /// Width of slot-addressed input/result rows; independent of participant count.
    pub capacity: usize,
    /// Occupied gameplay slots, in the same order as the mode-selected cars.
    pub slots: Vec<u8>,
    /// Stable identities in occupied-slot order; preserved in C effects and snapshots.
    pub participants: Vec<ParticipantId>,
    pub world: String,
    pub cars: Vec<String>,
    /// Ordered immutable resource pool, independent of occupied slots.
    #[serde(rename = "modelPool")]
    pub model_pool: Vec<String>,
    pub compatibility: Compatibility,
    pub seed: u32,
    pub epoch: u32,
    pub portable: bool,
}

/// The original renderer has eight permanent car atlases. Preserve every initial
/// selection, then fill spare atlases in catalog order. The declared result, not
/// this policy or local enumeration, is consumed by peers and journal replay.
pub fn prepared_model_pool(catalog: &[String], cars: &[String]) -> Vec<String> {
    let mut pool = Vec::new();
    for car in cars.iter().chain(catalog) {
        if pool.len() == MAX_PLAYERS {
            break;
        }
        if !pool.contains(car) {
            pool.push(car.clone());
        }
    }
    pool
}

impl SessionStart {
    pub fn valid_slots(&self) -> bool {
        self.limits.valid()
            && self.capacity == MAX_PLAYERS
            && (1..=3600).contains(&self.respawn_delay_ticks)
            && (2..=self.capacity).contains(&self.slots.len())
            && self.slots.len() == self.cars.len()
            && self.participants.len() == self.slots.len()
            && self
                .participants
                .iter()
                .enumerate()
                .all(|(index, id)| id.0 != 0 && !self.participants[..index].contains(id))
            && self
                .cars
                .iter()
                .all(|car| !car.is_empty() && !car.contains(['\0', '\n']))
            && !self.model_pool.is_empty()
            && self.model_pool.len() <= MAX_PLAYERS
            && self.model_pool.iter().enumerate().all(|(i, model)| {
                !model.is_empty()
                    && model.len() < 64
                    && !model.contains(['\0', '\n'])
                    && !self.model_pool[..i].contains(model)
            })
            && self.cars.iter().all(|car| self.model_pool.contains(car))
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
    // The browser bridge represents every request payload as an object.
    Leave {},
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
    Finished {
        state: RoundState,
    },
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
    Membership {
        tick: u32,
        changes: Vec<MembershipChange>,
    },
    Frame {
        tick: u32,
        changes: Vec<MembershipChange>,
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

#[cfg(test)]
mod participant_tests {
    use super::*;

    #[test]
    fn participant_identity_is_lossless_for_browser_and_native_consumers() {
        for id in [1, (1_u64 << 53) + 1, u64::MAX] {
            let id = ParticipantId(id);
            let encoded = serde_json::to_string(&id).unwrap();
            assert_eq!(encoded, format!("\"{id}\""));
            assert_eq!(serde_json::from_str::<ParticipantId>(&encoded).unwrap(), id);
        }
        for invalid in [
            "0",
            "1",
            "\"0000000000000000\"",
            "\"FFFFFFFFFFFFFFFF\"",
            "\"0000000000000001extra\"",
        ] {
            assert!(serde_json::from_str::<ParticipantId>(invalid).is_err());
        }
    }
    #[test]
    fn membership_messages_roundtrip_through_lightyear_wire_format() {
        for change in [
            MembershipChange::Admit {
                identity: ControllerIdentity {
                    participant: ParticipantId(9),
                    slot: 7,
                },
                car: "Orbital".into(),
            },
            MembershipChange::Depart {
                identity: ControllerIdentity {
                    participant: ParticipantId(9),
                    slot: 7,
                },
            },
        ] {
            let message = Message::Membership {
                tick: 123,
                changes: vec![change],
            };
            let bytes = postcard::to_allocvec(&message).unwrap();
            let decoded: Message = postcard::from_bytes(&bytes).unwrap();
            assert_eq!(
                serde_json::to_value(&decoded).unwrap(),
                serde_json::to_value(&message).unwrap()
            );
            let json = serde_json::to_string(&message).unwrap();
            assert!(json.contains("\"kind\""));
            assert_eq!(
                serde_json::to_value(serde_json::from_str::<Message>(&json).unwrap()).unwrap(),
                serde_json::to_value(message).unwrap()
            );
        }
    }

    #[test]
    fn membership_journal_roundtrip_is_bounded_and_rejects_ambiguous_leases() {
        let pool: Vec<String> = vec!["Orbital".into(), "Crusher".into()];
        let identity = ControllerIdentity {
            participant: ParticipantId(u64::MAX),
            slot: 7,
        };
        let changes = vec![MembershipChange::Admit {
            identity,
            car: pool[1].clone(),
        }];
        let mut bytes = [0; 89];
        assert!(encode_membership(&changes, &pool, &mut bytes));
        assert_eq!(decode_membership(&bytes, 8, &pool), Some(changes.clone()));
        assert!(decode_membership(&bytes, 7, &pool).is_none());
        bytes[11] = 255;
        assert!(decode_membership(&bytes, 8, &pool).is_none());
        assert!(!valid_membership(
            &[changes[0].clone(), MembershipChange::Depart { identity }],
            8,
            &pool
        ));
        assert!(!valid_membership(
            &[MembershipChange::Admit {
                identity,
                car: "Minion".into()
            }],
            8,
            &pool
        ));
    }
}

#[cfg(test)]
mod model_pool_tests {
    use super::*;
    #[test]
    fn pool_preserves_all_startup_choices_and_fills_without_duplicate_atlases() {
        let catalog: Vec<String> = (0..22).map(|i| format!("stock{i}")).collect();
        let repeated = vec![catalog[21].clone(); 8];
        let pool = prepared_model_pool(&catalog, &repeated);
        assert_eq!(pool.len(), 8);
        assert_eq!(pool[0], catalog[21]);
        assert_eq!(&pool[1..], &catalog[..7]);
        let distinct = catalog[14..].to_vec();
        assert_eq!(prepared_model_pool(&catalog, &distinct), distinct);
    }
}

#[cfg(test)]
mod ffa_limit_tests {
    use super::*;
    #[test]
    fn defaults_and_explicit_limit_validation() {
        let defaults = FfaLimits::default();
        assert_eq!(defaults.time_limit_ticks, 900 * 30);
        assert_eq!(defaults.frag_limit, 20);
        assert!(defaults.valid());
        for limits in [
            FfaLimits {
                time_limit_ticks: 0,
                ..defaults
            },
            FfaLimits {
                frag_limit: 0,
                ..defaults
            },
            FfaLimits {
                time_limit_ticks: u32::MAX,
                ..defaults
            },
            FfaLimits {
                frag_limit: u32::MAX,
                ..defaults
            },
        ] {
            assert!(!limits.valid());
        }
        assert!(serde_json::from_str::<FfaLimits>(r#"{"timeLimitTicks":27000}"#).is_err());
        assert!(serde_json::from_str::<FfaLimits>(r#"{"fragLimit":20}"#).is_err());
    }
}
