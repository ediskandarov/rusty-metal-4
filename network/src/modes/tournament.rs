use super::{INVALID_LIMITS, SessionParameters, StartSettings, prepared_model_pool};
use crate::protocol::{FfaLimits, SessionStart};

const INITIAL_WORLD: &str = "Construction Yard";
// The wire format retains the FFA fields; the original tournament does not use them.
const UNUSED_LIMITS: FfaLimits = FfaLimits {
    time_limit_ticks: 0,
    frag_limit: 0,
};

pub(super) fn validate_start(settings: &StartSettings<'_>) -> Result<FfaLimits, &'static str> {
    if settings.human_capacity != 2
        || settings.selected_humans != 2
        || settings.bots != 0
        || settings.world != INITIAL_WORLD
    {
        return Err("Tournament requires two selected humans on Construction Yard");
    }
    if settings.limits.is_some() {
        return Err(INVALID_LIMITS);
    }
    Ok(UNUSED_LIMITS)
}

pub(super) fn session_parameters(cars: &[String]) -> SessionParameters {
    SessionParameters {
        limits: UNUSED_LIMITS,
        respawn_delay_ticks: 0,
        model_pool: prepared_model_pool(&[], cars),
    }
}

pub(super) fn valid_session(session: &SessionStart) -> bool {
    session.slots == [0, 1]
        && session.bots.is_empty()
        && session.respawn_delay_ticks == 0
        && session.limits == UNUSED_LIMITS
        && session.world == INITIAL_WORLD
}

pub(super) fn check_live_membership() -> Result<(), &'static str> {
    Err("Tournament participants are fixed until the battle ends.")
}
