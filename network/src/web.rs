//! Loopback HTTP launcher. Simulation stays on the native game thread.
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    net::{SocketAddr, TcpListener},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};
use tokio::{
    runtime::Builder,
    sync::Mutex as AsyncMutex,
    time::{sleep, timeout},
};
use tower::{ServiceExt, limit::ConcurrencyLimitLayer};
use tower_http::services::ServeDir;

use tm4_network::protocol::MAX_PLAYERS;
#[derive(Debug, PartialEq)]
pub struct MatchSetup {
    pub resources: PathBuf,
    pub players: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartOptions {
    players: usize,
}
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: String,
    pub message: String,
    pub players: usize,
    pub connected: usize,
    pub tick: u32,
    pub endpoint: String,
    pub uploaded: usize,
    pub required: usize,
}
#[derive(Clone, Deserialize, Serialize)]
struct Resource {
    id: String,
    size: usize,
    sha256: String,
}
#[derive(Deserialize)]
struct Reference {
    files: Vec<Resource>,
}

struct PrivateDirectory(PathBuf);
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct Launcher {
    pub site: PathBuf,
    pub wasm: PathBuf,
    pub stopped: Arc<AtomicBool>,
    pub status: Arc<Mutex<Status>>,
    requests: Receiver<MatchSetup>,
    _private: PrivateDirectory,
    http: Option<thread::JoinHandle<()>>,
}
impl Launcher {
    pub fn start(players: usize, endpoint: SocketAddr) -> Result<Self> {
        let listen: SocketAddr = env::var("TM4_HTTP_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:8120".into())
            .parse()?;
        ensure!(
            listen.ip().is_loopback(),
            "HTTP setup currently requires a loopback address"
        );
        let secret = env::var("TM4_ADMIN_SECRET").context(
            "Set TM4_ADMIN_SECRET to a private startup secret of at least 24 characters",
        )?;
        ensure!(
            secret.len() >= 24
                && secret.len() <= 256
                && secret.is_ascii()
                && !secret.bytes().any(|c| c.is_ascii_control()),
            "Invalid TM4_ADMIN_SECRET"
        );
        let binary = env::current_exe()?
            .parent()
            .context("Binary directory missing")?
            .to_owned();
        let root = env::var_os("TM4_SERVER_SITE_DIR").map(PathBuf::from).unwrap_or_else(|| binary.join("site")).canonicalize()
            .context("Build the server site and set TM4_SERVER_SITE_DIR, or place site/ next to the binary")?;
        ensure!(
            root.join("index.html").is_file(),
            "Server site index.html missing"
        );
        let site = root.join("play");
        let wasm = env::var_os("TM4_SIMULATION_WASM")
            .map(PathBuf::from)
            .unwrap_or_else(|| binary.join("tm4_standalone.wasm"));
        let reference: Reference =
            serde_json::from_str(include_str!("../../config/resources.json"))?;
        let resources: BTreeMap<_, _> = reference
            .files
            .into_iter()
            .filter(|f| f.id.ends_with(".MR") || f.id.ends_with(".IMG") || f.id.ends_with(".VAB"))
            .map(|f| (f.id.clone(), f))
            .collect();
        let listener = TcpListener::bind(listen)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let signal = stopped.clone();
        ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
        let mut random = [0; 16];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("Private directory allocation failed"))?;
        let private = env::temp_dir()
            .canonicalize()?
            .join(format!("tm4-server-{:032x}", u128::from_le_bytes(random)));
        ensure!(
            !private.starts_with(&root),
            "Static root must not contain private temporary storage"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&private)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&private)?;
        let private = PrivateDirectory(private);
        let status = Arc::new(Mutex::new(Status {
            phase: "setup".into(),
            message: "Administrator: supply your disc resources to prepare a match.".into(),
            players,
            connected: 0,
            tick: 0,
            endpoint: format!("ws://{endpoint}"),
            uploaded: 0,
            required: resources.len() + 1,
        }));
        let (sender, requests) = mpsc::channel();
        let service = Arc::new(Service {
            root,
            private: private.0.clone(),
            secret,
            resources,
            status: status.clone(),
            sender,
            mutation: Arc::new(AsyncMutex::new(())),
        });
        let http = serve_http(listener, router(service), stopped.clone(), status.clone())?;
        println!("Server launcher: http://{listen}/");
        Ok(Self {
            site,
            wasm,
            stopped,
            status,
            requests,
            _private: private,
            http: Some(http),
        })
    }
    pub fn wait_for_setup(&self) -> Option<MatchSetup> {
        while !self.stopped.load(Ordering::Relaxed) {
            match self.requests.recv_timeout(Duration::from_millis(100)) {
                Ok(path) => return Some(path),
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(_) => return None,
            }
        }
        None
    }
    pub fn phase(&self, phase: &str, message: &str) {
        let mut status = self.status.lock().unwrap();
        status.phase = phase.into();
        status.message = message.into();
    }
}
impl Drop for Launcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(http) = self.http.take() {
            let _ = http.join();
        }
        // PrivateDirectory drops only after HTTP work (including blocking publication) ends.
    }
}

