use super::{
    INVALID_LIMITS, PreparedRoster, SessionParameters, StartSettings, prepared_model_pool,
};
use crate::protocol::{FfaLimits, SessionStart};

const INITIAL_WORLD: &str = "Construction Yard";
// The wire format retains the FFA fields; the original tournament does not use them.
const UNUSED_LIMITS: FfaLimits = FfaLimits {
    time_limit_ticks: 0,
    frag_limit: 0,
};

pub(super) fn validate_start(settings: &StartSettings<'_>) -> Result<FfaLimits, &'static str> {
    if !(2..=4).contains(&settings.human_capacity)
        || !(2..=settings.human_capacity).contains(&settings.selected_humans)
        || settings.bots != 0
        || settings.world != INITIAL_WORLD
    {
        return Err("Tournament requires two to four selected humans on Construction Yard");
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
    (2..=4).contains(&session.slots.len())
        && session
            .slots
            .iter()
            .enumerate()
            .all(|(index, slot)| usize::from(*slot) == index)
        && session.bots.is_empty()
        && session.respawn_delay_ticks == 0
        && session.limits == UNUSED_LIMITS
        && match &session.tournament {
            None => session.world == INITIAL_WORLD,
            Some(stage) => {
                session.world == stage.world
                    && session.world != INITIAL_WORLD
                    && stage.progress > 0
                    && stage.progress < 4096
                    && stage.games_completed >= stage.progress
                    && stage.players.len() == session.slots.len()
                    && stage.players.iter().all(|player| player.lives >= 0)
            }
        }
}

pub(super) fn check_live_membership() -> Result<(), &'static str> {
    Err("Tournament participants are fixed until the battle ends.")
}

pub(super) const PLAYING_MESSAGE: &str =
    "Tournament participants are fixed for this battle; existing participants can reconnect.";

pub(super) fn validate_roster(roster: &PreparedRoster) -> Result<(), &'static str> {
    if !(2..=4).contains(&roster.humans) || roster.bots != 0 {
        return Err(
            "Tournament requires two to four prepared human participants and no lobby bots.",
        );
    }
    Ok(())
}
