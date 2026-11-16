//! Commands and shared state between HTTP management and the game thread.
mod start;
mod state;
use serde::{Deserialize, Serialize};
pub use start::{StartError, StartOptions};
pub use state::{MatchOutcome, MatchUpdate, Status};
pub(crate) use state::{Phase, PublishedState, SharedState};
use std::sync::{Arc, Mutex, atomic::AtomicBool, mpsc::Receiver};
use tm4_network::protocol::Compatibility;

#[derive(Debug, PartialEq)]
pub enum SetupRequest {
    Prepare,
    Start(MatchSetup),
}
#[derive(Debug, PartialEq)]
pub struct MatchSetup {
    pub mode: tm4_network::protocol::MatchMode,
    pub bots: Vec<String>,
    pub roster: Vec<RosterMember>,
    pub limits: tm4_network::protocol::FfaLimits,
    pub players: usize,
    pub world: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RosterMember {
    pub credential: String,
    pub car: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoomMembership {
    Admit {
        credential: String,
        car: String,
    },
    Depart {
        credential: String,
    },
    #[serde(skip)]
    Inspect {
        credential: String,
    },
}
#[derive(Serialize)]
pub struct MembershipReply {
    pub identity: Option<tm4_network::protocol::ControllerIdentity>,
    pub tick: Option<u32>,
    pub pending: bool,
}
pub struct MembershipCommand {
    pub change: RoomMembership,
    pub response: tokio::sync::oneshot::Sender<std::result::Result<MembershipReply, &'static str>>,
}
pub type MembershipQueue = Arc<Mutex<Receiver<MembershipCommand>>>;

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct ServerLocation {
    region: Option<String>,
    country: Option<String>,
    location: Option<String>,
}
impl ServerLocation {
    pub fn from_environment(mut lookup: impl FnMut(&str) -> Option<String>) -> Option<Self> {
        let mut value = |name| {
            lookup(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let location = Self {
            region: value("CLOUDFLARE_REGION"),
            country: value("CLOUDFLARE_COUNTRY_A2"),
            location: value("CLOUDFLARE_LOCATION"),
        };
        (location.region.is_some() || location.country.is_some() || location.location.is_some())
            .then_some(location)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub session_id: String,
    pub completion: tm4_network::protocol::MatchCompletion,
    pub participants: Vec<ResultParticipant>,
}
#[derive(Clone, Serialize)]
pub struct ResultParticipant {
    pub identity: tm4_network::protocol::ControllerIdentity,
    pub credential: Option<String>,
    pub score: tm4_network::protocol::Score,
}

#[derive(Clone)]
pub struct Control {
    pub stopped: Arc<AtomicBool>,
    pub state: SharedState,
    pub health: crate::health::Shared,
    pub journal: crate::journal::SharedExport,
    pub membership: MembershipQueue,
}

impl Control {
    pub fn ready(&self, worlds: Vec<String>, cars: Vec<String>, compatibility: Compatibility) {
        self.state
            .lock()
            .unwrap()
            .resources_ready(worlds, cars, compatibility);
    }
    pub fn preparation_failed(&self, message: &str) {
        self.state.lock().unwrap().preparation_failed(message);
    }
    pub fn listening(&self) {
        self.state.lock().unwrap().listening();
    }
    pub fn close(&self, message: &str) {
        self.state.lock().unwrap().close(message);
    }
    pub fn session_id(&self) -> Option<String> {
        self.state.lock().unwrap().status.session_id.clone()
    }
    pub fn publish_match(&self, update: MatchUpdate) {
        self.state.lock().unwrap().publish_match(update);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_location_uses_container_environment() {
        let location = ServerLocation::from_environment(|name| match name {
            "CLOUDFLARE_REGION" => Some("WEUR".into()),
            "CLOUDFLARE_COUNTRY_A2" => Some("DE".into()),
            "CLOUDFLARE_LOCATION" => Some("FRA".into()),
            _ => panic!("unexpected environment variable"),
        });
        assert_eq!(
            serde_json::to_value(location).unwrap(),
            serde_json::json!({
                "region": "WEUR", "country": "DE", "location": "FRA"
            })
        );
        assert_eq!(ServerLocation::from_environment(|_| None), None);
        assert_eq!(
            ServerLocation::from_environment(|_| Some("  ".into())),
            None
        );
        let partial = ServerLocation::from_environment(|name| {
            (name == "CLOUDFLARE_REGION").then(|| " WEUR ".into())
        })
        .unwrap();
        assert_eq!(partial.region.as_deref(), Some("WEUR"));
        assert_eq!(partial.country, None);
        assert_eq!(partial.location, None);
    }
}
