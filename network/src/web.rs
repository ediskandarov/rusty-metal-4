//! HTTP launcher. Simulation stays on the native game thread.
use crate::management::{
    Control, MatchSetup, MembershipCommand, Phase, PublishedState, RoomMembership, RosterMember,
    ServerLocation, SetupRequest, SharedState, Status,
};
use crate::resources::{Resource, ResourceStore};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use std::{
    env,
    net::{SocketAddr, TcpListener},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    runtime::Builder,
    sync::Mutex as AsyncMutex,
    time::{sleep, timeout},
};
use tower::limit::ConcurrencyLimitLayer;

use crate::assets::Simulation;
use tm4_network::protocol::MAX_PLAYERS;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartOptions {
    mode: tm4_network::protocol::MatchMode,
    #[serde(default)]
    bots: Vec<String>,
    limits: Option<tm4_network::protocol::FfaLimits>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    roster: Vec<RosterMember>,
    players: usize,
    world: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MembershipOptions {
    session_id: String,
    change: RoomMembership,
}
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

// The proxy owns TLS and admission; never enable this on a directly exposed listener.
pub fn behind_proxy() -> bool {
    env::var("TM4_BEHIND_PROXY").as_deref() == Ok("1")
}

pub struct Launcher {
    pub wasm: Simulation,
    pub control: Control,
    requests: Receiver<SetupRequest>,
    resources: Arc<ResourceStore>,
    http: Option<thread::JoinHandle<()>>,
}
impl Launcher {
    pub fn start(players: usize, endpoint: SocketAddr) -> Result<Self> {
        let listen: SocketAddr = env::var("TM4_HTTP_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:8120".into())
            .parse()?;
        ensure!(
            listen.ip().is_loopback() || behind_proxy(),
            "Non-loopback HTTP requires TM4_BEHIND_PROXY=1 and an authenticated HTTPS proxy"
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
        let wasm = Simulation::load()?;
        let resources = Arc::new(ResourceStore::stock()?);
        let listener = TcpListener::bind(listen)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let signal = stopped.clone();
        ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
        let status = Status {
            location: ServerLocation::from_environment(|name| env::var(name).ok()),
            session_id: None,
            cars: Vec::new(),
            compatibility: None,
            phase: Phase::Setup,
            message: "Administrator: supply your disc resources to prepare a match.".into(),
            players,
            worlds: Vec::new(),
            world: None,
            connected: 0,
            tick: 0,
            endpoint: if behind_proxy() {
                "/match".into()
            } else {
                format!("ws://{endpoint}")
            },
            uploaded: 0,
            required: resources.required(),
        };
        let health = crate::health::Shared::default();
        let journal = crate::journal::SharedExport::default();
        let state = Arc::new(Mutex::new(PublishedState::new(status)));
        let (sender, requests) = mpsc::channel();
        let (membership_sender, membership_receiver) = mpsc::sync_channel(8);
        let membership = Arc::new(Mutex::new(membership_receiver));
        let service = Arc::new(Service {
            secret,
            resources: resources.clone(),
            state: state.clone(),
            health: health.clone(),
            journal: journal.clone(),
            sender,
            membership: membership_sender,
            mutation: Arc::new(AsyncMutex::new(())),
        });
        let http = serve_http(listener, router(service), stopped.clone(), state.clone())?;
        println!("Server launcher: http://{listen}/");
        Ok(Self {
            wasm,
            control: Control {
                stopped,
                state,
                health,
                journal,
                membership,
            },
            requests,
            resources,
            http: Some(http),
        })
    }
    pub fn wait_for_setup(&self) -> Option<SetupRequest> {
        while !self.control.stopped.load(Ordering::Relaxed) {
            match self.requests.recv_timeout(Duration::from_millis(100)) {
                Ok(path) => return Some(path),
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(_) => return None,
            }
        }
        None
    }
    pub fn resource_directory(&self) -> &Path {
        self.resources.directory()
    }
}
impl Drop for Launcher {
    fn drop(&mut self) {
        self.control.stopped.store(true, Ordering::Relaxed);
        if let Some(http) = self.http.take() {
            let _ = http.join();
        }
        // Resources remain alive until HTTP work (including blocking publication) ends.
    }
}

fn serve_http(
    listener: TcpListener,
    router: Router,
    stopped: Arc<AtomicBool>,
    state: SharedState,
) -> Result<thread::JoinHandle<()>> {
    listener.set_nonblocking(true)?;
    let runtime = Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    Ok(thread::spawn(move || {
        runtime.block_on(async {
            let listener =
                tokio::net::TcpListener::from_std(listener).expect("prepared HTTP listener");
            let graceful = stopped.clone();
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                while !graceful.load(Ordering::Relaxed) {
                    sleep(Duration::from_millis(100)).await;
                }
            });
            // Bound shutdown even if an HTTP recipient stops reading.
            let shutdown_deadline = async {
                while !stopped.load(Ordering::Relaxed) {
                    sleep(Duration::from_millis(100)).await;
                }
                sleep(HTTP_TIMEOUT).await;
            };
            tokio::select! {
                result = server => if result.is_err() {
                    state.lock().unwrap().close("HTTP server stopped unexpectedly.");
                    stopped.store(true, Ordering::Relaxed);
                },
                _ = shutdown_deadline => (),
            }
        });
    }))
}