fn serve_http(
    listener: TcpListener,
    router: Router,
    stopped: Arc<AtomicBool>,
    status: Arc<Mutex<Status>>,
) -> Result<thread::JoinHandle<()>> {
    listener.set_nonblocking(true)?;
    let runtime = Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    Ok(thread::spawn(move || {
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::from_std(listener).expect("prepared HTTP listener");
            let graceful = stopped.clone();
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                while !graceful.load(Ordering::Relaxed) { sleep(Duration::from_millis(100)).await; }
            });
            // Bound shutdown even if a static response's recipient stops reading.
            let shutdown_deadline = async {
                while !stopped.load(Ordering::Relaxed) { sleep(Duration::from_millis(100)).await; }
                sleep(HTTP_TIMEOUT).await;
            };
            tokio::select! {
                result = server => if result.is_err() {
                    let mut status = status.lock().unwrap();
                    status.phase = "closed".into(); status.message = "HTTP server stopped unexpectedly.".into();
                    stopped.store(true, Ordering::Relaxed);
                },
                _ = shutdown_deadline => (),
            }
        });
    }))
}

struct Service {
    root: PathBuf,
    private: PathBuf,
    secret: String,
    resources: BTreeMap<String, Resource>,
    status: Arc<Mutex<Status>>,
    sender: Sender<MatchSetup>,
    mutation: Arc<AsyncMutex<()>>,
}

