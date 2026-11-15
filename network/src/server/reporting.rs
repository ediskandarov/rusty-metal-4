use super::{Match, control::Admission};
use crate::web::{self, MatchOutcome, MatchUpdate};
use bevy_ecs::world::World;
use tm4_network::modes::BattleProgress;

pub(super) struct Report {
    pub update: MatchUpdate,
    pub unacknowledged: Vec<usize>,
}

pub(super) fn collect(world: &World, session_id: Option<&str>) -> Report {
    let game = world.resource::<Match>();
    let progress = game.battle_progress().unwrap_or(BattleProgress::Playing);
    let outcome = if game.ended {
        if game.result_state().is_some() {
            MatchOutcome::Finished {
                message: game.mode.status_message(BattleProgress::Completed),
                result: game
                    .final_result(session_id.expect("a started match has an identity"))
                    .unwrap(),
            }
        } else if progress == BattleProgress::TransitionRequested {
            MatchOutcome::Stopped(game.mode.status_message(progress))
        } else {
            MatchOutcome::Stopped("Match stopped. Restart the server to prepare a new match.")
        }
    } else if game.started && game.tick > 0 {
        MatchOutcome::Playing(game.mode.status_message(progress))
    } else {
        MatchOutcome::Waiting
    };
    Report {
        update: MatchUpdate {
            connected: game
                .controls
                .iter()
                .filter(|player| player.connection.is_some())
                .count(),
            tick: game.tick,
            cars: game
                .session
                .as_ref()
                .map(|session| session.model_pool.clone()),
            outcome,
        },
        unacknowledged: game
            .controls
            .iter()
            .map(|player| {
                player
                    .connection
                    .and_then(|entity| world.get::<Admission>(entity))
                    .map_or(0, |admission| admission.unacknowledged.len())
            })
            .collect(),
    }
}

pub(super) fn publish(world: &World, launcher: &web::Launcher) {
    let session_id = launcher.session_id();
    let report = collect(world, session_id.as_deref());
    {
        let mut health = world.resource::<Match>().health.lock().unwrap();
        for (slot, count) in report.unacknowledged.into_iter().enumerate() {
            health.unacknowledged(slot, count);
        }
    }
    launcher.publish_match(report.update);
}
