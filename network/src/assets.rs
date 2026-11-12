#[cfg(not(feature = "embedded-server"))]
use anyhow::Context;
use anyhow::{Result, ensure};
use serde::Deserialize;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub authority_sha256: String,
    pub sha256: String,
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
    }
}
