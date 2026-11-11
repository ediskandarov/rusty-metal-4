//! Server-owned C/Wasm world. No browser, JavaScript runtime, or simulation subprocess.
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tm4_network::{
    input::Input,
    protocol::{Catalog, Compatibility, RoundState, Score, SessionStart},
};
use wasmtime::{
    Config, Engine, Instance, Linker, Memory, Module, Store, TypedFunc, WasmParams, WasmResults,
};
use wasmtime_wasi::{
    DirPerms, FilePerms, WasiCtxBuilder,
    p1::{self, WasiP1Ctx},
};

const SNAPSHOT_MAX: usize = 256 * 1024;
const EPOCH_INTERVAL: Duration = Duration::from_millis(50);
const LOADING_DEADLINE_EPOCHS: u64 = 900; // The existing 45-second session loading budget.
const CALL_DEADLINE_EPOCHS: u64 = 60; // Preserve the previous authority's three-second tick deadline.

pub struct Simulator {
    store: Store<WasiP1Ctx>,
    instance: Instance,
    memory: Memory,
    stop_clock: Arc<AtomicBool>,
    clock: Option<thread::JoinHandle<()>>,
    deadline_epochs: u64,
    pub compatibility: Compatibility,
    pub catalog: Catalog,
    #[cfg(feature = "rollback_probe")]
    fixture_file: Option<PathBuf>,
    #[cfg(feature = "rollback_probe")]
    loaded_actions: Vec<FixtureAction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Build {
    sha256: String,
    authority_sha256: String,
}
#[derive(Deserialize)]
struct Reference {
    files: Vec<Resource>,
}
#[derive(Deserialize)]
struct Resource {
    id: String,
    size: u64,
    sha256: String,
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn resource_content(directory: &Path) -> Result<String> {
    let reference: Reference = serde_json::from_str(include_str!("../../config/resources.json"))?;
    let mut fingerprints = Vec::new();
    for file in reference.files {
        if !(file.id.ends_with(".MR") || file.id.ends_with(".IMG") || file.id.ends_with(".VAB")) {
            continue;
        }
        let path = directory.join(file.id.trim_start_matches('/'));
        let bytes = fs::read(&path)
            .with_context(|| format!("Reading local resource {}", path.display()))?;
        ensure!(
            bytes.len() as u64 == file.size && hash(&bytes) == file.sha256,
            "Local stock resource differs: {}",
            file.id
        );
        if file.id != "/DATA/MENU.MR" {
            fingerprints.push(format!("{}:{}", file.id, file.sha256));
        }
    }
    fingerprints.sort();
    // The original sector index is needed by the C CD adapter; no host path is exposed.
    let index = fs::read_to_string(directory.join("DATA/files.tsv"))?;
    ensure!(
        !index.is_empty()
            && index.lines().all(|line| {
                let fields: Vec<_> = line.split('\t').collect();
                fields.len() == 3
                    && fields[0].parse::<u32>().is_ok()
                    && fields[1].parse::<u32>().is_ok()
                    && fields[2].starts_with("/DATA/")
                    && !fields[2].contains("..")
            }),
        "Invalid local resource sector index"
    );
    Ok(hash(fingerprints.join("\n")))
}

// Local test tape only. Production builds reject this environment setting.
#[cfg(feature = "rollback_probe")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    cars: Option<Vec<String>>,
    world: Option<String>,
    projectile_target: Option<String>,
    #[serde(default)]
    actions: Vec<FixtureAction>,
}
#[cfg(feature = "rollback_probe")]
#[derive(Clone, Deserialize, PartialEq, Eq)]
struct FixtureAction {
    tick: u32,
    name: String,
    distance: Option<i32>,
}

impl Simulator {
    pub fn from_environment() -> Result<Self> {
        let wasm = PathBuf::from(
            env::var("TM4_SIMULATION_WASM")
                .context("Set TM4_SIMULATION_WASM to the standalone simulation")?,
        );
        let resources = PathBuf::from(
            env::var("TM4_RESOURCE_DIR")
                .context("Set TM4_RESOURCE_DIR to prepared local resources")?,
        );
        let site = PathBuf::from(
            env::var("TM4_SITE_DIR").context("Set TM4_SITE_DIR to the matching browser site")?,
        );
        let build: Build = serde_json::from_slice(&fs::read(site.join("simulation-build.json"))?)?;
        let bytes = fs::read(&wasm)?;
        ensure!(
            hash(&bytes) == build.authority_sha256,
            "Standalone simulation does not match the browser build manifest"
        );
        let mut browser_build = fs::read(site.join("tm4_web.wasm"))?;
        browser_build.extend(fs::read(site.join("network/tm4_network_bg.wasm"))?);
        ensure!(
            hash(browser_build) == build.sha256,
            "Browser simulation build manifest is stale"
        );
        let compatibility = Compatibility {
            protocol: 8,
            build: build.sha256,
            content: resource_content(&resources)?,
        };
        let mut simulator = Self::new(&bytes, &resources, compatibility)?;
        #[cfg(feature = "rollback_probe")]
        {
            simulator.fixture_file = env::var_os("TM4_TEST_ACTIONS").map(PathBuf::from);
        }
        #[cfg(not(feature = "rollback_probe"))]
        ensure!(
            env::var_os("TM4_TEST_ACTIONS").is_none(),
            "TM4_TEST_ACTIONS requires the diagnostic rollback_probe build"
        );
        if let Ok(cars) = env::var("TM4_MATCH_CARS") {
            let selected: Vec<_> = cars.split(',').map(|car| car.trim().to_owned()).collect();
            ensure!(
                !selected.is_empty()
                    && selected.len() <= 8
                    && selected
                        .iter()
                        .all(|car| simulator.catalog.cars.contains(car)),
                "TM4_MATCH_CARS must contain local stock car names"
            );
            let mut ordered = selected.clone();
            ordered.extend(
                simulator
                    .catalog
                    .cars
                    .iter()
                    .filter(|car| !selected.contains(car))
                    .cloned(),
            );
            simulator.catalog.cars = ordered;
        }
        if let Ok(world) = env::var("TM4_MATCH_WORLD") {
            ensure!(
                simulator.catalog.worlds.contains(&world),
                "TM4_MATCH_WORLD must name a local stock map"
            );
            simulator.catalog.worlds.retain(|name| name != &world);
            simulator.catalog.worlds.insert(0, world);
        }
        Ok(simulator)
    }

