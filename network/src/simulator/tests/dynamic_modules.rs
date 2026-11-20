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

// Exercise the real host ABI and production arena sizing without game assets.
fn loader_fixture(modules: crate::assets::ModuleFiles) -> Result<Simulator> {
    let engine = Engine::default();
    let mut store = Store::new(
        &engine,
        Host {
            wasi: WasiCtxBuilder::new().build_p1(),
            dylink: None,
            module_images: Default::default(),
        },
    );
    let mut linker = Linker::new(&engine);
    dylink::add_to_linker(&mut linker)?;
    linker.func_wrap("env", "fail_constructor", || -> wasmtime::Result<()> {
        Err(wasmtime::Error::msg("fixture constructor root cause"))
    })?;
    let bytes = wat::parse_str(
        r#"(module
      (import "env" "_dlopen_js" (func $open (param i32) (result i32)))
      (memory (export "memory") 4)
      (table (export "__indirect_function_table") 1 funcref)
      (global $heap (mut i32) (i32.const 8192))
      (func (export "malloc") (param $size i32) (result i32) (local $p i32)
        global.get $heap local.tee $p local.get $size i32.add
        i32.const 15 i32.add i32.const -16 i32.and global.set $heap local.get $p)
      (func (export "free") (param i32))
      (func (export "__dl_seterr") (param i32 i32))
      (func (export "open") (param i32) (result i32) local.get 0 call $open))"#,
    )?;
    let instance = linker.instantiate(&mut store, &Module::from_binary(&engine, &bytes)?)?;
    let memory = instance.get_memory(&mut store, "memory").unwrap();
    dylink::attach(&mut store, instance, linker, modules)?;
    Ok(Simulator {
        prepared_resources: None,
        capacity: 0,
        slots: vec![],
        store,
        instance,
        memory,
        stop_clock: Arc::new(AtomicBool::new(false)),
        clock: None,
        deadline_epochs: CALL_DEADLINE_EPOCHS,
        compatibility: compatibility(),
        catalog: Catalog {
            cars: vec![],
            worlds: vec![],
        },
        #[cfg(feature = "rollback_probe")]
        fixture_file: None,
        #[cfg(feature = "rollback_probe")]
        loaded_actions: vec![],
    })
}

fn module_descriptor(world: &mut Simulator, name: &str) -> Result<u32> {
    let address = world.call::<u32, u32>("malloc", 36 + name.len() as u32 + 1)?;
    let mut descriptor = vec![0; 36];
    descriptor[4..8].copy_from_slice(&2u32.to_le_bytes()); // RTLD_NOW | RTLD_LOCAL
    descriptor.extend_from_slice(name.as_bytes());
    descriptor.push(0);
    world
        .memory
        .write(&mut world.store, address as usize, &descriptor)?;
    Ok(address)
}

fn load_all_entry_points(world: &mut Simulator, names: &[String]) -> Result<()> {
    let mut linker = Linker::new(world.store.engine());
    dylink::add_to_linker(&mut linker)?;
    let open = linker
        .get(&mut world.store, "env", "_dlopen_js")
        .unwrap()
        .into_func()
        .unwrap()
        .typed::<u32, i32>(&world.store)?;
    let sym = linker
        .get(&mut world.store, "env", "_dlsym_js")
        .unwrap()
        .into_func()
        .unwrap()
        .typed::<(u32, u32, u32), u32>(&world.store)?;
    let name = world.call::<u32, u32>("malloc", 32)?;
    world
        .memory
        .write(&mut world.store, name as usize, b"Tm4ModuleExport\0")?;
    for file in names {
        let handle = module_descriptor(world, &format!("/mr/{}", file.replace(".wasm", ".sym")))?;
        ensure!(open.call(&mut world.store, handle)? == 1, "opening {file}");
        let pointer = sym.call(&mut world.store, (handle, name, name + 24))?;
        ensure!(pointer != 0, "resolving {file}");
        assert_eq!(
            sym.call(&mut world.store, (handle, name, name + 24))?,
            pointer
        );
    }
    Ok(())
}