struct Service {
    secret: String,
    resources: Arc<ResourceStore>,
    state: SharedState,
    health: crate::health::Shared,
    journal: crate::journal::SharedExport,
    sender: Sender<SetupRequest>,
    membership: mpsc::SyncSender<MembershipCommand>,
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
    let published = service.state.lock().unwrap();
    let status = &published.status;
    if status.phase.permits_upload() {
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
        .route("/api/metrics", get(metrics))
        .route("/api/system-metrics", get(system_metrics))
        .route("/api/journal", get(journal))
        .route("/api/results", get(results))
        .route("/api/resources", get(manifest))
        .route("/api/resources/{*path}", put(upload))
        .route("/api/prepare", post(prepare))
        .route("/api/start", post(start))
        .route("/api/membership", post(membership))
        .route("/api/membership/status", post(membership_status))
        .route_layer(middleware::from_fn_with_state(
            service.clone(),
            authenticate,
        ));
    Router::new()
        .route("/api/status", get(status))
        .merge(admin)
        .with_state(service)
        .layer(ConcurrencyLimitLayer::new(64))
        .layer(middleware::from_fn(isolation_and_timeout))
}
async fn system_metrics() -> ApiResult {
    let body = tokio::task::spawn_blocking(crate::system_metrics::read)
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "System metrics task failed".into(),
            )
        })?
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error.to_string()))?;
    Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response())
}

async fn results(State(service): State<Arc<Service>>) -> ApiResult {
    let result = service
        .state
        .lock()
        .unwrap()
        .result
        .clone()
        .ok_or((StatusCode::CONFLICT, "No completed match result".into()))?;
    Ok(Json(result).into_response())
}

async fn journal(State(service): State<Arc<Service>>) -> ApiResult {
    let export = service
        .journal
        .lock()
        .unwrap()
        .clone()
        .ok_or((StatusCode::NOT_FOUND, "No match journal yet".into()))?;
    let file = tokio::fs::File::open(&export.path).await.map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Journal unavailable".into(),
        )
    })?;
    // Freeze the complete, flushed prefix: the writer may append while this response streams.
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file.take(export.length)));
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, export.length.to_string()),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=match.tm4j".to_owned(),
            ),
        ],
        body,
    )
        .into_response())
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
    Json(service.state.lock().unwrap().status.clone())
}
async fn metrics(State(service): State<Arc<Service>>) -> Json<crate::health::Snapshot> {
    let status = service.state.lock().unwrap().status.clone();
    Json(
        service
            .health
            .lock()
            .unwrap()
            .snapshot(status.phase.as_str(), status.connected),
    )
}
async fn manifest(State(service): State<Arc<Service>>) -> Json<Vec<Resource>> {
    Json(service.resources.manifest().cloned().collect())
}

