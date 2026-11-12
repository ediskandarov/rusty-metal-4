# Development environment

Run `bun install --frozen-lockfile` once at the repository root. The root commands
(`build`, `build:dev`, `build:diagnostic`, `dev`, `match`, `test`, `fmt`, `lint`
and `typecheck`) cover the workspaces together.

- `apps/player` owns the standalone player's HTML, styles, startup flow, UI and mod persistence.
  Its `build.ts` bundles the app; `tools/build.js` coordinates CMake, the player and Cargo.
- `apps/server` owns the native server's web launcher and private resource setup UI.
  It reuses the disc loader and bundles the existing player under `/play/`.
- `@tm4/resources` provides disc/image loading, compatibility checks and car mod
  formats/installers to both the player and host tools. Its `loader`, `compatibility`
  and `mods` exports use web-standard APIs without DOM or application dependencies.
  Bun-only `host/disc` provides lazy directory sources and streaming identity inspection;
  `host/resources` generates strict stock references and prepares resource directories.
  These functions take input paths, references and destinations explicitly, without
  command-line parsing or logging. Reference generation requires full stock track hashes;
  ordinary loading checks resource compatibility and permits supported modifications.
  Reference data in `config/` remains shared with the Rust host and resource tools.
- `@tm4/game-client` provides browser Wasm startup and the network client. The
  player supplies settings initialization and match status presentation through
  callbacks; packages do not reach into the player's UI.

Packages expose TypeScript sources through workspace dependencies and package exports.
The single root lockfile also owns tooling dependencies. C/Wasm remains on CMake,
and Rust remains on Cargo. Public site URLs and output directories are unchanged.
After a full build, `bun run build:player --mode dev` (or `release`/`diagnostic`)
rebuilds just the player against existing runtime artifacts in `build/<mode>/site`.

For the native web launcher, run `bun run build:server --mode dev` after a matching
full build, then set `TM4_ADMIN_SECRET` to a private startup secret of at least 24
characters and run `bun run server 2`. Open `http://127.0.0.1:8120/`, enter that
secret in administrator setup, select your disc folder and prepare resources.
Then choose a map from the native simulation catalog, choose 2–8 players and
open the match. The command-line count supplies the initial selection; opening
the match locks both settings. The browser extracts
the required files; Rust checks exact stock sizes/hashes, validates the sector
index and matching Wasm build, then supplies the available maps. Opening the
match starts the existing Lightyear listener with the chosen settings.
Players open the player link and select their own local disc; their files are
never uploaded. The standalone Pages output in `build/<mode>/site` remains independent
of server APIs. `bun run match` and the Bun development server retain their existing behavior.

`bun run server 2 --mode release` builds and runs Cargo's optimized release binary;
dev uses the debug profile, and diagnostic uses debug with `rollback_probe` enabled.
Use `bun run build:server --mode release` (or `diagnostic`) with the matching runtime
build first. The same mode also selects the binary for `bun run test:server` through
`TM4_SERVER_MODE`.

The Rust executable serves **only the API and match transport**, never a website.
`build/<mode>/server` holds the simulation and compatibility manifest;
`build/<mode>/server-site` holds the launcher and player. The build verifies the
manifest against both client Wasm files and the authority Wasm before separating them.
`bun run server` runs Bun on port 8120 and the Rust API on 8121; Lightyear uses 8122.
Bun serves files and proxies `/api/`. `TM4_HOST_PORT` changes the local website port.

For a single-file API server, run `bun run build:server:standalone` after a full build.
The optimized binary embeds only its own Wasm simulation and compatibility manifest;
archives under `build/server-release/` contain the executable and license.
Run `rustymetal4-server --serve 4` with `TM4_ADMIN_SECRET` set. Serve the separate
frontend with Bun (`bun run server:site --mode release --api http://127.0.0.1:8120 --port 8119`)
or a static host with an API/WebSocket reverse proxy.

Ordinary Cargo builds load `tm4_standalone.wasm` and `simulation-build.json` beside
the binary, or via `TM4_SIMULATION_WASM` and `TM4_SIMULATION_BUILD`.
Native HTTP defaults to `127.0.0.1:8120` and Lightyear to `127.0.0.1:8122`.
Non-loopback listeners require `TM4_BEHIND_PROXY=1` behind an authenticated
HTTPS/WebSocket proxy; that mode advertises `/match` on the website's origin.
Never expose the unencrypted listeners directly.

`TM4_SERVER_EXECUTABLE=<path> bun run test:server:standalone` checks a copied binary
in an empty directory: API access, authentication and absence of static serving.
Rust tests with `--features embedded-server` require `TM4_SERVER_BUNDLE` pointing
at the generated backend bundle and validate the embedded simulation and manifest.

The startup secret is supplied through the environment, never embedded in the
site, URL or logs. Uploaded resources live in an owner-only temporary directory
outside the static tree and are removed on normal exit, SIGINT or SIGTERM.
An uncatchable process kill may leave that private temporary directory behind.

This first slice preserves the existing one-match session: the configured 2–8
slots fill, the roster locks, and eligible participants can reconnect. Status
shows completion or failure; restart the process for the next match. Returning
results to a reusable lobby and map rotation are follow-up work. The Cloudflare test deployment below supplies TLS and admission separately.

With the server bundle and native debug binary built, `bun run test:server`
checks the empty setup state, HTTP isolation, administrator authentication,
invalid upload handling and the browser setup screen. Set `TM4_DISC_DIR` to
your existing disc folder to also exercise the administrator upload UI and two
players reaching native match ticks without uploading player files. Rust unit
tests cover atomic upload publication, index validation, private storage and
the setup/start lock. `bun run test:pages` remains the separate Pages smoke.

## Cloudflare test server

`apps/cloudflare` fronts one named container with HTTPS and WebSocket on the same
origin. Build the release bundle with `bun run build`, set Worker secrets
`TEST_ACCESS_CODE` and `TM4_ADMIN_SECRET` with Wrangler, then run
`bun run --cwd apps/cloudflare deploy`. Worker Assets serves the separate frontend without starting the container.
Only authenticated host setup starts a sleeping server; status polling does not.
Docker cross-compiles a static Linux x64 server into `scratch`, running as UID 65532
with writable `/tmp`. The image contains no website, shell or disc resources.
The image build precompiles its trusted simulation with the same pinned Wasmtime
and baseline CPU target used at runtime. Cranelift remains available for Wasm mods.
`TM4_SIMULATION_PRECOMPILED` accepts only deployment-owned native cache files,
never uploads. Wasm and frontend updates do not invalidate the Rust compilation layer.

The access code admits test players; the separate administrator secret authorizes
resource upload and match setup. Enter each in the browser when prompted. Local
secret files belong in ignored `.local/`. The container uses ¼ vCPU and 256 MiB,
with a five-minute inactivity timeout. An active match keeps it alive; idle launcher polling does not. Sleep discards uploads and the match; the host must prepare it again.

An authenticated `POST /_server/stop` with the administrator Bearer token stops
the container. Preparing resources starts a fresh server. This is one private test lobby, not the public lobby directory.

Application health export and Analytics Engine queries: [server observability](server-observability.md).
