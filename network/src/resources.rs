//! Validated simulator inputs. No HTTP or gameplay-state ownership.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Component, Path, PathBuf},
};

const SECTOR_INDEX: &str = "/DATA/files.tsv";
const INDEX_LIMIT: usize = 128 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct Resource {
    pub id: String,
    pub size: usize,
    pub sha256: String,
}
#[derive(Deserialize)]
struct Reference {
    files: Vec<Resource>,
}

struct PrivateDirectory(PathBuf);
impl PrivateDirectory {
    fn new() -> Result<Self> {
        let mut random = [0; 16];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("Private directory allocation failed"))?;
        let private = env::temp_dir()
            .canonicalize()?
            .join(format!("tm4-server-{:032x}", u128::from_le_bytes(random)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&private)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&private)?;
        Ok(Self(private))
    }
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct ResourceStore {
    directory: PrivateDirectory,
    manifest: BTreeMap<String, Resource>,
}
impl ResourceStore {
    pub fn stock() -> Result<Self> {
        let reference: Reference =
            serde_json::from_str(include_str!("../../config/resources.json"))?;
        Self::new(
            reference
                .files
                .into_iter()
                .filter(|file| {
                    file.id.ends_with(".MR")
                        || file.id.ends_with(".IMG")
                        || file.id.ends_with(".VAB")
                })
                .collect(),
        )
    }
    pub fn new(files: Vec<Resource>) -> Result<Self> {
        Ok(Self {
            directory: PrivateDirectory::new()?,
            manifest: files
                .into_iter()
                .map(|file| (file.id.clone(), file))
                .collect(),
        })
    }
    pub fn directory(&self) -> &Path {
        &self.directory.0
    }
    pub fn manifest(&self) -> impl Iterator<Item = &Resource> {
        self.manifest.values()
    }
    pub fn required(&self) -> usize {
        self.manifest.len() + 1
    }
    pub fn limit(&self, id: &str) -> Result<usize> {
        if id == SECTOR_INDEX {
            return Ok(INDEX_LIMIT);
        }
        self.manifest
            .get(id)
            .map(|file| file.size)
            .ok_or_else(|| anyhow::anyhow!("Resource is not in the server manifest"))
    }
    // The caller serializes uploads through publication, including cancelled HTTP requests.
    pub fn publish(&self, id: &str, data: &[u8]) -> Result<usize> {
        ensure!(data.len() <= self.limit(id)?, "Unexpected resource size");
        if let Some(file) = self.manifest.get(id) {
            ensure!(
                data.len() == file.size && format!("{:x}", Sha256::digest(data)) == file.sha256,
                "Stock resource checksum differs"
            );
        } else {
            validate_index(data)?;
            let text = std::str::from_utf8(data)?;
            let mut indexed = BTreeMap::new();
            for line in text.lines() {
                let fields: Vec<_> = line.split('\t').collect();
                ensure!(
                    indexed
                        .insert(fields[2], fields[1].parse::<usize>()?)
                        .is_none(),
                    "Duplicate resource sector index entry"
                );
            }
            ensure!(
                self.manifest
                    .values()
                    .all(|file| indexed.get(file.id.as_str()) == Some(&file.size)),
                "Resource sector index must include each required stock file with its exact size"
            );
        }
        let target = self.directory.0.join(id.trim_start_matches('/'));
        fs::create_dir_all(target.parent().unwrap())?;
        let pending = self.directory.0.join("upload.tmp");
        fs::write(&pending, data)?;
        fs::rename(pending, target)?;
        let uploaded = self
            .manifest
            .keys()
            .map(String::as_str)
            .chain(std::iter::once(SECTOR_INDEX))
            .filter(|id| self.directory.0.join(id.trim_start_matches('/')).is_file())
            .count();
        Ok(uploaded)
    }
}