async fn upload(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let id = request
        .uri()
        .path()
        .strip_prefix("/api/resources")
        .unwrap_or("")
        .to_owned();
    let limit = service.resources.limit(&id).map_err(invalid)?;
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
async fn prepare(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let _guard = service.mutation.lock().await;
    require_setup(&service)?;
    to_bytes(request.into_body(), 0).await.map_err(invalid)?;
    service
        .state
        .lock()
        .unwrap()
        .begin_prepare()
        .map_err(invalid)?;
    service.send(SetupRequest::Prepare)?;
    Ok((StatusCode::ACCEPTED, "Preparing resources").into_response())
}
async fn membership(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let bytes = to_bytes(request.into_body(), 1024).await.map_err(invalid)?;
    let options: MembershipOptions = serde_json::from_slice(&bytes).map_err(invalid)?;
    membership_command(service, options).await
}

async fn membership_status(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lookup {
        session_id: String,
        credential: String,
    }
    let bytes = to_bytes(request.into_body(), 1024).await.map_err(invalid)?;
    let lookup: Lookup = serde_json::from_slice(&bytes).map_err(invalid)?;
    membership_command(
        service,
        MembershipOptions {
            session_id: lookup.session_id,
            change: RoomMembership::Inspect {
                credential: lookup.credential,
            },
        },
    )
    .await
}

async fn membership_command(service: Arc<Service>, options: MembershipOptions) -> ApiResult {
    {
        let published = service.state.lock().unwrap();
        let status = &published.status;
        if status.phase != Phase::Match
            || status.session_id.as_deref() != Some(options.session_id.as_str())
        {
            return Err((
                StatusCode::CONFLICT,
                "This match is no longer accepting membership changes.".into(),
            ));
        }
    }
    let credential = match &options.change {
        RoomMembership::Admit { credential, .. }
        | RoomMembership::Depart { credential }
        | RoomMembership::Inspect { credential } => credential,
    };
    if credential.len() != 64
        || !credential
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    {
        return Err(invalid("Invalid room membership credential"));
    }
    let (response, receive) = tokio::sync::oneshot::channel();
    service
        .membership
        .try_send(MembershipCommand {
            change: options.change,
            response,
        })
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "The membership queue is busy. Retry shortly.".into(),
            )
        })?;
    match timeout(Duration::from_secs(2), receive).await {
        Ok(Ok(Ok(reply))) => Ok(Json(reply).into_response()),
        Ok(Ok(Err(message))) => Err((StatusCode::CONFLICT, message.into())),
        _ => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Membership preparation did not respond.".into(),
        )),
    }
}