    pub fn new(bytes: &[u8], resources: &Path, compatibility: Compatibility) -> Result<Self> {
        let mut wasi = WasiCtxBuilder::new();
        wasi.inherit_stdout().inherit_stderr().preopened_dir(
            resources.join("DATA"),
            "/DATA",
            DirPerms::READ,
            FilePerms::READ,
        )?;
        Self::with_wasi(bytes, compatibility, wasi)
    }

    fn with_wasi(
        bytes: &[u8],
        compatibility: Compatibility,
        mut wasi: WasiCtxBuilder,
    ) -> Result<Self> {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config)?;
        let module = Module::new(&engine, bytes)?;
        for import in module.imports() {
            ensure!(
                import.module() == "wasi_snapshot_preview1"
                    && matches!(
                        import.name(),
                        "fd_prestat_get"
                            | "fd_prestat_dir_name"
                            | "path_open"
                            | "fd_close"
                            | "proc_exit"
                            | "fd_write"
                            | "fd_read"
                            | "fd_seek"
                    ),
                "Unsupported simulation import: {}::{}",
                import.module(),
                import.name()
            );
        }
        let mut store = Store::new(&engine, wasi.build_p1());
        store.set_epoch_deadline(LOADING_DEADLINE_EPOCHS);
        let mut linker = Linker::new(&engine);
        p1::add_to_linker_sync(&mut linker, |context| context)?;
        let instance = linker.instantiate(&mut store, &module)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .context("Missing simulation memory")?;
        let stop_clock = Arc::new(AtomicBool::new(false));
        let clock_stop = stop_clock.clone();
        let clock = thread::spawn(move || {
            while !clock_stop.load(Ordering::Relaxed) {
                thread::sleep(EPOCH_INTERVAL);
                engine.increment_epoch();
            }
        });
        let mut result = Self {
            store,
            instance,
            memory,
            stop_clock,
            clock: Some(clock),
            deadline_epochs: LOADING_DEADLINE_EPOCHS,
            compatibility,
            catalog: Catalog {
                cars: Vec::new(),
                worlds: Vec::new(),
            },
            #[cfg(feature = "rollback_probe")]
            fixture_file: None,
            #[cfg(feature = "rollback_probe")]
            loaded_actions: Vec::new(),
        };
        result.call::<(), ()>("_initialize", ())?;
        ensure!(
            result.call::<(), i32>("HeadlessInitialize", ())? == 1,
            "C simulation initialization failed"
        );
        let worlds = result.call::<(), u32>("HeadlessWorldCount", ())?;
        let cars = result.call::<(), u32>("HeadlessCarCount", ())?;
        ensure!(
            worlds > 0 && worlds <= 64 && cars >= 2 && cars <= 64,
            "Invalid simulation catalog"
        );
        for index in 0..worlds {
            let address = result.call::<u32, u32>("HeadlessWorldName", index)?;
            let name = result.string(address)?;
            result.catalog.worlds.push(name);
        }
        for index in 0..cars {
            let address = result.call::<u32, u32>("HeadlessCarName", index)?;
            let name = result.string(address)?;
            result.catalog.cars.push(name);
        }
        Ok(result)
    }

