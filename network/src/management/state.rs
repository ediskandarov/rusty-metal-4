use super::{MatchResult, MatchSetup, ServerLocation, StartError, StartOptions};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tm4_network::protocol::Compatibility;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    Setup,
    Loading,
    Ready,
    Starting,
    Lobby,
    Match,
    Results,
    Failed,
    Closed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Starting => "starting",
            Self::Lobby => "lobby",
            Self::Match => "match",
            Self::Results => "results",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }

    pub fn permits_upload(self) -> bool {
        matches!(self, Self::Setup | Self::Failed)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub location: Option<ServerLocation>,
    pub session_id: Option<String>,
    pub cars: Vec<String>,
    pub compatibility: Option<Compatibility>,
    pub(crate) phase: Phase,
    pub message: String,
    pub players: usize,
    pub worlds: Vec<String>,
    pub world: Option<String>,
    pub connected: usize,
    pub tick: u32,
    pub endpoint: String,
    pub uploaded: usize,
    pub required: usize,
}

pub struct MatchUpdate {
    pub connected: usize,
    pub tick: u32,
    pub cars: Option<Vec<String>>,
    pub outcome: MatchOutcome,
}

pub enum MatchOutcome {
    Waiting,
    Playing(&'static str),
    Finished {
        message: &'static str,
        result: MatchResult,
    },
    Stopped(&'static str),
}

pub(crate) type SharedState = Arc<Mutex<PublishedState>>;

pub(crate) struct PublishedState {
    pub status: Status,
    pub result: Option<MatchResult>,
}

impl PublishedState {
    pub fn new(status: Status) -> Self {
        Self {
            status,
            result: None,
        }
    }

    fn transition(&mut self, phase: Phase, message: impl Into<String>) {
        self.status.phase = phase;
        self.status.message = message.into();
    }

    pub fn begin_prepare(&mut self) -> Result<(), &'static str> {
        if !self.status.phase.permits_upload() {
            return Err("Setup is locked for this match. Restart the server for a new match.");
        }
        if self.status.uploaded != self.status.required {
            return Err("Upload all server resources before preparing");
        }
        self.transition(
            Phase::Loading,
            "Validating resources and preparing the native simulator…",
        );
        Ok(())
    }

    pub fn resources_ready(
        &mut self,
        worlds: Vec<String>,
        cars: Vec<String>,
        compatibility: Compatibility,
    ) {
        if self.status.phase != Phase::Loading {
            return;
        }
        self.status.cars = cars;
        self.status.compatibility = Some(compatibility);
        self.status.world = worlds.first().cloned();
        self.status.worlds = worlds;
        self.transition(
            Phase::Ready,
            "Resources ready. Choose a map and player count, then open the match.",
        );
    }

    pub fn preparation_failed(&mut self, message: &str) {
        if self.status.phase == Phase::Loading {
            self.transition(Phase::Failed, message);
        }
    }

    pub fn ensure_startable(&self) -> Result<(), StartError> {
        if self.status.phase != Phase::Ready {
            return Err(StartError::NotReady);
        }
        Ok(())
    }

    pub fn start(&mut self, options: StartOptions) -> Result<MatchSetup, StartError> {
        self.ensure_startable()?;
        let validated = options.validate(&self.status)?;
        self.status.session_id = validated.session_id;
        self.status.players = validated.setup.players;
        self.status.world = Some(validated.setup.world.clone());
        self.transition(Phase::Starting, "Opening match…");
        Ok(validated.setup)
    }

    pub fn listening(&mut self) {
        if self.status.phase == Phase::Starting {
            self.transition(
                Phase::Lobby,
                "Match ready. Players can open the player and select their own local disc.",
            );
        }
    }

    pub fn close(&mut self, message: &str) {
        if self.status.phase != Phase::Closed {
            self.transition(Phase::Closed, message);
        }
    }

    pub fn publish_match(&mut self, update: MatchUpdate) {
        if !matches!(
            self.status.phase,
            Phase::Lobby | Phase::Match | Phase::Results
        ) {
            return;
        }
        self.status.connected = update.connected;
        self.status.tick = update.tick;
        if let Some(cars) = update.cars {
            self.status.cars = cars;
        }
        if self.status.phase == Phase::Results {
            return;
        }
        match update.outcome {
            MatchOutcome::Waiting => (),
            MatchOutcome::Playing(message) => self.transition(Phase::Match, message),
            MatchOutcome::Finished { message, result } => {
                self.result = Some(result);
                self.transition(Phase::Results, message);
            }
            MatchOutcome::Stopped(message) => self.close(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tm4_network::protocol::MatchCompletion;

    fn state() -> PublishedState {
        PublishedState::new(Status {
            location: None,
            session_id: None,
            cars: vec![],
            compatibility: None,
            phase: Phase::Setup,
            message: String::new(),
            players: 2,
            worlds: vec![],
            world: None,
            connected: 0,
            tick: 0,
            endpoint: "ws://localhost:8122".into(),
            uploaded: 0,
            required: 2,
        })
    }

    fn start_request() -> serde_json::Value {
        serde_json::json!({
            "mode": "ffa", "players": 2, "world": "Construction Yard",
            "limits": {"timeLimitTicks": 27000, "fragLimit": 20},
            "sessionId": "00000000-0000-4000-8000-000000000000",
            "roster": [{"credential": "a".repeat(64), "car": "Orbital"}]
        })
    }

    fn start_options(players: usize, world: &str) -> StartOptions {
        let mut request = start_request();
        request["players"] = players.into();
        request["world"] = world.into();
        serde_json::from_value(request).unwrap()
    }

    #[test]
    fn invalid_start_options_never_mutate_prepared_state() {
        let mut state = state();
        state.status.uploaded = state.status.required;
        state.begin_prepare().unwrap();
        resources_ready(&mut state);
        let before = serde_json::to_value(&state.status).unwrap();
        let request = start_request();
        for changes in [
            serde_json::json!({"players": 0}),
            serde_json::json!({"players": 9}),
            serde_json::json!({"world": "Missing map"}),
            serde_json::json!({"bots": ["Missing car"]}),
            serde_json::json!({"players": 8, "bots": ["Orbital"]}),
            serde_json::json!({"limits": null}),
            serde_json::json!({"mode": "tournament"}),
            serde_json::json!({"sessionId": null}),
            serde_json::json!({"roster": [request["roster"][0].clone(), request["roster"][0].clone()]}),
            serde_json::json!({"roster": [{"credential": "x".repeat(64), "car": "Orbital"}]}),
            serde_json::json!({"roster": [{"credential": "a".repeat(64), "car": "Missing car"}]}),
        ] {
            let mut invalid = request.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            assert!(matches!(
                state.start(serde_json::from_value(invalid).unwrap()),
                Err(StartError::Invalid(_))
            ));
            assert_eq!(serde_json::to_value(&state.status).unwrap(), before);
        }
        let setup = state
            .start(serde_json::from_value(request).unwrap())
            .unwrap();
        assert_eq!(setup.players, 2);
        assert_eq!(setup.roster.len(), 1);
        assert_eq!(state.status.phase, Phase::Starting);
        assert_eq!(
            state.start(start_options(2, "Construction Yard")),
            Err(StartError::NotReady)
        );
    }

    fn resources_ready(state: &mut PublishedState) {
        state.resources_ready(
            vec!["Construction Yard".into()],
            vec!["Orbital".into()],
            Compatibility {
                protocol: 17,
                build: "build".into(),
                content: "content".into(),
            },
        );
    }

    fn update(outcome: MatchOutcome) -> MatchUpdate {
        MatchUpdate {
            connected: 2,
            tick: 100,
            cars: None,
            outcome,
        }
    }

    fn finished() -> MatchOutcome {
        MatchOutcome::Finished {
            message: "Match finished",
            result: MatchResult {
                session_id: "match".into(),
                completion: MatchCompletion {
                    tick: 100,
                    reasons: 1,
                    winners: 1,
                },
                participants: vec![],
            },
        }
    }

    #[test]
    fn phase_serialization_preserves_http_and_metrics_names() {
        for (phase, name) in [
            (Phase::Setup, "setup"),
            (Phase::Loading, "loading"),
            (Phase::Ready, "ready"),
            (Phase::Starting, "starting"),
            (Phase::Lobby, "lobby"),
            (Phase::Match, "match"),
            (Phase::Results, "results"),
            (Phase::Failed, "failed"),
            (Phase::Closed, "closed"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
            assert_eq!(phase.as_str(), name);
        }
    }

    #[test]
    fn launch_requires_resources_and_allows_retry_after_preparation_failure() {
        let mut state = state();
        assert!(state.begin_prepare().is_err());
        state.status.uploaded = 2;
        state.begin_prepare().unwrap();
        assert_eq!(state.status.phase, Phase::Loading);
        assert!(state.begin_prepare().is_err());
        assert!(state.start(start_options(2, "Construction Yard")).is_err());
        state.preparation_failed("Invalid resources");
        assert_eq!(state.status.phase, Phase::Failed);
        assert!(state.status.phase.permits_upload());
        state.begin_prepare().unwrap();
        resources_ready(&mut state);
        assert_eq!(state.status.phase, Phase::Ready);
        assert_eq!(state.status.world.as_deref(), Some("Construction Yard"));
        assert!(!state.status.phase.permits_upload());
        state.start(start_options(2, "Construction Yard")).unwrap();
        assert_eq!(state.status.phase, Phase::Starting);
        assert!(state.start(start_options(1, "The Oil Rig")).is_err());
        assert_eq!(
            state.status.session_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000000")
        );
        state.listening();
        assert_eq!(state.status.phase, Phase::Lobby);
        state.publish_match(update(MatchOutcome::Waiting));
        assert_eq!(state.status.phase, Phase::Lobby);
        state.publish_match(update(MatchOutcome::Playing("Playing")));
        assert_eq!(state.status.phase, Phase::Match);
        state.publish_match(update(finished()));
        assert_eq!(state.status.phase, Phase::Results);
        assert_eq!(state.result.as_ref().unwrap().completion.tick, 100);
    }

    #[test]
    fn late_callbacks_cannot_reopen_a_closed_server_or_erase_the_cause() {
        for phase in [
            Phase::Setup,
            Phase::Loading,
            Phase::Ready,
            Phase::Starting,
            Phase::Lobby,
            Phase::Match,
        ] {
            let mut state = state();
            state.status.phase = phase;
            state.close("HTTP server stopped");
            resources_ready(&mut state);
            state.preparation_failed("Preparation failed");
            state.listening();
            state.publish_match(update(MatchOutcome::Playing("Playing")));
            state.publish_match(update(finished()));
            state.close("Match stopped");
            assert_eq!(state.status.phase, Phase::Closed);
            assert_eq!(state.status.message, "HTTP server stopped");
            assert!(state.result.is_none());
            assert!(state.begin_prepare().is_err());
            assert!(state.start(start_options(2, "Construction Yard")).is_err());
        }
    }

    #[test]
    fn results_remain_final_while_connection_counts_continue_to_update() {
        let mut state = state();
        state.status.phase = Phase::Match;
        state.publish_match(update(finished()));
        let mut later = update(MatchOutcome::Playing("Stale update"));
        later.connected = 1;
        state.publish_match(later);
        assert_eq!(state.status.phase, Phase::Results);
        assert_eq!(state.status.message, "Match finished");
        assert_eq!(state.status.connected, 1);
        let mut replacement = finished();
        if let MatchOutcome::Finished { result, .. } = &mut replacement {
            result.completion.tick = 200;
        }
        state.publish_match(update(replacement));
        assert_eq!(state.result.as_ref().unwrap().completion.tick, 100);
        assert!(
            serde_json::to_value(&state.status)
                .unwrap()
                .get("participants")
                .is_none()
        );
    }

    #[test]
    fn match_reports_cannot_skip_preparation_or_listener_startup() {
        for phase in [
            Phase::Setup,
            Phase::Loading,
            Phase::Ready,
            Phase::Starting,
            Phase::Failed,
        ] {
            let mut state = state();
            state.status.phase = phase;
            state.publish_match(update(MatchOutcome::Playing("Playing")));
            state.publish_match(update(finished()));
            assert_eq!(state.status.phase, phase);
            assert_eq!(state.status.tick, 0);
            assert!(state.result.is_none());
        }
    }
}
