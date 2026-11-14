# Development environment

Run `bun install --frozen-lockfile` once at the repository root.
Its postinstall hook links `build/cargo-cache` to the repository shared
`<git-common-dir>/rm4-cache/cargo`; `bun run setup:cache` repeats only that setup.
Cargo dependencies and intermediates are shared; final binaries stay in each
checkout. Cargo serializes shared builds. The pass-through workspace compiler
wrapper gives each checkout its own crate cache key: without it Cargo can reuse
another branch incorrectly. Do not override `RUSTC_WORKSPACE_WRAPPER` or symlink
an entire build/target directory. Clean shared intermediates only when no checkout
is compiling. CMake outputs remain local; Docker retains its BuildKit cache.
CI uses a single checkout per job and overrides the intermediate directory to the
existing platform-specific target directory retained by the Rust cache action.

The root commands
(`build`, `build:dev`, `build:diagnostic`, `dev`, `match`, `test`, `fmt`, `lint`
and `typecheck`) cover the workspaces together.

- `apps/player` owns the player's Astro pages, UI components, Markdown help, styles
  and browser TypeScript. Its `build.ts` builds the static frontend; `tools/build.js`
  coordinates it with CMake and Cargo.
- `apps/server` owns the Astro server launcher, private resource setup UI and access page.
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
- `@tm4/game-runtime` provides browser Wasm startup and the network client. The
  player supplies settings initialization and match status presentation through
  callbacks; packages do not reach into the player's UI.

Packages expose TypeScript sources through workspace dependencies and package exports.
The single root lockfile also owns tooling dependencies. C/Wasm remains on CMake,
and Rust remains on Cargo. Public site URLs and output directories are unchanged.
After a full build, `bun run build:player --mode dev` (or `release`/`diagnostic`)
rebuilds just the player against existing runtime artifacts in `build/<mode>/site`.

`tools/web/build.ts` builds Astro into a separate intermediate directory before
publishing the generated HTML/CSS/JavaScript alongside the C/Rust artifacts.
Asset links are relative so the same player works at the root, under `/play/`,
and in a Pages repository subpath. Text lives in each app's `src/content/*.md`;
forms and interactive structure live in `src/components/` and `src/pages/`.

`typecheck` checks TypeScript and Astro templates. TypeScript uses the version
supported by Astro's checker. Bun formats the usual sources; `tools/web/format.ts`
formats Astro through its Prettier plugin using the same `bunfig.toml` settings.

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

The standalone launcher remains one match per process: its configured 2–8 initial
slots fill before startup. During an active round, explicit departure frees a seat
for admission from the prepared model pool; authenticated recovery retains an existing
lease. Restart the launcher after completion or failure. The website below supplies
reusable rooms by releasing
each completed match process and allocating a fresh one for the next match.

With the server bundle and native debug binary built, `bun run test:server`
checks the empty setup state, HTTP isolation, administrator authentication,
invalid upload handling and the browser setup screen. Set `TM4_DISC_DIR` to
your existing disc folder to also exercise the administrator upload UI and two
players reaching native match ticks without uploading player files. Rust unit
tests cover atomic upload publication, index validation, private storage and
the setup/start lock. `bun run test:pages` remains the separate Pages smoke.

## Browser checks

Run from the repository root. All Chromium scenarios use
`tests/browser/helpers/browser.cjs`: `TM4_CHROME` selects an executable; otherwise
macOS uses installed Chrome when available and other hosts use Playwright Chromium.
Install the latter with `bunx playwright install chromium` if needed. Specialized
scenario flags (timing, audio, background tabs) remain local to their tests.

- `bun run test:player` checks the ordinary player UI: settings, rendering presets,
  control capture/persistence, panel switching and narrow layouts. Point
  `TM4_WEB_URL` at a running dev or release site (default: port 8080). Dev can use
  its configured local disc; for release set `TM4_DISC_DIR` to select a folder.
- `check_loader.cjs` and `check_resources.cjs` use the release folder picker and
  need a local disc (`TM4_DISC_DIR` or `.local/dev.json`). They do not require
  diagnostic exports. Set `TM4_WEB_URL` explicitly for these scenarios.
- Gameplay checks such as `check_controls.cjs`, `check_render_settings.cjs` and
  `check_render_scale.cjs` require `bun run build:diagnostic`. Serve that site's
  directory and pass its URL through `TM4_WEB_URL`. Their shared
  `startDiagnosticGame` rejects ordinary Wasm with a build hint instead of waiting
  for nonexistent game counters. Match scenarios additionally need the server
  fixtures described below.
- `bun run test:pages` serves its own release site without disc assets and checks
  isolation, subpath loading and runtime initialization; it needs no diagnostic build.

Use `waitForPlayer` for ordinary runtime readiness and `setPanelOpen`/
`closeSettings` for user-visible settings interactions. Do not set DOM `hidden`
flags or `details.open` directly to bypass the gear menu. Screenshots go under
`build/checks`; room scenarios retain `build/room-tests`.

