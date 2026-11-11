# Development environment

Run `bun install --frozen-lockfile` once at the repository root. The root commands
(`build`, `build:dev`, `build:diagnostic`, `dev`, `match`, `test`, `fmt`, `lint`
and `typecheck`) cover the workspaces together.

- `apps/player` owns the standalone player's HTML, styles, startup flow, UI and mod persistence.
  Its `build.ts` bundles the app; `tools/build.js` coordinates CMake, the player and Cargo.
- `apps/server` owns the native server's web launcher and private resource setup UI.
  It reuses the disc loader and bundles the existing player under `/play/`.
- `@tm4/resources` provides disc/image loading, compatibility checks and car mod
  formats/installers to both the player and host tools. It uses web-standard file,
  fetch and crypto APIs without DOM or application dependencies. Reference data in
  `config/` remains shared with the Rust host and resource tools.
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

The production process is the Rust binary alone: invoke
`tm4-deathmatch-server --serve 2` with the generated server `site/` directory and
`tm4_standalone.wasm` next to it. Alternatively set `TM4_SERVER_SITE_DIR` and
`TM4_SIMULATION_WASM`. `TM4_HTTP_LISTEN` defaults to `127.0.0.1:8120`;
`TM4_MATCH_LISTEN` defaults to `127.0.0.1:8122`. Both require loopback addresses.
Axum/Tokio and tower-http run inside this native process: static files stream from
disk and HEAD reads only metadata. Upload validation and publication run on a
blocking worker; explicit start commands cross to the existing native simulation
thread. HTTP and Lightyear remain on separate ports, with the player following
the endpoint advertised by the server.
The startup secret is supplied through the environment, never embedded in the
site, URL or logs. Uploaded resources live in an owner-only temporary directory
outside the static tree and are removed on normal exit, SIGINT or SIGTERM.
An uncatchable process kill may leave that private temporary directory behind.

This first slice preserves the existing one-match session: the configured 2–8
slots fill, the roster locks, and eligible participants can reconnect. Status
shows completion or failure; restart the process for the next match. Returning
results to a reusable lobby and map rotation are follow-up work. Public hosting,
TLS and non-local admission are not implemented.

With the server bundle and native debug binary built, `bun run test:server`
checks the empty setup state, HTTP isolation, administrator authentication,
invalid upload handling and the browser setup screen. Set `TM4_DISC_DIR` to
your existing disc folder to also exercise the administrator upload UI and two
players reaching native match ticks without uploading player files. Rust unit
tests cover atomic upload publication, index validation, private storage and
the setup/start lock. `bun run test:pages` remains the separate Pages smoke.
