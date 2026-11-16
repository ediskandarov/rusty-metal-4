//! Emscripten's dynamic-linking ABI on the same WASI store as the C authority.
use super::*;
#[cfg(test)]
use std::borrow::Cow;
use std::collections::BTreeMap;
use wasmtime_dylink::{ArenaRequirements, Metadata, emscripten::Emscripten};
use wasmtime_wasi::p1::WasiP1Ctx;

pub(super) struct Host {
    pub wasi: WasiP1Ctx,
    pub dylink: Option<Emscripten<Host>>,
}

pub(super) fn attach(
    store: &mut Store<Host>,
    instance: Instance,
    linker: Linker<Host>,
    modules: crate::assets::ModuleFiles,
) -> Result<()> {
    let mut requirements = ArenaRequirements::default();
    let mut files = BTreeMap::new();
    for (name, bytes) in modules {
        let metadata = Metadata::parse(&bytes)
            .map_err(|error| anyhow::anyhow!("Reading module metadata {name}: {error:#}"))?;
        requirements.add_module(&metadata)?;
        ensure!(
            files.insert(format!("/modules/{name}"), bytes).is_none(),
            "Duplicate module: {name}"
        );
    }
    // Reserve once through guest malloc so libc and module data cannot overlap.
    // A non-null reservation is required even for modules without static data.
    let base = instance
        .get_typed_func::<u32, u32>(&mut *store, "malloc")?
        .call(&mut *store, requirements.memory_bytes.max(1))?;
    ensure!(base != 0, "Cannot reserve resource-module memory");
    let table = instance
        .get_table(&mut *store, "__indirect_function_table")
        .context("Missing simulation function table")?;
    let table_base = u32::try_from(table.size(&*store))?;
    let adapter = Emscripten::new(
        &mut *store,
        instance,
        linker,
        requirements.at(base, table_base)?,
        move |_, name| {
            files.get(name).map(|bytes| bytes.to_vec()).ok_or_else(|| {
                wasmtime::Error::msg(format!("Module absent from this build: {name}"))
            })
        },
    )?;
    store.data_mut().dylink = Some(adapter);
    Ok(())
}

#[cfg(test)]
pub(super) fn test_modules() -> Result<crate::assets::ModuleFiles> {
    let directory = env::var_os("TM4_MODULE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("TM4_SIMULATION_WASM")
                .map(PathBuf::from)
                .and_then(|path| path.parent().map(|parent| parent.join("modules")))
        })
        .context("Set TM4_MODULE_DIR or TM4_SIMULATION_WASM for resource-module tests")?;
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "wasm") {
            files.push((
                path.file_name()
                    .unwrap()
                    .to_str()
                    .context("Module filename is not UTF-8")?
                    .to_owned(),
                Cow::Owned(fs::read(path)?),
            ));
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    ensure!(!files.is_empty(), "Missing compiled resource modules");
    Ok(files)
}