#[test]
fn dynamic_module_failure_preserves_constructor_cause_and_blocks_reentry() -> Result<()> {
    let bytes = wat::parse_str(
        r#"(module
      (@dylink.0 (mem-info))
      (import "env" "fail_constructor" (func $fail))
      (func (export "__wasm_call_ctors") call $fail))"#,
    )?;
    let mut world = loader_fixture(vec![("broken.wasm".into(), bytes.into())])?;
    let handle = module_descriptor(&mut world, "/mr/broken.sym")?;
    let error = world.call::<u32, i32>("open", handle).unwrap_err();
    let detail = format!("{error:#}");
    assert!(
        detail.contains("Resource-module loader failed during open"),
        "{detail}"
    );
    assert!(detail.contains("broken.sym"), "{detail}");
    assert!(
        detail.contains("fixture constructor root cause"),
        "{detail}"
    );
    assert!(
        world
            .call::<u32, u32>("malloc", 4)
            .unwrap_err()
            .to_string()
            .contains("loader is poisoned")
    );
    Ok(())
}

#[test]
#[ignore = "requires authority Wasm and private stock resources"]
fn dynamic_module_arena_loads_entire_stock_inventory() -> Result<()> {
    let (bytes, resources) = paths()?;
    let names = dylink::test_modules()?
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    let mut world = Simulator::new(&bytes, &resources, compatibility())?;
    load_all_entry_points(&mut world, &names)
}

