//! MR preparation operates on bytes; hosts own filesystem access and runtime startup.
mod archive;
#[cfg(feature = "web")]
mod bindings;
mod index;
mod module;

use anyhow::{Result, ensure};
use std::collections::BTreeMap;

pub struct Preparation {
    index: index::Index,
    modules: BTreeMap<String, Vec<u8>>,
}
impl Preparation {
    pub fn new(index: &str) -> Result<Self> {
        Ok(Self {
            index: index::Index::new(index)?,
            modules: BTreeMap::new(),
        })
    }
    pub fn paths(&self) -> &[String] {
        &self.index.paths
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
        self.index.set_size(path, size)
    }
    pub fn index(&self) -> Result<String> {
        self.index.render()
    }
    pub fn into_modules(self) -> BTreeMap<String, Vec<u8>> {
        self.modules
    }
}