## rustymetal4.com website

`apps/rustymetal4.com` owns the public Astro website and Worker. It is separate
from the native launcher in `apps/server` and standalone player in `apps/player`.
Rooms gather players, choose settings and prepare one match at a time. Browsing
and joining need no disc resources or simulation container. The embedded existing
player reads each participant's own disc. The host explicitly prepares the private
server, then every participant readies and the host starts the actual roster.
Native completion returns everyone to the same room and releases the server. Room
capacity is independent of the initial roster size. During play, a newcomer can load
their own disc, select from the startup-prepared model pool and join a free seat;
explicit room leave schedules native departure. Closing a tab preserves recovery
identity rather than releasing its gameplay seat.

Run `bun run dev:rustymetal4.com` and open [localhost:8787](http://localhost:8787).
This builds only the frontend and runs Wrangler locally, persisting room state
in ignored `build/rustymetal4.com-state/`. The configured `dev.enable_containers: false`
disables local container building; Docker, game builds, secrets and Cloudflare
authentication are unnecessary for this workflow. Enable that development setting
only when working on the retained container infrastructure.

- `bun run build:rustymetal4.com`: into `build/release/rustymetal4.com-site`; bundles
  the existing player when `build/release/site` is available. `TM4_PLAYER_RUNTIME`
  selects another matching runtime directory. Without it, room-only development
  remains available. No disc files are copied.
- `bun test tests/unit/room-state.test.ts`: validation and state transitions.
- `bun run test:room-matches`: state and local Worker authority tests, with a mocked
  native boundary for races, private setup, completion, session isolation and cleanup.
- `bun run test:room-matches:browser`: two independent identities against the real
  native process through local room DOs. Requires a diagnostic server/client bundle,
  the diagnostic native binary, and `TM4_DISC_DIR`. Its existing combat fixture
  positions a lethal duel; normal engine results release the process and a second
  match uses the same room. It does not verify deployed Cloudflare containers.
- `TM4_DISC_DIR=<disc folder> bun tests/browser/check_live_membership.cjs`: four
  independent browsers use ordinary room actions to admit, depart, reuse a seat,
  reject retired credentials and recover the same identity. Reloading a preparing
  iframe after predicted admission verifies cancellation through Lightyear's actual
  rollback schedule, then same-room-member retry with a fresh identity. It uses the same
  native diagnostic bundle and matching website runtime as the match browser test.
  The downloaded journal is `build/room-tests/live-membership.tm4j`;
  `TM4_SIMULATION_WASM=<authority Wasm> TM4_RESOURCE_DIR=<resource root> node
tests/simulation/replay-membership-journal.cjs <journal>` checks every recorded
  subsystem digest in a fresh simulation instance.
- `bun run test:rooms`: real local Worker/SQLite Durable Objects, concurrent
  admission, creation retries, permissions, reconnect/hibernation, host succession,
  directory outages and complete empty-room cleanup. Allow about 90 seconds.
- `bun run test:rooms:browser`: builds the frontend and checks two browser
  identities, reload/tabs, live updates, leave/cleanup, mobile layout and initial
  session/snapshot recovery. Uses system Chrome on macOS; set `TM4_CHROME` elsewhere.
  Screenshots are written under `build/room-tests/`.
- Optional: `bun tools/web/check-room-catalog.ts /path/to/DATA/MAIN.MR` verifies
  map labels against the native registry without adding private inputs to CI.

The existing Worker name `tm4-rewired-test`, domain `rustymetal4.com`, `TestServer`
Durable Object declaration, `SERVER` binding, container image and health dataset
are preserved. The same declarative `exports` map adds SQLite `Room` and
`RoomDirectory` classes; no legacy migration or namespace retirement is introduced.
The website Worker replaces the old access-code/admin UI and its API.
The retained container controller is addressed by room and fresh match session.
It keeps its administrator secret, sizing and telemetry; only host-authorized room
requests reach private setup. Native result status is polled by persisted room
alarms; simulation traffic stays in the existing Lightyear WebSocket transport.

Deployment still prepares the existing release/server bundle and container image:
after installing dependencies, load the Emscripten environment and pinned Rust
toolchain. `bun run deploy:prepare` performs the release build, Pages verification
and focused room checks without publishing. `bun run deploy` then uses Wrangler;
Docker must be running and Wrangler authenticated. GitHub Actions runs tests only.

The retained Dockerfile builds a static Linux x64 server into `scratch`, running
as UID 65532 with private temporary storage. It includes no website or disc files.
Trusted simulation precompilation and native resource setup remain unchanged.
Server health export: [server observability](server-observability.md).
The agreed target lifecycle, resource policy and transport boundary remain in
[Cloudflare architecture](cloudflare-architecture.md).
