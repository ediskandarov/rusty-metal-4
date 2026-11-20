//! Filesystem adapter for the shared, byte-oriented MR preparer.
use super::*;
use rm4_mr_preparation::Preparation;
use std::borrow::Cow;

pub(super) fn resources(
    source: &Path,
    modules: crate::assets::ModuleFiles,
) -> Result<(tempfile::TempDir, crate::assets::ModuleFiles)> {
    let mut preparation = Preparation::new(&fs::read_to_string(source.join("DATA/files.tsv"))?)?;
    for (name, bytes) in modules {
        let id = name
            .strip_suffix(".wasm")
            .context("Invalid module filename")?;
        preparation.add_module(&format!("{id}.sym"), bytes.into_owned())?;
    }
    let directory = tempfile::Builder::new()
        .prefix("rustymetal4-runtime-")
        .tempdir()?;
    fs::create_dir(directory.path().join("DATA"))?;
    for path in preparation.paths().to_vec() {
        let name = &path[1..];
        let src = source.join(name);
        let dst = directory.path().join(name);
        fs::create_dir_all(dst.parent().context("Missing destination parent")?)?;
        let size = if name.ends_with(".MR") {
            let prepared = preparation
                .archive(&fs::read(&src)?)
                .with_context(|| format!("Preparing {name}"))?;
            fs::write(&dst, &prepared)?;
            prepared.len() as u64
        } else {
            if fs::hard_link(&src, &dst).is_err() {
                fs::copy(&src, &dst)?;
            }
            fs::metadata(&dst)?.len()
        };
        preparation.set_size(&path, size)?;
    }
    fs::write(
        directory.path().join("DATA/files.tsv"),
        preparation.index()?,
    )?;
    let modules = preparation
        .into_modules()
        .into_iter()
        .map(|(name, bytes)| (name.replace(".sym", ".wasm"), Cow::Owned(bytes)))
        .collect();
    Ok((directory, modules))
}
