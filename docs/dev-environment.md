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

For a single-file server release, first run `bun run build`, then
`bun run build:server:standalone`. The latter embeds the generated server site and
WASI simulation in an optimized Rust binary with symbol tables removed, using
`include_dir!` and `include_bytes!`. It produces a platform archive under `build/server-release/`;
`--mode dev` uses an existing dev bundle for local packaging tests. Bun, Rust,
Wasm runtimes and adjacent asset files are not required on the destination machine.
The archive contains the executable and license; no disc resources are included.

Set `TM4_ADMIN_SECRET` as above and run `tm4-rewired-server` (`.exe` on Windows).
The embedded build opens server mode by default; `--serve 4` sets an initial player
count. `TM4_SERVER_SITE_DIR` and `TM4_SIMULATION_WASM` can override the embedded
files during development. The ordinary Cargo build still loads `site/` and
`tm4_standalone.wasm` beside the executable or from these variables.
`TM4_HTTP_LISTEN` defaults to `127.0.0.1:8120`;
`TM4_MATCH_LISTEN` defaults to `127.0.0.1:8122`. Both require loopback addresses.
Axum serves embedded static bytes directly, including MIME types, HEAD and byte
ranges. External static files retain streaming and metadata-only HEAD requests.
Wasmtime reads the embedded simulation directly; no temporary asset extraction is
needed. Upload validation runs on a blocking worker; setup commands cross to the
native simulation thread. HTTP and Lightyear remain on separate ports.

Only `v*` tags trigger server archive builds, GitHub Releases and Pages publication. CI builds the shared
Web/Wasm bundle once, then builds and tests Linux x64, Windows x64 and macOS ARM64
executables against that exact bundle. After checks pass, it publishes all three
archives and `SHA256SUMS` in a GitHub Release; tags containing `-` produce
prereleases. Pushes to main run formatting, lint, typechecks and unit tests only.
Same-repository pull requests and manual runs on branches also build the Web/Wasm
bundle and run the Pages smoke test, without publishing or building server executables.
Fork pull requests run only the checks, without access to private game sources. The server
serves its bundled player, so updating Pages does not change an older server's client.

`TM4_SERVER_EXECUTABLE=<path> bun run test:server:standalone` copies the executable
to an empty temporary directory and tests its built-in site without a checkout,
external site or game disc. Rust tests with `--features embedded-server` require
`TM4_SERVER_BUNDLE` to point at the generated bundle; they also check both Wasm
hashes and validate the embedded simulation with Wasmtime.

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
