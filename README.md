# Rusty Metal 4

Build and run instructions, private local resource preparation, and the embedded
Rust/Wasmtime match host are documented in [the network workflow](docs/network-audit.md#embedded-simulation-and-local-checks).

Use `bun run test:simulation:record` and `bun run test:simulation` for browser/Rust
canonical parity, local replay, portable transfer, and missing-host-capability checks.

See [the development environment](docs/dev-environment.md) for TypeScript workspace
layout and development commands.

The [mod effects overview](docs/design/mod-effects.md) links implemented map contracts
and separates them from the proposed car presentation interfaces.

## License

Original code written for this port, including its web interface and tooling,
is available under the [MIT License](LICENSE).

This license does not relicense game sources or assets, SDK code, or third-party
code, including upstream code copied or adapted in port files and patches.
Those materials retain their respective licenses and copyright notices.