type ApiResult = std::result::Result<Response, (StatusCode, String)>;
fn invalid(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}
fn authorized(headers: &HeaderMap, secret: &str) -> bool {
    let expected = format!("Bearer {secret}");
    let actual = headers
        .get(header::AUTHORIZATION)
        .map(HeaderValue::as_bytes)
        .unwrap_or_default();
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn require_setup(service: &Service) -> std::result::Result<(), (StatusCode, String)> {
    let status = service.status.lock().unwrap();
    if status.phase == "setup" || status.phase == "failed" {
        Ok(())
    } else {
        Err((
            StatusCode::CONFLICT,
            "Setup is locked for this match. Restart the server for a new match.".into(),
        ))
    }
}
fn router(service: Arc<Service>) -> Router {
    let admin = Router::new()
        .route("/api/resources", get(manifest))
        .route("/api/resources/{*path}", put(upload))
        .route("/api/start", post(start))
        .route_layer(middleware::from_fn_with_state(
            service.clone(),
            authenticate,
        ));
    Router::new()
        .route("/api/status", get(status))
        .merge(admin)
        .fallback(static_file)
        .with_state(service)
        .layer(ConcurrencyLimitLayer::new(64))
        .layer(middleware::from_fn(isolation_and_timeout))
}
async fn isolation_and_timeout(request: Request, next: Next) -> Response {
    let mut response = match timeout(HTTP_TIMEOUT, next.run(request)).await {
        Ok(response) => response,
        Err(_) => (StatusCode::REQUEST_TIMEOUT, "HTTP request timed out").into_response(),
    };
    for (name, value) in [
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-embedder-policy", "require-corp"),
        ("cross-origin-resource-policy", "same-origin"),
        ("x-content-type-options", "nosniff"),
        ("cache-control", "no-store"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}
async fn authenticate(
    State(service): State<Arc<Service>>,
    request: Request,
    next: Next,
) -> Response {
    if !authorized(request.headers(), &service.secret) {
        return (
            StatusCode::UNAUTHORIZED,
            "Administrator startup secret required",
        )
            .into_response();
    }
    next.run(request).await
}
async fn status(State(service): State<Arc<Service>>) -> Json<Status> {
    Json(service.status.lock().unwrap().clone())
}
async fn manifest(State(service): State<Arc<Service>>) -> Json<Vec<Resource>> {
    Json(service.resources.values().cloned().collect())
}

async fn upload(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let id = request
        .uri()
        .path()
        .strip_prefix("/api/resources")
        .unwrap_or("")
        .to_owned();
    let limit = if id == "/DATA/files.tsv" {
        128 * 1024
    } else {
        service
            .resources
            .get(&id)
            .ok_or_else(|| invalid("Resource is not in the server manifest"))?
            .size
    };
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
        let length: usize = length.to_str().map_err(invalid)?.parse().map_err(invalid)?;
        if length > limit {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Unexpected resource size".into(),
            ));
        }
    }
    // Keep setup/start ordered across body reception, validation and atomic publication.
    let guard = service.mutation.clone().lock_owned().await;
    require_setup(&service)?;
    let bytes = to_bytes(request.into_body(), limit)
        .await
        .map_err(invalid)?;
    tokio::task::spawn_blocking(move || {
        // An HTTP timeout cannot release the lock while publication is still running.
        let _guard = guard;
        service.publish(&id, &bytes).map_err(invalid)?;
        Ok("Validated".into_response())
    })
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Resource validation failed".into(),
        )
    })?
}
async fn start(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let _guard = service.mutation.lock().await;
    require_setup(&service)?;
    let bytes = to_bytes(request.into_body(), 256).await.map_err(invalid)?;
    let players = if bytes.is_empty() {
        service.status.lock().unwrap().players
    } else {
        serde_json::from_slice::<StartOptions>(&bytes)
            .map_err(invalid)?
            .players
    };
    if !(2..=MAX_PLAYERS).contains(&players) {
        return Err(invalid("Expected a player count from 2 to 8"));
    }
    {
        let mut status = service.status.lock().unwrap();
        if status.uploaded != service.resources.len() + 1 {
            return Err(invalid("Upload all server resources before starting"));
        }
        status.players = players;
        status.phase = "loading".into();
        status.message = "Validating resources and preparing the native simulator…".into();
    }
    // The existing main thread owns Wasmtime/Lightyear; HTTP only requests initialization.
    if service
        .sender
        .send(MatchSetup {
            resources: service.private.clone(),
            players,
        })
        .is_err()
    {
        let mut status = service.status.lock().unwrap();
        status.phase = "closed".into();
        status.message = "Native server is unavailable. Restart the server to try again.".into();
        return Err((StatusCode::SERVICE_UNAVAILABLE, status.message.clone()));
    }
    Ok((StatusCode::ACCEPTED, "Preparing match").into_response())
}
impl Service {
    fn publish(&self, id: &str, data: &[u8]) -> Result<()> {
        if let Some(file) = self.resources.get(id) {
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
                self.resources
                    .values()
                    .all(|file| indexed.get(file.id.as_str()) == Some(&file.size)),
                "Resource sector index must include each required stock file with its exact size"
            );
        }
        let target = self.private.join(id.trim_start_matches('/'));
        fs::create_dir_all(target.parent().unwrap())?;
        let pending = self.private.join("upload.tmp");
        fs::write(&pending, data)?;
        fs::rename(pending, target)?;
        let uploaded = self
            .resources
            .keys()
            .map(String::as_str)
            .chain(std::iter::once("/DATA/files.tsv"))
            .filter(|id| self.private.join(id.trim_start_matches('/')).is_file())
            .count();
        self.status.lock().unwrap().uploaded = uploaded;
        Ok(())
    }
}

