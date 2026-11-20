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

Resource modules share the main instance's memory. Browser modules use
`SIDE_MODULE=2`. Cars, maps and simulation modules use `ASYNCIFY=0`; only the
menu and main browser module retain Asyncify for presentation waits.

The MR type-6 handler loads Wasm embedded in the resource entry. A `rm4.module`
custom section identifies the image (for example `o_car.sym`); exports still use
`Tm4ModuleExport` and the original symbol registry. Mod images use the same path,
without a compiled-in module list. `nameModule` in `@tm4/resources/mods/modules`
adds this section to a compiled side module.

Before startup, resource preparation replaces original MIPS entries with the
verified Wasm of the current build. Other encoded records retain their names,
compression and contents. The sector index is rebuilt for the prepared lengths.
Disc uploads and content compatibility are checked before this transformation.
The byte-oriented Rust crate in `packages/mr-preparation` performs the same
transformation in both environments: browser Wasm via `@tm4/mr-preparation`,
and a native dependency on the server. Browser and server adapters only supply
bytes and store the result; the server uses a private temporary runtime copy.
Its `ResourceIndex` also owns `files.tsv` parsing and validation for disc loading,
mod installation and server uploads. Reading or writing an index preserves its
sectors; only explicit repacking relocates files. Callers supply required-file
checks. Unuploaded menu images retain their indexed spans on the server so its
virtual CD layout matches the browser's.
The same crate validates `simulation-build.json` and module bytes through
`BuildManifest`. Browser and authority hashes remain distinct; both targets
check the module's embedded identity against its filename before MR preparation.
TypeScript supplies file/network I/O and calls the Wasm validator.
Build artifacts still contain individual module files for this preparation, but the runtime loads code from MR. `port/web/movie.c` retains
browser-owned movie playback; the original movie code entry is removed.

Module ownership follows MR registrations. Removing the last registration closes
the loader handle and invalidates imported-address caches and snapshot metadata.
Callback addresses come from the defining module's accessor, so loader-created
import trampolines cannot change identity comparisons in snapshots.

The server uses `wasmtime-dylink`'s Emscripten adapter on the existing Wasmtime/WASI
store. Both targets compile with Emscripten; the headless core and server modules
omit Asyncify and threads. The browser retains its presentation runtime.
The host indexes embedded MR modules before initialization and rejects conflicting
bytes under one image name. Browser loading stages those same bytes in `/mr/` for
Emscripten's `dlopen`; Wasmtime resolves that virtual name from the prepared MR
inventory after checking the MR entry against those exact bytes. Replacing an image with different code requires a new runtime instance.
The host reserves their data through guest `malloc` and a separate function-table
range, sized from the complete prepared inventory's `dylink.0` metadata. Loaded images live until the store is dropped;
MR teardown still clears gameplay state and invalidates imported addresses.

`bun run build:mr-preparation` builds the browser preparer; typechecking and
player and server-launcher builds invoke it automatically. `bun run test:mr-preparation` runs its
asset-free native tests; the Bun unit suite exercises the Wasm bindings.

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
Then choose a map from the native simulation catalog, choose 1–8 players and
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
`build/<mode>/server` holds the simulation, `modules/` and compatibility manifest;
`build/<mode>/server-site` holds the launcher and player. The build verifies the
manifest against both client Wasm files and the authority Wasm before separating them.
`bun run server` runs Bun on port 8120 and the Rust API on 8121; Lightyear uses 8122.
Bun serves files and proxies `/api/`. `TM4_HOST_PORT` changes the local website port.

For a single-file API server, run `bun run build:server:standalone` after a full build.
The optimized binary embeds its Wasm simulation, resource modules and compatibility manifest;
archives under `build/server-release/` contain the executable and license.
Run `rustymetal4-server --serve 4` with `TM4_ADMIN_SECRET` set. Serve the separate
frontend with Bun (`bun run server:site --mode release --api http://127.0.0.1:8120 --port 8119`)
or a static host with an API/WebSocket reverse proxy.

Ordinary Cargo builds load `tm4_standalone.wasm`, its adjacent `modules/` directory and `simulation-build.json` beside
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

The dynamic-module browser check runs 300 combat ticks with Orbital and Microblast
and records canonical states for the existing Rust parity/rollback test. It starts
and stops its own local HTTP server and Chrome. With both diagnostic builds ready:

```sh
export TM4_RESOURCE_DIR="$PWD/build/resources"
export TM4_WASM_SITE="$PWD/build/diagnostic/site"
export TM4_SIMULATION_WASM="$PWD/build/diagnostic/authority/site/tm4_standalone.wasm"
export TM4_MODULE_DIR="$PWD/build/diagnostic/authority/site/modules"
export TM4_TEST_RECORD="$PWD/build/checks/simulation-modules.json"
bun run test:simulation:modules
(cd network && cargo test --locked --features rollback_probe --bin tm4-deathmatch-server \
  simulator::tests::browser_parity_local_replay_and_distinct_instance_transfer -- --ignored)
```

