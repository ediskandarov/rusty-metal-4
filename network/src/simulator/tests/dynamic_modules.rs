use super::*;

#[test]
#[ignore = "requires diagnostic Wasm and private stock resources"]
fn dynamic_maps_restore_between_instances_and_replay_after_reload() -> Result<()> {
    fn row(world: &mut Simulator) -> Result<Row> {
        let state = world.state()?;
        ensure!(state.unsupported.is_none(), "{:?}", state.unsupported);
        let length = world.call::<(), u32>("HeadlessCapture", ())?;
        ensure!(length > 0, "Canonical capture refused");
        let address = world.call::<(), u32>("HeadlessCanonical", ())?;
        let mut bytes = vec![0; length as usize];
        world
            .memory
            .read(&world.store, address as usize, &mut bytes)?;
        Ok(Row {
            tick: world.call::<(), u32>("HeadlessTick", ())?,
            digest: state.digest,
            sections: state.sections,
            canonical: STANDARD.encode(bytes),
        })
    }
    fn inputs(tick: u32) -> Vec<Input> {
        let mut inputs = vec![Input::default(); 8];
        inputs[0].buttons = if tick % 90 < 60 { 0x8040 } else { 0x2 };
        inputs[1].buttons = if tick % 60 < 30 { 0x8080 } else { 0x40 };
        inputs
    }
    let (bytes, resources) = paths()?;
    let mut source = Simulator::new(&bytes, &resources, compatibility())?;
    let mut target = Simulator::new(&bytes, &resources, compatibility())?;
    // Different load histories must not leak addresses or module globals into snapshots.
    target.start(&session())?;
    for tick in 0..30 {
        target.step(tick, &inputs(tick))?;
    }
    target.finish()?;
    for pass in 0..2 {
        for (map, classes) in [
            ("Neon City", &["train", "ufo"][..]),
            ("The Oil Rig", &["helicopter"][..]),
            ("The Carnival", &["coaster"][..]),
        ] {
            let setup = SessionStart {
                world: map.into(),
                ..session()
            };
            ensure!(source.start(&setup)?.1, "{map}: portable unavailable");
            let mut rows = vec![row(&mut source)?];
            let mut snapshot = Vec::new();
            for tick in 0..180 {
                source.step(tick, &inputs(tick))?;
                rows.push(row(&mut source)?);
                if tick == 89 {
                    snapshot = source.snapshot()?;
                    for class in classes {
                        let name = format!("{class}\0");
                        ensure!(
                            snapshot.windows(name.len()).any(|w| w == name.as_bytes()),
                            "{map}: missing live {class} in snapshot"
                        );
                    }
                    ensure!(
                        source.call::<(), u32>("WebNetCaptureLocalCheckpoint", ())? > 0,
                        "{map}: checkpoint refused"
                    );
                }
            }
            ensure!(
                source.call::<(), i32>("WebNetRestoreLocalCheckpoint", ())? == 1,
                "{map}: source rollback refused"
            );
            compare(&mut source, &rows[90])?;
            for tick in 90..180 {
                source.step(tick, &inputs(tick))?;
                compare(&mut source, &rows[tick as usize + 1])?;
            }
            ensure!(
                source.call::<(), i32>("WebNetFinishLocalReplay", ())? == 1,
                "{map}: source replay finish refused"
            );
            target.start(&setup)?;
            target.restore_portable(&snapshot)?;
            target.call::<(), ()>("WebNetEndReplay", ())?;
            compare(&mut target, &rows[90])?;
            ensure!(
                target.call::<(), u32>("WebNetCaptureLocalCheckpoint", ())? > 0,
                "{map}: restored checkpoint refused"
            );
            for tick in 90..180 {
                target.step(tick, &inputs(tick))?;
                compare(&mut target, &rows[tick as usize + 1])?;
            }
            target.call::<(), ()>("WebNetEndReplay", ())?;
            ensure!(
                target.call::<(), i32>("WebNetRestoreLocalCheckpoint", ())? == 1,
                "{map}: restored-instance rollback refused"
            );
            compare(&mut target, &rows[90])?;
            for tick in 90..180 {
                target.step(tick, &inputs(tick))?;
                compare(&mut target, &rows[tick as usize + 1])?;
            }
            ensure!(
                target.call::<(), i32>("WebNetFinishLocalReplay", ())? == 1,
                "{map}: restored-instance replay finish refused"
            );
            source.finish()?;
            target.finish()?;
            eprintln!(
                "PASS {map} pass {pass}: live {classes:?}, portable transfer, source/target rollback, 273 exact comparisons"
            );
        }
    }
    Ok(())
}

#[test]
#[ignore = "local simulation benchmark: requires Wasm and private stock resources"]
fn measure_dynamic_module_rotation() -> Result<()> {
    use std::time::Instant;
    fn rss_kib() -> Result<u64> {
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()?;
            ensure!(output.status.success(), "ps failed");
            Ok(String::from_utf8(output.stdout)?.trim().parse()?)
        }
        #[cfg(target_os = "linux")]
        {
            let status = fs::read_to_string("/proc/self/status")?;
            Ok(status
                .lines()
                .find(|l| l.starts_with("VmRSS:"))
                .context("Missing RSS")?
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse()?)
        }
    }
    let (bytes, resources) = paths()?;
    let started = Instant::now();
    let mut world = Simulator::new(&bytes, &resources, compatibility())?;
    eprintln!(
        "MEASURE {}",
        serde_json::json!({"phase":"initialize", "ms":started.elapsed().as_secs_f64()*1000.0, "rssKiB":rss_kib()?})
    );
    for round in 0..30 {
        let map = ["Neon City", "The Oil Rig", "The Carnival"][round % 3];
        let setup = SessionStart {
            world: map.into(),
            cars: vec!["Sweet Tooth".into(); 8],
            model_pool: vec!["Sweet Tooth".into()],
            slots: (0..8).collect(),
            participants: (1..=8).map(tm4_network::protocol::ParticipantId).collect(),
            portable: false,
            ..session()
        };
        let started = Instant::now();
        world.start(&setup)?;
        let start_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut timings = Vec::new();
        for tick in 0..900 {
            let inputs: Vec<_> = (0..8)
                .map(|slot| Input {
                    buttons: 0x40
                        | if (tick / 90 + slot) % 2 == 0 {
                            0x8000
                        } else {
                            0x2000
                        }
                        | if tick % 3 != 0 { 0x2 } else { 0 },
                    ..Default::default()
                })
                .collect();
            let started = Instant::now();
            let state = world.step(tick, &inputs)?;
            timings.push(started.elapsed().as_secs_f64() * 1000.0);
            ensure!(
                state.unsupported.is_none(),
                "{map}: {:?}",
                state.unsupported
            );
        }
        ensure!(
            world.call::<(), u32>("HeadlessTick", ())? == 900,
            "{map}: stalled simulation"
        );
        ensure!(
            world.state()?.completion.reasons == 0,
            "{map}: match ended during benchmark"
        );
        timings.sort_by(f64::total_cmp);
        let live_rss = rss_kib()?;
        world.finish()?;
        eprintln!(
            "MEASURE {}",
            serde_json::json!({"phase":"rotation", "round":round,
            "map":map, "startMs":start_ms, "tickMeanMs":timings.iter().sum::<f64>()/timings.len() as f64,
            "tickP95Ms":timings[854], "tickP99Ms":timings[890], "tickMaxMs":timings[899],
            "liveRssKiB":live_rss, "idleRssKiB":rss_kib()?})
        );
    }
    Ok(())
}
