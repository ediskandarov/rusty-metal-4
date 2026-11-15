pub mod ffa;
mod tournament;

use crate::protocol::{FfaLimits, MAX_PLAYERS, MatchMode, SessionStart};

pub struct StartSettings<'a> {
    pub human_capacity: usize,
    pub selected_humans: usize,
    pub bots: usize,
    pub world: &'a str,
    pub limits: Option<FfaLimits>,
}

pub struct SessionParameters {
    pub limits: FfaLimits,
    pub respawn_delay_ticks: u32,
    pub model_pool: Vec<String>,
}

const INVALID_LIMITS: &str =
    "FFA requires positive time and frag limits; tournament uses original rules";

impl MatchMode {
    pub fn validate_start(self, settings: &StartSettings<'_>) -> Result<FfaLimits, &'static str> {
        match self {
            Self::Ffa => ffa::validate_start(settings),
            Self::Tournament => tournament::validate_start(settings),
        }
    }

    pub fn session_parameters(
        self,
        limits: FfaLimits,
        catalog: &[String],
        cars: &[String],
    ) -> SessionParameters {
        match self {
            Self::Ffa => ffa::session_parameters(limits, catalog, cars),
            Self::Tournament => tournament::session_parameters(cars),
        }
    }

    pub(crate) fn valid_session(self, session: &SessionStart) -> bool {
        match self {
            Self::Ffa => ffa::valid_session(session),
            Self::Tournament => tournament::valid_session(session),
        }
    }

    pub fn check_live_membership(self) -> Result<(), &'static str> {
        match self {
            Self::Ffa => Ok(()),
            Self::Tournament => tournament::check_live_membership(),
        }
    }
}

/// The original renderer has eight permanent car atlases. Preserve every initial
/// selection, then fill spare atlases in catalog order. The declared result, not
/// this policy or local enumeration, is consumed by peers and journal replay.
fn prepared_model_pool(catalog: &[String], cars: &[String]) -> Vec<String> {
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
mod tests;