    fn call<P: WasmParams, R: WasmResults>(&mut self, name: &str, args: P) -> Result<R> {
        let function: TypedFunc<P, R> = self.instance.get_typed_func(&mut self.store, name)?;
        self.store.set_epoch_deadline(self.deadline_epochs);
        function
            .call(&mut self.store, args)
            .map_err(|error| anyhow::anyhow!("C simulation call {name}: {error:#}"))
    }
    fn string(&self, address: u32) -> Result<String> {
        ensure!(address != 0, "Missing C string");
        let data = self
            .memory
            .data(&self.store)
            .get(address as usize..)
            .context("Invalid C string address")?;
        let length = data
            .iter()
            .take(4096)
            .position(|&byte| byte == 0)
            .context("Unterminated C string")?;
        Ok(std::str::from_utf8(&data[..length])?.to_owned())
    }
    fn error(&mut self) -> String {
        self.call::<(), u32>("HeadlessError", ())
            .ok()
            .filter(|&p| p != 0)
            .and_then(|p| self.string(p).ok())
            .unwrap_or_else(|| "simulation rejected the operation".into())
    }
    fn with_string<R>(
        &mut self,
        value: &str,
        use_string: impl FnOnce(&mut Self, u32) -> Result<R>,
    ) -> Result<R> {
        let address = self.call::<u32, u32>("malloc", (value.len() + 1) as u32)?;
        ensure!(address != 0, "Simulation string allocation failed");
        let mut bytes = value.as_bytes().to_vec();
        bytes.push(0);
        self.memory
            .write(&mut self.store, address as usize, &bytes)?;
        let result = use_string(self, address);
        self.call::<u32, ()>("free", address)?;
        result
    }
    pub fn start(&mut self, session: &SessionStart) -> Result<(RoundState, bool)> {
        self.deadline_epochs = LOADING_DEADLINE_EPOCHS;
        if session.portable {
            ensure!(
                self.call::<(), i32>("WebNetEnablePortableCheckpoint", ())? == 1,
                "Portable mode rejected"
            );
        }
        for (slot, car) in session.cars.iter().enumerate() {
            let accepted = self.with_string(car, |world, address| {
                world.call::<(i32, u32), i32>("WebNetSelectCar", (slot as i32, address))
            })?;
            ensure!(accepted == 1, "Stock car selection rejected: {car}");
        }
        let world = self.with_string(&session.world, |world, address| {
            world.call::<u32, i32>("WebNetWorldIndex", address)
        })?;
        ensure!(
            world >= 0
                && self.call::<(i32, i32, u32, i32), i32>(
                    "WebNetRequestMatch",
                    (session.players as i32, world, session.seed, -1)
                )? == 1,
            "Match setup rejected"
        );
        let state = self.state()?;
        let portable = if session.portable {
            match self.snapshot() {
                Ok(_) => true,
                Err(error) => {
                    eprintln!("Portable reconnect unavailable: {error:#}");
                    false
                }
            }
        } else {
            false
        };
        self.deadline_epochs = CALL_DEADLINE_EPOCHS;
        Ok((state, portable))
    }
    pub fn prepare_catalog(&mut self) -> Result<()> {
        #[cfg(feature = "rollback_probe")]
        if let Some(path) = &self.fixture_file {
            let fixture: Fixture = serde_json::from_slice(&fs::read(path)?)?;
            if let Some(cars) = fixture.cars {
                ensure!(
                    cars.len() >= 2
                        && cars.len() <= 8
                        && cars.iter().all(|car| self.catalog.cars.contains(car)),
                    "Invalid diagnostic roster"
                );
                let mut ordered = cars.clone();
                ordered.extend(
                    self.catalog
                        .cars
                        .iter()
                        .filter(|car| !cars.contains(car))
                        .cloned(),
                );
                self.catalog.cars = ordered;
            }
            if let Some(world) = fixture.world {
                ensure!(
                    self.catalog.worlds.contains(&world),
                    "Invalid diagnostic map"
                );
                self.catalog.worlds.retain(|name| name != &world);
                self.catalog.worlds.insert(0, world);
            }
        }
        Ok(())
    }

