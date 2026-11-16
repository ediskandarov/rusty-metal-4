//! A confirmed stage boundary starts a fresh prediction timeline, retaining the campaign.
use super::{AcceptedTimeline, ControllerState, Match};
use crate::simulator::Simulator;
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use std::time::Instant;
use tm4_network::protocol::{MatchMode, Message};

pub(super) fn advance_stage(
    game: &mut Match,
    simulator: &mut Simulator,
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    commands: &mut Commands,
) -> bool {
    if game.continuation.is_some()
        && !game.started
        && !game.ended
        && game.loading_since.elapsed() > std::time::Duration::from_secs(300)
    {
        game.fail(
            links,
            "Tournament transition expired while waiting for both players.",
        );
        return false;
    }
    if !game.ended
        || game.mode != MatchMode::Tournament
        || !game
            .last_state
            .as_ref()
            .is_some_and(|state| state.completion.reasons == 16)
    {
        return true;
    }
    let next = match simulator.next_tournament_stage().and_then(|stage| {
        simulator.finish()?;
        Ok(stage)
    }) {
        Ok(stage) => stage,
        Err(error) => {
            game.last_state = None;
            game.fail(links, &format!("Tournament transition failed: {error:#}"));
            return false;
        }
    };
    // Old links finish delivering their final reliable frame. They cannot submit
    // commands into the next battle, even if a browser resumes an old callback.
    for player in &mut game.controls {
        if let Some(entity) = player.connection {
            game.retired_connections.insert(entity);
        }
        if let Some(entity) = player.controller {
            commands.entity(entity).despawn();
        }
        *player = ControllerState::default();
    }
    game.selected_world = Some(next.world.clone());
    game.continuation = Some(next);
    game.authority_ready = false;
    game.initial_digest = None;
    game.started = false;
    game.ended = false;
    game.tick = 0;
    game.loading_since = Instant::now();
    game.lobby_since = None;
    game.last_state = None;
    game.last_step_duration = None;
    game.tick_schedule = None;
    game.prediction = AcceptedTimeline::default();
    game.journal = None;
    game.journal_sealed = false;
    true
}
