#[cfg(not(feature = "embedded-server"))]
use anyhow::Context;
use anyhow::{Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    env, fs,
    path::{Path, PathBuf},
};

#[cfg(feature = "embedded-server")]
static SIMULATION: &[u8] =
    include_bytes!(concat!(env!("TM4_SERVER_BUNDLE"), "/tm4_standalone.wasm"));
#[cfg(feature = "embedded-server")]
static BUILD: &str = include_str!(concat!(env!("TM4_SERVER_BUNDLE"), "/simulation-build.json"));

pub type ModuleFiles = Vec<(String, Cow<'static, [u8]>)>;
#[cfg(feature = "embedded-server")]
static MODULES: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/modules.rs"));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleBuild {
    pub name: String,
    pub authority_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub authority_sha256: String,
    pub sha256: String,
    pub modules: Vec<ModuleBuild>,
}
impl Build {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let build: Self = serde_json::from_slice(bytes)?;
        for value in [&build.authority_sha256, &build.sha256] {
            ensure!(
                value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()),
                "Invalid simulation build identity"
            );
        }
        ensure!(!build.modules.is_empty(), "Missing resource modules");
        let mut names = std::collections::HashSet::new();
        for module in &build.modules {
            ensure!(
                module.name.ends_with(".wasm")
                    && module.name.len() > 5
                    && module
                        .name
                        .strip_suffix(".wasm")
                        .unwrap_or("")
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
                    && names.insert(&module.name),
                "Invalid or duplicate module name"
            );
            ensure!(
                module.authority_sha256.len() == 64
                    && module
                        .authority_sha256
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit()),
                "Invalid module identity"
            );
        }
        Ok(build)
    }
}

pub enum Simulation {
    File(PathBuf),
    #[cfg(feature = "embedded-server")]
    Embedded,
}
#[cfg(not(feature = "embedded-server"))]
fn beside_binary(name: &str) -> Result<PathBuf> {
    Ok(env::current_exe()?
        .parent()
        .context("Binary directory missing")?
        .join(name))
}
impl Simulation {
    pub fn load() -> Result<Self> {
        if let Some(path) = env::var_os("TM4_SIMULATION_WASM") {
            return Ok(Self::File(path.into()));
        }
        #[cfg(feature = "embedded-server")]
        {
            Ok(Self::Embedded)
        }
        #[cfg(not(feature = "embedded-server"))]
        {
            Ok(Self::File(beside_binary("tm4_standalone.wasm")?))
        }
    }
    pub fn read(&self) -> Result<Cow<'static, [u8]>> {
        match self {
            Self::File(path) => Ok(Cow::Owned(fs::read(path)?)),
            #[cfg(feature = "embedded-server")]
            Self::Embedded => Ok(Cow::Borrowed(SIMULATION)),
        }
    }
    pub fn modules(&self, build: &Build) -> Result<ModuleFiles> {
        build
            .modules
            .iter()
            .map(|entry| {
                let bytes = match self {
                    Self::File(path) => Cow::Owned(fs::read(
                        path.parent()
                            .unwrap_or(Path::new("."))
                            .join("modules")
                            .join(&entry.name),
                    )?),
                    #[cfg(feature = "embedded-server")]
                    Self::Embedded => Cow::Borrowed(
                        MODULES
                            .iter()
                            .find(|(name, _)| *name == entry.name)
                            .ok_or_else(|| {
                                anyhow::anyhow!("Embedded module missing: {}", entry.name)
                            })?
                            .1,
                    ),
                };
                ensure!(
                    format!("{:x}", Sha256::digest(&bytes)) == entry.authority_sha256,
                    "Resource module belongs to a different build: {}",
                    entry.name
                );
                Ok((entry.name.clone(), bytes))
            })
            .collect()
    }

    pub fn build(&self) -> Result<Build> {
        if let Some(path) = env::var_os("TM4_SIMULATION_BUILD") {
            return Build::parse(&fs::read(path)?);
        }
        match self {
            Self::File(path) => Build::parse(&fs::read(
                path.parent()
                    .unwrap_or(Path::new("."))
                    .join("simulation-build.json"),
            )?),
            #[cfg(feature = "embedded-server")]
            Self::Embedded => Build::parse(BUILD.as_bytes()),
        }
    }
}

#[cfg(all(test, feature = "embedded-server"))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn embedded_simulation_matches_its_build_identity() {
        let build = Simulation::Embedded.build().unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(SIMULATION)),
            build.authority_sha256
        );
        wasmtime::Module::validate(&wasmtime::Engine::default(), SIMULATION).unwrap();
        assert!(!Simulation::Embedded.modules(&build).unwrap().is_empty());
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn rejects_missing_duplicate_and_path_like_module_names() {
        let value = serde_json::json!({
            "sha256": "a".repeat(64), "authoritySha256": "b".repeat(64),
            "modules": [{"name": "c_toy.wasm", "authoritySha256": "c".repeat(64)}]
        });
        assert!(Build::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
        for name in [
            "../c_toy.wasm",
            "/c_toy.wasm",
            ".wasm",
            "a.wasm.wasm",
            "c_toy.wasm/",
            "",
        ] {
            let mut invalid = value.clone();
            invalid["modules"][0]["name"] = name.into();
            assert!(
                Build::parse(&serde_json::to_vec(&invalid).unwrap()).is_err(),
                "{name}"
            );
        }
        let mut invalid = value.clone();
        invalid["modules"] = serde_json::json!([]);
        assert!(Build::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        invalid["modules"] = serde_json::json!([value["modules"][0], value["modules"][0]]);
        assert!(Build::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }

    #[test]
    fn verifies_module_contents_before_loading() -> Result<()> {
        let root = env::temp_dir().join(format!("rm4-module-identity-{}", std::process::id()));
        fs::create_dir_all(root.join("modules"))?;
        let path = root.join("modules/c_toy.wasm");
        let bytes = b"expected module";
        fs::write(&path, bytes)?;
        let build = Build {
            sha256: "a".repeat(64),
            authority_sha256: "b".repeat(64),
            modules: vec![ModuleBuild {
                name: "c_toy.wasm".into(),
                authority_sha256: format!("{:x}", Sha256::digest(bytes)),
            }],
        };
        let source = Simulation::File(root.join("tm4_standalone.wasm"));
        assert_eq!(source.modules(&build)?[0].1.as_ref(), bytes);
        fs::write(path, b"different build")?;
        assert!(source.modules(&build).is_err());
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