async fn start(State(service): State<Arc<Service>>, request: Request) -> ApiResult {
    let _guard = service.mutation.lock().await;
    if service.state.lock().unwrap().status.phase != Phase::Ready {
        return Err((
            StatusCode::CONFLICT,
            "Prepare resources before opening the match".into(),
        ));
    }
    let bytes = to_bytes(request.into_body(), 8192).await.map_err(invalid)?;
    let options: StartOptions = serde_json::from_slice(&bytes).map_err(invalid)?;
    let limits = options
        .mode
        .validate_start(&tm4_network::modes::StartSettings {
            human_capacity: options.players,
            selected_humans: options.roster.len(),
            bots: options.bots.len(),
            world: &options.world,
            limits: options.limits,
        })
        .map_err(invalid)?;
    if !(1..=MAX_PLAYERS).contains(&options.players) {
        return Err(invalid("Expected a player count from 1 to 8"));
    }
    {
        let mut published = service.state.lock().unwrap();
        let status = &published.status;
        if options.players + options.bots.len() > MAX_PLAYERS
            || options.bots.iter().any(|bot| !status.cars.contains(bot))
        {
            return Err(invalid(
                "Choose available AI models within eight human and AI places.",
            ));
        }
        if !status.worlds.contains(&options.world) {
            return Err(invalid("Choose a map from the server catalog"));
        }
        if options.session_id.is_some() || !options.roster.is_empty() {
            if options.session_id.as_ref().is_none_or(|id| id.len() != 36)
                || !(1..=options.players).contains(&options.roster.len())
                || options.roster.iter().any(|member| {
                    member.credential.len() != 64
                        || !member
                            .credential
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                        || !status.cars.contains(&member.car)
                })
                || options.roster.iter().enumerate().any(|(index, member)| {
                    options.roster[..index]
                        .iter()
                        .any(|other| other.credential == member.credential)
                })
            {
                return Err(invalid("Invalid initial room roster"));
            }
        }
        published
            .begin_start(options.session_id, options.players, options.world.clone())
            .map_err(|message| (StatusCode::CONFLICT, message.into()))?;
    }
    service.send(SetupRequest::Start(MatchSetup {
        mode: options.mode,
        bots: options.bots,
        roster: options.roster,
        limits,
        players: options.players,
        world: options.world,
    }))?;
    Ok((StatusCode::ACCEPTED, "Opening match").into_response())
}
impl Service {
    fn send(&self, request: SetupRequest) -> std::result::Result<(), (StatusCode, String)> {
        self.sender.send(request).map_err(|_| {
            let mut published = self.state.lock().unwrap();
            published.close("Native server is unavailable. Restart the server to try again.");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                published.status.message.clone(),
            )
        })
    }
    fn publish(&self, id: &str, data: &[u8]) -> Result<()> {
        let uploaded = self.resources.publish(id, data)?;
        self.state.lock().unwrap().status.uploaded = uploaded;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::management::MatchResult;
    use axum::body::Bytes;
    use futures_util::stream;
    use sha2::{Digest, Sha256};
    use std::{fs, path::PathBuf};
    use std::{
        future::Future,
        task::{Context as TaskContext, Poll, Waker},
    };
    use tower::ServiceExt;

    const STOCK: &[u8] = b"test stock fixture";
    struct Fixture {
        service: Arc<Service>,
        requests: Receiver<SetupRequest>,
    }
    impl Fixture {
        fn new() -> Self {
            let resource = Resource {
                id: "/DATA/MAIN.MR".into(),
                size: STOCK.len(),
                sha256: format!("{:x}", Sha256::digest(STOCK)),
            };
            let status = Status {
                location: None,
                session_id: None,
                cars: Vec::new(),
                compatibility: None,
                phase: Phase::Setup,
                message: String::new(),
                players: 2,
                worlds: Vec::new(),
                world: None,
                connected: 0,
                tick: 0,
                endpoint: String::new(),
                uploaded: 0,
                required: 2,
            };
            let state = Arc::new(Mutex::new(PublishedState::new(status)));
            let (sender, requests) = mpsc::channel();
            let (membership, _) = mpsc::sync_channel(8);
            let service = Arc::new(Service {
                secret: "test-secret".into(),
                resources: Arc::new(ResourceStore::new(vec![resource]).unwrap()),
                state,
                health: crate::health::Shared::default(),
                journal: crate::journal::SharedExport::default(),
                sender,
                membership,
                mutation: Arc::new(AsyncMutex::new(())),
            });
            Self { service, requests }
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
    async fn journal_download_streams_only_the_published_prefix() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .request("GET", "/api/journal", Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        let path = fixture.service.resources.directory().join("journal.tm4j");
        fs::write(&path, b"committed-unpublished").unwrap();
        *fixture.service.journal.lock().unwrap() = Some(crate::journal::Export { path, length: 9 });
        let response = fixture.request("GET", "/api/journal", Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "9");
        assert_eq!(
            &to_bytes(response.into_body(), 1024).await.unwrap()[..],
            b"committed"
        );
    }

    #[tokio::test]
    async fn administrator_actions_require_the_startup_secret() {
        let fixture = Fixture::new();
        for (method, path) in [
            ("GET", "/api/resources"),
            ("GET", "/api/system-metrics"),
            ("GET", "/api/journal"),
            ("POST", "/api/start"),
            ("POST", "/api/prepare"),
            ("POST", "/api/membership"),
            ("POST", "/api/membership/status"),
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
                .request("POST", "/api/prepare", Body::empty())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert!(fixture.requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn tournament_start_requires_two_humans_and_original_rules() {
        let fixture = Fixture::new();
        {
            let mut published = fixture.service.state.lock().unwrap();
            let status = &mut published.status;
            status.phase = Phase::Ready;
            status.worlds = vec!["Construction Yard".into()];
            status.cars = vec!["Orbital".into()];
        }
        let valid = serde_json::json!({
            "mode": "tournament", "players": 2, "world": "Construction Yard",
            "sessionId": "00000000-0000-4000-8000-000000000000",
            "roster": [
                { "credential": "a".repeat(64), "car": "Orbital" },
                { "credential": "b".repeat(64), "car": "Orbital" }
            ]
        });
        for changes in [
            serde_json::json!({"players":1}),
            serde_json::json!({"world":"Road Rage"}),
            serde_json::json!({"bots":["Orbital"]}),
            serde_json::json!({"limits":{"timeLimitTicks":27000,"fragLimit":20}}),
            serde_json::json!({"roster":[valid["roster"][0].clone()]}),
        ] {
            let mut invalid = valid.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            assert_eq!(
                fixture
                    .request("POST", "/api/start", invalid.to_string())
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
            assert!(fixture.requests.try_recv().is_err());
        }
        assert_eq!(
            fixture
                .request("POST", "/api/start", valid.to_string())
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        let SetupRequest::Start(setup) = fixture.requests.try_recv().unwrap() else {
            panic!("expected startup")
        };
        assert_eq!(setup.mode, tm4_network::protocol::MatchMode::Tournament);
        assert_eq!(setup.limits.time_limit_ticks, 0);
        assert_eq!(setup.limits.frag_limit, 0);
    }

    #[tokio::test]
    async fn explicit_ai_roster_requires_capacity_and_supports_room_setup() {
        let fixture = Fixture::new();
        {
            let mut published = fixture.service.state.lock().unwrap();
            let status = &mut published.status;
            status.phase = Phase::Ready;
            status.worlds = vec!["Construction Yard".into()];
            status.cars = vec!["Orbital".into(), "Pizza Boy".into()];
        }
        let valid = serde_json::json!({
            "players": 2, "bots": ["Orbital", "Pizza Boy", "Orbital"],
            "sessionId": "00000000-0000-4000-8000-000000000000",
            "roster": [{ "credential": "a".repeat(64), "car": "Orbital" }],
            "world": "Construction Yard", "mode":"ffa", "limits": { "timeLimitTicks": 27000, "fragLimit": 20 }
        });
        for changes in [
            serde_json::json!({ "players": 6 }),
            serde_json::json!({ "bots": ["Unknown"] }),
            serde_json::json!({ "bot": "Orbital" }),
        ] {
            let mut invalid = valid.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            assert_eq!(
                fixture
                    .request("POST", "/api/start", invalid.to_string())
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
            assert!(fixture.requests.try_recv().is_err());
            assert_eq!(
                fixture.service.state.lock().unwrap().status.phase,
                Phase::Ready
            );
        }
        assert_eq!(
            fixture
                .request("POST", "/api/start", valid.to_string())
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        let SetupRequest::Start(setup) = fixture.requests.try_recv().unwrap() else {
            panic!("expected startup")
        };
        assert_eq!(setup.players, 2);
        assert_eq!(setup.bots, ["Orbital", "Pizza Boy", "Orbital"]);
    }

    #[tokio::test]
    async fn browser_options_require_ready_catalog_and_lock_after_start() {
        let fixture = Fixture::new();
        let valid = r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":1,"world":"The Oil Rig"}"#;
        assert_eq!(
            fixture.request("POST", "/api/start", valid).await.status(),
            StatusCode::CONFLICT
        );
        fixture.provision().await;
        assert_eq!(
            fixture
                .request("POST", "/api/prepare", Body::empty())
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(fixture.requests.try_recv().unwrap(), SetupRequest::Prepare);
        assert_eq!(
            fixture.request("POST", "/api/start", valid).await.status(),
            StatusCode::CONFLICT
        );
        {
            let mut published = fixture.service.state.lock().unwrap();
            let status = &mut published.status;
            status.worlds = vec!["Construction Yard".into(), "The Oil Rig".into()];
            status.world = Some("Construction Yard".into());
            status.phase = Phase::Ready;
        }
        for body in [
            r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":0,"world":"The Oil Rig"}"#,
            r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":9,"world":"The Oil Rig"}"#,
            r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":2.5,"world":"The Oil Rig"}"#,
            r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":"4","world":"The Oil Rig"}"#,
            r#"{"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players":4,"world":"Invalid map"}"#,
            "{}",
        ] {
            assert_eq!(
                fixture.request("POST", "/api/start", body).await.status(),
                StatusCode::BAD_REQUEST
            );
            assert_eq!(fixture.service.state.lock().unwrap().status.players, 2);
            assert_eq!(
                fixture.service.state.lock().unwrap().status.phase,
                Phase::Ready
            );
            assert!(fixture.requests.try_recv().is_err());
        }
        assert_eq!(
            fixture.request("POST", "/api/start", valid).await.status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(fixture.service.state.lock().unwrap().status.players, 1);
        assert_eq!(
            fixture
                .service
                .state
                .lock()
                .unwrap()
                .status
                .world
                .as_deref(),
            Some("The Oil Rig")
        );
        assert_eq!(
            fixture.requests.try_recv().unwrap(),
            SetupRequest::Start(MatchSetup {
                mode: tm4_network::protocol::MatchMode::Ffa,
                bots: Vec::new(),
                roster: Vec::new(),
                limits: Default::default(),
                players: 1,
                world: "The Oil Rig".into()
            })
        );
        assert_eq!(
            fixture.request("POST", "/api/start", valid).await.status(),
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
        assert!(
            !fixture
                .service
                .resources
                .directory()
                .join("DATA/MAIN.MR")
                .exists()
        );
        assert_eq!(fixture.service.state.lock().unwrap().status.uploaded, 0);
        assert_eq!(
            fixture.service.state.lock().unwrap().status.phase,
            Phase::Setup
        );
        fixture.provision().await;
        assert_eq!(
            fixture
                .request("PUT", path, b"invalid stock data".as_slice())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            fs::read(fixture.service.resources.directory().join("DATA/MAIN.MR")).unwrap(),
            STOCK
        );
        assert!(
            !fixture
                .service
                .resources
                .directory()
                .join("upload.tmp")
                .exists()
        );
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
        assert_eq!(fixture.service.state.lock().unwrap().status.uploaded, 0);
        assert!(
            !fixture
                .service
                .resources
                .directory()
                .join("DATA/MAIN.MR")
                .exists()
        );
    }

    #[tokio::test]
    async fn room_roster_is_capacity_bounded_validated_and_never_exposed_in_status() {
        let fixture = Fixture::new();
        {
            let mut published = fixture.service.state.lock().unwrap();
            let status = &mut published.status;
            status.phase = Phase::Ready;
            status.worlds = vec!["Construction Yard".into()];
            status.cars = vec!["Orbital".into(), "Pizza Boy".into()];
        }
        let roster = vec![
            serde_json::json!({"credential": "a".repeat(64), "car": "Orbital"}),
            serde_json::json!({"credential": "b".repeat(64), "car": "Pizza Boy"}),
        ];
        let valid = serde_json::json!({"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players": 8, "world": "Construction Yard", "sessionId": "12345678-1234-1234-1234-123456789abc", "roster": roster});
        for bad in [
            serde_json::json!({"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players": 2, "world": "Construction Yard", "roster": roster}),
            serde_json::json!({"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players": 1, "world": "Construction Yard", "sessionId": "12345678-1234-1234-1234-123456789abc", "roster": roster}),
            serde_json::json!({"mode":"ffa", "limits":{"timeLimitTicks":27000,"fragLimit":20},"players": 2, "world": "Construction Yard", "sessionId": "12345678-1234-1234-1234-123456789abc", "roster": [roster[0], roster[0]]}),
        ] {
            assert_eq!(
                fixture
                    .request("POST", "/api/start", bad.to_string())
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            fixture
                .request("POST", "/api/start", valid.to_string())
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        let SetupRequest::Start(setup) = fixture.requests.try_recv().unwrap() else {
            panic!("Missing fixed setup")
        };
        assert_eq!(setup.roster.len(), 2);
        assert_eq!(setup.roster[1].car, "Pizza Boy");
        let public = serde_json::to_string(&fixture.service.state.lock().unwrap().status).unwrap();
        assert!(!public.contains(&"a".repeat(64)));
        assert!(!public.contains("credential"));
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
        let start = fixture.request("POST", "/api/prepare", Body::empty());
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
        assert_eq!(fixture.requests.try_recv().unwrap(), SetupRequest::Prepare);
        assert_eq!(
            fixture
                .request("POST", "/api/prepare", Body::empty())
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
        assert_eq!(
            fixture.service.state.lock().unwrap().status.phase,
            Phase::Loading
        );
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
        assert_eq!(fixture.service.state.lock().unwrap().status.uploaded, 0);
    }

    #[tokio::test]
    async fn server_never_serves_web_or_private_files() {
        let fixture = Fixture::new();
        fixture.service.publish("/DATA/MAIN.MR", STOCK).unwrap();
        for path in [
            "/",
            "/play/",
            "/index.html",
            "/style.css",
            "/server.js",
            "/play/tm4_web.wasm",
            "/DATA/MAIN.MR",
            "/../private/DATA/MAIN.MR",
            "/%2e%2e/private/DATA/MAIN.MR",
            "/api/unknown",
        ] {
            for method in ["GET", "HEAD"] {
                assert_eq!(
                    fixture.request(method, path, Body::empty()).await.status(),
                    StatusCode::NOT_FOUND,
                    "{method} {path}"
                );
            }
        }
    }

    #[tokio::test]
    async fn health_snapshot_is_read_only_and_requires_administrator_access() {
        let fixture = Fixture::new();
        let unauthenticated = router(fixture.service.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        fixture
            .service
            .health
            .lock()
            .unwrap()
            .tick(Duration::from_millis(4), Duration::ZERO);
        let response = fixture.request("GET", "/api/metrics", Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(snapshot["schema"], 1);
        assert_eq!(snapshot["phase"], "setup");
        assert_eq!(snapshot["measurements"][0]["value"], 1.0);
        assert!(fixture.requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn final_results_require_admin_authorization_and_a_completed_match() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .request("GET", "/api/results", Body::empty())
                .await
                .status(),
            StatusCode::CONFLICT
        );
        let unauthorized = router(fixture.service.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/results")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        fixture.service.state.lock().unwrap().result = Some(MatchResult {
            session_id: "test-match".into(),
            completion: tm4_network::protocol::MatchCompletion {
                tick: 1,
                reasons: 1,
                winners: 0,
            },
            participants: vec![],
        });
        let response = fixture.request("GET", "/api/results", Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["sessionId"], "test-match");
        assert_eq!(result["completion"]["tick"], 1);
    }

    #[test]
    fn shutdown_joins_http_before_removing_private_uploads() {
        let fixture = Fixture::new();
        fixture.service.publish("/DATA/MAIN.MR", STOCK).unwrap();
        let path = fixture.service.resources.directory().to_owned();
        let stopped = Arc::new(AtomicBool::new(false));
        let state = fixture.service.state.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let http = serve_http(
            listener,
            router(fixture.service.clone()),
            stopped.clone(),
            state.clone(),
        )
        .unwrap();
        let launcher = Launcher {
            wasm: Simulation::File(PathBuf::new()),
            control: Control {
                stopped,
                state,
                health: fixture.service.health.clone(),
                journal: fixture.service.journal.clone(),
                membership: Arc::new(Mutex::new(mpsc::sync_channel(8).1)),
            },
            requests: fixture.requests,
            resources: fixture.service.resources.clone(),
            http: Some(http),
        };
        drop(fixture.service);
        drop(launcher);
        assert!(!path.exists());
    }
}