fn validate_index(data: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(data)?;
    ensure!(!text.is_empty(), "Empty resource sector index");
    for line in text.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        ensure!(
            fields.len() == 3
                && fields[0].parse::<u32>().is_ok()
                && fields[1].parse::<u32>().is_ok(),
            "Invalid sector index row"
        );
        let path = fields[2];
        ensure!(
            path.starts_with("/DATA/")
                && !path.contains(['%', '\\'])
                && !path.bytes().any(|byte| byte.is_ascii_control())
                && Path::new(path.trim_start_matches('/'))
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "Invalid sector index path"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const DATA: &[u8] = b"stock fixture";
    fn store() -> ResourceStore {
        ResourceStore::new(vec![Resource {
            id: "/DATA/MAIN.MR".into(),
            size: DATA.len(),
            sha256: format!("{:x}", Sha256::digest(DATA)),
        }])
        .unwrap()
    }

    #[test]
    fn publication_validates_direct_callers_and_preserves_accepted_files_on_error() {
        let store = store();
        assert_eq!(store.required(), 2);
        assert_eq!(store.limit("/DATA/MAIN.MR").unwrap(), DATA.len());
        assert_eq!(store.publish("/DATA/MAIN.MR", DATA).unwrap(), 1);
        assert_eq!(store.publish("/DATA/MAIN.MR", DATA).unwrap(), 1);
        for bad in [
            vec![0; DATA.len()],
            DATA[..3].to_vec(),
            vec![0; DATA.len() + 1],
        ] {
            assert!(store.publish("/DATA/MAIN.MR", &bad).is_err());
            assert_eq!(
                fs::read(store.directory().join("DATA/MAIN.MR")).unwrap(),
                DATA
            );
        }
        let index = format!("10\t{}\t/DATA/MAIN.MR\n", DATA.len());
        assert!(store.publish("/DATA/other.tsv", index.as_bytes()).is_err());
        assert!(!store.directory().join("DATA/other.tsv").exists());
        assert!(
            store
                .publish(SECTOR_INDEX, &vec![b'x'; INDEX_LIMIT + 1])
                .is_err()
        );
        assert_eq!(store.publish(SECTOR_INDEX, index.as_bytes()).unwrap(), 2);
        for bad in [
            format!("10\t{}\t/DATA/MAIN.MR\n", DATA.len() + 1),
            format!("{index}{index}"),
            "10\t1\t/DATA/OTHER.MR\n".into(),
            format!("{index}12\t1\t/DATA/../secret\n"),
        ] {
            assert!(store.publish(SECTOR_INDEX, bad.as_bytes()).is_err());
            assert_eq!(
                fs::read_to_string(store.directory().join("DATA/files.tsv")).unwrap(),
                index
            );
        }
        assert!(!store.directory().join("upload.tmp").exists());
    }

    #[test]
    fn private_inputs_outlive_the_launcher_while_a_publication_still_owns_them() {
        let store = Arc::new(store());
        let directory = store.directory().to_owned();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let publication = store.clone();
        drop(store);
        publication.publish("/DATA/MAIN.MR", DATA).unwrap();
        assert!(directory.join("DATA/MAIN.MR").is_file());
        drop(publication);
        assert!(!directory.exists());
    }

    #[test]
    fn stock_manifest_selects_only_native_simulator_inputs() {
        let store = ResourceStore::stock().unwrap();
        let reference: Reference =
            serde_json::from_str(include_str!("../../config/resources.json")).unwrap();
        for file in reference.files {
            let required =
                file.id.ends_with(".MR") || file.id.ends_with(".IMG") || file.id.ends_with(".VAB");
            assert_eq!(store.limit(&file.id).is_ok(), required, "{}", file.id);
            if required {
                assert_eq!(store.limit(&file.id).unwrap(), file.size);
            }
        }
        assert_eq!(store.required(), store.manifest().count() + 1);
        assert_eq!(store.limit(SECTOR_INDEX).unwrap(), INDEX_LIMIT);
    }
}
