# Development environment

Run `bun install --frozen-lockfile` once at the repository root. The root commands
(`build`, `build:dev`, `build:diagnostic`, `dev`, `match`, `test`, `fmt`, `lint`
and `typecheck`) cover the workspaces together.

- `apps/player` owns the standalone player's HTML, styles, startup flow, UI and mod persistence.
  Its `build.ts` bundles the app; `tools/build.js` coordinates CMake, the player and Cargo.
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
