use super::{
    INVALID_LIMITS, PreparedRoster, SessionParameters, StartSettings, prepared_model_pool,
};
use crate::protocol::{FfaLimits, SessionStart};
use serde::Deserialize;

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
    serde_json::from_str(include_str!("../../../config/ffa.json")).expect("valid FFA defaults")
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

pub fn respawn_delay_ticks() -> u32 {
    ffa_defaults().respawn_delay_ticks
}

pub(super) fn validate_start(settings: &StartSettings<'_>) -> Result<FfaLimits, &'static str> {
    settings
        .limits
        .filter(|limits| limits.valid())
        .ok_or(INVALID_LIMITS)
}

pub(super) fn session_parameters(
    limits: FfaLimits,
    catalog: &[String],
    cars: &[String],
) -> SessionParameters {
    SessionParameters {
        limits,
        respawn_delay_ticks: respawn_delay_ticks(),
        model_pool: prepared_model_pool(catalog, cars),
    }
}

pub(super) fn valid_session(session: &SessionStart) -> bool {
    if session.tournament.is_some() {
        return false;
    }
    session.limits.valid() && (1..=3600).contains(&session.respawn_delay_ticks)
}

pub(super) const PLAYING_MESSAGE: &str =
    "Live admission uses the prepared model pool; existing participants can reconnect.";

pub(super) fn validate_roster(roster: &PreparedRoster) -> Result<(), &'static str> {
    if roster.humans == 0 {
        return Err("FFA needs at least one prepared human participant.");
    }
    Ok(())
}