#[test]
#[ignore = "requires diagnostic Wasm and private stock resources"]
fn authored_mr_module_follows_registry_ownership() -> Result<()> {
    let image = wat::parse_str(
        r#"(module
      (@dylink.0 (mem-info (memory 0 0) (table 1 0)))
      (@custom "rm4.module" "mprobe.sym")
      (import "env" "memory" (memory 1))
      (import "env" "__indirect_function_table" (table 0 funcref))
      (import "env" "__table_base" (global $base i32))
      (func $probe (result i32) i32.const 37)
      (elem (global.get $base) $probe)
      (func (export "Tm4ModuleExport") (param $name i32) (result i32)
        local.get $name i32.load8_u i32.const 80 i32.eq
        if (result i32) global.get $base else i32.const 0 end))"#,
    )?;
    let mut archive = vec![0x67, 0, 0, 0, 8, 0, 1, 0];
    archive.extend_from_slice(b"Root\0\0\0\0");
    archive.extend_from_slice(&[16, 6, 255, 255]);
    archive.extend_from_slice(&(image.len() as u32).to_le_bytes());
    archive.extend_from_slice(&0u32.to_le_bytes());
    archive.extend_from_slice(b"behavior.mod\0\0\0\0");
    archive.extend_from_slice(&image);
    let (bytes, resources) = paths()?;
    let input = tempfile::tempdir()?;
    let mut index = rm4_mr_preparation::ResourceIndex::parse(&fs::read_to_string(
        resources.join("DATA/files.tsv"),
    )?)?;
    for entry in index.entries() {
        let name = entry.path.trim_start_matches('/');
        let source = resources.join(name);
        if !source.try_exists()? && name.ends_with(".TIM") {
            continue;
        }
        let destination = input.path().join(name);
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::copy(source, destination)?;
    }
    fs::write(input.path().join("DATA/PROBE.MR"), &archive)?;
    index.add("/DATA/PROBE.MR", 0, archive.len() as u64)?;
    fs::write(input.path().join("DATA/files.tsv"), index.to_tsv()?)?;
    // No mprobe entry in the stock module list: preparation must discover it in MR.
    let modules = dylink::test_modules()?;
    assert!(!modules.iter().any(|(name, _)| name == "mprobe.wasm"));
    let mut world =
        Simulator::new_with_cache(&bytes, input.path(), compatibility(), modules, None)?;
    fn put(world: &mut Simulator, bytes: &[u8]) -> Result<u32> {
        let ptr = world.call::<u32, u32>("malloc", bytes.len() as u32)?;
        ensure!(ptr != 0, "Allocation failed");
        world.memory.write(&mut world.store, ptr as usize, bytes)?;
        Ok(ptr)
    }
    let mr = put(&mut world, &archive)?;
    let root = put(&mut world, b"/\0")?;
    let first = put(&mut world, b"probe-a\0")?;
    let second = put(&mut world, b"probe-b\0")?;
    let image_name = put(&mut world, b"mprobe.sym\0")?;
    let symbol = put(&mut world, b"ProbeValue\0")?;
    for registration in [first, second] {
        assert_eq!(
            world.call::<(u32, u32, u32), i32>("RegAddReg", (root, mr, registration))?,
            1
        );
    }
    let function = world.call::<(u32, u32), u32>("WebDynamicModuleExport", (image_name, symbol))?;
    let table = world
        .instance
        .get_table(&mut world.store, "__indirect_function_table")
        .unwrap();
    let wasmtime::Ref::Func(Some(probe)) = table.get(&mut world.store, function as u64).unwrap()
    else {
        anyhow::bail!("Missing probe function")
    };
    assert_eq!(
        probe
            .typed::<(), i32>(&world.store)?
            .call(&mut world.store, ())?,
        37
    );
    world.call::<u32, ()>("RegRemoveReg", first)?;
    assert_eq!(
        world.call::<u32, i32>("WebNativeModuleLoaded", image_name)?,
        1
    );
    world.call::<u32, ()>("RegRemoveReg", second)?;
    assert_eq!(
        world.call::<(u32, u32), u32>("WebDynamicModuleExport", (image_name, symbol))?,
        0
    );
    assert_eq!(
        world.call::<(u32, u32, u32), i32>("RegAddReg", (root, mr, first))?,
        1
    );
    assert_ne!(
        world.call::<(u32, u32), u32>("WebDynamicModuleExport", (image_name, symbol))?,
        0
    );
    world.call::<u32, ()>("RegRemoveReg", first)?;
    for ptr in [mr, root, first, second, image_name, symbol] {
        world.call::<u32, ()>("free", ptr)?;
    }
    Ok(())
}

#[test]
fn module_validation_rejects_substitution_and_invalid_memory() -> Result<()> {
    let engine = Engine::default();
    let mut linker = Linker::new(&engine);
    dylink::add_to_linker(&mut linker)?;
    let mut store = Store::new(
        &engine,
        Host {
            wasi: WasiCtxBuilder::new().build_p1(),
            dylink: None,
            module_images: Arc::new(std::collections::BTreeMap::from([(
                "/mr/probe.sym".into(),
                vec![1, 2, 3],
            )])),
        },
    );
    let module = Module::new(
        &engine,
        wat::parse_str(
            r#"(module
      (import "env" "rm4_validate_module" (func $validate (param i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "/mr/probe.sym\00")
      (data (i32.const 32) "\01\02\03\04")
      (func (export "validate") (param i32 i32 i32)
        local.get 0 local.get 1 local.get 2 call $validate))"#,
        )?,
    )?;
    let instance = linker.instantiate(&mut store, &module)?;
    let validate = instance.get_typed_func::<(u32, u32, u32), ()>(&mut store, "validate")?;
    validate.call(&mut store, (0, 32, 3))?;
    let error = validate.call(&mut store, (0, 33, 3)).unwrap_err();
    assert!(format!("{error:#}").contains("differs from prepared resources"));
    for args in [
        (0, 32, 4),
        (0, u32::MAX, 3),
        (0, 65535, 3),
        (u32::MAX, 32, 3),
        (1, 32, 3),
    ] {
        assert!(validate.call(&mut store, args).is_err());
    }
    Ok(())
}
