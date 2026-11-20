//! Filesystem adapter for the shared, byte-oriented MR preparer.
use super::*;
use rm4_mr_preparation::{Preparation, ResourceIndex};
use std::borrow::Cow;

pub(super) fn resources(
    source: &Path,
    modules: crate::assets::ModuleFiles,
) -> Result<(tempfile::TempDir, crate::assets::ModuleFiles)> {
    let index = ResourceIndex::parse(&fs::read_to_string(source.join("DATA/files.tsv"))?)?;
    let mut preparation = Preparation::from_index(index.clone());
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
    for entry in index.entries() {
        let path = &entry.path;
        let name = &path[1..];
        let src = source.join(name);
        // Menu images are not uploaded to the headless server. Keep their spans
        // so browser and server repacking produces the same virtual CD layout.
        if name.ends_with(".TIM") && !src.try_exists()? {
            preparation.set_size(path, u64::from(entry.size))?;
            continue;
        }
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
        preparation.set_size(path, size)?;
    }
    fs::write(
        directory.path().join("DATA/files.tsv"),
        preparation.repacked_index()?,
    )?;
    let modules = preparation
        .into_modules()
        .into_iter()
        .map(|(name, bytes)| (name.replace(".sym", ".wasm"), Cow::Owned(bytes)))
        .collect();
    Ok((directory, modules))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_menu_images_keep_the_same_repacked_sectors_as_full_client_resources() -> Result<()> {
        let source = tempfile::tempdir()?;
        fs::create_dir(source.path().join("DATA"))?;
        fs::write(source.path().join("DATA/X.IMG"), b"image")?;
        fs::write(
            source.path().join("DATA/files.tsv"),
            "90\t2049\t/DATA/MENU.TIM\n95\t5\t/DATA/X.IMG\n",
        )?;
        let (server, _) = resources(source.path(), vec![])?;
        fs::write(source.path().join("DATA/MENU.TIM"), vec![0; 2049])?;
        let (client, _) = resources(source.path(), vec![])?;
        let server_index = fs::read_to_string(server.path().join("DATA/files.tsv"))?;
        assert_eq!(server_index, "1\t2049\t/DATA/MENU.TIM\n3\t5\t/DATA/X.IMG\n");
        assert_eq!(
            server_index,
            fs::read_to_string(client.path().join("DATA/files.tsv"))?
        );
        assert!(!server.path().join("DATA/MENU.TIM").exists());
        fs::remove_file(source.path().join("DATA/X.IMG"))?;
        assert!(resources(source.path(), vec![]).is_err());
        Ok(())
    }
}