For original-AI FFA, choose the human count and explicit **Original AI opponents**
in native administrator setup. Humans and selected opponents share eight places; selecting
none starts a human-only match. Vacancies are never filled automatically. Room hosts can
choose opponents under Free for all settings after loading their disc,
then set the maximum human count and save settings before preparing the server. Bot places
and the human limit share eight slots. Humans can join during play within their limit and reconnect after disconnection. With prepared local resources, for example:

`bun run match 2 --diagnostic --bot "Orbital" --bot "Pizza Boy" --bot "Capt. Grimm"`

Omit `--diagnostic` for dev. The same `TM4_RESOURCE_DIR` and matching simulation
manifest used by ordinary `bun run match` are required. Each human opens the printed
link and readies normally. The supported AI boundary and recovery state are described in
[participant lifecycle](design/participant-lifecycle.md#original-ai-participants).

The focused AI checks use `tests/simulation/ffa-bots.mjs` with `node --test`,
`TM4_SIMULATION_WASM` and `TM4_RESOURCE_DIR`. `TM4_BOT_REFERENCE` writes the one-bot
canonical tape; `TM4_MULTI_BOT_REFERENCE` writes the sparse two-human/three-bot tape.
The corresponding ignored Rust checks are `original_ai_node_wasmtime_replay` and
`multiple_original_ai_node_wasmtime_replay`.
`tests/browser/check_ffa_bots.mjs` takes `TM4_WEB_URL` and a fresh two-human/three-bot
`TM4_MATCH_ENDPOINT`; it checks playable clients, delayed input rollback, one human's
reconnect while the other continues, and explicit departures. Its optional
`TM4_BOT_REFERENCE` and `TM4_MULTI_BOT_REFERENCE` comparisons run the same tapes in
browser Wasm. Replay the completed authority journal with `tests/simulation/replay-membership-journal.mjs`
to compare accepted live inputs and all subsystem digests in Node.
Combat placement and obstacle recovery are controlled simulation fixtures; navigation,
weapon choice and driving still execute through the original C AI.

## 200 Challenge hosting

`main` owns the `/200-challenge` page, trusted leaderboard and delivery of an already
built player. Gameplay, expanded car storage, original-menu integration and
`build:challenge` live only on `codex/r361-200-challenge`. Do not merge that branch
wholesale into `main`. Building or deploying the website never compiles the challenge.

The game branch freezes HTML, JavaScript, Wasm, modules and manifests together under
`build/challenge-releases/<sha256>/`. Keep this directory intact when transferring it
to the publishing checkout. Disc resources are excluded. The publisher checks file
hashes, the challenge runtime export and the absence of diagnostic test exports.

Provision the `rm4-challenge-releases` R2 bucket before the first website deployment.
Set bucket-scoped S3 credentials in `TM4_R2_ACCOUNT_ID`, `TM4_R2_ACCESS_KEY_ID` and
`TM4_R2_SECRET_ACCESS_KEY`, then run:

```sh
bun run publish:challenge /path/to/frozen-release
```

Publication creates objects without overwriting existing ones and uploads `release.json`
last. Retrying a partial upload reuses only byte-identical files. It neither creates
cloud resources nor changes the pin. After successful publication, set `buildId` in
`config/challenge-release.json`, then run the ordinary website deployment. The null
pin means unpublished. Subsequent deployments leave R2 files and the selected build intact.

For a local preview, build the website with `bun run build:rustymetal4.com`, then run
`bun run dev:challenge /path/to/frozen-release`. Open
[localhost:8362/200-challenge](http://localhost:8362/200-challenge). This uses local R2
and leaderboard storage under `build/challenge-local-state/`; the release pin is
only overridden for that process. Users supply their own disc files.

The leaderboard stores one completion per browser identity and model, including the
first map, date and challenge version. Display names need not be unique. Results are
trusted; the service validates only the catalog and score rule. A one-year cookie
identifies the driver. Unsent results are not retained after a page reload.

Run `bun test tests/unit/challenge.test.ts` for the service and artifact checks, and
`bun tests/browser/check_200_challenge_page.mjs` against the local preview for the
page, result bridge and identity persistence. Gameplay checks belong to the game branch.

## Browser checks

Run from the repository root. All Chromium scenarios use
`tests/browser/helpers/browser.mjs`: `TM4_CHROME` selects an executable; otherwise
macOS uses installed Chrome when available and other hosts use Playwright Chromium.
Install the latter with `bunx playwright install chromium` if needed. Specialized
scenario flags (timing, audio, background tabs) remain local to their tests.

- `bun run test:player` checks the ordinary player UI: settings, rendering presets,
  control capture/persistence, panel switching and narrow layouts. Point
  `TM4_WEB_URL` at a running dev or release site (default: port 8080). Dev can use
  its configured local disc; for release set `TM4_DISC_DIR` to select a folder.
- `check_loader.mjs` and `check_resources.mjs` use the release folder picker and
  need a local disc (`TM4_DISC_DIR` or `.local/dev.json`). They do not require
  diagnostic exports. Set `TM4_WEB_URL` explicitly for these scenarios.
- Gameplay checks such as `check_controls.mjs`, `check_render_settings.mjs` and
  `check_render_scale.mjs` require `bun run build:diagnostic`. Serve that site's
  directory and pass its URL through `TM4_WEB_URL`. Their shared
  `startDiagnosticGame` rejects ordinary Wasm with a build hint instead of waiting
  for nonexistent game counters. Match scenarios additionally need the server
  fixtures described below.
- `bun tests/browser/check_network_latency.mjs` checks live Lightyear RTT, a 90 ms
  incoming packet delay, stale diagnostics and connection replacement. Set
  `TM4_WEB_URL` to a dev player with local disc resources and `TM4_MATCH_ENDPOINT`
  to a fresh two-player authority. Screenshots go under `build/checks/`. This
  checks a local authority, not Cloudflare latency.
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
FFA respawns after deaths and finishes at its immutable time or frag limit; normal
completion releases the private server and returns members to the same room.
Explicit departure releases seats, and an empty room releases its
private server. FFA always provides eight places, independently of the initial roster
size. During play, a newcomer can load their own disc, select from the explicit startup-prepared model pool and join a free seat;
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
  positions a lethal duel, verifies fresh-car respawn and retained combat results,
  then tests reconnect and explicit all-player departure with private resource cleanup.
  A fresh room and native process exercise a second session. It does not verify deployed
  Cloudflare containers. `check_ffa_completion.mjs` separately uses explicit short limits
  to verify a tied timeout, confirmed client completion, normal results status and cleanup.
  Set `TM4_TEST_END_RECOVERY=1` to reconnect the guest immediately before timeout.
  `bun tests/browser/check_ffa_prediction.mjs` uses the diagnostic bundle to exercise
  forecast membership beyond a provisional end, native correction undoing a projectile's
  frag-limit finish, exact corrected C replay and rejection of invalid identities.
- `TM4_DISC_DIR=<disc folder> bun tests/browser/check_ffa_rematch.mjs`: real native
  authority and local Room/Miniflare with explicit short test limits. Verifies combat,
  respawn, late admission, reconnect, the named authoritative scoreboard after server
  release and a second match in the same pages and loaded runtime. Checks fresh sessions,
  admission credentials, zero initial scores, retained room identities and no surviving
  match process. The server bundle and native binary use the same diagnostic inputs as
  the match browser test; no deployed container is involved.
- `TM4_DISC_DIR=<disc folder> bun tests/browser/check_live_membership.mjs`: four
  independent browsers use ordinary room actions to admit, depart, reuse a seat,
  reject retired credentials and recover the same identity. Reloading a preparing
  iframe after predicted admission verifies cancellation through Lightyear's actual
  rollback schedule, then same-room-member retry with a fresh identity. It uses the same
  native diagnostic bundle and matching website runtime as the match browser test.
  The downloaded journal is `build/room-tests/live-membership.tm4j`;
  `TM4_SIMULATION_WASM=<authority Wasm> TM4_RESOURCE_DIR=<resource root> node
tests/simulation/replay-membership-journal.mjs <journal>` checks every recorded
  subsystem digest in a fresh simulation instance.
  The `check_ffa.mjs` variant adds repeated deaths and rollback/recovery across automatic
  respawn. It writes `build/room-tests/ffa.tm4j`; replay it with
  `TM4_TEST_ACTIONS=build/room-tests/ffa-actions.json` and the same simulation inputs.
- `TM4_DISC_DIR=<disc folder> bun tests/browser/check_tournament_match.mjs`: two original
  engine car menus, all eight campaign maps and bosses, original Continue presentation,
  reconnect during combat and overlay loading, final co-op results, then a second Tournament
  in the same loaded pages through life exhaustion and GAME OVER. Uses the matching diagnostic
  bundle, native binary and website build described above. Native diagnostic checks under
  `simulator::tests::tournament` cover complete map replay, local rollback and portable recovery
  around reinforcements, boss delay/activation, victory, shared-life borrowing and elimination.
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
