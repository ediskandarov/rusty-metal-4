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
    pub module_images: Arc<BTreeMap<String, Vec<u8>>>,
}

pub(super) fn add_to_linker(linker: &mut Linker<Host>) -> Result<()> {
    wasmtime_dylink::emscripten::add_to_linker(linker, |host| &mut host.dylink)?;
    linker.func_wrap(
        "env",
        "rm4_validate_module",
        |mut caller: wasmtime::Caller<'_, Host>,
         path: u32,
         data: u32,
         size: u32|
         -> wasmtime::Result<()> {
            validate_module(&mut caller, path, data, size).map_err(wasmtime::Error::from_anyhow)
        },
    )?;
    Ok(())
}

fn validate_module(
    caller: &mut wasmtime::Caller<'_, Host>,
    path: u32,
    data: u32,
    size: u32,
) -> Result<()> {
    let memory = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .context("Missing module memory")?;
    let memory = memory.data(&caller);
    let name = memory
        .get(path as usize..)
        .context("Invalid module path pointer")?;
    let end = name
        .iter()
        .take(160)
        .position(|&b| b == 0)
        .context("Invalid module path")?;
    let name = std::str::from_utf8(&name[..end])?;
    let expected = caller
        .data()
        .module_images
        .get(name)
        .with_context(|| format!("Module absent from prepared resources: {name}"))?;
    let bytes = memory
        .get(data as usize..)
        .and_then(|tail| tail.get(..size as usize))
        .context("Invalid module byte range")?;
    ensure!(
        bytes == expected,
        "MR module differs from prepared resources: {name}"
    );
    Ok(())
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
            files
                .insert(
                    format!("/mr/{}", rm4_mr_preparation::module_symbol(&name)?),
                    bytes.into_owned()
                )
                .is_none(),
            "Duplicate module: {name}"
        );
    }
    let files = Arc::new(files);
    store.data_mut().module_images = files.clone();
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
