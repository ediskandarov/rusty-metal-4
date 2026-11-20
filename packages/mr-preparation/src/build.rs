use crate::module;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Clone, Copy)]
pub enum ModuleTarget {
    Browser,
    Authority,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModuleBuild {
    name: String,
    sha256: String,
    authority_sha256: String,
}

/// Validated build inventory. Hosts own I/O; module identity and hashes are checked here.
pub struct BuildManifest(ManifestData);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestData {
    sha256: String,
    authority_sha256: String,
    modules: Vec<ModuleBuild>,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn verify_hash(bytes: &[u8], expected: &str) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == expected
}

impl BuildManifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let data: ManifestData = serde_json::from_slice(bytes).context("Invalid build manifest")?;
        ensure!(
            valid_hash(&data.sha256) && valid_hash(&data.authority_sha256),
            "Invalid build hash"
        );
        ensure!(!data.modules.is_empty(), "Missing resource modules");
        let mut names = BTreeSet::new();
        for entry in &data.modules {
            module::module_symbol(&entry.name)?;
            ensure!(
                names.insert(&entry.name),
                "Duplicate module: {}",
                entry.name
            );
            ensure!(
                valid_hash(&entry.sha256) && valid_hash(&entry.authority_sha256),
                "Invalid module hash: {}",
                entry.name
            );
        }
        Ok(Self(data))
    }
    pub fn sha256(&self) -> &str {
        &self.0.sha256
    }
    pub fn authority_sha256(&self) -> &str {
        &self.0.authority_sha256
    }
    pub fn module_names(&self) -> impl Iterator<Item = &str> {
        self.0.modules.iter().map(|entry| entry.name.as_str())
    }
    /// Return the registry identity only after verifying the selected target's bytes.
    pub fn verify_module(&self, name: &str, bytes: &[u8], target: ModuleTarget) -> Result<String> {
        let entry = self
            .0
            .modules
            .iter()
            .find(|entry| entry.name == name)
            .with_context(|| format!("Module absent from build manifest: {name}"))?;
        let expected = match target {
            ModuleTarget::Browser => &entry.sha256,
            ModuleTarget::Authority => &entry.authority_sha256,
        };
        ensure!(
            verify_hash(bytes, expected),
            "Resource module belongs to a different build: {name}"
        );
        let symbol = module::module_symbol(name)?;
        ensure!(
            module::identity(bytes)? == symbol,
            "Module identity mismatch: {name}"
        );
        Ok(symbol)
    }
    pub fn verify_authority(&self, bytes: &[u8]) -> Result<()> {
        ensure!(
            verify_hash(bytes, &self.0.authority_sha256),
            "Standalone simulation does not match its build manifest"
        );
        Ok(())
    }
}