    #[cfg(feature = "rollback_probe")]
    fn apply_fixture(&mut self, tick: u32) -> Result<()> {
        let Some(path) = &self.fixture_file else {
            return Ok(());
        };
        let fixture: Fixture = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            fixture.actions.starts_with(&self.loaded_actions),
            "Diagnostic action tape must only append"
        );
        ensure!(
            fixture.actions[self.loaded_actions.len()..]
                .iter()
                .all(|action| action.tick >= tick),
            "Diagnostic action arrived after its scheduled tick {tick}"
        );
        self.loaded_actions = fixture.actions.clone();
        for action in fixture.actions.iter().filter(|action| action.tick == tick) {
            let (name, argument) = match action.name.as_str() {
                "contact" => ("WebTestPlaceWeaponTarget", 128),
                "target" => ("WebTestPlaceWeaponTarget", action.distance.unwrap_or(500)),
                "duel" => ("WebTestPrepareNetworkDuel", action.distance.unwrap_or(500)),
                "helicopter" => ("WebTestLaunchAtHelicopter", 0),
                "train" => ("WebTestApproachNeonObject", 0),
                "ufo" => ("WebTestApproachNeonObject", 1),
                "coaster" => ("WebTestApproachPathObject", 0),
                "grab" => ("WebTestPlaceAugerTarget", 0),
                "world" => ("WebTestAimAtWeakDestroyable", 0),
                "wall" => ("WebTestAimAtDestroyable", 0),
                name => anyhow::bail!("Unknown diagnostic action {name}"),
            };
            let accepted = match name {
                "WebTestLaunchAtHelicopter"
                | "WebTestPlaceAugerTarget"
                | "WebTestAimAtWeakDestroyable"
                | "WebTestAimAtDestroyable" => self.call::<(), i32>(name, ())?,
                _ => self.call::<i32, i32>(name, argument)?,
            };
            ensure!(
                accepted > 0,
                "Diagnostic action {} rejected at tick {tick}",
                action.name
            );
        }
        if let Some(target) = fixture.projectile_target {
            self.with_string(&target, |world, address| {
                world.call::<u32, i32>("WebTestPlaceProjectileTarget", address)
            })?;
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<()> {
        self.call::<(), ()>("WebNetCancelMatch", ())
    }

    pub fn state(&mut self) -> Result<RoundState> {
        let address = self.call::<(), u32>("HeadlessState", ())?;
        ensure!(address != 0, "{}", self.error());
        let mut bytes = [0; 120];
        self.memory
            .read(&self.store, address as usize, &mut bytes)?;
        let words: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|word| u32::from_le_bytes(word.try_into().unwrap()))
            .collect();
        ensure!(words[1] <= 8, "Invalid C player count");
        let unsupported = if words[29] == 0 {
            None
        } else {
            Some(self.string(words[29])?)
        };
        Ok(RoundState {
            remaining: words[2] as u8,
            winner: words[3] as i8,
            round_finished: words[4] != 0,
            accepts_continue: words[5] != 0,
            next_mode: words[6] as i32,
            digest: words[7],
            sections: words[8..13].try_into().unwrap(),
            unsupported,
            scores: (0..words[1] as usize)
                .map(|slot| Score {
                    wins: words[13 + slot * 2] as i32,
                    losses: words[14 + slot * 2] as i32,
                })
                .collect(),
        })
    }
    pub fn step(&mut self, tick: u32, inputs: &[Input]) -> Result<RoundState> {
        #[cfg(feature = "rollback_probe")]
        self.apply_fixture(tick)?;
        for (slot, input) in inputs.iter().enumerate() {
            ensure!(
                self.call::<(u32, i32, u32, u32, i32), i32>(
                    "WebNetSetInput",
                    (
                        tick,
                        slot as i32,
                        u32::from(input.buttons),
                        input.axes,
                        i32::from(input.analog)
                    )
                )? == 1,
                "Input rejected at tick {tick}, slot {slot}"
            );
        }
        ensure!(
            self.call::<u32, i32>("WebNetQueueTick", tick)? == 1,
            "Tick {tick} rejected"
        );
        self.state()
    }
    pub fn snapshot(&mut self) -> Result<Vec<u8>> {
        let length = self.call::<(), u32>("HeadlessPortableCapture", ())? as usize;
        ensure!(length > 0 && length <= SNAPSHOT_MAX, "{}", self.error());
        let address = self.call::<(), u32>("HeadlessPortableBuffer", ())?;
        let mut bytes = vec![0; length];
        self.memory
            .read(&self.store, address as usize, &mut bytes)?;
        Ok(bytes)
    }
    pub fn restore_portable(&mut self, bytes: &[u8]) -> Result<()> {
        ensure!(
            !bytes.is_empty() && bytes.len() <= SNAPSHOT_MAX,
            "Invalid portable snapshot size"
        );
        let address = self.call::<(), u32>("HeadlessPortableBuffer", ())?;
        self.memory
            .write(&mut self.store, address as usize, bytes)?;
        ensure!(
            self.call::<u32, i32>("HeadlessPortableRestore", bytes.len() as u32)? == 1,
            "{}",
            self.error()
        );
        Ok(())
    }
}
impl Drop for Simulator {
    fn drop(&mut self) {
        self.stop_clock.store(true, Ordering::Relaxed);
        if let Some(clock) = self.clock.take() {
            let _ = clock.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use wasmtime_wasi::p2::pipe::MemoryOutputPipe;

    #[derive(Deserialize)]
    struct Record {
        #[serde(default = "default_world")]
        world: String,
        #[serde(default = "default_seed")]
        seed: u32,
        cars: Vec<String>,
        rows: Vec<Row>,
        tape: Vec<Tape>,
        events: Vec<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct Row {
        tick: u32,
        digest: u32,
        sections: [u32; 5],
        canonical: String,
    }
    #[derive(Deserialize)]
    struct Tape {
        action: Option<(String, i32)>,
        inputs: Vec<Command>,
    }
    #[derive(Deserialize)]
    struct Command {
        buttons: u16,
        #[serde(default)]
        axes: u32,
        #[serde(default)]
        analog: bool,
    }
    fn default_world() -> String {
        "Construction Yard".into()
    }
    fn default_seed() -> u32 {
        12345
    }
    fn paths() -> Result<(Vec<u8>, PathBuf)> {
        Ok((
            fs::read(env::var("TM4_SIMULATION_WASM")?)?,
            PathBuf::from(env::var("TM4_RESOURCE_DIR")?),
        ))
    }
    fn compatibility() -> Compatibility {
        Compatibility {
            protocol: 8,
            build: "local parity test".into(),
            content: "local stock resources".into(),
        }
    }
    fn session() -> SessionStart {
        SessionStart {
            players: 2,
            world: "Construction Yard".into(),
            cars: vec!["Orbital".into(), "Pizza Boy".into()],
            seed: 12345,
            epoch: 1,
            compatibility: compatibility(),
            portable: true,
        }
    }
    fn compare(world: &mut Simulator, row: &Row) -> Result<()> {
        ensure!(
            world.call::<(), u32>("HeadlessTick", ())? == row.tick,
            "Tick differs"
        );
        let state = world.state()?;
        ensure!(
            state.unsupported.is_none(),
            "Unsupported C state: {:?}",
            state.unsupported
        );
        ensure!(
            state.digest == row.digest && state.sections == row.sections,
            "Subsystems differ at {}",
            row.tick
        );
        let length = world.call::<(), u32>("HeadlessCapture", ())?;
        ensure!(length > 0, "Canonical capture refused");
        let address = world.call::<(), u32>("HeadlessCanonical", ())?;
        let mut actual = vec![0; length as usize];
        world
            .memory
            .read(&world.store, address as usize, &mut actual)?;
        ensure!(
            actual == STANDARD.decode(&row.canonical)?,
            "Canonical bytes differ at {}",
            row.tick
        );
        Ok(())
    }
    fn apply(world: &mut Simulator, tick: usize, tape: &Tape) -> Result<()> {
        if let Some((name, value)) = &tape.action {
            let accepted = world.call::<i32, i32>(name.trim_start_matches('_'), *value)?;
            ensure!(accepted != 0, "Fixture {name} rejected at {tick}");
        }
        let inputs: Vec<_> = tape
            .inputs
            .iter()
            .map(|input| Input {
                buttons: input.buttons,
                axes: input.axes,
                analog: input.analog,
            })
            .collect();
        world.step(tick as u32, &inputs)?;
        Ok(())
    }

    #[test]
    #[ignore = "requires the private local resources, diagnostic Wasm, and Bun browser recording"]
    fn browser_parity_local_replay_and_distinct_instance_transfer() -> Result<()> {
        let (bytes, resources) = paths()?;
        let record: Record = serde_json::from_slice(&fs::read(env::var("TM4_TEST_RECORD")?)?)?;
        ensure!(
            record.rows.len() == record.tape.len() + 1 && record.tape.len() >= 300,
            "Incomplete combat tape"
        );
        ensure!(
            !record.events[81]["live"]
                .as_array()
                .context("Missing projectile fixture")?
                .is_empty(),
            "Save must contain a live projectile"
        );
        let mut world = Simulator::new(&bytes, &resources, compatibility())?;
        let setup = SessionStart {
            world: record.world.clone(),
            cars: record.cars.clone(),
            seed: record.seed,
            ..session()
        };
        ensure!(
            world.call::<(), u32>("HeadlessCapture", ())? == 0,
            "Capture before match accepted"
        );
        let (_, portable) = world.start(&setup)?;
        ensure!(portable, "Fixture lacks portable capability");
        compare(&mut world, &record.rows[0])?;
        let mut snapshot = Vec::new();
        for (tick, tape) in record.tape.iter().enumerate() {
            apply(&mut world, tick, tape)?;
            compare(&mut world, &record.rows[tick + 1])?;
            if tick + 1 == 82 {
                ensure!(
                    world.call::<(), u32>("WebNetCaptureLocalCheckpoint", ())? > 0,
                    "Local checkpoint refused"
                );
                snapshot = world.snapshot()?;
            }
        }
        for _ in 0..3 {
            ensure!(
                world.call::<(), i32>("WebNetRestoreLocalCheckpoint", ())? == 1,
                "Local restore refused"
            );
            compare(&mut world, &record.rows[82])?;
            for tick in 82..record.tape.len() {
                apply(&mut world, tick, &record.tape[tick])?;
                compare(&mut world, &record.rows[tick + 1])?;
            }
            ensure!(
                world.call::<(), i32>("WebNetFinishLocalReplay", ())? == 1,
                "Local replay finish refused"
            );
        }
        let mut independent = Simulator::new(&bytes, &resources, compatibility())?;
        independent.start(&setup)?;
        independent.restore_portable(&snapshot)?;
        compare(&mut independent, &record.rows[82])?;
        for tick in 82..record.tape.len() {
            apply(&mut independent, tick, &record.tape[tick])?;
            compare(&mut independent, &record.rows[tick + 1])?;
        }
        independent.call::<(), ()>("WebNetEndReplay", ())?;
        ensure!(
            world.call::<(), u32>("WebGetPresentedFrames", ())? == 0,
            "Server simulation presented a frame"
        );
        world.call::<(), ()>("WebNetCancelMatch", ())?;
        ensure!(
            world.call::<(), u32>("HeadlessCapture", ())? == 0,
            "Capture after teardown accepted"
        );
        eprintln!(
            "PASS {} exact canonical/subsystem comparisons, three local replays, and distinct-instance portable transfer",
            record.rows.len() + 4 * (record.rows.len() - 82)
        );
        Ok(())
    }

    #[test]
    fn altered_stock_resource_is_rejected() -> Result<()> {
        let reference: Reference =
            serde_json::from_str(include_str!("../../config/resources.json"))?;
        let first = reference
            .files
            .iter()
            .find(|file| {
                file.id.ends_with(".MR") || file.id.ends_with(".IMG") || file.id.ends_with(".VAB")
            })
            .unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("tm4-resource-test-{}-{unique}", std::process::id()));
        fs::create_dir(&directory)?;
        let file = directory.join(first.id.trim_start_matches('/'));
        fs::create_dir_all(file.parent().unwrap())?;
        fs::write(&file, [0])?;
        let error = resource_content(&directory).unwrap_err().to_string();
        fs::remove_dir_all(&directory)?;
        ensure!(error.contains("Local stock resource differs"), "{error}");
        Ok(())
    }

    #[test]
    #[ignore = "requires diagnostic Wasm and private stock resources"]
    fn additional_stock_sessions_step_and_capture() -> Result<()> {
        let (bytes, resources) = paths()?;
        let mut world = Simulator::new(&bytes, &resources, compatibility())?;
        for (map, first, second) in [
            ("Construction Yard", "Gen. Warthog", "Minion"),
            ("Neon City", "Orbital", "Pizza Boy"),
            ("The Oil Rig", "Microblast", "Pizza Boy"),
        ] {
            let mut setup = session();
            setup.world = map.into();
            setup.cars = vec![first.into(), second.into()];
            let (_, portable) = world
                .start(&setup)
                .with_context(|| format!("Stock startup {map}/{first}/{second}"))?;
            ensure!(
                portable,
                "Portable startup unavailable for {map}/{first}/{second}"
            );
            for tick in 0..90 {
                let state = world.step(
                    tick,
                    &[
                        Input {
                            buttons: if tick < 60 { 0x40 | 0x8000 } else { 0x2 },
                            axes: 0,
                            analog: false,
                        },
                        Input::default(),
                    ],
                )?;
                ensure!(
                    state.unsupported.is_none(),
                    "Unsupported stock state at {map}/{first}/{tick}: {:?}",
                    state.unsupported
                );
            }
            ensure!(
                !world.snapshot()?.is_empty(),
                "Stock portable capture failed"
            );
            world.finish()?;
        }
        Ok(())
    }

    #[test]
    #[ignore = "requires diagnostic Wasm and private stock resources"]
    fn unsupported_setup_stops_at_tick_zero() -> Result<()> {
        let (bytes, resources) = paths()?;
        let mut world = Simulator::new(&bytes, &resources, compatibility())?;
        let mut invalid = session();
        invalid.world = "Unavailable stock test map".into();
        ensure!(world.start(&invalid).is_err(), "Unknown map accepted");
        ensure!(
            world.call::<(), u32>("HeadlessTick", ())? == 0,
            "Invalid map advanced a tick"
        );
        world.start(&session())?;
        ensure!(
            world.call::<(), i32>("WebTestUnsupportedCarCallback", ())? == 1,
            "Callback fixture rejected"
        );
        ensure!(
            world.state()?.unsupported.as_deref() == Some("car callback state"),
            "Unsupported callback was not diagnosed"
        );
        ensure!(
            world.call::<(), u32>("HeadlessTick", ())? == 0,
            "Unsupported callback advanced a tick"
        );
        world.finish()?;
        Ok(())
    }

    #[test]
    #[ignore = "requires diagnostic Wasm and the private local resource directory"]
    fn missing_host_capabilities_fail_with_operation_and_location() -> Result<()> {
        let (bytes, resources) = paths()?;
        let operations = [
            "EM_ASM",
            "EM_ASM_INT",
            "EM_ASM_DOUBLE",
            "headless_required_js",
            "emscripten_get_now",
            "emscripten_set_interval",
            "emscripten_sleep",
            "emscripten_set_main_loop",
            "Psyz_OsNowUs",
        ];
        for (kind, operation) in operations.iter().enumerate() {
            let output = MemoryOutputPipe::new(8192);
            let mut wasi = WasiCtxBuilder::new();
            wasi.stderr(output.clone()).preopened_dir(
                resources.join("DATA"),
                "/DATA",
                DirPerms::READ,
                FilePerms::READ,
            )?;
            let mut world = Simulator::with_wasi(&bytes, compatibility(), wasi)?;
            ensure!(
                world
                    .call::<i32, i32>("HeadlessTestRequiredHost", kind as i32)
                    .is_err(),
                "{operation} silently returned"
            );
            let diagnostics = String::from_utf8(output.contents().to_vec())?;
            ensure!(
                diagnostics.contains(&format!(
                    "Required host capability unavailable: {operation} at "
                )),
                "Missing operation/source diagnostic: {diagnostics}"
            );
        }
        Ok(())
    }
}