async fn contained_file(root: &Path, uri: &str) -> Option<PathBuf> {
    // Site paths are generated ASCII; reject escapes, traversal and alternate separators.
    if !uri.starts_with('/')
        || uri.contains(['%', '\\'])
        || uri.bytes().any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    let relative = Path::new(uri.trim_start_matches('/'));
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let mut path = tokio::fs::canonicalize(root.join(relative)).await.ok()?;
    if !path.starts_with(root) {
        return None;
    }
    if tokio::fs::metadata(&path).await.ok()?.is_dir() {
        path = tokio::fs::canonicalize(path.join("index.html"))
            .await
            .ok()?;
    }
    (path.starts_with(root) && tokio::fs::metadata(&path).await.ok()?.is_file()).then_some(path)
}
async fn static_file(State(service): State<Arc<Service>>, mut request: Request) -> Response {
    if request.uri().path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(path) = contained_file(&service.root, request.uri().path()).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Serve the resolved path so an escaping symlink never reaches ServeDir.
    let Some(relative) = path.strip_prefix(&service.root).ok().and_then(Path::to_str) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(uri) = format!("/{relative}").parse::<Uri>() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    *request.uri_mut() = uri;
    ServeDir::new(&service.root)
        .oneshot(request)
        .await
        .unwrap()
        .map(Body::new)
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
    use axum::body::Bytes;
    use futures_util::stream;
    use std::{
        future::Future,
        task::{Context as TaskContext, Poll, Waker},
    };

    const STOCK: &[u8] = b"test stock fixture";
    struct Fixture {
        _directory: PrivateDirectory,
        service: Arc<Service>,
        requests: Receiver<MatchSetup>,
    }
    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 16];
            getrandom::fill(&mut random).unwrap();
            let directory = env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("tm4-web-test-{:032x}", u128::from_le_bytes(random)));
            let root = directory.join("site");
            let private = directory.join("private");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&private).unwrap();
            fs::write(root.join("index.html"), b"launcher").unwrap();
            let resource = Resource {
                id: "/DATA/MAIN.MR".into(),
                size: STOCK.len(),
                sha256: format!("{:x}", Sha256::digest(STOCK)),
            };
            let status = Arc::new(Mutex::new(Status {
                phase: "setup".into(),
                message: String::new(),
                players: 2,
                connected: 0,
                tick: 0,
                endpoint: String::new(),
                uploaded: 0,
                required: 2,
            }));
            let (sender, requests) = mpsc::channel();
            let service = Arc::new(Service {
                root,
                private,
                secret: "test-secret".into(),
                resources: [(resource.id.clone(), resource)].into(),
                status,
                sender,
                mutation: Arc::new(AsyncMutex::new(())),
            });
            Self {
                _directory: PrivateDirectory(directory),
                service,
                requests,
            }
        }
        async fn request(&self, method: &str, path: &str, body: impl Into<Body>) -> Response {
            router(self.service.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header(header::AUTHORIZATION, "Bearer test-secret")
                        .body(body.into())
                        .unwrap(),
                )
                .await
                .unwrap()
        }
        async fn provision(&self) {
            assert_eq!(
                self.request("PUT", "/api/resources/DATA/MAIN.MR", STOCK)
                    .await
                    .status(),
                StatusCode::OK
            );
            let index = format!("10\t{}\t/DATA/MAIN.MR\n", STOCK.len());
            assert_eq!(
                self.request("PUT", "/api/resources/DATA/files.tsv", index)
                    .await
                    .status(),
                StatusCode::OK
            );
        }
    }

    #[tokio::test]
    async fn administrator_actions_require_the_startup_secret() {
        let fixture = Fixture::new();
        for (method, path) in [
            ("GET", "/api/resources"),
            ("POST", "/api/start"),
            ("PUT", "/api/resources/DATA/MAIN.MR"),
        ] {
            let response = router(fixture.service.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                response.headers()["cross-origin-embedder-policy"],
                "require-corp"
            );
        }
        assert_eq!(
            fixture
                .request("GET", "/api/status", Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture
                .request("GET", "/api/resources", Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture
                .request("POST", "/api/start", Body::empty())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert!(fixture.requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn browser_player_count_is_validated_and_carried_to_native_start() {
        let fixture = Fixture::new();
        fixture.provision().await;
        for body in [
            r#"{"players":1}"#,
            r#"{"players":9}"#,
            r#"{"players":2.5}"#,
            r#"{"players":"4"}"#,
            "{}",
        ] {
            assert_eq!(
                fixture.request("POST", "/api/start", body).await.status(),
                StatusCode::BAD_REQUEST
            );
            assert_eq!(fixture.service.status.lock().unwrap().players, 2);
            assert_eq!(fixture.service.status.lock().unwrap().phase, "setup");
            assert!(fixture.requests.try_recv().is_err());
        }
        assert_eq!(
            fixture
                .request("POST", "/api/start", r#"{"players":8}"#)
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(fixture.service.status.lock().unwrap().players, 8);
        assert_eq!(fixture.requests.try_recv().unwrap().players, 8);
        assert_eq!(
            fixture
                .request("POST", "/api/start", r#"{"players":3}"#)
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(fixture.service.status.lock().unwrap().players, 8);
    }
    #[tokio::test]
    async fn invalid_and_partial_uploads_publish_nothing_and_can_retry() {
        let fixture = Fixture::new();
        let path = "/api/resources/DATA/MAIN.MR";
        assert_eq!(
            fixture
                .request("PUT", path, b"invalid stock data".as_slice())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let partial = Body::from_stream(stream::iter([
            Ok(Bytes::from_static(&STOCK[..4])),
            Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "interrupted upload",
            )),
        ]));
        assert_eq!(
            fixture.request("PUT", path, partial).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert!(!fixture.service.private.join("DATA/MAIN.MR").exists());
        assert_eq!(fixture.service.status.lock().unwrap().uploaded, 0);
        assert_eq!(fixture.service.status.lock().unwrap().phase, "setup");
        fixture.provision().await;
        assert_eq!(
            fixture
                .request("PUT", path, b"invalid stock data".as_slice())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            fs::read(fixture.service.private.join("DATA/MAIN.MR")).unwrap(),
            STOCK
        );
        assert!(!fixture.service.private.join("upload.tmp").exists());
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_uploads_time_out_without_holding_the_setup_lock() {
        let fixture = Fixture::new();
        let body = Body::from_stream(stream::pending::<std::io::Result<Bytes>>());
        let response = fixture
            .request("PUT", "/api/resources/DATA/MAIN.MR", body)
            .await;
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert!(fixture.service.mutation.try_lock().is_ok());
        assert_eq!(fixture.service.status.lock().unwrap().uploaded, 0);
        assert!(!fixture.service.private.join("DATA/MAIN.MR").exists());
    }

    #[tokio::test]
    async fn uploads_and_start_are_serialized_and_start_is_sent_once() {
        let fixture = Fixture::new();
        fixture.provision().await;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Bytes>();
        let body = Body::from_stream(stream::once(async {
            receiver.await.map_err(std::io::Error::other)
        }));
        let app = router(fixture.service.clone());
        let upload = tokio::spawn(
            app.oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/resources/DATA/MAIN.MR")
                    .header(header::AUTHORIZATION, "Bearer test-secret")
                    .body(body)
                    .unwrap(),
            ),
        );
        // Wait for the upload to acquire the lock and wait for its body.
        loop {
            if fixture.service.mutation.try_lock().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let start = fixture.request("POST", "/api/start", Body::empty());
        let mut start = std::pin::pin!(start);
        assert!(matches!(
            start
                .as_mut()
                .poll(&mut TaskContext::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert!(fixture.requests.try_recv().is_err());
        sender.send(Bytes::from_static(STOCK)).unwrap();
        assert_eq!(upload.await.unwrap().unwrap().status(), StatusCode::OK);
        assert_eq!(start.await.status(), StatusCode::ACCEPTED);
        assert_eq!(
            fixture.requests.try_recv().unwrap(),
            MatchSetup {
                resources: fixture.service.private.clone(),
                players: 2
            }
        );
        assert_eq!(
            fixture
                .request("POST", "/api/start", Body::empty())
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            fixture
                .request("PUT", "/api/resources/DATA/MAIN.MR", STOCK)
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert!(fixture.requests.try_recv().is_err());
        assert_eq!(fixture.service.status.lock().unwrap().phase, "loading");
    }

    #[tokio::test]
    async fn upload_bounds_and_sector_index_are_checked_before_publication() {
        let fixture = Fixture::new();
        let response = fixture
            .request(
                "PUT",
                "/api/resources/DATA/MAIN.MR",
                vec![0; STOCK.len() + 1],
            )
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        for index in [
            "",
            "23\t120\t/DATA/../secret",
            "23\t120\t/DATA/a\\b",
            "-1\t0\t/DATA/a",
            "1\t1\t/secret",
            "1\t1\t/DATA/MAIN.MR",
        ] {
            assert_eq!(
                fixture
                    .request("PUT", "/api/resources/DATA/files.tsv", index.to_owned())
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(fixture.service.status.lock().unwrap().uploaded, 0);
    }

    #[tokio::test]
    async fn static_paths_and_symlinks_cannot_expose_private_storage() {
        let fixture = Fixture::new();
        fixture.provision().await;
        for path in [
            "/../private/DATA/MAIN.MR",
            "/%2e%2e/private/DATA/MAIN.MR",
            "/foo\\bar",
            "/DATA/MAIN.MR",
            "/api/resources/DATA/MAIN.MR",
        ] {
            let response = fixture.request("GET", path, Body::empty()).await;
            assert!(!response.status().is_success(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                &fixture.service.private,
                fixture.service.root.join("leaked"),
            )
            .unwrap();
            assert_eq!(
                fixture
                    .request("GET", "/leaked/DATA/MAIN.MR", Body::empty())
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            fixture.request("GET", "/", Body::empty()).await.status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn static_head_uses_metadata_and_get_supports_streamed_ranges() {
        let fixture = Fixture::new();
        // A sparse 1 GiB asset makes a regression to reading HEAD bodies conspicuous.
        let file = fs::File::create(fixture.service.root.join("large.wasm")).unwrap();
        file.set_len(1 << 30).unwrap();
        let head = fixture.request("HEAD", "/large.wasm", Body::empty()).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            (1u64 << 30).to_string()
        );
        assert_eq!(head.headers()[header::CONTENT_TYPE], "application/wasm");
        assert_eq!(head.headers()["cross-origin-opener-policy"], "same-origin");
        assert!(to_bytes(head.into_body(), 0).await.unwrap().is_empty());
        let response = router(fixture.service.clone())
            .oneshot(
                Request::builder()
                    .uri("/large.wasm")
                    .header(header::RANGE, "bytes=0-63")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "64");
        assert_eq!(to_bytes(response.into_body(), 64).await.unwrap().len(), 64);
    }

    #[test]
    fn shutdown_joins_http_before_removing_private_uploads() {
        let fixture = Fixture::new();
        fixture.service.publish("/DATA/MAIN.MR", STOCK).unwrap();
        let path = fixture.service.private.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let status = fixture.service.status.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let http = serve_http(
            listener,
            router(fixture.service.clone()),
            stopped.clone(),
            status.clone(),
        )
        .unwrap();
        let launcher = Launcher {
            site: fixture.service.root.clone(),
            wasm: PathBuf::new(),
            stopped,
            status,
            requests: fixture.requests,
            _private: PrivateDirectory(path.clone()),
            http: Some(http),
        };
        drop(launcher);
        assert!(!path.exists());
    }
}
