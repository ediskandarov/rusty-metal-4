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
    let mut inputs = vec![Input::default(); 8];
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
        inputs[0].buttons = if tick % 30 == 0 { 0x40 } else { 0 };
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
    ensure!(
        final_state.scores[0].frags > 0,
        "Tournament AI kills were not credited"
    );
    let completed = authority.snapshot()?;
    authority.finish()?;
    authority.start(&start)?;
    authority.restore_portable(&completed)?;
    ensure!(
        authority.state()?.digest == final_state.digest,
        "Completed battle restore diverged"
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
        inputs[0].buttons = if replay_tick % 30 == 0 { 0x40 } else { 0 };
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

fn tournament_rules(world: &mut Simulator) -> Result<Vec<i32>> {
    let address = world.call::<(), u32>("WebTestTournamentState", ())?;
    let mut bytes = [0u8; 84];
    world
        .memory
        .read(&world.store, address as usize, &mut bytes)?;
    Ok(bytes
        .chunks_exact(4)
        .map(|word| i32::from_le_bytes(word.try_into().unwrap()))
        .collect())
}

#[test]
#[ignore = "requires diagnostic Wasm and private stock resources"]
fn tournament_full_campaign_original_waves_bosses_and_reuse() -> Result<()> {
    let (bytes, resources) = paths()?;
    let mut authority = Simulator::new(&bytes, &resources, compatibility())?;
    let first = SessionStart {
        mode: tm4_network::protocol::MatchMode::Tournament,
        limits: tm4_network::protocol::FfaLimits {
            time_limit_ticks: 0,
            frag_limit: 0,
        },
        respawn_delay_ticks: 0,
        ..session()
    };
    let worlds = [
        "Construction Yard",
        "Neon City",
        "Road Rage",
        "The Bedroom",
        "Amazonia 3000 B.C.",
        "The Oil Rig",
        "Minion's Maze",
        "The Carnival",
    ];
    let mut inputs = vec![Input::default(); 8];
    let mut start = first.clone();
    for (stage, expected_world) in worlds.iter().enumerate() {
        ensure!(
            start.world == *expected_world,
            "Wrong original world order: {:?}",
            start
        );
        authority.start(&start)?;
        let initial = tournament_rules(&mut authority)?;
        ensure!(
            initial[10] == 1 && initial[16] == 0,
            "Co-op rules/movie: {initial:?}"
        );
        if stage > 0 {
            let carry = start.tournament.as_ref().unwrap();
            ensure!(
                initial[8] == carry.progress
                    && initial[9] == carry.games_completed
                    && initial[11] == carry.players[0].lives
                    && initial[12] == carry.players[1].lives,
                "Campaign carry was lost: {initial:?} {carry:?}"
            );
        }
        let checkpoint = authority.snapshot()?;
        ensure!(authority.call::<(), u32>("WebNetCaptureLocalCheckpoint", ())? > 0);
        let mut tape = Vec::new();
        let mut recovery_points = Vec::new();
        let mut milestones = [false; 4];
        let mut saw_reinforcements = false;
        let mut saw_boss_delay = false;
        let mut saw_boss = false;
        for tick in 0..1800 {
            if tick % 90 == 0 {
                authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
            }
            inputs[0].buttons = if tick % 30 == 0 { 0x40 } else { 0 };
            let state = authority.step(tick, &inputs)?;
            let rules = tournament_rules(&mut authority)?;
            saw_reinforcements |= rules[4] != 0;
            saw_boss_delay |= rules[5] != 0;
            saw_boss |= rules[6] != 0;
            ensure!(
                state.unsupported.is_none(),
                "Unsupported {expected_world}: {:?}",
                state.unsupported
            );
            tape.push(state.digest);
            for (milestone, reached) in [
                rules[4] != 0,
                rules[5] != 0,
                rules[6] != 0,
                rules[17] != 0 || rules[18] != 0,
            ]
            .into_iter()
            .enumerate()
            {
                if reached && !milestones[milestone] && state.completion.reasons == 0 {
                    milestones[milestone] = true;
                    recovery_points.push((tick + 1, authority.snapshot()?));
                }
            }
            if state.completion.reasons != 0 {
                let expected = if stage == worlds.len() - 1 { 4 } else { 16 };
                ensure!(
                    state.completion.reasons == expected && state.completion.winners == 3,
                    "Wrong result {expected_world}: {:?} {rules:?}",
                    state.completion
                );
                ensure!(
                    rules[16] == 0,
                    "Two-player campaign selected a single-player ending"
                );
                break;
            }
        }
        let state = authority.state()?;
        ensure!(
            state.completion.reasons != 0,
            "Campaign stalled on {expected_world}"
        );
        ensure!(
            initial[0] <= initial[1] || saw_reinforcements,
            "Missing reinforcements on {expected_world}"
        );
        ensure!(
            initial[3] == 0 || (saw_boss_delay && saw_boss),
            "Missing original boss sequence on {expected_world}"
        );
        let completed = authority.snapshot()?;
        ensure!(authority.call::<(), i32>("WebNetRestoreLocalCheckpoint", ())? == 1);
        for (tick, digest) in tape.iter().enumerate() {
            if tick % 90 == 0 {
                authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
            }
            inputs[0].buttons = if tick % 30 == 0 { 0x40 } else { 0 };
            ensure!(
                authority.step(tick as u32, &inputs)?.digest == *digest,
                "Local rollback diverged on {expected_world} at {tick}"
            );
        }
        ensure!(authority.call::<(), i32>("WebNetFinishLocalReplay", ())? == 1);
        // Replay the entire map from its portable startup boundary after resource teardown.
        authority.finish()?;
        authority.start(&start)?;
        authority.restore_portable(&checkpoint)?;
        for (tick, digest) in tape.iter().enumerate() {
            if tick % 90 == 0 {
                authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
            }
            inputs[0].buttons = if tick % 30 == 0 { 0x40 } else { 0 };
            ensure!(
                &authority.step(tick as u32, &inputs)?.digest == digest,
                "Replay diverged on {expected_world} at {tick}"
            );
        }
        authority.call::<(), ()>("WebNetEndReplay", ())?;
        ensure!(
            authority.snapshot()? == completed,
            "Terminal snapshot differed on {expected_world}"
        );
        for (boundary, checkpoint) in recovery_points {
            authority.finish()?;
            authority.start(&start)?;
            authority.restore_portable(&checkpoint)?;
            for tick in boundary..tape.len() as u32 {
                if tick % 90 == 0 {
                    authority.call::<(), ()>("WebTestDefeatOpponents", ())?;
                }
                inputs[0].buttons = if tick % 30 == 0 { 0x40 } else { 0 };
                ensure!(
                    authority.step(tick, &inputs)?.digest == tape[tick as usize],
                    "Boundary recovery diverged on {expected_world} at {tick}"
                );
            }
        }
        let next = if stage + 1 < worlds.len() {
            Some(authority.next_tournament_stage()?)
        } else {
            ensure!(
                authority.next_tournament_stage().is_err(),
                "Final victory has a next stage"
            );
            None
        };
        // Restore the completed map after teardown as a reconnect would.
        authority.finish()?;
        authority.start(&start)?;
        authority.restore_portable(&completed)?;
        ensure!(
            authority.state()?.digest == state.digest,
            "Completed-map reconnect diverged on {expected_world}"
        );
        eprintln!(
            "PASS original stage {}: {expected_world}, AI={} initial={} threshold={} bosses={} ticks={} lives={:?}",
            stage + 1,
            initial[0],
            initial[1],
            initial[2],
            initial[3],
            tape.len(),
            &tournament_rules(&mut authority)?[11..15]
        );
        authority.finish()?;
        if let Some(next) = next {
            start = SessionStart {
                world: next.world.clone(),
                tournament: Some(next),
                epoch: start.epoch + 1,
                ..start
            };
        }
    }
    let restarted = authority.start(&first)?.0;
    let rules = tournament_rules(&mut authority)?;
    ensure!(
        rules[8] == 0 && rules[11] == 4 && rules[12] == 4 && rules[13] == 0 && rules[14] == 0,
        "Campaign state leaked into new tournament: {rules:?}"
    );
    ensure!(
        restarted.completion.reasons == 0
            && restarted
                .scores
                .iter()
                .all(|s| s.frags == 0 && s.deaths == 0),
        "Campaign result leaked into new tournament"
    );
    authority.finish()?;
    Ok(())
}

#[test]
#[ignore = "requires diagnostic Wasm and private stock resources"]
fn tournament_shared_lives_elimination_and_original_game_over_recovery() -> Result<()> {
    let (bytes, resources) = paths()?;
    let mut world = Simulator::new(&bytes, &resources, compatibility())?;
    let start = SessionStart {
        mode: tm4_network::protocol::MatchMode::Tournament,
        limits: tm4_network::protocol::FfaLimits {
            time_limit_ticks: 0,
            frag_limit: 0,
        },
        respawn_delay_ticks: 0,
        ..session()
    };
    let inputs = vec![Input::default(); 8];
    for shared in [0, 1] {
        world.start(&start)?;
        // Original option plus a small remaining stock. Damage/removal/respawn remain original.
        ensure!(world.call::<i32, i32>("WebTestCoopSetup", shared)? == 1);
        world.step(0, &inputs)?;
        ensure!(world.call::<i32, i32>("WebTestKillParticipant", 0)? == 1);
        for tick in 1..241 {
            world.step(tick, &inputs)?;
        }
        let rules = tournament_rules(&mut world)?;
        ensure!(
            rules[11] == 0 && rules[12] == 1 - shared,
            "Wrong donor lives: {rules:?}"
        );
        ensure!(
            (rules[13] != 0) == (shared == 0),
            "Wrong eliminated player: {rules:?}"
        );
        ensure!(
            (world.call::<i32, u32>("WebTestCarHandle", 0)? != 0) == (shared == 1),
            "Original shared/individual respawn differs: {rules:?}"
        );
        ensure!(
            world.state()?.completion.reasons == 0,
            "Surviving teammate prematurely lost"
        );
        let checkpoint = world.snapshot()?;
        let mut events = Vec::new();
        let mut tape = Vec::new();
        let mut pending_loss = None;
        for tick in 241..1500 {
            if (tick - 241) % 240 == 0 {
                for slot in 0..2 {
                    if world.call::<i32, u32>("WebTestCarHandle", slot)? != 0 {
                        ensure!(world.call::<i32, i32>("WebTestKillParticipant", slot)? == 1);
                        events.push((tick, slot));
                    }
                }
            }
            let state = world.step(tick, &inputs)?;
            let rules = tournament_rules(&mut world)?;
            if rules[19] != 0 && state.completion.reasons == 0 && pending_loss.is_none() {
                ensure!(
                    rules[13] == 1 && rules[14] == 1,
                    "GAME OVER before both eliminated"
                );
                pending_loss = Some((tick + 1, world.snapshot()?));
            }
            ensure!(
                state.next_mode == 0,
                "Network ran the offline menu transition"
            );
            tape.push(state.digest);
            if state.completion.reasons != 0 {
                ensure!(
                    state.completion.reasons == 8 && state.completion.winners == 0,
                    "Wrong original defeat: {:?}",
                    state.completion
                );
                let loss_tick = pending_loss
                    .as_ref()
                    .context("Missing GAME OVER presentation")?
                    .0;
                ensure!(
                    tick + 1 >= loss_tick + 119,
                    "GAME OVER presentation was skipped"
                );
                break;
            }
        }
        ensure!(
            world.state()?.completion.reasons == 8,
            "Defeat did not finish"
        );
        let final_state = world.state()?;
        for (boundary, snapshot) in [(241, checkpoint), pending_loss.unwrap()] {
            world.finish()?;
            world.start(&start)?;
            world.restore_portable(&snapshot)?;
            for tick in boundary..241 + tape.len() as u32 {
                for (_, slot) in events.iter().filter(|(event, _)| *event == tick) {
                    ensure!(world.call::<i32, i32>("WebTestKillParticipant", *slot)? == 1);
                }
                ensure!(
                    world.step(tick, &inputs)?.digest == tape[(tick - 241) as usize],
                    "Defeat replay diverged shared={shared} tick={tick}"
                );
            }
            ensure!(
                world.state()?.digest == final_state.digest,
                "Defeat recovery diverged"
            );
        }
        world.finish()?;
    }
    Ok(())
}
