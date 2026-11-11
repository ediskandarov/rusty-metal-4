use anyhow::{Context, Result};
use std::{
    borrow::Cow,
    env, fs,
    path::{Path, PathBuf},
};

#[cfg(feature = "embedded-server")]
static SITE: include_dir::Dir<'_> = include_dir::include_dir!("$TM4_SERVER_BUNDLE/site");
#[cfg(feature = "embedded-server")]
static SIMULATION: &[u8] =
    include_bytes!(concat!(env!("TM4_SERVER_BUNDLE"), "/tm4_standalone.wasm"));

#[derive(Clone)]
pub enum Site {
    Directory(PathBuf),
    #[cfg(feature = "embedded-server")]
    Embedded,
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

impl Site {
    pub fn load() -> Result<Self> {
        let site = if let Some(path) = env::var_os("TM4_SERVER_SITE_DIR") {
            Self::Directory(PathBuf::from(path).canonicalize()?)
        } else {
            #[cfg(feature = "embedded-server")]
            {
                Self::Embedded
            }
            #[cfg(not(feature = "embedded-server"))]
            {
                Self::Directory(beside_binary("site")?.canonicalize()
                .context("Build the server site and set TM4_SERVER_SITE_DIR, or place site/ next to the binary")?)
            }
        };
        site.read("index.html")
            .context("Server site index.html missing")?;
        Ok(site)
    }

    pub fn directory(&self) -> Option<&Path> {
        match self {
            Self::Directory(path) => Some(path),
            #[cfg(feature = "embedded-server")]
            Self::Embedded => None,
        }
    }

    pub fn read(&self, path: &str) -> Result<Cow<'static, [u8]>> {
        match self {
            Self::Directory(root) => Ok(Cow::Owned(fs::read(root.join(path))?)),
            #[cfg(feature = "embedded-server")]
            Self::Embedded => Ok(Cow::Borrowed(
                SITE.get_file(path)
                    .with_context(|| format!("Embedded asset missing: {path}"))?
                    .contents(),
            )),
        }
    }
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
}

#[cfg(feature = "embedded-server")]
pub fn response(request: &axum::extract::Request) -> axum::response::Response {
    use axum::{
        body::Body,
        http::{Method, StatusCode, header},
        response::{IntoResponse, Response},
    };
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() || path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path.to_owned()
    };
    let Some(file) = SITE.get_file(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bytes = file.contents();
    let mut status = StatusCode::OK;
    let mut content_range = None;
    let mut body = bytes;
    // HEAD describes the complete representation; multi-range requests fall back to full GET.
    if request.method() == Method::GET && !request.headers().contains_key(header::IF_RANGE) {
        if let Some(range) = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
        {
            if let Ok(parsed) = http_range_header::parse_range_header(range) {
                match parsed.validate(bytes.len() as u64) {
                    Ok(ranges) if ranges.len() == 1 && !bytes.is_empty() => {
                        let start = *ranges[0].start() as usize;
                        let end = *ranges[0].end() as usize;
                        body = &bytes[start..=end];
                        status = StatusCode::PARTIAL_CONTENT;
                        content_range = Some(format!("bytes {start}-{end}/{}", bytes.len()));
                    }
                    Ok(ranges) if ranges.len() > 1 => (),
                    _ => {
                        return Response::builder()
                            .status(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header(header::CONTENT_RANGE, format!("bytes */{}", bytes.len()))
                            .body(Body::empty())
                            .unwrap();
                    }
                }
            }
        }
    }
    let mut response = Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
        )
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::ACCEPT_RANGES, "bytes");
    if let Some(range) = content_range {
        response = response.header(header::CONTENT_RANGE, range);
    }
    response
        .body(if request.method() == Method::HEAD {
            Body::empty()
        } else {
            Body::from(body)
        })
        .unwrap()
}

#[cfg(all(test, feature = "embedded-server"))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn embedded_simulation_and_browser_share_the_manifest() {
        let manifest: serde_json::Value =
            serde_json::from_slice(&Site::Embedded.read("play/simulation-build.json").unwrap())
                .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(SIMULATION)),
            manifest["authoritySha256"]
        );
        let mut browser = Sha256::new();
        browser.update(Site::Embedded.read("play/tm4_web.wasm").unwrap());
        browser.update(
            Site::Embedded
                .read("play/network/tm4_network_bg.wasm")
                .unwrap(),
        );
        assert_eq!(format!("{:x}", browser.finalize()), manifest["sha256"]);
        wasmtime::Module::validate(&wasmtime::Engine::default(), SIMULATION).unwrap();
    }

    #[tokio::test]
    async fn range_responses_use_embedded_bytes_and_head_has_no_body() {
        use axum::{
            body::{Body, to_bytes},
            extract::Request,
            http::{StatusCode, header},
        };
        let path = "/play/tm4_web.wasm";
        let bytes = SITE.get_file("play/tm4_web.wasm").unwrap().contents();
        for (range, expected) in [
            ("bytes=0-3", &bytes[..4]),
            ("bytes=-4", &bytes[bytes.len() - 4..]),
            ("bytes=4-7", &bytes[4..8]),
        ] {
            let request = Request::builder()
                .uri(path)
                .header(header::RANGE, range)
                .body(Body::empty())
                .unwrap();
            let reply = response(&request);
            assert_eq!(reply.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                &to_bytes(reply.into_body(), 16).await.unwrap()[..],
                expected
            );
        }
        let request = Request::builder()
            .method("HEAD")
            .uri(path)
            .header(header::RANGE, "bytes=0-3")
            .body(Body::empty())
            .unwrap();
        let reply = response(&request);
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(
            reply.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert!(to_bytes(reply.into_body(), 0).await.unwrap().is_empty());
    }
}
