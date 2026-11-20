#[cfg(not(feature = "embedded-server"))]
use anyhow::Context;
use anyhow::Result;
use rm4_mr_preparation::{BuildManifest, ModuleTarget};
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
    pub fn modules(&self, build: &BuildManifest) -> Result<ModuleFiles> {
        build
            .module_names()
            .map(|name| {
                let bytes = match self {
                    Self::File(path) => Cow::Owned(fs::read(
                        path.parent()
                            .unwrap_or(Path::new("."))
                            .join("modules")
                            .join(name),
                    )?),
                    #[cfg(feature = "embedded-server")]
                    Self::Embedded => Cow::Borrowed(
                        MODULES
                            .iter()
                            .find(|(candidate, _)| *candidate == name)
                            .ok_or_else(|| anyhow::anyhow!("Embedded module missing: {}", name))?
                            .1,
                    ),
                };
                build.verify_module(name, &bytes, ModuleTarget::Authority)?;
                Ok((name.to_owned(), bytes))
            })
            .collect()
    }

    pub fn build(&self) -> Result<BuildManifest> {
        if let Some(path) = env::var_os("TM4_SIMULATION_BUILD") {
            return BuildManifest::parse(&fs::read(path)?);
        }
        match self {
            Self::File(path) => BuildManifest::parse(&fs::read(
                path.parent()
                    .unwrap_or(Path::new("."))
                    .join("simulation-build.json"),
            )?),
            #[cfg(feature = "embedded-server")]
            Self::Embedded => BuildManifest::parse(BUILD.as_bytes()),
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
            build.authority_sha256()
        );
        wasmtime::Module::validate(&wasmtime::Engine::default(), SIMULATION).unwrap();
        assert!(!Simulation::Embedded.modules(&build).unwrap().is_empty());
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    #[ignore = "requires a built authority and its simulation-build.json"]
    fn built_authority_and_all_modules_match_the_shared_manifest() -> Result<()> {
        let source = Simulation::load()?;
        let build = source.build()?;
        build.verify_authority(&source.read()?)?;
        assert_eq!(source.modules(&build)?.len(), build.module_names().count());
        Ok(())
    }

    #[test]
    fn verifies_module_contents_before_loading() -> Result<()> {
        let root = env::temp_dir().join(format!("rm4-module-identity-{}", std::process::id()));
        fs::create_dir_all(root.join("modules"))?;
        let path = root.join("modules/c_toy.wasm");
        let bytes = wat::parse_str("(module (@custom \"rm4.module\" \"c_toy.sym\"))")?;
        fs::write(&path, &bytes)?;
        let build = BuildManifest::parse(&serde_json::to_vec(&serde_json::json!({
            "sha256": "a".repeat(64),
            "authoritySha256": "b".repeat(64),
            "modules": [{"name": "c_toy.wasm", "sha256": "c".repeat(64),
                "authoritySha256": format!("{:x}", Sha256::digest(&bytes))}]
        }))?)?;
        let source = Simulation::File(root.join("tm4_standalone.wasm"));
        assert_eq!(source.modules(&build)?[0].1.as_ref(), bytes.as_slice());
        fs::write(path, b"different build")?;
        assert!(source.modules(&build).is_err());
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
