//! MR preparation operates on bytes; hosts own filesystem access and runtime startup.
mod archive;
#[cfg(feature = "web")]
mod bindings;
mod index;
mod module;

use anyhow::{Result, ensure};
pub use index::{INDEX_LIMIT, ResourceEntry, ResourceIndex};
use std::collections::{BTreeMap, BTreeSet};

pub struct Preparation {
    index: ResourceIndex,
    pending: BTreeSet<String>,
    modules: BTreeMap<String, Vec<u8>>,
}
impl Preparation {
    pub fn new(index: &str) -> Result<Self> {
        Ok(Self::from_index(ResourceIndex::parse(index)?))
    }
    pub fn from_index(index: ResourceIndex) -> Self {
        let pending = index
            .entries()
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        Self {
            index,
            pending,
            modules: BTreeMap::new(),
        }
    }
    pub fn paths(&self) -> Vec<String> {
        self.index
            .entries()
            .iter()
            .map(|entry| entry.path.clone())
            .collect()
    }
    pub fn add_module(&mut self, name: &str, bytes: Vec<u8>) -> Result<()> {
        ensure!(
            module::identity(&bytes)? == name,
            "Module identity mismatch: {name}"
        );
        ensure!(
            !self.modules.contains_key(name),
            "Duplicate module identity: {name}"
        );
        self.modules.insert(name.to_owned(), bytes);
        Ok(())
    }
    pub fn archive(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        archive::archive(bytes, &mut self.modules)
    }
    pub fn set_size(&mut self, path: &str, size: u64) -> Result<()> {
        self.index.set_size(path, size)?;
        self.pending.remove(&path.to_ascii_uppercase());
        Ok(())
    }
    pub fn repacked_index(&self) -> Result<String> {
        ensure!(
            self.pending.is_empty(),
            "Not all indexed resources were prepared"
        );
        let mut index = self.index.clone();
        index.repack(1)?;
        index.to_tsv()
    }
    pub fn into_modules(self) -> BTreeMap<String, Vec<u8>> {
        self.modules
    }
}
