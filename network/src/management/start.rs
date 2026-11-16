use super::{MatchSetup, RosterMember, Status};
use serde::Deserialize;
use tm4_network::protocol::MAX_PLAYERS;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartOptions {
    mode: tm4_network::protocol::MatchMode,
    #[serde(default)]
    bots: Vec<String>,
    limits: Option<tm4_network::protocol::FfaLimits>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    roster: Vec<RosterMember>,
    players: usize,
    world: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    NotReady,
    Invalid(&'static str),
}
impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotReady => "Prepare resources before opening the match",
            Self::Invalid(message) => message,
        })
    }
}

pub(super) struct ValidatedStart {
    pub session_id: Option<String>,
    pub setup: MatchSetup,
}

impl StartOptions {
    pub(super) fn validate(self, status: &Status) -> Result<ValidatedStart, StartError> {
        let limits = self
            .mode
            .validate_start(&tm4_network::modes::StartSettings {
                human_capacity: self.players,
                selected_humans: self.roster.len(),
                bots: self.bots.len(),
                world: &self.world,
                limits: self.limits,
            })
            .map_err(StartError::Invalid)?;
        if !(1..=MAX_PLAYERS).contains(&self.players) {
            return Err(StartError::Invalid("Expected a player count from 1 to 8"));
        }
        if self.players + self.bots.len() > MAX_PLAYERS
            || self.bots.iter().any(|bot| !status.cars.contains(bot))
        {
            return Err(StartError::Invalid(
                "Choose available AI models within eight human and AI places.",
            ));
        }
        if !status.worlds.contains(&self.world) {
            return Err(StartError::Invalid("Choose a map from the server catalog"));
        }
        if self.session_id.is_some() || !self.roster.is_empty() {
            if self.session_id.as_ref().is_none_or(|id| id.len() != 36)
                || !(1..=self.players).contains(&self.roster.len())
                || self.roster.iter().any(|member| {
                    member.credential.len() != 64
                        || !member
                            .credential
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                        || !status.cars.contains(&member.car)
                })
                || self.roster.iter().enumerate().any(|(index, member)| {
                    self.roster[..index]
                        .iter()
                        .any(|other| other.credential == member.credential)
                })
            {
                return Err(StartError::Invalid("Invalid initial room roster"));
            }
        }
        Ok(ValidatedStart {
            session_id: self.session_id,
            setup: MatchSetup {
                mode: self.mode,
                bots: self.bots,
                roster: self.roster,
                limits,
                players: self.players,
                world: self.world,
            },
        })
    }
}
