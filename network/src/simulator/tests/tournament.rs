use super::*;

#[test]
#[ignore = "requires diagnostic Wasm and private stock resources"]
fn tournament_next_map_preserves_campaign_and_restores_on_fresh_instance() -> Result<()> {
    let (bytes, resources) = paths()?;
    let mut authority = Simulator::new(&bytes, &resources, compatibility())?;
    let start = SessionStart {
        mode: tm4_network::protocol::MatchMode::Tournament,
        limits: tm4_network::protocol::FfaLimits {
            time_limit_ticks: 0,
            frag_limit: 0,
        },
        respawn_delay_ticks: 0,
        ..session()
    };
    authority.start(&start)?;
    ensure!(
        authority.next_tournament_stage().is_err(),
        "Unfinished battle advanced"
    );
    let inputs = vec![Input::default(); 8];
    let mut tick = 0;
    for _ in 0..60 {
        authority.step(tick, &inputs)?;
        tick += 1;
    }
    ensure!(authority.call::<i32, i32>("WebTestKillParticipant", 0)? == 1);
    for _ in 0..240 {
        authority.step(tick, &inputs)?;
        tick += 1;
    }
    let checkpoint = authority.snapshot()?;
    let replay_start = tick;
    let mut final_state = None;
    for _ in 0..1500 {
        if (tick - replay_start) % 240 == 0 {
            authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
        }
        let state = authority.step(tick, &inputs)?;
        tick += 1;
        if state.completion.reasons != 0 {
            final_state = Some(state);
            break;
        }
    }
    let final_state = final_state.context("Tournament did not finish")?;
    ensure!(
        final_state.completion.reasons == 16 && final_state.completion.winners == 3,
        "Not an intermediate team victory"
    );
    let next = authority.next_tournament_stage()?;
    ensure!(
        next.world == "Neon City" && next.players[0].lives == 3,
        "Wrong progression or lives: {next:?}"
    );
    authority.finish()?;
    authority.start(&start)?;
    authority.restore_portable(&checkpoint)?;
    for replay_tick in replay_start..tick {
        if (replay_tick - replay_start) % 240 == 0 {
            authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
        }
        authority.step(replay_tick, &inputs)?;
    }
    ensure!(
        authority.state()?.digest == final_state.digest,
        "Victory replay diverged"
    );
    ensure!(
        authority.next_tournament_stage()? == next,
        "Campaign differs after restore"
    );
    authority.finish()?;
    let next_start = SessionStart {
        world: next.world.clone(),
        tournament: Some(next),
        epoch: 2,
        ..start
    };
    let mut fresh = Simulator::new(&bytes, &resources, compatibility())?;
    let initial = authority.start(&next_start)?.0;
    ensure!(
        initial.digest == fresh.start(&next_start)?.0.digest,
        "Reload history leaked into next map"
    );
    for tick in 0..120 {
        ensure!(
            authority.step(tick, &inputs)?.digest == fresh.step(tick, &inputs)?.digest,
            "Next map diverged at {tick}"
        );
    }
    let checkpoint = authority.snapshot()?;
    fresh.finish()?;
    fresh.start(&next_start)?;
    fresh.restore_portable(&checkpoint)?;
    for tick in 120..180 {
        ensure!(
            authority.step(tick, &inputs)?.digest == fresh.step(tick, &inputs)?.digest,
            "Next map recovery diverged at {tick}"
        );
    }
    Ok(())
}
